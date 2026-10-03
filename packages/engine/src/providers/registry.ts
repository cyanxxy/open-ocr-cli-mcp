import type {
  GatewayId,
  ProviderId,
  ProviderProfile,
  ProviderRuntimeConfig,
  ProviderTokenPrice,
} from './types';
import { GEMINI_MODELS, type ThinkingLevel } from '../gemini/types';

export { GEMINI_MODELS };

export const PROVIDER_PROFILES: Record<ProviderId, ProviderProfile> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-3.8-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultApiKeyEnv: 'GEMINI_API_KEY',
    models: GEMINI_MODELS,
    inputImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
    capabilities: {
      images: true,
      pdfs: true,
      structuredOutput: true,
      toolCalling: true,
      reasoning: true,
      webUrls: true,
    },
  },
  kimi: {
    id: 'kimi',
    label: 'Moonshot Kimi',
    defaultModel: 'kimi-k3',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    defaultApiKeyEnv: 'MOONSHOT_API_KEY',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
    inputImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    capabilities: {
      images: true,
      pdfs: true,
      structuredOutput: true,
      toolCalling: true,
      reasoning: true,
      webUrls: true,
    },
  },
  muse: {
    id: 'muse',
    label: 'Meta Muse',
    defaultModel: 'muse-spark-1.3',
    defaultBaseUrl: 'https://api.meta.ai/v1',
    defaultApiKeyEnv: 'META_API_KEY',
    // Contributor variants permit training on submitted documents. They remain
    // available by explicit model ID, but are not suggested during discovery.
    models: ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'],
    inputImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    capabilities: {
      images: true,
      // Meta documents Chat Completions PDF parts as
      // { type: "file", file: { filename, file_data } } (same family as OpenRouter).
      pdfs: true,
      structuredOutput: true,
      toolCalling: true,
      reasoning: true,
      webUrls: true,
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'google/gemini-3.8-flash',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultApiKeyEnv: 'OPENROUTER_API_KEY',
    models: [
      ...GEMINI_MODELS.map((model) => `google/${model}`),
      'meta/muse-spark-1.3',
      'meta/muse-spark-1.2',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-astra',
      'openai/gpt-6-luna',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-fable-5.1',
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k2.7-code',
      'moonshotai/kimi-k2.6',
    ],
    inputImageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    capabilities: {
      images: 'model-dependent',
      pdfs: 'model-dependent',
      structuredOutput: 'model-dependent',
      toolCalling: 'model-dependent',
      reasoning: 'model-dependent',
      webUrls: 'model-dependent',
    },
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible API',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultApiKeyEnv: 'OPEN_OCR_API_KEY',
    models: [],
    capabilities: {
      images: 'unknown',
      pdfs: false,
      structuredOutput: 'unknown',
      toolCalling: 'unknown',
      reasoning: 'unknown',
      webUrls: 'unknown',
    },
  },
};

export function providerProfile(provider: ProviderId): ProviderProfile {
  return PROVIDER_PROFILES[provider];
}

export function providerDefaultModel(provider: ProviderId): string | undefined {
  return providerProfile(provider).defaultModel;
}

export function providerDefaultApiKeyEnv(provider: ProviderId): string {
  return providerProfile(provider).defaultApiKeyEnv;
}

export function providerDefaultBaseUrl(provider: ProviderId): string {
  return providerProfile(provider).defaultBaseUrl;
}

/** True when the selected route targets Kimi K3's current reasoning contract. */
export function isKimiK3Route(provider: ProviderId, model: string): boolean {
  if (provider === 'kimi') return /^kimi-k3(?:$|-)/u.test(model);
  // OpenRouter model variants use a colon suffix (for example routing
  // variants). They still target K3 and therefore keep K3's exact effort
  // contract instead of the gateway's generic effort vocabulary.
  return provider === 'openrouter' && /^moonshotai\/kimi-k3(?:$|[-:])/u.test(model);
}

/** Current, verified reasoning contracts; unlisted gateway models remain model-dependent. */
export function knownModelThinkingLevels(provider: ProviderId, model: string): readonly ThinkingLevel[] | undefined {
  if (isKimiK3Route(provider, model)) return ['LOW', 'HIGH', 'MAX'];
  const routedModel = provider === 'openrouter' ? model.split(':')[0] : model;
  const geminiModel = provider === 'gemini'
    ? model
    : provider === 'openrouter' && routedModel.startsWith('google/') ? routedModel.slice(7) : undefined;
  if (geminiModel && (GEMINI_MODELS as readonly string[]).includes(geminiModel)) {
    return ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'].includes(geminiModel)
      ? ['LOW', 'MEDIUM', 'HIGH']
      : ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
  }
  const kimiModel = provider === 'kimi'
    ? model
    : provider === 'openrouter' && routedModel.startsWith('moonshotai/') ? routedModel.slice(11) : undefined;
  if (kimiModel && /^kimi-k2\.7-code/u.test(kimiModel)) return ['HIGH'];
  if (kimiModel === 'kimi-k2.6') return ['MINIMAL', 'HIGH'];
  const museModel = provider === 'muse'
    ? model
    : provider === 'openrouter' && routedModel.startsWith('meta/') ? routedModel.slice(5) : undefined;
  if (museModel && ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'].includes(museModel)) {
    return museModel === 'muse-spark-1.3'
      ? ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']
      : ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'];
  }
  if (provider === 'openrouter' && [
    'openai/gpt-6.1-sol', 'openai/gpt-6-astra', 'openai/gpt-6-luna',
    'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1',
  ].includes(routedModel)) return ['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
  return undefined;
}

export function providerDefaultThinkingLevel(provider: ProviderId, model: string): ThinkingLevel {
  if (isKimiK3Route(provider, model)) return 'MAX';
  if (provider === 'kimi' && (/^kimi-k2\.7-code/u.test(model) || model === 'kimi-k2.6')) return 'HIGH';
  const routedModel = provider === 'openrouter' ? model.split(':')[0] : model;
  if (provider === 'openrouter' && /^moonshotai\/kimi-k2\.(?:7-code|6$)/u.test(routedModel)) return 'HIGH';
  const geminiModel = provider === 'gemini'
    ? model
    : provider === 'openrouter' && routedModel.startsWith('google/') ? routedModel.slice(7) : undefined;
  if (geminiModel === 'gemini-3.5-flash-lite' || geminiModel === 'gemini-3.1-flash-lite') return 'MINIMAL';
  if (geminiModel === 'gemini-3.1-pro-preview' || geminiModel === 'gemini-3-flash-preview') return 'HIGH';
  if (provider === 'openrouter' && routedModel.startsWith('anthropic/claude-')) return 'HIGH';
  return 'MEDIUM';
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function cloudflareGatewayRoot(accountId: string, gatewayId: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}`;
}

export function resolveProviderBaseUrl(input: {
  provider: ProviderId;
  gateway: GatewayId;
  baseUrl?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareProvider?: string;
}): string {
  if (input.baseUrl) return input.baseUrl.replace(/\/$/, '');
  if (input.gateway === 'direct') return providerDefaultBaseUrl(input.provider);

  if (!input.cloudflareAccountId || !input.cloudflareGatewayId) {
    throw new Error('Cloudflare AI Gateway requires cloudflareAccountId and cloudflareGatewayId');
  }
  const root = cloudflareGatewayRoot(input.cloudflareAccountId, input.cloudflareGatewayId);
  if (input.provider === 'gemini') return `${root}/google-ai-studio`;
  if (input.provider === 'openrouter') return `${root}/openrouter`;
  if (!input.cloudflareProvider) {
    throw new Error(
      `Cloudflare AI Gateway for ${input.provider} requires cloudflareProvider, the configured custom-provider slug`,
    );
  }
  return `${root}/custom-${encodeURIComponent(input.cloudflareProvider)}/v1`;
}

export function providerRequestHeaders(config: ProviderRuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.gatewayToken) headers['cf-aig-authorization'] = `Bearer ${config.gatewayToken}`;
  if (config.cloudflareByokAlias) headers['cf-aig-byok-alias'] = config.cloudflareByokAlias;
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/cyanxxy/open-ocr-cli-mcp';
    headers['X-Title'] = 'Open OCR CLI & MCP';
  }
  return headers;
}

export function providerTokenPrice(
  config: Pick<ProviderRuntimeConfig, 'provider' | 'model' | 'inputPricePerMillionUsd' | 'outputPricePerMillionUsd'>,
  inputTokens: number,
  now = Date.now(),
): ProviderTokenPrice | undefined {
  if (config.inputPricePerMillionUsd !== undefined && config.outputPricePerMillionUsd !== undefined) {
    return {
      inputPerMillionUsd: config.inputPricePerMillionUsd,
      outputPerMillionUsd: config.outputPricePerMillionUsd,
    };
  }
  // Identical model strings on a generic/private endpoint do not establish its
  // billing rate. Only named provider routes may use the verified price table.
  if (config.provider === 'openai-compatible') return undefined;
  const explicitMuseContributor = config.provider === 'muse'
    && ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'].includes(config.model);
  if (config.provider !== 'openrouter' && !explicitMuseContributor && !providerProfile(config.provider).models.includes(config.model)) {
    return undefined;
  }
  const model = config.provider === 'openrouter'
    ? config.model.replace(/^google\//, '').replace(/^moonshotai\//, '').replace(/^meta\//, '')
    : config.model;
  switch (model) {
    // Verified against https://platform.kimi.ai/docs/pricing/chat on 2026-10-03.
    // The default K3 5-minute cache-write price equals uncached input ($3/M).
    case 'kimi-k3':
      if (config.provider === 'openrouter') return {
        inputPerMillionUsd: 2.7,
        cachedInputPerMillionUsd: 0.27,
        outputPerMillionUsd: 13.5,
      };
      return {
        inputPerMillionUsd: 3,
        cachedInputPerMillionUsd: 0.3,
        outputPerMillionUsd: 15,
      };
    case 'kimi-k2.7-code':
      if (config.provider === 'openrouter') return {
        inputPerMillionUsd: 0.6712,
        cachedInputPerMillionUsd: 0.18,
        outputPerMillionUsd: 3.35,
      };
      return {
        inputPerMillionUsd: 0.95,
        cachedInputPerMillionUsd: 0.19,
        outputPerMillionUsd: 4,
      };
    case 'kimi-k2.7-code-highspeed':
      return {
        inputPerMillionUsd: 1.9,
        cachedInputPerMillionUsd: 0.38,
        outputPerMillionUsd: 8,
      };
    case 'kimi-k2.6':
      return {
        inputPerMillionUsd: 0.95,
        cachedInputPerMillionUsd: 0.16,
        outputPerMillionUsd: 4,
      };
    // Standard paid-tier rates: https://ai.google.dev/gemini-api/docs/pricing
    // The published introductory discount ends at the start of 2027 (UTC).
    case 'gemini-3.8-flash':
    case 'gemini-3.7-flash':
    case 'gemini-3.6-flash':
      return now < Date.UTC(2027, 0, 1)
        ? { inputPerMillionUsd: 0.75, cachedInputPerMillionUsd: 0.075, outputPerMillionUsd: 3.75 }
        : { inputPerMillionUsd: 1.5, cachedInputPerMillionUsd: 0.15, outputPerMillionUsd: 7.5 };
    case 'gemini-3.5-flash-lite':
      return { inputPerMillionUsd: 0.3, cachedInputPerMillionUsd: 0.03, outputPerMillionUsd: 2.5 };
    case 'gemini-3.5-flash':
      return {
        inputPerMillionUsd: 1.5,
        cachedInputPerMillionUsd: 0.15,
        outputPerMillionUsd: 9,
      };
    case 'gemini-3.1-flash-lite':
      return {
        inputPerMillionUsd: 0.25,
        cachedInputPerMillionUsd: 0.025,
        outputPerMillionUsd: 1.5,
      };
    case 'gemini-3-flash-preview':
      return {
        inputPerMillionUsd: 0.5,
        cachedInputPerMillionUsd: 0.05,
        outputPerMillionUsd: 3,
      };
    case 'gemini-3.1-pro-preview':
      return inputTokens > 200_000
        ? { inputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.4, outputPerMillionUsd: 18 }
        : { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 12 };
    // https://dev.meta.ai/docs/pricing-rate-limits (verified 2026-10-03).
    case 'muse-spark-1.3':
    case 'muse-spark-1.2':
    case 'muse-spark-1.1':
      return { inputPerMillionUsd: 1.25, cachedInputPerMillionUsd: 0.15, outputPerMillionUsd: 4.25 };
    case 'muse-spark-1.3-contributor':
    case 'muse-spark-1.2-contributor':
      return { inputPerMillionUsd: 0.1, cachedInputPerMillionUsd: 0.002, outputPerMillionUsd: 0.2 };
    // OpenRouter catalog prices, https://openrouter.ai/api/v1/models (2026-10-03).
    // Actual response cost takes precedence over these estimates.
    case 'openai/gpt-6.1-sol':
      return inputTokens >= 272_000
        ? { inputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 15 }
        : { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.1, outputPerMillionUsd: 10 };
    case 'openai/gpt-6-astra':
      return inputTokens >= 272_000
        ? { inputPerMillionUsd: 20, cachedInputPerMillionUsd: 2, outputPerMillionUsd: 75 }
        : { inputPerMillionUsd: 10, cachedInputPerMillionUsd: 1, outputPerMillionUsd: 50 };
    case 'openai/gpt-6-luna':
      return inputTokens >= 272_000
        ? { inputPerMillionUsd: 0.2, cachedInputPerMillionUsd: 0.02, outputPerMillionUsd: 0.75 }
        : { inputPerMillionUsd: 0.1, cachedInputPerMillionUsd: 0.01, outputPerMillionUsd: 0.5 };
    case 'anthropic/claude-sonnet-5.5':
      return { inputPerMillionUsd: 2, cachedInputPerMillionUsd: 0.2, outputPerMillionUsd: 10 };
    case 'anthropic/claude-fable-5.1':
      return { inputPerMillionUsd: 10, cachedInputPerMillionUsd: 0.25, outputPerMillionUsd: 50 };
    default:
      return undefined;
  }
}

export function estimateProviderRequestCostUsd(
  config: Pick<ProviderRuntimeConfig, 'provider' | 'model' | 'inputPricePerMillionUsd' | 'outputPricePerMillionUsd'>,
  inputTokens: number,
  outputTokens: number,
  thoughtTokens: number,
  cachedTokens = 0,
): number {
  const price = providerTokenPrice(config, inputTokens);
  if (!price) return 0;
  const billedCachedTokens = Math.min(Math.max(cachedTokens, 0), inputTokens);
  const uncachedInputTokens = inputTokens - billedCachedTokens;
  return (
    uncachedInputTokens * price.inputPerMillionUsd
    + billedCachedTokens * (price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd)
    + (outputTokens + thoughtTokens) * price.outputPerMillionUsd
  ) / 1_000_000;
}
