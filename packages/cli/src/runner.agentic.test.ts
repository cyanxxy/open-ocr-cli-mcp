import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMemory, AgentStep } from '@open-ocr/engine/agentTypes';

const { mockAgentLoop } = vi.hoisted(() => ({
  mockAgentLoop: vi.fn(),
}));

vi.mock('@open-ocr/engine/agentLoop', () => ({
  agentLoop: mockAgentLoop,
}));

import { resolveCliOptions } from './config';
import { discoverInputSet } from './inputs';
import { runBatch } from './runner';
import { cliBatchExitCode } from './errors';
import { toOcrRunResult } from './protocol';

const discoverInputs = async (...args: Parameters<typeof discoverInputSet>) =>
  (await discoverInputSet(...args)).inputs;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
let directory: string;

/** A minimal valid PDF with `pages` blank pages. */
function pdfWithPages(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, index) => `${3 + index} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'),
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function partialAgentRun(
  documentName: string,
  stopReason: NonNullable<AgentMemory['stopReason']> = 'max_iterations',
): AsyncGenerator<AgentStep, AgentMemory, void> {
  return (async function* (): AsyncGenerator<AgentStep, AgentMemory, void> {
    await Promise.resolve();
    yield { type: 'thinking', content: 'Inspecting document', timestamp: 1 };
    yield {
      type: 'thinking', source: 'model_output', id: 'completion-1', delta: true,
      content: 'Invoice ', timestamp: 2,
    };
    yield {
      type: 'thinking', source: 'model_output', id: 'completion-1', delta: true,
      content: 'recognized.', timestamp: 3,
    };
    return {
      sessionId: 'session-1',
      documentName,
      currentIteration: 2,
      extractedFields: {
        invoice_number: { value: 'INV-42', confidence: 0.72, extractedAt: 1 },
      },
      processingHistory: [],
      documentAnalysis: {
        pageCount: 1,
        documentType: 'invoice',
        complexity: 'medium',
        specialFeatures: [],
      },
      confidence: 0.72,
      lastUpdated: 1,
      stopReason,
    };
  })();
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-agentic-runner-'));
  process.env.GEMINI_API_KEY = 'test-key';
  mockAgentLoop.mockReset();
  mockAgentLoop.mockImplementation((input: { name: string }) => partialAgentRun(input.name));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
});

describe('CLI agentic batch orchestration', () => {
  it('writes useful partial artifacts and re-extracts them on the next run', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    const output = path.join(directory, 'results');
    const options = resolveCliOptions(
      { mode: 'agentic', format: 'all', output, quiet: true },
      {},
      directory,
    );
    const inputs = await discoverInputs(['*.jpg'], options);

    const first = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    expect(mockAgentLoop.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ throwOnFailure: true }));
    expect(first).toMatchObject({ total: 2, succeeded: 0, partial: 2, failed: 0 });
    expect(first.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'partial',
        partialReason: 'max_iterations',
        nextAction: 'increase_max_iterations',
      }),
    ]));
    expect(await readFile(path.join(output, 'one.md'), 'utf8')).toContain('INV-42');
    expect(await readFile(path.join(output, 'one.json'), 'utf8')).toContain('max_iterations');
    const trace = JSON.parse(await readFile(path.join(output, 'one.steps.json'), 'utf8')) as AgentStep[];
    expect(trace).toEqual([
      expect.objectContaining({ content: 'Inspecting document' }),
      expect.objectContaining({
        id: 'completion-1', source: 'model_output', content: 'Invoice recognized.',
      }),
    ]);
    expect(trace[1]).not.toHaveProperty('delta');

    const resumed = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    // An agentic run that stopped on its iteration ceiling is exactly the case
    // resume must not skip: skipping strands the shortfall permanently. The
    // rerun replaces the partial run's own artifacts without a collision.
    expect(resumed).toMatchObject({ total: 2, succeeded: 0, partial: 2, failed: 0, skipped: 0 });
    expect(mockAgentLoop).toHaveBeenCalledTimes(4);
  });

  it('starts the agent with the document\'s real page count', async () => {
    await writeFile(path.join(directory, 'two-pages.pdf'), pdfWithPages(2));
    await writeFile(path.join(directory, 'photo.jpg'), JPEG_BYTES);
    const options = resolveCliOptions(
      { mode: 'agentic', format: 'json', output: path.join(directory, 'results'), quiet: true },
      {},
      directory,
    );
    const inputs = await discoverInputs(['two-pages.pdf', 'photo.jpg'], options);
    await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });
    const pageCounts = Object.fromEntries(mockAgentLoop.mock.calls.map((call) => [
      (call[0] as { name: string }).name,
      (call[3] as { pageCount?: number }).pageCount,
    ]));
    expect(pageCounts).toEqual({ 'two-pages.pdf': 2, 'photo.jpg': 1 });
  });

  it('publishes a field location with exactly the result-schema keys, whatever the agent stored', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    mockAgentLoop.mockImplementation(() => (async function* (): AsyncGenerator<AgentStep, AgentMemory, void> {
      await Promise.resolve();
      yield { type: 'thinking', content: 'Inspecting document', timestamp: 1 };
      return {
        sessionId: 'session-1',
        documentName: 'one.jpg',
        currentIteration: 1,
        extractedFields: {
          invoice_number: {
            value: 'INV-42',
            confidence: 0.95,
            extractedAt: 1,
            // A model-added key the published result schema does not allow.
            location: {
              page: 1, x: 0.7, y: 0.05, width: 0.2, height: 0.04, units: 'normalized', label: 'top right',
            } as NonNullable<AgentMemory['extractedFields'][string]['location']>,
          },
        },
        processingHistory: [],
        documentAnalysis: { pageCount: 1, documentType: 'invoice', complexity: 'low', specialFeatures: [] },
        confidence: 0.95,
        lastUpdated: 1,
        stopReason: 'succeeded',
      };
    })());
    const options = resolveCliOptions({ mode: 'agentic', format: 'json', quiet: true }, {}, directory);
    const inputs = await discoverInputs(['one.jpg'], options);
    const written: string[] = [];
    // One document to stdout: inline delivery, validated against result-v2.
    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(),
      writeStdout: (text) => { written.push(text); },
      writeStderr: () => undefined,
    });
    expect(summary.succeeded).toBe(1);
    const published = JSON.parse(written.join('')) as { fields: Record<string, { location?: Record<string, unknown> }> };
    expect(published.fields.invoice_number.location).toEqual({
      page: 1, x: 0.7, y: 0.05, width: 0.2, height: 0.04, units: 'normalized',
    });
    expect(() => toOcrRunResult('run-1', summary, 'inline', 'json')).not.toThrow();
  });

  it('stops the batch when an agentic document reports a cost-limit stop', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    // One worker, so the second document is still unscheduled when the first
    // reports the ceiling.
    const options = resolveCliOptions(
      { mode: 'agentic', format: 'json', output: path.join(directory, 'results'), quiet: true, concurrency: '1' },
      {},
      directory,
    );
    mockAgentLoop.mockImplementation((input: { name: string }) => (
      partialAgentRun(input.name, 'cost_limit_reached')
    ));
    const inputs = await discoverInputs(['*.jpg'], options);

    const summary = await runBatch(inputs, options, {
      abortController: new AbortController(), writeStdout: () => undefined, writeStderr: () => undefined,
    });

    // The ceiling is a decision, not a fault: the batch stops scheduling and
    // says so, rather than reporting the remainder as a retryable NOT_RUN.
    expect(summary.costLimitReached).toBe(true);
    expect(summary.partial).toBe(1);
    expect(summary.results[0]).toMatchObject({
      partialReason: 'cost_limit_reached',
      nextAction: 'increase_max_cost',
    });
    expect(mockAgentLoop).toHaveBeenCalledTimes(1);
    const unscheduled = summary.results.find((result) => result.skipReason === 'cost-limit');
    expect(unscheduled?.errorDetails).toMatchObject({ code: 'COST_LIMIT', retryable: false });

    expect(toOcrRunResult('run-1', summary).status).toBe('cost_limited');
    expect(cliBatchExitCode(summary)).toBe(1);
  });
});
