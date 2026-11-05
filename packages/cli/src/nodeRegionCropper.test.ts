import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { nodeRegionCropper } from './nodeRegionCropper';

const HALF_REGION = { page: 1, x: 0.5, y: 0.5, width: 0.5, height: 0.5, units: 'normalized' } as const;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A tiny PNG whose header declares the given dimensions; the pixel data is never decoded. */
function pngDeclaring(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function quadrantImage(mimeType: 'image/png' | 'image/jpeg' | 'image/webp'): string {
  const canvas = createCanvas(100, 80);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 100, 80);
  context.fillStyle = '#000';
  context.fillRect(50, 40, 50, 40);
  const bytes = mimeType === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer(mimeType, 90);
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

async function meanCropLuma(dataUrl: string): Promise<number> {
  const image = await loadImage(Buffer.from(dataUrl.split(',')[1] || '', 'base64'));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let total = 0;
  for (let index = 0; index < data.length; index += 4) total += data[index] ?? 0;
  return total / (data.length / 4);
}

// pdf.js may detach the buffer it is handed, so every call needs its own copy.
function malformedPdfBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from('%PDF-1.4 broken'));
}

describe('Node region cropper', () => {
  it('crops image regions for agentic re-OCR', async () => {
    const canvas = createCanvas(100, 80);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 100, 80);
    context.fillStyle = '#000';
    context.fillRect(50, 40, 50, 40);
    const dataUrl = `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
    const result = await nodeRegionCropper(dataUrl, 'image/png', {
      page: 1,
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
      units: 'normalized',
    });
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(50);
    expect(result.height).toBe(40);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('crops the requested pixels from %s input', async (mimeType) => {
    const result = await nodeRegionCropper(quadrantImage(mimeType), mimeType, HALF_REGION);
    expect(result).toMatchObject({ mimeType: 'image/png', width: 50, height: 40 });
    // The requested quadrant is solid black; lossy encoders may bleed a little.
    expect(await meanCropLuma(result.dataUrl)).toBeLessThan(16);
  });

  it('crops GIF input', async () => {
    // 2x2 GIF: left column black, right column white.
    const gif = Buffer.from('R0lGODdhAgACAPAAAAAAAP///ywAAAAAAgACAAACAoRRADs=', 'base64');
    const result = await nodeRegionCropper(`data:image/gif;base64,${gif.toString('base64')}`, 'image/gif', {
      page: 1, x: 0, y: 0, width: 0.5, height: 1, units: 'normalized',
    });
    expect(result).toMatchObject({ width: 1, height: 2 });
  });

  it('rejects images that declare more pixels than the decode budget before decoding them', async () => {
    const bomb = pngDeclaring(20_000, 20_000);
    await expect(nodeRegionCropper(`data:image/png;base64,${bomb.toString('base64')}`, 'image/png', HALF_REGION))
      .rejects.toThrow('pixel limit');
  });

  it('rejects bytes that are not a decodable image', async () => {
    await expect(nodeRegionCropper('data:image/jpeg;base64,/9j/AAECAw==', 'image/jpeg', HALF_REGION))
      .rejects.toThrow('Unable to determine document image dimensions');
  });

  it('rejects invalid pages and MIME types', async () => {
    await expect(nodeRegionCropper('data:image/png;base64,AA==', 'image/png', {
      page: 2, x: 0, y: 0, width: 1, height: 1, units: 'normalized',
    })).rejects.toThrow('only contain page 1');
    await expect(nodeRegionCropper('data:text/plain;base64,QQ==', 'text/plain', {
      page: 1, x: 0, y: 0, width: 1, height: 1, units: 'normalized',
    })).rejects.toThrow('not supported');
  });

  it('renders and crops PDF pages for agentic re-OCR', async () => {
    // The cropper installs @napi-rs/canvas classes as globals while pdf.js
    // renders; these names are not declared in the CLI's DOM-free lib set.
    const canvasGlobals = globalThis as unknown as Record<'DOMMatrix' | 'ImageData' | 'Path2D', unknown>;
    const previousGlobals = {
      DOMMatrix: canvasGlobals.DOMMatrix,
      ImageData: canvasGlobals.ImageData,
      Path2D: canvasGlobals.Path2D,
    };
    const bytes = await readFile(path.resolve(process.cwd(), 'evals/corpus/invoice.pdf'));
    const result = await nodeRegionCropper(
      `data:application/pdf;base64,${bytes.toString('base64')}`,
      'application/pdf',
      { page: 1, x: 0.5, y: 0.5, width: 0.25, height: 0.25, units: 'normalized' },
    );
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBeGreaterThan(100);
    expect(result.height).toBeGreaterThan(100);
    expect(canvasGlobals.DOMMatrix).toBe(previousGlobals.DOMMatrix);
    expect(canvasGlobals.ImageData).toBe(previousGlobals.ImageData);
    expect(canvasGlobals.Path2D).toBe(previousGlobals.Path2D);
  });

  it('pins pdf.js verbosity so rendering cannot re-enable stderr warnings', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Verbosity is module-global in pdf.js, so a render that omitted it would
      // leave warnings enabled for every later document in the same process.
      await pdfjs.getDocument({
        data: malformedPdfBytes(),
        verbosity: pdfjs.VerbosityLevel.WARNINGS,
      }).promise.catch(() => undefined);
      expect(consoleWarn).toHaveBeenCalled();

      const bytes = await readFile(path.resolve(process.cwd(), 'evals/corpus/invoice.pdf'));
      await nodeRegionCropper(
        `data:application/pdf;base64,${bytes.toString('base64')}`,
        'application/pdf',
        { page: 1, x: 0, y: 0, width: 1, height: 1, units: 'normalized' },
      );

      consoleWarn.mockClear();
      await pdfjs.getDocument({ data: malformedPdfBytes() }).promise.catch(() => undefined);
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
