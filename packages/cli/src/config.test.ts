import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listExtractionPresets } from '@open-ocr/engine/templates';
import {
  assertCredentialsAvailable,
  credentialSetupGuidance,
  ignoredModeScopedOptionWarning,
  ignoredModeScopedOptions,
  loadCliConfig,
  loadLocalEnv,
  resolveCliOptions,
  suppliedModeScopedFlags,
} from './config';
import { ocrErrorPayload } from './errors';
import { modeFingerprint } from './ocrJobService';
import { ocrExtractionSemanticError } from './protocol';
import type { ExtractCommandFlags } from './types';

const originalApiKey = process.env.GEMINI_API_KEY;
const originalGatewayToken = process.env.CLOUDFLARE_AI_GATEWAY_TOKEN;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  delete process.env.OPEN_OCR_PROVIDER;
  delete process.env.OPEN_OCR_GATEWAY;
  delete process.env.OPEN_OCR_MODEL;
  delete process.env.OPEN_OCR_THINKING;
  delete process.env.OPEN_OCR_NO_CONFIG;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  if (originalGatewayToken === undefined) delete process.env.CLOUDFLARE_AI_GATEWAY_TOKEN;
  else process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = originalGatewayToken;
});

describe('CLI configuration', () => {
  it('uses safe defaults and environment credentials', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const options = resolveCliOptions({}, {}, '/workspace');
    expect(options).toMatchObject({
      apiKey: 'test-key',
      model: 'gemini-3.8-flash',
      thinking: 'MEDIUM',
      mode: 'simple',
      format: 'markdown',
      concurrency: 2,
      retries: 3,
      resume: true,
    });
  });

  it('resolves the default directory excludes from config and flags', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(resolveCliOptions({}, {}, '/workspace').defaultExcludes).toBe(true);
    expect(resolveCliOptions({}, { defaultExcludes: false }, '/workspace').defaultExcludes).toBe(false);
    // --no-default-excludes has to reach the resolver even when a config file
    // asked for the excludes, and --default-excludes has to win back.
    expect(resolveCliOptions({ defaultExcludes: false }, { defaultExcludes: true }, '/workspace').defaultExcludes)
      .toBe(false);
    expect(resolveCliOptions({ defaultExcludes: true }, { defaultExcludes: false }, '/workspace').defaultExcludes)
      .toBe(true);
  });

  it('lets CLI flags override environment and file configuration', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.OPEN_OCR_MODEL = 'gemini-3-flash-preview';
    const options = resolveCliOptions(
      { model: 'gemini-3.1-pro-preview', thinking: 'high', concurrency: '6' },
      { model: 'gemini-3.1-flash-lite', thinking: 'LOW', concurrency: 3 },
      '/workspace',
    );
    expect(options.model).toBe('gemini-3.1-pro-preview');
    expect(options.thinking).toBe('HIGH');
    expect(options.concurrency).toBe(6);
  });

  it('resolves named provider defaults and arbitrary OpenRouter model IDs', () => {
    process.env.MOONSHOT_API_KEY = 'kimi-key';
    expect(resolveCliOptions({ provider: 'kimi' }, {}, '/workspace')).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k3',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      baseUrl: 'https://api.moonshot.ai/v1',
      thinking: 'MAX',
      maxTokens: 131_072,
    });
    process.env.OPENROUTER_API_KEY = 'router-key';
    expect(resolveCliOptions(
      { provider: 'openrouter', model: 'vendor/custom-vision' },
      {},
      '/workspace',
    )).toMatchObject({ provider: 'openrouter', model: 'vendor/custom-vision' });
    expect(resolveCliOptions(
      { provider: 'openrouter', model: 'moonshotai/kimi-k3' },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'MAX', maxTokens: 131_072 });
    expect(resolveCliOptions(
      { provider: 'openrouter', model: 'vendor/model-with-max', thinking: 'max', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'MAX' });
    expect(resolveCliOptions(
      {
        provider: 'openrouter',
        model: 'vendor/current-coding-model',
        thinking: 'xhigh',
        maxTokens: '131072',
        dryRun: true,
      },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'XHIGH', maxTokens: 131_072 });
    expect(resolveCliOptions(
      { provider: 'kimi', thinking: 'minimal', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'LOW' });
    expect(() => resolveCliOptions(
      { provider: 'kimi', thinking: 'medium', dryRun: true },
      {},
      '/workspace',
    )).toThrow('ambiguous silent upgrade');
    expect(resolveCliOptions(
      { provider: 'openrouter', model: 'moonshotai/kimi-k3', thinking: 'minimal', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'LOW' });
    expect(() => resolveCliOptions(
      { provider: 'openrouter', model: 'moonshotai/kimi-k3', thinking: 'medium', dryRun: true },
      {},
      '/workspace',
    )).toThrow('ambiguous silent upgrade');
    expect(() => resolveCliOptions(
      { provider: 'openrouter', model: 'moonshotai/kimi-k3', thinking: 'xhigh', dryRun: true },
      {},
      '/workspace',
    )).toThrow('not a Kimi K3 effort');
    expect(resolveCliOptions(
      { provider: 'openrouter', model: 'moonshotai/kimi-k3:exacto', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'MAX', maxTokens: 131_072 });
    expect(() => resolveCliOptions(
      { provider: 'openrouter', model: 'moonshotai/kimi-k3:exacto', thinking: 'medium', dryRun: true },
      {},
      '/workspace',
    )).toThrow('ambiguous silent upgrade');
  });

  it('refuses --format csv for a preset that extracts one record per document', () => {
    expect(() => resolveCliOptions(
      { preset: 'business-card', format: 'csv', dryRun: true },
      {},
      '/workspace',
    )).toThrow(/cannot produce CSV rows.*invoice, receipt/su);
    // The same rejection has to fire when the preset comes from configuration,
    // which is the shape that reached the provider and billed a call before.
    expect(() => resolveCliOptions(
      { format: 'csv', dryRun: true },
      { preset: 'resume' },
      '/workspace',
    )).toThrow('cannot produce CSV rows');
    expect(resolveCliOptions(
      { preset: 'invoice', format: 'csv', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ preset: 'invoice', format: 'csv' });
    expect(resolveCliOptions(
      { preset: 'business-card', format: 'json', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ preset: 'business-card', format: 'json' });
  });

  it('states the csv preset-shape rule the same way the request vocabulary does', () => {
    // `extract` resolves through resolveCliOptions while `run` and `mcp` resolve
    // through parseOcrJobRequest, so this rule exists twice. It has to teach the
    // same thing from either surface, in that surface's vocabulary.
    const requestMessage = ocrExtractionSemanticError({
      mode: 'template',
      preset: 'business-card',
      hasSchema: false,
      contentFormat: 'csv',
    });
    let flagMessage = '';
    try {
      resolveCliOptions({ preset: 'business-card', format: 'csv', dryRun: true }, {}, '/workspace');
    } catch (error) {
      flagMessage = (error as Error).message;
    }

    const shared = 'business-card extracts a single record per document, so it cannot produce CSV rows';
    expect(requestMessage).toContain(shared);
    expect(flagMessage).toContain(shared);
    expect(requestMessage).toContain('extraction.contentFormat json or markdown, or a table preset');
    expect(flagMessage).toContain('--format json or markdown, or a table preset');
    expect(flagMessage).not.toContain('extraction.');
    expect(requestMessage).not.toContain('--format');
    // Both offer exactly the tabular presets the registry declares, so a preset
    // added later is offered by both without either list being hand-maintained.
    const tablePresets = listExtractionPresets()
      .filter((candidate) => candidate.outputShape === 'table')
      .map((candidate) => candidate.id)
      .join(', ');
    expect(requestMessage).toContain(`or a table preset: ${tablePresets}`);
    expect(flagMessage).toContain(`or a table preset: ${tablePresets}`);
  });

  it('does not carry provider-coupled settings across a provider switch', () => {
    process.env.MOONSHOT_API_KEY = 'kimi-key';
    const options = resolveCliOptions({ provider: 'kimi' }, {
      model: 'gemini-3.1-flash-lite',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseUrl: 'https://gemini.example/v1',
      thinking: 'MINIMAL',
      maxTokens: 1024,
      inputPricePerMillionUsd: 99,
      outputPricePerMillionUsd: 999,
    }, '/workspace');
    expect(options).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k3',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      baseUrl: 'https://api.moonshot.ai/v1',
      thinking: 'MAX',
      maxTokens: 131_072,
      inputPricePerMillionUsd: undefined,
      outputPricePerMillionUsd: undefined,
    });
  });

  it('does not invent effort tiers for direct Kimi models with boolean or mandatory thinking', () => {
    expect(resolveCliOptions({
      provider: 'kimi', model: 'kimi-k2.7-code', dryRun: true,
    }, {}, '/workspace')).toMatchObject({ thinking: 'HIGH' });
    expect(() => resolveCliOptions({
      provider: 'kimi', model: 'kimi-k2.7-code', thinking: 'low', dryRun: true,
    }, {}, '/workspace')).toThrow('does not expose configurable reasoning effort');
    expect(resolveCliOptions({
      provider: 'kimi', model: 'kimi-k2.6', thinking: 'minimal', dryRun: true,
    }, {}, '/workspace')).toMatchObject({ thinking: 'MINIMAL' });
    expect(() => resolveCliOptions({
      provider: 'kimi', model: 'kimi-k2.6', thinking: 'medium', dryRun: true,
    }, {}, '/workspace')).toThrow('instant mode');
  });

  it('does not carry a direct base URL across a gateway switch', () => {
    const options = resolveCliOptions({
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
      cloudflareByok: true,
      dryRun: true,
    }, {
      gateway: 'direct',
      baseUrl: 'https://direct.example/v1',
    }, '/workspace');
    expect(options.baseUrl).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio');
  });

  it('does not carry a provider-specific Cloudflare BYOK alias across a provider switch', () => {
    const options = resolveCliOptions({
      provider: 'kimi',
      cloudflareProvider: 'moonshot',
      dryRun: true,
    }, {
      provider: 'gemini',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
      cloudflareByok: true,
      cloudflareByokAlias: 'gemini-production',
    }, '/workspace');

    expect(options).toMatchObject({
      provider: 'kimi',
      gateway: 'cloudflare',
      cloudflareByok: false,
      cloudflareByokAlias: undefined,
    });
  });

  it('requires an explicit price pair when a configured model is overridden', () => {
    expect(() => resolveCliOptions({
      provider: 'kimi',
      model: 'kimi-next',
      maxCost: '1',
      dryRun: true,
    }, {
      provider: 'kimi',
      model: 'kimi-k2.6',
      inputPricePerMillionUsd: 1,
      outputPricePerMillionUsd: 2,
    }, '/workspace')).toThrow('requires both --input-price and --output-price');
  });

  it('enables max-cost for published Kimi and Muse prices', () => {
    expect(resolveCliOptions({
      provider: 'kimi',
      maxCost: '1',
      dryRun: true,
    }, {}, '/workspace').maxCostUsd).toBe(1);
    expect(resolveCliOptions({
      provider: 'muse',
      maxCost: '1',
      dryRun: true,
    }, {}, '/workspace').maxCostUsd).toBe(1);
  });

  it('accepts an explicit zero-price route with a cost ceiling', () => {
    const options = resolveCliOptions({
      provider: 'openai-compatible',
      model: 'local-vision',
      baseUrl: 'https://example.test/v1',
      maxCost: '1',
      inputPrice: '0',
      outputPrice: '0',
      dryRun: true,
    }, {}, '/workspace');

    expect(options).toMatchObject({
      maxCostUsd: 1,
      inputPricePerMillionUsd: 0,
      outputPricePerMillionUsd: 0,
    });
  });

  it('builds Cloudflare native and custom-provider routes without serializing keys', () => {
    process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'gateway-token';
    const gemini = resolveCliOptions({
      provider: 'gemini',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
      cloudflareByok: true,
    }, {}, '/workspace');
    expect(gemini).toMatchObject({
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio',
      apiKey: '',
      cloudflareByok: true,
    });
    const kimi = resolveCliOptions({
      provider: 'kimi',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
      cloudflareProvider: 'moonshot',
      cloudflareByok: true,
    }, {}, '/workspace');
    expect(kimi.baseUrl).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/custom-moonshot/v1');
  });

  it('rejects Cloudflare stored-key flags outside a Cloudflare BYOK route', () => {
    expect(() => resolveCliOptions({
      provider: 'gemini',
      gateway: 'direct',
      cloudflareByok: true,
      dryRun: true,
    }, {}, '/workspace')).toThrow('--cloudflare-byok requires --gateway cloudflare');
    expect(() => resolveCliOptions({
      provider: 'gemini',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
      cloudflareByokAlias: 'stored-key',
      dryRun: true,
    }, {}, '/workspace')).toThrow('--cloudflare-byok-alias requires --cloudflare-byok');
  });

  it('makes a preset imply template mode and accepts CSV', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const options = resolveCliOptions({ preset: 'invoice', format: 'csv' }, {}, '/workspace');
    expect(options.mode).toBe('template');
    expect(options.preset).toBe('invoice');
    expect(options.format).toBe('csv');
    expect(resolveCliOptions({ mode: 'template', preset: 'invoice' }, {}, '/workspace')).toMatchObject({
      mode: 'template',
      preset: 'invoice',
    });
  });

  it('rejects a preset the named mode would silently discard', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    // The preset would otherwise survive into resolved options while the runner
    // only reads it in template mode, so the run quietly returns markdown.
    expect(() => resolveCliOptions({ mode: 'simple', preset: 'invoice' }, {}, '/workspace'))
      .toThrow('--preset is only available in template mode');
    expect(() => resolveCliOptions({ mode: 'agentic', preset: 'invoice' }, {}, '/workspace'))
      .toThrow('--preset is only available in template mode');
    // A `mode` key in file configuration demotes the preset the same way.
    expect(() => resolveCliOptions({ preset: 'invoice' }, { mode: 'simple' }, '/workspace'))
      .toThrow('--preset is only available in template mode');
    let thrown: unknown;
    try {
      resolveCliOptions({ mode: 'simple', preset: 'invoice' }, {}, '/workspace');
    } catch (error) {
      thrown = error;
    }
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
    });
  });

  it('keeps the resume fingerprint stable now that an inert preset cannot resolve', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const simple = resolveCliOptions({ mode: 'simple' }, {}, '/workspace');
    expect(simple.preset).toBeUndefined();
    expect(modeFingerprint(simple)).toBe(modeFingerprint(resolveCliOptions({}, {}, '/workspace')));
    // The rejected variant used to hash an ignored preset into the fingerprint,
    // so it could never resume a manifest written by plain --mode simple.
    expect(() => resolveCliOptions({ mode: 'simple', preset: 'invoice' }, {}, '/workspace')).toThrow();
  });

  it('classifies numeric flag failures as configuration errors, not runtime timeouts', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const numericFailures: Array<[ExtractCommandFlags, string]> = [
      [{ timeout: '0' }, '--timeout must be an integer from 1 to 3600'],
      [{ concurrency: '0' }, '--concurrency must be an integer from 1 to 16'],
      [{ maxIterations: '99' }, '--max-iterations must be an integer from 1 to 20'],
      [{ confidenceThreshold: '2' }, '--confidence-threshold must be between 0 and 1'],
      [{ maxTotalMb: '0' }, '--max-total-mb must be between 1 and 1048576'],
    ];
    for (const [flags, message] of numericFailures) {
      let thrown: unknown;
      try {
        resolveCliOptions(flags, {}, '/workspace');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toBe(message);
      // A retry harness must not loop on a permanent flag error; before this
      // was typed, the word "timeout" in the flag name classified its own error.
      expect(ocrErrorPayload(thrown, 2)).toMatchObject({
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
      });
    }
  });

  it('names an unreadable explicit configuration file without leaking an errno', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-config-missing-'));
    try {
      let thrown: unknown;
      try {
        await loadCliConfig(directory, 'nope.json');
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toBe('Configuration file not found: nope.json');
      expect((thrown as Error).message).not.toContain('ENOENT');
      expect((thrown as Error).message).not.toContain(directory);
      expect(ocrErrorPayload(thrown, 2)).toMatchObject({
        code: 'CONFIG_INVALID',
        category: 'configuration',
      });

      let directoryThrown: unknown;
      try {
        await loadCliConfig(directory, '.');
      } catch (error) {
        directoryThrown = error;
      }
      expect((directoryThrown as Error).message).toBe('Configuration path is not a file: .');
      expect((directoryThrown as Error).message).not.toContain('EISDIR');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports the options a resolved mode will not read', () => {
    expect(suppliedModeScopedFlags({})).toEqual([]);
    // Commander defaults --instruction to [], so an untyped flag must not warn.
    expect(suppliedModeScopedFlags({ instruction: [], exclude: [] })).toEqual([]);
    expect(suppliedModeScopedFlags({
      detectMath: true,
      maxIterations: '9',
      confidenceThreshold: '0.5',
      instruction: ['read the table'],
    })).toEqual(['detectMath', 'instructions', 'maxIterations', 'confidenceThreshold']);

    expect(ignoredModeScopedOptions(['detectMath', 'maxIterations'], 'simple')).toEqual(['maxIterations']);
    expect(ignoredModeScopedOptions(['detectMath', 'maxIterations'], 'agentic')).toEqual(['detectMath']);
    // --max-tokens reaches simple and agentic extraction but never the preset path.
    expect(ignoredModeScopedOptions(['maxTokens'], 'template')).toEqual(['maxTokens']);
    expect(ignoredModeScopedOptions(['maxTokens'], 'simple')).toEqual([]);
    expect(ignoredModeScopedOptions(['progress'], 'simple')).toEqual(['progress']);

    expect(ignoredModeScopedOptionWarning([], 'simple', 'flag')).toBeUndefined();
    expect(ignoredModeScopedOptionWarning(['maxIterations', 'progress'], 'simple', 'flag')).toBe(
      'ignoring option(s) that simple mode does not use: --max-iterations, --progress',
    );
    expect(ignoredModeScopedOptionWarning(['detectMath'], 'template', 'field')).toBe(
      'ignoring option(s) that template mode does not use: extraction.detectMath',
    );
  });

  it('preserves an explicit minimal effort for agentic Flash models that support it', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(resolveCliOptions({ model: 'gemini-3.6-flash', mode: 'agentic', thinking: 'minimal' }, {}, '/workspace').thinking).toBe('MINIMAL');
  });

  it('uses model-aware Gemini defaults and rejects unsupported Pro minimal effort', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(resolveCliOptions({ model: 'gemini-3.1-flash-lite' }, {}, '/workspace').thinking).toBe('MINIMAL');
    expect(resolveCliOptions({ model: 'gemini-3-flash-preview' }, {}, '/workspace').thinking).toBe('HIGH');
    expect(resolveCliOptions({ model: 'gemini-3.1-pro-preview' }, {}, '/workspace').thinking).toBe('HIGH');
    expect(() => resolveCliOptions(
      { model: 'gemini-3.1-pro-preview', thinking: 'minimal' },
      {},
      '/workspace',
    )).toThrow('minimal is not supported');
  });

  it('validates current Gemini and Muse model efforts before requesting credentials', () => {
    expect(resolveCliOptions({ model: 'gemini-3.8-flash', dryRun: true }, {}, '/workspace').thinking).toBe('MEDIUM');
    expect(resolveCliOptions({ model: 'gemini-3.5-flash-lite', dryRun: true }, {}, '/workspace').thinking).toBe('MINIMAL');
    for (const provider of ['gemini', 'openrouter'] as const) {
      const model = provider === 'gemini' ? 'gemini-3.8-flash' : 'google/gemini-3.8-flash';
      expect(() => resolveCliOptions({ provider, model, thinking: 'minimal', dryRun: true }, {}, '/workspace'))
        .toThrow('minimal is not supported');
    }
    expect(resolveCliOptions({ provider: 'muse', thinking: 'max', dryRun: true }, {}, '/workspace'))
      .toMatchObject({ model: 'muse-spark-1.3', thinking: 'MAX' });
    expect(() => resolveCliOptions({
      provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: 'max', dryRun: true,
    }, {}, '/workspace')).toThrow('Muse Spark 1.3 Standard');
  });

  it('accepts a credential-free generic endpoint on IPv6 loopback', () => {
    expect(resolveCliOptions({
      provider: 'openai-compatible', model: 'vision', baseUrl: 'http://[::1]:11434/v1',
    }, {}, '/workspace').apiKey).toBe('');
  });

  it('keeps progress visibility scoped to agentic extraction', () => {
    const simple = resolveCliOptions({ dryRun: true }, {}, '/workspace');
    const agentic = resolveCliOptions({ dryRun: true, mode: 'agentic' }, {}, '/workspace');
    const silentAgent = resolveCliOptions({ dryRun: true, mode: 'agentic', progress: 'off' }, {}, '/workspace');

    expect(simple).toMatchObject({ progress: 'standard', includeThoughts: false });
    expect(agentic).toMatchObject({ progress: 'standard', includeThoughts: true });
    expect(silentAgent).toMatchObject({ progress: 'off', includeThoughts: false });
  });

  it('accepts Muse xhigh thinking and rejects it for Gemini', () => {
    process.env.META_API_KEY = 'muse-key';
    expect(resolveCliOptions(
      { provider: 'muse', thinking: 'xhigh', dryRun: true },
      {},
      '/workspace',
    )).toMatchObject({ thinking: 'XHIGH' });
    process.env.GEMINI_API_KEY = 'test-key';
    expect(() => resolveCliOptions(
      { thinking: 'xhigh', dryRun: true },
      {},
      '/workspace',
    )).toThrow('xhigh is supported by Muse and model-dependent OpenRouter routes');
  });

  it('uses a lower default max-tokens budget for agentic Kimi K3', () => {
    process.env.MOONSHOT_API_KEY = 'kimi-key';
    expect(resolveCliOptions(
      { provider: 'kimi', mode: 'agentic', dryRun: true },
      {},
      '/workspace',
    ).maxTokens).toBe(32_768);
    expect(resolveCliOptions(
      { provider: 'kimi', dryRun: true },
      {},
      '/workspace',
    ).maxTokens).toBe(131_072);
  });

  it('allows credential-free dry runs but rejects live runs without a key', () => {
    delete process.env.GEMINI_API_KEY;
    expect(resolveCliOptions({ dryRun: true }, {}, '/workspace').apiKey).toBe('');
    expect(() => assertCredentialsAvailable(resolveCliOptions({ dryRun: true }, {}, '/workspace'))).not.toThrow();
    const live = (): void => assertCredentialsAvailable(resolveCliOptions({}, {}, '/workspace'));
    expect(live).toThrow('Gemini API key is missing');
    expect(live).toThrow('PowerShell');
    expect(credentialSetupGuidance('CUSTOM_GEMINI_KEY', '/workspace')).toContain(
      'CUSTOM_GEMINI_KEY=your-key',
    );
  });

  it('resolves options without a credential so flag and input errors report first', () => {
    delete process.env.GEMINI_API_KEY;
    expect(resolveCliOptions({}, {}, '/workspace').apiKey).toBe('');
    // The numeric flag is still validated during resolution, so the reported
    // failure is the bad flag rather than the missing credential.
    expect(() => resolveCliOptions({ timeout: '0' }, {}, '/workspace'))
      .toThrow('--timeout must be an integer from 1 to 3600');
  });

  it('reports a missing gateway token only for a live Cloudflare BYOK route', () => {
    delete process.env.CLOUDFLARE_AI_GATEWAY_TOKEN;
    const byok: ExtractCommandFlags = {
      provider: 'gemini',
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
      cloudflareByok: true,
    };
    expect(() => assertCredentialsAvailable(resolveCliOptions(byok, {}, '/workspace')))
      .toThrow('Cloudflare BYOK requires CLOUDFLARE_AI_GATEWAY_TOKEN for gateway authentication');
    expect(() => assertCredentialsAvailable(
      resolveCliOptions({ ...byok, dryRun: true }, {}, '/workspace'),
    )).not.toThrow();
  });

  it('types credential failures as AUTH_MISSING rather than a generic config error', () => {
    delete process.env.GEMINI_API_KEY;
    let thrown: unknown;
    try {
      assertCredentialsAvailable(resolveCliOptions({}, {}, '/workspace'));
    } catch (error) {
      thrown = error;
    }
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'AUTH_MISSING',
      category: 'authentication',
      retryable: false,
    });
  });

  it('validates modes, formats, numeric bounds, and presets', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(() => resolveCliOptions({ mode: 'template' }, {}, '/workspace')).toThrow('--preset is required');
    expect(() => resolveCliOptions({ format: 'csv' }, {}, '/workspace')).toThrow('only available in template mode');
    expect(() => resolveCliOptions({ concurrency: '0' }, {}, '/workspace')).toThrow('--concurrency');
    // The machine surfaces ask for request-field vocabulary; a caller that sent
    // JSON is not told to fix a flag it never typed.
    expect(() => resolveCliOptions({ concurrency: 0 }, {}, '/workspace', 'field'))
      .toThrow('execution.concurrency must be an integer from 1 to 16');
    expect(() => resolveCliOptions({ thinking: 'max' }, {}, '/workspace', 'field'))
      .toThrow('extraction.thinking max is supported by');
    expect(() => resolveCliOptions({ preset: 'missing' }, {}, '/workspace')).toThrow('Unknown extraction preset');
    expect(() => resolveCliOptions({ maxCost: '0' }, {}, '/workspace')).toThrow('--max-cost');
    expect(() => resolveCliOptions({ requestsPerMinute: '-1' }, {}, '/workspace')).toThrow('--requests-per-minute');
  });

  it('makes custom schemas JSON-only simple extraction', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    expect(resolveCliOptions({ schema: 'invoice.schema.json' }, {}, '/workspace')).toMatchObject({
      mode: 'simple',
      format: 'json',
      schemaPath: 'invoice.schema.json',
    });
    expect(() => resolveCliOptions(
      { schema: 'invoice.schema.json', mode: 'agentic' },
      {},
      '/workspace',
    )).toThrow('--schema is only available in simple mode');
    expect(() => resolveCliOptions(
      { schema: 'invoice.schema.json', format: 'markdown' },
      {},
      '/workspace',
    )).toThrow('--schema requires --format json');
    expect(() => resolveCliOptions(
      { schema: 'invoice.schema.json', preset: 'invoice', mode: 'simple' },
      {},
      '/workspace',
    )).toThrow('--schema cannot be combined with --preset');
  });

  it('allowlists file configuration and warns about unknown keys without retaining secrets', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-config-'));
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await writeFile(path.join(directory, '.open-ocr-cli.json'), JSON.stringify({
        concurrency: 3,
        apiKey: 'must-not-survive',
        concurreny: 9,
      }));
      const config = await loadCliConfig(directory);
      expect(config).toMatchObject({ concurrency: 3 });
      expect(config).not.toHaveProperty('apiKey');
      expect(config).not.toHaveProperty('concurreny');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('apiKey, concurreny'));
    } finally {
      warning.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads a project-local .env file for first-run credential setup', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-env-'));
    delete process.env.PROJECT_GEMINI_KEY;
    try {
      await writeFile(path.join(directory, '.env'), 'PROJECT_GEMINI_KEY=from-project-env\n');
      loadLocalEnv(directory);
      expect(process.env.PROJECT_GEMINI_KEY).toBe('from-project-env');
    } finally {
      delete process.env.PROJECT_GEMINI_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports hermetic runs that ignore config files and project .env', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-hermetic-'));
    delete process.env.HERMETIC_TEST_KEY;
    try {
      await writeFile(path.join(directory, '.open-ocr-cli.json'), JSON.stringify({ concurrency: 9 }));
      await writeFile(path.join(directory, '.env'), 'HERMETIC_TEST_KEY=from-project-env\n');
      process.env.OPEN_OCR_NO_CONFIG = '1';
      expect(await loadCliConfig(directory)).toEqual({});
      loadLocalEnv(directory);
      expect(process.env.HERMETIC_TEST_KEY).toBeUndefined();

      delete process.env.OPEN_OCR_NO_CONFIG;
      expect(await loadCliConfig(directory, undefined, true)).toEqual({});
      loadLocalEnv(directory, true);
      expect(process.env.HERMETIC_TEST_KEY).toBeUndefined();
    } finally {
      delete process.env.HERMETIC_TEST_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads only an explicit config under ambient hermetic mode without ambient merge or .env', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-explicit-config-'));
    const configPath = path.join(directory, 'agent-config.json');
    delete process.env.EXPLICIT_CONFIG_TEST_KEY;
    try {
      await writeFile(configPath, JSON.stringify({ concurrency: 7 }));
      await writeFile(path.join(directory, '.open-ocr-cli.json'), JSON.stringify({
        concurrency: 99,
        baseUrl: 'https://attacker.example/v1',
      }));
      await writeFile(path.join(directory, '.env'), 'EXPLICIT_CONFIG_TEST_KEY=loaded\n');
      process.env.OPEN_OCR_NO_CONFIG = '1';

      expect(await loadCliConfig(directory, configPath)).toEqual({ concurrency: 7 });
      loadLocalEnv(directory, false);
      expect(process.env.EXPLICIT_CONFIG_TEST_KEY).toBeUndefined();
    } finally {
      delete process.env.EXPLICIT_CONFIG_TEST_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
