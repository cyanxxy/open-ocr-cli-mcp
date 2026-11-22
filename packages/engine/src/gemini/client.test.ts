import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGenerateContent, mockGenerateContentStream } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockGenerateContentStream: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  ThinkingLevel: {
    MINIMAL: 'MINIMAL',
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
  },
  GoogleGenAI: vi.fn(function (this: { models: Record<string, unknown> }) {
    this.models = {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    };
  }),
}));

import { GoogleGenAI } from '@google/genai';
import {
  applyThinkingConfig,
  assertCompleteGeminiResponse,
  createGeminiStreamCompletionTracker,
  getGenAIClient,
  isFatalGeminiError,
  isRetryableGeminiError,
} from './client';
import { OcrError, OcrErrorType } from './types';

const MockedGoogleGenAI = vi.mocked(GoogleGenAI);

describe('getGenAIClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws an OcrError when the API key is missing', () => {
    expect(() => getGenAIClient('')).toThrow(OcrError);
    try {
      getGenAIClient('');
    } catch (error) {
      expect((error as OcrError).type).toBe(OcrErrorType.API_KEY_MISSING);
    }
  });

  it('caches clients per API key', () => {
    const first = getGenAIClient('cache-test-key');
    const second = getGenAIClient('cache-test-key');
    expect(second).toBe(first);
    expect(MockedGoogleGenAI).toHaveBeenCalledTimes(1);
  });
});

describe('assertCompleteGeminiResponse', () => {
  it('rejects a response with no candidate instead of allowing an empty success', () => {
    expect(() => assertCompleteGeminiResponse({ candidates: undefined }))
      .toThrow(/no candidate/i);
  });

  it('rejects a blocked prompt and a MAX_TOKENS candidate, accepts STOP', () => {
    expect(() => assertCompleteGeminiResponse({
      candidates: [{ finishReason: 'STOP' }],
      promptFeedback: { blockReason: 'SAFETY' },
    })).toThrow(/blocked by safety filters/i);
    expect(() => assertCompleteGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
      .toThrow(/incomplete output/i);
    expect(() => assertCompleteGeminiResponse({ candidates: [{ finishReason: 'STOP' }] }))
      .not.toThrow();
  });

  it('reports an uncontinued CONTINUATION stop (@google/genai >= 2.26) as the per-request limit', () => {
    let message = '';
    try {
      assertCompleteGeminiResponse({ candidates: [{ finishReason: 'CONTINUATION' }] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('per-request output limit');
    expect(message).toMatch(/incomplete output/i);
    // A higher output-token limit cannot get past this stop, so never advise one.
    expect(message).not.toContain('reached the output token limit');
    expect(message).not.toContain('Increase the output-token limit');
    expect(message).not.toContain('max-tokens');
    expect(() => assertCompleteGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
      .toThrow(/reached the output token limit.*Increase the output-token limit/i);
  });

  it('rejects a candidate without a terminal finish reason', () => {
    expect(() => assertCompleteGeminiResponse({ candidates: [{}] }))
      .toThrow(/without a terminal finish reason/i);
  });
});

describe('createGeminiStreamCompletionTracker', () => {
  it('rejects a stream that reaches MAX_TOKENS', () => {
    const completion = createGeminiStreamCompletionTracker();
    completion.observe({ candidates: [{}] });
    expect(() => completion.observe({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
      .toThrow(/incomplete output/i);
  });

  it('rejects a stream that ends without terminal STOP', () => {
    const completion = createGeminiStreamCompletionTracker();
    completion.observe({ candidates: [{}] });
    expect(() => completion.assertComplete()).toThrow(/without a terminal STOP/i);
  });

  it('accepts a stream whose last candidate reports STOP, ignoring usage-only chunks', () => {
    const completion = createGeminiStreamCompletionTracker();
    completion.observe({ candidates: [{}] });
    completion.observe({ candidates: [{ finishReason: 'STOP' }] });
    completion.observe({});
    expect(() => completion.assertComplete()).not.toThrow();
  });
});

describe('Gemini error classification', () => {
  it('uses structured status before misleading message prose', () => {
    const transient = Object.assign(new Error('API key service unavailable'), { status: 503 });
    expect(isFatalGeminiError(transient)).toBe(false);
    expect(isRetryableGeminiError(transient)).toBe(true);

    const invalid = Object.assign(new Error('request rejected'), { status: 401 });
    expect(isFatalGeminiError(invalid)).toBe(true);
    expect(isRetryableGeminiError(invalid)).toBe(false);
  });

  it('recognizes current structured RPC error codes through wrapper causes', () => {
    const exhausted = new Error('provider request failed', {
      cause: Object.assign(new Error('busy'), { code: 'RESOURCE_EXHAUSTED' }),
    });
    const denied = Object.assign(new Error('request rejected'), { code: 'PERMISSION_DENIED' });
    expect(isRetryableGeminiError(exhausted)).toBe(true);
    expect(isFatalGeminiError(denied)).toBe(true);
  });

  it('classifies engine OUTPUT_INVALID errors by type, whatever digits their message quotes', () => {
    for (const message of [
      'Re-OCR returned invalid JSON: Expected \',\' or \'}\' after property value in JSON at position 403 (line 1 column 404)',
      'Re-OCR returned invalid JSON: Unexpected token in JSON at position 503 (line 1 column 504)',
      'Extraction requested JSON but the response did not match the OCR schema: sections[401].content[0] must be a string',
      'Re-OCR returned invalid JSON: quota network timeout unavailable',
    ]) {
      const error = new OcrError(OcrErrorType.OUTPUT_INVALID, message, undefined, { cause: new SyntaxError('bad') });
      expect(isFatalGeminiError(error), message).toBe(false);
      expect(isRetryableGeminiError(error), message).toBe(false);
      // A retry layer that copies the message is classified by the same type.
      const restated = new Error(message, { cause: error });
      expect(isFatalGeminiError(restated), message).toBe(false);
      expect(isRetryableGeminiError(restated), message).toBe(false);
    }
    const missingKey = new OcrError(OcrErrorType.API_KEY_MISSING, 'API key is required for Gemini AI');
    expect(isFatalGeminiError(missingKey)).toBe(true);
    expect(isRetryableGeminiError(missingKey)).toBe(false);
  });

  it('reads a status from status-shaped text only, not from bare digits', () => {
    expect(isFatalGeminiError(new Error('Unexpected token at position 403'))).toBe(false);
    expect(isRetryableGeminiError(new Error('Unexpected token at position 503'))).toBe(false);
    expect(isRetryableGeminiError(new Error('page 1429 of the document'))).toBe(false);
    expect(isFatalGeminiError(new Error('401 Request had invalid authentication credentials'))).toBe(true);
    expect(isFatalGeminiError(new Error('request failed: [403 Forbidden]'))).toBe(true);
    expect(isFatalGeminiError(new Error('Request failed with status code 401'))).toBe(true);
    expect(isRetryableGeminiError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableGeminiError(new Error('upstream answered HTTP 502'))).toBe(true);
    expect(isRetryableGeminiError(new Error('{"error":{"code":503}}'))).toBe(true);
  });

  it('never retries an undici headers or body timeout, but still retries a socket reset', () => {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      const timeout = new TypeError('fetch failed', { cause: Object.assign(new Error('timeout'), { code }) });
      expect(isRetryableGeminiError(timeout), code).toBe(false);
    }
    const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    expect(isRetryableGeminiError(reset)).toBe(true);
  });

  it('treats a credential-specific Gemini HTTP 400 as fatal without classifying every 400 that way', () => {
    expect(isFatalGeminiError(Object.assign(
      new Error('API key not valid. Please pass a valid API key.'),
      { status: 400 },
    ))).toBe(true);
    expect(isFatalGeminiError(Object.assign(
      new Error('Invalid request parameter'),
      { status: 400 },
    ))).toBe(false);
  });
});

describe('applyThinkingConfig', () => {
  it('uses current defaults and rejects minimal for 3.8 Flash and 4 Argon before sending', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-4-argon'] as const) {
      expect(applyThinkingConfig({}, model).thinkingConfig.thinkingLevel).toBe('MEDIUM');
      expect(() => applyThinkingConfig({}, model, { level: 'MINIMAL' })).toThrow('minimal is not supported');
    }
    expect(applyThinkingConfig({}, 'gemini-3.5-flash-lite').thinkingConfig.thinkingLevel).toBe('MINIMAL');
  });
  it('defaults thinking by model family when no config is provided', () => {
    expect(applyThinkingConfig({}, 'gemini-4-argon').thinkingConfig).toEqual({
      thinkingLevel: 'MEDIUM',
    });
    expect(applyThinkingConfig({}, 'gemini-3.8-flash').thinkingConfig).toEqual({
      thinkingLevel: 'MEDIUM',
    });
    expect(applyThinkingConfig({}, 'gemini-3.5-flash-lite').thinkingConfig).toEqual({
      thinkingLevel: 'MINIMAL',
    });
  });

  it('uses the SDK thinking enum and preserves the base config', () => {
    const result = applyThinkingConfig(
      { temperature: 0.2 },
      'gemini-3.5-flash-lite',
      { level: 'MEDIUM', includeThoughts: true },
    );
    expect(result).toEqual({
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
    });
  });

  it('sends XHIGH to Gemini 4 Hydrogen and Neon and defaults them to HIGH', () => {
    for (const model of ['gemini-4-hydrogen', 'gemini-4-neon'] as const) {
      expect(applyThinkingConfig({}, model, { level: 'XHIGH' }).thinkingConfig.thinkingLevel).toBe('XHIGH');
      expect(applyThinkingConfig({}, model).thinkingConfig.thinkingLevel).toBe('HIGH');
      expect(() => applyThinkingConfig({}, model, { level: 'MINIMAL' })).toThrow('minimal is not supported');
    }
    expect(applyThinkingConfig({}, 'gemini-4-carbon').thinkingConfig.thinkingLevel).toBe('MEDIUM');
    expect(() => applyThinkingConfig({}, 'gemini-4-carbon', { level: 'XHIGH' })).toThrow('xhigh is not supported');
    expect(() => applyThinkingConfig({}, 'gemini-4-argon', { level: 'XHIGH' })).toThrow('xhigh is not supported');
    expect(() => applyThinkingConfig({}, 'gemini-4-hydrogen', { level: 'MAX' })).toThrow('max is not supported');
  });

  it('allows minimal on Flash-Lite but rejects it on Argon instead of silently upgrading it', () => {
    const lite = applyThinkingConfig({}, 'gemini-3.5-flash-lite', { level: 'MINIMAL' });
    expect(lite.thinkingConfig.thinkingLevel).toBe('MINIMAL');

    expect(() => applyThinkingConfig(
      {},
      'gemini-4-argon',
      { level: 'MINIMAL' },
    )).toThrow('gemini-4-argon supports thinking levels low, medium, high');
  });
});
