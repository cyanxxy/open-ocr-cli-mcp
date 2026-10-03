import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockExecuteAgentTurn } = vi.hoisted(() => ({
  mockExecuteAgentTurn: vi.fn(),
}));

vi.mock('./agentGemini', () => ({
  executeAgentTurn: mockExecuteAgentTurn,
  createAgentSystemPrompt: vi.fn(() => 'system prompt'),
  createUserPrompt: vi.fn(() => 'initial prompt'),
  createFollowUpPrompt: vi.fn(() => 'follow-up prompt'),
}));

import { agentLoop } from './agentLoop';
import type { AgentClientConfig, AgentMemory, AgentStep } from './agentTypes';
import { GeminiCostLimitError } from './gemini/requestPolicy';

async function drainLoop(generator: AsyncGenerator<AgentStep, AgentMemory>) {
  const steps: AgentStep[] = [];
  let current = await generator.next();
  while (!current.done) {
    steps.push(current.value);
    current = await generator.next();
  }
  return { steps, memory: current.value };
}

const FIXTURE_FILE = () => new File(['fixture'], 'invoice.pdf', { type: 'application/pdf' });
const FIXTURE_DATA = 'data:application/pdf;base64,ZmFrZQ==';
// Zero out the backoff/pause so retry behavior is exercised without real waits.
const BASE_CONFIG = {
  confidenceThreshold: 0.8,
  maxTokens: 1024,
  retryBaseDelayMs: 0,
  iterationPauseMs: 0,
};


describe('agentLoop', () => {
  beforeEach(() => {
    mockExecuteAgentTurn.mockReset();
  });

  it('reports success only when readiness criteria are met', async () => {
    // The model stops calling tools AND the runtime's deterministic criteria
    // (a valid field + confidence >= threshold) are satisfied (audit C-03).
    mockExecuteAgentTurn.mockImplementation((...args: unknown[]) => {
      const memory = args[7] as AgentMemory;
      memory.extractedFields.note = { value: 'hello', confidence: 0.9, isValid: true, extractedAt: 1 };
      memory.confidence = 0.9;
      return Promise.resolve({
        finished: true,
        steps: [{ type: 'thinking', content: 'No more tool calls are needed.', timestamp: 1 }],
      });
    });

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(memory.stopReason).toBe('succeeded');
    expect(steps.some((s) => s.type === 'result' && s.content.includes('Extraction complete'))).toBe(true);
    expect(memory.currentIteration).toBe(1);
  });

  it('does NOT report success when the model stops early with zero fields', async () => {
    // finished:true but no extraction must be a partial result, never a success
    // (the previous loop mapped any finished turn to "completed successfully").
    mockExecuteAgentTurn.mockResolvedValue({
      finished: true,
      steps: [{ type: 'thinking', content: 'Looks done to me.', timestamp: 1 }],
    });

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    expect(memory.stopReason).toBe('partial');
    expect(steps.some((s) => s.type === 'result' && /partial/i.test(s.content))).toBe(true);
    expect(steps.some((s) => s.content === 'Document processing completed successfully')).toBe(false);
  });

  it('continues refining existing fields while confidence improves', async () => {
    const confidences = [0.4, 0.6, 0.9];
    mockExecuteAgentTurn.mockImplementation((...args: unknown[]) => {
      const memory = args[7] as AgentMemory;
      const confidence = confidences[memory.currentIteration - 1];
      memory.extractedFields.note = { value: 'hello', confidence, isValid: true };
      memory.confidence = confidence;
      return Promise.resolve({ finished: true, steps: [] });
    });
    const { memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(), FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));
    expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(3);
    expect(memory.stopReason).toBe('succeeded');
  });

  it('stops when existing fields are unchanged even if their extraction timestamps change', async () => {
    mockExecuteAgentTurn.mockImplementation((...args: unknown[]) => {
      const memory = args[7] as AgentMemory;
      memory.extractedFields.note = {
        value: 'hello', confidence: 0.4, isValid: true, extractedAt: memory.currentIteration,
      };
      memory.confidence = 0.4;
      return Promise.resolve({ finished: true, steps: [] });
    });
    const { memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(), FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));
    expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(2);
    expect(memory.stopReason).toBe('partial');
  });

  it('finalizes instead of looping when the inner tool-call rounds are exhausted', async () => {
    mockExecuteAgentTurn.mockResolvedValue({ finished: false, steps: [] });

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    // Terminal: a single turn that exhausts its rounds must NOT start a new
    // iteration on top of a dangling function_result turn.
    expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(memory.stopReason).toBe('tool_limit_reached');
    expect(steps.some((s) => s.type === 'result' && s.content.includes('tool-call limit'))).toBe(true);
  });

  it('breaks immediately on a terminal (auth) API error and emits an error step', async () => {
    mockExecuteAgentTurn.mockRejectedValue(new Error('API key invalid'));

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(memory.stopReason).toBe('failed');
    expect(steps.some((s) => s.type === 'error')).toBe(true);
  });

  it('rethrows a terminal Gemini error for machine-facing callers', async () => {
    mockExecuteAgentTurn.mockRejectedValue(new Error('API key invalid'));

    await expect(drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG, throwOnFailure: true },
    ))).rejects.toThrow('API key invalid');
  });

  it('preserves partial agent output when the next request is blocked by the cost limit', async () => {
    mockExecuteAgentTurn.mockRejectedValue(new GeminiCostLimitError(0.01));

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(memory.stopReason).toBe('cost_limit_reached');
    expect(steps.some((step) => step.type === 'result' && /cost limit/i.test(step.content))).toBe(true);
    expect(steps.some((step) => step.type === 'error')).toBe(false);
  });

  it('retries a transient error with backoff before giving up', async () => {
    mockExecuteAgentTurn.mockRejectedValue(new Error('503 service unavailable'));

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    // A transient error is retried (more than the single initial attempt) and
    // only then gives up — it is NOT treated as immediately fatal (audit H-17).
    expect(mockExecuteAgentTurn.mock.calls.length).toBeGreaterThan(1);
    expect(steps.some((s) => s.type === 'thinking' && /retrying/i.test(s.content))).toBe(true);
    expect(memory.stopReason).toBe('failed');
  });

  it('returns immediately without calling the model when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const { steps, memory } = await drainLoop(agentLoop(
      FIXTURE_FILE(),
      FIXTURE_DATA,
      { apiKey: 'test-key', model: 'gemini-3-flash-preview', abortSignal: controller.signal },
      { maxIterations: 3, ...BASE_CONFIG },
    ));

    expect(mockExecuteAgentTurn).not.toHaveBeenCalled();
    expect(steps.some((s) => s.type === 'error')).toBe(false);
    expect(memory.extractedFields).toEqual({});
  });

  it('aborts an active turn at its document deadline and retains partial memory', async () => {
    vi.useFakeTimers();
    try {
      mockExecuteAgentTurn.mockImplementation((...args: unknown[]) => {
        const memory = args[7] as AgentMemory;
        const signal = (args[8] as AgentClientConfig).abortSignal!;
        memory.extractedFields.note = { value: 'partial', confidence: 0.4 };
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true });
        });
      });
      const pending = drainLoop(agentLoop(
        FIXTURE_FILE(), FIXTURE_DATA,
        { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
        { maxIterations: 3, ...BASE_CONFIG, maxDurationMs: 25, throwOnFailure: true },
      ));
      await vi.advanceTimersByTimeAsync(25);
      const { memory, steps } = await pending;
      expect(memory.stopReason).toBe('budget_exhausted');
      expect(memory.extractedFields.note.value).toBe('partial');
      expect(steps.some((step) => step.type === 'result' && step.content.includes('time budget'))).toBe(true);
      expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
