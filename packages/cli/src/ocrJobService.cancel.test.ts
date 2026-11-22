import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hashCalls, onHash } = vi.hoisted(() => ({
  hashCalls: { count: 0 },
  onHash: { current: undefined as (() => void) | undefined },
}));

// Wrap the content hash so a test can cancel from inside the hashing pass.
vi.mock('./inputs', async (importOriginal) => {
  const original = await importOriginal<typeof import('./inputs')>();
  return {
    ...original,
    inputContentSha256: (...args: Parameters<typeof original.inputContentSha256>) => {
      hashCalls.count += 1;
      onHash.current?.();
      return original.inputContentSha256(...args);
    },
  };
});

import { resolveCliOptions } from './config';
import { discoverInputSet } from './inputs';
import { OcrJobService, type OcrDocumentExtractor } from './ocrJobService';
import { ManifestStore } from './output';
import type { ManifestEntry } from './types';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-cancel-'));
  hashCalls.count = 0;
  onHash.current = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('cancellation before any document starts', () => {
  it('stops the up-front hashing pass and writes no claims', async () => {
    const docs = path.join(directory, 'docs');
    await mkdir(docs);
    for (let index = 0; index < 20; index += 1) await writeFile(path.join(docs, `d${index}.jpg`), JPEG_BYTES);
    const options = {
      ...resolveCliOptions({ output: path.join(directory, 'out'), concurrency: '2' }, {}, directory),
      apiKey: 'test-key',
      quiet: true,
    };
    const { inputs } = await discoverInputSet([docs], options);
    const abortController = new AbortController();
    // A Ctrl-C (or an MCP cancel) while the second file is being read.
    onHash.current = () => {
      if (hashCalls.count === 2) abortController.abort(new Error('Cancelled by user'));
    };
    const updateMany = vi.spyOn(ManifestStore.prototype, 'updateMany');
    const extractDocument = vi.fn<OcrDocumentExtractor>();

    const execution = await new OcrJobService({ extractDocument }).run(inputs, options, {
      runId: 'cancel-while-hashing',
      abortController,
    });

    expect(hashCalls.count).toBeLessThan(20);
    expect(updateMany).not.toHaveBeenCalled();
    expect(extractDocument).not.toHaveBeenCalled();
    expect(execution.summary.results).toHaveLength(20);
    expect(execution.summary.results.every((result) => (
      result.status === 'skipped' && result.skipReason === 'cancelled'
    ))).toBe(true);
    expect(execution.result.status).toBe('cancelled');
    const onDisk = JSON.parse(await readFile(path.join(directory, 'out', '.open-ocr-manifest.json'), 'utf8')) as {
      entries: Record<string, ManifestEntry>;
    };
    expect(Object.values(onDisk.entries).filter((entry) => entry.status === 'pending')).toEqual([]);
  });
});
