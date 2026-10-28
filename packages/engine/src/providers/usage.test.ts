import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderRuntimeConfig } from './types';
import { getProviderUsage, recordProviderUsage, resetProviderUsage } from './usage';
import { createProviderExecutionContext, ProviderCostLimitError } from './runtime';

const openRouterConfig: ProviderRuntimeConfig = {
  provider: 'openrouter',
  gateway: 'direct',
  apiKey: 'secret',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  model: 'google/gemini-3.8-flash',
  baseUrl: 'https://openrouter.ai/api/v1',
};

beforeEach(() => resetProviderUsage());

describe('provider usage accounting', () => {
  it('treats an explicitly reported zero cost as free when no local prices exist', () => {
    recordProviderUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        cost: 0,
      },
    }, {
      ...openRouterConfig,
      // Unknown model: no built-in price table, so zero remains free.
      model: 'vendor/unknown-free-model',
    });

    expect(getProviderUsage()).toMatchObject({
      requests: 1,
      totalTokens: 1100,
      estimatedCostUsd: 0,
    });
  });

  it('falls back to local pricing when exact cost is zero but tokens were billed', () => {
    recordProviderUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        cost: 0,
      },
    }, {
      ...openRouterConfig,
      inputPricePerMillionUsd: 2,
      outputPricePerMillionUsd: 10,
    });

    expect(getProviderUsage().estimatedCostUsd).toBe(0.003);
  });

  it('uses configured pricing when the provider omits billed cost', () => {
    recordProviderUsage({
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
    }, {
      ...openRouterConfig,
      inputPricePerMillionUsd: 2,
      outputPricePerMillionUsd: 10,
    });

    expect(getProviderUsage().estimatedCostUsd).toBe(0.003);
  });

  it('does not charge cached Kimi input at the uncached rate', () => {
    recordProviderUsage({
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 100_000,
        total_tokens: 1_100_000,
        prompt_tokens_details: { cached_tokens: 250_000 },
      },
    }, {
      ...openRouterConfig,
      provider: 'kimi',
      model: 'kimi-k2.6',
    });

    expect(getProviderUsage()).toMatchObject({
      cachedTokens: 250_000,
      estimatedCostUsd: 1.1525,
    });
  });

  it('keeps concurrent job accounting and cost gates isolated', async () => {
    const first = createProviderExecutionContext({ maxCostUsd: 0.001 });
    const second = createProviderExecutionContext({ maxCostUsd: 1 });
    recordProviderUsage({ usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.002 } }, openRouterConfig, first);
    recordProviderUsage({ usage: { prompt_tokens: 2, total_tokens: 2, cost: 0.0001 } }, openRouterConfig, second);

    expect(first.getUsage()).toMatchObject({ requests: 1, totalTokens: 1, estimatedCostUsd: 0.002 });
    expect(second.getUsage()).toMatchObject({ requests: 1, totalTokens: 2, estimatedCostUsd: 0.0001 });
    await expect(first.waitForRequestSlot()).rejects.toBeInstanceOf(ProviderCostLimitError);
    await expect(second.waitForRequestSlot()).resolves.toBeUndefined();
    expect(getProviderUsage()).toMatchObject({ requests: 0, estimatedCostUsd: 0 });
  });

  it('adds the usage of every chained interaction request', () => {
    const runtime = createProviderExecutionContext();
    runtime.recordUsage({
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 20,
        total_tool_use_tokens: 12,
        total_cached_tokens: 40,
        total_tokens: 120,
      },
    }, openRouterConfig);
    runtime.recordUsage({
      usage: {
        total_input_tokens: 150,
        total_output_tokens: 30,
        total_tokens: 180,
      },
    }, openRouterConfig);

    expect(runtime.getUsage()).toMatchObject({
      requests: 2,
      inputTokens: 250,
      outputTokens: 50,
      toolTokens: 12,
      cachedTokens: 40,
      totalTokens: 300,
    });
  });

  it('sums per-step usage once and adds later interaction request totals', () => {
    const runtime = createProviderExecutionContext();
    runtime.recordUsageParts([
      { usage: { total_input_tokens: 10, total_tokens: 10 } },
      { usage: { total_output_tokens: 4, total_tokens: 4 } },
    ], openRouterConfig);
    runtime.recordUsageParts([
      { usage: { total_input_tokens: 20, total_tokens: 20 } },
      { usage: { total_output_tokens: 6, total_tokens: 6 } },
    ], openRouterConfig);
    runtime.recordUsage({
      usage: {
        total_input_tokens: 35,
        total_output_tokens: 12,
        total_tokens: 47,
      },
    }, openRouterConfig);

    expect(runtime.getUsage()).toMatchObject({
      requests: 3,
      inputTokens: 65,
      outputTokens: 22,
      totalTokens: 87,
    });
  });

  it('uses unrounded cost for the request gate and normalizes malformed counters', async () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 0.000001 });
    runtime.recordUsage({
      usage: {
        input_tokens: 1.9,
        output_tokens: -4,
        total_tokens: 1.9,
        cost: 0.000000996,
      },
    });

    expect(runtime.getUsage()).toMatchObject({
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      estimatedCostUsd: 0.000001,
    });
    expect(runtime.hasReachedCostLimit()).toBe(false);
    await expect(runtime.waitForRequestSlot()).resolves.toBeUndefined();

    runtime.recordUsage({ usage: { total_tokens: 1, cost: 0.00000001 } });
    expect(runtime.hasReachedCostLimit()).toBe(true);
    await expect(runtime.waitForRequestSlot()).rejects.toBeInstanceOf(ProviderCostLimitError);
  });
});
