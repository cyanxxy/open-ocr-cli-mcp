import {
  createInteractionGenerationConfig,
  extractInteractionModelErrors,
  extractInteractionText,
  getInteractionSteps,
  runModelInteraction,
  summarizeUrlContextResults,
  type InteractionStep,
} from './interactions';
import { logger } from '../logger';
import type { GeminiModel, ThinkingConfig } from './types';
import type { ProviderExecutionContext } from '../providers/runtime';

/**
 * A single extracted URL result from grounded URL-context extraction.
 *
 * audit W-01: this type lives in the engine's domain layer, so consumers
 * (the CLI's web command, the evals harness) re-import it from here rather
 * than the engine depending on any of them.
 */
export interface UrlResult {
  /** The requested source URL this result corresponds to. */
  url: string;
  /** The extracted text content for this URL. */
  content: string;
  /** The detected content type of the source. */
  type: 'webpage' | 'image' | 'pdf' | 'unknown';
  /** Optional title or heading extracted from the source. */
  title?: string;
  /** Per-URL error message when extraction failed for this entry. */
  error?: string;
}

// audit H-06: verification here is infrastructure-level only — URL-context
// retrieval metadata reporting success means each page was fetched, NOT that the
// returned text is factually faithful to the page. The wording avoids claiming
// factual non-fabrication.
const VERIFIED_ONLY_SUFFIX = 'Web OCR only returns content when URL-context retrieval reports success for every URL; it does not guess content.';

function createGroundedUrlError(message: string): Error {
  return new Error(`${message} ${VERIFIED_ONLY_SUFFIX}`);
}

function normalizeResultType(value: unknown): UrlResult['type'] {
  switch (value) {
    case 'webpage':
    case 'image':
    case 'pdf':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Normalize a URL for matching so trivial differences (host casing, trailing
 * slash) don't prevent a returned entry from being resolved back to the exact
 * URL the user requested.
 *
 * audit H-05: the scheme is kept in the key and `www.` is NOT stripped, so
 * `http://example.com` vs `https://example.com` and `www.example.com` vs
 * `example.com` are treated as DISTINCT identities. Collapsing them would let
 * the model satisfy a request for one origin with content fetched from another.
 */
function normalizeUrlForMatch(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.host.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${host}${path}${parsed.search}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Deduplicate a list of requested URLs by their normalized match key, preserving
 * the first occurrence's original spelling. Returns the deduped list plus the
 * number of duplicates that were dropped.
 *
 * audit W-06 / H-05: callers must collapse duplicates BEFORE building the match
 * Map, otherwise the second of two identical inputs silently overwrites the
 * first and the model's second result for that URL can no longer be matched.
 */
export function dedupeRequestedUrls(urls: string[]): { urls: string[]; duplicateCount: number } {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of urls) {
    const key = normalizeUrlForMatch(url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(url);
  }
  return { urls: deduped, duplicateCount: urls.length - deduped.length };
}

export function parseIndividualResults(responseText: string, urls: string[]): UrlResult[] {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw createGroundedUrlError('Grounded URL extraction returned an unreadable individual response.');
  }

  const parsed = JSON.parse(jsonMatch[0]) as { results?: unknown };
  if (!Array.isArray(parsed.results) || parsed.results.length !== urls.length) {
    throw createGroundedUrlError('Grounded URL extraction did not return a complete result for every requested URL.');
  }

  // Resolve each returned entry back to the requested URL by content, never by
  // array position: the model can reorder results, and trusting the index (or a
  // blindly-returned url) silently mislabels which URL produced which text.
  //
  // audit H-05: building the Map with `.set()` would let two requested URLs that
  // normalize to the same key silently overwrite each other (one entry never
  // consumed). Detect that collision here and fail closed instead.
  const remaining = new Map<string, string>();
  for (const url of urls) {
    const key = normalizeUrlForMatch(url);
    if (remaining.has(key)) {
      throw createGroundedUrlError('Grounded URL extraction received duplicate URLs that resolve to the same address.');
    }
    remaining.set(key, url);
  }

  const results = parsed.results.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw createGroundedUrlError('Grounded URL extraction returned a malformed result entry.');
    }

    const result = entry as {
      url?: unknown;
      type?: unknown;
      title?: unknown;
      content?: unknown;
    };

    if (typeof result.url !== 'string') {
      throw createGroundedUrlError('Grounded URL extraction returned a result without its source URL.');
    }

    const matchKey = normalizeUrlForMatch(result.url);
    const requestedUrl = remaining.get(matchKey);
    if (!requestedUrl) {
      throw createGroundedUrlError(`Grounded URL extraction returned a result for an unexpected URL (${result.url}).`);
    }
    remaining.delete(matchKey);

    if (typeof result.content !== 'string' || result.content.trim().length === 0) {
      throw createGroundedUrlError('Grounded URL extraction returned an empty result for at least one URL.');
    }

    return {
      url: requestedUrl,
      type: normalizeResultType(result.type),
      title: typeof result.title === 'string' ? result.title : undefined,
      content: result.content.trim(),
    };
  });

  // audit H-05: assert a strict 1:1 mapping — every requested URL must have been
  // matched exactly once. A non-empty `remaining` means a requested URL was
  // never accounted for (e.g. the model returned the same URL twice), which the
  // array-length check alone cannot catch.
  if (remaining.size !== 0) {
    throw createGroundedUrlError('Grounded URL extraction did not account for every requested URL.');
  }

  return results;
}

function validateUrlContextResults(
  urls: string[],
  steps?: InteractionStep[],
): void {
  const { hasToolError, results } = summarizeUrlContextResults(steps);

  if (hasToolError) {
    throw createGroundedUrlError('Grounded URL retrieval failed before the model produced a verified answer.');
  }

  if (results.length === 0) {
    throw createGroundedUrlError('Grounded URL retrieval could not be verified for this response.');
  }

  if (results.length < urls.length) {
    throw createGroundedUrlError('Grounded URL retrieval did not verify every requested URL.');
  }

  const failedResults = results.filter((result) => result.status !== 'success');
  if (failedResults.length > 0) {
    const detail = failedResults
      .map((result, index) => `${result.url || urls[index] || `URL ${index + 1}`} (${result.status || 'unknown'})`)
      .join(', ');

    throw createGroundedUrlError(`Grounded URL retrieval failed for ${detail}.`);
  }

  const requestedByKey = new Map(
    urls.map((url) => [normalizeUrlForMatch(url), url] as const),
  );
  const retrievedKeys = new Set<string>();

  for (const result of results) {
    if (typeof result.url !== 'string' || result.url.trim().length === 0) {
      throw createGroundedUrlError('Grounded URL retrieval returned a success result without its source URL.');
    }

    const key = normalizeUrlForMatch(result.url);
    if (!requestedByKey.has(key)) {
      throw createGroundedUrlError(`Grounded URL retrieval verified an unexpected URL (${result.url}).`);
    }
    if (retrievedKeys.has(key)) {
      throw createGroundedUrlError(`Grounded URL retrieval returned a duplicate result for ${result.url}.`);
    }
    retrievedKeys.add(key);
  }

  const missingUrls = [...requestedByKey]
    .filter(([key]) => !retrievedKeys.has(key))
    .map(([, url]) => url);
  if (missingUrls.length > 0) {
    throw createGroundedUrlError(`Grounded URL retrieval did not verify: ${missingUrls.join(', ')}.`);
  }
}

function normalizeUrlExtractionError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes(VERIFIED_ONLY_SUFFIX)) {
      return error;
    }

    // audit W-04: only map genuine feature-unavailability signals to the
    // "unavailable for this API key/model/region" message. Transient server
    // failures (500/internal), permission misconfigurations, and generic tool
    // errors must keep their original message so the real root cause surfaces
    // instead of falsely blaming the user's key/region. Categories stay stable:
    // url-context-specific unavailability vs. everything-else passthrough.
    const loweredError = error.message.toLowerCase();
    if (
      loweredError.includes('url context')
      || loweredError.includes('url_context')
      || loweredError.includes('not supported')
      || loweredError.includes('not available')
      || loweredError.includes('unsupported')
    ) {
      return createGroundedUrlError('Grounded URL retrieval is unavailable for this API key, model, or region.');
    }

    // Preserve typed cost, cancellation, and provider errors for the host's
    // retry policy and result classification.
    return error;
  }

  return createGroundedUrlError('Grounded URL retrieval failed.');
}

/**
 * Extract text from multiple URLs using Gemini's URL context feature.
 *
 * The response is treated as valid only when URL-context retrieval reports
 * success for every requested URL. Otherwise the function fails closed.
 */
export async function extractTextFromUrls(
  urls: string[],
  apiKey: string,
  analysisMode: 'individual' | 'combined' | 'comparison',
  model: GeminiModel,
  thinkingConfig?: ThinkingConfig,
  abortSignal?: AbortSignal,
  transport?: { baseUrl?: string; headers?: Record<string, string> },
  runtime?: ProviderExecutionContext,
): Promise<{
  results?: UrlResult[];
  combinedContent?: string;
  comparisonAnalysis?: string;
}> {
  try {
    logger.info(`Processing ${urls.length} URLs with mode: ${analysisMode}`);

    let prompt = '';

    if (analysisMode === 'individual') {
      prompt = `Analyze each of the following URLs and extract their text content individually:

${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}

For each URL, provide:
1. The URL
2. The type of content (webpage, image, pdf, etc.)
3. A title or heading if available
4. The main text content extracted

Keep each URL's extracted content focused on the primary text so that the
combined response stays within the output limit; summarize boilerplate rather
than reproducing it verbatim.

Format the response as JSON:
{
  "results": [
    {
      "url": "the URL",
      "type": "webpage|image|pdf|unknown",
      "title": "title if available",
      "content": "extracted text content"
    }
  ]
}`;
    } else if (analysisMode === 'combined') {
      prompt = `Extract and combine all text content from the following URLs into a single coherent document:

${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}

Merge the content intelligently, removing duplicates and organizing it logically.
Include source attribution where appropriate.

Provide the combined content as a well-structured markdown document.`;
    } else {
      prompt = `Compare and analyze the content from the following URLs:

${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}

Provide:
1. Summary of each document
2. Key similarities between documents
3. Key differences between documents
4. Common themes or topics
5. Unique insights from each source

Format as a structured comparison analysis.`;
    }

    // audit W-05: a single fixed 8192-token budget truncated multi-URL
    // individual extractions (each URL needs its own slice of the output), which
    // surfaced to the user as an opaque "incomplete result" error. Scale the
    // budget with the URL count for individual mode (~2k tokens/URL), and use a
    // higher fixed ceiling for combined/comparison synthesis. Capped at 32768 to
    // stay well within the model's output limit.
    const maxOutputTokens = analysisMode === 'individual'
      ? Math.min(32768, Math.max(8192, urls.length * 2048))
      : 16384;

    // Omit temperature/top_p — Gemini 3.x is optimized for defaults.
    const generationConfig = createInteractionGenerationConfig({
      maxOutputTokens,
    }, model, thinkingConfig);

    const responseSchema = analysisMode === 'individual'
      ? {
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
                  type: { type: 'string' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                },
              },
            },
          },
        }
      : undefined;

    const interaction = await runModelInteraction({
      apiKey,
      model,
      baseUrl: transport?.baseUrl,
      headers: transport?.headers,
      input: prompt,
      tools: [{ type: 'url_context' }],
      generationConfig,
      responseSchema,
      responseMimeType: analysisMode === 'individual' ? 'application/json' : undefined,
      abortSignal,
      store: false,
      runtime,
    });

    if (interaction.status !== 'completed') {
      throw createGroundedUrlError(`URL-context interaction ended with status "${interaction.status}".`);
    }

    const steps = getInteractionSteps(interaction);
    const modelErrors = extractInteractionModelErrors(steps);
    if (modelErrors.length > 0) {
      throw createGroundedUrlError(`URL-context model output failed: ${modelErrors.join('; ')}.`);
    }
    validateUrlContextResults(urls, steps);

    const responseText = extractInteractionText(steps, interaction.output_text);
    if (!responseText) {
      throw createGroundedUrlError('Grounded URL retrieval succeeded, but the model returned no text output.');
    }

    if (analysisMode === 'individual') {
      return { results: parseIndividualResults(responseText, urls) };
    }

    if (analysisMode === 'combined') {
      return { combinedContent: responseText.trim() };
    }

    return { comparisonAnalysis: responseText.trim() };
  } catch (error) {
    logger.error('URL extraction failed:', error);
    throw normalizeUrlExtractionError(error);
  }
}
