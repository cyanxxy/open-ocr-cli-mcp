import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { pipeline, type Readable, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { isPublicIpAddress, parseSupportedHttpUrl } from '@open-ocr/engine/urlValidation';
import { CliExitError } from './errors';

/**
 * A URL that cannot be retrieved is an input problem, not a provider one.
 *
 * Left as bare `Error`s these reached the untyped classifier and were reported
 * as `PROVIDER_FAILURE`/`provider` — telling an agent to read a provider message
 * that does not exist, for a request no provider ever saw.
 */
function urlInputError(message: string, hint: string, retryable = false, cause?: unknown): CliExitError {
  return new CliExitError(message, 2, {
    ...(cause === undefined ? {} : { cause }),
    code: 'INPUT_INVALID',
    category: 'input',
    retryable,
    hint,
  });
}

/** Transport failures a later attempt can get past: a reset, a refused or dropped connection, a slow resolver. */
const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'ERR_STREAM_PREMATURE_CLOSE', 'URL_NETWORK_IDLE',
  // A compressed body cut off mid-stream.
  'Z_BUF_ERROR',
]);

function errorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Type a raw DNS, connect, TLS, socket, or decoding failure as the input
 * problem it is, keeping the original as `cause`. Aborts, the deadline, and
 * errors this module already typed pass through untouched.
 */
function transportError(error: unknown, value: string, signal: AbortSignal): unknown {
  if (error instanceof CliExitError || signal.aborted) return error;
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return error;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail = code !== undefined && !code.startsWith('URL_') && !message.includes(code)
    ? `${message || code} (${code})`
    : message || code || 'unknown error';
  if (code === 'ENOTFOUND') {
    return urlInputError(
      `Could not retrieve ${value}: ${detail}`,
      'Check the URL; its host name does not resolve.',
      false,
      error,
    );
  }
  const retryable = code !== undefined && RETRYABLE_TRANSPORT_CODES.has(code);
  return urlInputError(
    `Could not retrieve ${value}: ${detail}`,
    retryable
      ? 'The connection to the source site failed; retry later or use a different URL.'
      : 'The source site could not be fetched (a TLS or certificate failure, or a malformed response); check the URL.',
    retryable,
    error,
  );
}

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const NETWORK_IDLE_TIMEOUT_MS = 30_000;
/**
 * Wall-clock ceiling for one URL fetch: every redirect hop, DNS lookup, and the
 * whole body read. The idle timeout alone resets on every byte, so a server
 * trickling one byte every few seconds could hold a fetch open indefinitely.
 */
export const NETWORK_TOTAL_TIMEOUT_MS = 120_000;

export interface SecureFetchOptions {
  /** Override the wall-clock ceiling (tests, or a tighter caller budget). */
  totalTimeoutMs?: number;
}

export interface SecureFetchResult {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * WHATWG `URL.hostname` keeps the brackets on an IPv6 literal (`[2001:db8::1]`),
 * which is neither a valid `isIP` input nor a resolvable DNS name. Left
 * bracketed, every IPv6-literal URL missed the direct-address path and failed
 * with a bogus `ENOTFOUND [2001:db8::1]`.
 */
function unbracketHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function resolvedPublicAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const directFamily = isIP(hostname);
  const addresses = directFamily
    ? [{ address: hostname, family: directFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw urlInputError(
      `URL host does not resolve exclusively to public addresses: ${hostname}`,
      'Use a public HTTP(S) URL; loopback, private, and link-local hosts are refused.',
    );
  }
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

function decoderFor(response: IncomingMessage): Transform | undefined {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip') return createGunzip();
  if (encoding === 'deflate') return createInflate();
  if (encoding === 'br') return createBrotliDecompress();
  return undefined;
}

/**
 * The response body, decompressed when it is encoded.
 *
 * Joined with `pipeline`, not `pipe`: `pipe` forwards neither a source error
 * nor a premature close, so a compressed response whose connection dropped
 * mid-body left the decoder waiting until the total deadline, and was then
 * misreported (and retried) as a slow site. `pipeline` destroys every stream
 * when one fails, which also releases the socket when the decoder is destroyed
 * for an oversized body.
 */
function decodedStream(response: IncomingMessage): Readable {
  const decoder = decoderFor(response);
  if (!decoder) return response;
  pipeline(response, decoder, () => undefined);
  return decoder;
}

function prematureClose(): CliExitError {
  return urlInputError(
    'URL response ended before its body was complete',
    'The connection to the source site dropped; retry later or use a different URL.',
    true,
  );
}

function readBounded(stream: Readable, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let ended = false;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      stream.destroy(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Operation aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    stream.on('data', (chunk: Buffer | Uint8Array | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_RESPONSE_BYTES) {
        stream.destroy(urlInputError(
          `URL response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB`,
          'Use a smaller source document.',
        ));
        return;
      }
      chunks.push(buffer);
    });
    stream.once('error', (error) => { cleanup(); reject(error); });
    stream.once('end', () => { ended = true; cleanup(); resolve(Buffer.concat(chunks)); });
    // A stream destroyed without an error (or closed before `end`) would
    // otherwise leave this promise pending until the total deadline.
    stream.once('close', () => { cleanup(); if (!ended) reject(prematureClose()); });
  });
}

async function requestOnce(url: URL, signal?: AbortSignal): Promise<IncomingMessage> {
  const host = unbracketHost(url.hostname);
  const addresses = await resolvedPublicAddresses(host);
  // DNS cannot be cancelled; honour a deadline that fired while it ran.
  signal?.throwIfAborted();
  const selected = addresses[0];
  return new Promise<IncomingMessage>((resolve, reject) => {
    const options: RequestOptions = {
      protocol: url.protocol,
      // Unbracketed: Node re-brackets an IPv6 host itself when it builds the
      // `Host` header, and brackets are not a legal TLS server name.
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/pdf,image/*,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'open-ocr-cli (+https://github.com/cyanxxy/open-ocr-cli-mcp)',
      },
      // Pinned to the validated answers. Node's connect asks for every address
      // (`all: true`, for happy eyeballs) unless a family is fixed, and then
      // expects an array: answering in the single-address form failed every
      // hostname URL with ERR_INVALID_IP_ADDRESS. Every address handed over
      // here was checked by `resolvedPublicAddresses`.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) {
          callback(null, addresses.map(({ address, family }) => ({ address, family })));
          return;
        }
        callback(null, selected.address, selected.family);
      },
      // SNI carries names, never addresses; sending an IP literal as the server
      // name is rejected by conforming servers.
      ...(url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(options, resolve);
    request.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
      const idle: NodeJS.ErrnoException = new Error(
        `URL network operation was idle for ${NETWORK_IDLE_TIMEOUT_MS / 1000} seconds`,
      );
      idle.code = 'URL_NETWORK_IDLE';
      request.destroy(idle);
    });
    const onAbort = (): void => {
      request.destroy(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Operation aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.once('error', (error) => { signal?.removeEventListener('abort', onAbort); reject(error); });
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    request.end();
  });
}

/**
 * Fetch a public URL with DNS pinning, bounded redirects, a bounded body, an
 * idle timeout, and a total wall-clock deadline.
 */
export async function secureFetchPublicUrl(
  value: string,
  signal?: AbortSignal,
  options: SecureFetchOptions = {},
): Promise<SecureFetchResult> {
  const totalTimeoutMs = options.totalTimeoutMs ?? NETWORK_TOTAL_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(urlInputError(
      `URL fetch exceeded the ${totalTimeoutMs / 1000}-second total time limit: ${value}`,
      'The source site is responding too slowly; retry later or use a different URL.',
      true,
    ));
  }, totalTimeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    return await fetchFollowingRedirects(value, combined, 0);
  } catch (error) {
    // A deadline abort surfaces as whatever the aborted socket or stream
    // reported; restate it as the typed deadline error.
    if (deadline.signal.aborted && !signal?.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFollowingRedirects(
  value: string,
  signal: AbortSignal,
  redirectCount: number,
): Promise<SecureFetchResult> {
  signal.throwIfAborted();
  const url = parseSupportedHttpUrl(value);
  if (!url) {
    throw urlInputError(
      `Unsupported or unsafe URL: ${value}`,
      'Use a public http(s) URL without embedded credentials.',
    );
  }
  let response: IncomingMessage;
  try {
    response = await requestOnce(url, signal);
  } catch (error) {
    throw transportError(error, value, signal);
  }
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    // The body of a redirect or an error is never used. Draining it with
    // `resume()` kept a hostile endless body streaming into this process after
    // the fetch had returned, outliving the total deadline.
    response.destroy();
    const location = response.headers.location;
    if (!location) {
      throw urlInputError(
        `URL redirect from ${value} omitted Location`,
        'Request the redirect target directly.',
      );
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw urlInputError(
        `URL exceeded ${MAX_REDIRECTS} redirects`,
        'Request the final URL directly.',
      );
    }
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch (error) {
      throw urlInputError(
        `URL redirect from ${value} has an invalid Location`,
        'Request the redirect target directly.',
        false,
        error,
      );
    }
    return fetchFollowingRedirects(next, signal, redirectCount + 1);
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    // A 5xx or 429 from the *source site* is worth retrying; a 4xx is the URL
    // being wrong, which retrying cannot fix.
    throw urlInputError(
      `URL returned HTTP ${status}: ${value}`,
      status >= 500 || status === 429
        ? 'The source site failed; retry later or use a different URL.'
        : 'Check the URL; the source site rejected the request.',
      status >= 500 || status === 429,
    );
  }
  const declaredLength = Number(response.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    response.destroy();
    throw urlInputError(
      `URL response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB: ${value}`,
      'Use a smaller source document.',
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(decodedStream(response), signal);
  } catch (error) {
    response.destroy();
    throw transportError(error, value, signal);
  }
  return {
    url: url.toString(),
    contentType: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase(),
    bytes,
  };
}
