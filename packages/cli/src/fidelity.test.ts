import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMemory, AgentStep } from '@open-ocr/engine/agentTypes';
import { OcrError, OcrErrorType } from '@open-ocr/engine/gemini/types';
import { ProviderApiError } from '@open-ocr/engine/providers/openaiCompatible';

const { mockAgentLoop } = vi.hoisted(() => ({ mockAgentLoop: vi.fn() }));
vi.mock('@open-ocr/engine/agentLoop', () => ({ agentLoop: mockAgentLoop }));

import { resolveCliOptions } from './config';
import { cliBatchExitCode, ocrErrorPayload } from './errors';
import { discoverInputSet } from './inputs';
import { createOcrCapabilities, toOcrRunResult } from './protocol';
import { extractedContentToMarkdown, runBatch } from './runner';
import { assertCustomSchemaOutput, validateCustomSchema } from './schema';
import type { ExtractCommandFlags, ResolvedCliOptions } from './types';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-fidelity-'));
  await writeFile(path.join(directory, 'doc.png'), PNG_BYTES);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  mockAgentLoop.mockReset();
  await rm(directory, { recursive: true, force: true });
});

function completion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function stubModel(...answers: string[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(() => Promise.resolve(completion(answers[Math.min(call++, answers.length - 1)])));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function options(flags: ExtractCommandFlags): ResolvedCliOptions {
  return resolveCliOptions({
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'm',
    retries: 0,
    ...flags,
  }, {}, directory, 'flag', { OPEN_OCR_API_KEY: 'test-key' });
}

async function run(resolved: ResolvedCliOptions) {
  const inputs = (await discoverInputSet(['doc.png'], resolved)).inputs;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const summary = await runBatch(inputs, resolved, {
    runId: 'fidelity-run',
    abortController: new AbortController(),
    writeStdout: (text) => { stdout.push(text); },
    writeStderr: (text) => { stderr.push(text); },
  });
  return { summary, stdout: stdout.join(''), stderr: stderr.join('') };
}

const EMPTY_INVOICE = JSON.stringify({
  documentType: 'Invoice',
  summary: 's',
  fields: { vendor_name: { value: 'ACME', confidence: 0.9 }, invoice_number: { value: null, confidence: 0 } },
  rows: [],
  warnings: [],
});

describe('template validation reaches the document status', () => {
  it('reports missing required fields as partial (exit 1) with the errors in the document warnings', async () => {
    stubModel(EMPTY_INVOICE);
    const { summary, stdout, stderr } = await run(options({ preset: 'invoice', format: 'csv' }));
    const [document] = summary.results;

    expect(document.status).toBe('partial');
    expect(document).toMatchObject({ partialReason: 'validation_failed', nextAction: 'review_partial_output' });
    expect(document.warnings).toEqual(expect.arrayContaining([
      'Required field "invoice_number" is missing or empty.',
      'Required field "total" is missing or empty.',
      'No line-item rows were extracted; CSV output contains only the header row.',
    ]));
    expect(cliBatchExitCode({ ...summary, costLimitReached: false })).toBe(1);
    // An empty line-item table no longer discards the extraction.
    expect(stdout).toBe('description,quantity,unit_price,line_total\n');
    expect(stderr).toContain('partial: validation_failed');
    expect(stderr).toContain('warning: Required field "invoice_number" is missing or empty.');

    const protocol = toOcrRunResult('fidelity-run', summary, 'inline', 'all');
    expect(protocol.status).toBe('partial');
    expect(protocol.documents[0].warnings).toEqual(document.warnings);
    expect(protocol.documents[0].partialReason).toBe('validation_failed');
  });

  it('keeps a complete preset result succeeded while surfacing non-fatal warnings', async () => {
    stubModel(JSON.stringify({
      documentType: 'Card',
      summary: 's',
      fields: {
        full_name: { value: 'Nina', confidence: 0.9 },
        company: { value: 'Orbit', confidence: 0.9 },
        website: { value: 'javascript:alert(1)', confidence: 0.9 },
      },
      warnings: [],
    }));
    const { summary } = await run(options({ preset: 'business-card', format: 'json' }));
    expect(summary.results[0].status).toBe('succeeded');
    expect(summary.results[0].warnings?.[0]).toMatch(/"javascript:" scheme/);
    expect(toOcrRunResult('fidelity-run', summary).documents[0].warnings).toHaveLength(1);
  });

  it('sends --max-tokens with template requests', async () => {
    const fetchMock = stubModel(EMPTY_INVOICE);
    await run(options({ preset: 'invoice', format: 'json', maxTokens: '4096' }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(4096);
    expect(options({ preset: 'invoice' }).maxTokens).toBe(16384);
  });
});

describe('simple-mode output contracts', () => {
  it('writes the model Markdown unchanged apart from CRLF, reasoning, and outer blank lines', async () => {
    stubModel('<think>plan</think>\r\n# Report\r\n\r\n## A\r\n\r\n### A.1\r\n\r\n    # code\r\n\r\ntext  \r\n');
    const { stdout } = await run(options({}));
    expect(stdout).toBe('# Report\n\n## A\n\n### A.1\n\n    # code\n\ntext  \n');
  });

  it('records heading levels consistently in --format all JSON', async () => {
    stubModel('# Report\n\n## A\n\n#### Deep\n\nx');
    const resolved = options({ format: 'all', output: 'out' });
    await run(resolved);
    const json = JSON.parse(await readFile(path.join(directory, 'out', 'doc.json'), 'utf8')) as {
      title: string;
      markdown: string;
      sections: Array<{ heading: string; level: number }>;
    };
    expect(json.title).toBe('Report');
    expect(json.sections.map((section) => [section.heading, section.level])).toEqual([['A', 2], ['Deep', 4]]);
    expect(await readFile(path.join(directory, 'out', 'doc.md'), 'utf8')).toBe(`${json.markdown}\n`);
  });

  it('fails a JSON answer of the wrong shape as OUTPUT_INVALID naming the path, and retries it', async () => {
    const fetchMock = stubModel('{"sections":[{"content":["a",5]}]}');
    const { summary } = await run(options({ format: 'json', retries: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.results[0].errorDetails).toMatchObject({ code: 'OUTPUT_INVALID', category: 'output', retryable: true });
    expect(summary.results[0].error).toContain('sections[0].content[1] must be a string');
  });

  it('fails {"sections":[]} instead of reporting an empty success', async () => {
    stubModel('{"sections":[]}');
    const { summary } = await run(options({ format: 'json' }));
    expect(summary.results[0].status).toBe('failed');
    expect(summary.results[0].error).toMatch(/no text content/);
  });

  it('accepts a fenced --schema answer and reports a nonconforming one as OUTPUT_INVALID naming the key', async () => {
    const schema = validateCustomSchema({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    stubModel('```json\n{"name":"a"}\n```');
    const ok = await run({ ...options({ format: 'json' }), customSchema: schema });
    expect(ok.summary.results[0].status).toBe('succeeded');
    expect(JSON.parse(ok.stdout)).toEqual({ name: 'a' });

    stubModel('Sure: {"name":"a","extra":1}');
    const bad = await run({ ...options({ format: 'json' }), customSchema: schema });
    expect(bad.summary.results[0].errorDetails).toMatchObject({
      code: 'OUTPUT_INVALID',
      retryable: true,
      message: 'Model output did not conform to the requested JSON Schema: / has unexpected property "extra"',
    });
    expect(bad.summary.results[0].errorDetails?.hint).not.toMatch(/Validate the JSON Schema/);
  });
});

describe('Markdown rendering of structured content', () => {
  it('rebuilds a JSON answer at its section levels without doubled blank lines', () => {
    expect(extractedContentToMarkdown({
      title: 'T',
      sections: [{ heading: 'A', level: 3, content: ['x'] }, { heading: 'B', content: ['y'] }],
    })).toBe('# T\n\n### A\n\nx\n\n## B\n\ny');
  });

  it('escapes agentic field names and values', async () => {
    mockAgentLoop.mockImplementation(() => (async function* (): AsyncGenerator<AgentStep, AgentMemory, void> {
      await Promise.resolve();
      yield { type: 'thinking', content: 'x', timestamp: 1 };
      return {
        sessionId: 's',
        documentName: 'doc.png',
        currentIteration: 1,
        extractedFields: { merchant_name: { value: 'Shop\n# Injected | <b>', confidence: 0.9, extractedAt: 1 } },
        processingHistory: [],
        documentAnalysis: { pageCount: 1, documentType: 'receipt', complexity: 'low', specialFeatures: [] },
        confidence: 0.9,
        lastUpdated: 1,
        stopReason: 'succeeded',
      };
    })());
    const resolved = resolveCliOptions({ mode: 'agentic' }, {}, directory, 'flag', { GEMINI_API_KEY: 'k' });
    const { stdout } = await run(resolved);
    expect(stdout).toContain('- **merchant_name**: Shop # Injected \\| &lt;b&gt; (90%)');
    expect(stdout).not.toMatch(/^# Injected/m);
  });
});

describe('error taxonomy', () => {
  it('types malformed model output as OUTPUT_INVALID, distinct from SCHEMA_INVALID', () => {
    const payload = ocrErrorPayload(new OcrError(OcrErrorType.OUTPUT_INVALID, 'Schema extraction returned invalid JSON: x'), 1);
    expect(payload).toMatchObject({ code: 'OUTPUT_INVALID', category: 'output', retryable: true });
    expect(ocrErrorPayload(new Error('Schema output validation failed: /a must be string'), 1).code).not.toBe('SCHEMA_INVALID');
  });

  it('hints at --max-tokens for truncated responses', () => {
    for (const error of [
      new ProviderApiError('Provider response reached the output token limit and is incomplete'),
      new Error('Extraction reached the output token limit and returned incomplete output. Increase the output-token limit or lower the thinking level and retry.'),
    ]) {
      const payload = ocrErrorPayload(error, 1);
      expect(payload.hint).toMatch(/--max-tokens/);
      expect(payload.hint).not.toMatch(/rejected this request/);
      expect(payload.retryable).toBe(false);
    }
  });

  it('reports a model refusal with refusal-specific advice', () => {
    const payload = ocrErrorPayload(new ProviderApiError('Provider model refused the request: no', undefined, 'MODEL_REFUSAL'), 1);
    expect(payload).toMatchObject({ code: 'PROVIDER_FAILURE', retryable: false });
    expect(payload.hint).toMatch(/declined/);
  });

  it('lists OUTPUT_INVALID and document warnings in capabilities', () => {
    const capabilities = createOcrCapabilities('0.0.0');
    expect(capabilities.errorCodes).toContain('OUTPUT_INVALID');
    expect(capabilities.features).toContain('document-warnings');
  });

  it('names required and enum violations in --schema output errors', () => {
    const schema = validateCustomSchema({
      type: 'object',
      required: ['kind', 'total'],
      properties: { kind: { enum: ['a', 'b'] }, total: { type: 'number' } },
    });
    expect(() => assertCustomSchemaOutput(schema, { kind: 'c' }))
      .toThrow('/ is missing required property "total"; /kind must be one of "a", "b"');
  });
});
