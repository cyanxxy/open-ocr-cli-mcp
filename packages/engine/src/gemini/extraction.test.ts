import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }));

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, getGenAIClient: mockGetClient };
});

import { extractStructuredDataFromFile, extractTextFromFile } from './extraction';
import { OcrError, OcrErrorType } from './types';
import { getGeminiUsage, resetGeminiUsage } from './usage';

const FILE_DATA = 'data:image/png;base64,ZmFrZQ==';
const CLIENT = { apiKey: 'k', model: 'gemini-3.5-flash' as const };

function mockGenerate(response: unknown) {
  const generateContent = vi.fn<(request: {
    model: string;
    contents: Array<{ parts: Array<{ text?: string }> }>;
    config: Record<string, unknown>;
  }) => Promise<unknown>>().mockResolvedValue(response);
  mockGetClient.mockReturnValue({ models: { generateContent } });
  return generateContent;
}

describe('extractTextFromFile — output contract', () => {
  beforeEach(() => {
    mockGetClient.mockReset();
    resetGeminiUsage();
  });
  afterEach(() => vi.restoreAllMocks());

  it('H-01: outputFormat=json (without structuredOutput) prompts JSON and requests application/json', async () => {
    const generateContent = mockGenerate({
      text: '{"title":"T","sections":[]}',
      candidates: [{ finishReason: 'STOP' }],
    });

    await extractTextFromFile(FILE_DATA, 'image/png', CLIENT, undefined, { outputFormat: 'json' });

    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3.5-flash');
    const promptText = call.contents[0].parts[0].text as string;
    expect(promptText).toMatch(/structured JSON/i);
    expect(promptText).not.toMatch(/clean markdown/i);
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseJsonSchema).toEqual(expect.objectContaining({
      type: 'object',
      required: ['sections'],
    }));
  });

  it('H-02: invalid JSON throws when JSON was requested (no silent Markdown downgrade)', async () => {
    mockGenerate({ text: 'this is not json', candidates: [{ finishReason: 'STOP' }] });
    await expect(
      extractTextFromFile(FILE_DATA, 'image/png', CLIENT, undefined, { structuredOutput: true }),
    ).rejects.toThrow(/invalid JSON/i);
  });

  it('parses valid JSON when requested', async () => {
    mockGenerate({
      text: '{"title":"Invoice","sections":[{"heading":"H","content":["line"]}]}',
      candidates: [{ finishReason: 'STOP' }],
    });
    const result = await extractTextFromFile(FILE_DATA, 'image/png', CLIENT, undefined, { structuredOutput: true });
    expect(result.title).toBe('Invoice');
    expect(result.sections[0].content).toEqual(['line']);
  });

  it.each([
    ['a primitive', '42'],
    ['a missing required sections property', '{"title":"Invoice"}'],
    ['a malformed nested section', '{"sections":[{"content":"not-an-array"}]}'],
    ['an undeclared property', '{"sections":[],"surprise":true}'],
  ])('rejects schema-invalid JSON: %s', async (_description, text) => {
    mockGenerate({ text, candidates: [{ finishReason: 'STOP' }] });
    await expect(
      extractTextFromFile(FILE_DATA, 'image/png', CLIENT, undefined, { structuredOutput: true }),
    ).rejects.toThrow(/did not match the OCR schema/i);
  });

  it('extracts JSON with a caller-provided schema', async () => {
    const generateContent = mockGenerate({
      text: '{"invoice_number":"INV-42","total":12.5}',
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
    });
    const schema = {
      type: 'object',
      properties: {
        invoice_number: { type: 'string' },
        total: { type: 'number' },
      },
      required: ['invoice_number', 'total'],
    };

    const result = await extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, schema);

    expect(result).toEqual({ invoice_number: 'INV-42', total: 12.5 });
    const call = generateContent.mock.calls[0][0];
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseJsonSchema).toEqual(schema);
    expect(getGeminiUsage().estimatedCostUsd).toBeGreaterThan(0);
  });

  describe('extractStructuredDataFromFile — schema rejections', () => {
    /** Live Gemini shape: `ApiError` with numeric `status` and the body as `message`. */
    function mockReject(status: number, body: string) {
      const generateContent = vi.fn().mockRejectedValue(Object.assign(
        new Error(body),
        { name: 'ApiError', status },
      ));
      mockGetClient.mockReturnValue({ models: { generateContent } });
    }

    /** Grammar cost 500 x 4 properties, well over the documented budget. */
    const OVER_BUDGET = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          maxItems: 500,
          items: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' }, d: { type: 'string' } },
            required: ['a', 'b', 'c', 'd'],
            additionalProperties: false,
          },
        },
      },
      required: ['rows'],
      additionalProperties: false,
    };
    const CLEAN_SCHEMA = {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
      additionalProperties: false,
    };
    /** Shared shapes hoisted into `$defs`: idiomatic, and fully supported. */
    const MODULAR_SCHEMA = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { total: { $ref: '#/$defs/Money' } },
      required: ['total'],
      additionalProperties: false,
      $defs: {
        Money: {
          type: 'object',
          properties: { amount: { type: 'string' }, currency: { type: 'string' } },
          required: ['amount', 'currency'],
          additionalProperties: false,
        },
      },
    };
    /** `pattern` is real JSON Schema we have simply never probed. */
    const UNTESTED_KEYWORD_SCHEMA = {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^[A-Z]+$' } },
      required: ['code'],
      additionalProperties: false,
    };
    const BARE_INVALID_ARGUMENT = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';

    it('names the offending construct when a bare 400 meets an over-budget schema', async () => {
      // Constrained decoding rejects an over-budget grammar with a body that
      // names nothing, so the static check is the only thing that can say why.
      mockReject(400, BARE_INVALID_ARGUMENT);
      await expect(extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, OVER_BUDGET))
        .rejects.toThrow(/^Invalid JSON Schema for structured output: .*maxItems.*grammar cost of 2000/su);
    });

    it('states the schema verdict as a type rather than leaving it in the prose', async () => {
      // The diagnosis quotes the caller's own schema paths, so a consumer that
      // has to recognise it by substring is matching user-supplied text. This
      // site has the evidence, so it declares the verdict outright — and keeps
      // the provider's untouched error reachable as `cause`.
      mockReject(400, BARE_INVALID_ARGUMENT);
      const failure = await extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, OVER_BUDGET)
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(OcrError);
      expect((failure as OcrError).type).toBe(OcrErrorType.SCHEMA_INVALID);
      expect(((failure as OcrError).cause as Error).message).toBe(BARE_INVALID_ARGUMENT);
    });

    it('leaves an unexplained rejection untyped, so nothing claims the schema was at fault', async () => {
      // The counterpart to the rule above: `SCHEMA_INVALID` is only ever
      // asserted on confident evidence, never on a rejection nobody can explain.
      mockReject(400, BARE_INVALID_ARGUMENT);
      const failure = await extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, CLEAN_SCHEMA)
        .then(() => undefined, (error: unknown) => error);
      expect(failure).not.toBeInstanceOf(OcrError);
    });

    it('names the path, cost and remedy so the caller can act on the diagnosis', async () => {
      mockReject(400, BARE_INVALID_ARGUMENT);
      const failure = await extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, OVER_BUDGET)
        .then(() => undefined, (error: unknown) => error as Error);
      expect(failure?.message).toContain('properties.rows (maxItems)');
      expect(failure?.message).toContain('grammar cost of 2000');
      expect(failure?.message).toContain('above the largest cost (200) observed to compile');
      expect(failure?.message).toContain('cap the collection after parsing instead');
    });

    it('does not blame a modular $defs/$ref schema for an unexplained 400', async () => {
      // Every keyword here is supported; blaming it would send the caller off to
      // rewrite a correct schema while the real cause stayed unmentioned.
      mockReject(400, BARE_INVALID_ARGUMENT);
      const failure = await extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, MODULAR_SCHEMA)
        .then(() => undefined, (error: unknown) => error as Error);
      expect(failure?.message).toBe('Request contains an invalid argument. [INVALID_ARGUMENT]');
    });

    it('offers an untested construct as a lead without blaming the schema', async () => {
      // "We have not probed this" is not "this is broken": the provider is
      // documented to ignore properties it does not support. The provider's own
      // sentence still leads, and the classifier still sees a provider failure.
      mockReject(400, BARE_INVALID_ARGUMENT);
      const failure = await extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, UNTESTED_KEYWORD_SCHEMA)
        .then(() => undefined, (error: unknown) => error as Error);
      expect(failure?.message).not.toMatch(/^Invalid JSON Schema/u);
      expect(failure?.message).toMatch(/^Request contains an invalid argument\. \[INVALID_ARGUMENT\]/u);
      expect(failure?.message).toContain('properties.code (pattern)');
      expect(failure?.message).toContain('rather than the established cause');
      expect((failure as unknown as { status?: number }).status).toBe(400);
    });

    it('leaves the rejection unexplained when the schema clears the static check', async () => {
      // No evidence to offer, so the provider's own sentence stands rather than
      // the schema being blamed on suspicion.
      mockReject(400, BARE_INVALID_ARGUMENT);
      await expect(extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, CLEAN_SCHEMA))
        .rejects.toThrow('Request contains an invalid argument. [INVALID_ARGUMENT]');
    });

    it('restates a raw JSON body as prose for direct callers', async () => {
      mockReject(401, '{"error":{"code":401,"message":"API key not valid. Please pass a valid API key.","status":"UNAUTHENTICATED"}}');
      await expect(extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, CLEAN_SCHEMA))
        .rejects.toThrow('API key not valid. Please pass a valid API key. [UNAUTHENTICATED]');
    });

    it('does not blame the schema when the provider blamed the document', async () => {
      mockReject(400, '{"error":{"code":400,"message":"Unable to process input image. Please retry.","status":"INVALID_ARGUMENT"}}');
      await expect(extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, OVER_BUDGET))
        .rejects.toThrow(/Unable to process input image/u);
    });

    it('does not blame the schema for a transient server failure', async () => {
      mockReject(503, '{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}');
      await expect(extractStructuredDataFromFile(FILE_DATA, 'image/png', CLIENT, OVER_BUDGET))
        .rejects.toThrow(/overloaded/u);
    });
  });

  it('G-02: a safety-blocked response throws instead of returning empty', async () => {
    mockGenerate({ text: '', promptFeedback: { blockReason: 'SAFETY' } });
    await expect(extractTextFromFile(FILE_DATA, 'image/png', CLIENT)).rejects.toThrow(/blocked/i);
  });

  it('G-02: an empty response throws', async () => {
    mockGenerate({ text: '', candidates: [{ finishReason: 'STOP' }] });
    await expect(extractTextFromFile(FILE_DATA, 'image/png', CLIENT)).rejects.toThrow(/empty/i);
  });

  it('rejects plausible-looking output when generation stops at MAX_TOKENS', async () => {
    mockGenerate({
      text: '# Partial document\nThis looks usable but is truncated.',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });
    await expect(extractTextFromFile(FILE_DATA, 'image/png', CLIENT)).rejects.toThrow(/incomplete output/i);
  });

  it('H-03: with streaming callbacks, a failure rejects AND notifies onError (never empty success)', async () => {
    const generateContentStream = vi.fn().mockRejectedValue(new Error('network down'));
    mockGetClient.mockReturnValue({ models: { generateContentStream } });
    const onError = vi.fn();
    const onComplete = vi.fn();

    await expect(
      extractTextFromFile(FILE_DATA, 'image/png', CLIENT, undefined, undefined, { onError, onComplete }),
    ).rejects.toThrow(/network down/);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('records usage metadata from the final streaming chunk', async () => {
    async function* chunks() {
      await Promise.resolve();
      await Promise.resolve();
      yield { text: '{"title":"T",' };
      yield {
        text: '"sections":[]}',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };
    }
    const generateContentStream = vi.fn().mockResolvedValue(chunks());
    mockGetClient.mockReturnValue({ models: { generateContentStream } });

    await extractTextFromFile(
      FILE_DATA,
      'image/png',
      CLIENT,
      undefined,
      { structuredOutput: true },
      { onProgress: vi.fn() },
    );

    expect(getGeminiUsage()).toEqual(expect.objectContaining({
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    }));
  });

  it('rejects a streaming result whose final chunk reports MAX_TOKENS', async () => {
    async function* chunks() {
      await Promise.resolve();
      yield { text: '# Partial document' };
      yield { text: '\ntruncated', candidates: [{ finishReason: 'MAX_TOKENS' }] };
    }
    mockGetClient.mockReturnValue({
      models: { generateContentStream: vi.fn().mockResolvedValue(chunks()) },
    });

    await expect(extractTextFromFile(
      FILE_DATA,
      'image/png',
      CLIENT,
      undefined,
      undefined,
      { onProgress: vi.fn() },
    )).rejects.toThrow(/incomplete output/i);
  });

  it('rejects a streaming result that ends without a terminal finish reason', async () => {
    async function* chunks() {
      await Promise.resolve();
      yield { text: '# Possibly truncated', candidates: [{}] };
    }
    mockGetClient.mockReturnValue({
      models: { generateContentStream: vi.fn().mockResolvedValue(chunks()) },
    });

    await expect(extractTextFromFile(
      FILE_DATA,
      'image/png',
      CLIENT,
      undefined,
      undefined,
      { onProgress: vi.fn() },
    )).rejects.toThrow(/without a terminal STOP/i);
  });
});
