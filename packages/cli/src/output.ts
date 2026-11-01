import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import type { ProviderUsageSnapshot } from '@open-ocr/engine/providers';
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

const OUTPUT_CONFLICT_HINT = 'Choose a new output path, pass --overwrite to replace the existing file(s), '
  + 'or rerun the job that wrote them to resume it.';

/** `--no-resume` turns ownership off, so "resume a matching job" cannot be the remedy. */
const RESUME_DISABLED_CONFLICT_HINT = 'This run has resume disabled, so existing artifacts are never reused or replaced. '
  + 'Drop --no-resume to resume the job that wrote them, pass --overwrite to re-extract and replace them, '
  + 'or choose a new --output directory.';

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
  onWarning?: (message: string) => void;
}

/**
 * A stable identity for one process lifetime, so a lock whose PID has since
 * been reused by an unrelated process is recognised as stale instead of
 * looking in use forever. Undefined where the platform gives no way to read it.
 */
export function processStartIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 (starttime) counted after the parenthesised command name,
      // which may itself contain spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const startTicks = fields[19];
      if (!startTicks || !/^\d+$/u.test(startTicks)) return undefined;
      let bootId = '';
      try {
        bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      } catch {
        // Containers may hide boot_id; start ticks alone still separate PIDs.
      }
      return `linux:${bootId}:${startTicks}`;
    }
    if (process.platform === 'win32') return undefined;
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return started ? `ps:${started}` : undefined;
  } catch {
    return undefined;
  }
}

let ownProcessStart: string | undefined | null = null;
function currentProcessStartIdentity(): string | undefined {
  if (ownProcessStart === null) ownProcessStart = processStartIdentity(process.pid);
  return ownProcessStart;
}

/**
 * What a lock owner record means from this host:
 * - `live`: the owning process is running (or cannot be told apart from it).
 * - `stale`: the owner is provably gone, or its PID now belongs to another process.
 * - `unverifiable`: a different host owns it; only an operator can check.
 */
export type BatchLockState = 'live' | 'stale' | 'unverifiable';

export function batchLockOwnerState(owner: BatchLockOwner): BatchLockState {
  if (owner.hostname !== hostname()) return 'unverifiable';
  if (!processIsAlive(owner.pid)) return 'stale';
  if (owner.processStart !== undefined) {
    const current = processStartIdentity(owner.pid);
    if (current !== undefined && current !== owner.processStart) return 'stale';
  }
  return 'live';
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

/**
 * A CSV was requested but this extraction has no table to render: a table
 * preset without declared columns whose model returned no rows. It is the
 * output contract that could not be met, not a provider failure, and the
 * extracted fields are still in the JSON and Markdown artifacts.
 */
function csvUnavailable(): CliExitError {
  return new CliExitError('This extraction returned no table rows and the preset declares no columns, so no CSV could be produced', 1, {
    code: 'OUTPUT_INVALID',
    category: 'output',
    retryable: false,
    hint: 'Request --format json or markdown (or all) to keep the extracted fields, or check that the document contains a table.',
  });
}

export function primaryArtifact(artifacts: OcrArtifacts, format: ResolvedCliOptions['format']): string {
  if (format === 'json') {
    if (artifacts.json === undefined) throw new Error('This extraction did not produce JSON output');
    return `${JSON.stringify(artifacts.json, null, 2)}\n`;
  }
  if (format === 'csv') {
    if (!artifacts.csv) throw csvUnavailable();
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
  if (format === 'csv' && !artifacts.csv) throw csvUnavailable();
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
  /** The caller turned resume off (`--no-resume`), which changes the guidance again. */
  resumeDisabled?: boolean;
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
  const hint = availability.resumeDisabled ? RESUME_DISABLED_CONFLICT_HINT : OUTPUT_CONFLICT_HINT;
  throw outputConflict(
    `Output already exists before extraction: ${existing.join(', ')}. ${hint}`,
    undefined,
    hint,
  );
}

/** Every destination this input could write, including optional artifacts. */
export async function possibleArtifactTargets(
  input: ResolvedInput,
  options: ResolvedCliOptions,
  totalInputs: number,
): Promise<ArtifactTarget[]> {
  const writesFiles = totalInputs > 1 || Boolean(options.output) || options.format === 'all';
  if (!writesFiles) return [];
  return resolveArtifactTargets(input, possibleArtifactExtensions(options), options, totalInputs);
}

/** Staging and backup names written by {@link commitArtifacts} and {@link writeTextFileAtomically}. */
const TRANSACTION_SUFFIX = /\.(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(tmp|bak)$/u;

export interface StaleTransactionFile {
  path: string;
  /** The artifact or metadata file the staged/backup copy belongs to. */
  target: string;
  kind: 'tmp' | 'bak';
  pid: number;
}

/** Find staging/backup leftovers of the given targets (no changes made). */
export async function findStaleTransactionFiles(
  targets: Iterable<string>,
): Promise<StaleTransactionFile[]> {
  const byDirectory = new Map<string, Set<string>>();
  for (const target of targets) {
    const resolved = path.resolve(target);
    const directory = path.dirname(resolved);
    byDirectory.set(directory, (byDirectory.get(directory) ?? new Set()).add(path.basename(resolved)));
  }
  const found: StaleTransactionFile[] = [];
  await Promise.all([...byDirectory].map(async ([directory, names]) => {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const match = TRANSACTION_SUFFIX.exec(entry);
      if (!match) continue;
      const base = entry.slice(0, match.index);
      if (!names.has(base)) continue;
      found.push({
        path: path.join(directory, entry),
        target: path.join(directory, base),
        kind: match[2] as 'tmp' | 'bak',
        pid: Number(match[1]),
      });
    }
  }));
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** Any staging/backup file name, for a directory-wide status scan. */
export function isTransactionFileName(name: string): boolean {
  return TRANSACTION_SUFFIX.test(name);
}

/**
 * Remove leftovers of a killed artifact or manifest transaction. Must run only
 * while holding the batch lock, so no live writer of this directory can own
 * them. A `.bak` is the previous artifact moved aside mid-commit: it is put
 * back when its target is missing, otherwise discarded. Files whose embedded
 * PID belongs to another live process are left alone.
 */
export async function recoverStaleTransactionFiles(
  targets: Iterable<string>,
): Promise<{ removed: string[]; restored: string[] }> {
  const removed: string[] = [];
  const restored: string[] = [];
  for (const file of await findStaleTransactionFiles(targets)) {
    if (file.pid !== process.pid && processIsAlive(file.pid)) continue;
    if (file.kind === 'bak' && !(await pathExists(file.target))) {
      await fs.rename(file.path, file.target);
      restored.push(file.target);
      continue;
    }
    await fs.rm(file.path, { force: true });
    removed.push(file.path);
  }
  return { removed, restored };
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

export interface ManifestFingerprints {
  /** Content-hash (v2) fingerprint of the input as it is now. */
  current: string;
  /** Legacy path/size/mtime fingerprint, accepted only for entries without a version. */
  legacy?: string;
}

export class ManifestStore {
  private readonly manifestPath: string;
  private manifest: CliManifest = { ...EMPTY_MANIFEST, entries: {} };
  private pendingWrite: Promise<void> = Promise.resolve();
  private usageSource: (() => ProviderUsageSnapshot | undefined) | undefined;

  constructor(outputDirectory: string) {
    this.manifestPath = path.join(outputDirectory, '.open-ocr-manifest.json');
  }

  get path(): string {
    return this.manifestPath;
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

  /** Cumulative usage recorded by earlier runs, as loaded. */
  recordedUsage(): ProviderUsageSnapshot | undefined {
    return this.manifest.usage ? { ...this.manifest.usage } : undefined;
  }

  /**
   * Supply the cumulative usage persisted with every manifest write, so a
   * killed run still leaves its spend on record for the next `--max-cost` check.
   */
  setUsageSource(source: () => ProviderUsageSnapshot | undefined): void {
    this.usageSource = source;
  }

  entry(key: string): ManifestEntry | undefined {
    const entry = this.manifest.entries[key];
    return entry ? { ...entry, outputFiles: [...entry.outputFiles] } : undefined;
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
   *
   * `pending` is an interrupted attempt and is never skipped either.
   */
  async completedEntry(
    key: string,
    fingerprints: string | ManifestFingerprints,
  ): Promise<(ManifestEntry & { legacyFingerprint?: true }) | undefined> {
    const { current, legacy } = typeof fingerprints === 'string'
      ? { current: fingerprints, legacy: undefined }
      : fingerprints;
    const entry = this.manifest.entries[key];
    if (!entry || entry.status !== 'succeeded') return undefined;
    const matchesCurrent = entry.fingerprint === current;
    const matchesLegacy = !matchesCurrent
      && legacy !== undefined
      && entry.fingerprintVersion === undefined
      && entry.fingerprint === legacy;
    if (!matchesCurrent && !matchesLegacy) return undefined;
    if (!(await Promise.all(entry.outputFiles.map(artifactFileExists))).every(Boolean)) return undefined;
    return {
      ...entry,
      outputFiles: [...entry.outputFiles],
      ...(matchesLegacy ? { legacyFingerprint: true as const } : {}),
    };
  }

  /**
   * Artifact paths this manifest already attributes to `key`, whatever the
   * recorded fingerprint or status: the current outputs plus every path the
   * entry ever wrote or claimed (earlier formats, interrupted attempts). A
   * resume owns these destinations, so re-extracting the input may replace them.
   */
  recordedArtifactPaths(key: string): ReadonlySet<string> {
    const entry = this.manifest.entries[key];
    return new Set([...(entry?.outputFiles ?? []), ...(entry?.ownedFiles ?? [])].map(artifactPathKey));
  }

  /** Every artifact path any entry owns, for leftover cleanup and `status`. */
  allOwnedArtifactPaths(): Set<string> {
    const owned = new Set<string>();
    for (const key of Object.keys(this.manifest.entries)) {
      for (const file of this.recordedArtifactPaths(key)) owned.add(file);
    }
    return owned;
  }

  /**
   * Replace one entry and persist the whole manifest atomically (staged file,
   * then rename). Ownership only grows: paths the entry recorded before stay
   * in `ownedFiles`, so a later format switch still recognises them.
   */
  update(key: string, entry: ManifestEntry): Promise<void> {
    const previous = this.manifest.entries[key];
    const owned = [...new Set([
      ...(previous?.ownedFiles ?? []),
      ...(previous?.outputFiles ?? []),
      ...(entry.ownedFiles ?? []),
      ...entry.outputFiles,
    ].map(artifactPathKey))];
    this.manifest.entries[key] = {
      ...entry,
      ...(owned.length > 0 ? { ownedFiles: owned } : {}),
    };
    return this.write();
  }

  /** Persist the manifest (and the current cumulative usage) without changing entries. */
  flush(): Promise<void> {
    return this.write();
  }

  private write(): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(async () => {
      const usage = this.usageSource?.();
      if (usage) this.manifest.usage = usage;
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
const MAX_LOCK_ACQUIRE_ATTEMPTS = 8;

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
    const processStart = currentProcessStartIdentity();
    const owner: BatchLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      ...(processStart ? { processStart } : {}),
    };
    const manualRecovery = `Verify no batch is writing to ${outputDirectory}, then delete ${lockPath}.`;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        await writeTextFileAtomically(lockPath, `${JSON.stringify(owner, null, 2)}\n`, false);
        return new BatchOutputLock(lockPath, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        lastError = error;
      }
      let existingOwner: BatchLockOwner | undefined;
      try {
        existingOwner = parseBatchLockOwner(JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown);
      } catch (readError) {
        // The owner released it between our write and this read: try again.
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Invalid owner data is handled below without guessing that it is stale.
      }
      if (!existingOwner) {
        throw outputConflict(
          `Batch output directory is locked and its owner metadata is invalid: ${lockPath}`,
          lastError,
          manualRecovery,
        );
      }
      const state = batchLockOwnerState(existingOwner);
      if (state === 'unverifiable') {
        throw outputConflict(
          `Batch output directory is locked by PID ${existingOwner.pid} on host ${existingOwner.hostname} `
          + `(started ${existingOwner.startedAt}), which cannot be checked from ${hostname()}: ${outputDirectory}`,
          lastError,
          manualRecovery,
        );
      }
      if (state === 'live') {
        throw outputConflict(
          `Batch output directory is in use by running PID ${existingOwner.pid} `
          + `(started ${existingOwner.startedAt}): ${outputDirectory}`,
          lastError,
          'Wait for that batch to finish, or write to a different output directory.',
        );
      }

      // A same-host owner that is provably dead (killed, crashed, a second
      // Ctrl-C, or its PID now belongs to another process) cannot release its
      // own lock. Reclaiming it is exactly the check an operator would make.
      //
      // Check-then-delete is not atomic: a second recovering process could
      // delete the fresh lock the first one just created. Instead move the lock
      // aside under a unique name (atomic), then confirm the moved file is the
      // stale owner's. If it is not, someone else already reclaimed it, so put
      // their lock back and report the conflict.
      const aside = `${lockPath}.${process.pid}-${randomUUID()}.tmp`;
      try {
        await fs.rename(lockPath, aside);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw renameError;
      }
      let movedOwner: BatchLockOwner | undefined;
      try {
        movedOwner = parseBatchLockOwner(JSON.parse(await fs.readFile(aside, 'utf8')) as unknown);
      } catch {
        movedOwner = undefined;
      }
      if (movedOwner?.token !== existingOwner.token) {
        try {
          await fs.link(aside, lockPath);
        } catch {
          // A third process took the path meanwhile; their lock stands.
        }
        await fs.rm(aside, { force: true });
        throw outputConflict(
          `Batch lock ownership changed during stale-lock recovery: ${lockPath}`,
          lastError,
          'Another process reclaimed the stale lock first; wait for it to finish, or write to a different output directory.',
        );
      }
      await fs.rm(aside, { force: true });
      options.onWarning?.(
        `Removed stale batch lock left by ${processIsAlive(existingOwner.pid) ? 'reused' : 'dead'} PID `
        + `${existingOwner.pid} on ${hostname()}: ${lockPath}`,
      );
    }
    throw outputConflict(
      `Could not acquire the batch lock after ${MAX_LOCK_ACQUIRE_ATTEMPTS} attempts; another process keeps taking it: ${lockPath}`,
      lastError,
      'Wait for the other batch to finish, or write to a different output directory.',
    );
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
