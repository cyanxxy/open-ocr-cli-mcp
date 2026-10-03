import { describe, expect, it } from 'vitest';

import type { AgentStep } from './agentTypes';
import { streamAgentOperation, waitForAbortableAgentDelay } from './agentStepStream';

describe('streamAgentOperation', () => {
  it.each([undefined, null, 'rejected'])('fails closed on a non-Error rejection: %s', async (reason) => {
    // Exercise arbitrary rejections from third-party async operations.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const generator = streamAgentOperation(() => Promise.reject(reason));
    await expect(generator.next()).rejects.toThrow(reason === 'rejected' ? 'rejected' : 'Agent operation failed');
  });

  it('yields steps that arrive between empty-queue check and waiter arming', async () => {
    const yielded: AgentStep[] = [];
    let resolveTurn!: (value: string) => void;
    const turn = new Promise<string>((resolve) => {
      resolveTurn = resolve;
    });

    const generator = streamAgentOperation((onStep) => {
      // Push a step on the next microtask while the consumer may be arming wake.
      queueMicrotask(() => {
        onStep({
          type: 'thinking',
          content: 'live',
          timestamp: Date.now(),
        });
      });
      return turn;
    });

    const first = await generator.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      yielded.push(first.value);
      expect(first.value.content).toBe('live');
    }

    resolveTurn('ok');
    const final = await generator.next();
    expect(final.done).toBe(true);
    expect(final.value).toBe('ok');
    expect(yielded).toHaveLength(1);
  });

  it('propagates operation failures after draining queued steps', async () => {
    const generator = streamAgentOperation(async (onStep) => {
      onStep({
        type: 'error',
        content: 'before fail',
        timestamp: Date.now(),
      });
      return Promise.reject(new Error('turn failed'));
    });

    const first = await generator.next();
    expect(first.done).toBe(false);
    await expect(generator.next()).rejects.toThrow('turn failed');
  });
});

describe('waitForAbortableAgentDelay', () => {
  it('rejects promptly when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(waitForAbortableAgentDelay(50, controller.signal)).rejects.toThrow('cancelled');
  });
});
