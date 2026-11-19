import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpCachedTool } from "@berry/local-agent/mcp";
import { sealDurableSecret } from "@berry/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableMcpToolExecutor } from "./mcp-tools.js";
import {
  McpToolSnapshotRefresher,
  SqlMcpToolSnapshotStore,
  diffMcpToolSnapshots,
  isRefreshableConnector,
  mcpToolDefinitionHash,
  type McpToolSnapshotRow,
  type McpToolSnapshotStore,
} from "./mcp-tool-refresh.js";
import type { SqlExecutor } from "./sql-repositories.js";
import type { DurableTurnSnapshot, DurableTurnStep } from "./turn-runner.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

function tool(name: string, properties: Record<string, unknown> = {}, extra: Partial<McpCachedTool> = {}): McpCachedTool {
  return { name, description: `The ${name} tool`, inputSchema: { type: "object", properties }, ...extra };
}

/**
 * In-memory stand-in for SqlMcpToolSnapshotStore with the same conditional
 * semantics: replace only while the stored list is unchanged, claim only when
 * no unexpired claim is held.
 */
class MemorySnapshotStore implements McpToolSnapshotStore {
  readonly rows = new Map<string, { tools: unknown; checkedAt: number | null; claim: { id: string; until: number } | null; updates: number }>();
  /** Runs once between the next read and the following replace, like another worker saving. */
  beforeReplace: (() => void) | null = null;

  seed(connectorId: string, tools: McpCachedTool[] | null, checkedAt: number | null): void {
    this.rows.set(connectorId, { tools: tools ? structuredClone(tools) : null, checkedAt, claim: null, updates: 0 });
  }

  tools(connectorId: string): string[] {
    const stored = this.rows.get(connectorId)?.tools;
    return Array.isArray(stored) ? stored.map((item) => (item as McpCachedTool).name) : [];
  }

  async read(_tenantId: string, connectorIds: readonly string[]): Promise<Map<string, McpToolSnapshotRow>> {
    return new Map(connectorIds.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [[id, {
        stored: structuredClone(row.tools),
        tools: Array.isArray(row.tools) ? structuredClone(row.tools) as McpCachedTool[] : [],
        checkedAt: row.checkedAt,
        claimedUntil: row.claim?.until ?? null,
      }] as const] : [];
    }));
  }

  async claim(_tenantId: string, connectorId: string, claimId: string, now: number, until: number): Promise<boolean> {
    const row = this.rows.get(connectorId);
    if (!row || (row.claim && row.claim.until > now)) return false;
    row.claim = { id: claimId, until };
    return true;
  }

  async release(_tenantId: string, connectorId: string, claimId: string): Promise<void> {
    const row = this.rows.get(connectorId);
    if (row?.claim?.id === claimId) row.claim = null;
  }

  async replace(_tenantId: string, connectorId: string, expected: unknown, tools: readonly McpCachedTool[], at: string): Promise<boolean> {
    const hook = this.beforeReplace;
    this.beforeReplace = null;
    hook?.();
    const row = this.rows.get(connectorId);
    if (!row || JSON.stringify(row.tools ?? null) !== JSON.stringify(expected ?? null)) return false;
    row.tools = structuredClone(tools);
    row.checkedAt = Date.parse(at);
    row.updates += 1;
    return true;
  }

  async markChecked(_tenantId: string, connectorId: string, at: string): Promise<void> {
    const row = this.rows.get(connectorId);
    if (row) row.checkedAt = Date.parse(at);
  }
}

describe("MCP tool snapshot diffing", () => {
  it("reports added, removed and changed tools by name and definition", () => {
    const previous = [tool("people_list"), tool("leave_log", { kind: { enum: ["sick"] } }), tool("retired")];
    const live = [tool("leave_log", { kind: { enum: ["sick", "leave"] } }), tool("people_list"), tool("team_list")];
    expect(diffMcpToolSnapshots(previous, live)).toEqual({
      added: ["team_list"],
      removed: ["retired"],
      changed: ["leave_log"],
      unchanged: false,
    });
  });

  it("treats reordering, key order and display-only annotations as unchanged", () => {
    const previous = [
      tool("a", { first: { type: "string" }, second: { type: "number" } }, { annotations: { readOnlyHint: true } }),
      tool("b"),
    ];
    const live = [
      tool("b"),
      { name: "a", description: "The a tool", inputSchema: { properties: { second: { type: "number" }, first: { type: "string" } }, type: "object" }, annotations: { readOnlyHint: true, title: "A" } as never },
    ];
    expect(diffMcpToolSnapshots(previous, live).unchanged).toBe(true);
  });

  it("counts description and safety hint changes", () => {
    expect(mcpToolDefinitionHash(tool("a"))).not.toBe(mcpToolDefinitionHash(tool("a", {}, { description: "New wording" })));
    expect(mcpToolDefinitionHash(tool("a"))).not.toBe(mcpToolDefinitionHash(tool("a", {}, { annotations: { destructiveHint: true } })));
  });

  it("refreshes only organization custom connectors, not Berry-owned adapters", () => {
    expect(isRefreshableConnector({ id: "connector_mcp_1", credentialKey: "connector:connector_mcp_1:user-1" })).toBe(true);
    expect(isRefreshableConnector({ id: "connector_mcp_1", credentialKey: "connector:connector_mcp_1:shared" })).toBe(true);
    expect(isRefreshableConnector({ id: "gmail", credentialKey: "connector:gmail:user-1", trustReadOnlyAnnotations: true })).toBe(false);
    expect(isRefreshableConnector({ id: "berrycrawl", credentialKey: "env:BERRYCRAWL_API_KEY" })).toBe(false);
    expect(isRefreshableConnector({ id: "other", credentialKey: "connector:connector_mcp_1:user-1" })).toBe(false);
  });
});

describe("MCP tool snapshot saves", () => {
  it("stores a changed list, drops removed tools, and only marks an unchanged list as checked", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("people_list"), tool("retired")], 0);
    const refresher = new McpToolSnapshotRefresher(store, { now: () => 1_000_000 });

    await expect(refresher.record(tenantId, "connect", [tool("people_list"), tool("team_list")])).resolves.toBe("saved");
    expect(store.tools("connect")).toEqual(["people_list", "team_list"]);
    expect(store.rows.get("connect")?.updates).toBe(1);

    await expect(refresher.record(tenantId, "connect", [tool("team_list"), tool("people_list")])).resolves.toBe("unchanged");
    expect(store.rows.get("connect")?.updates).toBe(1);
  });

  it("never stores an empty list or a connector the store does not refresh", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("people_list")], 0);
    const refresher = new McpToolSnapshotRefresher(store);
    await expect(refresher.record(tenantId, "connect", [])).resolves.toBe("skipped");
    await expect(refresher.record(tenantId, "draft-connector", [tool("a")])).resolves.toBe("skipped");
    expect(store.tools("connect")).toEqual(["people_list"]);
  });

  it("re-reads and diffs again when another worker saved first, without overwriting blindly", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("people_list")], 0);
    store.beforeReplace = () => {
      // Another worker stored a newer list between this worker's read and save.
      store.rows.get("connect")!.tools = [tool("people_list"), tool("team_list")];
    };
    const refresher = new McpToolSnapshotRefresher(store);

    await expect(refresher.record(tenantId, "connect", [tool("people_list"), tool("team_list")])).resolves.toBe("unchanged");
    expect(store.rows.get("connect")?.updates).toBe(0);
  });

  it("gives up after a second conflict and keeps the stored list", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("a")], 0);
    const replace = vi.spyOn(store, "replace").mockResolvedValue(false);
    const events: string[] = [];
    const refresher = new McpToolSnapshotRefresher(store, { onEvent: (event) => events.push(event.outcome) });

    await expect(refresher.record(tenantId, "connect", [tool("b")])).resolves.toBe("conflict");
    expect(replace).toHaveBeenCalledTimes(2);
    expect(store.tools("connect")).toEqual(["a"]);
    expect(events).toEqual(["conflict"]);
  });

  it("saves listings for one connector one at a time", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("a")], 0);
    let active = 0;
    let peak = 0;
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementation(async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return read(...args);
    });
    const refresher = new McpToolSnapshotRefresher(store);

    const outcomes = await Promise.all([
      refresher.record(tenantId, "connect", [tool("a"), tool("b")]),
      refresher.record(tenantId, "connect", [tool("a"), tool("b")]),
      refresher.record(tenantId, "connect", [tool("a"), tool("b"), tool("c")]),
    ]);
    expect(peak).toBe(1);
    expect(outcomes).toEqual(["saved", "unchanged", "saved"]);
    expect(store.tools("connect")).toEqual(["a", "b", "c"]);
  });

  it("reports a store failure as an outcome instead of throwing", async () => {
    const store = new MemorySnapshotStore();
    vi.spyOn(store, "read").mockRejectedValue(new Error("database unavailable"));
    const refresher = new McpToolSnapshotRefresher(store);
    await expect(refresher.record(tenantId, "connect", [tool("a")])).resolves.toBe("failed");
  });
});

describe("turn-start refresh of stale MCP tool snapshots", () => {
  const fifteenMinutes = 15 * 60_000;

  it("leaves a fresh snapshot alone and refreshes a stale one", async () => {
    const now = 10 * fifteenMinutes;
    const store = new MemorySnapshotStore();
    store.seed("fresh", [tool("a")], now - 60_000);
    store.seed("stale", [tool("a")], now - fifteenMinutes - 1);
    const refresher = new McpToolSnapshotRefresher(store, { now: () => now });
    const list = vi.fn(async (ids: string[]) => {
      for (const id of ids) await refresher.record(tenantId, id, [tool("a"), tool("team_list")]);
    });

    await refresher.refreshStale(tenantId, ["fresh", "stale", "not-a-connector"], list, 1_000);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(["stale"]);
    expect(store.tools("stale")).toEqual(["a", "team_list"]);
    expect(store.tools("fresh")).toEqual(["a"]);
    // A successful refresh releases its claim for the next stale window.
    expect(store.rows.get("stale")?.claim).toBeNull();
  });

  it("refreshes a connector whose snapshot has never been checked", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", null, null);
    const refresher = new McpToolSnapshotRefresher(store);
    const list = vi.fn(async () => {
      await refresher.record(tenantId, "connect", [tool("a")]);
    });
    await refresher.refreshStale(tenantId, ["connect"], list, 1_000);
    expect(store.tools("connect")).toEqual(["a"]);
  });

  it("runs one refresh per connector in a worker even when turns start together", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("a")], null);
    const refresher = new McpToolSnapshotRefresher(store);
    const list = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await refresher.record(tenantId, "connect", [tool("a"), tool("b")]);
    });

    await Promise.all(Array.from({ length: 5 }, () => refresher.refreshStale(tenantId, ["connect"], list, 1_000)));
    expect(list).toHaveBeenCalledOnce();
  });

  it("lets only the worker holding the claim ask the server", async () => {
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("a")], null);
    const workers = Array.from({ length: 4 }, () => new McpToolSnapshotRefresher(store));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lists = workers.map((worker) => vi.fn(async () => {
      await gate;
      await worker.record(tenantId, "connect", [tool("a"), tool("b")]);
    }));

    const running = workers.map((worker, index) => worker.refreshStale(tenantId, ["connect"], lists[index]!, 1_000));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all(running);
    expect(lists.reduce((calls, list) => calls + list.mock.calls.length, 0)).toBe(1);
    expect(store.tools("connect")).toEqual(["a", "b"]);
  });

  it("keeps the cached list when the server fails or is slow, and waits out the claim before retrying", async () => {
    let now = 10 * fifteenMinutes;
    const store = new MemorySnapshotStore();
    store.seed("connect", [tool("a")], null);
    const events: string[] = [];
    const refresher = new McpToolSnapshotRefresher(store, { now: () => now, claimMs: 120_000, onEvent: (event) => events.push(event.outcome) });

    // A 401 or network error: the source swallows it and no listing arrives.
    const failing = vi.fn(async () => undefined);
    await expect(refresher.refreshStale(tenantId, ["connect"], failing, 1_000)).resolves.toBeUndefined();
    expect(store.tools("connect")).toEqual(["a"]);
    expect(events).toContain("failed");

    // The claim stays until it expires, so turns starting meanwhile do not retry.
    now += 60_000;
    await refresher.refreshStale(tenantId, ["connect"], failing, 1_000);
    expect(failing).toHaveBeenCalledOnce();

    // A server that never answers is abandoned after the timeout.
    now += 120_000;
    const hanging = vi.fn(() => new Promise<void>(() => undefined));
    const started = Date.now();
    await refresher.refreshStale(tenantId, ["connect"], hanging, 30);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(hanging).toHaveBeenCalledOnce();
    expect(events).toContain("timed_out");
    expect(store.tools("connect")).toEqual(["a"]);
  });

  it("never rejects when the store is unavailable", async () => {
    const store = new MemorySnapshotStore();
    vi.spyOn(store, "read").mockRejectedValue(new Error("database unavailable"));
    const refresher = new McpToolSnapshotRefresher(store);
    const list = vi.fn(async () => undefined);
    await expect(refresher.refreshStale(tenantId, ["connect"], list, 1_000)).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("SQL MCP tool snapshot store", () => {
  it("runs every statement in the tenant's context with conditional updates", async () => {
    const calls: Array<{ tenant: string | null; sql: string; params: readonly unknown[] }> = [];
    let tenant: string | null = null;
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        calls.push({ tenant, sql, params });
        return undefined;
      },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ tenant, sql, params });
        if (sql.trim().startsWith("SELECT")) {
          return [{ id: "connect", tools: [tool("a")], checked_at: null, discovered_at: "2026-11-19T10:00:00.000Z", claimed_until: "1700000000000" }] as T[];
        }
        return [{ id: "connect" }] as T[];
      },
      runWithTenant: async (id, callback) => {
        tenant = id;
        try {
          return await callback();
        } finally {
          tenant = null;
        }
      },
    };
    const store = new SqlMcpToolSnapshotStore(executor);

    const rows = await store.read(tenantId, ["connect"]);
    expect(rows.get("connect")).toEqual({
      stored: [tool("a")],
      tools: [tool("a")],
      checkedAt: Date.parse("2026-11-19T10:00:00.000Z"),
      claimedUntil: 1_700_000_000_000,
    });
    await expect(store.claim(tenantId, "connect", "claim-1", 10, 20)).resolves.toBe(true);
    await expect(store.replace(tenantId, "connect", [tool("a")], [tool("a"), tool("b")], "2026-11-19T11:00:00.000Z")).resolves.toBe(true);
    await store.markChecked(tenantId, "connect", "2026-11-19T11:00:00.000Z");
    await store.release(tenantId, "connect", "claim-1");

    expect(calls.every((call) => call.tenant === tenantId)).toBe(true);
    expect(calls[0]?.sql).toContain("kind = 'custom_mcp' AND enabled = true AND publication_status = 'published' AND approval_status = 'approved'");
    expect(calls[1]?.sql).toMatch(/toolsRefresh.*<= \$4::bigint/s);
    expect(calls[2]?.sql).toContain("COALESCE(config->'discoveredTools', 'null'::jsonb) = COALESCE($4::jsonb, 'null'::jsonb)");
    expect(calls[2]?.params).toEqual(["connect", JSON.stringify([tool("a"), tool("b")]), "2026-11-19T11:00:00.000Z", JSON.stringify([tool("a")])]);
    expect(calls[4]?.sql).toContain("config->'toolsRefresh'->>'claimId' = $2");
  });
});

describe("durable MCP executor tool refresh", () => {
  const catalogFixture = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/local-agent/test/fixtures/mcp-catalog-server.mjs");
  const connectorId = "connector_mcp_connect";
  const sockets: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((cleanup) => cleanup()));
    vi.unstubAllGlobals();
  });

  type Setup = {
    cached: McpCachedTool[];
    live: McpCachedTool[];
    input?: string;
    allowedTools?: string[];
    stored?: { tools: McpCachedTool[]; checkedAt: number | null };
    delayMs?: number;
  };

  async function setup(options: Setup) {
    const directory = mkdtempSync(join(tmpdir(), "berry-mcp-refresh-"));
    const catalog = join(directory, "tools.json");
    const log = join(directory, "requests.log");
    const write = (tools: McpCachedTool[]) => writeFileSync(catalog, JSON.stringify(tools));
    write(options.live);
    const key = randomBytes(32).toString("base64");
    const env = { BERRY_DURABLE_CAPABILITY_KEY: key } as NodeJS.ProcessEnv;
    vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
      expect(input.pathname).toBe("/v1/connectors/mcp/runtime-credential");
      return Response.json({ status: "static" });
    }));
    const store = new MemorySnapshotStore();
    store.seed(connectorId, options.stored?.tools ?? options.cached, options.stored ? options.stored.checkedAt : Date.now());
    const refresher = new McpToolSnapshotRefresher(store);
    const tools = new DurableMcpToolExecutor({ execute: vi.fn(async () => ({ output: {}, summary: "base" })) }, [], undefined, 5_000, env, undefined, refresher);
    const input = options.input ?? "Help me with the team's records";
    const snapshot = {
      id: "00000000-0000-7000-8000-000000000901",
      tenantId,
      userId: "user-1",
      workspaceId: "workspace-1",
      runtimeRequest: admittedRuntime(input, {
        id: connectorId,
        name: "Connect",
        transport: "stdio",
        command: process.execPath,
        args: [catalogFixture],
        url: null,
        env: { MCP_CATALOG_FILE: catalog, MCP_CATALOG_LOG: log, ...(options.delayMs ? { MCP_CATALOG_DELAY_MS: String(options.delayMs) } : {}) },
        enabled: true,
        trusted: true,
        credentialRef: `connector:${connectorId}:user-1`,
        credential: await sealDurableSecret("member-token", key),
        cachedTools: options.cached,
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : { defaultTools: options.cached.map((item) => item.name) }),
      }),
      steps: [],
      entries: [{ entryId: "entry-user", parentEntryId: null, entryType: "message", sequence: 1, payload: { type: "message", message: { role: "user", content: input } } }],
      approvals: [],
    } as unknown as DurableTurnSnapshot;
    const listRequests = () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    sockets.push(async () => {
      await tools.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return { tools, snapshot, store, refresher, write, listRequests };
  }

  const search = (query: string, extra: Record<string, unknown> = {}) => ({
    id: `search-${query}`,
    type: "tool.tool_search",
    state: "pending",
    input: { toolName: "tool_search", arguments: { query, connector: connectorId, ...extra } },
  }) as unknown as DurableTurnStep;

  it("re-lists after a tool_search miss, finds the new tool, and stores the server's list", async () => {
    const { tools, snapshot, store, refresher, listRequests } = await setup({
      cached: [tool("people_list")],
      live: [tool("people_list"), tool("fls_team_list")],
    });
    await tools.turnContext(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The stored list is fresh, so the turn did not contact the server.
    expect(listRequests()).toBe(0);

    const found = await tools.execute(snapshot, search("fls_team_list"));
    expect((found.output as { activatedTools: string[] }).activatedTools[0]).toBe("mcp__Connect__fls_team_list");
    expect(listRequests()).toBe(1);
    await refresher.settled(tenantId, connectorId);
    expect(store.tools(connectorId)).toEqual(["people_list", "fls_team_list"]);

    // A second miss moments later is a real miss: no new request to the server.
    await tools.execute(snapshot, search("payroll_export"));
    expect(listRequests()).toBe(1);
  });

  it("refreshes a stale stored list in the background without holding up the turn", async () => {
    const { tools, snapshot, store, listRequests } = await setup({
      cached: [tool("people_list")],
      live: [tool("people_list"), tool("fls_team_list")],
      stored: { tools: [tool("people_list")], checkedAt: Date.now() - 16 * 60_000 },
      delayMs: 300,
    });
    const started = Date.now();
    const context = await tools.turnContext(snapshot);
    expect(Date.now() - started).toBeLessThan(250);
    expect(context).toContain("mcp__Connect__people_list");

    await vi.waitFor(() => expect(store.tools(connectorId)).toEqual(["people_list", "fls_team_list"]), { timeout: 5_000 });
    // The same turn now has the new tool's schema.
    expect(tools.argumentSchema(snapshot, "mcp__Connect__fls_team_list")).toMatchObject({ type: "object" });
    expect(listRequests()).toBe(1);
    expect(store.rows.get(connectorId)?.claim).toBeNull();
  });

  it("re-lists a connector whose arguments were refused and checks against the new schema", async () => {
    const { tools, snapshot, store, refresher } = await setup({
      cached: [tool("leave_log", { kind: { enum: ["sick"] } })],
      live: [tool("leave_log", { kind: { enum: ["sick", "leave"] } })],
    });
    await tools.turnContext(snapshot);
    expect(tools.argumentSchema(snapshot, "mcp__Connect__leave_log")).toMatchObject({ properties: { kind: { enum: ["sick"] } } });

    await tools.refreshArgumentSchemas(snapshot, ["mcp__Connect__leave_log"]);
    expect(tools.argumentSchema(snapshot, "mcp__Connect__leave_log")).toMatchObject({ properties: { kind: { enum: ["sick", "leave"] } } });
    await refresher.settled(tenantId, connectorId);
    expect(diffMcpToolSnapshots(store.rows.get(connectorId)!.tools as McpCachedTool[], [tool("leave_log", { kind: { enum: ["sick", "leave"] } })]).unchanged).toBe(true);
  });

  it("keeps an administrator-reviewed connector's new tools pending while following its approved tools", async () => {
    const { tools, snapshot, store, refresher } = await setup({
      cached: [tool("leave_log", { kind: { enum: ["sick"] } })],
      live: [tool("leave_log", { kind: { enum: ["sick", "leave"] } }), tool("fls_team_list")],
      allowedTools: ["leave_log"],
    });
    await tools.turnContext(snapshot);
    await tools.refreshArgumentSchemas(snapshot, ["mcp__Connect__leave_log"]);

    expect(tools.argumentSchema(snapshot, "mcp__Connect__leave_log")).toMatchObject({ properties: { kind: { enum: ["sick", "leave"] } } });
    expect(tools.argumentSchema(snapshot, "mcp__Connect__fls_team_list")).toBeUndefined();
    const result = await tools.execute(snapshot, search("fls_team_list"));
    expect(result.output).not.toMatchObject({ activatedTools: expect.arrayContaining(["mcp__Connect__fls_team_list"]) });
    // Stored for an administrator to review; the connector's allowlist is untouched.
    await refresher.settled(tenantId, connectorId);
    expect(store.tools(connectorId)).toEqual(["leave_log", "fls_team_list"]);
  });

  it("re-lists before refusing a tool the stored list does not have", async () => {
    const { tools, snapshot } = await setup({
      input: "Use Connect to list the FLS team",
      cached: [tool("people_list")],
      live: [tool("people_list"), tool("fls_team_list")],
    });
    await tools.turnContext(snapshot);
    const result = await tools.execute(snapshot, {
      id: "call-team",
      type: "tool.mcp__Connect__fls_team_list",
      state: "pending",
      input: { toolCallId: "call-team", toolName: "mcp__Connect__fls_team_list", arguments: { team: "fls" } },
    } as unknown as DurableTurnStep);
    expect(result.output).toMatchObject({ content: 'fls_team_list: {"team":"fls"}' });
  });

  it("follows the server's list_changed notification in the turn and in the stored list", async () => {
    const { tools, snapshot, store, write } = await setup({
      input: "Use Connect",
      cached: [tool("notify_tools_changed"), tool("people_list")],
      live: [tool("notify_tools_changed"), tool("people_list")],
    });
    await tools.turnContext(snapshot);
    const run = (name: string) => tools.execute(snapshot, {
      id: `call-${name}`,
      type: `tool.mcp__Connect__${name}`,
      state: "pending",
      input: { toolCallId: `call-${name}`, toolName: `mcp__Connect__${name}`, arguments: {} },
    } as unknown as DurableTurnStep);
    await run("people_list");
    write([tool("notify_tools_changed"), tool("people_list"), tool("fls_team_list")]);
    await run("notify_tools_changed");

    await vi.waitFor(() => expect(store.tools(connectorId)).toEqual(["notify_tools_changed", "people_list", "fls_team_list"]), { timeout: 5_000 });
    expect(tools.argumentSchema(snapshot, "mcp__Connect__fls_team_list")).toMatchObject({ type: "object" });
  });
});

function admittedRuntime(input: string, server: Record<string, unknown>): DurableTurnSnapshot["runtimeRequest"] {
  return {
    capabilityVersion: 1,
    input,
    providerId: "router",
    provider: {
      id: "router",
      name: "Berry Router",
      kind: "berry-router",
      baseUrl: "https://router.example.test/v1",
      defaultModel: "test-model",
      apiType: "openai-chat-completions",
      authType: "none",
      models: [],
    },
    model: "test-model",
    conversationKind: "chat",
    workspacePath: "/workspace",
    workspaceId: "workspace-1",
    permissionMode: "ask",
    reasoning: "off",
    maxTokens: 1_000,
    contextWindowTokens: 16_000,
    modelAcceptsImages: false,
    modelPricing: {},
    builtInTools: [],
    mcpServers: [server],
    extraSkills: [],
    attachments: [],
  } as DurableTurnSnapshot["runtimeRequest"];
}
