import { describe, expect, it } from 'vitest';
import { recordGeminiUsage, recordGeminiInteractionUsage } from '@open-ocr/engine/gemini';
import { createProviderExecutionContext, ProviderCostLimitError } from '@open-ocr/engine/providers';
import { resolveCliOptions } from './config';
import { providerRuntimeConfig } from './providerRuntime';

describe('provider runtime pricing', () => {
  it('applies explicit Gemini prices across native API surfaces and enforces the job cost gate', async () => {
    const options = resolveCliOptions({
      model: 'gemini-3.8-flash', inputPrice: '100', outputPrice: '200', maxCost: '0.2', dryRun: true,
    }, {}, '/workspace');
    const runtime = createProviderExecutionContext({ maxCostUsd: options.maxCostUsd });
    providerRuntimeConfig(options, runtime);
    recordGeminiUsage({ usageMetadata: {
      promptTokenCount: 1_000, candidatesTokenCount: 100, thoughtsTokenCount: 100,
    } }, 'gemini-3.8-flash', runtime);
    expect(runtime.getUsage().estimatedCostUsd).toBe(0.14);
    await expect(runtime.waitForRequestSlot()).resolves.toBeUndefined();
    recordGeminiInteractionUsage({ usage: {
      total_input_tokens: 1_000, total_output_tokens: 100, total_thought_tokens: 100,
    } }, 'gemini-3.8-flash', runtime);
    expect(runtime.getUsage().estimatedCostUsd).toBe(0.28);
    await expect(runtime.waitForRequestSlot()).rejects.toBeInstanceOf(ProviderCostLimitError);
  });

  it('keeps custom prices isolated between jobs and selected models', () => {
    const runtime = createProviderExecutionContext();
    const separateJob = createProviderExecutionContext();
    providerRuntimeConfig(resolveCliOptions({
      model: 'gemini-3.5-flash', inputPrice: '100', outputPrice: '200', dryRun: true,
    }, {}, '/workspace'), runtime);
    const response = { usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100 } };
    recordGeminiUsage(response, 'gemini-3.1-flash-lite', runtime);
    recordGeminiUsage(response, 'gemini-3.5-flash', separateJob);
    expect(runtime.getUsage().estimatedCostUsd).toBe(0.0004);
    expect(separateJob.getUsage().estimatedCostUsd).toBe(0.0024);
  });

  it('creates independent contexts and applies cost policy when callers omit a runtime', async () => {
    const options = resolveCliOptions({
      model: 'gemini-3.8-flash', inputPrice: '100', outputPrice: '200', maxCost: '0.1', dryRun: true,
    }, {}, '/workspace');
    const first = providerRuntimeConfig(options).runtime;
    const second = providerRuntimeConfig(options).runtime;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    if (!first || !second) throw new Error('Expected per-call runtimes');
    recordGeminiUsage({ usageMetadata: {
      promptTokenCount: 1_000, candidatesTokenCount: 100,
    } }, 'gemini-3.8-flash', first);
    expect(first.getUsage().estimatedCostUsd).toBe(0.12);
    expect(second.getUsage().requests).toBe(0);
    await expect(first.waitForRequestSlot()).rejects.toBeInstanceOf(ProviderCostLimitError);
    await expect(second.waitForRequestSlot()).resolves.toBeUndefined();
  });
});
