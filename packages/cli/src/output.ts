import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import { parseBatchLockOwner, type BatchLockOwner } from './jsonValidation';
import { batchMetadataError, CliExitError } from './errors';
import { artifactFileExists, parseCliManifest } from './manifest';
import type {
  BatchSummary,
  CliManifest,
  ManifestEntry,
  OcrArtifacts,
  ResolvedCliOptions,
  ResolvedInput,
} from './types';

const EMPTY_MANIFEST: CliManifest = { version: 1, entries: {} };

const OUTPUT_CONFLICT_HINT = 'Choose a new output path or resume a matching job.';

function outputConflict(message: string, cause?: unknown, hint = OUTPUT_CONFLICT_HINT): CliExitError {
  return new CliExitError(message, 2, {
    ...(cause !== undefined ? { cause } : {}),
    code: 'OUTPUT_CONFLICT',
    category: 'output',
    retryable: false,
    hint,
  });
}

export interface BatchLockAcquireOptions {
  forceUnlock?: boolean;
  onWarning?: (message: string) => void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
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

export function primaryArtifact(artifacts: OcrArtifacts, format: ResolvedCliOptions['format']): string {
  if (format === 'json') {
    if (artifacts.json === undefined) throw new Error('This extraction did not produce JSON output');
    return `${JSON.stringify(artifacts.json, null, 2)}\n`;
  }
  if (format === 'csv') {
    if (!artifacts.csv) throw new Error('This extraction did not produce tabular CSV output');
    return `${artifacts.csv.replace(/\n?$/, '\n')}`;
  }
  if (!artifacts.markdown) throw new Error('This extraction did not produce Markdown output');
  return artifacts.markdown.replace(/\n?$/, '\n');
}

function artifactEntries(
  artifacts: OcrArtifacts,
  format: ResolvedCliOptions['format'],
): Array<[ArtifactExtension, string]> {
  const entries: Array<[ArtifactExtension, string]> = [];
  if ((format === 'markdown' || format === 'all') && artifacts.markdown) {
    entries.push(['md', artifacts.markdown.replace(/\n?$/, '\n')]);
  }
  if ((format === 'json' || format === 'all') && artifacts.json !== undefined) {
    entries.push(['json', `${JSON.stringify(artifacts.json, null, 2)}\n`]);
  }
  if ((format === 'csv' || format === 'all') && artifacts.csv) {
    entries.push(['csv', artifacts.csv.replace(/\n?$/, '\n')]);
  }
  if (format === 'all' && artifacts.agentSteps) {
    entries.push(['steps.json', `${JSON.stringify(artifacts.agentSteps, null, 2)}\n`]);
  }
  if (format === 'csv' && !artifacts.csv) throw new Error('This extraction did not produce tabular CSV output');
  if (entries.length === 0) throw new Error(`No artifact is available for format ${format}`);
  return entries;
}

/** Validate an inline delivery against the same artifact contract as file output. */
export function assertArtifactFormatAvailable(
  artifacts: OcrArtifacts,
  format: ResolvedCliOptions['format'],
): void {
  void artifactEntries(artifacts, format);
}

function safeOutputRelative(input: ResolvedInput): string {
  const normalized = input.relativePath.replaceAll('\\', '/');
  const parsed = path.posix.parse(normalized);
  const safeDirectory = parsed.dir
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join(path.sep);
  return path.join(safeDirectory, parsed.name);
}

function plannedArtifactExtensions(options: ResolvedCliOptions): ArtifactExtension[] {
  if (options.format === 'markdown') return ['md'];
  if (options.format === 'json') return ['json'];
  if (options.format === 'csv') return ['csv'];
  // Plan only guaranteed artifacts. Template CSV depends on the model returning
  // at least one table row, so `--format all` cannot promise it before extraction.
  // Agentic runs always retain a steps array (including an empty one).
  if (options.mode === 'agentic') return ['md', 'json', 'steps.json'];
  return ['md', 'json'];
}

function possibleArtifactExtensions(options: ResolvedCliOptions): ArtifactExtension[] {
  if (options.format !== 'all') return plannedArtifactExtensions(options);
  if (options.mode === 'template') return ['md', 'json', 'csv'];
  if (options.mode === 'agentic') return ['md', 'json', 'steps.json'];
  return ['md', 'json'];
}

export function defaultOutputDirectory(options: ResolvedCliOptions): string {
  return path.resolve(options.cwd, options.output ?? 'open-ocr-output');
}

/**
 * True when `--output` names the single artifact file itself rather than a
 * directory this job owns.
 *
 * In that layout {@link defaultOutputDirectory} resolves to the artifact path,
 * so job metadata — manifest, lock, batch summary — has nowhere to live: writing
 * it would create a directory exactly where the extraction must write its file.
 */
export async function resolvesToSingleArtifactFile(
  options: ResolvedCliOptions,
  totalInputs: number,
): Promise<boolean> {
  // A caller that said "directory" gets a directory. The extension heuristic
  // below only guesses intent for the human `-o` flag, where the same string can
  // legitimately mean either.
  if (options.outputPathKind === 'directory') return false;
  if (totalInputs !== 1 || !options.output || options.format === 'all') return false;
  if (options.outputPathKind === 'file') return true;
  if (!path.extname(options.output)) return false;
  const explicitOutput = path.resolve(options.cwd, options.output);
  return !(await pathExists(explicitOutput) && (await fs.stat(explicitOutput)).isDirectory());
}

/**
 * The artifact extension keys, which are also what determine an artifact's
 * reported `kind` and `mediaType`.
 *
 * Carried alongside each path rather than re-derived from it: `--output
 * report.json --format markdown` is a legitimate request that writes Markdown to
 * a `.json` filename, and reading the extension back reported that file to the
 * caller as `kind: "json"`, `mediaType: "application/json"`. An agent that
 * trusted the reference would hand Markdown to a JSON parser.
 */
export type ArtifactExtension = 'md' | 'json' | 'csv' | 'steps.json';

export interface ArtifactTarget {
  path: string;
  extension: ArtifactExtension;
}

/** Restore typed artifact metadata from paths written by the directory layout. */
export function artifactTargetFromPath(filePath: string): ArtifactTarget {
  if (filePath.endsWith('.steps.json')) return { path: filePath, extension: 'steps.json' };
  if (filePath.endsWith('.json')) return { path: filePath, extension: 'json' };
  if (filePath.endsWith('.csv')) return { path: filePath, extension: 'csv' };
  return { path: filePath, extension: 'md' };
}

async function resolveArtifactTargets(
  input: ResolvedInput,
  extensions: ArtifactExtension[],
  options: ResolvedCliOptions,
  totalInputs: number,
): Promise<ArtifactTarget[]> {
  if (await resolvesToSingleArtifactFile(options, totalInputs)) {
    // One destination for one artifact, whatever the caller named the file.
    return [{ path: path.resolve(options.cwd, options.output!), extension: extensions[0] }];
  }
  return extensions.map((extension) => ({
    path: path.join(defaultOutputDirectory(options), `${safeOutputRelative(input)}.${extension}`),
    extension,
  }));
}

export async function plannedArtifactTargets(
  input: ResolvedInput,
  options: ResolvedCliOptions,
  totalInputs: number,
): Promise<ArtifactTarget[]> {
  const writesFiles = totalInputs > 1 || Boolean(options.output) || options.format === 'all';
  if (!writesFiles) return [];
  return resolveArtifactTargets(input, plannedArtifactExtensions(options), options, totalInputs);
}

/**
 * Comparison key for an artifact path recorded by an earlier run. Deliberately
 * exact rather than case-folded: reclaiming a path means agreeing to replace
 * it, so a near-miss must fall through to the conflict error instead.
 */
export function artifactPathKey(target: string): string {
  return path.resolve(target);
}

export interface ArtifactAvailabilityOptions {
  /**
   * Artifact paths this input's own manifest entry recorded. They are stale
   * output of a previous attempt at the same document, so a resume may replace
   * them; every other occupied destination is still a conflict.
   */
  reclaimable?: ReadonlySet<string>;
  /** A manifest-backed resume is active, which changes the conflict guidance. */
  resumeActive?: boolean;
}

/** Reject every destination this extraction could write before paid work starts. */
export async function assertArtifactTargetsAvailable(
  input: ResolvedInput,
  options: ResolvedCliOptions,
  totalInputs: number,
  availability: ArtifactAvailabilityOptions = {},
): Promise<void> {
  const writesFiles = totalInputs > 1 || Boolean(options.output) || options.format === 'all';
  if (!writesFiles) return;
  const reclaimable = availability.reclaimable ?? new Set<string>();
  const targets = await resolveArtifactTargets(
    input,
    possibleArtifactExtensions(options),
    options,
    totalInputs,
  );
  const existing = (await Promise.all(targets.map(async ({ path: target }): Promise<string | undefined> => {
    try {
      // lstat treats a dangling symlink as occupied; access() would follow it,
      // report ENOENT, and allow paid extraction before the final EEXIST.
      const metadata = await fs.lstat(target);
      if (metadata.isDirectory()) {
        throw outputConflict(`Output artifact path is occupied by a directory: ${target}`);
      }
      if (options.overwrite || reclaimable.has(artifactPathKey(target))) return undefined;
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }))).filter((target): target is string => target !== undefined);
  if (existing.length === 0) return;
  if (availability.resumeActive) {
    // Telling a caller who is already resuming to "resume a matching job" sends
    // them back to the thing they just did. Name what resume cannot claim.
    throw outputConflict(
      `Output already exists before extraction and no resume manifest entry claims it for ${input.displayPath}: `
      + `${existing.join(', ')}.`,
      undefined,
      'Move or remove the untracked file, or pick a different output directory; '
      + 'resume only replaces artifacts its own manifest recorded for this input.',
    );
  }
  throw outputConflict(
    `Output already exists before extraction: ${existing.join(', ')}. ${OUTPUT_CONFLICT_HINT}`,
  );
}

export async function assertNoOutputCollisions(
  inputs: ResolvedInput[],
  options: ResolvedCliOptions,
  reserveJobMetadata = inputs.length > 1,
): Promise<void> {
  const owners = new Map<string, string[]>();
  if (reserveJobMetadata) {
    const outputDirectory = defaultOutputDirectory(options);
    for (const metadataPath of [
      path.join(outputDirectory, '.open-ocr-manifest.json'),
      path.join(outputDirectory, 'batch-summary.json'),
      path.join(outputDirectory, '.open-ocr.lock'),
    ]) {
      const key = path.normalize(metadataPath).normalize('NFC').toLowerCase();
      owners.set(key, ['reserved job metadata']);
    }
  }
  await Promise.all(inputs.map(async (input) => {
    // Reserve optional outputs too: template CSV is not guaranteed, but it
    // must never overwrite or obstruct another document when it is produced.
    const targets = await resolveArtifactTargets(
      input,
      possibleArtifactExtensions(options),
      options,
      inputs.length,
    );
    for (const { path: target } of targets) {
      // Use a portable case-folded key on every platform. This deliberately
      // rejects names that are distinct on some Linux filesystems but collide
      // on default macOS/Windows volumes or when outputs are moved between them.
      const key = path.normalize(target).normalize('NFC').toLowerCase();
      owners.set(key, [...(owners.get(key) ?? []), input.displayPath]);
    }
  }));
  const collisions = [...owners.entries()].filter(([, sources]) => sources.length > 1);
  // Every artifact occupies a file path. An otherwise distinct destination
  // cannot also use that path as a directory, including reserved job metadata.
  for (const [target, sources] of owners) {
    let parent = path.dirname(target);
    while (parent !== path.dirname(parent)) {
      const parentOwners = owners.get(parent);
      if (parentOwners) collisions.push([target, [...parentOwners, ...sources]]);
      parent = path.dirname(parent);
    }
  }
  if (collisions.length === 0) return;
  const details = collisions
    .slice(0, 5)
    .map(([target, sources]) => `${target} <= ${sources.join(', ')}`)
    .join('; ');
  const remainder = collisions.length > 5 ? `; and ${collisions.length - 5} more` : '';
  throw outputConflict(
    `Output path collision detected before extraction: ${details}${remainder}. `
    + 'Rename same-stem inputs or process them into separate output directories.',
  );
}

const HARD_LINK_FALLBACK_CODES = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EPERM',
  'EXDEV',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeExclusiveFallback(target: string, content: string): Promise<void> {
  // Some network/FUSE and non-NTFS filesystems do not support hard links. An
  // exclusive open preserves the no-clobber guarantee there. Unlike a hard
  // link, the target is visible while it is written; failures are cleaned up
  // best-effort and the staged source remains available to the caller.
  const handle = await fs.open(target, 'wx');
  let failure: unknown;
  try {
    await handle.writeFile(content, { encoding: 'utf8' });
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure = failure === undefined
      ? error
      : new Error(`${errorMessage(failure)}; close also failed: ${errorMessage(error)}`, { cause: failure });
  }
  if (failure === undefined) return;

  try {
    await fs.rm(target, { force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      `${errorMessage(failure)}; exclusive-write cleanup also failed: ${errorMessage(cleanupError)}`,
      { cause: cleanupError },
    );
  }
  throw failure instanceof Error ? failure : new Error(errorMessage(failure));
}

async function commitStagedNoClobber(
  temporary: string,
  target: string,
  content: string,
): Promise<void> {
  try {
    // Preferred path: an atomic create-if-absent directory entry that exposes
    // the already-complete staged inode.
    await fs.link(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !HARD_LINK_FALLBACK_CODES.has(code)) throw error;
    await writeExclusiveFallback(target, content);
  }
}

async function commitArtifacts(
  targets: ReadonlyArray<readonly [string, string]>,
  overwrite: boolean,
  reclaimable: ReadonlySet<string> = new Set(),
): Promise<void> {
  const transactionId = `${process.pid}-${randomUUID()}`;
  const staged: Array<{
    target: string;
    temporary: string;
    content: string;
    /** Replace an occupied destination instead of refusing it. */
    replace: boolean;
    backup?: string;
    committed: boolean;
  }> = [];
  try {
    for (const [target, content] of targets) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const replace = overwrite || reclaimable.has(artifactPathKey(target));
      if (!replace && await pathExists(target)) {
        throw outputConflict(`Output already exists: ${target}. ${OUTPUT_CONFLICT_HINT}`);
      }
      const temporary = `${target}.${transactionId}.tmp`;
      await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      staged.push({ target, temporary, content, replace, committed: false });
    }

    for (const entry of staged) {
      if (entry.replace && await pathExists(entry.target)) {
        if ((await fs.lstat(entry.target)).isDirectory()) {
          throw outputConflict(`Output artifact path is occupied by a directory: ${entry.target}`);
        }
        entry.backup = `${entry.target}.${transactionId}.bak`;
        await fs.rename(entry.target, entry.backup);
      } else if (!entry.replace && await pathExists(entry.target)) {
        throw outputConflict(`Output already exists: ${entry.target}. ${OUTPUT_CONFLICT_HINT}`);
      }
      if (entry.replace) {
        await fs.rename(entry.temporary, entry.target);
      } else {
        await commitStagedNoClobber(entry.temporary, entry.target, entry.content);
      }
      entry.committed = true;
      if (!entry.replace) await fs.rm(entry.temporary, { force: true });
    }
    await Promise.all(staged.map(async (entry) => {
      if (entry.backup) await fs.rm(entry.backup, { force: true }).catch(() => undefined);
    }));
  } catch (error) {
    const rollbackFailures: string[] = [];
    const attemptRollback = async (operation: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        rollbackFailures.push(`${operation}: ${message}`);
      }
    };
    for (const entry of [...staged].reverse()) {
      if (entry.committed) {
        await attemptRollback(`remove committed ${entry.target}`, () => fs.rm(entry.target, { force: true }));
      }
      if (entry.backup) {
        await attemptRollback(`restore backup ${entry.target}`, () => fs.rename(entry.backup!, entry.target));
      }
      await attemptRollback(`remove staged ${entry.temporary}`, () => fs.rm(entry.temporary, { force: true }));
    }
    if (rollbackFailures.length > 0) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${originalMessage}; artifact rollback also failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Commit one complete text file safely. Overwrite uses an atomic replacement.
 * No-overwrite prefers an atomic hard-link commit and falls back to a portable
 * exclusive write on filesystems that do not support hard links.
 */
export async function writeTextFileAtomically(
  target: string,
  content: string,
  overwrite: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    if (overwrite) {
      await fs.rename(temporary, target);
    } else {
      await commitStagedNoClobber(temporary, target, content);
      // The target is now complete, either through the staged inode or the
      // exclusive-write fallback. Failure to remove the staging name must not
      // turn a valid committed output into a false extraction failure.
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    try {
      await fs.rm(temporary, { force: true });
    } catch (cleanupError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        `${originalMessage}; staged-file cleanup also failed: ${cleanupMessage}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function writeArtifacts(
  input: ResolvedInput,
  artifacts: OcrArtifacts,
  options: ResolvedCliOptions,
  totalInputs: number,
  /** Stale artifact paths this input's manifest entry recorded (see {@link ArtifactAvailabilityOptions}). */
  reclaimable?: ReadonlySet<string>,
): Promise<ArtifactTarget[]> {
  const entries = artifactEntries(artifacts, options.format);
  const targets = await resolveArtifactTargets(
    input,
    entries.map(([extension]) => extension),
    options,
    totalInputs,
  );
  await commitArtifacts(
    targets.map((target, index) => [target.path, entries[index][1]] as const),
    options.overwrite,
    reclaimable,
  );
  return targets;
}

/**
 * Manifest key for a document that has no path on disk — piped stdin bytes and
 * URL sets. Every other key is an absolute path, which is what lets `status`
 * tell a moved source from one that never existed as a file.
 */
export const STDIN_MANIFEST_KEY = '<stdin>';

export class ManifestStore {
  private readonly manifestPath: string;
  private manifest: CliManifest = { ...EMPTY_MANIFEST, entries: {} };
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(outputDirectory: string) {
    this.manifestPath = path.join(outputDirectory, '.open-ocr-manifest.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf8');
      this.manifest = parseCliManifest(JSON.parse(raw) as unknown, this.manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof SyntaxError) {
        throw batchMetadataError(`Invalid JSON in ${this.manifestPath}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * The entry a resume may skip: same input, same output-affecting options, and
   * a run that actually finished.
   *
   * `partial` is deliberately not resumable. A partial document produced less
   * than the extraction asked for — an agentic run that stopped on its iteration
   * ceiling, say — so skipping it strands the shortfall permanently, and the
   * rerun then reports the batch as fully succeeded because the skip is counted
   * as `resumed`. Re-extracting is the only outcome that can improve it.
   */
  async completedEntry(key: string, fingerprint: string): Promise<ManifestEntry | undefined> {
    const entry = this.manifest.entries[key];
    if (
      !entry
      || entry.status !== 'succeeded'
      || entry.fingerprint !== fingerprint
    ) return undefined;
    if (!(await Promise.all(entry.outputFiles.map(artifactFileExists))).every(Boolean)) return undefined;
    return { ...entry, outputFiles: [...entry.outputFiles] };
  }

  /**
   * Artifact paths this manifest already attributes to `key`, whatever the
   * recorded fingerprint or status. A resume owns these destinations: they are
   * this input's own output from an earlier attempt, so re-extracting the input
   * may replace them.
   */
  recordedArtifactPaths(key: string): ReadonlySet<string> {
    return new Set((this.manifest.entries[key]?.outputFiles ?? []).map(artifactPathKey));
  }

  update(key: string, entry: ManifestEntry): Promise<void> {
    this.manifest.entries[key] = entry;
    this.pendingWrite = this.pendingWrite.then(async () => {
      await writeTextFileAtomically(
        this.manifestPath,
        `${JSON.stringify(this.manifest, null, 2)}\n`,
        true,
      );
    });
    return this.pendingWrite;
  }
}

/**
 * Exclusive ownership of a batch output directory. The lock prevents separate
 * CLI processes from racing manifest read-modify-write cycles and losing resume
 * entries after provider work has already been paid for.
 */
export class BatchOutputLock {
  private constructor(
    readonly lockPath: string,
    private readonly owner: BatchLockOwner,
  ) {}

  static async acquire(
    outputDirectory: string,
    options: BatchLockAcquireOptions = {},
  ): Promise<BatchOutputLock> {
    await fs.mkdir(outputDirectory, { recursive: true });
    const lockPath = path.join(outputDirectory, '.open-ocr.lock');
    const owner: BatchLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };
    try {
      await writeTextFileAtomically(lockPath, `${JSON.stringify(owner, null, 2)}\n`, false);
      return new BatchOutputLock(lockPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existingOwner: BatchLockOwner | undefined;
      try {
        existingOwner = parseBatchLockOwner(JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown);
      } catch {
        // Invalid owner data is handled below without guessing that it is stale.
      }
      const ownership = existingOwner
        ? `PID ${existingOwner.pid} on ${existingOwner.hostname}, started ${existingOwner.startedAt}`
        : 'owner details unavailable';

      if (options.forceUnlock) {
        if (!existingOwner) {
          throw outputConflict(
            `Cannot force-unlock ${lockPath}: owner metadata is invalid. Remove it manually only after verifying no batch is running.`,
            error,
          );
        }
        const localHostname = hostname();
        if (existingOwner.hostname !== localHostname) {
          throw outputConflict(
            `Cannot force-unlock ${lockPath}: it belongs to host ${existingOwner.hostname}, not ${localHostname}.`,
            error,
          );
        }
        if (processIsAlive(existingOwner.pid)) {
          throw outputConflict(
            `Cannot force-unlock ${lockPath}: owner PID ${existingOwner.pid} is still running on ${localHostname}.`,
            error,
          );
        }

        const currentOwner = parseBatchLockOwner(
          JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown,
        );
        if (currentOwner?.token !== existingOwner.token) {
          throw outputConflict(`Cannot force-unlock ${lockPath}: lock ownership changed during recovery.`);
        }
        await fs.rm(lockPath);
        options.onWarning?.(
          `Removed stale batch lock for dead PID ${existingOwner.pid} on ${localHostname}: ${lockPath}`,
        );
        return BatchOutputLock.acquire(outputDirectory, { onWarning: options.onWarning });
      }
      throw outputConflict(
        `Batch output directory is already in use (${ownership}): ${outputDirectory}. `
        + 'If that same-host process is no longer running, retry with --force-unlock. '
        + `Review ${lockPath} manually for cross-host or invalid lock metadata.`,
        error,
      );
    }
  }

  async release(): Promise<void> {
    let current: Partial<BatchLockOwner>;
    try {
      current = JSON.parse(await fs.readFile(this.lockPath, 'utf8')) as Partial<BatchLockOwner>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (current.token !== this.owner.token) {
      throw outputConflict(`Batch lock ownership changed unexpectedly; refusing to remove ${this.lockPath}`);
    }
    await fs.rm(this.lockPath);
  }
}

export async function writeBatchSummary(summary: BatchSummary, outputDirectory: string): Promise<string> {
  const target = path.join(outputDirectory, 'batch-summary.json');
  await writeTextFileAtomically(target, `${JSON.stringify(summary, null, 2)}\n`, true);
  return target;
}
