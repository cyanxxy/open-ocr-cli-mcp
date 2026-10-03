import type { AgentMemory, AgentMemoryUpdate } from './agentTypes';

/**
 * Pure agent-memory helpers shared by the outer loop (agentLoop.ts) and the
 * turn executor (agentGemini.ts).
 *
 * These functions used to live in agentLoop.ts, which created a circular import
 * (agentLoop -> agentGemini -> agentLoop). Hosting them in a neutral module that
 * neither file depends on for control flow breaks that cycle.
 */

type FieldData = AgentMemory['extractedFields'][string];

/** Semantic progress excludes timestamps and audit history, which always grow. */
export function agentProgressFingerprint(memory: Readonly<AgentMemory>): string {
  return JSON.stringify({
    documentAnalysis: memory.documentAnalysis,
    confidence: memory.confidence,
    fields: Object.entries(memory.extractedFields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, field]) => [name, {
        value: field.value,
        confidence: field.confidence,
        isValid: field.isValid,
        location: field.location,
      }]),
  });
}

/**
 * Create initial agent memory.
 */
export function createInitialMemory(sessionId: string, fileName: string): AgentMemory {
  return {
    sessionId,
    documentName: fileName,
    currentIteration: 0,
    extractedFields: {},
    processingHistory: [],
    documentAnalysis: {
      pageCount: 1,
      documentType: 'unknown',
      complexity: 'medium',
      specialFeatures: [],
    },
    confidence: 0,
    lastUpdated: Date.now(),
  };
}

/**
 * Validity rank for merge ordering. A value the validators flagged as invalid
 * (`isValid === false`) must never overwrite a known-valid value, regardless of
 * the model's self-reported confidence. `undefined`/`true` are treated as "not
 * known-invalid" and rank above an explicit `false`.
 */
function validityRank(field: Pick<FieldData, 'isValid'>): number {
  return field.isValid === false ? 0 : 1;
}

/**
 * Decide whether an incoming field should replace an existing one.
 *
 * Ordering (highest priority first):
 *  1. Validity — a known-valid value beats a known-invalid one.
 *  2. Confidence — higher confidence wins.
 *  3. Recency — newer extraction wins on a tie.
 *
 * This is the single deterministic reducer for agent field merges. The previous
 * implementation ordered purely by confidence, which let a high-confidence but
 * invalid value clobber a lower-confidence valid one (audit A-13).
 */
export function shouldReplaceField(existing: FieldData, incoming: FieldData): boolean {
  const incomingValidity = validityRank(incoming);
  const existingValidity = validityRank(existing);
  if (incomingValidity !== existingValidity) {
    return incomingValidity > existingValidity;
  }

  const incomingConfidence = incoming.confidence ?? 0;
  const existingConfidence = existing.confidence ?? 0;
  if (incomingConfidence !== existingConfidence) {
    return incomingConfidence > existingConfidence;
  }

  const incomingExtractedAt = incoming.extractedAt ?? 0;
  const existingExtractedAt = existing.extractedAt ?? 0;
  return incomingExtractedAt >= existingExtractedAt;
}

/**
 * Merge a single incoming field into an existing one using the deterministic
 * ordering above, preserving a previously-known region when the newer value
 * omits one (extract_fields_batch frequently leaves `location` undefined, which
 * would otherwise clobber a precise region established earlier by re_ocr_region).
 */
export function mergeField(existing: FieldData, incoming: FieldData): FieldData {
  const replace = shouldReplaceField(existing, incoming);
  const merged = replace
    ? { ...existing, ...incoming }
    : { ...incoming, ...existing };

  if (merged.location == null) {
    merged.location = replace
      ? (incoming.location ?? existing.location)
      : (existing.location ?? incoming.location);
  }

  return merged;
}

/**
 * Apply updates to the agent memory in place.
 */
export function applyMemoryUpdate(memory: AgentMemory, update?: AgentMemoryUpdate): void {
  if (!update) return;

  if (update.extractedFields) {
    for (const [fieldName, incomingField] of Object.entries(update.extractedFields)) {
      const existingField = Object.hasOwn(memory.extractedFields, fieldName)
        ? memory.extractedFields[fieldName]
        : undefined;
      const field = existingField
        ? mergeField(existingField, incomingField)
        : incomingField;
      // Defining a data property also handles direct updates named __proto__;
      // assignment on a normal object would invoke its inherited setter.
      Object.defineProperty(memory.extractedFields, fieldName, {
        value: field, enumerable: true, writable: true, configurable: true,
      });
    }
  }

  for (const [name, review] of Object.entries(update.fieldReviews ?? {})) {
    const field = Object.hasOwn(memory.extractedFields, name) ? memory.extractedFields[name] : undefined;
    // A review describes one exact value. Do not apply it if the candidate
    // merger retained a different, better extraction.
    if (field?.value === review.value) {
      memory.extractedFields[name] = {
        ...field,
        isValid: review.isValid,
        validationMessage: review.validationMessage,
      };
    }
  }

  if (update.documentAnalysis) {
    Object.assign(memory.documentAnalysis, update.documentAnalysis);
  }

  if (typeof update.confidence === 'number') {
    memory.confidence = update.confidence;
  }

  if (typeof update.lastUpdated === 'number') {
    memory.lastUpdated = update.lastUpdated;
  }

  if (update.processingHistoryItem) {
    memory.processingHistory.push(update.processingHistoryItem);
  }
}
