import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
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
function urlInputError(message: string, hint: string, retryable = false): CliExitError {
  return new CliExitError(message, 2, {
    code: 'INPUT_INVALID',
    category: 'input',
    retryable,
    hint,
  });
}

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const NETWORK_IDLE_TIMEOUT_MS = 30_000;

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

function decodedStream(response: IncomingMessage): Readable {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  return response;
}

function readBounded(stream: Readable, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      stream.destroy(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('Operation aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
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
    stream.once('end', () => { cleanup(); resolve(Buffer.concat(chunks)); });
  });
}

async function requestOnce(url: URL, signal?: AbortSignal): Promise<IncomingMessage> {
  const host = unbracketHost(url.hostname);
  const addresses = await resolvedPublicAddresses(host);
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
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      // SNI carries names, never addresses; sending an IP literal as the server
      // name is rejected by conforming servers.
      ...(url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {}),
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(options, resolve);
    request.setTimeout(NETWORK_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error(`URL network operation was idle for ${NETWORK_IDLE_TIMEOUT_MS / 1000} seconds`));
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

export async function secureFetchPublicUrl(
  value: string,
  signal?: AbortSignal,
  redirectCount = 0,
): Promise<SecureFetchResult> {
  const url = parseSupportedHttpUrl(value);
  if (!url) {
    throw urlInputError(
      `Unsupported or unsafe URL: ${value}`,
      'Use a public http(s) URL without embedded credentials.',
    );
  }
  const response = await requestOnce(url, signal);
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.resume();
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
    return secureFetchPublicUrl(new URL(location, url).toString(), signal, redirectCount + 1);
  }
  if (status < 200 || status >= 300) {
    response.resume();
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
  return {
    url: url.toString(),
    contentType: String(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase(),
    bytes: await readBounded(decodedStream(response), signal),
  };
}
