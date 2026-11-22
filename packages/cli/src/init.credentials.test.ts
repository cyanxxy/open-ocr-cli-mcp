import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderExecutionContext,
  getProviderUsage,
  providerDefaultBaseUrl,
  ProviderCostLimitError,
  type ProviderRuntimeConfig,
} from '@open-ocr/engine/providers';
import { CliExitError } from './errors';
import { CREDENTIAL_PROBE_TIMEOUT_MS, validateProviderCredentials } from './init';

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

/** A request that is accepted and never answered: it settles only on abort. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

describe('credential probe deadline', () => {
  it('bounds the probe by default, since the global fetch dispatcher has no timeouts', () => {
    expect(CREDENTIAL_PROBE_TIMEOUT_MS).toBe(60_000);
  });

  it('cuts an OpenAI-compatible endpoint that never answers', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => hangUntilAborted(init?.signal ?? undefined));
    vi.stubGlobal('fetch', fetchMock);
    const failure = await validateProviderCredentials(config('kimi'), 20).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliExitError);
    expect(failure).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect((failure as Error).message).toContain('did not answer the credential check within 1 second');
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('cuts a Gemini endpoint that never answers', async () => {
    mockGenerateContent.mockImplementation((request: { config?: { abortSignal?: AbortSignal } }) => (
      hangUntilAborted(request.config?.abortSignal)
    ));
    await expect(validateProviderCredentials(config('gemini'), 20)).rejects.toMatchObject({
      name: 'CliExitError', code: 'TIMEOUT',
    });
  });

  it('keeps provider errors that arrive before the deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'Invalid API key' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }))));
    await expect(validateProviderCredentials(config('kimi'), 5_000)).rejects.toMatchObject({
      name: 'ProviderApiError',
    });
  });
});
