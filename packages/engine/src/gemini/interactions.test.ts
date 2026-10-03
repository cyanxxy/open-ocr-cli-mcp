import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInteractionCreate } = vi.hoisted(() => ({
  mockInteractionCreate: vi.fn(),
}));

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return {
    ...actual,
    getGenAIClient: vi.fn(() => ({
      interactions: { create: mockInteractionCreate },
    })),
  };
});

import {
  createInteractionGenerationConfig,
  extractInteractionFunctionCalls,
  extractInteractionModelErrors,
  extractInteractionText,
  getInteractionSteps,
  runModelInteraction,
  selectModelStepsForReplay,
  type InteractionStep,
} from './interactions';
import { createProviderExecutionContext } from '../providers/runtime';

beforeEach(() => {
  mockInteractionCreate.mockReset();
});

describe('selectModelStepsForReplay — exact transcript fidelity (C-02 / A-05 / A-06)', () => {
  it('preserves thought steps, signatures, and server metadata by reference', () => {
    const steps: InteractionStep[] = [
      {
        type: 'thought',
        signature: 'sig-abc',
        summary: [{ text: 'reasoning' }],
        server_metadata: { future_field: true },
      },
      { type: 'function_call', id: 'call-1', name: 'analyze_document_structure', arguments: { a: 1 } },
    ];
    const replay = selectModelStepsForReplay(steps);
    const thought = replay.find((b) => b.type === 'thought');
    expect(thought).toBe(steps[0]);
    expect(thought).toEqual(steps[0]);
  });

  it('uses the same canonical id for the model step and the executed call', () => {
    const steps: InteractionStep[] = [
      { type: 'function_call', id: 'cid-7', name: 'extract_fields_batch', arguments: {} },
    ];
    const replayCall = selectModelStepsForReplay(steps).find((b) => b.type === 'function_call');
    const executed = extractInteractionFunctionCalls(steps);
    expect(replayCall).toBe(steps[0]);
    expect((replayCall as { id?: string }).id).toBe('cid-7');
    expect(executed[0].id).toBe('cid-7');
  });

  it('rejects a function call without the current required id', () => {
    const steps: InteractionStep[] = [
      { type: 'function_call', name: 'extract_fields_batch', arguments: {} },
    ];
    expect(() => extractInteractionFunctionCalls(steps)).toThrow('without an ID');
  });

  it('rejects duplicate provider function-call IDs', () => {
    const steps: InteractionStep[] = [
      { type: 'function_call', id: 'duplicate', name: 'first', arguments: {} },
      { type: 'function_call', id: 'duplicate', name: 'second', arguments: {} },
    ];
    expect(() => extractInteractionFunctionCalls(steps)).toThrow('duplicate function-call ID');
  });

  it('preserves every parallel function_call for stateless history fidelity', () => {
    const steps: InteractionStep[] = [
      { type: 'function_call', id: 'c1', name: 'analyze_document_structure', arguments: {} },
      { type: 'function_call', id: 'c2', name: 'extract_fields_batch', arguments: {} },
    ];
    const replay = selectModelStepsForReplay(steps);
    const calls = replay.filter((s) => s.type === 'function_call');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c as { id: string }).id)).toEqual(['c1', 'c2']);
  });

  it('rejects an array passed as function-call arguments', () => {
    const steps: InteractionStep[] = [
      { type: 'function_call', id: 'c1', name: 'f', arguments: ['not', 'an', 'object'] as unknown as Record<string, unknown> },
    ];
    expect(() => extractInteractionFunctionCalls(steps)).toThrow('non-object function-call arguments');
    const call = selectModelStepsForReplay(steps).find((b) => b.type === 'function_call');
    expect((call as { arguments?: unknown }).arguments).toEqual(['not', 'an', 'object']);
  });

  it('does not rewrite forward-compatible step shapes', () => {
    const steps: InteractionStep[] = [
      { type: 'future_server_step', opaque: { value: 1 } },
    ];
    const replay = selectModelStepsForReplay(steps);
    expect(replay).toEqual(steps);
    expect(replay[0]).toBe(steps[0]);
  });
});

describe('extractInteractionText', () => {
  it('reads text from model_output steps', () => {
    expect(extractInteractionText([
      { type: 'model_output', content: [{ type: 'text', text: 'Verified comparison output' }] },
    ])).toBe('Verified comparison output');
  });

  it('falls back to output_text sugar', () => {
    expect(extractInteractionText([], '  sdk sugar  ')).toBe('sdk sugar');
  });
});

describe('extractInteractionModelErrors', () => {
  it('surfaces model_output status errors', () => {
    expect(extractInteractionModelErrors([{
      type: 'model_output',
      content: [],
      error: { code: 13, message: 'generation failed internally' },
    }])).toEqual(['generation failed internally']);
  });
});

describe('getInteractionSteps', () => {
  it('reads the current steps transcript', () => {
    expect(getInteractionSteps({
      id: 'i1',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'new' }] }],
    }).map((s) => s.type)).toEqual(['model_output']);
  });

  it('does not invent steps when the response omits them', () => {
    expect(getInteractionSteps({ id: 'i1' })).toEqual([]);
  });
});

describe('runModelInteraction', () => {
  it('preserves the SDK output_text convenience property', async () => {
    mockInteractionCreate.mockResolvedValueOnce({
      id: 'interaction-output-text',
      status: 'completed',
      steps: [],
      output_text: 'SDK convenience output',
    });

    await expect(runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
    })).resolves.toEqual(expect.objectContaining({
      output_text: 'SDK convenience output',
    }));
  });

  it('assembles current Interactions SSE events and emits typed live deltas', async () => {
    const completedSteps: InteractionStep[] = [
      { type: 'thought', signature: 'sig-1', summary: [{ type: 'text', text: 'Inspect totals' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Finished' }] },
    ];
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { event_type: 'interaction.created', interaction: { id: 'interaction-stream', status: 'in_progress' } };
      yield { event_type: 'step.start', index: 0, step: { type: 'thought', summary: [] } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Inspect ' } } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'totals' } } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-1' } };
      yield { event_type: 'step.stop', index: 0 };
      yield { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } };
      yield { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Fin' } };
      yield { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'ished' } };
      yield { event_type: 'step.stop', index: 1 };
      yield {
        event_type: 'interaction.completed',
        interaction: {
          id: 'interaction-stream',
          status: 'completed',
          steps: completedSteps,
          usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 },
        },
      };
    }
    mockInteractionCreate.mockResolvedValueOnce(events());
    const runtime = createProviderExecutionContext();
    const deltas: Array<{ kind: string; text: string; stepId?: string }> = [];

    const result = await runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
      runtime,
      onProgress: (delta) => deltas.push(delta),
    });

    expect(result).toMatchObject({
      id: 'interaction-stream',
      status: 'completed',
      steps: completedSteps,
      output_text: 'Finished',
      streamedProgressKinds: ['thought_summary', 'model_output'],
    });
    expect(deltas).toEqual([
      { kind: 'thought_summary', text: 'Inspect ', stepId: 'interaction-stream:0' },
      { kind: 'thought_summary', text: 'totals', stepId: 'interaction-stream:0' },
      { kind: 'model_output', text: 'Fin', stepId: 'interaction-stream:1' },
      { kind: 'model_output', text: 'ished', stepId: 'interaction-stream:1' },
    ]);
    expect(runtime.getUsage()).toMatchObject({ requests: 1, totalTokens: 12 });
    expect(mockInteractionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true }),
      undefined,
    );
  });

  it('preserves output_text supplied only by the terminal streaming event', async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { event_type: 'interaction.created', interaction: { id: 'terminal-text', status: 'in_progress' } };
      yield {
        event_type: 'interaction.completed',
        interaction: {
          id: 'terminal-text',
          status: 'completed',
          steps: [],
          output_text: 'Terminal convenience text',
        },
      };
    }
    mockInteractionCreate.mockResolvedValueOnce(events());

    await expect(runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
      onProgress: () => undefined,
    })).resolves.toMatchObject({ output_text: 'Terminal convenience text' });
  });

  it('records reported streaming usage before surfacing a terminal stream error', async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { event_type: 'interaction.created', interaction: { id: 'failed-stream', status: 'in_progress' } };
      yield {
        event_type: 'step.stop',
        index: 0,
        usage: { total_input_tokens: 7, total_output_tokens: 3, total_tokens: 10 },
      };
      yield { event_type: 'error', error: { code: 'INTERNAL', message: 'stream failed' } };
    }
    mockInteractionCreate.mockResolvedValueOnce(events());
    const runtime = createProviderExecutionContext();

    await expect(runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
      runtime,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ message: 'stream failed', code: 'INTERNAL' });
    expect(runtime.getUsage()).toMatchObject({ requests: 1, totalTokens: 10 });
  });

  it('sums per-step usage when a stream omits cumulative usage', async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { event_type: 'interaction.created', interaction: { id: 'step-usage-stream', status: 'in_progress' } };
      yield {
        event_type: 'step.stop',
        index: 0,
        step_usage: { total_input_tokens: 7, total_thought_tokens: 2, total_tokens: 9 },
      };
      yield {
        event_type: 'step.stop',
        index: 1,
        step_usage: { total_output_tokens: 3, total_tokens: 3 },
      };
      yield {
        event_type: 'interaction.completed',
        interaction: { id: 'step-usage-stream', status: 'completed', steps: [] },
      };
    }
    mockInteractionCreate.mockResolvedValueOnce(events());
    const runtime = createProviderExecutionContext();

    await runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
      runtime,
      onProgress: () => undefined,
    });

    expect(runtime.getUsage()).toMatchObject({
      requests: 1,
      inputTokens: 7,
      outputTokens: 3,
      thoughtTokens: 2,
      totalTokens: 12,
    });
  });

  it('keeps a delta channel ID stable when a gateway emits deltas before interaction.created', async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Early ' } };
      yield { event_type: 'interaction.created', interaction: { id: 'late-created-id', status: 'in_progress' } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'delta' } };
      yield {
        event_type: 'interaction.completed',
        interaction: {
          id: 'late-created-id',
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Early delta' }] }],
        },
      };
    }
    mockInteractionCreate.mockResolvedValueOnce(events());
    const stepIds: string[] = [];

    await runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
      onProgress: (delta) => stepIds.push(delta.stepId),
    });

    expect(stepIds).toHaveLength(2);
    expect(stepIds[0]).toBe(stepIds[1]);
  });

  it('rejects a stream that ends before interaction.completed', async () => {
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { event_type: 'interaction.created', interaction: { id: 'truncated', status: 'in_progress' } };
      yield { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } };
      yield { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'partial' } };
      yield { event_type: 'interaction.status_update', interaction_id: 'truncated', status: 'completed' };
    }
    mockInteractionCreate.mockResolvedValueOnce(events());

    await expect(runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Extract text',
      onProgress: () => undefined,
    })).rejects.toThrow(/without a terminal interaction\.completed/u);
  });

  it('records each chained interaction request usage in full', async () => {
    mockInteractionCreate
      .mockResolvedValueOnce({
        id: 'interaction-1',
        status: 'completed',
        steps: [],
        usage: {
          total_input_tokens: 10,
          total_output_tokens: 4,
          total_thought_tokens: 6,
          total_tokens: 20,
        },
      })
      .mockResolvedValueOnce({
        id: 'interaction-2',
        status: 'completed',
        steps: [],
        usage: {
          total_input_tokens: 40,
          total_output_tokens: 10,
          total_thought_tokens: 10,
          total_tokens: 60,
        },
      });
    const runtime = createProviderExecutionContext();

    await runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'First turn',
      runtime,
    });
    await runModelInteraction({
      apiKey: 'test-key',
      model: 'gemini-3.5-flash',
      input: 'Second turn',
      previousInteractionId: 'interaction-1',
      runtime,
    });

    expect(runtime.getUsage()).toMatchObject({
      requests: 2,
      inputTokens: 50,
      outputTokens: 14,
      thoughtTokens: 16,
      totalTokens: 80,
    });
  });
});

describe('createInteractionGenerationConfig', () => {
  it('maps each thinking level to its model-gated lowercase wire value', () => {
    expect(
      createInteractionGenerationConfig({}, 'gemini-3-flash-preview', { level: 'MEDIUM' }).thinking_level,
    ).toBe('medium');
    expect(
      createInteractionGenerationConfig({}, 'gemini-3.1-pro-preview', { level: 'MEDIUM' }).thinking_level,
    ).toBe('medium');
    expect(
      createInteractionGenerationConfig({}, 'gemini-3-flash-preview', { level: 'MINIMAL' }).thinking_level,
    ).toBe('minimal');
    expect(
      createInteractionGenerationConfig({}, 'gemini-3.1-flash-lite', { level: 'MINIMAL' }).thinking_level,
    ).toBe('minimal');
    expect(
      createInteractionGenerationConfig({}, 'gemini-3-flash-preview', { level: 'LOW' }).thinking_level,
    ).toBe('low');
    expect(
      createInteractionGenerationConfig({}, 'gemini-3-flash-preview', { level: 'HIGH' }).thinking_level,
    ).toBe('high');
  });

  it('rejects MINIMAL when the model does not support it (Pro)', () => {
    expect(() => (
      createInteractionGenerationConfig({}, 'gemini-3.1-pro-preview', { level: 'MINIMAL' })
    )).toThrow('gemini-3.1-pro-preview supports thinking levels low, medium, high');
  });

  it('defaults thinking when no thinking config is given', () => {
    const flash = createInteractionGenerationConfig({}, 'gemini-3.5-flash');
    expect(flash.thinking_level).toBe('medium');
    expect(flash.thinking_summaries).toBe('none');

    const lite = createInteractionGenerationConfig({}, 'gemini-3.1-flash-lite');
    expect(lite.thinking_level).toBe('minimal');

    const pro = createInteractionGenerationConfig({}, 'gemini-3.1-pro-preview');
    expect(pro.thinking_level).toBe('high');

    const preview = createInteractionGenerationConfig({}, 'gemini-3-flash-preview');
    expect(preview.thinking_level).toBe('high');
  });

  it('enables thought summaries only when includeThoughts is set', () => {
    expect(
      createInteractionGenerationConfig({}, 'gemini-3-flash-preview', { level: 'HIGH', includeThoughts: true })
        .thinking_summaries,
    ).toBe('auto');
    expect(
      createInteractionGenerationConfig({}, 'gemini-3-flash-preview', { level: 'HIGH', includeThoughts: false })
        .thinking_summaries,
    ).toBe('none');
  });

  it('passes through generation parameters using Interactions snake_case keys without top_p', () => {
    const config = createInteractionGenerationConfig(
      { temperature: 0.4, maxOutputTokens: 2048, topP: 0.8, toolChoice: 'validated' },
      'gemini-3-flash-preview',
    );
    expect(config.temperature).toBe(0.4);
    expect(config.max_output_tokens).toBe(2048);
    expect(config.top_p).toBeUndefined();
    expect(config.tool_choice).toBe('validated');
  });
});
