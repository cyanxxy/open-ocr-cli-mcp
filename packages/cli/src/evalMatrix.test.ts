import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseMatrixConfig, waitForMatrixChild } from '../../../evals/run-matrix';

describe('evaluation matrix safety', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  const spawnStub = (script: string): ChildProcess => {
    const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    return child;
  };

  it.each(['../escape', '/tmp/escape', '..\\escape', '.', 'path/file', 'name\n', 'x'.repeat(81)])(
    'refuses unsafe artifact identifiers: %j', (id) => {
      expect(() => parseMatrixConfig({ providers: [{ id, provider: 'gemini', model: 'gemini-3.8-flash' }] })).toThrow('id must be');
    },
  );

  it('validates records before launching any worker and rejects portable path collisions', () => {
    const entry = { id: 'gemini-direct', provider: 'gemini', model: 'gemini-3.8-flash' };
    expect(parseMatrixConfig({ providers: [entry] }).providers).toEqual([entry]);
    expect(() => parseMatrixConfig({ providers: [entry, { ...entry, id: 'GEMINI-DIRECT' }] })).toThrow('unique');
    expect(() => parseMatrixConfig({ providers: [null] })).toThrow('object');
    expect(() => parseMatrixConfig({ providers: [{ ...entry, model: {} }] })).toThrow('requires a model');
    expect(() => parseMatrixConfig({ providers: [{ ...entry, baseUrl: false }] })).toThrow('non-empty string');
    expect(() => parseMatrixConfig(null)).toThrow('non-empty providers');
  });

  it('retains successful and failed child exit codes', async () => {
    for (const code of [0, 7]) {
      const child = spawnStub(`process.exitCode = ${code}`);
      expect(await waitForMatrixChild(child, new AbortController().signal)).toBe(code);
      expect(child.exitCode).toBe(code);
    }
  });

  it('forwards cancellation and joins the worker before rejecting', async () => {
    const child = spawnStub(`
      process.on('SIGTERM', () => { process.send('terminated'); setTimeout(() => process.exit(0), 20); });
      process.send('ready');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const stopped = new Error('stop matrix');
    const result = waitForMatrixChild(child, controller.signal);
    // Install rejection handling before sending cancellation, avoiding an
    // unhandled rejection if the small child shuts down immediately.
    const assertion = expect(result).rejects.toBe(stopped);
    await once(child, 'message');
    const forwarded = once(child, 'message');
    controller.abort(stopped);
    await forwarded;
    await assertion;
    expect(child.exitCode).toBe(0);
  });

  it('treats an independently terminated worker as cancellation', async () => {
    const child = spawnStub("process.send('ready'); setInterval(() => {}, 1000)");
    const result = waitForMatrixChild(child, new AbortController().signal);
    const assertion = expect(result).rejects.toMatchObject({ exitCode: 130 });
    await once(child, 'message');
    child.kill('SIGINT');
    await assertion;
  });

  it('joins a newly spawned worker when the signal was already aborted', async () => {
    const controller = new AbortController();
    const stopped = new Error('already stopped');
    controller.abort(stopped);
    const child = spawnStub('setInterval(() => {}, 1000)');
    await expect(waitForMatrixChild(child, controller.signal)).rejects.toBe(stopped);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('force-stops a worker that ignores the forwarded signal', async () => {
    const child = spawnStub("process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const stopped = new Error('stop stubborn worker');
    const result = waitForMatrixChild(child, controller.signal);
    const assertion = expect(result).rejects.toBe(stopped);
    await once(child, 'message');
    vi.useFakeTimers();
    controller.abort(stopped);
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    await assertion;
    expect(child.signalCode).toBe('SIGKILL');
  });
});
