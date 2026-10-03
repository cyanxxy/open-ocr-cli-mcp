import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { type ExtractedContent, type ThinkingLevel } from '@open-ocr/engine/gemini';
import { providerErrorMessage, redactSensitiveErrorText } from '@open-ocr/engine/gemini/errorPayload';
import { agentLoop } from '@open-ocr/engine/agentLoop';
import { getAgentReadiness, normalizeAgentDocumentType, normalizeAgentFieldName } from '@open-ocr/engine/agentSchema';
import {
  buildEvalSummary,
  evaluateEvalCase,
  renderEvalSummaryMarkdown,
  type EvalCase,
  type EvalExecutionMetadata,
  type EvalRunOutput,
  toEvalRunOutput,
} from '@open-ocr/engine/evals';
import type { AgentMemory } from '@open-ocr/engine/agentTypes';
import {
  GATEWAY_IDS,
  PROVIDER_IDS,
  createProviderExecutionContext,
  extractPresetWithProvider,
  extractTextWithProvider,
  getProviderUsage,
  isKimiK3Route,
  isLocalBaseUrl,
  providerAgentLoop,
  providerDefaultApiKeyEnv,
  providerDefaultBaseUrl,
  providerDefaultModel,
  providerRequestHeaders,
  resolveProviderBaseUrl,
  type GatewayId,
  type ProviderId,
  type ProviderExecutionContext,
  type ProviderRuntimeConfig,
  type ProviderUsageSnapshot,
} from '@open-ocr/engine/providers';
import { getExtractionPreset } from '@open-ocr/engine/templates';
import { nodeRegionCropper } from '../packages/cli/src/nodeRegionCropper';
import { cliThinkingLevels, defaultCliThinkingLevel } from '../packages/cli/src/config';
import {
  assertEvalInputsExist,
  fileToDataUrl,
  loadEvalCases,
  loadEvalGroundTruth,
  loadEvalSuiteConfig,
  resolveRepeatCount,
  resolveSuiteName,
  writeEvalArtifacts,
  writeEvalSummary,
  type EvalArtifact,
} from './shared';

function extractedContentToMarkdown(result: ExtractedContent): string {
  if (result.markdown) {
    return result.markdown;
  }

  const sections = result.sections.flatMap((section) => {
    const heading = section.heading ? [`## ${section.heading}`] : [];
    return [...heading, ...section.content, ''];
  });

  return [result.title ? `# ${result.title}` : '# OCR Extraction', '', ...sections].join('\n').trim();
}

function agentMemoryToMarkdown(memory: AgentMemory): string {
  const fields = Object.entries(memory.extractedFields);
  const lines = [
    '# Agentic OCR Extraction',
    '',
    `Document type: ${memory.documentAnalysis.documentType || 'unknown'}`,
    `Confidence: ${(memory.confidence * 100).toFixed(0)}%`,
    `Iterations: ${memory.currentIteration}`,
    `Fields extracted: ${fields.length}`,
    '',
    '## Fields',
    '',
  ];

  if (fields.length === 0) {
    lines.push('- None');
  } else {
    for (const [fieldName, field] of fields) {
      lines.push(`- ${fieldName}: ${field.value}`);
    }
  }

  return lines.join('\n');
}

function normalizeAgentFields(fields: AgentMemory['extractedFields'], documentType: string) {
  const normalized: Record<string, unknown> = {};
  const normalizedDocumentType = normalizeAgentDocumentType(documentType);

  for (const [fieldName, field] of Object.entries(fields)) {
    const canonicalName = normalizeAgentFieldName(normalizedDocumentType, fieldName);
    if (!(canonicalName in normalized)) {
      normalized[canonicalName] = field;
    }
  }

  return normalized;
}

function agentMemoryToEvalOutput(memory: AgentMemory) {
  const readiness = getAgentReadiness(memory);

  return {
    markdown: agentMemoryToMarkdown(memory),
    json: {
      documentType: normalizeAgentDocumentType(memory.documentAnalysis.documentType || 'unknown'),
      confidence: memory.confidence,
      currentIteration: memory.currentIteration,
      fieldCount: Object.keys(memory.extractedFields).length,
      extractedFields: memory.extractedFields,
      normalizedFields: normalizeAgentFields(memory.extractedFields, memory.documentAnalysis.documentType),
      specialFeatures: memory.documentAnalysis.specialFeatures,
      requiredFields: readiness.requiredFields,
      missingRequiredFields: readiness.missingRequiredFields,
      requiredCoverage: readiness.requiredCoverage,
    },
  };
}

async function runSimpleEvalCase(evalCase: EvalCase, clientConfig: ProviderRuntimeConfig): Promise<EvalRunOutput> {
  const { dataUrl, mimeType } = await fileToDataUrl(evalCase.inputPath);
  const result = await extractTextWithProvider(
    dataUrl,
    mimeType,
    path.basename(evalCase.inputPath),
    clientConfig,
    undefined,
    {
      outputFormat: 'markdown',
    },
  );

  return {
    markdown: extractedContentToMarkdown(result),
    json: result,
  };
}

async function runTemplateEvalCase(evalCase: EvalCase, clientConfig: ProviderRuntimeConfig): Promise<EvalRunOutput> {
  const { dataUrl, mimeType } = await fileToDataUrl(evalCase.inputPath);
  const result = await extractPresetWithProvider(
    dataUrl,
    mimeType,
    path.basename(evalCase.inputPath),
    clientConfig,
    getExtractionPreset(evalCase.presetId || ''),
  );

  return toEvalRunOutput(result);
}

interface AgenticEvalOutput {
  output: EvalRunOutput;
  iterations: number;
  toolCalls: number;
}

async function runAgenticEvalCase(evalCase: EvalCase, clientConfig: ProviderRuntimeConfig): Promise<AgenticEvalOutput> {
  const { dataUrl, mimeType } = await fileToDataUrl(evalCase.inputPath);
  const file = { name: path.basename(evalCase.inputPath), type: mimeType };
  const loopConfig = {
    maxIterations: evalCase.agentConfig?.maxIterations ?? 4,
    confidenceThreshold: evalCase.agentConfig?.confidenceThreshold ?? 0.65,
    maxTokens: isKimiK3Route(clientConfig.provider, clientConfig.model)
      ? 131072
      : clientConfig.model.includes('kimi-') ? 32768 : 4096,
  };
  const generator = clientConfig.provider === 'gemini' ? agentLoop(
    file,
    dataUrl,
    {
      apiKey: clientConfig.apiKey || (clientConfig.cloudflareByok
        ? clientConfig.gatewayToken || 'cloudflare-byok'
        : ''),
      model: clientConfig.model,
      thinkingConfig: clientConfig.thinkingConfig,
      baseUrl: clientConfig.gateway === 'cloudflare'
        || clientConfig.baseUrl !== providerDefaultBaseUrl('gemini')
        ? clientConfig.baseUrl
        : undefined,
      headers: clientConfig.gateway === 'cloudflare' ? providerRequestHeaders(clientConfig) : undefined,
      regionCropper: nodeRegionCropper,
      runtime: clientConfig.runtime,
    },
    loopConfig,
  ) : providerAgentLoop(file, dataUrl, clientConfig, loopConfig, nodeRegionCropper);

  let current = await generator.next();
  while (!current.done) {
    current = await generator.next();
  }

  const memory = current.value as AgentMemory;
  return {
    output: agentMemoryToEvalOutput(memory),
    iterations: memory.currentIteration,
    toolCalls: memory.processingHistory.length,
  };
}

interface CompletedEvalCase {
  result: ReturnType<typeof evaluateEvalCase>;
  artifact: EvalArtifact;
}

/** Keep provider diagnostics useful without printing or persisting credentials. */
export function formatEvalError(error: unknown, credentials: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message
    : typeof error === 'string' ? error : 'Evaluation failed with a non-Error value.';
  // Custom endpoints can use opaque keys that the standard provider-pattern
  // redactor cannot recognize. Cover URL and JSON-escaped error echoes too.
  const secrets = [...new Set(credentials.flatMap((credential) => {
    const value = credential?.trim();
    return value ? [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)] : [];
  }))].sort((left, right) => right.length - left.length);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  return redactSensitiveErrorText(providerErrorMessage(message));
}

function configuredEvalCredentials(env: NodeJS.ProcessEnv): (string | undefined)[] {
  const customKeyEnv = env.EVAL_API_KEY_ENV;
  return [
    ...(customKeyEnv ? [env[customKeyEnv]] : []),
    ...PROVIDER_IDS.map((provider) => env[providerDefaultApiKeyEnv(provider)]),
    env.CLOUDFLARE_AI_GATEWAY_TOKEN,
  ];
}

function estimateCost(usage: ProviderUsageSnapshot): number | undefined {
  return usage.estimatedCostUsd || undefined;
}

function executionMetadata(
  runtime: ProviderExecutionContext,
  startedAt: number,
  extras: Pick<EvalExecutionMetadata, 'iterations' | 'toolCalls'>,
  runtimeError?: string,
  repeatIndex?: number,
): EvalExecutionMetadata {
  const usage = getProviderUsage(runtime);
  return {
    durationMs: performance.now() - startedAt,
    repeatIndex,
    ...extras,
    apiRequests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thoughtTokens: usage.thoughtTokens,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: estimateCost(usage),
    runtimeError,
  };
}

export async function runEvalCase(evalCase: EvalCase, clientConfig: ProviderRuntimeConfig, repeatIndex: number): Promise<CompletedEvalCase> {
  const runtime = createProviderExecutionContext();
  runtime.configureUsagePricing(clientConfig);
  const caseConfig = { ...clientConfig, runtime };
  const startedAt = performance.now();
  let output: EvalRunOutput = { markdown: '' };
  let executionExtras: Pick<EvalExecutionMetadata, 'iterations' | 'toolCalls'> = {};
  try {
    if (evalCase.mode === 'template') {
      output = await runTemplateEvalCase(evalCase, caseConfig);
    } else if (evalCase.mode === 'agentic') {
      const agenticResult = await runAgenticEvalCase(evalCase, caseConfig);
      output = agenticResult.output;
      executionExtras = { iterations: agenticResult.iterations, toolCalls: agenticResult.toolCalls };
    } else {
      output = await runSimpleEvalCase(evalCase, caseConfig);
    }
    const groundTruth = await loadEvalGroundTruth(evalCase);
    const execution = executionMetadata(runtime, startedAt, executionExtras, undefined, repeatIndex);
    return {
      result: evaluateEvalCase(evalCase, output, groundTruth, execution),
      artifact: { evalCase, output, repeatIndex },
    };
  } catch (error) {
    const message = formatEvalError(error, [clientConfig.apiKey, clientConfig.gatewayToken]);
    const execution = executionMetadata(runtime, startedAt, executionExtras, message, repeatIndex);
    let groundTruth;
    try {
      groundTruth = await loadEvalGroundTruth(evalCase);
    } catch {
      // The runtime error below remains the actionable failure if loading the
      // reference also fails.
    }
    return {
      result: evaluateEvalCase(evalCase, output, groundTruth, execution),
      artifact: { evalCase, output, repeatIndex },
    };
  }
}

function resolveThinkingLevel(provider: ProviderId, model: string): ThinkingLevel {
  const allowedLevels = cliThinkingLevels(provider, model);
  const envLevel = (process.env.OPEN_OCR_THINKING ?? process.env.GEMINI_THINKING_LEVEL)?.toUpperCase();

  if (envLevel) {
    if (!allowedLevels.includes(envLevel as ThinkingLevel)) {
      throw new Error(
        `OPEN_OCR_THINKING must be one of ${allowedLevels.join(', ')} for ${provider}/${model}`,
      );
    }
    return envLevel as ThinkingLevel;
  }
  return defaultCliThinkingLevel(provider, model);
}

export function resolveEvalTokenPrices(
  env: NodeJS.ProcessEnv,
): Pick<ProviderRuntimeConfig, 'inputPricePerMillionUsd' | 'outputPricePerMillionUsd'> {
  const input = env.EVAL_INPUT_USD_PER_MILLION;
  const output = env.EVAL_OUTPUT_USD_PER_MILLION;
  if (input === undefined && output === undefined) return {};
  if (input === undefined || output === undefined) {
    throw new Error('Set both EVAL_INPUT_USD_PER_MILLION and EVAL_OUTPUT_USD_PER_MILLION to override eval prices');
  }
  const inputPricePerMillionUsd = Number(input);
  const outputPricePerMillionUsd = Number(output);
  if (!input.trim() || !output.trim()
    || !Number.isFinite(inputPricePerMillionUsd) || inputPricePerMillionUsd < 0
    || !Number.isFinite(outputPricePerMillionUsd) || outputPricePerMillionUsd < 0) {
    throw new Error('EVAL_INPUT_USD_PER_MILLION and EVAL_OUTPUT_USD_PER_MILLION must be finite nonnegative numbers');
  }
  return { inputPricePerMillionUsd, outputPricePerMillionUsd };
}

async function main() {
  const tokenPrices = resolveEvalTokenPrices(process.env);
  const providerValue = process.env.EVAL_PROVIDER ?? process.env.OPEN_OCR_PROVIDER ?? 'gemini';
  if (!PROVIDER_IDS.includes(providerValue as ProviderId)) throw new Error(`Unsupported EVAL_PROVIDER: ${providerValue}`);
  const provider = providerValue as ProviderId;
  const gatewayValue = process.env.EVAL_GATEWAY ?? process.env.OPEN_OCR_GATEWAY ?? 'direct';
  if (!GATEWAY_IDS.includes(gatewayValue as GatewayId)) throw new Error(`Unsupported EVAL_GATEWAY: ${gatewayValue}`);
  const gateway = gatewayValue as GatewayId;
  const defaultModel = providerDefaultModel(provider);
  const model = process.env.OPEN_OCR_MODEL ?? process.env.GEMINI_MODEL ?? defaultModel;
  if (!model) throw new Error('OPEN_OCR_MODEL is required for this provider.');
  const apiKeyEnv = process.env.EVAL_API_KEY_ENV ?? providerDefaultApiKeyEnv(provider);
  const apiKey = process.env[apiKeyEnv]?.trim() ?? '';
  const cloudflareByok = process.env.CLOUDFLARE_AI_GATEWAY_BYOK === '1';
  if (gateway === 'cloudflare' && cloudflareByok && !process.env.CLOUDFLARE_AI_GATEWAY_TOKEN) {
    throw new Error('CLOUDFLARE_AI_GATEWAY_TOKEN is required for Cloudflare BYOK evals.');
  }
  const baseUrl = resolveProviderBaseUrl({
    provider,
    gateway,
    baseUrl: process.env.OPEN_OCR_BASE_URL,
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareGatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID,
    cloudflareProvider: process.env.CLOUDFLARE_AI_GATEWAY_PROVIDER,
  });
  if (!apiKey && !cloudflareByok && !(provider === 'openai-compatible' && isLocalBaseUrl(baseUrl))) {
    // EVAL_API_KEY_ENV is untrusted configuration, not a credential to echo.
    // A user may accidentally put the secret itself here instead of its name.
    throw new Error('A provider credential is required for live evals. Set the provider’s default key variable, or set EVAL_API_KEY_ENV to the name of a populated credential variable.');
  }
  const suite = resolveSuiteName();
  const repeatCount = resolveRepeatCount();
  const thinkingLevel = resolveThinkingLevel(provider, model);
  const evalCases = await loadEvalCases(suite);
  if (evalCases.length === 0) {
    const setupHint = suite === 'benchmark' ? ' Run `npm run evals:setup` first.' : '';
    throw new Error(`No eval cases are installed for the "${suite}" suite.${setupHint}`);
  }
  const suiteConfig = await loadEvalSuiteConfig();
  const clientConfig: ProviderRuntimeConfig = {
    provider,
    gateway,
    apiKey,
    apiKeyEnv,
    model,
    baseUrl,
    thinkingConfig: {
      level: thinkingLevel,
      includeThoughts: false,
    },
    gatewayToken: process.env.CLOUDFLARE_AI_GATEWAY_TOKEN,
    gatewayTokenEnv: 'CLOUDFLARE_AI_GATEWAY_TOKEN',
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareGatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID,
    cloudflareByok,
    cloudflareByokAlias: process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS,
    cloudflareProvider: process.env.CLOUDFLARE_AI_GATEWAY_PROVIDER,
    ...tokenPrices,
  };

  await assertEvalInputsExist(evalCases);

  const caseResults = [];
  const artifacts: EvalArtifact[] = [];

  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    for (const evalCase of evalCases) {
      const completed = await runEvalCase(evalCase, clientConfig, repeatIndex);
      caseResults.push(completed.result);
      artifacts.push(completed.artifact);
    }
  }

  const summary = buildEvalSummary(model, caseResults, suiteConfig, suite);
  summary.provider = provider;
  summary.gateway = gateway;
  if (repeatCount > 1) {
    summary.notes = [...(summary.notes ?? []), `Each case was run ${repeatCount} times; aggregate metrics include all repetitions.`];
  }
  const markdown = renderEvalSummaryMarkdown(summary);

  await writeEvalSummary(summary, markdown);
  const artifactDirectory = await writeEvalArtifacts(summary, artifacts);
  console.log(`Wrote eval artifacts to ${path.relative(process.cwd(), artifactDirectory)}`);

  if (summary.status === 'failed') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${formatEvalError(error, configuredEvalCredentials(process.env))}\n`);
    process.exitCode = 1;
  });
}
