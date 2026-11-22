import type { ThinkingConfig } from '../gemini/types';
import type { ProviderExecutionContext } from './runtime';

export const PROVIDER_IDS = [
  'gemini',
  'kimi',
  'muse',
  'openrouter',
  'openai-compatible',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const GATEWAY_IDS = ['direct', 'cloudflare'] as const;
export type GatewayId = (typeof GATEWAY_IDS)[number];

export interface ProviderCapabilities {
  images: ProviderCapabilityState;
  pdfs: ProviderCapabilityState;
  structuredOutput: ProviderCapabilityState;
  toolCalling: ProviderCapabilityState;
  reasoning: ProviderCapabilityState;
  webUrls: ProviderCapabilityState;
}

export type ProviderCapabilityState = boolean | 'model-dependent' | 'unknown';

export type AgentProgressLevel = 'off' | 'standard' | 'detailed';

export interface ProviderTokenPrice {
  inputPerMillionUsd: number;
  /** Optional discounted rate for cached input tokens, which are a subset of input tokens. */
  cachedInputPerMillionUsd?: number;
  outputPerMillionUsd: number;
}

export interface ProviderThinkingConfig extends ThinkingConfig {
  /**
   * True when the level was chosen by the user (a flag, OPEN_OCR_THINKING, or a
   * matching config-file `thinking`) rather than filled in as a default. An
   * OpenRouter route with no known reasoning contract receives `reasoning` only
   * when this is true.
   */
  explicit?: boolean;
}

export interface ProviderRuntimeConfig {
  provider: ProviderId;
  gateway: GatewayId;
  apiKey: string;
  apiKeyEnv: string;
  model: string;
  baseUrl: string;
  thinkingConfig?: ProviderThinkingConfig;
  /** Controls emitted observability only; never controls reasoning continuity. */
  progress?: AgentProgressLevel;
  gatewayToken?: string;
  gatewayTokenEnv?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareByok?: boolean;
  cloudflareByokAlias?: string;
  cloudflareProvider?: string;
  inputPricePerMillionUsd?: number;
  outputPricePerMillionUsd?: number;
  /** Per-job usage accounting, cost ceiling, and request-rate gate. */
  runtime?: ProviderExecutionContext;
}

export interface ProviderProfile {
  id: ProviderId;
  label: string;
  defaultModel?: string;
  defaultBaseUrl: string;
  defaultApiKeyEnv: string;
  models: readonly string[];
  /** Image MIME types accepted by both this CLI and the known provider transport. Omitted when model/endpoint-specific. */
  inputImageMimeTypes?: readonly string[];
  capabilities: ProviderCapabilities;
}

export interface ProviderUsageSnapshot {
  /** Every provider HTTP attempt, including failed and retried ones. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  toolTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /**
   * Completed provider responses that carried no usage telemetry. Present only
   * when non-zero: token and cost totals then undercount the real spend.
   */
  unreportedUsageRequests?: number;
  /**
   * The subset of {@link unreportedUsageRequests} sent at non-zero prices, so
   * their spend is unknown. Present only when non-zero. A resumed job under
   * `--max-cost` uses it to fail closed (see `setPriorUsageUnknown`).
   */
  unmeteredPaidRequests?: number;
}
