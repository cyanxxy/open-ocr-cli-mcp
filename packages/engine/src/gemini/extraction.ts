/**
 * Text and structured data extraction operations using Gemini AI
 * This module contains the main extraction functions moved from the monolithic gemini.ts
 */

import { logger } from '../logger';
import {
  applyThinkingConfig,
  assertCompleteGeminiResponse,
  createGeminiStreamCompletionTracker,
  generateContentMediaResolution,
  getGenAIClient,
} from './client';
import { OcrError, OcrErrorType } from './types';
import type {
  ExtractedContent,
  StreamingCallbacks,
  ExtractionOptions,
  ExtractionInstruction,
  GeminiModel,
  GeminiClientConfig,
  JsonValue,
  ThinkingConfig
} from './types';
import { recordGeminiUsage } from './usage';
import { waitForGeminiRequestSlot } from './requestPolicy';
import {
  parseProviderErrorPayload,
  providerErrorMessage,
  providerErrorSubject,
  readableProviderError,
} from './errorPayload';
import { findSchemaCompatibilityIssues, type SchemaCompatibilityIssue } from './schemaCompat';

/**
 * Helper function to process markdown text into ExtractedContent structure
 */
function processMarkdownIntoExtractedContent(
  text: string
): ExtractedContent {
  const lines = text.split('\n');
  const sections: ExtractedContent['sections'] = [];
  let currentSection: { heading?: string; content: string[] } = { content: [] };
  let title: string | undefined;
  let inCodeFence = false;
  let codeFenceMarker: string | null = null;

  const trimTrailingBlankLines = (content: string[]) => {
    let endIndex = content.length;
    while (endIndex > 0 && content[endIndex - 1].trim() === '') {
      endIndex -= 1;
    }
    return content.slice(0, endIndex);
  };

  const commitSection = () => {
    const cleanedContent = trimTrailingBlankLines(currentSection.content);
    const hasContent = cleanedContent.some((line) => line.trim() !== '');
    if (currentSection.heading || hasContent) {
      sections.push({
        heading: currentSection.heading,
        content: cleanedContent,
      });
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const fenceMatch = trimmedLine.match(/^(```|~~~)/);

    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true;
        codeFenceMarker = fenceMatch[1];
      } else if (codeFenceMarker && trimmedLine.startsWith(codeFenceMarker)) {
        inCodeFence = false;
        codeFenceMarker = null;
      }
      currentSection.content.push(line);
      continue;
    }

    if (!inCodeFence) {
      const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const headingText = headingMatch[2].trim();

        if (
          level === 1 &&
          !title &&
          sections.length === 0 &&
          currentSection.content.every((contentLine) => contentLine.trim() === '')
        ) {
          title = headingText;
          continue;
        }

        commitSection();
        currentSection = {
          heading: headingText,
          content: []
        };
        continue;
      }
    }

    currentSection.content.push(line);
  }
  
  // Don't forget the last section
  commitSection();

  return { title, sections };
}

/** How many advisory constructs to name before summarizing the rest. */
const MAX_HINTED_SCHEMA_ISSUES = 3;

function listAdvisoryConstructs(advisory: SchemaCompatibilityIssue[]): string {
  const listed = advisory
    .slice(0, MAX_HINTED_SCHEMA_ISSUES)
    .map((issue) => `${issue.path} (${issue.keyword})`)
    .join(', ');
  const remainder = advisory.length > MAX_HINTED_SCHEMA_ISSUES
    ? `, and ${advisory.length - MAX_HINTED_SCHEMA_ISSUES} more`
    : '';
  return `${listed}${remainder}`;
}

/**
 * Append untested-construct findings to a rejection nobody can explain, without
 * claiming they caused it.
 *
 * The error stays the provider's own: same name, same `status`, same cause, so
 * every classifier keyed on those still reads it as the generic provider failure
 * it is. Only the sentence gains a lead worth checking first.
 */
function withUntestedConstructHint(error: unknown, advisory: SchemaCompatibilityIssue[]): unknown {
  if (advisory.length === 0 || !(error instanceof Error)) return error;
  const hinted = new Error(
    `${error.message} The response schema also uses constructs this client has not tested against `
    + `structured output (${listAdvisoryConstructs(advisory)}); the provider named nothing, so that is `
    + 'a lead to check rather than the established cause.',
    { cause: error },
  );
  hinted.name = error.name;
  if (error.stack) hinted.stack = error.stack;
  const status = (error as { status?: unknown }).status;
  if (status !== undefined) {
    Object.defineProperty(hinted, 'status', { value: status, enumerable: true, writable: true, configurable: true });
  }
  return hinted;
}

/**
 * Explain a response schema the provider refused to compile.
 *
 * Constrained decoding rejects an over-budget schema with a bare
 * `400 INVALID_ARGUMENT` whose whole message is "Request contains an invalid
 * argument." — no field, no detail, nothing that separates it from any other
 * malformed request. `findSchemaCompatibilityIssues` is the only evidence that
 * can name the cause and it needs the schema, which the error does not carry, so
 * the diagnosis has to be made here where the schema is still in scope.
 *
 * Runs only when the provider named nothing itself: a rejection that already
 * blamed the document or a specific request field is rethrown untouched.
 *
 * Only a `confident` finding — a grammar cost past the measured ceiling —
 * converts the failure into a schema failure. An `advisory` finding means the
 * schema uses something we have never probed, which is not evidence of anything;
 * promoting it would tell a caller with a perfectly legitimate modular schema to
 * go rewrite it while the real cause went unmentioned. Those findings ride along
 * as a hint and leave the error on the generic provider path.
 */
function describeSchemaRejection(
  error: unknown,
  responseJsonSchema: Record<string, unknown>,
): unknown {
  if (!(error instanceof Error)) return error;
  if ((error as { status?: unknown }).status !== 400) return readableProviderError(error);
  const payload = parseProviderErrorPayload(error.message);
  if (payload && providerErrorSubject(payload)) return readableProviderError(error);
  const issues = findSchemaCompatibilityIssues(responseJsonSchema);
  const confident = issues.filter((issue) => issue.confidence === 'confident');
  const advisory = issues.filter((issue) => issue.confidence === 'advisory');
  if (confident.length === 0) return withUntestedConstructHint(readableProviderError(error), advisory);
  const detail = confident
    .map((issue) => `${issue.path} (${issue.keyword}): ${issue.reason}`)
    .join('; ');
  const alsoUntested = advisory.length > 0
    ? ` The schema also uses constructs we have not tested (${listAdvisoryConstructs(advisory)}).`
    : '';
  // Typed, not prose. This site has the evidence — a measured grammar cost over
  // the ceiling — so it states the verdict outright and a consumer never has to
  // infer it from the message. That matters more here than anywhere else in the
  // engine: `detail` quotes the caller's own schema paths, so any classifier
  // reduced to substring-matching this sentence is matching user-supplied text.
  // A schema with properties named `page` and `maximum` read as a page-limit
  // failure until this became an `OcrError`.
  return new OcrError(
    OcrErrorType.SCHEMA_INVALID,
    'Invalid JSON Schema for structured output: the provider rejected the request '
    + `("${providerErrorMessage(error.message)}") and the schema exceeds a limit it is `
    + `measured to reject — ${detail}.${alsoUntested}`,
    undefined,
    { cause: error },
  );
}

/** Extract a document directly into a caller-provided JSON Schema contract. */
export async function extractStructuredDataFromFile(
  fileData: string,
  mimeType: string,
  clientConfig: GeminiClientConfig,
  responseJsonSchema: Record<string, unknown>,
  instructions?: ExtractionInstruction[],
  options?: Pick<ExtractionOptions, 'abortSignal' | 'maxTokens' | 'detectImages' | 'detectMathEquations'>,
): Promise<JsonValue> {
  const { apiKey, model, thinkingConfig, baseUrl, headers, runtime } = clientConfig;
  if (!apiKey) throw new Error('Please configure your Gemini API key in settings');

  const prompt = [
    'Extract the document into the exact JSON structure described by the response schema.',
    'Use only information visible in the document. Do not invent missing values.',
    'Return JSON only, without Markdown fences or commentary.',
    ...(instructions?.map((instruction) => instruction.prompt) ?? []),
    ...(options?.detectImages ? ['Include relevant information visible in charts, diagrams, or images.'] : []),
    ...(options?.detectMathEquations ? ['Represent mathematical expressions accurately.'] : []),
  ].join(' ');
  const base64Data = fileData.split(',')[1] || fileData;
  let generationConfig: Record<string, unknown> = {
    maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    responseMimeType: 'application/json',
    responseJsonSchema,
    mediaResolution: generateContentMediaResolution(mimeType),
  };
  if (options?.abortSignal) generationConfig.abortSignal = options.abortSignal;
  generationConfig = applyThinkingConfig(generationConfig, model, thinkingConfig);

  const genAI = getGenAIClient(apiKey, { baseUrl, headers });
  await waitForGeminiRequestSlot(options?.abortSignal, runtime);
  let response;
  try {
    response = await genAI.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } },
        ],
      }],
      config: generationConfig,
    });
  } catch (error) {
    throw describeSchemaRejection(error, responseJsonSchema);
  }
  recordGeminiUsage(response, model, runtime);
  assertCompleteGeminiResponse(response, 'Schema extraction');
  const text = response.text?.trim() ?? '';
  if (!text) throw new Error('Schema extraction returned an empty response');
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new Error('Schema extraction returned invalid JSON');
  }
}

/**
 * Single source of truth for whether a JSON contract was requested. Both the
 * prompt and the generation config must agree on this — the previous code asked
 * for Markdown in the prompt while requesting `application/json` in the config
 * whenever `outputFormat: 'json'` was set without `structuredOutput` (audit H-01).
 */
function wantsJsonOutput(options?: ExtractionOptions): boolean {
  return options?.structuredOutput === true || options?.outputFormat === 'json';
}

/** Default output-token ceiling. Generous enough for a dense page, but bounded
 * (the model max of 65536 masked runaway prompts and inflated worst-case cost —
 * audit G-03). Callers needing more pass `options.maxTokens` explicitly. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export const EXTRACTED_CONTENT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content'],
        properties: {
          heading: { type: 'string' },
          content: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    content: { type: 'string' },
    headings: { type: 'array', items: { type: 'string' } },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['headers', 'rows', 'content'],
        properties: {
          headers: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          content: { type: 'string' },
        },
      },
    },
    code: { type: 'array', items: { type: 'string' } },
    lists: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'items'],
        properties: {
          type: { type: 'string', enum: ['ordered', 'unordered'] },
          items: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    markdown: { type: 'string' },
  },
};

/** Build generation configuration for Gemini 3 generateContent calls. */
function buildGenerationConfig(
  modelName: GeminiModel,
  options?: ExtractionOptions,
  thinkingConfig?: ThinkingConfig,
  mimeType?: string,
): Record<string, unknown> {
  // Gemini 3.x: omit temperature/topP/topK unless the caller overrides temperature.
  let config: Record<string, unknown> = {
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };

  if (wantsJsonOutput(options)) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = EXTRACTED_CONTENT_RESPONSE_SCHEMA;
  }

  if (options?.abortSignal) {
    config.abortSignal = options.abortSignal;
  }

  if (mimeType) {
    config.mediaResolution = generateContentMediaResolution(mimeType);
  }

  config = applyThinkingConfig(config, modelName, thinkingConfig);

  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isExtractedContent(value: unknown): value is ExtractedContent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'title',
    'sections',
    'content',
    'headings',
    'tables',
    'code',
    'lists',
    'markdown',
  ])) {
    return false;
  }

  if (!Array.isArray(value.sections) || !value.sections.every((section) => (
    isRecord(section)
    && hasOnlyKeys(section, ['heading', 'content'])
    && (section.heading === undefined || typeof section.heading === 'string')
    && isStringArray(section.content)
  ))) {
    return false;
  }

  if (
    (value.title !== undefined && typeof value.title !== 'string')
    || (value.content !== undefined && typeof value.content !== 'string')
    || (value.headings !== undefined && !isStringArray(value.headings))
    || (value.code !== undefined && !isStringArray(value.code))
    || (value.markdown !== undefined && typeof value.markdown !== 'string')
  ) {
    return false;
  }

  if (value.tables !== undefined && (
    !Array.isArray(value.tables)
    || !value.tables.every((table) => (
      isRecord(table)
      && hasOnlyKeys(table, ['headers', 'rows', 'content'])
      && isStringArray(table.headers)
      && Array.isArray(table.rows)
      && table.rows.every(isStringArray)
      && typeof table.content === 'string'
    ))
  )) {
    return false;
  }

  if (value.lists !== undefined && (
    !Array.isArray(value.lists)
    || !value.lists.every((list) => (
      isRecord(list)
      && hasOnlyKeys(list, ['type', 'items'])
      && (list.type === 'ordered' || list.type === 'unordered')
      && isStringArray(list.items)
    ))
  )) {
    return false;
  }

  return true;
}

function parseExtractedContentFromJson(text: string): ExtractedContent | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isExtractedContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Turn raw model output into an ExtractedContent according to the requested
 * contract. When JSON was explicitly requested, an unparseable response is a
 * contract violation that throws — it is never silently downgraded to Markdown
 * (audit H-02). An empty response always throws (audit G-02/H-03).
 */
export function coerceExtractionResult(text: string, wantsJson: boolean): ExtractedContent {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Extraction returned an empty response');
  }
  if (wantsJson) {
    const parsed = parseExtractedContentFromJson(trimmed);
    if (!parsed) {
      throw new Error('Extraction requested JSON but the response was invalid JSON or did not match the OCR schema');
    }
    return parsed;
  }
  return processMarkdownIntoExtractedContent(trimmed);
}

/**
 * Extracts text content from a given file (image or PDF).
 *
 * @param fileData - The base64 encoded string of the file.
 * @param mimeType - The MIME type of the file (e.g., 'image/png', 'application/pdf').
 * @param clientConfig - Configuration containing apiKey, model, and thinkingConfig.
 * @param instructions - Optional array of ExtractionInstruction to guide the AI.
 * @param options - Optional ExtractionOptions to customize extraction behavior.
 * @param callbacks - Optional StreamingCallbacks for handling streaming responses.
 * @returns A promise that resolves to an ExtractedContent object.
 * @throws Error if API key is missing or if there's an issue with file data or API communication.
 */
export async function extractTextFromFile(
  fileData: string,
  mimeType: string,
  clientConfig: GeminiClientConfig,
  instructions?: ExtractionInstruction[],
  options?: ExtractionOptions,
  callbacks?: StreamingCallbacks
): Promise<ExtractedContent> {
  try {
    const { apiKey, model, thinkingConfig, baseUrl, headers, runtime } = clientConfig;
    
    if (!apiKey) {
      throw new Error('Please configure your Gemini API key in settings');
    }

    // Reuse the shared (single-entry) client rather than constructing a new
    // GoogleGenAI per call, so credential lifecycle/caching stays centralized
    // (audit H-18).
    const genAI = getGenAIClient(apiKey, { baseUrl, headers });
    const wantsJson = wantsJsonOutput(options);

    // Prepare the file data
    const base64Data = fileData.split(',')[1] || fileData;

    // Build the prompt. Explicit user instructions act as the extraction
    // directive; otherwise we fall back to the default "extract all text"
    // objective. Feature flags and the format directive are always appended so
    // they are never lost when custom instructions are supplied (audit G-04).
    const promptParts: string[] = [];
    if (instructions && instructions.length > 0) {
      promptParts.push(...instructions.map((inst) => inst.prompt));
    } else {
      promptParts.push('Extract all text content from this document.');
    }

    if (options?.handwritingStyle) {
      promptParts.push(`The document contains ${options.handwritingStyle} handwriting.`);
    }
    if (options?.detectImages) {
      promptParts.push('Detect and describe any images, charts, or diagrams.');
    }
    if (options?.detectMathEquations) {
      promptParts.push('Detect and format mathematical equations using LaTeX notation.');
    }
    if (options?.imageDetailLevel === 'detailed') {
      promptParts.push('Describe visual (non-text) elements in detail.');
    } else if (options?.imageDetailLevel === 'minimal') {
      promptParts.push('Keep descriptions of non-text visual elements brief.');
    }

    if (wantsJson) {
      promptParts.push('Output the result as structured JSON with title, sections, and content.');
    } else {
      promptParts.push('Format the output as clean markdown with proper headings and structure.');
    }

    const prompt = promptParts.join(' ');

    // Prepare contents for the API
    const contents = [{
      role: 'user' as const,
      parts: [
        { text: prompt },
        { 
          inlineData: {
            mimeType,
            data: base64Data
          }
        }
      ]
    }];

    const generationConfig = buildGenerationConfig(model, options, thinkingConfig, mimeType);

    // Handle streaming if callbacks are provided
    if (callbacks) {
      callbacks.onStart?.();
      await waitForGeminiRequestSlot(options?.abortSignal, runtime);
      const result = await genAI.models.generateContentStream({
        model,
        contents,
        config: generationConfig
      });

      let fullText = '';
      const completion = createGeminiStreamCompletionTracker('Extraction');
      let lastChunk: {
        candidates?: Array<{ finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
      } | null = null;
      for await (const chunk of result) {
        lastChunk = chunk;
        try {
          completion.observe(lastChunk);
        } catch (error) {
          recordGeminiUsage(lastChunk, model, runtime);
          throw error;
        }
        const chunkText = chunk.text || '';
        fullText += chunkText;
        callbacks.onProgress?.(chunkText);
      }

      // STOP can appear before a final usage-only chunk, so completion is
      // tracked across the stream rather than inferred from the last event.
      if (lastChunk) {
        recordGeminiUsage(lastChunk, model, runtime);
      }
      completion.assertComplete();
      const finalContent = coerceExtractionResult(fullText, wantsJson);
      callbacks.onComplete?.(finalContent);
      return finalContent;

    } else {
      await waitForGeminiRequestSlot(options?.abortSignal, runtime);
      const response = await genAI.models.generateContent({
        model,
        contents,
        config: generationConfig
      });

      recordGeminiUsage(response, model, runtime);
      assertCompleteGeminiResponse(response, 'Extraction');
      return coerceExtractionResult(response.text || '', wantsJson);
    }

  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger.error('Text extraction failed:', error);
    // Always surface failures. Previously, when callbacks were supplied, the
    // function notified onError and then RESOLVED with an empty `{ sections: [] }`,
    // so callers could not distinguish a real failure (or a cancellation) from a
    // genuinely empty document (audit H-03 / G-07). The onError callback is still
    // invoked for host handling, and the rejection preserves the original error
    // (including an AbortError's name) so cancellation stays distinguishable.
    callbacks?.onError?.(normalizedError);
    throw normalizedError;
  }
}
