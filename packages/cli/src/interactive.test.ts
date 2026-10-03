import { describe, expect, it, vi } from 'vitest';

import { cliExitCode } from './errors';
import { promptInteractiveArguments, type InteractivePrompter } from './interactive';
import type { CliConfigFile } from './types';

function scriptedPrompter(
  answers: string[],
  confirmations: boolean[] = [],
): InteractivePrompter {
  let answerIndex = 0;
  let confirmationIndex = 0;
  return {
    ask: vi.fn((_question: string, defaultValue: string) => (
      Promise.resolve(answers[answerIndex++] ?? defaultValue)
    )),
    confirm: vi.fn((_question: string, defaultValue: boolean) => (
      Promise.resolve(confirmations[confirmationIndex++] ?? defaultValue)
    )),
    close: vi.fn(),
  };
}

async function selectedArguments(
  answers: string[],
  confirmations: boolean[] = [],
  config: CliConfigFile = {},
): Promise<string[] | undefined> {
  return promptInteractiveArguments({
    env: {},
    config,
    prompter: scriptedPrompter(answers, confirmations),
    writeOutput: () => undefined,
  });
}

describe('interactive command menu', () => {
  it('builds a complete extract command from guided choices', async () => {
    await expect(selectedArguments([
      'extract',
      'invoice.pdf, scans/*.png',
      'kimi',
      'direct',
      '1',
      'high',
      'MOONSHOT_API_KEY',
      'template',
      '1',
      'json',
      './results',
      '5',
    ], [true])).resolves.toEqual([
      'extract',
      'invoice.pdf',
      'scans/*.png',
      '--provider', 'kimi',
      '--gateway', 'direct',
      '--model', 'kimi-k3',
      '--thinking', 'high',
      '--api-key-env', 'MOONSHOT_API_KEY',
      '--mode', 'template',
      '--preset', 'invoice',
      '--format', 'json',
      '--output', './results',
      '--max-cost', '5',
      '--dry-run',
    ]);
  });

  it('builds a web command with provider and analysis choices', async () => {
    await expect(selectedArguments([
      'web',
      'https://example.com/a, https://example.com/b',
      'muse',
      'direct',
      '1',
      'medium',
      'META_API_KEY',
      'comparison',
      'markdown',
      '',
      '',
    ], [true])).resolves.toEqual([
      'web',
      'https://example.com/a',
      'https://example.com/b',
      '--provider', 'muse',
      '--gateway', 'direct',
      '--model', 'muse-spark-1.3',
      '--thinking', 'medium',
      '--api-key-env', 'META_API_KEY',
      '--analysis', 'comparison',
      '--format', 'markdown',
      '--dry-run',
    ]);
  });

  it('uses the exact Kimi K3 effort menu through OpenRouter', async () => {
    const calls: Array<{ question: string; values: string[]; defaultValue: string }> = [];
    const choose: NonNullable<InteractivePrompter['choose']> = <T extends string>(
      question: string,
      choices: ReadonlyArray<{ value: T; label: string }>,
      defaultValue: T,
    ): Promise<T> => {
      calls.push({ question, values: choices.map((choice) => choice.value), defaultValue });
      return Promise.resolve(defaultValue);
    };
    const prompter = scriptedPrompter(['invoice.pdf']);
    prompter.choose = choose;

    const result = await promptInteractiveArguments({
      env: {},
      config: {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k3',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
      prompter,
      writeOutput: () => undefined,
    });

    expect(result).toContain('max');
    expect(calls).toContainEqual({
      question: 'Thinking level',
      values: ['low', 'high', 'max'],
      defaultValue: 'max',
    });
  });

  it.each([
    { answers: ['init'], expected: ['init'] },
    { answers: ['providers', 'json'], expected: ['providers', '--json'] },
    { answers: ['models', 'openrouter', 'text'], expected: ['models', '--provider', 'openrouter'] },
    { answers: ['presets', 'json'], expected: ['presets', '--json'] },
    { answers: ['doctor', './custom.json', 'json'], expected: ['doctor', '--config', './custom.json', '--json'] },
    { answers: ['status', ' ./results ', 'text'], expected: ['status', './results'] },
    { answers: ['help', 'web'], expected: ['help', 'web'] },
    { answers: ['help', 'root'], expected: ['--help'] },
    { answers: ['exit'], expected: undefined },
  ])('supports $answers.0 from the same menu', async ({ answers, expected }) => {
    await expect(selectedArguments(answers)).resolves.toEqual(expected);
  });

  it('uses a native choice prompt when the terminal prompter provides one', async () => {
    const prompter = scriptedPrompter([]);
    const calls: Array<[string, string]> = [];
    const choose: NonNullable<InteractivePrompter['choose']> = <T extends string>(
      question: string,
      _choices: ReadonlyArray<{ value: T; label: string }>,
      defaultValue: T,
    ): Promise<T> => {
      calls.push([question, defaultValue]);
      return Promise.resolve('exit' as T);
    };
    prompter.choose = choose;

    await expect(promptInteractiveArguments({
      config: {},
      prompter,
      writeOutput: () => undefined,
    })).resolves.toBeUndefined();
    expect(calls).toContainEqual(['Command', 'extract']);
  });

  it('seeds provider and extraction choices from the effective configuration', async () => {
    const calls: Array<[string, string]> = [];
    const choose: NonNullable<InteractivePrompter['choose']> = <T extends string>(
      question: string,
      _choices: ReadonlyArray<{ value: T; label: string }>,
      defaultValue: T,
    ): Promise<T> => {
      calls.push([question, defaultValue]);
      return Promise.resolve(defaultValue);
    };
    const prompter: InteractivePrompter = {
      ask: vi.fn((question: string, defaultValue: string) => (
        Promise.resolve(question.startsWith('Input files') ? 'invoice.pdf' : defaultValue)
      )),
      confirm: vi.fn((_question: string, defaultValue: boolean) => Promise.resolve(defaultValue)),
      choose,
      close: vi.fn(),
    };

    const result = await promptInteractiveArguments({
      env: {},
      config: {
        provider: 'kimi',
        gateway: 'direct',
        model: 'kimi-custom-vision',
        thinking: 'HIGH',
        apiKeyEnv: 'KIMI_CUSTOM_KEY',
        mode: 'agentic',
        format: 'json',
        output: './configured-results',
        maxCostUsd: 2,
      },
      prompter,
      writeOutput: () => undefined,
    });

    expect(result).toEqual([
      'extract', 'invoice.pdf',
      '--provider', 'kimi',
      '--gateway', 'direct',
      '--model', 'kimi-custom-vision',
      '--thinking', 'high',
      '--api-key-env', 'KIMI_CUSTOM_KEY',
      '--mode', 'agentic',
      '--format', 'json',
      '--output', './configured-results',
      '--max-cost', '2',
    ]);
    expect(calls).toContainEqual(['Provider', 'kimi']);
    expect(calls).toContainEqual(['Thinking level', 'high']);
  });

  it('re-prompts when maximum cost is outside the CLI range', async () => {
    const output: string[] = [];
    const result = await promptInteractiveArguments({
      env: {},
      config: {},
      prompter: scriptedPrompter([
        'extract', 'invoice.pdf', 'gemini', 'direct', '1', 'medium', 'GEMINI_API_KEY',
        'simple', 'markdown', '', '-4', '1.50',
      ]),
      writeOutput: (text) => output.push(text),
    });

    expect(result).toContain('--max-cost');
    expect(result).toContain('1.50');
    expect(output.join('')).toContain('Maximum cost must be between');
  });

  it('maps Ctrl-C to exit code 130', async () => {
    const abort = Object.assign(new Error('Aborted with Ctrl+C'), { code: 'ABORT_ERR' });
    let thrown: unknown;
    try {
      await promptInteractiveArguments({
        config: {},
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

    expect(cliExitCode(thrown)).toBe(130);
  });
});
