import type { ReadableStream } from 'node:stream/web';
import { isKimiK3Route, knownModelThinkingLevels, providerDefaultThinkingLevel, providerRequestHeaders } from './registry';
import { waitForProviderRequestSlot } from './requestPolicy';
import type { ProviderRuntimeConfig } from './types';
import { recordProviderUsage } from './usage';

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface OpenAIFilePart {
  type: 'file';
  file: { filename: string; file_data: string };
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | OpenAIFilePart;

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning?: string;
  reasoning_content?: string;
  reasoning_details?: unknown[];
  /** Unknown provider fields preserved for lossless assistant-message replay. */
  providerFields?: Record<string, unknown>;
  /** Complete assistant wire message, replayed unchanged during tool use. */
  providerMessage?: Record<string, unknown>;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionRequest {
  messages: OpenAIMessage[];
  maxTokens: number;
  responseSchema?: Record<string, unknown>;
  schemaName?: string;
  tools?: OpenAITool[];
  toolChoice?: 'auto' | 'required' | 'none';
  signal?: AbortSignal;
  extraBody?: Record<string, unknown>;
  onDelta?: (delta: ChatCompletionDelta) => void;
}

export interface ChatCompletionDelta {
  kind: 'reasoning' | 'model_output';
  text: string;
}

export interface ChatCompletionResult {
  text: string;
  message: OpenAIMessage;
  finishReason?: string;
  raw: Record<string, unknown>;
}

export class ProviderApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function requestHeaders(config: ProviderRuntimeConfig, json = true): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...providerRequestHeaders(config),
  };
  if (json) headers['Content-Type'] = 'application/json';
  if (config.apiKey && !config.cloudflareByok) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function responseError(response: Response): Promise<ProviderApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return providerErrorFromRecord(
    error,
    `Provider request failed with HTTP ${response.status}`,
    response.status,
  );
}

function providerErrorFromRecord(
  error: Record<string, unknown> | undefined,
  fallbackMessage: string,
  fallbackStatus?: number,
): ProviderApiError {
  const metadata = isRecord(error?.metadata) ? error.metadata : undefined;
  const numericCode = typeof error?.code === 'number'
    ? error.code
    : typeof error?.code === 'string' && /^\d{3}$/u.test(error.code)
      ? Number(error.code)
      : undefined;
  const status = typeof error?.status === 'number'
    ? error.status
    : numericCode ?? fallbackStatus;
  const message = typeof error?.message === 'string'
    ? error.message
    : fallbackMessage;
  const code = typeof error?.code === 'string' && !/^\d{3}$/u.test(error.code)
    ? error.code
    : typeof error?.type === 'string'
      ? error.type
      : typeof metadata?.error_type === 'string' ? metadata.error_type : undefined;
  return new ProviderApiError(message, status, code);
}

function nestedSystemErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (!isRecord(current)) break;
    if (typeof current.code === 'string') return current.code.toUpperCase();
    current = current.cause;
  }
  return undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = nestedSystemErrorCode(error);
  if (code && [
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(code)) {
    return true;
  }
  if (!(error instanceof TypeError)) return false;
  return /\b(?:fetch|network(?: request)?) failed\b|\bfailed to fetch\b|\bnetworkerror\b|\bsocket (?:closed|hang up)\b/iu
    .test(error.message);
}

export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof ProviderApiError) {
    const code = error.code?.toUpperCase();
    if (code === 'EXCEEDED_CURRENT_QUOTA_ERROR') return false;
    return error.status === 408
      || error.status === 409
      || error.status === 429
      || Boolean(error.status && error.status >= 500)
      || code === 'RESOURCE_EXHAUSTED'
      || code === 'RATE_LIMITED'
      || code === 'RATE_LIMIT_EXCEEDED'
      || code === 'ENGINE_OVERLOADED_ERROR'
      || code === 'RATE_LIMIT_REACHED_ERROR'
      || code === 'PROVIDER_OVERLOADED'
      || code === 'DEADLINE_EXCEEDED'
      || code === 'TIMEOUT'
      || code === 'UNAVAILABLE'
      || code === 'PROVIDER_UNAVAILABLE'
      || code === 'INTERNAL'
      || code === 'SERVER_ERROR'
      || code === 'SERVER'
      || code === 'SERVER_UNAVAILABLE'
      || code === 'UNEXPECTED_OUTPUT'
      || code === 'CLIENT_CLOSED_REQUEST'
      || code === 'UNMAPPED';
  }
  return isRetryableNetworkError(error);
}

function reasoningBody(config: ProviderRuntimeConfig): Record<string, unknown> {
  const level = config.thinkingConfig?.level ?? providerDefaultThinkingLevel(config.provider, config.model);
  const allowed = knownModelThinkingLevels(config.provider, config.model);
  if (allowed && !allowed.includes(level) && !isKimiK3Route(config.provider, config.model)) {
    throw new ProviderApiError(`${config.model} supports reasoning effort ${allowed.map((entry) => entry.toLowerCase()).join(', ')}; received ${level.toLowerCase()}`);
  }
  const kimiK3Effort = (): 'low' | 'high' | 'max' => {
    if (level === 'MINIMAL' || level === 'LOW') return 'low';
    if (level === 'HIGH') return 'high';
    if (level === 'MAX') return 'max';
    throw new ProviderApiError(
      `Kimi K3 reasoning effort must be low, high, or max; received ${level.toLowerCase()}`,
    );
  };
  if (config.provider === 'kimi') {
    if (/^kimi-k3(?:$|-)/u.test(config.model)) {
      return { reasoning_effort: kimiK3Effort() };
    }
    if (/^kimi-k2\.7-code/u.test(config.model)) {
      return { thinking: { type: 'enabled', keep: 'all' } };
    }
    return level === 'MINIMAL'
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled', keep: 'all' } };
  }
  if (config.provider === 'openrouter') {
    const routedModel = config.model.split(':')[0];
    if (/^moonshotai\/kimi-k2\.7-code/u.test(routedModel) || routedModel === 'moonshotai/kimi-k2.6') {
      // These K2 routes expose a reasoning toggle, not an effort budget. K2.7
      // always reasons; K2.6 minimal maps to its instant mode explicitly.
      return { reasoning: { enabled: level !== 'MINIMAL', exclude: false } };
    }
    return {
      // OpenRouter requires reasoning_details to be replayed unchanged during
      // tool use. Visibility is handled by progress policy, never transport.
      reasoning: {
        effort: isKimiK3Route(config.provider, config.model)
          ? kimiK3Effort()
          : level.toLowerCase(),
        exclude: false,
      },
    };
  }
  if (config.provider === 'muse') {
    return { reasoning_effort: level.toLowerCase() };
  }
  return {};
}

function isOpenAIStrictSchema(schema: Record<string, unknown>): boolean {
  const visit = (value: unknown, seen: Set<object>): boolean => {
    if (Array.isArray(value)) return value.every((entry) => visit(entry, seen));
    if (!isRecord(value)) return true;
    if (seen.has(value)) return true;
    seen.add(value);
    if ('$ref' in value) return false;

    const properties = isRecord(value.properties) ? value.properties : undefined;
    if (value.type === 'object' || properties) {
      if (!properties || value.additionalProperties !== false) return false;
      const required = Array.isArray(value.required)
        ? new Set(value.required.filter((entry): entry is string => typeof entry === 'string'))
        : new Set<string>();
      if (Object.keys(properties).some((key) => !required.has(key))) return false;
      if (!Object.values(properties).every((property) => visit(property, seen))) return false;
    }

    for (const key of ['items', 'not', 'if', 'then', 'else', 'additionalProperties']) {
      if (isRecord(value[key]) && !visit(value[key], seen)) return false;
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (Array.isArray(value[key]) && !visit(value[key], seen)) return false;
    }
    if (isRecord(value.$defs) && !Object.values(value.$defs).every((entry) => visit(entry, seen))) {
      return false;
    }
    return true;
  };
  return visit(schema, new Set<object>());
}

/**
 * Kimi's MFJS dialect permits optional properties in strict mode. Other named
 * compatible routes receive `strict: true` only when the supplied schema meets
 * the narrower all-properties-required dialect. Generic endpoints get no
 * unverified strict-mode claim; every returned value is still validated locally.
 */
function strictSchemaSupport(
  config: ProviderRuntimeConfig,
  schema: Record<string, unknown>,
): true | undefined {
  if (config.provider === 'kimi') return true;
  if (config.provider === 'openai-compatible') return undefined;
  return isOpenAIStrictSchema(schema) ? true : undefined;
}

function compatibleTools(config: ProviderRuntimeConfig, tools: OpenAITool[]): OpenAITool[] {
  return tools.map((tool) => {
    const strict = strictSchemaSupport(config, tool.function.parameters);
    return {
      ...tool,
      function: {
        ...tool.function,
        ...(strict !== undefined ? { strict } : {}),
      },
    };
  });
}

function parseContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!isRecord(part)) return '';
    if (typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

function providerMessageFields(message: Record<string, unknown>): Record<string, unknown> | undefined {
  const known = new Set([
    'role', 'content', 'name', 'tool_call_id', 'tool_calls',
    'reasoning', 'reasoning_content', 'reasoning_details',
  ]);
  const fields = Object.fromEntries(
    Object.entries(message).filter(([key]) => !known.has(key)),
  );
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function parseToolCalls(value: unknown): OpenAIToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: OpenAIToolCall[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) throw new ProviderApiError('Provider returned a malformed tool call');
    const functionValue = isRecord(entry.function) ? entry.function : {};
    if (typeof entry.id !== 'string' || !entry.id) {
      throw new ProviderApiError('Provider returned a tool call without an ID');
    }
    if (seenIds.has(entry.id)) {
      throw new ProviderApiError(`Provider returned duplicate tool-call ID ${entry.id}`);
    }
    seenIds.add(entry.id);
    if (typeof functionValue.name !== 'string' || !functionValue.name) {
      throw new ProviderApiError('Provider returned a tool call without a function name');
    }
    if (typeof functionValue.arguments !== 'string') {
      throw new ProviderApiError('Provider returned non-string tool-call arguments');
    }
    calls.push({
      id: entry.id,
      type: 'function',
      function: {
        name: functionValue.name,
        arguments: functionValue.arguments,
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function parseAssistantMessage(rawMessage: Record<string, unknown>): OpenAIMessage {
  const text = parseContent(rawMessage.content);
  const toolCalls = parseToolCalls(rawMessage.tool_calls);
  const providerFields = providerMessageFields(rawMessage);
  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(typeof rawMessage.reasoning_content === 'string'
      ? { reasoning_content: rawMessage.reasoning_content }
      : {}),
    ...(typeof rawMessage.reasoning === 'string' ? { reasoning: rawMessage.reasoning } : {}),
    ...(Array.isArray(rawMessage.reasoning_details)
      ? { reasoning_details: rawMessage.reasoning_details }
      : {}),
    ...(providerFields ? { providerFields } : {}),
    providerMessage: rawMessage,
  };
}

function messageForWire(message: OpenAIMessage): Record<string, unknown> {
  if (message.role === 'assistant' && message.providerMessage) return message.providerMessage;
  return {
    ...(message.providerFields ?? {}),
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
    ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.reasoning_details !== undefined ? { reasoning_details: message.reasoning_details } : {}),
  };
}

function completionRequestBody(
  config: ProviderRuntimeConfig,
  request: ChatCompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  const strict = request.responseSchema
    ? strictSchemaSupport(config, request.responseSchema)
    : undefined;
  const routeRequirements = Boolean(request.responseSchema || request.tools?.length);
  const extraBody = { ...(request.extraBody ?? {}) };
  if (config.provider === 'openrouter' && routeRequirements) {
    const existingProvider = isRecord(extraBody.provider) ? extraBody.provider : {};
    extraBody.provider = { ...existingProvider, require_parameters: true };
  }
  return {
    ...extraBody,
    model: config.model,
    messages: request.messages.map(messageForWire),
    // Both named routes have deprecated `max_tokens` in favour of the OpenAI
    // spelling: Kimi's Chat API across every model family, and OpenRouter's
    // reference, which now documents `max_tokens` as "deprecated, use
    // max_completion_tokens". A generic compatible endpoint keeps `max_tokens`,
    // because a local server built against the older spec is the common case and
    // an unrecognised field there would silently drop the output cap.
    ...(config.provider === 'kimi' || config.provider === 'openrouter'
      ? { max_completion_tokens: request.maxTokens }
      : { max_tokens: request.maxTokens }),
    stream,
    // Kimi still requires this flag for terminal usage. OpenRouter now returns
    // usage automatically and explicitly deprecates the old include_usage
    // options; generic endpoints must not receive an assumed extension.
    ...(stream && (config.provider === 'kimi' || config.provider === 'muse')
      ? { stream_options: { include_usage: true } }
      : {}),
    ...reasoningBody(config),
    ...(request.responseSchema ? {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName ?? 'ocr_result',
          ...(strict !== undefined ? { strict } : {}),
          schema: request.responseSchema,
        },
      },
    } : {}),
    ...(request.tools?.length ? {
      tools: compatibleTools(config, request.tools),
      tool_choice: request.toolChoice ?? 'auto',
      // Prefer sequential tool execution; the agent runtime still handles
      // parallel batches safely, but disables them when the provider honors this.
      parallel_tool_calls: false,
    } : {}),
  };
}

function assertFinishReason(finishReason: string | undefined): void {
  if (finishReason === undefined) {
    throw new ProviderApiError('Provider response omitted its terminal finish reason');
  }
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new ProviderApiError('Provider response reached the output token limit and is incomplete');
  }
  if (finishReason === 'content_filter') {
    throw new ProviderApiError('Provider response was blocked by a content filter');
  }
  if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
    throw new ProviderApiError(`Provider response ended with finish reason ${finishReason}`);
  }
}

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

async function streamedChatCompletion(
  response: Response,
  config: ProviderRuntimeConfig,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  if (!response.body) throw new ProviderApiError('Provider returned an empty streaming response');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let reasoningContent = '';
  const reasoningDetails: unknown[] = [];
  const toolCalls = new Map<number, StreamedToolCall>();
  let finishReason: string | undefined;
  let usage: unknown;
  let lastChunk: Record<string, unknown> = {};
  let receivedDone = false;
  const annotations: unknown[] = [];
  let eventDataLines: string[] = [];

  const consume = (data: string): void => {
    if (!data) return;
    if (data === '[DONE]') {
      receivedDone = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      throw new ProviderApiError(
        `Provider returned invalid streaming JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(parsed)) return;
    lastChunk = parsed;
    if (parsed.usage !== undefined) usage = parsed.usage;
    if (isRecord(parsed.error)) {
      throw providerErrorFromRecord(parsed.error, 'Provider reported a streaming error');
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices.find(isRecord) : undefined;
    if (!choice) return;
    // Kimi reports streaming usage on choices[0], while OpenRouter/OpenAI put
    // it at the chunk root. Support both current wire shapes.
    if (choice.usage !== undefined) usage = choice.usage;
    if (isRecord(choice.error)) {
      throw providerErrorFromRecord(choice.error, 'Provider reported a streaming completion error');
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    if (!isRecord(choice.delta)) return;
    const delta = choice.delta;
    const contentDelta = parseContent(delta.content);
    if (contentDelta) {
      text += contentDelta;
      request.onDelta?.({ kind: 'model_output', text: contentDelta });
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoningContent += delta.reasoning_content;
      request.onDelta?.({ kind: 'reasoning', text: delta.reasoning_content });
    } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
      reasoning += delta.reasoning;
      request.onDelta?.({ kind: 'reasoning', text: delta.reasoning });
    }
    if (Array.isArray(delta.reasoning_details)) {
      // OpenRouter specifies that the complete reasoning sequence is the
      // ordered concatenation of these blocks. Do not normalize or reorder it.
      for (const detail of delta.reasoning_details as unknown[]) reasoningDetails.push(detail);
    }
    if (Array.isArray(delta.annotations)) {
      // OpenRouter returns reusable PDF parser annotations on the assistant
      // message. Preserve streamed chunks so later tool turns do not pay to
      // parse the same document again.
      annotations.push(...delta.annotations as unknown[]);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const entry of delta.tool_calls) {
        if (!isRecord(entry)) continue;
        const index = typeof entry.index === 'number' ? entry.index : 0;
        const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof entry.id === 'string' && !current.id) current.id = entry.id;
        if (isRecord(entry.function)) {
          if (typeof entry.function.name === 'string' && !current.name) current.name = entry.function.name;
          if (typeof entry.function.arguments === 'string') current.arguments += entry.function.arguments;
        }
        toolCalls.set(index, current);
      }
    }
  };

  const dispatchEvent = (): void => {
    if (eventDataLines.length === 0) return;
    const data = eventDataLines.join('\n');
    eventDataLines = [];
    consume(data);
  };
  const consumeLine = (line: string): void => {
    if (line === '') {
      dispatchEvent();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('data:')) {
      eventDataLines.push(line.slice(5).trimStart());
      return;
    }
    if (/^(?:event|id|retry):/u.test(line)) return;
    // Kimi documents continuation lines without a repeated `data:` prefix;
    // accepting them also makes the parser tolerant of compliant multiline
    // SSE producers that have already stripped the field name upstream.
    if (eventDataLines.length > 0) eventDataLines.push(line);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) {
        if (buffer) consumeLine(buffer.replace(/\r$/u, ''));
        dispatchEvent();
        break;
      }
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the provider/protocol failure when transport cleanup also fails.
    }
    if (usage !== undefined) recordProviderUsage({ usage }, config, config.runtime);
    throw error;
  }
  if (usage !== undefined) recordProviderUsage({ usage }, config, config.runtime);
  if (config.provider === 'kimi' && !receivedDone) {
    throw new ProviderApiError(
      'Kimi stream ended without the terminal [DONE] marker and may be incomplete',
    );
  }
  if (finishReason === undefined) {
    throw new ProviderApiError(
      'Provider stream ended without a terminal finish reason and may be incomplete',
    );
  }

  const orderedToolCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right);
  const streamedCallIds = new Set<string>();
  for (const [, call] of orderedToolCalls) {
    if (!call.id) throw new ProviderApiError('Provider streamed a tool call without an ID');
    if (streamedCallIds.has(call.id)) {
      throw new ProviderApiError(`Provider streamed duplicate tool-call ID ${call.id}`);
    }
    streamedCallIds.add(call.id);
    if (!call.name) throw new ProviderApiError('Provider streamed a tool call without a function name');
  }
  const completedToolCalls: OpenAIToolCall[] = orderedToolCalls
    .map(([, call]): OpenAIToolCall => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }));
  const rawMessage: Record<string, unknown> = {
    role: 'assistant',
    content: text || null,
    ...(completedToolCalls.length ? { tool_calls: completedToolCalls } : {}),
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
    ...(annotations.length ? { annotations } : {}),
  };
  if (!text && completedToolCalls.length === 0) {
    throw new ProviderApiError('Provider returned an empty response');
  }
  const raw = {
    ...lastChunk,
    choices: [{ message: rawMessage, finish_reason: finishReason ?? null }],
    ...(usage !== undefined ? { usage } : {}),
  };
  if (usage === undefined) recordProviderUsage(raw, config, config.runtime);
  assertFinishReason(finishReason);
  if (finishReason === 'tool_calls' && completedToolCalls.length === 0) {
    throw new ProviderApiError('Provider ended with tool_calls but returned no tool calls');
  }
  return { text, message: parseAssistantMessage(rawMessage), finishReason, raw };
}

export async function createChatCompletion(
  config: ProviderRuntimeConfig,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  await waitForProviderRequestSlot(request.signal, config.runtime);
  const stream = request.onDelta !== undefined;
  const body = completionRequestBody(config, request, stream);
  const response = await fetch(endpoint(config.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      ...requestHeaders(config),
      ...(stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  if (!response.ok) throw await responseError(response);
  if (stream && response.headers.get('content-type')?.includes('text/event-stream')) {
    return streamedChatCompletion(response, config, request);
  }
  const parsed = await response.json();
  if (!isRecord(parsed)) throw new ProviderApiError('Provider returned a non-object response');
  recordProviderUsage(parsed, config, config.runtime);
  if (isRecord(parsed.error)) {
    throw providerErrorFromRecord(parsed.error, 'Provider reported a completion error');
  }
  const choices: unknown[] = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = choices[0];
  if (!isRecord(choice)) {
    throw new ProviderApiError('Provider returned no assistant message');
  }
  if (isRecord(choice.error)) {
    throw providerErrorFromRecord(choice.error, 'Provider reported a completion error');
  }
  if (!isRecord(choice.message)) {
    throw new ProviderApiError('Provider returned no assistant message');
  }
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
  assertFinishReason(finishReason);
  const rawMessage = choice.message;
  const text = parseContent(rawMessage.content);
  const message = parseAssistantMessage(rawMessage);
  if (finishReason === 'tool_calls' && !message.tool_calls?.length) {
    throw new ProviderApiError('Provider ended with tool_calls but returned no tool calls');
  }
  if (!text && !message.tool_calls?.length) throw new ProviderApiError('Provider returned an empty response');
  return { text, message, finishReason, raw: parsed };
}

async function parseFileContentResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response.text();
  const value = await response.json();
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    for (const key of ['content', 'text', 'file_content']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  throw new ProviderApiError('Kimi file extraction returned no text content');
}

/** Upload a PDF through Kimi's file-extract API and return its extracted text. */
export async function extractKimiFileContent(
  config: ProviderRuntimeConfig,
  dataUrl: string,
  filename: string,
  signal?: AbortSignal,
): Promise<string> {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  const form = new FormData();
  form.append('purpose', 'file-extract');
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  await waitForProviderRequestSlot(signal, config.runtime);
  const upload = await fetch(endpoint(config.baseUrl, 'files'), {
    method: 'POST',
    headers: requestHeaders(config, false),
    body: form,
    signal,
  });
  if (!upload.ok) throw await responseError(upload);
  const uploaded = await upload.json();
  if (!isRecord(uploaded) || typeof uploaded.id !== 'string') {
    throw new ProviderApiError('Kimi file upload returned no file ID');
  }
  const fileId = uploaded.id;
  try {
    await waitForProviderRequestSlot(signal, config.runtime);
    const content = await fetch(endpoint(config.baseUrl, `files/${encodeURIComponent(fileId)}/content`), {
      headers: requestHeaders(config, false),
      signal,
    });
    if (!content.ok) throw await responseError(content);
    return await parseFileContentResponse(content);
  } finally {
    try {
      // Remote-file deletion is non-billable cleanup. Give it an independent
      // short transport deadline after retaining the shared request-rate gate.
      // The rate wait can legitimately exceed five seconds at low RPM values,
      // so it must not consume the DELETE request's timeout budget.
      await waitForProviderRequestSlot(undefined, config.runtime, { ignoreCostLimit: true });
      const cleanupSignal = AbortSignal.timeout(5_000);
      await fetch(endpoint(config.baseUrl, `files/${encodeURIComponent(fileId)}`), {
        method: 'DELETE',
        headers: requestHeaders(config, false),
        signal: cleanupSignal,
      });
    } catch {
      // The extraction result is still useful if best-effort remote cleanup fails.
    }
  }
}

export async function documentContentParts(
  config: ProviderRuntimeConfig,
  dataUrl: string,
  mimeType: string,
  filename: string,
  signal?: AbortSignal,
): Promise<OpenAIContentPart[]> {
  if (mimeType.startsWith('image/')) {
    return [{
      type: 'image_url',
      image_url: {
        url: dataUrl,
        // OpenRouter documents this optional quality hint. Kimi's current
        // multimodal contract allows only `url`, and generic/Muse routes do
        // not get optional OpenAI fields that their public contract does not
        // explicitly advertise.
        ...(config.provider === 'openrouter' ? { detail: 'high' as const } : {}),
      },
    }];
  }
  if (mimeType === 'application/pdf') {
    if (config.provider === 'kimi') {
      const text = await extractKimiFileContent(config, dataUrl, filename, signal);
      return [{ type: 'text', text: `Extracted PDF content:\n\n${text}` }];
    }
    // Meta Muse and OpenRouter document the same Chat Completions PDF part shape.
    if (config.provider === 'openrouter' || config.provider === 'muse') {
      return [{ type: 'file', file: { filename, file_data: dataUrl } }];
    }
    throw new ProviderApiError(
      'This generic OpenAI-compatible profile cannot assume PDF support; use an image, OpenRouter, Kimi, Muse, or Gemini',
    );
  }
  throw new ProviderApiError(`Unsupported document MIME type for ${config.provider}: ${mimeType}`);
}
