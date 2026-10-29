import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getExtractionPreset } from '../templates';
import {
  extractPresetWithProvider,
  extractStructuredWithProvider,
  extractTextWithProvider,
} from './extraction';
import { resetProviderRequestPolicy } from './requestPolicy';
import type { ProviderRuntimeConfig } from './types';
import { resetProviderUsage } from './usage';

function config(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    provider: 'openrouter',
    gateway: 'direct',
    apiKey: 'secret',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: 'google/gemini-3.8-flash',
    baseUrl: 'https://openrouter.ai/api/v1',
    thinkingConfig: { level: 'MEDIUM', includeThoughts: false },
    ...overrides,
  };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  const parsed = JSON.parse(init.body) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected an object request body');
  }
  return parsed as Record<string, unknown>;
}

beforeEach(() => {
  resetProviderRequestPolicy();
  resetProviderUsage();
});

afterEach(() => vi.unstubAllGlobals());

describe('provider extraction facade', () => {
  it('sends image media and returns Markdown through the compatible transport', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(completion('# Invoice\n\nTotal: 42.00')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractTextWithProvider(
      'data:image/png;base64,AA==',
      'image/png',
      'invoice.png',
      config(),
    );

    expect(result.sections.flatMap((section) => section.content).join('\n')).toContain('Total: 42.00');
    expect(JSON.stringify(requestBody(fetchMock))).toContain('image_url');
  });

  it('requests and parses an arbitrary JSON schema', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(completion('{"invoice_number":"INV-42"}')));
    vi.stubGlobal('fetch', fetchMock);
    const schema = {
      type: 'object',
      required: ['invoice_number'],
      properties: { invoice_number: { type: 'string' } },
    };

    await expect(extractStructuredWithProvider(
      'data:image/png;base64,AA==',
      'image/png',
      'invoice.png',
      config(),
      schema,
    )).resolves.toEqual({ invoice_number: 'INV-42' });
    expect(requestBody(fetchMock)).toMatchObject({
      response_format: { type: 'json_schema' },
    });
  });

  it('normalizes a built-in preset response into JSON, Markdown, and CSV', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(completion(JSON.stringify({
      documentType: 'invoice',
      summary: 'Invoice INV-42 from Orbit Partners',
      fields: {
        invoice_number: { value: 'INV-42', confidence: 0.99 },
        invoice_date: { value: '2026-07-15', confidence: 0.99 },
        due_date: { value: null, confidence: 0 },
        vendor_name: { value: 'Orbit Partners', confidence: 0.98 },
        customer_name: { value: 'Nina Patel', confidence: 0.95 },
        currency: { value: 'EUR', confidence: 0.99 },
        subtotal: { value: 40, confidence: 0.98 },
        tax: { value: 2, confidence: 0.98 },
        total: { value: 42, confidence: 0.99 },
      },
      rows: [{ description: 'Consulting', quantity: '1', unit_price: '40.00', line_total: '40.00' }],
      warnings: [],
    }))));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractPresetWithProvider(
      'data:image/png;base64,AA==',
      'image/png',
      'card.png',
      config(),
      getExtractionPreset('invoice'),
    );

    expect(result.markdown).toContain('INV-42');
    expect(result.json.fields.invoice_number.value).toBe('INV-42');
    expect(result.csv).toContain('description,quantity,unit_price,line_total');
  });

  it('uses OpenRouter file parts and the PDF parser plugin', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(completion('# PDF extraction')));
    vi.stubGlobal('fetch', fetchMock);

    await extractTextWithProvider(
      'data:application/pdf;base64,AA==',
      'application/pdf',
      'report.pdf',
      config(),
    );

    const body = requestBody(fetchMock);
    expect(body.plugins).toEqual([{ id: 'file-parser' }]);
    expect(JSON.stringify(body.messages)).toContain('file_data');
  });
});
