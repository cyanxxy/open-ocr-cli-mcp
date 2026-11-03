import { isGeminiQuotaExhaustedError, isRetryableGeminiError } from '../gemini/client';
import {
  isQuotaExhaustedProviderError,
  isRetryableProviderError,
  isTransientBudgetProviderError,
} from './openaiCompatible';
import { parseRetryAfterHeader } from './retryAfter';
import type { ProviderId } from './types';

export { parseRetryAfterHeader };

/** Provider-neutral retry classification for CLI and service callers. */
export function isRetryableExtractionError(
  provider: ProviderId,
  error: unknown,
): boolean {
  return provider === 'gemini'
    ? isRetryableGeminiError(error)
    : isRetryableProviderError(error);
}

/**
 * True when the provider says the account itself is out of quota or credit —
 * OpenAI `insufficient_quota`, an HTTP 402, Moonshot's exhausted balance, a
 * Gemini per-day or zero-limit quota. Retrying such a request cannot succeed
 * until someone changes the account, and every attempt is a wasted request.
 * OpenRouter's in-flight-budget 402 with Retry-After is the one documented
 * transient 402 and is never reported as exhausted.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  if (isTransientBudgetProviderError(error)) return false;
  return isQuotaExhaustedProviderError(error) || isGeminiQuotaExhaustedError(error);
}

/**
 * Bounded exponential backoff with jitter for transient provider failures.
 * `retry` is the 0-based index of the retry being scheduled; a non-positive
 * `baseDelayMs` disables the delay entirely (used by tests and dry runs).
 */
export function transientRetryDelayMs(retry: number, baseDelayMs = 750): number {
  if (baseDelayMs <= 0) return 0;
  return baseDelayMs * 2 ** retry + Math.floor(Math.random() * 250);
}

/** Longest server-requested delay the CLI will honour before one retry. */
export const MAX_RETRY_AFTER_MS = 60_000;

function recordValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Gemini does not expose response headers through the SDK error, but its
 * RESOURCE_EXHAUSTED body carries `google.rpc.RetryInfo` with a `retryDelay`
 * such as `"37s"` or `"1.5s"`.
 */
function geminiRetryInfoDelayMs(message: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/u.exec(message);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

/**
 * The delay a provider asked for before retrying, walking the cause chain so a
 * retry-layer wrapper does not hide it. Undefined when the provider gave none.
 */
export function providerRetryAfterMs(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const direct = recordValue(current, 'retryAfterMs');
    if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;
    const message = recordValue(current, 'message');
    if (typeof message === 'string') {
      const status = recordValue(current, 'status') ?? recordValue(current, 'code');
      if (status === 429 || status === 503 || /RESOURCE_EXHAUSTED|UNAVAILABLE/u.test(message)) {
        const delay = geminiRetryInfoDelayMs(message);
        if (delay !== undefined) return delay;
      }
    }
    current = recordValue(current, 'cause');
  }
  return undefined;
}

/**
 * Delay before the next attempt: the provider's own `Retry-After` (capped at
 * {@link MAX_RETRY_AFTER_MS}) when it sent one, otherwise jittered backoff.
 */
export function providerRetryDelayMs(
  retry: number,
  error: unknown,
  baseDelayMs = 750,
  maxRetryAfterMs = MAX_RETRY_AFTER_MS,
): number {
  const requested = providerRetryAfterMs(error);
  if (requested !== undefined) return Math.min(requested, maxRetryAfterMs);
  return transientRetryDelayMs(retry, baseDelayMs);
}
