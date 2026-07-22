import { describe, expect, it } from "vitest";
import {
  createSandboxProviderFromConfig,
  RouterSandboxProvider,
  RouterSandboxProviderError,
  sandboxProviderConfigFromEnv,
  type RouterSandboxProviderOptions,
} from "./index.js";
import { collectSandboxExecEvents, exerciseSandboxProviderContract } from "./provider.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

class FakeRouter {
  readonly requests: Array<{ method: string; path: string; auth: string | null; provider: string | null; body: unknown }> = [];
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    this.requests.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      auth: headers.get("authorization"),
      provider: headers.get("x-berry-sandbox-provider"),
      body: rawBody,
    });

    if (url.pathname === "/v1/sandboxes" && init?.method === "POST") {
      const body = readObject(rawBody);
      return jsonResponse({
        sandbox: {
          id: "sbx_123",
          request_id: body.request_id,
          tenant_id: body.tenant_id,
          provider: body.provider_hint ?? "e2b",
          status: "running",
          image: body.image,
          cwd: body.cwd,
          created_at: "2026-07-10T00:00:00.000Z",
          expires_at: "2026-07-10T01:00:00.000Z",
          metadata: { router_request_id: "router_req_1" },
        },
      });
    }
    if (url.pathname === "/v1/sandboxes/sbx_123/exec" && init?.method === "POST") {
      return new Response([
        `data: ${JSON.stringify({ kind: "started", sandbox_id: "sbx_123", request_id: "exec_req", pid: 42 })}\n\n`,
        `data: ${JSON.stringify({ kind: "stdout", data: "contract-ok\n" })}\n\n`,
        `data: ${JSON.stringify({ kind: "exit", exit_code: 0, signal: null })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/v1/sandboxes/sbx_123/files/workspace/result.txt" && init?.method === "PUT") {
      const body = readObject(rawBody);
      return jsonResponse({ file: { path: "/workspace/result.txt", size_bytes: String(body.content).length, mtime: "2026-07-10T00:00:01.000Z" } });
    }
    if (url.pathname === "/v1/sandboxes/sbx_123/files/workspace/result.txt" && init?.method === "GET") {
      return jsonResponse({ file: { path: "/workspace/result.txt", encoding: "utf8", content: "contract-ok", size_bytes: 11, mtime: "2026-07-10T00:00:01.000Z" } });
    }
    if (url.pathname === "/v1/sandboxes/sbx_123/files/workspace" && init?.method === "GET") {
      return jsonResponse({ list: { path: "/workspace", entries: [{ path: "/workspace/result.txt", type: "file", size_bytes: 11, mtime: "2026-07-10T00:00:01.000Z" }] } });
    }
    if (url.pathname === "/v1/sandboxes/sbx_123/ports" && init?.method === "POST") {
      return jsonResponse({ port: { sandbox_id: "sbx_123", port: 3000, protocol: "http", url: "https://sbx-123-router.example.test", expires_at: null } });
    }
    if (url.pathname === "/v1/sandboxes/sbx_123" && init?.method === "DELETE") {
      return jsonResponse({ destroyed: true, status: "stopped" });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

describe("RouterSandboxProvider", () => {
  it("runs the shared contract through the Router sandbox API", async () => {
    const router = new FakeRouter();
    const provider = new RouterSandboxProvider(providerOptions(router));

    const result = await exerciseSandboxProviderContract(provider, {
      requestId: "create_req",
      tenantId,
      image: "berry/python:3.12",
    });

    expect(result.sandbox).toMatchObject({
      sandbox_id: "sbx_123",
      provider: "e2b",
      provider_kind: "commercial",
      status: "running",
    });
    expect(result.execEvents).toEqual([
      { kind: "started", sandbox_id: "sbx_123", request_id: "exec_req", pid: 42 },
      { kind: "stdout", data: "contract-ok\n" },
      { kind: "exit", exit_code: 0, signal: null },
    ]);
    expect(router.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/sandboxes",
      "PUT /v1/sandboxes/sbx_123/files/workspace/result.txt",
      "GET /v1/sandboxes/sbx_123/files/workspace/result.txt?encoding=utf8",
      "GET /v1/sandboxes/sbx_123/files/workspace?list=true&recursive=true",
      "POST /v1/sandboxes/sbx_123/exec",
      "POST /v1/sandboxes/sbx_123/ports",
      "DELETE /v1/sandboxes/sbx_123",
    ]);
    expect(router.requests.every((request) => request.auth === "Bearer router_service_token")).toBe(true);
    expect(router.requests.every((request) => request.provider === "e2b")).toBe(true);
    expect(readObject(router.requests[0]?.body).provider_hint).toBe("e2b");
  });

  it("normalizes non-SSE exec event arrays", async () => {
    const provider = new RouterSandboxProvider(providerOptions({
      fetch: async () => jsonResponse({
        events: [
          { event: "start", sandbox_id: "sbx_json", request_id: "exec_json", pid: 7 },
          { event: "output", data: "hello" },
          { event: "completed", exit_code: 0 },
        ],
      }),
    }));

    await expect(collectSandboxExecEvents(provider.exec({
      sandbox_id: "sbx_json",
      request_id: "exec_json",
      command: ["echo", "hello"],
    }))).resolves.toEqual([
      { kind: "started", sandbox_id: "sbx_json", request_id: "exec_json", pid: 7 },
      { kind: "stdout", data: "hello" },
      { kind: "exit", exit_code: 0, signal: null },
    ]);
  });

  it("redacts service tokens from Router errors", async () => {
    const provider = new RouterSandboxProvider(providerOptions({
      fetch: async () => new Response("Bearer router_service_token denied", { status: 401 }),
    }));

    await expect(provider.files.read({ sandbox_id: "sbx_bad", path: "/workspace/a.txt" })).rejects.toMatchObject({
      name: "RouterSandboxProviderError",
      status: 401,
      body: "Bearer [redacted] denied",
    } satisfies Partial<RouterSandboxProviderError>);
  });

  it("selects the commercial Router provider from environment config", () => {
    const config = sandboxProviderConfigFromEnv({
      BERRY_SANDBOX_PROVIDER: "commercial",
      BERRY_ROUTER_URL: "https://router.example.test/v1",
      BERRY_ROUTER_SERVICE_TOKEN: "svc",
      BERRY_SANDBOX_COMMERCIAL_PROVIDER: "cloudflare",
    });
    const provider = createSandboxProviderFromConfig({
      ...config,
      router: { ...config.router!, fetchImpl: async () => jsonResponse({}) },
    });

    expect(config).toMatchObject({
      provider: "commercial",
      router: { baseUrl: "https://router.example.test/v1", serviceToken: "svc", providerHint: "cloudflare" },
    });
    expect(provider.kind).toBe("commercial");
  });

  it("fails closed when Router sandbox config is incomplete", () => {
    expect(() => sandboxProviderConfigFromEnv({ BERRY_SANDBOX_PROVIDER: "router" })).toThrow("BERRY_ROUTER_URL");
    expect(() => sandboxProviderConfigFromEnv({
      BERRY_SANDBOX_PROVIDER: "router",
      BERRY_ROUTER_URL: "https://router.example.test/v1",
    })).toThrow("BERRY_ROUTER_SERVICE_TOKEN");
  });
});

function providerOptions(router: { fetch: typeof fetch }): RouterSandboxProviderOptions {
  return {
    baseUrl: "https://router.example.test/v1",
    serviceToken: "router_service_token",
    kind: "commercial",
    providerHint: "e2b",
    fetchImpl: router.fetch,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
