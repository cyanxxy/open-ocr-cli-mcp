import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureGeminiRequestPolicy,
  GeminiCostLimitError,
  resetGeminiRequestPolicy,
  waitForGeminiRequestSlot,
} from './requestPolicy';
import { recordGeminiUsage, resetGeminiUsage } from './usage';

afterEach(() => {
  resetGeminiRequestPolicy();
  resetGeminiUsage();
  vi.useRealTimers();
});

describe('Gemini request policy', () => {
  it('does not delay requests when no rate limit is configured', async () => {
    await expect(waitForGeminiRequestSlot()).resolves.toBeUndefined();
  });

  it('spaces queued requests according to the configured RPM', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    configureGeminiRequestPolicy({ requestsPerMinute: 60 });
    await waitForGeminiRequestSlot();
    const second = waitForGeminiRequestSlot();
    await vi.advanceTimersByTimeAsync(999);
    let completed = false;
    void second.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBeUndefined();
  });

  it('aborts immediately while waiting behind another rate-limited request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    configureGeminiRequestPolicy({ requestsPerMinute: 60 });
    await waitForGeminiRequestSlot();
    const second = waitForGeminiRequestSlot();
    const abortController = new AbortController();
    const queued = waitForGeminiRequestSlot(abortController.signal);

    abortController.abort(new Error('Interrupted'));
    await expect(queued).rejects.toThrow('Interrupted');
    const following = waitForGeminiRequestSlot();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBeUndefined();
    let followingCompleted = false;
    void following.then(() => { followingCompleted = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(followingCompleted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(following).resolves.toBeUndefined();
  });

  it('blocks the next request after recorded usage reaches the cost limit', async () => {
    configureGeminiRequestPolicy({ maxCostUsd: 0.000001 });
    await waitForGeminiRequestSlot();
    recordGeminiUsage({
      usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100, totalTokenCount: 1_100 },
    }, 'gemini-3.8-flash');

    await expect(waitForGeminiRequestSlot()).rejects.toBeInstanceOf(GeminiCostLimitError);
  });
});
