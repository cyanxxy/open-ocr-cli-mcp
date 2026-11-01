import { existsSync, readFileSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';

import type { ThinkingLevel } from '@open-ocr/engine/gemini';
import { registerSecretForRedaction } from '@open-ocr/engine/gemini/errorPayload';
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
import { DEFAULT_TEMPLATE_MAX_TOKENS, getExtractionPreset, listExtractionPresets } from '@open-ocr/engine/templates';
import { CliExitError } from './errors';
import {
  confineCallerPath,
  jsonSyntaxLocation,
  openRegularFile,
  realpathOfNearestAncestor,
} from './fileBoundary';
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
  if (code === 'ENOTREG') return configurationError(`Configuration path is not a regular file: ${displayPath}`);
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

/** Far above any real configuration file; bounds what a misdirected path can make the process read. */
const MAX_CONFIG_BYTES = 1024 * 1024;

async function readConfigFile(
  filePath: string,
  required: boolean,
  displayPath = filePath,
  regularFileOnly = false,
): Promise<CliConfigFile> {
  try {
    // The MCP server reads regular files only, non-blocking: a FIFO or device
    // named as the configuration would otherwise hang the long-lived server or
    // never reach EOF. The CLI keeps accepting a pipe (`--config <(...)`).
    const handle = regularFileOnly
      ? await openRegularFile(filePath, displayPath)
      : await open(filePath, 'r');
    let raw: string;
    try {
      if ((await handle.stat()).size > MAX_CONFIG_BYTES) {
        throw configurationError(`Configuration file exceeds the 1 MB limit: ${displayPath}`);
      }
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    return pickConfig(asRecord(JSON.parse(raw) as unknown, displayPath), displayPath);
  } catch (error) {
    if (error instanceof CliExitError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (!required && code === 'ENOENT') return {};
    // The parser's own message quotes the start of the file; a misdirected
    // path (`/etc/passwd`, a key file) must not be echoed back that way.
    if (error instanceof SyntaxError) {
      throw configurationError(`Invalid JSON in ${displayPath}${jsonSyntaxLocation(error)}`);
    }
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
  assertProjectConfigDoesNotRoute(project);
  await assertProjectOutputStaysInProject(project, cwd);
  return { ...user, ...project, ...explicit };
}

/**
 * Execution limits an operator can set in the user configuration that an MCP
 * caller may lower but never raise. `requestsPerMinute` 0 and an absent
 * `maxCostUsd` both mean "unlimited", so either from the caller is a raise.
 */
export const OPERATOR_CEILING_KEYS = [
  'maxFiles', 'maxTotalMb', 'maxCostUsd', 'requestsPerMinute', 'concurrency',
] as const;

export type OperatorCeilingKey = (typeof OPERATOR_CEILING_KEYS)[number];
export type OperatorCeilings = Partial<Record<OperatorCeilingKey, number>>;

/** The request flag each ceiling clamps, and the request field it is reported as. */
const CEILING_FLAGS: Record<OperatorCeilingKey, { flag: keyof ExtractCommandFlags; field: string }> = {
  maxFiles: { flag: 'maxFiles', field: 'execution.maxFiles' },
  maxTotalMb: { flag: 'maxTotalMb', field: 'execution.maxTotalMb' },
  maxCostUsd: { flag: 'maxCost', field: 'execution.maxCostUsd' },
  requestsPerMinute: { flag: 'requestsPerMinute', field: 'execution.requestsPerMinute' },
  concurrency: { flag: 'concurrency', field: 'execution.concurrency' },
};

function pickCeilings(config: CliConfigFile): OperatorCeilings {
  const ceilings: OperatorCeilings = {};
  for (const key of OPERATOR_CEILING_KEYS) {
    const value = config[key];
    // A requests-per-minute of 0 disables the limit; it caps nothing.
    if (typeof value === 'number' && !(key === 'requestsPerMinute' && value === 0)) ceilings[key] = value;
  }
  return ceilings;
}

/**
 * Apply operator ceilings to an MCP request's flags before option resolution.
 *
 * The caller's effective value is whatever would otherwise win (its argument,
 * else its `configPath` or the project file); a missing or unlimited value
 * becomes the ceiling and a larger one is lowered to it. Returns the clamped
 * flags and a warning per lowered field, so the caller learns why its number
 * was not used.
 */
export function applyOperatorCeilings(
  flags: ExtractCommandFlags,
  fileConfig: CliConfigFile,
  ceilings: OperatorCeilings,
): { flags: ExtractCommandFlags; warnings: string[] } {
  const clamped: ExtractCommandFlags = { ...flags };
  const warnings: string[] = [];
  for (const key of OPERATOR_CEILING_KEYS) {
    const ceiling = ceilings[key];
    if (ceiling === undefined) continue;
    const { flag, field } = CEILING_FLAGS[key];
    const raw = (flags[flag] as string | number | undefined) ?? fileConfig[key];
    const requested = raw === undefined ? undefined : Number(raw);
    const unlimited = requested === undefined || (key === 'requestsPerMinute' && requested === 0);
    if (!unlimited && Number.isFinite(requested) && requested <= ceiling) {
      (clamped as Record<string, unknown>)[flag] = requested;
      continue;
    }
    (clamped as Record<string, unknown>)[flag] = ceiling;
    if (raw !== undefined) {
      warnings.push(
        `${field} ${String(raw)} exceeds the operator's limit of ${ceiling} (~/.config/open-ocr-cli/config.json); using ${ceiling}`,
      );
    }
  }
  return { flags: clamped, warnings };
}

export interface McpCallerConfig {
  /** Merged configuration for option resolution. */
  fileConfig: CliConfigFile;
  /** Limits from the operator's user configuration; see {@link applyOperatorCeilings}. */
  ceilings: OperatorCeilings;
  /**
   * True when `fileConfig.schema` came from the operator's user configuration,
   * whose paths are the operator's own and are not confined to the working
   * directory.
   */
  operatorSchema: boolean;
}

/**
 * Configuration for one MCP tool call.
 *
 * The caller (an agent, possibly steered by document content) is untrusted
 * relative to the operator who started the server, so the layers are kept
 * apart rather than merged blindly:
 *
 * - The operator's user configuration and the server environment may route
 *   requests (provider, baseUrl, apiKeyEnv, gateway) and set limits.
 * - The caller's `configPath` must be a regular file inside the working
 *   directory and, like `.open-ocr-cli.json`, may not route; its `output` must
 *   stay inside the working directory and out of hidden directories.
 * - Neither the caller's `configPath` nor `.open-ocr-cli.json` may set token
 *   prices, which decide whether the cost ceiling can trip; the operator's
 *   prices apply only while the caller keeps the operator's provider and model.
 * - The operator's `maxFiles`, `maxTotalMb`, `maxCostUsd`, `requestsPerMinute`
 *   and `concurrency` are ceilings, and `noConfig` does not remove them: it
 *   drops the configuration's settings, never the operator's limits.
 *
 * Ambient `OPEN_OCR_NO_CONFIG` is the operator's own choice and still disables
 * the user configuration, exactly as for the CLI.
 */
export async function loadMcpCallerConfig(
  cwd: string,
  configPath?: string,
  callerNoConfig = false,
): Promise<McpCallerConfig> {
  const operatorDisabled = environmentDisablesConfig();
  const userPath = path.join(homedir(), '.config', 'open-ocr-cli', 'config.json');
  const user = operatorDisabled ? {} : await readConfigFile(userPath, false, userPath, true);
  const ceilings = pickCeilings(user);
  if (callerNoConfig) return { fileConfig: {}, ceilings, operatorSchema: false };

  let explicit: CliConfigFile = {};
  if (configPath) {
    const absolute = await confineCallerPath(cwd, configPath, 'configPath');
    explicit = await readConfigFile(absolute, true, configPath, true);
    assertConfigDoesNotRoute(explicit, 'mcp');
    assertMcpConfigDoesNotPrice(explicit, 'configPath');
    if (explicit.output !== undefined) await confineCallerPath(cwd, explicit.output, 'output', 'write');
  }
  if (operatorDisabled) return { fileConfig: explicit, ceilings, operatorSchema: false };

  const projectPath = path.join(cwd, '.open-ocr-cli.json');
  const project = await readConfigFile(projectPath, false, projectPath, true);
  assertProjectConfigDoesNotRoute(project);
  // The caller's agent can usually edit the project file as easily as its own
  // configPath, so over MCP the same price rule applies to it.
  assertMcpConfigDoesNotPrice(project, '.open-ocr-cli.json');
  await assertProjectOutputStaysInProject(project, cwd);
  const fileConfig = withOperatorPricesOnlyForOperatorModel({ ...user, ...project, ...explicit }, user);
  return {
    fileConfig,
    ceilings,
    operatorSchema: user.schema !== undefined && project.schema === undefined && explicit.schema === undefined,
  };
}

/**
 * Keys that feed the cost estimate behind `maxCostUsd` and the fail-closed
 * "paid response without usage" gate. A per-million price of 0 makes every
 * request free on paper, so the operator's cost ceiling never trips and a
 * response without usage is no longer treated as paid.
 */
const PRICE_CONFIG_KEYS = [
  'inputPricePerMillionUsd', 'outputPricePerMillionUsd',
] as const satisfies readonly (keyof CliConfigFile)[];

/**
 * Over MCP, prices come only from the operator's user configuration (or the
 * verified price table). A caller-chosen `configPath` or the project file that
 * could set them would turn the operator's `maxCostUsd` ceiling into a number
 * the caller controls. Refused rather than ignored, like routing keys, so a
 * setup that relied on them fails visibly instead of being billed differently.
 */
function assertMcpConfigDoesNotPrice(config: CliConfigFile, source: 'configPath' | '.open-ocr-cli.json'): void {
  const pricing = PRICE_CONFIG_KEYS.filter((key) => config[key] !== undefined);
  if (pricing.length === 0) return;
  throw new CliExitError(
    `${source} cannot set ${pricing.join(', ')} over MCP: prices decide whether the operator's maxCostUsd ceiling and the usage-unknown cost gate can trip`,
    2,
    {
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
      hint: 'Prices belong to the operator who starts the MCP server: set inputPricePerMillionUsd and '
        + 'outputPricePerMillionUsd in ~/.config/open-ocr-cli/config.json, or rely on the verified price table.',
    },
  );
}

/**
 * The operator's prices describe the operator's provider and model. If the
 * caller's configuration switches either, those prices would be applied to a
 * model they were never meant for (a cheap model's prices on an expensive one
 * under-counts spend), so they are dropped and resolution falls back to the
 * verified price table, or refuses a cost ceiling it cannot account for.
 * (A provider or model switched through tool arguments is already handled by
 * `resolveCliOptions`, which keeps file prices only for the file's model.)
 */
function withOperatorPricesOnlyForOperatorModel(merged: CliConfigFile, user: CliConfigFile): CliConfigFile {
  if (PRICE_CONFIG_KEYS.every((key) => merged[key] === undefined)) return merged;
  const provider = (config: CliConfigFile): string => config.provider ?? DEFAULT_CONFIG.provider;
  const model = (config: CliConfigFile): string | undefined => {
    const id = provider(config);
    // An unknown provider is reported by option resolution; it has no default here.
    return config.model ?? (PROVIDER_IDS.includes(id as ProviderId) ? providerDefaultModel(id as ProviderId) : undefined);
  };
  if (provider(merged) === provider(user) && model(merged) === model(user)) return merged;
  const { inputPricePerMillionUsd: _input, outputPricePerMillionUsd: _output, ...rest } = merged;
  return rest;
}

/**
 * The write-side twin of {@link assertProjectConfigDoesNotRoute}. A cloned
 * repository that could set `output` and `overwrite` could aim OCR text at
 * `~/.bashrc` or its own `.git/hooks`. So a project file may only send output
 * somewhere inside the project, outside `.git`, with symbolic links resolved,
 * and replacing existing files stays a decision the user makes themselves.
 */
async function assertProjectOutputStaysInProject(project: CliConfigFile, cwd: string): Promise<void> {
  const refuse = (message: string): CliExitError => new CliExitError(message, 2, {
    code: 'CONFIG_INVALID',
    category: 'configuration',
    retryable: false,
    hint: 'Pass --output/--overwrite explicitly, set them in ~/.config/open-ocr-cli/config.json or a file passed with --config, or run with --no-config.',
  });
  if (project.overwrite !== undefined) {
    throw refuse('.open-ocr-cli.json cannot set overwrite: replacing existing files must be the caller\'s own choice');
  }
  if (project.output === undefined) return;
  const root = await realpath(cwd);
  const target = await realpathOfNearestAncestor(path.resolve(cwd, project.output));
  const relative = path.relative(root, target);
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (outside || relative.split(path.sep).includes('.git')) {
    throw refuse(
      `.open-ocr-cli.json output must stay inside the project and outside .git: ${project.output} resolves to ${target}`,
    );
  }
}

/**
 * Keys that decide which host receives a request and which environment
 * variable's value travels with it as the credential.
 */
const ROUTING_CONFIG_KEYS = [
  'baseUrl', 'apiKeyEnv', 'cloudflareAccountId', 'cloudflareGatewayId', 'cloudflareTokenEnv',
  'cloudflareProvider', 'cloudflareByok', 'cloudflareByokAlias',
] as const satisfies readonly (keyof CliConfigFile)[];

/**
 * `.open-ocr-cli.json` arrives with whatever repository the caller (often a
 * coding agent) is standing in. If it could set routing, a cloned repository
 * could pair its own `baseUrl` with `apiKeyEnv: "ANY_SECRET"` and receive that
 * secret plus every document. Routing therefore comes only from sources the
 * user chose: the user config, an explicit --config file, flags, or the
 * environment. Refusing (rather than ignoring) keeps a repository that relied
 * on it from silently sending documents somewhere else.
 */
function assertProjectConfigDoesNotRoute(project: CliConfigFile): void {
  assertConfigDoesNotRoute(project, 'project');
}

function routingKeysIn(config: CliConfigFile): string[] {
  const routing: string[] = ROUTING_CONFIG_KEYS.filter((key) => config[key] !== undefined);
  if (config.gateway !== undefined && config.gateway !== 'direct') routing.unshift('gateway');
  return routing;
}

/**
 * The same rule for a configuration the MCP caller chose (`configPath`). The
 * caller is an agent that may be acting on instructions planted in a document;
 * if its file could set `baseUrl` and `apiKeyEnv`, one tool call would send any
 * environment variable of the server, as a bearer token, to any host.
 */
function assertConfigDoesNotRoute(config: CliConfigFile, source: 'project' | 'mcp'): void {
  const routing = routingKeysIn(config);
  if (routing.length === 0) return;
  if (source === 'project') {
    throw new CliExitError(
      `.open-ocr-cli.json cannot set ${routing.join(', ')}: a project configuration may not choose where requests or credentials are sent`,
      2,
      {
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
        hint: 'Move these keys to ~/.config/open-ocr-cli/config.json or a file passed with --config, pass them as flags, or run with --no-config.',
      },
    );
  }
  throw new CliExitError(
    `configPath cannot set ${routing.join(', ')}: a configuration supplied by the MCP caller may not choose where requests or credentials are sent`,
    2,
    {
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
      hint: 'Routing belongs to the operator who starts the MCP server: set it in ~/.config/open-ocr-cli/config.json '
        + 'or the server environment (OPEN_OCR_PROVIDER, OPEN_OCR_GATEWAY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY_ID).',
    },
  );
}

/**
 * The only variables a project `.env` may supply: each provider's default
 * credential and the default gateway token. Anything else in that file
 * (`OPEN_OCR_GATEWAY`, `CLOUDFLARE_ACCOUNT_ID`, `OPEN_OCR_MCP_CONFIRM`...) would
 * let a repository redirect the user's credential or change server policy.
 */
export const PROJECT_ENV_CREDENTIALS: readonly string[] = [
  ...new Set([...PROVIDER_IDS.map(providerDefaultApiKeyEnv), 'CLOUDFLARE_AI_GATEWAY_TOKEN']),
];

/**
 * The environment one request resolves its options against: the process
 * environment plus the project `.env` credentials, without writing either into
 * `process.env`. A long-lived MCP server serves many requests from one process;
 * once a `.env` value lands in `process.env`, every later `noConfig` request
 * inherits it, so the project file is read per request and never installed.
 */
export function localEnvironment(cwd: string, disabled = false): NodeJS.ProcessEnv {
  // Ambient OPEN_OCR_NO_CONFIG always blocks project .env, even when a caller
  // passes an explicit config path for option resolution.
  if (disabled || environmentDisablesConfig()) return { ...process.env };
  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) return { ...process.env };
  const parsed = parseEnv(readFileSync(envPath, 'utf8'));
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // Values already in the environment win, matching `process.loadEnvFile`.
  for (const name of PROJECT_ENV_CREDENTIALS) {
    const value = parsed[name];
    if (value !== undefined && environment[name] === undefined) environment[name] = value;
  }
  const ignored = Object.keys(parsed).filter((name) => (
    !PROJECT_ENV_CREDENTIALS.includes(name) && /^(?:OPEN_OCR_|CLOUDFLARE_)/.test(name)
  )).sort();
  if (ignored.length > 0) {
    process.stderr.write(
      `${envPath}: ignoring ${ignored.join(', ')}; a project .env may only supply ${PROJECT_ENV_CREDENTIALS.join(', ')}\n`,
    );
  }
  return environment;
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
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCliOptions {
  const name = (key: keyof typeof OPTION_NAMES): string => OPTION_NAMES[key][vocabulary === 'flag' ? 0 : 1];
  // OPEN_OCR_* variables are a layer of their own between flags and files. An
  // error about one names the variable: the caller never typed the flag, and
  // "fix --model" sends them looking in the wrong place.
  const envProvider = env.OPEN_OCR_PROVIDER;
  const envGateway = env.OPEN_OCR_GATEWAY;
  const configuredProvider = fileConfig.provider ?? DEFAULT_CONFIG.provider;
  const selectedProvider = flags.provider ?? envProvider;
  const provider = oneOf<ProviderId>(
    selectedProvider ?? configuredProvider,
    PROVIDER_IDS,
    flags.provider === undefined && envProvider !== undefined ? 'OPEN_OCR_PROVIDER' : name('provider'),
    DEFAULT_CONFIG.provider,
  );
  const providerContextMatches = selectedProvider === undefined || selectedProvider === configuredProvider;
  const configuredGateway = fileConfig.gateway ?? DEFAULT_CONFIG.gateway;
  const selectedGateway = flags.gateway ?? envGateway;
  const gateway = oneOf<GatewayId>(
    selectedGateway ?? configuredGateway,
    GATEWAY_IDS,
    flags.gateway === undefined && envGateway !== undefined ? 'OPEN_OCR_GATEWAY' : name('gateway'),
    DEFAULT_CONFIG.gateway,
  );
  const gatewayContextMatches = selectedGateway === undefined || selectedGateway === configuredGateway;
  // OPEN_OCR_MODEL and OPEN_OCR_THINKING were chosen for the ambient provider
  // (OPEN_OCR_PROVIDER, else the configured one). A --provider flag that
  // switches away from it drops them, exactly as it drops the file's model:
  // `kimi/gemini-3.8-flash` validates locally and fails upstream.
  const envContextMatches = flags.provider === undefined
    || flags.provider === (envProvider ?? configuredProvider);
  const envModel = envContextMatches ? env.OPEN_OCR_MODEL : undefined;
  const selectedModel = flags.model ?? envModel;
  const configuredModel = providerContextMatches
    ? fileConfig.model ?? providerDefaultModel(provider)
    : providerDefaultModel(provider);
  const model = selectedModel
    ?? configuredModel
    ?? providerDefaultModel(provider);
  const modelLabel = flags.model === undefined && envModel !== undefined ? 'OPEN_OCR_MODEL' : name('model');
  if (!model) throw configurationError(`${modelLabel} is required for the openai-compatible provider`);
  if (provider === 'gemini' && !GEMINI_MODELS.includes(model as (typeof GEMINI_MODELS)[number])) {
    throw configurationError(`${modelLabel} must be one of: ${SUPPORTED_MODELS.join(', ')}`);
  }
  const modelContextMatches = providerContextMatches
    && (selectedModel === undefined || selectedModel === configuredModel);
  const envThinking = envContextMatches && (flags.model === undefined || flags.model === (envModel ?? configuredModel))
    ? env.OPEN_OCR_THINKING
    : undefined;
  const configuredThinking = flags.thinking
    ?? envThinking
    ?? (modelContextMatches ? fileConfig.thinking : undefined);
  const thinkingLabel = flags.thinking === undefined && envThinking !== undefined
    ? 'OPEN_OCR_THINKING'
    : name('thinking');
  const isKimiK3 = isKimiK3Route(provider, model);
  let thinking = oneOf<ThinkingLevel>(
    configuredThinking?.toUpperCase(),
    ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'],
    thinkingLabel,
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

  if (!isKimiK3 && provider !== 'openrouter' && !(provider === 'muse' && ['muse-spark-1.3', 'muse-wonder-1.0'].includes(model)) && thinking === 'MAX') {
    throw configurationError(`${thinkingLabel} max is supported by Kimi K3/K3.1, Muse Spark 1.3 Standard, Muse Wonder, and model-dependent OpenRouter routes`);
  }
  if (provider !== 'openrouter' && provider !== 'muse' && thinking === 'XHIGH') {
    throw configurationError(`${thinkingLabel} xhigh is supported by Muse and model-dependent OpenRouter routes`);
  }
  if (isKimiK3 && thinking === 'MEDIUM') {
    throw configurationError(`Kimi K3 supports ${thinkingLabel} low, high, or max; medium would be an ambiguous silent upgrade`);
  }
  if (isKimiK3 && thinking === 'XHIGH') {
    throw configurationError(`Kimi K3 supports ${thinkingLabel} low, high, or max; xhigh is not a Kimi K3 effort`);
  }
  if (isKimiK3 && thinking === 'MINIMAL') {
    thinking = 'LOW';
  }
  const knownThinking = knownModelThinkingLevels(provider, model);
  if (knownThinking && !knownThinking.includes(thinking)) {
    throw configurationError(`${model} supports ${thinkingLabel} ${knownThinking.map((level) => level.toLowerCase()).join(', ')}; ${thinking.toLowerCase()} is not supported`);
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
  // A preset answer is one bounded JSON record, so template mode keeps its
  // historical 16,384-token default; --max-tokens now raises it explicitly.
  const defaultMaxTokens = effectiveMode === 'template'
    ? DEFAULT_TEMPLATE_MAX_TOKENS
    : isKimiK3
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

  const cloudflareAccountId = flags.cloudflareAccountId
    ?? env.CLOUDFLARE_ACCOUNT_ID
    ?? fileConfig.cloudflareAccountId;
  const cloudflareGatewayId = flags.cloudflareGatewayId
    ?? env.CLOUDFLARE_AI_GATEWAY_ID
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
  const apiKey = env[apiKeyEnv]?.trim() || '';
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
  const gatewayToken = gateway === 'cloudflare' ? env[gatewayTokenEnv]?.trim() : undefined;
  // Error text that echoes a credential verbatim is scrubbed by value, not only
  // by shape: register the values this run may send, plus every well-known
  // credential variable, before anything can fail and render a message.
  for (const name of new Set([apiKeyEnv, gatewayTokenEnv, ...PROJECT_ENV_CREDENTIALS])) {
    registerSecretForRedaction(env[name]);
  }
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
  maxTokens: { flag: '--max-tokens', field: 'extraction.maxTokens', modes: ['simple', 'template', 'agentic'] },
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
