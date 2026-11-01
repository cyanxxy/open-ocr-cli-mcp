import { promises as fs } from 'node:fs';

import type { ProviderUsageSnapshot } from '@open-ocr/engine/providers';
import { batchMetadataError } from './errors';
import type { CliManifest, ManifestEntry } from './types';
import { asRecord, isIsoTimestamp } from './jsonValidation';

/** A directory or device at an artifact path cannot satisfy a completed run. */
export async function artifactFileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * `asRecord` is shared with the configuration reader, which needs its failures
 * typed as configuration errors. Re-throw here so a malformed manifest is
 * classified like every other corrupt-metadata failure in this file.
 */
function manifestRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    return asRecord(value, label);
  } catch (error) {
    throw batchMetadataError(error instanceof Error ? error.message : String(error));
  }
}

const USAGE_INTEGER_KEYS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'thoughtTokens',
  'toolTokens',
  'cachedTokens',
  'totalTokens',
] as const;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate a stored usage snapshot; undefined when absent, throws when malformed. */
export function parseUsageSnapshot(value: unknown, label: string): ProviderUsageSnapshot | undefined {
  if (value === undefined) return undefined;
  const record = manifestRecord(value, label);
  if (
    USAGE_INTEGER_KEYS.some((key) => !isNonNegativeInteger(record[key]))
    || typeof record.estimatedCostUsd !== 'number'
    || !Number.isFinite(record.estimatedCostUsd)
    || record.estimatedCostUsd < 0
    || (record.unreportedUsageRequests !== undefined && !isNonNegativeInteger(record.unreportedUsageRequests))
  ) {
    throw batchMetadataError(`${label} is invalid`);
  }
  const unreported = record.unreportedUsageRequests;
  return {
    requests: record.requests as number,
    inputTokens: record.inputTokens as number,
    outputTokens: record.outputTokens as number,
    thoughtTokens: record.thoughtTokens as number,
    toolTokens: record.toolTokens as number,
    cachedTokens: record.cachedTokens as number,
    totalTokens: record.totalTokens as number,
    estimatedCostUsd: record.estimatedCostUsd,
    ...(unreported ? { unreportedUsageRequests: unreported } : {}),
  };
}

/** Field-wise sum of two usage snapshots. */
export function addUsageSnapshots(
  left: ProviderUsageSnapshot | undefined,
  right: ProviderUsageSnapshot,
): ProviderUsageSnapshot {
  if (!left) return { ...right };
  const unreported = (left.unreportedUsageRequests ?? 0) + (right.unreportedUsageRequests ?? 0);
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    thoughtTokens: left.thoughtTokens + right.thoughtTokens,
    toolTokens: left.toolTokens + right.toolTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCostUsd: Number((left.estimatedCostUsd + right.estimatedCostUsd).toFixed(8)),
    ...(unreported > 0 ? { unreportedUsageRequests: unreported } : {}),
  };
}

/** Parse the on-disk resume manifest without trusting user-editable JSON. */
export function parseCliManifest(value: unknown, manifestPath: string): CliManifest {
  const record = manifestRecord(value, manifestPath);
  if (record.version !== 1) throw batchMetadataError(`Unsupported manifest version in ${manifestPath}`);
  const rawEntries = manifestRecord(record.entries, `${manifestPath}: entries`);
  const entries: Record<string, ManifestEntry> = {};

  for (const [source, rawEntry] of Object.entries(rawEntries)) {
    if (source.length === 0) throw batchMetadataError(`${manifestPath} has an empty source key`);
    const entry = manifestRecord(rawEntry, `${manifestPath}: entry ${source}`);
    if (
      entry.status !== 'succeeded'
      && entry.status !== 'partial'
      && entry.status !== 'failed'
      && entry.status !== 'pending'
    ) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has an invalid status`);
    }
    if (!isStringArray(entry.outputFiles) || entry.outputFiles.some((file) => file.length === 0)) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has invalid outputFiles`);
    }
    if (
      entry.ownedFiles !== undefined
      && (!isStringArray(entry.ownedFiles) || entry.ownedFiles.some((file) => file.length === 0))
    ) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has invalid ownedFiles`);
    }
    if (
      (entry.status === 'succeeded' || entry.status === 'partial')
      && entry.outputFiles.length === 0
    ) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has no resumable output files`);
    }
    if (
      typeof entry.fingerprint !== 'string'
      || entry.fingerprint.length === 0
      || !isIsoTimestamp(entry.completedAt)
    ) {
      throw batchMetadataError(`${manifestPath}: entry ${source} is incomplete`);
    }
    if (entry.fingerprintVersion !== undefined && entry.fingerprintVersion !== 2) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has an unsupported fingerprintVersion`);
    }
    if (entry.error !== undefined && typeof entry.error !== 'string') {
      throw batchMetadataError(`${manifestPath}: entry ${source} has an invalid error`);
    }
    entries[source] = {
      fingerprint: entry.fingerprint,
      ...(entry.fingerprintVersion === 2 ? { fingerprintVersion: 2 as const } : {}),
      status: entry.status,
      outputFiles: [...entry.outputFiles],
      ...(entry.ownedFiles !== undefined ? { ownedFiles: [...entry.ownedFiles] } : {}),
      completedAt: entry.completedAt,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
  }

  const usage = parseUsageSnapshot(record.usage, `${manifestPath}: usage`);
  return { version: 1, entries, ...(usage ? { usage } : {}) };
}
