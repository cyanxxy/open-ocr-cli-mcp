import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { convert } from 'html-to-text';

import {
  dedupeRequestedUrls,
  extractTextFromUrls,
  parseIndividualResults,
  type UrlResult,
} from '@open-ocr/engine/gemini/operations';
import type { GeminiModel, JsonValue } from '@open-ocr/engine/gemini/types';
import {
  createChatCompletion,
  documentContentParts,
  providerDefaultBaseUrl,
  providerRequestHeaders,
  type OpenAIContentPart,
  type ProviderExecutionContext,
} from '@open-ocr/engine/providers';
import { getUnsupportedUrls } from '@open-ocr/engine/urlValidation';
import { FILE_CONSTRAINTS } from '@open-ocr/engine/constants';
import { CliExitError } from './errors';
import { sniffDocumentMimeType } from './inputs';
import {
  OcrJobService,
  type OcrJobServiceResult,
  type OcrJobServiceRuntime,
} from './ocrJobService';
import { assertProviderMediaTypeSupported } from './providerInputs';
import { providerRuntimeConfig } from './providerRuntime';
import { runWithProviderRetries } from './providerRetries';
import { secureFetchPublicUrl } from './secureFetch';
import type { OcrArtifacts, ResolvedCliOptions, ResolvedInput } from './types';

export const WEB_ANALYSIS_MODES = ['individual', 'combined', 'comparison'] as const;
export type WebAnalysisMode = (typeof WEB_ANALYSIS_MODES)[number];
export type WebOutputFormat = 'markdown' | 'json';

export interface WebExtractionResult {
  results?: UrlResult[];
  combinedContent?: string;
  comparisonAnalysis?: string;
}

const WEB_INPUT_MIME_TYPE = 'application/vnd.open-ocr.url-set+json';

function webInput(urls: string[], analysis: WebAnalysisMode): ResolvedInput {
  const encoded = new TextEncoder().encode(JSON.stringify({ analysis, urls }));
  const id = createHash('sha256').update(encoded).digest('hex').slice(0, 12);
  const name = `web-${id}.urls`;
  return {
    displayPath: urls.join(', '),
    relativePath: name,
    name,
    mimeType: WEB_INPUT_MIME_TYPE,
    size: encoded.byteLength,
    mtimeMs: 0,
    stdinBytes: encoded,
  };
}

function webArtifacts(
  result: WebExtractionResult,
  analysis: WebAnalysisMode,
): OcrArtifacts {
  return {
    markdown: renderWebResult(result, analysis, 'markdown'),
    json: result as JsonValue,
  };
}

export async function runWebJob(
  urls: string[],
  analysis: WebAnalysisMode,
  options: ResolvedCliOptions,
  runtime: OcrJobServiceRuntime,
): Promise<OcrJobServiceResult> {
  const service = new OcrJobService({
    assertInputSupported: () => undefined,
    validateInput: () => Promise.resolve(),
    extractDocument: async (input, resolvedOptions, signal, _onStep, providerRuntime) => {
      if (input.mimeType !== WEB_INPUT_MIME_TYPE) {
        throw new Error(`Unexpected Web OCR input type: ${input.mimeType}`);
      }
      const extraction = await runWithProviderRetries(
        resolvedOptions,
        signal,
        () => runWebExtraction(
          urls,
          analysis,
          resolvedOptions,
          signal,
          providerRuntime,
        ),
      );
      return {
        artifacts: webArtifacts(extraction.value, analysis),
        attempts: extraction.attempts,
      };
    },
  });
  return service.run([webInput(urls, analysis)], options, {
    ...runtime,
    deliveryMode: runtime.deliveryMode ?? (options.output ? 'reference' : 'inline'),
  });
}

export function readableWebText(bytes: Uint8Array, contentType: string): string {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!contentType.includes('html') && !contentType.includes('xml')) return decoded;
  return convert(decoded, {
    wordwrap: false,
    preserveNewlines: true,
    selectors: [
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
      { selector: 'svg', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function webPrompt(urls: string[], analysis: WebAnalysisMode): string {
  const sources = urls.map((url, index) => `${index + 1}. ${url}`).join('\n');
  if (analysis === 'individual') return [
    'Extract the primary text from each supplied source independently.',
    `The exact source URLs are:\n${sources}`,
    'Return one result for every URL. Preserve the exact URL string.',
    'Return JSON only with {"results":[{"url":"...","type":"webpage|image|pdf|unknown","title":"...","content":"..."}]}.',
  ].join('\n\n');
  if (analysis === 'combined') return [
    'Combine the supplied sources into one well-structured Markdown document.',
    'Remove duplicates and retain source attribution.',
    sources,
  ].join('\n\n');
  return [
    'Compare the supplied sources in Markdown.',
    'Include a summary of each, similarities, differences, common themes, and unique insights.',
    sources,
  ].join('\n\n');
}

const WEB_RESULTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'type', 'content'],
        properties: {
          url: { type: 'string' },
          type: { type: 'string', enum: ['webpage', 'image', 'pdf', 'unknown'] },
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
};

const KNOWN_MEDIA_TYPES = new Set<string>([
  ...FILE_CONSTRAINTS.SUPPORTED_IMAGE_MIME_TYPES,
  ...FILE_CONSTRAINTS.SUPPORTED_DOCUMENT_MIME_TYPES,
]);

function isTextualContentType(contentType: string): boolean {
  return contentType.startsWith('text/')
    || contentType === 'application/json'
    || contentType === 'application/xml'
    || contentType === 'application/xhtml+xml'
    || contentType.endsWith('+json')
    || contentType.endsWith('+xml');
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  // A truncated sample almost always splits a multibyte sequence at its edge, so
  // the boundary bytes are decoded in streaming mode rather than treated as
  // malformed — otherwise any page whose 4096th byte lands mid-character was
  // rejected as non-text. `stream` is only set when the sample really is a
  // prefix, so a body that genuinely ends in a truncated sequence still fails.
  const truncated = sample.byteLength < bytes.byteLength;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: truncated });
  } catch {
    return false;
  }
  if (decoded.includes('\0')) return false;
  const disallowedControls = [...decoded].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 && character !== '\t' && character !== '\n' && character !== '\r' && character !== '\f';
  }).length;
  return disallowedControls <= Math.max(1, Math.floor(decoded.length / 100));
}

function unsupportedFetchedType(declaredType: string): CliExitError {
  return new CliExitError(
    `URL returned unsupported binary content (${declaredType})`,
    2,
    {
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
      hint: 'Use a textual webpage or a supported image/PDF URL.',
    },
  );
}

function fetchedContentType(declaredType: string, bytes: Uint8Array): string {
  const sniffedType = sniffDocumentMimeType(bytes.subarray(0, 256));
  if (declaredType === 'application/octet-stream') {
    if (sniffedType) return sniffedType;
    if (looksLikeUtf8Text(bytes)) return 'text/plain';
    throw unsupportedFetchedType(declaredType);
  }
  if (KNOWN_MEDIA_TYPES.has(declaredType) && sniffedType !== declaredType) {
    throw new CliExitError(
      `URL response does not match its declared type (${declaredType})`,
      2,
      {
        code: 'INPUT_INVALID',
        category: 'input',
        retryable: false,
        hint: 'Use a URL whose media type matches its document bytes.',
      },
    );
  }
  if (isTextualContentType(declaredType)) {
    if (sniffedType || !looksLikeUtf8Text(bytes)) {
      throw new CliExitError(
        `URL response does not contain plausible text for its declared type (${declaredType})`,
        2,
        {
          code: 'INPUT_INVALID',
          category: 'input',
          retryable: false,
          hint: 'Use a textual UTF-8 webpage or a correctly typed supported image/PDF URL.',
        },
      );
    }
    return declaredType;
  }
  if (!KNOWN_MEDIA_TYPES.has(declaredType)) {
    throw unsupportedFetchedType(declaredType);
  }
  return declaredType;
}

async function runCompatibleWebExtraction(
  urls: string[],
  analysis: WebAnalysisMode,
  options: ResolvedCliOptions,
  signal: AbortSignal,
  runtime?: ProviderExecutionContext,
): Promise<WebExtractionResult> {
  const config = providerRuntimeConfig(options, runtime);
  const parts: OpenAIContentPart[] = [{ type: 'text', text: webPrompt(urls, analysis) }];
  let totalBytes = 0;
  let hasPdf = false;
  for (const [index, url] of urls.entries()) {
    const fetched = await secureFetchPublicUrl(url, signal);
    totalBytes += fetched.bytes.byteLength;
    if (totalBytes > 30 * 1024 * 1024) throw new Error('Web OCR source data exceeds the 30 MB combined limit');
    const contentType = fetchedContentType(fetched.contentType, fetched.bytes);
    // `image/svg+xml` is an `image/*` type that `fetchedContentType` already
    // accepted as text. Routing it by prefix alone uploaded SVG markup as a
    // binary image part, which the provider rejects; its extractable content is
    // the markup, so it belongs on the text branch.
    if (
      contentType === 'application/pdf'
      || (contentType.startsWith('image/') && !isTextualContentType(contentType))
    ) {
      assertProviderMediaTypeSupported(contentType, options);
      hasPdf ||= contentType === 'application/pdf';
      const dataUrl = `data:${contentType};base64,${Buffer.from(fetched.bytes).toString('base64')}`;
      parts.push({ type: 'text', text: `Source ${index + 1}: ${url}` });
      parts.push(...await documentContentParts(
        config,
        dataUrl,
        contentType,
        new URL(url).pathname.split('/').pop() || `source-${index + 1}`,
        signal,
      ));
    } else {
      const text = readableWebText(fetched.bytes, contentType).slice(0, 1_500_000);
      if (!text) {
        throw new CliExitError(`URL returned no readable text: ${url}`, 2, {
          code: 'INPUT_INVALID',
          category: 'input',
          retryable: false,
          hint: 'Use a URL whose response contains extractable text, or a supported image/PDF URL.',
        });
      }
      parts.push({ type: 'text', text: `Source ${index + 1}: ${url}\n\n${text}` });
    }
  }
  const response = await createChatCompletion(config, {
    messages: [{ role: 'user', content: parts }],
    maxTokens: analysis === 'individual'
      ? Math.min(32768, Math.max(8192, urls.length * 2048))
      : 16384,
    responseSchema: analysis === 'individual' ? WEB_RESULTS_SCHEMA : undefined,
    schemaName: 'web_ocr_results',
    signal,
    ...(config.provider === 'openrouter' && hasPdf
      ? { extraBody: { plugins: [{ id: 'file-parser' }] } }
      : {}),
  });
  if (analysis === 'individual') return { results: parseIndividualResults(response.text, urls) };
  if (analysis === 'combined') return { combinedContent: response.text.trim() };
  return { comparisonAnalysis: response.text.trim() };
}

/** A malformed URL request: the caller's arguments are wrong, not the provider's. */
function webConfigurationError(message: string, hint: string): CliExitError {
  return new CliExitError(message, 2, {
    code: 'CONFIG_INVALID',
    category: 'configuration',
    retryable: false,
    hint,
  });
}

function urlListError(message: string, cause: unknown): CliExitError {
  return new CliExitError(message, 2, {
    cause,
    code: 'INPUT_NOT_FOUND',
    category: 'input',
    retryable: false,
    hint: 'Check the --file path and working directory.',
  });
}

/** Read the `--file` URL list, reporting the path the caller passed on failure. */
async function readUrlListFile(filePath: string, cwd: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.resolve(cwd, filePath), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw urlListError(`URL list file not found: ${filePath}`, error);
    if (code === 'EISDIR') throw urlListError(`URL list path is not a file: ${filePath}`, error);
    if (code === 'EACCES' || code === 'EPERM') {
      throw urlListError(`URL list file is not readable: ${filePath}`, error);
    }
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export async function resolveWebUrls(rawUrls: string[], filePath: string | undefined, cwd: string): Promise<string[]> {
  const fromFile = filePath ? await readUrlListFile(filePath, cwd) : [];
  const requested = [...rawUrls, ...fromFile].map((url) => url.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw webConfigurationError(
      'Provide at least one URL or use --file',
      'Pass one or more public HTTP(S) URLs, or --file with a URL list.',
    );
  }
  const unsupported = getUnsupportedUrls(requested);
  if (unsupported.length > 0) {
    throw webConfigurationError(
      `Unsupported or unsafe URL(s): ${unsupported.join(', ')}`,
      'Use public http(s) URLs without embedded credentials; loopback, private, and tunnelling hosts are refused.',
    );
  }
  const { urls } = dedupeRequestedUrls(requested);
  if (urls.length > 20) {
    throw webConfigurationError(
      `Web OCR supports at most 20 unique URLs per request; received ${urls.length}`,
      'Split the URL list across several runs.',
    );
  }
  return urls;
}

export function renderWebResult(
  result: WebExtractionResult,
  analysis: WebAnalysisMode,
  format: WebOutputFormat,
): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  if (analysis === 'combined') {
    if (!result.combinedContent) throw new Error('Combined Web OCR returned no content');
    return result.combinedContent.replace(/\n?$/, '\n');
  }
  if (analysis === 'comparison') {
    if (!result.comparisonAnalysis) throw new Error('Comparison Web OCR returned no content');
    return result.comparisonAnalysis.replace(/\n?$/, '\n');
  }
  if (!result.results?.length) throw new Error('Individual Web OCR returned no results');
  return `${result.results.map((entry) => [
    `# ${entry.title || entry.url}`,
    '',
    `Source: ${entry.url}`,
    '',
    entry.content,
  ].join('\n')).join('\n\n---\n\n')}\n`;
}

export async function runWebExtraction(
  urls: string[],
  analysis: WebAnalysisMode,
  options: ResolvedCliOptions,
  signal: AbortSignal,
  runtime?: ProviderExecutionContext,
): Promise<WebExtractionResult> {
  if (options.provider !== 'gemini') {
    return runCompatibleWebExtraction(urls, analysis, options, signal, runtime);
  }
  const config = providerRuntimeConfig(options, runtime);
  return extractTextFromUrls(
    urls,
    options.apiKey || (options.cloudflareByok ? options.gatewayToken || 'cloudflare-byok' : ''),
    analysis,
    options.model as GeminiModel,
    { level: options.thinking, includeThoughts: options.includeThoughts },
    signal,
    options.gateway === 'cloudflare' || options.baseUrl !== providerDefaultBaseUrl('gemini')
      ? {
          baseUrl: options.baseUrl,
          ...(options.gateway === 'cloudflare' ? { headers: providerRequestHeaders(config) } : {}),
        }
        : undefined,
    config.runtime,
  );
}

/** Resolve and preflight a Web OCR destination before any paid API request. */
export async function assertWebOutputAvailable(
  outputPath: string,
  cwd: string,
  overwrite: boolean,
): Promise<string> {
  const target = path.resolve(cwd, outputPath);
  if (overwrite) return target;
  try {
    // A dangling symlink still occupies the destination and must be rejected
    // before the URL-context request spends tokens.
    await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw error;
  }
  throw new Error(`Output already exists: ${target} (use --overwrite)`);
}
