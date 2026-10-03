import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExtractPresetWithProvider,
  mockExtractStructuredDataFromFile,
  mockExtractTextFromFile,
} = vi.hoisted(() => ({
  mockExtractPresetWithProvider: vi.fn(),
  mockExtractStructuredDataFromFile: vi.fn(),
  mockExtractTextFromFile: vi.fn(),
}));

vi.mock('@open-ocr/engine/gemini/extraction', () => ({
  extractStructuredDataFromFile: mockExtractStructuredDataFromFile,
  extractTextFromFile: mockExtractTextFromFile,
}));

// Partial mock: runner.ts pulls six other symbols out of this module, so a bare
// factory would break every neighbouring test in this file.
vi.mock('@open-ocr/engine/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@open-ocr/engine/providers')>()),
  extractPresetWithProvider: mockExtractPresetWithProvider,
}));

import { resolveCliOptions } from './config';
import { discoverInputSet } from './inputs';
import { runBatch } from './runner';
import { BatchOutputLock } from './output';
import { cliExitCode } from './errors';
import { toOcrRunResult, type OcrJobEvent } from './protocol';
import { recordGeminiUsage } from '@open-ocr/engine/gemini/usage';
import type { GeminiClientConfig } from '@open-ocr/engine/gemini/types';

const discoverInputs = async (...args: Parameters<typeof discoverInputSet>) =>
  (await discoverInputSet(...args)).inputs;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
let directory: string;
let outputDirectory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-live-runner-'));
  outputDirectory = path.join(directory, 'results');
  process.env.GEMINI_API_KEY = 'test-key';
  mockExtractTextFromFile.mockReset();
  mockExtractStructuredDataFromFile.mockReset();
  mockExtractTextFromFile.mockResolvedValue({
    title: 'Extracted document',
    sections: [{ content: ['Hello from OCR'] }],
  });
  mockExtractStructuredDataFromFile.mockResolvedValue({ invoice_number: 'INV-42', total: 12.5 });
  mockExtractPresetWithProvider.mockReset();
  mockExtractPresetWithProvider.mockResolvedValue({
    markdown: '# Invoice\n\n- Number: INV-42',
    json: { invoice_number: 'INV-42', rows: [{ description: 'Widget', line_total: '10.00' }] },
    csv: 'description,line_total\nWidget,10.00\n',
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
});

describe('CLI live batch orchestration', () => {
  it.each([
    { name: 'single input on stdout', count: 1, output: false, inline: true },
    { name: 'single input with output', count: 1, output: true, inline: false },
    { name: 'batch with default output', count: 2, output: false, inline: false },
  ])('delivers readable JSONL content for $name', async ({ count, output, inline }) => {
    for (let index = 0; index < count; index += 1) {
      await writeFile(path.join(directory, `${index}.jpg`), JPEG_BYTES);
    }
    const options = resolveCliOptions({
      jsonl: true,
      quiet: true,
      ...(output ? { output: outputDirectory } : {}),
    }, {}, directory);
    const inputs = await discoverInputs(['*.jpg'], options);
    const events: OcrJobEvent[] = [];
    const writeStdout = vi.fn();

    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(),
      eventSink: (event) => { events.push(event); },
      writeStdout,
      writeStderr: () => undefined,
    });

    expect(summary.succeeded).toBe(count);
    expect(writeStdout).not.toHaveBeenCalled();
    const completed = events.filter((event) => event.type === 'document.completed');
    expect(completed).toHaveLength(count);
    const final = events.at(-1);
    expect(final?.type).toBe('run.completed');
    expect(final?.result?.documents).toHaveLength(count);
    for (const event of completed) {
      const document = event.document!;
      const finalDocument = final?.result?.documents.find((item) => item.documentId === document.documentId);
      expect(finalDocument).toEqual(document);
      if (inline) {
        expect(document.content?.markdown).toContain('Hello from OCR');
        expect(document.artifacts).toEqual([]);
      } else {
        expect(document.content).toBeUndefined();
        expect(document.artifacts).toHaveLength(1);
        expect(await readFile(document.artifacts[0].path, 'utf8')).toContain('Hello from OCR');
      }
    }
    if (inline) expect(await readdir(directory)).toEqual(['0.jpg']);
  });

  it('rejects concurrent ownership before spending Gemini requests', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    const options = resolveCliOptions({ output: outputDirectory, quiet: true }, {}, directory);
    const inputs = await discoverInputs(['*.jpg'], options);
    const lock = await BatchOutputLock.acquire(outputDirectory);
    try {
      let thrown: unknown;
      try {
        await runBatch(inputs, options, {
          abortController: new AbortController(),
          writeStdout: () => undefined,
          writeStderr: () => undefined,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('Batch output directory is already in use');
      expect(cliExitCode(thrown)).toBe(2);
      expect(mockExtractTextFromFile).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });

  it('rejects existing non-resumable artifacts before spending Gemini requests', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'one.md'), 'existing output\n');
    const options = resolveCliOptions({ output: outputDirectory, quiet: true }, {}, directory);
    const inputs = await discoverInputs(['*.jpg'], options);

    let thrown: unknown;
    try {
      await runBatch(inputs, options, {
        abortController: new AbortController(),
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Output already exists before extraction');
    expect(cliExitCode(thrown)).toBe(2);
    expect(mockExtractTextFromFile).not.toHaveBeenCalled();
  });

  it('writes batch artifacts and resumes unchanged documents', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    const options = resolveCliOptions(
      { output: outputDirectory, quiet: true, concurrency: '2' },
      {},
      directory,
    );
    const inputs = await discoverInputs(['*.jpg'], options);

    const first = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(first).toMatchObject({ total: 2, succeeded: 2, partial: 0, failed: 0 });
    expect(first.results.every((result) => result.artifacts === undefined)).toBe(true);
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(outputDirectory, 'one.md'), 'utf8')).toContain('Hello from OCR');
    expect(await readFile(path.join(outputDirectory, 'batch-summary.json'), 'utf8')).toContain('"succeeded": 2');

    const second = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(second).toMatchObject({ succeeded: 0, skipped: 2, failed: 0 });
    expect(second.results.map((result) => result.outputFiles)).toEqual([
      [path.join(outputDirectory, 'one.md')],
      [path.join(outputDirectory, 'two.md')],
    ]);
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(2);
  });

  it('re-extracts partial outputs over their own artifacts instead of skipping them', async () => {
    await writeFile(path.join(directory, 'partial.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'second.jpg'), JPEG_BYTES);
    const options = resolveCliOptions({ output: outputDirectory, quiet: true }, {}, directory);
    const inputs = await discoverInputs(['*.jpg'], options);
    await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });

    const manifestPath = path.join(outputDirectory, '.open-ocr-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      entries: Record<string, { status: string }>;
    };
    for (const entry of Object.values(manifest.entries)) entry.status = 'partial';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const resumed = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    // A partial document produced less than the extraction asked for, so resume
    // re-runs it. Its own recorded artifacts are reclaimed rather than reported
    // as an output collision, which is what this batch is really guarding.
    expect(resumed).toMatchObject({ total: 2, succeeded: 2, failed: 0, skipped: 0 });
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(4);
  });

  it('validates every input during dry runs even when the resume manifest matches', async () => {
    await writeFile(path.join(directory, 'valid.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'other.jpg'), JPEG_BYTES);
    const options = resolveCliOptions({ output: outputDirectory, quiet: true }, {}, directory);
    const inputs = await discoverInputs(['*.jpg'], options);
    await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    await writeFile(inputs[0].absolutePath!, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));

    const dryRun = await runBatch(inputs, { ...options, dryRun: true }, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(dryRun).toMatchObject({ total: 2, failed: 1, skipped: 1 });
    expect(dryRun.results[0].error).toContain('does not match its declared type');
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(2);
  });

  it('represents the unscheduled fail-fast remainder explicitly', async () => {
    await writeFile(path.join(directory, 'a.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'b.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'c.jpg'), JPEG_BYTES);
    mockExtractTextFromFile.mockRejectedValue(new Error('invalid request'));
    const options = resolveCliOptions(
      { output: outputDirectory, quiet: true, concurrency: '1', retries: '0', failFast: true },
      {},
      directory,
    );
    const inputs = await discoverInputs(['*.jpg'], options);

    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(summary).toMatchObject({ total: 3, failed: 1, skipped: 2 });
    expect(summary.results).toHaveLength(3);
    expect(summary.results.slice(1).every((result) => (
      result.status === 'skipped'
      && result.attempts === 0
      && result.error?.includes('--fail-fast')
    ))).toBe(true);
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and records the true attempt count', async () => {
    await writeFile(path.join(directory, 'retry.jpg'), JPEG_BYTES);
    const transientError = Object.assign(new Error('rate limited'), { status: 429 });
    mockExtractTextFromFile.mockRejectedValueOnce(transientError).mockResolvedValueOnce({
      sections: [{ content: ['Recovered'] }],
    });
    const options = resolveCliOptions(
      { output: outputDirectory, quiet: true, retries: '1' },
      {},
      directory,
    );
    const inputs = await discoverInputs(['retry.jpg'], options);
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.results[0].attempts).toBe(2);
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(2);
  });

  it('extracts and writes caller-defined schema output', async () => {
    await writeFile(path.join(directory, 'schema.jpg'), JPEG_BYTES);
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { invoice_number: { type: 'string' }, total: { type: 'number' } },
      required: ['invoice_number', 'total'],
    };
    const options = {
      ...resolveCliOptions({ schema: 'invoice.schema.json', output: outputDirectory, quiet: true }, {}, directory),
      customSchema: schema,
    };
    const inputs = await discoverInputs(['schema.jpg'], options);
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(summary.succeeded).toBe(1);
    expect(mockExtractStructuredDataFromFile).toHaveBeenCalledWith(
      expect.any(String),
      'image/jpeg',
      expect.objectContaining({ model: 'gemini-3.8-flash' }),
      schema,
      undefined,
      expect.objectContaining({ maxTokens: 32768 }),
    );
    expect(await readFile(path.join(outputDirectory, 'schema.json'), 'utf8')).toContain('INV-42');
  });

  it('stops scheduling new documents when the estimated cost ceiling is reached', async () => {
    await writeFile(path.join(directory, 'a.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'b.jpg'), JPEG_BYTES);
    mockExtractTextFromFile.mockImplementation((
      _fileData: string,
      _mimeType: string,
      clientConfig: GeminiClientConfig,
    ) => {
      recordGeminiUsage({
        usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100, totalTokenCount: 1_100 },
      }, 'gemini-3.5-flash', clientConfig.runtime);
      return Promise.resolve({ sections: [{ content: ['Costed result'] }] });
    });
    const options = resolveCliOptions({
      output: outputDirectory,
      quiet: true,
      concurrency: '1',
      maxCost: '0.000001',
    }, {}, directory);
    const inputs = await discoverInputs(['*.jpg'], options);
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(summary).toMatchObject({ total: 2, succeeded: 1, skipped: 1, costLimitReached: true });
    expect(summary.usage.estimatedCostUsd).toBeGreaterThan(options.maxCostUsd!);
    expect(summary.results[1].error).toContain('--max-cost');
    expect(mockExtractTextFromFile).toHaveBeenCalledTimes(1);
  });

  it('runs template mode through the preset extractor and writes its CSV artifact', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const options = resolveCliOptions(
      { preset: 'invoice', format: 'all', output: outputDirectory, quiet: true },
      {},
      directory,
    );
    // A preset implies template mode, and only template mode can produce CSV.
    expect(options.mode).toBe('template');
    const inputs = await discoverInputs(['*.jpg'], options);

    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });

    expect(summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(mockExtractPresetWithProvider).toHaveBeenCalledTimes(1);
    // The preset itself is resolved and handed over, not the raw id.
    expect(mockExtractPresetWithProvider.mock.calls[0][4]).toMatchObject({ id: 'invoice' });
    // Simple-mode extraction must not run for a template document.
    expect(mockExtractTextFromFile).not.toHaveBeenCalled();

    expect(await readFile(path.join(outputDirectory, 'invoice.csv'), 'utf8')).toContain('Widget,10.00');
    expect(await readFile(path.join(outputDirectory, 'invoice.json'), 'utf8')).toContain('INV-42');
    expect(await readFile(path.join(outputDirectory, 'invoice.md'), 'utf8')).toContain('INV-42');
  });

  it('refuses CSV from a record-shaped preset before spending a request', () => {
    // `business-card` extracts one record, so it can never produce rows. The
    // refusal has to happen at option resolution, not after a billed call.
    expect(() => resolveCliOptions(
      { preset: 'business-card', format: 'csv', output: outputDirectory, quiet: true },
      {},
      directory,
    )).toThrow(/cannot produce CSV rows/u);
    expect(mockExtractPresetWithProvider).not.toHaveBeenCalled();
  });

  it('describes a single-file artifact by what was written, not by its filename', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    const target = path.join(directory, 'report.json');
    // Naming the output `.json` while asking for markdown is legal — the caller
    // owns the filename. What must not happen is the result claiming the file
    // holds JSON, which would send an agent to JSON.parse a Markdown body.
    const options = resolveCliOptions(
      { format: 'markdown', output: target, quiet: true },
      {},
      directory,
    );
    const inputs = await discoverInputs(['*.jpg'], options);
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });

    expect(await readFile(target, 'utf8')).toContain('Hello from OCR');
    const result = toOcrRunResult('run-1', summary, 'reference');
    expect(result.documents[0].artifacts).toEqual([
      { path: target, mediaType: 'text/markdown', kind: 'markdown' },
    ]);
  });
});
