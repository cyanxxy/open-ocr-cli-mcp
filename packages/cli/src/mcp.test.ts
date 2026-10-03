import { webcrypto } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAgenticMcpRequest,
  buildExtractMcpRequest,
  buildWebMcpRequest,
  createOcrMcpServer,
  mcpResult,
  ModernMcpDiagnosticTransport,
} from './mcp';
import type { OcrMachineResult } from './protocol';
import * as machine from './machine';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);

describe('Open OCR MCP server', () => {
  const closeCallbacks: Array<() => Promise<void>> = [];
  const cleanupPaths: string[] = [];

  beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
    await Promise.all(cleanupPaths.splice(0).map(
      async (directory) => rm(directory, { recursive: true, force: true }),
    ));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds versioned requests through the shared semantic validator', () => {
    expect(buildExtractMcpRequest({
      inputs: [{ type: 'path', path: 'invoice.pdf' }],
      mode: 'template',
      preset: 'invoice',
      contentFormat: 'json',
    })).toMatchObject({
      protocolVersion: 2,
      inputs: [{ type: 'path', path: 'invoice.pdf' }],
      extraction: { mode: 'template', preset: 'invoice', contentFormat: 'json' },
      delivery: { mode: 'reference' },
    });
    expect(buildAgenticMcpRequest({
      inputs: [{ type: 'path', path: 'dense-scan.png' }],
      progress: 'detailed',
    })).toMatchObject({ extraction: { mode: 'agentic', progress: 'detailed' } });
    expect(buildWebMcpRequest({
      urls: ['https://example.com/report'],
      analysis: 'combined',
    })).toMatchObject({
      inputs: [{ type: 'url', url: 'https://example.com/report' }],
      web: { analysis: 'combined' },
    });
    expect(() => buildExtractMcpRequest({
      inputs: [{ type: 'path', path: 'invoice.pdf' }],
      mode: 'template',
    })).toThrow('extraction.preset');
  });

  it('rejects tool arguments the protocol forbids with a message an agent can act on', () => {
    // The tool takes delivery and outputDirectory as independent arguments, so
    // the conflict has to be named rather than left to the schema's `not`.
    expect(() => buildExtractMcpRequest({
      inputs: [{ type: 'path', path: 'invoice.pdf' }],
      delivery: 'inline',
      outputDirectory: 'out',
    })).toThrow(/delivery\.outputDirectory.*delivery\.mode inline/su);
    expect(() => buildAgenticMcpRequest({
      inputs: [{ type: 'path', path: 'scan.png' }],
      delivery: 'inline',
      resume: true,
    })).toThrow('delivery.resume');
    expect(buildExtractMcpRequest({
      inputs: [{ type: 'path', path: 'invoice.pdf' }],
      delivery: 'reference',
      outputDirectory: 'out',
    })).toMatchObject({ delivery: { mode: 'reference', outputDirectory: 'out' } });

    // csv from a preset that extracts one record per document can only fail
    // after the call is billed, so it is refused here.
    expect(() => buildExtractMcpRequest({
      inputs: [{ type: 'path', path: 'card.png' }],
      mode: 'template',
      preset: 'business-card',
      contentFormat: 'csv',
    })).toThrow('cannot produce CSV rows');
    expect(buildExtractMcpRequest({
      inputs: [{ type: 'path', path: 'receipt.png' }],
      mode: 'template',
      preset: 'receipt',
      contentFormat: 'csv',
    })).toMatchObject({ extraction: { preset: 'receipt', contentFormat: 'csv' } });
  });

  // A live run only reaches `partial` easily, so the remaining not-ok statuses
  // are pinned here. Enumerating statuses is what let the original bug survive:
  // `failed` was listed and the other three were not.
  describe('tool error reporting', () => {
    const resultWithStatus = (
      status: OcrMachineResult['status'],
      ok: boolean,
    ): OcrMachineResult => ({
      protocolVersion: 2,
      type: 'run.result',
      ok,
      runId: 'r1',
      status,
      documents: [],
    } as unknown as OcrMachineResult);

    it.each([
      ['partial', false],
      ['failed', false],
      ['cancelled', false],
      ['cost_limited', false],
    ] as const)('reports %s as a tool error', (status, ok) => {
      expect(mcpResult(resultWithStatus(status, ok)).isError).toBe(true);
    });

    it.each([
      ['succeeded', true],
      ['validated', true],
    ] as const)('does not report %s as a tool error', (status, ok) => {
      expect(mcpResult(resultWithStatus(status, ok)).isError).toBeUndefined();
    });

    it('never disagrees with the ok field it is derived from', () => {
      for (const ok of [true, false]) {
        const built = mcpResult(resultWithStatus('partial', ok));
        expect(built.isError === true).toBe(!ok);
        expect(built.structuredContent.ok).toBe(ok);
      }
    });
  });

  describe('modern stdio transport', () => {
    interface JsonRpcReply {
      id?: number;
      result?: Record<string, unknown>;
      error?: { code: number; message: string; data?: unknown };
    }

    const modernMeta = (
      capabilities: Record<string, unknown> = { elicitation: { form: {} } },
    ): Record<string, unknown> => ({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': capabilities,
      'io.modelcontextprotocol/clientInfo': { name: 'open-ocr-test', version: '1.0.0' },
    });

    const driveServer = async (cwd: string, direct = false) => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      if (direct) {
        const server = createOcrMcpServer('3.0.0', cwd);
        await server.connect(serverTransport);
        closeCallbacks.push(async () => server.close());
      } else {
        const handle = serveStdio(() => createOcrMcpServer('3.0.0', cwd), {
          legacy: 'reject',
          transport: new ModernMcpDiagnosticTransport(serverTransport),
          onerror: () => { /* asserted through replies, not side channels */ },
        });
        closeCallbacks.push(async () => handle.close());
      }

      const waiters = new Map<number, (reply: JsonRpcReply) => void>();
      // Notifications carry no id, so the reply router drops them. Collect them
      // separately: they are the only evidence the progress channel works.
      const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
      clientTransport.onmessage = (message) => {
        const reply = message as JsonRpcReply & { method?: string; params?: Record<string, unknown> };
        if (reply.id === undefined) {
          if (reply.method) notifications.push({ method: reply.method, params: reply.params });
          return;
        }
        const waiter = waiters.get(reply.id);
        if (!waiter) return;
        waiters.delete(reply.id);
        waiter(reply);
      };
      await clientTransport.start();

      const request = async (
        id: number,
        method: string,
        params?: Record<string, unknown>,
      ): Promise<JsonRpcReply> => {
        const reply = new Promise<JsonRpcReply>((resolve) => waiters.set(id, resolve));
        await clientTransport.send(
          { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } as never,
        );
        return reply;
      };
      return { request, notifications, notify: clientTransport.send.bind(clientTransport) };
    };

    it('serves 2026-07-28 discovery, tools, and resources', async () => {
      const { request } = await driveServer(process.cwd());

      const discover = await request(1, 'server/discover', { _meta: modernMeta() });
      expect(discover.result).toMatchObject({
        supportedVersions: ['2026-07-28'],
        resultType: 'complete',
        ttlMs: 3_600_000,
        cacheScope: 'private',
      });

      const tools = await request(2, 'tools/list', { _meta: modernMeta() });
      expect(tools.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: 'public' });
      const listed = tools.result?.tools as Array<{ name: string; inputSchema?: { properties?: { inputs?: { items?: { properties?: Record<string, unknown> } } } }; outputSchema?: { type?: string } }>;
      expect(listed.map((tool) => tool.name)).toEqual(['ocr_capabilities', 'ocr_read_artifact', 'ocr_extract', 'ocr_run_agentic', 'ocr_web']);
      expect(listed.every((tool) => tool.outputSchema?.type === 'object')).toBe(true);
      expect(listed.find((tool) => tool.name === 'ocr_extract')?.inputSchema?.properties?.inputs?.items?.properties).toMatchObject({
        type: { const: 'path' },
        path: { type: 'string' },
      });

      const read = await request(3, 'resources/read', {
        uri: 'open-ocr://capabilities',
        _meta: modernMeta(),
      });
      expect(read.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: 'public' });
    });

    it.each([
      'tools/list',
      'resources/list',
      'resources/templates/list',
    ])('advertises %s as cacheable rather than taking the uncacheable default', async (method) => {
      const { request } = await driveServer(process.cwd());

      // SEP-2549 requires ttlMs/cacheScope on every cacheable list result, and
      // the SDK fills a method omitted from `cacheHints` with `ttlMs: 0,
      // cacheScope: 'private'`. That default is still spec-compliant, so nothing
      // fails when a method is forgotten — it just quietly tells every client
      // never to cache a catalogue fixed at build time. Only an assertion per
      // method catches that.
      const reply = await request(1, method, { _meta: modernMeta() });
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({ ttlMs: 3_600_000, cacheScope: 'public' });
    });

    it('refuses a stdin document, which would consume the JSON-RPC channel', async () => {
      const { request } = await driveServer(process.cwd());

      // Under `mcp`, stdin is the transport. A document read from it never
      // terminates, so the call used to hang forever with no response and
      // swallow the client's next requests. Both spellings must be refused, and
      // the advertised schema must say so rather than only the runtime.
      const dash = await request(1, 'tools/call', {
        name: 'ocr_extract',
        arguments: { inputs: [{ type: 'path', path: '-' }], dryRun: true, noConfig: true },
        _meta: modernMeta(),
      });
      expect(dash.result).toMatchObject({ isError: true });
      expect(JSON.stringify(dash.result)).toContain('stdin');

      // Proof the guard is not merely slow: a later request still gets served,
      // so nothing consumed the channel.
      const tools = await request(2, 'tools/list', { _meta: modernMeta() });
      expect((tools.result?.tools as unknown[]).length).toBe(5);
    });

    it('refuses an unrecognized tool argument instead of dropping it', async () => {
      const { request } = await driveServer(process.cwd());

      // A silently stripped `dryRun` turns a validation pass into a billed run,
      // which is the whole reason the schemas are strict.
      const reply = await request(1, 'tools/call', {
        name: 'ocr_extract',
        arguments: { inputs: [{ type: 'path', path: 'invoice.pdf' }], dryRunn: true },
        _meta: modernMeta(),
      });
      expect(reply.result).toMatchObject({ isError: true });
      expect(JSON.stringify(reply.result)).toContain('dryRunn');
    });

    it('bounds tool input complexity before custom-schema validation and keeps serving', async () => {
      const { request } = await driveServer(process.cwd());
      const reply = await request(1, 'tools/call', {
        name: 'ocr_extract',
        arguments: { inputs: [{ type: 'path', path: 'scan.png' }], schema: { enum: Array.from({ length: 100_001 }, (_, index) => index) }, dryRun: true },
        _meta: modernMeta(),
      });
      expect(reply.result).toMatchObject({ isError: true });
      expect(JSON.stringify(reply.result)).toContain('100000');
      expect((await request(2, 'tools/list', { _meta: modernMeta() })).error).toBeUndefined();
    });

    it('reads saved output across tool calls and exposes bounded private resources', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-mcp-read-'));
      cleanupPaths.push(directory);
      await writeFile(path.join(directory, 'scan.jpg'), JPEG_BYTES);
      const execution = await machine.executeOcrJobRequest(buildExtractMcpRequest({
        inputs: [{ type: 'path', path: 'scan.jpg' }], dryRun: true, noConfig: true,
      }), { cwd: directory, runId: 'artifact-test', abortController: new AbortController() });
      if (!('documents' in execution.result)) throw new Error('Expected a validated document');
      execution.result.documents[0].status = 'succeeded';
      const filename = path.join(directory, 'result.md');
      await writeFile(filename, 'A😀éZ');
      const largeFilename = path.join(directory, 'large.md');
      await writeFile(largeFilename, 'x'.repeat(70_000));
      execution.result.documents[0].artifacts = [
        { path: filename, mediaType: 'text/markdown', kind: 'markdown' },
        { path: largeFilename, mediaType: 'text/markdown', kind: 'markdown' },
      ];
      vi.spyOn(machine, 'executeOcrJobRequest').mockResolvedValue(execution);
      const { request } = await driveServer(directory);
      const extraction = await request(1, 'tools/call', {
        name: 'ocr_extract', arguments: { inputs: [{ type: 'path', path: 'scan.jpg' }], noConfig: true }, _meta: modernMeta(),
      });
      expect(extraction.result?.isError).toBeUndefined();
      const uri = pathToFileURL(filename).href;
      const chunk = await request(2, 'tools/call', {
        name: 'ocr_read_artifact', arguments: { uri, maxBytes: 4 }, _meta: modernMeta(),
      });
      expect(chunk.result?.structuredContent).toMatchObject({ text: 'A', nextOffset: 1, eof: false });
      const resource = await request(3, 'resources/read', { uri, _meta: modernMeta() });
      expect(resource.result).toMatchObject({ cacheScope: 'private', ttlMs: 0, contents: [{ text: 'A😀éZ' }] });
      const unauthorized = await request(4, 'resources/read', {
        uri: pathToFileURL(path.join(directory, 'scan.jpg')).href, _meta: modernMeta(),
      });
      expect(unauthorized.error).toMatchObject({ code: -32602 });
      const tooLarge = await request(5, 'resources/read', { uri: pathToFileURL(largeFilename).href, _meta: modernMeta() });
      expect(tooLarge.error?.code).toBe(-32602);
      expect(tooLarge.error?.message).toContain('ocr_read_artifact');
    });

    it('cancels the job signal and suppresses late progress while accepting later requests', async () => {
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      let cancelled!: () => void;
      const didCancel = new Promise<void>((resolve) => { cancelled = resolve; });
      vi.spyOn(machine, 'executeOcrJobRequest').mockImplementation(async (_request, options) => {
        started();
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener('abort', () => resolve(), { once: true }));
        await options.eventSink?.({ protocolVersion: 2, type: 'run.started', runId: 'cancelled', sequence: 1, timestamp: new Date().toISOString(), total: 1 });
        cancelled();
        throw options.abortController.signal.reason;
      });
      const { request, notify, notifications } = await driveServer(process.cwd());
      void request(1, 'tools/call', {
        name: 'ocr_extract', arguments: { inputs: [{ type: 'path', path: 'scan.jpg' }], noConfig: true },
        _meta: { ...modernMeta(), progressToken: 'cancelled-progress' },
      });
      await didStart;
      await notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, _meta: modernMeta() } });
      await didCancel;
      expect(notifications.filter((notification) => notification.method === 'notifications/progress')).toEqual([]);
      expect((await request(2, 'tools/list', { _meta: modernMeta() })).error).toBeUndefined();
    });

    it('relays lifecycle events as progress notifications when a token is supplied', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-mcp-progress-'));
      cleanupPaths.push(directory);
      await writeFile(path.join(directory, 'scan.jpg'), JPEG_BYTES);
      const { request, notifications } = await driveServer(directory);

      const reply = await request(1, 'tools/call', {
        name: 'ocr_extract',
        arguments: { inputs: [{ type: 'path', path: 'scan.jpg' }], dryRun: true, noConfig: true, delivery: 'inline' },
        _meta: { ...modernMeta(), progressToken: 'p1' },
      });
      expect(reply.error).toBeUndefined();

      const progress = notifications.filter((message) => message.method === 'notifications/progress');
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0].params).toMatchObject({ progressToken: 'p1', progress: 0, total: 1 });
      // Strictly increasing, as the spec requires, and bounded by the document
      // count so a client can draw it rather than watch a counter grow.
      expect(progress.every((message) => {
        const params = message.params as { progress: number; total: number };
        return params.progress <= params.total;
      })).toBe(true);
      const values = progress.map((message) => (message.params as { progress: number }).progress);
      for (let index = 1; index < values.length; index += 1) expect(values[index]).toBeGreaterThan(values[index - 1]);
      expect(values.at(-1)).toBe(1);
      expect(values.every((value) => value <= 1)).toBe(true);
    });

    it('serves capabilities as a tool and names the working directory', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-mcp-capabilities-'));
      cleanupPaths.push(directory);
      const { request } = await driveServer(directory);

      // A resource is application-driven and many hosts never show it to the
      // model; a tool is model-controlled. The working directory is what a
      // relative tool-argument path resolves against, and nothing else in the
      // revision tells the client what it is now that roots are deprecated.
      const reply = await request(1, 'tools/call', { name: 'ocr_capabilities', arguments: {}, _meta: modernMeta() });
      expect(reply.error).toBeUndefined();
      expect(reply.result?.isError).toBeUndefined();
      expect(reply.result?.structuredContent).toMatchObject({
        workingDirectory: directory,
        capabilities: { protocolVersion: 2, limits: { request: { concurrency: { min: 1, max: 16 } } } },
      });
      const discover = await request(2, 'server/discover', { _meta: modernMeta() });
      expect(discover.result?.instructions).toContain(directory);
    });

    it('carries warnings in the result rather than only on stderr', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-mcp-warnings-'));
      cleanupPaths.push(directory);
      await writeFile(path.join(directory, 'scan.jpg'), JPEG_BYTES);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { request } = await driveServer(directory);
        const reply = await request(1, 'tools/call', {
          name: 'ocr_extract',
          arguments: {
            inputs: [{ type: 'path', path: 'scan.jpg' }], mode: 'template', preset: 'invoice', detectMath: true,
            dryRun: true, noConfig: true, delivery: 'inline',
          },
          _meta: modernMeta(),
        });
        // A host may not forward stderr, and the skill tells agents not to
        // parse it; the ignored field has to be in the result the model reads.
        const structured = reply.result?.structuredContent as { warnings: string[] };
        expect(structured.warnings).toEqual([
          'ignoring option(s) that template mode does not use: extraction.detectMath',
        ]);
      } finally {
        stderr.mockRestore();
      }
    });

    it('diagnoses the removed initialize handshake instead of contradicting its revision', async () => {
      const { request } = await driveServer(process.cwd());

      const initialized = await request(1, 'initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'open-ocr-test', version: '1.0.0' },
      });
      expect(initialized.result).toBeUndefined();
      expect(initialized.error?.message).toContain('initialize handshake removed');
      expect(initialized.error).toMatchObject({
        code: -32600,
        data: {
          reason: 'legacy_initialize_removed',
          protocolRevision: '2026-07-28',
        },
      });

      const tools = await request(2, 'tools/list', { _meta: modernMeta() });
      expect(tools.error).toBeUndefined();
      expect((tools.result?.tools as unknown[]).length).toBe(5);
    });

    it('pins the reusable server factory to 2026-07-28', async () => {
      const { request } = await driveServer(process.cwd(), true);

      const initialized = await request(1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'open-ocr-test', version: '1.0.0' },
      });
      expect(initialized.result).toBeUndefined();
      expect(initialized.error).toMatchObject({
        code: -32601,
        message: 'Method not found',
      });
    });

    it('runs tool calls only through the modern envelope', async () => {
      const { request } = await driveServer(process.cwd());

      const result = await request(1, 'tools/call', {
        name: 'ocr_web',
        arguments: {
          urls: ['https://example.com/report'],
          dryRun: true,
          noConfig: true,
          delivery: 'inline',
        },
        _meta: modernMeta(),
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        resultType: 'complete',
        structuredContent: {
          type: 'run.result',
          status: 'validated',
          total: 1,
        },
      });

      const invalid = await request(2, 'tools/call', {
        name: 'ocr_extract',
        arguments: { inputs: [{ type: 'path', path: 'invoice.pdf' }], mode: 'template', dryRun: true },
        _meta: modernMeta(),
      });
      expect(invalid.result).toMatchObject({
        resultType: 'complete',
        isError: true,
        structuredContent: {
          status: 'failed',
          error: { code: 'CONFIG_INVALID' },
        },
      });
    });

    it('reports a partially failed run as a tool error', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-mcp-'));
      cleanupPaths.push(directory);
      await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
      await writeFile(path.join(directory, 'broken.png'), 'not an image');
      const { request } = await driveServer(directory);

      const result = await request(1, 'tools/call', {
        name: 'ocr_extract',
        arguments: {
          inputs: [
            { type: 'path', path: 'invoice.jpg' },
            { type: 'path', path: 'broken.png' },
          ],
          outputDirectory: path.join(directory, 'out'),
          dryRun: true,
          noConfig: true,
        },
        _meta: modernMeta(),
      });
      const structured = result.result?.structuredContent as {
        ok: boolean;
        status: string;
        documents: Array<{ status: string }>;
      };
      expect(structured.status).toBe('partial');
      expect(structured.ok).toBe(false);
      expect(result.result?.isError).toBe(true);
      expect(structured.documents.some((document) => document.status === 'failed')).toBe(true);
    });

    it('carries the confirmation through a modern multi-round-trip retry', async () => {
      vi.stubEnv('OPEN_OCR_MCP_CONFIRM', '1');
      for (const key of [
        'GEMINI_API_KEY', 'OPEN_OCR_API_KEY', 'MOONSHOT_API_KEY',
        'META_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE_AI_GATEWAY_TOKEN',
      ]) vi.stubEnv(key, '');
      const { request } = await driveServer(process.cwd());

      const asked = await request(1, 'tools/call', {
        name: 'ocr_web',
        arguments: { urls: ['https://example.com/report'], noConfig: true },
        _meta: modernMeta(),
      });
      expect(asked.result?.resultType).toBe('input_required');
      const inputRequests = asked.result?.inputRequests as Record<string, { method: string }>;
      expect(Object.keys(inputRequests)).toEqual(['proceed']);
      expect(inputRequests.proceed.method).toBe('elicitation/create');

      // The retry is a NEW request id carrying the answer, per the MRTR rules.
      const retried = await request(2, 'tools/call', {
        name: 'ocr_web',
        arguments: { urls: ['https://example.com/report'], noConfig: true },
        inputResponses: { proceed: { action: 'accept', content: { proceed: true } } },
        ...(asked.result?.requestState === undefined
          ? {}
          : { requestState: asked.result.requestState }),
        _meta: modernMeta(),
      });
      // Asked once, then ran: reaching the credential check proves the answer
      // was read on retry rather than the gate prompting again.
      expect(retried.result?.resultType).toBe('complete');
      expect(retried.result?.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'AUTH_MISSING' },
      });
    });

    it('refuses a forged confirmation without request state', async () => {
      vi.stubEnv('OPEN_OCR_MCP_CONFIRM', '1');
      const { request } = await driveServer(process.cwd());

      const forged = await request(1, 'tools/call', {
        name: 'ocr_web',
        arguments: { urls: ['https://example.com/report'], noConfig: true },
        inputResponses: { proceed: { action: 'accept', content: { proceed: true } } },
        _meta: modernMeta(),
      });
      expect(forged.result?.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });
    });

    it('binds a confirmation to the exact request and consumes it once', async () => {
      vi.stubEnv('OPEN_OCR_MCP_CONFIRM', '1');
      for (const key of [
        'GEMINI_API_KEY', 'OPEN_OCR_API_KEY', 'MOONSHOT_API_KEY',
        'META_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE_AI_GATEWAY_TOKEN',
      ]) vi.stubEnv(key, '');
      const { request } = await driveServer(process.cwd());
      const args = { urls: ['https://example.com/report'], noConfig: true };

      const asked = await request(1, 'tools/call', {
        name: 'ocr_web',
        arguments: args,
        _meta: modernMeta(),
      });
      const answer = {
        proceed: { action: 'accept', content: { proceed: true } },
      };

      const changed = await request(2, 'tools/call', {
        name: 'ocr_web',
        arguments: { ...args, urls: ['https://example.com/other'] },
        inputResponses: answer,
        requestState: asked.result?.requestState,
        _meta: modernMeta(),
      });
      expect(changed.result?.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });

      const accepted = await request(3, 'tools/call', {
        name: 'ocr_web',
        arguments: args,
        inputResponses: answer,
        requestState: asked.result?.requestState,
        _meta: modernMeta(),
      });
      expect(accepted.result?.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'AUTH_MISSING' },
      });

      const replayed = await request(4, 'tools/call', {
        name: 'ocr_web',
        arguments: args,
        inputResponses: answer,
        requestState: asked.result?.requestState,
        _meta: modernMeta(),
      });
      expect(replayed.result?.structuredContent).toMatchObject({
        ok: false,
        error: { code: 'CANCELLED' },
      });
    });

    it.each([
      ['no elicitation at all', {}],
      ['URL elicitation only', { elicitation: { url: {} } }],
    ])('answers -32021 naming form elicitation when a modern client cannot be prompted (%s)', async (
      _label,
      capabilities,
    ) => {
      vi.stubEnv('OPEN_OCR_MCP_CONFIRM', '1');
      const { request } = await driveServer(process.cwd());

      // The base protocol names this outcome: a server that needs a capability
      // the client did not declare MUST answer MissingRequiredClientCapability
      // listing it. A tool-level failure told the model to fix its arguments,
      // which is not where the problem is.
      const refused = await request(1, 'tools/call', {
        name: 'ocr_web',
        arguments: { urls: ['https://example.com/report'], noConfig: true },
        _meta: modernMeta(capabilities),
      });
      expect(refused.result).toBeUndefined();
      expect(refused.error).toMatchObject({
        code: -32021,
        data: { requiredCapabilities: { elicitation: { form: {} } } },
      });
    });

    it.each([
      ['null elicitation', { elicitation: null }],
      ['a non-object elicitation', { elicitation: 'yes' }],
      ['a non-object capabilities blob', 'capabilities'],
    ])('rejects %s at the envelope boundary, before the billed handler', async (_label, capabilities) => {
      vi.stubEnv('OPEN_OCR_MCP_CONFIRM', '1');
      const { request } = await driveServer(process.cwd());

      // Capabilities are untrusted envelope JSON in this revision, and the
      // transport — not this server — is what validates their shape. Pinning
      // that here records which layer owns the check: if it ever moves, the
      // confirmation gate starts reading unvalidated peer input, so this failing
      // is the signal to make `supportsFormElicitation` the sole guard.
      const refused = await request(1, 'tools/call', {
        name: 'ocr_web',
        arguments: { urls: ['https://example.com/report'], noConfig: true },
        _meta: modernMeta(capabilities as Record<string, unknown>),
      });
      expect(refused.error).toMatchObject({ code: -32602 });
      expect(refused.result).toBeUndefined();
    });
  });

  describe('artifact resource links', () => {
    const resultWithArtifacts = (
      artifacts: Array<{ path: string; mediaType: string; kind: string }>,
      plannedArtifacts: Array<{ path: string; mediaType: string; kind: string }> = [],
    ): OcrMachineResult => ({
      protocolVersion: 2,
      type: 'run.result',
      ok: true,
      runId: 'r1',
      status: 'succeeded',
      documents: [{ source: 'invoice.pdf', artifacts, plannedArtifacts }],
    } as unknown as OcrMachineResult);

    it('links written artifacts as resolvable file URIs alongside the JSON body', () => {
      const built = mcpResult(resultWithArtifacts([
        { path: '/runs/r1/invoice.md', mediaType: 'text/markdown', kind: 'markdown' },
        { path: '/runs/r1/invoice.json', mediaType: 'application/json', kind: 'json' },
      ]));

      // The JSON envelope stays first and unchanged; links are additive.
      expect(built.content[0]).toMatchObject({ type: 'text' });
      expect(built.content.slice(1)).toEqual([
        {
          type: 'resource_link',
          uri: 'file:///runs/r1/invoice.md',
          name: 'invoice.md',
          mimeType: 'text/markdown',
          description: 'markdown output for invoice.pdf',
        },
        {
          type: 'resource_link',
          uri: 'file:///runs/r1/invoice.json',
          name: 'invoice.json',
          mimeType: 'application/json',
          description: 'json output for invoice.pdf',
        },
      ]);
    });

    it('never links planned artifacts, which name files a dry run did not write', () => {
      const built = mcpResult(resultWithArtifacts([], [
        { path: '/runs/r1/invoice.md', mediaType: 'text/markdown', kind: 'markdown' },
      ]));
      expect(built.content).toHaveLength(1);
      expect(built.content[0]).toMatchObject({ type: 'text' });
    });

    it('emits no links for a failure envelope, which carries no documents', () => {
      const built = mcpResult({
        protocolVersion: 2,
        type: 'run.result',
        ok: false,
        runId: 'r1',
        status: 'failed',
        error: { code: 'INTERNAL', category: 'internal', message: 'boom', retryable: false, hint: 'h' },
      } as unknown as OcrMachineResult);
      // Still exactly one text block: a host that renders content only must not
      // be handed an empty response for a failure.
      expect(built.content).toHaveLength(1);
      expect(JSON.parse((built.content[0] as { text: string }).text)).toMatchObject({
        error: { code: 'INTERNAL' },
      });
    });

    it('summarises rather than mirrors the envelope when documents carry inline bodies', () => {
      const inline = {
        protocolVersion: 2,
        type: 'run.result',
        ok: true,
        runId: 'r1',
        status: 'succeeded',
        total: 1,
        succeeded: 1,
        partial: 0,
        failed: 0,
        skipped: 0,
        documents: [{
          source: 'invoice.pdf',
          artifacts: [],
          plannedArtifacts: [],
          content: { markdown: 'x'.repeat(70_000) },
        }],
      } as unknown as OcrMachineResult;
      const built = mcpResult(inline);

      // The body travels once, in structuredContent. Mirroring it into a text
      // block would put the whole corpus on the wire twice in one response.
      const text = (built.content[0] as { text: string }).text;
      expect(text).not.toContain('x'.repeat(70_000));
      expect(text).toContain('succeeded run r1');
      expect(text).toContain('structuredContent.documents[].content');
      expect(built.structuredContent).toBe(inline as unknown as Record<string, unknown>);
    });

    it('mirrors the envelope verbatim for reference delivery, which carries only metadata', () => {
      const built = mcpResult(resultWithArtifacts([
        { path: '/runs/r1/invoice.md', mediaType: 'text/markdown', kind: 'markdown' },
      ]));
      expect(JSON.parse((built.content[0] as { text: string }).text)).toMatchObject({
        runId: 'r1',
        status: 'succeeded',
      });
    });

    it('keeps small inline extraction readable to clients that use only text content', () => {
      const result = resultWithArtifacts([]);
      if (!('documents' in result)) throw new Error('Expected a document result');
      result.documents[0].content = { markdown: 'Invoice total: €14.00' };
      const built = mcpResult(result);
      expect(JSON.parse((built.content[0] as { text: string }).text)).toMatchObject({
        documents: [{ content: { markdown: 'Invoice total: €14.00' } }],
      });
    });
  });

});
