import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { repoRoot } from './shared';

interface DatasetManifest {
  cord: {
    dataset: string;
    revision: string;
    split: string;
    indices: number[];
    license: string;
    source: string;
  };
  omnidocbench: {
    dataset: string;
    revision: string;
    annotationSha256: string;
    seed: string;
    samplesPerDocumentType: number;
    source: string;
    termsNote: string;
  };
  olmocrbench: {
    dataset: string;
    revision: string;
    seed: string;
    pdfsPerCategory: number;
    minTestsPerPdf: number;
    testTypes: string[];
    categories: Record<string, string>;
    license: string;
    source: string;
    selectionNote: string;
  };
}

interface OlmocrTest {
  pdf: string;
  page: number;
  id: string;
  type: string;
  checked?: string | null;
  max_diffs?: number;
  text?: string;
  case_sensitive?: boolean;
  first_n?: number | null;
  last_n?: number | null;
  before?: string;
  after?: string;
  cell?: string;
  up?: string | null;
  down?: string | null;
  left?: string | null;
  right?: string | null;
  top_heading?: string | null;
  left_heading?: string | null;
}

interface CordWord {
  text?: unknown;
}

interface CordLine {
  words?: CordWord[];
}

interface CordGroundTruth {
  gt_parse?: unknown;
  valid_line?: CordLine[];
}

interface CordRowsResponse {
  rows: Array<{
    row_idx: number;
    row: {
      image: { src: string };
      ground_truth: string;
    };
  }>;
}

interface OmniBlock {
  category_type?: string;
  ignore?: boolean;
  order?: number;
  text?: string;
  latex?: string;
  html?: string;
}

interface OmniPage {
  layout_dets: OmniBlock[];
  page_info: {
    image_path: string;
    page_attribute: {
      data_source: string;
      language?: string;
      layout?: string;
      special_issue?: string[];
    };
  };
}

const cacheRoot = path.resolve(repoRoot, 'evals', 'cache');
const MAX_DOWNLOAD_REDIRECTS = 5;

function validateHuggingFaceUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const allowedHost = hostname === 'huggingface.co'
    || hostname.endsWith('.huggingface.co')
    || hostname === 'hf.co'
    || hostname.endsWith('.hf.co');
  if (
    url.protocol !== 'https:'
    || !allowedHost
    || (url.port !== '' && url.port !== '443')
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error(`Refusing dataset download from untrusted URL: ${url.origin}`);
  }
}

async function fetchHuggingFace(rawUrl: string): Promise<Response> {
  let url = new URL(rawUrl);
  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    validateHuggingFaceUrl(url);
    const response = await fetch(url, {
      headers: { 'user-agent': 'open-ocr-evals/1.0' },
      redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error(`Dataset download redirect from ${url.origin} omitted Location`);
    url = new URL(location, url);
  }
  throw new Error(`Dataset download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`);
}

async function readManifest(): Promise<DatasetManifest> {
  const raw = await fs.readFile(path.resolve(repoRoot, 'evals', 'datasets.json'), 'utf8');
  return JSON.parse(raw) as DatasetManifest;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetchHuggingFace(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchHuggingFace(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return await response.json() as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function downloadFile(url: string, filePath: string): Promise<void> {
  const bytes = await fetchBytes(url);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}

function cordText(groundTruth: CordGroundTruth): string {
  return (groundTruth.valid_line ?? [])
    .map((line) => (line.words ?? []).map((word) => typeof word.text === 'string' ? word.text.trim() : '').filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}

function localPath(...segments: string[]): string {
  return path.posix.join('evals', 'cache', ...segments);
}

async function setupCord(manifest: DatasetManifest['cord']): Promise<number> {
  const maximumIndex = Math.max(...manifest.indices);
  const query = new URL('https://datasets-server.huggingface.co/rows');
  query.searchParams.set('dataset', manifest.dataset);
  query.searchParams.set('config', 'default');
  query.searchParams.set('split', manifest.split);
  query.searchParams.set('offset', '0');
  query.searchParams.set('length', String(maximumIndex + 1));
  query.searchParams.set('revision', manifest.revision);
  const response = await fetchJson<CordRowsResponse>(query.toString());
  const selectedRows = response.rows.filter((row) => manifest.indices.includes(row.row_idx));

  for (const [selectionIndex, entry] of selectedRows.entries()) {
    const id = String(entry.row_idx).padStart(3, '0');
    const groundTruth = JSON.parse(entry.row.ground_truth) as CordGroundTruth;
    const imageRelative = localPath('cord', 'images', `${id}.jpg`);
    const textRelative = localPath('cord', 'references', `${id}.txt`);
    const jsonRelative = localPath('cord', 'references', `${id}.json`);
    await Promise.all([
      downloadFile(entry.row.image.src, path.resolve(repoRoot, imageRelative)),
      fs.mkdir(path.dirname(path.resolve(repoRoot, textRelative)), { recursive: true })
        .then(() => fs.writeFile(path.resolve(repoRoot, textRelative), `${cordText(groundTruth)}\n`, 'utf8')),
      writeJson(path.resolve(repoRoot, jsonRelative), groundTruth.gt_parse ?? {}),
    ]);
    await writeJson(path.resolve(cacheRoot, 'cases', `cord-simple-${id}.json`), {
      id: `cord-simple-${id}`,
      mode: 'simple',
      inputPath: imageRelative,
      reference: { textPath: textRelative },
      expectedAssertions: [
        { type: 'metric_min', metric: 'normalized_edit_similarity', value: 0.65 },
        { type: 'metric_min', metric: 'text_coverage', value: 0.65 },
        { type: 'metric_max', metric: 'unsupported_text_rate', value: 0.4 },
      ],
      tags: ['external', 'cord', 'receipt', 'photographed', 'real-ocr'],
      suites: selectionIndex < 5 ? ['canary', 'full', 'benchmark'] : ['full', 'benchmark'],
    });
  }
  return selectedRows.length;
}

function stripHtml(html: string): string {
  return html
    .replace(/<\/(?:tr|p|div|table)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function omniText(page: OmniPage): string {
  return [...page.layout_dets]
    .filter((block) => !block.ignore)
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
    .map((block) => block.text?.trim() || block.latex?.trim() || (block.html ? stripHtml(block.html) : ''))
    .filter(Boolean)
    .join('\n');
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodeRemotePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function selectOmniPages(pages: OmniPage[], seed: string, samplesPerDocumentType: number): OmniPage[] {
  const grouped = new Map<string, OmniPage[]>();
  for (const page of pages) {
    const source = page.page_info.page_attribute.data_source;
    grouped.set(source, [...(grouped.get(source) ?? []), page]);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).flatMap(([, entries]) =>
    entries
      .sort((left, right) => sha256(`${seed}${left.page_info.image_path}`).localeCompare(sha256(`${seed}${right.page_info.image_path}`)))
      .slice(0, samplesPerDocumentType)
  );
}

async function setupOmniDocBench(manifest: DatasetManifest['omnidocbench']): Promise<number> {
  const annotationUrl = `https://huggingface.co/datasets/${manifest.dataset}/resolve/${manifest.revision}/OmniDocBench.json?download=true`;
  const annotationBytes = await fetchBytes(annotationUrl);
  const digest = sha256(annotationBytes);
  if (digest !== manifest.annotationSha256) {
    throw new Error(`OmniDocBench annotation checksum mismatch: expected ${manifest.annotationSha256}, received ${digest}`);
  }
  const pages = JSON.parse(new TextDecoder().decode(annotationBytes)) as OmniPage[];
  const selectedPages = selectOmniPages(pages, manifest.seed, manifest.samplesPerDocumentType);

  for (const [index, page] of selectedPages.entries()) {
    const id = String(index).padStart(3, '0');
    const extension = path.extname(page.page_info.image_path).toLowerCase() || '.png';
    const imageRelative = localPath('omnidocbench', 'images', `${id}${extension}`);
    const textRelative = localPath('omnidocbench', 'references', `${id}.txt`);
    const metadataRelative = localPath('omnidocbench', 'references', `${id}.json`);
    const imageUrl = `https://huggingface.co/datasets/${manifest.dataset}/resolve/${manifest.revision}/images/${encodeRemotePath(page.page_info.image_path)}?download=true`;
    await Promise.all([
      downloadFile(imageUrl, path.resolve(repoRoot, imageRelative)),
      fs.mkdir(path.dirname(path.resolve(repoRoot, textRelative)), { recursive: true })
        .then(() => fs.writeFile(path.resolve(repoRoot, textRelative), `${omniText(page)}\n`, 'utf8')),
      writeJson(path.resolve(repoRoot, metadataRelative), page.page_info),
    ]);
    const attributes = page.page_info.page_attribute;
    await writeJson(path.resolve(cacheRoot, 'cases', `omnidocbench-simple-${id}.json`), {
      id: `omnidocbench-simple-${id}`,
      mode: 'simple',
      inputPath: imageRelative,
      reference: { textPath: textRelative },
      expectedAssertions: [
        { type: 'metric_min', metric: 'normalized_edit_similarity', value: 0.55 },
        { type: 'metric_min', metric: 'text_coverage', value: 0.55 },
        { type: 'metric_max', metric: 'unsupported_text_rate', value: 0.45 },
      ],
      tags: [
        'external',
        'omnidocbench',
        attributes.data_source,
        attributes.language ?? 'unknown-language',
        attributes.layout ?? 'unknown-layout',
        'real-ocr',
      ],
      suites: index < 5 ? ['canary', 'full', 'benchmark'] : ['full', 'benchmark'],
    });
  }
  return selectedPages.length;
}

/** Convert olmOCR's snake_case test records to the engine's OcrUnitTest shape. */
function toUnitTest(test: OlmocrTest): Record<string, unknown> {
  const optional = (value: string | number | boolean | null | undefined): string | number | boolean | undefined =>
    value === null || value === '' ? undefined : value;
  const base = { id: test.id, type: test.type, maxDiffs: test.max_diffs ?? 0 };
  if (test.type === 'order') return { ...base, before: test.before, after: test.after };
  if (test.type === 'table') {
    return {
      ...base,
      cell: test.cell,
      up: optional(test.up),
      down: optional(test.down),
      left: optional(test.left),
      right: optional(test.right),
      topHeading: optional(test.top_heading),
      leftHeading: optional(test.left_heading),
    };
  }
  return {
    ...base,
    text: test.text,
    caseSensitive: test.case_sensitive ?? true,
    firstN: optional(test.first_n),
    lastN: optional(test.last_n),
  };
}

async function setupOlmocrBench(manifest: DatasetManifest['olmocrbench']): Promise<number> {
  const root = `https://huggingface.co/datasets/${manifest.dataset}/resolve/${manifest.revision}/bench_data`;
  let caseIndex = 0;
  for (const [category, expectedSha256] of Object.entries(manifest.categories)) {
    const bytes = await fetchBytes(`${root}/${category}.jsonl?download=true`);
    const digest = sha256(bytes);
    if (digest !== expectedSha256) {
      throw new Error(`olmOCR-bench ${category} checksum mismatch: expected ${expectedSha256}, received ${digest}`);
    }
    const byPdf = new Map<string, OlmocrTest[]>();
    for (const line of new TextDecoder().decode(bytes).split('\n')) {
      if (!line.trim()) continue;
      const test = JSON.parse(line) as OlmocrTest;
      if (test.checked !== 'verified' || !manifest.testTypes.includes(test.type) || test.page !== 1) continue;
      byPdf.set(test.pdf, [...(byPdf.get(test.pdf) ?? []), test]);
    }
    const selected = [...byPdf.entries()]
      .filter(([, tests]) => tests.length >= manifest.minTestsPerPdf)
      .sort(([left], [right]) => sha256(`${manifest.seed}${left}`).localeCompare(sha256(`${manifest.seed}${right}`)))
      .slice(0, manifest.pdfsPerCategory);

    for (const [categoryIndex, [pdf, tests]] of selected.entries()) {
      const id = String(caseIndex).padStart(3, '0');
      const pdfRelative = localPath('olmocrbench', 'pdfs', `${id}.pdf`);
      const testsRelative = localPath('olmocrbench', 'references', `${id}.tests.json`);
      await Promise.all([
        downloadFile(`${root}/pdfs/${encodeRemotePath(pdf)}?download=true`, path.resolve(repoRoot, pdfRelative)),
        writeJson(path.resolve(repoRoot, testsRelative), tests.map(toUnitTest)),
      ]);
      await writeJson(path.resolve(cacheRoot, 'cases', `olmocrbench-simple-${id}.json`), {
        id: `olmocrbench-simple-${id}`,
        mode: 'simple',
        inputPath: pdfRelative,
        reference: { unitTestsPath: testsRelative },
        expectedAssertions: [
          { type: 'metric_min', metric: 'unit_test_pass_rate', value: 0.6 },
        ],
        tags: ['external', 'olmocrbench', category, 'pdf', 'real-ocr'],
        suites: categoryIndex < 2 ? ['canary', 'full', 'benchmark'] : ['full', 'benchmark'],
      });
      caseIndex += 1;
    }
  }
  return caseIndex;
}

async function main(): Promise<void> {
  const manifest = await readManifest();
  await fs.rm(cacheRoot, { recursive: true, force: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  console.log(`CORD: ${manifest.cord.license}; ${manifest.cord.source}`);
  console.log(`OmniDocBench: ${manifest.omnidocbench.termsNote} ${manifest.omnidocbench.source}`);
  console.log(`olmOCR-bench: ${manifest.olmocrbench.license}; ${manifest.olmocrbench.source}`);
  const cordCount = await setupCord(manifest.cord);
  const omniCount = await setupOmniDocBench(manifest.omnidocbench);
  const olmocrCount = await setupOlmocrBench(manifest.olmocrbench);
  await writeJson(path.resolve(cacheRoot, 'installed.json'), {
    installedAt: new Date().toISOString(),
    cord: { revision: manifest.cord.revision, cases: cordCount },
    omnidocbench: { revision: manifest.omnidocbench.revision, cases: omniCount },
    olmocrbench: { revision: manifest.olmocrbench.revision, cases: olmocrCount },
  });
  console.log(`Prepared ${cordCount + omniCount + olmocrCount} public eval cases in ${path.relative(repoRoot, cacheRoot)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
