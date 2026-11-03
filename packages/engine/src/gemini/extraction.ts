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
import { markdownToSections, normalizeModelMarkdown } from './markdown';
import { parseJsonPayload } from './structured';

/**
 * Join prompt parts so each stays its own sentence. Caller instructions often
 * lack terminal punctuation ("Only the header"), and a bare space join ran them
 * into the next directive ("Only the header Detect and describe…").
 */
export function joinPromptParts(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/[.!?:;)\]"'`]$/u.test(part) ? part : `${part}.`))
    .join('\n');
}

/**
 * Simple Markdown mode: the model's Markdown is the artifact, preserved as
 * written (see {@link normalizeModelMarkdown}); the sections are an index over
 * that same text, never a lossy re-rendering of it.
 */
function processMarkdownIntoExtractedContent(text: string): ExtractedContent {
  const markdown = normalizeModelMarkdown(text);
  return { ...markdownToSections(markdown), markdown };
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

  const prompt = joinPromptParts([
    'Extract the document into the exact JSON structure described by the response schema.',
    'Use only information visible in the document. Do not invent missing values.',
    'Return JSON only, without Markdown fences or commentary.',
    ...(instructions?.map((instruction) => instruction.prompt) ?? []),
    ...(options?.detectImages ? ['Include relevant information visible in charts, diagrams, or images.'] : []),
    ...(options?.detectMathEquations ? ['Represent mathematical expressions accurately.'] : []),
  ]);
  const base64Data = fileData.split(',')[1] || fileData;
  let generationConfig: Record<string, unknown> = {
    maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    // Each continuation hop re-bills the input and runs inside one SDK call,
    // past --max-cost; a CONTINUATION stop is reported as truncated output.
    automaticContinuation: false,
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
  return parseJsonPayload<JsonValue>(response.text ?? '', 'Schema extraction');
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
          level: { type: 'integer', minimum: 1, maximum: 6 },
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
    // Each continuation hop re-bills the input and runs inside one SDK call,
    // past --max-cost; a CONTINUATION stop is reported as truncated output.
    automaticContinuation: false,
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

const CONTENT_KEYS = ['title', 'sections', 'content', 'headings', 'tables', 'code', 'lists', 'markdown'] as const;

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[], path: string): string | undefined {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedKeys.has(key));
  return extra === undefined ? undefined : `${path || 'the response'} has unexpected property "${extra}"`;
}

function stringArrayProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value)) return `${path} must be an array of strings`;
  const index = value.findIndex((entry) => typeof entry !== 'string');
  return index < 0 ? undefined : `${path}[${index}] must be a string`;
}

function optionalStringProblem(value: unknown, path: string): string | undefined {
  return value === undefined || typeof value === 'string' ? undefined : `${path} must be a string`;
}

/**
 * Explain the first way `value` departs from the OCR content schema, naming
 * the JSON path ("sections[2].content[0] must be a string"), or return
 * undefined when it conforms.
 */
export function describeExtractedContentMismatch(value: unknown): string | undefined {
  if (!isRecord(value)) return 'the response must be a JSON object';
  const topLevel = unexpectedKey(value, CONTENT_KEYS, '');
  if (topLevel) return topLevel;
  if (!Array.isArray(value.sections)) return 'sections must be an array';
  for (const [index, section] of value.sections.entries()) {
    const path = `sections[${index}]`;
    if (!isRecord(section)) return `${path} must be an object`;
    const problem = unexpectedKey(section, ['heading', 'level', 'content'], path)
      ?? optionalStringProblem(section.heading, `${path}.heading`)
      ?? (section.level !== undefined
        && !(Number.isInteger(section.level) && (section.level as number) >= 1 && (section.level as number) <= 6)
        ? `${path}.level must be an integer from 1 to 6`
        : undefined)
      ?? stringArrayProblem(section.content, `${path}.content`);
    if (problem) return problem;
  }
  const scalar = optionalStringProblem(value.title, 'title')
    ?? optionalStringProblem(value.content, 'content')
    ?? optionalStringProblem(value.markdown, 'markdown')
    ?? (value.headings !== undefined ? stringArrayProblem(value.headings, 'headings') : undefined)
    ?? (value.code !== undefined ? stringArrayProblem(value.code, 'code') : undefined);
  if (scalar) return scalar;
  if (value.tables !== undefined) {
    if (!Array.isArray(value.tables)) return 'tables must be an array';
    for (const [index, table] of value.tables.entries()) {
      const path = `tables[${index}]`;
      if (!isRecord(table)) return `${path} must be an object`;
      const problem = unexpectedKey(table, ['headers', 'rows', 'content'], path)
        ?? stringArrayProblem(table.headers, `${path}.headers`)
        ?? (Array.isArray(table.rows)
          ? table.rows.map((row, rowIndex) => stringArrayProblem(row, `${path}.rows[${rowIndex}]`)).find(Boolean)
          : `${path}.rows must be an array of string arrays`)
        ?? (typeof table.content === 'string' ? undefined : `${path}.content must be a string`);
      if (problem) return problem;
    }
  }
  if (value.lists !== undefined) {
    if (!Array.isArray(value.lists)) return 'lists must be an array';
    for (const [index, list] of value.lists.entries()) {
      const path = `lists[${index}]`;
      if (!isRecord(list)) return `${path} must be an object`;
      const problem = unexpectedKey(list, ['type', 'items'], path)
        ?? (list.type === 'ordered' || list.type === 'unordered'
          ? undefined
          : `${path}.type must be "ordered" or "unordered"`)
        ?? stringArrayProblem(list.items, `${path}.items`);
      if (problem) return problem;
    }
  }
  return undefined;
}

function hasText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasText);
  if (isRecord(value)) return Object.entries(value).some(([key, entry]) => key !== 'type' && key !== 'level' && hasText(entry));
  return false;
}

function outputInvalid(message: string, cause?: unknown): OcrError {
  return new OcrError(OcrErrorType.OUTPUT_INVALID, message, undefined, cause === undefined ? undefined : { cause });
}

/**
 * Turn raw model output into an ExtractedContent according to the requested
 * contract. When JSON was explicitly requested, an unparseable response is a
 * contract violation that throws — it is never silently downgraded to Markdown
 * (audit H-02). An empty response always throws (audit G-02/H-03), and so does
 * a well-formed JSON answer that carries no text at all (`{"sections":[]}`):
 * reporting that as a successful OCR would hide a model that read nothing.
 *
 * JSON is located with the same tolerance as template and `--schema` mode
 * (fences, prose, inline reasoning), and a failure says whether the response
 * was not JSON or was JSON of the wrong shape, naming the offending path.
 */
export function coerceExtractionResult(text: string, wantsJson: boolean): ExtractedContent {
  const trimmed = text.trim();
  if (!trimmed) {
    throw outputInvalid('Extraction returned an empty response');
  }
  if (wantsJson) {
    let parsed: unknown;
    try {
      parsed = parseJsonPayload<unknown>(trimmed, 'Extraction');
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/^Extraction returned invalid JSON: /u, '');
      throw outputInvalid(`Extraction requested JSON but the response was invalid JSON (${reason})`, error);
    }
    const mismatch = describeExtractedContentMismatch(parsed);
    if (mismatch) {
      throw outputInvalid(`Extraction requested JSON but the response did not match the OCR schema: ${mismatch}`);
    }
    if (!hasText(parsed)) {
      throw outputInvalid('Extraction returned JSON with no text content (no title, headings, or section text)');
    }
    return parsed as ExtractedContent;
  }
  const content = processMarkdownIntoExtractedContent(text);
  if (!content.markdown) {
    throw outputInvalid('Extraction returned an empty response');
  }
  return content;
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

    const prompt = joinPromptParts(promptParts);

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
