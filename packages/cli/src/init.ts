import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { applyThinkingConfig, getGenAIClient } from '@open-ocr/engine/gemini/client';
import { waitForGeminiRequestSlot } from '@open-ocr/engine/gemini/requestPolicy';
import type { GeminiModel, ThinkingLevel } from '@open-ocr/engine/gemini/types';
import { recordGeminiUsage } from '@open-ocr/engine/gemini/usage';
import {
  GATEWAY_IDS,
  GEMINI_MODELS,
  PROVIDER_IDS,
  PROVIDER_PROFILES,
  createChatCompletion,
  createProviderExecutionContext,
  providerDefaultApiKeyEnv,
  providerDefaultBaseUrl,
  providerDefaultModel,
  providerRequestHeaders,
  providerTokenPrice,
  resolveProviderBaseUrl,
  type GatewayId,
  type ProviderId,
  type ProviderRuntimeConfig,
} from '@open-ocr/engine/providers';
import type { CliConfigFile } from './types';
import {
  cliThinkingLevels,
  credentialSetupGuidance,
  defaultCliThinkingLevel,
} from './config';
import { asCliExitError } from './errors';
import {
  isPromptAbort,
  promptSelect,
  terminalPrompter,
  type CliPrompter,
} from './prompter';

export interface InitFlags {
  global?: boolean;
  force?: boolean;
  yes?: boolean;
  skipValidation?: boolean;
  provider?: ProviderId;
  gateway?: GatewayId;
  model?: string;
}

export type InitPrompter = CliPrompter;

export interface InitResult {
  configPath: string;
  written: boolean;
  credentialStatus: 'valid' | 'missing' | 'skipped';
  apiKeyEnvironmentVariable: string;
  provider: ProviderId;
  gateway: GatewayId;
}

interface InitRuntime {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  prompter?: InitPrompter;
  validateCredentials?: (apiKey: string, model: string) => Promise<void>;
  writeOutput?: (text: string) => void;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function choice<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

async function promptChoice<T extends string>(
  prompter: InitPrompter,
  writeOutput: (text: string) => void,
  question: string,
  defaultValue: T,
  allowed: readonly T[],
  normalize: (value: string) => string = (value) => value,
  formatChoice: (value: T) => string = (value) => value,
): Promise<T> {
  return promptSelect(
    prompter,
    writeOutput,
    question,
    allowed.map((value) => ({ value, label: formatChoice(value) })),
    defaultValue,
    normalize,
  );
}

async function promptRequiredText(
  prompter: InitPrompter,
  writeOutput: (text: string) => void,
  question: string,
): Promise<string> {
  while (true) {
    const answer = (await prompter.ask(question, '')).trim();
    if (answer) return answer;
    writeOutput(`${question} is required.\n`);
  }
}

const CUSTOM_MODEL_CHOICE = '__custom_model__';

async function promptModel(
  prompter: InitPrompter,
  writeOutput: (text: string) => void,
  provider: ProviderId,
  defaultModel: string | undefined,
): Promise<string> {
  if (provider === 'gemini') {
    return promptChoice(
      prompter,
      writeOutput,
      'Default model',
      defaultModel ?? GEMINI_MODELS[0],
      GEMINI_MODELS,
    );
  }

  const recommendedModels = PROVIDER_PROFILES[provider].models;
  if (recommendedModels.length === 0) {
    return promptRequiredText(prompter, writeOutput, 'Default model ID');
  }

  const choices = [...recommendedModels, CUSTOM_MODEL_CHOICE];
  const recommendedDefault = defaultModel && recommendedModels.includes(defaultModel)
    ? defaultModel
    : recommendedModels[0];
  const selected = await promptChoice(
    prompter,
    writeOutput,
    'Default model',
    recommendedDefault,
    choices,
    (value) => value,
    (value) => value === CUSTOM_MODEL_CHOICE ? 'Enter a custom model ID' : value,
  );
  return selected === CUSTOM_MODEL_CHOICE
    ? promptRequiredText(prompter, writeOutput, 'Custom model ID')
    : selected;
}

function integer(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function optionalPositiveNumber(value: string, label: string, max: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${label} must be greater than zero and at most ${max}`);
  }
  return parsed;
}

async function writeConfig(configPath: string, config: CliConfigFile): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, configPath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function validateProviderCredentials(config: ProviderRuntimeConfig): Promise<void> {
  const runtime = config.runtime ?? createProviderExecutionContext();
  runtime.configureUsagePricing(config);
  // Credential validation proves endpoint access; it is not an extraction
  // quality evaluation. Use the lowest supported effort so modern reasoning
  // models cannot exhaust this small probe response before returning `OK`.
  const probeThinkingLevel = cliThinkingLevels(config.provider, config.model)[0]
    ?? defaultCliThinkingLevel(config.provider, config.model);
  if (config.provider === 'gemini') {
    const client = getGenAIClient(
      config.apiKey || (config.cloudflareByok ? 'cloudflare-byok' : ''),
      {
        baseUrl: config.gateway === 'cloudflare' ? config.baseUrl : undefined,
        headers: config.gateway === 'cloudflare' ? providerRequestHeaders(config) : undefined,
      },
    );
    await waitForGeminiRequestSlot(undefined, runtime);
    const response = await client.models.generateContent({
      model: config.model,
      contents: 'Reply with OK.',
      config: applyThinkingConfig(
        { maxOutputTokens: 1024 },
        config.model as GeminiModel,
        { level: probeThinkingLevel },
      ),
    });
    recordGeminiUsage(response, config.model as GeminiModel, runtime);
    return;
  }
  await createChatCompletion({
    ...config,
    runtime,
    thinkingConfig: { level: probeThinkingLevel },
  }, {
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    maxTokens: 1024,
  });
}

export async function runInit(flags: InitFlags, runtime: InitRuntime = {}): Promise<InitResult> {
  const cwd = runtime.cwd ?? process.cwd();
  const env = runtime.env ?? process.env;
  const writeOutput = runtime.writeOutput ?? ((text: string) => process.stdout.write(text));
  const ownsPrompter = runtime.prompter === undefined;
  if (
    ownsPrompter
    && !flags.yes
    && (!(runtime.stdinIsTTY ?? process.stdin.isTTY) || !(runtime.stderrIsTTY ?? process.stderr.isTTY))
  ) {
    throw asCliExitError(
      new Error('Interactive init requires a terminal (TTY); pass --yes for non-interactive setup'),
      2,
    );
  }
  const prompter = runtime.prompter ?? terminalPrompter();
  const configPath = flags.global
    ? path.join(homedir(), '.config', 'open-ocr-cli', 'config.json')
    : path.join(cwd, '.open-ocr-cli.json');

  try {
    if (await pathExists(configPath) && !flags.force) {
      if (flags.yes || !(await prompter.confirm(`Configuration exists at ${configPath}. Replace it?`, false))) {
        writeOutput(`Configuration already exists at ${configPath}; kept it unchanged. Use --force to replace it.\n`);
        return {
          configPath,
          written: false,
          credentialStatus: 'skipped',
          apiKeyEnvironmentVariable: 'GEMINI_API_KEY',
          provider: 'gemini',
          gateway: 'direct',
        };
      }
    }

    const ask = async (question: string, defaultValue: string): Promise<string> => (
      flags.yes ? defaultValue : prompter.ask(question, defaultValue)
    );
    const provider = flags.provider !== undefined
      ? choice<ProviderId>(flags.provider, PROVIDER_IDS, 'Provider')
      : flags.yes
        ? 'gemini'
        : await promptChoice(
            prompter,
            writeOutput,
            'Provider',
            'gemini',
            PROVIDER_IDS,
            (value) => value.toLowerCase(),
            (value) => `${PROVIDER_PROFILES[value].label} (${value})`,
          );
    const gateway = flags.gateway !== undefined
      ? choice<GatewayId>(flags.gateway, GATEWAY_IDS, 'Gateway')
      : flags.yes
        ? 'direct'
        : await promptChoice(
            prompter,
            writeOutput,
            'Gateway',
            'direct',
            GATEWAY_IDS,
            (value) => value.toLowerCase(),
            (value) => value === 'direct'
              ? 'Direct provider API (direct)'
              : 'Cloudflare AI Gateway (cloudflare)',
          );
    const defaultModel = providerDefaultModel(provider);
    if (!defaultModel && flags.yes && !flags.model) {
      throw new Error('--model is required with --yes for the openai-compatible provider');
    }
    const model = flags.model
      ?? (flags.yes
        ? await ask('Default model', defaultModel ?? 'your-model')
        : await promptModel(prompter, writeOutput, provider, defaultModel));
    if (!model.trim()) throw new Error('Default model cannot be empty');
    if (provider === 'gemini' && !GEMINI_MODELS.includes(model as GeminiModel)) {
      throw new Error(`Default model must be one of: ${GEMINI_MODELS.join(', ')}`);
    }
    const thinkingOptions = cliThinkingLevels(provider, model);
    const defaultThinking = defaultCliThinkingLevel(provider, model);
    const thinking = flags.yes
      ? defaultThinking
      : await promptChoice(
          prompter,
          writeOutput,
          'Thinking level',
          defaultThinking,
          thinkingOptions,
          (value) => value.toUpperCase(),
          (value) => {
            const descriptions: Record<ThinkingLevel, string> = {
              MINIMAL: 'MINIMAL — fastest, least reasoning',
              LOW: 'LOW — light reasoning',
              MEDIUM: 'MEDIUM — balanced (recommended)',
              HIGH: 'HIGH — strong reasoning',
              XHIGH: 'XHIGH — extra-high model-dependent reasoning',
              MAX: 'MAX — maximum reasoning effort',
            };
            return descriptions[value];
          },
        );
    const concurrency = integer(await ask('Concurrent documents', '2'), 'Concurrency', 1, 16);
    const requestsPerMinute = integer(
      await ask('Provider requests per minute (0 for unlimited)', '0'),
      'Requests per minute',
      0,
      60_000,
    );
    const maxCostUsd = optionalPositiveNumber(
      flags.yes ? '' : await prompter.ask('Maximum estimated batch cost in USD (blank for none)', ''),
      'Maximum cost',
      1_000_000,
    );
    const needsCustomPrice = maxCostUsd !== undefined
      && provider !== 'openrouter'
      && providerTokenPrice({ provider, model }, 0) === undefined;
    const inputPricePerMillionUsd = needsCustomPrice
      ? optionalPositiveNumber(
          await ask('Input price per million tokens in USD', ''),
          'Input price',
          1_000_000,
        )
      : undefined;
    const outputPricePerMillionUsd = needsCustomPrice
      ? optionalPositiveNumber(
          await ask('Output price per million tokens in USD', ''),
          'Output price',
          1_000_000,
        )
      : undefined;
    if (needsCustomPrice && (inputPricePerMillionUsd === undefined || outputPricePerMillionUsd === undefined)) {
      throw new Error('A maximum cost for this provider requires both input and output token prices');
    }
    const apiKeyEnv = await ask('API key environment variable', providerDefaultApiKeyEnv(provider));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new Error('API key environment variable must be a valid environment-variable name');
    }

    const baseUrl = gateway === 'direct'
      ? await ask('Provider API base URL', providerDefaultBaseUrl(provider))
      : undefined;
    const cloudflareAccountId = gateway === 'cloudflare'
      ? await ask('Cloudflare account ID', env.CLOUDFLARE_ACCOUNT_ID ?? '')
      : undefined;
    const cloudflareGatewayId = gateway === 'cloudflare'
      ? await ask('Cloudflare AI Gateway ID', env.CLOUDFLARE_AI_GATEWAY_ID ?? '')
      : undefined;
    const cloudflareTokenEnv = gateway === 'cloudflare'
      ? await ask('Cloudflare gateway token environment variable', 'CLOUDFLARE_AI_GATEWAY_TOKEN')
      : undefined;
    const cloudflareByok = gateway === 'cloudflare'
      ? (flags.yes ? false : await prompter.confirm('Use a provider key stored in Cloudflare?', false))
      : false;
    const cloudflareByokAlias = cloudflareByok
      ? await ask('Cloudflare stored-key alias (blank for default)', '')
      : undefined;
    const cloudflareProvider = gateway === 'cloudflare' && provider !== 'gemini' && provider !== 'openrouter'
      ? await ask('Cloudflare custom-provider slug', provider)
      : undefined;
    if (gateway === 'cloudflare' && (!cloudflareAccountId || !cloudflareGatewayId)) {
      throw new Error('Cloudflare account ID and AI Gateway ID are required');
    }

    const config: CliConfigFile = {
      provider,
      gateway,
      model,
      thinking,
      concurrency,
      requestsPerMinute,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      ...(inputPricePerMillionUsd !== undefined ? { inputPricePerMillionUsd } : {}),
      ...(outputPricePerMillionUsd !== undefined ? { outputPricePerMillionUsd } : {}),
      retries: 3,
      timeoutSeconds: 120,
      resume: true,
      format: 'markdown',
      apiKeyEnv,
      ...(baseUrl ? { baseUrl } : {}),
      ...(cloudflareAccountId ? { cloudflareAccountId } : {}),
      ...(cloudflareGatewayId ? { cloudflareGatewayId } : {}),
      ...(cloudflareTokenEnv ? { cloudflareTokenEnv } : {}),
      ...(cloudflareByok ? { cloudflareByok: true } : {}),
      ...(cloudflareByokAlias ? { cloudflareByokAlias } : {}),
      ...(cloudflareProvider ? { cloudflareProvider } : {}),
    };

    let credentialStatus: InitResult['credentialStatus'] = 'skipped';
    const apiKey = env[apiKeyEnv]?.trim() ?? '';
    const gatewayToken = cloudflareTokenEnv ? env[cloudflareTokenEnv]?.trim() : undefined;
    const credentialEnvironmentVariable = cloudflareByok && cloudflareTokenEnv
      ? cloudflareTokenEnv
      : apiKeyEnv;
    if (!flags.skipValidation) {
      if (cloudflareByok ? !gatewayToken : !apiKey) credentialStatus = 'missing';
      else {
        const resolvedBaseUrl = resolveProviderBaseUrl({
          provider,
          gateway,
          baseUrl,
          cloudflareAccountId,
          cloudflareGatewayId,
          cloudflareProvider,
        });
        if (runtime.validateCredentials) {
          await runtime.validateCredentials(apiKey, model);
        } else {
          await validateProviderCredentials({
            provider,
            gateway,
            apiKey,
            apiKeyEnv,
            model,
            baseUrl: resolvedBaseUrl,
            thinkingConfig: { level: thinking },
            gatewayToken,
            gatewayTokenEnv: cloudflareTokenEnv,
            cloudflareAccountId,
            cloudflareGatewayId,
            cloudflareByok,
            cloudflareByokAlias,
            cloudflareProvider,
          });
        }
        credentialStatus = 'valid';
      }
    }

    await writeConfig(configPath, config);
    writeOutput(`Created ${configPath}\n`);
    if (credentialStatus === 'valid') writeOutput(`${credentialEnvironmentVariable}: credential validated\n`);
    else if (credentialStatus === 'missing') {
      const credentialProvider = cloudflareByok ? 'Cloudflare AI Gateway' : provider;
      writeOutput(
        `${credentialEnvironmentVariable}: not set; credential validation skipped\n`
        + `${credentialSetupGuidance(credentialEnvironmentVariable, cwd, credentialProvider)}\n`,
      );
    }
    else writeOutput('Credential validation skipped\n');
    return {
      configPath,
      written: true,
      credentialStatus,
      apiKeyEnvironmentVariable: credentialEnvironmentVariable,
      provider,
      gateway,
    };
  } catch (error) {
    if (isPromptAbort(error)) throw asCliExitError(error, 130);
    throw error;
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
