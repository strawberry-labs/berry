import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BERRYCRAWL_TOOL_CATALOG, McpToolSource, mcpServerSpecsFromJson, type McpServerSpec } from "@berry/local-agent/mcp";
import { DurableMcpServerSchema, DurableTurnRuntimeRequestSchema } from "@berry/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableMcpToolExecutor } from "./mcp-tools.js";
import type { ToolResultStore } from "./tool-result-store.js";
import type { DurableTurnSnapshot, DurableTurnStep, TurnToolResult } from "./turn-runner.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/local-agent/test/fixtures/mcp-browser-server.mjs");
const executors: DurableMcpToolExecutor[] = [];
afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function server(local = true): McpServerSpec {
  const [spec] = mcpServerSpecsFromJson(JSON.stringify([{
    id: "berrycrawl", name: "BerryCrawl", transport: "streamable-http", url: "https://api.berrycrawl.com/api/v1/mcp",
  }]));
  return local ? {
    ...spec!, transport: "stdio", command: process.execPath, args: [fixture], url: null,
    env: { BERRY_TEST_MCP_TOOLS: JSON.stringify(BERRYCRAWL_TOOL_CATALOG) },
  } : spec!;
}
function snapshot(spec = server(), images = true): DurableTurnSnapshot {
  const { credentialKey: _key, ...durableServer } = spec;
  return {
    id: "run-browser", tenantId: "tenant-1", userId: "owner-1", sessionId: "session-1", workspaceId: "workspace-1",
    runtimeRequest: DurableTurnRuntimeRequestSchema.parse({
      capabilityVersion: 1, input: "Check the latest report on this website", providerId: "router",
      provider: { id: "router", name: "Berry Router", kind: "berry-router", baseUrl: "https://router.example.test/v1", defaultModel: "test-model", apiType: "openai-chat-completions", authType: "none" },
      model: "test-model", conversationKind: "chat", workspacePath: "/workspace", workspaceId: "workspace-1",
      permissionMode: "full-access", reasoning: "off", maxTokens: 1000, contextWindowTokens: 32000,
      modelAcceptsImages: images, builtInTools: [], mcpServers: [DurableMcpServerSchema.parse(durableServer)],
    }),
    steps: [], entries: [], approvals: [],
  } as unknown as DurableTurnSnapshot;
}
function step(name: string, args: Record<string, unknown>, sequence = 1): DurableTurnStep {
  const toolName = `mcp__BerryCrawl__berrycrawl_browser_${name}`;
  return { id: `browser-step-${sequence}`, sequence, type: `tool.${toolName}`, state: "pending", input: { toolName, arguments: args } } as unknown as DurableTurnStep;
}
function executor(store: ToolResultStore | null = memoryStore()): DurableMcpToolExecutor {
  // The admitted runtime is authoritative. No globally configured connectors.
  const value = new DurableMcpToolExecutor({ execute: vi.fn(async () => { throw new Error("Unexpected core tool call"); }) }, [], undefined, 5000, {}, store);
  executors.push(value);
  return value;
}
function complete(snapshot: DurableTurnSnapshot, step: DurableTurnStep, result: TurnToolResult): void {
  snapshot.steps = [...snapshot.steps, { ...step, state: "completed", output: result.output }];
}
function memoryStore(): ToolResultStore {
  const values = new Map<string, string>();
  const key = (scope: Pick<DurableTurnSnapshot, "tenantId" | "sessionId">, id: string) => `${scope.tenantId}/${scope.sessionId}/${id}`;
  return {
    put: vi.fn(async (scope, stepId, content) => {
      const sha256 = createHash("sha256").update(content).digest("hex");
      const id = createHash("sha256").update(stepId + sha256).digest("hex");
      values.set(key(scope, id), content);
      return { id, characters: content.length, sha256 };
    }),
    get: vi.fn(async (scope, id) => {
      const content = values.get(key(scope, id));
      if (!content) throw new Error("Result unavailable in this session");
      return content;
    }),
  };
}

describe("Berry Chat native browser control", () => {
  it("exposes direct controls on the first model call for chats and automation admissions without contacting Berrycrawl", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected external request"); });
    vi.stubGlobal("fetch", fetch);
    const tools = executor();
    const admitted = snapshot(server(false));
    expect((await tools.definitions(admitted)).map((tool) => tool.function.name)).toEqual(["request_browser_handoff", "read_tool_result", "tool_search", "use_tool"]);
    const context = await tools.turnContext(admitted);
    expect(context).toContain("your own agent loop");
    for (const name of ["open", "snapshot", "navigate", "click", "type", "press", "scroll", "screenshot", "read", "close"]) {
      expect(context).toContain(`- mcp__BerryCrawl__berrycrawl_browser_${name}:`);
    }
    expect(context).not.toContain("browser_run_task");
    expect(context).not.toContain("browser_run_recording");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers a successful official MCP browser receipt without exposing its viewer capability to the model", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("This receipt test must not contact a live MCP server"); }));
    vi.spyOn(McpToolSource.prototype, "listTools").mockReturnValue([{
      name: "mcp__BerryCrawl__berrycrawl_browser_open", label: "Open browser", description: "fixture", parameters: { type: "object", properties: { url: { type: "string" } } },
      execute: async () => ({ content: [{ type: "text", text: "Opened bses_receipt" }], details: { structuredContent: { data: { session_id: "bses_receipt", expires_at: "2026-11-04T13:00:00Z" } } } }),
    }] as never);
    const tools = executor(null), admitted = snapshot(server(false));
    const result = await tools.execute(admitted, step("open", { url: "https://example.test" }));
    expect(result.output).toMatchObject({ _berryBrowserSession: { sessionId: "bses_receipt", serverId: "berrycrawl", closed: false } });
  });

  it("drops screenshots from before human control and resets repeat guards at the fresh handback observation", async () => {
    const tools = executor(), admitted = snapshot();
    const shot = step("screenshot", { session_id: "bses_fixture" });
    complete(admitted, shot, await tools.execute(admitted, shot));
    admitted.steps = [...admitted.steps, { id: "resume-model", type: "model.call", state: "completed", sequence: 2, input: { resumedFromBrowserHandoff: "handoff" } } as unknown as DurableTurnStep];
    expect(await tools.modelContent(admitted)).toEqual([]);
    const official = snapshot(server(false)); official.steps = admitted.steps;
    expect(executor(null).repeatContextSince(official, step("click", { session_id: "bses_fixture", ref: "e1" }, 3))).toBe(2);
  });

  it("executes the agent's open, inspect, type, click, read and close calls through MCP", async () => {
    const tools = executor();
    const admitted = snapshot();
    const calls = [
      step("open", { url: "https://example.test", timeout_seconds: 300 }),
      step("snapshot", { session_id: "bses_fixture" }, 2),
      step("type", { session_id: "bses_fixture", ref: "e1", text: "Quarterly report" }, 3),
      step("click", { session_id: "bses_fixture", ref: "e2" }, 4),
      step("read", { session_id: "bses_fixture" }, 5),
      step("close", { session_id: "bses_fixture" }, 6),
    ];
    for (const call of calls) {
      const result = await tools.execute(admitted, call);
      complete(admitted, call, result);
    }
    expect(admitted.steps[0]?.output).toMatchObject({ content: expect.stringContaining("bses_fixture") });
    expect(admitted.steps[2]?.output).toMatchObject({ content: expect.stringContaining("Quarterly report") });
    expect(admitted.steps.at(-1)?.output).toMatchObject({ tool: "mcp__BerryCrawl__berrycrawl_browser_close" });
  });

  it("keeps mutating controls approval-gated in ask mode and prevents blind replay in either permission mode", async () => {
    const tools = executor();
    const admitted = snapshot();
    await tools.definitions(admitted);
    for (const action of ["open", "navigate", "click", "type", "press", "scroll", "act", "close"]) {
      const call = step(action, {});
      const name = String(call.input.toolName);
      expect(tools.policy(admitted, name, "ask")).toMatchObject({ retryClass: "non_idempotent_manual", repeatPolicy: "block_after_success", requiresApproval: true });
      expect(tools.policy(admitted, name, "full-access")).toMatchObject({ retryClass: "non_idempotent_manual", repeatPolicy: "block_after_success", requiresApproval: false });
      expect(tools.supportsConcurrency(admitted, call)).toBe(false);
    }
    for (const action of ["snapshot", "screenshot", "read", "tabs", "files"]) {
      const call = step(action, {});
      expect(tools.policy(admitted, String(call.input.toolName), "ask")).toMatchObject({ retryClass: "read_only", requiresApproval: false });
      expect(tools.supportsConcurrency(admitted, call)).toBe(true);
    }
  });

  it.each(["completed", "failed", "running"])("requires a new observation after an intervening %s mutation", (state) => {
    const tools = executor();
    const admitted = snapshot(server(false));
    admitted.steps = [
      { ...step("click", { session_id: "bses_fixture", ref: "e1" }), state: "completed" },
      { ...step("snapshot", { session_id: "bses_fixture" }, 2), state: "completed" },
      { ...step("navigate", { session_id: "bses_fixture", url: "https://example.test/next" }, 3), state },
    ] as DurableTurnStep[];
    const next = step("click", { session_id: "bses_fixture", ref: "e1" }, 5);
    expect(tools.repeatContextSince(admitted, next)).toBeUndefined();
    admitted.steps = [...admitted.steps, { ...step("snapshot", { session_id: "bses_fixture" }, 4), state: "completed" } as DurableTurnStep];
    expect(tools.repeatContextSince(admitted, next)).toBe(4);
  });

  it("does not treat an observation of another tab as the current tab's state", () => {
    const tools = executor();
    const admitted = snapshot(server(false));
    admitted.steps = [
      { ...step("click", { session_id: "bses_fixture", tab_id: "tab-a", ref: "e1" }), state: "completed" },
      { ...step("snapshot", { session_id: "bses_fixture", tab_id: "tab-b" }, 2), state: "completed" },
    ] as DurableTurnStep[];
    expect(tools.repeatContextSince(admitted, step("click", { session_id: "bses_fixture", tab_id: "tab-a", ref: "e1" }, 3))).toBeUndefined();
  });

  it("feeds screenshot pixels back to the same agent after a worker release, without putting binary in its journal", async () => {
    const store = memoryStore();
    const tools = executor(store);
    const admitted = snapshot();
    const screenshot = step("screenshot", { session_id: "bses_fixture" });
    const result = await tools.execute(admitted, screenshot);
    complete(admitted, screenshot, result);
    expect(result.output).toMatchObject({ hasImages: true, storedResult: { id: expect.any(String) } });
    expect(JSON.stringify(result.output)).not.toContain("iVBOR");
    expect(store.put).toHaveBeenCalledOnce(); // Even a small screenshot must survive the queue boundary.
    const readable = await tools.execute(admitted, { id: "read-screenshot-result", type: "tool.read_tool_result", input: { toolName: "read_tool_result", arguments: { result_id: (result.output as { storedResult: { id: string } }).storedResult.id } } } as unknown as DurableTurnStep);
    expect(JSON.stringify(readable.output)).not.toContain("iVBOR");
    expect(JSON.stringify(readable.output)).toContain("binary is omitted from text reads");
    expect((await tools.modelContent(admitted)).some((part) => part.type === "image_url")).toBe(true);
    await tools.release(admitted);
    const restarted = executor(store);
    const content = await restarted.modelContent(admitted);
    expect(content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } })]));
    expect(store.get).toHaveBeenCalledWith(admitted, expect.any(String), undefined);
    expect(store.put).toHaveBeenCalledOnce(); // Restoring pixels never re-executes the browser operation.
  });

  it.each(["failed", "running", "completed"])("withholds stale pixels after a later %s browser action", async (state) => {
    const tools = executor();
    const admitted = snapshot();
    const screenshot = step("screenshot", { session_id: "bses_fixture" });
    complete(admitted, screenshot, await tools.execute(admitted, screenshot));
    admitted.steps = [...admitted.steps, { ...step("navigate", { session_id: "bses_fixture", url: "https://example.test/next" }, 2), state } as DurableTurnStep];
    expect(await tools.modelContent(admitted)).toEqual([]);
  });

  it("compares screenshot observations independently of their per-step storage references", async () => {
    const tools = executor();
    const admitted = snapshot();
    const first = await tools.execute(admitted, step("screenshot", { session_id: "bses_fixture" }));
    const second = await tools.execute(admitted, step("screenshot", { session_id: "bses_fixture" }, 2));
    expect(first.progress?.fingerprintBasis).toEqual(second.progress?.fingerprintBasis);
    expect(first.output).not.toEqual(second.output);
  });

  it("keeps screenshots private to the admitted session and current connector scope", async () => {
    const store = memoryStore();
    const tools = executor(store);
    const admitted = snapshot();
    const screenshot = step("screenshot", { session_id: "bses_fixture" });
    complete(admitted, screenshot, await tools.execute(admitted, screenshot));
    await tools.release(admitted);
    const other = { ...admitted, id: "run-other", tenantId: "tenant-other", sessionId: "session-other" };
    expect(JSON.stringify(await executor(store).modelContent(other))).toContain("could not be restored");
    const restricted = snapshot();
    restricted.steps = admitted.steps;
    restricted.runtimeRequest = { ...restricted.runtimeRequest, mcpServers: [] };
    expect(await executor(store).modelContent(restricted)).toEqual([]);
  });

  it("uses DOM guidance for a text-only agent without delegating to another browser agent", async () => {
    const tools = executor();
    const admitted = snapshot(server(), false);
    const screenshot = step("screenshot", { session_id: "bses_fixture" });
    complete(admitted, screenshot, await tools.execute(admitted, screenshot));
    const content = await tools.modelContent(admitted);
    expect(content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(content)).toContain("DOM snapshot/read");
    expect(JSON.stringify(content)).not.toContain("run_task");
  });

  it("rejects undecodable screenshot bytes before sending them to the agent", async () => {
    const spec = server(); spec.env.BERRY_TEST_IMAGE_DATA = "bm90LWEtdmFsaWQtaW1hZ2U=";
    const tools = executor();
    const admitted = snapshot(spec);
    const screenshot = step("screenshot", { session_id: "bses_fixture" });
    complete(admitted, screenshot, await tools.execute(admitted, screenshot));
    await tools.release(admitted);
    const content = await tools.modelContent(admitted);
    expect(content.some((part) => part.type === "image_url")).toBe(false);
    expect(JSON.stringify(content)).toContain("could not be decoded within image limits");
  });

  it("reports unavailable screenshot retention without inventing a restore reference", async () => {
    const store = memoryStore();
    vi.mocked(store.put).mockRejectedValue(new Error("private storage unavailable"));
    const tools = executor(store);
    const admitted = snapshot();
    const screenshot = step("screenshot", { session_id: "bses_fixture" });
    const result = await tools.execute(admitted, screenshot);
    expect(result.output).not.toHaveProperty("storedResult");
    complete(admitted, screenshot, result);
    await tools.release(admitted);
    expect(JSON.stringify(await tools.modelContent(admitted))).toContain("Take a fresh screenshot or use a DOM snapshot");
    expect(store.get).not.toHaveBeenCalled();
  });
});
