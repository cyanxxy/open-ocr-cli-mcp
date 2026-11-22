import { createCanvas } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

const canvasSizes = vi.hoisted(() => [] as Array<[number, number]>);
const canvasHooks = vi.hoisted(() => ({ onCreate: undefined as (() => void) | undefined }));
vi.mock('@napi-rs/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@napi-rs/canvas')>();
  return {
    ...actual,
    createCanvas: (width: number, height: number) => {
      canvasSizes.push([width, height]);
      canvasHooks.onCreate?.();
      return actual.createCanvas(width, height);
    },
  };
});

import { MAX_PDF_RENDER_PIXELS, nodeRegionCropper } from './nodeRegionCropper';

/** A one-page PDF built in memory, optionally painting one image XObject over the whole page. */
function onePagePdf(options: {
  mediaBox: number;
  image?: { bytes: Buffer; width: number; height: number; filter: 'DCTDecode' | 'JPXDecode' };
  content?: string;
}): Buffer {
  const { mediaBox, image } = options;
  const content = options.content
    ?? (image ? `q ${mediaBox} 0 0 ${mediaBox} 0 0 cm /Im1 Do Q` : '');
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBox} ${mediaBox}] /Contents 4 0 R`
      + `${image ? ' /Resources << /XObject << /Im1 5 0 R >> >>' : ''} >>`,
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n`),
      Buffer.from(content),
      Buffer.from('\nendstream'),
    ]),
  ];
  if (image) {
    const colour = image.filter === 'DCTDecode' ? ' /ColorSpace /DeviceRGB /BitsPerComponent 8' : '';
    objects.push(Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height}${colour} `
        + `/Filter /${image.filter} /Length ${image.bytes.length} >>\nstream\n`,
      ),
      image.bytes,
      Buffer.from('\nendstream'),
    ]));
  }
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    offsets.push(length);
    parts.push(object);
    length += object.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(length),
    '%%EOF',
  ].join('\n');
  parts.push(Buffer.from(`${xref}\n`));
  return Buffer.concat(parts);
}

function pdfDataUrl(bytes: Buffer): string {
  return `data:application/pdf;base64,${bytes.toString('base64')}`;
}

async function meanColour(dataUrl: string): Promise<number[]> {
  const stats = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).stats();
  return stats.channels.slice(0, 3).map((channel) => channel.mean);
}

const FULL_PAGE = { page: 1, x: 0, y: 0, width: 1, height: 1, units: 'normalized' } as const;

/** A 16x16 JPEG 2000 codestream of RGB (40, 60, 230), written by OpenJPEG. */
const JPX_BLUE = Buffer.from(
  '/0//UQAvAAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEAAAQEAAH/XAAEQED/ZAAlAAFDcmVhdGVkIGJ5IE9w'
  + 'ZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAABcAAH/k8+0SBFQVK/0nSMkAAAAAAGEhL//f8+0YBFQVK/0yCN/gAAAAAGEhL9o8AAAAwkJf8+0bBQA'
  + 'XK/fSCX/QAAAAADCQl/wy2AAAAAGEhL/f//Z',
  'base64',
);

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

  it('renders a PDF page that paints a JPEG image without crashing, in the image colour', async () => {
    const jpeg = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 254, g: 127, b: 127 } } })
      .jpeg()
      .toBuffer();
    const pdf = onePagePdf({ mediaBox: 300, image: { bytes: jpeg, width: 200, height: 150, filter: 'DCTDecode' } });
    const result = await nodeRegionCropper(pdfDataUrl(pdf), 'application/pdf', FULL_PAGE);
    const [red, green, blue] = await meanColour(result.dataUrl);
    expect(red).toBeGreaterThan(240);
    expect(green).toBeGreaterThan(110);
    expect(green).toBeLessThan(145);
    expect(blue).toBeLessThan(145);
  });

  it('decodes JPEG 2000 images instead of returning a blank crop', async () => {
    const pdf = onePagePdf({ mediaBox: 200, image: { bytes: JPX_BLUE, width: 16, height: 16, filter: 'JPXDecode' } });
    const result = await nodeRegionCropper(pdfDataUrl(pdf), 'application/pdf', FULL_PAGE);
    const [red, , blue] = await meanColour(result.dataUrl);
    expect(red).toBeLessThan(120);
    expect(blue).toBeGreaterThan(red + 100);
  });

  it('caps the render of a tiny PDF that declares a huge page', async () => {
    const pdf = onePagePdf({ mediaBox: 8000, content: '0 0 1 rg 0 0 8000 8000 re f' });
    expect(pdf.length).toBeLessThan(1024);
    canvasSizes.length = 0;
    const result = await nodeRegionCropper(pdfDataUrl(pdf), 'application/pdf', {
      page: 1, x: 0, y: 0, width: 0.1, height: 0.1, units: 'normalized',
    });
    expect(canvasSizes.length).toBeGreaterThan(0);
    for (const [width, height] of canvasSizes) expect(width * height).toBeLessThanOrEqual(MAX_PDF_RENDER_PIXELS);
    expect(result.width * result.height).toBeLessThanOrEqual(MAX_PDF_RENDER_PIXELS / 100 + 2 * Math.sqrt(MAX_PDF_RENDER_PIXELS));
  });

  it('stops a render when the run is cancelled, and the next crop still runs', async () => {
    const painting = Array.from({ length: 4000 }, (_, index) => (
      `${(index * 37) % 255 / 255} 0 0 rg ${(index * 13) % 7900} ${(index * 29) % 7900} 100 100 re f`
    )).join('\n');
    const pdf = onePagePdf({ mediaBox: 8000, content: painting });
    const controller = new AbortController();
    // Cancel once the document is loaded and the page canvas is being made,
    // i.e. as pdf.js starts rendering.
    canvasHooks.onCreate = () => {
      canvasHooks.onCreate = undefined;
      controller.abort();
    };
    try {
      await expect(nodeRegionCropper(pdfDataUrl(pdf), 'application/pdf', FULL_PAGE, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      canvasHooks.onCreate = undefined;
    }

    const bytes = await readFile(path.resolve(process.cwd(), 'evals/corpus/invoice.pdf'));
    const next = await nodeRegionCropper(pdfDataUrl(bytes), 'application/pdf', {
      page: 1, x: 0, y: 0, width: 0.5, height: 0.5, units: 'normalized',
    });
    expect(next.width).toBeGreaterThan(100);
  });

  it('refuses to start a crop whose run is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(nodeRegionCropper(pdfDataUrl(onePagePdf({ mediaBox: 100 })), 'application/pdf', FULL_PAGE, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
