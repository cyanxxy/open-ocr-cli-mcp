import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliOptions } from './config';
import { describeDiscoverySkips, discoverInputSet, inputFingerprint } from './inputs';
import { modeFingerprint, OcrJobService, type OcrDocumentExtractor } from './ocrJobService';
import {
  BatchOutputLock,
  MANIFEST_FLUSH_INTERVAL_MS,
  ManifestStore,
  processStartIdentity,
  recoverStaleTransactionFiles,
} from './output';
import { inspectBatchStatus, renderBatchStatus } from './status';
import type { ManifestEntry, ResolvedCliOptions } from './types';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
const TX = '4242-0f8fad5b-d9cb-469f-a165-70867728950e';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-reliability-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function batchOptions(flags: Record<string, unknown> = {}): ResolvedCliOptions {
  return {
    ...resolveCliOptions({ output: path.join(directory, 'out'), concurrency: '1', ...flags }, {}, directory),
    apiKey: 'test-key',
    quiet: true,
  };
}

async function seedDocs(names: string[]): Promise<string> {
  const docs = path.join(directory, 'docs');
  await mkdir(docs, { recursive: true });
  for (const name of names) await writeFile(path.join(docs, name), JPEG_BYTES);
  return docs;
}

const markdownExtractor = (): ReturnType<typeof vi.fn<OcrDocumentExtractor>> => (
  vi.fn<OcrDocumentExtractor>((input) => Promise.resolve({
    artifacts: { markdown: `# ${input.name}`, json: { name: input.name } },
    attempts: 1,
  }))
);

async function run(
  service: OcrJobService,
  inputs: string[],
  options: ResolvedCliOptions,
  warnings: string[] = [],
) {
  const discovery = await discoverInputSet(inputs, options);
  return service.run(discovery.inputs, options, {
    runId: `run-${Math.random()}`,
    abortController: new AbortController(),
    onWarning: (message) => warnings.push(message),
  });
}

describe('crash-safe resume', () => {
  it('recovers a batch killed between the artifact commit and the manifest update', async () => {
    const docs = await seedDocs(['a.jpg', 'b.jpg']);
    const options = batchOptions();
    const out = path.join(directory, 'out');
    const extractDocument = markdownExtractor();
    const service = new OcrJobService({ extractDocument });

    // Simulate SIGKILL right after b's artifacts are committed: its final
    // manifest update never lands.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound via call() below
    const original = ManifestStore.prototype.update;
    vi.spyOn(ManifestStore.prototype, 'update').mockImplementation(function (this: ManifestStore, key, entry) {
      if (key.endsWith('b.jpg') && entry.status !== 'pending') throw new Error('killed');
      return original.call(this, key, entry);
    });
    await expect(run(service, [docs], options)).rejects.toThrow('killed');
    vi.restoreAllMocks();

    const killedArtifact = path.join(out, 'docs', 'b.md');
    await expect(stat(killedArtifact)).resolves.toBeDefined();
    // A kill mid-commit also leaves staging and backup names behind.
    await writeFile(`${killedArtifact}.${TX}.tmp`, 'partial');
    await writeFile(path.join(out, `.open-ocr-manifest.json.${TX}.tmp`), '{');
    const before = await inspectBatchStatus(out, directory);
    expect(before.counts.interrupted).toBe(1);
    expect(before.strayTempFiles).toHaveLength(2);
    expect(before.untrackedArtifacts).toEqual([]);

    // A dry run must not reject the directory either.
    const dry = await run(service, [docs], { ...options, dryRun: true });
    expect(dry.summary.failed).toBe(0);

    const warnings: string[] = [];
    const resumed = await run(service, [docs], options, warnings);
    expect(resumed.summary.results.map((result) => [result.input.name, result.status, result.skipReason]))
      .toEqual([['a.jpg', 'skipped', 'resumed'], ['b.jpg', 'succeeded', undefined]]);
    expect(warnings.some((warning) => warning.includes('Recovered an interrupted run'))).toBe(true);
    const after = await inspectBatchStatus(out, directory);
    expect(after).toMatchObject({ healthy: true, strayTempFiles: [], untrackedArtifacts: [] });
  });

  it('claims every document durably before extracting, then writes the manifest O(1) times, not twice per document', async () => {
    const names = Array.from({ length: 60 }, (_, index) => `p${index}.jpg`);
    const docs = await seedDocs(names);
    const out = path.join(directory, 'out');
    const manifestPath = path.join(out, '.open-ocr-manifest.json');
    const claimsOnDiskAtFirstExtraction: string[] = [];
    let first = true;
    const extractDocument = vi.fn<OcrDocumentExtractor>(async (input) => {
      if (first) {
        first = false;
        const onDisk = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: Record<string, ManifestEntry> };
        claimsOnDiskAtFirstExtraction.push(...Object.values(onDisk.entries).map((entry) => entry.status));
      }
      return { artifacts: { markdown: `# ${input.name}`, json: { name: input.name } }, attempts: 1 };
    });
    const { promises: fsPromises } = await import('node:fs');
    const rename = vi.spyOn(fsPromises, 'rename');
    const execution = await run(new OcrJobService({ extractDocument }), [docs], batchOptions({ concurrency: '4' }));
    const manifestWrites = rename.mock.calls.filter(([, to]) => String(to) === manifestPath).length;
    expect(execution.summary.succeeded).toBe(60);
    // The pending-before-artifacts invariant: every document is claimed on
    // disk before the first one is even extracted.
    expect(claimsOnDiskAtFirstExtraction).toEqual(names.map(() => 'pending'));
    // One claim write, the final flush, and at most a few interval flushes.
    expect(manifestWrites).toBeLessThanOrEqual(4);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: Record<string, ManifestEntry> };
    expect(Object.values(manifest.entries).map((entry) => entry.status)).toEqual(names.map(() => 'succeeded'));
  });

  it('flushes finished documents within the bounded interval while the batch is still running', async () => {
    const docs = await seedDocs(['a.jpg', 'b.jpg']);
    const out = path.join(directory, 'out');
    let statusOfAWhileBRuns: string | undefined;
    const extractDocument = vi.fn<OcrDocumentExtractor>(async (input) => {
      if (input.name === 'b.jpg') {
        await new Promise((resolve) => setTimeout(resolve, MANIFEST_FLUSH_INTERVAL_MS + 400));
        const onDisk = JSON.parse(await readFile(path.join(out, '.open-ocr-manifest.json'), 'utf8')) as {
          entries: Record<string, ManifestEntry>;
        };
        statusOfAWhileBRuns = Object.entries(onDisk.entries).find(([key]) => key.endsWith('a.jpg'))?.[1].status;
      }
      return { artifacts: { markdown: `# ${input.name}`, json: { name: input.name } }, attempts: 1 };
    });
    await run(new OcrJobService({ extractDocument }), [docs], batchOptions());
    expect(statusOfAWhileBRuns).toBe('succeeded');
  });

  it('withdraws the claims of documents a run never started', async () => {
    const docs = await seedDocs(['a.jpg', 'b.jpg', 'c.jpg']);
    const out = path.join(directory, 'out');
    const extractDocument = vi.fn<OcrDocumentExtractor>(() => Promise.reject(new Error('provider down')));
    const execution = await run(new OcrJobService({ extractDocument }), [docs], batchOptions({ failFast: true }));
    expect(extractDocument).toHaveBeenCalledOnce();
    expect(execution.summary.failed + execution.summary.skipped).toBe(3);
    const manifest = JSON.parse(await readFile(path.join(out, '.open-ocr-manifest.json'), 'utf8')) as {
      entries: Record<string, ManifestEntry>;
    };
    expect(Object.values(manifest.entries).map((entry) => entry.status)).toEqual(['failed']);
    expect((await inspectBatchStatus(out, directory)).counts.interrupted).toBe(0);
  });

  it('restores an artifact a kill left moved aside as a .bak', async () => {
    const target = path.join(directory, 'doc.md');
    await writeFile(`${target}.${TX}.bak`, '# previous');
    await writeFile(`${target}.${TX}.tmp`, '# half-written');
    const recovered = await recoverStaleTransactionFiles([target]);
    expect(recovered.restored).toEqual([target]);
    expect(recovered.removed).toEqual([`${target}.${TX}.tmp`]);
    await expect(readFile(target, 'utf8')).resolves.toBe('# previous');
  });

  it('cleans up leftovers whose embedded PID is alive but was reused, and status turns healthy', async () => {
    const docs = await seedDocs(['a.jpg']);
    const options = batchOptions();
    const out = path.join(directory, 'out');
    const service = new OcrJobService({ extractDocument: markdownExtractor() });
    expect((await run(service, [docs], options)).summary.succeeded).toBe(1);

    // A live PID that is not the writer: this test's parent process.
    const reused = `${process.ppid}-0f8fad5b-d9cb-469f-a165-70867728950e`;
    const artifact = path.join(out, 'docs', 'a.md');
    await writeFile(`${artifact}.${reused}.tmp`, 'partial');
    await writeFile(path.join(out, `.open-ocr-manifest.json.${reused}.tmp`), '{');
    const before = await inspectBatchStatus(out, directory);
    expect(before.strayTempFiles).toHaveLength(2);
    expect(renderBatchStatus(before)).toContain('the next extract into this directory cleans them up');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const warnings: string[] = [];
    await run(service, [docs], options, warnings);
    expect(warnings.some((warning) => warning.includes('removed 2 stale staging file(s)'))).toBe(true);
    const after = await inspectBatchStatus(out, directory);
    expect(after).toMatchObject({ healthy: true, strayTempFiles: [] });
  });

  it('keeps a live PID\'s transaction file touched after the lock was taken', async () => {
    const target = path.join(directory, '.open-ocr.lock');
    const staging = `${target}.${process.ppid}-0f8fad5b-d9cb-469f-a165-70867728950e.tmp`;
    await writeFile(staging, '{}');
    const touched = (await stat(staging)).mtimeMs;
    const kept = await recoverStaleTransactionFiles([target], { lockAcquiredAtMs: touched });
    expect(kept.removed).toEqual([]);
    const removed = await recoverStaleTransactionFiles([target], { lockAcquiredAtMs: touched + 1_000 });
    expect(removed.removed).toEqual([staging]);
  });

  it('recognises its own artifacts across a markdown -> json -> markdown format switch', async () => {
    const docs = await seedDocs(['c1.jpg']);
    const service = new OcrJobService({ extractDocument: markdownExtractor() });
    for (const format of ['markdown', 'json', 'markdown'] as const) {
      const execution = await run(service, [docs], batchOptions({ format }));
      expect(execution.summary.succeeded).toBe(1);
    }
    const manifest = JSON.parse(await readFile(path.join(directory, 'out', '.open-ocr-manifest.json'), 'utf8')) as {
      entries: Record<string, ManifestEntry>;
    };
    const entry = Object.values(manifest.entries)[0];
    expect(entry.ownedFiles?.map((file) => path.basename(file)).sort()).toEqual(['c1.json', 'c1.md']);
  });

  it('re-extracts content that changed while size and mtime stayed the same', async () => {
    const docs = await seedDocs(['same.jpg']);
    const file = path.join(docs, 'same.jpg');
    const extractDocument = markdownExtractor();
    const service = new OcrJobService({ extractDocument });
    await run(service, [docs], batchOptions());
    const { mtime } = await stat(file);
    await writeFile(file, Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9, 9]));
    await utimes(file, mtime, mtime);
    const second = await run(service, [docs], batchOptions());
    expect(second.summary.succeeded).toBe(1);
    expect(extractDocument).toHaveBeenCalledTimes(2);
    // A touch that changes nothing is not re-billed.
    await utimes(file, new Date(), new Date());
    const third = await run(service, [docs], batchOptions());
    expect(third.summary.results[0].skipReason).toBe('resumed');
  });

  it('accepts and upgrades a legacy size/mtime fingerprint once', async () => {
    const docs = await seedDocs(['old.jpg']);
    const options = batchOptions();
    const [input] = (await discoverInputSet([docs], options)).inputs;
    const out = path.join(directory, 'out');
    const artifact = path.join(out, 'docs', 'old.md');
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, '# old');
    await writeFile(path.join(out, '.open-ocr-manifest.json'), JSON.stringify({
      version: 1,
      entries: {
        [input.absolutePath!]: {
          fingerprint: inputFingerprint(input, modeFingerprint(options)),
          status: 'succeeded',
          outputFiles: [artifact],
          completedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }));
    const extractDocument = markdownExtractor();
    const execution = await run(new OcrJobService({ extractDocument }), [docs], options);
    expect(execution.summary.results[0].skipReason).toBe('resumed');
    expect(extractDocument).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(path.join(out, '.open-ocr-manifest.json'), 'utf8')) as {
      entries: Record<string, ManifestEntry>;
    };
    expect(manifest.entries[input.absolutePath!].fingerprintVersion).toBe(2);
  });

  it('points --no-resume conflicts at --overwrite or a new output, not at resuming', async () => {
    const docs = await seedDocs(['x.jpg']);
    const service = new OcrJobService({ extractDocument: markdownExtractor() });
    await run(service, [docs], batchOptions());
    const failure = await run(service, [docs], batchOptions({ resume: false })).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'OUTPUT_CONFLICT' });
    const hint = (failure as { hint?: string }).hint ?? '';
    expect(hint).toContain('--overwrite');
    expect(hint).toContain('--output');
    expect(hint).not.toContain('resume a matching job');
  });
});

describe('spend accounting across runs', () => {
  const costing = (cost: number) => vi.fn<OcrDocumentExtractor>((input, _options, _signal, _step, runtime) => {
    runtime.recordUsage({ usage: { input_tokens: 1, total_tokens: 1, cost } });
    return Promise.resolve({ artifacts: { markdown: `# ${input.name}` }, attempts: 1 });
  });

  it('enforces --max-cost against spend recorded by earlier runs of the same output directory', async () => {
    const docs = await seedDocs(['one.jpg']);
    const extractDocument = costing(0.01);
    const service = new OcrJobService({ extractDocument });
    const first = await run(service, [docs], batchOptions({ maxCost: '0.01' }));
    expect(first.summary).toMatchObject({ succeeded: 1, costLimitReached: false });

    await writeFile(path.join(docs, 'two.jpg'), JPEG_BYTES);
    const warnings: string[] = [];
    const second = await run(service, [docs], batchOptions({ maxCost: '0.01' }), warnings);
    expect(extractDocument).toHaveBeenCalledOnce();
    expect(second.summary.results.map((result) => [result.input.name, result.skipReason])).toEqual([
      ['one.jpg', 'resumed'],
      ['two.jpg', 'cost-limit'],
    ]);
    expect(second.summary.costLimitReached).toBe(true);
    expect(second.summary.cumulativeUsage?.estimatedCostUsd).toBeCloseTo(0.01);
    expect(warnings.join('\n')).toContain('across earlier runs');
    expect(second.summary.results[1].errorDetails?.hint).toContain('every resumed run');

    const report = await inspectBatchStatus(path.join(directory, 'out'), directory);
    expect(report.cumulativeUsage?.estimatedCostUsd).toBeCloseTo(0.01);
    expect(report.lastRun?.usage.estimatedCostUsd).toBe(0);
  });

  it('stops paid work when a priced provider returns no usage under --max-cost', async () => {
    const docs = await seedDocs(['p1.jpg', 'p2.jpg']);
    const extractDocument = vi.fn<OcrDocumentExtractor>((input, _options, _signal, _step, runtime) => {
      runtime.recordUsage({}, {
        provider: 'openai-compatible', model: 'm', inputPricePerMillionUsd: 1, outputPricePerMillionUsd: 2,
      });
      return Promise.resolve({ artifacts: { markdown: `# ${input.name}` }, attempts: 1 });
    });
    const warnings: string[] = [];
    const execution = await run(new OcrJobService({ extractDocument }), [docs], batchOptions({ maxCost: '5' }), warnings);
    expect(extractDocument).toHaveBeenCalledOnce();
    expect(execution.summary).toMatchObject({ succeeded: 1, skipped: 1, costLimitReached: true });
    expect(execution.summary.usage.unreportedUsageRequests).toBe(1);
    expect(execution.result.usage.unreportedUsageRequests).toBe(1);
    expect(warnings.join('\n')).toContain('fail closed');
  });
});

describe('input discovery', () => {
  it('applies cwd-relative excludes to directory scans and warns about excludes that matched nothing', async () => {
    const docs = await seedDocs(['keep.jpg']);
    await mkdir(path.join(docs, 'drafts'), { recursive: true });
    await writeFile(path.join(docs, 'drafts', 'skip.jpg'), JPEG_BYTES);
    const options = batchOptions();
    const cwdRelative = await discoverInputSet([docs], { ...options, excludes: ['docs/drafts/**', 'nothing/**'] });
    expect(cwdRelative.inputs.map((input) => input.name)).toEqual(['keep.jpg']);
    expect(cwdRelative.skipped.unmatchedExcludes).toEqual(['nothing/**']);
    expect(describeDiscoverySkips(cwdRelative.skipped)).toContain('--exclude pattern(s) matched nothing: nothing/**');
    // The scan-root-relative form keeps working.
    const rootRelative = await discoverInputSet([docs], { ...options, excludes: ['drafts/**'] });
    expect(rootRelative.inputs.map((input) => input.name)).toEqual(['keep.jpg']);
    expect(rootRelative.skipped.unmatchedExcludes).toBeUndefined();
    // And so does a glob input with the same cwd-relative pattern.
    const glob = await discoverInputSet(['docs/**/*.jpg'], { ...options, excludes: ['docs/drafts/**'] });
    expect(glob.inputs.map((input) => input.name)).toEqual(['keep.jpg']);
  });

  it.each(['scans{a,b}', 'scans[1]', 'scans(2)', 'a{b}[c](d)!+@'])(
    'applies a cwd-relative exclude when the working directory has glob characters (%s)',
    async (name) => {
      const cwd = path.join(directory, name);
      await mkdir(path.join(cwd, 'docs', 'drafts'), { recursive: true });
      await writeFile(path.join(cwd, 'docs', 'keep.jpg'), JPEG_BYTES);
      await writeFile(path.join(cwd, 'docs', 'drafts', 'skip.jpg'), JPEG_BYTES);
      const options = {
        ...resolveCliOptions({ output: path.join(cwd, 'out'), exclude: ['docs/drafts/**'] }, {}, cwd),
        apiKey: 'test-key',
      };
      const scan = await discoverInputSet(['docs'], options);
      expect(scan.inputs.map((input) => input.name)).toEqual(['keep.jpg']);
      expect(scan.skipped.unmatchedExcludes).toBeUndefined();
    },
  );

  it('reports only command-line excludes that matched nothing, and only after a walk', async () => {
    const docs = await seedDocs(['keep.jpg']);
    const resolve = (flags: Record<string, unknown>, config: Record<string, unknown>): ResolvedCliOptions => ({
      ...resolveCliOptions({ output: path.join(directory, 'out'), ...flags }, config, directory),
      apiKey: 'test-key',
    });
    // Config-file excludes are ambient: never reported, even after a walk.
    const fromConfig = await discoverInputSet([docs], resolve({}, { exclude: ['nothing/**'] }));
    expect(fromConfig.skipped.unmatchedExcludes).toBeUndefined();
    // A single named file never consults excludes, so nothing is reported.
    const singleFile = await discoverInputSet(
      [path.join(docs, 'keep.jpg')],
      resolve({ exclude: ['flagged/**'] }, { exclude: ['nothing/**'] }),
    );
    expect(singleFile.skipped.unmatchedExcludes).toBeUndefined();
    expect(describeDiscoverySkips(singleFile.skipped)).toBeUndefined();
    // A directory scan reports the command-line pattern, not the config one.
    const scan = await discoverInputSet([docs], resolve({ exclude: ['flagged/**'] }, { exclude: ['nothing/**'] }));
    expect(scan.skipped.unmatchedExcludes).toEqual(['flagged/**']);
    // A pattern given both ways counts as given on the command line.
    const both = await discoverInputSet([docs], resolve({ exclude: ['nothing/**'] }, { exclude: ['nothing/**'] }));
    expect(both.skipped.unmatchedExcludes).toEqual(['nothing/**']);
    // A glob walk counts as a walk.
    const glob = await discoverInputSet(['docs/*.jpg'], resolve({ exclude: ['flagged/**'] }, {}));
    expect(glob.skipped.unmatchedExcludes).toEqual(['flagged/**']);
  });

  it('extracts a symlink and its target once', async () => {
    const docs = await seedDocs(['real.jpg']);
    await symlink(path.join(docs, 'real.jpg'), path.join(directory, 'link.jpg'));
    const discovery = await discoverInputSet([path.join(docs, 'real.jpg'), path.join(directory, 'link.jpg')], batchOptions());
    expect(discovery.inputs).toHaveLength(1);
    expect(discovery.skipped.duplicates?.count).toBe(1);
    expect(describeDiscoverySkips(discovery.skipped)).toContain('duplicate input(s) skipped');
  });
});

describe('batch lock ownership', () => {
  it('reclaims a lock whose PID is alive but belongs to a different process', async () => {
    if (processStartIdentity(1) === undefined) return;
    await writeFile(path.join(directory, '.open-ocr.lock'), JSON.stringify({
      version: 1,
      token: 'reused',
      pid: 1,
      hostname: (await import('node:os')).hostname(),
      startedAt: '2026-01-01T00:00:00.000Z',
      processStart: 'linux:another-boot:1',
    }));
    const warnings: string[] = [];
    const lock = await BatchOutputLock.acquire(directory, { onWarning: (message) => warnings.push(message) });
    expect(warnings[0]).toContain('reused PID 1');
    await lock.release();
  });

  it('gives racing reclaimers of one stale lock a clean conflict, never ENOENT', async () => {
    const { hostname } = await import('node:os');
    for (let round = 0; round < 10; round += 1) {
      const lockDirectory = path.join(directory, `race-${round}`);
      await mkdir(lockDirectory);
      await writeFile(path.join(lockDirectory, '.open-ocr.lock'), JSON.stringify({
        version: 1,
        token: `dead-${round}`,
        pid: 2 ** 22 + 12_345,
        hostname: hostname(),
        startedAt: '2026-01-01T00:00:00.000Z',
      }));
      const outcomes = await Promise.allSettled([
        BatchOutputLock.acquire(lockDirectory),
        BatchOutputLock.acquire(lockDirectory),
        BatchOutputLock.acquire(lockDirectory),
      ]);
      const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'OUTPUT_CONFLICT' });
      }
      const winner = winners[0];
      if (winner?.status === 'fulfilled') await winner.value.release();
    }
  });
});
