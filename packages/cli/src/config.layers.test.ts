import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyOperatorCeilings,
  credentialSetupGuidance,
  loadCliConfig,
  loadMcpCallerConfig,
  localEnvironment,
  mergeConfigLayers,
  resolveCliOptions,
} from './config';
import { providerRuntimeConfig } from './providerRuntime';

let root: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'open-ocr-config-layers-'));
  home = path.join(root, 'home');
  cwd = path.join(root, 'project');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('OPEN_OCR_NO_CONFIG', undefined);
  vi.stubEnv('OPEN_OCR_PROVIDER', undefined);
  vi.stubEnv('OPEN_OCR_MODEL', undefined);
  vi.stubEnv('OPEN_OCR_THINKING', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function writeUserConfig(config: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(home, '.config', 'open-ocr-cli'), { recursive: true });
  await writeFile(path.join(home, '.config', 'open-ocr-cli', 'config.json'), JSON.stringify(config));
}

async function writeProjectConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(cwd, '.open-ocr-cli.json'), JSON.stringify(config));
}

describe('configuration layers', () => {
  it('drops the user endpoint and key variable when a project switches provider', async () => {
    // What `init --global --yes` writes, then `init --yes --provider kimi` in a project.
    await writeUserConfig({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      thinking: 'MEDIUM',
      apiKeyEnv: 'GEMINI_API_KEY',
      baseUrl: 'https://generativelanguage.googleapis.com',
    });
    await writeProjectConfig({ provider: 'kimi' });
    const options = resolveCliOptions({ dryRun: true }, await loadCliConfig(cwd), cwd, 'flag', {
      GEMINI_API_KEY: 'gem-secret',
    });
    expect(options).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k3.1-pro',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      apiKey: '',
    });
  });

  it('sends no Gemini key to OpenRouter when the user config sets only apiKeyEnv', async () => {
    await writeUserConfig({ apiKeyEnv: 'GEMINI_WORK_KEY' });
    await writeProjectConfig({ provider: 'openrouter' });
    const options = resolveCliOptions({ dryRun: true }, await loadCliConfig(cwd), cwd, 'flag', {
      GEMINI_WORK_KEY: 'gem-secret',
    });
    expect(options.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(options.apiKey).toBe('');
  });

  it('still inherits the user endpoint and key variable when the project keeps the provider', async () => {
    await writeUserConfig({
      provider: 'kimi',
      apiKeyEnv: 'KIMI_WORK_KEY',
      baseUrl: 'https://api.moonshot.cn/v1',
    });
    await writeProjectConfig({ provider: 'kimi', concurrency: 3 });
    const options = resolveCliOptions({ dryRun: true }, await loadCliConfig(cwd), cwd, 'flag', {
      KIMI_WORK_KEY: 'kimi-secret',
    });
    expect(options).toMatchObject({
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'KIMI_WORK_KEY',
      apiKey: 'kimi-secret',
      concurrency: 3,
    });
  });

  it('drops an explicit-file layer below it the same way', async () => {
    await writeUserConfig({ provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' });
    await writeFile(path.join(cwd, 'local.json'), JSON.stringify({ provider: 'openai-compatible', model: 'llava' }));
    const options = resolveCliOptions({ dryRun: true }, await loadCliConfig(cwd, 'local.json'), cwd, 'flag', {
      GEMINI_API_KEY: 'gem-secret',
    });
    expect(options).toMatchObject({ apiKeyEnv: 'OPEN_OCR_API_KEY', apiKey: '', model: 'llava' });
  });

  it('keeps the operator credential away from a provider an MCP configPath switches to', async () => {
    await writeUserConfig({ provider: 'kimi', apiKeyEnv: 'KIMI_PROD_KEY', maxFiles: 5, requestsPerMinute: 30 });
    await writeFile(path.join(cwd, 'caller.json'), JSON.stringify({ provider: 'openai-compatible', model: 'llava' }));
    const { fileConfig, ceilings } = await loadMcpCallerConfig(cwd, 'caller.json');
    const options = resolveCliOptions({ dryRun: true }, fileConfig, cwd, 'field', { KIMI_PROD_KEY: 'sk-prodsecret' });
    expect(options).toMatchObject({
      provider: 'openai-compatible',
      model: 'llava',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyEnv: 'OPEN_OCR_API_KEY',
      apiKey: '',
    });
    // Operator limits are not provider settings: they stay ceilings.
    expect(ceilings).toEqual({ maxFiles: 5, requestsPerMinute: 30 });
    expect(applyOperatorCeilings({ maxFiles: 50 }, fileConfig, ceilings).flags.maxFiles).toBe(5);
    expect(fileConfig.maxFiles).toBe(5);
  });

  it('keeps the operator credential away from OpenRouter when a project file switches provider over MCP', async () => {
    await writeUserConfig({ provider: 'kimi', apiKeyEnv: 'KIMI_PROD_KEY', inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2 });
    await writeProjectConfig({ provider: 'openrouter' });
    const { fileConfig } = await loadMcpCallerConfig(cwd);
    expect(fileConfig).not.toHaveProperty('apiKeyEnv');
    // The operator's prices belong to the operator's model.
    expect(fileConfig).not.toHaveProperty('inputPricePerMillionUsd');
    const options = resolveCliOptions({ dryRun: true }, fileConfig, cwd, 'field', { KIMI_PROD_KEY: 'sk-prodsecret' });
    expect(options).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', apiKey: '' });
  });

  it('keeps the operator routing when the MCP caller keeps the operator provider', async () => {
    await writeUserConfig({ provider: 'kimi', apiKeyEnv: 'KIMI_PROD_KEY', maxFiles: 5 });
    await writeFile(path.join(cwd, 'caller.json'), JSON.stringify({ provider: 'kimi', concurrency: 1 }));
    const { fileConfig } = await loadMcpCallerConfig(cwd, 'caller.json');
    expect(fileConfig).toMatchObject({ provider: 'kimi', apiKeyEnv: 'KIMI_PROD_KEY', concurrency: 1, maxFiles: 5 });
  });

  it('drops gateway-specific settings on a gateway switch and model-tuned settings on a model switch', () => {
    expect(mergeConfigLayers({
      gateway: 'cloudflare',
      baseUrl: 'https://example.invalid/v1',
      apiKeyEnv: 'GEMINI_WORK_KEY',
      cloudflareAccountId: 'acct',
      cloudflareGatewayId: 'gw',
      cloudflareTokenEnv: 'CF_TOKEN',
      cloudflareByok: true,
      cloudflareByokAlias: 'prod',
    }, { gateway: 'direct' })).toEqual({
      gateway: 'direct',
      apiKeyEnv: 'GEMINI_WORK_KEY',
      cloudflareAccountId: 'acct',
      cloudflareGatewayId: 'gw',
      cloudflareTokenEnv: 'CF_TOKEN',
    });

    expect(mergeConfigLayers({
      model: 'gemini-4-argon',
      thinking: 'HIGH',
      maxTokens: 4096,
      inputPricePerMillionUsd: 4,
      outputPricePerMillionUsd: 20,
      apiKeyEnv: 'GEMINI_WORK_KEY',
      concurrency: 4,
    }, { model: 'gemini-3.8-flash' })).toEqual({
      model: 'gemini-3.8-flash',
      apiKeyEnv: 'GEMINI_WORK_KEY',
      concurrency: 4,
    });

    // Naming the model the lower layer already uses (explicitly or by default) is not a switch.
    expect(mergeConfigLayers({ thinking: 'LOW', maxTokens: 4096 }, { model: 'gemini-3.8-flash' }))
      .toEqual({ thinking: 'LOW', maxTokens: 4096, model: 'gemini-3.8-flash' });
    expect(mergeConfigLayers({ provider: 'gemini', thinking: 'LOW' }, { provider: 'gemini' }))
      .toEqual({ provider: 'gemini', thinking: 'LOW' });
  });
});

describe('project .env', () => {
  const posix = process.platform !== 'win32';

  it.runIf(posix)('does not block on a FIFO named .env', async () => {
    execFileSync('mkfifo', [path.join(cwd, '.env')]);
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => localEnvironment(cwd)),
        new Promise<'blocked'>((resolve) => { setTimeout(() => resolve('blocked'), 1_000); }),
      ]);
      expect(outcome).not.toBe('blocked');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('not a regular file'));
    } finally {
      warning.mockRestore();
    }
  });

  it.runIf(posix)('does not read a .env symlink to a device', async () => {
    await symlink('/dev/zero', path.join(cwd, '.env'));
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(localEnvironment(cwd).GEMINI_API_KEY).toBe(process.env.GEMINI_API_KEY);
    } finally {
      warning.mockRestore();
    }
  });

  it('ignores a directory named .env instead of failing with a raw EISDIR', async () => {
    await mkdir(path.join(cwd, '.env'));
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => localEnvironment(cwd)).not.toThrow();
    } finally {
      warning.mockRestore();
    }
  });

  it('refuses an oversized .env with a typed error', async () => {
    await writeFile(path.join(cwd, '.env'), `GEMINI_API_KEY=${'x'.repeat(1024 * 1024)}\n`);
    expect(() => localEnvironment(cwd)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }) as Error);
  });

  it('advises a project .env only for the variables it can supply', () => {
    const custom = credentialSetupGuidance('MY_GEMINI', '/p');
    expect(custom).not.toContain(path.join('/p', '.env'));
    expect(custom).not.toContain('MY_GEMINI=your-key');
    expect(custom).toContain('export MY_GEMINI');
    expect(credentialSetupGuidance('GEMINI_API_KEY', '/p')).toContain(
      `add GEMINI_API_KEY=your-key to ${path.join('/p', '.env')}`,
    );
  });
});

describe('thinking choice marker', () => {
  it('is set only when the level was chosen, not defaulted', () => {
    const resolve = (
      flags: Record<string, string | boolean>,
      config: Record<string, unknown> = {},
      env: NodeJS.ProcessEnv = {},
    ) => resolveCliOptions({ dryRun: true, provider: 'openrouter', model: 'openai/gpt-4.1-mini', ...flags }, config, cwd, 'flag', env);
    expect(resolve({}).thinkingExplicit).toBe(false);
    expect(resolve({ thinking: 'high' }).thinkingExplicit).toBe(true);
    expect(resolveCliOptions({ dryRun: true }, {}, cwd, 'flag', {
      OPEN_OCR_PROVIDER: 'openrouter', OPEN_OCR_MODEL: 'openai/gpt-4.1-mini', OPEN_OCR_THINKING: 'low',
    }).thinkingExplicit).toBe(true);
    expect(resolve({}, { provider: 'openrouter', model: 'openai/gpt-4.1-mini', thinking: 'LOW' }).thinkingExplicit).toBe(true);
    // A file `thinking` written for another model is not a choice for this one.
    expect(resolve({}, { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', thinking: 'LOW' }).thinkingExplicit)
      .toBe(false);

    expect(providerRuntimeConfig(resolve({})).thinkingConfig).toMatchObject({ level: 'MEDIUM', explicit: false });
    expect(providerRuntimeConfig(resolve({ thinking: 'high' })).thinkingConfig).toMatchObject({ level: 'HIGH', explicit: true });
  });
});
