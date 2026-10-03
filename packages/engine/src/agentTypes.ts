import type { ThinkingConfig } from './gemini/types';
import type { InteractionStep } from './gemini/interactions';

/**
 * Types and interfaces for the agentic OCR system
 */

// Note: FunctionCallingConfigMode is imported from @google/genai SDK
// Use FunctionCallingConfigMode.AUTO, FunctionCallingConfigMode.ANY, FunctionCallingConfigMode.NONE

/**
 * Represents a function call made by the agent
 */
export interface AgentFunctionCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Represents the result of a function call
 */
export interface AgentMemoryUpdate {
  extractedFields?: Record<string, AgentMemory['extractedFields'][string]>;
  /** Runtime review of the selected values, applied after candidate merging. */
  fieldReviews?: Record<string, {
    value: string;
    isValid: boolean;
    validationMessage?: string;
  }>;
  documentAnalysis?: Partial<AgentMemory['documentAnalysis']>;
  confidence?: number;
  lastUpdated?: number;
  processingHistoryItem?: AgentStep;
}

export interface AgentFunctionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  memoryUpdate?: AgentMemoryUpdate;
}

export interface NormalizedRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  units: 'normalized';
}

/** Runtime-neutral result returned by a document region rasterizer. */
export interface RegionCropResult {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
}

/** Runtime adapter supplied by a host that supports region re-OCR. */
export type RegionCropper = (
  fileData: string,
  mimeType: string,
  region: NormalizedRegion,
) => Promise<RegionCropResult>;

export type RegionStructuredExtractor = (
  dataUrl: string,
  mimeType: string,
  responseSchema: Record<string, unknown>,
  prompt: string,
  abortSignal?: AbortSignal,
) => Promise<unknown>;

/** Minimal document descriptor required by the agent loop. */
export interface AgentDocumentInput {
  name: string;
  type: string;
}

/**
 * Represents a step in the agent's reasoning process
 */
export interface AgentStep {
  type: 'thinking' | 'function_call' | 'result' | 'error';
  /** Semantic origin; `type` is the host-facing presentation category. */
  source?: 'runtime' | 'thought_summary' | 'reasoning' | 'model_output' | 'tool_call' | 'tool_result';
  /** Provider step identifier when one exists. */
  id?: string;
  /** True when content is a live stream delta rather than a completed step. */
  delta?: boolean;
  content: string;
  functionCall?: AgentFunctionCall;
  functionResult?: AgentFunctionResult;
  timestamp: number;
}

/**
 * Runtime Gemini client configuration required by the agent.
 * This keeps the core agent loop independent from host configuration.
 */
export interface AgentClientConfig {
  apiKey: string;
  model: string;
  thinkingConfig?: ThinkingConfig;
  progress?: 'off' | 'standard' | 'detailed';
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Per-job provider accounting and request policy. */
  runtime?: import('./providers/runtime').ProviderExecutionContext;
  abortSignal?: AbortSignal;
  /** Runtime-specific rasterizer for the re_ocr_region tool. */
  regionCropper?: RegionCropper;
  /** Optional provider-neutral structured extraction adapter for region re-OCR. */
  regionStructuredExtractor?: RegionStructuredExtractor;
}

/**
 * Configuration for the agent's behavior (used by agent loop)
 */
export interface AgentLoopConfig {
  maxIterations: number;
  confidenceThreshold: number;
  maxTokens: number;
  /**
   * Hard wall-clock budget for the whole run, in milliseconds. Acts as a
   * safety net so a stuck/looping run cannot consume unbounded time and cost
   * even if it never converges (audit H-16). Defaults are applied by the loop.
   */
  maxDurationMs?: number;
  /** Base backoff (ms) for transient-error retries. Overridable (e.g. 0 in tests). */
  retryBaseDelayMs?: number;
  /** Pause (ms) between iterations. Overridable (e.g. 0 in tests). */
  iterationPauseMs?: number;
  /** Re-throw terminal provider failures after emitting progress, for machine-facing callers. */
  throwOnFailure?: boolean;
}

/**
 * Why an agent run stopped. The runtime — not the model — owns this decision so
 * that hitting a limit or finishing below the confidence threshold is never
 * reported as a clean success (audit A-16 / C-03).
 */
export type AgentStopReason =
  | 'succeeded'
  | 'partial'
  | 'max_iterations'
  | 'tool_limit_reached'
  | 'budget_exhausted'
  | 'cost_limit_reached'
  | 'cancelled'
  | 'failed';

/**
 * Represents the agent's memory/context
 */
export interface AgentMemory {
  sessionId: string;
  documentName: string;
  currentIteration: number;
  extractedFields: Record<string, {
    value: string;
    confidence: number;
    validation_rule?: string;
    location?: NormalizedRegion;
    isValid?: boolean;
    validationMessage?: string;
    extractedAt?: number;
  }>;
  processingHistory: AgentStep[];
  documentAnalysis: {
    pageCount: number;
    documentType: string;
    complexity: 'low' | 'medium' | 'high';
    specialFeatures: string[];
  };
  confidence: number;
  lastUpdated: number;
  /** Terminal reason set by the runtime when the run ends (audit A-16). */
  stopReason?: AgentStopReason;
}

/**
 * Type for progress update callbacks
 */
export type ProgressCallback = (progress: number, message: string) => void;

/**
 * Callback to yield steps from inside executeAgentTurn without async generators
 */
export type StepCallback = (step: AgentStep) => void;

/**
 * Result from a single agent turn (may involve multiple API calls for tool chaining)
 */
export interface AgentTurnResult {
  /** True if the runtime decided the turn has completed extraction */
  finished: boolean;
  /** All steps produced during this turn */
  steps: AgentStep[];
}

/** Mutable state for one server-side Interactions conversation. */
export interface AgentInteractionState {
  /** Most recent stored interaction used for `previous_interaction_id` chaining. */
  previousInteractionId?: string;
  /** Incremental input that has not yet been accepted by the API. */
  pendingInput?: InteractionStep[];
}
