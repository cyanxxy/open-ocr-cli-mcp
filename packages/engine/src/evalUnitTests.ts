/**
 * Pass/fail OCR unit tests in the olmOCR-bench format
 * (https://huggingface.co/datasets/allenai/olmOCR-bench).
 *
 * Text normalization, table parsing, and cell matching are ported from
 * olmocr/bench/tests.py and table_parsing.py (Apache-2.0,
 * https://github.com/allenai/olmocr). Presence tests use the smallest
 * Levenshtein distance between the query and any substring of the output
 * (`<= maxDiffs`) instead of rapidfuzz's partial_ratio, so pass rates are close
 * to, but not interchangeable with, the official leaderboard.
 */

export type OcrUnitTest =
  | {
    id: string;
    type: 'present' | 'absent';
    text: string;
    maxDiffs?: number;
    caseSensitive?: boolean;
    firstN?: number;
    lastN?: number;
  }
  | { id: string; type: 'order'; before: string; after: string; maxDiffs?: number }
  | {
    id: string;
    type: 'table';
    cell: string;
    maxDiffs?: number;
    up?: string;
    down?: string;
    left?: string;
    right?: string;
    topHeading?: string;
    leftHeading?: string;
  };

export interface OcrUnitTestResult {
  id: string;
  passed: boolean;
}

const TYPOGRAPHY: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '＿': '_',
  '–': '-', '—': '-', '‑': '-', '‒': '-', '−': '-', 'µ': 'μ',
};

export function normalizeUnitTestText(value: string): string {
  let text = value
    .replace(/<br\/?>/g, ' ')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/<\/?[bi]>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .normalize('NFC');
  for (const [fancy, plain] of Object.entries(TYPOGRAPHY)) text = text.split(fancy).join(plain);
  return text;
}

/** For each end offset in `haystack`, the smallest edit distance from `needle` to a substring ending there. */
function substringDistances(needle: string, haystack: string): Int32Array {
  const m = needle.length;
  let previous = new Int32Array(m + 1);
  let current = new Int32Array(m + 1);
  for (let i = 0; i <= m; i += 1) previous[i] = i;
  // ends[j] = distance of the best match of `needle` ending just before haystack[j].
  const ends = new Int32Array(haystack.length + 1);
  ends[0] = m;
  for (let j = 1; j <= haystack.length; j += 1) {
    current[0] = 0;
    const character = haystack[j - 1];
    for (let i = 1; i <= m; i += 1) {
      const substitution = previous[i - 1] + (needle[i - 1] === character ? 0 : 1);
      current[i] = Math.min(substitution, previous[i] + 1, current[i - 1] + 1);
    }
    ends[j] = current[m];
    [previous, current] = [current, previous];
  }
  return ends;
}

function minSubstringDistance(needle: string, haystack: string): number {
  if (!needle) return 0;
  return substringDistances(needle, haystack).reduce((best, distance) => Math.min(best, distance), needle.length);
}

const reverse = (value: string): string => [...value].reverse().join('');

/** Start offsets of approximate matches (distance <= limit), found by matching reversed strings. */
function matchStarts(needle: string, haystack: string, limit: number): number[] {
  const ends = substringDistances(reverse(needle), reverse(haystack));
  const starts: number[] = [];
  for (let j = 1; j < ends.length; j += 1) {
    if (ends[j] <= limit) starts.push(haystack.length - j);
  }
  return starts;
}

/** rapidfuzz `fuzz.ratio` / 100: normalized Indel similarity. */
function indelRatio(left: string, right: string): number {
  if (!left && !right) return 1;
  let previous = new Int32Array(right.length + 1);
  let current = new Int32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return (2 * previous[right.length]) / (left.length + right.length);
}

type CellId = string;

interface TableData {
  cellText: Map<CellId, string>;
  headingCells: Set<CellId>;
  up: Map<CellId, Set<CellId>>;
  down: Map<CellId, Set<CellId>>;
  left: Map<CellId, Set<CellId>>;
  right: Map<CellId, Set<CellId>>;
}

interface CellSpec {
  text: string;
  rowspan: number;
  colspan: number;
  heading: boolean;
}

function buildTable(rows: CellSpec[][]): TableData | undefined {
  const cellText = new Map<CellId, string>();
  const headingCells = new Set<CellId>();
  const meta = new Map<CellId, { row: number; col: number; rowspan: number; colspan: number }>();
  const occupancy: Array<Array<CellId | undefined>> = [];
  const activeSpans: Array<{ id: CellId; remaining: number } | undefined> = [];

  rows.forEach((cells, rowIndex) => {
    const entries: Array<CellId | undefined> = [];
    let col = 0;
    let specIndex = 0;
    while (specIndex < cells.length || col < activeSpans.length) {
      const active = activeSpans[col];
      if (active) {
        entries.push(active.id);
        activeSpans[col] = active.remaining > 1 ? { id: active.id, remaining: active.remaining - 1 } : undefined;
        col += 1;
        continue;
      }
      if (specIndex >= cells.length) {
        entries.push(undefined);
        col += 1;
        continue;
      }
      const spec = cells[specIndex];
      specIndex += 1;
      const id = `${rowIndex},${col}`;
      cellText.set(id, spec.text);
      if (spec.heading) headingCells.add(id);
      meta.set(id, { row: rowIndex, col, rowspan: spec.rowspan, colspan: spec.colspan });
      for (let offset = 0; offset < spec.colspan; offset += 1) {
        entries.push(id);
        activeSpans[col + offset] = spec.rowspan > 1 ? { id, remaining: spec.rowspan - 1 } : undefined;
      }
      col += spec.colspan;
    }
    occupancy.push(entries);
  });
  while (activeSpans.some(Boolean)) {
    occupancy.push(activeSpans.map((active, col) => {
      if (!active) return undefined;
      activeSpans[col] = active.remaining > 1 ? { id: active.id, remaining: active.remaining - 1 } : undefined;
      return active.id;
    }));
  }
  if (cellText.size === 0) return undefined;

  const populated = occupancy.flatMap((row) => row.flatMap((value, index) => (value ? [index] : [])));
  if (populated.length === 0) return undefined;
  const width = Math.max(...populated) + 1;
  for (const row of occupancy) row.length = width;
  const height = occupancy.length;

  const relation = (): Map<CellId, Set<CellId>> => new Map([...cellText.keys()].map((id) => [id, new Set<CellId>()]));
  const table: TableData = { cellText, headingCells, up: relation(), down: relation(), left: relation(), right: relation() };
  const firstNeighbor = (target: Set<CellId>, id: CellId, cells: Array<CellId | undefined>): void => {
    const neighbor = cells.find((value) => value !== undefined && value !== id);
    if (neighbor) target.add(neighbor);
  };
  for (const [id, cell] of meta) {
    const rowEnd = cell.row + cell.rowspan - 1;
    const colEnd = cell.col + cell.colspan - 1;
    for (let row = cell.row; row <= rowEnd && row < height; row += 1) {
      firstNeighbor(table.right.get(id)!, id, occupancy[row].slice(colEnd + 1));
      firstNeighbor(table.left.get(id)!, id, occupancy[row].slice(0, cell.col).reverse());
    }
    for (let col = cell.col; col <= colEnd && col < width; col += 1) {
      firstNeighbor(table.down.get(id)!, id, occupancy.slice(rowEnd + 1).map((row) => row[col]));
      firstNeighbor(table.up.get(id)!, id, occupancy.slice(0, cell.row).reverse().map((row) => row[col]));
    }
  }
  return table;
}

function walkHeadings(table: TableData, start: CellId, relation: Map<CellId, Set<CellId>>): Set<CellId> {
  const headings = new Set<CellId>();
  const ends = new Set<CellId>();
  const visited = new Set<CellId>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (table.headingCells.has(current)) headings.add(current);
    const next = relation.get(current);
    if (!next || next.size === 0) ends.add(current);
    else pending.push(...next);
  }
  headings.delete(start);
  ends.delete(start);
  return headings.size > 0 ? headings : ends;
}

function parseMarkdownTables(content: string): TableData[] {
  const tables: TableData[] = [];
  let block: string[] = [];
  const flush = (): void => {
    if (block.length >= 2) {
      const separator = block.findIndex((line) => {
        const stripped = line.replaceAll('|', '').trim();
        return stripped !== '' && /^[- :]+$/.test(stripped);
      });
      const rows = block
        .filter((line, index) => index !== separator && !(line.trim() && /^[- :|]+$/.test(line)))
        .map((line) => {
          const cells = line.split('|').map((cell) => cell.trim());
          if (cells[0] === '') cells.shift();
          if (cells.at(-1) === '') cells.pop();
          return cells;
        })
        .filter((cells) => cells.length > 0);
      const table = buildTable(rows.map((cells, rowIndex) => cells.map((text, colIndex) => ({
        text, rowspan: 1, colspan: 1, heading: rowIndex === 0 || colIndex === 0,
      }))));
      if (table) tables.push(table);
    }
    block = [];
  };
  for (const line of content.trim().split('\n')) {
    if (line.includes('|')) block.push(line);
    else flush();
  }
  flush();
  return tables;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlText(html: string): string {
  // Drop complete tags, then any unterminated fragment such as `a<script`, so no
  // markup survives; entities decode last, so an escaped `&lt;` stays literal text.
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replaceAll('<', '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (entity, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? entity;
    })
    .trim();
}

function spanAttribute(attributes: string, name: string, rowsRemaining: number): number {
  const match = new RegExp(`${name}\\s*=\\s*["']?\\s*(\\d+)`, 'i').exec(attributes);
  if (!match) return 1;
  const value = Number.parseInt(match[1], 10);
  // HTML rowspan=0 extends to the end of the table section.
  if (value === 0 && name === 'rowspan') return Math.max(1, rowsRemaining);
  return Math.max(1, value || 1);
}

function parseHtmlTables(content: string): TableData[] {
  const tables: TableData[] = [];
  for (const [, tableHtml] of content.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const rows = rowMatches.map((rowMatch, rowIndex) => {
      const before = tableHtml.slice(0, rowMatch.index);
      const inHead = before.lastIndexOf('<thead') > before.lastIndexOf('</thead');
      return [...rowMatch[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map(([, tag, attributes, inner]) => ({
        text: htmlText(inner),
        rowspan: spanAttribute(attributes, 'rowspan', rowMatches.length - rowIndex),
        colspan: spanAttribute(attributes, 'colspan', 1),
        heading: tag.toLowerCase() === 'th' || inHead,
      }));
    });
    const table = buildTable(rows);
    if (table) tables.push(table);
  }
  return tables;
}

function cellThreshold(value: string, maxDiffs: number): number {
  return Math.max(0.5, 1 - maxDiffs / (value.length || 1));
}

function runTableTest(test: Extract<OcrUnitTest, { type: 'table' }>, content: string): boolean {
  const maxDiffs = test.maxDiffs ?? 0;
  const cell = normalizeUnitTestText(test.cell);
  const relations: Array<[string | undefined, (table: TableData, id: CellId) => Set<CellId>]> = [
    [test.up, (table, id) => table.up.get(id)!],
    [test.down, (table, id) => table.down.get(id)!],
    [test.left, (table, id) => table.left.get(id)!],
    [test.right, (table, id) => table.right.get(id)!],
    [test.leftHeading, (table, id) => walkHeadings(table, id, table.left)],
    [test.topHeading, (table, id) => walkHeadings(table, id, table.up)],
  ];
  for (const table of [...parseMarkdownTables(content), ...parseHtmlTables(content)]) {
    for (const [id, text] of table.cellText) {
      if (indelRatio(cell, normalizeUnitTestText(text)) < cellThreshold(cell, maxDiffs)) continue;
      const satisfied = relations.every(([expected, neighbors]) => {
        if (!expected) return true;
        const target = normalizeUnitTestText(expected);
        return [...neighbors(table, id)].some((neighbor) =>
          indelRatio(target, normalizeUnitTestText(table.cellText.get(neighbor) ?? '')) >= cellThreshold(target, maxDiffs));
      });
      if (satisfied) return true;
    }
  }
  return false;
}

export function runOcrUnitTest(test: OcrUnitTest, markdown: string): boolean {
  const maxDiffs = test.maxDiffs ?? 0;
  switch (test.type) {
    case 'present':
    case 'absent': {
      let query = normalizeUnitTestText(test.text);
      let content = normalizeUnitTestText(markdown);
      if (test.caseSensitive === false) {
        query = query.toLowerCase();
        content = content.toLowerCase();
      }
      if (test.firstN && test.lastN) content = content.slice(0, test.firstN) + content.slice(-test.lastN);
      else if (test.firstN) content = content.slice(0, test.firstN);
      else if (test.lastN) content = content.slice(-test.lastN);
      const found = minSubstringDistance(query, content) <= maxDiffs;
      return test.type === 'present' ? found : !found;
    }
    case 'order': {
      const content = normalizeUnitTestText(markdown);
      const before = matchStarts(normalizeUnitTestText(test.before), content, maxDiffs);
      const after = matchStarts(normalizeUnitTestText(test.after), content, maxDiffs);
      return before.length > 0 && after.length > 0 && Math.min(...before) < Math.max(...after);
    }
    case 'table':
      return runTableTest(test, markdown);
  }
}

export function scoreOcrUnitTests(tests: OcrUnitTest[], markdown: string): {
  passRate: number;
  results: OcrUnitTestResult[];
} {
  const results = tests.map((test) => ({ id: test.id, passed: runOcrUnitTest(test, markdown) }));
  const passed = results.filter((result) => result.passed).length;
  return { passRate: tests.length === 0 ? 0 : passed / tests.length, results };
}

export function isOcrUnitTest(value: unknown): value is OcrUnitTest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const test = value as Record<string, unknown>;
  const optionalNumber = (key: string): boolean => test[key] === undefined || (Number.isInteger(test[key]) && (test[key] as number) >= 0);
  const optionalString = (key: string): boolean => test[key] === undefined || typeof test[key] === 'string';
  if (typeof test.id !== 'string' || !optionalNumber('maxDiffs')) return false;
  switch (test.type) {
    case 'present':
    case 'absent':
      return typeof test.text === 'string' && test.text.trim() !== ''
        && (test.caseSensitive === undefined || typeof test.caseSensitive === 'boolean')
        && optionalNumber('firstN') && optionalNumber('lastN');
    case 'order':
      return typeof test.before === 'string' && typeof test.after === 'string';
    case 'table':
      return typeof test.cell === 'string'
        && ['up', 'down', 'left', 'right', 'topHeading', 'leftHeading'].every(optionalString);
    default:
      return false;
  }
}
