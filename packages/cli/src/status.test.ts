import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliExitError } from './errors';
import { inspectBatchStatus, renderBatchStatus } from './status';
import { BatchOutputLock } from './output';

let directory: string;

const usage = {
  requests: 2,
  inputTokens: 100,
  outputTokens: 20,
  thoughtTokens: 0,
  toolTokens: 0,
  cachedTokens: 0,
  totalTokens: 120,
  estimatedCostUsd: 0.001,
};

interface SummaryResult {
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  skipReason?: 'validated' | 'resumed' | 'cancelled' | 'cost-limit' | 'fail-fast';
}

function batchSummary(results: SummaryResult[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:01:00.000Z',
    durationMs: 60_000,
    total: results.length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    partial: results.filter((result) => result.status === 'partial').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    mode: 'simple',
    // Required: every summary the CLI writes carries the provider route, and
    // status no longer guesses gemini/direct when it is absent.
    provider: 'gemini',
    gateway: 'direct',
    model: 'gemini-3.5-flash',
    usage,
    costLimitReached: false,
    results,
    ...overrides,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-status-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('CLI batch status', () => {
  it('audits manifest artifacts and renders actionable failures', async () => {
    const source = path.join(directory, 'invoice.pdf');
    const presentOutput = path.join(directory, 'invoice.md');
    const missingOutput = path.join(directory, 'invoice.json');
    await writeFile(source, '%PDF');
    await writeFile(presentOutput, '# Invoice');
    await writeFile(path.join(directory, '.open-ocr-manifest.json'), JSON.stringify({
      version: 1,
      entries: {
        [source]: {
          fingerprint: 'abc',
          status: 'partial',
          outputFiles: [presentOutput, missingOutput],
          completedAt: '2026-07-15T00:00:00.000Z',
          error: 'confidence threshold not reached',
        },
      },
    }));

    const report = await inspectBatchStatus('.', directory);
    expect(report).toMatchObject({
      healthy: false,
      counts: { total: 1, partial: 1, failed: 0, missingArtifacts: 1, missingSources: 0 },
    });
    expect(report.entries[0].missingOutputFiles).toEqual([missingOutput]);
    expect(renderBatchStatus(report)).toContain('attention required');
    expect(renderBatchStatus(report)).toContain('confidence threshold not reached');
  });

  it('uses the summary when no manifest is available', async () => {
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(batchSummary([
      { status: 'succeeded' },
      { status: 'succeeded' },
    ])));
    const report = await inspectBatchStatus('.', directory);
    expect(report).toMatchObject({ healthy: true, summaryPresent: true, manifestPresent: false });
    expect(renderBatchStatus(report)).toContain('120 tokens');
    expect(renderBatchStatus(report)).toContain('gemini/gemini-3.5-flash via direct');
  });

  it('reports a directory at an artifact path as missing output', async () => {
    const outputFile = path.join(directory, 'invoice.md');
    await mkdir(outputFile);
    await writeFile(path.join(directory, '.open-ocr-manifest.json'), JSON.stringify({
      version: 1,
      entries: {
        '<stdin>': {
          fingerprint: 'abc',
          status: 'succeeded',
          outputFiles: [outputFile],
          completedAt: '2026-07-15T00:00:00.000Z',
        },
      },
    }));
    const report = await inspectBatchStatus('.', directory);
    expect(report.healthy).toBe(false);
    expect(report.counts.missingArtifacts).toBe(1);
    expect(report.entries[0].missingOutputFiles).toEqual([outputFile]);
  });

  it('reports the provider and gateway for provider-neutral summaries', async () => {
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(batchSummary([
      { status: 'succeeded' },
    ], {
      provider: 'openrouter',
      gateway: 'cloudflare',
      model: 'moonshotai/kimi-k2.6',
    })));
    const report = await inspectBatchStatus('.', directory);
    expect(report.lastRun).toMatchObject({
      provider: 'openrouter',
      gateway: 'cloudflare',
      model: 'moonshotai/kimi-k2.6',
    });
    expect(renderBatchStatus(report)).toContain('openrouter/moonshotai/kimi-k2.6 via cloudflare');
  });

  it('prefers last-run totals and marks cost-limited batches unhealthy', async () => {
    const source = path.join(directory, 'invoice.pdf');
    const output = path.join(directory, 'invoice.md');
    await writeFile(source, '%PDF');
    await writeFile(output, '# Invoice');
    await writeFile(path.join(directory, '.open-ocr-manifest.json'), JSON.stringify({
      version: 1,
      entries: {
        [source]: {
          fingerprint: 'abc',
          status: 'succeeded',
          outputFiles: [output],
          completedAt: '2026-07-15T00:00:30.000Z',
        },
      },
    }));
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(batchSummary([
      { status: 'succeeded' },
      { status: 'skipped', skipReason: 'cost-limit' },
    ], { costLimitReached: true })));

    const report = await inspectBatchStatus('.', directory);
    expect(report).toMatchObject({
      healthy: false,
      counts: { total: 2, succeeded: 1, failed: 0, skipped: 1 },
      lastRun: { costLimitReached: true, incomplete: true },
    });
    expect(renderBatchStatus(report)).toContain('stopped at its estimated cost limit');
  });

  it('treats a clean all-resumed run as healthy', async () => {
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(batchSummary([
      { status: 'skipped', skipReason: 'resumed' },
      { status: 'skipped', skipReason: 'resumed' },
    ])));
    const report = await inspectBatchStatus('.', directory);
    expect(report).toMatchObject({
      healthy: true,
      counts: { total: 2, succeeded: 0, skipped: 2 },
      lastRun: { incomplete: false },
    });
  });

  it('reports archived sources as drift without failing healthy artifacts', async () => {
    const source = path.join(directory, 'archived.pdf');
    const output = path.join(directory, 'archived.md');
    await writeFile(output, '# Preserved output');
    await writeFile(path.join(directory, '.open-ocr-manifest.json'), JSON.stringify({
      version: 1,
      entries: {
        [source]: {
          fingerprint: 'abc',
          status: 'succeeded',
          outputFiles: [output],
          completedAt: '2026-07-15T00:00:00.000Z',
        },
      },
    }));

    const report = await inspectBatchStatus('.', directory);
    expect(report).toMatchObject({
      healthy: true,
      sourceDrift: true,
      counts: { missingSources: 1, missingArtifacts: 0 },
    });
    expect(renderBatchStatus(report)).toContain('Source drift (artifacts remain auditable)');
    expect(renderBatchStatus(report)).toContain('Status: healthy');
  });

  it('reports an owned output directory as in progress instead of healthy', async () => {
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(batchSummary([
      { status: 'succeeded' },
    ])));
    const lock = await BatchOutputLock.acquire(directory);
    try {
      const report = await inspectBatchStatus('.', directory);
      expect(report).toMatchObject({
        healthy: false,
        activeLock: { ownerValid: true, pid: process.pid },
      });
      expect(renderBatchStatus(report)).toContain('Status: batch in progress or stale lock');
    } finally {
      await lock.release();
    }
  });

  it('rejects summaries missing health-critical fields', async () => {
    const invalid = batchSummary([{ status: 'succeeded' }]);
    delete invalid.costLimitReached;
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(invalid));
    await expect(inspectBatchStatus('.', directory)).rejects.toThrow('Invalid batch summary');
  });

  it('rejects impossible accounting and unsupported execution metadata', async () => {
    const invalidUsage = batchSummary([{ status: 'succeeded' }]);
    invalidUsage.usage = { ...usage, totalTokens: -1 };
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(invalidUsage));
    await expect(inspectBatchStatus('.', directory)).rejects.toThrow('Invalid batch summary');

    const invalidModel = batchSummary([{ status: 'succeeded' }], { provider: 'gemini', model: 'unknown-model' });
    await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(invalidModel));
    await expect(inspectBatchStatus('.', directory)).rejects.toThrow('Invalid batch summary');
  });

  it('rejects directories without batch metadata', async () => {
    await expect(inspectBatchStatus('.', directory)).rejects.toThrow('No Open OCR batch metadata');
  });

  it.each([
    [
      'a 2.x summary that predates the required provider metadata',
      async () => {
        const legacy = batchSummary([{ status: 'succeeded' }]);
        delete legacy.provider;
        delete legacy.gateway;
        await writeFile(path.join(directory, 'batch-summary.json'), JSON.stringify(legacy));
      },
    ],
    [
      'a summary that is not JSON',
      async () => { await writeFile(path.join(directory, 'batch-summary.json'), 'not json'); },
    ],
    [
      'a summary that is not an object',
      async () => { await writeFile(path.join(directory, 'batch-summary.json'), '[]'); },
    ],
    [
      'a manifest entry with an unknown status',
      async () => {
        await writeFile(path.join(directory, '.open-ocr-manifest.json'), JSON.stringify({
          version: 1,
          entries: {
            '/a/b.png': {
              fingerprint: 'x',
              status: 'bogus',
              completedAt: '2026-01-01T00:00:00.000Z',
              outputFiles: ['/a/b.md'],
            },
          },
        }));
      },
    ],
  ])('reports %s as unreadable batch metadata, not a flag problem', async (_label, seed) => {
    await seed();
    // The taxonomy is what an agent acts on: this is a stale or foreign
    // directory, so the recovery is a fresh output directory. Classifying it as
    // CONFIG_INVALID sent the caller to re-read their own flags, which cannot
    // fix a file on disk.
    const error = await inspectBatchStatus('.', directory).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CliExitError);
    expect(error).toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
      exitCode: 2,
    });
    expect((error as CliExitError).hint).toContain('fresh output directory');
  });
});
