import type { AgentStep } from '@open-ocr/engine/agentTypes';
import {
  createProviderExecutionContext,
  type ProviderExecutionContext,
} from '@open-ocr/engine/providers';
import {
  asCliExitError,
  CliExitError,
  ocrErrorPayload,
  redactSensitiveErrorText,
  type CliExitCode,
  type OcrErrorPayload,
} from './errors';
import { inputFingerprint, readAndValidateInput } from './inputs';
import { assertProviderMediaTypeSupported } from './providerInputs';
import {
  assertArtifactFormatAvailable,
  assertArtifactTargetsAvailable,
  assertNoOutputCollisions,
  artifactTargetFromPath,
  BatchOutputLock,
  defaultOutputDirectory,
  ManifestStore,
  plannedArtifactTargets,
  resolvesToSingleArtifactFile,
  STDIN_MANIFEST_KEY,
  writeArtifacts,
  writeBatchSummary,
} from './output';
import {
  agentProtocolStep,
  assertOcrJobEvent,
  OCR_PROTOCOL_VERSION,
  ocrDocumentId,
  toOcrRunResult,
  toProtocolDocument,
  type OcrJobEvent,
  type OcrJobEventSink,
  type OcrDeliveryMode,
  type OcrProgressLevel,
  type OcrRunResult,
} from './protocol';
import type {
  AgenticExtractionResult,
  BatchSummary,
  ManifestEntry,
  OcrArtifacts,
  OcrJobResult,
  OcrNextAction,
  OcrPartialReason,
  ResolvedCliOptions,
  ResolvedInput,
} from './types';

/**
 * The agentic JSON artifact is the protocol's `agenticResult` shape, written by
 * the runner; this reads its `stopReason` back without casting into the engine
 * type the service never sees.
 */
function isAgenticExtractionResult(value: unknown): value is AgenticExtractionResult {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { stopReason?: unknown }).stopReason === 'string'
    && typeof (value as { fields?: unknown }).fields === 'object';
}

export interface OcrExtractionResult {
  artifacts: OcrArtifacts;
  attempts: number;
}

export type OcrDocumentExtractor = (
  input: ResolvedInput,
  options: ResolvedCliOptions,
  signal: AbortSignal,
  onStep: (step: AgentStep) => void,
  providerRuntime: ProviderExecutionContext,
) => Promise<OcrExtractionResult>;

export interface OcrJobServiceDependencies {
  extractDocument: OcrDocumentExtractor;
  /** Override local-file validation for another logical input source, such as URLs. */
  validateInput?: (input: ResolvedInput, options: ResolvedCliOptions) => Promise<void>;
  /** Override provider media checks for non-file inputs. */
  assertInputSupported?: (input: ResolvedInput, options: ResolvedCliOptions) => void;
}

export interface OcrJobServiceRuntime {
  runId: string;
  abortController: AbortController;
  eventSink?: OcrJobEventSink;
  onDocumentResult?: (index: number, total: number, result: OcrJobResult) => void | Promise<void>;
  onAgentStep?: (input: ResolvedInput, step: AgentStep) => void;
  onWarning?: (message: string) => void;
  /** Persist a manifest for a reference-first, single-document output directory. */
  enableSingleInputResume?: boolean;
  /** Explicit machine delivery; the direct CLI derives delivery from its output options. */
  deliveryMode?: OcrDeliveryMode;
  /** Structured agent event detail. */
  progress?: OcrProgressLevel;
  /**
   * Warnings raised before the service was entered — option resolution,
   * request fields the mode will not read, documents a directory scan passed
   * over. Replayed as `run.warning` events after `run.started` and carried in
   * the result's `warnings`, so the machine surfaces report them and not only
   * the stderr diagnostics channel.
   */
  priorWarnings?: readonly string[];
}

export interface OcrJobServiceResult {
  runId: string;
  summary: BatchSummary;
  result: OcrRunResult;
}

/**
 * Where this job's artifacts and job metadata go. Resolved once so the batch
 * lock and the manifest can never disagree about whether the run owns an output
 * directory.
 */
interface OutputPlan {
  shouldWriteFiles: boolean;
  needsManifest: boolean;
  deliveryMode: OcrDeliveryMode;
}

/** Remove document bodies and extraction payloads from the auditable summary. */
function persistedJobResult(result: OcrJobResult): OcrJobResult {
  return {
    ...result,
    input: { ...result.input, stdinBytes: undefined },
    artifacts: undefined,
  };
}

type EventPayload = Omit<OcrJobEvent, 'protocolVersion' | 'runId' | 'sequence' | 'timestamp'>;

class EventDispatcher {
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly runId: string,
    private readonly sink?: OcrJobEventSink,
  ) {}

  emit(payload: EventPayload): Promise<void> {
    if (!this.sink) return Promise.resolve();
    const { error, ...common } = payload;
    const event: OcrJobEvent = {
      protocolVersion: OCR_PROTOCOL_VERSION,
      runId: this.runId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      ...common,
      ...(error ? { error } : {}),
    };
    // Validate before allocating the sequence number so a bad event does not
    // leave a permanent gap or throw after side effects.
    assertOcrJobEvent(event);
    this.sequence += 1;
    const delivery = this.pending.then(async () => this.sink?.(event));
    // Keep later events deliverable after a sink failure, while retaining the
    // first rejection so a later flush cannot race past an async sink error.
    this.pending = delivery.catch((error: unknown) => {
      this.failure ??= error;
    });
    return delivery;
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure !== undefined) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure instanceof Error
        ? failure
        : new Error(errorMessage(failure));
    }
  }
}

export function modeFingerprint(options: ResolvedCliOptions): string {
  return JSON.stringify({
    provider: options.provider,
    gateway: options.gateway,
    baseUrl: options.baseUrl,
    cloudflareProvider: options.cloudflareProvider,
    cloudflareByok: options.cloudflareByok,
    cloudflareByokAlias: options.cloudflareByokAlias,
    mode: options.mode,
    preset: options.preset,
    model: options.model,
    thinking: options.thinking,
    traceProgress: options.format === 'all' ? options.progress : undefined,
    traceThoughtSummaries: options.format === 'all' ? options.includeThoughts : undefined,
    format: options.format,
    instructions: options.instructions,
    detectImages: options.detectImages,
    detectMath: options.detectMath,
    maxTokens: options.maxTokens,
    maxIterations: options.maxIterations,
    confidenceThreshold: options.confidenceThreshold,
    customSchema: options.customSchema,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * The `error`/`errorDetails` pair a failed or skipped document reports, built
 * once from one source.
 *
 * Both fields are read: `errorDetails` by the machine protocol, the bare string
 * by the `--jsonl` document records, the stderr status lines, the resume
 * manifest, and batch-summary.json. `ocrErrorPayload` is what reduces a
 * provider's JSON body to the sentence it wrote and strips credential-shaped
 * fragments out of it, so a bare `Error.message` taken alongside it is an
 * unredacted copy of the same failure on the surfaces most likely to be
 * persisted and logged. Returning the two together is what makes them
 * unable to diverge.
 */
function documentFailure(error: unknown, fallbackExitCode: CliExitCode = 2): {
  error: string;
  errorDetails: OcrErrorPayload;
} {
  const errorDetails = ocrErrorPayload(error, fallbackExitCode);
  return { error: errorDetails.message, errorDetails };
}

function errorAttempts(error: unknown): number {
  if (error instanceof Error && 'attempts' in error && typeof error.attempts === 'number') {
    return error.attempts;
  }
  return 1;
}

function agentPartialResolution(stopReason: string): {
  partialReason: OcrPartialReason;
  nextAction: OcrNextAction;
} {
  switch (stopReason) {
    case 'partial':
      return { partialReason: 'readiness_not_met', nextAction: 'review_partial_output' };
    case 'max_iterations':
      return { partialReason: 'max_iterations', nextAction: 'increase_max_iterations' };
    case 'tool_limit_reached':
      return { partialReason: 'tool_limit_reached', nextAction: 'retry_document' };
    case 'budget_exhausted':
      return { partialReason: 'time_budget_reached', nextAction: 'increase_timeout' };
    case 'cost_limit_reached':
      return { partialReason: 'cost_limit_reached', nextAction: 'increase_max_cost' };
    default:
      throw new Error(`Agentic OCR returned unsupported partial stop reason: ${stopReason}`);
  }
}

function terminalEventType(result: OcrJobResult): OcrJobEvent['type'] {
  if (result.status === 'failed') return 'document.failed';
  if (result.status === 'partial') return 'document.partial';
  if (result.status === 'skipped') return 'document.skipped';
  return 'document.completed';
}

function agentToolLabel(name: string | undefined): string {
  if (name === 'analyze_document_structure') return 'document structure analysis';
  if (name === 'extract_fields_batch') return 'field extraction';
  if (name === 're_ocr_region') return 'region re-OCR';
  return 'an agent tool';
}

const MAX_PROGRESS_MESSAGE_LENGTH = 512;
const ANSI_CONTROL_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'gu',
);

function isSafeProgressCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  const disallowedControl = codePoint <= 8
    || (codePoint >= 11 && codePoint <= 12)
    || (codePoint >= 14 && codePoint <= 31)
    || (codePoint >= 127 && codePoint <= 159);
  const bidirectionalOverride = (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
  return !disallowedControl && !bidirectionalOverride;
}

/** Produce a bounded, terminal-safe direct-CLI progress message. */
export function normalizeAgentProgressText(content: string): string | undefined {
  const withoutAnsi = content.replace(ANSI_CONTROL_SEQUENCE, '');
  const normalized = Array.from(withoutAnsi)
    .filter(isSafeProgressCharacter)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return undefined;

  const characters = Array.from(normalized);
  if (characters.length <= MAX_PROGRESS_MESSAGE_LENGTH) return normalized;
  return `${characters.slice(0, MAX_PROGRESS_MESSAGE_LENGTH - 1).join('').trimEnd()}…`;
}

export function agentProgressMessage(step: AgentStep): string {
  if (step.type === 'thinking') {
    return normalizeAgentProgressText(step.content) ?? 'Agent is analyzing the document.';
  }
  if (step.type === 'function_call') {
    return `Agent requested ${agentToolLabel(step.functionCall?.name)}.`;
  }
  if (step.type === 'error') {
    return normalizeAgentProgressText(step.content) ?? 'An agent step reported an error.';
  }
  if (step.functionCall?.name) {
    return `Agent completed ${agentToolLabel(step.functionCall.name)}.`;
  }
  return normalizeAgentProgressText(step.content) ?? 'Agent processing step completed.';
}

/**
 * Process-independent batch application service. It owns OCR job semantics,
 * persistence, scheduling, and lifecycle events, but never reads or writes
 * process stdio, installs signal handlers, or chooses a process exit code.
 */
export class OcrJobService {
  constructor(private readonly dependencies: OcrJobServiceDependencies) {}

  private validateInput(input: ResolvedInput, options: ResolvedCliOptions): Promise<void> {
    if (this.dependencies.validateInput) return this.dependencies.validateInput(input, options);
    return readAndValidateInput(input).then(() => undefined);
  }

  private assertInputSupported(input: ResolvedInput, options: ResolvedCliOptions): void {
    if (this.dependencies.assertInputSupported) {
      this.dependencies.assertInputSupported(input, options);
      return;
    }
    assertProviderMediaTypeSupported(input.mimeType, options);
  }

  private async planOutput(
    inputs: ResolvedInput[],
    options: ResolvedCliOptions,
    runtime: OcrJobServiceRuntime,
  ): Promise<OutputPlan> {
    const explicitDelivery = runtime.deliveryMode;
    const shouldWriteFiles = explicitDelivery === 'reference'
      || (explicitDelivery === undefined && (
        inputs.length > 1 || Boolean(options.output) || options.format === 'all'
      ));
    // Job metadata needs a directory of its own; `--output report.md` leaves it
    // nowhere to go, so gate on the output layout rather than the document count.
    const singleArtifactFile = await resolvesToSingleArtifactFile(options, inputs.length);
    // One document resumes exactly like several, provided it has a stable
    // manifest key. stdin and URL documents all key on '<stdin>', so they stay
    // on the caller's explicit opt-in rather than sharing one entry.
    const keyedByPath = inputs.every((input) => input.absolutePath !== undefined);
    const needsManifest = shouldWriteFiles && !singleArtifactFile && (
      inputs.length > 1 || keyedByPath || runtime.enableSingleInputResume === true
    );
    return {
      shouldWriteFiles,
      needsManifest,
      deliveryMode: explicitDelivery ?? (shouldWriteFiles ? 'reference' : 'inline'),
    };
  }

  async run(
    inputs: ResolvedInput[],
    options: ResolvedCliOptions,
    runtime: OcrJobServiceRuntime,
  ): Promise<OcrJobServiceResult> {
    const events = new EventDispatcher(runtime.runId, runtime.eventSink);
    const providerRuntime = createProviderExecutionContext({
      requestsPerMinute: options.requestsPerMinute,
      maxCostUsd: options.maxCostUsd,
    });
    const warnings: string[] = [...(runtime.priorWarnings ?? [])];
    // A warning raised mid-run reaches three places at once: the host's
    // diagnostic channel, the event stream, and the result. The event is not
    // awaited because lock acquisition reports through a synchronous callback;
    // the dispatcher still serialises it and retains a sink failure for flush().
    const warn = (message: string): void => {
      warnings.push(message);
      runtime.onWarning?.(message);
      void events.emit({ type: 'run.warning', message }).catch(() => undefined);
    };
    let batchLock: BatchOutputLock | undefined;
    let plan: OutputPlan | undefined;
    let summary: BatchSummary | undefined;
    let failure: unknown;

    await events.emit({
      type: 'run.started',
      total: inputs.length,
      provider: options.provider,
      gateway: options.gateway,
      model: options.model,
      mode: options.mode,
      dryRun: options.dryRun,
    });
    for (const message of runtime.priorWarnings ?? []) {
      await events.emit({ type: 'run.warning', message });
    }

    try {
      // The lock guards the manifest, so both follow one plan: a run that keeps
      // no manifest (stdout, inline delivery, or a single-artifact-file output)
      // must not create a lock directory either.
      plan = await this.planOutput(inputs, options, runtime);
      if (plan.needsManifest && !options.dryRun) {
        try {
          batchLock = await BatchOutputLock.acquire(defaultOutputDirectory(options), {
            forceUnlock: options.forceUnlock,
            onWarning: warn,
          });
        } catch (error) {
          throw asCliExitError(error, 2);
        }
      }
      summary = await this.runBatchInternal(inputs, options, runtime, events, providerRuntime, plan);
    } catch (error) {
      failure = error;
    }

    try {
      await batchLock?.release();
    } catch (lockError) {
      failure = failure === undefined
        ? lockError
        : new Error(
            `${errorMessage(failure)}; batch lock cleanup also failed: ${errorMessage(lockError)}`,
            { cause: failure },
          );
    }

    if (failure !== undefined) {
      const typedFailure = failure instanceof CliExitError
        ? failure
        // Redact here as well as at every renderer: this error is thrown, and a
        // caller that logs `error.message` directly bypasses `ocrErrorPayload`.
        // No `hint`: the constructor falls back to DEFAULT_ERROR_HINTS for the
        // code, so a copy here could only drift from the taxonomy it belongs to.
        : new CliExitError(redactSensitiveErrorText(errorMessage(failure)), 1, {
            cause: failure,
            code: 'INTERNAL',
            category: 'internal',
            retryable: false,
          });
      await events.emit({
        type: 'run.failed',
        error: ocrErrorPayload(typedFailure),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
      await events.flush();
      throw typedFailure;
    }
    if (!summary || !plan) throw new Error('Internal error: batch completed without a summary or output plan');

    const result = toOcrRunResult(
      runtime.runId,
      summary,
      plan.deliveryMode,
      options.format,
      runtime.progress ?? options.progress,
      warnings,
    );
    await events.emit({ type: 'run.completed', result });
    await events.flush();
    return { runId: runtime.runId, summary, result };
  }

  private async runBatchInternal(
    inputs: ResolvedInput[],
    options: ResolvedCliOptions,
    runtime: OcrJobServiceRuntime,
    events: EventDispatcher,
    providerRuntime: ProviderExecutionContext,
    plan: OutputPlan,
  ): Promise<BatchSummary> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    // stdin IDs include a content hash. Compute them once per document so a
    // detailed streaming run does not re-hash tens of megabytes for every
    // model delta.
    const documentIds = inputs.map((input) => ocrDocumentId({ input }));
    const { shouldWriteFiles, needsManifest, deliveryMode } = plan;
    if (shouldWriteFiles) {
      try {
        await assertNoOutputCollisions(inputs, options, needsManifest);
      } catch (error) {
        throw asCliExitError(error, 2);
      }
    }
    const manifest = needsManifest ? new ManifestStore(defaultOutputDirectory(options)) : undefined;
    try {
      await manifest?.load();
    } catch (error) {
      throw asCliExitError(error, 2);
    }
    const fingerprintMode = modeFingerprint(options);
    const resumableEntries = new Map<number, ManifestEntry>();
    const staleArtifacts = new Map<number, ReadonlySet<string>>();
    const resumeActive = Boolean(options.resume) && manifest !== undefined;
    // Runs regardless of --dry-run. An occupied destination is checkable without
    // a credential and without a provider call, so a dry run that stayed silent
    // about it would approve a job the live run rejects. Resolving resume state
    // first keeps that honest in both directions: a document the live run would
    // skip as unchanged is not reported as a conflict.
    try {
      await Promise.all(inputs.map(async (input, index) => {
        const key = input.absolutePath ?? STDIN_MANIFEST_KEY;
        const fingerprint = inputFingerprint(input, fingerprintMode);
        const completedEntry = resumeActive && !options.overwrite
          ? await manifest?.completedEntry(key, fingerprint)
          : undefined;
        if (completedEntry) {
          resumableEntries.set(index, completedEntry);
          return;
        }
        // A tracked input that changed (or lost part of its output) is exactly
        // what resume exists for: re-extract it over its own stale artifacts
        // rather than failing the whole batch on a destination this job owns.
        // Only paths the manifest recorded for this same input are reclaimed;
        // anything else at a target path is still a genuine collision.
        const reclaimable = resumeActive
          ? manifest?.recordedArtifactPaths(key) ?? new Set<string>()
          : new Set<string>();
        if (reclaimable.size > 0) staleArtifacts.set(index, reclaimable);
        if (shouldWriteFiles) {
          await assertArtifactTargetsAvailable(input, options, inputs.length, {
            reclaimable,
            resumeActive,
          });
        }
      }));
    } catch (error) {
      throw asCliExitError(error, 2);
    }
    const results = new Array<OcrJobResult | undefined>(inputs.length);
    let cursor = 0;
    let completed = 0;
    let failFastTriggered = false;
    let costLimitReached = false;

    const publishResult = async (index: number, result: OcrJobResult): Promise<void> => {
      completed += 1;
      await runtime.onDocumentResult?.(completed, inputs.length, result);
      await events.emit({
        type: terminalEventType(result),
        document: toProtocolDocument(
          result,
          deliveryMode,
          options.format,
          runtime.progress ?? options.progress,
        ),
      });
      // Large bodies have already been persisted and observed by the adapter.
      results[index] = shouldWriteFiles && inputs.length > 1 && result.artifacts
        ? { ...result, artifacts: undefined }
        : result;
    };

    const worker = async (): Promise<void> => {
      while (!runtime.abortController.signal.aborted && !failFastTriggered && !costLimitReached) {
        const index = cursor;
        if (index >= inputs.length) return;
        if (providerRuntime.hasReachedCostLimit()) {
          costLimitReached = true;
          return;
        }
        cursor += 1;
        const input = inputs[index];
        const jobStart = performance.now();
        const jobStartedAt = new Date().toISOString();
        const key = input.absolutePath ?? STDIN_MANIFEST_KEY;
        const fingerprint = inputFingerprint(input, fingerprintMode);
        await events.emit({
          type: 'document.started',
          documentId: documentIds[index],
          index,
          total: inputs.length,
          source: input.displayPath,
        });

        let result: OcrJobResult;
        const completedEntry = resumableEntries.get(index);
        if (options.dryRun) {
          try {
            this.assertInputSupported(input, options);
            await this.validateInput(input, options);
            const plannedOutputArtifacts = shouldWriteFiles
              ? await plannedArtifactTargets(input, options, inputs.length)
              : [];
            result = {
              status: 'skipped', input, provider: options.provider, gateway: options.gateway,
              mode: options.mode, model: options.model, startedAt: jobStartedAt,
              completedAt: new Date().toISOString(), durationMs: performance.now() - jobStart,
              attempts: 0, plannedOutputArtifacts,
              plannedOutputFiles: plannedOutputArtifacts.map((target) => target.path),
              skipReason: 'validated',
            };
          } catch (error) {
            result = {
              status: 'failed', input, provider: options.provider, gateway: options.gateway,
              mode: options.mode, model: options.model, startedAt: jobStartedAt,
              completedAt: new Date().toISOString(), durationMs: performance.now() - jobStart,
              attempts: 0, ...documentFailure(error),
            };
            if (options.failFast) failFastTriggered = true;
          }
        } else if (completedEntry) {
          const outputArtifacts = completedEntry.outputFiles.map(artifactTargetFromPath);
          result = {
            status: 'skipped', input, provider: options.provider, gateway: options.gateway,
            mode: options.mode, model: options.model, startedAt: jobStartedAt,
            completedAt: new Date().toISOString(), durationMs: performance.now() - jobStart,
            attempts: 0, outputFiles: completedEntry.outputFiles, outputArtifacts, skipReason: 'resumed',
          };
        } else {
          const timeoutController = new AbortController();
          const relayAbort = (): void => timeoutController.abort(runtime.abortController.signal.reason);
          runtime.abortController.signal.addEventListener('abort', relayAbort, { once: true });
          if (runtime.abortController.signal.aborted) relayAbort();
          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            timeoutController.abort(new Error(`Timed out after ${options.timeoutSeconds}s`));
          }, options.timeoutSeconds * 1000);
          let progressFailure: unknown;
          try {
            timeoutController.signal.throwIfAborted();
            this.assertInputSupported(input, options);
            const { artifacts, attempts } = await this.dependencies.extractDocument(
              input,
              options,
              timeoutController.signal,
              (step) => {
                try {
                  runtime.onAgentStep?.(input, step);
                  const protocolStep = agentProtocolStep(step, runtime.progress ?? options.progress);
                  if (!protocolStep) return;
                  void events.emit({
                    type: 'document.progress',
                    documentId: documentIds[index],
                    index,
                    total: inputs.length,
                    source: input.displayPath,
                    step: protocolStep,
                  }).catch((error: unknown) => {
                    progressFailure ??= error;
                  });
                } catch (error) {
                  // agentProtocolStep / assertOcrJobEvent can throw sync; keep
                  // the intentional document-boundary progressFailure path.
                  progressFailure ??= error;
                }
              },
              providerRuntime,
            );
            // Agent runtimes may preserve partial memory by returning normally
            // after their signal fires. The document boundary owns timeout and
            // cancellation semantics, so never accept that return as a normal
            // partial/successful extraction.
            if (timeoutController.signal.aborted) {
              throw timeoutController.signal.reason instanceof Error
                ? timeoutController.signal.reason
                : new DOMException('Operation aborted', 'AbortError');
            }
            await events.flush();
            if (progressFailure !== undefined) {
              throw progressFailure instanceof Error
                ? progressFailure
                : new Error(errorMessage(progressFailure));
            }
            if (deliveryMode === 'inline') {
              assertArtifactFormatAvailable(artifacts, options.format);
            }
            const outputArtifacts = shouldWriteFiles
              ? await writeArtifacts(input, artifacts, options, inputs.length, staleArtifacts.get(index))
              : undefined;
            const outputFiles = outputArtifacts?.map((target) => target.path);
            const agentResult = options.mode === 'agentic' && isAgenticExtractionResult(artifacts.json)
              ? artifacts.json
              : undefined;
            const jobStatus: OcrJobResult['status'] = agentResult && agentResult.stopReason !== 'succeeded'
              ? 'partial'
              : 'succeeded';
            if (agentResult?.stopReason === 'cost_limit_reached') costLimitReached = true;
            const partialResolution = agentResult?.stopReason && agentResult.stopReason !== 'succeeded'
              ? agentPartialResolution(agentResult.stopReason)
              : undefined;
            result = {
              status: jobStatus, input, provider: options.provider, gateway: options.gateway,
              mode: options.mode, model: options.model, startedAt: jobStartedAt,
              completedAt: new Date().toISOString(), durationMs: performance.now() - jobStart,
              artifacts, outputFiles, outputArtifacts, attempts, ...partialResolution,
            };
            await manifest?.update(key, {
              fingerprint,
              status: jobStatus,
              outputFiles: outputFiles ?? [],
              completedAt: result.completedAt,
            });
          } catch (error) {
            if (progressFailure !== undefined && error === progressFailure) throw error;
            const cancelled = runtime.abortController.signal.aborted && !timedOut;
            const typedError = timedOut
              ? new CliExitError(`Timed out after ${options.timeoutSeconds}s`, 1, {
                  code: 'TIMEOUT',
                  category: 'limit',
                  retryable: true,
                  hint: 'Retry with a longer --timeout or a smaller document.',
                })
              : cancelled
                ? new CliExitError(errorMessage(runtime.abortController.signal.reason ?? error), 130, { cause: error })
                : error;
            const failure = documentFailure(typedError, 1);
            // Read the classified code, not the raw error: by this point the
            // provider's cost-limit rejection is wrapped by the retry layer, so
            // an instance check against the original class never matched and a
            // cost-stopped batch reported its remaining documents as a
            // retryable NOT_RUN. `documentFailure` walks the cause chain.
            if (failure.errorDetails.code === 'COST_LIMIT') costLimitReached = true;
            result = {
              status: cancelled ? 'skipped' : 'failed', input, provider: options.provider, gateway: options.gateway,
              mode: options.mode, model: options.model, startedAt: jobStartedAt,
              completedAt: new Date().toISOString(), durationMs: performance.now() - jobStart,
              ...(cancelled ? { skipReason: 'cancelled' as const } : {}),
              ...failure, attempts: errorAttempts(error),
            };
            // An interrupted document must remain resumable. The manifest has no
            // cancelled state, so persist it as failed while exposing the richer
            // skipped/cancelled status through the machine and batch contracts.
            await manifest?.update(key, {
              fingerprint,
              status: 'failed',
              // A failed replacement leaves the previous artifact transaction
              // intact. Retain its ownership so the next resume can replace
              // those stale files instead of rejecting them as untracked.
              outputFiles: [...(manifest?.recordedArtifactPaths(key) ?? [])],
              completedAt: result.completedAt,
              error: failure.error,
            });
            if (options.failFast && !cancelled) failFastTriggered = true;
          } finally {
            clearTimeout(timeout);
            runtime.abortController.signal.removeEventListener('abort', relayAbort);
          }
        }
        await publishResult(index, result);
      }
    };

    // A failed event sink or persistence operation must stop sibling workers,
    // then join them before releasing the output lock or returning to the host.
    const workers = await Promise.allSettled(Array.from(
      { length: Math.min(options.concurrency, inputs.length) },
      async () => {
        try {
          await worker();
        } catch (error) {
          runtime.abortController.abort(error);
          throw error;
        }
      },
    ));
    const rejected = workers.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      throw rejected.reason instanceof Error ? rejected.reason : new Error(errorMessage(rejected.reason));
    }
    const unscheduledReason = runtime.abortController.signal.aborted
      ? 'Not started because the batch was cancelled'
      : costLimitReached
        ? `Not started because the estimated cost reached --max-cost $${options.maxCostUsd?.toFixed(4)}`
        : 'Not started because --fail-fast stopped the batch';
    const unscheduledSkipReason: OcrJobResult['skipReason'] = runtime.abortController.signal.aborted
      ? 'cancelled'
      : costLimitReached ? 'cost-limit' : 'fail-fast';
    for (let index = 0; index < inputs.length; index += 1) {
      if (results[index]) continue;
      const timestamp = new Date().toISOString();
      const failure = unscheduledSkipReason === 'cancelled'
        ? documentFailure(new CliExitError(unscheduledReason, 130))
        : unscheduledSkipReason === 'cost-limit'
          ? documentFailure(new CliExitError(unscheduledReason, 1, {
              code: 'COST_LIMIT', category: 'limit', retryable: false,
              hint: 'Rerun the remaining documents with a higher --max-cost, or accept the partial batch.',
            }))
          : documentFailure(new CliExitError(unscheduledReason, 1, {
              code: 'NOT_RUN', category: 'execution', retryable: true,
              hint: 'Rerun the skipped documents without --fail-fast after addressing the first failure.',
            }));
      // Emit document.started so every documentId appears in the lifecycle
      // stream before its terminal event (including fail-fast/cost/cancel remainders).
      await events.emit({
        type: 'document.started',
        documentId: documentIds[index],
        index,
        total: inputs.length,
        source: inputs[index].displayPath,
      });
      const result: OcrJobResult = {
        status: 'skipped', input: inputs[index], provider: options.provider, gateway: options.gateway,
        mode: options.mode, model: options.model, startedAt: timestamp, completedAt: timestamp,
        durationMs: 0, attempts: 0, skipReason: unscheduledSkipReason,
        ...failure,
      };
      await publishResult(index, result);
    }
    const finishedResults = results.map((result, index): OcrJobResult => {
      if (!result) throw new Error(`Internal error: missing result for input ${index + 1}`);
      return result;
    });
    const completedAt = new Date().toISOString();
    const summary: BatchSummary = {
      version: 1,
      startedAt,
      completedAt,
      durationMs: performance.now() - started,
      total: inputs.length,
      succeeded: finishedResults.filter((result) => result.status === 'succeeded').length,
      partial: finishedResults.filter((result) => result.status === 'partial').length,
      failed: finishedResults.filter((result) => result.status === 'failed').length,
      skipped: finishedResults.filter((result) => result.status === 'skipped').length,
      mode: options.mode,
      provider: options.provider,
      gateway: options.gateway,
      model: options.model,
      usage: providerRuntime.getUsage(),
      costLimitUsd: options.maxCostUsd,
      costLimitReached: costLimitReached || providerRuntime.wasCostLimitDenied(),
      results: finishedResults,
    };
    // Gated on the manifest, not the document count: `needsManifest` is exactly
    // the condition under which this run owns an output directory and has
    // already reserved `batch-summary.json` in it. Keying on `inputs.length > 1`
    // meant a single-document reference run reserved the path, created the
    // manifest and lock, and then wrote no summary — leaving `status` with
    // nothing to report for a run the docs say is auditable.
    if (needsManifest && !options.dryRun) {
      await writeBatchSummary(
        { ...summary, results: summary.results.map(persistedJobResult) },
        defaultOutputDirectory(options),
      );
    }
    return summary;
  }
}
