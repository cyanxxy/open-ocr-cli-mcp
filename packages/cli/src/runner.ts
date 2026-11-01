import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { agentLoop } from '@open-ocr/engine/agentLoop';
import type { AgentMemory, AgentStep } from '@open-ocr/engine/agentTypes';
import type { ExtractedContent, ExtractionInstruction } from '@open-ocr/engine/gemini/types';
import {
  extractPresetWithProvider,
  extractStructuredWithProvider,
  extractTextWithProvider,
  providerAgentLoop,
  providerDefaultBaseUrl,
  providerRequestHeaders,
  type ProviderExecutionContext,
} from '@open-ocr/engine/providers';
import { escapeMarkdown, getExtractionPreset } from '@open-ocr/engine/templates';
import { normalizeModelMarkdown, sectionsToMarkdown } from '@open-ocr/engine/gemini/markdown';
import { asCliExitError } from './errors';
import { readAndValidateInput } from './inputs';
import { nodeRegionCropper } from './nodeRegionCropper';
import { agentProgressMessage, normalizeAgentProgressText, OcrJobService, modeFingerprint } from './ocrJobService';
import { assertCustomSchemaOutput } from './schema';
import { primaryArtifact } from './output';
import type { OcrJobEventSink } from './protocol';
import { providerRuntimeConfig } from './providerRuntime';
import { writeStdout as writeProcessStdout } from './stdout';
import { runWithProviderRetries } from './providerRetries';
import type {
  AgenticExtractionResult,
  BatchSummary,
  OcrArtifacts,
  OcrJobResult,
  ResolvedCliOptions,
  ResolvedInput,
} from './types';

/**
 * The Markdown artifact for a simple-mode result. Markdown mode always carries
 * the model's own Markdown (preserved, see `normalizeModelMarkdown`); a JSON
 * answer without one is rebuilt from its sections at their recorded levels.
 */
export function extractedContentToMarkdown(result: ExtractedContent): string {
  if (result.markdown?.trim()) return normalizeModelMarkdown(result.markdown);
  return sectionsToMarkdown(result);
}

function recordName(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : undefined;
}

function unitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Project the engine's memory onto the protocol's `agenticResult` shape.
 *
 * The memory is an engine-internal type: it carries session IDs, timestamps
 * and the raw processing history, and it changes with the engine. Writing it
 * verbatim made that internal type the JSON artifact contract. The trace is
 * still available as the `agent-steps` artifact under `contentFormat: "all"`.
 */
export function agenticExtractionResult(memory: AgentMemory): AgenticExtractionResult {
  const fields = Object.fromEntries(
    Object.entries(memory.extractedFields).map(([name, field]) => [name, {
      value: field.value,
      confidence: unitInterval(field.confidence),
      ...(field.isValid !== undefined ? { valid: field.isValid } : {}),
      ...(field.validationMessage !== undefined ? { validationMessage: field.validationMessage } : {}),
      ...(field.validation_rule !== undefined ? { validationRule: field.validation_rule } : {}),
      ...(field.location !== undefined ? { location: field.location } : {}),
    }]),
  );
  return {
    documentType: memory.documentAnalysis.documentType,
    pageCount: Math.max(0, Math.trunc(memory.documentAnalysis.pageCount)),
    complexity: memory.documentAnalysis.complexity,
    specialFeatures: [...memory.documentAnalysis.specialFeatures],
    confidence: unitInterval(memory.confidence),
    iterations: Math.max(0, Math.trunc(memory.currentIteration)),
    // The loop sets a terminal reason on every exit; a missing one is treated
    // as the loop always treated it, as a run that ran to completion.
    stopReason: memory.stopReason ?? 'succeeded',
    fields,
  };
}

function agenticResultToMarkdown(result: AgenticExtractionResult): string {
  const fields = Object.entries(result.fields);
  const lines = [
    '# Agentic OCR Extraction',
    '',
    `- Document type: ${result.documentType || 'unknown'}`,
    `- Confidence: ${(result.confidence * 100).toFixed(0)}%`,
    `- Iterations: ${result.iterations}`,
    `- Stop reason: ${result.stopReason}`,
    '',
    '## Fields',
    '',
  ];
  if (fields.length === 0) lines.push('- None');
  for (const [name, field] of fields) {
    // Field names and values are model output: escaped like template-mode
    // cells, so a value carrying "\n# Injected" cannot open a heading.
    lines.push(`- **${escapeMarkdown(name)}**: ${escapeMarkdown(String(field.value))} (${Math.round(field.confidence * 100)}%)`);
  }
  return lines.join('\n');
}

function appendAgentTrace(steps: AgentStep[], step: AgentStep): void {
  const previous = steps.at(-1);
  if (
    step.delta
    && previous?.delta
    && previous.type === step.type
    && previous.source === step.source
    && previous.id === step.id
    && !previous.functionCall
    && !step.functionCall
  ) {
    previous.content += step.content;
    return;
  }
  steps.push({ ...step });
}

function finalizeAgentTrace(steps: AgentStep[]): AgentStep[] {
  for (const step of steps) {
    // Deltas are coalesced while the run is live. Once the document is
    // terminal, the retained artifact contains completed text steps rather
    // than an orphaned `in_progress` stream with no future event to close it.
    if (step.delta) delete step.delta;
  }
  return steps;
}

async function runAgentic(
  input: ResolvedInput,
  dataUrl: string,
  options: ResolvedCliOptions,
  signal: AbortSignal,
  onStep: (step: AgentStep) => void,
  runtime: ProviderExecutionContext,
  budgetDeadline: number,
): Promise<OcrArtifacts> {
  const config = providerRuntimeConfig(options, runtime);
  // Measured from the document's own deadline, not restarted here, so the
  // agent stops first and keeps its partial fields (see agentBudgetDeadline).
  const maxDurationMs = Math.max(1, budgetDeadline - Date.now());
  const generator = options.provider === 'gemini' ? agentLoop(
    { name: input.name, type: input.mimeType },
    dataUrl,
    {
      apiKey: options.apiKey || (options.cloudflareByok ? options.gatewayToken || 'cloudflare-byok' : ''),
      model: options.model,
      thinkingConfig: { level: options.thinking, includeThoughts: options.includeThoughts },
      progress: options.progress,
      baseUrl: options.gateway === 'cloudflare' || options.baseUrl !== providerDefaultBaseUrl('gemini')
        ? options.baseUrl
        : undefined,
      headers: options.gateway === 'cloudflare' ? providerRequestHeaders(config) : undefined,
      abortSignal: signal,
      regionCropper: nodeRegionCropper,
      runtime,
    },
    {
      maxIterations: options.maxIterations,
      confidenceThreshold: options.confidenceThreshold,
      maxTokens: options.maxTokens,
      maxDurationMs,
      throwOnFailure: true,
    },
  ) : providerAgentLoop(
    { name: input.name, type: input.mimeType },
    dataUrl,
    config,
    {
      maxIterations: options.maxIterations,
      confidenceThreshold: options.confidenceThreshold,
      maxTokens: options.maxTokens,
      maxDurationMs,
      throwOnFailure: true,
    },
    nodeRegionCropper,
    signal,
  );
  // Live deltas belong to the event stream. Retain a compact, lossless trace
  // only when the caller explicitly requested the `all` artifact set.
  const steps: AgentStep[] | undefined = options.format === 'all' ? [] : undefined;
  let state = await generator.next();
  while (!state.done) {
    if (steps) appendAgentTrace(steps, state.value);
    onStep(state.value);
    state = await generator.next();
  }
  const memory = state.value;
  if (memory.stopReason === 'failed' || memory.stopReason === 'cancelled') {
    throw new Error(`Agentic OCR ${memory.stopReason}`);
  }
  const result = agenticExtractionResult(memory);
  return {
    markdown: agenticResultToMarkdown(result),
    json: result,
    ...(steps ? { agentSteps: finalizeAgentTrace(steps) } : {}),
  };
}

async function extractOnce(
  input: ResolvedInput,
  options: ResolvedCliOptions,
  signal: AbortSignal,
  onStep: (step: AgentStep) => void,
  runtime: ProviderExecutionContext,
  budgetDeadline: number,
): Promise<OcrArtifacts> {
  const { dataUrl } = await readAndValidateInput(input);
  const clientConfig = providerRuntimeConfig(options, runtime);

  if (options.mode === 'template') {
    const result = await extractPresetWithProvider(
      dataUrl,
      input.mimeType,
      input.name,
      clientConfig,
      getExtractionPreset(options.preset!),
      signal,
      { maxTokens: options.maxTokens },
    );
    return {
      markdown: result.markdown,
      json: result.json,
      csv: result.csv,
      ...(result.json.validationErrors?.length ? { validationErrors: [...result.json.validationErrors] } : {}),
      ...(result.json.validationWarnings?.length ? { warnings: [...result.json.validationWarnings] } : {}),
    };
  }
  if (options.mode === 'agentic') {
    return runAgentic(input, dataUrl, options, signal, onStep, runtime, budgetDeadline);
  }

  const instructions: ExtractionInstruction[] = options.instructions.map((prompt) => ({ prompt }));
  if (options.customSchema) {
    const result = await extractStructuredWithProvider(
      dataUrl,
      input.mimeType,
      input.name,
      clientConfig,
      options.customSchema,
      instructions.length > 0 ? instructions : undefined,
      {
        detectImages: options.detectImages,
        detectMathEquations: options.detectMath,
        maxTokens: options.maxTokens,
        abortSignal: signal,
      },
    );
    assertCustomSchemaOutput(options.customSchema, result);
    return { json: result };
  }
  const result = await extractTextWithProvider(
    dataUrl,
    input.mimeType,
    input.name,
    clientConfig,
    instructions.length > 0 ? instructions : undefined,
    {
      outputFormat: options.format === 'json' ? 'json' : 'markdown',
      structuredOutput: options.format === 'json',
      detectImages: options.detectImages,
      detectMathEquations: options.detectMath,
      maxTokens: options.maxTokens,
      abortSignal: signal,
    },
  );
  return { markdown: extractedContentToMarkdown(result), json: result };
}

async function extractWithRetries(
  input: ResolvedInput,
  options: ResolvedCliOptions,
  signal: AbortSignal,
  onStep: (step: AgentStep) => void,
  runtime: ProviderExecutionContext,
  budgetDeadline: number,
): Promise<{ artifacts: OcrArtifacts; attempts: number }> {
  const result = await runWithProviderRetries(
    options,
    signal,
    async (attemptSignal) => {
      try {
        return await extractOnce(input, options, attemptSignal, onStep, runtime, budgetDeadline);
      } catch (error) {
        // A malformed model answer (not JSON, wrong shape, no text) is typed
        // OUTPUT_INVALID by the engine. Typing it here as well lets --retries
        // re-ask the model, exactly as for a --schema mismatch, instead of the
        // retry layer treating it as an unknown provider error.
        if (recordName(error) === 'OcrError' && (error as { type?: unknown }).type === 'OUTPUT_INVALID') {
          throw asCliExitError(error, 1);
        }
        throw error;
      }
    },
    { deadlineMs: budgetDeadline },
  );
  return { artifacts: result.value, attempts: result.attempts };
}

export { modeFingerprint };

function statusLine(index: number, total: number, result: OcrJobResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const icon = result.status === 'succeeded' ? '✓' : result.status === 'partial' ? '~' : result.status === 'skipped' ? '↷' : '✗';
  const destinations = result.outputFiles ?? result.plannedOutputFiles;
  const destination = destinations?.length
    ? ` → ${destinations.join(', ')}`
    : result.skipReason === 'validated' ? ' → stdout' : '';
  const reason = result.skipReason === 'validated'
    ? ' — validated (dry run)'
    : result.skipReason === 'resumed' ? ' — unchanged (resume)' : '';
  const code = result.errorDetails?.code ? ` [${result.errorDetails.code}]` : '';
  const error = result.error ? ` —${code} ${result.error}` : '';
  const partial = result.partialReason
    ? ` — partial: ${result.partialReason}${result.nextAction ? `; next: ${result.nextAction}` : ''}`
    : '';
  const hint = result.errorDetails?.hint ? `\n    hint: ${result.errorDetails.hint}` : '';
  // Warnings quote model output; strip terminal control sequences first.
  const warnings = (result.warnings ?? [])
    .map((warning) => normalizeAgentProgressText(warning))
    .filter((warning): warning is string => warning !== undefined)
    .map((warning) => `\n    warning: ${warning}`)
    .join('');
  return `[${index}/${total}] ${icon} ${result.input.displayPath}${destination} (${seconds}s)${reason}${partial}${error}${hint}${warnings}`;
}

interface BatchRuntime {
  runId?: string;
  abortController: AbortController;
  /**
   * Receives every protocol v2 lifecycle event. `extract --jsonl` supplies a
   * sink that writes each event to stdout, so the direct CLI and `run` speak
   * one dialect; the sink's owner also owns the stream's terminal record.
   */
  eventSink?: OcrJobEventSink;
  /** Warnings raised before the batch (ignored flags, discovery skips). */
  priorWarnings?: readonly string[];
  writeStdout?: (text: string) => void | Promise<void>;
  writeStderr?: (text: string) => void;
}

export function createOcrJobService(): OcrJobService {
  return new OcrJobService({ extractDocument: extractWithRetries });
}

export async function runBatch(
  inputs: ResolvedInput[],
  options: ResolvedCliOptions,
  runtime: BatchRuntime,
): Promise<BatchSummary> {
  const writeStdout = runtime.writeStdout ?? writeProcessStdout;
  const writeStderr = runtime.writeStderr ?? ((text: string) => process.stderr.write(text));
  const service = createOcrJobService();
  const { summary } = await service.run(inputs, options, {
    runId: runtime.runId ?? randomUUID(),
    abortController: runtime.abortController,
    eventSink: runtime.eventSink,
    priorWarnings: runtime.priorWarnings,
    onWarning: (message) => writeStderr(`${message}\n`),
    onAgentStep: (input, step) => {
      if (options.verbose && !options.quiet) {
        writeStderr(`  ${input.displayPath}: ${step.type}: ${agentProgressMessage(step)}\n`);
      }
    },
    onDocumentResult: (index, total, result): void => {
      // --quiet silences progress, never an outcome the caller has to act on:
      // without --jsonl this line is the only report a failure gets.
      const needsAttention = result.status === 'failed' || result.status === 'partial';
      if (!options.quiet || (needsAttention && !options.jsonl)) {
        writeStderr(`${statusLine(index, total, result)}\n`);
      }
    },
  });
  const shouldWriteFiles = inputs.length > 1 || Boolean(options.output) || options.format === 'all';
  if (inputs.length === 1 && !shouldWriteFiles && !options.jsonl && summary.results[0]?.artifacts) {
    await writeStdout(primaryArtifact(summary.results[0].artifacts, options.format));
  }
  return summary;
}
