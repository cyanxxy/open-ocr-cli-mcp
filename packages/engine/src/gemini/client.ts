/**
 * Gemini AI client configuration and initialization
 * Handles API client creation and model configuration
 */

import { GoogleGenAI, ThinkingLevel as GoogleThinkingLevel } from '@google/genai';
import { logger } from '../logger';
import { isRecord } from './errorPayload';
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
  // CONTINUATION (@google/genai >= 2.26): the per-request decode limit was hit.
  // Automatic continuation is disabled on every request (each hop re-bills the
  // input past --max-cost), so this output is as incomplete as MAX_TOKENS.
  if (finishReason === 'MAX_TOKENS' || finishReason === 'CONTINUATION') {
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

const GOOGLE_RPC_QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure';
const GOOGLE_RPC_RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';

/**
 * Longest server-requested wait that still counts as a transient throttle.
 * Same threshold as Google's gemini-cli (`MAX_RETRYABLE_DELAY_SECONDS`): a
 * longer `retryDelay` means the caller is effectively locked out.
 */
const MAX_RETRYABLE_QUOTA_DELAY_SECONDS = 300;

/** Everything a thrown Gemini error (or its cause chain) says about a quota. */
interface GoogleQuotaEvidence {
  status?: number;
  /** Upper-cased status tokens and string codes, e.g. RESOURCE_EXHAUSTED, QUOTA_EXCEEDED. */
  codes: Set<string>;
  texts: string[];
  /** `google.rpc.*` detail objects recovered from any JSON body in the chain. */
  details: Array<Record<string, unknown>>;
}


function parseErrorBodyText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.includes('{')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function absorbErrorBody(body: unknown, evidence: GoogleQuotaEvidence, depth = 0): void {
  if (depth > 3) return;
  if (Array.isArray(body)) {
    for (const entry of body) absorbErrorBody(entry, evidence, depth + 1);
    return;
  }
  if (!isRecord(body)) return;
  const error = isRecord(body.error) ? body.error : body;
  if (typeof error.code === 'number') evidence.status ??= error.code;
  if (typeof error.code === 'string' && error.code) evidence.codes.add(error.code.toUpperCase());
  if (typeof error.status === 'string' && error.status) evidence.codes.add(error.status.toUpperCase());
  if (typeof error.message === 'string' && error.message) evidence.texts.push(error.message);
  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (isRecord(detail)) evidence.details.push(detail);
    }
  }
}

function collectGoogleQuotaEvidence(error: unknown): GoogleQuotaEvidence {
  const evidence: GoogleQuotaEvidence = { codes: new Set(), texts: [], details: [] };
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current === 'string') {
      evidence.texts.push(current);
      absorbErrorBody(parseErrorBodyText(current), evidence);
      break;
    }
    if (typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    const status = record.status ?? record.statusCode;
    if (typeof status === 'number') evidence.status ??= status;
    if (typeof record.code === 'number') evidence.status ??= record.code;
    if (typeof record.code === 'string' && record.code) {
      if (/^\d{3}$/u.test(record.code)) evidence.status ??= Number(record.code);
      else evidence.codes.add(record.code.toUpperCase());
    }
    for (const key of ['message', 'body'] as const) {
      const value = record[key];
      if (typeof value !== 'string' || !value) continue;
      evidence.texts.push(value);
      absorbErrorBody(parseErrorBodyText(value), evidence);
    }
    // The Interactions SDK keeps the parsed body on `error`.
    if (isRecord(record.error)) absorbErrorBody(record.error, evidence);
    current = record.cause;
  }
  return evidence;
}

/** "34.07s", "60s", "900ms" -> seconds (google.protobuf.Duration JSON form). */
function parseDurationSeconds(duration: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)(ms|s)\s*$/u.exec(duration);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return match[2] === 'ms' ? value / 1000 : value;
}

/** Phrases Google uses for a project without billing (400 FAILED_PRECONDITION / 403). */
const BILLING_NOT_ENABLED_PATTERN =
  /\bbilling (?:is not enabled|has not been enabled|is disabled|to be enabled)\b|\benable billing\b|\bBILLING_DISABLED\b/iu;
const SPENDING_CAP_PATTERN = /\b(?:spending|spend)\s+cap\b/iu;
/** A quota ID or limit name such as `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. */
const DAILY_QUOTA_ID_PATTERN = /\w(?:PerDay|Daily)\w*/u;

export type GeminiQuotaVerdict = 'terminal' | 'retryable';

/**
 * Classify a Gemini quota/throttle failure the way Google's own gemini-cli does
 * (`packages/core/src/utils/googleQuotaErrors.ts`, `classifyGoogleError`).
 *
 * Terminal — no retry inside one run can fix it:
 * - a `google.rpc.QuotaFailure` violation whose `quotaId` contains `PerDay` or
 *   `Daily` (or, when the body carried no violations, such a quota ID quoted in
 *   the message);
 * - `limit: 0` (the model has no quota on this tier);
 * - a project spending cap;
 * - a `RetryInfo.retryDelay` (or "Please retry in Xs") longer than 300s;
 * - the Interactions API's `quota_exceeded` (daily quota) or
 *   `payment_required` (prepaid credit depleted) codes;
 * - outside a 429 only, a project without billing enabled.
 *
 * Every other 429 / RESOURCE_EXHAUSTED is retryable: per-minute quota IDs, a
 * short `retryDelay`, or no structured detail at all. In particular the
 * standard 429 sentence "You exceeded your current quota, please check your
 * plan and billing details" is sent for per-minute limits too, so it is not a
 * billing signal.
 *
 * Returns undefined when the error is not a quota or throttle failure.
 */
export function classifyGeminiQuotaError(error: unknown): GeminiQuotaVerdict | undefined {
  const evidence = collectGoogleQuotaEvidence(error);
  const text = evidence.texts.join('\n');
  const { codes, status } = evidence;
  if (codes.has('QUOTA_EXCEEDED') || codes.has('PAYMENT_REQUIRED')) return 'terminal';
  const throttled = status === 429
    || codes.has('RESOURCE_EXHAUSTED')
    || codes.has('RATE_LIMIT_EXCEEDED')
    || codes.has('TOO_MANY_REQUESTS')
    || /\bRESOURCE_EXHAUSTED\b/u.test(text);
  if ((throttled || status === 400) && SPENDING_CAP_PATTERN.test(text)) return 'terminal';
  if (!throttled) {
    return BILLING_NOT_ENABLED_PATTERN.test(text) ? 'terminal' : undefined;
  }
  if (/limit:\s*0(?!\d|\.\d)/u.test(text.toLowerCase())) return 'terminal';

  const violations = evidence.details
    .filter((detail) => detail['@type'] === GOOGLE_RPC_QUOTA_FAILURE)
    .flatMap((detail) => (Array.isArray(detail.violations) ? detail.violations as unknown[] : []))
    .filter(isRecord);
  if (violations.some((violation) => typeof violation.quotaId === 'string'
    && (violation.quotaId.includes('PerDay') || violation.quotaId.includes('Daily')))) {
    return 'terminal';
  }
  if (violations.length === 0 && DAILY_QUOTA_ID_PATTERN.test(text)) return 'terminal';

  const retryInfo = evidence.details.find((detail) => detail['@type'] === GOOGLE_RPC_RETRY_INFO);
  let retryDelaySeconds = typeof retryInfo?.retryDelay === 'string'
    ? parseDurationSeconds(retryInfo.retryDelay)
    : undefined;
  if (retryDelaySeconds === undefined) {
    const match = /Please retry in ([0-9.]+(?:ms|s))/u.exec(text);
    if (match?.[1]) retryDelaySeconds = parseDurationSeconds(match[1]);
  }
  if (retryDelaySeconds !== undefined && retryDelaySeconds > MAX_RETRYABLE_QUOTA_DELAY_SECONDS) {
    return 'terminal';
  }
  return 'retryable';
}

/**
 * Gemini quota failures that no retry inside one batch can fix. See
 * {@link classifyGeminiQuotaError} for the rule; a per-minute
 * RESOURCE_EXHAUSTED stays retryable.
 */
export function isGeminiQuotaExhaustedError(error: unknown): boolean {
  return classifyGeminiQuotaError(error) === 'terminal';
}

/**
 * Detect transient Gemini API failures (rate-limit, quota, 5xx, overload,
 * network/timeout) that may succeed if retried with bounded backoff. The agent
 * loop retries these a few times before giving up rather than treating the
 * first 429/5xx as permanently fatal (audit H-17).
 */
export function isRetryableGeminiError(error: unknown): boolean {
  if (isFatalGeminiError(error)) return false;
  const quota = classifyGeminiQuotaError(error);
  if (quota) return quota === 'retryable';
  const { status, code } = structuredErrorMetadata(error);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  if (code && [
    'ABORTED',
    'API_ERROR',
    'DEADLINE_EXCEEDED',
    'EAI_AGAIN',
    'ECONNRESET',
    'ETIMEDOUT',
    'INTERNAL',
    'RATE_LIMIT_EXCEEDED',
    'RESOURCE_EXHAUSTED',
    'SERVICE_UNAVAILABLE',
    'TOO_MANY_REQUESTS',
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
 * - 3.8 Flash and 4 Argon: medium
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
