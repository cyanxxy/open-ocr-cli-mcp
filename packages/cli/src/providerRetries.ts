import { waitForAbortableAgentDelay } from '@open-ocr/engine/agentStepStream';
import {
  isProviderCostLimitError,
  isQuotaExhaustedError,
  isRetryableExtractionError,
  providerRetryAfterMs,
  providerRetryDelayMs,
} from '@open-ocr/engine/providers';
import { CliExitError } from './errors';
import type { ResolvedCliOptions } from './types';

export interface ProviderRetryResult<T> {
  value: T;
  attempts: number;
}

export class ExtractionAttemptsError extends Error {
  constructor(error: unknown, readonly attempts: number) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'ExtractionAttemptsError';
  }
}

/**
 * Optional per-attempt timeout (off by default). When enabled, non-final
 * attempts get at most two thirds of the remaining document budget (never less
 * than {@link MIN_ATTEMPT_TIMEOUT_MS}) and a timed-out attempt is retried.
 *
 * It is not enabled for CLI or MCP runs: a non-streaming provider request gives
 * no signal that separates a hung connection from a slow but healthy one (large
 * PDFs with thinking routinely take minutes), so cutting an attempt short would
 * re-send, and re-bill, work the provider is still doing. Each attempt instead
 * inherits the document's own --timeout, as in 4.3.0.
 */
const MIN_ATTEMPT_TIMEOUT_MS = 30_000;
const ATTEMPT_BUDGET_FRACTION = 2 / 3;
/** A retry needs at least this much of the document budget to be worth sending. */
const MIN_RETRY_BUDGET_MS = 1_000;

export class AttemptTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Provider request produced no response within ${(timeoutMs / 1000).toFixed(0)}s; retrying`);
    this.name = 'AttemptTimeoutError';
  }
}

function isRetryableFailure(options: ResolvedCliOptions, error: unknown): boolean {
  if (error instanceof AttemptTimeoutError) return true;
  if (isQuotaExhaustedError(error)) return false;
  if (error instanceof CliExitError) return error.retryable;
  return isRetryableExtractionError(options.provider, error);
}

export interface ProviderRetryOptions {
  /**
   * Epoch ms at which the document's hard timeout fires. Defaults to now plus
   * `--timeout`, which is an upper bound because the document timer started
   * slightly earlier.
   */
  deadlineMs?: number;
  /** Enable the per-attempt timeout described above. Off by default. */
  perAttemptTimeout?: boolean;
  /** Override the per-attempt timeout floor (tests). */
  minAttemptTimeoutMs?: number;
}

/**
 * The timeout for one attempt, or undefined when it should simply inherit the
 * document's own deadline (the last allowed attempt, or no time to split).
 */
export function attemptTimeoutMs(
  remainingMs: number,
  attemptsLeft: number,
  minAttemptTimeoutMs = MIN_ATTEMPT_TIMEOUT_MS,
): number | undefined {
  if (attemptsLeft <= 1) return undefined;
  const budget = Math.max(minAttemptTimeoutMs, Math.floor(remainingMs * ATTEMPT_BUDGET_FRACTION));
  // Leave room for the retry itself, with margin for timer drift.
  return budget <= remainingMs - 2 * MIN_RETRY_BUDGET_MS ? budget : undefined;
}

/**
 * Run one provider operation under the CLI's bounded retry contract.
 *
 * Each attempt receives its own signal, which aborts with the document signal
 * (and, only when `perAttemptTimeout` is set, after a per-attempt timeout).
 * A provider `Retry-After` (seconds or
 * HTTP-date, capped at 60s) replaces the jittered backoff, and a retry that
 * could not start before the document deadline is not attempted.
 */
export async function runWithProviderRetries<T>(
  options: ResolvedCliOptions,
  signal: AbortSignal,
  operation: (attemptSignal: AbortSignal) => Promise<T>,
  retryOptions: ProviderRetryOptions = {},
): Promise<ProviderRetryResult<T>> {
  const allowedAttempts = options.mode === 'agentic' ? 1 : options.retries + 1;
  const deadlineMs = retryOptions.deadlineMs ?? Date.now() + options.timeoutSeconds * 1000;
  for (let attempt = 1; attempt <= allowedAttempts; attempt += 1) {
    const timeoutMs = retryOptions.perAttemptTimeout
      ? attemptTimeoutMs(
          deadlineMs - Date.now(),
          allowedAttempts - attempt + 1,
          retryOptions.minAttemptTimeoutMs,
        )
      : undefined;
    const attemptController = new AbortController();
    const relay = (): void => attemptController.abort(signal.reason);
    signal.addEventListener('abort', relay, { once: true });
    if (signal.aborted) relay();
    let attemptTimedOut = false;
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          attemptTimedOut = true;
          attemptController.abort(new AttemptTimeoutError(timeoutMs));
        }, timeoutMs);
    try {
      return { value: await operation(attemptController.signal), attempts: attempt };
    } catch (rawError) {
      const error = attemptTimedOut && !signal.aborted && timeoutMs !== undefined
        ? new AttemptTimeoutError(timeoutMs)
        : rawError;
      if (
        signal.aborted
        || attempt === allowedAttempts
        // A cost ceiling is a decision, not a transient fault: retrying spends
        // the whole backoff budget re-asking a runtime that has already refused,
        // and contradicts the COST_LIMIT taxonomy (retryable: false).
        || isProviderCostLimitError(error)
        || !isRetryableFailure(options, error)
      ) {
        throw new ExtractionAttemptsError(error, attempt);
      }
      const delayMs = error instanceof AttemptTimeoutError ? 0 : providerRetryDelayMs(attempt - 1, error);
      // Never sleep past the document deadline: a Retry-After the document
      // cannot honour fails now, with the provider's own error, rather than
      // later as an unexplained TIMEOUT.
      if (Date.now() + delayMs + MIN_RETRY_BUDGET_MS >= deadlineMs) {
        throw new ExtractionAttemptsError(
          providerRetryAfterMs(error) !== undefined
            ? new Error(
                `${error instanceof Error ? error.message : String(error)} `
                + `(provider asked to retry after ${(delayMs / 1000).toFixed(1)}s, beyond the remaining --timeout)`,
                { cause: error },
              )
            : error,
          attempt,
        );
      }
      try {
        await waitForAbortableAgentDelay(delayMs, signal);
      } catch (waitError) {
        throw new ExtractionAttemptsError(waitError, attempt);
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', relay);
    }
  }
  throw new ExtractionAttemptsError(
    new Error('Extraction exhausted its retry budget'),
    allowedAttempts,
  );
}
