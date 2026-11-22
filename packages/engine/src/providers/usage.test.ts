import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderRuntimeConfig } from './types';
import { getProviderUsage, recordProviderUsage, resetProviderUsage } from './usage';
import { estimateProviderRequestCostUsd } from './registry';
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
      model: 'kimi-k3.1-pro',
    });

    expect(getProviderUsage()).toMatchObject({
      cachedTokens: 250_000,
      estimatedCostUsd: 2.55,
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

describe('OpenRouter BYOK cost accounting', () => {
  const byokUsage = (extra: Record<string, unknown>) => ({
    usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000, ...extra },
  });

  it('adds the upstream provider charge to the OpenRouter fee', () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 5 });
    runtime.recordUsage(byokUsage({
      cost: 0.06,
      is_byok: true,
      cost_details: { upstream_inference_cost: 1.2 },
    }), openRouterConfig);
    expect(runtime.getUsage().estimatedCostUsd).toBe(1.26);
  });

  it('accepts the split upstream input and output charges', () => {
    const runtime = createProviderExecutionContext();
    runtime.recordUsage(byokUsage({
      cost: 0.06,
      is_byok: true,
      cost_details: { upstream_inference_input_cost: 0.75, upstream_inference_output_cost: 0.45 },
    }), openRouterConfig);
    expect(runtime.getUsage().estimatedCostUsd).toBe(1.26);
  });

  it('counts a waived fee plus the upstream charge on an unlisted model and trips the cap', async () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 1 });
    runtime.recordUsage(byokUsage({
      cost: 0,
      is_byok: true,
      cost_details: { upstream_inference_cost: 1.2 },
    }), { ...openRouterConfig, model: 'some/unlisted-model' });
    expect(runtime.getUsage().estimatedCostUsd).toBe(1.2);
    expect(runtime.hasReachedCostLimit()).toBe(true);
    await expect(runtime.waitForRequestSlot()).rejects.toBeInstanceOf(ProviderCostLimitError);
  });

  it('never treats a BYOK fee without an upstream figure as the whole charge', () => {
    const runtime = createProviderExecutionContext();
    runtime.recordUsage(byokUsage({ cost: 0.06, is_byok: true }), openRouterConfig);
    const localEstimate = estimateProviderRequestCostUsd(openRouterConfig, 1_000_000, 100_000, 0);
    expect(localEstimate).toBeGreaterThan(0.06);
    expect(runtime.getUsage().estimatedCostUsd).toBeGreaterThanOrEqual(localEstimate);
    expect(runtime.getUsage().estimatedCostUsd).toBeCloseTo(0.06 + localEstimate, 8);
  });

  it('leaves non-BYOK usage with a null upstream figure unchanged', () => {
    const runtime = createProviderExecutionContext();
    runtime.recordUsage(byokUsage({
      cost: 0.06,
      is_byok: false,
      cost_details: { upstream_inference_cost: null },
    }), openRouterConfig);
    expect(runtime.getUsage().estimatedCostUsd).toBe(0.06);
  });
});

describe('unmetered paid usage across resumed runs', () => {
  const paid = { provider: 'openai-compatible', model: 'm', inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2 } as const;
  const free = { provider: 'openai-compatible', model: 'm', inputPricePerMillionUsd: 0, outputPricePerMillionUsd: 0 } as const;

  it('counts unreported responses at paid prices, capped or not, and only those', () => {
    const runtime = createProviderExecutionContext();
    runtime.recordUsage({}, paid);
    runtime.recordUsage({}, free);
    expect(runtime.getUsage()).toMatchObject({ unreportedUsageRequests: 2, unmeteredPaidRequests: 1 });
    expect(runtime.wasUsageUnknownUnderCostLimit()).toBe(false);

    const freeOnly = createProviderExecutionContext({ maxCostUsd: 1 });
    freeOnly.recordUsage({}, free);
    expect(freeOnly.getUsage()).not.toHaveProperty('unmeteredPaidRequests');
    expect(freeOnly.hasReachedCostLimit()).toBe(false);
  });

  it('fails closed for a capped rerun whose earlier run left spend unknown, across resetUsage', async () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 5 });
    runtime.setPriorUsageUnknown();
    runtime.resetUsage();
    expect(runtime.hasReachedCostLimit()).toBe(true);
    expect(runtime.wasUsageUnknownUnderCostLimit()).toBe(true);
    await expect(runtime.waitForRequestSlot()).rejects.toMatchObject({ usageUnknown: true, limitUsd: 5 });
    expect(runtime.wasCostLimitDenied()).toBe(true);

    runtime.configure({ maxCostUsd: 5 });
    expect(runtime.hasReachedCostLimit()).toBe(false);
  });

  it('ignores prior unknown spend when no cap is set', async () => {
    const runtime = createProviderExecutionContext();
    runtime.setPriorUsageUnknown();
    expect(runtime.hasReachedCostLimit()).toBe(false);
    await expect(runtime.waitForRequestSlot()).resolves.toBeUndefined();
  });
});

describe('usage listener', () => {
  it('runs synchronously after every recorded response and never throws into the caller', () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 100 });
    const seen: number[] = [];
    runtime.setUsageListener(() => {
      seen.push(runtime.getUsage().estimatedCostUsd);
    });
    runtime.recordUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 4.5 } }, openRouterConfig);
    runtime.recordUsage({}, openRouterConfig);
    runtime.recordUsageParts([{ usage: { total_input_tokens: 1, total_tokens: 1, cost: 4.5 } }], openRouterConfig);
    expect(seen).toEqual([4.5, 4.5, 9]);

    runtime.setUsageListener(() => {
      throw new Error('disk full');
    });
    expect(() => runtime.recordUsage({ usage: { total_tokens: 1, cost: 1 } }, openRouterConfig)).not.toThrow();
    expect(runtime.getUsage().estimatedCostUsd).toBe(10);

    runtime.setUsageListener(undefined);
    runtime.recordUsage({ usage: { total_tokens: 1, cost: 1 } }, openRouterConfig);
    expect(seen).toHaveLength(3);
  });
});
