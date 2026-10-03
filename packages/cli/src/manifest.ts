import { promises as fs } from 'node:fs';

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

/** Parse the on-disk resume manifest without trusting user-editable JSON. */
export function parseCliManifest(value: unknown, manifestPath: string): CliManifest {
  const record = manifestRecord(value, manifestPath);
  if (record.version !== 1) throw batchMetadataError(`Unsupported manifest version in ${manifestPath}`);
  const rawEntries = manifestRecord(record.entries, `${manifestPath}: entries`);
  const entries: Record<string, ManifestEntry> = {};

  for (const [source, rawEntry] of Object.entries(rawEntries)) {
    if (source.length === 0) throw batchMetadataError(`${manifestPath} has an empty source key`);
    const entry = manifestRecord(rawEntry, `${manifestPath}: entry ${source}`);
    if (entry.status !== 'succeeded' && entry.status !== 'partial' && entry.status !== 'failed') {
      throw batchMetadataError(`${manifestPath}: entry ${source} has an invalid status`);
    }
    if (!isStringArray(entry.outputFiles) || entry.outputFiles.some((file) => file.length === 0)) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has invalid outputFiles`);
    }
    if (entry.status !== 'failed' && entry.outputFiles.length === 0) {
      throw batchMetadataError(`${manifestPath}: entry ${source} has no resumable output files`);
    }
    if (
      typeof entry.fingerprint !== 'string'
      || entry.fingerprint.length === 0
      || !isIsoTimestamp(entry.completedAt)
    ) {
      throw batchMetadataError(`${manifestPath}: entry ${source} is incomplete`);
    }
    if (entry.error !== undefined && typeof entry.error !== 'string') {
      throw batchMetadataError(`${manifestPath}: entry ${source} has an invalid error`);
    }
    entries[source] = {
      fingerprint: entry.fingerprint,
      status: entry.status,
      outputFiles: [...entry.outputFiles],
      completedAt: entry.completedAt,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
  }

  return { version: 1, entries };
}
