import { readFileSync } from "node:fs";
import { MODEL_PROVIDER_PRESETS } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { AnthropicMessagesClient, listProviderModels, OpenAIChatCompletionsClient } from "./index.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../src/fixtures/provider-enterprise-matrix.json", import.meta.url), "utf8"),
) as {
  anthropic: { models: Record<string, unknown>; events: Array<Record<string, unknown>> };
  gemini: { models: Record<string, unknown>; completion: Record<string, unknown> };
};

function preset(id: string) {
  const value = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`missing ${id} preset`);
  return value;
}

describe("enterprise provider fixture matrix", () => {
  it("uses the current Anthropic Messages/models contract and native capability metadata", async () => {
    const anthropic = preset("anthropic");
    const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requests.push({ path, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
      if (path === "/v1/models") return new Response(JSON.stringify(fixture.anthropic.models), { status: 200 });
      const body = fixture.anthropic.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await expect(listProviderModels({ provider: anthropic, apiKey: "anthropic_fixture", fetchImpl })).resolves.toEqual([
      expect.objectContaining({
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        capabilities: { vision: true, reasoning: true, json: true, context: { windowTokens: 1_000_000, maxOutputTokens: 128_000 } },
      }),
    ]);
    const events = [];
    for await (const event of new AnthropicMessagesClient({ provider: anthropic, apiKey: "anthropic_fixture", fetchImpl }).streamEvents({
      model: anthropic.defaultModel, max_tokens: 16, messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "message_stop" });
    expect(requests.every((request) => request.headers.get("x-api-key") === "anthropic_fixture")).toBe(true);
    expect(requests.every((request) => request.headers.get("anthropic-version") === "2023-06-01")).toBe(true);
    expect(requests.find((request) => request.path === "/v1/messages")?.body).toMatchObject({ model: "claude-sonnet-5", stream: true });
  });

  it("uses Google's documented OpenAI-compatible Gemini endpoint", async () => {
    const gemini = preset("gemini");
    const requests: Array<{ path: string; headers: Headers; body: Record<string, unknown> | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requests.push({ path, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
      const payload = path.endsWith("/models") ? fixture.gemini.models : fixture.gemini.completion;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    await expect(listProviderModels({ provider: gemini, apiKey: "gemini_fixture", fetchImpl })).resolves.toEqual([
      expect.objectContaining({ id: "gemini-3.5-flash", ownedBy: "google" }),
    ]);
    await expect(new OpenAIChatCompletionsClient({ provider: gemini, apiKey: "gemini_fixture", fetchImpl }).complete({
      messages: [{ role: "user", content: "ping" }], maxTokens: 16,
    })).resolves.toMatchObject({ model: "gemini-3.5-flash", content: "gemini ok", usage: { totalTokens: 7 } });
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer gemini_fixture")).toBe(true);
    expect(requests.find((request) => request.path.endsWith("/chat/completions"))?.body).toMatchObject({ model: "gemini-3.5-flash", max_tokens: 16 });
  });
});
