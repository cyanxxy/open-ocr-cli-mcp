import {
  createAgentSystemPrompt,
  createFollowUpPrompt,
  createUserPrompt,
  executeFunctionCall,
} from '../agentGemini';
import { agentProgressFingerprint, applyMemoryUpdate, createInitialMemory } from '../agentMemory';
import { evaluateAgentCompletion } from '../agentSchema';
import { AGENT_FUNCTIONS } from '../agentTools';
import type {
  AgentDocumentInput,
  AgentLoopConfig,
  AgentMemory,
  AgentStep,
  AgentStopReason,
  RegionCropper,
} from '../agentTypes';
import {
  createChatCompletion,
  documentContentParts,
  isRetryableProviderError,
  type OpenAIMessage,
  type OpenAITool,
} from './openaiCompatible';
import { isProviderCostLimitError } from './requestPolicy';
import { transientRetryDelayMs } from './retry';
import type { ProviderRuntimeConfig } from './types';
import { createAgentDeadline, streamAgentOperation, waitForAbortableAgentDelay } from '../agentStepStream';

const MAX_INNER_ROUNDS = 10;
const MAX_TRANSIENT_RETRIES = 3;

function agentTools(): OpenAITool[] {
  return AGENT_FUNCTIONS.map((declaration) => {
    const value = declaration as unknown as Record<string, unknown>;
    return {
      type: 'function',
      function: {
        name: typeof value.name === 'string' ? value.name : '',
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        parameters: (value.parametersJsonSchema ?? value.parameters ?? { type: 'object' }) as Record<string, unknown>,
      },
    };
  });
}

function terminalLine(reason: AgentStopReason, memory: AgentMemory): string {
  const fields = Object.keys(memory.extractedFields).length;
  const confidence = memory.confidence.toFixed(2);
  if (reason === 'succeeded') return `Extraction complete: ${fields} field(s) at ${confidence} confidence.`;
  if (reason === 'cancelled') return 'Processing cancelled.';
  return `Stopped with ${reason.replaceAll('_', ' ')}: ${fields} field(s) at ${confidence} confidence.`;
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Produce a tool result that lets the model correct malformed arguments.
  }
  return {};
}

async function completionWithRetries(
  config: ProviderRuntimeConfig,
  messages: OpenAIMessage[],
  maxTokens: number,
  onStep: (step: AgentStep) => void,
  stepIdPrefix: string,
  promptCacheKey: string,
  signal?: AbortSignal,
): ReturnType<typeof createChatCompletion> {
  for (let attempt = 0; ; attempt += 1) {
    let emittedDelta = false;
    try {
      return await createChatCompletion(config, {
        messages,
        maxTokens,
        tools: agentTools(),
        toolChoice: 'auto',
        signal,
        ...(config.provider === 'kimi'
          ? { extraBody: { prompt_cache_key: promptCacheKey } }
          : {}),
        ...(config.progress === 'off' ? {} : {
          onDelta: (delta): void => {
            if (delta.kind === 'reasoning' && config.progress !== 'detailed') return;
            emittedDelta = true;
            onStep({
              type: 'thinking',
              source: delta.kind,
              id: `${stepIdPrefix}:${delta.kind}`,
              delta: true,
              content: delta.text,
              timestamp: Date.now(),
            });
          },
        }),
      });
    } catch (error) {
      if (
        emittedDelta
        || signal?.aborted
        || !isRetryableProviderError(error)
        || attempt >= MAX_TRANSIENT_RETRIES
      ) throw error;
      const delay = transientRetryDelayMs(attempt);
      await waitForAbortableAgentDelay(delay, signal);
    }
  }
}

async function executeProviderTurn(
  messages: OpenAIMessage[],
  fileData: string,
  mimeType: string,
  memory: AgentMemory,
  providerConfig: ProviderRuntimeConfig,
  loopConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  regionCropper: RegionCropper,
  iteration: number,
  onStep: (step: AgentStep) => void,
): Promise<{ finished: boolean; steps: AgentStep[] }> {
  const steps: AgentStep[] = [];
  let calledTools = false;
  let nudged = false;

  for (let round = 0; round < MAX_INNER_ROUNDS; round += 1) {
    let streamedDelta = false;
    // Namespace streamed channels by the agent session so concurrent documents
    // cannot publish colliding step IDs into one machine-event stream.
    const stepIdPrefix = `${memory.sessionId}:completion-${iteration}-${round + 1}`;
    const completion = await completionWithRetries(
      providerConfig,
      messages,
      loopConfig.maxTokens,
      (step) => {
        streamedDelta = true;
        onStep(step);
      },
      stepIdPrefix,
      memory.sessionId,
      signal,
    );
    messages.push(completion.message);
    const reasoningText = completion.message.reasoning_content ?? completion.message.reasoning;
    if (providerConfig.progress === 'off' || streamedDelta) {
      // The assistant message is retained losslessly for continuation. Avoid
      // replaying a completed copy when live deltas were already emitted.
    } else {
      if (reasoningText && providerConfig.progress === 'detailed') {
        const reasoningStep: AgentStep = {
          type: 'thinking',
          source: 'reasoning',
          id: `${stepIdPrefix}:reasoning`,
          content: reasoningText,
          timestamp: Date.now(),
        };
        steps.push(reasoningStep);
        onStep(reasoningStep);
      }
      if (completion.text) {
        const outputStep: AgentStep = {
          type: 'thinking',
          source: 'model_output',
          id: `${stepIdPrefix}:model_output`,
          content: completion.text,
          timestamp: Date.now(),
        };
        steps.push(outputStep);
        onStep(outputStep);
      }
    }

    const calls = completion.message.tool_calls ?? [];
    if (calls.length === 0) {
      if (!calledTools && Object.keys(memory.extractedFields).length === 0 && !nudged && round < MAX_INNER_ROUNDS - 1) {
        nudged = true;
        messages.push({
          role: 'user',
          content: 'Begin now by calling analyze_document_structure, then extract_fields_batch. Respond with a tool call.',
        });
        continue;
      }
      return { finished: true, steps };
    }
    calledTools = true;

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const args = parseToolArguments(call.function.arguments);
      const callStep: AgentStep = {
        type: 'function_call',
        source: 'tool_call',
        id: call.id,
        content: index === 0
          ? `Calling ${call.function.name}`
          : `Skipping parallel call ${call.function.name}; tools run sequentially`,
        functionCall: { id: call.id, name: call.function.name, arguments: args },
        timestamp: Date.now(),
      };
      steps.push(callStep);
      onStep(callStep);

      const result = index === 0
        ? await executeFunctionCall(
            { id: call.id, name: call.function.name, arguments: args },
            fileData,
            mimeType,
            memory,
            {
              apiKey: providerConfig.apiKey,
              model: providerConfig.model,
              thinkingConfig: providerConfig.thinkingConfig,
              abortSignal: signal,
              regionCropper,
              regionStructuredExtractor: async (
                croppedDataUrl,
                croppedMimeType,
                responseSchema,
                prompt,
                abortSignal,
              ): Promise<unknown> => {
                const croppedMedia = await documentContentParts(
                  providerConfig,
                  croppedDataUrl,
                  croppedMimeType,
                  'region.png',
                  abortSignal,
                );
                const response = await createChatCompletion(providerConfig, {
                  messages: [{
                    role: 'user',
                    content: [{ type: 'text', text: prompt }, ...croppedMedia],
                  }],
                  maxTokens: 8192,
                  responseSchema,
                  schemaName: 'region_ocr_fields',
                  signal: abortSignal,
                });
                try {
                  return JSON.parse(response.text) as unknown;
                } catch {
                  throw new Error('Region re-OCR returned invalid JSON');
                }
              },
            },
          )
        : { success: false, error: 'Skipped because this runtime executes tools sequentially' };
      if (index === 0) applyMemoryUpdate(memory, result.memoryUpdate);
      const resultStep: AgentStep = {
        type: result.success ? 'result' : 'error',
        source: 'tool_result',
        id: call.id,
        content: result.success ? `${call.function.name} completed` : (result.error ?? `${call.function.name} failed`),
        functionCall: { id: call.id, name: call.function.name, arguments: args },
        functionResult: result,
        timestamp: Date.now(),
      };
      steps.push(resultStep);
      onStep(resultStep);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({
          success: result.success,
          error: result.error ?? null,
          data: result.data ?? null,
        }),
      });
    }
  }
  return { finished: false, steps };
}

export async function* providerAgentLoop(
  file: AgentDocumentInput,
  fileData: string,
  providerConfig: ProviderRuntimeConfig,
  config: AgentLoopConfig,
  regionCropper: RegionCropper,
  signal?: AbortSignal,
): AsyncGenerator<AgentStep, AgentMemory, unknown> {
  const memory = createInitialMemory(
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    file.name,
  );
  const deadline = createAgentDeadline(config.maxDurationMs ?? 120_000, signal);
  signal = deadline.signal;
  let stopReason: AgentStopReason | undefined;
  try {
    try {
      const media = await documentContentParts(
        providerConfig,
        fileData,
        file.type,
        file.name,
        signal,
      );
      const messages: OpenAIMessage[] = [
        { role: 'system', content: createAgentSystemPrompt(memory.documentAnalysis.documentType) },
        {
          role: 'user',
          content: [{ type: 'text', text: createUserPrompt(file.name, 1) }, ...media],
        },
      ];

      for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
        if (signal.aborted) { stopReason = deadline.hasExpired() ? 'budget_exhausted' : 'cancelled'; break; }
        if (deadline.hasExpired()) { stopReason = 'budget_exhausted'; break; }
        memory.currentIteration = iteration;
        if (iteration > 1) messages.push({ role: 'user', content: createFollowUpPrompt(iteration, memory) });
        messages[0] = {
          role: 'system',
          content: createAgentSystemPrompt(memory.documentAnalysis.documentType),
        };
        try {
          const before = agentProgressFingerprint(memory);
          const streamedTurn = streamAgentOperation((onStep) => executeProviderTurn(
            messages,
            fileData,
            file.type,
            memory,
            providerConfig,
            config,
            signal,
            regionCropper,
            iteration,
            onStep,
          ));
          let streamed = await streamedTurn.next();
          while (!streamed.done) {
            yield streamed.value;
            streamed = await streamedTurn.next();
          }
          const turn = streamed.value;
          if (deadline.hasExpired()) { stopReason = 'budget_exhausted'; break; }
          const completion = evaluateAgentCompletion(memory, memory.confidence, config.confidenceThreshold);
          if (completion.complete) { stopReason = 'succeeded'; break; }
          if (!turn.finished) { stopReason = 'tool_limit_reached'; break; }
          if (agentProgressFingerprint(memory) === before) { stopReason = 'partial'; break; }
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            stopReason = deadline.hasExpired() ? 'budget_exhausted' : 'cancelled';
            break;
          }
          if (isProviderCostLimitError(error)) { stopReason = 'cost_limit_reached'; break; }
          const message = error instanceof Error ? error.message : String(error);
          yield {
            type: 'error',
            source: 'runtime',
            content: `Agent iteration failed: ${message}`,
            timestamp: Date.now(),
          };
          if (config.throwOnFailure) throw error;
          stopReason = 'failed';
          break;
        }
      }
    } catch (error) {
      if (deadline.hasExpired()) stopReason = 'budget_exhausted';
      else if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) stopReason = 'cancelled';
      else throw error;
    }
    stopReason ??= evaluateAgentCompletion(memory, memory.confidence, config.confidenceThreshold).complete
      ? 'succeeded'
      : 'max_iterations';
    memory.stopReason = stopReason;
    if (stopReason !== 'cancelled') {
      yield {
        type: 'result',
        source: 'runtime',
        content: terminalLine(stopReason, memory),
        timestamp: Date.now(),
      };
    }
    return memory;
  } finally {
    deadline.dispose();
  }
}
