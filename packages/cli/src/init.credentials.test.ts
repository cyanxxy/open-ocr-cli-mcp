import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderExecutionContext,
  getProviderUsage,
  providerDefaultBaseUrl,
  ProviderCostLimitError,
  type ProviderRuntimeConfig,
} from '@open-ocr/engine/providers';
import { validateProviderCredentials } from './init';

const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }));

vi.mock('@open-ocr/engine/gemini/client', async () => {
  const actual = await vi.importActual<typeof import('@open-ocr/engine/gemini/client')>(
    '@open-ocr/engine/gemini/client',
  );
  return {
    ...actual,
    getGenAIClient: vi.fn(() => ({ models: { generateContent: mockGenerateContent } })),
  };
});

function config(provider: 'gemini' | 'kimi'): ProviderRuntimeConfig {
  return {
    provider,
    gateway: 'direct',
    apiKey: 'test-key',
    apiKeyEnv: 'TEST_KEY',
    model: provider === 'gemini' ? 'gemini-3.8-flash' : 'kimi-k3',
    baseUrl: providerDefaultBaseUrl(provider),
    inputPricePerMillionUsd: 100,
    outputPricePerMillionUsd: 200,
  };
}

beforeEach(() => {
  mockGenerateContent.mockReset();
  mockGenerateContent.mockResolvedValue({
    text: 'OK',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100 },
  });
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 1_000, completion_tokens: 100 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))));
});

afterEach(() => vi.unstubAllGlobals());

describe('credential probe usage isolation', () => {
  it.each(['gemini', 'kimi'] as const)('preserves the supplied %s runtime and its cost ceiling', async (provider) => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 0.1 });
    const probe = { ...config(provider), runtime };
    await validateProviderCredentials(probe);
    expect(runtime.getUsage()).toMatchObject({ requests: 1, estimatedCostUsd: 0.12 });
    await expect(validateProviderCredentials(probe)).rejects.toBeInstanceOf(ProviderCostLimitError);
    expect(runtime.getUsage().requests).toBe(1);
  });

  it.each(['gemini', 'kimi'] as const)('isolates standalone %s probes from process-wide usage', async (provider) => {
    const before = getProviderUsage();
    await validateProviderCredentials(config(provider));
    await validateProviderCredentials(config(provider));
    expect(getProviderUsage()).toEqual(before);
  });
});
