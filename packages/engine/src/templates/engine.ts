import {
  applyThinkingConfig,
  assertCompleteGeminiResponse,
  createGeminiStreamCompletionTracker,
  generateContentMediaResolution,
  getGenAIClient,
} from '../gemini/client';
import { parseJsonPayload } from '../gemini/structured';
import { OcrError, OcrErrorType } from '../gemini/types';
import { logger } from '../logger';
import { recordGeminiUsage } from '../gemini/usage';
import { waitForGeminiRequestSlot } from '../gemini/requestPolicy';
import type {
  ExtractionPreset,
  ExtractionRule,
  GeminiClientConfig,
  PresetExtractedField,
  PresetRunResult,
  PresetStreamingCallbacks,
  PresetStructuredOutput,
} from '../gemini/types';

interface TemplateGenerationOptions {
  abortSignal?: AbortSignal;
  /** Output-token ceiling; defaults to {@link DEFAULT_TEMPLATE_MAX_TOKENS}. */
  maxTokens?: number;
}

/** Output-token ceiling for a preset extraction when the caller sets none. */
export const DEFAULT_TEMPLATE_MAX_TOKENS = 16384;

type PrimitiveFieldValue = string | number | boolean | string[] | null;

interface RawPresetField {
  value?: unknown;
  confidence?: unknown;
}

interface RawPresetPayload {
  documentType?: unknown;
  summary?: unknown;
  fields?: Record<string, RawPresetField | PrimitiveFieldValue>;
  rows?: unknown;
  warnings?: unknown;
}

// audit T-09: bound output to keep CSV/markdown payloads (and downloads) sane
// even when a model emits an unbounded statement with hundreds of line items.
const MAX_ROWS = 500;
const MAX_FIELD_VALUE_LENGTH = 20000;

const JSON_ONLY_INSTRUCTION = [
  'Return valid JSON only.',
  'Do not wrap the JSON in markdown fences.',
  'Do not invent fields that are not visible in the document.',
  'Use null for missing scalar values and [] for missing list values.',
  'Confidence scores must be numbers between 0 and 1.',
].join(' ');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SCHEMA_ERROR_PREFIX = 'Preset extraction response did not match the expected schema';

/**
 * A preset response the model shaped wrongly. Typed as `OUTPUT_INVALID` so the
 * CLI reports "the model's answer did not conform" (retryable) rather than a
 * provider failure, and the message names the JSON path that broke.
 */
function presetSchemaError(path: string, problem: string): OcrError {
  return new OcrError(OcrErrorType.OUTPUT_INVALID, `${SCHEMA_ERROR_PREFIX}: ${path} ${problem}`);
}

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (typeof value === 'number') return String(value);
  return `a ${typeof value}`;
}

function scalarText(value: unknown, path = 'value'): string {
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw presetSchemaError(path, `must be a string, finite number, or boolean (got ${describeReceived(value)})`);
}

/**
 * Tolerance for a confidence just outside [0, 1]. Models occasionally emit
 * 1.0000001 or -0.001 from float arithmetic; those are clamped with a warning.
 * Anything further out (1.5, 95) is a real contract violation and fails with
 * the field named, since there is no safe reading of it.
 */
const CONFIDENCE_TOLERANCE = 0.05;

type ConfidenceReading = { value: number; warning?: string } | { error: string };

/**
 * Read a field's confidence. Policy (documented here because it is a choice):
 * - a finite number in [0, 1] is used as-is;
 * - a numeric string ("0.9") is coerced, with a warning;
 * - a number within {@link CONFIDENCE_TOLERANCE} of the range is clamped, with
 *   a warning;
 * - anything else is rejected, naming the field and the value received.
 */
function readConfidence(raw: unknown, field: string): ConfidenceReading {
  let numeric: number | undefined;
  const warnings: string[] = [];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    numeric = raw;
  } else if (typeof raw === 'string' && /^\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*$/u.test(raw)) {
    numeric = Number(raw);
    warnings.push(`Field "${field}": confidence was the string "${raw.trim()}"; read as ${numeric}.`);
  }
  if (numeric === undefined || numeric < -CONFIDENCE_TOLERANCE || numeric > 1 + CONFIDENCE_TOLERANCE) {
    return { error: `must be a number from 0 to 1 (got ${describeReceived(raw)})` };
  }
  if (numeric < 0 || numeric > 1) {
    const clamped = Math.min(1, Math.max(0, numeric));
    warnings.push(`Field "${field}": confidence ${numeric} was outside 0-1; clamped to ${clamped}.`);
    numeric = clamped;
  }
  return { value: numeric, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
}

/**
 * Fail closed on malformed preset JSON. Models (and non-Gemini providers without
 * responseJsonSchema) can return primitives, arrays, or half-shaped objects that
 * would otherwise become empty-but-plausible extraction results. Every failure
 * names the path that broke ("fields.total.confidence must be …").
 *
 * Partial extraction remains valid: `fields` may be `{}` and individual preset
 * rules may be omitted — those become validationErrors later, not schema failures.
 */
function assertValidPresetPayload(value: unknown): RawPresetPayload {
  if (!isRecord(value)) {
    throw presetSchemaError('the response', `must be a JSON object (got ${describeReceived(value)})`);
  }

  if (!isRecord(value.fields)) {
    throw presetSchemaError('fields', `must be an object keyed by field name (got ${describeReceived(value.fields)})`);
  }

  if (value.documentType !== undefined && typeof value.documentType !== 'string') {
    throw presetSchemaError('documentType', `must be a string (got ${describeReceived(value.documentType)})`);
  }

  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw presetSchemaError('summary', `must be a string (got ${describeReceived(value.summary)})`);
  }

  if (value.rows !== undefined) {
    if (!Array.isArray(value.rows)) {
      throw presetSchemaError('rows', `must be an array of objects (got ${describeReceived(value.rows)})`);
    }
    value.rows.forEach((row: unknown, index: number) => {
      if (!isRecord(row)) throw presetSchemaError(`rows[${index}]`, `must be an object (got ${describeReceived(row)})`);
      for (const [column, cell] of Object.entries(row)) {
        if (cell !== null) scalarText(cell, `rows[${index}].${column}`);
      }
    });
  }

  if (value.warnings !== undefined) {
    if (!Array.isArray(value.warnings)) {
      throw presetSchemaError('warnings', `must be an array of strings (got ${describeReceived(value.warnings)})`);
    }
    const bad = value.warnings.findIndex((entry: unknown) => typeof entry !== 'string');
    if (bad >= 0) throw presetSchemaError(`warnings[${bad}]`, `must be a string (got ${describeReceived(value.warnings[bad])})`);
  }

  for (const [name, field] of Object.entries(value.fields)) {
    const path = `fields.${name}`;
    if (!isRecord(field) || !('value' in field)) {
      throw presetSchemaError(path, `must be an object with "value" and "confidence" (got ${describeReceived(field)})`);
    }
    const confidence = readConfidence(field.confidence, name);
    if ('error' in confidence) throw presetSchemaError(`${path}.confidence`, confidence.error);
    if (Array.isArray(field.value)) {
      const bad = field.value.findIndex((entry: unknown) => typeof entry !== 'string');
      if (bad >= 0) throw presetSchemaError(`${path}.value[${bad}]`, `must be a string (got ${describeReceived(field.value[bad])})`);
    } else if (field.value !== null) {
      scalarText(field.value, `${path}.value`);
    }
  }

  return value;
}

function parsePresetPayload(rawText: string): RawPresetPayload {
  // The shared tolerant extractor parses a bare response directly (so
  // primitives/arrays reach shape validation with a clear schema error) and
  // otherwise unwraps fences, prose, and inline reasoning.
  return assertValidPresetPayload(parseJsonPayload<unknown>(rawText, 'Preset extraction'));
}

/** ISO 4217 currencies with three minor-unit digits. */
const THREE_DECIMAL_CURRENCIES = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const;
const THREE_DECIMAL_CODE = new RegExp(`(?:^|[^A-Za-z])(${THREE_DECIMAL_CURRENCIES.join('|')})(?![A-Za-z])`, 'iu');

/** The three-decimal currency named in `text`, if any. */
function threeDecimalCurrencyIn(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return THREE_DECIMAL_CODE.exec(text)?.[1]?.toUpperCase();
}

interface ParsedLocaleNumber {
  value: number;
  /** Digits after the decimal separator in the source text. */
  decimals: number;
  /** Set when one separator followed by exactly three digits had to be guessed. */
  ambiguity?: { chosen: 'grouping' | 'decimal'; alternative: number };
}

const GROUPING_SPACE = /[\s\u00a0\u202f'\u2019]/u;

/**
 * Parse a human-formatted number that may use US ("1,234.56"), European
 * ("1.234,56"), space/apostrophe ("1 234,56", "1'234.56"), or plain ("1234")
 * grouping/decimal conventions, with currency symbols or codes around it.
 *
 * The sign is read wherever documents put it: a leading minus before or after
 * the currency ("-$5", "USD -5.00"), a trailing minus ("5.00-"), accounting
 * parentheses ("(27.00)"), and the Unicode minus sign (U+2212).
 *
 * Returns null — so the caller keeps the original text — whenever a value
 * cannot be read without guessing its magnitude: two separate numbers
 * ("3 @ 5.00"), irregular grouping ("1,23,4"), and the like. The one guess that
 * is made, a single separator followed by exactly three digits ("1.234"), is
 * reported through `ambiguity` so the caller can warn about it.
 */
function parseLocaleNumber(
  raw: string,
  mode: 'number' | 'currency',
  threeDecimalCurrency: boolean,
): ParsedLocaleNumber | null {
  const text = raw.normalize('NFKC').replace(/[\u2212\ufe63\uff0d]/gu, '-').trim();
  const cores = text.match(/\d(?:[\d.,\s\u00a0\u202f'\u2019]*\d)?/gu);
  if (!cores || cores.length !== 1) return null;
  let core = cores[0];
  const coreStart = text.indexOf(core);
  let prefix = text.slice(0, coreStart);
  const suffix = text.slice(coreStart + core.length);

  // ".5" / ",5": the separator sits outside the digit run.
  const leadingSeparator = /[.,]$/u.exec(prefix);
  if (leadingSeparator) {
    prefix = prefix.slice(0, -1);
    core = `0${leadingSeparator[0]}${core}`;
  }

  const negative = prefix.includes('-')
    || /^\s*-/u.test(suffix)
    || (prefix.includes('(') && suffix.includes(')'));

  if (GROUPING_SPACE.test(core)) {
    if (!/^\d{1,3}(?:[\s\u00a0\u202f'\u2019]\d{3})+(?:[.,]\d+)?$/u.test(core)) return null;
    core = core.replace(/[\s\u00a0\u202f'\u2019]/gu, '');
  }

  const commaCount = core.split(',').length - 1;
  const dotCount = core.split('.').length - 1;
  let normalized: string;
  let decimals = 0;
  let ambiguity: ParsedLocaleNumber['ambiguity'];

  if (commaCount > 0 && dotCount > 0) {
    // The right-most separator is the decimal point; the other is grouping.
    const decimalSep = core.lastIndexOf(',') > core.lastIndexOf('.') ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    const [integerPart, fraction, ...extra] = core.split(decimalSep);
    if (extra.length > 0) return null;
    const groups = integerPart.split(groupSep);
    if (groups[0].length > 3 || !groups.slice(1).every((group) => group.length === 3)) return null;
    normalized = `${groups.join('')}.${fraction}`;
    decimals = fraction.length;
  } else if (commaCount + dotCount === 0) {
    normalized = core;
  } else {
    const separator = commaCount > 0 ? ',' : '.';
    const parts = core.split(separator);
    if (parts.length > 2) {
      // Repeated separators can only be grouping ("1.234.567").
      if (parts[0].length > 3 || !parts.slice(1).every((part) => part.length === 3)) return null;
      normalized = parts.join('');
    } else {
      const [integerPart, fraction] = parts;
      const groupingPossible = fraction.length === 3 && integerPart.length <= 3 && !/^0+$/u.test(integerPart);
      if (!groupingPossible) {
        normalized = `${integerPart}.${fraction}`;
        decimals = fraction.length;
      } else {
        const sign = negative ? -1 : 1;
        const asGrouping = Number(`${integerPart}${fraction}`);
        const asDecimal = Number(`${integerPart}.${fraction}`);
        // Currency: grouping unless the currency has three minor digits.
        // Plain numbers keep the long-standing reading (comma groups, dot decimal).
        const chooseDecimal = mode === 'currency' ? threeDecimalCurrency : separator === '.';
        if (chooseDecimal) {
          normalized = `${integerPart}.${fraction}`;
          decimals = 3;
          ambiguity = { chosen: 'decimal', alternative: sign * asGrouping };
        } else {
          normalized = `${integerPart}${fraction}`;
          ambiguity = { chosen: 'grouping', alternative: sign * asDecimal };
        }
      }
    }
  }

  const magnitude = Number(normalized);
  if (!Number.isFinite(magnitude)) return null;
  const value = negative && magnitude !== 0 ? -magnitude : magnitude;
  return { value, decimals, ...(ambiguity ? { ambiguity } : {}) };
}

/** Decimal places a number literal was written with, e.g. 3 for 1.234. */
function decimalsOf(value: number): number {
  const text = String(value);
  if (text.includes('e')) return 0;
  return text.split('.')[1]?.length ?? 0;
}

function formatAmount(value: number, sourceDecimals: number, threeDecimalCurrency: boolean): string {
  const minorUnits = threeDecimalCurrency ? 3 : 2;
  // Never round away digits the document printed: "0.125" stays "0.125".
  return value.toFixed(Math.min(10, Math.max(minorUnits, sourceDecimals)));
}

/** Context for {@link normalizeFieldValue}'s warnings. */
export interface FieldNormalizationContext {
  /** Field name used in warnings. */
  field?: string;
  /** The document's currency (e.g. the preset's `currency` field), when known. */
  currency?: string;
  /** Receives non-fatal findings, such as an ambiguous separator. */
  warnings?: string[];
}

export function normalizeFieldValue(
  value: unknown,
  type: PresetExtractedField['type'],
  context: FieldNormalizationContext = {},
): PrimitiveFieldValue {
  const label = context.field ? `Field "${context.field}"` : 'Value';
  const warn = (message: string): void => {
    context.warnings?.push(message);
  };
  if (value == null) {
    return type === 'list' ? [] : null;
  }

  if (type === 'list') {
    if (Array.isArray(value)) {
      return value.map((entry: unknown) => scalarText(entry).trim()).filter(Boolean);
    }
    return scalarText(value)
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    const normalized = scalarText(value).trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === 'no') return false;
    return scalarText(value).trim();
  }

  if (type === 'number' || type === 'currency') {
    const text = scalarText(value).trim();
    const threeDecimalCode = threeDecimalCurrencyIn(typeof value === 'string' ? value : undefined)
      ?? threeDecimalCurrencyIn(context.currency);
    const threeDecimal = type === 'currency' && threeDecimalCode !== undefined;
    if (typeof value === 'number') {
      return type === 'number' ? value : formatAmount(value, Math.min(6, decimalsOf(value)), threeDecimal);
    }
    const parsed = parseLocaleNumber(text, type, threeDecimal);
    if (!parsed) {
      if (type === 'currency' && /\d/u.test(text)) {
        warn(`${label}: "${text}" could not be read as a single amount; kept as text.`);
      }
      return text;
    }
    const render = (amount: number): string => (
      type === 'currency' ? formatAmount(amount, parsed.decimals, threeDecimal) : String(amount)
    );
    if (parsed.ambiguity) {
      const chosen = parsed.ambiguity.chosen === 'grouping'
        ? `read as ${render(parsed.value)} (thousands separator)`
        : `read as ${render(parsed.value)} (decimal separator${threeDecimal ? `; ${threeDecimalCode} uses three decimals` : ''})`;
      const alternative = parsed.ambiguity.chosen === 'grouping'
        ? `if it is a decimal separator the value is ${parsed.ambiguity.alternative}`
        : `if it is a thousands separator the value is ${parsed.ambiguity.alternative}`;
      warn(`${label}: "${text}" has one separator followed by exactly three digits, which is ambiguous; ${chosen}; ${alternative}.`);
    }
    return type === 'number' ? parsed.value : render(parsed.value);
  }

  return scalarText(value).trim();
}

function clampFieldLength(value: string): string {
  // audit T-09: guard against models emitting pathologically large strings.
  return value.length > MAX_FIELD_VALUE_LENGTH ? value.slice(0, MAX_FIELD_VALUE_LENGTH) : value;
}

interface NormalizedRows {
  rows: Array<Record<string, string>> | undefined;
  /** Number of rows dropped by the MAX_ROWS cap, for the validation report. */
  truncatedRowCount: number;
}

function normalizeRows(rows: unknown): NormalizedRows {
  if (!Array.isArray(rows)) {
    return { rows: undefined, truncatedRowCount: 0 };
  }

  const normalized = rows
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    .map((entry) => Object.fromEntries(
      Object.entries(entry).map(([key, value]) => [key, value == null ? '' : clampFieldLength(scalarText(value).trim())])
    ))
    .filter((entry) => Object.values(entry).some(Boolean));

  // audit T-09: cap row count so downstream CSV/markdown payloads stay bounded.
  const truncatedRowCount = Math.max(0, normalized.length - MAX_ROWS);
  const capped = truncatedRowCount > 0 ? normalized.slice(0, MAX_ROWS) : normalized;

  return {
    rows: capped.length > 0 ? capped : undefined,
    truncatedRowCount,
  };
}

/** True when a normalized field value carries no extracted content. */
function isEmptyFieldValue(value: PrimitiveFieldValue): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Enforce a rule's required/pattern constraints against a normalized value and
 * push human-readable messages into the validation report. See audit T-02.
 */
function validateRule(rule: ExtractionRule, value: PrimitiveFieldValue, errors: string[]): void {
  const empty = isEmptyFieldValue(value);

  if (rule.required && empty) {
    errors.push(`Required field "${rule.field}" is missing or empty.`);
    return;
  }

  if (empty || !rule.pattern) {
    return;
  }

  let matcher: RegExp;
  try {
    matcher = new RegExp(rule.pattern);
  } catch {
    // A malformed pattern in the preset definition should not crash extraction.
    errors.push(`Field "${rule.field}" has an invalid validation pattern.`);
    return;
  }

  const candidates = Array.isArray(value) ? value : [String(value)];
  for (const candidate of candidates) {
    if (!matcher.test(candidate)) {
      errors.push(`Field "${rule.field}" value "${candidate}" does not match the expected format.`);
    }
  }
}

export function normalizePresetPayload(
  rawPayload: RawPresetPayload,
  preset: ExtractionPreset,
): PresetStructuredOutput {
  const validationErrors: string[] = [];
  const validationWarnings: string[] = [];

  // audit T-01: rule.field is the stable contract key for the fields map.
  // Enforce uniqueness so diverging presets cannot silently overwrite entries.
  const seenFieldKeys = new Set<string>();

  const rawFieldEntry = (key: string): { value: unknown; confidence: unknown } => {
    const rawField = rawPayload.fields && Object.hasOwn(rawPayload.fields, key) ? rawPayload.fields[key] : undefined;
    return isRecord(rawField)
      ? { value: rawField.value, confidence: rawField.confidence }
      : { value: rawField, confidence: undefined };
  };

  // The document's own currency, so "1.234" on a KWD invoice reads as a
  // three-decimal amount rather than as thousands grouping.
  const currencyRule = preset.rules.find((rule) => rule.field === 'currency' && rule.type === 'text');
  const documentCurrency = currencyRule ? rawFieldEntry(currencyRule.field).value : undefined;

  const fields: Record<string, PresetExtractedField> = {};
  for (const rule of preset.rules) {
    if (seenFieldKeys.has(rule.field)) {
      validationErrors.push(`Duplicate field key "${rule.field}" in preset "${preset.id}"; later rule ignored.`);
      continue;
    }
    seenFieldKeys.add(rule.field);

    const raw = rawFieldEntry(rule.field);

    // audit T-09: bound string field values just like row cells.
    const rawNormalized = normalizeFieldValue(raw.value, rule.type, {
      field: rule.field,
      currency: typeof documentCurrency === 'string' ? documentCurrency : undefined,
      warnings: validationWarnings,
    });
    const clamped = typeof rawNormalized === 'string' ? clampFieldLength(rawNormalized) : rawNormalized;
    const value = checkTypedValue(rule, clamped, validationWarnings);
    validateRule(rule, value, validationErrors);

    // A value dropped as unsafe carries no confidence: nothing was kept.
    const dropped = value === null && clamped !== null;
    let confidence = 0;
    if (raw.confidence !== undefined && !dropped) {
      const reading = readConfidence(raw.confidence, rule.field);
      if ('value' in reading) {
        confidence = reading.value;
        if (reading.warning) validationWarnings.push(reading.warning);
      }
    }

    fields[rule.field] = {
      type: rule.type,
      value,
      confidence,
      required: Boolean(rule.required),
    };
  }

  const unknownFields = Object.keys(rawPayload.fields ?? {}).filter((key) => !seenFieldKeys.has(key));
  if (unknownFields.length > 0) {
    validationWarnings.push(
      `Ignored field(s) the "${preset.id}" preset does not define: ${unknownFields.map((key) => `"${key}"`).join(', ')}.`,
    );
  }

  const { rows, truncatedRowCount } = normalizeRows(rawPayload.rows);
  if (truncatedRowCount > 0) {
    // audit T-09: surface truncation so consumers know the export is partial.
    validationErrors.push(`Row output truncated to ${MAX_ROWS} rows; ${truncatedRowCount} additional row(s) dropped.`);
  }
  const fixedColumns = preset.tableColumns && preset.tableColumns.length > 0 ? preset.tableColumns : undefined;
  if (rows && fixedColumns) {
    const known = new Set(fixedColumns);
    const extraColumns = new Map<string, number>();
    rows.forEach((row, index) => {
      for (const key of Object.keys(row)) {
        if (!known.has(key) && !extraColumns.has(key)) extraColumns.set(key, index);
      }
    });
    if (extraColumns.size > 0) {
      const listed = [...extraColumns].map(([key, index]) => `"${key}" (first in row ${index + 1})`).join(', ');
      validationWarnings.push(
        `Row column(s) the "${preset.id}" preset does not define are kept in JSON but omitted from CSV and Markdown: ${listed}.`,
      );
    }
  }
  if (preset.outputShape === 'table' && !rows) {
    validationWarnings.push(
      fixedColumns
        ? 'No line-item rows were extracted; CSV output contains only the header row.'
        : 'No line-item rows were extracted.',
    );
  }

  return {
    presetId: preset.id,
    documentType: typeof rawPayload.documentType === 'string' && rawPayload.documentType.trim()
      ? rawPayload.documentType.trim()
      : preset.label,
    summary: typeof rawPayload.summary === 'string' && rawPayload.summary.trim()
      ? rawPayload.summary.trim()
      : `Structured extraction for ${preset.label.toLowerCase()}.`,
    fields,
    rows,
    warnings: Array.isArray(rawPayload.warnings)
      ? rawPayload.warnings.map((warning) => String(warning).trim()).filter(Boolean)
      : undefined,
    validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
    validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/u;
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):(.*)$/isu;

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Check a normalized value against its declared type. Values that merely look
 * wrong (an ambiguous `12/01/26` date, a malformed email) are kept with a
 * warning: the document may genuinely print them that way. A URL with a scheme
 * other than http(s) — `javascript:`, `data:`, `file:` — is dropped to null,
 * because a consumer that renders it as a link would execute or open it.
 */
function checkTypedValue(rule: ExtractionRule, value: PrimitiveFieldValue, warnings: string[]): PrimitiveFieldValue {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const label = `Field "${rule.field}"`;
  if (rule.type === 'date') {
    const match = ISO_DATE.exec(value);
    if (!match || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      warnings.push(`${label}: "${value}" is not an ISO 8601 date (YYYY-MM-DD); its day/month order or year may be ambiguous.`);
    }
    return value;
  }
  if (rule.type === 'email') {
    const candidate = value.replace(/^mailto:/iu, '');
    if (!EMAIL.test(candidate)) warnings.push(`${label}: "${value}" does not look like an email address.`);
    return value;
  }
  if (rule.type === 'url') {
    // Browsers ignore ASCII whitespace and control characters inside a scheme
    // ("java\tscript:"), so the scheme is judged with them removed.
    // eslint-disable-next-line no-control-regex
    const compact = value.replace(/[\u0000- \u007f]/gu, '');
    const scheme = URL_SCHEME.exec(compact);
    // "example.com:8080/x" and "localhost:3000" are a host and port, not a scheme.
    const isHostAndPort = scheme !== null && (scheme[1].includes('.') || /^\d/u.test(scheme[2]));
    if (scheme && !isHostAndPort) {
      const protocol = scheme[1].toLowerCase();
      if (protocol !== 'http' && protocol !== 'https') {
        warnings.push(`${label}: "${value}" uses the "${protocol}:" scheme; only http and https URLs are kept, so the value was set to null.`);
        return null;
      }
      try {
        new URL(compact);
      } catch {
        warnings.push(`${label}: "${value}" is not a valid URL.`);
      }
      return value;
    }
    if (!/^[^\s/?#]+\.[^\s/?#]{2,}(?:[/?#:]|$)/u.test(compact)) {
      warnings.push(`${label}: "${value}" does not look like a URL.`);
    }
    return value;
  }
  return value;
}

/**
 * Escape untrusted text for one line of GFM: a table cell or a list item.
 * Exported so every Markdown renderer of model-supplied values (template and
 * agentic output alike) neutralizes them the same way.
 */
export function escapeMarkdown(value: string): string {
  // audit T-05: a GFM table cell must stay on one line and must not let the
  // model's content open code spans or inject raw HTML. We strip C0/C1
  // control chars (CR/LF survive), collapse line breaks to a space, then
  // escape backslashes, backticks, pipes, and angle brackets.
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fieldValueToString(value: PrimitiveFieldValue): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value == null) {
    return 'Not found';
  }
  return String(value);
}

export function buildPresetMarkdown(result: PresetStructuredOutput, preset: ExtractionPreset): string {
  const sections: string[] = [
    `# ${preset.label} Extraction`,
    '',
    result.summary,
    '',
    '## Fields',
    '',
    '| Field | Value | Confidence |',
    '| --- | --- | --- |',
  ];

  for (const rule of preset.rules) {
    const field = result.fields[rule.field];
    sections.push(
      `| ${escapeMarkdown(rule.field)} | ${escapeMarkdown(fieldValueToString(field?.value ?? null))} | ${Math.round((field?.confidence ?? 0) * 100)}% |`,
    );
  }

  if (result.rows && result.rows.length > 0) {
    const columns = preset.tableColumns && preset.tableColumns.length > 0
      ? preset.tableColumns
      : Object.keys(result.rows[0]);

    sections.push('', '## Rows', '', `| ${columns.map(escapeMarkdown).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`);

    for (const row of result.rows) {
      sections.push(`| ${columns.map((column) => escapeMarkdown(row[column] ?? '')).join(' | ')} |`);
    }
  }

  // audit T-02: surface the validation report so required/pattern failures are visible.
  if (result.validationErrors && result.validationErrors.length > 0) {
    sections.push('', '## Validation', '', ...result.validationErrors.map((issue) => `- ${escapeMarkdown(issue)}`));
  }

  if (result.validationWarnings && result.validationWarnings.length > 0) {
    // These quote model output (field values), so they are escaped like warnings.
    sections.push('', '## Validation warnings', '', ...result.validationWarnings.map((issue) => `- ${escapeMarkdown(issue)}`));
  }

  if (result.warnings && result.warnings.length > 0) {
    // audit T-05: warnings come from model output, so escape them too.
    sections.push('', '## Warnings', '', ...result.warnings.map((warning) => `- ${escapeMarkdown(warning)}`));
  }

  return sections.join('\n');
}

/**
 * CSV for a table preset. With declared `tableColumns` the header is known
 * before extraction, so a document with no line items still yields a valid,
 * header-only CSV (and `normalizePresetPayload` warns about the empty table);
 * discarding the extracted fields over an empty table helped nobody. Only a
 * table preset without declared columns and without rows has no CSV.
 */
export function buildPresetCsv(result: PresetStructuredOutput, preset: ExtractionPreset): string | undefined {
  if (preset.outputShape !== 'table') {
    return undefined;
  }
  const rows = result.rows ?? [];
  const columns = preset.tableColumns && preset.tableColumns.length > 0
    ? preset.tableColumns
    : rows.length > 0 ? Object.keys(rows[0]) : undefined;
  if (!columns) {
    return undefined;
  }

  const escapeCsv = (value: string) => {
    // audit H-11: neutralize spreadsheet formula injection. Cells beginning with
    // =, @, TAB, or CR are interpreted as formulas by Excel/Sheets/LibreOffice and
    // are always prefixed with a single quote so they read as literal text.
    // A leading +/- is only a formula trigger when the cell is NOT a well-formed
    // number — prefixing legitimate negative amounts (e.g. a -50.00 refund line)
    // would corrupt the value for non-Excel consumers (Sheets, pandas, DB imports),
    // which is the OWASP CSV-injection false positive (review finding).
    let normalized = value;
    const isNumericLiteral = /^[+-]?\d[\d.,]*$/.test(normalized);
    const isFormulaLead = /^[=@\t\r]/.test(normalized)
      || (/^[+-]/.test(normalized) && !isNumericLiteral);
    if (isFormulaLead) {
      normalized = `'${normalized}`;
    }
    normalized = normalized.replace(/"/g, '""');
    return /[",\n\r\t]/.test(normalized) ? `"${normalized}"` : normalized;
  };

  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escapeCsv(row[column] ?? '')).join(',')),
  ].join('\n');
}

export function buildPresetPrompt(preset: ExtractionPreset): string {
  const rulesText = preset.rules
    .map((rule) => `- ${rule.field} (${rule.type}${rule.required ? ', required' : ''}): ${rule.description}${rule.example ? ` Example: ${rule.example}.` : ''}`)
    .join('\n');

  // The row cap lives in the prompt rather than as a `maxItems` bound on the
  // response schema; see `buildPresetResponseSchema`.
  const rowInstructions = preset.outputShape === 'table'
    ? `Also extract line-item rows into a "rows" array of at most ${MAX_ROWS} entries. Use these columns when present: ${(preset.tableColumns || []).join(', ')}.`
    : 'Do not include a "rows" array unless the preset requires one.';

  return [
    `You are extracting structured data for the preset "${preset.label}".`,
    preset.description,
    JSON_ONLY_INSTRUCTION,
    'Return this JSON shape:',
    '{"documentType":"string","summary":"string","fields":{"field_name":{"value":"string | number | boolean | string[] | null","confidence":0.0}},"rows":[{"column":"value"}],"warnings":["string"]}',
    'Rules:',
    rulesText,
    rowInstructions,
    'Keep the original language for extracted text whenever possible.',
  ].join('\n\n');
}

function fieldValueSchema(rule: ExtractionRule): Record<string, unknown> {
  const nullSchema = { type: 'null' };
  if (rule.type === 'list') {
    return { anyOf: [{ type: 'array', items: { type: 'string' } }, nullSchema] };
  }
  if (rule.type === 'boolean') {
    return { anyOf: [{ type: 'boolean' }, { type: 'string' }, nullSchema] };
  }
  if (rule.type === 'number' || rule.type === 'currency') {
    return { anyOf: [{ type: 'number' }, { type: 'string' }, nullSchema] };
  }
  return { anyOf: [{ type: 'string' }, nullSchema] };
}

export function buildPresetResponseSchema(preset: ExtractionPreset): Record<string, unknown> {
  const fieldProperties = Object.fromEntries(
    preset.rules.map((rule) => [
      rule.field,
      {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'confidence'],
        properties: {
          value: fieldValueSchema(rule),
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    ]),
  );
  const rowProperties = Object.fromEntries(
    (preset.tableColumns ?? []).map((column) => [column, { type: 'string' }]),
  );

  return {
    type: 'object',
    additionalProperties: false,
    required: ['documentType', 'summary', 'fields', 'warnings'],
    properties: {
      documentType: { type: 'string' },
      summary: { type: 'string' },
      fields: {
        type: 'object',
        additionalProperties: false,
        required: preset.rules.map((rule) => rule.field),
        properties: fieldProperties,
      },
      // No `maxItems` here: constrained decoding compiles array bounds into a
      // repeated grammar, and `MAX_ROWS` copies of a multi-column row object blows
      // past the provider's schema-complexity budget — every preset 400'd with
      // INVALID_ARGUMENT before any OCR happened. The cap is enforced after parsing
      // in `normalizeRows`, which also reports the truncation, so the wire schema
      // does not need to restate it. See `findSchemaCompatibilityIssues`.
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: preset.tableColumns?.length ? false : { type: 'string' },
          properties: rowProperties,
        },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  };
}

export function presetRunResultFromText(rawText: string, preset: ExtractionPreset): PresetRunResult {
  const normalized = normalizePresetPayload(parsePresetPayload(rawText), preset);
  return {
    presetId: preset.id,
    markdown: buildPresetMarkdown(normalized, preset),
    json: normalized,
    csv: buildPresetCsv(normalized, preset),
  };
}

export async function runExtractionPreset(
  fileData: string,
  mimeType: string,
  clientConfig: GeminiClientConfig,
  preset: ExtractionPreset,
  options?: TemplateGenerationOptions,
  callbacks?: PresetStreamingCallbacks,
): Promise<PresetRunResult> {
  try {
    const { apiKey, model, thinkingConfig, baseUrl, headers, runtime } = clientConfig;

    if (!apiKey) {
      throw new Error('Please configure your Gemini API key in settings');
    }

    if (options?.abortSignal?.aborted) {
      throw new Error('Extraction cancelled');
    }

    // Shared client cache so key rotation clears credentials (audit H-18).
    const genAI = getGenAIClient(apiKey, { baseUrl, headers });
    const base64Data = fileData.split(',')[1] || fileData;

    // Gemini 3.x: omit temperature/topP/topK; use media resolution for OCR fidelity.
    let generationConfig: Record<string, unknown> = {
      maxOutputTokens: options?.maxTokens ?? DEFAULT_TEMPLATE_MAX_TOKENS,
      responseMimeType: 'application/json',
      responseJsonSchema: buildPresetResponseSchema(preset),
      mediaResolution: generateContentMediaResolution(mimeType),
    };

    if (options?.abortSignal) {
      generationConfig.abortSignal = options.abortSignal;
    }

    generationConfig = applyThinkingConfig(generationConfig, model, thinkingConfig);

    const contents = [{
      role: 'user' as const,
      parts: [
        { text: buildPresetPrompt(preset) },
        {
          inlineData: {
            mimeType,
            data: base64Data,
          },
        },
      ],
    }];

    let rawText = '';

    if (callbacks) {
      await waitForGeminiRequestSlot(options?.abortSignal, runtime);
      const stream = await genAI.models.generateContentStream({
        model,
        contents,
        config: generationConfig,
      });

      const completion = createGeminiStreamCompletionTracker('Preset extraction');
      let lastChunk: unknown;
      for await (const chunk of stream) {
        lastChunk = chunk;
        try {
          completion.observe(chunk);
        } catch (error) {
          recordGeminiUsage(chunk, model, runtime);
          throw error;
        }
        const chunkText = chunk.text || '';
        rawText += chunkText;
        callbacks.onProgress?.(chunkText);
      }
      recordGeminiUsage(lastChunk, model, runtime);
      completion.assertComplete();
    } else {
      await waitForGeminiRequestSlot(options?.abortSignal, runtime);
      const response = await genAI.models.generateContent({
        model,
        contents,
        config: generationConfig,
      });
      recordGeminiUsage(response, model, runtime);
      assertCompleteGeminiResponse(response, 'Preset extraction');
      rawText = response.text || '';
    }

    const result = presetRunResultFromText(rawText, preset);

    callbacks?.onComplete?.(result);
    return result;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    callbacks?.onError?.(normalizedError);
    logger.error(`Preset extraction failed for ${preset.id}:`, normalizedError);
    throw normalizedError;
  }
}
