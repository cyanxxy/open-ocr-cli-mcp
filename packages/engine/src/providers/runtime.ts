import { estimateProviderRequestCostUsd } from './registry';
import type { ProviderRuntimeConfig, ProviderUsageSnapshot } from './types';

export interface ProviderRequestPolicy {
  requestsPerMinute?: number;
  maxCostUsd?: number;
}

export interface ProviderRequestSlotOptions {
  /** Cleanup calls still use the shared rate gate but must not be blocked by a completed job's cost ceiling. */
  ignoreCostLimit?: boolean;
}

type UsagePricingConfig = Pick<
  ProviderRuntimeConfig,
  'provider' | 'model' | 'inputPricePerMillionUsd' | 'outputPricePerMillionUsd'
>;

interface UsageMeasurement {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  toolTokens: number;
  cachedTokens: number;
  totalTokens: number;
  exactCost?: number;
  usesOpenAITokenAccounting: boolean;
}

function emptyUsage(): ProviderUsageSnapshot {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    toolTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
  }
  return 0;
}

function optionalNumberAt(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  }
  return undefined;
}

function nestedNumber(record: Record<string, unknown>, key: string, ...nestedKeys: string[]): number {
  const nested = record[key];
  return isRecord(nested) ? numberAt(nested, ...nestedKeys) : 0;
}

function usageMeasurement(response: unknown): UsageMeasurement | undefined {
  if (!isRecord(response)) return undefined;
  const candidate = response.usageMetadata ?? response.usage_metadata ?? response.usage;
  if (!isRecord(candidate)) return undefined;

  const inputTokens = numberAt(
    candidate,
    'promptTokenCount', 'prompt_token_count', 'totalInputTokens', 'total_input_tokens',
    'prompt_tokens', 'input_tokens',
  );
  const outputTokens = numberAt(
    candidate,
    // GenerateContent uses candidatesTokenCount, while the SDK's shared
    // UsageMetadata shape uses responseTokenCount on newer surfaces. Accept
    // both, plus their wire aliases, without making one API impersonate the
    // other in tests.
    'responseTokenCount', 'response_token_count',
    'candidatesTokenCount', 'candidates_token_count',
    'totalOutputTokens', 'total_output_tokens',
    'completion_tokens', 'output_tokens',
  );
  const thoughtTokens = numberAt(
    candidate,
    'thoughtsTokenCount', 'thoughts_token_count', 'totalThoughtTokens', 'total_thought_tokens',
  ) || nestedNumber(candidate, 'completion_tokens_details', 'reasoning_tokens');
  const toolTokens = numberAt(
    candidate,
    'toolUsePromptTokenCount', 'tool_use_prompt_token_count', 'totalToolUseTokens', 'total_tool_use_tokens',
  );
  const cachedTokens = numberAt(
    candidate,
    'cachedContentTokenCount', 'cached_content_token_count', 'totalCachedTokens', 'total_cached_tokens',
  ) || nestedNumber(candidate, 'prompt_tokens_details', 'cached_tokens');
  const reportedTotal = numberAt(
    candidate,
    'totalTokenCount', 'total_token_count', 'totalTokens', 'total_tokens',
  );
  const usesOpenAITokenAccounting = 'completion_tokens' in candidate || 'output_tokens' in candidate;
  return {
    inputTokens,
    outputTokens,
    thoughtTokens,
    toolTokens,
    cachedTokens,
    totalTokens: reportedTotal
      || inputTokens + outputTokens + (usesOpenAITokenAccounting ? 0 : thoughtTokens),
    exactCost: optionalNumberAt(candidate, 'cost', 'estimated_cost', 'estimated_cost_usd'),
    usesOpenAITokenAccounting,
  };
}

function combineUsageMeasurements(responses: readonly unknown[]): UsageMeasurement | undefined {
  const measurements = responses
    .map((response) => usageMeasurement(response))
    .filter((measurement): measurement is UsageMeasurement => measurement !== undefined);
  if (measurements.length === 0) return undefined;
  const allHaveExactCost = measurements.every((measurement) => measurement.exactCost !== undefined);
  return measurements.reduce<UsageMeasurement>((combined, measurement) => ({
    inputTokens: combined.inputTokens + measurement.inputTokens,
    outputTokens: combined.outputTokens + measurement.outputTokens,
    thoughtTokens: combined.thoughtTokens + measurement.thoughtTokens,
    toolTokens: combined.toolTokens + measurement.toolTokens,
    cachedTokens: combined.cachedTokens + measurement.cachedTokens,
    totalTokens: combined.totalTokens + measurement.totalTokens,
    ...(allHaveExactCost
      ? { exactCost: (combined.exactCost ?? 0) + (measurement.exactCost ?? 0) }
      : {}),
    usesOpenAITokenAccounting:
      combined.usesOpenAITokenAccounting || measurement.usesOpenAITokenAccounting,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    toolTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    ...(allHaveExactCost ? { exactCost: 0 } : {}),
    usesOpenAITokenAccounting: false,
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
}

function awaitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      () => { cleanup(); resolve(); },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal ? abortReason(signal) : new DOMException('Operation aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ProviderCostLimitError extends Error {
  constructor(readonly limitUsd: number) {
    super(`Estimated provider cost reached the configured limit of $${limitUsd.toFixed(6)}`);
    this.name = 'ProviderCostLimitError';
  }
}

/**
 * Per-job provider accounting and request gate. A context can be shared by all
 * documents in one batch without leaking rate or cost state into another job.
 */
export class ProviderExecutionContext {
  private usage = emptyUsage();
  private intervalMs = 0;
  private maxCostUsd: number | undefined;
  private previousRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private costLimitDenied = false;
  private usagePricing: UsagePricingConfig | undefined;

  constructor(policy: ProviderRequestPolicy = {}) {
    this.configure(policy);
  }

  configure(policy: ProviderRequestPolicy): void {
    const requestsPerMinute = policy.requestsPerMinute ?? 0;
    this.intervalMs = requestsPerMinute > 0 ? 60_000 / requestsPerMinute : 0;
    this.maxCostUsd = policy.maxCostUsd;
    this.previousRequestAt = 0;
    this.queue = Promise.resolve();
    this.costLimitDenied = false;
    this.usagePricing = undefined;
  }

  /** Per-job prices for transports that report usage with only provider/model. */
  configureUsagePricing(config: UsagePricingConfig): void {
    this.usagePricing = {
      provider: config.provider,
      model: config.model,
      inputPricePerMillionUsd: config.inputPricePerMillionUsd,
      outputPricePerMillionUsd: config.outputPricePerMillionUsd,
    };
  }

  resetUsage(): void {
    this.usage = emptyUsage();
  }

  getUsage(): ProviderUsageSnapshot {
    return {
      ...this.usage,
      estimatedCostUsd: Number(this.usage.estimatedCostUsd.toFixed(8)),
    };
  }

  wasCostLimitDenied(): boolean {
    return this.costLimitDenied;
  }

  /** Compare against unrounded internal cost; public snapshots are display-rounded. */
  hasReachedCostLimit(): boolean {
    return this.maxCostUsd !== undefined
      && this.usage.estimatedCostUsd >= this.maxCostUsd;
  }

  recordUsage(
    response: unknown,
    config?: UsagePricingConfig,
  ): void {
    const measurement = usageMeasurement(response);
    if (!measurement) return;
    this.accumulateUsage(measurement, config);
  }

  /**
   * Record one request whose only usage telemetry is split across multiple
   * parts, such as Interactions `step_usage` values. The caller must prefer a
   * request-level total when one is present so the same request is counted once.
   */
  recordUsageParts(
    responses: readonly unknown[],
    config?: UsagePricingConfig,
  ): void {
    const current = combineUsageMeasurements(responses);
    if (!current) return;
    this.accumulateUsage(current, config);
  }

  private accumulateUsage(measurement: UsageMeasurement, config?: UsagePricingConfig): void {
    this.usage.requests += 1;
    this.usage.inputTokens += measurement.inputTokens;
    this.usage.outputTokens += measurement.outputTokens;
    this.usage.thoughtTokens += measurement.thoughtTokens;
    this.usage.toolTokens += measurement.toolTokens;
    this.usage.cachedTokens += measurement.cachedTokens;
    this.usage.totalTokens += measurement.totalTokens;
    const contextPricing = this.usagePricing;
    const effectivePricing = config && contextPricing
      && config.provider === contextPricing.provider && config.model === contextPricing.model
      ? {
          ...config,
          inputPricePerMillionUsd: config.inputPricePerMillionUsd ?? contextPricing.inputPricePerMillionUsd,
          outputPricePerMillionUsd: config.outputPricePerMillionUsd ?? contextPricing.outputPricePerMillionUsd,
        }
      : config ?? contextPricing;
    const localEstimate = effectivePricing
      ? estimateProviderRequestCostUsd(
        effectivePricing,
        measurement.inputTokens,
        measurement.outputTokens,
        measurement.usesOpenAITokenAccounting ? 0 : measurement.thoughtTokens,
        measurement.cachedTokens,
      )
      : 0;
    const tokenActivity = measurement.inputTokens
      + measurement.outputTokens
      + measurement.thoughtTokens
      + measurement.totalTokens;
    if (measurement.exactCost !== undefined && measurement.exactCost > 0) {
      // Non-zero provider cost is authoritative (OpenRouter-style billing).
      this.usage.estimatedCostUsd += measurement.exactCost;
    } else if (measurement.exactCost === 0 && tokenActivity > 0 && localEstimate > 0) {
      // Zero cost with real token activity is often missing telemetry. Prefer a
      // local estimate so --max-cost cannot fail open on paid routes.
      this.usage.estimatedCostUsd += localEstimate;
    } else if (measurement.exactCost !== undefined) {
      // Truly free (zero tokens, or zero cost without a local price table).
      this.usage.estimatedCostUsd += measurement.exactCost;
    } else if (effectivePricing) {
      this.usage.estimatedCostUsd += localEstimate;
    }
  }

  private assertRequestAllowed(signal?: AbortSignal, options: ProviderRequestSlotOptions = {}): void {
    if (signal?.aborted) throw abortReason(signal);
    const maxCostUsd = this.maxCostUsd;
    if (
      !options.ignoreCostLimit
      && maxCostUsd !== undefined
      && this.usage.estimatedCostUsd >= maxCostUsd
    ) {
      this.costLimitDenied = true;
      throw new ProviderCostLimitError(maxCostUsd);
    }
  }

  async waitForRequestSlot(
    signal?: AbortSignal,
    options: ProviderRequestSlotOptions = {},
  ): Promise<void> {
    this.assertRequestAllowed(signal, options);
    if (this.intervalMs === 0) return;

    let release: () => void = () => undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    try {
      await awaitWithAbort(previous, signal);
      acquired = true;
      this.assertRequestAllowed(signal, options);
      const delayMs = Math.max(0, this.previousRequestAt + this.intervalMs - Date.now());
      await wait(delayMs, signal);
      this.assertRequestAllowed(signal, options);
      this.previousRequestAt = Date.now();
    } finally {
      if (acquired) release();
      else void previous.finally(release);
    }
  }
}

/** Shared context for hosts and direct library consumers. */
export const defaultProviderExecutionContext = new ProviderExecutionContext();

export function createProviderExecutionContext(
  policy: ProviderRequestPolicy = {},
): ProviderExecutionContext {
  return new ProviderExecutionContext(policy);
}
