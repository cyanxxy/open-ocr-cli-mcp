import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import sharp from 'sharp';

import type { NormalizedRegion, RegionCropResult, RegionCropper } from '@open-ocr/engine/agentTypes';

const PDF_RENDER_SCALE = 2;
/**
 * Most pixels one page render may allocate. A tiny PDF can declare a huge
 * (spec-legal) MediaBox, and rendering it at the full scale cost about 1 GiB
 * and 12 s per crop; larger pages render at a lower scale instead.
 */
export const MAX_PDF_RENDER_PIXELS = 32_000_000;
/** Below this scale a page is too large for its crop to be legible, and is refused. */
const MIN_PDF_RENDER_SCALE = 0.25;

/**
 * pdfjs-dist is external in the bundle, so its install directory is found at
 * run time. pdf.js joins `wasmUrl` with a file name and reads it with
 * `fs.readFile`, so it must be a plain path ending in a separator.
 */
let pdfjsWasmDirectory: string | undefined;
function pdfjsWasmUrl(): string {
  pdfjsWasmDirectory ??= path.join(
    path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'wasm',
  );
  return `${pdfjsWasmDirectory}${path.sep}`;
}

interface CanvasAndContext {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
}

/**
 * Every canvas pdf.js creates (temporary canvases for image XObjects among
 * them) comes from the same `@napi-rs/canvas` the page canvas does. pdfjs-dist
 * otherwise loads its own nested, older copy of the native addon, and drawing
 * one addon's canvas onto the other's context crashes the process with a
 * segmentation fault on any PDF that holds an embedded image. A class, because
 * pdf.js constructs it.
 */
class NapiCanvasFactory {
  constructor(_options?: unknown) {}

  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(canvasAndContext: CanvasAndContext, width: number, height: number): void {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: CanvasAndContext): void {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Region crop aborted', 'AbortError');
}
const CANVAS_GLOBAL_NAMES = ['DOMMatrix', 'ImageData', 'Path2D'] as const;
type CanvasGlobalName = (typeof CANVAS_GLOBAL_NAMES)[number];
const canvasGlobalValues: Readonly<Record<CanvasGlobalName, unknown>> = { DOMMatrix, ImageData, Path2D };
let pdfRenderQueue: Promise<void> = Promise.resolve();

function base64Bytes(fileData: string): Buffer {
  const payload = fileData.includes(',') ? fileData.split(',')[1] || '' : fileData;
  if (!payload) throw new Error('Document data is missing its base64 payload');
  return Buffer.from(payload, 'base64');
}

function pixelBox(region: NormalizedRegion, width: number, height: number) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(region.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(region.y * height)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil((region.x + region.width) * width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.ceil((region.y + region.height) * height)));
  return { left, top, width: right - left, height: bottom - top };
}

async function cropRaster(bytes: Buffer, region: NormalizedRegion): Promise<RegionCropResult> {
  const image = sharp(bytes, { failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Unable to determine document image dimensions');
  const box = pixelBox(region, metadata.width, metadata.height);
  const output = await image.extract(box).png().toBuffer();
  return {
    dataUrl: `data:image/png;base64,${output.toString('base64')}`,
    mimeType: 'image/png',
    width: box.width,
    height: box.height,
  };
}

/** Wait for the render queue, giving up the place in it if the crop is cancelled first. */
async function waitForTurn(previousRender: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return previousRender;
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    await Promise.race([
      previousRender,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function renderPdfPage(bytes: Buffer, region: NormalizedRegion, signal?: AbortSignal): Promise<Buffer> {
  let releaseQueue: () => void = () => undefined;
  const previousRender = pdfRenderQueue;
  const currentRender = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  pdfRenderQueue = previousRender.then(() => currentRender);
  try {
    await waitForTurn(previousRender, signal);
  } catch (error) {
    // The renders queued behind this one still wait for the one before it.
    releaseQueue();
    throw error;
  }

  // pdf.js constructs Path2D objects through globals. Point those globals at
  // the exact canvas implementation used by the rendering context; mixing the
  // DOM or a second native Path2D class makes ctx.fill(path) reject the value.
  const globals = globalThis as unknown as Record<CanvasGlobalName, unknown>;
  const previousGlobals = Object.fromEntries(
    CANVAS_GLOBAL_NAMES.map((name) => [name, {
      existed: Object.prototype.hasOwnProperty.call(globalThis, name),
      value: globals[name],
    }]),
  ) as Record<CanvasGlobalName, { existed: boolean; value: unknown }>;
  Object.assign(globalThis, canvasGlobalValues);
  let onAbort: (() => void) | undefined;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    signal?.throwIfAborted();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      CanvasFactory: NapiCanvasFactory,
      // JPEG 2000 images decode through OpenJPEG loaded from here; without it
      // pdf.js skips them with a hidden warning and the crop comes back blank.
      wasmUrl: pdfjsWasmUrl(),
      // Verbosity is module-global in pdf.js, so this call site must pin it too;
      // otherwise a render here re-enables warnings on stderr for input validation.
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    let renderTask: { cancel: () => void } | undefined;
    // Cancelling stops the render and frees the document, so a cancelled or
    // timed-out run releases the queue that every other crop waits on.
    onAbort = () => {
      renderTask?.cancel();
      void loadingTask.destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const pdf = await loadingTask.promise;
      if (region.page > pdf.numPages) {
        throw new RangeError(`Requested region page ${region.page} exceeds PDF page count ${pdf.numPages}`);
      }
      const page = await pdf.getPage(region.page);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PDF_RENDER_SCALE,
        Math.sqrt(MAX_PDF_RENDER_PIXELS / Math.max(1, base.width * base.height)),
      );
      if (scale < MIN_PDF_RENDER_SCALE) {
        throw new RangeError(
          `PDF page ${region.page} is too large to render for region refinement `
          + `(${Math.round(base.width)} x ${Math.round(base.height)} points)`,
        );
      }
      const viewport = page.getViewport({ scale });
      // Rounded down only when the pixel cap lowered the scale, so it holds.
      const pixels = (value: number): number => Math.max(
        1,
        scale < PDF_RENDER_SCALE ? Math.floor(value) : Math.ceil(value),
      );
      const canvas = createCanvas(pixels(viewport.width), pixels(viewport.height));
      const context = canvas.getContext('2d');
      // pdf.js declares these slots as HTMLCanvasElement/CanvasRenderingContext2D.
      // Those names are unresolvable under the CLI's DOM-free lib set, so the
      // slots accept the @napi-rs/canvas objects without a cast; pdf.js only
      // uses the subset both implementations share.
      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
      });
      renderTask = task;
      if (signal?.aborted) task.cancel();
      await task.promise;
      // Encoding a large page is not free either; skip it once cancelled.
      signal?.throwIfAborted();
      page.cleanup();
      return canvas.toBuffer('image/png');
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw error;
    } finally {
      await loadingTask.destroy();
    }
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    for (const name of CANVAS_GLOBAL_NAMES) {
      const previous = previousGlobals[name];
      if (previous.existed) globals[name] = previous.value;
      else Reflect.deleteProperty(globalThis, name);
    }
    releaseQueue();
  }
}

export const nodeRegionCropper: RegionCropper = async (fileData, mimeType, region, signal) => {
  signal?.throwIfAborted();
  const bytes = base64Bytes(fileData);
  if (mimeType === 'application/pdf') {
    const rendered = await renderPdfPage(bytes, region, signal);
    signal?.throwIfAborted();
    return cropRaster(rendered, region);
  }
  if (mimeType.startsWith('image/')) {
    if (region.page !== 1) throw new RangeError(`Image documents only contain page 1, requested page ${region.page}`);
    return cropRaster(bytes, region);
  }
  throw new Error(`Region refinement is not supported for MIME type "${mimeType}"`);
};
