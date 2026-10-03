import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderExecutionContext,
  getProviderUsage,
  ProviderCostLimitError,
} from '@open-ocr/engine/providers';
import { resolveCliOptions } from './config';
import { runWebExtraction } from './web';

const { mockInteractionCreate } = vi.hoisted(() => ({ mockInteractionCreate: vi.fn() }));

vi.mock('@open-ocr/engine/gemini/client', async () => {
  const actual = await vi.importActual<typeof import('@open-ocr/engine/gemini/client')>(
    '@open-ocr/engine/gemini/client',
  );
  return {
    ...actual,
    getGenAIClient: vi.fn(() => ({ interactions: { create: mockInteractionCreate } })),
  };
});

const url = 'https://example.com/article';

function options(): ReturnType<typeof resolveCliOptions> {
  return resolveCliOptions({
    model: 'gemini-3.8-flash', inputPrice: '100', outputPrice: '200', maxCost: '0.1', dryRun: true,
  }, {}, '/workspace');
}

beforeEach(() => {
  mockInteractionCreate.mockReset();
  mockInteractionCreate.mockResolvedValue({
    id: 'priced-web-request',
    status: 'completed',
    steps: [
      { type: 'url_context_result', result: [{ status: 'success', url }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Verified document text' }] },
    ],
    usage: { total_input_tokens: 1_000, total_output_tokens: 100 },
  });
});

describe('Gemini Web OCR pricing', () => {
  it('records custom prices through the real interaction flow and blocks the next paid request', async () => {
    const resolved = options();
    const runtime = createProviderExecutionContext({ maxCostUsd: resolved.maxCostUsd });
    const signal = new AbortController().signal;
    await expect(runWebExtraction([url], 'combined', resolved, signal, runtime)).resolves.toEqual({
      combinedContent: 'Verified document text',
    });
    expect(runtime.getUsage()).toMatchObject({ requests: 1, estimatedCostUsd: 0.12 });
    await expect(runWebExtraction([url], 'combined', resolved, signal, runtime))
      .rejects.toBeInstanceOf(ProviderCostLimitError);
    expect(mockInteractionCreate).toHaveBeenCalledTimes(1);
  });

  it('uses an isolated runtime for each standalone Web OCR invocation', async () => {
    const before = getProviderUsage();
    const signal = new AbortController().signal;
    await runWebExtraction([url], 'combined', options(), signal);
    await runWebExtraction([url], 'combined', options(), signal);
    expect(mockInteractionCreate).toHaveBeenCalledTimes(2);
    expect(getProviderUsage()).toEqual(before);
  });
});
