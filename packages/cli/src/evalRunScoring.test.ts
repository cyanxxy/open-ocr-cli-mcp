import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeConfig } from '@open-ocr/engine/providers';
import { validateEvalCase } from '@open-ocr/engine/evals';
import { runEvalCase } from '../../../evals/run';

const mocks = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@open-ocr/engine/gemini/client', async () => {
  const actual = await vi.importActual<typeof import('@open-ocr/engine/gemini/client')>(
    '@open-ocr/engine/gemini/client',
  );
  return {
    ...actual,
    getGenAIClient: vi.fn(() => ({ models: { generateContent: mocks.generateContent } })),
  };
});

// Scoring the model output throws (as an invalid HTML entity once did); scoring
// an empty output does not.
vi.mock('@open-ocr/engine/evals', async () => {
  const actual = await vi.importActual<typeof import('@open-ocr/engine/evals')>('@open-ocr/engine/evals');
  return {
    ...actual,
    evaluateEvalCase: vi.fn((...args: Parameters<typeof actual.evaluateEvalCase>) => {
      if (args[1].markdown) throw new RangeError('Invalid code point 1114112');
      return actual.evaluateEvalCase(...args);
    }),
  };
});

const config: ProviderRuntimeConfig = {
  provider: 'gemini', gateway: 'direct', model: 'gemini-3.8-flash',
  apiKey: 'test-key', apiKeyEnv: 'TEST_KEY',
  baseUrl: 'https://generativelanguage.googleapis.com',
};

beforeEach(() => {
  mocks.generateContent.mockReset();
  mocks.generateContent.mockResolvedValue({
    text: '<table><tr><td>Total</td><td>&#x110000;</td></tr></table>',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
  });
});

describe('eval case scoring errors', () => {
  it('reports a case whose output cannot be scored as failed instead of rejecting the run', async () => {
    const evalCase = validateEvalCase({
      id: 'scoring-error', mode: 'simple', tags: ['scoring'],
      inputPath: 'evals/corpus/raster/invoice.png',
      expectedAssertions: [{ type: 'not_contains', target: 'markdown', value: 'undefined' }],
    });
    const completed = await runEvalCase(evalCase, config, 0);
    expect(completed.result.passed).toBe(false);
    expect(completed.result.execution?.runtimeError).toContain('Invalid code point 1114112');
    expect(completed.result.failedAssertions).toContain('Eval runner error: Invalid code point 1114112');
    expect(completed.artifact.output.markdown).toContain('&#x110000;');
  });
});
