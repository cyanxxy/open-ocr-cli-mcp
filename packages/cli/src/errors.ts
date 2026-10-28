import {
  providerErrorMessage,
  providerErrorPayloadOf,
  providerErrorSubject,
  redactSensitiveErrorText,
  renderProviderErrorPayload,
  type ProviderErrorPayload,
  type ProviderErrorSubject,
} from '@open-ocr/engine/gemini/errorPayload';

/**
 * Redaction is defined beside the provider-body reader so the engine renders
 * text through it too, and re-exported here because this module is where the
 * CLI's error contract lives.
 */
export { redactSensitiveErrorText };

export type CliExitCode = 1 | 2 | 130 | 141 | 143;
/** `SIGPIPE` stands for stdout's reader closing the pipe (EPIPE). */
export type CliInterruptSignal = 'SIGINT' | 'SIGPIPE' | 'SIGTERM';

export const OCR_ERROR_CODES = [
  'INPUT_NOT_FOUND',
  'INPUT_INVALID',
  'CONFIG_INVALID',
  'AUTH_MISSING',
  'AUTH_INVALID',
  'PERMISSION_DENIED',
  'SCHEMA_INVALID',
  'OUTPUT_CONFLICT',
  'RATE_LIMITED',
  'TIMEOUT',
  'COST_LIMIT',
  'CANCELLED',
  'NOT_RUN',
  'PROVIDER_FAILURE',
  'INTERNAL',
] as const;

export type OcrErrorCode = (typeof OCR_ERROR_CODES)[number];

export type OcrErrorCategory =
  | 'input'
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'schema'
  | 'output'
  | 'provider'
  | 'limit'
  | 'cancelled'
  | 'execution'
  | 'internal';

/** Whether an output stream directly reported that its downstream pipe closed. */
export function isBrokenPipeError(error: unknown): boolean {
  return recordValue(error, 'code') === 'EPIPE';
}

export interface OcrErrorDetails {
  code: OcrErrorCode;
  category: OcrErrorCategory;
  retryable: boolean;
  hint?: string;
}

export interface OcrErrorPayload extends OcrErrorDetails {
  message: string;
}

interface CliExitErrorOptions extends ErrorOptions, Partial<OcrErrorDetails> {}

/**
 * The next action for each error code, used whenever a construction site does
 * not supply a more specific one. Agents treat `hint` as the recovery step, so
 * a typed error without one is a dead end; keying the fallback on the code
 * rather than the exit status keeps that floor from drifting into advice that
 * contradicts the code it is attached to.
 */
const DEFAULT_ERROR_HINTS: Record<OcrErrorCode, string> = {
  INPUT_NOT_FOUND: 'Check the input path and working directory.',
  INPUT_INVALID: 'Use a supported, non-empty image or PDF within the documented limits.',
  CONFIG_INVALID: 'Check the request, command flags, and configuration.',
  AUTH_MISSING: 'Configure the named credential environment variable; never pass a raw key as an argument.',
  AUTH_INVALID: 'Verify the configured provider credential.',
  PERMISSION_DENIED: 'Verify that the credential and project are allowed to use this model or operation.',
  SCHEMA_INVALID: 'Validate the JSON Schema against the supported structured-output subset.',
  OUTPUT_CONFLICT: 'Choose a new output path or resume a matching job.',
  RATE_LIMITED: 'Retry later or lower request concurrency/rate.',
  TIMEOUT: 'Retry with a longer timeout or a smaller document.',
  COST_LIMIT: 'Review partial output or explicitly raise the cost ceiling.',
  CANCELLED: 'Resume or rerun the interrupted job when ready.',
  NOT_RUN: 'Rerun the skipped documents after addressing the failure that stopped the batch.',
  PROVIDER_FAILURE: 'Review the reported provider message and adjust the request before retrying.',
  // Kept consistent with `retryable: false`: advising a retry under a flag that
  // says not to retry is the one thing an agent cannot act on.
  INTERNAL: 'Report the failure with non-secret diagnostics; rerunning the identical command is unlikely to help.',
};

function isSignalExitCode(exitCode: CliExitCode): boolean {
  return exitCode === 130 || exitCode === 141 || exitCode === 143;
}

function defaultErrorDetails(exitCode: CliExitCode): OcrErrorDetails {
  if (isSignalExitCode(exitCode)) {
    return { code: 'CANCELLED', category: 'cancelled', retryable: true, hint: DEFAULT_ERROR_HINTS.CANCELLED };
  }
  if (exitCode === 1) {
    return { code: 'PROVIDER_FAILURE', category: 'provider', retryable: false, hint: DEFAULT_ERROR_HINTS.PROVIDER_FAILURE };
  }
  return { code: 'CONFIG_INVALID', category: 'configuration', retryable: false, hint: DEFAULT_ERROR_HINTS.CONFIG_INVALID };
}

/**
 * The document page-limit rejection, matched on the exact clause `inputs.ts`
 * writes rather than on the
 * words "page" and "maximum" appearing anywhere in the message. Those two are
 * ordinary English and ordinary property names: a schema with properties called
 * `page` and `maximum` used to be classified as a bad document.
 */
const PAGE_LIMIT_PATTERN = /\bhas \d+ pages?; the maximum is \d+/u;

/**
 * Inference for untyped third-party or filesystem errors only.
 *
 * Every rule here is a substring match against a message that may embed text
 * the caller supplied — a schema path, a filename, a property name — so each one
 * is a standing collision risk. The durable fix is at the throw site: a call
 * site that knows what the failure is throws a typed error and
 * `classifyKnownError` short-circuits before this function is ever reached.
 * Treat anything below as a fallback for errors nobody typed, and prefer typing
 * a new producer over adding a rule.
 *
 * Rule order matters, because these are not mutually exclusive. The schema rules
 * run first: they are anchored on phrasing this codebase writes itself, so when
 * one matches the message is unambiguously about a schema, whereas the input
 * rules match short common words that a schema message can easily contain.
 */
function classifyErrorMessage(message: string, exitCode: CliExitCode): OcrErrorDetails | undefined {
  const normalized = message.toLowerCase();
  if (
    normalized.startsWith('invalid json schema')
    || normalized.startsWith('invalid json in schema')
    || normalized.startsWith('custom schema')
    || normalized.startsWith('schema path is not a file')
    || normalized.startsWith('schema exceeds')
    || normalized.startsWith('schema nesting exceeds')
    || normalized.startsWith('schema output validation failed')
    || normalized.includes('json schema keyword')
    || normalized.includes('"$ref" must reference this schema document')
  ) {
    return { code: 'SCHEMA_INVALID', category: 'schema', retryable: false, hint: 'Validate the JSON Schema against the supported structured-output subset.' };
  }
  if (normalized.includes('input does not exist')) {
    return { code: 'INPUT_NOT_FOUND', category: 'input', retryable: false, hint: 'Check the input path and working directory.' };
  }
  if (
    normalized.includes('unsupported document')
    || normalized.includes('unsupported mime')
    || normalized.includes('does not match its declared type')
    || normalized.includes('is empty')
    || normalized.includes('no supported documents')
    || normalized.includes('exceeding --max-files')
    || normalized.includes('exceeding --max-total-mb')
    || PAGE_LIMIT_PATTERN.test(normalized)
  ) {
    return { code: 'INPUT_INVALID', category: 'input', retryable: false, hint: 'Use a supported, non-empty image or PDF within the documented limits.' };
  }
  if (normalized.includes('api key is missing') || (normalized.includes('requires') && normalized.includes('gateway authentication'))) {
    return { code: 'AUTH_MISSING', category: 'authentication', retryable: false, hint: 'Configure the named credential environment variable; never pass a raw key as an argument.' };
  }
  if (normalized.includes('output already exists') || normalized.includes('output path collision') || normalized.includes('batch output directory is already in use')) {
    return { code: 'OUTPUT_CONFLICT', category: 'output', retryable: false, hint: 'Choose a new output path or resume a matching job.' };
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return { code: 'TIMEOUT', category: 'limit', retryable: true, hint: 'Retry with a longer timeout or a smaller document.' };
  }
  if (normalized.includes('cost') && normalized.includes('limit')) {
    return { code: 'COST_LIMIT', category: 'limit', retryable: false, hint: 'Review partial output or explicitly raise the cost ceiling.' };
  }
  if (normalized.includes('rate limit') || normalized.includes('429')) {
    return { code: 'RATE_LIMITED', category: 'provider', retryable: true, hint: 'Retry later or lower request concurrency/rate.' };
  }
  if (normalized.includes('interrupted') || normalized.includes('cancelled') || isSignalExitCode(exitCode)) {
    return { code: 'CANCELLED', category: 'cancelled', retryable: true, hint: 'Resume or rerun the interrupted job when ready.' };
  }
  return undefined;
}

function recordValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function numericStatus(value: unknown): number | undefined {
  for (const key of ['status', 'statusCode']) {
    const status = recordValue(value, key);
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  const code = recordValue(value, 'code');
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return Number(code);
  return undefined;
}

function normalizedErrorCode(value: unknown): string | undefined {
  const code = recordValue(value, 'code');
  return typeof code === 'string' && !/^\d{3}$/u.test(code)
    ? code.trim().toUpperCase()
    : undefined;
}

function invalidCredentialMessage(value: unknown): boolean {
  const messageValue = recordValue(value, 'message');
  const message = (typeof messageValue === 'string' ? messageValue : '').toLowerCase();
  return message.includes('api key not valid')
    || message.includes('api key is invalid')
    || message.includes('invalid api key')
    || message.includes('api_key_invalid');
}

/**
 * Read the provider's own error body off a thrown error, falling back to its
 * bare message. Providers whose client already reduced the body to a sentence
 * are represented as that sentence alone, so the same subject rules apply to a
 * parsed Gemini body and to an OpenAI-compatible `ProviderApiError` alike.
 */
function providerPayloadOf(value: unknown): ProviderErrorPayload | undefined {
  const structured = providerErrorPayloadOf(value);
  if (structured) return structured;
  const message = recordValue(value, 'message');
  if (typeof message !== 'string' || !message) return undefined;
  return { message, reasons: [], fields: [] };
}

/**
 * Type a provider rejection by what the provider named. Gemini returns
 * 400 INVALID_ARGUMENT for an undecodable document, a malformed request field,
 * and an unsupported response schema alike, so the numeric status alone would
 * send all three down the generic provider path and invite a pointless retry.
 */
function classifyProviderSubject(subject: ProviderErrorSubject): OcrErrorDetails {
  switch (subject) {
    case 'input-media':
      return {
        code: 'INPUT_INVALID',
        category: 'input',
        retryable: false,
        hint: 'The provider could not read this document; convert or re-export it before retrying.',
      };
    case 'response-schema':
      return {
        code: 'SCHEMA_INVALID',
        category: 'schema',
        retryable: false,
        hint: 'Simplify the response schema to the supported structured-output subset before retrying.',
      };
    case 'model':
      return {
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
        hint: 'Select a model this provider supports for this operation.',
      };
    case 'request-field':
      return {
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
        hint: 'Correct the request field named in the provider message, then retry.',
      };
  }
}

function classifyKnownError(error: unknown, exitCode: CliExitCode): OcrErrorDetails | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof CliExitError) {
      return {
        code: current.code,
        category: current.category,
        retryable: current.retryable,
        hint: current.hint,
      };
    }
    const name = recordValue(current, 'name');
    const providerError = name === 'ProviderApiError';
    const status = numericStatus(current);
    const structuredCode = normalizedErrorCode(current);
    if (name === 'ProviderCostLimitError') {
      return { code: 'COST_LIMIT', category: 'limit', retryable: false, hint: 'Review partial output or explicitly raise the cost ceiling.' };
    }
    if (name === 'AbortError' || name === 'TimeoutError') {
      return name === 'TimeoutError'
        ? { code: 'TIMEOUT', category: 'limit', retryable: true, hint: 'Retry with a longer timeout or a smaller document.' }
        : { code: 'CANCELLED', category: 'cancelled', retryable: true, hint: 'Resume or rerun the interrupted job when ready.' };
    }
    if (
      current instanceof TypeError
      && /\b(?:fetch|network(?: request)?) failed\b|\bsocket (?:closed|hang up)\b/iu.test(current.message)
    ) {
      return { code: 'PROVIDER_FAILURE', category: 'provider', retryable: true, hint: 'Retry with backoff after the transient network failure.' };
    }
    const ocrType = recordValue(current, 'type');
    if (name === 'OcrError' && ocrType === 'API_KEY_MISSING') {
      return { code: 'AUTH_MISSING', category: 'authentication', retryable: false, hint: 'Configure the named credential environment variable; never pass a raw key as an argument.' };
    }
    // The engine already established that the caller's response schema is why
    // the provider refused. Reading that verdict off the type is the whole point
    // of the type: its message quotes the caller's own schema paths, so leaving
    // it to `classifyErrorMessage` means matching substrings of user-supplied
    // text. Same verdict as the `response-schema` subject, by construction.
    if (name === 'OcrError' && ocrType === 'SCHEMA_INVALID') {
      return classifyProviderSubject('response-schema');
    }
    if (
      structuredCode === 'API_KEY_INVALID'
      || structuredCode === 'UNAUTHENTICATED'
      || structuredCode === 'INVALID_AUTHENTICATION_ERROR'
      || structuredCode === 'INCORRECT_API_KEY_ERROR'
    ) {
      return { code: 'AUTH_INVALID', category: 'authentication', retryable: false, hint: 'Verify the configured provider credential.' };
    }
    if (structuredCode === 'PERMISSION_DENIED' || structuredCode === 'PERMISSION_DENIED_ERROR') {
      return { code: 'PERMISSION_DENIED', category: 'authorization', retryable: false, hint: 'Verify that the credential and project are allowed to use this model or operation.' };
    }
    if (
      structuredCode === 'RESOURCE_EXHAUSTED'
      || structuredCode === 'RATE_LIMITED'
      || structuredCode === 'RATE_LIMIT_EXCEEDED'
      || structuredCode === 'ENGINE_OVERLOADED_ERROR'
      || structuredCode === 'RATE_LIMIT_REACHED_ERROR'
      || structuredCode === 'PROVIDER_OVERLOADED'
    ) {
      return { code: 'RATE_LIMITED', category: 'provider', retryable: true, hint: 'Retry later or lower request concurrency/rate.' };
    }
    if (structuredCode === 'EXCEEDED_CURRENT_QUOTA_ERROR') {
      return { code: 'RATE_LIMITED', category: 'provider', retryable: false, hint: 'Check the provider account balance and quota before retrying.' };
    }
    if (structuredCode === 'DEADLINE_EXCEEDED' || structuredCode === 'TIMEOUT') {
      return { code: 'TIMEOUT', category: 'limit', retryable: true, hint: 'Retry with a longer timeout or a smaller document.' };
    }
    if (structuredCode === 'CANCELLED') {
      return { code: 'CANCELLED', category: 'cancelled', retryable: true, hint: 'Resume or rerun the interrupted job when ready.' };
    }
    if (
      structuredCode === 'UNAVAILABLE'
      || structuredCode === 'PROVIDER_UNAVAILABLE'
      || structuredCode === 'INTERNAL'
      || structuredCode === 'SERVER_ERROR'
      || structuredCode === 'SERVER'
      || structuredCode === 'SERVER_UNAVAILABLE'
      || structuredCode === 'UNEXPECTED_OUTPUT'
      || structuredCode === 'CLIENT_CLOSED_REQUEST'
      || structuredCode === 'UNMAPPED'
    ) {
      return { code: 'PROVIDER_FAILURE', category: 'provider', retryable: true, hint: 'Retry with backoff; the provider reported a transient server failure.' };
    }
    if (
      structuredCode === 'INVALID_IMAGE'
      || structuredCode === 'IMAGE_TOO_LARGE'
      || structuredCode === 'IMAGE_TOO_SMALL'
      || structuredCode === 'INVALID_IMAGE_FORMAT'
      || structuredCode === 'IMAGE_PARSE_ERROR'
    ) {
      return { code: 'INPUT_INVALID', category: 'input', retryable: false, hint: 'Use a supported image format and size for the selected provider.' };
    }
    if (providerError || status !== undefined) {
      if (status === 400 && invalidCredentialMessage(current)) {
        return { code: 'AUTH_INVALID', category: 'authentication', retryable: false, hint: 'Verify the configured provider credential.' };
      }
      if (status === 401) {
        return { code: 'AUTH_INVALID', category: 'authentication', retryable: false, hint: 'Verify the configured provider credential.' };
      }
      if (status === 403) {
        return { code: 'PERMISSION_DENIED', category: 'authorization', retryable: false, hint: 'Verify that the credential and project are allowed to use this model or operation.' };
      }
      if (status === 408 || status === 504) {
        return { code: 'TIMEOUT', category: 'limit', retryable: true, hint: 'Retry with a longer timeout or a smaller document.' };
      }
      if (status === 429) {
        return { code: 'RATE_LIMITED', category: 'provider', retryable: true, hint: 'Retry later or lower request concurrency/rate.' };
      }
      if (status !== undefined && status >= 500) {
        return { code: 'PROVIDER_FAILURE', category: 'provider', retryable: true, hint: 'Retry with backoff; the provider reported a transient server failure.' };
      }
      if (status === 409) {
        return { code: 'PROVIDER_FAILURE', category: 'provider', retryable: true, hint: 'Retry with backoff after the provider conflict.' };
      }
      // Last resort before the generic provider verdict: every status-specific
      // rule above already had its say, so reading the body can only refine a
      // failure that would otherwise be reported as an unexplained 4xx.
      const payload = providerPayloadOf(current);
      const subject = payload ? providerErrorSubject(payload) : undefined;
      if (subject) return classifyProviderSubject(subject);
      if (providerError) {
        return {
          code: 'PROVIDER_FAILURE',
          category: 'provider',
          retryable: false,
          hint: 'The provider rejected this request; fix what its message names before retrying the same call.',
        };
      }
    }
    const systemCode = recordValue(current, 'code');
    if (systemCode === 'EEXIST') {
      return { code: 'OUTPUT_CONFLICT', category: 'output', retryable: false, hint: 'Choose a new output path or resume a matching job.' };
    }
    if (systemCode === 'ETIMEDOUT') {
      return { code: 'TIMEOUT', category: 'limit', retryable: true, hint: 'Retry with a longer timeout or a smaller document.' };
    }
    if (systemCode === 'ECONNRESET' || systemCode === 'EAI_AGAIN') {
      return { code: 'PROVIDER_FAILURE', category: 'provider', retryable: true, hint: 'Retry with backoff after the transient network failure.' };
    }
    // Backstop for an unguarded filesystem call: degrade to a typed error
    // instead of letting a raw errno reach the generic default.
    if (systemCode === 'ENOENT') {
      return { code: 'INPUT_NOT_FOUND', category: 'input', retryable: false, hint: 'Check the referenced path and working directory.' };
    }
    if (systemCode === 'EISDIR') {
      return { code: 'INPUT_INVALID', category: 'input', retryable: false, hint: 'Point the option at a file rather than a directory.' };
    }
    if (systemCode === 'EACCES' || systemCode === 'EPERM') {
      return { code: 'PERMISSION_DENIED', category: 'authorization', retryable: false, hint: 'Check filesystem permissions for the referenced path.' };
    }
    current = recordValue(current, 'cause');
  }
  if (isSignalExitCode(exitCode)) return defaultErrorDetails(exitCode);
  return undefined;
}

/** An expected CLI failure with an explicit process exit contract. */
export class CliExitError extends Error {
  readonly code: OcrErrorCode;
  readonly category: OcrErrorCategory;
  readonly retryable: boolean;
  readonly hint: string;

  constructor(
    message: string,
    readonly exitCode: CliExitCode,
    options: CliExitErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'CliExitError';
    const classified = defaultErrorDetails(exitCode);
    this.code = options.code ?? classified.code;
    this.category = options.category ?? classified.category;
    this.retryable = options.retryable ?? classified.retryable;
    // Fall back on the code, not the exit status: a site that names a code but
    // no hint would otherwise inherit advice meant for a different failure.
    this.hint = options.hint ?? DEFAULT_ERROR_HINTS[this.code];
  }
}

/**
 * A batch output directory whose own metadata cannot be read.
 *
 * Typed at the throw site because the untyped classifier reports these as
 * `CONFIG_INVALID` with "Check the request, command flags, and configuration" —
 * advice that cannot resolve a corrupt or superseded file on disk. The
 * distinction matters to `status` and to `--resume`, which are the two surfaces
 * that read this metadata back: the caller's command is fine, the directory is
 * not, and the recovery is to point elsewhere or re-run rather than to edit
 * flags.
 */
export function batchMetadataError(message: string): CliExitError {
  return new CliExitError(message, 2, {
    code: 'INPUT_INVALID',
    category: 'input',
    retryable: false,
    hint: 'This directory\'s batch metadata is missing fields this release requires, or was written by a different tool. '
      + 'Re-run the extraction into a fresh output directory.',
  });
}

export function asCliExitError(error: unknown, exitCode: CliExitCode): CliExitError {
  if (error instanceof CliExitError) {
    const redacted = redactSensitiveErrorText(error.message);
    if (redacted === error.message) return error;
    return new CliExitError(redacted, error.exitCode, {
      cause: error,
      code: error.code,
      category: error.category,
      retryable: error.retryable,
      hint: error.hint,
    });
  }
  // Providers that answer with a JSON body would otherwise put the whole blob
  // in `message`, on stderr and in every JSONL record. Reduce it to the
  // sentence the provider wrote first, then redact, so a credential echoed
  // anywhere inside the body is still scrubbed from what survives.
  const rawMessage = error instanceof Error ? error.message : String(error);
  const payload = providerErrorPayloadOf(error);
  const message = redactSensitiveErrorText(
    (payload ? renderProviderErrorPayload(payload) : undefined) ?? providerErrorMessage(rawMessage),
  );
  const classified = classifyKnownError(error, exitCode)
    ?? classifyErrorMessage(message, exitCode)
    ?? defaultErrorDetails(exitCode);
  return new CliExitError(
    message,
    exitCode,
    { cause: error, ...classified },
  );
}

export interface CliBatchOutcome {
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  costLimitReached: boolean;
}

/** Every incomplete execution exits with 1. */
export function cliBatchExitCode(outcome: CliBatchOutcome): 0 | 1 {
  if (outcome.costLimitReached || outcome.partial > 0 || outcome.failed > 0) return 1;
  return 0;
}

export function cliRunStatusExitCode(status: string): 0 | 1 {
  if (status === 'succeeded' || status === 'validated') return 0;
  return 1;
}

export function cliExitCode(error: unknown): CliExitCode {
  return error instanceof CliExitError ? error.exitCode : 2;
}

export function ocrErrorPayload(error: unknown, fallbackExitCode: CliExitCode = 2): OcrErrorPayload {
  const typed = asCliExitError(error, fallbackExitCode);
  return {
    code: typed.code,
    category: typed.category,
    message: typed.message,
    retryable: typed.retryable,
    hint: typed.hint,
  };
}

/** Render the same typed error contract used by `run` for human CLI users. */
export function renderCliError(error: unknown, binaryName: string): string {
  const payload = ocrErrorPayload(error, cliExitCode(error));
  const lines = [`${binaryName}: [${payload.code}] ${payload.message}`];
  if (payload.hint) lines.push(`${binaryName}: hint: ${payload.hint}`);
  return `${lines.join('\n')}\n`;
}

/** Return the conventional shell exit status for a supported interrupt signal. */
export function cliSignalExitCode(signal: CliInterruptSignal): 130 | 141 | 143 {
  if (signal === 'SIGINT') return 130;
  return signal === 'SIGPIPE' ? 141 : 143;
}
