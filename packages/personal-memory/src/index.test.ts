import { describe, expect, it } from "vitest";
import {
  PersonalMemoryHttpError,
  SelfHostedMem0PersonalMemoryProvider,
  createPersonalMemoryProviderFromEnv,
  personalMemoryScopeId,
} from "./index.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const memoryId = "00000000-0000-7000-8000-000000000003";
const timestamp = "2026-07-28T12:00:00.000Z";
const apiKey = "test-internal-mem0-key-000000";

describe("self-hosted personal memory adapter", () => {
  it("requires complete Mem0 configuration but retains the Berry rollback mode", () => {
    expect(createPersonalMemoryProviderFromEnv({ BERRY_PERSONAL_MEMORY_PROVIDER: "berry" })).toBeNull();
    expect(() => createPersonalMemoryProviderFromEnv({
      BERRY_PERSONAL_MEMORY_PROVIDER: "mem0",
    })).toThrow("BERRY_MEM0_BASE_URL and BERRY_MEM0_API_KEY");
  });

  it("sends tenant-scoped explicit memory to the internal service", async () => {
    const captured: { url?: URL; init?: RequestInit } = {};
    const provider = providerWith(async (input, init) => {
      captured.url = new URL(String(input));
      captured.init = init ?? {};
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
        metadata: Record<string, unknown>;
      };
      return json({
        operation: "ADD",
        results: [{
          id: memoryId,
          memory: body.messages[0]!.content,
          createdAt: timestamp,
          updatedAt: timestamp,
          metadata: body.metadata,
        }],
      }, 201);
    });

    const result = await provider.remember({
      tenantId,
      userId,
      kind: "preference",
      stableKey: "response-style",
      content: "The user prefers concise answers.",
      value: { format: "concise" },
      confidence: 1,
      salience: 0.9,
      explicit: true,
      expiresAt: null,
      source: source(),
    });

    expect(captured.url?.pathname).toBe("/v1/memories");
    expect(new Headers(captured.init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(captured.init?.body))).toMatchObject({
      tenantId,
      userId,
      infer: false,
      stableKey: "response-style",
      metadata: {
        berry_tenant_id: tenantId,
        berry_user_id: userId,
        berry_stable_key: "response-style",
      },
    });
    expect(result.item).toMatchObject({
      id: memoryId,
      tenantId,
      userId,
      scope: "personal",
      stableKey: "response-style",
    });
  });

  it("marks an idempotent extraction replay as a no-op", async () => {
    const provider = providerWith(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
      return json({
        operation: "NOOP",
        results: [{
          id: memoryId,
          memory: "The user prefers concise answers.",
          createdAt: timestamp,
          updatedAt: timestamp,
          metadata: body.metadata,
        }],
      });
    });

    const result = await provider.ingestConversation({
      tenantId,
      userId,
      messages: [{ role: "user", content: "Please keep answers concise." }],
      source: source(),
      idempotencyKey: "memory.extract:fixture",
    });

    expect(result.replayed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(personalMemoryScopeId({ tenantId, userId })).toBe(`berry:${tenantId}:${userId}`);
  });

  it("aborts an in-flight search without retrying it", async () => {
    let attempts = 0;
    const provider = providerWith(async (_input, init) => {
      attempts += 1;
      const signal = init?.signal;
      if (!signal) throw new Error("Expected a request abort signal");
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    });
    const controller = new AbortController();
    const pending = provider.search({
      tenantId,
      userId,
      query: "response preferences",
      limit: 10,
      signal: controller.signal,
    });

    controller.abort(new Error("turn cancelled"));

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PersonalMemoryHttpError);
    expect(error).toMatchObject({ retryable: false, status: null });
    expect(attempts).toBe(1);
  });
});

function providerWith(fetchImpl: typeof fetch): SelfHostedMem0PersonalMemoryProvider {
  return new SelfHostedMem0PersonalMemoryProvider({
    baseUrl: "http://mem0.internal:8010",
    apiKey,
    fetchImpl,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function source() {
  return {
    actorUserId: userId,
    taskId: "00000000-0000-7000-8000-000000000010",
    sessionId: "00000000-0000-7000-8000-000000000011",
    messageId: "00000000-0000-7000-8000-000000000012",
    extractorVersion: "test-v1",
  };
}
