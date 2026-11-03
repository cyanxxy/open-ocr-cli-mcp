import { describe, expect, it } from 'vitest';

import { readableProviderError } from './errorPayload';
import {
  classifyGeminiQuotaError,
  isGeminiQuotaExhaustedError,
  isRetryableGeminiError,
} from './client';
import { isQuotaExhaustedError, providerRetryAfterMs } from '../providers/retry';

/**
 * Shapes below are the ones Google's own gemini-cli pins in
 * packages/core/src/utils/googleQuotaErrors.test.ts and the payload reported in
 * google-gemini/gemini-cli#8437. The @google/genai SDK throws an `ApiError`
 * whose `message` is the response body verbatim and whose `status` is numeric.
 */
function sdkError(body: unknown, status = 429): Error {
  return Object.assign(new Error(JSON.stringify(body)), { name: 'ApiError', status });
}

const STANDARD_429_SENTENCE = 'You exceeded your current quota, please check your plan and billing details. '
  + 'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.';

const quotaFailure = (...quotaIds: string[]) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: quotaIds.map((quotaId) => ({
    quotaMetric: quotaId.includes('InputTokens')
      ? 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count'
      : 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
    quotaId,
    quotaDimensions: { location: 'global', model: 'gemini-2.5-flash-preview-image' },
  })),
});
const help = {
  '@type': 'type.googleapis.com/google.rpc.Help',
  links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }],
};
const retryInfo = (retryDelay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });

const resourceExhausted = (message: string, details: unknown[] = []) => ({
  error: { code: 429, message, status: 'RESOURCE_EXHAUSTED', details },
});

describe('Gemini quota classification (gemini-cli googleQuotaErrors rule)', () => {
  const perMinute = sdkError(resourceExhausted(STANDARD_429_SENTENCE, [
    quotaFailure(
      'GenerateContentInputTokensPerModelPerMinute-FreeTier',
      'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
    ),
    help,
    retryInfo('55s'),
  ]));

  it('retries a per-minute quota even though its sentence mentions "billing details"', () => {
    expect(isGeminiQuotaExhaustedError(perMinute)).toBe(false);
    expect(isQuotaExhaustedError(perMinute)).toBe(false);
    expect(isRetryableGeminiError(perMinute)).toBe(true);
    expect(providerRetryAfterMs(perMinute)).toBe(55_000);
  });

  it('keeps the verdict after the adapter restates the body as a readable sentence', () => {
    const restated = readableProviderError(perMinute) as Error;
    expect(restated.message).not.toContain('{');
    expect(isGeminiQuotaExhaustedError(restated)).toBe(false);
    expect(isRetryableGeminiError(restated)).toBe(true);
    expect(providerRetryAfterMs(restated)).toBe(55_000);
  });

  it('retries an unclassified 429 that carries only the standard sentence', () => {
    const bare = sdkError(resourceExhausted(STANDARD_429_SENTENCE));
    expect(classifyGeminiQuotaError(bare)).toBe('retryable');
    expect(isRetryableGeminiError(bare)).toBe(true);
    expect(classifyGeminiQuotaError(Object.assign(new Error(STANDARD_429_SENTENCE), { status: 429 })))
      .toBe('retryable');
  });

  it('treats a PerDay or Daily QuotaFailure violation as terminal (gemini-cli#8437 payload)', () => {
    const issue8437 = sdkError(resourceExhausted(STANDARD_429_SENTENCE, [
      quotaFailure(
        'GenerateContentInputTokensPerModelPerMinute-FreeTier',
        'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
        'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      ),
      help,
      retryInfo('55s'),
    ]));
    expect(isGeminiQuotaExhaustedError(issue8437)).toBe(true);
    expect(isRetryableGeminiError(issue8437)).toBe(false);
    expect(isGeminiQuotaExhaustedError(readableProviderError(issue8437))).toBe(true);
    const daily = sdkError(resourceExhausted('Quota exceeded.', [quotaFailure('DailyGenerateRequests')]));
    expect(isGeminiQuotaExhaustedError(daily)).toBe(true);
  });

  it('treats limit: 0 as terminal but not limit: 0.5 or limit: 2', () => {
    const zero = sdkError({
      error: {
        code: 429,
        status: 429,
        message: `${STANDARD_429_SENTENCE} To monitor your current usage, head to: https://ai.dev/usage?tab=rate-limit. `
          + '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
          + 'limit: 0\nPlease retry in 59.906331105s.',
        details: [{ detail: '??? to (unknown) : APP_ERROR(8) You exceeded your current quota' }],
      },
    });
    expect(isGeminiQuotaExhaustedError(zero)).toBe(true);
    expect(isGeminiQuotaExhaustedError(Object.assign(
      new Error('Quota exceeded for metric: ...\nlimit: 0. Please retry in 59s.'),
      { status: 429 },
    ))).toBe(true);
    expect(isGeminiQuotaExhaustedError(Object.assign(
      new Error('Quota exceeded for metric: ...\nlimit: 0.5. Please retry in 59s.'),
      { status: 429 },
    ))).toBe(false);
    const two = sdkError({
      error: {
        code: 429,
        status: 429,
        message: `${STANDARD_429_SENTENCE}\n* Quota exceeded for metric: `
          + 'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 2\nPlease retry in 44.097740004s.',
      },
    });
    expect(isGeminiQuotaExhaustedError(two)).toBe(false);
    expect(isRetryableGeminiError(two)).toBe(true);
  });

  it('treats a retry delay longer than 300s as terminal', () => {
    expect(isGeminiQuotaExhaustedError(sdkError(resourceExhausted('Quota exceeded.', [retryInfo('301s')])))).toBe(true);
    expect(isGeminiQuotaExhaustedError(sdkError(resourceExhausted('Quota exceeded.', [retryInfo('300s')])))).toBe(false);
    expect(isGeminiQuotaExhaustedError(Object.assign(
      new Error('Resource exhausted. Please retry in 400s'),
      { status: 429 },
    ))).toBe(true);
    expect(isRetryableGeminiError(Object.assign(new Error('Resource exhausted. Please retry in 5s'), { status: 429 })))
      .toBe(true);
  });

  it('treats a project spending cap as terminal on 429 and 400', () => {
    const message = 'Your project has exceeded its monthly spending cap. Please go to AI Studio at '
      + 'https://ai.studio/spend to manage your project spend cap. '
      + 'Learn more at https://ai.google.dev/gemini-api/docs/billing#project-spend-caps. ';
    expect(isGeminiQuotaExhaustedError(sdkError(resourceExhausted(message)))).toBe(true);
    expect(isGeminiQuotaExhaustedError(sdkError({
      error: { code: 400, message, status: 'FAILED_PRECONDITION' },
    }, 400))).toBe(true);
    expect(isGeminiQuotaExhaustedError(sdkError(resourceExhausted('Unable to spend capacity on model.')))).toBe(false);
  });

  it('reports billing-not-enabled as terminal only outside a 429', () => {
    const billing = sdkError({
      error: {
        code: 400,
        message: 'Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.',
        status: 'FAILED_PRECONDITION',
      },
    }, 400);
    expect(isGeminiQuotaExhaustedError(billing)).toBe(true);
    expect(isRetryableGeminiError(billing)).toBe(false);
  });

  it('treats the Interactions API quota_exceeded / payment_required codes as exhausted', () => {
    // Interactions SSE `error` event, rethrown by interactions.ts with its snake_case code.
    const streamed = Object.assign(new Error('Daily quota exceeded.'), { code: 'quota_exceeded' });
    expect(isGeminiQuotaExhaustedError(streamed)).toBe(true);
    expect(isRetryableGeminiError(streamed)).toBe(false);
    expect(isGeminiQuotaExhaustedError(Object.assign(new Error('x'), { code: 'QUOTA_EXCEEDED' }))).toBe(true);
    // Interactions SDK APIError: numeric status plus the raw body on `body`.
    const sdk = Object.assign(new Error('429 Daily quota exceeded.'), {
      status: 429,
      body: JSON.stringify({ error: { code: 'quota_exceeded', message: 'Daily quota exceeded.' } }),
    });
    expect(isGeminiQuotaExhaustedError(sdk)).toBe(true);
    const credits = Object.assign(new Error('402 Your Prepay credit balance is depleted.'), {
      status: 402,
      body: JSON.stringify({ error: { code: 'payment_required', message: 'Your Prepay credit balance is depleted.' } }),
    });
    expect(isGeminiQuotaExhaustedError(credits)).toBe(true);
    const perMinuteStream = Object.assign(new Error('Rate limit exceeded.'), { code: 'rate_limit_exceeded' });
    expect(isGeminiQuotaExhaustedError(perMinuteStream)).toBe(false);
    expect(isRetryableGeminiError(perMinuteStream)).toBe(true);
    expect(isRetryableGeminiError(Object.assign(new Error('Busy.'), { code: 'too_many_requests' }))).toBe(true);
  });
});
