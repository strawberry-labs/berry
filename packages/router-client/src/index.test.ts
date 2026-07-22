import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicMessagesClient,
  BerryRouterAccountClient,
  BERRY_ROUTER_METADATA_KEY,
  buildHeaders,
  OllamaNativeChatClient,
  OpenAIChatCompletionsClient,
  OpenAIImageGenerationClient,
  OpenAIResponsesClient,
  OpenRouterCompatibleClient,
  parseKimiToolCalls,
  type ChatCompletionChunk,
  listProviderModels,
  redactSecrets,
} from "./index.ts";

const berryRouterFixture = JSON.parse(
  readFileSync(new URL("../src/fixtures/berry-router-contract.json", import.meta.url), "utf8"),
) as {
  chat: { response: Record<string, unknown>; headers: Record<string, string> };
  responses: { events: Array<Record<string, unknown>>; headers: Record<string, string> };
  models: { data: Array<Record<string, unknown>> };
  account: Record<string, unknown>;
  oauth: Record<string, unknown>;
};

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}/`;
}

describe("router client", () => {
  it("generates an image through the OpenAI-compatible Image API", async () => {
    const requests: Array<{ path: string; auth: string | null; body: string }> = [];
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        requests.push({ path: request.url ?? "", auth: request.headers.authorization ?? null, body: raw });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          created: 1713833628,
          data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A generated berry" }],
        }));
      });
    });
    const client = new OpenAIImageGenerationClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "gpt-image-2", kind: "berry-router", name: "Berry Router" },
      apiKey: "brry_test",
    });

    await expect(client.generate({ prompt: "A generated berry", size: "1024x1024" })).resolves.toMatchObject({
      data: [{ b64_json: "aW1hZ2U=" }],
    });
    expect(requests).toEqual([
      {
        path: "/v1/images/generations",
        auth: "Bearer brry_test",
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "A generated berry",
          n: 1,
          size: "1024x1024",
          response_format: "b64_json",
        }),
      },
    ]);
  });

  it("normalizes Kimi control-token tool calls when an upstream host leaves them in message content", async () => {
    const raw = [
      "I will create the file now.\n",
      "<|tool_calls_section_begin|>",
      "<|tool_call_begin|>functions.write_file:2<|tool_call_argument_begin|>",
      JSON.stringify({ path: "/workspace/report.py", content: "print('ok')" }),
      "<|tool_call_end|><|tool_calls_section_end|>",
    ].join("");
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: "1", model: "kimi", choices: [{ message: { content: raw }, finish_reason: "stop" }] }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "kimi", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });
    await expect(client.complete({ messages: [{ role: "user", content: "make it" }] })).resolves.toMatchObject({
      content: "I will create the file now.",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "functions.write_file:2",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "/workspace/report.py", content: "print('ok')" }) },
      }],
    });
  });

  it("leaves incomplete Kimi control-token output visible", () => {
    const malformed = "before<|tool_calls_section_begin|><|tool_call_begin|>functions.write_file:2";
    expect(parseKimiToolCalls(malformed)).toBeUndefined();
  });

  it("matches the recorded Berry Router chat, responses, models, account, and OAuth contract", async () => {
    const requests: Array<{ path: string; auth: string | undefined; body: string }> = [];
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        const path = request.url ?? "";
        requests.push({ path, auth: request.headers.authorization, body: raw });
        if (path === "/v1/chat/completions") {
          response.writeHead(200, { "Content-Type": "application/json", ...berryRouterFixture.chat.headers });
          response.end(JSON.stringify(berryRouterFixture.chat.response));
          return;
        }
        if (path === "/v1/responses") {
          response.writeHead(200, { "Content-Type": "text/event-stream", ...berryRouterFixture.responses.headers });
          for (const event of berryRouterFixture.responses.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
          response.end("data: [DONE]\n\n");
          return;
        }
        if (path === "/v1/models") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(berryRouterFixture.models));
          return;
        }
        if (path === "/v1/account") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(berryRouterFixture.account));
          return;
        }
        if (path === "/oauth/token") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(berryRouterFixture.oauth));
          return;
        }
        response.writeHead(404).end();
      });
    });
    const provider = {
      baseUrl: `${baseUrl}v1`, defaultModel: "berry/fast", kind: "berry-router", name: "Berry Router",
      endpointPath: "/chat/completions", modelsPath: "/models", authType: "bearer" as const,
    };
    const chat = await new OpenAIChatCompletionsClient({ provider, apiKey: "brry_test" }).complete({
      model: "berry/fast",
      messages: [{ role: "user", content: "route me" }],
    });
    expect(chat).toMatchObject({
      content: "routed",
      usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
      attribution: { requestedModel: "berry/fast", servedProvider: "anthropic", servedModel: "anthropic/claude-sonnet-4" },
    });

    const responses = new OpenAIResponsesClient({ provider: { ...provider, endpointPath: "/responses" }, apiKey: "brry_test" });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of responses.streamEvents({ model: "berry/cheap", input: [] })) events.push(event);
    expect(events[0]?.[BERRY_ROUTER_METADATA_KEY]).toEqual({
      attribution: { requestedModel: "berry/cheap", servedProvider: "openai", servedModel: "openai/gpt-4.1-mini" },
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
    });

    await expect(listProviderModels({ provider, apiKey: "brry_test" })).resolves.toMatchObject([
      { id: "berry/cheap" }, { id: "berry/fast" }, { id: "berry/flagship" },
    ]);
    const accountClient = new BerryRouterAccountClient({
      provider,
      apiKey: "brry_test",
      accountPath: "/account",
      tokenUrl: `${baseUrl}oauth/token`,
    });
    await expect(accountClient.account()).resolves.toMatchObject({
      id: "acct_fixture", plan: "pro", quota: { used: 37, remaining: 63, unit: "usd" },
      aliases: ["berry/cheap", "berry/fast", "berry/flagship"],
    });
    await expect(accountClient.exchangeOAuthCode({
      clientId: "desktop_fixture", code: "fixture_code", codeVerifier: "fixture_verifier", redirectUri: "berry://router/oauth/callback",
    })).resolves.toMatchObject({ accessToken: "brry_fixture_access", tokenType: "Bearer" });
    expect(requests.find((request) => request.path === "/v1/chat/completions")?.body).toContain('"model":"berry/fast"');
    expect(requests.filter((request) => request.path.startsWith("/v1/")).every((request) => request.auth === "Bearer brry_test")).toBe(true);
    expect(requests.find((request) => request.path === "/oauth/token")?.body).toContain("code_verifier=fixture_verifier");
  });
  it("sends optional bearer auth only when an LM Studio token is present", () => {
    const provider = { baseUrl: "http://localhost:1234/v1", defaultModel: "local", kind: "lm-studio", name: "LM Studio", authType: "optional-bearer" as const };
    expect(buildHeaders(provider, undefined).get("authorization")).toBeNull();
    expect(buildHeaders(provider, "lm-token").get("authorization")).toBe("Bearer lm-token");
  });
  it("calls OpenRouter-compatible chat completions", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "chatcmpl_1",
          model: "test-model",
          choices: [{ message: { content: "hello berry", reasoning_content: "checked first" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "test-model", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({
      content: "hello berry",
      reasoning: "checked first",
      usage: { totalTokens: 3 },
    });
  });

  it("streams SSE deltas", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"content":"hel"}}]}\n\n');
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "berry-router", name: "test" },
      apiKey: "key",
    });
    const chunks: string[] = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) chunks.push(chunk.delta);
    expect(chunks.join("")).toBe("hello");
  });

  it("surfaces structured streaming errors with the Berry Router request id", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "x-request-id": "brq_stream_failure",
      });
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_partial","function":{"name":"list_dir","arguments":""}}]}}]}\n\n',
      );
      response.write(
        'data: {"error":{"message":"The canopywave stream ended before completion","type":"provider_stream_error","param":null,"code":"provider_stream_error"},"request_id":"brq_stream_failure"}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });
    const chunks: ChatCompletionChunk[] = [];
    const consume = async () => {
      for await (const chunk of client.stream({ messages: [{ role: "user", content: "list files" }] })) {
        chunks.push(chunk);
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: "RouterClientError",
      status: 502,
      message: "Berry Router stream failed (request brq_stream_failure): The canopywave stream ended before completion",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.toolCalls?.[0]).toMatchObject({ id: "call_partial", function: { name: "list_dir" } });
  });

  it("sends tools and serialized tool messages in the request body", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      });
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    await client.complete({
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call_1", type: "function", function: { name: "list_dir", arguments: "{}" } }],
        },
        { role: "tool", content: "a.txt", toolCallId: "call_1", name: "list_dir" },
      ],
      tools: [{ type: "function", function: { name: "list_dir", description: "List", parameters: { type: "object" } } }],
      toolChoice: "auto",
    });
    expect(requestBody.tools).toEqual([
      { type: "function", function: { name: "list_dir", description: "List", parameters: { type: "object" } } },
    ]);
    expect(requestBody.tool_choice).toBe("auto");
    const messages = requestBody.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "list_dir", arguments: "{}" } }],
    });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1", name: "list_dir" });
    expect(messages[2]?.toolCallId).toBeUndefined();
  });

  it("surfaces tool-call deltas, finish reason, and usage while streaming", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"grep","arguments":""}}]}}]}\n\n',
      );
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":"}}]}}]}\n\n',
      );
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"berry\\"}"}}]}}]}\n\n',
      );
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    const toolDeltas: Array<{ index: number; id?: string; name?: string; args?: string }> = [];
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      for (const delta of chunk.toolCalls ?? []) {
        const flattened: { index: number; id?: string; name?: string; args?: string } = { index: delta.index };
        if (delta.id) flattened.id = delta.id;
        if (delta.function?.name !== undefined) flattened.name = delta.function.name;
        if (delta.function?.arguments !== undefined) flattened.args = delta.function.arguments;
        toolDeltas.push(flattened);
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }
    expect(toolDeltas).toEqual([
      { index: 0, id: "call_9", name: "grep", args: "" },
      { index: 0, args: '{"pattern":' },
      { index: 0, args: '"berry"}' },
    ]);
    expect(toolDeltas.map((delta) => delta.args ?? "").join("")).toBe('{"pattern":"berry"}');
    expect(finishReason).toBe("tool_calls");
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("streams reasoning deltas separately from text deltas", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"reasoning":"think"}}]}\n\n');
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"reasoning_content":" more"}}]}\n\n');
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    const reasoning: string[] = [];
    const text: string[] = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if (chunk.reasoningDelta) reasoning.push(chunk.reasoningDelta);
      if (chunk.delta) text.push(chunk.delta);
    }
    expect(reasoning.join("")).toBe("think more");
    expect(text.join("")).toBe("answer");
  });

  it("maps Ollama native NDJSON chat, tools, reasoning, and usage", async () => {
    let body: Record<string, unknown> = {};
    let authorization: string | undefined;
    const root = await withServer((request, response) => {
      authorization = request.headers.authorization;
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        body = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/x-ndjson");
        response.write('{"model":"qwen3:8b","message":{"thinking":"plan","content":""},"done":false}\n');
        response.write('{"model":"qwen3:8b","message":{"content":"","tool_calls":[{"function":{"name":"grep","arguments":{"pattern":"berry"}}}]},"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":4}\n');
        response.end();
      });
    });
    const client = new OllamaNativeChatClient({
      provider: { baseUrl: `${root}v1`, defaultModel: "qwen3:8b", kind: "ollama", name: "Ollama", authType: "bearer" },
      apiKey: "ollama-key",
    });
    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "function", function: { name: "grep", parameters: { type: "object" } } }],
      reasoningEffort: "high",
    })) chunks.push(chunk);
    expect(authorization).toBe("Bearer ollama-key");
    expect(body).toMatchObject({ model: "qwen3:8b", stream: true, think: "high" });
    expect(chunks[0]?.reasoningDelta).toBe("plan");
    expect(chunks[1]?.toolCalls?.[0]).toMatchObject({ function: { name: "grep", arguments: '{"pattern":"berry"}' } });
    expect(chunks[1]?.usage).toEqual({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
  });

  it("serializes reasoning effort and image content in the request body", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      });
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    await client.complete({
      reasoningEffort: "medium",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          ],
        },
      ],
    });
    expect(requestBody.reasoning_effort).toBe("medium");
    expect(requestBody.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        ],
      },
    ]);
  });

  it("fetches available models from the /models endpoint", async () => {
    let method: string | undefined;
    let authHeader: string | undefined;
    const baseUrl = await withServer((request, response) => {
      method = request.method;
      authHeader = request.headers["authorization"];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            { id: "z-model", owned_by: "acme" },
            { id: "a-model", owned_by: "openai" },
            { id: "m-model", owned_by: "anthropic" },
          ],
        }),
      );
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "a-model", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    const models = await client.listModels();
    expect(method).toBe("GET");
    expect(authHeader).toBe("Bearer key");
    expect(models.map((m) => m.id)).toEqual(["a-model", "m-model", "z-model"]);
    expect(models[0]).toMatchObject({ id: "a-model", name: "a-model", ownedBy: "openai" });
  });

  it("surfaces a RouterClientError when the /models endpoint fails", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.statusCode = 401;
      response.end("unauthorized");
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "openrouter-compatible", name: "test" },
      apiKey: "bad",
    });
    await expect(client.listModels()).rejects.toMatchObject({ name: "RouterClientError", status: 401 });
  });

  it("sends no Authorization header for keyless (authType none) providers", async () => {
    let authHeader: string | undefined | null;
    const baseUrl = await withServer((request, response) => {
      authHeader = request.headers["authorization"] ?? null;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "local-model", kind: "local", name: "Ollama", authType: "none" },
    });
    const models = await client.listModels();
    expect(authHeader).toBeNull();
    expect(models.map((m) => m.id)).toEqual(["local-model"]);
  });

  it("posts chat completions to a custom endpoint path without a key", async () => {
    let path: string | undefined;
    let authHeader: string | undefined | null;
    const baseUrl = await withServer((request, response) => {
      path = request.url;
      authHeader = request.headers["authorization"] ?? null;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "m", kind: "local", name: "local", authType: "none", endpointPath: "/chat/completions" },
    });
    await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(path).toBe("/v1/chat/completions");
    expect(authHeader).toBeNull();
  });

  it("streams OpenAI Responses events with bearer auth on the /responses path", async () => {
    let path: string | undefined;
    let authHeader: string | undefined;
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      path = request.url;
      authHeader = request.headers["authorization"];
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "text/event-stream");
        response.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
        response.write('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n');
        response.end();
      });
    });
    const client = new OpenAIResponsesClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "gpt-test", kind: "openai", name: "OpenAI", authType: "bearer", endpointPath: "/responses" },
      apiKey: "sk-test",
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of client.streamEvents({ input: [] })) events.push(event);
    expect(path).toBe("/v1/responses");
    expect(authHeader).toBe("Bearer sk-test");
    expect(requestBody).toMatchObject({ model: "gpt-test", stream: true });
    expect(events.map((event) => event.type)).toEqual(["response.output_text.delta", "response.completed"]);
  });

  it("posts Responses compaction to the matching /responses/compact path", async () => {
    let path: string | undefined;
    let authHeader: string | undefined;
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      path = request.url;
      authHeader = request.headers["authorization"];
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            id: "cmp_1",
            object: "response.compaction",
            output: [{ type: "compaction", encrypted_content: "opaque" }],
            usage: { total_tokens: 10 },
          }),
        );
      });
    });
    const client = new OpenAIResponsesClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "gpt-test", kind: "openai", name: "OpenAI", authType: "bearer", endpointPath: "/responses" },
      apiKey: "sk-test",
    });
    const result = await client.compact({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    expect(path).toBe("/v1/responses/compact");
    expect(authHeader).toBe("Bearer sk-test");
    expect(requestBody).toMatchObject({ model: "gpt-test", input: expect.any(Array) });
    expect(requestBody.stream).toBeUndefined();
    expect(result).toMatchObject({
      id: "cmp_1",
      object: "response.compaction",
      output: [{ type: "compaction", encrypted_content: "opaque" }],
      usage: { total_tokens: 10 },
    });
  });

  it("streams Anthropic Messages events with x-api-key and version headers", async () => {
    let apiKeyHeader: string | undefined;
    let versionHeader: string | undefined;
    let authHeader: string | undefined | null;
    const baseUrl = await withServer((request, response) => {
      apiKeyHeader = request.headers["x-api-key"] as string | undefined;
      versionHeader = request.headers["anthropic-version"] as string | undefined;
      authHeader = request.headers["authorization"] ?? null;
      response.setHeader("Content-Type", "text/event-stream");
      response.write('data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3}}}\n\n');
      response.write('data: {"type":"ping"}\n\n');
      response.write('data: {"type":"message_stop"}\n\n');
      response.end();
    });
    const client = new AnthropicMessagesClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "claude-test", kind: "anthropic", name: "Anthropic", authType: "x-api-key", endpointPath: "/messages" },
      apiKey: "ak-test",
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of client.streamEvents({ messages: [] })) events.push(event);
    expect(apiKeyHeader).toBe("ak-test");
    expect(versionHeader).toBe("2023-06-01");
    expect(authHeader).toBeNull();
    expect(events.map((event) => event.type)).toEqual(["message_start", "ping", "message_stop"]);
  });

  it("lists Anthropic models using display_name as the model name", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "claude-x", display_name: "Claude X" }] }));
    });
    const client = new AnthropicMessagesClient({
      provider: { baseUrl, defaultModel: "claude-x", kind: "anthropic", name: "Anthropic", authType: "x-api-key", modelsPath: "/models" },
      apiKey: "ak",
    });
    const models = await client.listModels();
    expect(models[0]).toMatchObject({ id: "claude-x", name: "Claude X" });
  });

  it("redacts key-shaped values from error text", () => {
    expect(redactSecrets("Authorization: Bearer sk-abc123 failed")).not.toContain("sk-abc123");
    expect(redactSecrets("https://x.test/v1?apiKey=sk-999&x=1")).not.toContain("sk-999");
    expect(redactSecrets('header x-api-key: ak-777 rejected')).not.toContain("ak-777");
  });

  it("uses OpenRouter reasoning shape for Berry Router and OpenRouter endpoints", async () => {
    const seen: Record<string, unknown>[] = [];
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        seen.push(JSON.parse(raw) as Record<string, unknown>);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      });
    });
    await new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    }).complete({ reasoningEffort: "high", messages: [{ role: "user", content: "hi" }] });
    await new OpenRouterCompatibleClient({
      provider: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "m", kind: "openrouter-compatible", name: "OpenRouter" },
      apiKey: "key",
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }).complete({ reasoningEffort: "high", messages: [{ role: "user", content: "hi" }] });
    expect(seen.map((body) => body.reasoning)).toEqual([{ effort: "high" }, { effort: "high" }]);
  });
});
