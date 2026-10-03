import {
  applyThinkingConfig,
  assertCompleteGeminiResponse,
  createGeminiStreamCompletionTracker,
  generateContentMediaResolution,
  getGenAIClient,
} from '../gemini/client';
import { parseJsonPayload } from '../gemini/structured';
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
}

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

function scalarText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error('Preset extraction response did not match the expected schema: field and row values must be finite scalars');
}

/**
 * Fail closed on malformed preset JSON. Models (and non-Gemini providers without
 * responseJsonSchema) can return primitives, arrays, or half-shaped objects that
 * would otherwise become empty-but-plausible extraction results.
 *
 * Partial extraction remains valid: `fields` may be `{}` and individual preset
 * rules may be omitted — those become validationErrors later, not schema failures.
 */
function assertValidPresetPayload(value: unknown): RawPresetPayload {
  const schemaError = new Error('Preset extraction response did not match the expected schema');

  if (!isRecord(value)) {
    throw schemaError;
  }

  if (!isRecord(value.fields)) {
    throw schemaError;
  }

  if (value.documentType !== undefined && typeof value.documentType !== 'string') {
    throw schemaError;
  }

  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw schemaError;
  }

  if (value.rows !== undefined) {
    if (!Array.isArray(value.rows) || !value.rows.every(isRecord)) throw schemaError;
    for (const row of value.rows) {
      for (const cell of Object.values(row)) {
        if (cell !== null) scalarText(cell);
      }
    }
  }

  if (value.warnings !== undefined) {
    if (!Array.isArray(value.warnings) || !value.warnings.every((entry) => typeof entry === 'string')) {
      throw schemaError;
    }
  }

  for (const field of Object.values(value.fields)) {
    if (!isRecord(field) || !('value' in field)) {
      throw schemaError;
    }
    if (
      typeof field.confidence !== 'number'
      || !Number.isFinite(field.confidence)
      || field.confidence < 0
      || field.confidence > 1
    ) {
      throw schemaError;
    }
    if (Array.isArray(field.value)) {
      if (!field.value.every((entry: unknown) => typeof entry === 'string')) throw schemaError;
    } else if (field.value !== null) {
      scalarText(field.value);
    }
  }

  return value;
}

function parsePresetPayload(rawText: string): RawPresetPayload {
  // Prefer a direct JSON parse so primitives/arrays reach shape validation with a
  // clear schema error (instead of failing earlier as "not an object"). Fall back
  // to extractJsonPayload for fenced or prose-wrapped model responses.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    parsed = parseJsonPayload<unknown>(rawText, 'Preset extraction');
  }
  return assertValidPresetPayload(parsed);
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Parse a human-formatted number that may use US ("1,234.56"), European
 * ("1.234,56"), or plain ("1234") grouping/decimal conventions, with optional
 * currency symbols/letters. Returns null when no numeric value can be recovered
 * so the caller can fall back to the original string.
 *
 * The previous implementation stripped everything except digits/dots/minus,
 * which corrupted thousands-separated and European values (e.g. "1.234,56"
 * became NaN, "1,234.56" became 1.234).
 */
function parseLocaleNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/[0-9]/.test(trimmed)) {
    return null;
  }

  const sign = /^-/.test(trimmed) ? -1 : 1;
  let cleaned = trimmed.replace(/[^0-9.,]/g, '');
  if (cleaned === '') {
    return null;
  }

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    // The right-most separator is the decimal point; the other is grouping.
    const decimalSep = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.') ? ',' : '.';
    const groupSep = decimalSep === ',' ? '.' : ',';
    cleaned = cleaned.split(groupSep).join('').replace(decimalSep, '.');
  } else if (hasComma) {
    // Only commas: a single comma with a non-3-digit tail is a decimal comma
    // ("1,5", "1234,56"); otherwise treat commas as grouping ("1,234", "1,234,567").
    const parts = cleaned.split(',');
    cleaned = parts.length === 2 && parts[1].length !== 3
      ? `${parts[0]}.${parts[1]}`
      : parts.join('');
  } else if (hasDot) {
    // Only dots: multiple dots can only be grouping ("1.234.567"); a single dot
    // is treated as the decimal point.
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      cleaned = parts.join('');
    }
  }

  const result = Number(cleaned);
  return Number.isFinite(result) ? sign * result : null;
}

export function normalizeFieldValue(value: unknown, type: PresetExtractedField['type']): PrimitiveFieldValue {
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

  if (type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const numeric = parseLocaleNumber(scalarText(value));
    return numeric !== null ? numeric : scalarText(value).trim();
  }

  if (type === 'currency') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value.toFixed(2);
    }

    const trimmed = scalarText(value).trim();
    const numeric = parseLocaleNumber(trimmed);
    return numeric !== null ? numeric.toFixed(2) : trimmed;
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

  // audit T-01: rule.field is the stable contract key for the fields map.
  // Enforce uniqueness so diverging presets cannot silently overwrite entries.
  const seenFieldKeys = new Set<string>();

  const fields: Record<string, PresetExtractedField> = {};
  for (const rule of preset.rules) {
    if (seenFieldKeys.has(rule.field)) {
      validationErrors.push(`Duplicate field key "${rule.field}" in preset "${preset.id}"; later rule ignored.`);
      continue;
    }
    seenFieldKeys.add(rule.field);

    const rawField = rawPayload.fields?.[rule.field];
    const rawValue = typeof rawField === 'object' && rawField !== null && !Array.isArray(rawField)
      ? rawField.value
      : rawField;
    const rawConfidence = typeof rawField === 'object' && rawField !== null && !Array.isArray(rawField)
      ? rawField.confidence
      : undefined;

    // audit T-09: bound string field values just like row cells.
    const rawNormalized = normalizeFieldValue(rawValue, rule.type);
    const value = typeof rawNormalized === 'string' ? clampFieldLength(rawNormalized) : rawNormalized;
    validateRule(rule, value, validationErrors);

    fields[rule.field] = {
      type: rule.type,
      value,
      confidence: clampConfidence(rawConfidence),
      required: Boolean(rule.required),
    };
  }

  const { rows, truncatedRowCount } = normalizeRows(rawPayload.rows);
  if (truncatedRowCount > 0) {
    // audit T-09: surface truncation so consumers know the export is partial.
    validationErrors.push(`Row output truncated to ${MAX_ROWS} rows; ${truncatedRowCount} additional row(s) dropped.`);
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
  };
}

function escapeMarkdown(value: string): string {
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

  if (result.warnings && result.warnings.length > 0) {
    // audit T-05: warnings come from model output, so escape them too.
    sections.push('', '## Warnings', '', ...result.warnings.map((warning) => `- ${escapeMarkdown(warning)}`));
  }

  return sections.join('\n');
}

export function buildPresetCsv(result: PresetStructuredOutput, preset: ExtractionPreset): string | undefined {
  if (preset.outputShape !== 'table' || !result.rows || result.rows.length === 0) {
    return undefined;
  }

  const columns = preset.tableColumns && preset.tableColumns.length > 0
    ? preset.tableColumns
    : Object.keys(result.rows[0]);

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
    ...result.rows.map((row) => columns.map((column) => escapeCsv(row[column] ?? '')).join(',')),
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
      maxOutputTokens: 16384,
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
