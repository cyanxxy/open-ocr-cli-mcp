import { beforeEach, describe, expect, it } from 'vitest';

import { createProviderExecutionContext } from '../providers/runtime';
import { getGeminiUsage, recordGeminiInteractionUsage, recordGeminiUsage, resetGeminiUsage } from './usage';

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
      // The 4 tool-use tokens are billed as input: (150 + 4) * 0.3 + 30 * 2.5 + 5 * 2.5.
      estimatedCostUsd: 0.0001337,
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

  it('bills tool-use tokens as input, which Gemini reports apart from the prompt', () => {
    recordGeminiUsage({
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 25,
        total_tool_use_tokens: 50,
        total_tokens: 175,
      },
    }, 'gemini-3.5-flash-lite');
    expect(getGeminiUsage()).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      toolTokens: 50,
      totalTokens: 175,
      // (100 + 50) * 0.3 + 25 * 2.5 per million.
      estimatedCostUsd: 0.0001075,
    });
  });

  it('prices URL-context page content so a web request trips its cost cap', () => {
    // Interactions URL-context usage: total_tokens is the sum of all four
    // counts, so the 10309 tool-use tokens are not inside total_input_tokens.
    const runtime = createProviderExecutionContext({ maxCostUsd: 0.01 });
    recordGeminiInteractionUsage({
      usage: {
        total_input_tokens: 27,
        total_tool_use_tokens: 10309,
        total_output_tokens: 600,
        total_thought_tokens: 200,
        total_tokens: 11136,
      },
    }, 'gemini-4-hydrogen', runtime);
    expect(runtime.getUsage()).toMatchObject({ inputTokens: 27, toolTokens: 10309, totalTokens: 11136 });
    // (27 + 10309) * 1.5 + (600 + 200) * 7.5 per million.
    expect(runtime.getUsage().estimatedCostUsd).toBeCloseTo(0.021504, 8);
    expect(runtime.hasReachedCostLimit()).toBe(true);
  });

  it('prices generateContent toolUsePromptTokenCount and counts it in a missing total', () => {
    const runtime = createProviderExecutionContext();
    recordGeminiUsage({
      usageMetadata: {
        promptTokenCount: 27,
        toolUsePromptTokenCount: 10309,
        candidatesTokenCount: 45,
        thoughtsTokenCount: 31,
      },
    }, 'gemini-3.5-flash-lite', runtime);
    expect(runtime.getUsage()).toMatchObject({ toolTokens: 10309, totalTokens: 10412 });
    // (27 + 10309) * 0.3 + (45 + 31) * 2.5 per million.
    expect(runtime.getUsage().estimatedCostUsd).toBeCloseTo(0.0032908, 8);
  });
});
