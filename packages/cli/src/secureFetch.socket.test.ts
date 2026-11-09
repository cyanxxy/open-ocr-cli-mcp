import { once } from 'node:events';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Real sockets, real `http.request`: only DNS and the public-address policy are
// stubbed so a loopback server can stand in for a public host. The unit tests
// in secureFetch.test.ts mock `http.request`, which hid that Node >= 20 calls a
// custom lookup with `{ all: true }` and rejects a single-address answer.
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  default: { lookup: mocks.lookup },
  lookup: mocks.lookup,
}));
vi.mock('@open-ocr/engine/urlValidation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-ocr/engine/urlValidation')>();
  return { ...actual, isPublicIpAddress: () => true };
});

import { secureFetchPublicUrl } from './secureFetch';

let server: Server | undefined;

async function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    server.close();
    server = undefined;
  }
  mocks.lookup.mockReset();
});

describe('secure URL fetching over real sockets', () => {
  it('fetches a hostname URL through the pinned lookup', async () => {
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const port = await listen((request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end(`host=${request.headers.host}`);
    });

    const result = await secureFetchPublicUrl(`http://documents.example:${port}/note.txt`);

    expect(Buffer.from(result.bytes).toString('utf8')).toBe(`host=documents.example:${port}`);
    expect(result.contentType).toBe('text/plain');
  });
});
