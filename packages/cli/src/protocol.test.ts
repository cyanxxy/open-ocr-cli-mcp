import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

import type { BatchSummary, OcrJobResult, ResolvedInput } from './types';
import {
  agentProtocolStep,
  assertOcrCapabilities,
  assertOcrJobEvent,
  assertOcrMachineResult,
  createOcrCapabilities,
  OCR_PROTOCOL_SCHEMAS,
  ocrExtractionSemanticError,
  parseOcrJobRequest,
  toOcrRunFailure,
  toOcrRunResult,
} from './protocol';
import { ocrErrorPayload } from './errors';
import { OCR_REQUEST_LIMITS } from './limits';

const input: ResolvedInput = {
  absolutePath: '/workspace/invoice.jpg',
  displayPath: 'invoice.jpg',
  relativePath: 'invoice.jpg',
  name: 'invoice.jpg',
  mimeType: 'image/jpeg',
  size: 8,
  mtimeMs: 1,
};

const usage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 20,
  thoughtTokens: 0,
  toolTokens: 0,
  cachedTokens: 0,
  totalTokens: 120,
  estimatedCostUsd: 0.001,
};

function summaryFor(result: OcrJobResult): BatchSummary {
  return {
    version: 1,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    total: 1,
    succeeded: result.status === 'succeeded' ? 1 : 0,
    partial: result.status === 'partial' ? 1 : 0,
    failed: result.status === 'failed' ? 1 : 0,
    skipped: result.status === 'skipped' ? 1 : 0,
    mode: 'simple',
    provider: 'gemini',
    gateway: 'direct',
    model: 'gemini-3.8-flash',
    usage,
    costLimitReached: false,
    results: [result],
  };
}

describe('agent protocols', () => {
  it('accepts only protocol v2 and exposes its agent controls', () => {
    expect(() => parseOcrJobRequest({
      protocolVersion: 1,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
    })).toThrow('Unsupported OCR protocol version: 1');
    const modern = parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'stdin', name: 'scan.png', mimeType: 'image/png' }],
      noConfig: true,
      extraction: { mode: 'agentic', progress: 'detailed', thinking: 'max' },
      delivery: { mode: 'inline' },
    });
    expect(modern.inputs[0]).toMatchObject({ type: 'stdin', name: 'scan.png' });
    expect(modern.extraction?.progress).toBe('detailed');
    expect(parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'stdin', name: 'animation.gif', mimeType: 'image/gif' }],
      delivery: { mode: 'inline' },
    }).inputs[0]).toMatchObject({
      type: 'stdin',
      name: 'animation.gif',
      mimeType: 'image/gif',
    });
    expect(parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'url', url: 'https://example.com/report.pdf' }],
      web: { analysis: 'individual' },
      extraction: { mode: 'simple', contentFormat: 'json' },
      delivery: { mode: 'inline' },
    }).inputs[0]).toEqual({ type: 'url', url: 'https://example.com/report.pdf' });
    expect(() => parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [
        { type: 'url', url: 'https://example.com' },
        { type: 'path', path: 'invoice.jpg' },
      ],
    })).toThrow('cannot be mixed');
    expect(() => parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'url', url: 'https://example.com' }],
      extraction: { mode: 'agentic' },
    })).toThrow('simple mode');
    expect(() => parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      unknown: true,
    })).toThrow('Invalid OCR request');
    expect(() => parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      extraction: { schema: {}, schemaPath: 'schema.json' },
    })).toThrow('mutually exclusive');
    expect(() => parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      configPath: 'config.json',
      noConfig: true,
    })).toThrow('noConfig and configPath are mutually exclusive');
    expect(() => parseOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [
        { type: 'stdin' },
        { type: 'path', path: 'invoice.jpg' },
      ],
    })).toThrow('only input');
    try {
      parseOcrJobRequest({
        protocolVersion: 2,
        operation: 'extract',
        inputs: [{ type: 'path', path: 'invoice.jpg' }],
        extraction: { preset: 'invoice', schema: {} },
      });
      throw new Error('Expected the request to be rejected');
    } catch (error) {
      const payload = ocrErrorPayload(error);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.category).toBe('configuration');
      expect(payload.message).toContain('extraction.preset');
      expect(payload.message).not.toContain('--schema');
    }
  });

  it('refuses csv for a record-shaped preset before a provider call is billed', () => {
    const capabilities = createOcrCapabilities('3.0.0');
    const recordPreset = capabilities.presets.find((preset) => preset.outputShape === 'record');
    const tablePreset = capabilities.presets.find((preset) => preset.outputShape === 'table');
    if (!recordPreset || !tablePreset) throw new Error('Expected both preset shapes to be published');

    const csvRequest = (preset: string): Record<string, unknown> => ({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'card.png' }],
      extraction: { mode: 'template', preset, contentFormat: 'csv' },
      dryRun: true,
    });

    expect(ocrExtractionSemanticError({
      mode: 'template',
      preset: recordPreset.id,
      hasSchema: false,
      contentFormat: 'csv',
    })).toContain('cannot produce CSV rows');
    // A dry run used to answer `validated` for this, a green light for a
    // combination that can only fail after the call is paid for.
    try {
      parseOcrJobRequest(csvRequest(recordPreset.id));
      throw new Error('Expected the record-shaped preset to be rejected for csv');
    } catch (error) {
      const payload = ocrErrorPayload(error);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.message).toContain(recordPreset.id);
      expect(payload.message).toContain(tablePreset.id);
      expect(payload.message).not.toContain('--format');
    }

    expect(parseOcrJobRequest(csvRequest(tablePreset.id))).toMatchObject({
      extraction: { preset: tablePreset.id, contentFormat: 'csv' },
    });
    // Other formats stay available for a record preset, and an unknown preset is
    // still the preset lookup's failure to report.
    expect(ocrExtractionSemanticError({
      mode: 'template',
      preset: recordPreset.id,
      hasSchema: false,
      contentFormat: 'json',
    })).toBeUndefined();
    expect(ocrExtractionSemanticError({
      mode: 'template',
      preset: 'not-a-preset',
      hasSchema: false,
      contentFormat: 'csv',
    })).toBeUndefined();
  });

  it('names both fields when inline delivery is combined with file placement', () => {
    const inlineRequest = (delivery: Record<string, unknown>): Record<string, unknown> => ({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'card.png' }],
      delivery,
    });

    try {
      parseOcrJobRequest(inlineRequest({ mode: 'inline', outputDirectory: 'out' }));
      throw new Error('Expected inline delivery with an output directory to be rejected');
    } catch (error) {
      const payload = ocrErrorPayload(error);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.message).toContain('delivery.outputDirectory');
      expect(payload.message).toContain('delivery.mode inline');
      expect(payload.message).toContain('reference');
      // The schema's own `not` keyword reports this as `must NOT be valid`,
      // which names neither field.
      expect(payload.message).not.toContain('must NOT be valid');
    }
    expect(() => parseOcrJobRequest(inlineRequest({ mode: 'inline', resume: true })))
      .toThrow('delivery.resume');
    expect(() => parseOcrJobRequest(inlineRequest({
      mode: 'inline',
      outputDirectory: 'out',
      resume: false,
    }))).toThrow('delivery.outputDirectory and delivery.resume');
    expect(parseOcrJobRequest(inlineRequest({ mode: 'inline' }))).toMatchObject({
      delivery: { mode: 'inline' },
    });
    expect(parseOcrJobRequest(inlineRequest({ mode: 'reference', outputDirectory: 'out' })))
      .toMatchObject({ delivery: { mode: 'reference', outputDirectory: 'out' } });
  });

  it('resolves the schema identifiers capabilities publishes', () => {
    const capabilities = createOcrCapabilities('3.0.0');
    // capabilities hands agents `$id` URLs next to networkFetch: false, so the
    // local schema command has to accept exactly those identifiers.
    for (const identifier of Object.values(capabilities.schemas)) {
      expect(identifier in OCR_PROTOCOL_SCHEMAS).toBe(true);
      const schema: { $id: string } = OCR_PROTOCOL_SCHEMAS[
        identifier as keyof typeof OCR_PROTOCOL_SCHEMAS
      ];
      expect(schema.$id).toBe(identifier);
    }
    for (const [name, schema] of Object.entries(OCR_PROTOCOL_SCHEMAS)) {
      const bundled: { $id: string } = schema;
      // Every bundled schema is reachable by its own `$id`, not just the five
      // current-version ones capabilities lists.
      expect(OCR_PROTOCOL_SCHEMAS[bundled.$id as keyof typeof OCR_PROTOCOL_SCHEMAS]).toBe(schema);
      if (name.startsWith('https://')) expect(name).toBe(bundled.$id);
    }
    expect(capabilities.schemaAccess.networkFetch).toBe(false);
  });

  it('publishes every runtime request constraint', () => {
    const validateV2 = new Ajv2020({ strict: true, strictRequired: false })
      .compile(OCR_PROTOCOL_SCHEMAS.request);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      configPath: 'config.json',
      noConfig: true,
    })).toBe(false);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      configPath: 'config.json',
      noConfig: false,
    })).toBe(true);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [
        { type: 'stdin' },
        { type: 'path', path: 'invoice.jpg' },
      ],
    })).toBe(false);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [
        { type: 'path', path: '-' },
        { type: 'path', path: 'invoice.jpg' },
      ],
    })).toBe(false);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'stdin' }],
      noConfig: true,
    })).toBe(true);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'url', url: 'https://example.com' }],
      web: { analysis: 'combined' },
      extraction: { contentFormat: 'markdown' },
    })).toBe(true);
    expect(validateV2({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'url', url: 'https://example.com' }],
      extraction: { mode: 'agentic' },
    })).toBe(false);
  });

  it('keeps every numeric bound in one table', () => {
    // The request schema is static JSON and cannot import the table, so this
    // is what stops the two from drifting apart.
    const request = OCR_PROTOCOL_SCHEMAS.request as {
      properties: {
        extraction: { properties: Record<string, { minimum?: number; maximum?: number }> };
        execution: { properties: Record<string, { minimum?: number; maximum?: number }> };
      };
    };
    const bounds = { ...request.properties.extraction.properties, ...request.properties.execution.properties };
    for (const [key, range] of Object.entries(OCR_REQUEST_LIMITS)) {
      if (key === 'urlInputs') continue;
      expect({ key, minimum: bounds[key]?.minimum, maximum: bounds[key]?.maximum })
        .toEqual({ key, minimum: range.min, maximum: range.max });
    }
    // And capabilities publishes the same table, so an agent never has to read
    // the schema to learn a ceiling.
    expect(createOcrCapabilities('3.0.0').limits.request).toEqual(OCR_REQUEST_LIMITS);
  });

  it('carries warnings in the result and as a typed event', () => {
    const timestamp = new Date().toISOString();
    const warned = toOcrRunResult('warned-run', summaryFor({
      status: 'succeeded',
      input,
      provider: 'gemini',
      gateway: 'direct',
      mode: 'simple',
      model: 'gemini-3.8-flash',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 1,
      attempts: 1,
    }), 'reference', 'markdown', 'standard', ['Discovery: 1 unsupported file(s) skipped: notes.md']);
    expect(warned.warnings).toEqual(['Discovery: 1 unsupported file(s) skipped: notes.md']);
    expect(() => assertOcrMachineResult({ ...warned, warnings: undefined })).toThrow('Invalid OCR result');
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'run.warning',
      runId: 'warned-run',
      sequence: 1,
      timestamp,
      message: 'Discovery: 1 unsupported file(s) skipped: notes.md',
    })).not.toThrow();
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'run.warning',
      runId: 'warned-run',
      sequence: 1,
      timestamp,
    })).toThrow(/message/u);
    const failure = toOcrRunFailure('warned-run', {
      code: 'AUTH_MISSING', category: 'authentication', message: 'no key', retryable: false, hint: 'set it',
    }, ['ignoring option(s) that simple mode does not use: extraction.maxIterations']);
    expect(failure.warnings).toHaveLength(1);
  });

  it('types the agentic JSON artifact instead of passing engine memory through', () => {
    const timestamp = new Date().toISOString();
    const agentic = (json: unknown): BatchSummary => ({
      ...summaryFor({
        status: 'succeeded',
        input,
        provider: 'gemini',
        gateway: 'direct',
        mode: 'agentic',
        model: 'gemini-3.8-flash',
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 1,
        attempts: 1,
        artifacts: { markdown: '# fields', json: json as never },
      }),
      mode: 'agentic',
    });
    expect(() => toOcrRunResult('agentic-run', agentic({
      documentType: 'invoice',
      pageCount: 1,
      complexity: 'low',
      specialFeatures: [],
      confidence: 0.9,
      iterations: 2,
      stopReason: 'succeeded',
      fields: { total: { value: '12.00', confidence: 0.95, valid: true } },
    }), 'inline', 'json')).not.toThrow();
    // The raw engine memory carries fields the contract never promised.
    expect(() => toOcrRunResult('agentic-run', agentic({
      sessionId: 's1',
      documentName: 'invoice.jpg',
      currentIteration: 2,
      extractedFields: {},
      processingHistory: [],
      documentAnalysis: { pageCount: 1, documentType: 'invoice', complexity: 'low', specialFeatures: [] },
      confidence: 0.9,
      lastUpdated: 1,
    }), 'inline', 'json')).toThrow('Invalid OCR result');
  });

  it('returns artifact references without embedding extracted document bodies', () => {
    const timestamp = new Date().toISOString();
    const summary = summaryFor({
      status: 'succeeded',
      input,
      provider: 'gemini',
      gateway: 'direct',
      mode: 'simple',
      model: 'gemini-3.8-flash',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 5,
      attempts: 1,
      artifacts: { markdown: 'PRIVATE OCR BODY' },
      outputFiles: ['/workspace/output/invoice.md'],
      outputArtifacts: [{ path: '/workspace/output/invoice.md', extension: 'md' }],
    });
    const reference = toOcrRunResult('run-1', summary, 'reference');
    assertOcrMachineResult(reference);
    expect(reference.documents[0]?.artifacts).toEqual([{
      path: '/workspace/output/invoice.md',
      mediaType: 'text/markdown',
      kind: 'markdown',
    }]);
    expect(JSON.stringify(reference)).not.toContain('PRIVATE OCR BODY');

    const inline = toOcrRunResult('run-2', summary, 'inline', 'markdown');
    assertOcrMachineResult(inline);
    expect(inline.documents[0]?.content).toEqual({ markdown: 'PRIVATE OCR BODY' });

    const tracedSummary = summaryFor({
      ...summary.results[0],
      artifacts: {
        markdown: 'PRIVATE OCR BODY',
        json: { invoice: 'INV-1' },
        agentSteps: [
          {
            type: 'thinking', source: 'reasoning', content: 'raw reasoning', timestamp: 1,
          },
          {
            type: 'function_call',
            source: 'tool_call',
            content: 'Calling inspect',
            functionCall: { id: 'call-1', name: 'inspect', arguments: { region: 'totals' } },
            timestamp: 2,
          },
        ],
      },
    });
    const standard = toOcrRunResult('run-3', tracedSummary, 'inline', 'all', 'standard');
    expect(standard.documents[0]?.content?.agentSteps).toEqual([
      expect.objectContaining({ kind: 'tool_call', callId: 'call-1', name: 'inspect' }),
    ]);
    expect(standard.documents[0]?.content?.agentSteps?.[0]).not.toHaveProperty('arguments');
    const detailed = toOcrRunResult('run-4', tracedSummary, 'inline', 'all', 'detailed');
    expect(detailed.documents[0]?.content?.agentSteps).toEqual([
      expect.objectContaining({ kind: 'reasoning', text: 'raw reasoning' }),
      expect.objectContaining({
        kind: 'tool_call', callId: 'call-1', arguments: { region: 'totals' },
      }),
    ]);
  });

  it('validates typed failures, events, and capability discovery', () => {
    const failure = toOcrRunFailure('run-2', {
      code: 'AUTH_INVALID',
      category: 'authentication',
      message: 'Credential was rejected',
      retryable: false,
      hint: 'Replace the configured credential.',
    });
    assertOcrMachineResult(failure);
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'run.completed',
      runId: 'run-2',
      sequence: 0,
      timestamp: new Date().toISOString(),
      result: failure,
    })).toThrow(/Invalid OCR event/u);
    const timestamp = new Date().toISOString();
    const success = toOcrRunResult('run-2', summaryFor({
      status: 'succeeded',
      input,
      provider: 'gemini',
      gateway: 'direct',
      mode: 'simple',
      model: 'gemini-3.8-flash',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 1,
      attempts: 1,
      artifacts: { markdown: 'done' },
    }));
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'run.completed',
      runId: 'run-2',
      sequence: 0,
      timestamp,
      result: success,
      error: failure.error,
    })).toThrow(/Invalid OCR event/u);
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'run.failed',
      runId: 'run-2',
      sequence: 0,
      timestamp,
      error: failure.error,
      result: success,
    })).toThrow(/Invalid OCR event/u);
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'document.progress',
      runId: 'run-2',
      sequence: 0,
      timestamp: new Date().toISOString(),
      documentId: 'doc-1',
      index: 0,
      total: 1,
      source: 'invoice.jpg',
      step: {
        kind: 'model_output',
        status: 'in_progress',
        stepId: 'model-output-0',
        text: 'partial OCR output',
        delta: true,
      },
    })).not.toThrow();
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'document.progress',
      runId: 'run-2',
      sequence: 1,
      timestamp: new Date().toISOString(),
      documentId: 'doc-1',
      index: 0,
      total: 1,
      source: 'invoice.jpg',
      step: {
        kind: 'model_output', status: 'in_progress', text: 'unaddressable delta', delta: true,
      },
    })).toThrow(/stepId/u);
    expect(() => agentProtocolStep({
      type: 'thinking',
      source: 'model_output',
      delta: true,
      content: 'unaddressable delta',
      timestamp: 1,
    }, 'standard')).toThrow(/stable step ID/u);
    expect(() => agentProtocolStep({
      type: 'function_call',
      source: 'tool_call',
      content: 'Inspecting a region',
      timestamp: 1,
      functionCall: { name: 'inspect', arguments: {} },
    } as unknown as Parameters<typeof agentProtocolStep>[0], 'standard')).toThrow(/call ID and function name/u);
    expect(() => agentProtocolStep({
      type: 'result',
      source: 'tool_result',
      content: 'Inspection complete',
      timestamp: 1,
      functionCall: { id: 'call-1', arguments: {} },
      functionResult: { success: true },
    } as unknown as Parameters<typeof agentProtocolStep>[0], 'standard')).toThrow(/call ID and function name/u);
    const capabilities = createOcrCapabilities('2.1.0');
    expect(capabilities.protocolVersion).toBe(2);
    expect(capabilities.supportedProtocolVersions).toEqual([2]);
    expect(capabilities.inputKinds).toEqual(['path', 'stdin', 'url']);
    expect(capabilities.exitCodes).toMatchObject({ incomplete: 1, invalid: 2 });
    expect(capabilities.deliveryModes).toEqual(['inline', 'reference']);
    expect(capabilities.features).toContain('typed-streaming-agent-progress');
    expect(capabilities.features).toContain('url-input');
    expect(capabilities.features).toContain('mcp-stdio');
    expect(capabilities.features).toContain('result-warnings');
    expect(capabilities.progressStepKinds).toContain('tool_result');
    expect(capabilities.schemas.request).toContain('request-v2.schema.json');
    const geminiProvider = capabilities.providers.find((provider) => provider.id === 'gemini');
    const kimiProvider = capabilities.providers.find((provider) => provider.id === 'kimi');
    const museProvider = capabilities.providers.find((provider) => provider.id === 'muse');
    const openAiCompatibleProvider = capabilities.providers.find(
      (provider) => provider.id === 'openai-compatible',
    );
    expect(geminiProvider?.inputImageMimeTypes)
      .toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
    expect(geminiProvider?.reasoning?.fallbackLevels)
      .toEqual(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
    expect(geminiProvider?.reasoning?.byModel).toHaveProperty('gemini-3.8-flash');
    expect(kimiProvider?.inputImageMimeTypes)
      .toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    expect(museProvider?.inputImageMimeTypes)
      .toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    expect(museProvider?.capabilities.pdfs).toBe(true);
    expect(openAiCompatibleProvider).not.toHaveProperty('reasoning');
    const misleadingReasoning = structuredClone(capabilities);
    const genericProvider = misleadingReasoning.providers.find(
      (provider) => provider.id === 'openai-compatible',
    );
    if (!genericProvider) throw new Error('Expected the generic provider capability');
    genericProvider.reasoning = {
      byModel: {},
      fallbackLevels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'],
    };
    expect(() => assertOcrCapabilities(misleadingReasoning)).toThrow(/Invalid OCR capabilities/u);
    expect(capabilities.schemaAccess).toEqual({
      command: 'open-ocr-cli schema <name>',
      packageDirectory: 'schemas',
      networkFetch: false,
    });
    expect(() => assertOcrCapabilities({
      ...capabilities,
      providers: [{ id: 'gemini' }],
    })).toThrow(/Invalid OCR capabilities/u);
  });

  it('does not label a failed document plus fail-fast skips as partial', () => {
    const timestamp = new Date().toISOString();
    const failed: OcrJobResult = {
      status: 'failed',
      input,
      provider: 'gemini',
      gateway: 'direct',
      mode: 'simple',
      model: 'gemini-3.8-flash',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 1,
      attempts: 1,
      error: 'Input failed',
      errorDetails: {
        code: 'INPUT_INVALID', category: 'input', message: 'Input failed', retryable: false,
      },
    };
    const skippedInput = { ...input, absolutePath: '/workspace/skipped.jpg', name: 'skipped.jpg' };
    const skipped: OcrJobResult = {
      ...failed,
      status: 'skipped',
      input: skippedInput,
      attempts: 0,
      skipReason: 'fail-fast',
      error: 'Not started because --fail-fast stopped the batch',
    };
    const result = toOcrRunResult('fail-fast-run', {
      ...summaryFor(failed),
      total: 2,
      failed: 1,
      skipped: 1,
      results: [failed, skipped],
    });
    expect(result.status).toBe('failed');
  });

  it('couples result ok to terminal status and exposes a dedicated partial event', () => {
    const timestamp = new Date().toISOString();
    const partial = toOcrRunResult('partial-run', summaryFor({
      status: 'partial',
      partialReason: 'max_iterations',
      nextAction: 'increase_max_iterations',
      input,
      provider: 'gemini',
      gateway: 'direct',
      mode: 'simple',
      model: 'gemini-3.8-flash',
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 5,
      attempts: 1,
      outputFiles: ['/workspace/output/invoice.md'],
    }), 'reference');
    expect(partial.ok).toBe(false);
    expect(partial.documents[0]).toMatchObject({
      partialReason: 'max_iterations',
      nextAction: 'increase_max_iterations',
    });
    expect(() => assertOcrMachineResult({ ...partial, ok: true })).toThrow('Invalid OCR result');
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'document.partial',
      runId: 'partial-run',
      sequence: 0,
      timestamp,
      document: partial.documents[0],
    })).not.toThrow();
    expect(() => assertOcrJobEvent({
      protocolVersion: 2,
      type: 'document.completed',
      runId: 'partial-run',
      sequence: 1,
      timestamp,
      document: partial.documents[0],
    })).toThrow('Invalid OCR event');
  });
});

describe('protocol validation messages', () => {
  function rejection(request: unknown): { message: string; clauses: string[] } {
    try {
      parseOcrJobRequest(request);
    } catch (error) {
      const message = ocrErrorPayload(error).message;
      return { message, clauses: message.split('; ') };
    }
    throw new Error('Expected the OCR request to be rejected');
  }

  it('collapses a failed input union into one clause naming the wrong key and the fix', () => {
    const { message, clauses } = rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ kind: 'path', path: 'invoice.jpg' }],
    });
    expect(message).toBe(
      'Invalid OCR request: '
      + "inputs[0]: unknown field 'kind' — did you mean 'type'? (type must be one of: path, stdin, url)",
    );
    // Every oneOf branch fails at once; only one of them is worth reporting.
    expect(clauses).toHaveLength(1);
    expect(message).not.toContain('oneOf');
    expect(message).not.toContain('must NOT have additional properties');
  });

  it('reports only the branch the discriminator selects when a field is missing', () => {
    const { message, clauses } = rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path' }],
    });
    expect(message).toBe("Invalid OCR request: inputs[0]: missing required field 'path'");
    expect(clauses).toHaveLength(1);
    // The stdin and url branches also failed, and neither is relevant here.
    expect(message).not.toContain('url');
  });

  it('lists the discriminator values a schema declares rather than a copy of them', () => {
    expect(rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'file', path: 'invoice.jpg' }],
    }).message).toBe('Invalid OCR request: inputs[0]: type must be one of: path, stdin, url');
    expect(rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ path: 'invoice.jpg' }],
    }).message).toBe(
      "Invalid OCR request: inputs[0]: missing required field 'type' — must be one of: path, stdin, url",
    );
    const declared = OCR_PROTOCOL_SCHEMAS.request.properties.inputs.items.oneOf
      .map((branch) => branch.properties.type.const);
    expect(declared).toEqual(['path', 'stdin', 'url']);
  });

  it('names the allowed values for a bad enum and the offending key for an unknown field', () => {
    expect(rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      extraction: { mode: 'turbo' },
    }).message).toBe(
      'Invalid OCR request: extraction.mode: must be one of: simple, template, agentic',
    );
    const unknownField = rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      unknown: true,
    });
    expect(unknownField.clauses).toHaveLength(1);
    expect(unknownField.message).toContain("unknown field 'unknown' — allowed fields: protocolVersion");
  });

  it('keeps nested and non-union failures readable', () => {
    expect(rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      discovery: { exclude: ['build', 3] },
    }).message).toBe('Invalid OCR request: discovery.exclude[1]: must be string');
    expect(rejection({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
      execution: { timeoutSeconds: 99_999 },
    }).message).toBe('Invalid OCR request: execution.timeoutSeconds: must be <= 3600');
    expect(rejection({
      protocolVersion: 2,
      inputs: [{ type: 'path', path: 'invoice.jpg' }],
    }).message).toBe("Invalid OCR request: missing required field 'operation'");
  });

  it('stays single-line and short while preserving the request error contract', () => {
    const payload = (() => {
      try {
        parseOcrJobRequest({
          protocolVersion: 2,
          operation: 'extract',
          inputs: [{ type: 'stdin', unexpected: true }],
          noConfig: true,
          unknown: true,
        });
      } catch (error) {
        return ocrErrorPayload(error);
      }
      throw new Error('Expected the OCR request to be rejected');
    })();
    expect(payload.code).toBe('CONFIG_INVALID');
    expect(payload.category).toBe('configuration');
    expect(payload.retryable).toBe(false);
    expect(payload.hint).toBe(
      'Compare the payload with the bundled schema: open-ocr-cli schema request.',
    );
    expect(payload.message).not.toMatch(/[\n\r]/u);
    expect(payload.message.length).toBeLessThan(400);
    expect(payload.message.split('; ').length).toBeLessThanOrEqual(5);
    expect(payload.message).toContain("unknown field 'unknown'");
    expect(payload.message).toContain("inputs[0]: unknown field 'unexpected'");
  });
});
