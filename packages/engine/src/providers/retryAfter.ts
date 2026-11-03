/**
 * Parse an HTTP `Retry-After` value: delta-seconds or an HTTP-date. Returns
 * undefined for an absent or unparseable value so callers fall back to backoff.
 */
export function parseRetryAfterHeader(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}
