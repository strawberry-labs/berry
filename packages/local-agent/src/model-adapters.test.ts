import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { BERRY_ROUTER_METADATA_KEY, RouterClientError } from "@berry/router-client";
import { describe, expect, it } from "vitest";
import {
  AnthropicMessagesAdapter,
  BerryModelAdapter,
  contextToAnthropicMessages,
  contextToResponsesInput,
  createBerryModel,
  createProviderStreamFn,
  FallbackChatCompletionClient,
  OpenAIResponsesAdapter,
  providerErrorFromAssistantMessage,
  routerRequestIdFromAssistantMessage,
} from "./model.ts";
import { joinStableAndDynamicPrompt } from "./prompt-cache.ts";

const responsesProvider = {
  id: "provider_openai",
  baseUrl: "http://localhost/v1",
  defaultModel: "gpt-test",
  kind: "openai",
  name: "OpenAI",
  apiType: "openai-responses" as const,
  endpointPath: "/responses",
  authType: "bearer" as const,
};

const anthropicProvider = {
  id: "provider_anthropic",
  baseUrl: "http://localhost/v1",
  defaultModel: "claude-test",
  kind: "anthropic",
  name: "Anthropic",
  apiType: "anthropic-messages" as const,
  endpointPath: "/messages",
  authType: "x-api-key" as const,
};

function fakeClient(events: Array<Record<string, unknown>>, capture?: { body?: Record<string, unknown>; metadata?: Record<string, string> }) {
  return {
    async *streamEvents(body: Record<string, unknown>, _signal?: AbortSignal, metadata?: Record<string, string>): AsyncGenerator<Record<string, unknown>> {
      if (capture) {
        capture.body = body;
        if (metadata) capture.metadata = metadata;
      }
      for (const event of events) yield event;
    },
  };
}

async function collect(stream: ReturnType<OpenAIResponsesAdapter["stream"]>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of await stream) events.push(event);
  return events;
}

describe("OpenAIResponsesAdapter", () => {
  it("forwards only the durable provider idempotency header", async () => {
    const capture: { body?: Record<string, unknown>; metadata?: Record<string, string> } = {};
    const adapter = new OpenAIResponsesAdapter({
      client: fakeClient([{ type: "response.completed", response: {} }], capture),
    });

    await collect(adapter.stream(
      createBerryModel(responsesProvider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { metadata: { "Idempotency-Key": "durable-step", internal: "not-a-header" } },
    ));

    expect(capture.metadata).toEqual({ "Idempotency-Key": "durable-step" });
  });

  it("sends declared OpenAI cache controls and omits them when unsupported", async () => {
    const supportedCapture: { body?: Record<string, unknown> } = {};
    const supportedProvider = {
      ...responsesProvider,
      capabilities: {
        promptCaching: {
          supported: true,
          cacheKey: true,
          cacheControl: false,
          retention: ["short", "long"] as Array<"short" | "long">,
          minimumTokens: 0,
        },
      },
    };
    const supported = new OpenAIResponsesAdapter({
      client: fakeClient([{ type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 1 } } }], supportedCapture),
      promptCache: { namespace: "tenant_1", provider: supportedProvider },
    });
    await collect(supported.stream(
      createBerryModel(supportedProvider),
      { systemPrompt: "stable", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { cacheRetention: "long", sessionId: "session_1" },
    ));
    expect(supportedCapture.body).toMatchObject({
      prompt_cache_key: expect.stringMatching(/^berry_[a-f0-9]{64}$/),
      prompt_cache_retention: "24h",
    });

    const unsupportedCapture: { body?: Record<string, unknown> } = {};
    const unsupported = new OpenAIResponsesAdapter({
      client: fakeClient([{ type: "response.completed", response: {} }], unsupportedCapture),
    });
    await collect(unsupported.stream(
      createBerryModel(responsesProvider),
      { systemPrompt: "stable", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { cacheRetention: "long", sessionId: "session_1" },
    ));
    expect(unsupportedCapture.body?.prompt_cache_key).toBeUndefined();
    expect(unsupportedCapture.body?.prompt_cache_retention).toBeUndefined();
  });

  it("maps reasoning effort to the Responses reasoning object", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new OpenAIResponsesAdapter({
      client: fakeClient([{ type: "response.completed", response: {} }], capture),
    });
    const model = createBerryModel(
      { ...responsesProvider, models: [{ id: "gpt-test", capabilities: { reasoning: true } }] },
      undefined,
      { reasoning: true },
    );
    await collect(adapter.stream(model, { messages: [{ role: "user", content: "think", timestamp: 1 }] }, { reasoning: "high" }));
    expect(capture.body?.reasoning).toEqual({ effort: "high" });
  });

  it("maps output text deltas and usage onto pi-ai events", async () => {
    const adapter = new OpenAIResponsesAdapter({
      client: fakeClient([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: "hel" },
        { type: "response.output_text.delta", delta: "lo" },
        { type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } },
      ]),
    });
    const model = createBerryModel(responsesProvider);
    const events = await collect(adapter.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, undefined));
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("stop");
    expect(done.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(done.message.usage).toMatchObject({ input: 7, output: 2, totalTokens: 9 });
    expect(model.api).toBe("openai-responses");
  });

  it("assembles streamed function calls into a completed ToolCall", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new OpenAIResponsesAdapter({
      client: fakeClient(
        [
          { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_7", name: "grep", arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"pattern":' },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"berry"}' },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_7", name: "grep", arguments: '{"pattern":"berry"}' } },
          { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ],
        capture,
      ),
    });
    const context: Context = {
      systemPrompt: "You are Berry.",
      messages: [{ role: "user", content: "search", timestamp: 1 }],
      tools: [{ name: "grep", description: "Search", parameters: { type: "object" } as never }],
    };
    const events = await collect(adapter.stream(createBerryModel(responsesProvider), context, undefined));
    expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("toolUse");
    expect(done.message.content[0]).toEqual({ type: "toolCall", id: "call_7", name: "grep", arguments: { pattern: "berry" } });
    expect(capture.body).toMatchObject({ store: false, instructions: "You are Berry." });
    expect(capture.body?.tools).toEqual([{ type: "function", name: "grep", description: "Search", parameters: { type: "object" } }]);
  });

  it("converts tool results to function_call_output input items", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "list files", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "list_dir", arguments: { path: "." } }],
          api: "openai-responses",
          provider: "p",
          model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "list_dir", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 },
      ],
    };
    const items = contextToResponsesInput(context);
    expect(items).toEqual([
      { role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call", call_id: "call_1", name: "list_dir", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
    ]);
  });

  it("passes remote compaction output items through unchanged", () => {
    const compactItems = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "short state" }] },
      { type: "compaction", encrypted_content: "opaque" },
    ];
    const context = {
      messages: [
        { role: "responsesRawItems", items: compactItems, fallbackSummary: "fallback summary", timestamp: 1 },
        { role: "user", content: "continue", timestamp: 2 },
      ],
    } as unknown as Context;

    expect(contextToResponsesInput(context)).toEqual([
      ...compactItems,
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]);
    expect(contextToAnthropicMessages(context)[0]).toEqual({ role: "user", content: [{ type: "text", text: "fallback summary" }] });
  });

  it("surfaces response.failed as an error event with redacted text", async () => {
    const adapter = new OpenAIResponsesAdapter({
      client: fakeClient([{
        type: "response.failed",
        response: { error: { message: "denied for Bearer sk-secret-123", type: "invalid_request_error" } },
        [BERRY_ROUTER_METADATA_KEY]: { requestId: "responses-request-failed" },
      }]),
    });
    const events = await collect(adapter.stream(createBerryModel(responsesProvider), { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, undefined));
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error event");
    expect(last.error.errorMessage).not.toContain("sk-secret-123");
    expect(providerErrorFromAssistantMessage(last.error)).toMatchObject({
      name: "RouterClientError",
      status: 400,
      code: "invalid_request_error",
      requestId: "responses-request-failed",
    });
  });

  it("infers a permanent status from the error type when a specific code is also present", async () => {
    const adapter = new OpenAIResponsesAdapter({
      client: fakeClient([{
        type: "response.failed",
        response: {
          error: {
            message: "the prompt was rejected",
            code: "invalid_prompt",
            type: "invalid_request_error",
          },
        },
        [BERRY_ROUTER_METADATA_KEY]: { requestId: "responses-invalid-prompt" },
      }]),
    });
    const events = await collect(adapter.stream(
      createBerryModel(responsesProvider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      undefined,
    ));
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error event");
    expect(providerErrorFromAssistantMessage(last.error)).toMatchObject({
      name: "RouterClientError",
      status: 400,
      code: "invalid_prompt",
      requestId: "responses-invalid-prompt",
    });
  });

  it("preserves the original Responses transport error and successful identifiers", async () => {
    const failure = new RouterClientError("temporarily unavailable", 503, "sensitive", {
      code: "upstream_unavailable",
      requestId: "responses-request-503",
    });
    const failing = new OpenAIResponsesAdapter({
      client: {
        async *streamEvents(): AsyncGenerator<Record<string, unknown>> {
          throw failure;
        },
      },
    });
    const failedEvents = await collect(failing.stream(
      createBerryModel(responsesProvider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      undefined,
    ));
    const failed = failedEvents.at(-1);
    if (failed?.type !== "error") throw new Error("expected error event");
    expect(providerErrorFromAssistantMessage(failed.error)).toBe(failure);

    const successful = new OpenAIResponsesAdapter({
      client: fakeClient([{
        type: "response.completed",
        response: { id: "resp-success", model: "gpt-served" },
        [BERRY_ROUTER_METADATA_KEY]: { requestId: "responses-request-success" },
      }]),
    });
    const successEvents = await collect(successful.stream(
      createBerryModel(responsesProvider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      undefined,
    ));
    const success = successEvents.at(-1);
    if (success?.type !== "done") throw new Error("expected done event");
    expect(success.message).toMatchObject({ responseId: "resp-success", responseModel: "gpt-served" });
    expect(routerRequestIdFromAssistantMessage(success.message)).toBe("responses-request-success");
  });
});

describe("BerryModelAdapter", () => {
  it("passes the durable idempotency key into Chat Completions transport options", async () => {
    let metadata: Record<string, string> | undefined;
    const adapter = new BerryModelAdapter({
      client: {
        async *stream(options: import("@berry/router-client").ChatCompletionOptions) {
          metadata = options.metadata;
          yield { id: "chat-1", model: "chat-test", delta: "ok", finishReason: "stop", raw: {} };
        },
      },
    });
    const provider = {
      ...responsesProvider,
      apiType: "openai-chat-completions" as const,
      defaultModel: "chat-test",
    };

    await collect(adapter.stream(
      createBerryModel(provider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { metadata: { "Idempotency-Key": "chat-durable-step" } },
    ));

    expect(metadata).toEqual({ "Idempotency-Key": "chat-durable-step" });
  });
});

describe("Ollama adapter", () => {
  it("falls back to native chat only when the compatibility stream emits nothing", async () => {
    const primary = {
      async *stream(): AsyncGenerator<never> {
        throw new Error("malformed compatibility stream");
      },
    };
    const fallback = {
      async *stream() {
        yield { id: "native", model: "qwen3:8b", delta: "native", finishReason: "stop", raw: {} };
      },
    };
    const client = new FallbackChatCompletionClient(primary, fallback);
    const chunks = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.delta)).toEqual(["native"]);
  });

  it("omits tools for a model whose native capabilities reject tool calling", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"id":"1","model":"gemma3","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const provider = {
        id: "ollama",
        baseUrl: "http://localhost:11434/v1",
        defaultModel: "gemma3",
        kind: "ollama",
        name: "Ollama",
        apiType: "openai-chat-completions" as const,
        authType: "none" as const,
        models: [{ id: "gemma3", capabilities: { tools: false, vision: true } }],
      };
      const model = createBerryModel(provider);
      const stream = createProviderStreamFn(provider, undefined)(
        model,
        {
          messages: [{ role: "user", content: "hi", timestamp: 1 }],
          tools: [{ name: "bash", description: "Run", parameters: { type: "object" } }],
        },
        undefined,
      );
      await (await stream).result();
      expect(requestBody.tools).toBeUndefined();
      expect(model.input).toContain("image");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AnthropicMessagesAdapter", () => {
  it("preserves the original Anthropic transport error and successful identifiers", async () => {
    const failure = new RouterClientError("rate limited", 429, "sensitive", {
      code: "rate_limit_error",
      requestId: "anthropic-request-429",
    });
    const failing = new AnthropicMessagesAdapter({
      client: {
        async *streamEvents(): AsyncGenerator<Record<string, unknown>> {
          throw failure;
        },
      },
    });
    const failedEvents = await collect(failing.stream(
      createBerryModel(anthropicProvider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      undefined,
    ));
    const failed = failedEvents.at(-1);
    if (failed?.type !== "error") throw new Error("expected error event");
    expect(providerErrorFromAssistantMessage(failed.error)).toBe(failure);

    const successful = new AnthropicMessagesAdapter({
      client: fakeClient([{
        type: "message_start",
        message: { id: "msg-success", model: "claude-served", usage: { input_tokens: 1 } },
        [BERRY_ROUTER_METADATA_KEY]: { requestId: "anthropic-request-success" },
      }, {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
        [BERRY_ROUTER_METADATA_KEY]: { requestId: "anthropic-request-success" },
      }]),
    });
    const successEvents = await collect(successful.stream(
      createBerryModel(anthropicProvider),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      undefined,
    ));
    const success = successEvents.at(-1);
    if (success?.type !== "done") throw new Error("expected done event");
    expect(success.message).toMatchObject({ responseId: "msg-success", responseModel: "claude-served" });
    expect(routerRequestIdFromAssistantMessage(success.message)).toBe("anthropic-request-success");
  });

  it("marks stable Anthropic blocks cacheable but leaves dynamic grounding unmarked", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const provider = {
      ...anthropicProvider,
      capabilities: {
        promptCaching: {
          supported: true,
          cacheKey: false,
          cacheControl: true,
          retention: ["short", "long"] as Array<"short" | "long">,
          minimumTokens: 0,
        },
      },
    };
    const adapter = new AnthropicMessagesAdapter({
      client: fakeClient([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 20,
              cache_read_input_tokens: 12,
              cache_creation_input_tokens: 8,
              cache_creation: { ephemeral_1h_input_tokens: 8, ephemeral_5m_input_tokens: 0 },
            },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ], capture),
      promptCache: { namespace: "tenant_1", provider },
    });
    const prompt = joinStableAndDynamicPrompt("stable system", "retrieved memory");
    const events = await collect(adapter.stream(
      createBerryModel(provider),
      {
        systemPrompt: prompt,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } as never }],
      },
      { cacheRetention: "long", sessionId: "session_1" },
    ));
    const system = capture.body?.system as Array<Record<string, unknown>>;
    expect(system[0]).toMatchObject({ text: "stable system", cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(system[1]).toEqual({ type: "text", text: "retrieved memory" });
    const tools = capture.body?.tools as Array<Record<string, unknown>>;
    expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.message.usage).toMatchObject({ cacheRead: 12, cacheWrite: 8 });
  });

  it("maps reasoning effort to an Anthropic thinking budget", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new AnthropicMessagesAdapter({ client: fakeClient([{ type: "message_stop" }], capture) });
    const model = createBerryModel(
      { ...anthropicProvider, models: [{ id: "claude-test", capabilities: { reasoning: true } }] },
      undefined,
      { reasoning: true },
    );
    await collect(adapter.stream(model, { messages: [{ role: "user", content: "think", timestamp: 1 }] }, { reasoning: "medium" }));
    expect(capture.body?.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("maps text streaming, system prompt placement, and stop reasons", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new AnthropicMessagesAdapter({
      client: fakeClient(
        [
          { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "ping" },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ],
        capture,
      ),
    });
    const context: Context = { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] };
    const events = await collect(adapter.stream(createBerryModel(anthropicProvider), context, undefined));
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("stop");
    expect(done.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(done.message.usage).toMatchObject({ input: 5, output: 2, totalTokens: 7 });
    expect(capture.body?.system).toBe("sys");
    const messages = capture.body?.messages as Array<Record<string, unknown>>;
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(typeof capture.body?.max_tokens).toBe("number");
  });

  it("accumulates partial JSON tool input into a completed tool_use call", async () => {
    const adapter = new AnthropicMessagesAdapter({
      client: fakeClient([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "grep" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"berry"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ]),
    });
    const events = await collect(adapter.stream(createBerryModel(anthropicProvider), { messages: [{ role: "user", content: "go", timestamp: 1 }] }, undefined));
    expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("toolUse");
    expect(done.message.content[0]).toEqual({ type: "toolCall", id: "toolu_1", name: "grep", arguments: { pattern: "berry" } });
  });

  it("maps thinking deltas onto pi-ai thinking events and max_tokens onto length", async () => {
    const adapter = new AnthropicMessagesAdapter({
      client: fakeClient([
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "partial answer" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]),
    });
    const events = await collect(adapter.stream(createBerryModel(anthropicProvider), { messages: [{ role: "user", content: "think", timestamp: 1 }] }, undefined));
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("length");
    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "partial answer" },
    ]);
  });

  it("converts tool results into merged tool_result user messages", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "run both", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running." },
            { type: "toolCall", id: "toolu_a", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "toolu_b", name: "bash", arguments: { command: "pwd" } },
          ],
          api: "anthropic-messages",
          provider: "p",
          model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "toolu_a", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 },
        { role: "toolResult", toolCallId: "toolu_b", toolName: "bash", content: [{ type: "text", text: "/tmp" }], isError: true, timestamp: 4 },
      ],
    };
    const messages = contextToAnthropicMessages(context);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "run both" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running." },
          { type: "tool_use", id: "toolu_a", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_b", name: "bash", input: { command: "pwd" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "a.txt" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "/tmp", is_error: true },
        ],
      },
    ]);
  });
});

describe("createProviderStreamFn", () => {
  it("does not require an API key for keyless local providers", () => {
    const local = {
      id: "ollama",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "llama3",
      kind: "local",
      name: "Ollama",
      authType: "none" as const,
    };
    expect(() => createProviderStreamFn(local, undefined)).not.toThrow();
    expect(typeof createProviderStreamFn(local, undefined)).toBe("function");
  });

  it("selects the adapter matching the provider apiType", () => {
    expect(typeof createProviderStreamFn(responsesProvider, "sk")).toBe("function");
    expect(typeof createProviderStreamFn(anthropicProvider, "ak")).toBe("function");
  });
});
