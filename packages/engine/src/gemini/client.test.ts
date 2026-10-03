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
  it('uses current Flash defaults and rejects minimal for 3.8 and 3.7 before sending', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.7-flash'] as const) {
      expect(applyThinkingConfig({}, model).thinkingConfig.thinkingLevel).toBe('MEDIUM');
      expect(() => applyThinkingConfig({}, model, { level: 'MINIMAL' })).toThrow('minimal is not supported');
    }
    expect(applyThinkingConfig({}, 'gemini-3.5-flash-lite').thinkingConfig.thinkingLevel).toBe('MINIMAL');
    expect(applyThinkingConfig({}, 'gemini-3.6-flash', { level: 'MINIMAL' }).thinkingConfig.thinkingLevel).toBe('MINIMAL');
  });
  it('defaults thinking by model family when no config is provided', () => {
    expect(applyThinkingConfig({}, 'gemini-3.1-pro-preview').thinkingConfig).toEqual({
      thinkingLevel: 'HIGH',
    });
    expect(applyThinkingConfig({}, 'gemini-3.5-flash').thinkingConfig).toEqual({
      thinkingLevel: 'MEDIUM',
    });
    expect(applyThinkingConfig({}, 'gemini-3.1-flash-lite').thinkingConfig).toEqual({
      thinkingLevel: 'MINIMAL',
    });
  });

  it('uses the SDK thinking enum and preserves the base config', () => {
    const result = applyThinkingConfig(
      { temperature: 0.2 },
      'gemini-3-flash-preview',
      { level: 'MEDIUM', includeThoughts: true },
    );
    expect(result).toEqual({
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'MEDIUM', includeThoughts: true },
    });
  });

  it('allows minimal on Flash models but rejects it on Pro instead of silently upgrading it', () => {
    const flash = applyThinkingConfig({}, 'gemini-3.5-flash', { level: 'MINIMAL' });
    expect(flash.thinkingConfig.thinkingLevel).toBe('MINIMAL');

    const lite = applyThinkingConfig({}, 'gemini-3.1-flash-lite', { level: 'MINIMAL' });
    expect(lite.thinkingConfig.thinkingLevel).toBe('MINIMAL');

    expect(() => applyThinkingConfig(
      {},
      'gemini-3.1-pro-preview',
      { level: 'MINIMAL' },
    )).toThrow('gemini-3.1-pro-preview supports thinking levels low, medium, high');
  });
});
