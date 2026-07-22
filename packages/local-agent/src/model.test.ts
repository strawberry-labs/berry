import { OpenRouterCompatibleClient } from "@berry/router-client";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BerryModelAdapter, BufferedChatCompletionClient, ContentFallbackChatCompletionClient, contextForModelCapabilities, contextToChatMessages, createBerryModel, createBerryModels } from "./model.ts";

const provider = {
  id: "provider_test",
  baseUrl: "http://localhost/api/v1",
  defaultModel: "test-model",
  kind: "openrouter-compatible" as const,
  name: "Test",
};

function sseResponse(events: string[]): Response {
  const body = `${events.map((event) => `data: ${event}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function clientFor(events: string[], capture?: { body?: Record<string, unknown> }): OpenRouterCompatibleClient {
  return new OpenRouterCompatibleClient({
    provider,
    apiKey: "secret-key",
    fetchImpl: async (_url, init) => {
      if (capture) capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(events);
    },
  });
}

async function collect(adapter: BerryModelAdapter, context: Context, model = createBerryModel(provider)): Promise<AssistantMessageEvent[]> {
  const stream = adapter.stream(model, context, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const event of await stream) events.push(event);
  return events;
}

describe("BerryModelAdapter", () => {
  it("replays buffered reasoning, text, and tool calls through the stream adapter", async () => {
    const buffered = new BufferedChatCompletionClient({
      async complete() {
        return {
          id: "buffered_1",
          model: "test-model",
          reasoning: "checked the request",
          content: "",
          toolCalls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"news"}' } }],
          finishReason: "tool_calls",
          usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          raw: {},
        };
      },
      async *stream() {
        throw new Error("the SSE lane must not be used");
      },
    });
    const events = await collect(
      new BerryModelAdapter({ client: buffered }),
      { messages: [{ role: "user", content: "find news", timestamp: 1 }] },
      createBerryModel(provider, "test-model", { reasoning: true }),
    );
    expect(events.some((event) => event.type === "thinking_delta" && event.delta === "checked the request")).toBe(true);
    expect(events.some((event) => event.type === "toolcall_end" && event.toolCall.name === "lookup")).toBe(true);
  });

  it("falls back to a buffered completion when streaming fails before its first content chunk", async () => {
    let completed = 0;
    const compatible = {
      async complete() {
        completed += 1;
        return {
          id: "fallback_1",
          model: "test-model",
          content: "recovered",
          finishReason: "stop",
          raw: {},
        };
      },
      async *stream() {
        yield { id: "stream_meta", model: "test-model", delta: "", finishReason: null, raw: {} };
        throw new Error("SSE disconnected");
      },
    };
    const client = new ContentFallbackChatCompletionClient(
      compatible,
      new BufferedChatCompletionClient(compatible),
    );

    const chunks = [];
    for await (const chunk of client.stream({ messages: [] })) chunks.push(chunk);

    expect(completed).toBe(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta).toBe("recovered");
  });

  it("does not replay a buffered completion after streaming emitted a partial chunk", async () => {
    let completed = 0;
    const compatible = {
      async complete() {
        completed += 1;
        return {
          id: "fallback_2",
          model: "test-model",
          content: "duplicate",
          finishReason: "stop",
          raw: {},
        };
      },
      async *stream() {
        yield { id: "stream_1", model: "test-model", delta: "partial", finishReason: null, raw: {} };
        throw new Error("SSE disconnected");
      },
    };
    const client = new ContentFallbackChatCompletionClient(
      compatible,
      new BufferedChatCompletionClient(compatible),
    );

    const consume = async () => {
      for await (const _chunk of client.stream({ messages: [] })) {
        // Consume until the upstream failure is surfaced.
      }
    };

    await expect(consume()).rejects.toThrow("SSE disconnected");
    expect(completed).toBe(0);
  });

  it("resolves manual capability overrides into model limits, costs, and image support", () => {
    const model = createBerryModel(
      {
        ...provider,
        models: [{
          id: "test-model",
          capabilities: {
            vision: true,
            reasoning: true,
            context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
            cost: { input: 1, output: 4 },
          },
          capabilityOverrides: {
            vision: false,
            reasoning: false,
            context: { windowTokens: 128_000 },
            cost: { input: 0.5 },
          },
        }],
      },
      "test-model",
      { forceImages: true, reasoning: true },
    );
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(8_000);
    expect(model.cost).toEqual({ input: 0.5, output: 4, cacheRead: 0, cacheWrite: 0 });
  });

  it("trims tools from every transport context when the selected model rejects tool calling", () => {
    const context: Context = {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [{ name: "bash", description: "Run", parameters: { type: "object" } as never }],
    };
    const gated = contextForModelCapabilities(
      { ...provider, apiType: "anthropic-messages", models: [{ id: "test-model", capabilityOverrides: { tools: false } }] },
      "test-model",
      context,
    );
    expect(gated.tools).toBeUndefined();
    expect(gated.messages).toBe(context.messages);
  });

  it("maps text deltas, usage, and stop reason onto pi-ai events", async () => {
    const adapter = new BerryModelAdapter({
      client: clientFor([
        '{"id":"1","model":"m","choices":[{"delta":{"content":"hel"}}]}',
        '{"id":"1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
      ]),
    });
    const events = await collect(adapter, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("stop");
    expect(done.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(done.message.usage).toMatchObject({ input: 7, output: 2, totalTokens: 9 });
    expect(done.message.stopReason).toBe("stop");
  });

  it("keeps Berry Router alias attribution on the completed assistant message", async () => {
    const adapter = new BerryModelAdapter({
      client: {
        async *stream() {
          yield {
            id: "router_1",
            model: "openai/gpt-4.1-mini",
            delta: "routed",
            finishReason: "stop",
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            attribution: { requestedModel: "berry/fast", servedProvider: "openai", servedModel: "openai/gpt-4.1-mini" },
            raw: {},
          };
        },
      },
    });
    const events = await collect(adapter, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.message).toMatchObject({
      berryRouterAttribution: { requestedModel: "berry/fast", servedProvider: "openai", servedModel: "openai/gpt-4.1-mini" },
    });
  });

  it("assembles streamed tool-call deltas into a completed ToolCall", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new BerryModelAdapter({
      client: clientFor(
        [
          '{"id":"1","model":"m","choices":[{"delta":{"content":"Let me check."}}]}',
          '{"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","function":{"name":"grep","arguments":""}}]}}]}',
          '{"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":\\"berry\\"}"}}]}}]}',
          '{"id":"1","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        ],
        capture,
      ),
    });
    const context: Context = {
      systemPrompt: "You are Berry.",
      messages: [{ role: "user", content: "search", timestamp: 1 }],
      tools: [
        {
          name: "grep",
          description: "Search",
          parameters: { type: "object", properties: { pattern: { type: "string" } } } as never,
        },
      ],
    };
    const events = await collect(adapter, context);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected done event");
    expect(done.reason).toBe("toolUse");
    expect(done.message.content[1]).toEqual({
      type: "toolCall",
      id: "call_7",
      name: "grep",
      arguments: { pattern: "berry" },
    });
    expect(capture.body?.tools).toEqual([
      {
        type: "function",
        function: { name: "grep", description: "Search", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
      },
    ]);
    expect(capture.body?.tool_choice).toBe("auto");
  });

  it("encodes request failures as a final error event instead of throwing", async () => {
    const adapter = new BerryModelAdapter({
      client: new OpenRouterCompatibleClient({
        provider,
        apiKey: "secret-key",
        fetchImpl: async () => new Response("boom", { status: 500 }),
      }),
    });
    const events = await collect(adapter, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error event");
    expect(last.error.stopReason).toBe("error");
    expect(last.error.errorMessage).toContain("500");
  });

  it("converts harness context messages to OpenAI-compatible messages, dropping images with a note", () => {
    const context: Context = {
      systemPrompt: "sys",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data: "aGk=", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.txt" } },
          ],
          api: "openai-completions",
          provider: "berry",
          model: "m",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: [{ type: "text", text: "file body" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const messages = contextToChatMessages(context);
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[1]?.content).toContain("look at this");
    expect(messages[1]?.content).toContain("image attachment(s) omitted");
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    });
    expect(messages[3]).toMatchObject({ role: "tool", toolCallId: "call_1", name: "read_file", content: "file body" });
  });

  it("sends multimodal user content for image-capable models", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new BerryModelAdapter({
      client: clientFor(['{"id":"1","model":"m","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'], capture),
    });
    const model = createBerryModel(provider, "test-vision-model");
    await collect(
      adapter,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", data: "aGk=", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      },
      model,
    );
    expect(capture.body?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        ],
      },
    ]);
  });

  it("sends multimodal user content when images are explicitly forced for the turn", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new BerryModelAdapter({
      client: clientFor(['{"id":"1","model":"m","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'], capture),
    });
    const model = createBerryModel(provider, "unrecognized-model", { forceImages: true });
    await collect(
      adapter,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image", data: "aGk=", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      },
      model,
    );
    expect(capture.body?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        ],
      },
    ]);
  });

  it("maps provider thinking level to OpenAI-compatible reasoning effort", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const adapter = new BerryModelAdapter({
      client: clientFor(['{"id":"1","model":"m","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'], capture),
    });
    const model = createBerryModel(provider, "test-model", { reasoning: true });
    const stream = adapter.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { reasoning: "high" });
    for await (const _event of await stream) {
      // drain
    }
    expect(capture.body?.reasoning_effort).toBe("high");
  });

  it("exposes a Models collection whose completeSimple resolves the final message", async () => {
    const adapter = new BerryModelAdapter({
      client: clientFor(['{"id":"1","model":"m","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}']),
    });
    const model = createBerryModel(provider);
    const models = createBerryModels(adapter.stream, [model]);
    const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(models.getModel(provider.id, "test-model")).toBe(model);
  });
});
