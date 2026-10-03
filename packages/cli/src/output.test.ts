import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliOptions } from './config';
import {
  assertArtifactTargetsAvailable,
  assertNoOutputCollisions,
  BatchOutputLock,
  ManifestStore,
  plannedArtifactTargets,
  primaryArtifact,
  writeArtifacts,
  writeBatchSummary,
} from './output';
import type { BatchSummary, OcrArtifacts, ResolvedCliOptions, ResolvedInput } from './types';

let directory: string;
let options: ResolvedCliOptions;
const input: ResolvedInput = {
  absolutePath: '/workspace/nested/invoice.pdf',
  displayPath: 'nested/invoice.pdf',
  relativePath: 'nested/invoice.pdf',
  name: 'invoice.pdf',
  mimeType: 'application/pdf',
  size: 100,
  mtimeMs: 123,
};
const artifacts: OcrArtifacts = {
  markdown: '# Invoice',
  json: { title: 'Invoice', sections: [] },
  csv: 'name,total\nAcme,12.00',
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-output-'));
  process.env.GEMINI_API_KEY = 'test-key';
  options = resolveCliOptions({ output: directory, format: 'all' }, {}, '/workspace');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
});

describe('CLI output', () => {
  it('renders primary artifacts for pipelines', () => {
    expect(primaryArtifact(artifacts, 'markdown')).toBe('# Invoice\n');
    expect(primaryArtifact(artifacts, 'json')).toContain('"title": "Invoice"');
    expect(primaryArtifact(artifacts, 'csv')).toBe('name,total\nAcme,12.00\n');
    expect(() => primaryArtifact({ markdown: '# Only' }, 'csv')).toThrow('tabular CSV');
  });

  it('writes all artifacts while preserving input directories', async () => {
    const written = await writeArtifacts(input, artifacts, options, 2);
    expect(written).toHaveLength(3);
    // Each destination carries the artifact key that produced it, which is what
    // the protocol reports as `kind`/`mediaType`.
    expect(written).toContainEqual({
      path: path.join(directory, 'nested', 'invoice.md'),
      extension: 'md',
    });
    expect(await readFile(path.join(directory, 'nested', 'invoice.json'), 'utf8')).toContain('"Invoice"');
  });

  it('preserves valid falsey custom-schema JSON values', async () => {
    const target = path.join(directory, 'null-result.json');
    const files = await writeArtifacts(
      input,
      { json: null },
      { ...options, format: 'json', output: target },
      1,
    );

    // A `.json` filename that happens to match the format is still described by
    // the format, not by the name.
    expect(files).toEqual([{ path: target, extension: 'json' }]);
    await expect(readFile(target, 'utf8')).resolves.toBe('null\n');
  });

  it('refuses accidental replacement and supports explicit overwrite', async () => {
    await writeArtifacts(input, artifacts, options, 2);
    await expect(writeArtifacts(input, artifacts, options, 2)).rejects.toThrow('Output already exists');
    await expect(writeArtifacts(input, artifacts, { ...options, overwrite: true }, 2)).resolves.toHaveLength(3);
  });

  it('cannot clobber an output created by another process during commit', async () => {
    const markdownTarget = path.join(directory, 'invoice.md');
    const originalLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, 'link').mockImplementation(async (...args: Parameters<typeof fs.link>) => {
      const destination = args[1].toString();
      if (destination === markdownTarget) await writeFile(markdownTarget, 'concurrent writer\n');
      return originalLink(...args);
    });
    try {
      await expect(writeArtifacts(
        { ...input, relativePath: 'invoice.pdf' },
        { markdown: '# Replacement', json: { replacement: true } },
        { ...options, format: 'all', overwrite: false },
        2,
      )).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(readFile(markdownTarget, 'utf8')).resolves.toBe('concurrent writer\n');
    } finally {
      link.mockRestore();
    }
  });

  it('falls back to exclusive no-clobber writes when hard links are unsupported', async () => {
    const unsupported = Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' });
    const link = vi.spyOn(fs, 'link').mockRejectedValue(unsupported);
    try {
      const files = await writeArtifacts(
        { ...input, relativePath: 'invoice.pdf' },
        { markdown: '# Portable', json: { portable: true } },
        { ...options, format: 'all', overwrite: false },
        2,
      );
      expect(files).toHaveLength(2);
      await expect(readFile(path.join(directory, 'invoice.md'), 'utf8')).resolves.toBe('# Portable\n');
      await expect(readFile(path.join(directory, 'invoice.json'), 'utf8')).resolves.toContain('"portable": true');
    } finally {
      link.mockRestore();
    }
  });

  it('plans dry-run targets and rejects same-stem batch collisions before extraction', async () => {
    const first = { ...input, absolutePath: '/workspace/invoice.pdf', relativePath: 'invoice.pdf', displayPath: 'invoice.pdf' };
    const second = {
      ...input,
      absolutePath: '/workspace/invoice.png',
      relativePath: 'invoice.png',
      displayPath: 'invoice.png',
      name: 'invoice.png',
      mimeType: 'image/png',
    };
    await expect(plannedArtifactTargets(first, options, 2)).resolves.toEqual([
      { path: path.join(directory, 'invoice.md'), extension: 'md' },
      { path: path.join(directory, 'invoice.json'), extension: 'json' },
    ]);
    await expect(assertNoOutputCollisions([first, second], options)).rejects.toThrow(
      'Output path collision detected before extraction',
    );
  });

  it('rejects mixed-case collisions portably on every platform', async () => {
    const first = { ...input, relativePath: 'Invoice.pdf', displayPath: 'Invoice.pdf' };
    const second = {
      ...input,
      absolutePath: '/workspace/invoice.png',
      relativePath: 'invoice.png',
      displayPath: 'invoice.png',
      name: 'invoice.png',
      mimeType: 'image/png',
    };
    await expect(assertNoOutputCollisions([first, second], options)).rejects.toThrow(
      'Output path collision detected before extraction',
    );
  });

  it('reserves batch metadata filenames before extraction', async () => {
    const metadataCollision = {
      ...input,
      absolutePath: '/workspace/batch-summary.pdf',
      relativePath: 'batch-summary.pdf',
      displayPath: 'batch-summary.pdf',
      name: 'batch-summary.pdf',
    };
    const other = {
      ...input,
      absolutePath: '/workspace/other.pdf',
      relativePath: 'other.pdf',
      displayPath: 'other.pdf',
      name: 'other.pdf',
    };
    await expect(assertNoOutputCollisions(
      [metadataCollision, other],
      { ...options, format: 'json' },
    )).rejects.toThrow('reserved job metadata');
  });

  it.each(['md', 'csv'])('rejects artifact-versus-directory collisions for %s output', async (extension) => {
    const first = { ...input, relativePath: 'invoice.pdf', displayPath: 'invoice.pdf' };
    const nested = {
      ...input,
      relativePath: `invoice.${extension}/page.pdf`,
      displayPath: `invoice.${extension}/page.pdf`,
    };
    const templateOptions = resolveCliOptions(
      { output: directory, format: 'all', preset: 'invoice' },
      {},
      '/workspace',
    );
    await expect(assertNoOutputCollisions([first, nested], templateOptions))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
  });

  it('rejects document directories that occupy a reserved metadata file', async () => {
    const nested = {
      ...input,
      relativePath: 'batch-summary.json/page.pdf',
      displayPath: 'batch-summary.json/page.pdf',
    };
    await expect(assertNoOutputCollisions([nested], options, true))
      .rejects.toThrow('reserved job metadata');
  });

  it('can reserve job metadata for a reference-first single-document run', async () => {
    const metadataCollision = {
      ...input,
      absolutePath: '/workspace/.open-ocr-manifest.jpg',
      relativePath: '.open-ocr-manifest.jpg',
      displayPath: '.open-ocr-manifest.jpg',
      name: '.open-ocr-manifest.jpg',
    };
    await expect(assertNoOutputCollisions(
      [metadataCollision],
      { ...options, format: 'json' },
      true,
    )).rejects.toThrow('reserved job metadata');
  });

  it('plans only the artifact set guaranteed by each all-format mode', async () => {
    const templateOptions = resolveCliOptions(
      { output: directory, format: 'all', preset: 'invoice' },
      {},
      '/workspace',
    );
    const agenticOptions = resolveCliOptions(
      { output: directory, format: 'all', mode: 'agentic' },
      {},
      '/workspace',
    );
    await expect(plannedArtifactTargets(input, templateOptions, 2)).resolves.toEqual([
      { path: path.join(directory, 'nested', 'invoice.md'), extension: 'md' },
      { path: path.join(directory, 'nested', 'invoice.json'), extension: 'json' },
    ]);
    await expect(plannedArtifactTargets(input, agenticOptions, 2)).resolves.toEqual([
      { path: path.join(directory, 'nested', 'invoice.md'), extension: 'md' },
      { path: path.join(directory, 'nested', 'invoice.json'), extension: 'json' },
      { path: path.join(directory, 'nested', 'invoice.steps.json'), extension: 'steps.json' },
    ]);
  });

  it('preflights optional all-format artifacts that extraction could produce', async () => {
    const templateOptions = resolveCliOptions(
      { output: directory, format: 'all', preset: 'invoice' },
      {},
      '/workspace',
    );
    const csvTarget = path.join(directory, 'nested', 'invoice.csv');
    await fs.mkdir(path.dirname(csvTarget), { recursive: true });
    await writeFile(csvTarget, 'existing,csv\n');

    await expect(assertArtifactTargetsAvailable(input, templateOptions, 2)).rejects.toThrow(
      `Output already exists before extraction: ${csvTarget}`,
    );
  });

  it('reclaims only the artifact paths a manifest entry recorded for the same input', async () => {
    const markdownTarget = path.join(directory, 'nested', 'invoice.md');
    const jsonTarget = path.join(directory, 'nested', 'invoice.json');
    await fs.mkdir(path.dirname(markdownTarget), { recursive: true });
    await writeFile(markdownTarget, 'stale markdown\n');
    await writeFile(jsonTarget, 'written by something else\n');

    // The recorded path is this input's own stale output, so re-extracting may
    // replace it. The unrecorded one at another possible target is a collision.
    await expect(assertArtifactTargetsAvailable(input, options, 2, {
      reclaimable: new Set([markdownTarget]),
      resumeActive: true,
    })).rejects.toThrow(`no resume manifest entry claims it for ${input.displayPath}: ${jsonTarget}`);

    await fs.rm(jsonTarget);
    await expect(assertArtifactTargetsAvailable(input, options, 2, {
      reclaimable: new Set([markdownTarget]),
      resumeActive: true,
    })).resolves.toBeUndefined();
  });

  it('replaces a reclaimed artifact without enabling a blanket overwrite', async () => {
    const markdownTarget = path.join(directory, 'nested', 'invoice.md');
    const jsonTarget = path.join(directory, 'nested', 'invoice.json');
    await fs.mkdir(path.dirname(markdownTarget), { recursive: true });
    await writeFile(markdownTarget, 'stale markdown\n');
    await writeFile(jsonTarget, 'written by something else\n');

    await expect(writeArtifacts(
      input,
      { markdown: '# Fresh', json: { fresh: true } },
      { ...options, format: 'all' },
      2,
      new Set([markdownTarget]),
    )).rejects.toThrow('Output already exists');
    // The unreclaimed destination is untouched, and the transaction rolled back.
    await expect(readFile(jsonTarget, 'utf8')).resolves.toBe('written by something else\n');
    await expect(readFile(markdownTarget, 'utf8')).resolves.toBe('stale markdown\n');

    await fs.rm(jsonTarget);
    await expect(writeArtifacts(
      input,
      { markdown: '# Fresh', json: { fresh: true } },
      { ...options, format: 'all' },
      2,
      new Set([markdownTarget]),
    )).resolves.toContainEqual({ path: markdownTarget, extension: 'md' });
    await expect(readFile(markdownTarget, 'utf8')).resolves.toBe('# Fresh\n');
  });

  it('reports the artifact paths a manifest already attributes to an input', async () => {
    const manifest = new ManifestStore(directory);
    await manifest.update('/workspace/invoice.pdf', {
      fingerprint: 'stale',
      status: 'succeeded',
      outputFiles: [path.join(directory, 'invoice.md')],
      completedAt: new Date().toISOString(),
    });

    // Reported whatever the fingerprint: a changed input still owns the output
    // its previous attempt wrote.
    expect(manifest.recordedArtifactPaths('/workspace/invoice.pdf'))
      .toEqual(new Set([path.join(directory, 'invoice.md')]));
    expect(manifest.recordedArtifactPaths('/workspace/other.pdf')).toEqual(new Set());
  });

  it('restores every existing artifact if an overwrite transaction fails', async () => {
    const markdownTarget = path.join(directory, 'invoice.md');
    const jsonTarget = path.join(directory, 'invoice.json');
    await writeFile(markdownTarget, 'original markdown\n');
    await writeFile(jsonTarget, '{"original":true}\n');
    const originalRename = fs.rename.bind(fs);
    let renameCalls = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      renameCalls += 1;
      if (renameCalls === 4) throw new Error('simulated commit failure');
      return originalRename(...args);
    });
    try {
      await expect(writeArtifacts(
        { ...input, relativePath: 'invoice.pdf' },
        { markdown: '# Replacement', json: { replacement: true } },
        { ...options, format: 'all', overwrite: true },
        2,
      )).rejects.toThrow('simulated commit failure');
      await expect(readFile(markdownTarget, 'utf8')).resolves.toBe('original markdown\n');
      await expect(readFile(jsonTarget, 'utf8')).resolves.toBe('{"original":true}\n');
    } finally {
      rename.mockRestore();
    }
  });

  it('surfaces rollback failures instead of hiding a mixed filesystem state', async () => {
    const markdownTarget = path.join(directory, 'invoice.md');
    const jsonTarget = path.join(directory, 'invoice.json');
    await writeFile(markdownTarget, 'original markdown\n');
    await writeFile(jsonTarget, '{"original":true}\n');
    const originalRename = fs.rename.bind(fs);
    let renameCalls = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      renameCalls += 1;
      if (renameCalls === 4) throw new Error('simulated commit failure');
      if (renameCalls === 5) throw new Error('simulated restore failure');
      return originalRename(...args);
    });
    try {
      await expect(writeArtifacts(
        { ...input, relativePath: 'invoice.pdf' },
        { markdown: '# Replacement', json: { replacement: true } },
        { ...options, format: 'all', overwrite: true },
        2,
      )).rejects.toThrow('artifact rollback also failed');
    } finally {
      rename.mockRestore();
    }
  });

  it('persists and verifies resumable manifest entries', async () => {
    const outputFile = path.join(directory, 'invoice.json');
    await writeArtifacts(
      { ...input, relativePath: 'invoice.pdf' },
      { json: artifacts.json },
      { ...options, format: 'json' },
      2,
    );
    const manifest = new ManifestStore(directory);
    await manifest.load();
    await manifest.update('/workspace/invoice.pdf', {
      fingerprint: 'abc',
      status: 'succeeded',
      outputFiles: [outputFile],
      completedAt: new Date().toISOString(),
    });
    const reloaded = new ManifestStore(directory);
    await reloaded.load();
    await expect(reloaded.completedEntry('/workspace/invoice.pdf', 'abc')).resolves.toMatchObject({
      outputFiles: [outputFile],
      status: 'succeeded',
    });
    await expect(reloaded.completedEntry('/workspace/invoice.pdf', 'different')).resolves.toBeUndefined();

    await manifest.update('/workspace/invoice.pdf', {
      fingerprint: 'partial',
      status: 'partial',
      outputFiles: [outputFile],
      completedAt: new Date().toISOString(),
    });
    const partial = new ManifestStore(directory);
    await partial.load();
    // A partial document produced less than the extraction asked for, so resume
    // must re-extract it rather than report the shortfall as a clean skip.
    await expect(partial.completedEntry('/workspace/invoice.pdf', 'partial')).resolves.toBeUndefined();
  });

  it('surfaces artifact permission errors instead of treating them as a resume miss', async () => {
    const manifest = new ManifestStore(directory);
    await manifest.update('/workspace/invoice.pdf', {
      fingerprint: 'abc',
      status: 'succeeded',
      outputFiles: [path.join(directory, 'invoice.json')],
      completedAt: new Date().toISOString(),
    });
    const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(
      new Error('permission denied'),
      { code: 'EACCES' },
    ));
    try {
      await expect(manifest.completedEntry('/workspace/invoice.pdf', 'abc')).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      stat.mockRestore();
    }
  });

  it('does not resume when a directory occupies a recorded artifact path', async () => {
    const outputFile = path.join(directory, 'invoice.json');
    await fs.mkdir(outputFile);
    const manifest = new ManifestStore(directory);
    await manifest.update('/workspace/invoice.pdf', {
      fingerprint: 'abc',
      status: 'succeeded',
      outputFiles: [outputFile],
      completedAt: new Date().toISOString(),
    });
    await expect(manifest.completedEntry('/workspace/invoice.pdf', 'abc')).resolves.toBeUndefined();
  });

  it.each([false, true])('preserves directories at artifact destinations with overwrite=%s', async (overwrite) => {
    const target = path.join(directory, 'nested', 'invoice.md');
    await fs.mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep.txt'), 'keep');
    const destinationOptions = { ...options, format: 'markdown' as const, overwrite };
    const reclaimable = new Set([target]);

    await expect(assertArtifactTargetsAvailable(input, destinationOptions, 2, { reclaimable }))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    await expect(writeArtifacts(input, artifacts, destinationOptions, 2, reclaimable))
      .rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    await expect(readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects malformed resume manifests instead of trusting unsafe entry shapes', async () => {
    const manifestPath = path.join(directory, '.open-ocr-manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      entries: {
        '/workspace/invoice.pdf': {
          fingerprint: 'abc',
          status: 'succeeded',
          outputFiles: 'invoice.json',
          completedAt: new Date().toISOString(),
        },
      },
    }));
    await expect(new ManifestStore(directory).load()).rejects.toThrow('has invalid outputFiles');

    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      entries: {
        '/workspace/invoice.pdf': {
          fingerprint: 'abc',
          status: 'succeeded',
          outputFiles: [],
          completedAt: new Date().toISOString(),
        },
      },
    }));
    await expect(new ManifestStore(directory).load()).rejects.toThrow('has no resumable output files');

    await writeFile(manifestPath, '{not-json');
    await expect(new ManifestStore(directory).load()).rejects.toThrow(`Invalid JSON in ${manifestPath}`);
  });

  it('prevents concurrent batch ownership and releases only its own lock', async () => {
    const first = await BatchOutputLock.acquire(directory);
    await expect(BatchOutputLock.acquire(directory)).rejects.toThrow(
      'Batch output directory is already in use',
    );
    await expect(BatchOutputLock.acquire(directory, { forceUnlock: true })).rejects.toThrow(
      'is still running',
    );
    await first.release();

    const second = await BatchOutputLock.acquire(directory);
    await expect(second.release()).resolves.toBeUndefined();
  });

  it('force-unlocks a valid same-host lock only after its owner is proven dead', async () => {
    const lockPath = path.join(directory, '.open-ocr.lock');
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      token: 'stale-token',
      pid: 987654321,
      hostname: hostname(),
      startedAt: '2026-07-15T00:00:00.000Z',
    })}\n`);
    const dead = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw dead; });
    const warnings: string[] = [];
    try {
      const recovered = await BatchOutputLock.acquire(directory, {
        forceUnlock: true,
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings).toEqual([expect.stringContaining('Removed stale batch lock')]);
      await recovered.release();
    } finally {
      kill.mockRestore();
    }
  });

  it('preserves the prior batch summary if its atomic replacement fails', async () => {
    const target = path.join(directory, 'batch-summary.json');
    await writeFile(target, '{"previous":true}\n');
    const summary: BatchSummary = {
      version: 1,
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:01.000Z',
      durationMs: 1000,
      total: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      mode: 'simple',
      model: 'gemini-3.5-flash',
      usage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        toolTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
      costLimitReached: false,
      results: [],
    };
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated summary commit failure'));
    try {
      await expect(writeBatchSummary(summary, directory)).rejects.toThrow('simulated summary commit failure');
      await expect(readFile(target, 'utf8')).resolves.toBe('{"previous":true}\n');
      expect((await fs.readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      rename.mockRestore();
    }
  });
});
