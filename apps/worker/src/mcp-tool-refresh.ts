import { createHash, randomUUID } from "node:crypto";
import type { McpCachedTool, McpServerSpec } from "@berry/local-agent/mcp";
import { isStoredMcpCredentialRef } from "@berry/shared";
import type { SqlExecutor } from "./sql-repositories.js";

/**
 * Keeps each custom MCP connector's stored tool list
 * (`organization_connectors.config.discoveredTools`) in step with its server.
 *
 * The list is saved whenever a worker lists the server live: when a run
 * connects to it, when tool_search or argument checking re-lists it, after the
 * server's tools/list_changed notification, and at turn start when the stored
 * list is older than the stale window. Saves compare against the list they
 * diffed, so concurrent workers never overwrite a newer list with an older one,
 * and a claim kept in the connector row lets one worker at a time run the
 * turn-start refresh. Nothing here throws into a turn: every failure keeps the
 * stored list.
 *
 * Approval rules stay where they are. An organization-approved catalog server
 * exposes everything it lists. An administrator-reviewed server still exposes
 * only its allowlisted tool names, so a new tool is stored as pending until an
 * administrator approves it, while an approved tool's definition follows the
 * server.
 */

/** A stored list older than this is refreshed in the background at turn start. */
export const MCP_TOOL_SNAPSHOT_STALE_MS = 15 * 60_000;
/** How long a turn-start refresh claim holds. After a failure it also spaces out retries. */
const MCP_TOOL_REFRESH_CLAIM_MS = 2 * 60_000;
/** An unchanged list updates its checked time at most this often. */
const MCP_TOOL_MARK_CHECKED_AFTER_MS = 5 * 60_000;
/** Lists beyond these bounds are used for the turn but not stored. */
const MCP_TOOL_SNAPSHOT_MAX_TOOLS = 2_000;
const MCP_TOOL_SNAPSHOT_MAX_BYTES = 2_000_000;

/**
 * True for an organization custom MCP connector that the worker may refresh:
 * admitted from `organization_connectors` (its credential reference names the
 * connector) and not a Berry-owned adapter whose catalog Berry defines.
 */
export function isRefreshableConnector(server: Pick<McpServerSpec, "id" | "credentialKey" | "trustReadOnlyAnnotations">): boolean {
  return server.id.startsWith("connector_mcp_")
    && server.trustReadOnlyAnnotations !== true
    && isStoredMcpCredentialRef(server.id, server.credentialKey);
}

export interface McpToolSnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: boolean;
}

/** A tool definition's fingerprint: its input schema, description and safety hints. */
export function mcpToolDefinitionHash(tool: McpCachedTool): string {
  const annotations = compactAnnotations(tool.annotations);
  return createHash("sha256").update(canonicalJson({
    description: tool.description ?? null,
    inputSchema: tool.inputSchema ?? {},
    ...(annotations ? { annotations } : {}),
  })).digest("hex");
}

/** Tool names added, removed, or whose definition changed. Order does not count as a change. */
export function diffMcpToolSnapshots(previous: readonly McpCachedTool[], live: readonly McpCachedTool[]): McpToolSnapshotDiff {
  const before = new Map(previous.map((tool) => [tool.name, mcpToolDefinitionHash(tool)]));
  const after = new Map(live.map((tool) => [tool.name, mcpToolDefinitionHash(tool)]));
  const added = [...after.keys()].filter((name) => !before.has(name)).sort();
  const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
  const changed = [...after].filter(([name, hash]) => before.has(name) && before.get(name) !== hash).map(([name]) => name).sort();
  return { added, removed, changed, unchanged: added.length === 0 && removed.length === 0 && changed.length === 0 };
}

export interface McpToolSnapshotRow {
  /** The stored list exactly as read, which a save must still find in place. */
  stored: unknown;
  tools: McpCachedTool[];
  /** When the server's list was last confirmed (epoch ms), or null. */
  checkedAt: number | null;
  /** When the current turn-start refresh claim expires (epoch ms), or null. */
  claimedUntil: number | null;
}

export interface McpToolSnapshotStore {
  /** Published, approved custom MCP connectors among the ids. Others are absent. */
  read(tenantId: string, connectorIds: readonly string[]): Promise<Map<string, McpToolSnapshotRow>>;
  /** Takes the turn-start refresh claim unless an unexpired one is held. */
  claim(tenantId: string, connectorId: string, claimId: string, now: number, until: number): Promise<boolean>;
  release(tenantId: string, connectorId: string, claimId: string): Promise<void>;
  /** Replaces the list only while the stored one still equals `expected`. */
  replace(tenantId: string, connectorId: string, expected: unknown, tools: readonly McpCachedTool[], at: string): Promise<boolean>;
  markChecked(tenantId: string, connectorId: string, at: string): Promise<void>;
}

const REFRESHABLE_ROW = "kind = 'custom_mcp' AND enabled = true AND publication_status = 'published' AND approval_status = 'approved'";

export class SqlMcpToolSnapshotStore implements McpToolSnapshotStore {
  constructor(private readonly executor: SqlExecutor) {}

  async read(tenantId: string, connectorIds: readonly string[]): Promise<Map<string, McpToolSnapshotRow>> {
    if (connectorIds.length === 0) return new Map();
    const rows = await this.#inTenant(tenantId, (db) => db.query<{
      id: string;
      tools: unknown;
      checked_at: string | null;
      discovered_at: string | null;
      claimed_until: string | null;
    }>(
      `SELECT id, config->'discoveredTools' AS tools, config->>'toolsCheckedAt' AS checked_at,
              config->>'lastDiscoveredAt' AS discovered_at, config->'toolsRefresh'->>'until' AS claimed_until
         FROM organization_connectors
        WHERE id = ANY($1::text[]) AND ${REFRESHABLE_ROW}`,
      [[...connectorIds]],
    ));
    return new Map(rows.map((row) => [row.id, {
      stored: row.tools ?? null,
      tools: snapshotTools(row.tools),
      checkedAt: epoch(row.checked_at) ?? epoch(row.discovered_at),
      claimedUntil: row.claimed_until && /^\d{1,15}$/.test(row.claimed_until) ? Number(row.claimed_until) : null,
    }]));
  }

  async claim(tenantId: string, connectorId: string, claimId: string, now: number, until: number): Promise<boolean> {
    const rows = await this.#inTenant(tenantId, (db) => db.query<{ id: string }>(
      `UPDATE organization_connectors
          SET config = jsonb_set(config, '{toolsRefresh}', jsonb_build_object('claimId', $2::text, 'until', $3::bigint), true)
        WHERE id = $1 AND ${REFRESHABLE_ROW}
          AND CASE WHEN config->'toolsRefresh'->>'until' ~ '^[0-9]{1,15}$'
                   THEN (config->'toolsRefresh'->>'until')::bigint ELSE 0 END <= $4::bigint
        RETURNING id`,
      [connectorId, claimId, until, now],
    ));
    return rows.length > 0;
  }

  async release(tenantId: string, connectorId: string, claimId: string): Promise<void> {
    await this.#inTenant(tenantId, (db) => db.execute(
      "UPDATE organization_connectors SET config = config - 'toolsRefresh' WHERE id = $1 AND config->'toolsRefresh'->>'claimId' = $2",
      [connectorId, claimId],
    ));
  }

  async replace(tenantId: string, connectorId: string, expected: unknown, tools: readonly McpCachedTool[], at: string): Promise<boolean> {
    const rows = await this.#inTenant(tenantId, (db) => db.query<{ id: string }>(
      `UPDATE organization_connectors
          SET config = config || jsonb_build_object('discoveredTools', $2::jsonb, 'lastDiscoveredAt', $3::text, 'toolsCheckedAt', $3::text),
              updated_at = now()
        WHERE id = $1 AND ${REFRESHABLE_ROW}
          AND COALESCE(config->'discoveredTools', 'null'::jsonb) = COALESCE($4::jsonb, 'null'::jsonb)
        RETURNING id`,
      [connectorId, JSON.stringify(tools), at, expected === undefined || expected === null ? null : JSON.stringify(expected)],
    ));
    return rows.length > 0;
  }

  async markChecked(tenantId: string, connectorId: string, at: string): Promise<void> {
    await this.#inTenant(tenantId, (db) => db.execute(
      `UPDATE organization_connectors SET config = config || jsonb_build_object('toolsCheckedAt', $2::text)
        WHERE id = $1 AND ${REFRESHABLE_ROW}`,
      [connectorId, at],
    ));
  }

  async #inTenant<T>(tenantId: string, operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.executor.runWithTenant) return operation(this.executor);
    return this.executor.runWithTenant(tenantId, () => operation(this.executor));
  }
}

export type McpToolRecordOutcome = "saved" | "unchanged" | "conflict" | "skipped" | "failed";

export interface McpToolRefreshEvent {
  operation: "tool_snapshot_save" | "tool_snapshot_refresh";
  outcome: McpToolRecordOutcome | "claimed_elsewhere" | "timed_out";
  tenantId: string;
  connectorId: string;
  itemCount?: number;
  durationMs?: number;
}

export interface McpToolSnapshotRefresherOptions {
  staleAfterMs?: number;
  claimMs?: number;
  markCheckedAfterMs?: number;
  now?: () => number;
  onEvent?: (event: McpToolRefreshEvent) => void;
}

/** One per worker process: saves live tool lists and runs turn-start refreshes. */
export class McpToolSnapshotRefresher {
  readonly #records = new Map<string, Promise<McpToolRecordOutcome>>();
  readonly #refreshes = new Map<string, Promise<void>>();
  /** When a live listing last arrived for a connector in this process. */
  readonly #listedAt = new Map<string, number>();

  constructor(
    private readonly store: McpToolSnapshotStore,
    private readonly options: McpToolSnapshotRefresherOptions = {},
  ) {}

  get staleAfterMs(): number {
    return this.options.staleAfterMs ?? MCP_TOOL_SNAPSHOT_STALE_MS;
  }

  /**
   * Stores a server's complete live tool list when it differs from the stored
   * one. Calls for one connector run one after another; never rejects.
   */
  record(tenantId: string, connectorId: string, live: readonly McpCachedTool[]): Promise<McpToolRecordOutcome> {
    const key = connectorKey(tenantId, connectorId);
    this.#listedAt.set(key, this.#now());
    const previous: Promise<unknown> = this.#records.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.#record(tenantId, connectorId, live))
      .catch((): McpToolRecordOutcome => {
        this.#emit({ operation: "tool_snapshot_save", outcome: "failed", tenantId, connectorId });
        return "failed";
      });
    this.#records.set(key, next);
    void next.finally(() => {
      if (this.#records.get(key) === next) this.#records.delete(key);
    });
    return next;
  }

  /** Resolves once every listing recorded so far for the connector is stored or skipped. */
  async settled(tenantId: string, connectorId: string): Promise<void> {
    await this.#records.get(connectorKey(tenantId, connectorId));
  }

  /**
   * Refreshes, in the background of a starting turn, each connector whose
   * stored list is older than the stale window. One worker at a time per
   * connector runs it. `list` asks the live servers; their lists come back
   * through record(). Never rejects and never waits longer than `timeoutMs`
   * for a server. A failed refresh keeps the stored list and leaves its claim
   * to expire, which spaces out retries against a failing server.
   */
  async refreshStale(
    tenantId: string,
    connectorIds: readonly string[],
    list: (connectorIds: string[]) => Promise<unknown>,
    timeoutMs: number,
  ): Promise<void> {
    if (connectorIds.length === 0) return;
    let rows: Map<string, McpToolSnapshotRow>;
    try {
      rows = await this.store.read(tenantId, connectorIds);
    } catch {
      return;
    }
    const now = this.#now();
    const due = connectorIds.filter((connectorId) => {
      const row = rows.get(connectorId);
      if (!row) return false;
      if (row.claimedUntil !== null && row.claimedUntil > now) return false;
      return row.checkedAt === null || now - row.checkedAt >= this.staleAfterMs;
    });
    await Promise.all(due.map((connectorId) => this.#refreshOne(tenantId, connectorId, list, timeoutMs)));
  }

  #refreshOne(
    tenantId: string,
    connectorId: string,
    list: (connectorIds: string[]) => Promise<unknown>,
    timeoutMs: number,
  ): Promise<void> {
    const key = connectorKey(tenantId, connectorId);
    const running = this.#refreshes.get(key);
    if (running) return running;
    const refresh = (async () => {
      const started = this.#now();
      const claimId = randomUUID();
      try {
        if (!await this.store.claim(tenantId, connectorId, claimId, started, started + (this.options.claimMs ?? MCP_TOOL_REFRESH_CLAIM_MS))) {
          this.#emit({ operation: "tool_snapshot_refresh", outcome: "claimed_elsewhere", tenantId, connectorId });
          return;
        }
      } catch {
        return;
      }
      let timedOut = false;
      try {
        await withTimeout(list([connectorId]), timeoutMs).catch((error: unknown) => {
          if (error instanceof RefreshTimeoutError) timedOut = true;
        });
        const listed = (this.#listedAt.get(key) ?? 0) >= started;
        if (!listed) {
          this.#emit({ operation: "tool_snapshot_refresh", outcome: timedOut ? "timed_out" : "failed", tenantId, connectorId, durationMs: this.#now() - started });
          return;
        }
        await this.settled(tenantId, connectorId);
        await this.store.release(tenantId, connectorId, claimId).catch(() => undefined);
      } catch {
        // The stored list stays in use; the claim expires on its own.
      }
    })().finally(() => {
      if (this.#refreshes.get(key) === refresh) this.#refreshes.delete(key);
    });
    this.#refreshes.set(key, refresh);
    return refresh;
  }

  async #record(tenantId: string, connectorId: string, live: readonly McpCachedTool[]): Promise<McpToolRecordOutcome> {
    const started = this.#now();
    if (live.length === 0 || live.length > MCP_TOOL_SNAPSHOT_MAX_TOOLS || JSON.stringify(live).length > MCP_TOOL_SNAPSHOT_MAX_BYTES) {
      // An empty list is more likely a broken server than a retired catalog.
      this.#emit({ operation: "tool_snapshot_save", outcome: "skipped", tenantId, connectorId, itemCount: live.length });
      return "skipped";
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = (await this.store.read(tenantId, [connectorId])).get(connectorId);
      if (!row) return "skipped";
      const now = this.#now();
      const at = new Date(now).toISOString();
      const diff = diffMcpToolSnapshots(row.tools, live);
      if (diff.unchanged) {
        if (row.checkedAt === null || now - row.checkedAt >= (this.options.markCheckedAfterMs ?? MCP_TOOL_MARK_CHECKED_AFTER_MS)) {
          await this.store.markChecked(tenantId, connectorId, at);
        }
        return "unchanged";
      }
      if (await this.store.replace(tenantId, connectorId, row.stored, live, at)) {
        this.#emit({
          operation: "tool_snapshot_save",
          outcome: "saved",
          tenantId,
          connectorId,
          itemCount: diff.added.length + diff.removed.length + diff.changed.length,
          durationMs: this.#now() - started,
        });
        return "saved";
      }
      // Another worker stored a list since this one was read: diff against it.
    }
    this.#emit({ operation: "tool_snapshot_save", outcome: "conflict", tenantId, connectorId });
    return "conflict";
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #emit(event: McpToolRefreshEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Telemetry never affects a refresh.
    }
  }
}

class RefreshTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RefreshTimeoutError(`timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function connectorKey(tenantId: string, connectorId: string): string {
  return `${tenantId}\u0000${connectorId}`;
}

function epoch(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The stored list as tool definitions, ignoring malformed entries. */
function snapshotTools(value: unknown): McpCachedTool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): McpCachedTool[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name) return [];
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema as Record<string, unknown>
      : {};
    const annotations = compactAnnotations(tool.annotations);
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : null,
      inputSchema,
      ...(annotations ? { annotations } : {}),
    }];
  });
}

function compactAnnotations(value: unknown): McpCachedTool["annotations"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: NonNullable<McpCachedTool["annotations"]> = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
