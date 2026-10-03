import type { Content, FunctionDeclaration, Interactions } from '@google/genai';
import { getGenAIClient, normalizeThinkingLevel } from './client';
import type { GeminiModel, ThinkingConfig } from './types';
import {
  recordGeminiInteractionStepUsages,
  recordGeminiInteractionUsage,
} from './usage';
import { waitForGeminiRequestSlot } from './requestPolicy';
import { withReadableProviderErrors } from './errorPayload';

type InteractionToolChoice = 'auto' | 'any' | 'none' | 'validated';

/**
 * Media / text blocks accepted by the shared Gemini transport. The OCR CLI's
 * public input contract is intentionally narrower: images and PDFs only.
 */
export type InteractionMediaContent =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'audio' | 'video' | 'document';
      data: string;
      mime_type?: string;
      resolution?: 'low' | 'medium' | 'high' | 'ultra_high';
    };

export type InteractionUserInputStep = {
  type: 'user_input';
  content: InteractionMediaContent[];
};

export type InteractionThoughtStep = {
  type: 'thought';
  signature?: string;
  summary?: Array<{ type?: string; text?: string }>;
};

export type InteractionFunctionCallStep = {
  type: 'function_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type InteractionFunctionResultStep = {
  type: 'function_result';
  call_id: string;
  name: string;
  result: InteractionMediaContent[] | Record<string, unknown> | string;
  is_error?: boolean;
};

export type InteractionModelOutputStep = {
  type: 'model_output';
  content: Array<{ type: 'text'; text: string }>;
  error?: {
    code?: number;
    message?: string;
    details?: unknown[];
  };
};

export type InteractionUrlContextResultStep = {
  type: 'url_context_result';
  call_id?: string;
  is_error?: boolean;
  result?: Array<{
    status?: string;
    url?: string;
  }>;
  signature?: string;
};

/** A single step in a post–May 2026 Interactions transcript. */
export type InteractionStep =
  | InteractionUserInputStep
  | InteractionThoughtStep
  | InteractionFunctionCallStep
  | InteractionFunctionResultStep
  | InteractionModelOutputStep
  | InteractionUrlContextResultStep
  | { type: string; [key: string]: unknown };

export interface InteractionResult {
  id: string;
  status?: string;
  steps?: InteractionStep[];
  output_text?: string | null;
  streamedProgressKinds?: Array<'thought_summary' | 'model_output'>;
}

export interface InteractionProgressDelta {
  kind: 'thought_summary' | 'model_output';
  text: string;
  stepId: string;
}

export interface UrlContextResultSummary {
  hasToolError: boolean;
  results: Array<{
    status?: string;
    url?: string;
  }>;
}

interface InteractionRequest {
  apiKey: string;
  model: GeminiModel;
  baseUrl?: string;
  headers?: Record<string, string>;
  input: string | InteractionMediaContent[] | InteractionStep[];
  systemInstruction?: string;
  previousInteractionId?: string;
  tools?: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  /** JSON Schema for structured text output (Interactions polymorphic response_format). */
  responseSchema?: Record<string, unknown>;
  responseMimeType?: 'application/json' | 'text/plain';
  abortSignal?: AbortSignal;
  store?: boolean;
  runtime?: import('../providers/runtime').ProviderExecutionContext;
  onProgress?: (delta: InteractionProgressDelta) => void;
}

let nextInteractionStreamSequence = 1;

/**
 * Pick Interactions media resolution for OCR quality.
 * Images: high (fine text). PDFs: medium (docs say quality saturates).
 */
export function mediaResolutionForMime(
  mimeType: string,
): 'low' | 'medium' | 'high' {
  if (mimeType === 'application/pdf' || mimeType.startsWith('application/')) {
    return 'medium';
  }
  return 'high';
}

export function createInteractionGenerationConfig(
  config: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    toolChoice?: InteractionToolChoice;
  },
  model: GeminiModel,
  thinkingConfig?: ThinkingConfig,
): Record<string, unknown> {
  // Gemini 3.x docs recommend leaving temperature/top_p/top_k at defaults.
  // Only set temperature when callers intentionally override; omit top_p.
  const generationConfig: Record<string, unknown> = {
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.maxOutputTokens !== undefined ? { max_output_tokens: config.maxOutputTokens } : {}),
    ...(config.toolChoice ? { tool_choice: config.toolChoice } : {}),
  };

  generationConfig.thinking_level = normalizeThinkingLevel(thinkingConfig?.level, model);
  generationConfig.thinking_summaries = thinkingConfig?.includeThoughts ? 'auto' : 'none';

  return generationConfig;
}

export function createInteractionFunctionTools(
  functions: FunctionDeclaration[],
): Array<Record<string, unknown>> {
  return functions
    .filter((fn): fn is FunctionDeclaration & { name: string } => typeof fn.name === 'string' && fn.name.length > 0)
    .map((fn) => ({
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parametersJsonSchema !== undefined
        ? { parameters: fn.parametersJsonSchema }
        : fn.parameters !== undefined
          ? { parameters: fn.parameters }
          : {}),
    }));
}

export function contentToInteractionInput(
  content: Pick<Content, 'parts'>,
): InteractionMediaContent[] {
  const input: InteractionMediaContent[] = [];

  for (const part of content.parts ?? []) {
    if ('text' in part && typeof part.text === 'string' && part.text.trim().length > 0) {
      input.push({
        type: 'text',
        text: part.text,
      });
    }

    if ('inlineData' in part && part.inlineData && typeof part.inlineData.data === 'string') {
      const mimeType = part.inlineData.mimeType || 'application/octet-stream';
      const baseInput = {
        data: part.inlineData.data,
        mime_type: mimeType,
      };

      if (mimeType.startsWith('image/')) {
        input.push({
          type: 'image',
          ...baseInput,
          resolution: mediaResolutionForMime(mimeType),
        });
      } else if (mimeType.startsWith('audio/')) {
        input.push({
          type: 'audio',
          ...baseInput,
        });
      } else if (mimeType.startsWith('video/')) {
        input.push({
          type: 'video',
          ...baseInput,
        });
      } else {
        input.push({
          type: 'document',
          ...baseInput,
        });
      }
    }
  }

  return input;
}

export function createUserInputStep(content: InteractionMediaContent[]): InteractionUserInputStep {
  return { type: 'user_input', content };
}

/**
 * Canonical correlation id for a model function call. Used by BOTH
 * model-step replay and extractInteractionFunctionCalls so the id on the
 * model step always matches the id on the function_result we send back.
 */
export function interactionCallId(
  step: { id?: string },
): string {
  if (typeof step.id !== 'string' || !step.id) {
    throw new Error('Gemini interaction returned a function call without an ID');
  }
  return step.id;
}

function toArgsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Gemini interaction returned non-object function-call arguments');
  }
  return value as Record<string, unknown>;
}

/** Read the current post-May 2026 Interactions `steps` transcript. */
export function getInteractionSteps(interaction: InteractionResult | null | undefined): InteractionStep[] {
  return Array.isArray(interaction?.steps) ? interaction.steps : [];
}

/**
 * Return model-generated steps exactly as the API produced them.
 *
 * Gemini requires every model-generated step — including ALL parallel
 * function_call steps and thought signatures — to be echoed back verbatim in
 * stateless mode. Stateful callers also use this helper for a faithful local
 * audit transcript. Do not normalize, clone, or drop unknown fields/step types:
 * signatures and forward-compatible server metadata must survive unchanged.
 */
export function selectModelStepsForReplay(steps?: InteractionStep[]): InteractionStep[] {
  if (!steps || steps.length === 0) {
    return [];
  }
  return steps.filter(
    (step): step is InteractionStep =>
      typeof step === 'object'
      && step !== null
      && typeof step.type === 'string',
  );
}

export function extractInteractionText(
  steps?: InteractionStep[],
  fallbackOutputText?: string | null,
): string {
  if (steps && steps.length > 0) {
    const parts: string[] = [];
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      if (step.type === 'model_output') {
        const mo = step as InteractionModelOutputStep;
        for (const block of mo.content || []) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            parts.push(block.text.trim());
          }
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('\n').trim();
    }
  }

  return typeof fallbackOutputText === 'string' ? fallbackOutputText.trim() : '';
}

/** Surface model-output errors that may accompany an otherwise terminal interaction. */
export function extractInteractionModelErrors(steps?: InteractionStep[]): string[] {
  if (!steps) return [];
  return steps.flatMap((step) => {
    if (step?.type !== 'model_output') return [];
    const error = (step as InteractionModelOutputStep).error;
    if (!error) return [];
    if (typeof error.message === 'string' && error.message.trim()) return [error.message.trim()];
    if (typeof error.code === 'number') return [`model output error ${error.code}`];
    return ['unknown model output error'];
  });
}

export function extractInteractionThoughtSummaries(steps?: InteractionStep[]): string[] {
  if (!steps) {
    return [];
  }

  return steps
    .filter((step): step is InteractionThoughtStep => step?.type === 'thought' && Array.isArray((step as InteractionThoughtStep).summary))
    .map((step) =>
      (step.summary || [])
        .map((part) => (typeof part.text === 'string' ? part.text.trim() : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
    )
    .filter(Boolean);
}

export function extractInteractionFunctionCalls(steps?: InteractionStep[]): Array<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  if (!steps) {
    return [];
  }

  const calls = steps.flatMap((step) => {
    if (step?.type !== 'function_call') {
      return [];
    }
    const fc = step as InteractionFunctionCallStep & { name?: string; arguments?: unknown };
    if (typeof fc.name !== 'string' || fc.name.length === 0) {
      throw new Error('Gemini interaction returned a function call without a name');
    }

    return [{
      id: interactionCallId(fc),
      name: fc.name,
      arguments: toArgsObject(fc.arguments),
    }];
  });
  const seenIds = new Set<string>();
  for (const call of calls) {
    if (seenIds.has(call.id)) {
      throw new Error(`Gemini interaction returned duplicate function-call ID ${call.id}`);
    }
    seenIds.add(call.id);
  }
  return calls;
}

export function summarizeUrlContextResults(steps?: InteractionStep[]): UrlContextResultSummary {
  if (!steps) {
    return { hasToolError: false, results: [] };
  }

  return steps.reduce<UrlContextResultSummary>((summary, step) => {
    if (step?.type !== 'url_context_result') {
      return summary;
    }

    const urlStep = step as InteractionUrlContextResultStep;
    if (urlStep.is_error) {
      summary.hasToolError = true;
    }

    if (Array.isArray(urlStep.result)) {
      summary.results.push(
        ...urlStep.result
          .filter((entry) => typeof entry === 'object' && entry !== null)
          .map((entry) => ({
            status: entry.status,
            url: entry.url,
          })),
      );
    }

    return summary;
  }, { hasToolError: false, results: [] });
}

function buildResponseFormat(
  responseSchema?: Record<string, unknown>,
  responseMimeType?: 'application/json' | 'text/plain',
): Record<string, unknown> | undefined {
  if (!responseSchema && !responseMimeType) {
    return undefined;
  }

  return {
    type: 'text',
    ...(responseMimeType ? { mime_type: responseMimeType } : {}),
    ...(responseSchema ? { schema: responseSchema } : {}),
  };
}

export async function runModelInteraction({
  apiKey,
  model,
  baseUrl,
  headers,
  input,
  systemInstruction,
  previousInteractionId,
  tools,
  generationConfig,
  responseSchema,
  responseMimeType,
  abortSignal,
  store,
  runtime,
  onProgress,
}: InteractionRequest): Promise<InteractionResult> {
  const genAI = getGenAIClient(apiKey, { baseUrl, headers });
  const responseFormat = buildResponseFormat(responseSchema, responseMimeType);
  const common = {
    model,
    input: input as Interactions.CreateModelInteractionParamsNonStreaming['input'],
    ...(store !== undefined ? { store } : {}),
    ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    ...(tools && tools.length > 0 ? { tools: tools as Interactions.Tool[] } : {}),
    ...(generationConfig
      ? { generation_config: generationConfig as Interactions.GenerationConfig }
      : {}),
    ...(responseFormat
      ? {
          response_format: responseFormat as Interactions.CreateModelInteractionParamsNonStreaming['response_format'],
        }
      : {}),
  };

  await waitForGeminiRequestSlot(abortSignal, runtime);
  if (!onProgress) {
    const params: Interactions.CreateModelInteractionParamsNonStreaming = {
      ...common,
      stream: false,
    };
    const interaction = await withReadableProviderErrors(() => genAI.interactions.create(
      params,
      abortSignal ? { fetchOptions: { signal: abortSignal } } : undefined,
    )) as Interactions.Interaction;
    recordGeminiInteractionUsage(
      interaction,
      model,
      runtime,
    );
    return {
      id: interaction.id,
      status: interaction.status,
      steps: interaction.steps as InteractionStep[] | undefined,
      output_text: interaction.output_text,
    };
  }

  const params: Interactions.CreateModelInteractionParamsStreaming = {
    ...common,
    stream: true,
  };
  const stream = await withReadableProviderErrors(() => genAI.interactions.create(
    params,
    abortSignal ? { fetchOptions: { signal: abortSignal } } : undefined,
  )) as AsyncIterable<Interactions.InteractionSSEEvent>;
  const steps = new Map<number, InteractionStep>();
  const argumentDeltas = new Map<number, string>();
  const streamedKinds = new Set<'thought_summary' | 'model_output'>();
  let interactionId = '';
  let status: string | undefined;
  let outputText = '';
  let completedOutputText: string | undefined;
  let completedSteps: InteractionStep[] | undefined;
  let receivedCompletion = false;
  let usagePayload: unknown;
  let latestInteractionUsage: unknown;
  const stepUsages: unknown[] = [];
  const progressStepIds = new Map<number, string>();
  const localStreamId = `interaction-stream-${nextInteractionStreamSequence++}`;

  const progressStepId = (index: number): string => {
    const existing = progressStepIds.get(index);
    if (existing) return existing;
    // interaction.created normally precedes deltas. Keep a local per-stream
    // fallback so an out-of-order gateway cannot change a channel's ID midway.
    const created = `${interactionId || localStreamId}:${index}`;
    progressStepIds.set(index, created);
    return created;
  };

  const appendModelText = (index: number, text: string): void => {
    const step = steps.get(index);
    if (!step || step.type !== 'model_output') return;
    const modelOutput = step as InteractionModelOutputStep;
    const last = modelOutput.content.at(-1);
    if (last?.type === 'text') last.text += text;
    else modelOutput.content.push({ type: 'text', text });
    outputText += text;
  };
  const appendThoughtSummary = (index: number, content: unknown): string => {
    const step = steps.get(index);
    if (!step || step.type !== 'thought' || typeof content !== 'object' || content === null) return '';
    const text = 'text' in content && typeof content.text === 'string' ? content.text : '';
    if (!text) return '';
    const thought = step as InteractionThoughtStep;
    thought.summary ??= [];
    const last = thought.summary.at(-1);
    if (last && typeof last.text === 'string') last.text += text;
    else thought.summary.push({ type: 'text', text });
    return text;
  };

  try {
    for await (const event of stream) {
      if ('metadata' in event && event.metadata?.total_usage) {
        latestInteractionUsage = event.metadata.total_usage;
      }
      if (event.event_type === 'step.stop') {
        if (event.usage) latestInteractionUsage = event.usage;
        else if (event.step_usage) stepUsages.push({ usage: event.step_usage });
      }
      if (event.event_type === 'interaction.created') {
        interactionId = event.interaction.id;
        status = event.interaction.status;
        continue;
      }
      if (event.event_type === 'interaction.status_update') {
        interactionId ||= event.interaction_id;
        status = event.status;
        continue;
      }
      if (event.event_type === 'interaction.completed') {
        receivedCompletion = true;
        interactionId = event.interaction.id;
        status = event.interaction.status;
        if (event.interaction.usage) usagePayload = event.interaction;
        const terminalOutputText = (event.interaction as { output_text?: unknown }).output_text;
        if (typeof terminalOutputText === 'string') {
          completedOutputText = terminalOutputText;
        }
        if (Array.isArray(event.interaction.steps)) {
          completedSteps = event.interaction.steps;
        }
        continue;
      }
      if (event.event_type === 'error') {
        const message = event.error?.message ?? event.error?.code ?? 'Gemini interaction stream failed';
        const error = new Error(message);
        if (event.error?.code) Object.assign(error, { code: event.error.code });
        throw error;
      }
      if (event.event_type === 'step.start') {
        const step = structuredClone(event.step) as InteractionStep;
        if (step.type === 'model_output') {
          (step as InteractionModelOutputStep).content ??= [];
        } else if (step.type === 'thought') {
          (step as InteractionThoughtStep).summary ??= [];
        }
        steps.set(event.index, step);
        continue;
      }
      if (event.event_type === 'step.delta') {
        const delta = event.delta;
        if (delta.type === 'text' && delta.text) {
          appendModelText(event.index, delta.text);
          streamedKinds.add('model_output');
          onProgress({
            kind: 'model_output',
            text: delta.text,
            stepId: progressStepId(event.index),
          });
        } else if (delta.type === 'thought_summary') {
          const text = appendThoughtSummary(event.index, delta.content);
          if (text) {
            streamedKinds.add('thought_summary');
            onProgress({
              kind: 'thought_summary',
              text,
              stepId: progressStepId(event.index),
            });
          }
        } else if (delta.type === 'thought_signature') {
          const step = steps.get(event.index);
          if (step?.type === 'thought' && delta.signature) {
            (step as InteractionThoughtStep).signature = delta.signature;
          }
        } else if (delta.type === 'arguments_delta' && delta.arguments) {
          argumentDeltas.set(event.index, (argumentDeltas.get(event.index) ?? '') + delta.arguments);
        }
        continue;
      }
      if (event.event_type === 'step.stop') {
        const argumentsText = argumentDeltas.get(event.index);
        const step = steps.get(event.index);
        if (argumentsText && step?.type === 'function_call') {
          try {
            const parsed = JSON.parse(argumentsText) as unknown;
            (step as InteractionFunctionCallStep).arguments = toArgsObject(parsed);
          } catch (error) {
            throw new Error(
              `Gemini interaction streamed invalid function-call arguments: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          }
        }
      }
    }
  } catch (error) {
    // A provider can bill and report usage before a terminal stream error or
    // transport failure. Preserve that accounting even though no OCR result is
    // accepted from the incomplete interaction.
    if (usagePayload) {
      recordGeminiInteractionUsage(usagePayload, model, runtime);
    } else if (latestInteractionUsage) {
      recordGeminiInteractionUsage(
        { usage: latestInteractionUsage },
        model,
        runtime,
      );
    } else if (stepUsages.length > 0) {
      recordGeminiInteractionStepUsages(
        stepUsages,
        model,
        runtime,
      );
    }
    throw error;
  }

  if (usagePayload) {
    recordGeminiInteractionUsage(usagePayload, model, runtime);
  } else if (latestInteractionUsage) {
    recordGeminiInteractionUsage(
      { usage: latestInteractionUsage },
      model,
      runtime,
    );
  } else if (stepUsages.length > 0) {
    recordGeminiInteractionStepUsages(
      stepUsages,
      model,
      runtime,
    );
  }
  if (!receivedCompletion) {
    throw new Error('Gemini interaction stream ended without a terminal interaction.completed event');
  }
  if (!interactionId) throw new Error('Gemini interaction stream returned no interaction ID');
  const finalSteps = completedSteps
    ?? [...steps.entries()].sort(([left], [right]) => left - right).map(([, step]) => step);
  return {
    id: interactionId,
    status,
    steps: finalSteps,
    output_text: completedOutputText || outputText || extractInteractionText(finalSteps) || null,
    streamedProgressKinds: [...streamedKinds],
  };
}
