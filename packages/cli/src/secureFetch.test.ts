import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: { lookup: mocks.lookup },
  lookup: mocks.lookup,
}));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    default: { request: mocks.request },
    request: mocks.request,
  };
});

import { secureFetchPublicUrl } from './secureFetch';

interface ResponseFixture {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  defer?: boolean;
}

const fixtures: ResponseFixture[] = [];
const requestOptions: Array<Record<string, unknown>> = [];
const timeoutCallbacks: Array<() => void> = [];

beforeEach(() => {
  fixtures.length = 0;
  requestOptions.length = 0;
  timeoutCallbacks.length = 0;
  mocks.lookup.mockReset();
  mocks.request.mockReset();
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockImplementation((options: Record<string, unknown>, callback: (response: PassThrough) => void) => {
    const fixture = fixtures.shift();
    if (!fixture) throw new Error('Missing HTTP fixture');
    requestOptions.push(options);
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => void;
      setTimeout: (milliseconds: number, callback: () => void) => void;
    };
    request.setTimeout = vi.fn((_milliseconds: number, callback: () => void) => {
      timeoutCallbacks.push(callback);
    });
    request.end = (): void => {
      if (fixture.defer) return;
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = fixture.status;
        response.headers = fixture.headers ?? {};
        callback(response);
        response.end(fixture.body ?? '');
      });
    };
    request.destroy = (error?: Error): void => {
      if (error) request.emit('error', error);
      request.emit('close');
    };
    return request;
  });
});

describe('secure public URL fetching', () => {
  it('rejects a hostname when any DNS answer is private before opening a socket', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);

    await expect(secureFetchPublicUrl('http://documents.example/report.pdf'))
      .rejects.toThrow('does not resolve exclusively to public addresses');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('pins the validated DNS answer and decodes a compressed response', async () => {
    fixtures.push({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' },
      body: gzipSync('invoice total: 42.00'),
    });

    const result = await secureFetchPublicUrl('http://documents.example/invoice.txt');

    expect(Buffer.from(result.bytes).toString('utf8')).toBe('invoice total: 42.00');
    expect(result.contentType).toBe('text/plain');
    expect(result.url).toBe('http://documents.example/invoice.txt');
    const pinnedLookup = requestOptions[0].lookup as (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    const callback = vi.fn();
    pinnedLookup('documents.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect((requestOptions[0].headers as Record<string, string>)['User-Agent'])
      .toBe('open-ocr-cli (+https://github.com/cyanxxy/open-ocr-cli-mcp)');
    const createdRequest = mocks.request.mock.results[0].value as { setTimeout: ReturnType<typeof vi.fn> };
    expect(createdRequest.setTimeout).toHaveBeenCalledWith(30_000, expect.any(Function));
  });

  it('revalidates redirect DNS and blocks redirects into a private network', async () => {
    fixtures.push({ status: 302, headers: { location: 'http://internal.example/secret' } });
    mocks.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }]);

    await expect(secureFetchPublicUrl('http://documents.example/start'))
      .rejects.toThrow('does not resolve exclusively to public addresses');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('destroys a peer that remains idle at the socket layer', async () => {
    fixtures.push({ status: 200, defer: true });

    const pending = secureFetchPublicUrl('http://documents.example/stalled');
    await vi.waitFor(() => expect(timeoutCallbacks).toHaveLength(1));
    timeoutCallbacks[0]();

    await expect(pending).rejects.toThrow('idle for 30 seconds');
  });

  it('rejects hexadecimal IPv4-mapped DNS answers before opening a socket', async () => {
    mocks.lookup.mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }]);

    await expect(secureFetchPublicUrl('http://documents.example/secret'))
      .rejects.toThrow('does not resolve exclusively to public addresses');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared response before reading the body', async () => {
    fixtures.push({
      status: 200,
      headers: { 'content-length': String(11 * 1024 * 1024) },
    });

    await expect(secureFetchPublicUrl('http://documents.example/large.pdf'))
      .rejects.toThrow('response exceeds 10 MB');
  });

  it('rejects non-success responses without treating the body as OCR input', async () => {
    fixtures.push({ status: 404, body: 'not found' });

    await expect(secureFetchPublicUrl('http://documents.example/missing'))
      .rejects.toThrow('returned HTTP 404');
  });
});
