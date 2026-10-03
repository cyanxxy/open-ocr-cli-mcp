import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderUsage, type ProviderRuntimeConfig } from '@open-ocr/engine/providers';
import { validateEvalCase } from '@open-ocr/engine/evals';
import { formatEvalError, resolveEvalTokenPrices, runEvalCase } from '../../../evals/run';

const mocks = vi.hoisted(() => ({ generateContent: vi.fn(), createInteraction: vi.fn() }));

vi.mock('@open-ocr/engine/gemini/client', async () => {
  const actual = await vi.importActual<typeof import('@open-ocr/engine/gemini/client')>(
    '@open-ocr/engine/gemini/client',
  );
  return {
    ...actual,
    getGenAIClient: vi.fn(() => ({
      models: { generateContent: mocks.generateContent },
      interactions: { create: mocks.createInteraction },
    })),
  };
});

function config(inputPrice: number, outputPrice: number): ProviderRuntimeConfig {
  return {
    provider: 'gemini', gateway: 'direct', model: 'gemini-3.8-flash',
    apiKey: 'test-key', apiKeyEnv: 'TEST_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com',
    inputPricePerMillionUsd: inputPrice, outputPricePerMillionUsd: outputPrice,
  };
}

function evalCase(mode: 'simple' | 'agentic') {
  return validateEvalCase({
    id: `pricing-${mode}`, mode,
    tags: ['pricing'],
    inputPath: 'evals/corpus/raster/invoice.png',
    expectedAssertions: [{ type: 'not_contains', target: 'markdown', value: 'undefined' }],
  });
}

beforeEach(() => {
  mocks.generateContent.mockReset();
  mocks.createInteraction.mockReset();
  mocks.generateContent.mockResolvedValue({
    text: 'Invoice text', candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100, thoughtsTokenCount: 100 },
  });
  mocks.createInteraction.mockResolvedValue({
    id: 'priced-interaction', status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'No readable fields' }] }],
    usage: { total_input_tokens: 1_000, total_output_tokens: 100, total_thought_tokens: 100 },
  });
});

describe('eval case usage accounting', () => {
  it('isolates concurrent cases and repetitions while honoring custom Gemini prices', async () => {
    const before = getProviderUsage();
    const [first, second] = await Promise.all([
      runEvalCase(evalCase('simple'), config(100, 200), 0),
      runEvalCase(evalCase('simple'), config(1, 2), 1),
    ]);
    expect(first.result.execution).toMatchObject({ apiRequests: 1, estimatedCostUsd: 0.14, repeatIndex: 0 });
    expect(second.result.execution).toMatchObject({ apiRequests: 1, estimatedCostUsd: 0.0014, repeatIndex: 1 });
    expect(getProviderUsage()).toEqual(before);
  });

  it('records every Gemini agent continuation against the same isolated case prices', async () => {
    const before = getProviderUsage();
    const result = await runEvalCase(evalCase('agentic'), config(100, 200), 0);
    // The agent retries an empty opener once before returning partial output.
    expect(mocks.createInteraction).toHaveBeenCalledTimes(2);
    expect(result.result.execution).toMatchObject({ apiRequests: 2, estimatedCostUsd: 0.28 });
    expect(getProviderUsage()).toEqual(before);
  });
});

describe('eval price overrides', () => {
  it('uses provider pricing when no override is configured and accepts explicit zero rates', () => {
    expect(resolveEvalTokenPrices({})).toEqual({});
    expect(resolveEvalTokenPrices({
      EVAL_INPUT_USD_PER_MILLION: '0', EVAL_OUTPUT_USD_PER_MILLION: '0',
    })).toEqual({ inputPricePerMillionUsd: 0, outputPricePerMillionUsd: 0 });
    expect(resolveEvalTokenPrices({
      EVAL_INPUT_USD_PER_MILLION: ' 0.25 ', EVAL_OUTPUT_USD_PER_MILLION: '1.5',
    })).toEqual({ inputPricePerMillionUsd: 0.25, outputPricePerMillionUsd: 1.5 });
  });

  it.each(['EVAL_INPUT_USD_PER_MILLION', 'EVAL_OUTPUT_USD_PER_MILLION'])(
    'rejects a one-sided %s override', (key) => {
      expect(() => resolveEvalTokenPrices({ [key]: '1' })).toThrow('Set both');
    },
  );

  it.each(['', ' ', '-0.01', 'NaN', 'Infinity', '-Infinity', 'invalid'])(
    'rejects invalid rate %j on either side', (value) => {
      expect(() => resolveEvalTokenPrices({
        EVAL_INPUT_USD_PER_MILLION: value, EVAL_OUTPUT_USD_PER_MILLION: '1',
      })).toThrow('finite nonnegative');
      expect(() => resolveEvalTokenPrices({
        EVAL_INPUT_USD_PER_MILLION: '1', EVAL_OUTPUT_USD_PER_MILLION: value,
      })).toThrow('finite nonnegative');
    },
  );
});

describe('eval error diagnostics', () => {
  it('redacts opaque configured credentials before persisting case errors', async () => {
    const apiKey = 'custom-service-credential';
    const gatewayToken = 'custom-gateway-credential';
    mocks.generateContent.mockRejectedValue(new Error(
      `Access denied for ${apiKey} through ${gatewayToken}; check model permissions.`,
    ));
    const completed = await runEvalCase(evalCase('simple'), {
      ...config(1, 2), apiKey, gatewayToken,
    }, 0);
    expect(completed.result.execution?.runtimeError).toBe(
      'Access denied for [REDACTED] through [REDACTED]; check model permissions.',
    );
    expect(JSON.stringify(completed)).not.toContain(apiKey);
    expect(JSON.stringify(completed)).not.toContain(gatewayToken);
  });

  it('redacts escaped credentials and standard token patterns while preserving the provider reason', () => {
    const credential = 'opaque/key+"value';
    const message = JSON.stringify({ error: {
      message: `Denied ${credential} at ${encodeURIComponent(credential)}; Bearer unconfigured-token`,
      status: 'PERMISSION_DENIED',
    } });
    const formatted = formatEvalError(new Error(message), [credential]);
    expect(formatted).toContain('PERMISSION_DENIED');
    expect(formatted).toContain('Denied [REDACTED] at [REDACTED]');
    expect(formatted).not.toContain(credential);
    expect(formatted).not.toContain('unconfigured-token');
  });

  it('does not serialize arbitrary thrown objects into diagnostics', () => {
    expect(formatEvalError({ apiKey: 'opaque' })).toBe('Evaluation failed with a non-Error value.');
  });

  it('never echoes a misconfigured credential selector from the actual entrypoint', () => {
    const selector = 'accidentally-pasted-credential';
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts'], {
      cwd: path.resolve(),
      env: { PATH: process.env.PATH, EVAL_PROVIDER: 'gemini', EVAL_API_KEY_ENV: selector },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('EVAL_API_KEY_ENV to the name of a populated credential variable');
    expect(result.stderr).not.toContain(selector);
  });

  it('redacts custom environment credentials from fatal entrypoint diagnostics', () => {
    const credential = 'opaque-private-value';
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts'], {
      cwd: path.resolve(),
      env: {
        PATH: process.env.PATH,
        // Trigger a setup failure before any provider request. The fatal
        // renderer must still recognize a nonstandard configured key value.
        EVAL_PROVIDER: credential,
        EVAL_API_KEY_ENV: 'CUSTOM_PROVIDER_SECRET',
        CUSTOM_PROVIDER_SECRET: credential,
      },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported EVAL_PROVIDER: [REDACTED]');
    expect(result.stderr).not.toContain(credential);
  });
});
