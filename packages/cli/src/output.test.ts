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
    expect(() => primaryArtifact({ markdown: '# Only' }, 'csv')).toThrow('no CSV could be produced');
  });

  it('types a missing CSV as an output-contract failure, not a provider failure', () => {
    let thrown: unknown;
    try {
      primaryArtifact({ markdown: '# Only' }, 'csv');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'OUTPUT_INVALID', category: 'output', retryable: false, exitCode: 1 });
    expect((thrown as { hint: string }).hint).toMatch(/--format json/);
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
    // `.open-ocr-manifest.jpg` can no longer collide: hidden names lose their
    // leading dot (`_open-ocr-manifest.json`). The summary is still reserved.
    const metadataCollision = {
      ...input,
      absolutePath: '/workspace/batch-summary.jpg',
      relativePath: 'batch-summary.jpg',
      displayPath: 'batch-summary.jpg',
      name: 'batch-summary.jpg',
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
    await expect(BatchOutputLock.acquire(directory)).rejects.toMatchObject({
      code: 'OUTPUT_CONFLICT',
      message: expect.stringContaining(`in use by running PID ${process.pid}`) as unknown,
      hint: expect.stringContaining('Wait for that batch to finish') as unknown,
    });
    await first.release();

    const second = await BatchOutputLock.acquire(directory);
    await expect(second.release()).resolves.toBeUndefined();
  });

  it('reclaims a same-host lock automatically once its owner is proven dead', async () => {
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
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings).toEqual([expect.stringContaining('Removed stale batch lock')]);
      await recovered.release();
    } finally {
      kill.mockRestore();
    }
  });

  it('never reclaims a lock it cannot prove stale', async () => {
    const lockPath = path.join(directory, '.open-ocr.lock');
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      token: 'remote-token',
      pid: 1234,
      hostname: `${hostname()}-elsewhere`,
      startedAt: '2026-07-15T00:00:00.000Z',
    })}\n`);
    await expect(BatchOutputLock.acquire(directory)).rejects.toMatchObject({
      code: 'OUTPUT_CONFLICT',
      hint: expect.stringContaining(`then delete ${lockPath}`) as unknown,
    });

    await writeFile(lockPath, '{not-json');
    await expect(BatchOutputLock.acquire(directory)).rejects.toMatchObject({
      code: 'OUTPUT_CONFLICT',
      message: expect.stringContaining('owner metadata is invalid') as unknown,
    });
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
      model: 'gemini-3.8-flash',
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

describe('artifact path hardening', () => {
  it('rewrites names coding agents load as instructions', async () => {
    const { neutralizeAgentInstructionPath } = await import('./output');
    expect(neutralizeAgentInstructionPath([], 'CLAUDE')).toEqual(['CLAUDE.ocr']);
    expect(neutralizeAgentInstructionPath([], 'agents')).toEqual(['agents.ocr']);
    expect(neutralizeAgentInstructionPath(['.claude', 'commands'], 'deploy')).toEqual(['_claude', 'commands', 'deploy']);
    expect(neutralizeAgentInstructionPath(['docs', '.GitHub'], 'copilot-instructions'))
      .toEqual(['docs', '_GitHub', 'copilot-instructions.ocr']);
    expect(neutralizeAgentInstructionPath(['scans'], 'invoice')).toEqual(['scans', 'invoice']);
  });

  it('never starts a directory or file segment with a dot', async () => {
    const { neutralizeAgentInstructionPath } = await import('./output');
    expect(neutralizeAgentInstructionPath([], '.mcp')).toEqual(['_mcp']);
    expect(neutralizeAgentInstructionPath(['.devcontainer'], 'devcontainer')).toEqual(['_devcontainer', 'devcontainer']);
    expect(neutralizeAgentInstructionPath(['docs', '.vscode', '.config'], '.env')).toEqual(['docs', '_vscode', '_config', '_env']);
    // Both rules apply: the instruction name gains `.ocr`, then loses its dot.
    expect(neutralizeAgentInstructionPath([], '.cursorrules')).toEqual(['_cursorrules.ocr']);
    expect(neutralizeAgentInstructionPath(['a..b'], 'x.y')).toEqual(['a..b', 'x.y']);
  });

  it.each([
    ['.mcp.png', '_mcp'],
    ['.devcontainer/devcontainer.png', path.join('_devcontainer', 'devcontainer')],
    ['.github/workflows/ci.png', path.join('_github', 'workflows', 'ci')],
    ['scans/.hidden/.page.png', path.join('scans', '_hidden', '_page')],
  ])('writes %s without a hidden segment, consistently with planning', async (relativePath, expected) => {
    const hidden: ResolvedInput = {
      ...input, absolutePath: `/workspace/${relativePath}`, relativePath, displayPath: relativePath, name: path.basename(relativePath),
    };
    const planned = await plannedArtifactTargets(hidden, options, 2);
    const written = await writeArtifacts(hidden, artifacts, options, 2);
    // Planning lists the guaranteed artifacts; the optional CSV comes on top.
    expect(written.map((target) => target.path)).toEqual(expect.arrayContaining(planned.map((target) => target.path)));
    expect(planned.length).toBeGreaterThan(0);
    expect(written.map((target) => path.relative(directory, target.path))).toEqual(
      expect.arrayContaining([`${expected}.md`, `${expected}.json`]),
    );
    for (const target of written) {
      expect(path.relative(directory, target.path).split(path.sep).some((segment) => segment.startsWith('.'))).toBe(false);
    }
    await expect(fs.lstat(path.join(directory, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(directory, '.devcontainer'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-extracts a resumed entry whose recorded artifact has a hidden name from the old layout', async () => {
    const legacy = path.join(directory, '.mcp.json');
    const current = path.join(directory, '_mcp.json');
    await writeFile(legacy, '{}\n');
    await writeFile(current, '{}\n');
    const manifest = new ManifestStore(directory);
    await manifest.load();
    await manifest.update('/workspace/.mcp.png', {
      fingerprint: 'abc', status: 'succeeded', outputFiles: [legacy], completedAt: new Date().toISOString(),
    });
    await expect(manifest.completedEntry('/workspace/.mcp.png', 'abc')).resolves.toBeUndefined();
    // The old path stays owned, so the new write is not blocked by it.
    expect(manifest.recordedArtifactPaths('/workspace/.mcp.png').has(legacy)).toBe(true);

    await manifest.update('/workspace/.mcp.png', {
      fingerprint: 'abc', status: 'succeeded', outputFiles: [current], completedAt: new Date().toISOString(),
    });
    await expect(manifest.completedEntry('/workspace/.mcp.png', 'abc')).resolves.toMatchObject({ outputFiles: [current] });
  });
});

describe('artifact write containment', () => {
  it('refuses a write whose directory was swapped for a symbolic link out of the output directory', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'open-ocr-outside-'));
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(outside, path.join(directory, 'nested'));
      await expect(writeArtifacts(input, artifacts, options, 2)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates nothing outside the output directory through a symlinked intermediate directory', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'open-ocr-outside-'));
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(outside, path.join(directory, 'nested'));
      const deep: ResolvedInput = {
        ...input,
        absolutePath: '/workspace/nested/deeper/still/invoice.pdf',
        relativePath: 'nested/deeper/still/invoice.pdf',
        displayPath: 'nested/deeper/still/invoice.pdf',
      };
      const failure = await writeArtifacts(deep, artifacts, options, 2).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'OUTPUT_CONFLICT' });
      expect((failure as Error).message).toContain('resolves outside the output directory');
      // A recursive mkdir would have created outside/deeper/still before refusing.
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a path component that is a file, and follows a symlink that stays inside', async () => {
    const { symlink } = await import('node:fs/promises');
    await writeFile(path.join(directory, 'nested'), 'not a directory');
    const failure = await writeArtifacts(input, artifacts, options, 2).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'OUTPUT_CONFLICT' });
    expect((failure as Error).message).toContain('is not a directory');
    await rm(path.join(directory, 'nested'));
    await fs.mkdir(path.join(directory, 'real'));
    await symlink(path.join(directory, 'real'), path.join(directory, 'nested'));
    await writeArtifacts(input, artifacts, options, 2);
    expect((await fs.readdir(path.join(directory, 'real'))).sort()).toEqual(['invoice.csv', 'invoice.json', 'invoice.md']);
  });

  it('writes an input named CLAUDE.png as CLAUDE.ocr.md', async () => {
    const claude = { ...input, absolutePath: '/workspace/CLAUDE.png', relativePath: 'CLAUDE.png', displayPath: 'CLAUDE.png', name: 'CLAUDE.png' };
    const written = await writeArtifacts(claude, artifacts, options, 2);
    expect(written.map((target) => path.basename(target.path))).toContain('CLAUDE.ocr.md');
    expect(await fs.readdir(directory)).not.toContain('CLAUDE.md');
  });
});
