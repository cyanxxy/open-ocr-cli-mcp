import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getExtractionPreset } from '../templates';
import { extractPresetWithProvider, extractStructuredWithProvider, extractTextWithProvider } from './extraction';
import { createChatCompletion } from './openaiCompatible';
import { resetProviderRequestPolicy } from './requestPolicy';
import type { ProviderRuntimeConfig } from './types';
import { resetProviderUsage } from './usage';

function config(): ProviderRuntimeConfig {
  return {
    provider: 'openai-compatible',
    gateway: 'direct',
    apiKey: 'secret',
    apiKeyEnv: 'OPEN_OCR_API_KEY',
    model: 'm',
    baseUrl: 'http://127.0.0.1:9/v1',
    thinkingConfig: { level: 'MEDIUM', includeThoughts: false },
  };
}

function completion(message: Record<string, unknown>, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function promptText(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  return messages[0].content.find((part) => part.type === 'text')?.text ?? '';
}

beforeEach(() => {
  resetProviderRequestPolicy();
  resetProviderUsage();
});

afterEach(() => vi.unstubAllGlobals());

describe('provider extraction fidelity', () => {
  it('accepts a fenced, prose-wrapped answer in --schema mode', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(completion({ content: 'Here:\n```json\n{"name":"a"}\n```' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(extractStructuredWithProvider('data:image/png;base64,AA==', 'image/png', 'x.png', config(), {
      type: 'object',
      properties: { name: { type: 'string' } },
    })).resolves.toEqual({ name: 'a' });
  });

  it('types an unparseable --schema answer as OUTPUT_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(completion({ content: 'no json at all' }))));
    await expect(extractStructuredWithProvider('data:image/png;base64,AA==', 'image/png', 'x.png', config(), {
      type: 'object',
    })).rejects.toMatchObject({ name: 'OcrError', type: 'OUTPUT_INVALID' });
  });

  it('honours maxTokens in template mode and keeps 16384 as the default', async () => {
    const payload = JSON.stringify({ documentType: 'Card', summary: 's', fields: { full_name: { value: 'N', confidence: 0.9 } }, warnings: [] });
    const fetchMock = vi.fn(() => Promise.resolve(completion({ content: payload })));
    vi.stubGlobal('fetch', fetchMock);
    const card = getExtractionPreset('business-card');
    await extractPresetWithProvider('data:image/png;base64,AA==', 'image/png', 'x.png', config(), card);
    await extractPresetWithProvider('data:image/png;base64,AA==', 'image/png', 'x.png', config(), card, undefined, { maxTokens: 2048 });
    const limits = [0, 1].map((call) => sentBody(fetchMock, call).max_tokens ?? sentBody(fetchMock, call).max_completion_tokens);
    expect(limits).toEqual([16384, 2048]);
  });

  it('joins caller instructions and feature directives as separate sentences', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(completion({ content: '# Doc\n\ntext' })));
    vi.stubGlobal('fetch', fetchMock);
    await extractTextWithProvider('data:image/png;base64,AA==', 'image/png', 'x.png', config(), [{ prompt: 'Only the header' }], {
      detectImages: true,
    });
    const prompt = promptText(sentBody(fetchMock));
    expect(prompt).toContain('Only the header.\nDetect and describe any images, charts, or diagrams.');
    expect(prompt).not.toContain('Only the header Detect');
  });

  it('reports a model refusal as a refusal, not an empty response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(completion({ content: null, refusal: 'I cannot help with that.' }))));
    await expect(createChatCompletion(config(), { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }))
      .rejects.toMatchObject({ name: 'ProviderApiError', code: 'MODEL_REFUSAL', message: 'Provider model refused the request: I cannot help with that.' });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(completion({ content: [{ type: 'refusal', refusal: 'No.' }] }))));
    await expect(createChatCompletion(config(), { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }))
      .rejects.toMatchObject({ code: 'MODEL_REFUSAL' });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(completion({ content: null }))));
    await expect(createChatCompletion(config(), { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }))
      .rejects.toThrow('Provider returned an empty response');
  });

  it('reports a streamed refusal as a refusal', async () => {
    const events = [
      { choices: [{ delta: { refusal: 'I cannot ' } }] },
      { choices: [{ delta: { refusal: 'do that.' }, finish_reason: 'stop' }] },
    ];
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))));
    await expect(createChatCompletion(config(), {
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 10,
      onDelta: () => undefined,
    })).rejects.toMatchObject({ code: 'MODEL_REFUSAL', message: 'Provider model refused the request: I cannot do that.' });
  });
});
