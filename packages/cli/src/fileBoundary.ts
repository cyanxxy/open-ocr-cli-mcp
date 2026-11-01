import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { CliExitError } from './errors';

/**
 * File access helpers shared by the configuration, schema, and request readers,
 * plus the path boundary the MCP server enforces on its (untrusted) caller.
 */

/**
 * Where a JSON syntax error occurred, without any of the text around it.
 *
 * V8's messages quote the offending input (`Unexpected token 'r', "root:x:0:0"...
 * is not valid JSON`), so echoing them turns "parse this file" into "show me
 * the first bytes of this file". Only the position survives.
 */
export function jsonSyntaxLocation(error: SyntaxError): string {
  const position = /\bat position \d+(?: \(line \d+ column \d+\))?/u.exec(error.message)?.[0];
  if (position) return ` (${position})`;
  if (/\bunexpected end of JSON input\b/iu.test(error.message)) return ' (unexpected end of input)';
  return '';
}

/** An errno-style error, so callers can map it with their existing tables. */
function fileTypeError(code: 'EISDIR' | 'ENOTREG', displayPath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    code === 'EISDIR' ? `${displayPath} is a directory` : `${displayPath} is not a regular file`,
  );
  error.code = code;
  return error;
}

// Absent on Windows, where FIFOs cannot be opened this way in the first place.
const O_NONBLOCK: number = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;

/**
 * Open a file for reading only if it is a regular file.
 *
 * Opened non-blocking and checked through the same handle: a plain open of a
 * FIFO blocks until a writer appears (hanging an MCP server indefinitely), and
 * a device such as `/dev/zero` never reaches end of file. `O_NONBLOCK` has no
 * effect on a regular file's reads.
 */
export async function openRegularFile(absolutePath: string, displayPath = absolutePath): Promise<FileHandle> {
  const handle = await open(absolutePath, constants.O_RDONLY | O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (metadata.isDirectory()) throw fileTypeError('EISDIR', displayPath);
    if (!metadata.isFile()) throw fileTypeError('ENOTREG', displayPath);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Resolve symbolic links in the longest existing prefix of a path that may not exist yet. */
export async function realpathOfNearestAncestor(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `relative` (from `path.relative`) leaves the directory it was measured from. */
export function escapesRoot(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** The tool's own default output root, the one hidden directory an MCP caller may write into. */
export const MCP_DEFAULT_OUTPUT_ROOT = '.open-ocr-results';

export type CallerPathKind = 'input' | 'configPath' | 'schemaPath' | 'outputDirectory' | 'output';

const CALLER_PATH_LABELS: Record<CallerPathKind, string> = {
  input: 'Input',
  configPath: 'configPath',
  schemaPath: 'schemaPath',
  outputDirectory: 'outputDirectory',
  output: 'configPath "output"',
};

export function callerBoundaryError(kind: CallerPathKind, message: string, cwd: string): CliExitError {
  const input = kind === 'input';
  return new CliExitError(message, 2, {
    code: input ? 'INPUT_INVALID' : 'CONFIG_INVALID',
    category: input ? 'input' : 'configuration',
    retryable: false,
    hint: `Over MCP, every path must stay inside the server working directory (${cwd}), with symbolic links resolved`
      + (kind === 'outputDirectory' || kind === 'output'
        ? `, and output may not go into a hidden directory other than ${MCP_DEFAULT_OUTPUT_ROOT}. `
        : '. ')
      + 'Move the files into that directory, or ask the operator to start the server where they are.',
  });
}

/**
 * Confine a path an MCP caller supplied to the server working directory.
 *
 * The check is made on the real path of the nearest existing ancestor, so a
 * symbolic link inside the working directory cannot point the read or write
 * elsewhere, and a path that does not exist yet is judged by where it would
 * land. A path that leaves the directory is refused whether or not it exists,
 * so the answer is not an existence oracle for files outside.
 *
 * Writes are additionally kept out of hidden directories (`.git`, `.claude`,
 * `.config`, ...) other than the tool's own `.open-ocr-results`: those hold
 * repository hooks and agent instructions that a document-controlled write
 * must never reach.
 *
 * Returns the lexical absolute path, unchanged, so reported paths keep the
 * spelling the caller used.
 */
export async function confineCallerPath(
  cwd: string,
  value: string,
  kind: CallerPathKind,
  use: 'read' | 'write' = 'read',
): Promise<string> {
  const label = CALLER_PATH_LABELS[kind];
  const absolute = path.resolve(cwd, value);
  const root = await realpath(cwd);
  let resolved: string;
  try {
    resolved = await realpathOfNearestAncestor(absolute);
  } catch (error) {
    // ENOTDIR and friends: a component is not a directory. Judge the lexical
    // path; whatever reads or writes it next reports the real problem.
    if ((error as NodeJS.ErrnoException).code === undefined) throw error;
    resolved = path.resolve(root, path.relative(cwd, absolute));
  }
  const relative = path.relative(root, resolved);
  if (escapesRoot(relative)) {
    throw callerBoundaryError(kind, `${label} resolves outside the MCP server working directory: ${value}`, cwd);
  }
  if (use === 'write') {
    const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
    const hidden = segments.find((segment, index) => (
      segment.startsWith('.') && !(index === 0 && segment === MCP_DEFAULT_OUTPUT_ROOT)
    ));
    if (hidden !== undefined) {
      throw callerBoundaryError(
        kind,
        `${label} may not write inside the hidden directory ${hidden}: ${value}`,
        cwd,
      );
    }
  }
  return absolute;
}

/** Longest glob pattern an MCP caller may send. */
export const MCP_MAX_PATTERN_LENGTH = 1024;
/** Most brace groups in one MCP glob pattern; each multiplies the expansion. */
export const MCP_MAX_PATTERN_BRACES = 8;

/**
 * Refuse a caller glob that could only leave the working directory, or whose
 * expansion is unreasonably large. The matched files are realpath-checked
 * afterwards as well; this stops the walk from starting outside at all.
 */
export function assertCallerPatternBounded(cwd: string, pattern: string, kind: 'input' | 'exclude'): void {
  const label = kind === 'input' ? 'Input pattern' : 'Exclude pattern';
  if (pattern.length > MCP_MAX_PATTERN_LENGTH) {
    throw callerBoundaryError('input', `${label} exceeds ${MCP_MAX_PATTERN_LENGTH} characters`, cwd);
  }
  if ((pattern.match(/\{/gu) ?? []).length > MCP_MAX_PATTERN_BRACES) {
    throw callerBoundaryError('input', `${label} has more than ${MCP_MAX_PATTERN_BRACES} brace groups`, cwd);
  }
  if (kind === 'exclude') return;
  if (path.isAbsolute(pattern) || /^[A-Za-z]:/u.test(pattern) || pattern.startsWith('~')) {
    throw callerBoundaryError('input', `${label} must be relative to the MCP server working directory: ${pattern}`, cwd);
  }
  // `..` as a whole segment, including inside a brace list (`{..,a}/x`).
  if (/(?:^|[\\/{,])\.\.(?:$|[\\/},])/u.test(pattern)) {
    throw callerBoundaryError('input', `${label} may not contain ".." segments: ${pattern}`, cwd);
  }
}

/** Glob syntax, as discovery reads it (see `isGlobPattern` in inputs.ts). */
export const GLOB_SYNTAX = /[*?{}[\]()!]/u;

/**
 * The part of an absolute pattern below `directory`, or `undefined` when the
 * pattern does not start with it.
 */
function patternBelowDirectory(directory: string, pattern: string): string | undefined {
  const spellings = new Set([directory, directory.split(path.sep).join('/')]);
  for (const spelling of spellings) {
    for (const separator of new Set([path.sep, '/'])) {
      const prefix = spelling.endsWith(separator) ? spelling : `${spelling}${separator}`;
      if (pattern.startsWith(prefix) && pattern.length > prefix.length) return pattern.slice(prefix.length);
    }
  }
  return undefined;
}

/**
 * Bound and confine a glob an MCP caller sent as an input, and return the
 * pattern discovery should expand.
 *
 * A relative pattern is checked by {@link assertCallerPatternBounded}. An
 * absolute one that starts with the working directory (as spelled, or as its
 * real path) is handed to discovery relative to it. Stripping the directory,
 * instead of escaping it into the pattern, is what lets a working directory
 * such as `Project (2024)`, `scans[old]` or `{draft}` hold globs at all:
 * discovery matches a relative pattern against `cwd` as a literal path, while
 * an escaped absolute prefix would rely on the glob library escaping every
 * metacharacter (its `escape` leaves braces alone) the same way everywhere.
 *
 * Any other absolute pattern is accepted only when the literal directory
 * before its first glob character resolves, symbolic links followed, inside
 * the working directory; that prefix holds no glob syntax by construction, so
 * the pattern is used as sent. Matches are realpath-checked again after
 * discovery either way.
 */
export async function confineCallerPattern(cwd: string, pattern: string): Promise<string> {
  if (!path.isAbsolute(pattern)) {
    assertCallerPatternBounded(cwd, pattern, 'input');
    return pattern;
  }
  const root = await realpath(cwd);
  for (const directory of new Set([path.resolve(cwd), root])) {
    const relative = patternBelowDirectory(directory, pattern);
    if (relative !== undefined) {
      assertCallerPatternBounded(cwd, relative, 'input');
      return relative;
    }
  }
  // The same length, brace, and `..` limits as a relative pattern; only the
  // "must be relative" rule is lifted, by checking the pattern below its root.
  assertCallerPatternBounded(cwd, pattern.replace(/^(?:[A-Za-z]:)?[\\/]+/u, ''), 'input');
  const literal = pattern.slice(0, pattern.search(GLOB_SYNTAX));
  const literalDirectory = /[\\/]$/u.test(literal) ? literal : path.dirname(literal);
  let resolved: string;
  try {
    resolved = await realpathOfNearestAncestor(literalDirectory);
  } catch {
    resolved = path.resolve(literalDirectory);
  }
  if (escapesRoot(path.relative(root, resolved))) {
    throw callerBoundaryError(
      'input',
      `Input pattern resolves outside the MCP server working directory: ${pattern}`,
      cwd,
    );
  }
  return pattern;
}
