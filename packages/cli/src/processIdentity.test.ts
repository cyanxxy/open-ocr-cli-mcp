import { hostname } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync } = vi.hoisted(() => ({ mockExecFileSync: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: mockExecFileSync };
});

import {
  batchLockOwnerState,
  parsePsLstartUtc,
  procStatStartTicks,
  processStartIdentity,
  sameProcessStart,
} from './output';

/** One process start instant, as `ps -o lstart=` prints it under different environments. */
const START_UTC = 'Sun Nov  1 18:20:43 2026';
const PRINTED: Record<string, string> = {
  'C/UTC': START_UTC,
  'en_US/America/Los_Angeles': 'Sun Nov  1 10:20:43 2026',
  'de_DE/Europe/Berlin': 'So  1 Nov 19:20:43 2026',
  'ja_JP/Asia/Tokyo': '2026年11月 2日 日曜日 03時20分43秒',
};

let ambient = 'en_US/America/Los_Angeles';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

/** A fake `ps` that honours LC_ALL/TZ from the environment it is given, like the real one. */
function fakePs(_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env;
  const key = env?.LC_ALL === 'C' && env.TZ === 'UTC' ? 'C/UTC' : ambient;
  return `${PRINTED[key]}\n`;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  mockExecFileSync.mockImplementation(fakePs);
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  mockExecFileSync.mockReset();
});

describe('process start identity on macOS/BSD', () => {
  it('is the same whatever the caller locale and time zone', () => {
    const identities = Object.keys(PRINTED).filter((key) => key !== 'C/UTC').map((key) => {
      ambient = key;
      return processStartIdentity(4242);
    });
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toBe(`ps-utc:${Date.UTC(2026, 10, 1, 18, 20, 43) / 1000}`);
    const [, , options] = mockExecFileSync.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env).toMatchObject({ LC_ALL: 'C', TZ: 'UTC' });
  });

  it('keeps a live lock written from another locale/time zone live', () => {
    ambient = 'de_DE/Europe/Berlin';
    const processStart = processStartIdentity(process.pid);
    expect(processStart).toBeDefined();
    ambient = 'ja_JP/Asia/Tokyo';
    expect(batchLockOwnerState({
      version: 1,
      token: 't',
      pid: process.pid,
      hostname: hostname(),
      startedAt: '2026-11-01T18:20:43.000Z',
      processStart,
    })).toBe('live');
  });

  it('reports a reused PID as stale when the start times really differ', () => {
    expect(batchLockOwnerState({
      version: 1,
      token: 't',
      pid: process.pid,
      hostname: hostname(),
      startedAt: '2026-10-01T00:00:00.000Z',
      processStart: `ps-utc:${Date.UTC(2026, 9, 1) / 1000}`,
    })).toBe('stale');
  });

  it('treats an unreadable or incomparable identity as live, never stale', () => {
    const owner = {
      version: 1 as const,
      token: 't',
      pid: process.pid,
      hostname: hostname(),
      startedAt: '2026-11-01T18:20:43.000Z',
    };
    mockExecFileSync.mockImplementation(() => 'garbage output\n');
    expect(processStartIdentity(process.pid)).toBeUndefined();
    expect(batchLockOwnerState({ ...owner, processStart: 'ps-utc:1' })).toBe('live');

    mockExecFileSync.mockImplementation(() => {
      throw new Error('ps: not permitted');
    });
    expect(batchLockOwnerState({ ...owner, processStart: 'ps-utc:1' })).toBe('live');

    // A record in an older, locale-dependent format cannot be compared.
    mockExecFileSync.mockImplementation(fakePs);
    expect(batchLockOwnerState({ ...owner, processStart: 'ps:So  1 Nov 19:20:43 2026' })).toBe('live');
  });
});

describe('start identity helpers', () => {
  it('reads starttime after a command name with spaces and parentheses', () => {
    const tail = 'S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21';
    expect(procStatStartTicks(`123 (node) ${tail}`)).toBe('987654');
    expect(procStatStartTicks(`123 (my (weird) cmd) ${tail}`)).toBe('987654');
    expect(procStatStartTicks(`123 (a) b ) c) ${tail}`)).toBe('987654');
    expect(procStatStartTicks(`123 (x\ny) ${tail}`)).toBe('987654');
    expect(procStatStartTicks('123 (node) S 1 2')).toBeUndefined();
    expect(procStatStartTicks('garbage')).toBeUndefined();
  });

  it('parses only C-locale lstart output', () => {
    expect(parsePsLstartUtc('Sun Nov  1 18:20:43 2026')).toBe(Date.UTC(2026, 10, 1, 18, 20, 43) / 1000);
    expect(parsePsLstartUtc('Mon Dec 14 09:05:00 2026\n')).toBe(Date.UTC(2026, 11, 14, 9, 5, 0) / 1000);
    expect(parsePsLstartUtc('So  1 Nov 19:20:43 2026')).toBeUndefined();
    expect(parsePsLstartUtc('')).toBeUndefined();
  });

  it('compares identities only within one scheme', () => {
    expect(sameProcessStart('linux:boot-a:100', 'linux:boot-a:100')).toBe(true);
    expect(sameProcessStart('linux:boot-a:100', 'linux:boot-a:101')).toBe(false);
    expect(sameProcessStart('linux:boot-a:100', 'linux:boot-b:100')).toBe(false);
    expect(sameProcessStart('linux::100', 'linux:boot-b:100')).toBe(true);
    expect(sameProcessStart('ps-utc:1000', 'ps-utc:1001')).toBe(true);
    expect(sameProcessStart('ps-utc:1000', 'ps-utc:2000')).toBe(false);
    expect(sameProcessStart('ps:Sun Nov  1 18:20:43 2026', 'ps-utc:1000')).toBeUndefined();
    expect(sameProcessStart('linux:a:1', 'ps-utc:1')).toBeUndefined();
  });
});
