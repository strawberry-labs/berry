import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderAttemptReport } from "@berry/shared";
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
  parseSse,
  RouterClientError,
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
  it("reports a bounded success attempt with normalized usage", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "completion-1",
        model: "served-model",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
    const reports: ProviderAttemptReport[] = [];
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "requested-model", kind: "openai-compatible", name: "Test provider" },
      apiKey: "key",
    });

    await client.complete({
      providerAttemptOrdinal: 2,
      messages: [{ role: "user", content: "hello" }],
      onProviderAttempt: (report) => reports.push(report),
    });

    expect(reports).toEqual([expect.objectContaining({
      physicalAttempt: 2,
      model: "served-model",
      status: 200,
      statusClass: "2xx",
      category: "success",
      retryDecision: "none",
      inputTokens: 7,
      outputTokens: 3,
      finishReason: "stop",
    })]);
  });

  it.each([
    [409, "permanent_client", "terminal"],
    [429, "rate_limit", "retry"],
  ] as const)("reports HTTP %i as %s with a %s decision", async (status, category, retryDecision) => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider body must not enter telemetry", code: "provider_error" } }));
    });
    const reports: ProviderAttemptReport[] = [];
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "m", kind: "openai-compatible", name: "Test provider" },
      apiKey: "key",
    });

    await expect(client.complete({
      messages: [{ role: "user", content: "hello" }],
      onProviderAttempt: (report) => reports.push(report),
    })).rejects.toMatchObject({ status });

    expect(reports).toEqual([expect.objectContaining({
      status,
      statusClass: "4xx",
      category,
      retryDecision,
      inputTokens: 0,
      outputTokens: 0,
    })]);
    expect(JSON.stringify(reports)).not.toContain("provider body must not enter telemetry");
  });

  it("cancels an SSE response body when the consumer stops early", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\ndata: second\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    }));

    for await (const event of parseSse(response)) {
      expect(event).toBe("first");
      break;
    }

    expect(cancelled).toBe(true);
  });

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
        }),
      },
    ]);
  });

  it("streams partial images and returns the completed frame", async () => {
    const requests: string[] = [];
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        requests.push(raw);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"cGFydGlhbA==","partial_image_index":0}\n\n');
        response.end('event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"ZmluYWw="}\n\n');
      });
    });
    const client = new OpenAIImageGenerationClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "gpt-image-2", kind: "berry-router", name: "Berry Router" },
      apiKey: "brry_test",
    });
    const partials: Array<{ index: number; b64_json: string }> = [];
    await expect(client.generate({
      prompt: "A generated berry",
      stream: true,
      partialImages: 3,
      onPartial: (partial) => partials.push(partial),
    })).resolves.toMatchObject({ data: [{ b64_json: "ZmluYWw=" }] });
    expect(partials).toEqual([{ index: 0, b64_json: "cGFydGlhbA==" }]);
    expect(JSON.parse(requests[0]!)).toMatchObject({ stream: true, partial_images: 3 });
  });

  it("routes grounded edits through the image edit endpoint", async () => {
    const requests: Array<{ path: string; body: string }> = [];
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        requests.push({ path: request.url ?? "", body: raw });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('event: image_edit.partial_image\ndata: {"type":"image_edit.partial_image","b64_json":"cGFydGlhbA==","partial_image_index":0}\n\n');
        response.end('event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"ZWRpdGVk"}\n\n');
      });
    });
    const client = new OpenAIImageGenerationClient({
      provider: { baseUrl: `${baseUrl}v1`, defaultModel: "gpt-image-2", kind: "berry-router", name: "Berry Router" },
      apiKey: "brry_test",
    });
    const partials: Array<{ index: number; b64_json: string }> = [];
    await expect(client.generate({
      prompt: "Remove the label",
      referenceImageUrls: ["data:image/png;base64,c291cmNl"],
      stream: true,
      onPartial: (partial) => partials.push(partial),
    })).resolves.toMatchObject({ data: [{ b64_json: "ZWRpdGVk" }] });
    expect(requests[0]?.path).toBe("/v1/images/edits");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      images: [{ image_url: "data:image/png;base64,c291cmNl" }],
    });
    expect(JSON.parse(requests[0]!.body)).not.toHaveProperty("input_fidelity");
    expect(partials).toEqual([{ index: 0, b64_json: "cGFydGlhbA==" }]);
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
    expect(events[0]?.[BERRY_ROUTER_METADATA_KEY]).toMatchObject({
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

  it("preserves provider continuation metadata from buffered tool calls", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        id: "chatcmpl_tool_metadata",
        model: "gemini-3.7-flash",
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "default_api:bash",
              type: "function",
              function: { name: "bash", arguments: '{"command":"pwd"}' },
              extra_content: { google: { thought_signature: "signature-buffered" } },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "gemini-3.7-flash", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });

    await expect(client.complete({ messages: [{ role: "user", content: "run pwd" }] }))
      .resolves.toMatchObject({
        toolCalls: [{
          id: "default_api:bash",
          extraContent: { google: { thought_signature: "signature-buffered" } },
        }],
      });
  });

  it("captures a sanitized request id on successful buffered completions", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "x-berry-request-id": "brq buffered@42",
      });
      response.end(JSON.stringify({
        id: "chatcmpl_request_id",
        model: "test-model",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "test-model", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });

    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({
      requestId: "brq_buffered_42",
      content: "ok",
    });
  });

  it("serializes declared OpenAI cache fields without inventing them", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          id: "cache_1",
          model: "gpt-test",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 2_000,
            completion_tokens: 2,
            total_tokens: 2_002,
            prompt_tokens_details: { cached_tokens: 1_500 },
          },
        }));
      });
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "gpt-test", kind: "openai", name: "OpenAI" },
      apiKey: "key",
    });
    const cached = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      promptCacheKey: "berry_hash",
      promptCacheRetention: "long",
    });
    await client.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(bodies[0]).toMatchObject({ prompt_cache_key: "berry_hash", prompt_cache_retention: "24h" });
    expect(bodies[1]?.prompt_cache_key).toBeUndefined();
    expect(bodies[1]?.prompt_cache_retention).toBeUndefined();
    expect(cached.usage).toMatchObject({ cacheReadTokens: 1_500, cacheWriteTokens: 0 });
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

  it("captures a sanitized request id on every successful streaming chunk", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "x-router-request-id": "brq stream@42",
      });
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"content":"hel"}}]}\n\n');
      response.write('data: {"id":"1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "m", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });
    const chunks: ChatCompletionChunk[] = [];

    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.requestId === "brq_stream_42")).toBe(true);
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
      code: "provider_stream_error",
      requestId: "brq_stream_failure",
      message: "Berry Router stream failed (request brq_stream_failure): The canopywave stream ended before completion",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.toolCalls?.[0]).toMatchObject({ id: "call_partial", function: { name: "list_dir" } });
  });

  it("classifies in-band invalid-request stream errors as permanent even when a specific code is also present", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "x-request-id": "brq_invalid_stream" });
      response.end('data: {"error":{"message":"tool choice is unsupported","type":"invalid_request_error","code":"unsupported_tool_choice"}}\n\ndata: [DONE]\n\n');
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "m", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });
    const consume = async () => {
      for await (const _chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
        // Consume the stream so the in-band error is observed.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: "RouterClientError",
      status: 400,
      code: "unsupported_tool_choice",
      requestId: "brq_invalid_stream",
    });
  });

  it("surfaces sanitized provider code and request id on HTTP failures", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.writeHead(400, {
        "Content-Type": "application/json",
        "x-request-id": "brq_memory_400",
      });
      response.end(JSON.stringify({
        error: {
          message: "tool_choice is unsupported",
          type: "invalid_request_error",
          code: "unsupported tool choice",
        },
      }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "m", kind: "berry-router", name: "Berry Router" },
      apiKey: "key",
    });

    await expect(client.complete({ messages: [{ role: "user", content: "remember this" }] })).rejects.toMatchObject({
      name: "RouterClientError",
      status: 400,
      code: "unsupported_tool_choice",
      requestId: "brq_memory_400",
    });
  });

  it("keeps the RouterClientError constructor backward compatible", () => {
    const legacy = new RouterClientError("legacy", 503, "unavailable");
    expect(legacy).toMatchObject({ status: 503, body: "unavailable" });
    expect(legacy.code).toBeUndefined();
    expect(legacy.requestId).toBeUndefined();
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
          toolCalls: [{
            id: "call_1",
            type: "function",
            function: { name: "list_dir", arguments: "{}" },
            extraContent: { google: { thought_signature: "signature-1" } },
          }],
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
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "list_dir", arguments: "{}" },
        extra_content: { google: { thought_signature: "signature-1" } },
      }],
    });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1", name: "list_dir" });
    expect(messages[2]?.toolCallId).toBeUndefined();
  });

  it("surfaces tool-call deltas, finish reason, and usage while streaming", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"grep","arguments":""},"extra_content":{"google":{"thought_signature":"signature-9"}}}]}}]}\n\n',
      );
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":"}}]}}]}\n\n',
      );
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"berry\\"}"}}]}}]}\n\n',
      );
      response.write(
        'data: {"id":"1","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":6}}}\n\n',
      );
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenRouterCompatibleClient({
      provider: { baseUrl, defaultModel: "m", kind: "openrouter-compatible", name: "test" },
      apiKey: "key",
    });
    const toolDeltas: Array<{ index: number; id?: string; name?: string; args?: string; extraContent?: unknown }> = [];
    let finishReason: string | null = null;
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      for (const delta of chunk.toolCalls ?? []) {
        const flattened: { index: number; id?: string; name?: string; args?: string; extraContent?: unknown } = { index: delta.index };
        if (delta.id) flattened.id = delta.id;
        if (delta.function?.name !== undefined) flattened.name = delta.function.name;
        if (delta.function?.arguments !== undefined) flattened.args = delta.function.arguments;
        if (delta.extraContent !== undefined) flattened.extraContent = delta.extraContent;
        toolDeltas.push(flattened);
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }
    expect(toolDeltas).toEqual([
      {
        index: 0,
        id: "call_9",
        name: "grep",
        args: "",
        extraContent: { google: { thought_signature: "signature-9" } },
      },
      { index: 0, args: '{"pattern":' },
      { index: 0, args: '"berry"}' },
    ]);
    expect(toolDeltas.map((delta) => delta.args ?? "").join("")).toBe('{"pattern":"berry"}');
    expect(finishReason).toBe("tool_calls");
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 6, cacheWriteTokens: 0 });
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

  it("forwards Gemini reasoning effort to BerryRouter and accepts thought-summary deltas", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "text/event-stream");
        response.write('data: {"id":"1","model":"google-vertex/gemini-3.7-flash","choices":[{"delta":{"reasoning_content":"Check the constraints."}}]}\n\n');
        response.write('data: {"id":"1","model":"google-vertex/gemini-3.7-flash","choices":[{"delta":{"content":"The answer."},"finish_reason":"stop"}]}\n\n');
        response.end("data: [DONE]\n\n");
      });
    });
    const client = new OpenRouterCompatibleClient({
      provider: {
        baseUrl,
        defaultModel: "google-vertex/gemini-3.7-flash",
        kind: "berry-router",
        name: "Berry Router",
      },
      apiKey: "key",
    });
    const reasoning: string[] = [];
    const text: string[] = [];

    for await (const chunk of client.stream({
      reasoningEffort: "high",
      messages: [{ role: "user", content: "Solve this." }],
    })) {
      if (chunk.reasoningDelta) reasoning.push(chunk.reasoningDelta);
      if (chunk.delta) text.push(chunk.delta);
    }

    expect(requestBody.reasoning).toEqual({ effort: "high" });
    expect(reasoning.join("")).toBe("Check the constraints.");
    expect(text.join("")).toBe("The answer.");
  });

  it("uses Kimi K2.6 thinking mode and streams its reasoning_content", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "text/event-stream");
        response.write('data: {"id":"1","model":"canopywave/moonshotai/kimi-k2.6","choices":[{"delta":{"reasoning_content":"inspect image"}}]}\n\n');
        response.write('data: {"id":"1","model":"canopywave/moonshotai/kimi-k2.6","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
        response.end("data: [DONE]\n\n");
      });
    });
    const client = new OpenRouterCompatibleClient({
      provider: {
        baseUrl,
        defaultModel: "canopywave/moonshotai/kimi-k2.6",
        kind: "berry-router",
        name: "Berry Router",
      },
      apiKey: "key",
    });
    const reasoning: string[] = [];
    const text: string[] = [];
    for await (const chunk of client.stream({
      reasoningEffort: "high",
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
        ],
      }],
    })) {
      if (chunk.reasoningDelta) reasoning.push(chunk.reasoningDelta);
      if (chunk.delta) text.push(chunk.delta);
    }

    expect(requestBody.thinking).toEqual({ type: "enabled" });
    expect(requestBody).not.toHaveProperty("reasoning");
    expect(requestBody).not.toHaveProperty("reasoning_effort");
    expect(requestBody).not.toHaveProperty("temperature");
    expect(reasoning.join("")).toBe("inspect image");
    expect(text.join("")).toBe("answer");
  });

  it("normalizes MiniMax M3 think tags split across streaming chunks", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.write('data: {"id":"1","model":"canopywave/minimax/minimax-m3","choices":[{"delta":{"content":"<thi"}}]}\n\n');
      response.write('data: {"id":"1","model":"canopywave/minimax/minimax-m3","choices":[{"delta":{"content":"nk>Need current"}}]}\n\n');
      response.write('data: {"id":"1","model":"canopywave/minimax/minimax-m3","choices":[{"delta":{"content":" sources.</thi"}}]}\n\n');
      response.write('data: {"id":"1","model":"canopywave/minimax/minimax-m3","choices":[{"delta":{"content":"nk>Here is the answer."},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const client = new OpenRouterCompatibleClient({
      provider: {
        baseUrl,
        defaultModel: "canopywave/minimax/minimax-m3",
        kind: "berry-router",
        name: "Berry Router",
      },
      apiKey: "key",
    });
    const reasoning: string[] = [];
    const text: string[] = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "latest news" }] })) {
      if (chunk.reasoningDelta) reasoning.push(chunk.reasoningDelta);
      if (chunk.delta) text.push(chunk.delta);
    }
    expect(reasoning.join("")).toBe("Need current sources.");
    expect(text.join("")).toBe("Here is the answer.");
  });

  it("normalizes MiniMax M3 think tags in non-streaming responses", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        id: "1",
        model: "canopywave/minimax/minimax-m3",
        choices: [{ message: { content: "<think>Check first.</think>Visible answer." }, finish_reason: "stop" }],
      }));
    });
    const client = new OpenRouterCompatibleClient({
      provider: {
        baseUrl,
        defaultModel: "canopywave/minimax/minimax-m3",
        kind: "berry-router",
        name: "Berry Router",
      },
      apiKey: "key",
    });
    await expect(client.complete({ messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({
      content: "Visible answer.",
      reasoning: "Check first.",
    });
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
        response.setHeader("x-request-id", "ollama request@7");
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
    expect(chunks.every((chunk) => chunk.requestId === "ollama_request_7")).toBe(true);
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
      reasoningEffort: "xhigh",
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
    expect(requestBody.reasoning_effort).toBe("xhigh");
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

  it("replays reasoning_content with an assistant tool call", async () => {
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ id: "1", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      });
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "m", kind: "openai-compatible", name: "test" },
      apiKey: "key",
    });
    await client.complete({
      messages: [{
        role: "assistant",
        content: null,
        reasoningContent: "I need the file contents first.",
        toolCalls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/workspace/input.txt"}' },
        }],
      }],
    });
    expect(requestBody.messages).toEqual([{
      role: "assistant",
      content: null,
      reasoning_content: "I need the file contents first.",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"/workspace/input.txt"}' },
      }],
    }]);
  });

  it("counts provider-reported reasoning tokens when visible output is zero", async () => {
    const baseUrl = await withServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        id: "1",
        model: "m",
        choices: [{ message: { content: "", reasoning_content: "thinking" }, finish_reason: "length" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 0,
          total_tokens: 10,
          completion_tokens_details: { reasoning_tokens: 4096 },
        },
      }));
    });
    const client = new OpenAIChatCompletionsClient({
      provider: { baseUrl, defaultModel: "m", kind: "openai-compatible", name: "test" },
      apiKey: "key",
    });
    await expect(client.complete({ messages: [{ role: "user", content: "solve" }] }))
      .resolves.toMatchObject({
        finishReason: "length",
        usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106 },
      });
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
            { id: "z-model", owned_by: "acme", max_output_tokens: 384_000 },
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
    expect(models[2]).toMatchObject({ id: "z-model", maxOutputTokens: 384_000 });
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
    let idempotencyHeader: string | undefined;
    let requestBody: Record<string, unknown> = {};
    const baseUrl = await withServer((request, response) => {
      path = request.url;
      authHeader = request.headers["authorization"];
      idempotencyHeader = request.headers["idempotency-key"] as string | undefined;
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "x-router-request-id": "responses request@42",
        });
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
    for await (const event of client.streamEvents({ input: [] }, undefined, { "Idempotency-Key": "durable-step-1" })) events.push(event);
    expect(path).toBe("/v1/responses");
    expect(authHeader).toBe("Bearer sk-test");
    expect(idempotencyHeader).toBe("durable-step-1");
    expect(requestBody).toMatchObject({ model: "gpt-test", stream: true });
    expect(events.map((event) => event.type)).toEqual(["response.output_text.delta", "response.completed"]);
    expect(events.every((event) => (
      event[BERRY_ROUTER_METADATA_KEY] as { requestId?: string } | undefined
    )?.requestId === "responses_request_42")).toBe(true);
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
    let idempotencyHeader: string | undefined;
    const baseUrl = await withServer((request, response) => {
      apiKeyHeader = request.headers["x-api-key"] as string | undefined;
      versionHeader = request.headers["anthropic-version"] as string | undefined;
      authHeader = request.headers["authorization"] ?? null;
      idempotencyHeader = request.headers["idempotency-key"] as string | undefined;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "request-id": "anthropic request@42",
      });
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
    for await (const event of client.streamEvents({ messages: [] }, undefined, { "Idempotency-Key": "durable-step-2" })) events.push(event);
    expect(apiKeyHeader).toBe("ak-test");
    expect(versionHeader).toBe("2023-06-01");
    expect(authHeader).toBeNull();
    expect(idempotencyHeader).toBe("durable-step-2");
    expect(events.map((event) => event.type)).toEqual(["message_start", "ping", "message_stop"]);
    expect(events.every((event) => (
      event[BERRY_ROUTER_METADATA_KEY] as { requestId?: string } | undefined
    )?.requestId === "anthropic_request_42")).toBe(true);
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
