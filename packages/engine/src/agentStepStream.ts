import type { AgentStep, StepCallback } from './agentTypes';

export interface AgentDeadline {
  signal: AbortSignal;
  hasExpired: () => boolean;
  dispose: () => void;
}

/** One deadline covers active requests, tools, rate waits, and retry backoff. */
export function createAgentDeadline(durationMs: number, signal?: AbortSignal): AgentDeadline {
  const controller = new AbortController();
  const reason = new Error('Agent document time budget exhausted');
  const expiresAt = Date.now() + durationMs;
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(reason), durationMs);
  timer.unref();
  return {
    signal: combined,
    hasExpired: () => combined.aborted
      ? combined.reason === reason
      : Date.now() >= expiresAt,
    dispose: () => clearTimeout(timer),
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}

/** Delay agent retries/iterations without making cancellation wait for a timer. */
export function waitForAbortableAgentDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal ? abortReason(signal) : new DOMException('Operation aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Bridge a callback-based model/tool operation into a genuinely live async
 * generator. This avoids buffering an entire provider turn before callers see
 * progress while retaining a normal Promise result for the control loop.
 */
export async function* streamAgentOperation<T>(
  operation: (onStep: StepCallback) => Promise<T>,
): AsyncGenerator<AgentStep, T, unknown> {
  const queue: AgentStep[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let result: T | undefined;
  let failure: unknown;
  let failed = false;

  const notify = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  void operation((step) => {
    queue.push(step);
    notify();
  }).then(
    (value) => { result = value; },
    (error: unknown) => { failed = true; failure = error; },
  ).finally(() => {
    settled = true;
    notify();
  });

  while (!settled || queue.length > 0) {
    const step = queue.shift();
    if (step) {
      yield step;
      continue;
    }
    // Arm the waiter, then re-check so a notify between empty-check and arming
    // cannot leave live progress stalled until the operation settles.
    await new Promise<void>((resolve) => {
      wake = resolve;
      if (queue.length > 0 || settled) {
        wake = undefined;
        resolve();
      }
    });
  }

  if (failed) {
    throw failure instanceof Error
      ? failure
      : new Error(typeof failure === 'string' ? failure : 'Agent operation failed');
  }
  return result as T;
}
