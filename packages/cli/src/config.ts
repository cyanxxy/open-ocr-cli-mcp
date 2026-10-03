import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { ThinkingLevel } from '@open-ocr/engine/gemini';
import {
  GATEWAY_IDS,
  GEMINI_MODELS,
  PROVIDER_IDS,
  isKimiK3Route,
  isLocalBaseUrl,
  knownModelThinkingLevels,
  providerDefaultApiKeyEnv,
  providerDefaultModel,
  providerDefaultThinkingLevel,
  providerTokenPrice,
  resolveProviderBaseUrl,
  type GatewayId,
  type ProviderId,
} from '@open-ocr/engine/providers';
import { getExtractionPreset, listExtractionPresets } from '@open-ocr/engine/templates';
import { CliExitError } from './errors';
import { asRecord } from './jsonValidation';
import { OCR_REQUEST_LIMITS, PRICE_PER_MILLION_LIMIT } from './limits';
import {
  CLI_FORMATS,
  CLI_MODES,
  SUPPORTED_MODELS,
  type CliConfigFile,
  type CliFormat,
  type CliMode,
  type ExtractCommandFlags,
  type ResolvedCliOptions,
} from './types';

const DEFAULT_CONFIG: Required<Pick<
  ResolvedCliOptions,
  | 'provider'
  | 'gateway'
  | 'model'
  | 'thinking'
  | 'includeThoughts'
  | 'progress'
  | 'mode'
  | 'format'
  | 'concurrency'
  | 'retries'
  | 'timeoutSeconds'
  | 'maxFiles'
  | 'maxTotalMb'
  | 'hidden'
  | 'defaultExcludes'
  | 'resume'
  | 'overwrite'
  | 'failFast'
  | 'jsonl'
  | 'dryRun'
  | 'quiet'
  | 'verbose'
  | 'stdinName'
  | 'detectImages'
  | 'detectMath'
  | 'maxTokens'
  | 'maxIterations'
  | 'confidenceThreshold'
  | 'requestsPerMinute'
>> = {
  provider: 'gemini',
  gateway: 'direct',
  model: 'gemini-3.8-flash',
  thinking: 'MEDIUM',
  includeThoughts: false,
  progress: 'standard',
  mode: 'simple',
  format: 'markdown',
  concurrency: 2,
  retries: 3,
  timeoutSeconds: 120,
  maxFiles: 1000,
  maxTotalMb: 5120,
  hidden: false,
  defaultExcludes: true,
  resume: true,
  overwrite: false,
  failFast: false,
  jsonl: false,
  dryRun: false,
  quiet: false,
  verbose: false,
  stdinName: 'stdin',
  detectImages: false,
  detectMath: false,
  maxTokens: 32768,
  maxIterations: 5,
  confidenceThreshold: 0.8,
  requestsPerMinute: 0,
};

/**
 * A permanent request error: the flags, request fields, or configuration file
 * are wrong and rerunning the identical command cannot succeed.
 *
 * These are typed at the throw site rather than left as bare `Error`s so
 * `asCliExitError` short-circuits before its untyped-error classifier, which
 * would otherwise read an option name such as `--timeout` as evidence of a
 * retryable runtime timeout.
 */
function configurationError(message: string): CliExitError {
  return new CliExitError(message, 2, {
    code: 'CONFIG_INVALID',
    category: 'configuration',
    retryable: false,
    hint: 'Check the request, command flags, and configuration.',
  });
}

/** A missing provider or gateway credential, reported after local validation. */
function credentialError(message: string): CliExitError {
  return new CliExitError(message, 2, {
    code: 'AUTH_MISSING',
    category: 'authentication',
    retryable: false,
    hint: 'Configure the named credential environment variable; never pass a raw key as an argument.',
  });
}

/** Map an unreadable configuration path to a typed error instead of a raw errno. */
function configFileError(error: unknown, displayPath: string): CliExitError | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return configurationError(`Configuration file not found: ${displayPath}`);
  if (code === 'EISDIR') return configurationError(`Configuration path is not a file: ${displayPath}`);
  if (code === 'EACCES' || code === 'EPERM') {
    return configurationError(`Configuration file is not readable: ${displayPath}`);
  }
  return undefined;
}

function pickConfig(value: Record<string, unknown>, label: string): CliConfigFile {
  const stringKeys = [
    'provider', 'gateway', 'model', 'baseUrl', 'thinking', 'progress', 'mode', 'preset', 'format', 'output',
    'apiKeyEnv', 'schema', 'cloudflareAccountId', 'cloudflareGatewayId', 'cloudflareTokenEnv',
    'cloudflareByokAlias', 'cloudflareProvider',
  ] as const;
  const numberKeys = [
    'concurrency', 'retries', 'timeoutSeconds', 'maxFiles', 'maxTotalMb', 'maxTokens',
    'maxIterations', 'confidenceThreshold', 'maxCostUsd', 'requestsPerMinute',
    'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
  ] as const;
  const booleanKeys = [
    'resume', 'overwrite', 'failFast', 'hidden', 'defaultExcludes', 'detectImages',
    'detectMath', 'cloudflareByok',
  ] as const;
  const arrayKeys = ['exclude', 'instructions'] as const;
  const knownKeys = new Set<string>([...stringKeys, ...numberKeys, ...booleanKeys, ...arrayKeys]);

  // Typed at the throw site rather than left as bare `Error`s. The untyped
  // classifier matches substrings of the message, and these messages quote the
  // offending key: `"timeoutSeconds" must be a finite number` contains the word
  // "timeout", so a permanently broken config file was reported as a retryable
  // TIMEOUT and an agent obeying `retryable` would retry it forever.
  for (const key of stringKeys) {
    const entry = value[key];
    if (entry !== undefined && typeof entry !== 'string') {
      throw configurationError(`${label}: "${key}" must be a string`);
    }
  }
  for (const key of numberKeys) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw configurationError(`${label}: "${key}" must be a finite number`);
    }
  }
  for (const key of booleanKeys) {
    const entry = value[key];
    if (entry !== undefined && typeof entry !== 'boolean') {
      throw configurationError(`${label}: "${key}" must be a boolean`);
    }
  }

  for (const key of arrayKeys) {
    const entry = value[key];
    if (entry !== undefined && (!Array.isArray(entry) || entry.some((item) => typeof item !== 'string'))) {
      throw configurationError(`${label}: "${key}" must be an array of strings`);
    }
  }

  const unknownKeys = Object.keys(value).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    process.stderr.write(`${label}: ignoring unknown configuration key(s): ${unknownKeys.join(', ')}\n`);
  }
  const allowlisted = Object.fromEntries(
    Object.entries(value).filter(([key]) => knownKeys.has(key)),
  );
  return allowlisted;
}

async function readConfigFile(
  filePath: string,
  required: boolean,
  displayPath = filePath,
): Promise<CliConfigFile> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return pickConfig(asRecord(JSON.parse(raw) as unknown, displayPath), displayPath);
  } catch (error) {
    if (error instanceof CliExitError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (!required && code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw configurationError(`Invalid JSON in ${displayPath}: ${error.message}`);
    // An explicitly requested config file that cannot be read is a request
    // error; reporting the raw errno would leak the resolved absolute path.
    const typed = configFileError(error, displayPath);
    if (typed) throw typed;
    // Everything else here is still a malformed configuration file — `asRecord`
    // rejecting a JSON array, for one. Typing it keeps the message-substring
    // classifier from reading the file path or key name as a different failure.
    throw configurationError(`${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function environmentDisablesConfig(): boolean {
  const value = process.env.OPEN_OCR_NO_CONFIG?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function cliConfigDisabled(value?: string | false, disabled = false): boolean {
  // Explicit --no-config / request.noConfig always wins. An explicit config path
  // still allows loading that one file under hermetic ambient mode (see
  // loadCliConfig), but does not re-enable user/project merges or .env.
  return disabled || value === false || (value === undefined && environmentDisablesConfig());
}

export function defaultCliThinkingLevel(provider: ProviderId, model: string): ThinkingLevel {
  return providerDefaultThinkingLevel(provider, model);
}

export function cliThinkingLevels(provider: ProviderId, model: string): readonly ThinkingLevel[] {
  const known = knownModelThinkingLevels(provider, model);
  if (known) return known;
  if (provider === 'openrouter') return ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
  if (provider === 'muse') return ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'];
  return ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
}

export async function loadCliConfig(
  cwd: string,
  explicitPath?: string,
  disabled = false,
): Promise<CliConfigFile> {
  const hermetic = disabled || environmentDisablesConfig();
  if (hermetic && !explicitPath) return {};
  const explicit = explicitPath
    ? await readConfigFile(path.resolve(cwd, explicitPath), true, explicitPath)
    : {};
  // Hermetic mode may still load one explicit config file, but never ambient
  // user/project files that could reintroduce baseUrl or credential env names.
  if (hermetic) return explicit;

  const userPath = path.join(homedir(), '.config', 'open-ocr-cli', 'config.json');
  const projectPath = path.join(cwd, '.open-ocr-cli.json');
  const [user, project] = await Promise.all([
    readConfigFile(userPath, false),
    readConfigFile(projectPath, false),
  ]);
  return { ...user, ...project, ...explicit };
}

export function loadLocalEnv(cwd: string, disabled = false): void {
  // Ambient OPEN_OCR_NO_CONFIG always blocks project .env, even when a caller
  // passes an explicit config path for option resolution.
  if (disabled || environmentDisablesConfig()) return;
  const envPath = path.join(cwd, '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

export function credentialSetupGuidance(apiKeyEnv: string, cwd: string, provider = 'provider'): string {
  return [
    `Set ${apiKeyEnv} with your ${provider} API key before running extraction:`,
    `  macOS/Linux: export ${apiKeyEnv}="your-key"`,
    `  PowerShell:   $env:${apiKeyEnv}="your-key"`,
    `  Project:      add ${apiKeyEnv}=your-key to ${path.join(cwd, '.env')} (keep it out of version control)`,
    'Then run: open-ocr-cli doctor (agents: doctor --json emits the same checks machine-readably)',
  ].join('\n');
}

function integer(value: string | number | undefined, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw configurationError(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function numberInRange(value: string | number | undefined, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw configurationError(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function optionalNumberInRange(
  value: string | number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  return numberInRange(value, min, label, min, max);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw configurationError(`${label} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

/**
 * Which vocabulary a configuration error names its option in.
 *
 * `flag` is the `extract` command's `--option` spelling. `field` is the
 * machine-protocol request path (`execution.concurrency`), which `run` and MCP
 * use so a caller that sent JSON is not told to fix a flag it never typed.
 * Options with no request field name their configuration-file key instead.
 */
export type OptionVocabulary = 'flag' | 'field';

const OPTION_NAMES = {
  provider: ['--provider', 'provider.id'],
  gateway: ['--gateway', 'provider.gateway'],
  model: ['--model', 'provider.model'],
  thinking: ['--thinking', 'extraction.thinking'],
  mode: ['--mode', 'extraction.mode'],
  format: ['--format', 'extraction.contentFormat'],
  progress: ['--progress', 'extraction.progress'],
  schema: ['--schema', 'extraction.schema'],
  preset: ['--preset', 'extraction.preset'],
  maxTokens: ['--max-tokens', 'extraction.maxTokens'],
  maxIterations: ['--max-iterations', 'extraction.maxIterations'],
  confidenceThreshold: ['--confidence-threshold', 'extraction.confidenceThreshold'],
  concurrency: ['--concurrency', 'execution.concurrency'],
  retries: ['--retries', 'execution.retries'],
  timeout: ['--timeout', 'execution.timeoutSeconds'],
  maxFiles: ['--max-files', 'execution.maxFiles'],
  maxTotalMb: ['--max-total-mb', 'execution.maxTotalMb'],
  maxCost: ['--max-cost', 'execution.maxCostUsd'],
  requestsPerMinute: ['--requests-per-minute', 'execution.requestsPerMinute'],
  inputPrice: ['--input-price', 'inputPricePerMillionUsd'],
  outputPrice: ['--output-price', 'outputPricePerMillionUsd'],
  cloudflareByok: ['--cloudflare-byok', 'cloudflareByok'],
  cloudflareByokAlias: ['--cloudflare-byok-alias', 'cloudflareByokAlias'],
} as const satisfies Record<string, readonly [flag: string, field: string]>;

export function resolveCliOptions(
  flags: ExtractCommandFlags,
  fileConfig: CliConfigFile,
  cwd: string,
  vocabulary: OptionVocabulary = 'flag',
): ResolvedCliOptions {
  const name = (key: keyof typeof OPTION_NAMES): string => OPTION_NAMES[key][vocabulary === 'flag' ? 0 : 1];
  const configuredProvider = fileConfig.provider ?? DEFAULT_CONFIG.provider;
  const selectedProvider = flags.provider ?? process.env.OPEN_OCR_PROVIDER;
  const provider = oneOf<ProviderId>(
    selectedProvider ?? configuredProvider,
    PROVIDER_IDS,
    name('provider'),
    DEFAULT_CONFIG.provider,
  );
  const providerContextMatches = selectedProvider === undefined || selectedProvider === configuredProvider;
  const configuredGateway = fileConfig.gateway ?? DEFAULT_CONFIG.gateway;
  const selectedGateway = flags.gateway ?? process.env.OPEN_OCR_GATEWAY;
  const gateway = oneOf<GatewayId>(
    selectedGateway ?? configuredGateway,
    GATEWAY_IDS,
    name('gateway'),
    DEFAULT_CONFIG.gateway,
  );
  const gatewayContextMatches = selectedGateway === undefined || selectedGateway === configuredGateway;
  const selectedModel = flags.model
    ?? process.env.OPEN_OCR_MODEL;
  const configuredModel = providerContextMatches
    ? fileConfig.model ?? providerDefaultModel(provider)
    : providerDefaultModel(provider);
  const model = selectedModel
    ?? configuredModel
    ?? providerDefaultModel(provider);
  if (!model) throw configurationError(`${name('model')} is required for the openai-compatible provider`);
  if (provider === 'gemini' && !GEMINI_MODELS.includes(model as (typeof GEMINI_MODELS)[number])) {
    throw configurationError(`${name('model')} must be one of: ${SUPPORTED_MODELS.join(', ')}`);
  }
  const modelContextMatches = providerContextMatches
    && (selectedModel === undefined || selectedModel === configuredModel);
  const configuredThinking = flags.thinking
    ?? process.env.OPEN_OCR_THINKING
    ?? (modelContextMatches ? fileConfig.thinking : undefined);
  const isKimiK3 = isKimiK3Route(provider, model);
  let thinking = oneOf<ThinkingLevel>(
    configuredThinking?.toUpperCase(),
    ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'],
    name('thinking'),
    defaultCliThinkingLevel(provider, model),
  );
  const schemaPath = flags.schema ?? fileConfig.schema;
  const hasCustomSchema = flags.customSchema ?? false;
  const hasSchema = hasCustomSchema || Boolean(schemaPath);
  const mode = oneOf<CliMode>(flags.mode ?? fileConfig.mode, CLI_MODES, name('mode'), DEFAULT_CONFIG.mode);
  const format = oneOf<CliFormat>(
    flags.format ?? fileConfig.format ?? (hasSchema ? 'json' : undefined),
    CLI_FORMATS,
    name('format'),
    DEFAULT_CONFIG.format,
  );
  const preset = flags.preset ?? fileConfig.preset;
  const effectiveMode: CliMode = preset && !flags.mode && !fileConfig.mode ? 'template' : mode;
  const progress = oneOf<ResolvedCliOptions['progress']>(
    flags.progress ?? fileConfig.progress,
    ['off', 'standard', 'detailed'],
    name('progress'),
    DEFAULT_CONFIG.progress,
  );

  if (!isKimiK3 && provider !== 'openrouter' && !(provider === 'muse' && model === 'muse-spark-1.3') && thinking === 'MAX') {
    throw configurationError(`${name('thinking')} max is supported by Kimi K3, Muse Spark 1.3 Standard, and model-dependent OpenRouter routes`);
  }
  if (provider !== 'openrouter' && provider !== 'muse' && thinking === 'XHIGH') {
    throw configurationError(`${name('thinking')} xhigh is supported by Muse and model-dependent OpenRouter routes`);
  }
  if (provider === 'gemini' && model === 'gemini-3.1-pro-preview' && thinking === 'MINIMAL') {
    throw configurationError(`Gemini 3.1 Pro supports ${name('thinking')} low, medium, or high; minimal is not supported`);
  }
  if (isKimiK3 && thinking === 'MEDIUM') {
    throw configurationError(`Kimi K3 supports ${name('thinking')} low, high, or max; medium would be an ambiguous silent upgrade`);
  }
  if (isKimiK3 && thinking === 'XHIGH') {
    throw configurationError(`Kimi K3 supports ${name('thinking')} low, high, or max; xhigh is not a Kimi K3 effort`);
  }
  if (isKimiK3 && thinking === 'MINIMAL') {
    thinking = 'LOW';
  }
  if (provider === 'kimi' && /^kimi-k2\.7-code/u.test(model) && thinking !== 'HIGH') {
    throw configurationError(`Kimi K2.7 Code always thinks and does not expose configurable reasoning effort; use ${name('thinking')} high`);
  }
  if (provider === 'kimi' && model === 'kimi-k2.6' && thinking !== 'MINIMAL' && thinking !== 'HIGH') {
    throw configurationError(`Direct Kimi K2.6 supports only instant mode (${name('thinking')} minimal) or thinking mode (${name('thinking')} high)`);
  }
  const knownThinking = knownModelThinkingLevels(provider, model);
  if (knownThinking && !knownThinking.includes(thinking)) {
    throw configurationError(`${model} supports ${name('thinking')} ${knownThinking.map((level) => level.toLowerCase()).join(', ')}; ${thinking.toLowerCase()} is not supported`);
  }
  if (hasSchema && preset) throw configurationError(`${name('schema')} cannot be combined with ${name('preset')}`);
  if (effectiveMode === 'template' && !preset) throw configurationError(`${name('preset')} is required when ${name('mode')} template is selected`);
  // A preset only implies template mode when no mode is named. Without this the
  // converse rule, an explicit --mode (or a `mode` config key) would silently
  // demote the preset to an inert option, exactly as `run` and `mcp` already
  // refuse to do (see ocrExtractionSemanticError in protocol.ts).
  if (preset && effectiveMode !== 'template') throw configurationError(`${name('preset')} is only available in template mode`);
  if (preset) getExtractionPreset(preset);
  if (format === 'csv' && effectiveMode !== 'template') throw configurationError(`${name('format')} csv is only available in template mode`);
  // A record-shaped preset extracts one document's worth of fields and never
  // rows, so CSV cannot be built from it. Without this the run reaches the
  // provider, bills a call, and fails afterwards on the missing CSV artifact
  // (see ocrExtractionSemanticError in protocol.ts for the `run`/MCP wording).
  if (format === 'csv' && preset && getExtractionPreset(preset).outputShape !== 'table') {
    const tablePresets = listExtractionPresets()
      .filter((candidate) => candidate.outputShape === 'table')
      .map((candidate) => candidate.id)
      .join(', ');
    throw configurationError(
      `${name('preset')} ${preset} extracts a single record per document, so it cannot produce CSV rows; `
      + `use ${name('format')} json or markdown, or a table preset: ${tablePresets}`,
    );
  }
  if (hasSchema && effectiveMode !== 'simple') throw configurationError(`${name('schema')} is only available in simple mode`);
  if (hasSchema && format !== 'json') throw configurationError(`${name('schema')} requires ${name('format')} json`);
  const defaultMaxTokens = isKimiK3
    // Agentic K3 can issue many continuations; keep a safer default budget
    // unless the operator opts into the full protocol ceiling.
    ? (effectiveMode === 'agentic' ? 32_768 : 131_072)
    : DEFAULT_CONFIG.maxTokens;
  const maxTokens = integer(
    flags.maxTokens ?? (modelContextMatches ? fileConfig.maxTokens : undefined),
    defaultMaxTokens,
    name('maxTokens'),
    OCR_REQUEST_LIMITS.maxTokens.min,
    provider === 'gemini' ? 65536 : OCR_REQUEST_LIMITS.maxTokens.max,
  );
  if (
    effectiveMode === 'agentic'
    && thinking !== 'MINIMAL'
    && model.includes('kimi-k2.6')
    && maxTokens < 16_000
  ) {
    throw configurationError(`${name('maxTokens')} must be at least 16000 for Kimi K2.6 agentic tool use with thinking enabled`);
  }

  const cloudflareAccountId = flags.cloudflareAccountId
    ?? process.env.CLOUDFLARE_ACCOUNT_ID
    ?? fileConfig.cloudflareAccountId;
  const cloudflareGatewayId = flags.cloudflareGatewayId
    ?? process.env.CLOUDFLARE_AI_GATEWAY_ID
    ?? fileConfig.cloudflareGatewayId;
  const cloudflareProvider = flags.cloudflareProvider
    ?? (providerContextMatches ? fileConfig.cloudflareProvider : undefined);
  const baseUrl = resolveProviderBaseUrl({
    provider,
    gateway,
    baseUrl: flags.baseUrl
      ?? (providerContextMatches && gatewayContextMatches ? fileConfig.baseUrl : undefined),
    cloudflareAccountId,
    cloudflareGatewayId,
    cloudflareProvider,
  });
  const apiKeyEnv = flags.apiKeyEnv
    ?? (providerContextMatches ? fileConfig.apiKeyEnv : undefined)
    ?? providerDefaultApiKeyEnv(provider);
  const apiKey = process.env[apiKeyEnv]?.trim() || '';
  const cloudflareByok = flags.cloudflareByok
    ?? (providerContextMatches && gatewayContextMatches ? fileConfig.cloudflareByok : undefined)
    ?? false;
  const cloudflareByokAlias = flags.cloudflareByokAlias
    ?? (providerContextMatches && gatewayContextMatches ? fileConfig.cloudflareByokAlias : undefined);
  if (cloudflareByok && gateway !== 'cloudflare') {
    throw configurationError(`${name('cloudflareByok')} requires ${name('gateway')} cloudflare`);
  }
  if (cloudflareByokAlias && !cloudflareByok) {
    throw configurationError(`${name('cloudflareByokAlias')} requires ${name('cloudflareByok')}`);
  }
  const gatewayTokenEnv = flags.cloudflareTokenEnv
    ?? fileConfig.cloudflareTokenEnv
    ?? 'CLOUDFLARE_AI_GATEWAY_TOKEN';
  const gatewayToken = gateway === 'cloudflare' ? process.env[gatewayTokenEnv]?.trim() : undefined;
  const hasFlagPrice = flags.inputPrice !== undefined || flags.outputPrice !== undefined;
  const inputPricePerMillionUsd = optionalNumberInRange(
    hasFlagPrice
      ? flags.inputPrice
      : modelContextMatches ? fileConfig.inputPricePerMillionUsd : undefined,
    name('inputPrice'),
    PRICE_PER_MILLION_LIMIT.min,
    PRICE_PER_MILLION_LIMIT.max,
  );
  const outputPricePerMillionUsd = optionalNumberInRange(
    hasFlagPrice
      ? flags.outputPrice
      : modelContextMatches ? fileConfig.outputPricePerMillionUsd : undefined,
    name('outputPrice'),
    PRICE_PER_MILLION_LIMIT.min,
    PRICE_PER_MILLION_LIMIT.max,
  );
  if ((inputPricePerMillionUsd === undefined) !== (outputPricePerMillionUsd === undefined)) {
    throw configurationError(`${name('inputPrice')} and ${name('outputPrice')} must be supplied together`);
  }
  const maxCostUsd = optionalNumberInRange(
    flags.maxCost ?? fileConfig.maxCostUsd,
    name('maxCost'),
    OCR_REQUEST_LIMITS.maxCostUsd.min,
    OCR_REQUEST_LIMITS.maxCostUsd.max,
  );
  const canAccountCost = provider === 'openrouter' || providerTokenPrice({
    provider,
    model,
    inputPricePerMillionUsd,
    outputPricePerMillionUsd,
  }, 0) !== undefined;
  if (maxCostUsd !== undefined && !canAccountCost) {
    throw configurationError(
      `${name('maxCost')} for ${provider}/${model} requires both ${name('inputPrice')} and ${name('outputPrice')} because the API does not report a portable cost`,
    );
  }

  return {
    provider,
    gateway,
    apiKey,
    apiKeyEnv,
    model,
    baseUrl,
    gatewayToken,
    gatewayTokenEnv,
    cloudflareAccountId,
    cloudflareGatewayId,
    cloudflareByok,
    cloudflareByokAlias,
    cloudflareProvider,
    inputPricePerMillionUsd,
    outputPricePerMillionUsd,
    thinking,
    // Thought summaries are an agent progress surface. Simple/template/web
    // extraction has no consumer for them, so requesting hidden summaries
    // would only spend output tokens without changing the returned artifact.
    includeThoughts: effectiveMode === 'agentic' && progress !== 'off',
    progress,
    mode: effectiveMode,
    preset,
    format,
    output: flags.output ?? fileConfig.output,
    outputPathKind: flags.outputPathKind ?? 'auto',
    concurrency: integer(
      flags.concurrency ?? fileConfig.concurrency,
      DEFAULT_CONFIG.concurrency,
      name('concurrency'),
      OCR_REQUEST_LIMITS.concurrency.min,
      OCR_REQUEST_LIMITS.concurrency.max,
    ),
    retries: integer(
      flags.retries ?? fileConfig.retries,
      DEFAULT_CONFIG.retries,
      name('retries'),
      OCR_REQUEST_LIMITS.retries.min,
      OCR_REQUEST_LIMITS.retries.max,
    ),
    timeoutSeconds: integer(
      flags.timeout ?? fileConfig.timeoutSeconds,
      DEFAULT_CONFIG.timeoutSeconds,
      name('timeout'),
      OCR_REQUEST_LIMITS.timeoutSeconds.min,
      OCR_REQUEST_LIMITS.timeoutSeconds.max,
    ),
    maxFiles: integer(
      flags.maxFiles ?? fileConfig.maxFiles,
      DEFAULT_CONFIG.maxFiles,
      name('maxFiles'),
      OCR_REQUEST_LIMITS.maxFiles.min,
      OCR_REQUEST_LIMITS.maxFiles.max,
    ),
    maxTotalMb: numberInRange(
      flags.maxTotalMb ?? fileConfig.maxTotalMb,
      DEFAULT_CONFIG.maxTotalMb,
      name('maxTotalMb'),
      OCR_REQUEST_LIMITS.maxTotalMb.min,
      OCR_REQUEST_LIMITS.maxTotalMb.max,
    ),
    excludes: [...(fileConfig.exclude ?? []), ...(flags.exclude ?? [])],
    instructions: [...(fileConfig.instructions ?? []), ...(flags.instruction ?? [])],
    hidden: flags.hidden ?? fileConfig.hidden ?? DEFAULT_CONFIG.hidden,
    defaultExcludes: flags.defaultExcludes ?? fileConfig.defaultExcludes ?? DEFAULT_CONFIG.defaultExcludes,
    resume: flags.resume ?? fileConfig.resume ?? DEFAULT_CONFIG.resume,
    overwrite: flags.overwrite ?? fileConfig.overwrite ?? DEFAULT_CONFIG.overwrite,
    forceUnlock: flags.forceUnlock ?? false,
    failFast: flags.failFast ?? fileConfig.failFast ?? DEFAULT_CONFIG.failFast,
    jsonl: flags.jsonl ?? DEFAULT_CONFIG.jsonl,
    dryRun: flags.dryRun ?? DEFAULT_CONFIG.dryRun,
    quiet: flags.quiet ?? DEFAULT_CONFIG.quiet,
    verbose: flags.verbose ?? DEFAULT_CONFIG.verbose,
    stdinName: flags.stdinName ?? DEFAULT_CONFIG.stdinName,
    stdinType: flags.stdinType,
    detectImages: flags.detectImages ?? fileConfig.detectImages ?? DEFAULT_CONFIG.detectImages,
    detectMath: flags.detectMath ?? fileConfig.detectMath ?? DEFAULT_CONFIG.detectMath,
    maxTokens,
    maxIterations: integer(
      flags.maxIterations ?? fileConfig.maxIterations,
      DEFAULT_CONFIG.maxIterations,
      name('maxIterations'),
      OCR_REQUEST_LIMITS.maxIterations.min,
      OCR_REQUEST_LIMITS.maxIterations.max,
    ),
    confidenceThreshold: numberInRange(
      flags.confidenceThreshold ?? fileConfig.confidenceThreshold,
      DEFAULT_CONFIG.confidenceThreshold,
      name('confidenceThreshold'),
      OCR_REQUEST_LIMITS.confidenceThreshold.min,
      OCR_REQUEST_LIMITS.confidenceThreshold.max,
    ),
    schemaPath,
    maxCostUsd,
    requestsPerMinute: integer(
      flags.requestsPerMinute ?? fileConfig.requestsPerMinute,
      DEFAULT_CONFIG.requestsPerMinute,
      name('requestsPerMinute'),
      OCR_REQUEST_LIMITS.requestsPerMinute.min,
      OCR_REQUEST_LIMITS.requestsPerMinute.max,
    ),
    cwd,
  };
}

/**
 * Require the credentials a live run needs.
 *
 * Deliberately separate from {@link resolveCliOptions} so every front end can
 * finish local validation — flags, configuration, and input discovery — before
 * asking for a key. `capabilities` advertises `credential-free-dry-run`, so a
 * dry run must reach the same first error as a real run rather than stopping on
 * a missing credential the plan never uses.
 */
export function assertCredentialsAvailable(options: ResolvedCliOptions): void {
  if (options.dryRun) return;
  const permitsMissingKey = options.cloudflareByok
    || (options.provider === 'openai-compatible' && isLocalBaseUrl(options.baseUrl));
  if (!options.apiKey && !permitsMissingKey) {
    const providerLabel = options.provider === 'gemini'
      ? 'Gemini'
      : options.provider === 'kimi'
        ? 'Kimi'
        : options.provider === 'muse' ? 'Muse' : options.provider;
    throw credentialError(
      `${providerLabel} API key is missing.\n`
      + credentialSetupGuidance(options.apiKeyEnv, options.cwd, providerLabel),
    );
  }
  const gatewayTokenEnv = options.gatewayTokenEnv ?? 'CLOUDFLARE_AI_GATEWAY_TOKEN';
  if (options.gateway === 'cloudflare' && options.cloudflareByok && !options.gatewayToken) {
    throw credentialError(`Cloudflare BYOK requires ${gatewayTokenEnv} for gateway authentication`);
  }
}

/** An option whose resolved value only reaches the provider in some OCR modes. */
interface ModeScopedOption {
  /** Flag name on the `extract` command. */
  flag: string;
  /**
   * Field name in a machine-protocol request, when the option has one. Omitted
   * for a flag with no protocol counterpart, so a `run`/MCP warning can never
   * name a request key the caller had no way to send.
   */
  field?: string;
  /** Modes that actually consume the option. */
  modes: readonly CliMode[];
}

/**
 * Options the runner reads in only some modes. Kept beside the resolver so a
 * new mode-scoped option is warned about at the same time it is added, instead
 * of being silently discarded like `--max-iterations` was in simple mode.
 */
const MODE_SCOPED_OPTIONS = {
  detectImages: { flag: '--detect-images', field: 'extraction.detectImages', modes: ['simple'] },
  detectMath: { flag: '--detect-math', field: 'extraction.detectMath', modes: ['simple'] },
  instructions: { flag: '--instruction', field: 'extraction.instructions', modes: ['simple'] },
  maxTokens: { flag: '--max-tokens', field: 'extraction.maxTokens', modes: ['simple', 'agentic'] },
  maxIterations: { flag: '--max-iterations', field: 'extraction.maxIterations', modes: ['agentic'] },
  confidenceThreshold: {
    flag: '--confidence-threshold',
    field: 'extraction.confidenceThreshold',
    modes: ['agentic'],
  },
  progress: { flag: '--progress', field: 'extraction.progress', modes: ['agentic'] },
  // Honoured in every mode except agentic, where the agent loop owns its own
  // bounded provider retries and the outer wrapper is pinned to a single attempt
  // (see providerRetries.ts). Previously an agentic run accepted `--retries 5`
  // and silently performed one attempt.
  retries: { flag: '--retries', field: 'execution.retries', modes: ['simple', 'template'] },
  // Agent steps are the only thing --verbose prints, so outside agentic mode it
  // is a silent no-op rather than "more output".
  verbose: { flag: '--verbose', modes: ['agentic'] },
} as const satisfies Record<string, ModeScopedOption>;

export type ModeScopedOptionKey = keyof typeof MODE_SCOPED_OPTIONS;

/**
 * The same table widened to the declared interface.
 *
 * Indexing the `as const` literal yields a union in which only some members have
 * `field`, so reading a computed `'flag' | 'field'` key off it needs an
 * assertion. Assigning it once here makes the compiler check that widening —
 * which `satisfies` already proves — instead of taking an unchecked `as` at the
 * point of use.
 */
const MODE_SCOPED_OPTION_DETAILS: Record<ModeScopedOptionKey, ModeScopedOption> = MODE_SCOPED_OPTIONS;

/** Options the caller supplied that the resolved mode will not read. */
export function ignoredModeScopedOptions(
  supplied: readonly ModeScopedOptionKey[],
  mode: CliMode,
): ModeScopedOptionKey[] {
  return supplied.filter((key) => !MODE_SCOPED_OPTIONS[key].modes.some((allowed) => allowed === mode));
}

/**
 * Phrase ignored options the way file configuration already reports ignored
 * keys, so both surfaces read the same way in a terminal or an agent log.
 */
export function ignoredModeScopedOptionWarning(
  ignored: readonly ModeScopedOptionKey[],
  mode: CliMode,
  surface: 'flag' | 'field',
): string | undefined {
  // An option with no protocol counterpart is dropped from the `field` wording:
  // naming a request key the caller cannot send is worse than staying quiet.
  const names = ignored
    .map((key) => MODE_SCOPED_OPTION_DETAILS[key][surface])
    .filter((name): name is string => name !== undefined);
  if (names.length === 0) return undefined;
  return `ignoring option(s) that ${mode} mode does not use: ${names.join(', ')}`;
}

/**
 * Mode-scoped flags the user actually typed.
 *
 * `--instruction` carries a Commander `[]` default, so presence is length-based
 * rather than `undefined`-based; file configuration is excluded because it is
 * ambient and would warn on every unrelated run.
 */
export function suppliedModeScopedFlags(flags: ExtractCommandFlags): ModeScopedOptionKey[] {
  const supplied: ModeScopedOptionKey[] = [];
  if (flags.detectImages !== undefined) supplied.push('detectImages');
  if (flags.detectMath !== undefined) supplied.push('detectMath');
  if (flags.instruction !== undefined && flags.instruction.length > 0) supplied.push('instructions');
  if (flags.maxTokens !== undefined) supplied.push('maxTokens');
  if (flags.maxIterations !== undefined) supplied.push('maxIterations');
  if (flags.confidenceThreshold !== undefined) supplied.push('confidenceThreshold');
  if (flags.progress !== undefined) supplied.push('progress');
  if (flags.retries !== undefined) supplied.push('retries');
  // Commander stores `true` only when --verbose was typed, so this stays quiet
  // on the far more common run that never asked for it.
  if (flags.verbose === true) supplied.push('verbose');
  return supplied;
}
