import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit, type InitPrompter } from './init';
import { cliExitCode } from './errors';

let directory: string;

function answers(values: string[], confirmation = true): InitPrompter {
  let index = 0;
  return {
    ask: vi.fn((_question: string, defaultValue: string) => Promise.resolve(values[index++] ?? defaultValue)),
    confirm: vi.fn(() => Promise.resolve(confirmation)),
    close: vi.fn(),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-init-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe('CLI init', () => {
  it('writes safe interactive configuration and validates an environment credential', async () => {
    const validateCredentials = vi.fn(() => Promise.resolve());
    const output: string[] = [];
    const result = await runInit({ global: true }, {
      cwd: directory,
      homeDirectory: directory,
      env: { OCR_KEY: 'secret-value' },
      prompter: answers(['gemini', 'direct', 'gemini-3.1-flash-lite', 'LOW', '4', '30', '2.50', 'OCR_KEY']),
      validateCredentials,
      writeOutput: (text) => output.push(text),
    });

    expect(result).toMatchObject({ written: true, credentialStatus: 'valid' });
    expect(result.configPath).toBe(path.join(directory, '.config', 'open-ocr-cli', 'config.json'));
    expect(validateCredentials).toHaveBeenCalledWith('secret-value', 'gemini-3.1-flash-lite');
    const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({ provider: 'gemini', gateway: 'direct', concurrency: 4, requestsPerMinute: 30, maxCostUsd: 2.5, apiKeyEnv: 'OCR_KEY' });
    expect(config).not.toHaveProperty('apiKey');
    expect(await readFile(result.configPath, 'utf8')).not.toContain('secret-value');
    expect(output.join('')).toContain('credential validated');
  });

  it('keeps project setup on the default endpoint and key variable without asking', async () => {
    const questions: string[] = [];
    const output: string[] = [];
    const result = await runInit({ skipValidation: true }, {
      cwd: directory,
      env: {},
      prompter: {
        ask: (question, defaultValue) => {
          questions.push(question);
          return Promise.resolve(defaultValue);
        },
        confirm: () => Promise.resolve(false),
        close: () => undefined,
      },
      writeOutput: (text) => output.push(text),
    });

    expect(result).toMatchObject({ written: true, gateway: 'direct', apiKeyEnvironmentVariable: 'GEMINI_API_KEY' });
    expect(questions).not.toContain('Choose gateway by number or value');
    expect(questions).not.toContain('API key environment variable');
    expect(questions).not.toContain('Provider API base URL');
    const config = JSON.parse(await readFile(path.join(directory, '.open-ocr-cli.json'), 'utf8')) as Record<string, unknown>;
    expect(config).not.toHaveProperty('apiKeyEnv');
    expect(config).not.toHaveProperty('baseUrl');
    expect(output.join('')).toContain('init --global');

    await expect(runInit({ yes: true, force: true, gateway: 'cloudflare' }, {
      cwd: directory,
      env: {},
      prompter: answers([]),
      writeOutput: () => undefined,
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', hint: expect.stringContaining('init --global') as unknown });
  });

  it('shows fixed-choice options and re-prompts after an invalid provider', async () => {
    const output: string[] = [];
    const questions: string[] = [];
    const responses = ['y', '1', '1', '1', '3'];
    let responseIndex = 0;
    const prompter: InitPrompter = {
      ask: (question, defaultValue) => {
        questions.push(question);
        return Promise.resolve(responses[responseIndex++] ?? defaultValue);
      },
      confirm: () => Promise.resolve(true),
      close: () => undefined,
    };
    const result = await runInit({ skipValidation: true, global: true }, {
      cwd: directory,
      homeDirectory: directory,
      env: {},
      prompter,
      writeOutput: (text) => output.push(text),
    });

    expect(result).toMatchObject({ written: true, provider: 'gemini', gateway: 'direct' });
    expect(questions.slice(0, 2)).toEqual([
      'Choose provider by number or value',
      'Choose provider by number or value',
    ]);
    expect(questions).toContain('Choose gateway by number or value');
    expect(questions).toContain('Choose default model by number or value');
    expect(questions).toContain('Choose thinking level by number or value');
    expect(output.join('')).toContain('1. Google Gemini (gemini) (default)');
    expect(output.join('')).toContain('2. Moonshot Kimi (kimi)');
    expect(output.join('')).toContain('1. Direct provider API (direct) (default)');
    expect(output.join('')).toContain('gemini-3.1-flash-lite');
    expect(output.join('')).toContain('MEDIUM — balanced (recommended) (default)');
    expect(output.join('')).toContain('Invalid provider "y". Enter 1-5');
  });

  it('offers recommended models plus a custom model choice', async () => {
    const output: string[] = [];
    const result = await runInit({ skipValidation: true }, {
      cwd: directory,
      env: {},
      prompter: answers(['2', '5', 'kimi-custom-vision', '3']),
      writeOutput: (text) => output.push(text),
    });

    expect(result).toMatchObject({ written: true, provider: 'kimi', gateway: 'direct' });
    const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    expect(config.model).toBe('kimi-custom-vision');
    expect(output.join('')).toContain('1. kimi-k3 (default)');
    expect(output.join('')).toContain('5. Enter a custom model ID');
  });

  it('uses Kimi K3 reasoning and published pricing defaults during setup', async () => {
    const result = await runInit({
      yes: true,
      provider: 'kimi',
      skipValidation: true,
    }, {
      cwd: directory,
      env: {},
      prompter: answers([]),
      writeOutput: () => undefined,
    });

    const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({ model: 'kimi-k3', thinking: 'MAX' });
    expect(config).not.toHaveProperty('inputPricePerMillionUsd');
    expect(config).not.toHaveProperty('outputPricePerMillionUsd');
  });

  it('validates a Kimi K3 credential with low effort without changing the saved MAX default', async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runInit({ yes: true, provider: 'kimi' }, {
      cwd: directory,
      env: { MOONSHOT_API_KEY: 'secret-value' },
      prompter: answers([]),
      writeOutput: () => undefined,
    });

    expect(result.credentialStatus).toBe('valid');
    const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    expect(config.thinking).toBe('MAX');
    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 1024 });
  });

  it('uses the Kimi K3 effort contract when routed through OpenRouter', async () => {
    const result = await runInit({
      yes: true,
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      skipValidation: true,
    }, {
      cwd: directory,
      env: {},
      prompter: answers([]),
      writeOutput: () => undefined,
    });

    const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    expect(config).toMatchObject({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      thinking: 'MAX',
    });
  });

  it('maps Ctrl-C during interactive setup to exit code 130', async () => {
    const abort = Object.assign(new Error('Aborted with Ctrl+C'), { code: 'ABORT_ERR' });
    let thrown: unknown;
    try {
      await runInit({}, {
        cwd: directory,
        prompter: {
          ask: () => Promise.reject(abort),
          confirm: () => Promise.resolve(false),
          close: () => undefined,
        },
        writeOutput: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(cliExitCode(thrown)).toBe(130);
  });

  it('fails fast when interactive init has no terminal', async () => {
    let thrown: unknown;
    try {
      await runInit({ skipValidation: true }, {
        cwd: directory,
        stdinIsTTY: false,
        stderrIsTTY: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('pass --yes');
    expect(cliExitCode(thrown)).toBe(2);
  });

  it('does not replace existing configuration when confirmation is declined', async () => {
    const target = path.join(directory, '.open-ocr-cli.json');
    const output: string[] = [];
    await writeFile(target, '{"model":"gemini-3.5-flash"}\n');
    const result = await runInit({}, {
      cwd: directory,
      prompter: answers([], false),
      writeOutput: (text) => output.push(text),
    });
    expect(result.written).toBe(false);
    expect(await readFile(target, 'utf8')).toContain('gemini-3.5-flash');
    expect(output.join('')).toContain('Use --force');
  });

  it('reports an existing config in non-interactive mode instead of silently succeeding', async () => {
    const target = path.join(directory, '.open-ocr-cli.json');
    const output: string[] = [];
    await writeFile(target, '{"model":"gemini-3.5-flash"}\n');
    const result = await runInit({ yes: true }, {
      cwd: directory,
      prompter: answers([]),
      writeOutput: (text) => output.push(text),
    });
    expect(result.written).toBe(false);
    expect(output.join('')).toContain('already exists');
    expect(output.join('')).toContain('--force');
  });

  it('uses the same maximum cost bound as extract', async () => {
    await expect(runInit({}, {
      cwd: directory,
      prompter: answers(['gemini', 'direct', 'gemini-3.5-flash', 'MEDIUM', '2', '0', '1000001']),
      writeOutput: () => undefined,
    })).rejects.toThrow('at most 1000000');
  });

  it('shows platform and project setup instructions when the API key is missing', async () => {
    const output: string[] = [];
    const result = await runInit({ yes: true }, {
      cwd: directory,
      env: {},
      prompter: answers([]),
      writeOutput: (text) => output.push(text),
    });
    expect(result.credentialStatus).toBe('missing');
    expect(output.join('')).toContain('PowerShell');
    expect(output.join('')).toContain(path.join(directory, '.env'));
  });

  it('requires an explicit model for non-interactive generic provider setup', async () => {
    await expect(runInit({ yes: true, provider: 'openai-compatible' }, {
      cwd: directory,
      env: {},
      prompter: answers([]),
      writeOutput: () => undefined,
    })).rejects.toThrow('--model is required with --yes');

    const result = await runInit({
      yes: true,
      provider: 'openai-compatible',
      model: 'local-vision-model',
      skipValidation: true,
    }, {
      cwd: directory,
      env: {},
      prompter: answers([]),
      writeOutput: () => undefined,
    });
    expect(result.provider).toBe('openai-compatible');
    const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<string, unknown>;
    expect(config.model).toBe('local-vision-model');
  });
});
