import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ocrErrorPayload } from './errors';
import { executeOcrJobRequest, readOcrJobRequest, readStandardInput } from './machine';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
const originalNoConfig = process.env.OPEN_OCR_NO_CONFIG;
const originalProvider = process.env.OPEN_OCR_PROVIDER;
const originalApiKey = process.env.GEMINI_API_KEY;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-machine-'));
  delete process.env.OPEN_OCR_PROVIDER;
  process.env.GEMINI_API_KEY = 'test-key';
});

afterEach(async () => {
  if (originalNoConfig === undefined) delete process.env.OPEN_OCR_NO_CONFIG;
  else process.env.OPEN_OCR_NO_CONFIG = originalNoConfig;
  if (originalProvider === undefined) delete process.env.OPEN_OCR_PROVIDER;
  else process.env.OPEN_OCR_PROVIDER = originalProvider;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  await rm(directory, { recursive: true, force: true });
});

describe('machine request execution', () => {
  it('destroys a blocked request stdin stream when aborted', async () => {
    const input = new PassThrough();
    const abortController = new AbortController();
    const reading = readStandardInput(abortController.signal, input);

    input.write('{"protocolVersion":2');
    abortController.abort(new Error('Interrupted by SIGINT'));

    await expect(reading).rejects.toThrow('Interrupted by SIGINT');
    expect(input.destroyed).toBe(true);
  });

  it('loads only the explicit config when execution disables ambient config', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'agent-config.json'), JSON.stringify({
      concurrency: 7,
      model: 'gemini-3.1-flash-lite',
    }));
    await writeFile(path.join(directory, '.open-ocr-cli.json'), JSON.stringify({
      provider: 'kimi',
      model: 'kimi-k3',
      mode: 'agentic',
    }));

    const execution = await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      configPath: 'agent-config.json',
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'explicit-config-hermetic-run',
      abortController: new AbortController(),
      noConfig: true,
    });

    expect(execution.summary).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      mode: 'simple',
      failed: 0,
    });
  });

  it('honors OPEN_OCR_NO_CONFIG for protocol runs', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, '.open-ocr-cli.json'), JSON.stringify({
      provider: 'kimi',
      model: 'kimi-k3',
    }));
    await writeFile(path.join(directory, '.env'), 'OPEN_OCR_PROVIDER=kimi\n');
    process.env.OPEN_OCR_NO_CONFIG = '1';

    const execution = await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'hermetic-run',
      abortController: new AbortController(),
    });

    expect(execution.summary).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      failed: 0,
    });
    expect(process.env.OPEN_OCR_PROVIDER).toBeUndefined();
  });

  it('routes URL dry runs through the shared job service', async () => {
    const execution = await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [
        { type: 'url', url: 'https://example.com/article' },
        { type: 'url', url: 'https://example.com/report.pdf' },
      ],
      web: { analysis: 'comparison' },
      extraction: { mode: 'simple', contentFormat: 'markdown' },
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'url-dry-run',
      abortController: new AbortController(),
      noConfig: true,
    });

    expect(execution.result).toMatchObject({
      status: 'validated',
      total: 1,
      failed: 0,
      documents: [{ status: 'skipped', skipReason: 'validated' }],
    });
  });

  it('names an unreadable request path instead of leaking an errno into the payload', async () => {
    let thrown: unknown;
    try {
      await readOcrJobRequest('request.json', directory);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe('OCR request file not found: request.json');
    expect((thrown as Error).message).not.toContain('ENOENT');
    expect((thrown as Error).message).not.toContain(directory);
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'INPUT_NOT_FOUND',
      category: 'input',
      retryable: false,
    });
  });

  it('refuses csv from a config-supplied record preset instead of validating it', async () => {
    await writeFile(path.join(directory, 'card.png'), JPEG_BYTES);
    // The preset arrives from file configuration, so the request itself parses
    // cleanly and only the merged view can catch the combination.
    await writeFile(path.join(directory, 'agent-config.json'), JSON.stringify({
      mode: 'template',
      preset: 'business-card',
    }));
    let thrown: unknown;
    try {
      await executeOcrJobRequest({
        protocolVersion: 2,
        operation: 'extract',
        inputs: [{ type: 'path', path: 'card.png' }],
        configPath: 'agent-config.json',
        extraction: { contentFormat: 'csv' },
        delivery: { mode: 'inline' },
        dryRun: true,
      }, {
        cwd: directory,
        runId: 'csv-record-preset-run',
        abortController: new AbortController(),
        noConfig: true,
      });
    } catch (error) {
      thrown = error;
    }

    // A dry run answered `validated`, ok: true for this before — a green light
    // for a combination that fails only after the provider call is billed.
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
    });
    expect((thrown as Error).message).toContain('business-card');
    expect((thrown as Error).message).toContain('cannot produce CSV rows');
  });

  it('reports a missing document before a missing credential', async () => {
    delete process.env.GEMINI_API_KEY;
    let thrown: unknown;
    try {
      await executeOcrJobRequest({
        protocolVersion: 2,
        operation: 'extract',
        inputs: [{ type: 'path', path: 'missing.jpg' }],
        delivery: { mode: 'inline' },
      }, {
        cwd: directory,
        runId: 'missing-input-run',
        abortController: new AbortController(),
        noConfig: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(ocrErrorPayload(thrown, 2)).toMatchObject({ code: 'INPUT_NOT_FOUND' });
    expect((thrown as Error).message).not.toContain('API key is missing');
  });

  it('still requires a credential once the request and its inputs resolve', async () => {
    delete process.env.GEMINI_API_KEY;
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    let thrown: unknown;
    try {
      await executeOcrJobRequest({
        protocolVersion: 2,
        operation: 'extract',
        inputs: [{ type: 'path', path: 'invoice.jpg' }],
        delivery: { mode: 'inline' },
      }, {
        cwd: directory,
        runId: 'missing-credential-run',
        abortController: new AbortController(),
        noConfig: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'AUTH_MISSING',
      category: 'authentication',
    });
  });

  it('warns about extraction fields the resolved mode will not read', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const warnings: string[] = [];

    const execution = await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      extraction: { mode: 'template', preset: 'invoice', detectMath: true, maxTokens: 4096 },
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'ignored-fields-run',
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    // Reported on the host channel as it happens, and carried in the result so
    // a caller that only reads the machine payload still sees it.
    expect(warnings).toEqual([
      'ignoring option(s) that template mode does not use: extraction.detectMath, extraction.maxTokens',
    ]);
    expect(execution.result.status).toBe('validated');
    expect(execution.result.warnings).toEqual(warnings);
  });

  it('replays pre-run warnings on the event stream after run.started', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const events: string[] = [];
    let warningEvent: { message?: string } | undefined;

    await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      extraction: { mode: 'template', preset: 'invoice', detectMath: true },
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'warning-event-run',
      abortController: new AbortController(),
      eventSink: (event) => {
        events.push(event.type);
        if (event.type === 'run.warning') warningEvent = event;
      },
      noConfig: true,
    });

    expect(events.slice(0, 2)).toEqual(['run.started', 'run.warning']);
    expect(warningEvent?.message).toContain('extraction.detectMath');
  });

  it('names request fields, not extract flags, in option errors', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    let thrown: unknown;
    try {
      await executeOcrJobRequest({
        protocolVersion: 2,
        operation: 'extract',
        inputs: [{ type: 'path', path: 'invoice.jpg' }],
        // The schema allows `max`; only the resolver knows Gemini refuses it.
        extraction: { thinking: 'max' },
        delivery: { mode: 'inline' },
        dryRun: true,
      }, {
        cwd: directory,
        runId: 'field-vocabulary-run',
        abortController: new AbortController(),
        noConfig: true,
      });
    } catch (error) {
      thrown = error;
    }

    const payload = ocrErrorPayload(thrown, 2);
    expect(payload.code).toBe('CONFIG_INVALID');
    expect(payload.message).toContain('extraction.thinking');
    expect(payload.message).not.toContain('--thinking');
  });

  it('reports the documents a directory scan passed over', async () => {
    await mkdir(path.join(directory, 'docs'));
    await writeFile(path.join(directory, 'docs', 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'docs', 'notes.md'), '# notes');
    await writeFile(path.join(directory, 'docs', 'README.txt'), 'plain text');
    const warnings: string[] = [];

    const execution = await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'docs' }],
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'discovery-skip-run',
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    // The run is one document short of what was requested. The result and
    // event schemas are strict, so the shortfall rides the warning channel in
    // the same wording the direct CLI prints.
    expect(warnings).toEqual([
      `Discovery: 2 unsupported file(s) skipped: ${path.join('docs', 'notes.md')}, ${path.join('docs', 'README.txt')}`,
    ]);
    expect(execution.summary.total).toBe(1);
  });

  it('reports the dependency trees a directory scan refused to walk', async () => {
    await mkdir(path.join(directory, 'docs'));
    await mkdir(path.join(directory, 'docs', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(directory, 'docs', 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'docs', 'node_modules', 'pkg', 'logo.jpg'), JPEG_BYTES);
    const warnings: string[] = [];

    const execution = await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'docs' }],
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'default-exclude-run',
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    // An agent that pointed at a folder has to learn the scan declined part of
    // it, or the document set shrinks with no way to notice.
    expect(warnings).toEqual([
      `Discovery: 1 director(y/ies) skipped by default excludes: ${path.join('docs', 'node_modules')}`
      + ' (use --no-default-excludes to scan them)',
    ]);
    expect(execution.summary.total).toBe(1);
  });

  it('says nothing about discovery when a scan passed over nothing', async () => {
    await mkdir(path.join(directory, 'docs'));
    await writeFile(path.join(directory, 'docs', 'invoice.jpg'), JPEG_BYTES);
    const warnings: string[] = [];

    await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'docs' }],
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'discovery-clean-run',
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    expect(warnings).toEqual([]);
  });

  it('says that an explicit resume cannot match anything without an output directory', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const warnings: string[] = [];

    await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      delivery: { mode: 'reference', resume: true },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'resume-without-output-run',
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    // The default output directory is per-run, so this resume can never match.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('delivery.resume was requested without delivery.outputDirectory');
    expect(warnings[0]).toContain(path.join('.open-ocr-results', 'resume-without-output-run'));
  });

  it.each([
    {
      label: 'resume is only the default',
      delivery: { mode: 'reference' as const },
      runId: 'default-resume-run',
    },
    {
      label: 'an explicit resume names its output directory',
      delivery: { mode: 'reference' as const, resume: true, outputDirectory: 'results' },
      runId: 'explicit-resume-run',
    },
    {
      label: 'resume is explicitly switched off',
      delivery: { mode: 'reference' as const, resume: false },
      runId: 'disabled-resume-run',
    },
  ])('stays quiet about resume when $label', async ({ delivery, runId }) => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const warnings: string[] = [];

    await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      delivery,
      dryRun: true,
    }, {
      cwd: directory,
      runId,
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    // Resume is only on by default with an output directory, so the default
    // run has nothing to warn about, and an explicit off never does.
    expect(warnings).toEqual([]);
  });

  it('does not warn when every supplied extraction field is used', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const warnings: string[] = [];

    await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      extraction: { mode: 'agentic', maxIterations: 3, confidenceThreshold: 0.9, maxTokens: 4096 },
      delivery: { mode: 'inline' },
      dryRun: true,
    }, {
      cwd: directory,
      runId: 'used-fields-run',
      abortController: new AbortController(),
      onWarning: (message) => warnings.push(message),
      noConfig: true,
    });

    expect(warnings).toEqual([]);
  });

  it('bounds the request envelope at 1 MB through both guards', async () => {
    const oversized = JSON.stringify({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      extraction: { instructions: ['x'.repeat(1024 * 1024)] },
    });
    const requestPath = path.join(directory, 'huge.json');
    await writeFile(requestPath, oversized);

    // The file path checks the size twice on purpose — once through the open
    // handle's stat, once on the bytes actually read — because the file can be
    // swapped between the two. Both must report the same refusal.
    await expect(readOcrJobRequest('huge.json', directory)).rejects.toMatchObject({
      message: 'OCR request JSON exceeds the 1 MB limit',
    });

    const stdin = new PassThrough();
    stdin.end(oversized);
    await expect(readStandardInput(undefined, stdin)).rejects.toMatchObject({
      message: 'OCR request JSON exceeds the 1 MB limit',
    });
  });

  it('reports malformed request JSON as a fixable configuration error', async () => {
    await writeFile(path.join(directory, 'broken.json'), '{ "protocolVersion": 2,');

    let thrown: unknown;
    try {
      await readOcrJobRequest('broken.json', directory);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toMatch(/^OCR request JSON is invalid: /u);
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
    });
  });

  it('rejects a request whose protocolVersion is not the one supported version', async () => {
    for (const protocolVersion of [1, 3, '2', undefined]) {
      await writeFile(path.join(directory, 'versioned.json'), JSON.stringify({
        protocolVersion,
        operation: 'extract',
        inputs: [{ type: 'path', path: 'invoice.jpg' }],
      }));

      const payload = await readOcrJobRequest('versioned.json', directory).then(
        () => undefined,
        (error: unknown) => ocrErrorPayload(error, 2),
      );
      expect(payload).toMatchObject({ code: 'CONFIG_INVALID', retryable: false });
      expect(payload?.message).toContain('Unsupported OCR protocol version');
      expect(payload?.hint).toContain('protocolVersion 2');
    }
  });
});
