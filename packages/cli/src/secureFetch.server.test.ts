import http, { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { getDefaultAutoSelectFamily } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only name resolution and the public-address predicate are replaced, so the
// real node:http client, socket connect, and its `lookup` contract run as in
// production against a server on 127.0.0.1.
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  default: { lookup: mocks.lookup },
  lookup: mocks.lookup,
}));
vi.mock('@open-ocr/engine/urlValidation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@open-ocr/engine/urlValidation')>(),
  isPublicIpAddress: () => true,
}));

import { secureFetchPublicUrl } from './secureFetch';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let port: number;
let handler: Handler;
const sockets = new Set<Socket>();

beforeEach(async () => {
  mocks.lookup.mockReset();
  mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  handler = (_request, response) => { response.end('hello pinned'); };
  server = createServer((request, response) => handler(request, response));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Write chunks until the socket closes; resolves when it does. */
function streamForever(response: ServerResponse): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024, 120);
  return new Promise<void>((resolve) => {
    response.socket?.once('close', () => resolve());
    const pump = (): void => {
      while (!response.destroyed && response.write(chunk)) { /* fill the buffer */ }
      if (!response.destroyed) response.once('drain', pump);
    };
    pump();
  });
}

describe('secure fetch against a real local server', () => {
  it('fetches a hostname URL through the pinned lookup', async () => {
    // Node asks the lookup for every address (happy eyeballs) by default.
    expect(getDefaultAutoSelectFamily()).toBe(true);
    const result = await secureFetchPublicUrl(`http://pinned.example:${port}/page`);
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('hello pinned');
    expect(mocks.lookup).toHaveBeenCalledWith('pinned.example', { all: true, verbatim: true });
  });

  it('answers an all-addresses lookup with every validated address', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '127.0.0.2', family: 4 },
    ]);
    const request = vi.spyOn(http, 'request');
    await secureFetchPublicUrl(`http://pinned.example:${port}/page`);
    const options = request.mock.calls[0][0] as http.RequestOptions;
    const pinned = options.lookup as unknown as (
      hostname: string,
      lookupOptions: { all?: boolean },
      callback: (error: Error | null, address: unknown, family?: number) => void,
    ) => void;
    const all = vi.fn();
    pinned('pinned.example', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [
      { address: '127.0.0.1', family: 4 },
      { address: '127.0.0.2', family: 4 },
    ]);
    const single = vi.fn();
    pinned('pinned.example', {}, single);
    expect(single).toHaveBeenCalledWith(null, '127.0.0.1', 4);
  });

  it('rejects promptly with a typed error when a compressed body is cut off', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      response.write(gzipSync(Buffer.alloc(200_000, 97)).subarray(0, 100));
      setTimeout(() => response.socket?.destroy(), 20);
    };
    const started = Date.now();
    const error = await secureFetchPublicUrl(`http://pinned.example:${port}/gzip`, undefined, { totalTimeoutMs: 5_000 })
      .catch((caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(error).toMatchObject({ code: 'INPUT_INVALID', retryable: true });
    expect((error as Error).message).not.toContain('total time limit');
  });

  it('rejects promptly when an uncompressed body is cut off', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      response.write('partial');
      setTimeout(() => response.socket?.destroy(), 20);
    };
    const error = await secureFetchPublicUrl(`http://pinned.example:${port}/plain`, undefined, { totalTimeoutMs: 5_000 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INPUT_INVALID', retryable: true });
    expect((error as Error).message).not.toContain('total time limit');
  });

  it.each([
    ['a redirect', 302],
    ['an error', 404],
  ])('stops reading %s body with no end once the fetch settles', async (_label, status) => {
    let drained: Promise<void> = Promise.resolve();
    handler = (request, response) => {
      if (request.url === '/page') {
        response.end('hello pinned');
        return;
      }
      response.writeHead(status, { location: '/page', 'content-type': 'text/plain' });
      drained = streamForever(response);
    };
    await secureFetchPublicUrl(`http://pinned.example:${port}/forever`).catch(() => undefined);
    const closed = await Promise.race([
      drained.then(() => 'closed'),
      new Promise<string>((resolve) => { setTimeout(() => resolve('still streaming'), 500); }),
    ]);
    expect(closed).toBe('closed');
  });

  it('types an unresolvable host as a permanent input error', async () => {
    mocks.lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' }));
    await expect(secureFetchPublicUrl('http://nowhere.example/page'))
      .rejects.toMatchObject({ code: 'INPUT_INVALID', category: 'input', retryable: false });
  });

  it('types a refused connection as a retryable input error', async () => {
    const closedPort = port;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await expect(secureFetchPublicUrl(`http://pinned.example:${closedPort}/page`))
      .rejects.toMatchObject({ code: 'INPUT_INVALID', retryable: true, message: expect.stringContaining('ECONNREFUSED') as unknown });
  });

  it('types an unparsable redirect Location as a permanent input error', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: 'http://[::1' });
      response.end();
    };
    await expect(secureFetchPublicUrl(`http://pinned.example:${port}/bad-redirect`))
      .rejects.toMatchObject({ code: 'INPUT_INVALID', retryable: false, message: expect.stringContaining('invalid Location') as unknown });
  });

  it('still reports a caller cancellation as the caller\'s own abort', async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = secureFetchPublicUrl(`http://pinned.example:${port}/stalled`, controller.signal);
    setTimeout(() => controller.abort(new Error('caller cancelled')), 50);
    await expect(pending).rejects.toThrow('caller cancelled');
  });
});
