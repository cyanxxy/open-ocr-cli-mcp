import { describe, expect, it } from 'vitest';

import { findSchemaCompatibilityIssues } from '@open-ocr/engine/gemini/schemaCompat';
import { OcrError, OcrErrorType } from '@open-ocr/engine/gemini/types';
import { ProviderApiError } from '@open-ocr/engine/providers';
import {
  asCliExitError,
  CliExitError,
  cliBatchExitCode,
  cliExitCode,
  cliRunStatusExitCode,
  cliSignalExitCode,
  isBrokenPipeError,
  OCR_ERROR_CODES,
  ocrErrorPayload,
  renderCliError,
} from './errors';

describe('CLI exit errors', () => {
  it('recognizes only a direct closed-pipe stream error', () => {
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isBrokenPipeError(brokenPipe)).toBe(true);
    expect(isBrokenPipeError(new Error('provider write failed', { cause: brokenPipe }))).toBe(false);
    expect(isBrokenPipeError(new Error('ordinary failure'))).toBe(false);
  });

  it('classifies expected runtime failures without changing their message', () => {
    const cause = new Error('Gemini request timed out');
    const error = asCliExitError(cause, 1);
    expect(error).toBeInstanceOf(CliExitError);
    expect(error.message).toBe('Gemini request timed out');
    expect(error.cause).toBe(cause);
    expect(cliExitCode(error)).toBe(1);
  });

  it('redacts credential-like fragments in provider error text', () => {
    const error = asCliExitError(
      new Error('Upstream said Authorization: Bearer sk-live-supersecret-token-value'),
      1,
    );
    expect(error.message).not.toContain('sk-live');
    expect(error.message).not.toContain('supersecret');
    expect(error.message).toContain('[REDACTED');
  });

  it('defaults unexpected command failures to exit code 2', () => {
    expect(cliExitCode(new Error('invalid configuration'))).toBe(2);
  });

  it('uses conventional shell exit codes for interrupts', () => {
    expect(cliSignalExitCode('SIGINT')).toBe(130);
    expect(cliSignalExitCode('SIGTERM')).toBe(143);
  });

  it('exposes stable machine error codes, retryability, and remediation hints', () => {
    expect(ocrErrorPayload(new Error('Gemini request timed out'), 1)).toMatchObject({
      code: 'TIMEOUT',
      category: 'limit',
      retryable: true,
    });
    expect(ocrErrorPayload(new Error('Gemini API key is missing'), 2)).toMatchObject({
      code: 'AUTH_MISSING',
      category: 'authentication',
      retryable: false,
    });
    expect(ocrErrorPayload(new TypeError('fetch failed'), 1)).toMatchObject({
      code: 'PROVIDER_FAILURE',
      category: 'provider',
      retryable: true,
    });
  });

  it('renders typed errors and hints for the human command surface', () => {
    const output = renderCliError(new CliExitError('Missing scan', 2, {
      code: 'INPUT_NOT_FOUND',
      category: 'input',
      retryable: false,
      hint: 'Check the input path.',
    }), 'open-ocr-cli');
    expect(output).toBe(
      'open-ocr-cli: [INPUT_NOT_FOUND] Missing scan\n'
      + 'open-ocr-cli: hint: Check the input path.\n',
    );
  });

  it('degrades an unguarded filesystem errno instead of falling through to the default', () => {
    const notFound = Object.assign(new Error("ENOENT: no such file or directory, stat '/tmp/nope'"), {
      code: 'ENOENT',
    });
    expect(ocrErrorPayload(notFound, 2)).toMatchObject({
      code: 'INPUT_NOT_FOUND',
      category: 'input',
      retryable: false,
    });
    const isDirectory = Object.assign(new Error('EISDIR: illegal operation on a directory'), {
      code: 'EISDIR',
    });
    expect(ocrErrorPayload(isDirectory, 2)).toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
    });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(ocrErrorPayload(denied, 2)).toMatchObject({
      code: 'PERMISSION_DENIED',
      category: 'authorization',
      retryable: false,
    });
  });

  it('lets a typed configuration error outrank an option name that reads like a runtime failure', () => {
    // A bare Error here would match the untyped "timeout" substring rule and be
    // reported as a retryable TIMEOUT, looping any retry harness forever.
    expect(ocrErrorPayload(new CliExitError('--timeout must be an integer from 1 to 3600', 2, {
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
    }), 2)).toMatchObject({
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
    });
    // A genuine runtime timeout still classifies from its message.
    expect(ocrErrorPayload(new Error('Gemini request timed out'), 1)).toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
  });

  it('does not classify configuration or output prose as a custom-schema failure', () => {
    expect(ocrErrorPayload(new Error('--schema cannot be combined with --preset'), 2)).toMatchObject({
      code: 'CONFIG_INVALID',
      category: 'configuration',
    });
    expect(ocrErrorPayload(new Error('Failed to write schema-looking path'), 2)).toMatchObject({
      code: 'CONFIG_INVALID',
      category: 'configuration',
    });
    expect(ocrErrorPayload(new Error('Output already exists: /tmp/schema-results'), 2)).toMatchObject({
      code: 'OUTPUT_CONFLICT',
      category: 'output',
      hint: 'Choose a new output path or resume a matching job.',
    });
  });

  it('prefers typed provider metadata over misleading message text', () => {
    expect(ocrErrorPayload(new ProviderApiError(
      'Upstream mentioned a cost limit while its service was unavailable',
      503,
    ), 1)).toMatchObject({
      code: 'PROVIDER_FAILURE',
      category: 'provider',
      retryable: true,
    });
    expect(ocrErrorPayload(new ProviderApiError('Unauthorized', 401), 1)).toMatchObject({
      code: 'AUTH_INVALID',
      category: 'authentication',
      retryable: false,
    });
    expect(ocrErrorPayload(new ProviderApiError('Forbidden', 403), 1)).toMatchObject({
      code: 'PERMISSION_DENIED',
      category: 'authorization',
      retryable: false,
    });
    expect(ocrErrorPayload(new ProviderApiError('Conflict', 409), 1)).toMatchObject({
      code: 'PROVIDER_FAILURE',
      category: 'provider',
      retryable: true,
    });
  });

  it('classifies current Gemini credential and RPC error shapes without relying on HTTP 401', () => {
    expect(ocrErrorPayload(Object.assign(
      new Error('API key not valid. Please pass a valid API key.'),
      { name: 'ApiError', status: 400 },
    ), 1)).toMatchObject({
      code: 'AUTH_INVALID',
      category: 'authentication',
      retryable: false,
    });
    expect(ocrErrorPayload(Object.assign(
      new Error('quota exhausted'),
      { code: 'RESOURCE_EXHAUSTED' },
    ), 1)).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(ocrErrorPayload(new ProviderApiError(
      'router capacity exhausted',
      undefined,
      'RATE_LIMITED',
    ), 1)).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(ocrErrorPayload(new ProviderApiError(
      'balance depleted',
      429,
      'exceeded_current_quota_error',
    ), 1)).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: false,
      hint: 'Check the provider account balance and quota before retrying.',
    });
    expect(ocrErrorPayload(new ProviderApiError(
      'incorrect key',
      401,
      'incorrect_api_key_error',
    ), 1)).toMatchObject({
      code: 'AUTH_INVALID',
      retryable: false,
    });
    expect(ocrErrorPayload(new ProviderApiError(
      'router capacity exhausted',
      200,
      'provider_overloaded',
    ), 1)).toMatchObject({
      code: 'RATE_LIMITED',
      category: 'provider',
      retryable: true,
    });
    expect(ocrErrorPayload(new ProviderApiError(
      'could not decode image',
      200,
      'invalid_image',
    ), 1)).toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
    });
  });

  it('returns exit code 1 for every incomplete execution', () => {
    expect(cliBatchExitCode({
      total: 2, succeeded: 0, partial: 0, failed: 2, skipped: 0, costLimitReached: false,
    })).toBe(1);
    expect(cliBatchExitCode({
      total: 100, succeeded: 98, partial: 0, failed: 2, skipped: 0, costLimitReached: false,
    })).toBe(1);
    expect(cliRunStatusExitCode('partial')).toBe(1);
    expect(cliRunStatusExitCode('cost_limited')).toBe(1);
    expect(cliRunStatusExitCode('failed')).toBe(1);
  });

  it('carries a next action on every typed error code', () => {
    // Agents branch on `hint` to decide what to do next, so a typed error that
    // omits one leaves them with nothing but prose to parse.
    for (const code of OCR_ERROR_CODES) {
      const error = new CliExitError(`${code} failure`, 1, { code });
      expect(error.hint, `missing hint for ${code}`).toEqual(expect.any(String));
      expect(error.hint.length, `empty hint for ${code}`).toBeGreaterThan(0);
      expect(ocrErrorPayload(error, 1).hint).toBe(error.hint);
    }
  });

  it('hints the untyped and provider-rejected failures that used to arrive bare', () => {
    // A provider 400 with no structured code fell through to the generic
    // default, and the default itself carried no hint.
    expect(ocrErrorPayload(new ProviderApiError('Unsupported response schema keyword', 400), 1))
      .toMatchObject({
        code: 'PROVIDER_FAILURE',
        category: 'provider',
        retryable: false,
        hint: expect.stringContaining('provider rejected') as unknown,
      });
    expect(ocrErrorPayload(new Error('Something the classifiers do not recognize'), 1))
      .toMatchObject({ code: 'PROVIDER_FAILURE', hint: expect.any(String) as unknown });
  });

  it('does not let an exit-status default contradict an explicitly named code', () => {
    // Exit 1 defaults to PROVIDER_FAILURE. A limit error that names its own code
    // must not inherit provider advice just because it shares the exit status.
    expect(new CliExitError('Timed out after 30s', 1, {
      code: 'TIMEOUT', category: 'limit', retryable: true,
    }).hint).toContain('timeout');
    expect(new CliExitError('Reached the cost ceiling', 1, {
      code: 'COST_LIMIT', category: 'limit', retryable: false,
    }).hint).toContain('cost');
  });

  describe('provider JSON error bodies', () => {
    /**
     * Recorded from the live Gemini API (gemini-3.1-flash-lite, 2026-07-26).
     * The SDK throws `ApiError` with a numeric `status` own-property and the
     * whole response body as `message`, so these fixtures reproduce the exact
     * error object the classifier receives in production.
     */
    const geminiError = (status: number, body: string): Error => Object.assign(
      new Error(body),
      { name: 'ApiError', status },
    );

    const INVALID_KEY = '{"error":{"code":401,"message":"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.","status":"UNAUTHENTICATED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"ACCESS_TOKEN_TYPE_UNSUPPORTED","metadata":{"method":"google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent","service":"generativelanguage.googleapis.com"}}]}}';
    const CORRUPT_IMAGE = '{"error":{"code":400,"message":"Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting","status":"INVALID_ARGUMENT"}}';
    const OVER_BUDGET_SCHEMA = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';

    it('reports the provider sentence instead of dumping the raw body', () => {
      const payload = ocrErrorPayload(geminiError(401, INVALID_KEY), 1);
      expect(payload.message).toBe(
        'Request had invalid authentication credentials. Expected OAuth 2 access token, '
        + 'login cookie or other valid authentication credential. '
        + 'See https://developers.google.com/identity/sign-in/web/devconsole-project. '
        + '[UNAUTHENTICATED; ACCESS_TOKEN_TYPE_UNSUPPORTED]',
      );
      expect(payload.message).not.toContain('type.googleapis.com');
      expect(payload.message.length).toBeLessThan(INVALID_KEY.length);
      // The envelope was already right and must stay byte-for-byte unchanged.
      expect(payload).toMatchObject({
        code: 'AUTH_INVALID',
        category: 'authentication',
        retryable: false,
        hint: 'Verify the configured provider credential.',
      });
    });

    it('reads the body off the Interactions error shape, whose message says nothing', () => {
      // Agentic and web modes use the Interactions API, which throws an
      // `ApiError` subclass whose message is "401 API error occurred: {...}"
      // and whose `body` holds the payload inside a JSON array.
      const error = Object.assign(
        new Error('401 API error occurred: {"httpMeta":{"response":{},"request":{}}}'),
        { name: 'AuthenticationError', status: 401, body: `[${INVALID_KEY}]` },
      );
      expect(ocrErrorPayload(error, 1)).toMatchObject({
        code: 'AUTH_INVALID',
        category: 'authentication',
        retryable: false,
        message: expect.stringContaining('Request had invalid authentication credentials.') as unknown,
      });
      expect(ocrErrorPayload(error, 1).message).not.toContain('httpMeta');
    });

    it('keeps the whole body reachable on the cause after shortening the message', () => {
      const cause = geminiError(401, INVALID_KEY);
      expect(asCliExitError(cause, 1).cause).toBe(cause);
    });

    it('types a document the provider could not read as an input failure', () => {
      // Previously a bare 400 landed on PROVIDER_FAILURE / provider, inviting an
      // agent to retry or escalate when the fix is to replace the document.
      expect(ocrErrorPayload(geminiError(400, CORRUPT_IMAGE), 1)).toEqual({
        code: 'INPUT_INVALID',
        category: 'input',
        retryable: false,
        message: 'Unable to process input image. Please retry or report in '
          + 'https://developers.generativeai.google/guide/troubleshooting [INVALID_ARGUMENT]',
        hint: 'The provider could not read this document; convert or re-export it before retrying.',
      });
      expect(ocrErrorPayload(geminiError(400, '{"error":{"code":400,"message":"Unsupported MIME type: application/x-msdownload","status":"INVALID_ARGUMENT"}}'), 1))
        .toMatchObject({ code: 'INPUT_INVALID', category: 'input', retryable: false });
    });

    /**
     * A caller's schema whose property names collide with the words the input
     * heuristics match on. Nothing about it is unusual — `page` and `maximum`
     * are ordinary field names — and both properties are over the measured
     * grammar budget, so the engine's diagnosis quotes both paths.
     */
    const COLLIDING_SCHEMA = {
      type: 'object',
      properties: {
        page: { type: 'array', maxItems: 500, items: { type: 'string' } },
        maximum: { type: 'array', maxItems: 500, items: { type: 'string' } },
      },
    };

    /** The sentence `describeSchemaRejection` builds, from the real findings. */
    function schemaRejectionMessage(): string {
      const detail = findSchemaCompatibilityIssues(COLLIDING_SCHEMA)
        .filter((issue) => issue.confidence === 'confident')
        .map((issue) => `${issue.path} (${issue.keyword}): ${issue.reason}`)
        .join('; ');
      expect(detail).toContain('properties.page');
      expect(detail).toContain('properties.maximum');
      return 'Invalid JSON Schema for structured output: the provider rejected the request '
        + `("Request contains an invalid argument. [INVALID_ARGUMENT]") and the schema exceeds a limit it is `
        + `measured to reject — ${detail}.`;
    }

    it('reads a schema verdict off the type, not out of the caller\'s property names', () => {
      // The message embeds the caller's own schema paths. Classified by prose,
      // properties named `page` and `maximum` tripped the page-limit heuristic
      // and the failure came back as INPUT_INVALID — telling an agent to fix its
      // document while the schema stayed broken. The type settles it first.
      const message = schemaRejectionMessage();
      expect(message.toLowerCase()).toContain('page');
      expect(message.toLowerCase()).toContain('maximum');
      const typed = new OcrError(
        OcrErrorType.SCHEMA_INVALID,
        message,
        undefined,
        { cause: geminiError(400, '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}') },
      );
      expect(ocrErrorPayload(typed, 1)).toMatchObject({
        code: 'SCHEMA_INVALID',
        category: 'schema',
        retryable: false,
        hint: 'Simplify the response schema to the supported structured-output subset before retrying.',
      });
    });

    it('lets the schema rules win over the input rules in the residual sniffer', () => {
      // Defence in depth for producers nobody has typed yet: the same message,
      // untyped, must not be read as a bad document either.
      expect(ocrErrorPayload(new Error(schemaRejectionMessage()), 1))
        .toMatchObject({ code: 'SCHEMA_INVALID', category: 'schema' });
    });

    it('still types a real page-limit rejection as an input failure', () => {
      // The narrowed rule has to keep catching what it was written for: the
      // page-limit message `inputs.ts` produces.
      expect(ocrErrorPayload(new Error('scan.pdf has 1200 pages; the maximum is 1000'), 2))
        .toMatchObject({ code: 'INPUT_INVALID', category: 'input' });
      expect(ocrErrorPayload(new Error('PDF "scan.pdf" has 1200 pages; the maximum is 1000.'), 2))
        .toMatchObject({ code: 'INPUT_INVALID', category: 'input' });
      // ...without claiming any message that merely contains both words.
      expect(ocrErrorPayload(new Error('The maximum retries were spent on one page.'), 1))
        .not.toMatchObject({ code: 'INPUT_INVALID' });
    });

    it('types a rejected request field as a configuration failure', () => {
      const body = '{"error":{"code":400,"message":"Invalid value at \'generation_config.thinking_config.thinking_level\'","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":"generation_config.thinking_config.thinking_level","description":"bad value"}]}]}}';
      expect(ocrErrorPayload(geminiError(400, body), 1)).toMatchObject({
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
        hint: 'Correct the request field named in the provider message, then retry.',
      });
    });

    it('types an unknown model as a configuration failure rather than a provider outage', () => {
      const body = '{"error":{"code":404,"message":"models/gemini-does-not-exist is not found for API version v1beta, or is not supported for generateContent.","status":"NOT_FOUND"}}';
      expect(ocrErrorPayload(geminiError(404, body), 1)).toMatchObject({
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
      });
    });

    it('leaves a bare invalid-argument body on the generic provider path', () => {
      // The over-budget response-schema grammar produces exactly this body. It
      // carries no signal at all, and a confident wrong category would be worse
      // than an honest generic one; the schema-aware diagnosis happens where the
      // schema is in scope, not here.
      expect(ocrErrorPayload(geminiError(400, OVER_BUDGET_SCHEMA), 1)).toMatchObject({
        code: 'PROVIDER_FAILURE',
        category: 'provider',
        retryable: false,
        message: 'Request contains an invalid argument. [INVALID_ARGUMENT]',
      });
    });

    it('types the engine\'s schema-grammar diagnosis as a schema failure', () => {
      // `describeSchemaRejection` in the Gemini adapter turns a bare 400 plus a
      // schema that fails the static compatibility check into this message. It
      // is the only thing that can name the cause, so it must not land on the
      // generic provider path.
      const diagnosis = new Error(
        'Invalid JSON Schema for structured output: the provider rejected the request '
        + '("Request contains an invalid argument. [INVALID_ARGUMENT]") and the schema uses '
        + 'constructs it is not known to accept — properties.rows (maxItems): maxItems=500 '
        + 'compiles to a grammar cost of 2000',
        { cause: geminiError(400, OVER_BUDGET_SCHEMA) },
      );
      expect(ocrErrorPayload(diagnosis, 1)).toMatchObject({
        code: 'SCHEMA_INVALID',
        category: 'schema',
        retryable: false,
      });
    });

    it('does not let body parsing preempt a status-based classification', () => {
      // A 429 or 503 body also parses; its status rule must still win, so the
      // failure stays retryable.
      expect(ocrErrorPayload(geminiError(429, '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}'), 1))
        .toMatchObject({ code: 'RATE_LIMITED', category: 'provider', retryable: true });
      expect(ocrErrorPayload(geminiError(503, '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}'), 1))
        .toMatchObject({ code: 'PROVIDER_FAILURE', category: 'provider', retryable: true });
    });

    it('still redacts a credential echoed inside a provider body', () => {
      const body = '{"error":{"code":400,"message":"API key not valid: AIzaSyDeadBeefDeadBeefDeadBeef","status":"INVALID_ARGUMENT"}}';
      const payload = ocrErrorPayload(geminiError(400, body), 1);
      expect(payload.message).not.toContain('AIzaSyDeadBeef');
      expect(payload.message).toContain('[REDACTED_KEY]');
      expect(payload).toMatchObject({ code: 'AUTH_INVALID', category: 'authentication' });
    });

    it('keeps the raw body reachable as cause without letting it escape a render', () => {
      const body = '{"error":{"code":400,"message":"API key not valid: AIzaSyDeadBeefDeadBeefDeadBeef","status":"INVALID_ARGUMENT"}}';
      const typed = asCliExitError(geminiError(400, body), 1);
      // Defence in depth: the untouched body stays on `cause` for a debugger,
      // and every rendered or serialized form of the error is without it.
      expect((typed.cause as Error).message).toContain('AIzaSyDeadBeef');
      expect(renderCliError(typed, 'open-ocr-cli')).not.toContain('AIzaSyDeadBeef');
      expect(JSON.stringify(ocrErrorPayload(typed, 1))).not.toContain('AIzaSyDeadBeef');
      expect(JSON.stringify(typed)).not.toContain('AIzaSyDeadBeef');
    });
  });

  it('preserves typed details through wrapper error causes', () => {
    const inputFailure = new CliExitError('Invalid PDF structure', 2, {
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
    });
    const wrapped = new Error('Invalid PDF structure', { cause: inputFailure });
    expect(ocrErrorPayload(wrapped, 1)).toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
      retryable: false,
    });
  });
});
