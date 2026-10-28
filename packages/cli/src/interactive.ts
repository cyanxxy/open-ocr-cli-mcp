import process from 'node:process';

import { listExtractionPresets } from '@open-ocr/engine/templates';
import {
  PROVIDER_IDS,
  PROVIDER_PROFILES,
  type GatewayId,
  type ProviderId,
} from '@open-ocr/engine/providers';
import { asCliExitError } from './errors';
import {
  cliThinkingLevels,
  defaultCliThinkingLevel,
  loadCliConfig,
  localEnvironment,
} from './config';
import {
  isPromptAbort,
  promptSelect,
  terminalPrompter,
  type CliPrompter,
  type PromptChoice,
} from './prompter';
import type { CliConfigFile } from './types';

export type InteractivePrompter = CliPrompter;

interface InteractiveRuntime {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: CliConfigFile;
  prompter?: InteractivePrompter;
  writeOutput?: (text: string) => void;
}

type MenuChoice<T extends string> = PromptChoice<T>;
type InteractiveThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type InteractiveCommand =
  | 'extract'
  | 'web'
  | 'init'
  | 'providers'
  | 'models'
  | 'presets'
  | 'doctor'
  | 'status'
  | 'help'
  | 'exit';

const COMMAND_CHOICES: ReadonlyArray<MenuChoice<InteractiveCommand>> = [
  { value: 'extract', label: 'Extract files, images, or PDFs' },
  { value: 'web', label: 'Extract content from public URLs' },
  { value: 'init', label: 'Configure a provider and credentials' },
  { value: 'providers', label: 'List supported providers' },
  { value: 'models', label: 'List recommended models' },
  { value: 'presets', label: 'List structured extraction presets' },
  { value: 'doctor', label: 'Check local configuration' },
  { value: 'status', label: 'Inspect a previous batch' },
  { value: 'help', label: 'Show command help' },
  { value: 'exit', label: 'Exit' },
];

function configuredChoice<T extends string>(
  candidate: string | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  return candidate && choices.includes(candidate as T) ? candidate as T : fallback;
}

async function required(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  question: string,
  defaultValue = '',
): Promise<string> {
  while (true) {
    const answer = (await prompter.ask(question, defaultValue)).trim();
    if (answer) return answer;
    writeOutput(`${question} is required.\n`);
  }
}

function splitCommaSeparated(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

async function chooseProvider(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  defaultProvider: ProviderId,
): Promise<ProviderId> {
  return promptSelect(
    prompter,
    writeOutput,
    'Provider',
    PROVIDER_IDS.map((provider) => ({
      value: provider,
      label: `${PROVIDER_PROFILES[provider].label} (${provider})`,
    })),
    defaultProvider,
  );
}

async function chooseModel(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  provider: ProviderId,
  preferredModel: string | undefined,
): Promise<string> {
  const profile = PROVIDER_PROFILES[provider];
  if (profile.models.length === 0) {
    return required(prompter, writeOutput, 'Model ID', preferredModel ?? '');
  }
  const custom = '__custom_model__';
  const choices: Array<MenuChoice<string>> = profile.models.map((model) => ({ value: model, label: model }));
  if (
    preferredModel
    && preferredModel !== custom
    && !profile.models.includes(preferredModel)
    && provider !== 'gemini'
  ) {
    choices.unshift({ value: preferredModel, label: `${preferredModel} (configured)` });
  }
  if (provider !== 'gemini') choices.push({ value: custom, label: 'Enter a custom model ID' });
  const defaultModel = preferredModel && choices.some((choice) => choice.value === preferredModel)
    ? preferredModel
    : profile.defaultModel ?? profile.models[0];
  const selected = await promptSelect(
    prompter,
    writeOutput,
    'Model',
    choices,
    defaultModel,
  );
  return selected === custom ? required(prompter, writeOutput, 'Custom model ID') : selected;
}

async function providerArguments(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): Promise<string[]> {
  const configuredProvider = configuredChoice(config.provider, PROVIDER_IDS, 'gemini');
  const defaultProvider = configuredChoice(env.OPEN_OCR_PROVIDER, PROVIDER_IDS, configuredProvider);
  const provider = await chooseProvider(prompter, writeOutput, defaultProvider);
  const providerContextMatches = provider === configuredProvider;
  const configuredGateway = configuredChoice(config.gateway, ['direct', 'cloudflare'] as const, 'direct');
  const defaultGateway = configuredChoice(env.OPEN_OCR_GATEWAY, ['direct', 'cloudflare'] as const, configuredGateway);
  const gateway = await promptSelect<GatewayId>(
    prompter,
    writeOutput,
    'Gateway',
    [
      { value: 'direct', label: 'Direct provider API (direct)' },
      { value: 'cloudflare', label: 'Cloudflare AI Gateway (cloudflare)' },
    ],
    defaultGateway,
  );
  const preferredModel = env.OPEN_OCR_MODEL
    ?? (providerContextMatches ? config.model : undefined)
    ?? PROVIDER_PROFILES[provider].defaultModel;
  const model = await chooseModel(prompter, writeOutput, provider, preferredModel);
  const modelContextMatches = providerContextMatches && (!config.model || config.model === model);
  const configuredThinking = (
    env.OPEN_OCR_THINKING
    ?? (modelContextMatches ? config.thinking : undefined)
  )?.toLowerCase();
  const thinkingValues: readonly InteractiveThinkingLevel[] = cliThinkingLevels(provider, model)
    .map((value) => value.toLowerCase() as InteractiveThinkingLevel);
  const thinkingLabels: Record<InteractiveThinkingLevel, string> = {
    minimal: 'MINIMAL — fastest, least reasoning',
    low: 'LOW — light reasoning',
    medium: 'MEDIUM — balanced',
    high: 'HIGH — strong reasoning',
    xhigh: 'XHIGH — extra-high model-dependent reasoning',
    max: 'MAX — maximum reasoning effort',
  };
  const defaultThinking = defaultCliThinkingLevel(provider, model).toLowerCase() as InteractiveThinkingLevel;
  const thinking = await promptSelect<InteractiveThinkingLevel>(
    prompter,
    writeOutput,
    'Thinking level',
    thinkingValues.map((value) => ({ value, label: thinkingLabels[value] })),
    configuredChoice(configuredThinking, thinkingValues, defaultThinking),
  );
  const apiKeyEnv = await required(
    prompter,
    writeOutput,
    'API key environment variable',
    providerContextMatches ? config.apiKeyEnv ?? profileApiKeyEnvironment(provider) : profileApiKeyEnvironment(provider),
  );
  const args = [
    '--provider', provider,
    '--gateway', gateway,
    '--model', model,
    '--thinking', thinking,
    '--api-key-env', apiKeyEnv,
  ];
  if (provider === 'openai-compatible') {
    const baseUrl = await required(
      prompter,
      writeOutput,
      'Provider API base URL',
      providerContextMatches ? config.baseUrl ?? PROVIDER_PROFILES[provider].defaultBaseUrl : PROVIDER_PROFILES[provider].defaultBaseUrl,
    );
    args.push('--base-url', baseUrl);
  }
  if (gateway === 'cloudflare') {
    const accountId = await required(
      prompter,
      writeOutput,
      'Cloudflare account ID',
      env.CLOUDFLARE_ACCOUNT_ID ?? config.cloudflareAccountId ?? '',
    );
    const gatewayId = await required(
      prompter,
      writeOutput,
      'Cloudflare AI Gateway ID',
      env.CLOUDFLARE_AI_GATEWAY_ID ?? config.cloudflareGatewayId ?? '',
    );
    const gatewayTokenEnv = await required(
      prompter,
      writeOutput,
      'Cloudflare token environment variable',
      config.cloudflareTokenEnv ?? 'CLOUDFLARE_AI_GATEWAY_TOKEN',
    );
    args.push(
      '--cloudflare-account-id', accountId,
      '--cloudflare-gateway-id', gatewayId,
      '--cloudflare-token-env', gatewayTokenEnv,
    );
    if (provider !== 'gemini' && provider !== 'openrouter') {
      const cloudflareProvider = await required(
        prompter,
        writeOutput,
        'Cloudflare custom-provider slug',
        providerContextMatches ? config.cloudflareProvider ?? provider : provider,
      );
      args.push('--cloudflare-provider', cloudflareProvider);
    }
    const defaultByok = providerContextMatches
      && gateway === 'cloudflare'
      && configuredGateway === 'cloudflare'
      && config.cloudflareByok === true;
    if (await prompter.confirm('Use a provider key stored in Cloudflare?', defaultByok)) {
      args.push('--cloudflare-byok');
      const alias = await prompter.ask(
        'Cloudflare stored-key alias (blank for default)',
        defaultByok ? config.cloudflareByokAlias ?? '' : '',
      );
      if (alias.trim()) args.push('--cloudflare-byok-alias', alias.trim());
    }
  }
  return args;
}

function profileApiKeyEnvironment(provider: ProviderId): string {
  return PROVIDER_PROFILES[provider].defaultApiKeyEnv;
}

async function outputFormatArguments(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
): Promise<string[]> {
  const format = await promptSelect(
    prompter,
    writeOutput,
    'Output style',
    [
      { value: 'text', label: 'Human-readable text' },
      { value: 'json', label: 'Machine-readable JSON' },
    ],
    'text',
  );
  return format === 'json' ? ['--json'] : [];
}

async function optionalMaxCost(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  defaultValue: number | undefined,
): Promise<string> {
  while (true) {
    const value = (await prompter.ask(
      'Maximum estimated cost in USD (blank for none)',
      defaultValue === undefined ? '' : String(defaultValue),
    )).trim();
    if (!value) return '';
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0.000001 && parsed <= 1_000_000) return value;
    writeOutput('Maximum cost must be between 0.000001 and 1000000 USD, or blank.\n');
  }
}

async function extractArguments(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): Promise<string[]> {
  const inputText = await required(
    prompter,
    writeOutput,
    'Input files, directories, or globs (comma-separated)',
  );
  const inputs = splitCommaSeparated(inputText);
  const providerArgs = await providerArguments(prompter, writeOutput, env, config);
  const mode = await promptSelect(
    prompter,
    writeOutput,
    'OCR mode',
    [
      { value: 'simple', label: 'Simple OCR' },
      { value: 'template', label: 'Structured preset extraction' },
      { value: 'agentic', label: 'Agentic iterative extraction' },
    ],
    configuredChoice(config.mode ?? (config.preset ? 'template' : undefined), ['simple', 'template', 'agentic'] as const, 'simple'),
  );
  const args = ['extract', ...inputs, ...providerArgs, '--mode', mode];
  if (mode === 'template') {
    const presets = listExtractionPresets();
    const configuredPreset = presets.find((entry) => entry.id === config.preset)?.id ?? presets[0].id;
    const preset = await promptSelect(
      prompter,
      writeOutput,
      'Preset',
      presets.map((entry) => ({ value: entry.id, label: `${entry.label} — ${entry.description}` })),
      configuredPreset,
    );
    args.push('--preset', preset);
  }
  const configuredFormat = mode !== 'template' && config.format === 'csv'
    ? undefined
    : config.format;
  const format = await promptSelect(
    prompter,
    writeOutput,
    'Artifact format',
    [
      { value: 'markdown', label: 'Markdown' },
      { value: 'json', label: 'JSON' },
      ...(mode === 'template' ? [{ value: 'csv' as const, label: 'CSV' }] : []),
      { value: 'all', label: 'All formats' },
    ],
    configuredChoice(
      configuredFormat,
      ['markdown', 'json', 'csv', 'all'] as const,
      mode === 'template' ? 'json' : 'markdown',
    ),
  );
  args.push('--format', format);
  const output = (await prompter.ask('Output path (blank for default)', config.output ?? '')).trim();
  if (output) args.push('--output', output);
  const maxCost = await optionalMaxCost(prompter, writeOutput, config.maxCostUsd);
  if (maxCost) args.push('--max-cost', maxCost);
  if (await prompter.confirm('Validate only without calling the provider?', false)) args.push('--dry-run');
  return args;
}

async function webArguments(
  prompter: InteractivePrompter,
  writeOutput: (text: string) => void,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): Promise<string[]> {
  const urlText = await required(prompter, writeOutput, 'Public URLs (comma-separated)');
  const urls = splitCommaSeparated(urlText);
  const providerArgs = await providerArguments(prompter, writeOutput, env, config);
  const analysis = await promptSelect(
    prompter,
    writeOutput,
    'URL analysis mode',
    [
      { value: 'individual', label: 'Analyze each URL individually' },
      { value: 'combined', label: 'Combine all URLs into one result' },
      { value: 'comparison', label: 'Compare the URLs' },
    ],
    'individual',
  );
  const format = await promptSelect(
    prompter,
    writeOutput,
    'Output format',
    [
      { value: 'markdown', label: 'Markdown' },
      { value: 'json', label: 'JSON' },
    ],
    configuredChoice(config.format, ['markdown', 'json'] as const, 'markdown'),
  );
  const args = ['web', ...urls, ...providerArgs, '--analysis', analysis, '--format', format];
  const output = (await prompter.ask('Output file (blank for stdout)', config.output ?? '')).trim();
  if (output) args.push('--output', output);
  const maxCost = await optionalMaxCost(prompter, writeOutput, config.maxCostUsd);
  if (maxCost) args.push('--max-cost', maxCost);
  if (await prompter.confirm('Validate only without calling the provider?', false)) args.push('--dry-run');
  return args;
}

export async function promptInteractiveArguments(runtime: InteractiveRuntime = {}): Promise<string[] | undefined> {
  const cwd = runtime.cwd ?? process.cwd();
  const env = runtime.env ?? localEnvironment(cwd);
  const config = runtime.config ?? await loadCliConfig(cwd);
  const writeOutput = runtime.writeOutput ?? ((text: string) => process.stderr.write(text));
  const ownsPrompter = runtime.prompter === undefined;
  const prompter = runtime.prompter ?? terminalPrompter();
  try {
    writeOutput('\nOpen OCR CLI interactive mode\n\n');
    const command = await promptSelect(prompter, writeOutput, 'Command', COMMAND_CHOICES, 'extract');
    switch (command) {
      case 'extract':
        return extractArguments(prompter, writeOutput, env, config);
      case 'web':
        return webArguments(prompter, writeOutput, env, config);
      case 'init':
        return ['init'];
      case 'providers':
        return ['providers', ...await outputFormatArguments(prompter, writeOutput)];
      case 'models': {
        const configuredProvider = configuredChoice(config.provider, PROVIDER_IDS, 'gemini');
        const defaultProvider = configuredChoice(env.OPEN_OCR_PROVIDER, PROVIDER_IDS, configuredProvider);
        const provider = await chooseProvider(prompter, writeOutput, defaultProvider);
        return ['models', '--provider', provider, ...await outputFormatArguments(prompter, writeOutput)];
      }
      case 'presets':
        return ['presets', ...await outputFormatArguments(prompter, writeOutput)];
      case 'doctor': {
        const config = (await prompter.ask('Config path (blank for automatic discovery)', '')).trim();
        return ['doctor', ...(config ? ['--config', config] : []), ...await outputFormatArguments(prompter, writeOutput)];
      }
      case 'status': {
        const output = (await prompter.ask('Batch output directory', 'open-ocr-output')).trim();
        return ['status', output, ...await outputFormatArguments(prompter, writeOutput)];
      }
      case 'help': {
        const target = await promptSelect(
          prompter,
          writeOutput,
          'Help topic',
          [
            { value: 'root', label: 'Main command overview' },
            ...COMMAND_CHOICES
              .filter((entry) => entry.value !== 'help' && entry.value !== 'exit')
              .map((entry) => ({ value: entry.value, label: entry.label })),
          ],
          'root',
        );
        return target === 'root' ? ['--help'] : ['help', target];
      }
      case 'exit':
        return undefined;
    }
  } catch (error) {
    if (isPromptAbort(error)) throw asCliExitError(error, 130);
    throw error;
  } finally {
    if (ownsPrompter) prompter.close();
  }
}
