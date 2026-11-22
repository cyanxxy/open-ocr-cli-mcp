import ipaddr from 'ipaddr.js';

const SUPPORTED_URL_PROTOCOLS = new Set(['http:', 'https:']);

// audit H-08: Gemini's URL Context only supports publicly-accessible HTTP/HTTPS
// URLs. We reject anything that targets the local machine, a private network, or
// a tunnelling host, and anything that smuggles credentials in the authority.
// This is defense-in-depth against SSRF-style abuse and avoids handing the model
// URLs it can never legitimately fetch.

const LOOPBACK_HOSTNAMES = new Set(['localhost']);

// Hostname suffixes for public tunnelling services that expose otherwise-private
// origins. Gemini URL Context does not support these.
const TUNNELING_HOST_SUFFIXES = [
  '.ngrok.io',
  '.ngrok-free.app',
  '.ngrok.app',
  '.ngrok.dev',
  '.pinggy.io',
  '.pinggy.link',
  '.pinggy.online',
  '.loca.lt', // localtunnel
];

/** Return true only for globally routable IPv4 or IPv6 addresses. */
export function isPublicIpAddress(address: string): boolean {
  const normalized = address.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!ipaddr.isValid(normalized)) return false;
  const parsed = ipaddr.parse(normalized);
  // Never follow IPv4-mapped IPv6 answers. Hexadecimal forms such as
  // ::ffff:7f00:1 have historically bypassed dotted-quad-only filters.
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) return false;
  // Nor the deprecated IPv4-compatible block ::/96 (RFC 4291 2.5.5.1), which
  // ipaddr.js labels unicast: the URL parser turns [::127.0.0.1] into
  // [::7f00:1], and ::a9fe:a9fe embeds the cloud metadata address.
  if (parsed instanceof ipaddr.IPv6 && parsed.parts.slice(0, 6).every((part) => part === 0)) return false;
  return parsed.range() === 'unicast';
}

function isTunnelingHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  return TUNNELING_HOST_SUFFIXES.some((suffix) => lowered === suffix.slice(1) || lowered.endsWith(suffix));
}

/**
 * Parse a URL and return it only when it is a publicly-fetchable HTTP/HTTPS URL
 * that Gemini's URL Context can actually retrieve. Returns null otherwise.
 *
 * audit H-08: in addition to the http(s) scheme check, this rejects embedded
 * credentials, loopback/localhost, private/link-local/CGNAT IP ranges, and known
 * tunnelling hosts.
 */
export function parseSupportedHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (!SUPPORTED_URL_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  // Reject credentials smuggled into the authority (user:pass@host).
  if (parsed.username || parsed.password) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return null;
  }

  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return null;
  }

  const unwrappedHostname = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (ipaddr.isValid(unwrappedHostname) && !isPublicIpAddress(unwrappedHostname)) {
    return null;
  }

  if (isTunnelingHost(hostname)) {
    return null;
  }

  return parsed;
}

export function isSupportedHttpUrl(value: string): boolean {
  return parseSupportedHttpUrl(value) !== null;
}

export function getUnsupportedUrls(urls: string[]): string[] {
  return urls.filter((url) => !isSupportedHttpUrl(url));
}
