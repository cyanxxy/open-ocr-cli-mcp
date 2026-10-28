import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCliOptions } from './config';
import { describeDiscoverySkips, discoverInputSet } from './inputs';
import type { OcrJobEvent } from './protocol';
import { modeFingerprint, runBatch } from './runner';

const discoverInputs = async (...args: Parameters<typeof discoverInputSet>) =>
  (await discoverInputSet(...args)).inputs;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-runner-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('CLI batch runner', () => {
  it('fingerprints output behavior without invalidating resume for display-only progress', () => {
    const gemini = resolveCliOptions({ dryRun: true }, {}, directory);
    const kimi = resolveCliOptions({ dryRun: true, provider: 'kimi' }, {}, directory);
    const cloudflare = resolveCliOptions({
      dryRun: true,
      gateway: 'cloudflare',
      cloudflareAccountId: 'account',
      cloudflareGatewayId: 'gateway',
    }, {}, directory);
    const traceStandard = resolveCliOptions({
      dryRun: true, format: 'all', progress: 'standard',
    }, {}, directory);
    const traceDetailed = resolveCliOptions({
      dryRun: true, format: 'all', progress: 'detailed',
    }, {}, directory);

    expect(modeFingerprint(kimi)).not.toBe(modeFingerprint(gemini));
    expect(modeFingerprint(cloudflare)).not.toBe(modeFingerprint(gemini));
    expect(modeFingerprint(traceDetailed)).not.toBe(modeFingerprint(traceStandard));
  });

  it('validates every document in a credential-free dry run', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    const options = resolveCliOptions({ dryRun: true }, {}, directory);
    const inputs = await discoverInputs(['.'], options);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(),
      writeStdout: (text) => { stdout.push(text); },
      writeStderr: (text) => stderr.push(text),
    });
    expect(summary).toMatchObject({ total: 2, failed: 0, skipped: 2 });
    expect(summary.results.every((result) => result.skipReason === 'validated')).toBe(true);
    expect(summary.results.every((result) => result.plannedOutputFiles?.length === 1)).toBe(true);
    expect(summary.usage.requests).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('validated (dry run)');
    expect(stderr.join('')).toContain(path.join(directory, 'open-ocr-output', 'one.md'));
  });

  it('reports invalid documents individually during dry runs', async () => {
    await writeFile(path.join(directory, 'good.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'spoofed.jpg'), 'plain text');
    const options = resolveCliOptions({ dryRun: true, quiet: true, jsonl: true }, {}, directory);
    const inputs = await discoverInputs(['.'], options);
    const events: OcrJobEvent[] = [];
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(),
      eventSink: (event) => { events.push(event); },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    const terminal = events.filter((event) => event.type.startsWith('document.') && event.document);
    expect(terminal.map((event) => event.document?.status).sort()).toEqual(['failed', 'skipped']);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(JSON.stringify(events)).toContain('does not match its declared type');
  });

  it('still reports failures under --quiet when no --jsonl stream carries them', async () => {
    await writeFile(path.join(directory, 'good.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'spoofed.jpg'), 'plain text');
    const options = resolveCliOptions({ dryRun: true, quiet: true }, {}, directory);
    const inputs = await discoverInputs(['.'], options);
    const stderr: string[] = [];

    await runBatch(inputs, options, {
      abortController: new AbortController(),
      writeStdout: () => undefined,
      writeStderr: (text) => stderr.push(text),
    });

    // Only the failure is printed; the validated document stays quiet.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('spoofed.jpg');
    expect(stderr[0]).toContain('[INPUT_INVALID]');
    expect(stderr[0]).toContain('hint: ');

    const jsonlStderr: string[] = [];
    await runBatch(inputs, { ...options, jsonl: true }, {
      abortController: new AbortController(),
      eventSink: () => undefined,
      writeStdout: () => undefined,
      writeStderr: (text) => jsonlStderr.push(text),
    });
    expect(jsonlStderr).toEqual([]);
  });

  it('makes a failed document and a shrunken input set machine-readable in --jsonl', async () => {
    await writeFile(path.join(directory, 'good.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'spoofed.jpg'), 'plain text');
    await writeFile(path.join(directory, 'notes.md'), '# notes');
    const options = resolveCliOptions({ dryRun: true, quiet: true, jsonl: true }, {}, directory);
    const discovery = await discoverInputSet(['.'], options);
    const skipSummary = describeDiscoverySkips(discovery.skipped);
    if (!skipSummary) throw new Error('Expected discovery to pass over notes.md');
    const events: OcrJobEvent[] = [];

    await runBatch(discovery.inputs, options, {
      abortController: new AbortController(),
      eventSink: (event) => { events.push(event); },
      priorWarnings: [`Discovery: ${skipSummary}`],
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    // `extract --jsonl` speaks the protocol dialect: the failed document is a
    // typed `document.failed` event, not a CLI-native record.
    const failed = events.find((event) => event.type === 'document.failed');
    expect(failed?.document?.error).toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
    });
    // `skipped` counts documents that entered the pipeline, so notes.md can only
    // be accounted for by the warning that replays on the stream and lands in
    // the result.
    expect(events.map((event) => event.type).slice(0, 2)).toEqual(['run.started', 'run.warning']);
    expect(events[1].message).toContain('notes.md');
    const completed = events.at(-1);
    expect(completed?.type).toBe('run.completed');
    expect(completed?.result).toMatchObject({ total: 2, failed: 1, skipped: 1 });
    expect(completed?.result?.warnings).toEqual([`Discovery: ${skipSummary}`]);
  });

  it('ends a cancelled --jsonl batch with run.completed as its one terminal event', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    const options = resolveCliOptions({ dryRun: true, quiet: true, jsonl: true }, {}, directory);
    const inputs = await discoverInputs(['.'], options);
    const abortController = new AbortController();
    abortController.abort(new Error('Interrupted by SIGINT'));
    const events: OcrJobEvent[] = [];

    const summary = await runBatch(inputs, options, {
      abortController,
      eventSink: (event) => { events.push(event); },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    // Cancellation resolves into skipped documents and a normal return, so the
    // stream terminates in `run.completed` rather than a typed failure.
    expect(summary).toMatchObject({ total: 2, skipped: 2 });
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.filter((event) => event.type === 'run.completed' || event.type === 'run.failed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'document.skipped').map((event) => event.document?.skipReason))
      .toEqual(['cancelled', 'cancelled']);
  });

  it('emits no run.warning when nothing was passed over', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    const options = resolveCliOptions({ dryRun: true, quiet: true, jsonl: true }, {}, directory);
    const inputs = await discoverInputs(['.'], options);
    const events: OcrJobEvent[] = [];

    await runBatch(inputs, options, {
      abortController: new AbortController(),
      eventSink: (event) => { events.push(event); },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(events.map((event) => event.type)).not.toContain('run.warning');
    expect(events.at(-1)?.result?.warnings).toEqual([]);
  });
});
