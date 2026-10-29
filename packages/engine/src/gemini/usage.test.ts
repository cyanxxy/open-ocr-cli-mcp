import { beforeEach, describe, expect, it } from 'vitest';

import { getGeminiUsage, recordGeminiUsage, resetGeminiUsage } from './usage';

describe('Gemini usage accumulator', () => {
  beforeEach(() => resetGeminiUsage());

  it('combines generateContent and Interactions token metadata', () => {
    recordGeminiUsage({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
        totalTokenCount: 125,
      },
    }, 'gemini-3.5-flash-lite');
    recordGeminiUsage({
      usage: {
        total_input_tokens: 50,
        total_output_tokens: 10,
        total_tool_use_tokens: 4,
        total_tokens: 64,
      },
    }, 'gemini-3.5-flash-lite');

    expect(getGeminiUsage()).toEqual({
      requests: 2,
      inputTokens: 150,
      outputTokens: 30,
      thoughtTokens: 5,
      toolTokens: 4,
      cachedTokens: 0,
      totalTokens: 189,
      estimatedCostUsd: 0.0001325,
    });
  });

  it('ignores responses without usage metadata', () => {
    recordGeminiUsage({ text: 'no metadata' });
    expect(getGeminiUsage().requests).toBe(0);
  });

  it('accepts the current shared UsageMetadata output-token field', () => {
    recordGeminiUsage({
      usageMetadata: {
        promptTokenCount: 10,
        responseTokenCount: 4,
        totalTokenCount: 14,
      },
    }, 'gemini-3.8-flash');

    expect(getGeminiUsage()).toMatchObject({
      requests: 1,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
  });

  it('records tool-use tokens without double-counting their input cost', () => {
    recordGeminiUsage({
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 25,
        total_tool_use_tokens: 50,
        total_tokens: 125,
      },
    }, 'gemini-3.5-flash-lite');
    expect(getGeminiUsage()).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      toolTokens: 50,
      totalTokens: 125,
      estimatedCostUsd: 0.0000925,
    });
  });
});
