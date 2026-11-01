import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatCompletion, type OpenAITool } from './openaiCompatible';
import { resetProviderRequestPolicy } from './requestPolicy';
import type { ProviderId, ProviderRuntimeConfig } from './types';
import { getProviderUsage, resetProviderUsage } from './usage';

const BASE_URLS: Record<ProviderId, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  kimi: 'https://api.moonshot.ai/v1',
  muse: 'https://api.meta.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'http://localhost:11434/v1',
};

function config(provider: ProviderId, model: string): ProviderRuntimeConfig {
  return {
    provider,
    gateway: 'direct',
    apiKey: 'secret',
    apiKeyEnv: 'KEY',
    model,
    baseUrl: BASE_URLS[provider],
  };
}

beforeEach(() => {
  resetProviderUsage();
  resetProviderRequestPolicy();
});
afterEach(() => vi.unstubAllGlobals());

async function wireBody(
  cfg: ProviderRuntimeConfig,
  request: { responseSchema?: Record<string, unknown>; tools?: OpenAITool[] },
): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
  }));
  vi.stubGlobal('fetch', fetchMock);
  await createChatCompletion(cfg, { messages: [{ role: 'user', content: 'Extract' }], maxTokens: 64, ...request });
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as Record<string, unknown>;
}

const strictObject = {
  type: 'object',
  properties: { total: { type: 'number' } },
  required: ['total'],
  additionalProperties: false,
};
const tool: OpenAITool = { type: 'function', function: { name: 'inspect', parameters: strictObject } };

describe('tool-call wire fields per provider', () => {
  // GET https://openrouter.ai/api/v1/models/<id>/endpoints (2026-11-01): no
  // endpoint for these routes lists parallel_tool_calls, while every route has
  // endpoints listing tools, tool_choice, response_format, structured_outputs,
  // reasoning and max_tokens. require_parameters plus parallel_tool_calls
  // therefore left nothing to route to.
  it.each([
    'anthropic/claude-sonnet-5.5',
    'google/gemini-3.8-flash',
    'openai/gpt-6.1-sol',
    'meta/muse-spark-1.3',
    'moonshotai/kimi-k3.1-pro',
  ])('keeps OpenRouter %s routable: require_parameters without parallel_tool_calls', async (model) => {
    const body = await wireBody(config('openrouter', model), { tools: [tool], responseSchema: strictObject });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(body).toMatchObject({ tool_choice: 'auto', max_tokens: 64 });
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('omits parallel_tool_calls for Kimi, whose chat schema lacks it', async () => {
    const body = await wireBody(config('kimi', 'kimi-k3.1-pro'), { tools: [tool] });
    expect(body).not.toHaveProperty('parallel_tool_calls');
  });

  it('keeps parallel_tool_calls for Meta, whose chat schema lists it', async () => {
    const body = await wireBody(config('muse', 'muse-spark-1.3'), { tools: [tool] });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body).toMatchObject({ max_completion_tokens: 64 });
    expect(body).not.toHaveProperty('max_tokens');
  });
});

describe('provider-aware strict schema subset', () => {
  const strictFlag = async (provider: ProviderId, model: string, schema: Record<string, unknown>) => {
    const body = await wireBody(config(provider, model), { responseSchema: schema });
    const format = body.response_format as { json_schema: Record<string, unknown> };
    return format.json_schema.strict;
  };

  const withDefs = {
    type: 'object',
    properties: { address: { $ref: '#/$defs/address' } },
    required: ['address'],
    additionalProperties: false,
    $defs: {
      address: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  };
  const recursive = {
    type: 'object',
    properties: { root: { $ref: '#/$defs/node' } },
    required: ['root'],
    additionalProperties: false,
    $defs: {
      node: {
        type: 'object',
        properties: { children: { type: 'array', items: { $ref: '#/$defs/node' } } },
        required: ['children'],
        additionalProperties: false,
      },
    },
  };
  const nested = (keyword: string, value: unknown) => ({
    type: 'object',
    properties: { value: { type: 'string', [keyword]: value } },
    required: ['value'],
    additionalProperties: false,
  });
  const rootAnyOf = { anyOf: [strictObject, { ...strictObject, properties: { other: { type: 'string' } }, required: ['other'] }] };

  it('accepts $defs/$ref for OpenAI and Meta, and recursion only for OpenAI', async () => {
    expect(await strictFlag('openrouter', 'openai/gpt-6.1-sol', withDefs)).toBe(true);
    expect(await strictFlag('muse', 'muse-spark-1.3', withDefs)).toBe(true);
    expect(await strictFlag('openrouter', 'openai/gpt-6.1-sol', recursive)).toBe(true);
    // Meta: "Recursive schemas aren't supported".
    expect(await strictFlag('muse', 'muse-spark-1.3', recursive)).toBeUndefined();
    expect(await strictFlag('openrouter', 'meta/muse-spark-1.3', recursive)).toBeUndefined();
  });

  it.each(['allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else'])(
    'drops strict for OpenAI when %s appears below the root',
    async (keyword) => {
      const value = keyword === 'allOf' ? [{ type: 'string' }]
        : keyword === 'dependentRequired' ? { a: ['b'] }
          : keyword === 'dependentSchemas' ? { a: { type: 'object' } }
            : { type: 'string' };
      expect(await strictFlag('openrouter', 'openai/gpt-6.1-sol', nested(keyword, value))).toBeUndefined();
    },
  );

  it('follows Meta: allOf and oneOf nowhere, anyOf only below the root', async () => {
    expect(await strictFlag('muse', 'muse-spark-1.3', nested('allOf', [{ type: 'string' }]))).toBeUndefined();
    expect(await strictFlag('muse', 'muse-spark-1.3', nested('oneOf', [{ type: 'string' }]))).toBeUndefined();
    expect(await strictFlag('muse', 'muse-spark-1.3', nested('anyOf', [{ type: 'string' }, { type: 'null' }]))).toBe(true);
    expect(await strictFlag('muse', 'muse-spark-1.3', rootAnyOf)).toBeUndefined();
    expect(await strictFlag('muse', 'muse-spark-1.3', { ...strictObject, not: { required: ['x'] } })).toBeUndefined();
    expect(await strictFlag('muse', 'muse-spark-1.3', { type: 'string', enum: ['a'] })).toBeUndefined();
  });

  it('rejects a root anyOf for OpenAI and uses the conservative union for other OpenRouter families', async () => {
    expect(await strictFlag('openrouter', 'openai/gpt-6.1-sol', rootAnyOf)).toBeUndefined();
    expect(await strictFlag('openrouter', 'openai/gpt-6.1-sol', nested('anyOf', [{ type: 'string' }, { type: 'null' }]))).toBe(true);
    expect(await strictFlag('openrouter', 'anthropic/claude-sonnet-5.5', withDefs)).toBe(true);
    expect(await strictFlag('openrouter', 'anthropic/claude-sonnet-5.5', recursive)).toBeUndefined();
    expect(await strictFlag('openrouter', 'google/gemini-3.8-flash', nested('not', { type: 'number' }))).toBeUndefined();
    expect(await strictFlag('openrouter', 'google/gemini-3.8-flash', nested('oneOf', [{ type: 'string' }]))).toBeUndefined();
  });

  it('still requires additionalProperties:false and every property required everywhere, including $defs', async () => {
    const optionalInDefs = {
      ...withDefs,
      $defs: { address: { ...withDefs.$defs.address, required: [] } },
    };
    expect(await strictFlag('openrouter', 'openai/gpt-6.1-sol', optionalInDefs)).toBeUndefined();
    expect(await strictFlag('muse', 'muse-spark-1.3', optionalInDefs)).toBeUndefined();
  });
});

describe('Kimi streaming usage', () => {
  it('records the final usage chunk Kimi sends at the root with choices: []', async () => {
    // Shape from platform.kimi.ai/docs/api/chat.md ("The final usage chunk has
    // `choices: []` and reports totals in the top-level `usage`").
    const chunks = [
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'kimi-k3.1-pro', choices: [{ index: 0, delta: { content: 'done' } }] },
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'kimi-k3.1-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1792741110,
        model: 'kimi-k3.1-pro',
        choices: [],
        usage: {
          prompt_tokens: 373,
          completion_tokens: 93,
          total_tokens: 466,
          completion_tokens_details: { reasoning_tokens: 71 },
          prompt_tokens_details: { cache_write_tokens: 256 },
        },
      },
    ];
    const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const result = await createChatCompletion(config('kimi', 'kimi-k3.1-pro'), {
      messages: [{ role: 'user', content: 'Extract' }],
      maxTokens: 64,
      onDelta: () => undefined,
    });
    expect(result.text).toBe('done');
    expect(getProviderUsage()).toMatchObject({ requests: 1, totalTokens: 466 });
  });
});
