import { AgentFunctionResult, AgentMemory, AgentMemoryUpdate } from './agentTypes';
import { mergeField, shouldReplaceField } from './agentMemory';
import { FunctionDeclaration } from '@google/genai';
import type { AgentClientConfig } from './agentTypes';
import {
  getAgentDocumentSchema,
  getAgentReadiness,
  normalizeAgentDocumentType,
  normalizeAgentFieldName,
} from './agentSchema';
import {
  applyThinkingConfig,
  assertCompleteGeminiResponse,
  generateContentMediaResolution,
  getGenAIClient,
  isFatalGeminiError,
  isRetryableGeminiError,
} from './gemini/client';
import type { GeminiModel } from './gemini/types';
import { parseJsonPayload } from './gemini/structured';
import { recordGeminiUsage } from './gemini/usage';
import { isGeminiCostLimitError, waitForGeminiRequestSlot } from './gemini/requestPolicy';
import { assertNormalizedRegion } from './normalizedRegion';

// Runtime validation helpers for Gemini function call args

function assertString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(`Expected non-empty string for "${key}", got ${typeof v}`);
  }
  return v;
}

function describeArgument(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function assertNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new TypeError(`Expected a finite confidence between 0 and 1 for "${key}", got ${describeArgument(v)}`);
  }
  return v;
}

function assertObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new TypeError(`Expected object for "${key}", got ${typeof v}`);
  }
  return v as Record<string, unknown>;
}

function assertArray(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new TypeError(`Expected non-empty array for "${key}", got ${typeof v}`);
  }

  return v.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Expected object at "${key}[${index}]", got ${typeof entry}`);
    }
    return entry as Record<string, unknown>;
  });
}

interface RawRegionFieldPayload {
  fields?: unknown;
}

function parseRegionFieldPayload(rawText: string): Record<string, unknown>[] {
  const parsed = parseJsonPayload<RawRegionFieldPayload>(rawText, 'Re-OCR');

  if (!Array.isArray(parsed.fields)) {
    throw new Error('Re-OCR response must include a "fields" array');
  }

  return parsed.fields.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Re-OCR response field at index ${index} is not an object`);
    }
    return entry as Record<string, unknown>;
  });
}

type ExtractedField = AgentMemory['extractedFields'][string];

interface BatchCandidate {
  field_name: string;
  rawFieldName: string;
  field: ExtractedField;
}

interface BatchReviewRound {
  acceptedFields: Record<string, ExtractedField>;
  reviews: Array<{ isValid: boolean; message: string }>;
}

/**
 * Field dependencies are shallow (a due date on the invoice date, a subtotal
 * on the item amounts), so the batch review settles in two or three rounds.
 * The cap only guards against a future check that never settles.
 */
const MAX_BATCH_REVIEW_ROUNDS = 8;

/**
 * One review round: every candidate is checked against the stored fields plus
 * the fields the previous round accepted, then merged with the deterministic
 * validity/confidence/recency reducer.
 */
function reviewBatchRound(
  candidates: readonly BatchCandidate[],
  memory: Readonly<AgentMemory>,
  previouslyAccepted: Record<string, ExtractedField>,
): BatchReviewRound {
  const acceptedFields: Record<string, ExtractedField> = {};
  const reviews = candidates.map(({ field_name, field }) => {
    // The same review applyCodeDrivenReviews runs later (format, consistency
    // and cross-reference) runs before the merge decision, so a value that
    // will be flagged invalid never replaces a known-valid one (A-13).
    const review = reviewField(field_name, field, {
      ...memory.extractedFields,
      ...previouslyAccepted,
      [field_name]: field,
    });
    const preparedField: ExtractedField = {
      ...field,
      isValid: review.isValid,
      validationMessage: review.message,
    };
    const currentField = Object.hasOwn(acceptedFields, field_name)
      ? acceptedFields[field_name]
      : Object.hasOwn(memory.extractedFields, field_name) ? memory.extractedFields[field_name] : undefined;
    if (!currentField || shouldReplaceField(currentField, preparedField)) {
      acceptedFields[field_name] = currentField ? mergeField(currentField, preparedField) : preparedField;
    }
    return review;
  });
  return { acceptedFields, reviews };
}

function sameReviews(left: BatchReviewRound, right: BatchReviewRound): boolean {
  return left.reviews.every((review, index) => (
    review.isValid === right.reviews[index].isValid && review.message === right.reviews[index].message
  ));
}

function normalizeStructuredFields(
  entries: Record<string, unknown>[],
  memory: Readonly<AgentMemory>,
) {
  const candidates: BatchCandidate[] = [];
  const extractedAt = Date.now();

  for (const [index, entry] of entries.entries()) {
    // One malformed entry still rejects the whole batch (memory is updated
    // atomically), but the error names which entry and field to fix, so the
    // model can resend a corrected batch instead of guessing.
    const entryLabel = typeof entry.field_name === 'string' && entry.field_name
      ? `fields[${index}] ("${entry.field_name}")`
      : `fields[${index}]`;
    const checked = <T>(read: () => T): T => {
      try {
        return read();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Invalid field entry ${entryLabel}: ${message}`, { cause: error });
      }
    };
    const rawFieldName = checked(() => assertString(entry, 'field_name'));
    const field_name = normalizeAgentFieldName(memory.documentAnalysis.documentType, rawFieldName);
    const field_value = checked(() => assertString(entry, 'field_value'));
    const confidence = checked(() => assertNumber(entry, 'confidence'));
    const validation_rule = typeof entry.validation_rule === 'string'
      ? entry.validation_rule
      : inferValidationRule(field_name);
    const location = typeof entry.location === 'object' && entry.location !== null
      ? checked(() => assertNormalizedRegion(entry.location, 'location'))
      : undefined;

    candidates.push({
      field_name,
      rawFieldName,
      field: { value: field_value, confidence, validation_rule, location, extractedAt },
    });
  }

  // Each candidate is reviewed against what this batch will store, not only
  // against the fields accepted earlier in it, so the order of the batch
  // cannot decide which values survive: a corrected due date sent before its
  // corrected invoice date is checked against the new invoice date. Rounds
  // repeat until the reviews stop changing; the last round was then checked
  // against exactly the fields it accepts.
  let round = reviewBatchRound(candidates, memory, {});
  for (let rounds = 1; rounds < MAX_BATCH_REVIEW_ROUNDS; rounds += 1) {
    const next = reviewBatchRound(candidates, memory, round.acceptedFields);
    const settled = sameReviews(round, next);
    round = next;
    if (settled) break;
  }

  const extractedSummaries: Array<Record<string, unknown>> = candidates.map(({ field_name, rawFieldName, field }, index) => ({
    field_name,
    original_field_name: rawFieldName,
    field_value: field.value,
    confidence: field.confidence,
    validation_rule: field.validation_rule,
    ...(field.location ? { location: field.location } : {}),
    isValid: round.reviews[index].isValid,
    validationMessage: round.reviews[index].message,
  }));

  return {
    acceptedFields: round.acceptedFields,
    extractedSummaries,
  };
}

export const AGENT_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: 're_ocr_region',
    description: 'Re-process a specific region of the document with higher focus to improve accuracy.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          description: 'Normalized region box for true region refinement.',
          properties: {
            page: { type: 'number', description: '1-based page number that contains the region.' },
            x: { type: 'number', description: 'Left edge of the region in normalized page coordinates (0-1).' },
            y: { type: 'number', description: 'Top edge of the region in normalized page coordinates (0-1).' },
            width: { type: 'number', description: 'Region width in normalized page coordinates (0-1).' },
            height: { type: 'number', description: 'Region height in normalized page coordinates (0-1).' },
            units: { type: 'string', enum: ['normalized'], description: 'Must always be "normalized".' },
          },
          required: ['page', 'x', 'y', 'width', 'height', 'units'],
        },
        focus: { type: 'string', description: 'Specific text or type of content to focus on within the region.' },
        target_fields: {
          type: 'array',
          description: 'Optional canonical field names that should be improved from this region.',
          items: { type: 'string' },
        },
        confidence_threshold: { type: 'number', description: 'The confidence threshold to aim for (0.0 to 1.0).' },
      },
      required: ['region', 'focus'],
    },
  },
  {
    name: 'extract_fields_batch',
    description: 'Extract all currently visible structured fields in one batch using canonical field names.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'The structured fields extracted from the document in this pass.',
          items: {
            type: 'object',
            properties: {
              field_name: { type: 'string', description: 'Canonical field name (e.g., "invoice_number", "customer_name").' },
              field_value: { type: 'string', description: 'The extracted value of the field.' },
              confidence: { type: 'number', description: 'The confidence score of the extraction (0.0 to 1.0).' },
              validation_rule: { type: 'string', description: 'Optional validation rule such as "email", "phone", "date", or "currency".' },
              location: {
                type: 'object',
                description: 'Optional normalized page region for this field.',
                properties: {
                  page: { type: 'number' },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  units: { type: 'string', enum: ['normalized'] },
                },
                required: ['page', 'x', 'y', 'width', 'height', 'units'],
              },
            },
            required: ['field_name', 'field_value', 'confidence'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'analyze_document_structure',
    description: 'Analyze the overall structure and layout of the document.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        document_type: { type: 'string', description: 'The identified type of the document (e.g., "invoice", "resume", "report").' },
        layout_analysis: {
          type: 'object',
          description: 'A description of the document layout (e.g., columns, sections, tables).',
          properties: {
            features: {
              type: 'array',
              description: 'Notable layout features, one per entry (e.g., "two columns", "line-item table", "header logo").',
              items: { type: 'string' },
            },
            specialFeatures: {
              type: 'array',
              description: 'Content that needs special care (e.g., "handwriting", "signature", "stamp", "rotated text").',
              items: { type: 'string' },
            },
          },
        },
        extraction_strategy: { type: 'string', description: 'The recommended strategy for extraction (e.g., "form-based", "table-based", "full-text").' },
        confidence: { type: 'number', description: 'The confidence in the analysis (0.0 to 1.0).' },
      },
      required: ['document_type', 'layout_analysis', 'extraction_strategy', 'confidence'],
    },
  },
];

/**
 * Tool implementations for agent function calls
 */

/**
 * Re-process a specific region of the document with higher focus
 */
export async function executeReOcrRegion(
  args: Record<string, unknown>,
  fileData: string,
  mimeType: string,
  memory: Readonly<AgentMemory>,
  clientConfig: AgentClientConfig,
): Promise<AgentFunctionResult> {
  try {
    const region = assertNormalizedRegion(args.region);
    const focus = assertString(args, 'focus');
    const explicitTargetFields = Array.isArray(args.target_fields)
      ? args.target_fields.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const confidence_threshold = args.confidence_threshold === undefined
      ? 0.7
      : assertNumber(args, 'confidence_threshold');
    const readiness = getAgentReadiness(memory);
    const targetFields = explicitTargetFields.length > 0
      ? explicitTargetFields
      : readiness.missingRequiredFields;
    const schema = getAgentDocumentSchema(memory.documentAnalysis.documentType);
    if (!clientConfig.regionCropper) {
      throw new Error('Region refinement is not configured for this runtime');
    }
    const croppedRegion = await clientConfig.regionCropper(fileData, mimeType, region, clientConfig.abortSignal);
    const base64Data = croppedRegion.dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error('Failed to generate cropped region image for refinement');
    }
    const responseSchema: Record<string, unknown> = {
      type: 'object',
      additionalProperties: false,
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field_name', 'field_value', 'confidence'],
            properties: {
              field_name: { type: 'string' },
              field_value: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              validation_rule: { type: 'string' },
              location: {
                type: 'object',
                additionalProperties: false,
                required: ['page', 'x', 'y', 'width', 'height', 'units'],
                properties: {
                  page: { type: 'integer', minimum: 1 },
                  x: { type: 'number', minimum: 0, maximum: 1 },
                  y: { type: 'number', minimum: 0, maximum: 1 },
                  width: { type: 'number', minimum: 0, maximum: 1 },
                  height: { type: 'number', minimum: 0, maximum: 1 },
                  units: { type: 'string', enum: ['normalized'] },
                },
              },
            },
          },
        },
      },
    };
    const prompt = [
      'Return valid JSON only.',
      'Do not wrap the JSON in markdown fences.',
      'You are re-reading a specific region of a document to recover structured field values.',
      'Respond with {"fields":[{"field_name":"string","field_value":"string","confidence":0.0,"validation_rule":"string","location":{"page":1,"x":0.1,"y":0.1,"width":0.2,"height":0.1,"units":"normalized"}}]}.',
      `This cropped image is from page ${region.page} of the original document.`,
      `Region coordinates in the original document: ${JSON.stringify(region)}.`,
      `Prioritize this focus instruction: ${focus}.`,
      `Document type: ${normalizeAgentDocumentType(memory.documentAnalysis.documentType)}.`,
      schema
        ? `Canonical fields for this document type: ${[...schema.requiredFields, ...schema.optionalFields].join(', ')}.`
        : 'Use concise canonical field names if the document type is still unknown.',
      targetFields.length > 0
        ? `Target fields to recover from this region: ${targetFields.join(', ')}.`
        : 'Recover any high-value structured fields visible in this region.',
      'Only return fields you can see in this region.',
      `Every field confidence must be >= ${confidence_threshold.toFixed(2)} to be worth returning.`,
      'If no useful structured fields are visible, return {"fields":[]}.',
    ].join(' ');

    let rawResponseText: string;
    if (clientConfig.regionStructuredExtractor) {
      const value = await clientConfig.regionStructuredExtractor(
        croppedRegion.dataUrl,
        croppedRegion.mimeType,
        responseSchema,
        prompt,
        clientConfig.abortSignal,
      );
      rawResponseText = typeof value === 'string' ? value : JSON.stringify(value);
    } else {
      const generationConfig = applyThinkingConfig({
        maxOutputTokens: 8192,
        // Each continuation hop re-bills the input and runs inside one SDK call,
        // past --max-cost; a CONTINUATION stop is reported as truncated output.
        automaticContinuation: false,
        responseMimeType: 'application/json',
        responseJsonSchema: responseSchema,
        mediaResolution: generateContentMediaResolution(croppedRegion.mimeType),
        ...(clientConfig.abortSignal ? { abortSignal: clientConfig.abortSignal } : {}),
      }, clientConfig.model as GeminiModel, clientConfig.thinkingConfig);
      const genAI = getGenAIClient(clientConfig.apiKey, {
        baseUrl: clientConfig.baseUrl,
        headers: clientConfig.headers,
      });
      await waitForGeminiRequestSlot(clientConfig.abortSignal, clientConfig.runtime);
      const response = await genAI.models.generateContent({
        model: clientConfig.model,
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: croppedRegion.mimeType,
                data: base64Data,
              },
            },
          ],
        }],
        config: generationConfig,
      });
      recordGeminiUsage(response, clientConfig.model as GeminiModel, clientConfig.runtime);
      assertCompleteGeminiResponse(response, 'Region re-OCR');
      rawResponseText = response.text || '';
    }

    const rawFields = parseRegionFieldPayload(rawResponseText);
    const filteredFields = rawFields.filter((entry) => {
      const entryConfidence = typeof entry.confidence === 'number' ? entry.confidence : 0;
      return entryConfidence >= confidence_threshold;
    });
    // The model only ever saw the CROPPED image, so any location it returns is
    // crop-relative and meaningless in the original document frame. It is dropped
    // before validation (a crop-relative box must not fail the paid batch), and
    // each recovered field's location is set to the known original-frame region
    // so a later re_ocr_region re-crops the correct area instead of a wrong one.
    const { acceptedFields, extractedSummaries } = normalizeStructuredFields(
      filteredFields.map(({ location: _cropRelativeLocation, ...entry }) => entry),
      memory,
    );
    for (const field of Object.values(acceptedFields)) {
      field.location = region;
    }

    const simulatedFields = { ...memory.extractedFields, ...acceptedFields };
    applyCodeDrivenReviews(simulatedFields);
    const updatedReadiness = getAgentReadiness({
      documentAnalysis: memory.documentAnalysis,
      extractedFields: simulatedFields,
    });

    return {
      success: true,
      data: {
        region,
        focus,
        targetFields,
        fieldCandidates: extractedSummaries.map((summary) => ({ ...summary, location: region })),
        fieldCount: Object.keys(acceptedFields).length,
        confidenceThreshold: confidence_threshold,
        crop: {
          mimeType: croppedRegion.mimeType,
          width: croppedRegion.width,
          height: croppedRegion.height,
        },
      },
      memoryUpdate: {
        extractedFields: acceptedFields,
        fieldReviews: fieldReviews(simulatedFields),
        confidence: updatedReadiness.averageConfidence,
        processingHistoryItem: {
          type: 'function_call',
          content: `Re-OCR recovered ${Object.keys(acceptedFields).length} fields from page ${region.page}, region ${JSON.stringify(region)}`,
          functionCall: { name: 're_ocr_region', arguments: args },
          functionResult: {
            success: true,
            data: {
              fieldCount: Object.keys(acceptedFields).length,
              recoveredFields: Object.keys(acceptedFields),
              missingRequiredFields: updatedReadiness.missingRequiredFields,
            }
          },
          timestamp: Date.now(),
        }
      }
    };
  } catch (error) {
    // Surface API-level failures so the agent loop stops (terminal) or backs off
    // and retries (transient) instead of looping against the endpoint (H-17).
    if (
      clientConfig.abortSignal?.aborted
      || isGeminiCostLimitError(error)
      || isFatalGeminiError(error)
      || isRetryableGeminiError(error)
      || (error instanceof Error && (error.name === 'AbortError' || error.name === 'ProviderApiError'))
    ) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Re-OCR failed',
    };
  }
}

/**
 * Extract and validate a batch of fields.
 */
export function executeExtractFieldsBatch(
  args: Record<string, unknown>,
  _fileData: string,
  _mimeType: string,
  memory: Readonly<AgentMemory>
): Promise<AgentFunctionResult> {
  try {
    const batch = assertArray(args, 'fields');
    const { acceptedFields, extractedSummaries } = normalizeStructuredFields(batch, memory);
    const simulatedFields = { ...memory.extractedFields, ...acceptedFields };
    applyCodeDrivenReviews(simulatedFields);
    const readiness = getAgentReadiness({
      documentAnalysis: memory.documentAnalysis,
      extractedFields: simulatedFields,
    });

    return Promise.resolve({
      success: true,
      data: {
        fieldCount: Object.keys(acceptedFields).length,
        fields: extractedSummaries,
        requiredCoverage: readiness.requiredCoverage,
        missingRequiredFields: readiness.missingRequiredFields,
      },
      memoryUpdate: {
        extractedFields: acceptedFields,
        fieldReviews: fieldReviews(simulatedFields),
        confidence: readiness.averageConfidence,
        processingHistoryItem: {
          type: 'function_call',
          content: `Batch extracted ${Object.keys(acceptedFields).length} fields`,
          functionCall: { name: 'extract_fields_batch', arguments: args },
          functionResult: {
            success: true,
            data: {
              fieldCount: Object.keys(acceptedFields).length,
              requiredCoverage: readiness.requiredCoverage,
              missingRequiredFields: readiness.missingRequiredFields,
            }
          },
          timestamp: Date.now(),
        }
      }
    });
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: error instanceof Error ? error.message : 'Batch field extraction failed',
    });
  }
}

/**
 * Analyze document structure
 */
export function executeAnalyzeDocumentStructure(
  args: Record<string, unknown>,
  _fileData: string,
  _mimeType: string,
  memory: Readonly<AgentMemory>
): Promise<AgentFunctionResult> {
  try {
    const document_type = normalizeAgentDocumentType(assertString(args, 'document_type'));
    const layout_analysis = assertObject(args, 'layout_analysis');
    const extraction_strategy = assertString(args, 'extraction_strategy');
    const confidence = assertNumber(args, 'confidence');
    const schema = getAgentDocumentSchema(document_type);

    // New document analysis state
    const newDocumentAnalysis = {
      pageCount: memory.documentAnalysis.pageCount,
      documentType: document_type,
      complexity: determineComplexity(layout_analysis),
      specialFeatures: extractSpecialFeatures(layout_analysis),
    };

    return Promise.resolve({
      success: true,
      data: {
        document_type,
        layout_analysis,
        extraction_strategy,
        confidence,
        required_fields: schema?.requiredFields ?? [],
        optional_fields: schema?.optionalFields ?? [],
        complexity: newDocumentAnalysis.complexity,
        specialFeatures: newDocumentAnalysis.specialFeatures,
      },
      memoryUpdate: {
        documentAnalysis: newDocumentAnalysis,
        processingHistoryItem: {
          type: 'function_call',
          content: `Document structure analyzed: ${document_type}`,
          functionCall: { name: 'analyze_document_structure', arguments: args },
          functionResult: { success: true, data: { document_type, extraction_strategy, confidence } },
          timestamp: Date.now(),
        }
      }
    });
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: error instanceof Error ? error.message : 'Document analysis failed',
    });
  }
}

// Helper functions

/**
 * Parse a possibly-formatted numeric/currency string into a number, tolerating
 * currency symbols, whitespace, and thousands separators in common locales.
 * Returns null when the value is not a usable number so callers can SKIP a
 * consistency check rather than treat an unparseable value as 0 — the previous
 * `parseFloat(value) || 0` silently coerced NaN to 0 and produced false
 * "inconsistent total" flags (audit A-14).
 */
function parseNumeric(value: string): number | null {
  let cleaned = String(value).replace(/[^\d.,-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  // A trailing minus marks a credit ("150.00-").
  if (cleaned.endsWith('-') && !cleaned.startsWith('-')) cleaned = `-${cleaned.slice(0, -1)}`;
  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let normalized: string;
  if (hasDot && hasComma) {
    // Whichever separator appears last is the decimal separator.
    normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    // A lone comma is a decimal separator unless it groups exactly 3 digits.
    normalized = /,\d{3}\b/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  } else {
    // Repeated dots followed by groups of three digits are grouping ("1.234.567").
    normalized = /^-?\d{1,3}(?:\.\d{3}){2,}$/.test(cleaned) ? cleaned.replace(/\./g, '') : cleaned;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** English month names and abbreviations, read from this table (never Date.parse). */
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(MONTH_NUMBERS, key) ? MONTH_NUMBERS[key] : undefined;
}

/** "2026-01-15", "2026/01/15", "2026.1.5", ISO 8601 with time, fraction and zone. */
const YEAR_FIRST_DATE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
/** "15.01.2026" (day first), "31/12/2026" or "12-31-2026" (either order). */
const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** "Mar 3, 2026", "March 3rd 2026". */
const MONTH_FIRST_NAMED_DATE = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i;
/** "3 March 2026", "3rd of March, 2026", "03-Mar-2026". */
const DAY_FIRST_NAMED_DATE = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:of\s+)?|-)([a-z]{3,9})\.?(?:,?\s+|-)(\d{4})$/i;
const UTC_OFFSET = /^(?:Z|[+-](?:0\d|1[0-4])(?::?[0-5]\d)?)$/i;

interface DateReadings {
  readings: Array<{ year: number; month: number; day: number }>;
  time: Array<string | undefined>;
  zone?: string;
}

function dateReadings(text: string): DateReadings | null {
  let match = YEAR_FIRST_DATE.exec(text);
  if (match) {
    return {
      readings: [{ year: Number(match[1]), month: Number(match[3]), day: Number(match[4]) }],
      time: match.slice(5, 8),
      zone: match[8],
    };
  }
  match = NUMERIC_DATE.exec(text);
  if (match) {
    const year = Number(match[4]);
    const first = Number(match[1]);
    const second = Number(match[3]);
    const dayFirst = { year, month: second, day: first };
    // A dotted date is day-first; "/" and "-" dates keep both readings.
    return {
      readings: match[2] === '.' ? [dayFirst] : [{ year, month: first, day: second }, dayFirst],
      time: match.slice(5, 8),
    };
  }
  match = MONTH_FIRST_NAMED_DATE.exec(text);
  const monthFirst = match ? monthNumber(match[1]) : undefined;
  if (match && monthFirst) {
    return { readings: [{ year: Number(match[3]), month: monthFirst, day: Number(match[2]) }], time: [] };
  }
  match = DAY_FIRST_NAMED_DATE.exec(text);
  const dayFirstMonth = match ? monthNumber(match[2]) : undefined;
  if (match && dayFirstMonth) {
    return { readings: [{ year: Number(match[3]), month: dayFirstMonth, day: Number(match[1]) }], time: [] };
  }
  return null;
}

/**
 * Parse supported dates without depending on host locale or Date.parse. Every
 * reading that is a real calendar date is returned, so an ambiguous
 * "04/03/2026" yields two candidates instead of a guess. A UTC offset is
 * checked but not applied: documents are compared by their printed date.
 */
function dateCandidates(value: string): number[] {
  const parsed = dateReadings(value.trim());
  if (!parsed) return [];
  const [hour = 0, minute = 0, seconds = 0] = parsed.time.map((part) => Number(part ?? 0));
  if (hour > 23 || minute > 59 || seconds > 59) return [];
  if (parsed.zone !== undefined && !UTC_OFFSET.test(parsed.zone)) return [];
  const candidates: number[] = [];
  for (const { year, month, day } of parsed.readings) {
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, seconds, 0);
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      candidates.push(date.getTime());
    }
  }
  return [...new Set(candidates)];
}

/**
 * Validate field value based on validation rule
 */
function validateFieldValue(value: string, rule: string): { isValid: boolean; message: string } {
  switch (rule) {
    case 'email': {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return {
        isValid: emailRegex.test(value),
        message: emailRegex.test(value) ? 'Valid email format' : 'Invalid email format',
      };
    }
    case 'phone': {
      const phoneRegex = /^\+?[\d\s\-()]+$/;
      return {
        isValid: phoneRegex.test(value) && value.replace(/\D/g, '').length >= 10,
        message: phoneRegex.test(value) ? 'Valid phone format' : 'Invalid phone format',
      };
    }
    case 'date': {
      const isValid = dateCandidates(value).length > 0;
      return {
        isValid,
        message: isValid ? 'Valid date' : 'Invalid date or time',
      };
    }
    case 'currency': {
      // Accept locale-formatted amounts ("$1,234.56", "€10", "1.234,50") via a
      // tolerant parser rather than a US-only regex (audit A-14).
      const isValid = parseNumeric(value) !== null;
      return {
        isValid,
        message: isValid ? 'Valid currency format' : 'Invalid currency format',
      };
    }
    case 'number': {
      const isValid = parseNumeric(value) !== null;
      return {
        isValid,
        message: isValid ? 'Valid number format' : 'Invalid number format',
      };
    }
    default:
      return { isValid: true, message: 'No validation rule applied' };
  }
}

/**
 * Field-name words. Whole words are matched, never substrings, which would
 * read "candidate" or "mandate" as a date and "taxpayer" as an amount.
 */
function fieldTokens(fieldName: string): string[] {
  return fieldName.toLowerCase().split('_').filter(Boolean);
}

function isDateField(fieldName: string): boolean {
  const tokens = fieldTokens(fieldName);
  return tokens.includes('date') || tokens.includes('dob');
}

const AMOUNT_TOKENS = new Set(['amount', 'total', 'subtotal', 'tax']);
const NON_AMOUNT_TOKENS = new Set(['id', 'number', 'name', 'exempt', 'payer', 'rate']);

function isCurrencyField(fieldName: string): boolean {
  const tokens = fieldTokens(fieldName);
  return tokens.some((token) => AMOUNT_TOKENS.has(token)) && !tokens.some((token) => NON_AMOUNT_TOKENS.has(token));
}

function isPhoneField(fieldName: string): boolean {
  const tokens = fieldTokens(fieldName);
  return tokens.some((token) => token === 'phone' || token === 'mobile' || token === 'telephone')
    && !tokens.includes('type');
}

function inferValidationRule(fieldName: string): string | undefined {
  if (fieldTokens(fieldName).includes('email')) return 'email';
  if (isPhoneField(fieldName)) return 'phone';
  if (isDateField(fieldName)) return 'date';
  if (isCurrencyField(fieldName)) return 'currency';
  return undefined;
}

function fieldReviews(
  fields: Record<string, AgentMemory['extractedFields'][string]>,
): NonNullable<AgentMemoryUpdate['fieldReviews']> {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, {
    value: field.value,
    isValid: field.isValid !== false,
    validationMessage: field.validationMessage,
  }]));
}

/** Rules validateFieldValue checks; any other rule (e.g. "text") checks nothing. */
const RECOGNIZED_VALIDATION_RULES = new Set(['email', 'phone', 'date', 'currency', 'number']);

/**
 * The full runtime review of one field value against the other fields: the
 * format check, then the consistency and cross-reference checks. A recognized
 * rule (explicit or inferred from the name) decides the format check, so a
 * passing explicit rule is not overridden by the field name.
 */
function reviewField(
  fieldName: string,
  field: ExtractedField,
  fields: Record<string, ExtractedField>,
): { isValid: boolean; message: string } {
  const reviewMemory = {
    extractedFields: fields,
  } as Readonly<AgentMemory>;
  const formatResult = field.validation_rule && RECOGNIZED_VALIDATION_RULES.has(field.validation_rule)
    ? validateFieldValue(field.value, field.validation_rule)
    : validateFieldFormat(field.value, fieldName);
  const consistencyResult = validateFieldConsistency(field.value, fieldName, reviewMemory);
  const crossReferenceResult = validateFieldCrossReference(field.value, fieldName, reviewMemory);

  const failedReview = !formatResult.isValid
    ? formatResult
    : !consistencyResult.isValid
      ? consistencyResult
    : !crossReferenceResult.isValid
      ? crossReferenceResult
      : null;
  return failedReview ?? formatResult;
}

function applyCodeDrivenReviews(fields: Record<string, ExtractedField>): void {
  for (const [fieldName, field] of Object.entries(fields)) {
    const review = reviewField(fieldName, field, fields);
    fields[fieldName] = {
      ...field,
      isValid: review.isValid,
      validationMessage: review.message,
    };
  }
}

/**
 * Validate field format
 */
function validateFieldFormat(value: string, fieldName: string): { isValid: boolean; message: string } {
  // Basic format validation based on the words in the field name
  const rule = inferValidationRule(fieldName);
  return rule ? validateFieldValue(value, rule) : { isValid: true, message: 'Format validation passed' };
}

/**
 * Validate field consistency with other fields
 */
function validateFieldConsistency(value: string, fieldName: string, memory: Readonly<AgentMemory>): { isValid: boolean; message: string } {
  // A grand total may include tax, shipping, discounts, or adjustments not yet
  // extracted. Only a subtotal with an explicitly complete set of indexed
  // item amounts can support a deterministic sum check. Descriptions and
  // quantities containing digits are never interpreted as monetary amounts.
  if (fieldName !== 'subtotal_amount' && fieldName !== 'subtotal') {
    return { isValid: true, message: 'Consistency validation passed' };
  }
  const fields = memory.extractedFields;
  const rawCount = fields.line_item_count ?? fields.line_items_count ?? fields.item_count;
  const count = rawCount ? parseNumeric(rawCount.value) : null;
  if (count === null || !Number.isInteger(count) || count < 1 || count > 1000) {
    return { isValid: true, message: 'Item completeness is not established' };
  }
  const items = new Map<number, number>();
  for (const [name, field] of Object.entries(fields)) {
    const match = /^(?:line_)?item_(\d+)_(?:amount|total)$/.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    const amount = parseNumeric(field.value);
    if (amount === null || items.has(index)) return { isValid: true, message: 'Item amounts are ambiguous' };
    items.set(index, amount);
  }
  const subtotal = parseNumeric(value);
  if (subtotal !== null && items.size === count && Array.from({ length: count }, (_, index) => items.has(index + 1)).every(Boolean)) {
    const sum = [...items.values()].reduce((total, amount) => total + amount, 0);
    const isValid = Math.abs(sum - subtotal) < 0.05;
    return { isValid, message: isValid ? 'Subtotal matches item amounts' : 'Subtotal does not match the complete item amounts' };
  }

  return { isValid: true, message: 'Consistency validation passed' };
}

/**
 * Validate field cross-reference
 */
function validateFieldCrossReference(value: string, fieldName: string, memory: Readonly<AgentMemory>): { isValid: boolean; message: string } {
  const existingFields = memory.extractedFields;

  // Date Cross-References
  if (isDateField(fieldName)) {
    const currentDates = dateCandidates(value);
    if (currentDates.length === 0) {
      return { isValid: false, message: 'Invalid date or time' };
    }

    // Check Due Date vs Invoice Date
    if (fieldTokens(fieldName).includes('due')) {
      const invoiceDateField = Object.entries(existingFields).find(([key]) => fieldTokens(key).includes('invoice') && isDateField(key));
      if (invoiceDateField) {
        const invoiceDates = dateCandidates(invoiceDateField[1].value);
        // Ambiguous numeric dates are not guessed: reject only when no
        // supported interpretation can put the due date after the invoice.
        if (invoiceDates.length > 0 && Math.max(...currentDates) < Math.min(...invoiceDates)) {
          return { isValid: false, message: 'Due date cannot be before invoice date' };
        }
      }
    }
  }

  return { isValid: true, message: 'Cross-reference validation passed' };
}

/**
 * Determine document complexity
 */
function determineComplexity(layoutAnalysis: Record<string, unknown>): 'low' | 'medium' | 'high' {
  // Simple heuristic - can be made more sophisticated
  const features = Array.isArray(layoutAnalysis?.features) ? layoutAnalysis.features : [];
  if (features.length > 10) return 'high';
  if (features.length > 5) return 'medium';
  return 'low';
}

/**
 * Extract special features from layout analysis
 */
function extractSpecialFeatures(layoutAnalysis: Record<string, unknown>): string[] {
  // Extract special features from layout analysis
  const features = layoutAnalysis?.specialFeatures;
  return Array.isArray(features)
    ? features.filter((feature): feature is string => typeof feature === 'string')
    : [];
}
