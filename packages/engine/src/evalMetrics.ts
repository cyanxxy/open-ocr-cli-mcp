export type EvalMetricName =
  | 'cer'
  | 'normalized_cer'
  | 'wer'
  | 'normalized_edit_similarity'
  | 'text_coverage'
  | 'unsupported_text_rate'
  | 'field_precision'
  | 'field_recall'
  | 'field_f1'
  | 'critical_field_exact_match'
  | 'table_cell_f1'
  | 'unit_test_pass_rate';

export type EvalMetricScores = Partial<Record<EvalMetricName, number>>;

export interface FieldMetricOptions {
  criticalFields?: string[];
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function levenshteinDistance<T>(reference: readonly T[], prediction: readonly T[]): number {
  if (reference.length === 0) return prediction.length;
  if (prediction.length === 0) return reference.length;

  let previous = Array.from({ length: prediction.length + 1 }, (_, index) => index);

  for (let referenceIndex = 1; referenceIndex <= reference.length; referenceIndex += 1) {
    const current = [referenceIndex];
    for (let predictionIndex = 1; predictionIndex <= prediction.length; predictionIndex += 1) {
      const substitutionCost = reference[referenceIndex - 1] === prediction[predictionIndex - 1] ? 0 : 1;
      current[predictionIndex] = Math.min(
        current[predictionIndex - 1] + 1,
        previous[predictionIndex] + 1,
        previous[predictionIndex - 1] + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[prediction.length];
}

/** Convert display Markdown into comparable OCR text without discarding content. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+] |\d+[.)] )/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function normalizeOcrText(value: string): string {
  return markdownToPlainText(value)
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function tokenize(value: string): string[] {
  const normalized = normalizeOcrText(value);
  return normalized ? normalized.split(' ') : [];
}

function multisetOverlap(reference: readonly string[], prediction: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of reference) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const token of prediction) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  }
  return overlap;
}

export function scoreOcrText(referenceText: string, predictionMarkdown: string): EvalMetricScores {
  const strictReference = referenceText.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const strictPrediction = markdownToPlainText(predictionMarkdown).normalize('NFC').trim();
  const normalizedReference = normalizeOcrText(referenceText);
  const normalizedPrediction = normalizeOcrText(predictionMarkdown);
  const referenceTokens = tokenize(referenceText);
  const predictionTokens = tokenize(predictionMarkdown);

  const strictDistance = levenshteinDistance([...strictReference], [...strictPrediction]);
  const normalizedDistance = levenshteinDistance([...normalizedReference], [...normalizedPrediction]);
  const wordDistance = levenshteinDistance(referenceTokens, predictionTokens);
  const overlap = multisetOverlap(referenceTokens, predictionTokens);
  const similarityDenominator = Math.max(normalizedReference.length, normalizedPrediction.length, 1);

  return {
    cer: strictReference.length === 0 ? (strictPrediction.length === 0 ? 0 : 1) : strictDistance / strictReference.length,
    normalized_cer: normalizedReference.length === 0
      ? (normalizedPrediction.length === 0 ? 0 : 1)
      : normalizedDistance / normalizedReference.length,
    wer: referenceTokens.length === 0 ? (predictionTokens.length === 0 ? 0 : 1) : wordDistance / referenceTokens.length,
    normalized_edit_similarity: clampUnit(1 - (normalizedDistance / similarityDenominator)),
    text_coverage: referenceTokens.length === 0 ? 1 : overlap / referenceTokens.length,
    unsupported_text_rate: predictionTokens.length === 0 ? 0 : 1 - (overlap / predictionTokens.length),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapFieldValue(value: unknown): unknown {
  if (isRecord(value) && 'value' in value) {
    return value.value;
  }
  return value;
}

function isEmptyValue(value: unknown): boolean {
  const unwrapped = unwrapFieldValue(value);
  if (unwrapped == null) return true;
  if (typeof unwrapped === 'string') return unwrapped.trim() === '';
  if (Array.isArray(unwrapped)) return unwrapped.length === 0;
  return false;
}

function canonicalValue(value: unknown): string {
  const unwrapped = unwrapFieldValue(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map(canonicalValue).sort().join('|');
  }
  if (isRecord(unwrapped)) {
    return Object.entries(unwrapped)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${normalizeOcrText(key)}:${canonicalValue(entry)}`)
      .join('|');
  }
  if (typeof unwrapped === 'number') return String(unwrapped);
  if (typeof unwrapped === 'boolean') return String(unwrapped);
  if (typeof unwrapped === 'string') return normalizeOcrText(unwrapped);
  if (typeof unwrapped === 'bigint' || typeof unwrapped === 'symbol') return normalizeOcrText(String(unwrapped));
  return '';
}

export function scoreFields(
  referenceFields: unknown,
  predictionFields: unknown,
  options: FieldMetricOptions = {},
): EvalMetricScores {
  const reference = isRecord(referenceFields) ? referenceFields : {};
  const prediction = isRecord(predictionFields) ? predictionFields : {};
  const referenceKeys = Object.keys(reference).filter((key) => !isEmptyValue(reference[key]));
  const predictionKeys = Object.keys(prediction).filter((key) => !isEmptyValue(prediction[key]));
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const key of predictionKeys) {
    if (key in reference && canonicalValue(prediction[key]) === canonicalValue(reference[key])) {
      truePositives += 1;
    } else {
      falsePositives += 1;
    }
  }

  for (const key of referenceKeys) {
    if (!(key in prediction) || canonicalValue(prediction[key]) !== canonicalValue(reference[key])) {
      falseNegatives += 1;
    }
  }

  const precision = truePositives + falsePositives === 0 ? (referenceKeys.length === 0 ? 1 : 0) : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const criticalFields = options.criticalFields ?? [];
  const criticalMatches = criticalFields.filter(
    (key) => key in reference && key in prediction && canonicalValue(prediction[key]) === canonicalValue(reference[key]),
  ).length;

  return {
    field_precision: precision,
    field_recall: recall,
    field_f1: f1,
    critical_field_exact_match: criticalFields.length === 0 ? 1 : criticalMatches / criticalFields.length,
  };
}

function tableCellTokens(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (Array.isArray(row)) {
      return row.map((value, index) => `${index}:${canonicalValue(value)}`);
    }
    if (isRecord(row)) {
      return Object.entries(row).map(([key, value]) => `${normalizeOcrText(key)}:${canonicalValue(value)}`);
    }
    return [];
  }).filter((token) => !token.endsWith(':'));
}

export function scoreTableCells(referenceRows: unknown, predictionRows: unknown): EvalMetricScores {
  const referenceTokens = tableCellTokens(referenceRows);
  const predictionTokens = tableCellTokens(predictionRows);
  const overlap = multisetOverlap(referenceTokens, predictionTokens);
  const precision = predictionTokens.length === 0 ? (referenceTokens.length === 0 ? 1 : 0) : overlap / predictionTokens.length;
  const recall = referenceTokens.length === 0 ? 1 : overlap / referenceTokens.length;

  return {
    table_cell_f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}
