import type { StreamFn } from "@berry/harness";
import {
  AnthropicMessagesClient,
  OllamaNativeChatClient,
  OpenAIChatCompletionsClient,
  OpenAIResponsesClient,
  BERRY_ROUTER_METADATA_KEY,
  type ChatCompletionOptions,
  type ChatCompletionChunk,
  type ChatCompletionResult,
  type ChatContentPart,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolDefinition,
  type BerryRouterStreamMetadata,
} from "@berry/router-client";
import { resolveModelCapabilities, type JsonValue, type ModelApiType, type ProviderAuthType, type ProviderCapabilities, type RemoteModel, type RouterAttribution } from "@berry/shared";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

export type BerryStreamFn = StreamFn;

export interface BerryModelProviderInfo {
  id: string;
  baseUrl: string;
  defaultModel: string;
  kind: string;
  name: string;
  apiType?: ModelApiType;
  endpointPath?: string | null;
  modelsPath?: string | null;
  authType?: ProviderAuthType;
  headers?: Record<string, string>;
  models?: RemoteModel[];
  capabilities?: ProviderCapabilities;
  /** Use complete-and-replay when an upstream SSE proxy is unreliable. */
  completionTransport?: "stream" | "buffered";
  /** Retry through complete-and-replay only when streaming produced no chunks. */
  completionFallback?: "buffered";
}

function piApiFor(apiType: ModelApiType | undefined): Api {
  if (apiType === "openai-responses") return "openai-responses";
  if (apiType === "anthropic-messages") return "anthropic-messages";
  return "openai-completions";
}

export function createBerryModel(provider: BerryModelProviderInfo, modelId?: string, options: { reasoning?: boolean; forceImages?: boolean } = {}): Model<Api> {
  const id = modelId ?? provider.defaultModel;
  const metadata = provider.models?.find((candidate) => candidate.id === id);
  const capabilities = resolveModelCapabilities(metadata);
  const vision = capabilities.vision ?? provider.capabilities?.imageInput;
  const contextWindow = capabilities.context?.windowTokens ?? metadata?.contextWindow ?? 200_000;
  const maxTokens = capabilities.context?.maxOutputTokens ?? metadata?.maxOutputTokens ?? 32_000;
  const cost = capabilities.cost ?? {};
  return {
    id,
    name: id,
    api: piApiFor(provider.apiType),
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: options.reasoning === true && capabilities.reasoning !== false,
    input: (options.forceImages === true && vision !== false) || vision === true || (vision === undefined && supportsImageInput(id)) ? ["text", "image"] : ["text"],
    cost: { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 },
    contextWindow,
    maxTokens,
  };
}

/**
 * Builds the pi-ai StreamFn for a provider based on its API transport. The
 * apiKey is optional: keyless local providers stream without auth headers.
 */
export function createProviderStreamFn(provider: BerryModelProviderInfo, apiKey: string | undefined): StreamFn {
  let stream: StreamFn;
  if (provider.apiType === "openai-responses") {
    stream = new OpenAIResponsesAdapter({ client: new OpenAIResponsesClient({ provider, apiKey }) }).stream;
  } else if (provider.apiType === "anthropic-messages") {
    stream = new AnthropicMessagesAdapter({ client: new AnthropicMessagesClient({ provider, apiKey }) }).stream;
  } else {
    const compatible = new OpenAIChatCompletionsClient({ provider, apiKey });
    let client: ChatCompletionStreamClient;
    if (provider.completionTransport === "buffered") {
      client = new BufferedChatCompletionClient(compatible);
    } else {
      client = provider.kind === "ollama"
        ? new FallbackChatCompletionClient(compatible, new OllamaNativeChatClient({ provider, apiKey }))
        : compatible;
      if (provider.completionFallback === "buffered") {
        client = new ContentFallbackChatCompletionClient(client, new BufferedChatCompletionClient(compatible));
      }
    }
    stream = new BerryModelAdapter({ client }).stream;
  }
  return (model, context, options) => {
    return stream(model, contextForModelCapabilities(provider, model.id, context), options);
  };
}

export function contextForModelCapabilities(provider: BerryModelProviderInfo, modelId: string, context: Context): Context {
  const metadata = provider.models?.find((candidate) => candidate.id === modelId);
  const supportsTools = resolveModelCapabilities(metadata).tools ?? provider.capabilities?.toolCalling;
  if (supportsTools !== false) return context;
  const { tools: _tools, ...withoutTools } = context;
  return withoutTools;
}

interface ChatCompletionStreamClient {
  stream(options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk>;
}

export interface ChatCompletionClient extends ChatCompletionStreamClient {
  complete(options: ChatCompletionOptions): Promise<ChatCompletionResult>;
}

/**
 * Converts a fast non-streaming Chat Completions response back into the same
 * normalized chunk shape consumed by BerryModelAdapter. The cloud Router's
 * Canopywave SSE lane can stall for minutes even when its non-streaming lane
 * returns the identical reasoning/tool response in seconds.
 */
export class BufferedChatCompletionClient implements ChatCompletionStreamClient {
  constructor(private readonly client: ChatCompletionClient) {}

  async *stream(options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const result = await this.client.complete(options);
    yield {
      id: result.id,
      model: result.model,
      delta: result.content,
      ...(result.reasoning ? { reasoningDelta: result.reasoning } : {}),
      ...(result.toolCalls ? {
        toolCalls: result.toolCalls.map((call, index) => ({
          index,
          id: call.id,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      } : {}),
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.attribution ? { attribution: result.attribution } : {}),
      raw: result.raw,
    };
  }
}

/** Retries the native Ollama stream only if the compatibility lane produced no chunks. */
export class FallbackChatCompletionClient implements ChatCompletionStreamClient {
  constructor(
    private readonly primary: ChatCompletionStreamClient,
    private readonly fallback: ChatCompletionStreamClient,
  ) {}

  async *stream(options: ChatCompletionOptions): AsyncGenerator<import("@berry/router-client").ChatCompletionChunk> {
    let emitted = false;
    try {
      for await (const chunk of this.primary.stream(options)) {
        emitted = true;
        yield chunk;
      }
      if (emitted) return;
    } catch (error) {
      if (emitted || options.signal?.aborted) throw error;
    }
    yield* this.fallback.stream(options);
  }
}

/**
 * Falls back only when the streaming lane fails before emitting model content.
 * Empty protocol/metadata chunks are held until real text, reasoning, or tool
 * output arrives so they cannot disable the safe fallback prematurely.
 */
export class ContentFallbackChatCompletionClient implements ChatCompletionStreamClient {
  constructor(
    private readonly primary: ChatCompletionStreamClient,
    private readonly fallback: ChatCompletionStreamClient,
  ) {}

  async *stream(options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    let emittedContent = false;
    const pending: ChatCompletionChunk[] = [];
    try {
      for await (const chunk of this.primary.stream(options)) {
        if (emittedContent) {
          yield chunk;
          continue;
        }
        pending.push(chunk);
        if (!chunk.delta && !chunk.reasoningDelta && !chunk.toolCalls?.length) continue;
        emittedContent = true;
        yield* pending;
        pending.length = 0;
      }
      yield* pending;
      return;
    } catch (error) {
      if (emittedContent || options.signal?.aborted) throw error;
    }
    yield* this.fallback.stream(options);
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export type BerryAssistantMessage = AssistantMessage & { berryRouterAttribution?: RouterAttribution };

function applyRouterAttribution(message: AssistantMessage, attribution: RouterAttribution | undefined): void {
  if (attribution) (message as BerryAssistantMessage).berryRouterAttribution = attribution;
}

function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/x-api-key["':\s]+[\w-]+/gi, "x-api-key [redacted]")
    .replace(/([?&](?:key|apiKey|api_key|token|secret)=)[^&\s"']+/gi, "$1[redacted]");
}

function flattenContentToText(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === "string") return content;
  const text = content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const imageCount = content.filter((part) => part.type === "image").length;
  if (imageCount === 0) return text;
  const note = `[note: ${imageCount} image attachment(s) omitted — this provider transport is text-only]`;
  return text.length > 0 ? `${text}\n${note}` : note;
}

function contentToChatContent(content: string | Array<TextContent | ImageContent>, includeImages: boolean): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) parts.push({ type: "text", text: part.text });
      continue;
    }
    if (includeImages) parts.push({ type: "image_url", image_url: { url: imageDataUrl(part) } });
  }
  if (includeImages) return parts.length > 0 ? parts : "";
  return flattenContentToText(content);
}

function imageDataUrl(image: ImageContent): string {
  return image.data.startsWith("data:") ? image.data : `data:${image.mimeType};base64,${image.data}`;
}

function supportsImageInput(modelId: string): boolean {
  return /(vision|vl|gpt-4o|gpt-4\.1|claude-3|gemini|llama-4|pixtral|qwen2\.5-vl|qwen-vl|mistral-small)/i.test(modelId);
}

function getResponsesRawItemsMessage(message: unknown): { items: Array<Record<string, unknown>>; fallbackSummary?: string } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as { role?: unknown; items?: unknown; fallbackSummary?: unknown };
  if (candidate.role !== "responsesRawItems") return undefined;
  if (!Array.isArray(candidate.items)) return undefined;
  if (!candidate.items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return undefined;
  return {
    items: candidate.items as Array<Record<string, unknown>>,
    ...(typeof candidate.fallbackSummary === "string" && candidate.fallbackSummary.length > 0 ? { fallbackSummary: candidate.fallbackSummary } : {}),
  };
}

export function contextToChatMessages(context: Context, options: { includeImages?: boolean } = {}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    const responsesRawItems = getResponsesRawItemsMessage(message);
    if (responsesRawItems) {
      if (responsesRawItems.fallbackSummary) messages.push({ role: "user", content: responsesRawItems.fallbackSummary });
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: contentToChatContent(message.content, options.includeImages === true) });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls: ChatToolCall[] = message.content
        .filter((part): part is ToolCall => part.type === "toolCall")
        .map((part) => ({
          id: part.id,
          type: "function" as const,
          function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
        }));
      const chatMessage: ChatMessage = {
        role: "assistant",
        content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
      };
      if (toolCalls.length > 0) chatMessage.toolCalls = toolCalls;
      messages.push(chatMessage);
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        content: flattenContentToText(message.content),
        toolCallId: message.toolCallId,
        name: message.toolName,
      });
    }
  }
  return messages;
}

export function contextToChatTools(context: Context): ChatToolDefinition[] | undefined {
  if (!context.tools || context.tools.length === 0) return undefined;
  return context.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as JsonValue,
    },
  }));
}

interface ToolCallBuffer {
  contentIndex: number;
  id: string;
  name: string;
  args: string;
}

/**
 * pi-ai compatible StreamFn that executes OpenAI-compatible chat completions
 * (text + tool calling) through the Berry router client and adapts the
 * streamed deltas onto the pi-ai AssistantMessage event protocol.
 */
export class BerryModelAdapter {
  readonly #client: ChatCompletionStreamClient;

  constructor(options: { client: ChatCompletionStreamClient }) {
    this.#client = options.client;
  }

  stream: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void this.#run(model, context, options, stream);
    return stream;
  };

  async complete(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
    const stream = this.stream(model, context, options) as AssistantMessageEventStream;
    return stream.result();
  }

  async #run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let openTextIndex = -1;
    let openThinkingIndex = -1;
    const toolBuffers = new Map<number, ToolCallBuffer>();
    let finishReason: string | null = null;

    const closeText = () => {
      if (openTextIndex < 0) return;
      const part = message.content[openTextIndex] as TextContent;
      stream.push({ type: "text_end", contentIndex: openTextIndex, content: part.text, partial: message });
      openTextIndex = -1;
    };
    const closeThinking = () => {
      if (openThinkingIndex < 0) return;
      const part = message.content[openThinkingIndex] as ThinkingContent;
      stream.push({ type: "thinking_end", contentIndex: openThinkingIndex, content: part.thinking, partial: message });
      openThinkingIndex = -1;
    };

    try {
      stream.push({ type: "start", partial: message });
      const request: ChatCompletionOptions = {
        model: model.id,
        messages: contextToChatMessages(context, { includeImages: model.input.includes("image") }),
      };
      const tools = contextToChatTools(context);
      if (tools) {
        request.tools = tools;
        request.toolChoice = "auto";
      }
      if (options?.temperature !== undefined) request.temperature = options.temperature;
      if (options?.maxTokens !== undefined) request.maxTokens = options.maxTokens;
      if (options?.signal) request.signal = options.signal;
      if (options?.reasoning && model.reasoning) request.reasoningEffort = reasoningEffort(options.reasoning);

      for await (const chunk of this.#client.stream(request)) {
        if (options?.signal?.aborted) throw new Error("aborted");
        applyRouterAttribution(message, chunk.attribution);
        if (chunk.usage) {
          message.usage = {
            ...emptyUsage(),
            input: chunk.usage.inputTokens,
            output: chunk.usage.outputTokens,
            totalTokens: chunk.usage.totalTokens,
          };
        }
        if (chunk.reasoningDelta) {
          closeText();
          if (openThinkingIndex < 0) {
            message.content.push({ type: "thinking", thinking: "" });
            openThinkingIndex = message.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: openThinkingIndex, partial: message });
          }
          const part = message.content[openThinkingIndex] as ThinkingContent;
          part.thinking += chunk.reasoningDelta;
          stream.push({
            type: "thinking_delta",
            contentIndex: openThinkingIndex,
            delta: chunk.reasoningDelta,
            partial: message,
          });
        }
        if (chunk.delta.length > 0) {
          closeThinking();
          if (openTextIndex < 0) {
            message.content.push({ type: "text", text: "" });
            openTextIndex = message.content.length - 1;
            stream.push({ type: "text_start", contentIndex: openTextIndex, partial: message });
          }
          const part = message.content[openTextIndex] as TextContent;
          part.text += chunk.delta;
          stream.push({ type: "text_delta", contentIndex: openTextIndex, delta: chunk.delta, partial: message });
        }
        for (const delta of chunk.toolCalls ?? []) {
          closeText();
          closeThinking();
          let buffer = toolBuffers.get(delta.index);
          if (!buffer) {
            message.content.push({
              type: "toolCall",
              id: delta.id ?? `call_${delta.index}`,
              name: delta.function?.name ?? "",
              arguments: {},
            });
            buffer = {
              contentIndex: message.content.length - 1,
              id: delta.id ?? `call_${delta.index}`,
              name: delta.function?.name ?? "",
              args: delta.function?.arguments ?? "",
            };
            toolBuffers.set(delta.index, buffer);
            stream.push({ type: "toolcall_start", contentIndex: buffer.contentIndex, partial: message });
            if (buffer.args.length > 0) {
              stream.push({
                type: "toolcall_delta",
                contentIndex: buffer.contentIndex,
                delta: buffer.args,
                partial: message,
              });
            }
            continue;
          }
          if (delta.id) buffer.id = delta.id;
          if (delta.function?.name) buffer.name += delta.function.name;
          if (delta.function?.arguments) {
            buffer.args += delta.function.arguments;
            stream.push({
              type: "toolcall_delta",
              contentIndex: buffer.contentIndex,
              delta: delta.function.arguments,
              partial: message,
            });
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }

      closeText();
      closeThinking();
      const orderedBuffers = [...toolBuffers.entries()].sort((a, b) => a[0] - b[0]).map(([, buffer]) => buffer);
      for (const buffer of orderedBuffers) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: buffer.id,
          name: buffer.name,
          arguments: parseToolArguments(buffer.args),
        };
        message.content[buffer.contentIndex] = toolCall;
        stream.push({ type: "toolcall_end", contentIndex: buffer.contentIndex, toolCall, partial: message });
      }
      const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
        finishReason === "length"
          ? "length"
          : orderedBuffers.length > 0 || finishReason === "tool_calls"
            ? "toolUse"
            : "stop";
      message.stopReason = reason;
      stream.push({ type: "done", reason, message });
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      message.stopReason = aborted ? "aborted" : "error";
      message.errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
  }
}

function reasoningEffort(value: NonNullable<SimpleStreamOptions["reasoning"]>): "minimal" | "low" | "medium" | "high" {
  if (value === "minimal") return "minimal";
  if (value === "xhigh") return "high";
  return value;
}

/** Converts harness context messages into OpenAI Responses `input` items. */
export function contextToResponsesInput(context: Context, options: { includeImages?: boolean } = {}): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const message of context.messages) {
    const responsesRawItems = getResponsesRawItemsMessage(message);
    if (responsesRawItems) {
      items.push(...responsesRawItems.items);
      continue;
    }
    if (message.role === "user") {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof message.content === "string") {
        parts.push({ type: "input_text", text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text.length > 0) parts.push({ type: "input_text", text: part.text });
          } else if (options.includeImages === true) {
            parts.push({ type: "input_image", image_url: imageDataUrl(part) });
          }
        }
        if (options.includeImages !== true) {
          const imageCount = message.content.filter((part) => part.type === "image").length;
          if (imageCount > 0) {
            parts.push({ type: "input_text", text: `[note: ${imageCount} image attachment(s) omitted — this provider transport is text-only]` });
          }
        }
      }
      items.push({ role: "user", content: parts.length > 0 ? parts : [{ type: "input_text", text: "" }] });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.length > 0) {
        items.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const part of message.content) {
        if (part.type === "toolCall") {
          items.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments ?? {}),
          });
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: flattenContentToText(message.content),
      });
    }
  }
  return items;
}

export function contextToResponsesTools(context: Context): Array<Record<string, unknown>> | undefined {
  if (!context.tools || context.tools.length === 0) return undefined;
  return context.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as JsonValue,
  }));
}

interface ResponsesStreamClient {
  streamEvents(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>>;
}

/**
 * pi-ai compatible StreamFn for the OpenAI Responses API. Parses the
 * `response.*` SSE vocabulary (output text deltas, reasoning summary deltas,
 * streamed function calls) onto AssistantMessage events. Requests are sent
 * with `store: false` — Berry keeps conversation state locally.
 */
export class OpenAIResponsesAdapter {
  readonly #client: ResponsesStreamClient;

  constructor(options: { client: ResponsesStreamClient }) {
    this.#client = options.client;
  }

  stream: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void this.#run(model, context, options, stream);
    return stream;
  };

  async #run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let openTextIndex = -1;
    let openThinkingIndex = -1;
    // Streamed function calls keyed by the Responses item id.
    const toolBuffers = new Map<string, ToolCallBuffer & { callId: string }>();
    let sawIncomplete = false;

    const closeText = () => {
      if (openTextIndex < 0) return;
      const part = message.content[openTextIndex] as TextContent;
      stream.push({ type: "text_end", contentIndex: openTextIndex, content: part.text, partial: message });
      openTextIndex = -1;
    };
    const closeThinking = () => {
      if (openThinkingIndex < 0) return;
      const part = message.content[openThinkingIndex] as ThinkingContent;
      stream.push({ type: "thinking_end", contentIndex: openThinkingIndex, content: part.thinking, partial: message });
      openThinkingIndex = -1;
    };

    try {
      stream.push({ type: "start", partial: message });
      const body: Record<string, unknown> = {
        model: model.id,
        input: contextToResponsesInput(context, { includeImages: model.input.includes("image") }),
        store: false,
      };
      if (context.systemPrompt) body.instructions = context.systemPrompt;
      const tools = contextToResponsesTools(context);
      if (tools) body.tools = tools;
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
      if (options?.reasoning && model.reasoning) body.reasoning = { effort: reasoningEffort(options.reasoning) };

      for await (const event of this.#client.streamEvents(body, options?.signal)) {
        if (options?.signal?.aborted) throw new Error("aborted");
        const routerMetadata = event[BERRY_ROUTER_METADATA_KEY] as BerryRouterStreamMetadata | undefined;
        applyRouterAttribution(message, routerMetadata?.attribution);
        if (routerMetadata?.usage) {
          message.usage = {
            ...emptyUsage(),
            input: routerMetadata.usage.inputTokens,
            output: routerMetadata.usage.outputTokens,
            totalTokens: routerMetadata.usage.totalTokens,
          };
        }
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "response.output_text.delta") {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta.length === 0) continue;
          closeThinking();
          if (openTextIndex < 0) {
            message.content.push({ type: "text", text: "" });
            openTextIndex = message.content.length - 1;
            stream.push({ type: "text_start", contentIndex: openTextIndex, partial: message });
          }
          const part = message.content[openTextIndex] as TextContent;
          part.text += delta;
          stream.push({ type: "text_delta", contentIndex: openTextIndex, delta, partial: message });
          continue;
        }
        if (type === "response.reasoning_summary_text.delta") {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta.length === 0) continue;
          closeText();
          if (openThinkingIndex < 0) {
            message.content.push({ type: "thinking", thinking: "" });
            openThinkingIndex = message.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: openThinkingIndex, partial: message });
          }
          const part = message.content[openThinkingIndex] as ThinkingContent;
          part.thinking += delta;
          stream.push({ type: "thinking_delta", contentIndex: openThinkingIndex, delta, partial: message });
          continue;
        }
        if (type === "response.output_item.added") {
          const item = event.item as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string } | undefined;
          if (item?.type !== "function_call") continue;
          closeText();
          closeThinking();
          const itemId = item.id ?? item.call_id ?? `item_${toolBuffers.size}`;
          message.content.push({ type: "toolCall", id: item.call_id ?? itemId, name: item.name ?? "", arguments: {} });
          const buffer = {
            contentIndex: message.content.length - 1,
            id: itemId,
            callId: item.call_id ?? itemId,
            name: item.name ?? "",
            args: item.arguments ?? "",
          };
          toolBuffers.set(itemId, buffer);
          stream.push({ type: "toolcall_start", contentIndex: buffer.contentIndex, partial: message });
          if (buffer.args.length > 0) {
            stream.push({ type: "toolcall_delta", contentIndex: buffer.contentIndex, delta: buffer.args, partial: message });
          }
          continue;
        }
        if (type === "response.function_call_arguments.delta") {
          const itemId = typeof event.item_id === "string" ? event.item_id : "";
          const buffer = toolBuffers.get(itemId);
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!buffer || delta.length === 0) continue;
          buffer.args += delta;
          stream.push({ type: "toolcall_delta", contentIndex: buffer.contentIndex, delta, partial: message });
          continue;
        }
        if (type === "response.output_item.done") {
          const item = event.item as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string } | undefined;
          if (item?.type !== "function_call") continue;
          const buffer = item.id ? toolBuffers.get(item.id) : undefined;
          if (!buffer) continue;
          if (typeof item.arguments === "string" && item.arguments.length > 0) buffer.args = item.arguments;
          if (typeof item.name === "string" && item.name.length > 0) buffer.name = item.name;
          if (typeof item.call_id === "string" && item.call_id.length > 0) buffer.callId = item.call_id;
          continue;
        }
        if (type === "response.completed" || type === "response.incomplete") {
          const response = event.response as
            | { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }; incomplete_details?: { reason?: string } }
            | undefined;
          if (response?.usage) {
            message.usage = {
              ...emptyUsage(),
              input: response.usage.input_tokens ?? 0,
              output: response.usage.output_tokens ?? 0,
              totalTokens: response.usage.total_tokens ?? (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
            };
          }
          if (type === "response.incomplete" || response?.incomplete_details?.reason === "max_output_tokens") sawIncomplete = true;
          continue;
        }
        if (type === "response.failed" || type === "error") {
          const errorInfo = (event.response as { error?: { message?: string } } | undefined)?.error ?? (event as { message?: string });
          throw new Error(typeof errorInfo?.message === "string" ? errorInfo.message : "Provider stream failed");
        }
        // Other event types (response.created, deltas we don't render, pings)
        // are intentionally ignored.
      }

      closeText();
      closeThinking();
      const orderedBuffers = [...toolBuffers.values()].sort((a, b) => a.contentIndex - b.contentIndex);
      for (const buffer of orderedBuffers) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: buffer.callId,
          name: buffer.name,
          arguments: parseToolArguments(buffer.args),
        };
        message.content[buffer.contentIndex] = toolCall;
        stream.push({ type: "toolcall_end", contentIndex: buffer.contentIndex, toolCall, partial: message });
      }
      const reason: Extract<StopReason, "stop" | "length" | "toolUse"> = sawIncomplete
        ? "length"
        : orderedBuffers.length > 0
          ? "toolUse"
          : "stop";
      message.stopReason = reason;
      stream.push({ type: "done", reason, message });
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      message.stopReason = aborted ? "aborted" : "error";
      message.errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
  }
}

type AnthropicContentBlock = Record<string, unknown>;

/**
 * Converts harness context messages into Anthropic Messages format. The
 * system prompt is NOT included here — it belongs in the request's `system`
 * field. Consecutive tool results merge into one user message so every
 * `tool_use` block is answered by `tool_result` blocks in the next message.
 */
export function contextToAnthropicMessages(context: Context): Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }> {
  const messages: Array<{ role: "user" | "assistant"; content: AnthropicContentBlock[] }> = [];
  for (const message of context.messages) {
    const responsesRawItems = getResponsesRawItemsMessage(message);
    if (responsesRawItems) {
      if (responsesRawItems.fallbackSummary) messages.push({ role: "user", content: [{ type: "text", text: responsesRawItems.fallbackSummary }] });
      continue;
    }
    if (message.role === "user") {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof message.content === "string") {
        blocks.push({ type: "text", text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === "text") {
            if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
          } else {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: part.mimeType, data: stripDataUrlPrefix(part.data) },
            });
          }
        }
      }
      messages.push({ role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
        } else if (part.type === "toolCall") {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.arguments ?? {} });
        }
        // Thinking blocks are not replayed: Anthropic requires signed thinking
        // blocks to round-trip verbatim, and Berry doesn't persist signatures.
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (message.role === "toolResult") {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: flattenContentToText(message.content),
        ...(message.isError ? { is_error: true } : {}),
      };
      const previous = messages.at(-1);
      if (previous && previous.role === "user" && previous.content.every((item) => item.type === "tool_result")) {
        previous.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    }
  }
  return messages;
}

export function contextToAnthropicTools(context: Context): Array<Record<string, unknown>> | undefined {
  if (!context.tools || context.tools.length === 0) return undefined;
  return context.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as unknown as JsonValue,
  }));
}

function stripDataUrlPrefix(data: string): string {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(data);
  return match ? match[1] ?? "" : data;
}

function anthropicThinkingBudget(value: NonNullable<SimpleStreamOptions["reasoning"]>): number {
  switch (value) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    default:
      return 16384;
  }
}

const ANTHROPIC_DEFAULT_MAX_TOKENS = 16_384;

interface AnthropicStreamClient {
  streamEvents(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>>;
}

/**
 * pi-ai compatible StreamFn for the Anthropic Messages API. Parses the
 * message/content-block event vocabulary (including partial-JSON tool input
 * deltas) onto AssistantMessage events; tolerates ping and unknown events.
 */
export class AnthropicMessagesAdapter {
  readonly #client: AnthropicStreamClient;

  constructor(options: { client: AnthropicStreamClient }) {
    this.#client = options.client;
  }

  stream: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void this.#run(model, context, options, stream);
    return stream;
  };

  async #run(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    // Anthropic block index -> our content index + accumulated tool JSON.
    const blocks = new Map<number, { contentIndex: number; kind: "text" | "thinking" | "toolCall"; toolJson: string }>();
    let stopReason: string | null = null;

    try {
      stream.push({ type: "start", partial: message });
      const maxTokens = options?.maxTokens ?? model.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
      const body: Record<string, unknown> = {
        model: model.id,
        max_tokens: maxTokens,
        messages: contextToAnthropicMessages(context),
      };
      if (context.systemPrompt) body.system = context.systemPrompt;
      const tools = contextToAnthropicTools(context);
      if (tools) body.tools = tools;
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.reasoning && model.reasoning) {
        // Budget must stay under max_tokens or the request is rejected.
        const budget = Math.min(anthropicThinkingBudget(options.reasoning), Math.max(1024, maxTokens - 1024));
        body.thinking = { type: "enabled", budget_tokens: budget };
      }

      for await (const event of this.#client.streamEvents(body, options?.signal)) {
        if (options?.signal?.aborted) throw new Error("aborted");
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "message_start") {
          const usage = (event.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
          if (usage) {
            message.usage.input = usage.input_tokens ?? 0;
            message.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
            message.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
          }
          continue;
        }
        if (type === "content_block_start") {
          const index = typeof event.index === "number" ? event.index : blocks.size;
          const block = event.content_block as { type?: string; id?: string; name?: string } | undefined;
          if (block?.type === "text") {
            message.content.push({ type: "text", text: "" });
            const contentIndex = message.content.length - 1;
            blocks.set(index, { contentIndex, kind: "text", toolJson: "" });
            stream.push({ type: "text_start", contentIndex, partial: message });
          } else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
            message.content.push({ type: "thinking", thinking: "" });
            const contentIndex = message.content.length - 1;
            blocks.set(index, { contentIndex, kind: "thinking", toolJson: "" });
            stream.push({ type: "thinking_start", contentIndex, partial: message });
          } else if (block?.type === "tool_use") {
            message.content.push({ type: "toolCall", id: block.id ?? `toolu_${index}`, name: block.name ?? "", arguments: {} });
            const contentIndex = message.content.length - 1;
            blocks.set(index, { contentIndex, kind: "toolCall", toolJson: "" });
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
          }
          continue;
        }
        if (type === "content_block_delta") {
          const index = typeof event.index === "number" ? event.index : -1;
          const state = blocks.get(index);
          const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
          if (!state || !delta) continue;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            const part = message.content[state.contentIndex] as TextContent;
            part.text += delta.text;
            stream.push({ type: "text_delta", contentIndex: state.contentIndex, delta: delta.text, partial: message });
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            const part = message.content[state.contentIndex] as ThinkingContent;
            part.thinking += delta.thinking;
            stream.push({ type: "thinking_delta", contentIndex: state.contentIndex, delta: delta.thinking, partial: message });
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
            state.toolJson += delta.partial_json;
            stream.push({ type: "toolcall_delta", contentIndex: state.contentIndex, delta: delta.partial_json, partial: message });
          }
          // signature_delta and unknown delta types are ignored.
          continue;
        }
        if (type === "content_block_stop") {
          const index = typeof event.index === "number" ? event.index : -1;
          const state = blocks.get(index);
          if (!state) continue;
          if (state.kind === "text") {
            const part = message.content[state.contentIndex] as TextContent;
            stream.push({ type: "text_end", contentIndex: state.contentIndex, content: part.text, partial: message });
          } else if (state.kind === "thinking") {
            const part = message.content[state.contentIndex] as ThinkingContent;
            stream.push({ type: "thinking_end", contentIndex: state.contentIndex, content: part.thinking, partial: message });
          } else {
            const open = message.content[state.contentIndex] as ToolCall;
            const toolCall: ToolCall = {
              type: "toolCall",
              id: open.id,
              name: open.name,
              arguments: parseToolArguments(state.toolJson),
            };
            message.content[state.contentIndex] = toolCall;
            stream.push({ type: "toolcall_end", contentIndex: state.contentIndex, toolCall, partial: message });
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = event.delta as { stop_reason?: string } | undefined;
          if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
          const usage = event.usage as { output_tokens?: number } | undefined;
          if (usage?.output_tokens !== undefined) {
            message.usage.output = usage.output_tokens;
            message.usage.totalTokens = message.usage.input + message.usage.output;
          }
          continue;
        }
        if (type === "error") {
          const errorInfo = event.error as { message?: string } | undefined;
          throw new Error(typeof errorInfo?.message === "string" ? errorInfo.message : "Provider stream failed");
        }
        // message_stop, ping, and unknown event types need no handling.
      }

      const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
        stopReason === "max_tokens" ? "length" : stopReason === "tool_use" ? "toolUse" : "stop";
      message.stopReason = reason;
      stream.push({ type: "done", reason, message });
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      message.stopReason = aborted ? "aborted" : "error";
      message.errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

/**
 * Minimal pi-ai `Models` implementation backed by a single stream function.
 * The harness resolves turn streaming, compaction, and branch summaries
 * through this collection.
 */
export function createBerryModels(streamFn: StreamFn, models: Array<Model<Api>>): Models {
  const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const result = streamFn(model, context, options);
    if (result instanceof Promise) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          for await (const event of await result) stream.push(event);
        } catch (error) {
          const failure: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "error",
            errorMessage: redactSecrets(error instanceof Error ? error.message : String(error)),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: failure });
        }
      })();
      return stream;
    }
    return result;
  };
  return {
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => models,
    getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    refresh: async () => {},
    getAuth: async () => undefined,
    stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions | undefined),
    complete: async (model, context, options) =>
      streamSimple(model, context, options as SimpleStreamOptions | undefined).result(),
    streamSimple,
    completeSimple: async (model, context, options) => streamSimple(model, context, options).result(),
  };
}
