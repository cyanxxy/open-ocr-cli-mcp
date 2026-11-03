/**
 * Reading a provider's JSON error body.
 *
 * The Gemini SDK does not model its failures: it throws an `ApiError` carrying a
 * numeric `status` own-property and a `message` that is the entire response body
 * verbatim, e.g.
 *
 *   {"error":{"code":400,"message":"Unable to process input image. ...",
 *             "status":"INVALID_ARGUMENT",
 *             "details":[{"@type":"...google.rpc.ErrorInfo","reason":"..."}]}}
 *
 * Everything a caller can act on lives inside that blob. Both the sentence a
 * human reads and the category an agent branches on therefore have to come from
 * parsing it; the numeric status alone cannot tell a bad document apart from a
 * bad request field, because Google returns 400 INVALID_ARGUMENT for both.
 *
 * Every shape and phrase below was captured from the live API against
 * gemini-3.1-flash-lite on 2026-07-26. The recorded bodies are pinned in
 * errorPayload.test.ts, so a wording change upstream shows up as a test failure
 * rather than as a silently generic classification. The prose rules are applied
 * to non-Gemini providers too: the OpenAI-compatible bodies use the same
 * `error.message` convention, and `providerErrorFromRecord` has already reduced
 * them to that sentence by the time a classifier sees them.
 */

/** Structured fields recovered from a provider's JSON error body. */
export interface ProviderErrorPayload {
  /** The sentence the provider wrote for this failure. */
  message?: string;
  /** Canonical status token, e.g. `INVALID_ARGUMENT` or `UNAUTHENTICATED`. */
  status?: string;
  /** Numeric code inside the body, normally mirroring the HTTP status. */
  code?: number;
  /** `google.rpc.ErrorInfo` reasons — the most specific machine signal offered. */
  reasons: readonly string[];
  /** Request field paths from `google.rpc.BadRequest` field violations. */
  fields: readonly string[];
}

/**
 * What the provider blamed, when it named something specific enough to act on.
 * Anything the provider left generic is deliberately absent from this union —
 * an honest "unclassified" beats a confident guess.
 */
export type ProviderErrorSubject = 'input-media' | 'response-schema' | 'request-field' | 'model';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse an error string as JSON. The body arrives whole from `generateContent`
 * and as a single-element array from the Interactions API, and some transports
 * prefix it with their own status line — so a failed direct parse falls back to
 * the widest brace span in the text.
 */
function parseJsonBody(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function detailSignals(details: unknown): { reasons: string[]; fields: string[] } {
  const reasons: string[] = [];
  const fields: string[] = [];
  if (!Array.isArray(details)) return { reasons, fields };
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    if (typeof detail.reason === 'string' && detail.reason) reasons.push(detail.reason);
    if (!Array.isArray(detail.fieldViolations)) continue;
    for (const violation of detail.fieldViolations) {
      if (!isRecord(violation)) continue;
      if (typeof violation.field === 'string' && violation.field) fields.push(violation.field);
    }
  }
  return { reasons, fields };
}

/**
 * Parse a provider error body into its structured parts. Returns undefined for
 * text that is not a recognizable error body, so callers can fall back to the
 * original string rather than inventing one.
 */
export function parseProviderErrorPayload(text: string): ProviderErrorPayload | undefined {
  const parsed = parseJsonBody(text);
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const payload = payloadFromBody(entry);
      if (payload) return payload;
    }
    return undefined;
  }
  return payloadFromBody(parsed);
}

function payloadFromBody(parsed: unknown): ProviderErrorPayload | undefined {
  if (!isRecord(parsed)) return undefined;
  const body = isRecord(parsed.error) ? parsed.error : parsed;
  const { reasons, fields } = detailSignals(body.details);
  const message = typeof body.message === 'string' ? body.message.trim() : undefined;
  const status = typeof body.status === 'string' ? body.status.trim() : undefined;
  const code = typeof body.code === 'number' ? body.code : undefined;
  if (!message && !status && code === undefined && reasons.length === 0 && fields.length === 0) {
    return undefined;
  }
  return {
    ...(message ? { message } : {}),
    ...(status ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    reasons,
    fields,
  };
}

/**
 * Own-properties that can hold a provider's response body, in preference order.
 * `generateContent` throws `ApiError`, whose `message` is the body; the
 * Interactions API throws `AuthenticationError`/`ApiError` subclasses whose
 * `message` is a useless "401 API error occurred: {...httpMeta}" summary and
 * whose `body` holds the real payload.
 */
const BODY_PROPERTIES = ['message', 'body'] as const;

/** Recover the provider's error body from wherever the thrown error kept it. */
export function providerErrorPayloadOf(error: unknown): ProviderErrorPayload | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const property of BODY_PROPERTIES) {
    const value = record[property];
    if (typeof value !== 'string' || !value) continue;
    const payload = parseProviderErrorPayload(value);
    if (payload?.message) return payload;
  }
  return undefined;
}

/**
 * Shortest credential value scrubbed verbatim. Below this a "secret" is more
 * likely to be a placeholder such as `test` whose removal would mangle ordinary
 * prose than a real key.
 */
const MIN_REGISTERED_SECRET_LENGTH = 8;
/** Bounded so a long-lived MCP server cannot accumulate values without limit. */
const MAX_REGISTERED_SECRETS = 64;
const REDACTED_SECRET = '[REDACTED_KEY]';

/** Credential values in use by this process, scrubbed wherever they appear. */
const registeredSecrets = new Set<string>();

/**
 * Register a credential value this process sends, so error text that echoes it
 * verbatim is scrubbed even when the value matches none of the key patterns
 * below. A provider that answers `invalid key: <the key>` with a key format the
 * patterns do not know would otherwise reach stderr, JSONL records, and MCP
 * error envelopes intact.
 */
export function registerSecretForRedaction(value: string | undefined): void {
  if (typeof value !== 'string') return;
  for (const candidate of new Set([value, value.trim()])) {
    if (candidate.length < MIN_REGISTERED_SECRET_LENGTH || candidate.includes(REDACTED_SECRET)) continue;
    registeredSecrets.delete(candidate);
    registeredSecrets.add(candidate);
  }
  while (registeredSecrets.size > MAX_REGISTERED_SECRETS) {
    const oldest = registeredSecrets.values().next().value;
    if (oldest === undefined) break;
    registeredSecrets.delete(oldest);
  }
}

/** Forget every registered credential value. Intended for tests. */
export function clearRegisteredSecretsForRedaction(): void {
  registeredSecrets.clear();
}

function redactRegisteredSecrets(message: string): string {
  if (registeredSecrets.size === 0) return message;
  let result = message;
  // Longest first, so a key that contains a shorter registered key is removed whole.
  const secrets = [...registeredSecrets].sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    for (const spelling of new Set([secret, encodeURIComponent(secret)])) {
      if (result.includes(spelling)) result = result.split(spelling).join(REDACTED_SECRET);
    }
  }
  return result;
}

/**
 * Strip credential-like fragments from provider/CLI error text.
 *
 * Lives beside the payload reader because rendering is where a provider's body
 * turns into text a caller will print, persist, or hand to an agent, and a
 * provider that echoes a request header or key into its own error body would
 * otherwise put that credential on every one of those surfaces. Applying it
 * twice is safe: each replacement's output no longer matches its own pattern.
 *
 * Patterns only catch credential *shapes*. The values this process actually
 * sends are registered with {@link registerSecretForRedaction} and removed
 * verbatim first, whatever they look like.
 */
export function redactSensitiveErrorText(message: string): string {
  return redactRegisteredSecrets(message)
    .replace(/\bBearer\s+[A-Za-z0-9._+=/-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/gu, '[REDACTED_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/gu, '[REDACTED_KEY]')
    .replace(
      /\b((?:api[_-]?key|token|authorization))\s*[:=]\s*["']?[^\s"',;]+/giu,
      '$1=[REDACTED]',
    );
}

/**
 * One readable line: the sentence the provider wrote, followed in brackets by
 * the machine tokens it carried that the sentence does not already repeat.
 *
 * The bracketed tokens exist so nothing actionable is lost when the raw body is
 * dropped; the discarded remainder (`@type` URLs, service/method metadata) is
 * still reachable on the thrown error, which classifiers keep as `cause`.
 *
 * Redaction is applied here, at the single point where a payload becomes text,
 * so no caller can render a body without it. It cleans the extraction rather
 * than discarding it: the provider's sentence and its bracketed tokens both
 * survive, and `payload.message` keeps the unredacted text for the classifiers
 * that match phrases on it.
 */
export function renderProviderErrorPayload(payload: ProviderErrorPayload): string | undefined {
  const message = payload.message;
  if (!message) return undefined;
  const tokens = [...new Set([payload.status, ...payload.reasons, ...payload.fields])]
    .filter((token): token is string => typeof token === 'string' && token.length > 0)
    .filter((token) => !message.includes(token));
  return redactSensitiveErrorText(tokens.length > 0 ? `${message} [${tokens.join('; ')}]` : message);
}

/**
 * Render error-body text as one readable line. Text that is not a recognizable
 * error body is returned unchanged, so plain provider prose is never mangled
 * and the function is safe to apply twice.
 */
export function providerErrorMessage(text: string): string {
  const payload = parseProviderErrorPayload(text);
  return (payload && renderProviderErrorPayload(payload)) ?? text;
}

/**
 * Restate a thrown provider error with the sentence the provider wrote.
 *
 * Consumers render `error.message` in CLI stderr and the `error` field of every
 * JSONL document record. Left alone, a Gemini failure puts a 500-byte JSON blob
 * in each of them, so the adapter normalizes the message before the error
 * escapes rather than asking every renderer to know the body format.
 *
 * The original error becomes `cause`, keeping the untouched body — and the
 * `status` own-property classifiers key on — reachable. Errors whose message is
 * already prose are returned as-is, so this is safe to apply anywhere and safe
 * to apply twice.
 *
 * The restated message is redacted, including when there is no parseable body
 * and the bare message is all there is: `message` is what renderers print, and
 * a provider is free to echo a request header or key into either one.
 */
export function readableProviderError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const payload = providerErrorPayloadOf(error);
  const readable = redactSensitiveErrorText(
    (payload ? renderProviderErrorPayload(payload) : undefined) ?? error.message,
  );
  if (!readable || readable === error.message) return error;
  const restated = new Error(readable, { cause: error });
  restated.name = error.name;
  if (error.stack) restated.stack = error.stack;
  const status = (error as { status?: unknown }).status;
  if (status !== undefined) {
    Object.defineProperty(restated, 'status', { value: status, enumerable: true, writable: true, configurable: true });
  }
  return restated;
}

/**
 * Run a provider call and restate any failure so its message is readable.
 * Applied at the adapter boundary, where "an error left the provider" is a
 * meaningful event, rather than around each individual SDK method.
 */
export async function withReadableProviderErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw readableProviderError(error);
  }
}

/**
 * Phrases Gemini uses when the *document* is what it could not handle. Verified
 * live: undecodable PNG bytes and a 25 MB inline part both return "Unable to
 * process input image", and a disallowed media type returns "Unsupported MIME
 * type: <type>". A MIME type only ever reaches the API on an inline media part,
 * so neither phrase can be reporting a request-option problem.
 */
const INPUT_MEDIA_PATTERNS: readonly RegExp[] = [
  /\bunable to process input (?:image|images|document|file|pdf|audio|video)\b/iu,
  /\bunsupported mime type\b/iu,
];

/** Response-schema field paths and message references, in either wire spelling. */
const RESPONSE_SCHEMA_PATTERN = /\bresponse_(?:json_)?schema\b/iu;

/**
 * The `GenerateContentRequest.<path>: <reason>` form Gemini uses when it rejects
 * a request field without attaching a `BadRequest` detail, e.g.
 * "* GenerateContentRequest.generation_config.max_output_tokens: must be positive."
 */
const REQUEST_FIELD_PATTERN = /\bGenerateContentRequest\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\s*:/u;

/** "models/<id> is not found for API version v1beta, or is not supported for ..." */
const UNKNOWN_MODEL_PATTERN = /\bmodels\/\S+ is not found for API version\b/iu;

/**
 * Identify what a provider blamed, using only signals it stated outright: a
 * named request field, a named response schema, a phrase that can only describe
 * the attached media, or a named missing model.
 *
 * Returns undefined whenever the body is generic. Gemini answers an
 * over-budget response-schema grammar with a bare
 * "Request contains an invalid argument." and no details at all — that body
 * cannot be told apart from any other malformed request, so it is left
 * unclassified here on purpose. `findSchemaCompatibilityIssues` is the evidence
 * that resolves that case, and it needs the schema, which an error does not
 * carry.
 */
export function providerErrorSubject(payload: ProviderErrorPayload): ProviderErrorSubject | undefined {
  const message = payload.message ?? '';
  if (payload.fields.some((field) => RESPONSE_SCHEMA_PATTERN.test(field))
    || RESPONSE_SCHEMA_PATTERN.test(message)) {
    return 'response-schema';
  }
  if (INPUT_MEDIA_PATTERNS.some((pattern) => pattern.test(message))) return 'input-media';
  if (UNKNOWN_MODEL_PATTERN.test(message)) return 'model';
  if (payload.fields.length > 0 || REQUEST_FIELD_PATTERN.test(message)) return 'request-field';
  return undefined;
}
