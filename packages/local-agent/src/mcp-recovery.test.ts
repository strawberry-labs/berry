import { beforeEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ request: vi.fn<(request: Request) => Promise<Response>>() }));
vi.mock("./remote-fetch.ts", async (original) => ({
  ...await original<typeof import("./remote-fetch.ts")>(),
  createPublicRemoteFetch: ({ bearerToken }: { bearerToken?: string } = {}) => async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (bearerToken) request.headers.set("authorization", `Bearer ${bearerToken}`);
    request.signal.throwIfAborted();
    return remote.request(request);
  },
}));

import { McpToolSource, type McpServerSpec } from "./mcp.ts";
import { refreshRemoteMcpOAuth, type McpOAuthState } from "./mcp-oauth.ts";

const serverUrl = "https://mcp.example.test/mcp";
const tokenUrl = "https://auth.example.test/token";
const deletion = { name: "remove_record", description: "Remove one record", inputSchema: { type: "object", properties: { id: { type: "string" } } } };
const spec: McpServerSpec = {
  id: "connector_mcp_test", name: "Connect", url: serverUrl, transport: "streamable-http",
  command: null, args: [], env: {}, enabled: true, trusted: true, cachedTools: [deletion],
};
const originalGrant: McpOAuthState = {
  clientInformation: { client_id: "berry-test-client" },
  tokens: { access_token: "stale-access", refresh_token: "saved-refresh", token_type: "Bearer" },
  discoveryState: { authorizationServerUrl: "https://auth.example.test/" },
};

type ToolRequest = { arguments: { id: string }; session: string | null; token: string | null };
type Rpc = { id?: number; method: string; params: Record<string, unknown> };
const rpc = (id: number | undefined, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rejected = () => Response.json({ error: "invalid_token" }, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
const success = { content: [{ type: "text", text: "Removed" }] };

function mockMcpServer(tool: (input: ToolRequest) => unknown | Promise<unknown>, tokenEndpoint?: () => Response) {
  const initialize = vi.fn();
  const requests = vi.fn();
  let nextSession = 0;
  remote.request.mockImplementation(async (request) => {
    if (request.url === tokenUrl) {
      requests(await request.text());
      return tokenEndpoint?.() ?? Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    if (request.method === "GET") return new Response(null, { status: 405 });
    const body = await request.json() as Rpc;
    const session = request.headers.get("mcp-session-id");
    if (body.method === "initialize") {
      initialize(session);
      const response = rpc(body.id, { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock Connect", version: "1" } });
      response.headers.set("mcp-session-id", `session-${++nextSession}`);
      return response;
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return rpc(body.id, { tools: [deletion] });
    const result = await tool({ arguments: body.params.arguments as ToolRequest["arguments"], session, token: request.headers.get("authorization") });
    return result instanceof Response ? result : rpc(body.id, result);
  });
  return { initialize, requests };
}

function recoveringConnection() {
  let state = structuredClone(originalGrant);
  let version = "original";
  const resolveCredential = vi.fn(async (_spec: McpServerSpec, signal?: AbortSignal, rejectedVersion?: string) => {
    if (version === rejectedVersion) {
      state = await refreshRemoteMcpOAuth({ serverUrl, callbackUrl: "https://berry.example.test/callback", state, ...(signal ? { signal } : {}) });
      version = "refreshed";
    }
    return { accessToken: state.tokens!.access_token, version };
  });
  return { source: new McpToolSource({ servers: [spec], resolveCredential }), resolveCredential };
}

describe("OAuth MCP recovery through the pinned Streamable HTTP client", () => {
  beforeEach(() => { remote.request.mockReset(); });

  it("refreshes a verified HTTP 401 before executing an identical permitted write once", async () => {
    const writes = vi.fn();
    const { initialize, requests } = mockMcpServer(({ token, arguments: args }) => {
      if (token === "Bearer stale-access") return rejected();
      writes(args);
      return success;
    });
    const { source } = recoveringConnection();
    try {
      await expect(source.executeTool(spec.id, "mcp__Connect__remove_record", { id: "42" })).resolves.toMatchObject(success);
      expect(writes.mock.calls).toEqual([[{ id: "42" }]]);
      expect(initialize.mock.calls).toEqual([[null], [null]]);
      expect(requests).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("refresh_token=saved-refresh"));
    } finally { await source.close(); }
  });

  it("gives one retry to a genuine session expiry and leaves application-level not found alone", async () => {
    const writes = vi.fn();
    const { initialize, requests } = mockMcpServer(({ session, arguments: args }) => {
      if (session === "session-1") return new Response(null, { status: 404 });
      writes(args);
      return args.id === "missing" ? { isError: true, content: [{ type: "text", text: "Record not found" }] } : success;
    });
    const { source } = recoveringConnection();
    try {
      await source.executeTool(spec.id, "mcp__Connect__remove_record", { id: "42" });
      await expect(source.executeTool(spec.id, "mcp__Connect__remove_record", { id: "missing" })).rejects.toMatchObject({ name: "McpToolError", message: "Record not found" });
      expect(initialize.mock.calls).toEqual([[null], [null]]);
      expect(writes.mock.calls).toEqual([[{ id: "42" }], [{ id: "missing" }]]);
      expect(requests).not.toHaveBeenCalled();
    } finally { await source.close(); }
  });

  it("handles a token-check outage as temporary when the fresh token also gets a 401", async () => {
    const call = vi.fn(rejected);
    const { requests } = mockMcpServer(call);
    const { source } = recoveringConnection();
    try {
      await expect(source.executeTool(spec.id, "mcp__Connect__remove_record", { id: "42" })).rejects.toMatchObject({ kind: "temporary", beforeDispatch: true, details: { exhausted: true, status: 401 } });
      expect(requests).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(2);
    } finally { await source.close(); }
  });

  it.each(["lost-response", "application-token-error", "permission"])("does not replay a write after %s", async (failure) => {
    const calls = vi.fn(() => {
      if (failure === "lost-response") throw new TypeError("connection closed after dispatch");
      if (failure === "permission") return Response.json({ error: "insufficient_scope" }, { status: 403 });
      return { isError: true, structuredContent: { error: "invalid_token" }, content: [{ type: "text", text: "Tool reported invalid_token" }] };
    });
    const { requests } = mockMcpServer(calls);
    const { source } = recoveringConnection();
    try {
      await expect(source.executeTool(spec.id, "mcp__Connect__remove_record", { id: "42" })).rejects.toMatchObject(
        failure === "lost-response" ? { kind: "temporary", beforeDispatch: false }
          : failure === "permission" ? { kind: "permission", beforeDispatch: true }
          : { name: "McpToolError", structuredContent: { error: "invalid_token" } },
      );
      expect(calls).toHaveBeenCalledTimes(1);
      expect(requests).not.toHaveBeenCalled();
    } finally { await source.close(); }
  });

  it("honors Retry-After within the budget and skips replay after cancellation", async () => {
    const controller = new AbortController();
    const call = vi.fn(() => new Response(null, { status: 429, headers: { "retry-after": "1" } }));
    mockMcpServer(call);
    const { source } = recoveringConnection();
    try {
      const result = source.executeTool(spec.id, "mcp__Connect__remove_record", { id: "42" }, controller.signal, true);
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
      controller.abort(new Error("Task cancelled"));
      await expect(result).rejects.toThrow(/aborted|cancelled/i);
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await source.close(); }
  });

  it.each([503, 429, 400])("distinguishes token endpoint HTTP %s without exposing its body", async (status) => {
    const { requests } = mockMcpServer(() => success, () => Response.json({ error: "invalid_grant", error_description: "private detail" }, { status, headers: { "retry-after": "30" } }));
    await expect(refreshRemoteMcpOAuth({ serverUrl, callbackUrl: "https://berry.example.test/callback", state: originalGrant })).rejects.toMatchObject({
      kind: status === 503 ? "uncertain" : status === 429 ? "temporary" : "invalid_grant",
    });
    expect(requests).toHaveBeenCalledTimes(1);
    expect(originalGrant.tokens?.refresh_token).toBe("saved-refresh");
  });
});
