import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecretsForRedaction,
  parseProviderErrorPayload,
  providerErrorMessage,
  providerErrorPayloadOf,
  providerErrorSubject,
  readableProviderError,
  redactSensitiveErrorText,
  registerSecretForRedaction,
  renderProviderErrorPayload,
} from './errorPayload';

/**
 * Bodies recorded verbatim from the live Gemini API (gemini-3.1-flash-lite,
 * 2026-07-26). They are the contract this module reads, so keeping them here
 * turns an upstream wording change into a test failure instead of a silent
 * regression back to generic classification.
 */
const LIVE_BODIES = {
  invalidKey: '{"error":{"code":401,"message":"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.","status":"UNAUTHENTICATED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED","metadata":{"method":"google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent","service":"generativelanguage.googleapis.com"}}]}}',
  corruptImage: '{"error":{"code":400,"message":"Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting","status":"INVALID_ARGUMENT"}}',
  unsupportedMime: '{"error":{"code":400,"message":"Unsupported MIME type: application/x-msdownload","status":"INVALID_ARGUMENT"}}',
  overBudgetSchema: '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}',
  badThinkingLevel: '{"error":{"code":400,"message":"Invalid value at \'generation_config.thinking_config.thinking_level\' (type.googleapis.com/google.ai.generativelanguage.v1beta.ThinkingConfig.ThinkingLevel), \\"ULTRA\\"","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":"generation_config.thinking_config.thinking_level","description":"Invalid value at \'generation_config.thinking_config.thinking_level\'"}]}]}}',
  negativeMaxTokens: '{"error":{"code":400,"message":"* GenerateContentRequest.generation_config.max_output_tokens: max_output_tokens must be positive.\\n","status":"INVALID_ARGUMENT"}}',
  unknownModel: '{"error":{"code":404,"message":"models/gemini-does-not-exist is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.","status":"NOT_FOUND"}}',
} as const;

/**
 * A provider is free to echo the request back inside its own error body. Nothing
 * stops it from quoting the key or the `Authorization` header it rejected, so
 * every rendered form of a body is treated as attacker-influenced text.
 */
const ECHOED_KEY = 'AIzaSyD1234567890abcdefghijklmnopqrstuv';
const ECHOED_BODY = `{"error":{"code":400,"message":"Provider rejected request for key ${ECHOED_KEY}","status":"INVALID_ARGUMENT"}}`;

describe('parseProviderErrorPayload', () => {
  it('reads message, status, code, and ErrorInfo reasons', () => {
    expect(parseProviderErrorPayload(LIVE_BODIES.invalidKey)).toMatchObject({
      code: 401,
      status: 'UNAUTHENTICATED',
      reasons: ['ACCESS_TOKEN_TYPE_UNSUPPORTED'],
      fields: [],
    });
  });

  it('reads BadRequest field violations', () => {
    expect(parseProviderErrorPayload(LIVE_BODIES.badThinkingLevel)?.fields)
      .toEqual(['generation_config.thinking_config.thinking_level']);
  });

  it('recovers a body wrapped in a transport status line', () => {
    expect(parseProviderErrorPayload(`got status: 400 Bad Request. ${LIVE_BODIES.corruptImage}`))
      .toMatchObject({ status: 'INVALID_ARGUMENT', code: 400 });
  });

  it('returns undefined for prose and for JSON that is not an error body', () => {
    expect(parseProviderErrorPayload('Provider request failed with HTTP 500')).toBeUndefined();
    expect(parseProviderErrorPayload('{"choices":[]}')).toBeUndefined();
    expect(parseProviderErrorPayload('{ not json')).toBeUndefined();
  });
});

describe('providerErrorMessage', () => {
  it('replaces a raw body with the sentence the provider wrote', () => {
    const rendered = providerErrorMessage(LIVE_BODIES.invalidKey);
    expect(rendered).toContain('Request had invalid authentication credentials.');
    expect(rendered).not.toContain('type.googleapis.com');
    expect(rendered.length).toBeLessThan(LIVE_BODIES.invalidKey.length);
  });

  it('keeps the machine tokens the sentence does not already carry', () => {
    expect(providerErrorMessage(LIVE_BODIES.invalidKey))
      .toContain('[UNAUTHENTICATED; ACCESS_TOKEN_TYPE_UNSUPPORTED]');
    expect(providerErrorMessage(LIVE_BODIES.corruptImage))
      .toBe('Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting [INVALID_ARGUMENT]');
  });

  it('does not repeat a field the sentence already names', () => {
    const rendered = providerErrorMessage(LIVE_BODIES.badThinkingLevel);
    expect(rendered).toContain('[INVALID_ARGUMENT]');
    expect(rendered.match(/generation_config\.thinking_config\.thinking_level/gu)).toHaveLength(1);
  });

  it('returns non-body text unchanged', () => {
    expect(providerErrorMessage('Gemini request timed out')).toBe('Gemini request timed out');
    expect(providerErrorMessage('')).toBe('');
  });
});

describe('renderProviderErrorPayload', () => {
  it('redacts a credential the provider echoed into its own body', () => {
    const payload = parseProviderErrorPayload(ECHOED_BODY);
    if (!payload) throw new Error('Expected a parsed payload');
    const rendered = renderProviderErrorPayload(payload);
    expect(rendered).not.toContain(ECHOED_KEY);
    expect(rendered).toContain('[REDACTED_KEY]');
  });

  it('cleans the extraction rather than discarding it', () => {
    const payload = parseProviderErrorPayload(ECHOED_BODY);
    if (!payload) throw new Error('Expected a parsed payload');
    // The provider's sentence and its bracketed machine tokens both survive;
    // only the credential-shaped fragment is replaced.
    expect(renderProviderErrorPayload(payload))
      .toBe('Provider rejected request for key [REDACTED_KEY] [INVALID_ARGUMENT]');
    // The unredacted message stays on the payload, because the phrase rules in
    // `providerErrorSubject` match on it.
    expect(payload.message).toContain(ECHOED_KEY);
  });

  it('leaves a body with nothing credential-shaped in it byte-identical', () => {
    const payload = parseProviderErrorPayload(LIVE_BODIES.corruptImage);
    if (!payload) throw new Error('Expected a parsed payload');
    expect(renderProviderErrorPayload(payload))
      .toBe('Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting [INVALID_ARGUMENT]');
  });
});

describe('redactSensitiveErrorText', () => {
  it('strips bearer tokens, provider key formats, and named credential fields', () => {
    const redacted = redactSensitiveErrorText(
      `Authorization: Bearer ${ECHOED_KEY}; api_key=sk-live-abcdefghijklmnop`,
    );
    expect(redacted).not.toContain(ECHOED_KEY);
    expect(redacted).not.toContain('sk-live');
  });

  it('is safe to apply twice', () => {
    const once = redactSensitiveErrorText(`key ${ECHOED_KEY} rejected`);
    expect(redactSensitiveErrorText(once)).toBe(once);
  });

  it('does not mangle a request-field path that merely contains "token"', () => {
    // `max_output_tokens:` looks like a named credential field to a careless
    // pattern; keeping it intact is what lets `providerErrorSubject` still
    // recognise a request-field rejection after rendering.
    const message = '* GenerateContentRequest.generation_config.max_output_tokens: max_output_tokens must be positive.';
    expect(redactSensitiveErrorText(message)).toBe(message);
  });

  describe('registered credential values', () => {
    afterEach(() => clearRegisteredSecretsForRedaction());

    // A bare key in a format no pattern knows used to pass straight through.
    const BARE_KEY = 'opaque9Q2xLmW7vKp3';

    it('scrubs a registered value that matches no credential pattern', () => {
      expect(redactSensitiveErrorText(`invalid key ${BARE_KEY}`)).toContain(BARE_KEY);
      registerSecretForRedaction(BARE_KEY);
      const redacted = redactSensitiveErrorText(`invalid key ${BARE_KEY} (was ${encodeURIComponent(BARE_KEY)})`);
      expect(redacted).not.toContain(BARE_KEY);
      expect(redacted).toBe('invalid key [REDACTED_KEY] (was [REDACTED_KEY])');
      expect(redactSensitiveErrorText(redacted)).toBe(redacted);
    });

    it('scrubs the untrimmed and trimmed spellings and through provider rendering', () => {
      registerSecretForRedaction(`  ${BARE_KEY}\n`);
      expect(providerErrorMessage(JSON.stringify({ error: { message: `API key ${BARE_KEY} not valid` } })))
        .toBe('API key [REDACTED_KEY] not valid');
      const restated = readableProviderError(new Error(`rejected ${BARE_KEY}`)) as Error;
      expect(restated.message).toBe('rejected [REDACTED_KEY]');
    });

    it('ignores values too short to be a credential', () => {
      registerSecretForRedaction('test');
      registerSecretForRedaction('');
      registerSecretForRedaction(undefined);
      expect(redactSensitiveErrorText('a test message')).toBe('a test message');
    });
  });
});

describe('providerErrorPayloadOf', () => {
  /**
   * The Interactions API throws an `ApiError` subclass whose `message` is a
   * content-free "401 API error occurred: {...httpMeta}" summary and whose
   * `body` own-property holds the real payload, wrapped in a JSON array.
   * Recorded live on 2026-07-26.
   */
  const interactionsError = (): Error => Object.assign(
    new Error('401 API error occurred: {"httpMeta":{"response":{},"request":{}}}'),
    {
      name: 'AuthenticationError',
      status: 401,
      body: `[${LIVE_BODIES.invalidKey}]`,
    },
  );

  it('reads the body when the message has nothing in it', () => {
    expect(providerErrorPayloadOf(interactionsError())).toMatchObject({
      status: 'UNAUTHENTICATED',
      reasons: ['ACCESS_TOKEN_TYPE_UNSUPPORTED'],
    });
  });

  it('prefers the message when it already carries the body', () => {
    expect(providerErrorPayloadOf(new Error(LIVE_BODIES.corruptImage))?.status)
      .toBe('INVALID_ARGUMENT');
  });

  it('returns undefined when no property holds an error body', () => {
    expect(providerErrorPayloadOf(new Error('Gemini request timed out'))).toBeUndefined();
    expect(providerErrorPayloadOf('not an object')).toBeUndefined();
  });
});

describe('readableProviderError', () => {
  it('restates the message and keeps the original reachable as cause', () => {
    const original = Object.assign(new Error(LIVE_BODIES.invalidKey), { name: 'ApiError', status: 401 });
    const restated = readableProviderError(original) as Error & { status?: number };
    expect(restated).not.toBe(original);
    expect(restated.message).toContain('Request had invalid authentication credentials.');
    expect(restated.message).not.toContain('type.googleapis.com');
    expect(restated.cause).toBe(original);
    expect(restated.name).toBe('ApiError');
    expect(restated.status).toBe(401);
  });

  it('redacts the restated message while cause keeps the untouched body', () => {
    const original = Object.assign(new Error(ECHOED_BODY), { name: 'ApiError', status: 400 });
    const restated = readableProviderError(original) as Error;
    expect(restated.message).not.toContain(ECHOED_KEY);
    expect(restated.message).toContain('[REDACTED_KEY]');
    // Defence in depth, not a leak: `cause` is a non-enumerable Error property,
    // so no serialized surface carries it — see the CLI's `cause` guard.
    expect((restated.cause as Error).message).toContain(ECHOED_KEY);
    expect(JSON.stringify(restated)).not.toContain(ECHOED_KEY);
  });

  it('redacts a bare message even when there is no parseable body', () => {
    const restated = readableProviderError(new Error(`upstream refused key ${ECHOED_KEY}`)) as Error;
    expect(restated.message).toBe('upstream refused key [REDACTED_KEY]');
  });

  it('returns errors that already read well untouched', () => {
    const timeout = new Error('Gemini request timed out');
    expect(readableProviderError(timeout)).toBe(timeout);
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(readableProviderError(abort)).toBe(abort);
  });

  it('is idempotent', () => {
    const once = readableProviderError(Object.assign(new Error(LIVE_BODIES.corruptImage), { status: 400 }));
    expect(readableProviderError(once)).toBe(once);
  });

  it('passes non-errors through', () => {
    expect(readableProviderError('plain string')).toBe('plain string');
    expect(readableProviderError(undefined)).toBeUndefined();
  });
});

describe('providerErrorSubject', () => {
  const subjectOf = (body: string) => {
    const payload = parseProviderErrorPayload(body);
    return payload ? providerErrorSubject(payload) : undefined;
  };

  it('blames the document when the provider names the media', () => {
    expect(subjectOf(LIVE_BODIES.corruptImage)).toBe('input-media');
    expect(subjectOf(LIVE_BODIES.unsupportedMime)).toBe('input-media');
  });

  it('blames a request field when the provider names one', () => {
    expect(subjectOf(LIVE_BODIES.badThinkingLevel)).toBe('request-field');
    expect(subjectOf(LIVE_BODIES.negativeMaxTokens)).toBe('request-field');
  });

  it('blames the model when the provider says it does not exist', () => {
    expect(subjectOf(LIVE_BODIES.unknownModel)).toBe('model');
  });

  it('blames the response schema when a violation names it', () => {
    expect(providerErrorSubject({
      message: 'Invalid value at \'generation_config.response_json_schema\'',
      status: 'INVALID_ARGUMENT',
      reasons: [],
      fields: ['generation_config.response_json_schema'],
    })).toBe('response-schema');
  });

  it('stays unclassified for a bare invalid-argument body', () => {
    // The over-budget response-schema grammar lands here. Nothing in the body
    // distinguishes it from any other malformed request, so guessing would be
    // worse than the generic provider verdict.
    expect(subjectOf(LIVE_BODIES.overBudgetSchema)).toBeUndefined();
  });

  it('stays unclassified for authentication and server failures', () => {
    expect(subjectOf(LIVE_BODIES.invalidKey)).toBeUndefined();
    expect(providerErrorSubject({
      message: 'The service is currently unavailable.',
      status: 'UNAVAILABLE',
      reasons: [],
      fields: [],
    })).toBeUndefined();
  });
});
