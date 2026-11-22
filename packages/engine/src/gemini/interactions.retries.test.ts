import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createProviderExecutionContext } from '../providers/runtime';
import { providerRetryAfterMs } from '../providers/retry';
import { classifyGeminiQuotaError } from './client';
import { runModelInteraction } from './interactions';

// Real @google/genai Interactions bridge against a local server: retry policy
// is the SDK's, so it can only be observed on the wire.

const PER_MINUTE_429 = JSON.stringify({
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' },
    ],
  },
});
const DAILY_429 = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota. limit: 0',
    status: 'RESOURCE_EXHAUSTED',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
    }],
  },
});
const UNAVAILABLE_503 = JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } });

let server: Server;
let baseUrl = '';
let hits = 0;
let reply: { status: number; body: string } = { status: 429, body: PER_MINUTE_429 };

beforeAll(async () => {
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    request.on('end', () => {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
});

async function failedInteraction(streaming: boolean) {
  const runtime = createProviderExecutionContext();
  const error = await runModelInteraction({
    apiKey: 'AIzaRetryProbeKey123456',
    model: 'gemini-3.8-flash',
    baseUrl,
    input: 'Extract',
    runtime,
    ...(streaming ? { onProgress: () => undefined } : {}),
  }).then(() => undefined, (caught: unknown) => caught);
  return { error, runtime };
}

describe('Interactions SDK retries are disabled', () => {
  it.each([
    ['per-minute 429', 429, PER_MINUTE_429],
    ['daily 429', 429, DAILY_429],
    ['503', 503, UNAVAILABLE_503],
  ] as const)('sends exactly one request for a %s, unary and streaming', async (_label, status, body) => {
    reply = { status, body };
    for (const streaming of [false, true]) {
      hits = 0;
      const { error, runtime } = await failedInteraction(streaming);
      expect(error, `streaming=${streaming}`).toBeInstanceOf(Error);
      expect(hits, `streaming=${streaming}`).toBe(1);
      expect(runtime.getUsage().requests, `streaming=${streaming}`).toBe(hits);
    }
  });

  it('keeps the server retry delay and quota verdict on the thrown error', async () => {
    reply = { status: 429, body: PER_MINUTE_429 };
    const { error } = await failedInteraction(false);
    expect(providerRetryAfterMs(error)).toBe(30_000);
    expect(classifyGeminiQuotaError(error)).toBe('retryable');

    reply = { status: 429, body: DAILY_429 };
    const daily = await failedInteraction(true);
    expect(classifyGeminiQuotaError(daily.error)).toBe('terminal');
  });
});
