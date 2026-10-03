/**
 * Type definitions for the Gemini OCR system
 * Extracted from the monolithic gemini.ts file for better organization
 */

/**
 * Represents the content extracted from a document, organized into a title and sections.
 */
export interface ExtractedContent {
  /** The main title of the document, if found */
  title?: string;
  /** An array of sections, each containing a heading and content lines */
  sections: {
    /** The heading for this section */
    heading?: string;
    /** An array of strings, where each string is a line of content within the section */
    content: string[];
  }[];
  /** The full content as a single string */
  content?: string;
  /** Extracted headings from the document */
  headings?: string[];
  /** Extracted tables from the document */
  tables?: Array<{
    headers: string[];
    rows: string[][];
    content: string;
  }>;
  /** Extracted code blocks */
  code?: string[];
  /** Extracted lists */
  lists?: Array<{
    type: 'ordered' | 'unordered';
    items: string[];
  }>;
  /** The content formatted as markdown */
  markdown?: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Options to configure extraction behavior
 */
export interface ExtractionOptions {
  /** If true, attempts to output structured data in JSON format */
  structuredOutput?: boolean;
  /** Specifies the predominant handwriting style */
  handwritingStyle?: 'general' | 'cursive' | 'print' | 'mixed';
  /** Controls the output format */
  outputFormat?: 'markdown' | 'json';
  /** If true, enables image detection */
  detectImages?: boolean;
  /** If true, enables math equation detection */
  detectMathEquations?: boolean;
  /** Level of detail for image descriptions */
  imageDetailLevel?: 'minimal' | 'standard' | 'detailed';
  /** Temperature setting for the model */
  temperature?: number;
  /** Maximum number of tokens to generate */
  maxTokens?: number;
  /** Model name to use */
  model?: string;
  /** Abort signal to cancel the request */
  abortSignal?: AbortSignal;
}

/**
 * Instruction for guiding the extraction process
 */
export interface ExtractionInstruction {
  /** Optional title for the instruction set */
  title?: string;
  /** The specific prompt or instruction */
  prompt: string;
}

/**
 * Callbacks for streaming operations
 */
export interface StreamingCallbacks {
  /** Called when streaming starts */
  onStart?: () => void;
  /** Called for each chunk of data */
  onProgress?: (chunk: string) => void;
  /** Called when streaming completes */
  onComplete?: (content: ExtractedContent) => void;
  /** Called if an error occurs */
  onError?: (error: Error) => void;
}

/**
 * Rule for extracting specific fields
 */
export interface ExtractionRule {
  /** Unique identifier for the rule */
  id: string;
  /** Name of the field to extract */
  field: string;
  /** Description or instruction for extraction */
  description: string;
  /** Expected type of the extracted value */
  type: 'text' | 'number' | 'date' | 'list' | 'boolean' | 'currency' | 'email' | 'url' | 'phone';
  /** Whether this field is required */
  required?: boolean;
  /** Pattern to match (regex) */
  pattern?: string;
  /** Example value */
  example?: string;
}

/**
 * Structured extraction presets built on top of OCR rules.
 */
export interface ExtractionPreset {
  /** Stable preset identifier used across hosts, evals, and reports. */
  id: string;
  /** Human-readable preset label. */
  label: string;
  /** Short description of the preset's intended use case. */
  description: string;
  /** Extraction rules that should be applied for this preset. */
  rules: ExtractionRule[];
  /** Whether the preset is primarily record-like or table-like. */
  outputShape: 'record' | 'table';
  /** Optional table columns for presets that should emit CSV rows. */
  tableColumns?: string[];
}

/**
 * Single extracted field in a preset result.
 */
export interface PresetExtractedField {
  /** Field type inherited from the preset rule. */
  type: ExtractionRule['type'];
  /** Extracted value or null when the field could not be found. */
  value: string | number | boolean | string[] | null;
  /** Model confidence score between 0 and 1. */
  confidence: number;
  /** Whether the field is required by the preset. */
  required: boolean;
}

/**
 * Normalized structured output returned by preset extraction.
 */
export interface PresetStructuredOutput {
  /** The preset identifier used to extract this result. */
  presetId: string;
  /** The document type interpreted by the model. */
  documentType: string;
  /** Short model-generated summary of the extracted document. */
  summary: string;
  /**
   * Extracted fields keyed by `rule.field` (the stable contract key). Preset
   * rules enforce `rule.field` uniqueness; `rule.id` is metadata only and is
   * NOT used for keying. See audit T-01.
   */
  fields: Record<string, PresetExtractedField>;
  /** Optional tabular rows for CSV export. */
  rows?: Array<Record<string, string>>;
  /** Extraction warnings or caveats. */
  warnings?: string[];
  /**
   * Validation report for required/type/pattern rule violations detected during
   * normalization. Empty/undefined when every rule passed. See audit T-02.
   */
  validationErrors?: string[];
}

/**
 * Final artifact bundle returned by a preset extraction run.
 */
export interface PresetRunResult {
  /** The preset identifier used to produce these artifacts. */
  presetId: string;
  /** Human-readable markdown summary for display and copy actions. */
  markdown: string;
  /** Normalized machine-readable structured output. */
  json: PresetStructuredOutput;
  /** Optional CSV artifact for table-shaped presets. */
  csv?: string;
}

/**
 * Callbacks for template/preset extraction operations.
 */
export interface PresetStreamingCallbacks {
  /** Called for each streamed chunk of model output. */
  onProgress?: (chunk: string) => void;
  /** Called when a preset run completes successfully. */
  onComplete?: (result: PresetRunResult) => void;
  /** Called if the preset extraction fails. */
  onError?: (error: Error) => void;
}

/**
 * Available Gemini models used by this app.
 */
export const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
] as const;

export type GeminiModel = (typeof GEMINI_MODELS)[number];

/**
 * Provider-neutral reasoning effort (uppercase in host config; lowercased at wire).
 * - MINIMAL: Lightest reasoning (Flash / Flash-Lite)
 * - LOW: Light reasoning, faster response
 * - MEDIUM: Balanced reasoning (3.5 Flash API default)
 * - HIGH: Full reasoning (3.1 Pro default; best for hard agent tasks)
 * - XHIGH / MAX: Compatible-provider efforts; CLI validation keeps them away from Gemini
 *
 * Official support:
 * - Gemini 3.8/3.7 Flash and 3.1 Pro: LOW, MEDIUM, HIGH
 * - Earlier Flash and Flash-Lite: MINIMAL, LOW, MEDIUM, HIGH
 */
export type ThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH' | 'MAX';

/**
 * Configuration for model thinking/reasoning.
 */
export interface ThinkingConfig {
  /** Thinking level - availability depends on model */
  level: ThinkingLevel;
  /** Whether to include thinking content in the response */
  includeThoughts?: boolean;
}

/**
 * Client configuration for Gemini API calls
 * Used for dependency injection to avoid coupling to global state
 */
export interface GeminiClientConfig {
  /** The Gemini API key */
  apiKey: string;
  /** The model to use */
  model: GeminiModel;
  /** Optional thinking configuration */
  thinkingConfig?: ThinkingConfig;
  /** Optional compatible base URL, for example Cloudflare AI Gateway. */
  baseUrl?: string;
  /** Optional transport headers such as Cloudflare gateway authentication. */
  headers?: Record<string, string>;
  /** Per-job provider accounting and request policy. */
  runtime?: import('../providers/runtime').ProviderExecutionContext;
}

/**
 * Error types for OCR operations.
 *
 * This is the engine's machine-readable failure vocabulary, and it exists so a
 * consumer never has to recognize a failure by reading its prose. The CLI keys
 * `classifyKnownError` on `name`/`type` for exactly that reason: a message
 * carrying user-supplied text — a schema path, a filename — must not be able to
 * trip a substring heuristic meant for something else.
 */
/**
 * Only the members something actually throws. A member no producer constructs
 * is a classification branch that can never fire, and it invites consumers to
 * write handling for a case the engine cannot reach — network and rate-limit
 * failures arrive as provider errors carrying a status, and are typed from that.
 */
export enum OcrErrorType {
  API_KEY_MISSING = 'API_KEY_MISSING',
  /** The caller's response schema is why the provider refused the request. */
  SCHEMA_INVALID = 'SCHEMA_INVALID'
}

/**
 * Custom error class for OCR operations.
 *
 * `options` reaches `Error`, so a diagnosis built here keeps the provider's
 * untouched error as `cause` while still declaring its own type.
 */
export class OcrError extends Error {
  constructor(
    public type: OcrErrorType,
    message: string,
    public details?: unknown,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'OcrError';
  }
}
