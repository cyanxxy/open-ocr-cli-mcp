/**
 * Node runtime contract: Node's built-in fetch honors the undici-7 global
 * dispatcher the CLI installs, so only the document deadline cuts a request.
 * Bun's fetch is its own and ignores undici dispatchers. Files named
 * *.node.test.ts run on Node only; bun test skips them by name and CI runs
 * them under Vitest on Node.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { installFetchDispatcher } from './providerRuntime';

const original = getGlobalDispatcher();
let server: Server | undefined;

afterEach(async () => {
  setGlobalDispatcher(original);
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe('process-wide fetch dispatcher', () => {
  it('lifts the fetch headers and body timeouts so only the document deadline cuts a request', async () => {
    // Headers arrive only after a delay, like a non-streaming completion.
    server = createServer((_request, response) => { setTimeout(() => response.end('generated'), 1_200); });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    // Node's fetch honours the undici global dispatcher: a short headers
    // timeout cuts the call...
    setGlobalDispatcher(new Agent({ headersTimeout: 200, bodyTimeout: 200 }));
    const cut = await fetch(url).then(() => undefined, (error: unknown) => error as { cause?: { code?: string } });
    expect(cut?.cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');

    // ...and the installed one waits for as long as the caller's signal allows.
    installFetchDispatcher();
    const dispatcher = getGlobalDispatcher();
    expect(dispatcher).toBeInstanceOf(Agent);
    const options = Object.getOwnPropertySymbols(dispatcher)
      .filter((symbol) => symbol.description === 'options')
      .map((symbol) => (dispatcher as unknown as Record<symbol, Record<string, unknown>>)[symbol])[0];
    expect(options).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
    await expect((await fetch(url)).text()).resolves.toBe('generated');
  });
});
