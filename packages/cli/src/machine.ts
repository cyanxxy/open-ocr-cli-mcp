import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  assertCredentialsAvailable,
  ignoredModeScopedOptionWarning,
  ignoredModeScopedOptions,
  loadCliConfig,
  localEnvironment,
  resolveCliOptions,
  type ModeScopedOptionKey,
} from './config';
import { CliExitError } from './errors';
import { describeDiscoverySkips, discoverInputSet } from './inputs';
import { createOcrJobService } from './runner';
import type { OcrJobServiceResult } from './ocrJobService';
import { customSchemaCompatibilityWarning, loadCustomSchema, validateCustomSchema } from './schema';
import {
  defaultAgentOutputDirectory,
  isStdinRequestInput,
  ocrExtractionSemanticError,
  ocrUrlExtractionSemanticError,
  parseOcrJobRequest,
  type OcrJobEventSink,
  type OcrJobRequest,
} from './protocol';
import type { CliConfigFile, ExtractCommandFlags } from './types';
import { resolveWebUrls, runWebJob } from './web';

export interface ExecuteOcrJobOptions {
  cwd: string;
  runId: string;
  abortController: AbortController;
  eventSink?: OcrJobEventSink;
  onWarning?: (message: string) => void;
  noConfig?: boolean;
}

const MAX_REQUEST_BYTES = 1024 * 1024;

function requestTooLarge(): CliExitError {
  return new CliExitError('OCR request JSON exceeds the 1 MB limit', 2, {
    code: 'CONFIG_INVALID',
    category: 'configuration',
    retryable: false,
    hint: 'Store large extraction schemas in a separate schema file.',
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}

function requestNotReadable(message: string, cause: unknown): CliExitError {
  return new CliExitError(message, 2, {
    cause,
    code: 'INPUT_NOT_FOUND',
    category: 'input',
    retryable: false,
    hint: 'Check the request path and working directory.',
  });
}

/**
 * Map an unreadable request path to a typed protocol error.
 *
 * A raw ErrnoException would fall through every classifier into a generic
 * failure carrying the resolved absolute path, which redaction does not strip.
 */
function requestPathError(error: unknown, requestPath: string): CliExitError | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return requestNotReadable(`OCR request file not found: ${requestPath}`, error);
  if (code === 'EISDIR') return requestNotReadable(`OCR request path is not a file: ${requestPath}`, error);
  if (code === 'EACCES' || code === 'EPERM') {
    return requestNotReadable(`OCR request file is not readable: ${requestPath}`, error);
  }
  return undefined;
}

export async function readStandardInput(
  signal?: AbortSignal,
  input: Readable = process.stdin,
): Promise<string> {
  let value = '';
  let bytes = 0;
  signal?.throwIfAborted();
  const onAbort = (): void => {
    input.destroy(signal ? abortReason(signal) : undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  input.setEncoding('utf8');
  try {
    for await (const chunk of input as AsyncIterable<string>) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) throw requestTooLarge();
      value += chunk;
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return value;
}

/**
 * Read and validate a protocol request from a file or stdin.
 *
 * Returns the parsed request rather than the raw text: the raw body existed only
 * to let a caller peek at `protocolVersion` before choosing a validator, and
 * there is one version.
 */
export async function readOcrJobRequest(
  requestPath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<OcrJobRequest> {
  let raw: string;
  if (requestPath === '-') {
    raw = await readStandardInput(signal);
  } else {
    const absolutePath = path.resolve(cwd, requestPath);
    // Size-check and read through one handle. Stat-then-read re-resolves the
    // path, so the file could be swapped for a larger one between the guard and
    // the read; the guard must describe the bytes actually loaded.
    let handle;
    try {
      handle = await open(absolutePath, 'r');
    } catch (error) {
      throw requestPathError(error, requestPath) ?? error;
    }
    try {
      if ((await handle.stat()).size > MAX_REQUEST_BYTES) throw requestTooLarge();
      raw = await handle.readFile('utf8');
    } catch (error) {
      if (error instanceof CliExitError) throw error;
      throw requestPathError(error, requestPath) ?? error;
    } finally {
      await handle.close();
    }
    if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) throw requestTooLarge();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliExitError(
      `OCR request JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
      2,
      {
        cause: error,
        code: 'CONFIG_INVALID',
        category: 'configuration',
        retryable: false,
        hint: 'Fix the request JSON syntax, then validate it again.',
      },
    );
  }
  return parseOcrJobRequest(parsed);
}

function requestFlags(request: OcrJobRequest, outputDirectory?: string): ExtractCommandFlags {
  return {
    config: request.configPath,
    provider: request.provider?.id,
    gateway: request.provider?.gateway,
    model: request.provider?.model,
    mode: request.extraction?.mode,
    preset: request.extraction?.preset,
    format: request.extraction?.schema || request.extraction?.schemaPath
      ? 'json'
      : request.extraction?.contentFormat,
    schema: request.extraction?.schemaPath,
    customSchema: request.extraction?.schema !== undefined,
    instruction: request.extraction?.instructions,
    thinking: request.extraction?.thinking,
    // Left undefined when the request omits it so file configuration — and then
    // the built-in default — still applies. Defaulting to 'standard' here made
    // the config file's `progress` key dead on the `run` and MCP surfaces, and
    // reported `extraction.progress` as an option the caller supplied when it
    // had not.
    progress: request.extraction?.progress,
    detectImages: request.extraction?.detectImages,
    detectMath: request.extraction?.detectMath,
    // Numbers pass through as numbers: the request schema already validated
    // them, and the resolver accepts both spellings.
    maxTokens: request.extraction?.maxTokens,
    maxIterations: request.extraction?.maxIterations,
    confidenceThreshold: request.extraction?.confidenceThreshold,
    concurrency: request.execution?.concurrency,
    retries: request.execution?.retries,
    timeout: request.execution?.timeoutSeconds,
    maxFiles: request.execution?.maxFiles,
    maxTotalMb: request.execution?.maxTotalMb,
    maxCost: request.execution?.maxCostUsd,
    requestsPerMinute: request.execution?.requestsPerMinute,
    failFast: request.execution?.failFast,
    hidden: request.discovery?.hidden,
    exclude: request.discovery?.exclude,
    output: outputDirectory,
    // `delivery.outputDirectory` is a directory by contract, so the "does this
    // path look like a file?" extension heuristic must not apply to it. Without
    // this, a perfectly ordinary directory name containing a dot —
    // `.open-ocr-results/run.2026` — was written as a single artifact file.
    outputPathKind: outputDirectory === undefined ? 'auto' : 'directory',
    // Resume is on by default only where it can work: the default output
    // directory is per run, so nothing in it can ever match an earlier run.
    // Defaulting to true there silently re-billed every document while telling
    // the caller resume was active.
    resume: request.delivery?.resume ?? request.delivery?.outputDirectory !== undefined,
    overwrite: false,
    jsonl: false,
    quiet: true,
    verbose: false,
    dryRun: request.dryRun,
  };
}

/**
 * Mode-scoped extraction fields the request actually set.
 *
 * Read from the request rather than from {@link requestFlags}, which fills in a
 * default `progress` for every v2 request and would otherwise report a field
 * the caller never sent.
 */
function suppliedModeScopedFields(request: OcrJobRequest): ModeScopedOptionKey[] {
  const supplied: ModeScopedOptionKey[] = [];
  if (request.execution?.retries !== undefined) supplied.push('retries');
  const extraction = request.extraction;
  if (!extraction) return supplied;
  if (extraction.detectImages !== undefined) supplied.push('detectImages');
  if (extraction.detectMath !== undefined) supplied.push('detectMath');
  if (extraction.instructions !== undefined && extraction.instructions.length > 0) supplied.push('instructions');
  if (extraction.maxTokens !== undefined) supplied.push('maxTokens');
  if (extraction.maxIterations !== undefined) supplied.push('maxIterations');
  if (extraction.confidenceThreshold !== undefined) supplied.push('confidenceThreshold');
  if (extraction.progress !== undefined) supplied.push('progress');
  return supplied;
}

function machineConfigurationError(request: OcrJobRequest, fileConfig: CliConfigFile): string | undefined {
  const requestExtraction = request.extraction;
  const requestHasSchema = requestExtraction?.schema !== undefined || requestExtraction?.schemaPath !== undefined;
  const hasSchema = requestHasSchema || fileConfig.schema !== undefined;
  const preset = requestExtraction?.preset ?? fileConfig.preset;
  const configuredMode = requestExtraction?.mode ?? fileConfig.mode;
  const mode = configuredMode ?? (preset ? 'template' : 'simple');
  const format = requestExtraction?.contentFormat ?? fileConfig.format ?? (hasSchema ? 'json' : 'markdown');
  const extractionError = ocrExtractionSemanticError({ mode, preset, hasSchema, contentFormat: format });
  if (extractionError) return extractionError;
  if (request.inputs.some((input) => input.type === 'url')) {
    const urlError = ocrUrlExtractionSemanticError({ mode, preset, hasSchema, contentFormat: format });
    if (urlError) return urlError;
  }
  return undefined;
}

function configurationError(message: string): CliExitError {
  return new CliExitError(message, 2, {
    code: 'CONFIG_INVALID',
    category: 'configuration',
    retryable: false,
    hint: 'Adjust the request or referenced configuration, then run a dry-run validation.',
  });
}

function schemaError(error: unknown): CliExitError {
  return new CliExitError(error instanceof Error ? error.message : String(error), 2, {
    cause: error,
    code: 'SCHEMA_INVALID',
    category: 'schema',
    retryable: false,
    hint: 'Validate the custom schema against the supported structured-output subset.',
  });
}

export async function executeOcrJobRequest(
  request: OcrJobRequest,
  execution: ExecuteOcrJobOptions,
): Promise<OcrJobServiceResult> {
  // Everything warned about before the service runs is collected so the
  // service can replay it as `run.warning` events and carry it in the result.
  // The host's own channel still hears each one as it happens.
  const priorWarnings: string[] = [];
  const warn = (message: string): void => {
    priorWarnings.push(message);
    execution.onWarning?.(message);
  };
  const stdinInputs = request.inputs.filter(isStdinRequestInput);
  if (stdinInputs.length > 0 && request.inputs.length !== 1) {
    throw configurationError(
      'An OCR stdin document must be the request\'s only input.',
    );
  }
  const urlInputs = request.inputs.filter((input) => input.type === 'url');
  if (urlInputs.length > 0 && urlInputs.length !== request.inputs.length) {
    throw configurationError('OCR URL inputs cannot be mixed with path or stdin inputs.');
  }
  const hermetic = execution.noConfig === true || request.noConfig === true;
  // Ambient OPEN_OCR_NO_CONFIG still blocks .env; explicit configPath may load
  // only that file (no user/project merge) via loadCliConfig hermetic rules.
  const env = localEnvironment(execution.cwd, hermetic);
  const fileConfig = await loadCliConfig(
    execution.cwd,
    request.configPath,
    hermetic,
  );
  const invalidConfiguration = machineConfigurationError(request, fileConfig);
  if (invalidConfiguration) throw configurationError(invalidConfiguration);

  // Validate schema content before option resolution can require credentials.
  let customSchema: Record<string, unknown> | undefined;
  try {
    customSchema = request.extraction?.schema
      ? validateCustomSchema(request.extraction.schema)
      : request.extraction?.schemaPath
        ? await loadCustomSchema(request.extraction.schemaPath, execution.cwd)
        : fileConfig.schema
          ? await loadCustomSchema(fileConfig.schema, execution.cwd)
          : undefined;
  } catch (error) {
    throw schemaError(error);
  }
  if (customSchema) {
    // Same diagnostic as the CLI, routed through the warning channel so `run`
    // and MCP callers are not left with an unexplained provider 400. Named for
    // the field the caller actually sent, since it never passed a CLI flag.
    const schemaWarning = customSchemaCompatibilityWarning(
      customSchema,
      request.extraction?.schema ? 'extraction.schema' : 'extraction.schemaPath',
    );
    if (schemaWarning) warn(schemaWarning);
  }
  const deliveryMode = request.delivery?.mode ?? 'reference';
  const outputDirectory = deliveryMode === 'reference'
    ? request.delivery?.outputDirectory
      ? path.resolve(execution.cwd, request.delivery.outputDirectory)
      : defaultAgentOutputDirectory(execution.cwd, execution.runId)
    : undefined;
  // The default output directory is per-run, so a resume there can never match
  // an earlier run and the caller silently pays for the same documents again.
  // Resume is off by default without an output directory, so only an explicit
  // request states an intent the default directory cannot honour.
  if (
    deliveryMode === 'reference'
    && request.delivery?.resume === true
    && request.delivery.outputDirectory === undefined
  ) {
    warn(
      'delivery.resume was requested without delivery.outputDirectory, so this run wrote to a new '
      + `per-run directory (${outputDirectory}) that no earlier run can match. `
      + 'Pass the same delivery.outputDirectory on every run for resume to skip unchanged documents.',
    );
  }
  const effectiveFileConfig = request.extraction?.schema !== undefined
    ? { ...fileConfig, schema: undefined }
    : fileConfig;
  const stdinInput = stdinInputs[0]?.type === 'stdin' ? stdinInputs[0] : undefined;
  const options = {
    // Errors name request fields, not `extract` flags: this caller sent JSON.
    ...resolveCliOptions(requestFlags(request, outputDirectory), effectiveFileConfig, execution.cwd, 'field', env),
    customSchema,
    ...(stdinInput?.name ? { stdinName: stdinInput.name } : {}),
    ...(stdinInput?.mimeType ? { stdinType: stdinInput.mimeType } : {}),
  };
  const ignoredWarning = ignoredModeScopedOptionWarning(
    ignoredModeScopedOptions(suppliedModeScopedFields(request), options.mode),
    options.mode,
    'field',
  );
  if (ignoredWarning) warn(ignoredWarning);
  if (urlInputs.length > 0) {
    const urls = await resolveWebUrls(urlInputs.map((input) => input.url), undefined, execution.cwd);
    assertCredentialsAvailable(options);
    return runWebJob(urls, request.web?.analysis ?? 'individual', options, {
      runId: execution.runId,
      abortController: execution.abortController,
      eventSink: execution.eventSink,
      onWarning: execution.onWarning,
      priorWarnings,
      deliveryMode,
      progress: options.progress,
      enableSingleInputResume: deliveryMode === 'reference',
    });
  }
  const discovery = await discoverInputSet(request.inputs.map((input) => (
    input.type === 'stdin' ? '-' : input.type === 'path' ? input.path : input.url
  )), options, execution.abortController.signal);
  // A directory scan that drops files hands back fewer documents than were
  // requested, which the caller has to hear about. It reuses the CLI's wording
  // so both surfaces say one thing.
  const skipSummary = describeDiscoverySkips(discovery.skipped);
  if (skipSummary) warn(`Discovery: ${skipSummary}`);
  assertCredentialsAvailable(options);
  return createOcrJobService().run(discovery.inputs, options, {
    runId: execution.runId,
    abortController: execution.abortController,
    eventSink: execution.eventSink,
    onWarning: execution.onWarning,
    priorWarnings,
    deliveryMode,
    progress: options.progress,
    enableSingleInputResume: deliveryMode === 'reference',
  });
}
