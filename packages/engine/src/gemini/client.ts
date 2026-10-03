/**
 * Gemini AI client configuration and initialization
 * Handles API client creation and model configuration
 */

import { GoogleGenAI, ThinkingLevel as GoogleThinkingLevel } from '@google/genai';
import { logger } from '../logger';
import { GeminiModel, OcrError, OcrErrorType, ThinkingLevel } from './types';
import { knownModelThinkingLevels, providerDefaultThinkingLevel } from '../providers/registry';

/**
 * Cache for GoogleGenAI instances to avoid recreating them
 */
const clientCache = new Map<string, GoogleGenAI>();

export interface GeminiTransportOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
}

/**
 * Get or create a raw GoogleGenAI client for APIs that need direct SDK access
 * such as the Interactions API.
 */
export function getGenAIClient(apiKey: string, transport: GeminiTransportOptions = {}): GoogleGenAI {
  if (!apiKey) {
    throw new OcrError(
      OcrErrorType.API_KEY_MISSING,
      'API key is required for Gemini AI'
    );
  }

  const cacheKey = JSON.stringify([apiKey, transport.baseUrl ?? '', transport.headers ?? {}]);
  const cached = clientCache.get(cacheKey);
  if (cached) {
    logger.debug(`Using cached GoogleGenAI client`);
    return cached;
  }

  // Retain only one client at a time. Clearing the cache before adding a new
  // entry prevents old API-key strings and their client objects from lingering
  // in memory for the page lifetime after a key rotation (audit H-14).
  clientCache.clear();
  try {
    const genAI = new GoogleGenAI({
      apiKey,
      ...((transport.baseUrl || transport.headers) ? {
        httpOptions: {
          ...(transport.baseUrl ? { baseUrl: transport.baseUrl } : {}),
          ...(transport.headers ? { headers: transport.headers } : {}),
        },
      } : {}),
    });
    clientCache.set(cacheKey, genAI);
    logger.info(`Created new GoogleGenAI client`);
    return genAI;
  } catch (error) {
    logger.error('Failed to create Gemini client:', error);
    throw new OcrError(
      OcrErrorType.API_KEY_MISSING,
      'Failed to initialize Gemini AI client',
      error
    );
  }
}

interface GeminiResponseStatus {
  candidates?: Array<{ finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

function assertNotFailedFinishReason(finishReason: string | undefined, operation: string): void {
  if (!finishReason || finishReason === 'STOP') return;
  if (finishReason === 'MAX_TOKENS') {
    throw new Error(
      `${operation} reached the output token limit and returned incomplete output. `
      + 'Increase the output-token limit or lower the thinking level and retry.',
    );
  }
  throw new Error(`${operation} did not complete normally (finishReason: ${finishReason})`);
}

function assertPromptNotBlocked(response: GeminiResponseStatus, operation: string): void {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`${operation} was blocked by safety filters (${blockReason})`);
  }
}

/**
 * Reject blocked or incomplete generateContent responses before callers parse
 * or persist them. A MAX_TOKENS response can contain plausible-looking text or
 * even valid JSON, but it is still truncated and must not be reported as a
 * successful OCR result.
 */
export function assertCompleteGeminiResponse(
  response: GeminiResponseStatus,
  operation = 'Gemini request',
): void {
  assertPromptNotBlocked(response, operation);
  const candidate = response.candidates?.[0];
  if (!candidate) {
    throw new Error(`${operation} returned no candidate and cannot be treated as complete`);
  }
  if (!candidate.finishReason) {
    throw new Error(`${operation} returned a candidate without a terminal finish reason and may be incomplete`);
  }
  assertNotFailedFinishReason(candidate.finishReason, operation);
}

export interface GeminiStreamCompletionTracker {
  observe: (chunk: GeminiResponseStatus) => void;
  assertComplete: () => void;
}

/**
 * Track completion across a generateContent stream. In-progress chunks may
 * have candidates without finishReason; the stream is successful only after a
 * candidate reports STOP. Later usage-only chunks do not erase that terminal
 * state.
 */
export function createGeminiStreamCompletionTracker(
  operation = 'Gemini request',
): GeminiStreamCompletionTracker {
  let sawCandidate = false;
  let lastCandidateFinishReason: string | undefined;
  return {
    observe: (chunk: GeminiResponseStatus): void => {
      assertPromptNotBlocked(chunk, operation);
      const candidate = chunk.candidates?.[0];
      if (!candidate) return;
      sawCandidate = true;
      lastCandidateFinishReason = candidate.finishReason;
      assertNotFailedFinishReason(lastCandidateFinishReason, operation);
    },
    assertComplete: (): void => {
      if (!sawCandidate || lastCandidateFinishReason !== 'STOP') {
        throw new Error(`${operation} stream ended without a terminal STOP and may be incomplete`);
      }
    },
  };
}

/**
 * Global generateContent media resolution for OCR.
 * Images: HIGH (fine text). PDFs: MEDIUM (docs: quality saturates at medium).
 */
export function generateContentMediaResolution(
  mimeType: string,
): 'MEDIA_RESOLUTION_HIGH' | 'MEDIA_RESOLUTION_MEDIUM' {
  if (mimeType === 'application/pdf' || mimeType.startsWith('application/')) {
    return 'MEDIA_RESOLUTION_MEDIUM';
  }
  return 'MEDIA_RESOLUTION_HIGH';
}

/**
 * Detect terminal Gemini API failures (bad/missing key, permission). These can
 * never succeed on retry, so the agent loop stops entirely rather than burning
 * iterations against an endpoint that will keep rejecting every request.
 *
 * Note: rate-limit / quota / 5xx are intentionally NOT here — they are transient
 * and handled by isRetryableGeminiError with backoff (audit H-17).
 */
function structuredErrorMetadata(error: unknown): { status?: number; code?: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let firstCode: string | undefined;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      const status = record.status ?? record.statusCode;
      const code = record.code;
      const numericStatus = typeof status === 'number'
        ? status
        : typeof code === 'number'
          ? code
          : typeof code === 'string' && /^\d{3}$/u.test(code)
            ? Number(code)
            : undefined;
      if (typeof code === 'string') firstCode ??= code.toUpperCase();
      if (numericStatus !== undefined) {
        return {
          status: numericStatus,
          ...(firstCode ? { code: firstCode } : {}),
        };
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return firstCode ? { code: firstCode } : {};
}

export function isFatalGeminiError(error: unknown): boolean {
  const { status, code } = structuredErrorMetadata(error);
  if (code && ['API_KEY_INVALID', 'UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(code)) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const credentialFailure = (
    message.includes('api key')
    || message.includes('api_key_invalid')
    || message.includes('invalid api key')
    || message.includes('permission_denied')
    || message.includes('permission denied')
    || message.includes('unauthorized')
    || message.includes('401')
    || message.includes('403')
  );
  if (status !== undefined) {
    // Google AI Studio can report an invalid API key as HTTP 400 rather than
    // 401. Use the credential-specific message only for that otherwise broad
    // status so unrelated INVALID_ARGUMENT errors are not misclassified.
    return status === 401 || status === 403 || (status === 400 && credentialFailure);
  }
  return credentialFailure;
}

/**
 * Detect transient Gemini API failures (rate-limit, quota, 5xx, overload,
 * network/timeout) that may succeed if retried with bounded backoff. The agent
 * loop retries these a few times before giving up rather than treating the
 * first 429/5xx as permanently fatal (audit H-17).
 */
export function isRetryableGeminiError(error: unknown): boolean {
  if (isFatalGeminiError(error)) return false;
  const { status, code } = structuredErrorMetadata(error);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  if (code && [
    'ABORTED',
    'DEADLINE_EXCEEDED',
    'EAI_AGAIN',
    'ECONNRESET',
    'ETIMEDOUT',
    'INTERNAL',
    'RESOURCE_EXHAUSTED',
    'UNAVAILABLE',
  ].includes(code)) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('resource_exhausted')
    || message.includes('rate limit')
    || message.includes('rate-limit')
    || message.includes('quota')
    || message.includes('429')
    || message.includes('500')
    || message.includes('502')
    || message.includes('503')
    || message.includes('504')
    || message.includes('unavailable')
    || message.includes('overloaded')
    || message.includes('internal error')
    || message.includes('network')
    || message.includes('timeout')
    || message.includes('econnreset')
    || message.includes('fetch failed')
  );
}

/**
 * Model-aware default thinking level when the host has not set one.
 * - Flash-Lite: minimal (API default; cheap/high-volume)
 * - Stable Flash: medium
 * - 3 Flash Preview: high
 * - 3.1 Pro: high
 */
export function defaultThinkingLevelForModel(modelName: GeminiModel): ThinkingLevel {
  return providerDefaultThinkingLevel('gemini', modelName);
}

/**
 * Resolve a host `ThinkingLevel` to the lowercase Gemini wire value, validated
 * against the selected model. Unsupported levels fail locally; they are never
 * silently rewritten.
 */
export function normalizeThinkingLevel(
  level: ThinkingLevel | undefined,
  modelName: GeminiModel,
): 'minimal' | 'low' | 'medium' | 'high' {
  const rawLevel = level ?? defaultThinkingLevelForModel(modelName);
  const normalized = typeof rawLevel === 'string' ? rawLevel.toUpperCase() : rawLevel;
  const allowed = knownModelThinkingLevels('gemini', modelName) ?? [];
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new Error(
      `${modelName} supports thinking levels ${allowed.map((entry) => entry.toLowerCase()).join(', ')}; `
      + `${String(rawLevel).toLowerCase()} is not supported`,
    );
  }
  return normalized.toLowerCase() as 'minimal' | 'low' | 'medium' | 'high';
}

function generateContentThinkingLevel(
  level: ThinkingLevel | undefined,
  modelName: GeminiModel,
): GoogleThinkingLevel {
  switch (normalizeThinkingLevel(level, modelName)) {
    case 'minimal': return GoogleThinkingLevel.MINIMAL;
    case 'low': return GoogleThinkingLevel.LOW;
    case 'medium': return GoogleThinkingLevel.MEDIUM;
    case 'high': return GoogleThinkingLevel.HIGH;
  }
}

/**
 * Apply thinking configuration to the generateContent SDK contract. The
 * Interactions API uses lowercase values through normalizeThinkingLevel().
 */
export function applyThinkingConfig(
  generationConfig: Record<string, unknown>,
  modelName: GeminiModel,
  thinkingConfig?: { level: ThinkingLevel; includeThoughts?: boolean }
) {
  return {
    ...generationConfig,
    thinkingConfig: {
      thinkingLevel: generateContentThinkingLevel(thinkingConfig?.level, modelName),
      ...(thinkingConfig?.includeThoughts && { includeThoughts: true }),
    },
  };
}
