import { afterEach, describe, expect, it, vi } from 'vitest';

import { isGeminiQuotaExhaustedError, isRetryableGeminiError } from '../gemini/client';
import {
  createChatCompletion,
  isQuotaExhaustedProviderError,
  isRetryableProviderError,
  ProviderApiError,
} from './openaiCompatible';
import {
  isQuotaExhaustedError,
  parseRetryAfterHeader,
  providerRetryAfterMs,
  providerRetryDelayMs,
} from './retry';
import { createProviderExecutionContext, ProviderCostLimitError } from './runtime';
import type { ProviderRuntimeConfig } from './types';

afterEach(() => vi.unstubAllGlobals());

function config(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    provider: 'openai-compatible',
    gateway: 'direct',
    apiKey: 'secret',
    apiKeyEnv: 'OPEN_OCR_API_KEY',
    model: 'vision-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    ...overrides,
  };
}

const request = { messages: [{ role: 'user' as const, content: 'Extract' }], maxTokens: 64 };
const completion = (usage?: Record<string, number>) => Response.json({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
  ...(usage ? { usage } : {}),
});

describe('Retry-After', () => {
  it('parses delta-seconds and HTTP-date forms', () => {
    const now = Date.parse('2026-11-01T00:00:00.000Z');
    expect(parseRetryAfterHeader('7', now)).toBe(7_000);
    expect(parseRetryAfterHeader('0.5', now)).toBe(500);
    expect(parseRetryAfterHeader('Sun, 01 Nov 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterHeader('Sat, 31 Oct 2026 23:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterHeader('soon', now)).toBeUndefined();
    expect(parseRetryAfterHeader(null, now)).toBeUndefined();
  });

  it('reads Retry-After from a 429/503 response onto the thrown provider error', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_exceeded' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } },
    )));
    const error = await createChatCompletion(config(), request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect((error as ProviderApiError).retryAfterMs).toBe(3_000);
    expect(providerRetryAfterMs(new Error('wrapped', { cause: error }))).toBe(3_000);
  });

  it('ignores Retry-After on statuses that are not throttling', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'bad' } }),
      { status: 500, headers: { 'retry-after': '3' } },
    )));
    const error = await createChatCompletion(config(), request).catch((caught: unknown) => caught);
    expect((error as ProviderApiError).retryAfterMs).toBeUndefined();
  });

  it('reads Gemini RetryInfo and caps any requested delay at 60s', () => {
    const gemini = Object.assign(new Error(JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
      },
    })), { status: 429 });
    expect(providerRetryAfterMs(gemini)).toBe(37_000);
    const huge = new ProviderApiError('slow', 429);
    huge.retryAfterMs = 3_600_000;
    expect(providerRetryDelayMs(0, huge)).toBe(60_000);
    // Without a hint, the jittered backoff applies.
    expect(providerRetryDelayMs(0, new ProviderApiError('slow', 429))).toBeGreaterThanOrEqual(750);
  });
});

describe('quota exhaustion', () => {
  it('never retries OpenAI insufficient_quota, billing limits, or HTTP 402', () => {
    for (const code of ['insufficient_quota', 'billing_hard_limit_reached', 'exceeded_current_quota_error']) {
      const error = new ProviderApiError('You exceeded your current quota', 429, code);
      expect(isQuotaExhaustedProviderError(error)).toBe(true);
      expect(isRetryableProviderError(error)).toBe(false);
    }
    const credits = new ProviderApiError('Insufficient credits', 402);
    expect(isRetryableProviderError(credits)).toBe(false);
    expect(isQuotaExhaustedError(new Error('wrapped', { cause: credits }))).toBe(true);
    // A plain throttle stays retryable.
    expect(isRetryableProviderError(new ProviderApiError('slow down', 429, 'rate_limit_exceeded'))).toBe(true);
    // Muse: a non-streaming request past the server time limit times out again.
    expect(isRetryableProviderError(new ProviderApiError('took too long', 504, 'gateway_timeout'))).toBe(false);
    expect(isRetryableProviderError(new ProviderApiError('bad gateway', 504))).toBe(true);
  });

  it('treats a Gemini per-day or zero-limit quota as exhausted, per-minute as transient', () => {
    const perDay = Object.assign(new Error(
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for quota metric '
      + '\'Generate requests\' and limit \'GenerateRequestsPerDayPerProjectPerModel-FreeTier\'"}}',
    ), { status: 429 });
    const zero = Object.assign(new Error(
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded, limit: 0"}}',
    ), { status: 429 });
    const perMinute = Object.assign(new Error(
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"GenerateRequestsPerMinutePerProjectPerModel"}}',
    ), { status: 429 });
    expect(isGeminiQuotaExhaustedError(perDay)).toBe(true);
    expect(isRetryableGeminiError(perDay)).toBe(false);
    expect(isRetryableGeminiError(zero)).toBe(false);
    expect(isRetryableGeminiError(perMinute)).toBe(true);
  });
});

describe('usage accounting', () => {
  it('counts every HTTP attempt, including failed ones', async () => {
    const runtime = createProviderExecutionContext();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(completion({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })));
    await expect(createChatCompletion(config({ runtime }), request)).rejects.toBeInstanceOf(ProviderApiError);
    await createChatCompletion(config({ runtime }), request);
    expect(runtime.getUsage()).toMatchObject({ requests: 2, totalTokens: 12 });
    expect(runtime.getUsage().unreportedUsageRequests).toBeUndefined();
  });

  it('records responses without usage, and only warns on a free route', async () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 1 });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(completion())));
    const free = config({ runtime, inputPricePerMillionUsd: 0, outputPricePerMillionUsd: 0 });
    await createChatCompletion(free, request);
    await createChatCompletion(free, request);
    expect(runtime.getUsage()).toMatchObject({ requests: 2, unreportedUsageRequests: 2 });
    expect(runtime.wasUsageUnknownUnderCostLimit()).toBe(false);
    expect(runtime.hasReachedCostLimit()).toBe(false);
  });

  it('fails closed under --max-cost when a paid response reports no usage', async () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 5 });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(completion())));
    const paid = config({ runtime, inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2 });
    await createChatCompletion(paid, request);
    expect(runtime.wasUsageUnknownUnderCostLimit()).toBe(true);
    expect(runtime.hasReachedCostLimit()).toBe(true);
    const blocked = await createChatCompletion(paid, request).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(ProviderCostLimitError);
    expect((blocked as ProviderCostLimitError).usageUnknown).toBe(true);
    expect(runtime.getUsage().requests).toBe(1);
  });

  it('enforces the cap against spend recorded by earlier runs', () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 1 });
    runtime.setPriorCostUsd(0.6);
    runtime.recordUsage({ usage: { input_tokens: 1, total_tokens: 1, cost: 0.3 } });
    expect(runtime.hasReachedCostLimit()).toBe(false);
    runtime.recordUsage({ usage: { input_tokens: 1, total_tokens: 1, cost: 0.1 } });
    expect(runtime.hasReachedCostLimit()).toBe(true);
    // The snapshot is this run's spend only; the prior total lives in the manifest.
    expect(runtime.getUsage().estimatedCostUsd).toBeCloseTo(0.4);
  });
});
