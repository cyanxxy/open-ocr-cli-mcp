import { ProviderApiError } from '@open-ocr/engine/providers';
import { describe, expect, it, vi } from 'vitest';

import { resolveCliOptions } from './config';
import { ocrErrorPayload } from './errors';
import { attemptTimeoutMs, runWithProviderRetries } from './providerRetries';

function throttled(retryAfterMs?: number, code = 'rate_limit_exceeded', status = 429): ProviderApiError {
  const error = new ProviderApiError('Too many requests', status, code);
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

const options = resolveCliOptions({ provider: 'openrouter', retries: '3', timeout: '30' }, {}, process.cwd());

describe('provider retry timing', () => {
  it('waits for the provider Retry-After instead of the jittered backoff', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(throttled(120))
      .mockResolvedValue('ok');
    const started = Date.now();
    const result = await runWithProviderRetries(options, new AbortController().signal, operation);
    expect(result).toEqual({ value: 'ok', attempts: 2 });
    // Default backoff for the first retry is >= 750ms; Retry-After asked for 120ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it('fails at once with the provider error when Retry-After exceeds the remaining document time', async () => {
    const operation = vi.fn(() => Promise.reject(throttled(45_000)));
    const started = Date.now();
    const failure = await runWithProviderRetries(
      options,
      new AbortController().signal,
      operation,
      { deadlineMs: Date.now() + 5_000 },
    ).catch((error: unknown) => error);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(operation).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({ attempts: 1 });
    expect(ocrErrorPayload(failure)).toMatchObject({ code: 'RATE_LIMITED' });
    expect((failure as Error).message).toContain('beyond the remaining --timeout');
  });

  it('does not retry an exhausted OpenAI quota (insufficient_quota on HTTP 429)', async () => {
    const operation = vi.fn(() => Promise.reject(throttled(undefined, 'insufficient_quota')));
    const failure = await runWithProviderRetries(options, new AbortController().signal, operation)
      .catch((error: unknown) => error);
    expect(operation).toHaveBeenCalledOnce();
    expect(ocrErrorPayload(failure)).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: false,
      hint: 'Check the provider account balance and quota before retrying.',
    });
  });

  it('does not retry an HTTP 402 out-of-credit response', async () => {
    const operation = vi.fn(() => Promise.reject(new ProviderApiError('Insufficient credits', 402)));
    await expect(runWithProviderRetries(options, new AbortController().signal, operation))
      .rejects.toMatchObject({ attempts: 1 });
    expect(operation).toHaveBeenCalledOnce();
  });

  it('retries a hung attempt on its own timeout instead of spending the whole document timeout', async () => {
    let calls = 0;
    const operation = vi.fn((signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) {
        // A connection that never answers: only the attempt signal ends it.
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        });
      }
      return Promise.resolve('second attempt');
    });
    const started = Date.now();
    const result = await runWithProviderRetries(
      options,
      new AbortController().signal,
      operation,
      { deadlineMs: Date.now() + 6_000, minAttemptTimeoutMs: 100 },
    );
    expect(result).toEqual({ value: 'second attempt', attempts: 2 });
    // Two thirds of a 6s budget, not the full 6s.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('gives the final attempt the whole remaining budget', () => {
    expect(attemptTimeoutMs(120_000, 1)).toBeUndefined();
    expect(attemptTimeoutMs(120_000, 4)).toBe(80_000);
    expect(attemptTimeoutMs(40_000, 3)).toBe(30_000);
    // Too little left to split: inherit the document deadline.
    expect(attemptTimeoutMs(31_000, 2)).toBeUndefined();
  });
});
