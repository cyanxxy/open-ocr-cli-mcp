export interface BatchLockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  /**
   * Identity of the owning process's start (Linux: boot ID plus start time in
   * clock ticks; elsewhere `ps` lstart). A live PID whose identity differs is a
   * reused PID, so the lock is stale. Absent on locks from older releases and
   * where the platform offers no way to read it.
   */
  processStart?: string;
}

/** A non-null, non-array object: the only JSON shape with readable properties. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

/**
 * Membership test that narrows, for validating an untrusted value against a
 * closed list of allowed literals.
 *
 * `allowed.includes(value as T)` is the shape this replaces. That cast exists
 * only to satisfy `includes`, and because it does not narrow `value`, every
 * consumer downstream needs a second assertion to use the result — an assertion
 * the compiler cannot check and that silently starts lying if the guard above it
 * is ever edited. This carries the proof instead.
 */
export function isOneOf<const T extends readonly unknown[]>(
  allowed: T,
  value: unknown,
): value is T[number] {
  return allowed.includes(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function parseBatchLockOwner(value: unknown): BatchLockOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  if (
    owner.version !== 1
    || typeof owner.token !== 'string'
    || owner.token.length === 0
    || typeof owner.pid !== 'number'
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.hostname !== 'string'
    || owner.hostname.length === 0
    || !isIsoTimestamp(owner.startedAt)
    || (owner.processStart !== undefined && (typeof owner.processStart !== 'string' || owner.processStart.length === 0))
  ) return undefined;
  return {
    version: 1,
    token: owner.token,
    pid: owner.pid,
    hostname: owner.hostname,
    startedAt: owner.startedAt,
    ...(typeof owner.processStart === 'string' ? { processStart: owner.processStart } : {}),
  };
}
