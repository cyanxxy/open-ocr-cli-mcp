import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedCliOptions } from './types';

const mocks = vi.hoisted(() => ({ secureFetch: vi.fn() }));

vi.mock('./secureFetch', () => ({ secureFetchPublicUrl: mocks.secureFetch }));

import { runWebExtraction, runWebJob } from './web';

function heicBytes(): Uint8Array {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('heic', 8, 'ascii');
  bytes.write('mif1', 16, 'ascii');
  return Uint8Array.from(bytes);
}

function options(): ResolvedCliOptions {
  return {
    provider: 'openrouter',
    gateway: 'direct',
    outputPathKind: 'auto',
    apiKey: 'secret',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: 'moonshotai/kimi-k2.6',
    baseUrl: 'https://openrouter.ai/api/v1',
    cloudflareByok: false,
    thinking: 'HIGH',
    includeThoughts: false,
    progress: 'standard',
    mode: 'simple',
    format: 'markdown',
    concurrency: 2,
    retries: 0,
    timeoutSeconds: 120,
    maxFiles: 20,
    maxTotalMb: 100,
    excludes: [],
    instructions: [],
    hidden: false,
    defaultExcludes: true,
    resume: true,
    overwrite: false,
    forceUnlock: false,
    failFast: false,
    jsonl: false,
    dryRun: false,
    quiet: false,
    verbose: false,
    stdinName: 'stdin',
    detectImages: false,
    detectMath: false,
    maxTokens: 32768,
    maxIterations: 5,
    confidenceThreshold: 0.85,
    requestsPerMinute: 0,
    cwd: '/workspace',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.secureFetch.mockReset();
});

describe('compatible-provider Web OCR', () => {
  it('runs URL extraction through the shared job lifecycle and usage context', async () => {
    const url = 'https://example.com/article';
    mocks.secureFetch.mockResolvedValueOnce({
      url,
      contentType: 'text/html',
      bytes: new TextEncoder().encode('<main><h1>Quarterly report</h1><p>Revenue 42</p></main>'),
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ results: [{ url, type: 'webpage', content: 'Revenue 42' }] }) },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    const events: string[] = [];

    const execution = await runWebJob([url], 'individual', options(), {
      runId: 'web-service-run',
      abortController: new AbortController(),
      deliveryMode: 'inline',
      eventSink: (event) => {
        events.push(event.type);
      },
    });

    expect(execution.result).toMatchObject({
      status: 'succeeded',
      total: 1,
      usage: { requests: 1, totalTokens: 15 },
      documents: [{
        status: 'succeeded',
        content: { markdown: expect.stringContaining('Revenue 42') as unknown },
      }],
    });
    expect(events).toEqual([
      'run.started',
      'document.started',
      'document.completed',
      'run.completed',
    ]);
  });

  it.each([
    ['image/gif', 'https://example.com/animation.gif'],
    ['application/octet-stream', 'https://example.com/download'],
  ])('accepts GIF bytes fetched as %s', async (contentType, url) => {
    mocks.secureFetch.mockResolvedValueOnce({
      url,
      contentType,
      bytes: new TextEncoder().encode('GIF89a'),
    });
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ results: [{ url, type: 'image', content: 'ok' }] }) },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runWebExtraction(
      [url],
      'individual',
      options(),
      new AbortController().signal,
    )).resolves.toMatchObject({ results: [{ url, type: 'image', content: 'ok' }] });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(typeof init?.body === 'string' ? init.body : '').toContain('data:image/gif;base64,');
  });

  it('rejects a fetched image MIME type that the selected provider profile does not accept', async () => {
    mocks.secureFetch.mockResolvedValueOnce({
      url: 'https://example.com/photo.heic',
      contentType: 'image/heic',
      bytes: heicBytes(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runWebExtraction(
      ['https://example.com/photo.heic'],
      'individual',
      options(),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'INPUT_INVALID',
      message: expect.stringContaining('not image/heic') as unknown,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects fetched media whose bytes do not match the declared supported MIME type', async () => {
    mocks.secureFetch.mockResolvedValueOnce({
      url: 'https://example.com/disguised.png',
      contentType: 'image/png',
      bytes: heicBytes(),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runWebExtraction(
      ['https://example.com/disguised.png'],
      'individual',
      options(),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'INPUT_INVALID',
      message: expect.stringContaining('does not match its declared type') as unknown,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects declared, unknown, or text-mislabeled video instead of decoding it as webpage text', async () => {
    const mp4 = Buffer.alloc(20);
    mp4.writeUInt32BE(mp4.length, 0);
    mp4.write('ftyp', 4, 'ascii');
    mp4.write('isom', 8, 'ascii');
    mp4.write('mp42', 16, 'ascii');
    mocks.secureFetch
      .mockResolvedValueOnce({
        url: 'https://example.com/clip.mp4',
        contentType: 'video/mp4',
        bytes: Uint8Array.from(mp4),
      })
      .mockResolvedValueOnce({
        url: 'https://example.com/download',
        contentType: 'application/octet-stream',
        bytes: Uint8Array.from(mp4),
      })
      .mockResolvedValueOnce({
        url: 'https://example.com/disguised.txt',
        contentType: 'text/plain',
        bytes: Uint8Array.from(mp4),
      });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(runWebExtraction(
      ['https://example.com/clip.mp4'],
      'individual',
      options(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(runWebExtraction(
      ['https://example.com/download'],
      'individual',
      options(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(runWebExtraction(
      ['https://example.com/disguised.txt'],
      'individual',
      options(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('combines HTML, image, and PDF sources in one grounded provider request', async () => {
    const urls = [
      'https://example.com/article',
      'https://example.com/chart.png',
      'https://example.com/report.pdf',
    ];
    mocks.secureFetch
      .mockResolvedValueOnce({
        url: urls[0],
        contentType: 'text/html',
        bytes: new TextEncoder().encode('<main><h1>Market &amp; Sales</h1><p>Revenue: 42</p></main>'),
      })
      .mockResolvedValueOnce({
        url: urls[1],
        contentType: 'image/png',
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      })
      .mockResolvedValueOnce({
        url: urls[2],
        contentType: 'application/octet-stream',
        bytes: new TextEncoder().encode('%PDF-1.7'),
      });
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { content: JSON.stringify({ results: urls.map((url) => ({ url, type: 'unknown', content: 'ok' })) }) },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWebExtraction(urls, 'individual', options(), new AbortController().signal);

    expect(result.results).toHaveLength(3);
    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('MARKET & SALES');
    expect(serialized).toContain('image_url');
    expect(serialized).toContain('file_data');
    expect(body.plugins).toEqual([{ id: 'file-parser' }]);
  });
});
