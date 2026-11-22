import { describe, expect, it, vi } from 'vitest';

import { OcrError, OcrErrorType } from '@open-ocr/engine/gemini/types';

import { resolveCliOptions } from './config';
import { CliExitError } from './errors';
import { runWithProviderRetries } from './providerRetries';

vi.mock('@open-ocr/engine/agentStepStream', () => ({
  waitForAbortableAgentDelay: vi.fn(() => Promise.resolve()),
}));

describe('provider retry policy', () => {
  it('honors typed retryability independently of the selected provider', async () => {
    const options = resolveCliOptions({
      provider: 'openrouter',
      retries: '2',
    }, {}, process.cwd());
    const operation = vi.fn()
      .mockRejectedValueOnce(new CliExitError('Source returned HTTP 503', 2, {
        code: 'INPUT_INVALID',
        category: 'input',
        retryable: true,
      }))
      .mockResolvedValue('ok');

    const result = await runWithProviderRetries(
      options,
      new AbortController().signal,
      operation,
    );

    expect(result).toEqual({ value: 'ok', attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a typed permanent failure', async () => {
    const options = resolveCliOptions({
      provider: 'openrouter',
      retries: '2',
    }, {}, process.cwd());
    const operation = vi.fn(() => Promise.reject(new CliExitError('Source returned HTTP 404', 2, {
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
    })));

    await expect(runWithProviderRetries(
      options,
      new AbortController().signal,
      operation,
    )).rejects.toMatchObject({ attempts: 1 });
    expect(operation).toHaveBeenCalledOnce();
  });

  it.each(['gemini', 'openrouter', 'kimi'] as const)(
    'retries an engine OUTPUT_INVALID on %s whatever digits its message carries',
    async (provider) => {
      const options = resolveCliOptions({ provider, retries: '1', dryRun: true }, {}, process.cwd());
      for (const position of [128, 403, 503]) {
        const operation = vi.fn()
          .mockRejectedValueOnce(new OcrError(
            OcrErrorType.OUTPUT_INVALID,
            `Re-OCR returned invalid JSON: Expected ',' or '}' after property value in JSON at position ${position}`,
          ))
          .mockResolvedValue('ok');
        await expect(runWithProviderRetries(options, new AbortController().signal, operation))
          .resolves.toEqual({ value: 'ok', attempts: 2 });
      }
    },
  );

  it('does not retry an engine SCHEMA_INVALID or API_KEY_MISSING', async () => {
    const options = resolveCliOptions({ retries: '2', dryRun: true }, {}, process.cwd());
    for (const type of [OcrErrorType.SCHEMA_INVALID, OcrErrorType.API_KEY_MISSING]) {
      const operation = vi.fn(() => Promise.reject(new OcrError(type, 'status 503 in sections[503]')));
      await expect(runWithProviderRetries(options, new AbortController().signal, operation))
        .rejects.toMatchObject({ attempts: 1 });
    }
  });
});
