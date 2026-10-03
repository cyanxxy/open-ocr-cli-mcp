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

function assertNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new TypeError(`Expected a finite confidence between 0 and 1 for "${key}"`);
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

function normalizeStructuredFields(
  entries: Record<string, unknown>[],
  memory: Readonly<AgentMemory>,
) {
  const acceptedFields: Record<string, AgentMemory['extractedFields'][string]> = {};
  const extractedSummaries: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    const rawFieldName = assertString(entry, 'field_name');
    const field_name = normalizeAgentFieldName(memory.documentAnalysis.documentType, rawFieldName);
    const field_value = assertString(entry, 'field_value');
    const confidence = assertNumber(entry, 'confidence');
    const validation_rule = typeof entry.validation_rule === 'string'
      ? entry.validation_rule
      : inferValidationRule(field_name);
    const location = typeof entry.location === 'object' && entry.location !== null
      ? assertNormalizedRegion(entry.location, 'location')
      : undefined;

    const validationResult = validation_rule
      ? validateFieldValue(field_value, validation_rule)
      : validateFieldFormat(field_value, field_name);

    const preparedField = {
      value: field_value,
      confidence,
      validation_rule,
      location,
      isValid: validationResult.isValid,
      validationMessage: validationResult.message,
      extractedAt: Date.now(),
    };

    const currentField = Object.hasOwn(acceptedFields, field_name)
      ? acceptedFields[field_name]
      : Object.hasOwn(memory.extractedFields, field_name) ? memory.extractedFields[field_name] : undefined;
    if (!currentField || shouldReplaceField(currentField, preparedField)) {
      acceptedFields[field_name] = currentField ? mergeField(currentField, preparedField) : preparedField;
    }

    extractedSummaries.push({
      field_name,
      original_field_name: rawFieldName,
      field_value,
      confidence,
      validation_rule,
      ...(location ? { location } : {}),
      isValid: validationResult.isValid,
      validationMessage: validationResult.message,
    });
  }

  return {
    acceptedFields,
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
        layout_analysis: { type: 'object', description: 'A description of the document layout (e.g., columns, sections, tables).' },
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
    const croppedRegion = await clientConfig.regionCropper(fileData, mimeType, region);
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
    const { acceptedFields, extractedSummaries } = normalizeStructuredFields(filteredFields, memory);

    // The model only ever saw the CROPPED image, so any location it returns is
    // crop-relative — meaningless in the original document frame. Overwrite each
    // recovered field's location with the known original-frame region so a later
    // re_ocr_region re-crops the correct area instead of a wrong one.
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
        fieldCandidates: extractedSummaries,
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
  const cleaned = String(value).replace(/[^\d.,-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
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
    normalized = cleaned;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse supported numeric dates without depending on host locale or Date.parse. */
function dateCandidates(value: string): number[] {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  const numeric = /^(\d{2})([/-])(\d{2})\2(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!iso && !numeric) return [];
  const year = Number(iso?.[1] ?? numeric?.[4]);
  const first = Number(iso?.[2] ?? numeric?.[1]);
  const second = Number(iso?.[3] ?? numeric?.[3]);
  const hour = Number(iso?.[4] ?? numeric?.[5] ?? 0);
  const minute = Number(iso?.[5] ?? numeric?.[6] ?? 0);
  const seconds = Number(iso?.[6] ?? numeric?.[7] ?? 0);
  if (hour > 23 || minute > 59 || seconds > 59) return [];
  const pairs = iso ? [[first, second]] : [[first, second], [second, first]];
  const candidates: number[] = [];
  for (const [month, day] of pairs) {
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

function inferValidationRule(fieldName: string): string | undefined {
  const lowerFieldName = fieldName.toLowerCase();

  if (lowerFieldName.includes('email')) return 'email';
  if (lowerFieldName.includes('phone')) return 'phone';
  if (lowerFieldName.includes('date')) return 'date';
  if (
    lowerFieldName.includes('amount')
    || lowerFieldName === 'total'
    || lowerFieldName === 'subtotal'
    || lowerFieldName.includes('tax')
  ) {
    return 'currency';
  }

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

function applyCodeDrivenReviews(fields: Record<string, AgentMemory['extractedFields'][string]>): void {
  const reviewMemory = {
    extractedFields: fields,
  } as Readonly<AgentMemory>;

  for (const [fieldName, field] of Object.entries(fields)) {
    const explicitRule = field.validation_rule
      ? validateFieldValue(field.value, field.validation_rule)
      : undefined;
    const formatResult = explicitRule?.isValid === false
      ? explicitRule
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

    fields[fieldName] = {
      ...field,
      isValid: failedReview === null,
      validationMessage: failedReview
        ? failedReview.message
        : formatResult.message,
    };
  }
}

/**
 * Validate field format
 */
function validateFieldFormat(value: string, fieldName: string): { isValid: boolean; message: string } {
  // Basic format validation based on field name patterns
  if (fieldName.toLowerCase().includes('email')) {
    return validateFieldValue(value, 'email');
  } else if (fieldName.toLowerCase().includes('phone')) {
    return validateFieldValue(value, 'phone');
  } else if (fieldName.toLowerCase().includes('date')) {
    return validateFieldValue(value, 'date');
  } else if (fieldName.toLowerCase().includes('amount') || fieldName.toLowerCase().includes('total')) {
    return validateFieldValue(value, 'currency');
  }
  
  return { isValid: true, message: 'Format validation passed' };
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
  const lowerFieldName = fieldName.toLowerCase();

  // Date Cross-References
  if (lowerFieldName.includes('date')) {
    const currentDates = dateCandidates(value);
    if (currentDates.length === 0) {
      return { isValid: false, message: 'Invalid date or time' };
    }

    // Check Due Date vs Invoice Date
    if (lowerFieldName.includes('due')) {
      const invoiceDateField = Object.entries(existingFields).find(([key]) => key.toLowerCase().includes('invoice') && key.toLowerCase().includes('date'));
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
