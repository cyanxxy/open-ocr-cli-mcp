import { Buffer } from 'node:buffer';

import { type Canvas, createCanvas, DOMMatrix, Image, ImageData, Path2D } from '@napi-rs/canvas';

import type { NormalizedRegion, RegionCropResult, RegionCropper } from '@open-ocr/engine/agentTypes';

const PDF_RENDER_SCALE = 2;
// Decompression-bomb guard: a small compressed file can declare enormous
// dimensions. Matches the 0x3FFF * 0x3FFF pixel ceiling sharp/libvips used
// before cropping moved onto @napi-rs/canvas.
const MAX_INPUT_PIXELS = 0x3fff * 0x3fff;
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

function assertPixelBudget(width: number, height: number): void {
  if (width * height > MAX_INPUT_PIXELS) {
    throw new RangeError(`Document image is ${width}x${height} pixels, which exceeds the ${MAX_INPUT_PIXELS} pixel limit`);
  }
}

function cropSource(source: Image | Canvas, width: number, height: number, region: NormalizedRegion): RegionCropResult {
  const box = pixelBox(region, width, height);
  const output = createCanvas(box.width, box.height);
  output.getContext('2d').drawImage(source, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
  return {
    dataUrl: `data:image/png;base64,${output.toBuffer('image/png').toString('base64')}`,
    mimeType: 'image/png',
    width: box.width,
    height: box.height,
  };
}

function cropRaster(bytes: Buffer, region: NormalizedRegion): RegionCropResult {
  // Assigning src only parses the header; pixels are decoded on drawImage, so
  // the pixel budget is enforced before any large allocation happens.
  const image = new Image();
  image.src = bytes;
  if (!image.width || !image.height) throw new Error('Unable to determine document image dimensions');
  assertPixelBudget(image.width, image.height);
  return cropSource(image, image.width, image.height, region);
}

async function cropPdfPage(bytes: Buffer, region: NormalizedRegion): Promise<RegionCropResult> {
  let releaseQueue: () => void = () => undefined;
  const previousRender = pdfRenderQueue;
  const currentRender = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  pdfRenderQueue = previousRender.then(() => currentRender);
  await previousRender;

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
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      // Verbosity is module-global in pdf.js, so this call site must pin it too;
      // otherwise a render here re-enables warnings on stderr for input validation.
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const pdf = await loadingTask.promise;
    try {
      if (region.page > pdf.numPages) {
        throw new RangeError(`Requested region page ${region.page} exceeds PDF page count ${pdf.numPages}`);
      }
      const page = await pdf.getPage(region.page);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      assertPixelBudget(width, height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      // pdf.js declares these slots as HTMLCanvasElement/CanvasRenderingContext2D.
      // Those names are unresolvable under the CLI's DOM-free lib set, so the
      // slots accept the @napi-rs/canvas objects without a cast; pdf.js only
      // uses the subset both implementations share.
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
      }).promise;
      page.cleanup();
      return cropSource(canvas, width, height, region);
    } finally {
      await loadingTask.destroy();
    }
  } finally {
    for (const name of CANVAS_GLOBAL_NAMES) {
      const previous = previousGlobals[name];
      if (previous.existed) globals[name] = previous.value;
      else Reflect.deleteProperty(globalThis, name);
    }
    releaseQueue();
  }
}

export const nodeRegionCropper: RegionCropper = async (fileData, mimeType, region) => {
  const bytes = base64Bytes(fileData);
  if (mimeType === 'application/pdf') {
    return cropPdfPage(bytes, region);
  }
  if (mimeType.startsWith('image/')) {
    if (region.page !== 1) throw new RangeError(`Image documents only contain page 1, requested page ${region.page}`);
    return cropRaster(bytes, region);
  }
  throw new Error(`Region refinement is not supported for MIME type "${mimeType}"`);
};
