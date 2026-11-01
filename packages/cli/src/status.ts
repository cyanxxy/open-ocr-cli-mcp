import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { GATEWAY_IDS, GEMINI_MODELS, PROVIDER_IDS } from '@open-ocr/engine/providers';
import { batchMetadataError, CliExitError } from './errors';
import { asRecord, isIsoTimestamp, isOneOf, parseBatchLockOwner } from './jsonValidation';
import { artifactFileExists, parseCliManifest, parseUsageSnapshot } from './manifest';
import { artifactPathKey, batchLockOwnerState, isTransactionFileName, type BatchLockState } from './output';
import {
  CLI_MODES,
  type BatchSummary,
  type ManifestEntry,
  type OcrJobResult,
} from './types';

export interface BatchStatusEntry {
  source: string;
  /**
   * `path` for a document read from disk, `synthetic` for one that never had a
   * path — piped stdin bytes and URL sets share the `<stdin>` manifest key.
   * A synthetic source cannot be stat'ed, so reporting it as missing made every
   * stdin and URL batch look like permanent source drift.
   */
  sourceKind: 'path' | 'synthetic';
  status: ManifestEntry['status'];
  completedAt: string;
  outputFiles: string[];
  missingOutputFiles: string[];
  sourceExists: boolean;
  error?: string;
}

export interface BatchStatusLock {
  path: string;
  ownerValid: boolean;
  /**
   * `live`: the owning process is running; `stale`: it is gone (or its PID was
   * reused), and the next extract reclaims the lock automatically;
   * `unverifiable`: another host owns it, or the owner record is invalid.
   */
  state: BatchLockState;
  pid?: number;
  hostname?: string;
  startedAt?: string;
}

export interface BatchStatusReport {
  outputDirectory: string;
  manifestPath: string;
  summaryPath: string;
  lockPath: string;
  manifestPresent: boolean;
  summaryPresent: boolean;
  activeLock?: BatchStatusLock;
  /**
   * Usage recorded across every run in this directory (the total `--max-cost`
   * is enforced against on resume). Absent for manifests from older releases.
   */
  cumulativeUsage?: BatchSummary['usage'];
  /**
   * Artifact-shaped files (`.md`, `.json`, `.csv`) in the output directory
   * that no manifest entry owns. A resume refuses to replace them.
   */
  untrackedArtifacts: string[];
  /** Staging/backup leftovers (`*.<pid>-<uuid>.tmp|.bak`) of an interrupted write. */
  strayTempFiles: string[];
  lastRun?: Pick<
    BatchSummary,
    | 'startedAt'
    | 'completedAt'
    | 'durationMs'
    | 'mode'
    | 'provider'
    | 'gateway'
    | 'model'
    | 'usage'
    | 'costLimitReached'
  > & {
    incomplete: boolean;
  };
  counts: {
    total: number;
    succeeded: number;
    partial: number;
    failed: number;
    skipped: number;
    missingArtifacts: number;
    missingSources: number;
    /** Manifest entries claimed by a run that never finished them. */
    interrupted: number;
    untrackedArtifacts: number;
    strayTempFiles: number;
  };
  sourceDrift: boolean;
  healthy: boolean;
  entries: BatchStatusEntry[];
}

interface ParsedSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  mode: BatchSummary['mode'];
  provider: NonNullable<BatchSummary['provider']>;
  gateway: NonNullable<BatchSummary['gateway']>;
  model: BatchSummary['model'];
  usage: BatchSummary['usage'];
  costLimitReached: boolean;
  results: Array<Pick<OcrJobResult, 'status' | 'skipReason'>>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw batchMetadataError(`Invalid JSON in ${filePath}: ${error.message}`);
    throw error;
  }
}

async function readBatchLockIfPresent(lockPath: string): Promise<BatchStatusLock | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return { path: lockPath, ownerValid: false, state: 'unverifiable' };
    throw error;
  }
  const owner = parseBatchLockOwner(value);
  if (!owner) return { path: lockPath, ownerValid: false, state: 'unverifiable' };
  return {
    path: lockPath,
    ownerValid: true,
    state: batchLockOwnerState(owner),
    pid: owner.pid,
    hostname: owner.hostname,
    startedAt: owner.startedAt,
  };
}

/**
 * See {@link manifestRecord} in manifest.ts: `asRecord` belongs to the shared
 * JSON helpers and reports configuration errors, which is the wrong taxonomy for
 * a batch directory whose summary is corrupt.
 */
function summaryRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    return asRecord(value, label);
  } catch (error) {
    throw batchMetadataError(error instanceof Error ? error.message : String(error));
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function parseSummaryResult(value: unknown, label: string): Pick<OcrJobResult, 'status' | 'skipReason'> {
  const record = summaryRecord(value, label);
  if (
    record.status !== 'succeeded'
    && record.status !== 'partial'
    && record.status !== 'failed'
    && record.status !== 'skipped'
  ) {
    throw batchMetadataError(`${label} has an invalid status`);
  }
  const allowedSkipReasons: ReadonlyArray<OcrJobResult['skipReason']> = [
    undefined,
    'validated',
    'resumed',
    'cancelled',
    'cost-limit',
    'fail-fast',
  ];
  if (!allowedSkipReasons.includes(record.skipReason as OcrJobResult['skipReason'])) {
    throw batchMetadataError(`${label} has an invalid skipReason`);
  }
  if (record.status !== 'skipped' && record.skipReason !== undefined) {
    throw batchMetadataError(`${label} has a skipReason but is not skipped`);
  }
  return {
    status: record.status,
    ...(record.skipReason ? { skipReason: record.skipReason as NonNullable<OcrJobResult['skipReason']> } : {}),
  };
}

function parseSummary(value: unknown, summaryPath: string): ParsedSummary | undefined {
  if (value === undefined) return undefined;
  const record = summaryRecord(value, summaryPath);
  const countKeys = ['total', 'succeeded', 'partial', 'failed', 'skipped'] as const;
  const usage = summaryRecord(record.usage, `${summaryPath}: usage`);
  const usageIntegerKeys = [
    'requests',
    'inputTokens',
    'outputTokens',
    'thoughtTokens',
    'toolTokens',
    'cachedTokens',
    'totalTokens',
  ] as const;
  // `provider` and `gateway` are both required. Every summary this CLI writes
  // carries them, and the old "absent means gemini/direct" fallback silently
  // relabelled a summary from an unknown writer as a Gemini run.
  //
  // The checks are inlined into the guard below rather than hoisted into a
  // `hasValidProviderMetadata` boolean so that `isOneOf` narrows these three
  // locals for the return statement. A boolean alias would validate the same
  // values but leave them `unknown`, which is what previously forced the
  // unchecked `as NonNullable<BatchSummary['provider']>` assertions.
  const provider = record.provider;
  const gateway = record.gateway;
  const mode = record.mode;
  const model = record.model;
  if (
    record.version !== 1
    || !isIsoTimestamp(record.startedAt)
    || !isIsoTimestamp(record.completedAt)
    || Date.parse(record.completedAt) < Date.parse(record.startedAt)
    || !isOneOf(CLI_MODES, mode)
    || typeof model !== 'string'
    || model.trim().length === 0
    || !isOneOf(PROVIDER_IDS, provider)
    || !isOneOf(GATEWAY_IDS, gateway)
    || (provider === 'gemini' && !isOneOf(GEMINI_MODELS, model))
    || !isNonNegativeNumber(record.durationMs)
    || countKeys.some((key) => !isNonNegativeInteger(record[key]))
    || usageIntegerKeys.some((key) => !isNonNegativeInteger(usage[key]))
    || !isNonNegativeNumber(usage.estimatedCostUsd)
    || typeof record.costLimitReached !== 'boolean'
    || !Array.isArray(record.results)
  ) {
    throw batchMetadataError(`Invalid batch summary in ${summaryPath}`);
  }
  const total = record.total as number;
  const succeeded = record.succeeded as number;
  const partial = record.partial as number;
  const failed = record.failed as number;
  const skipped = record.skipped as number;
  const results = (record.results as unknown[]).map((result, index) => (
    parseSummaryResult(result, `${summaryPath}: result ${index + 1}`)
  ));
  if (
    results.length !== total
    || succeeded + partial + failed + skipped !== total
    || results.filter((result) => result.status === 'succeeded').length !== succeeded
    || results.filter((result) => result.status === 'partial').length !== partial
    || results.filter((result) => result.status === 'failed').length !== failed
    || results.filter((result) => result.status === 'skipped').length !== skipped
  ) {
    throw batchMetadataError(`Invalid batch summary counts in ${summaryPath}`);
  }
  return {
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    total,
    succeeded,
    partial,
    failed,
    skipped,
    mode,
    provider,
    gateway,
    model,
    usage: parseUsageSnapshot(usage, `${summaryPath}: usage`)!,
    costLimitReached: record.costLimitReached,
    results,
  };
}

const METADATA_FILES = new Set(['.open-ocr-manifest.json', 'batch-summary.json', '.open-ocr.lock']);
const ARTIFACT_EXTENSION = /\.(?:md|json|csv)$/iu;

/** Walk the output directory for files the manifest does not account for. */
async function scanOutputDirectory(
  outputDirectory: string,
  owned: ReadonlySet<string>,
): Promise<{ untrackedArtifacts: string[]; strayTempFiles: string[] }> {
  const untrackedArtifacts: string[] = [];
  const strayTempFiles: string[] = [];
  let entries: Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(outputDirectory, { recursive: true, withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { untrackedArtifacts, strayTempFiles };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const directory = entry.parentPath ?? entry.path ?? outputDirectory;
    const filePath = path.join(directory, entry.name);
    if (isTransactionFileName(entry.name)) {
      strayTempFiles.push(filePath);
      continue;
    }
    if (directory === outputDirectory && METADATA_FILES.has(entry.name)) continue;
    if (!ARTIFACT_EXTENSION.test(entry.name)) continue;
    if (!owned.has(artifactPathKey(filePath))) untrackedArtifacts.push(filePath);
  }
  untrackedArtifacts.sort((left, right) => left.localeCompare(right));
  strayTempFiles.sort((left, right) => left.localeCompare(right));
  return { untrackedArtifacts, strayTempFiles };
}

export async function inspectBatchStatus(
  output: string,
  cwd: string,
): Promise<BatchStatusReport> {
  const outputDirectory = path.resolve(cwd, output);
  const manifestPath = path.join(outputDirectory, '.open-ocr-manifest.json');
  const summaryPath = path.join(outputDirectory, 'batch-summary.json');
  const lockPath = path.join(outputDirectory, '.open-ocr.lock');
  const [manifestValue, summaryValue, activeLock] = await Promise.all([
    readJsonIfPresent(manifestPath),
    readJsonIfPresent(summaryPath),
    readBatchLockIfPresent(lockPath),
  ]);
  if (manifestValue === undefined && summaryValue === undefined && activeLock === undefined) {
    // Typed rather than bare: the untyped classifier would report "no batch
    // metadata" as a configuration error, and an agent reading `code` cannot
    // tell "wrong directory" from "malformed flags".
    throw new CliExitError(`No Open OCR batch metadata found in ${outputDirectory}`, 2, {
      code: 'INPUT_NOT_FOUND',
      category: 'input',
      retryable: false,
      hint: 'Point status at the batch output directory (extract writes ./open-ocr-output; run and MCP write .open-ocr-results/<runId>).',
    });
  }
  const manifest = manifestValue === undefined
    ? undefined
    : parseCliManifest(manifestValue, manifestPath);
  const summary = parseSummary(summaryValue, summaryPath);
  const owned = new Set<string>();
  for (const entry of Object.values(manifest?.entries ?? {})) {
    for (const file of [...entry.outputFiles, ...(entry.ownedFiles ?? [])]) owned.add(artifactPathKey(file));
  }
  const { untrackedArtifacts, strayTempFiles } = await scanOutputDirectory(outputDirectory, owned);
  const entries = await Promise.all(Object.entries(manifest?.entries ?? {}).map(async ([source, entry]) => {
    const missingOutputFiles = (await Promise.all(entry.outputFiles.map(async (file) => ({
      file,
      exists: await artifactFileExists(file),
    })))).filter(({ exists }) => !exists).map(({ file }) => file);
    // Every real key is `input.absolutePath`, so anything relative is a
    // synthetic key rather than a path that has gone missing.
    const synthetic = !path.isAbsolute(source);
    return {
      source,
      sourceKind: synthetic ? 'synthetic' : 'path',
      status: entry.status,
      completedAt: entry.completedAt,
      outputFiles: entry.outputFiles,
      missingOutputFiles,
      sourceExists: synthetic ? true : await pathExists(source),
      error: entry.error,
    } satisfies BatchStatusEntry;
  }));
  const summaryCounts = summary
    ? {
        total: summary.total,
        succeeded: summary.succeeded,
        partial: summary.partial,
        failed: summary.failed,
        skipped: summary.skipped,
      }
    : undefined;
  const counts = {
    total: summaryCounts?.total ?? entries.length,
    succeeded: summaryCounts?.succeeded ?? entries.filter((entry) => entry.status === 'succeeded').length,
    partial: summaryCounts?.partial ?? entries.filter((entry) => entry.status === 'partial').length,
    failed: summaryCounts?.failed ?? entries.filter((entry) => entry.status === 'failed').length,
    skipped: summaryCounts?.skipped ?? 0,
    missingArtifacts: entries.reduce((sum, entry) => sum + entry.missingOutputFiles.length, 0),
    missingSources: entries.filter((entry) => !entry.sourceExists).length,
    interrupted: entries.filter((entry) => entry.status === 'pending').length,
    untrackedArtifacts: untrackedArtifacts.length,
    strayTempFiles: strayTempFiles.length,
  };
  const lastRunIncomplete = summary?.results.some((result) => (
    result.status === 'skipped'
    && result.skipReason !== 'resumed'
    && result.skipReason !== 'validated'
  )) ?? false;
  const manifestHasProblems = entries.some((entry) => (
    entry.status !== 'succeeded'
    || entry.missingOutputFiles.length > 0
  ));
  const lastRunHasProblems = summary !== undefined && (
    summary.failed > 0
    || summary.partial > 0
    || summary.costLimitReached
    || lastRunIncomplete
  );
  return {
    outputDirectory,
    manifestPath,
    summaryPath,
    lockPath,
    manifestPresent: manifest !== undefined,
    summaryPresent: summary !== undefined,
    ...(activeLock ? { activeLock } : {}),
    ...(manifest?.usage ? { cumulativeUsage: manifest.usage } : {}),
    untrackedArtifacts,
    strayTempFiles,
    ...(summary ? {
      lastRun: {
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        durationMs: summary.durationMs,
        mode: summary.mode,
        provider: summary.provider,
        gateway: summary.gateway,
        model: summary.model,
        usage: summary.usage,
        costLimitReached: summary.costLimitReached,
        incomplete: lastRunIncomplete,
      },
    } : {}),
    counts,
    sourceDrift: counts.missingSources > 0,
    healthy: activeLock === undefined
      && !manifestHasProblems
      && !lastRunHasProblems
      && untrackedArtifacts.length === 0
      && strayTempFiles.length === 0,
    entries,
  };
}

export function renderBatchStatus(report: BatchStatusReport): string {
  const lines = [
    `Batch: ${report.outputDirectory}`,
    `${report.lastRun ? 'Last run documents' : 'Documents'}: ${report.counts.total} total, ${report.counts.succeeded} succeeded, ${report.counts.partial} partial, ${report.counts.failed} failed, ${report.counts.skipped} skipped`,
    `Artifacts: ${report.counts.missingArtifacts === 0 ? 'all present' : `${report.counts.missingArtifacts} missing`}`,
    `Sources: ${report.counts.missingSources === 0 ? 'all present' : `${report.counts.missingSources} missing or moved`}`,
  ];
  if (report.activeLock) {
    const owner = report.activeLock.ownerValid
      ? `PID ${report.activeLock.pid} on ${report.activeLock.hostname}, started ${report.activeLock.startedAt}`
      : 'owner details are invalid or unavailable';
    const state = report.activeLock.state === 'live'
      ? 'held by a running process'
      : report.activeLock.state === 'stale'
        ? 'stale; its owner is gone and the next extract reclaims it'
        : 'cannot be verified from this host';
    lines.push(`Batch lock: ${state} (${owner})`);
  }
  if (report.counts.interrupted > 0) {
    lines.push(`Interrupted: ${report.counts.interrupted} document(s) were being written when a run stopped; resume re-extracts them`);
  }
  if (report.untrackedArtifacts.length > 0) {
    lines.push(`Untracked files: ${report.untrackedArtifacts.length} artifact-like file(s) no manifest entry owns; resume will not replace them`);
  }
  if (report.strayTempFiles.length > 0) {
    // Recovery runs under the batch lock and removes every leftover last
    // touched before the lock was taken, whatever its embedded PID, so this
    // promise holds unless a batch is writing here right now.
    lines.push(report.activeLock?.state === 'live'
      ? `Leftover temp files: ${report.strayTempFiles.length} (a batch is running here; they may be its in-progress writes)`
      : `Leftover temp files: ${report.strayTempFiles.length} (from an interrupted write; the next extract into this directory cleans them up)`);
  }
  const usageLine = (label: string, usage: BatchSummary['usage']): string => (
    `${label}: ${usage.totalTokens} tokens, ${usage.requests} requests, estimated $${usage.estimatedCostUsd.toFixed(6)}`
    + (usage.unreportedUsageRequests ? ` (${usage.unreportedUsageRequests} response(s) reported no usage)` : '')
  );
  if (report.lastRun) {
    lines.push(
      `Last run: ${report.lastRun.completedAt} with ${report.lastRun.provider}/${report.lastRun.model} via ${report.lastRun.gateway} in ${report.lastRun.mode} mode`,
      usageLine('Usage (last run)', report.lastRun.usage),
    );
    if (report.lastRun.costLimitReached) lines.push('Last run stopped at its estimated cost limit.');
    else if (report.lastRun.incomplete) lines.push('Last run did not schedule or complete every document.');
  }
  if (report.cumulativeUsage) lines.push(usageLine('Usage (all runs)', report.cumulativeUsage));
  const issues = report.entries.filter((entry) => (
    entry.status !== 'succeeded' || entry.missingOutputFiles.length > 0
  ));
  if (issues.length > 0) {
    lines.push('', 'Needs attention:');
    for (const entry of issues.slice(0, 20)) {
      const details = [
        entry.status,
        entry.error,
        entry.missingOutputFiles.length > 0 ? `${entry.missingOutputFiles.length} missing artifact(s)` : undefined,
      ].filter(Boolean).join('; ');
      lines.push(`  - ${entry.source}: ${details}`);
    }
    if (issues.length > 20) lines.push(`  - …and ${issues.length - 20} more`);
  }
  for (const [heading, files] of [
    ['Untracked artifact files:', report.untrackedArtifacts],
    ['Leftover temp files:', report.strayTempFiles],
  ] as const) {
    if (files.length === 0) continue;
    lines.push('', heading);
    for (const file of files.slice(0, 20)) lines.push(`  - ${file}`);
    if (files.length > 20) lines.push(`  - …and ${files.length - 20} more`);
  }
  const sourceWarnings = report.entries.filter((entry) => (
    entry.sourceKind === 'path' && !entry.sourceExists
  ));
  if (sourceWarnings.length > 0) {
    lines.push('', 'Source drift (artifacts remain auditable):');
    for (const entry of sourceWarnings.slice(0, 20)) lines.push(`  - ${entry.source}: missing or moved`);
    if (sourceWarnings.length > 20) lines.push(`  - …and ${sourceWarnings.length - 20} more`);
  }
  const status = report.activeLock?.state === 'live'
    ? 'Status: batch in progress'
    : report.activeLock?.state === 'stale'
      ? 'Status: interrupted (stale lock)'
      : report.activeLock
        ? 'Status: batch in progress or stale lock'
        : report.healthy ? 'Status: healthy' : 'Status: attention required';
  lines.push('', status);
  return `${lines.join('\n')}\n`;
}
