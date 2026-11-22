import { promises as fs } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate a `..` spelling the pattern guard does not know yet: the pattern is
// passed through unchanged, so discovery walks outside the working directory.
vi.mock('./fileBoundary', async () => {
  const actual = await vi.importActual<typeof import('./fileBoundary')>('./fileBoundary');
  return { ...actual, confineCallerPattern: vi.fn((_cwd: string, pattern: string) => Promise.resolve(pattern)) };
});

import { ocrErrorPayload } from './errors';
import { executeOcrJobRequest } from './machine';

let base: string;
let cwd: string;
const originalApiKey = process.env.GEMINI_API_KEY;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'open-ocr-walk-'));
  cwd = path.join(base, 'cwd');
  await mkdir(cwd);
  await mkdir(path.join(base, 'outside'));
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  await rm(base, { recursive: true, force: true });
});

describe('MCP discovery confinement', () => {
  it('refuses an outside match before discovery stats or opens it, whatever the file holds', async () => {
    const open = vi.spyOn(fs, 'open');
    const stat = vi.spyOn(fs, 'stat');
    const run = () => executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      noConfig: true,
      inputs: [{ type: 'path', path: '{.,.}./outside/notes.tmp' }],
      dryRun: true,
    }, { cwd, runId: 'run-walk', abortController: new AbortController(), boundary: 'mcp' });

    const payloads = [];
    for (const content of ['plain text, not a document', '%PDF-1.7\n']) {
      await writeFile(path.join(base, 'outside', 'notes.tmp'), content);
      payloads.push(ocrErrorPayload(await run().then(() => undefined, (error: unknown) => error)));
    }
    for (const payload of payloads) {
      expect(payload).toMatchObject({ code: 'INPUT_INVALID' });
      expect(payload.message).toContain('resolves outside the MCP server working directory');
      expect(JSON.stringify(payload)).not.toContain('notes');
    }
    // Discovery's literal-path stat of the pattern itself (ENOENT inside the
    // working directory) is expected; the outside file must never be reached.
    const outsideFile = path.join(base, 'outside', 'notes.tmp');
    const touched = [...open.mock.calls, ...stat.mock.calls].map(([file]) => path.resolve(String(file)));
    expect(touched).not.toContain(outsideFile);
  });
});
