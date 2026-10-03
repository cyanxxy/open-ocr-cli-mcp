import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliOptions } from './config';
import {
  DEFAULT_STDIN_NAME,
  describeDiscoverySkips,
  detectMimeType,
  discoverInputSet,
  inputFingerprint,
  readAndValidateInput,
  readStdin,
  stdinDisplayPath,
} from './inputs';
import type { ResolvedCliOptions, ResolvedInput } from './types';

async function discoverInputs(
  rawInputs: string[],
  options: ResolvedCliOptions,
  signal?: AbortSignal,
): Promise<ResolvedInput[]> {
  return (await discoverInputSet(rawInputs, options, signal)).inputs;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87A_BYTES = new TextEncoder().encode('GIF87a');
const GIF89A_BYTES = new TextEncoder().encode('GIF89a');

function bmffBytes(majorBrand: string, compatibleBrands: string[] = []): Uint8Array {
  const bytes = Buffer.alloc(16 + compatibleBrands.length * 4);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write(majorBrand, 8, 'ascii');
  compatibleBrands.forEach((brand, index) => bytes.write(brand, 16 + index * 4, 'ascii'));
  return Uint8Array.from(bytes);
}

// pdf.js may detach the buffer it is handed, so every call needs its own copy.
function malformedPdfBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from('%PDF-1.4 broken'));
}

function stdinInput(bytes: Uint8Array, mimeType: string, name = 'stdin'): ResolvedInput {
  return {
    displayPath: '<stdin>',
    relativePath: name,
    name,
    mimeType,
    size: bytes.byteLength,
    mtimeMs: 0,
    stdinBytes: bytes,
  };
}
let directory: string;
let options: ResolvedCliOptions;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-inputs-'));
  process.env.GEMINI_API_KEY = 'test-key';
  options = resolveCliOptions({ dryRun: true }, {}, directory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  delete process.env.GEMINI_API_KEY;
});

describe('CLI input discovery', () => {
  it('honors cancellation before local directory or glob discovery', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Discovery cancelled'));
    await expect(discoverInputs(['.'], options, controller.signal)).rejects.toThrow('Discovery cancelled');
    await expect(discoverInputs(['**/*.png'], options, controller.signal)).rejects.toThrow('Discovery cancelled');
  });

  it('matches brace and extglob patterns without following symbolic links', async () => {
    await mkdir(path.join(directory, 'source'));
    await writeFile(path.join(directory, 'source', 'scan.png'), PNG_BYTES);
    await writeFile(path.join(directory, 'source', 'photo.jpg'), JPEG_BYTES);
    await symlink(path.join(directory, 'source'), path.join(directory, 'linked'), 'dir');
    await symlink(path.join(directory, 'source', 'scan.png'), path.join(directory, 'alias.png'));
    const brace = await discoverInputs(['**/*.{png,jpg}'], options);
    const extglob = await discoverInputs(['**/*.@(png|jpg)'], options);
    expect(brace.map((input) => input.relativePath)).toEqual([
      path.join('source', 'photo.jpg'), path.join('source', 'scan.png'),
    ]);
    expect(extglob.map((input) => input.relativePath)).toEqual(brace.map((input) => input.relativePath));
  });

  it('stops oversized glob discovery before inspecting invalid document contents', async () => {
    await writeFile(path.join(directory, 'first.unknown'), 'invalid');
    await writeFile(path.join(directory, 'second.unknown'), 'invalid');
    await expect(discoverInputs(['*.unknown'], { ...options, maxFiles: 1 }))
      .rejects.toThrow('exceeding --max-files 1');
  });

  it('scans repeated input directories once, including skipped-entry counts', async () => {
    await writeFile(path.join(directory, 'scan.png'), PNG_BYTES);
    await writeFile(path.join(directory, 'notes.txt'), 'notes');
    const found = await discoverInputSet(['.', '.'], options);
    expect(found.inputs).toHaveLength(1);
    expect(found.skipped.unsupported.count).toBe(1);
  });

  it('destroys a blocked document stdin stream when aborted', async () => {
    const input = new PassThrough();
    const abortController = new AbortController();
    const reading = readStdin(1024, abortController.signal, input);

    input.write(PNG_BYTES);
    abortController.abort(new Error('Interrupted by SIGTERM'));

    await expect(reading).rejects.toThrow('Interrupted by SIGTERM');
    expect(input.destroyed).toBe(true);
  });

  it('detects every supported extension', () => {
    expect(detectMimeType('a.pdf')).toBe('application/pdf');
    expect(detectMimeType('a.PNG')).toBe('image/png');
    expect(detectMimeType('a.jpeg')).toBe('image/jpeg');
    expect(detectMimeType('a.webp')).toBe('image/webp');
    expect(detectMimeType('a.GIF')).toBe('image/gif');
    expect(detectMimeType('a.heic')).toBe('image/heic');
    expect(() => detectMimeType('a.txt')).toThrow('Unsupported document extension');
  });

  it('sniffs stdin media when its synthetic filename has no extension', () => {
    expect(detectMimeType('stdin', undefined, PNG_BYTES)).toBe('image/png');
    expect(detectMimeType('stdin', undefined, JPEG_BYTES)).toBe('image/jpeg');
    expect(detectMimeType('stdin', undefined, GIF87A_BYTES)).toBe('image/gif');
    expect(detectMimeType('stdin', undefined, GIF89A_BYTES)).toBe('image/gif');
    expect(detectMimeType('stdin', undefined, bmffBytes('heic', ['mif1']))).toBe('image/heic');
    expect(detectMimeType('stdin', undefined, bmffBytes('mif1'))).toBe('image/heif');
    expect(detectMimeType('stdin', 'image/png', PNG_BYTES)).toBe('image/png');
  });

  it('rejects unrelated ISO-BMFF and AVIF media instead of treating them as HEIF', async () => {
    // This MP4-brand payload is a negative fixture, not a supported OCR input.
    const nonImageBmff = bmffBytes('isom', ['mp42']);
    const avif = bmffBytes('avif', ['mif1']);
    const mixedAvif = bmffBytes('mif1', ['heic', 'avif']);
    expect(() => detectMimeType('stdin', undefined, nonImageBmff)).toThrow('Unsupported document extension');
    expect(() => detectMimeType('stdin', undefined, avif)).toThrow('Unsupported document extension');
    expect(() => detectMimeType('stdin', undefined, mixedAvif)).toThrow('Unsupported document extension');
    await expect(readAndValidateInput(stdinInput(nonImageBmff, 'image/heif'))).rejects.toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
    });
    await expect(readAndValidateInput(
      stdinInput(bmffBytes('heic', ['mif1']), 'image/heif'),
    )).rejects.toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
    });
  });

  it('expands directories recursively, sorts files, and applies exclusions', async () => {
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'b.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'nested', 'a.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'nested', 'ignored.jpg'), JPEG_BYTES);
    const found = await discoverInputs(['.'], { ...options, excludes: ['**/ignored.jpg'] });
    expect(found.map((input) => input.relativePath)).toEqual(['b.jpg', path.join('nested', 'a.jpg')]);
  });

  it('reports the directory entries it passed over instead of dropping them silently', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'receipt.png'), PNG_BYTES);
    // Scanners and Windows-originated files routinely use an uppercase
    // extension; an explicitly named `scan.PNG` has always been accepted, so a
    // directory scan must not quietly disagree.
    await writeFile(path.join(directory, 'scan.PNG'), PNG_BYTES);
    await writeFile(path.join(directory, 'report.txt'), 'plain text');
    await writeFile(path.join(directory, 'notes.md'), '# notes');

    const discovery = await discoverInputSet(['.'], options);

    expect(discovery.inputs.map((input) => input.relativePath))
      .toEqual(['invoice.jpg', 'receipt.png', 'scan.PNG']);
    expect(discovery.skipped.unsupported).toEqual({ count: 2, names: ['notes.md', 'report.txt'] });
    expect(describeDiscoverySkips(discovery.skipped))
      .toBe('2 unsupported file(s) skipped: notes.md, report.txt');
  });

  it('says nothing when a scan passed over nothing', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    const discovery = await discoverInputSet(['.'], options);
    expect(discovery.skipped.unsupported).toEqual({ count: 0, names: [] });
    expect(describeDiscoverySkips(discovery.skipped)).toBeUndefined();
  });

  it('names the unsupported entries when a directory yields no documents at all', async () => {
    await writeFile(path.join(directory, 'report.txt'), 'plain text');
    await writeFile(path.join(directory, 'notes.md'), '# notes');

    await expect(discoverInputSet(['.'], options)).rejects.toThrow(
      'No supported documents matched the supplied inputs (2 unsupported file(s) skipped: notes.md, report.txt)',
    );
  });

  it('bounds the listed skip names while keeping the count exact', async () => {
    await writeFile(path.join(directory, 'keep.jpg'), JPEG_BYTES);
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      await writeFile(path.join(directory, name), 'plain text');
    }

    const discovery = await discoverInputSet(['.'], options);

    expect(discovery.inputs).toHaveLength(1);
    expect(discovery.skipped.unsupported.count).toBe(5);
    expect(describeDiscoverySkips(discovery.skipped))
      .toBe('5 unsupported file(s) skipped: a.txt, b.txt, c.txt, and 2 more');
  });

  it('retains a bounded sample rather than every entry a large scan passes over', async () => {
    // Default excludes cover the common case, but a user can still point at a
    // genuinely huge directory. Naming three files must not cost one retained
    // string per file in it.
    await writeFile(path.join(directory, 'keep.jpg'), JPEG_BYTES);
    await mkdir(path.join(directory, 'assets', 'generated'), { recursive: true });
    await Promise.all(Array.from({ length: 400 }, (_, index) => writeFile(
      path.join(directory, 'assets', 'generated', `mod-${String(index).padStart(3, '0')}.js`),
      'module.exports = {};',
    )));

    const discovery = await discoverInputSet(['.'], options);

    expect(discovery.inputs.map((input) => input.name)).toEqual(['keep.jpg']);
    expect(discovery.skipped.unsupported.count).toBe(400);
    // Sampled by name, not by traversal order, so the report is the same on
    // every filesystem.
    expect(discovery.skipped.unsupported.names).toEqual([
      path.join('assets', 'generated', 'mod-000.js'),
      path.join('assets', 'generated', 'mod-001.js'),
      path.join('assets', 'generated', 'mod-002.js'),
    ]);
    expect(describeDiscoverySkips(discovery.skipped)).toContain('and 397 more');
  });

  it('never walks dependency or build trees, and never bills for what is inside them', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    for (const excluded of ['node_modules', 'dist', 'build', 'vendor', 'target']) {
      await mkdir(path.join(directory, excluded, 'nested'), { recursive: true });
      // A real PNG inside a dependency would otherwise become a paid request.
      await writeFile(path.join(directory, excluded, 'logo.png'), PNG_BYTES);
      await writeFile(path.join(directory, excluded, 'nested', 'deep.png'), PNG_BYTES);
    }

    const discovery = await discoverInputSet(['.'], options);

    expect(discovery.inputs.map((input) => input.name)).toEqual(['invoice.jpg']);
    // Directory-level accounting: the subtree is never walked, so the files
    // inside it were never enumerated and cannot be counted.
    expect(discovery.skipped.defaultExcluded.count).toBe(5);
    expect(discovery.skipped.defaultExcluded.names).toEqual(['build', 'dist', 'node_modules']);
    expect(discovery.skipped.unsupported.count).toBe(0);
  });

  it('says which directories the default excludes dropped and how to get them back', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    await mkdir(path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'node_modules', 'logo.png'), PNG_BYTES);

    const discovery = await discoverInputSet(['.'], options);

    // Silence here would re-create the silent-shrinkage bug one layer up.
    expect(describeDiscoverySkips(discovery.skipped)).toBe(
      '1 director(y/ies) skipped by default excludes: node_modules'
      + ' (use --no-default-excludes to scan them)',
    );
  });

  it('scans dependency and build trees when the caller turns the default excludes off', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    await mkdir(path.join(directory, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(directory, 'node_modules', 'pkg', 'logo.png'), PNG_BYTES);

    const discovery = await discoverInputSet(['.'], { ...options, defaultExcludes: false });

    expect(discovery.inputs.map((input) => input.relativePath).sort()).toEqual([
      'invoice.jpg',
      path.join('node_modules', 'pkg', 'logo.png'),
    ]);
    expect(discovery.skipped.defaultExcluded).toEqual({ count: 0, names: [] });
  });

  it('scans an excluded-looking directory the caller named explicitly', async () => {
    await mkdir(path.join(directory, 'dist', 'scans'), { recursive: true });
    await writeFile(path.join(directory, 'dist', 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'dist', 'scans', 'receipt.png'), PNG_BYTES);

    // The excludes describe what a walk wanders into, not what the caller asked
    // for. `extract ./dist` means dist.
    const discovery = await discoverInputSet(['dist'], options);

    expect(discovery.inputs.map((input) => input.name).sort()).toEqual(['invoice.jpg', 'receipt.png']);
    expect(discovery.skipped.defaultExcluded).toEqual({ count: 0, names: [] });
  });

  it('leaves an explicit glob free to match inside an excluded directory', async () => {
    await mkdir(path.join(directory, 'dist'));
    await writeFile(path.join(directory, 'dist', 'invoice.jpg'), JPEG_BYTES);

    const discovery = await discoverInputSet(['dist/*.jpg'], options);

    expect(discovery.inputs.map((input) => input.name)).toEqual(['invoice.jpg']);
  });

  it('keeps one bounded sample when several directory inputs each drop entries', async () => {
    await mkdir(path.join(directory, 'first'));
    await mkdir(path.join(directory, 'second'));
    await writeFile(path.join(directory, 'first', 'keep.jpg'), JPEG_BYTES);
    for (const name of ['b.txt', 'd.txt', 'f.txt']) {
      await writeFile(path.join(directory, 'first', name), 'plain text');
    }
    for (const name of ['a.txt', 'c.txt', 'e.txt']) {
      await writeFile(path.join(directory, 'second', name), 'plain text');
    }

    const discovery = await discoverInputSet(['first', 'second'], options);

    expect(discovery.skipped.unsupported.count).toBe(6);
    expect(discovery.skipped.unsupported.names).toEqual([
      path.join('first', 'b.txt'),
      path.join('first', 'd.txt'),
      path.join('first', 'f.txt'),
    ]);
  });

  it('keeps a directory scan permissive while an explicit glob still rejects unsupported matches', async () => {
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'notes.md'), '# notes');

    // Pointing at a folder must keep working; passing a pattern is the caller's
    // own filter, so an unsupported match there stays a hard error.
    const discovery = await discoverInputSet(['.'], options);
    expect(discovery.inputs.map((input) => input.name)).toEqual(['invoice.jpg']);
    await expect(discoverInputSet(['*'], options)).rejects.toThrow('Unsupported document extension: .md');
  });

  it('leaves hidden entries pruned so a scan never descends into dot directories', async () => {
    await mkdir(path.join(directory, '.git'));
    await writeFile(path.join(directory, '.git', 'config'), 'plain text');
    await writeFile(path.join(directory, 'invoice.jpg'), JPEG_BYTES);

    // Counting hidden entries would mean walking `.git`, `.venv`, and friends on
    // every run, so they stay pruned and therefore uncounted unless --hidden asks.
    const discovery = await discoverInputSet(['.'], options);
    expect(discovery.inputs).toHaveLength(1);
    expect(discovery.skipped.unsupported).toEqual({ count: 0, names: [] });

    const withHidden = await discoverInputSet(['.'], { ...options, hidden: true });
    expect(withHidden.skipped.unsupported).toEqual({
      count: 1,
      names: [path.join('.git', 'config')],
    });
  });

  it('discovers and validates GIF files recursively', async () => {
    await mkdir(path.join(directory, 'nested'));
    await writeFile(path.join(directory, 'nested', 'animation.gif'), GIF89A_BYTES);

    const [input] = await discoverInputs(['.'], options);

    expect(input).toMatchObject({ name: 'animation.gif', mimeType: 'image/gif' });
    const result = await readAndValidateInput(input);
    expect(result.dataUrl).toMatch(/^data:image\/gif;base64,/);
  });

  it('deduplicates overlapping file and glob inputs', async () => {
    await writeFile(path.join(directory, 'document.jpg'), JPEG_BYTES);
    const found = await discoverInputs(['document.jpg', '*.jpg'], options);
    expect(found).toHaveLength(1);
  });

  it('sniffs an explicitly named extensionless or temporary document', async () => {
    const extensionless = path.join(directory, 'agent-upload');
    const temporary = path.join(directory, 'agent-upload.tmp');
    await writeFile(extensionless, PNG_BYTES);
    await writeFile(temporary, JPEG_BYTES);

    const found = await discoverInputs([extensionless, temporary], options);

    expect(found.map((input) => [input.name, input.mimeType])).toEqual([
      ['agent-upload', 'image/png'],
      ['agent-upload.tmp', 'image/jpeg'],
    ]);
  });

  it('discovers empty documents so the batch can report them individually', async () => {
    await writeFile(path.join(directory, 'empty.jpg'), new Uint8Array());
    await writeFile(path.join(directory, 'valid.jpg'), JPEG_BYTES);
    const found = await discoverInputs(['.'], options);
    expect(found).toHaveLength(2);
    await expect(readAndValidateInput(found[0])).rejects.toThrow('is empty');
    await expect(readAndValidateInput(found[1])).resolves.toBeDefined();
  });

  it('enforces file-count and total-size budgets', async () => {
    await writeFile(path.join(directory, 'one.jpg'), JPEG_BYTES);
    await writeFile(path.join(directory, 'two.jpg'), JPEG_BYTES);
    await expect(discoverInputs(['.'], { ...options, maxFiles: 1 })).rejects.toThrow('exceeding --max-files');
    await expect(discoverInputs(['.'], { ...options, maxTotalMb: 0.000001 })).rejects.toThrow('exceeding --max-total-mb');
  });

  it('validates magic bytes and produces stable fingerprints', async () => {
    const target = path.join(directory, 'document.jpg');
    await writeFile(target, JPEG_BYTES);
    const [input] = await discoverInputs([target], options);
    const result = await readAndValidateInput(input);
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(inputFingerprint(input, 'simple')).toBe(inputFingerprint(input, 'simple'));
    expect(inputFingerprint(input, 'simple')).not.toBe(inputFingerprint(input, 'agentic'));

    await writeFile(target, 'not an image');
    await expect(readAndValidateInput(input)).rejects.toThrow('does not match its declared type');
  });

  it('reports a file removed after discovery as an input error', async () => {
    const target = path.join(directory, 'removed.jpg');
    await writeFile(target, JPEG_BYTES);
    const [input] = await discoverInputs([target], options);
    await rm(target);

    await expect(readAndValidateInput(input)).rejects.toMatchObject({
      code: 'INPUT_NOT_FOUND',
      category: 'input',
    });
  });

  it('content-addresses stdin fingerprints and document names', () => {
    const first = stdinInput(new Uint8Array([1, 2, 3]), 'image/png', 'first.png');
    const differentContent = stdinInput(new Uint8Array([9, 8, 7]), 'image/png', 'first.png');
    const differentName = stdinInput(new Uint8Array([1, 2, 3]), 'image/png', 'second.png');
    expect(inputFingerprint(first, 'simple')).not.toBe(inputFingerprint(differentContent, 'simple'));
    expect(inputFingerprint(first, 'simple')).not.toBe(inputFingerprint(differentName, 'simple'));
  });

  it('classifies structurally invalid PDFs as input errors', async () => {
    const malformedPdf = stdinInput(Buffer.from('%PDF-1.7\nbroken'), 'application/pdf', 'broken.pdf');
    await expect(readAndValidateInput(malformedPdf)).rejects.toMatchObject({
      code: 'INPUT_INVALID',
      category: 'input',
    });
  });

  it('keeps pdf.js diagnostics off stderr while validating a malformed PDF', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // pdf.js keeps verbosity in module-global state. Restore the library
      // default first so the assertions below prove that readAndValidateInput
      // pins it rather than inheriting a value another call site happened to set.
      await pdfjs.getDocument({
        data: malformedPdfBytes(),
        verbosity: pdfjs.VerbosityLevel.WARNINGS,
      }).promise.catch(() => undefined);
      expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockClear();
      stderrWrite.mockClear();

      await expect(readAndValidateInput(
        stdinInput(malformedPdfBytes(), 'application/pdf', 'broken.pdf'),
      )).rejects.toMatchObject({ code: 'INPUT_INVALID' });
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it('validates PDF page counts with Uint8Array input', async () => {
    const target = path.join(directory, 'invoice.pdf');
    await copyFile(path.resolve(process.cwd(), 'evals/corpus/invoice.pdf'), target);
    const [input] = await discoverInputs([target], options);
    const result = await readAndValidateInput(input);
    expect(result.dataUrl).toMatch(/^data:application\/pdf;base64,/);
  });
});

describe('stdin document identity', () => {
  /** Drive `discoverInputSet` through the real stdin path with piped bytes. */
  async function discoverPipedStdin(
    bytes: Uint8Array,
    flags: { stdinName?: string } = {},
  ): Promise<ResolvedInput> {
    const stream = new PassThrough();
    stream.end(Buffer.from(bytes));
    const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
    try {
      const discovery = await discoverInputSet(
        ['-'],
        resolveCliOptions({ ...flags, quiet: true }, {}, directory),
      );
      return discovery.inputs[0];
    } finally {
      if (descriptor) Object.defineProperty(process, 'stdin', descriptor);
    }
  }

  it('reports a named stdin document under the name the caller supplied', async () => {
    const named = await discoverPipedStdin(PNG_BYTES, { stdinName: 'piped-card.png' });
    // `source` is derived from displayPath, so naming the document is what lets
    // an agent correlate a result back to the bytes it piped in. The output file
    // already used this name; only the reported source lagged behind.
    expect(named.displayPath).toBe('piped-card.png');
    expect(named.name).toBe('piped-card.png');
    expect(named.relativePath).toBe('piped-card.png');
  });

  it('keeps <stdin> for an unnamed document', async () => {
    const unnamed = await discoverPipedStdin(PNG_BYTES);
    // The placeholder filename says less than the explicit marker does, and the
    // marker is what existing consumers already key on.
    expect(unnamed.displayPath).toBe('<stdin>');
    expect(unnamed.name).toBe(DEFAULT_STDIN_NAME);
  });

  it('pins the unnamed sentinel to the resolved stdin default', () => {
    // stdinDisplayPath decides "named" by comparing against this default. If
    // config.ts changed its default, every stdin run would silently start
    // reporting a name instead of <stdin>.
    expect(resolveCliOptions({}, {}, directory).stdinName).toBe(DEFAULT_STDIN_NAME);
    expect(stdinDisplayPath(DEFAULT_STDIN_NAME)).toBe('<stdin>');
    expect(stdinDisplayPath('piped-card.png')).toBe('piped-card.png');
  });

  it('leaves manifest identity and resume fingerprints unchanged by naming', async () => {
    // Manifests key stdin on the literal '<stdin>' (see ocrJobService) and
    // fingerprints key on relativePath plus content. Neither reads displayPath,
    // so naming a document must not move it to a different manifest entry.
    const named = await discoverPipedStdin(PNG_BYTES, { stdinName: 'piped-card.png' });
    expect(named.absolutePath).toBeUndefined();
    expect(inputFingerprint(named, 'simple')).toBe(inputFingerprint(
      { ...named, displayPath: '<stdin>' },
      'simple',
    ));
  });
});
