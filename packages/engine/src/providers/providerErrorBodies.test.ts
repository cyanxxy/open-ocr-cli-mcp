import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChatCompletion,
  isQuotaExhaustedProviderError,
  isRetryableProviderError,
  isTransientBudgetProviderError,
  ProviderApiError,
} from './openaiCompatible';
import { isQuotaExhaustedError, providerRetryAfterMs } from './retry';
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

async function failWith(body: unknown, status: number, headers: Record<string, string> = {}, overrides = {}) {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })));
  const error = await createChatCompletion(config(overrides), request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProviderApiError);
  return error as ProviderApiError;
}

describe('OpenAI billing 429s (developers.openai.com/api/docs/guides/error-codes)', () => {
  it.each([
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])('never retries 429 %s', async (code) => {
    const error = await failWith({
      error: { message: 'You exceeded your current quota.', param: null, code },
    }, 429, { 'retry-after': '20' });
    expect(error.code).toBe(code);
    expect(isQuotaExhaustedProviderError(error)).toBe(true);
    expect(isQuotaExhaustedError(error)).toBe(true);
    expect(isRetryableProviderError(error)).toBe(false);
  });

  it('keeps error.type and treats type insufficient_quota as exhausted whatever the code says', async () => {
    const error = await failWith({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        param: null,
        code: 'some_new_billing_code',
      },
    }, 429);
    expect(error.code).toBe('some_new_billing_code');
    expect(error.type).toBe('insufficient_quota');
    expect(isQuotaExhaustedProviderError(error)).toBe(true);
    expect(isRetryableProviderError(error)).toBe(false);
  });

  it('still retries an ordinary rate limit', async () => {
    const error = await failWith({
      error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', param: null, code: 'slow_down' },
    }, 429, { 'retry-after': '2' });
    expect(isQuotaExhaustedError(error)).toBe(false);
    expect(isRetryableProviderError(error)).toBe(true);
    expect(error.retryAfterMs).toBe(2_000);
  });
});

describe('OpenRouter 402 (openrouter.ai/docs/api_reference/limits)', () => {
  const inFlight = {
    error: {
      code: 402,
      message: 'This request would exceed your available credits given your current in-flight requests. '
        + 'Retry after in-flight requests settle, or add credits.',
      metadata: {
        reason: 'in_flight_budget_exhausted',
        limit_source: 'openrouter_in_flight_budget',
        remedy_hint: 'Retry after your in-flight requests settle (see the Retry-After header). Adding credits at '
          + 'https://openrouter.ai/settings/credits raises your in-flight budget, up to a capped ceiling.',
      },
    },
  };
  const openrouter = { provider: 'openrouter' as const, baseUrl: 'http://127.0.0.1:1/api/v1', model: 'google/gemini-3.8-flash' };

  it('retries an in-flight-budget 402 after its Retry-After delay', async () => {
    const error = await failWith(inFlight, 402, { 'retry-after': '4' }, openrouter);
    expect(error.limitSource).toBe('openrouter_in_flight_budget');
    expect(error.retryAfterMs).toBe(4_000);
    expect(providerRetryAfterMs(new Error('wrapped', { cause: error }))).toBe(4_000);
    expect(isTransientBudgetProviderError(error)).toBe(true);
    expect(isQuotaExhaustedProviderError(error)).toBe(false);
    expect(isQuotaExhaustedError(error)).toBe(false);
    expect(isRetryableProviderError(error)).toBe(true);
  });

  it('keeps the in-flight 402 terminal when no Retry-After came with it', async () => {
    const error = await failWith(inFlight, 402, {}, openrouter);
    expect(isTransientBudgetProviderError(error)).toBe(false);
    expect(isQuotaExhaustedError(error)).toBe(true);
    expect(isRetryableProviderError(error)).toBe(false);
  });

  it('keeps every other 402 terminal even with Retry-After', async () => {
    for (const metadata of [
      { reason: 'weight_exceeds_budget', limit_source: 'openrouter_credits' },
      { limit_source: 'openrouter_key_limit' },
    ]) {
      const error = await failWith({ error: { code: 402, message: 'Insufficient credits', metadata } }, 402, { 'retry-after': '4' }, openrouter);
      expect(error.retryAfterMs).toBeUndefined();
      expect(isQuotaExhaustedError(error)).toBe(true);
      expect(isRetryableProviderError(error)).toBe(false);
    }
  });
});
