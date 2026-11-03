import { fencedBlocks, stripReasoningBlocks } from './markdown';
import { OcrError, OcrErrorType } from './types';

/** Bound on candidate `{` positions tried, so adversarial prose stays linear-ish. */
const MAX_OBJECT_CANDIDATES = 256;

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isPlainObjectJson(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Index of the `}` that closes the object opened at `start`, scanning with
 * JSON string rules so braces inside string values do not count. Returns -1
 * when the object never closes.
 */
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The first complete top-level JSON object embedded in prose. Only top-level
 * candidates are tried, so an object nested inside a malformed outer object is
 * never mistaken for the answer: a balanced span that does not parse is
 * skipped as a whole, and an opening brace that never closes ends the search,
 * because every later brace lies inside that unclosed region.
 */
function firstEmbeddedObject(text: string): string | undefined {
  let from = 0;
  for (let attempt = 0; attempt < MAX_OBJECT_CANDIDATES; attempt += 1) {
    const start = text.indexOf('{', from);
    if (start < 0) return undefined;
    const end = balancedObjectEnd(text, start);
    if (end < 0) return undefined;
    const candidate = text.slice(start, end + 1);
    if (isPlainObjectJson(candidate)) return candidate;
    from = end + 1;
  }
  return undefined;
}

function outputInvalid(message: string, cause?: unknown): OcrError {
  return new OcrError(OcrErrorType.OUTPUT_INVALID, message, undefined, cause === undefined ? undefined : { cause });
}

/**
 * Locate the JSON document in a model response, tolerating what models add
 * around it: inline `<think>` reasoning, a ```json fence, or a sentence of
 * prose before or after.
 *
 * Preference order: the whole response if it parses as-is; otherwise the last
 * fenced `json` (or unlabelled) block that parses — models that restate a draft
 * put the final answer last; otherwise the first complete, balanced top-level
 * object that parses. When nothing parses, the most plausible candidate is
 * returned so `JSON.parse` reports a precise syntax error for it.
 */
export function extractJsonPayload(rawText: string, contextLabel: string): string {
  const trimmed = stripReasoningBlocks(rawText.replace(/\r\n?/gu, '\n')).trim();

  if (!trimmed) {
    throw outputInvalid(`${contextLabel} returned an empty response`);
  }

  if (parses(trimmed)) return trimmed;

  const fenced = fencedBlocks(trimmed)
    .filter((block) => block.language === '' || block.language === 'json' || block.language === 'jsonc')
    .map((block) => block.content.trim());
  for (let index = fenced.length - 1; index >= 0; index -= 1) {
    if (parses(fenced[index])) return fenced[index];
  }

  const embedded = firstEmbeddedObject(trimmed);
  if (embedded) return embedded;

  if (fenced.length > 0) return fenced[fenced.length - 1];
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) return trimmed.slice(firstBrace);

  throw outputInvalid(`Could not locate a JSON object in the ${contextLabel.toLowerCase()} response`);
}

/**
 * Parse a model's JSON answer with {@link extractJsonPayload}'s tolerance. Every
 * failure is an `OUTPUT_INVALID` {@link OcrError}: the request was fine, the
 * answer was not, so a caller may retry.
 */
export function parseJsonPayload<T>(rawText: string, contextLabel: string): T {
  const payload = extractJsonPayload(rawText, contextLabel);
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw outputInvalid(`${contextLabel} returned invalid JSON: ${message}`, error);
  }
}
