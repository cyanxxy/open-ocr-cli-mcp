import type { AgentMemory } from './agentTypes';

export type KnownAgentDocumentType =
  | 'invoice'
  | 'receipt'
  | 'resume'
  | 'business card'
  | 'form'
  | 'contract'
  | 'unknown';

export interface AgentDocumentSchema {
  documentType: KnownAgentDocumentType;
  requiredFields: string[];
  optionalFields: string[];
  aliases: Record<string, string>;
}

export interface AgentReadiness {
  documentType: string;
  hasSchema: boolean;
  fieldCount: number;
  /** Number of populated fields the validators did not flag invalid. */
  validFieldCount: number;
  /** Mean confidence of populated fields, clamped to [0, 1]. */
  averageConfidence: number;
  requiredFields: string[];
  optionalFields: string[];
  missingRequiredFields: string[];
  requiredCoverage: number;
}

/** Outcome of the deterministic completion check the runtime owns. */
export interface AgentCompletion {
  complete: boolean;
  reason:
    | 'confidence-and-coverage-met'
    | 'no-fields'
    | 'missing-required-fields'
    | 'below-confidence-threshold';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

type AgentExtractionSnapshot = Pick<AgentMemory, 'documentAnalysis' | 'extractedFields'>;

function sanitizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const DOCUMENT_TYPE_ALIASES: Record<string, KnownAgentDocumentType> = {
  invoice: 'invoice',
  invoices: 'invoice',
  bill: 'invoice',
  receipt: 'receipt',
  receipts: 'receipt',
  resume: 'resume',
  cv: 'resume',
  curriculum_vitae: 'resume',
  business_card: 'business card',
  businesscard: 'business card',
  contact_card: 'business card',
  form: 'form',
  application_form: 'form',
  contract: 'contract',
  agreement: 'contract',
  unknown: 'unknown',
};

const DOCUMENT_SCHEMAS: Record<Exclude<KnownAgentDocumentType, 'unknown'>, AgentDocumentSchema> = {
  invoice: {
    documentType: 'invoice',
    requiredFields: ['vendor_name', 'invoice_number', 'invoice_date', 'customer_name', 'total_amount'],
    optionalFields: ['due_date', 'currency', 'subtotal_amount', 'tax_amount', 'line_items'],
    aliases: {
      supplier_name: 'vendor_name',
      company_name: 'vendor_name',
      merchant_name: 'vendor_name',
      invoice_id: 'invoice_number',
      invoice_no: 'invoice_number',
      bill_to: 'customer_name',
      client_name: 'customer_name',
      customer: 'customer_name',
      subtotal: 'subtotal_amount',
      subtotal_total: 'subtotal_amount',
      tax: 'tax_amount',
      vat: 'tax_amount',
      total: 'total_amount',
      grand_total: 'total_amount',
      amount_due: 'total_amount',
      items: 'line_items',
    },
  },
  receipt: {
    documentType: 'receipt',
    requiredFields: ['merchant_name', 'transaction_date', 'total_amount'],
    optionalFields: ['receipt_number', 'subtotal_amount', 'tax_amount', 'payment_method', 'items'],
    aliases: {
      vendor_name: 'merchant_name',
      store_name: 'merchant_name',
      company_name: 'merchant_name',
      merchant: 'merchant_name',
      date: 'transaction_date',
      receipt_date: 'transaction_date',
      transaction_time: 'transaction_date',
      total: 'total_amount',
      grand_total: 'total_amount',
      subtotal: 'subtotal_amount',
      tax: 'tax_amount',
      line_items: 'items',
      purchased_items: 'items',
    },
  },
  resume: {
    documentType: 'resume',
    requiredFields: ['full_name', 'email'],
    optionalFields: ['phone_number', 'location', 'job_title', 'skills', 'experience', 'education'],
    aliases: {
      candidate_name: 'full_name',
      name: 'full_name',
      mobile: 'phone_number',
      phone: 'phone_number',
      address: 'location',
      city: 'location',
      title: 'job_title',
      current_title: 'job_title',
      work_experience: 'experience',
      work_history: 'experience',
      experience_highlights: 'experience',
      certifications: 'education',
    },
  },
  'business card': {
    documentType: 'business card',
    requiredFields: ['full_name', 'company_name', 'email'],
    optionalFields: ['job_title', 'phone_number', 'website', 'address'],
    aliases: {
      candidate_name: 'full_name',
      contact_name: 'full_name',
      name: 'full_name',
      company: 'company_name',
      organization: 'company_name',
      email_address: 'email',
      work_email: 'email',
      phone: 'phone_number',
      mobile: 'phone_number',
      telephone: 'phone_number',
      website_url: 'website',
      company_website: 'website',
      physical_address: 'address',
      location: 'address',
    },
  },
  form: {
    documentType: 'form',
    requiredFields: [],
    optionalFields: [],
    aliases: {},
  },
  contract: {
    documentType: 'contract',
    requiredFields: ['parties', 'effective_date'],
    optionalFields: ['terms', 'signatures', 'clauses'],
    aliases: {
      party_names: 'parties',
      start_date: 'effective_date',
      agreement_terms: 'terms',
    },
  },
};

export function normalizeAgentDocumentType(documentType?: string): string {
  if (!documentType || !documentType.trim()) {
    return 'unknown';
  }

  const sanitized = sanitizeKey(documentType);
  return Object.hasOwn(DOCUMENT_TYPE_ALIASES, sanitized)
    ? DOCUMENT_TYPE_ALIASES[sanitized]
    : sanitized.replace(/_/g, ' ');
}

export function getAgentDocumentSchema(documentType?: string): AgentDocumentSchema | null {
  const normalized = normalizeAgentDocumentType(documentType);
  if (normalized === 'unknown') {
    return null;
  }

  return Object.hasOwn(DOCUMENT_SCHEMAS, normalized)
    ? DOCUMENT_SCHEMAS[normalized as Exclude<KnownAgentDocumentType, 'unknown'>]
    : null;
}

export function normalizeAgentFieldName(documentType: string | undefined, fieldName: string): string {
  const normalizedField = sanitizeKey(fieldName);
  if (!normalizedField) {
    return normalizedField;
  }

  const schema = getAgentDocumentSchema(documentType);
  if (!schema) {
    return normalizedField;
  }

  return Object.hasOwn(schema.aliases, normalizedField) ? schema.aliases[normalizedField] : normalizedField;
}

export function getAgentReadiness(snapshot: AgentExtractionSnapshot): AgentReadiness {
  const schema = getAgentDocumentSchema(snapshot.documentAnalysis.documentType);
  const fields = Object.values(snapshot.extractedFields);
  const populated = fields.filter((field) => String(field.value || '').trim().length > 0);
  // Confidence is clamped per-field to [0, 1] so a model that returns an
  // out-of-range score (e.g. 1.4 or a NaN) cannot inflate readiness.
  const averageConfidence = populated.length > 0
    ? populated.reduce((sum, field) => sum + clampConfidence(field.confidence), 0) / populated.length
    : 0;
  const validFieldCount = populated.filter((field) => field.isValid !== false).length;

  if (!schema) {
    return {
      documentType: normalizeAgentDocumentType(snapshot.documentAnalysis.documentType),
      hasSchema: false,
      fieldCount: populated.length,
      validFieldCount,
      averageConfidence,
      requiredFields: [],
      optionalFields: [],
      missingRequiredFields: [],
      // No known schema means we cannot assert required-field coverage; report 0
      // when nothing has been extracted, otherwise 1 (no known requirements left
      // to satisfy). Completion still gates on confidence + a valid field below.
      requiredCoverage: populated.length > 0 ? 1 : 0,
    };
  }

  const missingRequiredFields = schema.requiredFields.filter((fieldName) => {
    const field = snapshot.extractedFields[fieldName];
    return !field || field.isValid === false || String(field.value || '').trim().length === 0;
  });

  const requiredCoverage = schema.requiredFields.length > 0
    ? (schema.requiredFields.length - missingRequiredFields.length) / schema.requiredFields.length
    : 1;

  return {
    documentType: schema.documentType,
    hasSchema: true,
    fieldCount: populated.length,
    validFieldCount,
    averageConfidence,
    requiredFields: schema.requiredFields,
    optionalFields: schema.optionalFields,
    missingRequiredFields,
    requiredCoverage,
  };
}

/**
 * Deterministic completion decision owned by the runtime (not the model).
 *
 * A run is only "complete" when, for the document's schema, every required
 * field is populated and valid AND overall confidence clears the configured threshold
 * AND at least one populated field survived validation. For unknown document
 * types (no schema) we cannot assert coverage, so completion requires a valid
 * field plus the confidence threshold. This is what makes `confidenceThreshold`
 * a real control instead of a value the loop ignored (audit C-03 / Q-08).
 */
export function evaluateAgentCompletion(
  snapshot: AgentExtractionSnapshot,
  confidence: number,
  confidenceThreshold: number,
): AgentCompletion {
  const readiness = getAgentReadiness(snapshot);
  const effectiveConfidence = Math.max(clampConfidence(confidence), readiness.averageConfidence);

  if (readiness.validFieldCount === 0) {
    return { complete: false, reason: 'no-fields' };
  }

  if (readiness.hasSchema && readiness.missingRequiredFields.length > 0) {
    return { complete: false, reason: 'missing-required-fields' };
  }

  if (effectiveConfidence < confidenceThreshold) {
    return { complete: false, reason: 'below-confidence-threshold' };
  }

  return { complete: true, reason: 'confidence-and-coverage-met' };
}

export function buildAgentSchemaGuidance(documentType?: string): string {
  const schema = getAgentDocumentSchema(documentType);
  if (!schema) {
    return 'If the document type is unknown, analyze it first and then reuse the exact canonical field names returned by analyze_document_structure.';
  }

  const required = schema.requiredFields.length > 0
    ? schema.requiredFields.join(', ')
    : 'none';
  const optional = schema.optionalFields.length > 0
    ? schema.optionalFields.join(', ')
    : 'none';

  return `Canonical field names for ${schema.documentType}:
- Required: ${required}
- Optional: ${optional}
Use these exact field_name values in extract_fields_batch. Avoid inventing aliases when a canonical field exists.`;
}
