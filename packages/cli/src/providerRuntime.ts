import {
  createProviderExecutionContext,
  type ProviderExecutionContext,
  type ProviderRuntimeConfig,
} from '@open-ocr/engine/providers';
import { Agent, setGlobalDispatcher } from 'undici';

import type { ResolvedCliOptions } from './types';

/**
 * Node's built-in fetch (which every provider client, the Gemini SDK
 * included, uses) cuts a response whose headers or body take more than 300
 * seconds, whatever `--timeout` says. A non-streaming completion sends its
 * headers only once generation ends, so a slow but healthy request was cut at
 * five minutes while the provider kept working and billing. Deadlines belong
 * to the per-document AbortSignal instead.
 */
export const FETCH_DISPATCHER_OPTIONS = { headersTimeout: 0, bodyTimeout: 0 } as const;

/** Install the process-wide fetch dispatcher. Called once at CLI and MCP startup. */
export function installFetchDispatcher(): void {
  setGlobalDispatcher(new Agent(FETCH_DISPATCHER_OPTIONS));
}

/** Build the provider-facing configuration once for every CLI execution path. */
export function providerRuntimeConfig(
  options: ResolvedCliOptions,
  runtime?: ProviderExecutionContext,
): ProviderRuntimeConfig {
  const context = runtime ?? createProviderExecutionContext({
    requestsPerMinute: options.requestsPerMinute,
    maxCostUsd: options.maxCostUsd,
  });
  // Gemini's native transport reports usage with provider/model only. Keep
  // operator price overrides on this job's context so every continuation,
  // credential check, and region re-OCR uses the same cost ceiling estimate.
  context.configureUsagePricing(options);
  return {
    provider: options.provider,
    gateway: options.gateway,
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    model: options.model,
    baseUrl: options.baseUrl,
    thinkingConfig: {
      level: options.thinking,
      includeThoughts: options.includeThoughts,
      // Without it, an OpenRouter route with no known reasoning contract gets
      // no `reasoning` field and keeps the model's own default.
      explicit: options.thinkingExplicit === true,
    },
    progress: options.progress,
    gatewayToken: options.gatewayToken,
    gatewayTokenEnv: options.gatewayTokenEnv,
    cloudflareAccountId: options.cloudflareAccountId,
    cloudflareGatewayId: options.cloudflareGatewayId,
    cloudflareByok: options.cloudflareByok,
    cloudflareByokAlias: options.cloudflareByokAlias,
    cloudflareProvider: options.cloudflareProvider,
    inputPricePerMillionUsd: options.inputPricePerMillionUsd,
    outputPricePerMillionUsd: options.outputPricePerMillionUsd,
    runtime: context,
  };
}
