import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetProviderRequestPolicy } from './requestPolicy';
import {
  createChatCompletion,
  documentContentParts,
  extractKimiFileContent,
  isRetryableProviderError,
  ProviderApiError,
} from './openaiCompatible';
import { createProviderExecutionContext, ProviderCostLimitError } from './runtime';
import type { ProviderRuntimeConfig } from './types';
import { getProviderUsage, resetProviderUsage } from './usage';

// Derived from the ambient `fetch` rather than the DOM `RequestInfo`: this
// engine is typechecked without DOM libs (packages/engine/tsconfig.json).
type FetchInput = Parameters<typeof fetch>[0];

function config(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    provider: 'kimi',
    gateway: 'direct',
    apiKey: 'secret',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    model: 'kimi-k2.6',
    baseUrl: 'https://api.moonshot.ai/v1',
    thinkingConfig: { level: 'HIGH', includeThoughts: true },
    ...overrides,
  };
}

beforeEach(() => {
  resetProviderUsage();
  resetProviderRequestPolicy();
});

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI-compatible transport', () => {
  it('uses the Kimi K3 default effort for callers without a thinking override', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    await createChatCompletion(config({ model: 'kimi-k3', thinkingConfig: undefined }), {
      messages: [{ role: 'user', content: 'Extract' }], maxTokens: 1024,
    });
    const wireBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof wireBody !== 'string') throw new Error('Expected JSON request body');
    const body = JSON.parse(wireBody) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('max');
  });

  it('supports Muse 1.3 max and rejects unsupported current model efforts before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = { messages: [{ role: 'user' as const, content: 'Extract' }], maxTokens: 1024 };
    await createChatCompletion(config({ provider: 'muse', model: 'muse-spark-1.3', thinkingConfig: { level: 'MAX' } }), request);
    const wireBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof wireBody !== 'string') throw new Error('Expected JSON request body');
    const body = JSON.parse(wireBody) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('max');
    await expect(createChatCompletion(config({
      provider: 'muse', model: 'muse-spark-1.3-contributor', thinkingConfig: { level: 'MAX' },
    }), request)).rejects.toThrow('received max');
    await expect(createChatCompletion(config({
      provider: 'openrouter', model: 'google/gemini-3.8-flash', thinkingConfig: { level: 'MINIMAL' },
    }), request)).rejects.toThrow('received minimal');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['moonshotai/kimi-k2.7-code', 'HIGH', true],
    ['moonshotai/kimi-k2.6', 'HIGH', true],
    ['moonshotai/kimi-k2.6', 'MINIMAL', false],
  ] as const)('uses the reasoning toggle for %s %s', async (model, level, enabled) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    await createChatCompletion(config({ provider: 'openrouter', model, thinkingConfig: { level } }), {
      messages: [{ role: 'user', content: 'Extract' }], maxTokens: 1024,
    });
    const wireBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof wireBody !== 'string') throw new Error('Expected JSON request body');
    expect(JSON.parse(wireBody) as unknown).toMatchObject({ reasoning: { enabled, exclude: false } });
  });

  it.each([undefined, 'budget_exceeded', 'paused'])('rejects unconfirmed completion %s from a generic endpoint', async (finishReason) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: 'partial' } }],
    })));
    await expect(createChatCompletion(config({ provider: 'openai-compatible', model: 'local-vision' }), {
      messages: [{ role: 'user', content: 'Extract' }], maxTokens: 1024,
    })).rejects.toThrow('finish reason');
  });

  it('rejects tool-call completion without the corresponding calls', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Inspecting...' } }],
    })));
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }], maxTokens: 1024,
    })).rejects.toThrow('returned no tool calls');
  });

  it('rejects streamed choice errors and preserves usage carried on that choice', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      `data: ${JSON.stringify({ choices: [{ error: { message: 'upstream unavailable', code: 'UNAVAILABLE' }, usage: { prompt_tokens: 8, completion_tokens: 2 }, delta: { content: 'partial' }, finish_reason: 'stop' }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )));
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }], maxTokens: 1024, onDelta: () => undefined,
    })).rejects.toThrow('upstream unavailable');
    expect(getProviderUsage()).toMatchObject({ inputTokens: 8, outputTokens: 2, requests: 1 });
  });
  it('uses Kimi K3 current token and reasoning fields', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({
      model: 'kimi-k3',
      thinkingConfig: { level: 'MAX', includeThoughts: true },
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 131_072,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ reasoning_effort: 'max', max_completion_tokens: 131_072 });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it.each([
    ['LOW', 'low'],
    ['HIGH', 'high'],
    ['MAX', 'max'],
  ] as const)('maps OpenRouter Kimi K3 %s to reasoning effort %s', async (level, effort) => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      baseUrl: 'https://openrouter.ai/api/v1',
      thinkingConfig: { level, includeThoughts: true },
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 131_072,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({ reasoning: { effort, exclude: false } });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('fails closed when a Kimi K3 transport caller bypasses CLI effort validation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createChatCompletion(config({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3:exacto',
      baseUrl: 'https://openrouter.ai/api/v1',
      thinkingConfig: { level: 'MEDIUM', includeThoughts: true },
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 131_072,
    })).rejects.toThrow('must be low, high, or max');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only image fields documented by each compatible provider', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    await expect(documentContentParts(config(), dataUrl, 'image/png', 'invoice.png')).resolves.toEqual([{
      type: 'image_url',
      image_url: { url: dataUrl },
    }]);
    await expect(documentContentParts(config({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    }), dataUrl, 'image/png', 'invoice.png')).resolves.toEqual([{
      type: 'image_url',
      image_url: { url: dataUrl, detail: 'high' },
    }]);
    await expect(documentContentParts(config({
      provider: 'muse',
      baseUrl: 'https://api.meta.ai/v1',
    }), dataUrl, 'image/png', 'invoice.png')).resolves.toEqual([{
      type: 'image_url',
      image_url: { url: dataUrl },
    }]);
    await expect(documentContentParts(config({
      provider: 'muse',
      baseUrl: 'https://api.meta.ai/v1',
    }), 'data:application/pdf;base64,JVBERi0=', 'application/pdf', 'invoice.pdf')).resolves.toEqual([{
      type: 'file',
      file: { filename: 'invoice.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
    }]);
  });

  it('deletes uploaded Kimi files even when extraction reaches the job cost ceiling', async () => {
    const runtime = createProviderExecutionContext({ maxCostUsd: 0.001 });
    const fetchMock = vi.fn((_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'file-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      runtime.recordUsage({ usage: { prompt_tokens: 1, total_tokens: 1, cost: 0.001 } });
      return Promise.resolve(new Response('extracted text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractKimiFileContent(
      config({ runtime }),
      'data:application/pdf;base64,JVBERg==',
      'invoice.pdf',
    )).resolves.toBe('extracted text');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    await expect(runtime.waitForRequestSlot()).rejects.toBeInstanceOf(ProviderCostLimitError);
  });

  it('starts the Kimi DELETE timeout after waiting for a low-rate request slot', async () => {
    const runtime = createProviderExecutionContext({ requestsPerMinute: 6 });
    const waitForRequestSlot = vi.spyOn(runtime, 'waitForRequestSlot');
    const fetchMock = vi.fn((_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ id: 'file-slow-rate' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response('extracted text', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    try {
      const extraction = extractKimiFileContent(
        config({ runtime }),
        'data:application/pdf;base64,JVBERg==',
        'invoice.pdf',
      );
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(extraction).resolves.toBe('extracted text');
      expect(waitForRequestSlot).toHaveBeenCalledTimes(3);
      expect(waitForRequestSlot.mock.calls[2]?.[0]).toBeUndefined();
      expect(waitForRequestSlot.mock.calls[2]?.[1]).toEqual({ ignoreCostLimit: true });
      expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
      const deleteSignal = fetchMock.mock.calls[2]?.[1]?.signal;
      expect(deleteSignal).toBeInstanceOf(AbortSignal);
      expect(deleteSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('streams reasoning, output, tools, and usage while preserving the assistant replay', async () => {
    const details = [
      { type: 'reasoning.text', text: 'inspect ', id: 'reason-1' },
      { type: 'reasoning.text', text: 'totals', id: 'reason-2' },
    ];
    const annotations = [{ type: 'file', file: { hash: 'pdf-hash', content: [] } }];
    const sse = [
      { choices: [{ delta: { reasoning_content: 'inspect ', reasoning_details: [details[0]], annotations } }] },
      { choices: [{ delta: { reasoning_content: 'totals', reasoning_details: [details[1]] } }] },
      { choices: [{ delta: { content: 'Working. ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'inspect', arguments: '{"region":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'inspect', arguments: '"totals"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.001 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: Array<{ kind: string; text: string }> = [];
    const userMessage = { role: 'user' as const, content: 'Inspect this' };

    const streamed = await createChatCompletion(config({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      baseUrl: 'https://openrouter.ai/api/v1',
    }), {
      messages: [userMessage],
      maxTokens: 1000,
      tools: [{
        type: 'function',
        function: { name: 'inspect', parameters: { type: 'object' } },
      }],
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual([
      { kind: 'reasoning', text: 'inspect ' },
      { kind: 'reasoning', text: 'totals' },
      { kind: 'model_output', text: 'Working. ' },
    ]);
    expect(streamed.message).toMatchObject({
      content: 'Working. ',
      reasoning_content: 'inspect totals',
      reasoning_details: details,
      providerFields: { annotations },
      tool_calls: [{
        id: 'call-1',
        function: { name: 'inspect', arguments: '{"region":"totals"}' },
      }],
    });
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 14, estimatedCostUsd: 0.001 });
    const firstInit = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(firstInit?.headers).get('accept')).toBe('text/event-stream');
    if (typeof firstInit?.body !== 'string') throw new Error('Expected a JSON request body');
    const firstBody = JSON.parse(firstInit.body) as Record<string, unknown>;
    expect(firstBody.parallel_tool_calls).toBe(false);
    expect(firstBody).not.toHaveProperty('stream_options');

    await createChatCompletion(config({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      baseUrl: 'https://openrouter.ai/api/v1',
    }), {
      messages: [
        userMessage,
        streamed.message,
        { role: 'tool', tool_call_id: 'call-1', name: 'inspect', content: '{"ok":true}' },
      ],
      maxTokens: 1000,
    });
    const replayInit = fetchMock.mock.calls[1]?.[1];
    if (typeof replayInit?.body !== 'string') throw new Error('Expected a JSON request body');
    const replay = JSON.parse(replayInit.body) as { messages: Array<Record<string, unknown>> };
    expect(replay.messages[1]).toEqual(streamed.message.providerMessage);
  });

  it('records streamed usage before rejecting an incomplete response', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'truncated' }, finish_reason: 'length' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('output token limit');
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 5 });
  });

  it('parses multiline Kimi SSE data blocks', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"multi"},',
      '"finish_reason":"stop"}]}',
      '',
      'data: {"choices":[{"delta":{},"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).resolves.toMatchObject({ text: 'multi', finishReason: 'stop' });
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 3 });
  });

  it('requests terminal stream usage only from providers that still document the flag', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('rejects a stream that ends without a terminal finish reason', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'possibly truncated' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('without a terminal finish reason');
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 4 });
  });

  it('fails closed on missing or explicit error finish reasons from named providers', async () => {
    const missingFinish = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'possibly truncated' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', missingFinish);
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
    })).rejects.toThrow('omitted its terminal finish reason');

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'error', message: { role: 'assistant', content: 'partial' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
    })).rejects.toThrow('finish reason error');
  });

  it('preserves canonical errors embedded in a successful OpenRouter response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'error',
        error: {
          message: 'provider is overloaded',
          metadata: { error_type: 'provider_overloaded' },
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))));

    await expect(createChatCompletion(config({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    }), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
    })).rejects.toMatchObject({
      name: 'ProviderApiError',
      code: 'provider_overloaded',
    });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: {
        message: 'router is unavailable',
        metadata: { error_type: 'provider_unavailable' },
      },
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    await expect(createChatCompletion(config({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    }), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
    })).rejects.toMatchObject({
      name: 'ProviderApiError',
      code: 'provider_unavailable',
    });
  });

  it('rejects a Kimi stream that has a finish reason but no DONE marker', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'possibly truncated' }, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`,
    ].join('');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('without the terminal [DONE] marker');
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 4 });
  });

  it('records usage reported before a streamed provider error', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
      `data: ${JSON.stringify({ error: { code: 500, message: 'stream failed' } })}\n\n`,
    ].join('');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('stream failed');
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 3 });
  });

  it('preserves current streaming error codes and retries transient codes', async () => {
    const sse = `data: ${JSON.stringify({
      error: { code: 'RESOURCE_EXHAUSTED', message: 'capacity exhausted' },
    })}\n\n`;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    let thrown: unknown;
    try {
      await createChatCompletion(config(), {
        messages: [{ role: 'user', content: 'Extract' }],
        maxTokens: 10,
        onDelta: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'ProviderApiError',
      code: 'RESOURCE_EXHAUSTED',
      message: 'capacity exhausted',
    });
    expect(isRetryableProviderError(thrown)).toBe(true);
    expect(isRetryableProviderError(
      new ProviderApiError('bad key', 401, 'UNAUTHENTICATED'),
    )).toBe(false);
    expect(isRetryableProviderError(
      new ProviderApiError('balance depleted', 429, 'exceeded_current_quota_error'),
    )).toBe(false);
    expect(isRetryableProviderError(
      new ProviderApiError('engine busy', 429, 'engine_overloaded_error'),
    )).toBe(true);
    expect(isRetryableProviderError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableProviderError(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });

  it('cancels the response reader after a streaming protocol failure', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {not-json}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('invalid streaming JSON');
    expect(cancelled).toBe(true);
  });

  it('rejects malformed streamed tool calls instead of inventing correlation IDs', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'inspect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));

    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('without an ID');
  });

  it('rejects duplicate tool-call IDs in complete and streamed responses', async () => {
    const duplicateCalls = [
      { id: 'duplicate', type: 'function', function: { name: 'first', arguments: '{}' } },
      { id: 'duplicate', type: 'function', function: { name: 'second', arguments: '{}' } },
    ];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: duplicateCalls },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
    })).rejects.toThrow('duplicate tool-call ID');

    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [duplicateCalls[0]] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ ...duplicateCalls[1], index: 1 }] }, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toThrow('duplicate tool-call ID');
  });

  it('preserves Kimi reasoning content and records OpenAI usage', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'done', reasoning_content: 'checked the fields' },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 1000,
    });

    expect(result.message.reasoning_content).toBe('checked the fields');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer secret');
    if (typeof request.body !== 'string') throw new Error('Expected a string request body');
    expect(JSON.parse(request.body) as unknown).toMatchObject({
      model: 'kimi-k2.6',
      thinking: { type: 'enabled', keep: 'all' },
      max_completion_tokens: 1000,
    });
    expect(JSON.parse(request.body)).not.toHaveProperty('max_tokens');
    expect(getProviderUsage()).toMatchObject({
      requests: 1,
      inputTokens: 100,
      outputTokens: 20,
      thoughtTokens: 5,
      totalTokens: 120,
    });
  });

  it('preserves Muse minimal effort instead of silently upgrading it', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({
      provider: 'muse',
      model: 'muse-spark-1.1',
      baseUrl: 'https://api.meta.ai/v1',
      thinkingConfig: { level: 'MINIMAL' },
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 1000,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      reasoning_effort: 'minimal',
      max_tokens: 1000,
    });
    expect(JSON.parse(init.body)).not.toHaveProperty('max_completion_tokens');
  });

  it('uses the token field supported by the default local endpoint', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({
      provider: 'openai-compatible',
      model: 'local-model',
      baseUrl: 'http://localhost:11434/v1',
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 1000,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({ max_tokens: 1000 });
    expect(JSON.parse(init.body)).not.toHaveProperty('max_completion_tokens');
  });

  it.each([
    ['kimi', 'kimi-k3', 'https://api.moonshot.ai/v1'],
    ['openrouter', 'google/gemini-3.5-flash', 'https://openrouter.ai/api/v1'],
  ] as const)('sends the output cap as max_completion_tokens on %s', async (provider, model, baseUrl) => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({ provider, model, baseUrl }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 1000,
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    // Both routes deprecate `max_tokens`. Sending only the deprecated spelling
    // risks the cap being ignored, which turns a bounded run into an unbounded
    // billed one, so the field is pinned rather than left to the transport.
    expect(JSON.parse(init.body)).toMatchObject({ max_completion_tokens: 1000 });
    expect(JSON.parse(init.body)).not.toHaveProperty('max_tokens');
  });

  it('uses Cloudflare gateway authentication and omits provider auth in BYOK mode', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({
      provider: 'openrouter',
      gateway: 'cloudflare',
      model: 'moonshotai/kimi-k2.6',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/a/g/openrouter',
      gatewayToken: 'gateway-secret',
      cloudflareByok: true,
      cloudflareByokAlias: 'router-key',
    }), {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    });

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cf-aig-authorization')).toBe('Bearer gateway-secret');
    expect(headers.get('cf-aig-byok-alias')).toBe('router-key');
  });

  it('uses the current OpenRouter reasoning shape and preserves reasoning details', async () => {
    const reasoningDetails = [{ type: 'reasoning.text', text: 'inspect totals', id: 'reason-1' }];
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          reasoning: 'inspect totals',
          reasoning_details: reasoningDetails,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'extract_fields_batch', arguments: '{"fields":[]}' },
          }],
        },
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createChatCompletion(config({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      thinkingConfig: { level: 'MINIMAL', includeThoughts: true },
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 1000,
    });

    expect(result.message).toMatchObject({
      reasoning: 'inspect totals',
      reasoning_details: reasoningDetails,
    });
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    if (typeof request.body !== 'string') throw new Error('Expected a string request body');
    expect(JSON.parse(request.body) as unknown).toMatchObject({
      reasoning: { enabled: false, exclude: false },
    });
    expect(new Headers(request.headers).get('http-referer')).toBe('https://github.com/cyanxxy/open-ocr-cli-mcp');
    // cost:0 with known Kimi pricing falls back to a local estimate so --max-cost cannot fail open.
    expect(getProviderUsage().estimatedCostUsd).toBeGreaterThan(0);
  });

  it('requires parameter-capable OpenRouter routes without mislabeling optional schemas as strict', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => (
      Promise.resolve(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"value":"ok"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createChatCompletion(config({
      provider: 'openrouter',
      model: 'vendor/strict-validator',
      baseUrl: 'https://openrouter.ai/api/v1',
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 100,
      responseSchema: {
        type: 'object',
        properties: { value: { type: 'string' }, optional_note: { type: 'string' } },
        required: ['value'],
      },
      tools: [{
        type: 'function',
        function: {
          name: 'inspect',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' }, optional_note: { type: 'string' } },
            required: ['value'],
          },
        },
      }],
    })).resolves.toMatchObject({ text: '{"value":"ok"}' });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(init.body) as {
      response_format: { json_schema: Record<string, unknown> };
      tools: Array<{ function: Record<string, unknown> }>;
      provider: Record<string, unknown>;
    };
    expect(body.provider).toMatchObject({ require_parameters: true });
    expect(body.response_format.json_schema).not.toHaveProperty('strict');
    expect(body.tools[0]?.function).not.toHaveProperty('strict');
  });

  it('does not claim strict-schema support for an unknown compatible endpoint', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => (
      Promise.resolve(new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"value":"ok"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    ));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config({
      provider: 'openai-compatible',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:8000/v1',
    }), {
      messages: [{ role: 'user', content: 'Extract this' }],
      maxTokens: 100,
      responseSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      tools: [{
        type: 'function',
        function: {
          name: 'inspect',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      }],
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(init.body) as {
      response_format: { json_schema: Record<string, unknown> };
      tools: Array<{ function: Record<string, unknown> }>;
      provider?: unknown;
    };
    expect(body.response_format.json_schema).not.toHaveProperty('strict');
    expect(body.tools[0]?.function).not.toHaveProperty('strict');
    expect(body.provider).toBeUndefined();
  });

  it('keeps Kimi MFJS schemas strict while wiring Muse reasoning effort', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    await createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 100,
      responseSchema: { type: 'object', properties: { optional_note: { type: 'string' } } },
    });
    await createChatCompletion(config({
      provider: 'muse',
      apiKeyEnv: 'META_API_KEY',
      model: 'muse-spark-1.1',
      baseUrl: 'https://api.meta.ai/v1',
      thinkingConfig: { level: 'HIGH', includeThoughts: true },
    }), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 100,
    });

    const kimiInit = fetchMock.mock.calls[0]?.[1];
    const museInit = fetchMock.mock.calls[1]?.[1];
    if (typeof kimiInit?.body !== 'string' || typeof museInit?.body !== 'string') {
      throw new Error('Expected JSON request bodies');
    }
    expect(JSON.parse(kimiInit.body) as unknown).toMatchObject({
      response_format: { json_schema: { strict: true } },
    });
    expect(JSON.parse(museInit.body) as unknown).toMatchObject({ reasoning_effort: 'high' });
  });

  it('claims strict mode only for schemas that satisfy the narrow strict dialect', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    const openRouter = config({
      provider: 'openrouter',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      model: 'google/gemini-3.5-flash',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    await createChatCompletion(openRouter, {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 100,
      responseSchema: {
        type: 'object',
        properties: { optional_note: { type: 'string' } },
      },
      tools: [{
        type: 'function',
        function: {
          name: 'inspect',
          parameters: {
            type: 'object',
            properties: { required_value: { type: 'string' }, optional_note: { type: 'string' } },
            required: ['required_value'],
          },
        },
      }],
    });
    await createChatCompletion(openRouter, {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 100,
      responseSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    });

    const optionalInit = fetchMock.mock.calls[0]?.[1];
    const strictInit = fetchMock.mock.calls[1]?.[1];
    if (typeof optionalInit?.body !== 'string' || typeof strictInit?.body !== 'string') {
      throw new Error('Expected JSON request bodies');
    }
    const optionalBody = JSON.parse(optionalInit.body) as {
      response_format: { json_schema: Record<string, unknown> };
      tools: Array<{ function: Record<string, unknown> }>;
    };
    const strictBody = JSON.parse(strictInit.body) as {
      response_format: { json_schema: Record<string, unknown> };
    };
    expect(optionalBody.response_format.json_schema).not.toHaveProperty('strict');
    expect(optionalBody.tools[0]?.function).not.toHaveProperty('strict');
    expect(strictBody.response_format.json_schema).toMatchObject({ strict: true });
  });
});
