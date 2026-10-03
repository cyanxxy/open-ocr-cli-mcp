import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentStep } from '../agentTypes';
import { providerAgentLoop } from './agent';
import { ProviderApiError } from './openaiCompatible';
import type { ProviderRuntimeConfig } from './types';

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('provider agent loop', () => {
  it('aborts an active compatible request when the document time budget expires', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true });
      }));
      vi.stubGlobal('fetch', fetchMock);
      const generator = providerAgentLoop(
        { name: 'form.png', type: 'image/png' }, 'data:image/png;base64,AA==',
        {
          provider: 'openrouter', gateway: 'direct', apiKey: 'secret', apiKeyEnv: 'OPENROUTER_API_KEY',
          model: 'vendor/current-model', baseUrl: 'https://openrouter.ai/api/v1',
          thinkingConfig: { level: 'HIGH', includeThoughts: false }, progress: 'off',
        },
        { maxIterations: 3, confidenceThreshold: 0.8, maxTokens: 1024, maxDurationMs: 25, throwOnFailure: true },
        () => Promise.resolve({ dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 1, height: 1 }),
      );
      const pending = (async () => {
        let state = await generator.next();
        while (!state.done) state = await generator.next();
        return state.value;
      })();
      await vi.advanceTimersByTimeAsync(25);
      expect((await pending).stopReason).toBe('budget_exhausted');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { confidences: [0.4, 0.6, 0.9], expected: 'succeeded', requests: 6 },
    { confidences: [0.4, 0.4], expected: 'partial', requests: 4 },
  ])('handles repeated field refinements: $expected', async ({ confidences, expected, requests }) => {
    const fetchMock = vi.fn();
    for (const [index, confidence] of confidences.entries()) {
      fetchMock.mockResolvedValueOnce(response({
        role: 'assistant',
        tool_calls: [{
          id: `fields-${index}`,
          type: 'function',
          function: {
            name: 'extract_fields_batch',
            arguments: JSON.stringify({ fields: [{ field_name: 'note', field_value: 'hello', confidence }] }),
          },
        }],
      })).mockResolvedValueOnce(response({ role: 'assistant', content: 'Pass complete.' }));
    }
    vi.stubGlobal('fetch', fetchMock);
    const generator = providerAgentLoop(
      { name: 'form.png', type: 'image/png' }, 'data:image/png;base64,AA==',
      {
        provider: 'openrouter', gateway: 'direct', apiKey: 'secret', apiKeyEnv: 'OPENROUTER_API_KEY',
        model: 'vendor/current-model', baseUrl: 'https://openrouter.ai/api/v1',
        thinkingConfig: { level: 'HIGH', includeThoughts: false }, progress: 'off',
      },
      { maxIterations: 3, confidenceThreshold: 0.8, maxTokens: 1024 },
      () => Promise.resolve({ dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 1, height: 1 }),
    );
    let state = await generator.next();
    while (!state.done) state = await generator.next();
    expect(state.value.stopReason).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it('rethrows typed provider failures for machine-facing callers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'Invalid provider credential', code: 'invalid_api_key' },
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))));
    const generator = providerAgentLoop(
      { name: 'invoice.png', type: 'image/png' },
      'data:image/png;base64,AA==',
      {
        provider: 'openrouter',
        gateway: 'direct',
        apiKey: 'bad-key',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        model: 'vendor/current-model',
        baseUrl: 'https://openrouter.ai/api/v1',
        thinkingConfig: { level: 'HIGH', includeThoughts: false },
        progress: 'standard',
      },
      {
        maxIterations: 1,
        confidenceThreshold: 0.8,
        maxTokens: 4096,
        throwOnFailure: true,
      },
      () => Promise.resolve({
        dataUrl: 'data:image/png;base64,AA==',
        mimeType: 'image/png',
        width: 1,
        height: 1,
      }),
    );

    await expect((async (): Promise<void> => {
      let state = await generator.next();
      while (!state.done) state = await generator.next();
    })()).rejects.toEqual(expect.objectContaining<Partial<ProviderApiError>>({
      name: 'ProviderApiError',
      status: 401,
      code: 'invalid_api_key',
    }));
  });

  it('assigns stable channel IDs to compatible streaming deltas', async () => {
    const stream = (reasoning: string[], output: string): Response => {
      const chunks = [
        ...reasoning.map((text) => ({ choices: [{ delta: { reasoning_content: text } }] })),
        { choices: [{ delta: { content: output }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4, cost: 0 } },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(stream(['inspect ', 'layout'], 'Need tools.'))
      .mockResolvedValueOnce(stream(['still checking'], 'No tools.')));

    const generator = providerAgentLoop(
      { name: 'invoice.png', type: 'image/png' },
      'data:image/png;base64,AA==',
      {
        provider: 'openrouter',
        gateway: 'direct',
        apiKey: 'secret',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        model: 'vendor/current-model',
        baseUrl: 'https://openrouter.ai/api/v1',
        thinkingConfig: { level: 'HIGH', includeThoughts: true },
        progress: 'detailed',
      },
      { maxIterations: 1, confidenceThreshold: 0.8, maxTokens: 4096 },
      () => Promise.resolve({ dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 1, height: 1 }),
    );
    const steps: AgentStep[] = [];
    let state = await generator.next();
    while (!state.done) {
      steps.push(state.value);
      state = await generator.next();
    }

    const firstReasoning = steps.filter((step) => step.id?.endsWith(':completion-1-1:reasoning'));
    expect(firstReasoning.map((step) => step.content)).toEqual(['inspect ', 'layout']);
    expect(firstReasoning.every((step) => step.delta)).toBe(true);
    expect(steps).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/:completion-1-1:model_output$/u) as unknown,
      source: 'model_output',
      content: 'Need tools.',
      delta: true,
    }));
    expect(steps).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/:completion-1-2:reasoning$/u) as unknown,
      content: 'still checking',
      delta: true,
    }));
    const sessionPrefixes = new Set(
      steps
        .flatMap((step) => step.id?.match(/^(.*):completion-/u)?.[1] ?? [])
        .filter(Boolean),
    );
    expect(sessionPrefixes.size).toBe(1);
  });

  it('chains tool results and preserves Kimi reasoning content', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        role: 'assistant',
        content: null,
        reasoning_content: 'I should identify the document first.',
        tool_calls: [{
          id: 'analysis-1',
          type: 'function',
          function: {
            name: 'analyze_document_structure',
            arguments: JSON.stringify({
              document_type: 'invoice',
              layout_analysis: { sections: ['header', 'totals'] },
              extraction_strategy: 'form-based',
              confidence: 0.98,
            }),
          },
        }],
      }))
      .mockResolvedValueOnce(response({
        role: 'assistant',
        content: null,
        reasoning_content: 'Now I can extract canonical invoice fields.',
        tool_calls: [{
          id: 'fields-1',
          type: 'function',
          function: {
            name: 'extract_fields_batch',
            arguments: JSON.stringify({ fields: [
              { field_name: 'vendor_name', field_value: 'Acme BV', confidence: 0.98 },
              { field_name: 'invoice_number', field_value: 'INV-100', confidence: 0.98 },
              { field_name: 'invoice_date', field_value: '2026-07-15', confidence: 0.98 },
              { field_name: 'customer_name', field_value: 'Example NV', confidence: 0.98 },
              { field_name: 'total_amount', field_value: '100.00', confidence: 0.98 },
            ] }),
          },
        }],
      }))
      .mockResolvedValueOnce(response({
        role: 'assistant',
        reasoning_content: 'Verified completeness.',
        content: 'Extraction is complete.',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const config: ProviderRuntimeConfig = {
      provider: 'kimi',
      gateway: 'direct',
      apiKey: 'secret',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      model: 'kimi-k2.6',
      baseUrl: 'https://api.moonshot.ai/v1',
      thinkingConfig: { level: 'HIGH', includeThoughts: true },
      progress: 'detailed',
    };
    const generator = providerAgentLoop(
      { name: 'invoice.png', type: 'image/png' },
      'data:image/png;base64,AA==',
      config,
      { maxIterations: 2, confidenceThreshold: 0.8, maxTokens: 4096 },
      () => Promise.resolve({ dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png', width: 1, height: 1 }),
    );
    let state = await generator.next();
    const steps: AgentStep[] = [];
    while (!state.done) {
      steps.push(state.value);
      state = await generator.next();
    }

    expect(state.value.stopReason).toBe('succeeded');
    expect(state.value.extractedFields.invoice_number.value).toBe('INV-100');
    expect(steps.some((step) => step.content.includes('canonical invoice fields'))).toBe(true);
    expect(steps.some((step) => step.source === 'reasoning' && step.content === 'Verified completeness.')).toBe(true);
    expect(steps.some((step) => step.source === 'model_output' && step.content === 'Extraction is complete.')).toBe(true);
    expect(steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'tool_result',
        functionCall: expect.objectContaining({ id: 'analysis-1', name: 'analyze_document_structure' }) as unknown,
      }),
    ]));
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    if (typeof secondInit?.body !== 'string') throw new Error('Expected a string request body');
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    if (typeof firstInit?.body !== 'string') throw new Error('Expected a string request body');
    const firstRequest = JSON.parse(firstInit.body) as {
      prompt_cache_key?: string;
      parallel_tool_calls?: boolean;
    };
    const secondRequest = JSON.parse(secondInit.body) as { messages: unknown[]; prompt_cache_key?: string };
    expect(secondRequest.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', reasoning_content: 'I should identify the document first.' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'analysis-1' }),
    ]));
    expect(firstRequest.prompt_cache_key).toMatch(/\S/u);
    expect(secondRequest.prompt_cache_key).toBe(firstRequest.prompt_cache_key);
    expect(firstRequest.parallel_tool_calls).toBe(false);
  });

  it('runs region re-OCR through the compatible structured extractor end to end', async () => {
    const region = { page: 1, x: 0.7, y: 0.75, width: 0.2, height: 0.1, units: 'normalized' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        role: 'assistant',
        content: null,
        reasoning_content: 'This summary must remain opt-in.',
        tool_calls: [{
          id: 'analysis-1',
          type: 'function',
          function: {
            name: 'analyze_document_structure',
            arguments: JSON.stringify({
              document_type: 'form',
              layout_analysis: { sections: ['account details'] },
              extraction_strategy: 'form-based',
              confidence: 0.95,
            }),
          },
        }],
      }))
      .mockResolvedValueOnce(response({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'region-1',
          type: 'function',
          function: {
            name: 're_ocr_region',
            arguments: JSON.stringify({ region, focus: 'account number', confidence_threshold: 0.8 }),
          },
        }],
      }))
      .mockResolvedValueOnce(response({
        role: 'assistant',
        content: JSON.stringify({
          fields: [{ field_name: 'account_number', field_value: 'AC-42', confidence: 0.99 }],
        }),
      }))
      .mockResolvedValueOnce(response({ role: 'assistant', content: 'The region is recovered.' }));
    vi.stubGlobal('fetch', fetchMock);
    const cropper = vi.fn(() => Promise.resolve({
      dataUrl: 'data:image/png;base64,AQ==',
      mimeType: 'image/png',
      width: 200,
      height: 100,
    }));
    const config: ProviderRuntimeConfig = {
      provider: 'openrouter',
      gateway: 'direct',
      apiKey: 'secret',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      model: 'moonshotai/kimi-k2.6',
      baseUrl: 'https://openrouter.ai/api/v1',
      thinkingConfig: { level: 'HIGH', includeThoughts: false },
      progress: 'standard',
    };
    const generator = providerAgentLoop(
      { name: 'form.png', type: 'image/png' },
      'data:image/png;base64,AA==',
      config,
      { maxIterations: 1, confidenceThreshold: 0.8, maxTokens: 4096 },
      cropper,
    );
    let state = await generator.next();
    const steps: AgentStep[] = [];
    while (!state.done) {
      steps.push(state.value);
      state = await generator.next();
    }

    expect(cropper).toHaveBeenCalledWith('data:image/png;base64,AA==', 'image/png', region);
    expect(steps.filter((step) => step.functionResult?.success === false)).toEqual([]);
    expect(state.value.stopReason).toBe('succeeded');
    expect(state.value.extractedFields.account_number).toMatchObject({
      value: 'AC-42',
      confidence: 0.99,
      location: region,
    });
    expect(steps.some((step) => step.content.includes('must remain opt-in'))).toBe(false);
    const regionInit = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined;
    if (typeof regionInit?.body !== 'string') throw new Error('Expected a JSON request body');
    const regionBody = JSON.parse(regionInit.body) as {
      response_format: { json_schema: Record<string, unknown> };
      provider: { require_parameters: boolean };
    };
    expect(regionBody).toMatchObject({
      response_format: {
        json_schema: {
          name: 'region_ocr_fields',
        },
      },
      provider: { require_parameters: true },
    });
    expect(regionBody.response_format.json_schema).not.toHaveProperty('strict');
  });
});
