import type { JsonValue, ModelApiType, ProviderAuthType, RemoteModel, RouterAccount, RouterAttribution } from "@berry/shared";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: ChatMessageContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: ChatToolCall[];
}

export type ChatMessageContent = string | null | ChatContentPart[];

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JsonValue;
  };
}

export type ChatToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export interface ChatCompletionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  id: string;
  model: string;
  content: string;
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  finishReason: string | null;
  usage?: ChatCompletionUsage;
  attribution?: RouterAttribution;
  raw: JsonValue;
}

export interface ChatToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunk {
  id: string;
  model: string;
  delta: string;
  reasoningDelta?: string;
  toolCalls?: ChatToolCallDelta[];
  finishReason: string | null;
  usage?: ChatCompletionUsage;
  attribution?: RouterAttribution;
  raw: JsonValue;
}

export const BERRY_ROUTER_METADATA_KEY = "_berryRouter";

export interface BerryRouterStreamMetadata {
  attribution: RouterAttribution;
  usage?: ChatCompletionUsage;
}

export interface ResponsesCompactionResult {
  id?: string;
  object?: string;
  output: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
  raw: JsonValue;
}

/**
 * The slice of a ModelProvider the transport clients need. `apiType`,
 * `endpointPath`, `modelsPath`, `authType`, and `headers` are optional so
 * legacy call sites (and tests) that pass the old four-field shape keep
 * working with bearer-auth Chat Completions defaults.
 */
export interface ProviderTransportInfo {
  baseUrl: string;
  defaultModel: string;
  /** Provider kind; kept as a plain string at the transport layer. */
  kind: string;
  name: string;
  apiType?: ModelApiType;
  endpointPath?: string | null;
  modelsPath?: string | null;
  authType?: ProviderAuthType;
  headers?: Record<string, string>;
}

export interface RouterClientOptions {
  provider: ProviderTransportInfo;
  /** Absent/empty for keyless providers (authType "none"). */
  apiKey?: string | undefined;
  appName?: string;
  referer?: string;
  fetchImpl?: typeof fetch;
}

export interface BerryRouterAccountClientOptions extends RouterClientOptions {
  accountPath?: string;
  tokenUrl?: string;
}

export interface BerryRouterOAuthExchange {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
}

export interface ImageGenerationOptions {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  responseFormat?: "url" | "b64_json";
  n?: number;
  signal?: AbortSignal;
}

export interface ImageGenerationData {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResult {
  model?: string;
  created?: number;
  data: ImageGenerationData[];
}

export class RouterClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(redactSecrets(message));
    this.name = "RouterClientError";
  }
}

export type { RemoteModel };

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Builds the auth + content headers for a provider request. `authType`
 * decides the header shape; a missing key with a non-"none" auth type sends
 * no auth header at all (the provider will reject with a 401 the caller can
 * surface). Provider-level custom headers are applied first so the standard
 * headers cannot be silently overridden.
 */
export function buildHeaders(
  provider: ProviderTransportInfo,
  apiKey: string | undefined,
  extras: { appName?: string; referer?: string; metadata?: Record<string, string> } = {},
): Headers {
  const headers = new Headers({ ...(provider.headers ?? {}), ...(extras.metadata ?? {}) });
  headers.set("Content-Type", "application/json");
  if (extras.appName) headers.set("X-Title", extras.appName);
  if (extras.referer) headers.set("HTTP-Referer", extras.referer);
  const authType = provider.authType ?? "bearer";
  const key = apiKey?.trim();
  if (authType === "x-api-key") {
    if (key) headers.set("x-api-key", key);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", ANTHROPIC_VERSION);
  } else if ((authType === "bearer" || authType === "optional-bearer") && key) {
    headers.set("Authorization", `Bearer ${key}`);
  }
  return headers;
}

function requestUrl(provider: ProviderTransportInfo, path: string): URL {
  return new URL(path.replace(/^\//, ""), ensureSlash(provider.baseUrl));
}

/**
 * Fetches and normalizes a provider's model list. Works for OpenAI-style
 * `GET /models` (`data[]` of `{id, owned_by}`) and Anthropic's
 * `GET /models` (`data[]` of `{id, display_name}`). No auth header is sent
 * for keyless providers.
 */
export async function listProviderModels(options: RouterClientOptions): Promise<RemoteModel[]> {
  const provider = options.provider;
  const modelsPath = provider.modelsPath ?? "/models";
  const url = requestUrl(provider, modelsPath);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: buildHeaders(provider, options.apiKey, { ...(options.appName ? { appName: options.appName } : {}) }),
  });
  if (!response.ok) {
    throw new RouterClientError(
      `Provider returned ${response.status} when listing models`,
      response.status,
      await response.text(),
    );
  }
  const payload = (await response.json()) as { data?: ProviderModelEntry[] } | ProviderModelEntry[] | null;
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const models: RemoteModel[] = entries
    .map((entry) => {
      const model: RemoteModel = { id: "", raw: entry as unknown as JsonValue };
      if (typeof entry?.id === "string" && entry.id.length > 0) {
        model.id = entry.id;
        model.name = typeof entry.display_name === "string" ? entry.display_name : entry.id;
      }
      if (typeof entry?.owned_by === "string") model.ownedBy = entry.owned_by;
      const contextWindow = positiveNumber(entry?.max_input_tokens) ?? positiveNumber(entry?.context_length);
      const maxOutputTokens = positiveNumber(entry?.max_tokens);
      if (contextWindow) model.contextWindow = contextWindow;
      if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
      const capabilities = normalizeProviderModelCapabilities(entry?.capabilities, contextWindow, maxOutputTokens);
      if (capabilities) model.capabilities = capabilities;
      return model;
    })
    .filter((model) => model.id.length > 0);
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** Contract-only Berry Router account/OAuth client. The Router service itself remains out of this repository. */
export class BerryRouterAccountClient {
  readonly #provider: ProviderTransportInfo;
  readonly #apiKey: string | undefined;
  readonly #accountPath: string;
  readonly #tokenUrl: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: BerryRouterAccountClientOptions) {
    this.#provider = options.provider;
    this.#apiKey = options.apiKey;
    this.#accountPath = options.accountPath ?? "/account";
    this.#tokenUrl = options.tokenUrl;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async account(signal?: AbortSignal): Promise<RouterAccount> {
    const response = await this.#fetch(requestUrl(this.#provider, this.#accountPath), {
      method: "GET",
      headers: buildHeaders(this.#provider, this.#apiKey),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new RouterClientError(`Berry Router account request failed with ${response.status}`, response.status, await response.text());
    }
    return normalizeRouterAccount(await response.json());
  }

  async exchangeOAuthCode(input: BerryRouterOAuthExchange, signal?: AbortSignal): Promise<{ accessToken: string; tokenType: string; expiresAt: string | null }> {
    if (!this.#tokenUrl) throw new RouterClientError("Berry Router OAuth token endpoint is not configured");
    const response = await this.#fetch(this.#tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new RouterClientError(`Berry Router OAuth exchange failed with ${response.status}`, response.status, await response.text());
    }
    const payload = await response.json() as Record<string, unknown>;
    const accessToken = stringField(payload, "access_token");
    if (!accessToken) throw new RouterClientError("Berry Router OAuth response did not include access_token", response.status, JSON.stringify(payload));
    const expiresIn = numberField(payload, "expires_in");
    return {
      accessToken,
      tokenType: stringField(payload, "token_type") ?? "Bearer",
      expiresAt: expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }
}

/** OpenAI-compatible Image API transport used by Berry Router and desktop. */
export class OpenAIImageGenerationClient {
  readonly #provider: ProviderTransportInfo;
  readonly #apiKey: string | undefined;
  readonly #appName: string;
  readonly #fetch: typeof fetch;

  constructor(options: RouterClientOptions) {
    this.#provider = options.provider;
    this.#apiKey = options.apiKey;
    this.#appName = options.appName ?? "Berry Desktop";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async generate(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const url = requestUrl(this.#provider, "/images/generations");
    const body = {
      model: options.model ?? this.#provider.defaultModel,
      prompt: options.prompt,
      n: options.n ?? 1,
      size: options.size ?? "1024x1024",
      response_format: options.responseFormat ?? "b64_json",
      ...(options.quality ? { quality: options.quality } : {}),
    };
    const response = await this.#fetch(url, {
      method: "POST",
      headers: buildHeaders(this.#provider, this.#apiKey, { appName: this.#appName }),
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new RouterClientError(`Image provider request failed with ${response.status}`, response.status, await response.text());
    }
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new RouterClientError("Image provider returned an invalid response", response.status, JSON.stringify(payload));
    }
    const data = payload.data.filter((entry): entry is ImageGenerationData => {
      if (!isRecord(entry)) return false;
      return typeof entry.url === "string" || typeof entry.b64_json === "string";
    });
    if (data.length === 0) {
      throw new RouterClientError("Image provider returned no image data", response.status, JSON.stringify(payload));
    }
    return {
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      ...(typeof payload.created === "number" ? { created: payload.created } : {}),
      data,
    };
  }
}

/**
 * OpenAI-compatible Chat Completions transport (OpenAI, OpenRouter, Fireworks,
 * llama.cpp/Ollama/LM Studio local servers, Berry Router).
 */
export class OpenAIChatCompletionsClient {
  readonly #provider: ProviderTransportInfo;
  readonly #apiKey: string | undefined;
  readonly #appName: string;
  readonly #referer: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: RouterClientOptions) {
    this.#provider = options.provider;
    this.#apiKey = options.apiKey;
    this.#appName = options.appName ?? "Berry Desktop";
    this.#referer = options.referer;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const response = await this.#post({ ...options, stream: false });
    const payload = (await response.json()) as OpenAICompletionResponse;
    const choice = payload.choices[0];
    if (!choice) throw new RouterClientError("Provider returned no choices", response.status, JSON.stringify(payload));
    const nativeToolCalls = normalizeToolCalls(choice.message?.tool_calls);
    const kimiToolCalls = nativeToolCalls ? undefined : parseKimiToolCalls(choice.message?.content ?? "");
    const result: ChatCompletionResult = {
      id: payload.id,
      model: payload.model ?? options.model ?? this.#provider.defaultModel,
      content: kimiToolCalls?.content ?? choice.message?.content ?? "",
      finishReason: kimiToolCalls ? "tool_calls" : choice.finish_reason ?? null,
      raw: payload as unknown as JsonValue,
    };
    const reasoning = choice.message?.reasoning ?? choice.message?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) result.reasoning = reasoning;
    const toolCalls = nativeToolCalls ?? kimiToolCalls?.toolCalls;
    if (toolCalls) result.toolCalls = toolCalls;
    const usage = normalizeUsage(payload.usage);
    const headerUsage = normalizeUsageHeaders(response.headers);
    const finalUsage = usage ?? headerUsage;
    if (finalUsage) result.usage = finalUsage;
    const attribution = routerAttribution(this.#provider, options.model ?? this.#provider.defaultModel, response.headers, payload as unknown as Record<string, unknown>);
    if (attribution) result.attribution = attribution;
    return result;
  }

  async *stream(options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const response = await this.#post({ ...options, stream: true });
    const requestedModel = options.model ?? this.#provider.defaultModel;
    const headerUsage = normalizeUsageHeaders(response.headers);
    try {
      for await (const event of parseSse(response)) {
        if (event === "[DONE]") break;
        const rawPayload = JSON.parse(event) as unknown;
        throwForOpenAIStreamError(rawPayload, response, this.#provider.name);
        if (!isRecord(rawPayload)) {
          throw new RouterClientError("Provider returned a non-object streaming event", undefined, event);
        }
        const payload = rawPayload as unknown as OpenAIStreamResponse;
        if (!Array.isArray(payload.choices)) {
          throw new RouterClientError("Provider returned a streaming event without choices", undefined, event);
        }
        const choice = payload.choices[0];
        if (!choice && !payload.usage) continue;
        const chunk: ChatCompletionChunk = {
          id: payload.id,
          model: payload.model ?? options.model ?? this.#provider.defaultModel,
          delta: choice?.delta?.content ?? "",
          finishReason: choice?.finish_reason ?? null,
          raw: payload as unknown as JsonValue,
        };
        const reasoningDelta = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          chunk.reasoningDelta = reasoningDelta;
        }
        const toolCalls = normalizeToolCallDeltas(choice?.delta?.tool_calls);
        if (toolCalls) chunk.toolCalls = toolCalls;
        const usage = normalizeUsage(payload.usage);
        const finalUsage = usage ?? (choice?.finish_reason ? headerUsage : undefined);
        if (finalUsage) chunk.usage = finalUsage;
        const attribution = routerAttribution(this.#provider, requestedModel, response.headers, rawPayload);
        if (attribution) chunk.attribution = attribution;
        yield chunk;
      }
    } catch (error) {
      if (error instanceof RouterClientError || options.signal?.aborted) throw error;
      const requestId = response.headers.get("x-request-id")?.trim();
      const cause = redactSecrets(error instanceof Error ? error.message : String(error));
      throw new RouterClientError(
        `${this.#provider.name} stream failed before completion${requestId ? ` (request ${requestId})` : ""}: ${cause}`,
        undefined,
        cause,
      );
    }
  }

  /** Fetches the provider's model list (`GET {baseUrl}{modelsPath ?? "/models"}`). */
  async listModels(): Promise<RemoteModel[]> {
    return listProviderModels({
      provider: this.#provider,
      apiKey: this.#apiKey,
      appName: this.#appName,
      fetchImpl: this.#fetch,
    });
  }

  async #post(options: ChatCompletionOptions & { stream: boolean }): Promise<Response> {
    const url = requestUrl(this.#provider, this.#provider.endpointPath ?? "/chat/completions");
    const body: Record<string, unknown> = {
      model: options.model ?? this.#provider.defaultModel,
      messages: options.messages.map(serializeMessage),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: options.stream,
    };
    if (options.reasoningEffort) {
      if (usesOpenRouterReasoningShape(this.#provider)) body.reasoning = { effort: options.reasoningEffort };
      else body.reasoning_effort = options.reasoningEffort;
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }
    const init: RequestInit = {
      method: "POST",
      headers: buildHeaders(this.#provider, this.#apiKey, {
        appName: this.#appName,
        ...(this.#referer ? { referer: this.#referer } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      }),
      body: JSON.stringify(body),
    };
    if (options.signal) init.signal = options.signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      throw new RouterClientError(`Provider request failed with ${response.status}`, response.status, await response.text());
    }
    return response;
  }
}

/** Native Ollama `/api/chat` transport used when its OpenAI-compatible stream is unavailable or malformed. */
export class OllamaNativeChatClient {
  readonly #provider: ProviderTransportInfo;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: RouterClientOptions) {
    this.#provider = options.provider;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *stream(options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    const nativeBase = new URL(this.#provider.baseUrl);
    nativeBase.pathname = nativeBase.pathname.replace(/\/?v1\/?$/, "/");
    const url = new URL("api/chat", nativeBase);
    const body: Record<string, unknown> = {
      model: options.model ?? this.#provider.defaultModel,
      messages: options.messages.map(serializeOllamaMessage),
      stream: true,
    };
    if (options.tools?.length) body.tools = options.tools;
    if (options.temperature !== undefined || options.maxTokens !== undefined) {
      body.options = {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
      };
    }
    if (options.reasoningEffort) body.think = options.reasoningEffort === "minimal" ? "low" : options.reasoningEffort;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: buildHeaders(this.#provider, this.#apiKey),
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new RouterClientError(`Ollama native chat failed with ${response.status}`, response.status, await response.text());
    }
    let sequence = 0;
    for await (const value of parseNdjson(response)) {
      const payload = value as OllamaChatChunk;
      if (payload.error) throw new RouterClientError(`Ollama native chat failed: ${payload.error}`);
      const toolCalls = payload.message?.tool_calls?.map((call, index) => ({
        index,
        id: call.id ?? `ollama_call_${index}`,
        function: {
          name: call.function?.name ?? "",
          arguments:
            typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        },
      }));
      const promptTokens = typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : 0;
      const outputTokens = typeof payload.eval_count === "number" ? payload.eval_count : 0;
      yield {
        id: `ollama_${sequence++}`,
        model: payload.model ?? options.model ?? this.#provider.defaultModel,
        delta: payload.message?.content ?? "",
        ...(payload.message?.thinking ? { reasoningDelta: payload.message.thinking } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
        finishReason: payload.done ? (toolCalls?.length ? "tool_calls" : payload.done_reason ?? "stop") : null,
        ...(payload.done
          ? { usage: { inputTokens: promptTokens, outputTokens, totalTokens: promptTokens + outputTokens } }
          : {}),
        raw: payload as unknown as JsonValue,
      };
    }
  }
}

/** Back-compat alias: the pre-transport-split client name. */
export const OpenRouterCompatibleClient = OpenAIChatCompletionsClient;
export type OpenRouterCompatibleClient = OpenAIChatCompletionsClient;

/**
 * Thin OpenAI Responses transport: POSTs a caller-built `/responses` body with
 * `stream: true` and yields the parsed SSE event objects. Request/stream
 * semantics (input items, function_call parsing) live in the local-agent
 * adapter, keeping this a pure wire client.
 */
export class OpenAIResponsesClient {
  readonly #provider: ProviderTransportInfo;
  readonly #apiKey: string | undefined;
  readonly #appName: string;
  readonly #fetch: typeof fetch;

  constructor(options: RouterClientOptions) {
    this.#provider = options.provider;
    this.#apiKey = options.apiKey;
    this.#appName = options.appName ?? "Berry Desktop";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *streamEvents(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const url = requestUrl(this.#provider, this.#provider.endpointPath ?? "/responses");
    const init: RequestInit = {
      method: "POST",
      headers: buildHeaders(this.#provider, this.#apiKey, { appName: this.#appName }),
      body: JSON.stringify({ ...body, model: body.model ?? this.#provider.defaultModel, stream: true }),
    };
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      throw new RouterClientError(`Provider request failed with ${response.status}`, response.status, await response.text());
    }
    const requestedModel = typeof body.model === "string" ? body.model : this.#provider.defaultModel;
    const headerUsage = normalizeUsageHeaders(response.headers);
    for await (const event of parseSse(response)) {
      if (event === "[DONE]") break;
      const payload = JSON.parse(event) as Record<string, unknown>;
      const attribution = routerAttribution(this.#provider, requestedModel, response.headers, payload);
      if (attribution) {
        payload[BERRY_ROUTER_METADATA_KEY] = {
          attribution,
          ...(headerUsage ? { usage: headerUsage } : {}),
        } satisfies BerryRouterStreamMetadata;
      }
      yield payload;
    }
  }

  async compact(body: Record<string, unknown>, signal?: AbortSignal): Promise<ResponsesCompactionResult> {
    const url = requestUrl(this.#provider, responsesCompactPath(this.#provider.endpointPath ?? "/responses"));
    const init: RequestInit = {
      method: "POST",
      headers: buildHeaders(this.#provider, this.#apiKey, { appName: this.#appName }),
      body: JSON.stringify({ ...body, model: body.model ?? this.#provider.defaultModel }),
    };
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      throw new RouterClientError(`Provider compact request failed with ${response.status}`, response.status, await response.text());
    }
    const payload = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(payload.output) || !payload.output.every(isRecord)) {
      throw new RouterClientError("Provider compact response did not include an output item array", response.status, JSON.stringify(payload));
    }
    const result: ResponsesCompactionResult = {
      output: payload.output,
      raw: payload as unknown as JsonValue,
    };
    if (typeof payload.id === "string") result.id = payload.id;
    if (typeof payload.object === "string") result.object = payload.object;
    if (isRecord(payload.usage)) result.usage = payload.usage;
    return result;
  }

  async listModels(): Promise<RemoteModel[]> {
    return listProviderModels({ provider: this.#provider, apiKey: this.#apiKey, appName: this.#appName, fetchImpl: this.#fetch });
  }
}

/**
 * Thin Anthropic Messages transport: POSTs a caller-built `/messages` body
 * with `stream: true` and yields parsed SSE event objects (`message_start`,
 * `content_block_delta`, ... plus `ping`/unknown events the adapter tolerates).
 */
export class AnthropicMessagesClient {
  readonly #provider: ProviderTransportInfo;
  readonly #apiKey: string | undefined;
  readonly #appName: string;
  readonly #fetch: typeof fetch;

  constructor(options: RouterClientOptions) {
    this.#provider = { authType: "x-api-key", ...options.provider };
    this.#apiKey = options.apiKey;
    this.#appName = options.appName ?? "Berry Desktop";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *streamEvents(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const url = requestUrl(this.#provider, this.#provider.endpointPath ?? "/messages");
    const init: RequestInit = {
      method: "POST",
      headers: buildHeaders(this.#provider, this.#apiKey, { appName: this.#appName }),
      body: JSON.stringify({ ...body, model: body.model ?? this.#provider.defaultModel, stream: true }),
    };
    if (signal) init.signal = signal;
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      throw new RouterClientError(`Provider request failed with ${response.status}`, response.status, await response.text());
    }
    for await (const event of parseSse(response)) {
      if (event === "[DONE]") break;
      yield JSON.parse(event) as Record<string, unknown>;
    }
  }

  async listModels(): Promise<RemoteModel[]> {
    return listProviderModels({ provider: this.#provider, apiKey: this.#apiKey, appName: this.#appName, fetchImpl: this.#fetch });
  }
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name) wire.name = message.name;
  if (message.toolCallId) wire.tool_call_id = message.toolCallId;
  if (message.toolCalls && message.toolCalls.length > 0) wire.tool_calls = message.toolCalls;
  return wire;
}

function serializeOllamaMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role };
  if (Array.isArray(message.content)) {
    wire.content = message.content
      .filter((part): part is Extract<ChatContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const images = message.content.flatMap((part) =>
      part.type === "image_url" ? [part.image_url.url.replace(/^data:[^,]+,/, "")] : [],
    );
    if (images.length) wire.images = images;
  } else {
    wire.content = message.content ?? "";
  }
  if (message.toolCalls?.length) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      function: {
        name: call.function.name,
        arguments: parseJsonObject(call.function.arguments),
      },
    }));
  }
  if (message.toolCallId) wire.tool_call_id = message.toolCallId;
  if (message.name) wire.tool_name = message.name;
  return wire;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function* parseSse(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = parseSseDataBlock(block);
      if (data !== undefined) yield data;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const data = parseSseDataBlock(buffer);
  if (data !== undefined) yield data;
}

export async function* parseNdjson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
}

function parseSseDataBlock(block: string): string | undefined {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return undefined;
  return lines.map((line) => line.slice(5).trimStart()).join("\n");
}

function throwForOpenAIStreamError(payload: unknown, response: Response, providerName: string): void {
  if (!isRecord(payload) || !isRecord(payload.error)) return;
  const message = stringField(payload.error, "message") ?? "The provider stream failed";
  const requestId = stringField(payload, "request_id") ?? response.headers.get("x-request-id")?.trim();
  throw new RouterClientError(
    `${providerName} stream failed${requestId ? ` (request ${requestId})` : ""}: ${message}`,
    numberField(payload.error, "status") ?? 502,
    JSON.stringify(payload),
  );
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function responsesCompactPath(endpointPath: string): string {
  const withSlash = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const normalized = withSlash.replace(/\/+$/, "");
  if (normalized.endsWith("/compact")) return normalized;
  return `${normalized}/compact`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip anything key-shaped from provider error text before it can surface. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/x-api-key["':\s]+[\w-]+/gi, "x-api-key [redacted]")
    .replace(/([?&](?:key|apiKey|api_key|token|secret)=)[^&\s"']+/gi, "$1[redacted]");
}

function usesOpenRouterReasoningShape(provider: ProviderTransportInfo): boolean {
  if (provider.kind === "berry-router") return true;
  return provider.baseUrl.toLowerCase().includes("openrouter.ai");
}

function normalizeUsage(usage: OpenAIUsage | undefined): ChatCompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

function normalizeUsageHeaders(headers: Headers): ChatCompletionUsage | undefined {
  const inputTokens = numericHeader(headers, ["x-berry-usage-input-tokens", "x-router-usage-input-tokens", "x-usage-input-tokens"]);
  const outputTokens = numericHeader(headers, ["x-berry-usage-output-tokens", "x-router-usage-output-tokens", "x-usage-output-tokens"]);
  const totalTokens = numericHeader(headers, ["x-berry-usage-total-tokens", "x-router-usage-total-tokens", "x-usage-total-tokens"]);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return { inputTokens: input, outputTokens: output, totalTokens: totalTokens ?? input + output };
}

function routerAttribution(
  provider: ProviderTransportInfo,
  requestedModel: string,
  headers: Headers,
  payload?: Record<string, unknown>,
): RouterAttribution | undefined {
  if (provider.kind !== "berry-router") return undefined;
  const metadata = isRecord(payload?.metadata) ? payload.metadata : undefined;
  const routing = isRecord(payload?.routing) ? payload.routing : undefined;
  const servedProvider = firstString([
    headerValue(headers, ["x-berry-served-provider", "x-router-served-provider", "x-router-provider"]),
    stringField(payload, "served_provider"),
    stringField(metadata, "served_provider"),
    stringField(metadata, "provider"),
    stringField(routing, "provider"),
  ]);
  const responseModel = stringField(payload, "model");
  const servedModel = firstString([
    headerValue(headers, ["x-berry-served-model", "x-router-served-model", "x-router-model"]),
    stringField(payload, "served_model"),
    stringField(metadata, "served_model"),
    stringField(routing, "model"),
    responseModel && responseModel !== requestedModel ? responseModel : undefined,
  ]);
  return { requestedModel, ...(servedProvider ? { servedProvider } : {}), ...(servedModel ? { servedModel } : {}) };
}

function normalizeRouterAccount(value: unknown): RouterAccount {
  if (!isRecord(value)) throw new RouterClientError("Berry Router account response was not an object");
  const account = isRecord(value.account) ? value.account : value;
  const quota = isRecord(value.quota) ? value.quota : isRecord(account.quota) ? account.quota : {};
  const usage = isRecord(value.usage) ? value.usage : isRecord(account.usage) ? account.usage : {};
  const id = stringField(account, "id") ?? stringField(account, "account_id");
  if (!id) throw new RouterClientError("Berry Router account response did not include an account id");
  const limit = numberField(quota, "limit") ?? numberField(quota, "limit_amount") ?? null;
  const used = numberField(quota, "used") ?? numberField(usage, "amount") ?? numberField(usage, "used") ?? 0;
  const remaining = numberField(quota, "remaining") ?? (limit === null ? null : Math.max(0, limit - used));
  const aliasesValue = value.aliases ?? account.aliases;
  const aliases = Array.isArray(aliasesValue)
    ? aliasesValue.flatMap((entry) => typeof entry === "string" ? [entry] : isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])
    : [];
  return {
    id,
    email: stringField(account, "email") ?? null,
    displayName: stringField(account, "display_name") ?? stringField(account, "name") ?? null,
    plan: stringField(account, "plan") ?? stringField(account, "plan_name") ?? "unknown",
    quota: {
      limit,
      used,
      remaining,
      unit: stringField(quota, "unit") ?? stringField(usage, "unit") ?? "requests",
      resetsAt: stringField(quota, "resets_at") ?? stringField(quota, "reset_at") ?? null,
    },
    aliases,
  };
}

function headerValue(headers: Headers, names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function numericHeader(headers: Headers, names: string[]): number | undefined {
  const value = headerValue(headers, names);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].trim().length > 0 ? value[key].trim() : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
}

function firstString(values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function normalizeProviderModelCapabilities(
  value: ProviderModelEntry["capabilities"],
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): RemoteModel["capabilities"] | undefined {
  const vision = capabilitySupported(value?.image_input);
  const reasoning = capabilitySupported(value?.thinking) ?? capabilitySupported(value?.effort);
  const json = capabilitySupported(value?.structured_outputs);
  if (vision === undefined && reasoning === undefined && json === undefined && !contextWindow && !maxOutputTokens) return undefined;
  return {
    ...(vision !== undefined ? { vision } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(json !== undefined ? { json } : {}),
    ...((contextWindow || maxOutputTokens) ? {
      context: {
        ...(contextWindow ? { windowTokens: contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
    } : {}),
  };
}

function capabilitySupported(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.supported === "boolean" ? value.supported : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeToolCalls(toolCalls: OpenAIToolCall[] | undefined): ChatToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((call, index) => ({
    id: call.id ?? `call_${index}`,
    type: "function" as const,
    function: {
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "",
    },
  }));
}

/**
 * Some OpenAI-compatible Kimi hosts return the model's documented tool-call
 * control tokens as message text instead of translating them to `tool_calls`.
 * Normalize only complete, valid blocks so malformed model output remains
 * visible rather than being silently discarded.
 */
export function parseKimiToolCalls(content: string): { content: string; toolCalls: ChatToolCall[] } | undefined {
  const sectionStart = "<|tool_calls_section_begin|>";
  const sectionEnd = "<|tool_calls_section_end|>";
  const callStart = "<|tool_call_begin|>";
  const argumentStart = "<|tool_call_argument_begin|>";
  const callEnd = "<|tool_call_end|>";
  if (!content.includes(sectionStart)) return undefined;

  const toolCalls: ChatToolCall[] = [];
  let visible = "";
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(sectionStart, cursor);
    if (start === -1) {
      visible += content.slice(cursor);
      break;
    }
    const end = content.indexOf(sectionEnd, start + sectionStart.length);
    if (end === -1) return undefined;
    visible += content.slice(cursor, start);
    const section = content.slice(start + sectionStart.length, end);
    let sectionCursor = 0;
    let sectionCalls = 0;
    while (sectionCursor < section.length) {
      const begin = section.indexOf(callStart, sectionCursor);
      if (begin === -1) {
        if (section.slice(sectionCursor).trim()) return undefined;
        break;
      }
      if (section.slice(sectionCursor, begin).trim()) return undefined;
      const argument = section.indexOf(argumentStart, begin + callStart.length);
      const finish = argument === -1 ? -1 : section.indexOf(callEnd, argument + argumentStart.length);
      if (argument === -1 || finish === -1) return undefined;
      const rawId = section.slice(begin + callStart.length, argument).trim();
      const rawArguments = section.slice(argument + argumentStart.length, finish).trim();
      const idMatch = /^functions\.([A-Za-z0-9_-]+)(?::\d+)?$/.exec(rawId);
      if (!idMatch) return undefined;
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      } catch {
        return undefined;
      }
      toolCalls.push({
        id: rawId,
        type: "function",
        function: { name: idMatch[1] ?? "", arguments: rawArguments },
      });
      sectionCalls += 1;
      sectionCursor = finish + callEnd.length;
    }
    if (sectionCalls === 0) return undefined;
    cursor = end + sectionEnd.length;
  }
  return toolCalls.length > 0 ? { content: visible.trimEnd(), toolCalls } : undefined;
}

function normalizeToolCallDeltas(deltas: OpenAIToolCallDelta[] | undefined): ChatToolCallDelta[] | undefined {
  if (!deltas || deltas.length === 0) return undefined;
  return deltas.map((delta, position) => {
    const normalized: ChatToolCallDelta = { index: delta.index ?? position };
    if (typeof delta.id === "string" && delta.id.length > 0) normalized.id = delta.id;
    if (delta.function) {
      const fn: { name?: string; arguments?: string } = {};
      if (typeof delta.function.name === "string") fn.name = delta.function.name;
      if (typeof delta.function.arguments === "string") fn.arguments = delta.function.arguments;
      normalized.function = fn;
    }
    return normalized;
  });
}

interface ProviderModelEntry {
  id?: string;
  owned_by?: string;
  display_name?: string;
  context_length?: number;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: {
    image_input?: { supported?: boolean };
    thinking?: { supported?: boolean };
    effort?: { supported?: boolean };
    structured_outputs?: { supported?: boolean };
  };
  object?: string;
  created?: number;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAICompletionResponse {
  id: string;
  model?: string;
  choices: Array<{
    finish_reason?: string | null;
    message?: { content?: string; reasoning?: string; reasoning_content?: string; tool_calls?: OpenAIToolCall[] };
  }>;
  usage?: OpenAIUsage;
}

interface OpenAIStreamResponse {
  id: string;
  model?: string;
  choices: Array<{
    finish_reason?: string | null;
    delta?: { content?: string; reasoning?: string; reasoning_content?: string; tool_calls?: OpenAIToolCallDelta[] };
  }>;
  usage?: OpenAIUsage;
}
