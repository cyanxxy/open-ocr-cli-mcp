import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Readable } from 'node:stream';

import { globIterate, Ignore, type IgnoreLike } from 'glob';

import { EXTENSION_TO_MIME, FILE_CONSTRAINTS, maxFileSizeForMime } from '@open-ocr/engine/constants';
import { CliExitError, type OcrErrorCode } from './errors';
import type { ResolvedCliOptions, ResolvedInput } from './types';

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(EXTENSION_TO_MIME));

/**
 * Directories a recursive scan does not descend into by default.
 *
 * These hold dependencies and build output, so "point at this folder" never
 * means them — yet nothing stopped a scan from walking them, which is most of
 * the cost of scanning a repository and puts sprite sheets and favicons in the
 * extraction results. Kept deliberately short: every name here can drop a
 * document someone wanted, so additions are cheap to make and expensive to be
 * wrong about.
 *
 * Applies to directory scans only. An explicit file or glob is the caller's own
 * intent and is never filtered. Overridable with `--no-default-excludes` or
 * `"defaultExcludes": false`.
 */
const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'vendor',
  'target',
]);

// Prune excluded children while retaining the directory entry for skip reports.
// Explicitly naming an excluded directory still scans that directory itself.
function discoveryIgnore(options: ResolvedCliOptions, applyDefaults: boolean): IgnoreLike {
  const patterns = new Ignore(options.excludes, {});
  return {
    ignored: (entry) => entry.isSymbolicLink() || patterns.ignored(entry),
    childrenIgnored: (entry) => entry.isSymbolicLink()
      || patterns.childrenIgnored(entry)
      || (applyDefaults && entry.relative() !== '' && DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)),
  };
}

/**
 * Whether a scanned path lives under a default-excluded directory.
 *
 * Resolved against the scan root, so pointing straight at `./dist` still scans
 * it: only directories *found during* the walk are excluded, never the folder
 * the caller named.
 */
function hasDefaultExcludedAncestor(root: string, absolutePath: string): boolean {
  const segments = path.relative(root, absolutePath).split(/[\\/]/u);
  segments.pop();
  return segments.some((segment) => DEFAULT_EXCLUDED_DIRECTORIES.has(segment));
}

/**
 * Dropped paths retained for reporting. A scan may pass over a whole dependency
 * or build tree, so the report is a count plus a bounded sample of names rather
 * than the full list.
 */
const MAX_REPORTED_SKIP_NAMES = 3;

/**
 * Files a recursive directory scan dropped before they could become documents.
 * Discovery is deliberately permissive — pointing at a folder must keep working
 * — but every dropped entry stays reportable so a scan never silently shrinks.
 */
export interface InputDiscoverySkips {
  unsupported: {
    /**
     * How many directory entries were dropped for having a non-document
     * extension. Entries are counted per scan, so overlapping directory inputs
     * can count one file once per scan that reaches it.
     */
    count: number;
    /**
     * Lexicographically first dropped display paths, at most
     * {@link MAX_REPORTED_SKIP_NAMES}. Sampled by name rather than by traversal
     * order so the report does not depend on the filesystem.
     */
    names: string[];
  };
  /**
   * Directories pruned by {@link DEFAULT_EXCLUDED_DIRECTORIES}.
   *
   * Reported separately from `unsupported` because the cause and the remedy
   * differ: these were dropped by policy, not by file type, and a caller who
   * wanted them needs `--no-default-excludes` rather than a different document.
   * Counted as directories, not files — the whole point of the exclude is that
   * the subtree is never walked, so the files inside were never enumerated.
   */
  defaultExcluded: {
    count: number;
    names: string[];
  };
}

export interface InputDiscovery {
  inputs: ResolvedInput[];
  skipped: InputDiscoverySkips;
}

interface ExpandedInput {
  files: string[];
  unsupportedCount: number;
  /** Absolute paths, already reduced to the bounded reporting sample. */
  unsupportedSample: string[];
  defaultExcludedCount: number;
  defaultExcludedSample: string[];
}

/** Skip counters for an expansion that cannot drop anything: a named file or a caller's own glob. */
function noExpansionSkips(): Omit<ExpandedInput, 'files'> {
  return {
    unsupportedCount: 0,
    unsupportedSample: [],
    defaultExcludedCount: 0,
    defaultExcludedSample: [],
  };
}

function inputError(message: string, code: OcrErrorCode = 'INPUT_INVALID'): CliExitError {
  return new CliExitError(message, 2, {
    code,
    category: 'input',
    retryable: false,
    hint: code === 'INPUT_NOT_FOUND'
      ? 'Check the input path and working directory.'
      : 'Use a supported, non-empty image or PDF within the documented limits.',
  });
}

export function detectMimeType(
  filePath: string,
  explicitMime?: string,
  bytes?: Uint8Array,
): string {
  if (explicitMime) {
    const supported = [
      ...FILE_CONSTRAINTS.SUPPORTED_IMAGE_MIME_TYPES,
      ...FILE_CONSTRAINTS.SUPPORTED_DOCUMENT_MIME_TYPES,
    ];
    if (!supported.includes(explicitMime as never)) throw inputError(`Unsupported MIME type: ${explicitMime}`);
    return explicitMime;
  }
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = EXTENSION_TO_MIME[extension];
  if (mimeType) return mimeType;
  const sniffed = bytes ? sniffDocumentMimeType(bytes.subarray(0, 256)) : undefined;
  if (sniffed) return sniffed;
  throw inputError(`Unsupported document extension: ${extension || '(none)'}`);
}

async function detectLocalMimeType(absolutePath: string): Promise<string> {
  const extension = path.extname(absolutePath).toLowerCase();
  const declared = EXTENSION_TO_MIME[extension];
  if (declared) return declared;

  // Coding agents commonly create extensionless or `.tmp` files. Sniff only
  // the bounded signature prefix for an explicitly named file; recursive
  // directory/glob discovery remains extension-filtered and predictable.
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(absolutePath, 'r');
    const prefix = Buffer.alloc(256);
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    return detectMimeType(absolutePath, undefined, prefix.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof CliExitError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw inputError(`Input no longer exists: ${absolutePath}`, 'INPUT_NOT_FOUND');
    throw inputError(
      `Could not inspect ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close();
  }
}

function isGlobPattern(value: string): boolean {
  return /[*?{}[\]()!]/.test(value);
}

/**
 * Insert one dropped path into a bounded, sorted sample.
 *
 * Retaining every dropped path just to name three of them makes pointing at a
 * repository hold its whole `node_modules` in memory, so only the sample
 * survives the walk. Keeping the lexicographically first names — rather than
 * the first ones the walk happened to reach — keeps the report reproducible.
 */
function sampleSkippedPath(sample: string[], absolutePath: string): void {
  const position = sample.findIndex((entry) => absolutePath.localeCompare(entry) < 0);
  if (position === -1) {
    if (sample.length < MAX_REPORTED_SKIP_NAMES) sample.push(absolutePath);
    return;
  }
  sample.splice(position, 0, absolutePath);
  if (sample.length > MAX_REPORTED_SKIP_NAMES) sample.length = MAX_REPORTED_SKIP_NAMES;
}

function appendDiscoveredFile(files: string[], absolutePath: string, maxFiles: number): void {
  files.push(absolutePath);
  if (files.length > maxFiles) {
    throw inputError(`Matched at least ${files.length} files, exceeding --max-files ${maxFiles}`);
  }
}

/**
 * Walk a directory once with the configured hidden/exclude pruning, partitioning
 * on extension as entries stream past rather than inside the glob.
 *
 * A glob only ever returns its matches, so filtered-out entries were never
 * materialized and could not be reported; partitioning here also makes
 * `EXTENSION_TO_MIME` the single source of truth, so a scan accepts `SCAN.PNG`
 * exactly like an explicitly named file already does. Filtering during traversal
 * keeps that reporting affordable: unsupported entries are counted and released
 * instead of accumulated and sorted.
 *
 * Directories are streamed alongside files purely so a pruned dependency or
 * build tree can be named. That is the whole reason the walk is not simply
 * `onlyFiles`.
 */
async function scanDirectory(
  absolute: string,
  options: ResolvedCliOptions,
  signal?: AbortSignal,
): Promise<ExpandedInput> {
  const applyDefaults = options.defaultExcludes;
  const entries = globIterate('**/*', {
    cwd: absolute,
    withFileTypes: true,
    dot: options.hidden,
    follow: false,
    signal,
    ignore: discoveryIgnore(options, applyDefaults),
  });
  const files: string[] = [];
  const unsupportedSample: string[] = [];
  const defaultExcludedSample: string[] = [];
  let unsupportedCount = 0;
  let defaultExcludedCount = 0;
  for await (const entry of entries) {
    signal?.throwIfAborted();
    const absolutePath = entry.fullpath();
    if (entry.isDirectory()) {
      if (applyDefaults && DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) {
        defaultExcludedCount += 1;
        sampleSkippedPath(defaultExcludedSample, absolutePath);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (applyDefaults && hasDefaultExcludedAncestor(absolute, absolutePath)) continue;
    if (SUPPORTED_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
      appendDiscoveredFile(files, absolutePath, options.maxFiles);
    }
    else {
      unsupportedCount += 1;
      sampleSkippedPath(unsupportedSample, absolutePath);
    }
  }
  return { files, unsupportedCount, unsupportedSample, defaultExcludedCount, defaultExcludedSample };
}

async function expandInput(
  value: string,
  options: ResolvedCliOptions,
  signal?: AbortSignal,
): Promise<ExpandedInput> {
  signal?.throwIfAborted();
  const absolute = path.resolve(options.cwd, value);
  let entry: Stats | undefined;
  try {
    entry = await fs.stat(absolute);
  } catch (error) {
    // Only a missing path falls through to glob expansion. Reading the stat
    // outside the walk keeps a mid-scan ENOENT from being misread as "this
    // input was a pattern all along".
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (entry?.isFile()) return { files: [absolute], ...noExpansionSkips() };
  if (entry?.isDirectory()) return scanDirectory(absolute, options, signal);
  if (entry) return { files: [], ...noExpansionSkips() };

  if (!isGlobPattern(value)) throw inputError(`Input does not exist: ${value}`, 'INPUT_NOT_FOUND');
  // An explicit pattern is the caller's own filter: unsupported matches stay in
  // the set and fail loudly by MIME detection rather than disappearing here, and
  // the default directory excludes never apply — `dist/**/*.pdf` means `dist`.
  const files: string[] = [];
  for await (const match of globIterate(value, {
    cwd: options.cwd,
    withFileTypes: true,
    nodir: true,
    dot: options.hidden,
    follow: false,
    signal,
    ignore: discoveryIgnore(options, false),
  })) {
    signal?.throwIfAborted();
    if (match.isFile()) appendDiscoveredFile(files, match.fullpath(), options.maxFiles);
  }
  return { files, ...noExpansionSkips() };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

export async function readStdin(
  maxBytes: number,
  signal?: AbortSignal,
  input: Readable = process.stdin,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  signal?.throwIfAborted();
  const onAbort = (): void => {
    input.destroy(signal ? abortReason(signal) : undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of input as AsyncIterable<Uint8Array | string>) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        throw inputError(
          `stdin exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)}MB configured input limit`,
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks, totalBytes);
}

function safeRelativePath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 8);
  const parsed = path.parse(absolutePath);
  return `${parsed.name}-${hash}${parsed.ext}`;
}

/**
 * Synthetic filename a stdin document carries when the caller did not name it.
 * Mirrors the resolved default in `config.ts`; `inputs.test.ts` pins the two
 * together so a change there cannot silently turn every stdin run into a named
 * one.
 */
export const DEFAULT_STDIN_NAME = 'stdin';

/**
 * How a stdin document reports itself in results, status lines, and errors.
 *
 * A caller that named its piped bytes gets that name back, so it can correlate
 * a result through `source` the same way a file input does — previously every
 * stdin run reported the opaque `<stdin>` while its *output file* used the
 * supplied name, leaving the two unlinkable. Unnamed input keeps `<stdin>`,
 * which says more than the placeholder filename would.
 *
 * This is the reported identity only. Manifest keys (`absolutePath ?? '<stdin>'`)
 * and resume fingerprints (which use `relativePath`) are computed elsewhere and
 * are deliberately untouched: naming a document must not silently move it to a
 * different manifest entry.
 */
export function stdinDisplayPath(stdinName: string): string {
  return stdinName === DEFAULT_STDIN_NAME ? '<stdin>' : stdinName;
}

/** Resolve every requested input, reporting what discovery dropped along the way. */
export async function discoverInputSet(
  rawInputs: string[],
  options: ResolvedCliOptions,
  signal?: AbortSignal,
): Promise<InputDiscovery> {
  signal?.throwIfAborted();
  if (rawInputs.length === 0) throw inputError('Provide at least one file, directory, glob, or - for stdin');
  if (rawInputs.includes('-') && rawInputs.length !== 1) throw inputError('stdin (-) must be the only input');

  if (rawInputs[0] === '-') {
    if (process.stdin.isTTY) throw inputError('stdin input was requested, but no data is being piped');
    const discoveryLimit = Math.min(
      options.maxTotalMb * 1024 * 1024,
      Math.max(FILE_CONSTRAINTS.MAX_IMAGE_SIZE, FILE_CONSTRAINTS.MAX_PDF_SIZE),
    );
    const stdinBytes = await readStdin(discoveryLimit, signal);
    if (stdinBytes.byteLength === 0) throw inputError('<stdin> is empty');
    const mimeType = detectMimeType(options.stdinName, options.stdinType, stdinBytes);
    const { bytes: mimeLimit, label } = maxFileSizeForMime(mimeType);
    if (stdinBytes.byteLength > mimeLimit) {
      throw inputError(`<stdin> exceeds the ${label} ${mimeType === 'application/pdf' ? 'PDF' : 'image'} limit`);
    }
    return {
      inputs: [{
        displayPath: stdinDisplayPath(options.stdinName),
        relativePath: options.stdinName,
        name: options.stdinName,
        mimeType,
        size: stdinBytes.byteLength,
        mtimeMs: 0,
        stdinBytes,
      }],
      // Piped bytes are the only document; there is nothing a scan could drop.
      skipped: {
        unsupported: { count: 0, names: [] },
        defaultExcluded: { count: 0, names: [] },
      },
    };
  }

  const expanded = await Promise.all([...new Set(rawInputs)].map((input) => expandInput(input, options, signal)));
  signal?.throwIfAborted();
  const uniqueAbsolute = (paths: string[]): string[] => [...new Set(paths.map((entry) => path.resolve(entry)))]
    .sort((a, b) => a.localeCompare(b));
  const unique = uniqueAbsolute(expanded.flatMap((entry) => entry.files));
  // Refuse oversized unions before opening every matched input for MIME sniffing.
  if (unique.length > options.maxFiles) {
    throw inputError(`Matched ${unique.length} files, exceeding --max-files ${options.maxFiles}`);
  }
  // Each expansion already reduced itself to a bounded sample, so merging sorts
  // at most one sample per requested input.
  const mergeNames = (samples: string[]): string[] => uniqueAbsolute(samples)
    .slice(0, MAX_REPORTED_SKIP_NAMES)
    .map((absolutePath) => safeRelativePath(options.cwd, absolutePath));
  const skipped: InputDiscoverySkips = {
    unsupported: {
      count: expanded.reduce((total, entry) => total + entry.unsupportedCount, 0),
      names: mergeNames(expanded.flatMap((entry) => entry.unsupportedSample)),
    },
    defaultExcluded: {
      count: expanded.reduce((total, entry) => total + entry.defaultExcludedCount, 0),
      names: mergeNames(expanded.flatMap((entry) => entry.defaultExcludedSample)),
    },
  };
  if (unique.length === 0) {
    // Naming what was passed over turns "nothing matched" from a dead end into
    // a diagnosis: the caller can see the folder was not empty, just unsupported.
    const detail = describeDiscoverySkips(skipped);
    throw inputError(
      `No supported documents matched the supplied inputs${detail ? ` (${detail})` : ''}`,
    );
  }

  const inputs = await Promise.all(unique.map(async (absolutePath): Promise<ResolvedInput> => {
    const stat = await fs.stat(absolutePath);
    const mimeType = await detectLocalMimeType(absolutePath);
    return {
      absolutePath,
      displayPath: safeRelativePath(options.cwd, absolutePath),
      relativePath: safeRelativePath(options.cwd, absolutePath),
      name: path.basename(absolutePath),
      mimeType,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }));

  const totalBytes = inputs.reduce((sum, input) => sum + input.size, 0);
  const maxBytes = options.maxTotalMb * 1024 * 1024;
  if (totalBytes > maxBytes) {
    throw inputError(`Matched documents total ${(totalBytes / 1024 / 1024).toFixed(1)}MB, exceeding --max-total-mb ${options.maxTotalMb}`);
  }

  return { inputs, skipped };
}

function describeSkipCategory(
  category: InputDiscoverySkips['unsupported'],
  subject: string,
  remedy = '',
): string | undefined {
  const { count, names } = category;
  if (count === 0) return undefined;
  const remainder = count > names.length ? `, and ${count - names.length} more` : '';
  return `${count} ${subject}: ${names.join(', ')}${remainder}${remedy}`;
}

/**
 * Describe what discovery passed over, or return undefined when it passed over
 * nothing. Names are bounded because a scan may drop an unbounded number of
 * entries; the counts cover every dropped entry, including the unnamed ones.
 *
 * The two causes stay separate clauses: an unsupported file type and a
 * default-excluded directory need different actions from the caller.
 */
export function describeDiscoverySkips(skipped: InputDiscoverySkips): string | undefined {
  const clauses = [
    describeSkipCategory(skipped.unsupported, 'unsupported file(s) skipped'),
    describeSkipCategory(
      skipped.defaultExcluded,
      'director(y/ies) skipped by default excludes',
      ' (use --no-default-excludes to scan them)',
    ),
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length > 0 ? clauses.join('; ') : undefined;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function fourCcAt(bytes: Uint8Array, offset: number): string | undefined {
  if (offset < 0 || offset + 4 > bytes.length) return undefined;
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function isoBmffBrands(bytes: Uint8Array): string[] {
  if (bytes.length < 12 || fourCcAt(bytes, 4) !== 'ftyp') return [];
  const boxSize = (
    bytes[0] * 0x1000000
    + bytes[1] * 0x10000
    + bytes[2] * 0x100
    + bytes[3]
  );
  // Extended-size ftyp boxes are unusual and cannot be validated from the
  // bounded sniffing prefix, so reject them instead of guessing.
  if (boxSize === 1 || (boxSize !== 0 && boxSize < 16)) return [];
  const boxEnd = boxSize === 0 ? bytes.length : Math.min(boxSize, bytes.length);
  const majorBrand = fourCcAt(bytes, 8);
  if (!majorBrand) return [];
  const brands = [majorBrand];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    const brand = fourCcAt(bytes, offset);
    if (brand) brands.push(brand);
  }
  return brands;
}

function sniffHeifMimeType(bytes: Uint8Array): 'image/heic' | 'image/heif' | undefined {
  const brands = isoBmffBrands(bytes);
  // AVIF is also HEIF-based. Its explicit brand wins over compatible HEVC
  // brands so a mixed/crafted ftyp box cannot smuggle unsupported AVIF input.
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return undefined;
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'image/heic';
  return brands.some((brand) => HEIF_BRANDS.has(brand)) ? 'image/heif' : undefined;
}

function magicBytesMatch(bytes: Uint8Array, mimeType: string): boolean {
  const startsWith = (signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
  switch (mimeType) {
    case 'image/png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith([0xff, 0xd8, 0xff]);
    case 'image/webp':
      return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWithAt(bytes, 8, [0x57, 0x45, 0x42, 0x50]);
    case 'image/gif':
      return startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
        || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case 'application/pdf':
      return startsWith([0x25, 0x50, 0x44, 0x46]);
    case 'image/heic':
      return sniffHeifMimeType(bytes) === 'image/heic';
    case 'image/heif':
      return sniffHeifMimeType(bytes) === 'image/heif';
    default:
      return false;
  }
}

/** Sniff a document MIME type from the bounded signatures accepted by the CLI. */
export function sniffDocumentMimeType(bytes: Uint8Array): string | undefined {
  const common = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
  const matched = common.find((mimeType) => magicBytesMatch(bytes, mimeType));
  if (matched) return matched;
  return sniffHeifMimeType(bytes);
}

function startsWithAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export async function readAndValidateInput(input: ResolvedInput): Promise<{ bytes: Uint8Array; dataUrl: string }> {
  const { bytes: maxBytes, label } = maxFileSizeForMime(input.mimeType);
  let bytes: Uint8Array;
  if (input.stdinBytes) {
    bytes = input.stdinBytes;
  } else {
    const absolutePath = input.absolutePath;
    if (!absolutePath) throw inputError(`${input.displayPath} has no readable input path`);
    try {
      // Open first, then size-check through the handle. Stat-then-open
      // re-resolves the path, so the entry could be swapped between the limit
      // check and the read; the bound must describe the bytes we actually load.
      const handle = await fs.open(absolutePath, 'r');
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      try {
        const currentSize = (await handle.stat()).size;
        if (currentSize > maxBytes) {
          throw inputError(
            `${input.displayPath} exceeds the ${label} ${input.mimeType === 'application/pdf' ? 'PDF' : 'image'} limit`,
          );
        }
        while (totalBytes <= maxBytes) {
          const readSize = Math.min(1024 * 1024, maxBytes + 1 - totalBytes);
          const chunk = Buffer.allocUnsafe(readSize);
          const { bytesRead } = await handle.read(chunk, 0, readSize, null);
          if (bytesRead === 0) break;
          chunks.push(chunk.subarray(0, bytesRead));
          totalBytes += bytesRead;
        }
      } finally {
        await handle.close();
      }
      bytes = Buffer.concat(chunks, totalBytes);
    } catch (error) {
      if (error instanceof CliExitError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw inputError(`Input no longer exists: ${input.displayPath}`, 'INPUT_NOT_FOUND');
      }
      throw inputError(
        `Could not read ${input.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (bytes.byteLength === 0) throw inputError(`${input.displayPath} is empty`);
  if (bytes.byteLength > maxBytes) {
    throw inputError(
      `${input.displayPath} exceeds the ${label} ${input.mimeType === 'application/pdf' ? 'PDF' : 'image'} limit`,
    );
  }
  if (!magicBytesMatch(bytes.subarray(0, 256), input.mimeType)) {
    throw inputError(`${input.displayPath} does not match its declared type (${input.mimeType})`);
  }

  if (input.mimeType === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      // Buffer#slice returns another Buffer, which pdf.js deliberately rejects;
      // Uint8Array.from always creates the runtime-neutral byte type it expects.
      data: Uint8Array.from(bytes),
      useSystemFonts: true,
      // pdf.js defaults to WARNINGS and writes them straight to stderr, bypassing
      // the CLI's own reporter and --quiet. Verbosity is module-global state, so
      // every getDocument call site must pin it.
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > FILE_CONSTRAINTS.MAX_PDF_PAGES) {
        throw inputError(`${input.displayPath} has ${pdf.numPages} pages; the maximum is ${FILE_CONSTRAINTS.MAX_PDF_PAGES}`);
      }
    } catch (error) {
      if (error instanceof CliExitError) throw error;
      throw inputError(
        `${input.displayPath} is not a valid PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        await loadingTask.destroy();
      } catch {
        // Preserve the input-validation result when pdf.js cleanup also fails.
      }
    }
  }

  return {
    bytes,
    dataUrl: `data:${input.mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
  };
}

export function inputFingerprint(input: ResolvedInput, modeKey: string): string {
  const identity = input.absolutePath ?? `<stdin:${input.relativePath}>`;
  const fingerprint = createHash('sha256')
    .update(`${identity}\0${input.size}\0${input.mtimeMs}\0${modeKey}`);
  if (input.stdinBytes) fingerprint.update('\0stdin-bytes\0').update(input.stdinBytes);
  return fingerprint.digest('hex');
}
