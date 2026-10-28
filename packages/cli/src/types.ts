import type { AgentStep, AgentStopReason, NormalizedRegion } from '@open-ocr/engine/agentTypes';
import type {
  ExtractedContent,
  JsonValue,
  PresetStructuredOutput,
  ThinkingLevel,
} from '@open-ocr/engine/gemini';
import {
  GEMINI_MODELS,
  type GatewayId,
  type ProviderId,
  type ProviderUsageSnapshot,
} from '@open-ocr/engine/providers';
import type { OcrErrorPayload } from './errors';
import type { ArtifactTarget } from './output';

export const CLI_MODES = ['simple', 'template', 'agentic'] as const;
export type CliMode = (typeof CLI_MODES)[number];
export type OutputPathKind = 'auto' | 'file' | 'directory';

export const CLI_FORMATS = ['markdown', 'json', 'csv', 'all'] as const;
export type CliFormat = (typeof CLI_FORMATS)[number];

export const SUPPORTED_MODELS = GEMINI_MODELS;

export interface CliConfigFile {
  provider?: ProviderId;
  gateway?: GatewayId;
  model?: string;
  baseUrl?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareTokenEnv?: string;
  cloudflareByok?: boolean;
  cloudflareByokAlias?: string;
  cloudflareProvider?: string;
  inputPricePerMillionUsd?: number;
  outputPricePerMillionUsd?: number;
  thinking?: ThinkingLevel;
  progress?: 'off' | 'standard' | 'detailed';
  mode?: CliMode;
  preset?: string;
  format?: CliFormat;
  output?: string;
  concurrency?: number;
  retries?: number;
  timeoutSeconds?: number;
  maxFiles?: number;
  maxTotalMb?: number;
  resume?: boolean;
  overwrite?: boolean;
  failFast?: boolean;
  hidden?: boolean;
  exclude?: string[];
  /** Prune node_modules, dist, build, vendor, and target from directory scans. */
  defaultExcludes?: boolean;
  instructions?: string[];
  detectImages?: boolean;
  detectMath?: boolean;
  maxTokens?: number;
  maxIterations?: number;
  confidenceThreshold?: number;
  apiKeyEnv?: string;
  schema?: string;
  maxCostUsd?: number;
  requestsPerMinute?: number;
}

export interface ExtractCommandFlags {
  /** String for --config; Commander's negated --no-config form stores `false`. */
  config?: string | false;
  provider?: string;
  gateway?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareTokenEnv?: string;
  cloudflareByok?: boolean;
  cloudflareByokAlias?: string;
  cloudflareProvider?: string;
  inputPrice?: string;
  outputPrice?: string;
  mode?: string;
  preset?: string;
  format?: string;
  output?: string;
  /**
   * How to interpret `output`. Human `extract -o` uses `auto`, Web OCR names a
   * file, and machine `delivery.outputDirectory` names a directory.
   */
  outputPathKind?: OutputPathKind;
  model?: string;
  thinking?: string;
  progress?: string;
  /**
   * Numeric options arrive as strings from Commander and as numbers from a
   * validated protocol request. Accepting both spares the machine path a
   * number → string → number round trip that only existed to satisfy the
   * flag-shaped type.
   */
  concurrency?: string | number;
  retries?: string | number;
  timeout?: string | number;
  maxFiles?: string | number;
  maxTotalMb?: string | number;
  exclude?: string[];
  instruction?: string[];
  hidden?: boolean;
  defaultExcludes?: boolean;
  resume?: boolean;
  overwrite?: boolean;
  failFast?: boolean;
  jsonl?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  stdinName?: string;
  stdinType?: string;
  detectImages?: boolean;
  detectMath?: boolean;
  maxTokens?: string | number;
  maxIterations?: string | number;
  confidenceThreshold?: string | number;
  schema?: string;
  /** Internal machine-adapter signal for an already-validated in-memory schema. */
  customSchema?: boolean;
  maxCost?: string | number;
  requestsPerMinute?: string | number;
}

/**
 * The JSON artifact an agentic run produces.
 *
 * This is a protocol shape (`result-v2.schema.json#/$defs/agenticResult`), not
 * the engine's `AgentMemory`. The engine type carries session IDs, timestamps,
 * and the raw processing history, and it changes with the engine; writing it
 * verbatim made an internal type the artifact contract. The step trace is
 * still available as the `agent-steps` artifact under `contentFormat: "all"`.
 */
export interface AgenticExtractionField {
  value: string;
  confidence: number;
  valid?: boolean;
  validationMessage?: string;
  validationRule?: string;
  location?: NormalizedRegion;
}

export interface AgenticExtractionResult {
  documentType: string;
  pageCount: number;
  complexity: 'low' | 'medium' | 'high';
  specialFeatures: string[];
  confidence: number;
  iterations: number;
  stopReason: AgentStopReason;
  fields: Record<string, AgenticExtractionField>;
}

export interface ResolvedCliOptions {
  provider: ProviderId;
  gateway: GatewayId;
  apiKey: string;
  apiKeyEnv: string;
  model: string;
  baseUrl: string;
  gatewayToken?: string;
  gatewayTokenEnv?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareByok: boolean;
  cloudflareByokAlias?: string;
  cloudflareProvider?: string;
  inputPricePerMillionUsd?: number;
  outputPricePerMillionUsd?: number;
  thinking: ThinkingLevel;
  includeThoughts: boolean;
  progress: 'off' | 'standard' | 'detailed';
  mode: CliMode;
  preset?: string;
  format: CliFormat;
  output?: string;
  /** See {@link ExtractCommandFlags.outputPathKind}. */
  outputPathKind: OutputPathKind;
  concurrency: number;
  retries: number;
  timeoutSeconds: number;
  maxFiles: number;
  maxTotalMb: number;
  excludes: string[];
  instructions: string[];
  hidden: boolean;
  /** Whether directory scans prune well-known dependency and build-output trees. */
  defaultExcludes: boolean;
  resume: boolean;
  overwrite: boolean;
  failFast: boolean;
  jsonl: boolean;
  dryRun: boolean;
  quiet: boolean;
  verbose: boolean;
  stdinName: string;
  stdinType?: string;
  detectImages: boolean;
  detectMath: boolean;
  maxTokens: number;
  maxIterations: number;
  confidenceThreshold: number;
  schemaPath?: string;
  customSchema?: Record<string, unknown>;
  maxCostUsd?: number;
  requestsPerMinute: number;
  cwd: string;
}

export interface ResolvedInput {
  absolutePath?: string;
  displayPath: string;
  relativePath: string;
  name: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  stdinBytes?: Uint8Array;
}

export interface OcrArtifacts {
  markdown?: string;
  json?: ExtractedContent | PresetStructuredOutput | AgenticExtractionResult | JsonValue;
  csv?: string;
  agentSteps?: AgentStep[];
}

export type OcrPartialReason =
  | 'readiness_not_met'
  | 'max_iterations'
  | 'tool_limit_reached'
  | 'time_budget_reached'
  | 'cost_limit_reached';

export type OcrNextAction =
  | 'review_partial_output'
  | 'increase_max_iterations'
  | 'retry_document'
  | 'increase_timeout'
  | 'increase_max_cost';

export interface OcrJobResult {
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  input: ResolvedInput;
  mode: CliMode;
  provider?: ProviderId;
  gateway?: GatewayId;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  artifacts?: OcrArtifacts;
  outputFiles?: string[];
  plannedOutputFiles?: string[];
  /**
   * The same destinations as {@link outputFiles}, each paired with the artifact
   * key that produced it. The protocol reads `kind`/`mediaType` from here rather
   * than guessing them from the filename, which is wrong whenever `--output`
   * names a file whose extension disagrees with `--format`. The plain path lists
   * stay because the manifest, resume, JSONL, and status surfaces consume them.
   */
  outputArtifacts?: ArtifactTarget[];
  plannedOutputArtifacts?: ArtifactTarget[];
  skipReason?: 'validated' | 'resumed' | 'cancelled' | 'cost-limit' | 'fail-fast';
  partialReason?: OcrPartialReason;
  nextAction?: OcrNextAction;
  error?: string;
  errorDetails?: OcrErrorPayload;
  attempts: number;
}

export interface BatchSummary {
  version: 1;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  mode: CliMode;
  provider?: ProviderId;
  gateway?: GatewayId;
  model: string;
  usage: ProviderUsageSnapshot;
  costLimitUsd?: number;
  costLimitReached: boolean;
  results: OcrJobResult[];
}

export interface ManifestEntry {
  fingerprint: string;
  status: 'succeeded' | 'partial' | 'failed';
  outputFiles: string[];
  completedAt: string;
  error?: string;
}

export interface CliManifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}
