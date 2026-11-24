import type { AgentTool, AgentToolResult } from "@berry/harness";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type TSchema } from "typebox";
import { ExecPolicyEngine, type ExecPolicyRule } from "@berry/execpolicy";
import { networkDomainAllowed, type NetworkPolicy } from "@berry/shared";
import { z } from "zod";
import { createPublicRemoteFetch, validatedPublicRemoteUrl } from "./remote-fetch.ts";
import { McpConnectionError, observeMcpTransport, waitForMcpRetry, type McpResolvedCredential } from "./mcp-connection.ts";
import {
  BERRYCRAWL_DEFAULT_TOOL_NAMES,
  BERRYCRAWL_NON_REPLAYABLE_TOOL_NAMES,
  BERRYCRAWL_TOOL_CATALOG,
} from "./berrycrawl-tools.ts";

export { BERRYCRAWL_TOOL_CATALOG, BERRYCRAWL_DEFAULT_TOOL_NAMES, BERRYCRAWL_NON_REPLAYABLE_TOOL_NAMES } from "./berrycrawl-tools.ts";
export { McpConnectionError, type McpResolvedCredential } from "./mcp-connection.ts";

export interface McpCachedTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpServerSpec {
  id: string;
  name: string;
  transport: "stdio" | "http-sse" | "streamable-http";
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  enabled: boolean;
  trusted: boolean;
  credential?: string | null;
  credentialKey?: string | null;
  cachedTools?: McpCachedTool[];
  /** Server tool names approved by the organization. Omit for unrestricted discovery. */
  allowedTools?: string[];
  /**
   * With allowedTools: an approved tool whose live definition differs from its
   * cached one is used as the server now describes it, instead of being
   * disabled until it is reviewed again. Unapproved tool names stay excluded.
   */
  followApprovedToolChanges?: boolean;
  /** Remote tool names exposed on the first model call without tool_search. */
  defaultTools?: string[];
  /** Remote tool names whose ambiguous execution outcome must not be replayed. */
  nonReplayableTools?: string[];
  /** Only Berry-owned adapters may make read-only annotations authoritative. */
  trustReadOnlyAnnotations?: boolean;
  /** Berry-owned tool names that require approval in every task permission mode. */
  approvalRequiredTools?: string[];
}

export interface McpServerHealth {
  id: string;
  status: "connecting" | "connected" | "auth-required" | "error";
  toolCount: number;
  latencyMs: number | null;
  lastError: string | null;
  tools: McpCachedTool[];
}

/** Why a source listed a server's tools: a new connection, an explicit refresh, or the server's list_changed notification. */
export type McpToolListReason = "connect" | "refresh" | "list_changed";

export interface McpToolSourceOptions {
  servers: McpServerSpec[];
  log?: (level: "info" | "warn" | "error", message: string) => void;
  connectTimeoutMs?: number;
  onHealth?: (health: McpServerHealth) => void | Promise<void>;
  /**
   * Receives a server's complete live tools/list result, before any allowlist
   * or review filtering, each time this source lists it. It is not awaited and
   * its failures are ignored, so it never delays or breaks a connection.
   */
  onToolsListed?: (spec: McpServerSpec, tools: McpCachedTool[], reason: McpToolListReason) => void | Promise<void>;
  enableToolListNotifications?: boolean;
  networkPolicy?: NetworkPolicy;
  execPolicyRules?: ExecPolicyRule[];
  resolveCredential?: (server: McpServerSpec, signal?: AbortSignal, rejectedVersion?: string) => Promise<McpResolvedCredential | undefined>;
}

const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(["stdio", "http-sse", "streamable-http"]),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  url: z.string().url().nullable().default(null),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  trusted: z.boolean().default(true),
  credential: z.string().nullable().optional(),
  credentialEnv: z.string().min(1).optional(),
  credentialKey: z.string().nullable().optional(),
  cachedTools: z.array(z.object({
    name: z.string(),
    description: z.string().nullable().default(null),
    inputSchema: z.record(z.unknown()),
    annotations: z.object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    }).optional(),
  })).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  defaultTools: z.array(z.string().min(1)).optional(),
  nonReplayableTools: z.array(z.string().min(1)).optional(),
  trustReadOnlyAnnotations: z.boolean().optional(),
  approvalRequiredTools: z.array(z.string().min(1)).optional(),
});

/** Parses deploy-safe MCP configuration while resolving credentials from the receiving process only. */
export function mcpServerSpecsFromJson(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): McpServerSpec[] {
  if (!raw?.trim()) return [];
  return z.array(McpServerConfigSchema).parse(JSON.parse(raw)).map((server) => {
    const bundledBerryCrawl = isOfficialBerryCrawlServer(server);
    const credential = server.credentialEnv
      ? env[server.credentialEnv]?.trim()
      : server.credential?.trim();
    const cachedTools = server.cachedTools ?? (bundledBerryCrawl
      ? BERRYCRAWL_TOOL_CATALOG.map((tool) => ({
          ...tool,
          inputSchema: structuredClone(tool.inputSchema),
          ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
        }))
      : undefined);
    const allowedTools = server.allowedTools ?? (bundledBerryCrawl
      ? BERRYCRAWL_TOOL_CATALOG.map((tool) => tool.name)
      : undefined);
    const defaultTools = server.defaultTools ?? (bundledBerryCrawl
      ? [...BERRYCRAWL_DEFAULT_TOOL_NAMES]
      : undefined);
    const nonReplayableTools = server.nonReplayableTools ?? (bundledBerryCrawl
      ? [...BERRYCRAWL_NON_REPLAYABLE_TOOL_NAMES]
      : undefined);
    const trustReadOnlyAnnotations = server.trustReadOnlyAnnotations ?? bundledBerryCrawl;
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      env: server.env,
      enabled: server.enabled,
      trusted: server.trusted,
      credentialKey: server.credentialKey ?? (server.credentialEnv ? `env:${server.credentialEnv}` : null),
      ...(cachedTools ? {
        cachedTools: cachedTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: compactAnnotations(tool.annotations) } : {}),
        })),
      } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(defaultTools ? { defaultTools } : {}),
      ...(nonReplayableTools ? { nonReplayableTools } : {}),
      ...(trustReadOnlyAnnotations ? { trustReadOnlyAnnotations: true } : {}),
      ...(server.approvalRequiredTools ? { approvalRequiredTools: server.approvalRequiredTools } : {}),
      ...(credential ? { credential } : {}),
    };
  });
}

export function isOfficialBerryCrawlServer(server: {
  id: string;
  name: string;
  transport: McpServerSpec["transport"];
  url: string | null;
}): boolean {
  if (server.id.toLowerCase() !== "berrycrawl") return false;
  if (server.name.toLowerCase().replace(/[^a-z0-9]+/g, "") !== "berrycrawl") return false;
  if (server.transport !== "streamable-http" || !server.url) return false;
  try {
    const url = new URL(server.url);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "api.berrycrawl.com"
      && url.pathname.replace(/\/+$/, "") === "/api/v1/mcp";
  } catch {
    return false;
  }
}

interface ConnectedServer {
  spec: McpServerSpec;
  client: Client;
  tools: AgentTool[];
  cachedTools: McpCachedTool[];
  version: string | undefined;
  inUse: number;
  retired: boolean;
  /** When tools/list last completed on this connection (epoch ms). */
  listedAt: number;
}

const operationContext = new AsyncLocalStorage<string>();
export function withMcpOperation<T>(operationId: string, action: () => Promise<T>): Promise<T> {
  return operationContext.run(operationId, action);
}

function wireJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(wireJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ":" + wireJson(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

const operationReceipt = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unknown"), operationId: z.string().uuid(), supportedTools: z.array(z.string()).max(1024).optional(), closeUnappliedTool: z.string().optional() }),
  z.object({ status: z.literal("applied"), operationId: z.string().uuid(), tool: z.string(), argumentsHash: z.string(), result: z.unknown() }),
  z.object({ status: z.literal("rejected"), operationId: z.string().uuid(), tool: z.string(), argumentsHash: z.string(),
    httpStatus: z.number().int().min(400).max(499), code: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/) }),
]);

const mcpRequestSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/** A tools/list result across every page, and whether all pages arrived. */
interface LiveToolListing {
  tools: McpCachedTool[];
  complete: boolean;
}

/** Pages followed in one tools/list before Berry stops and keeps what it has. */
const MAX_TOOL_LIST_PAGES = 50;

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const SAFE_ENV_KEYS = new Set(["HOME", "PATH", "SHELL", "TMPDIR", "TMP", "TEMP", "USER", "USERNAME", "SystemRoot", "ComSpec"]);

function mcpProcessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extra };
}

export function validatedRemoteMcpUrl(rawUrl: string): URL {
  try {
    return validatedPublicRemoteUrl(rawUrl);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.replace(/^remote endpoints?/, "remote MCP servers") : "invalid remote MCP URL";
    throw new Error(message);
  }
}

function contentToToolResult(content: unknown, structuredContent?: unknown): AgentToolResult<Record<string, unknown>> {
  const parts = Array.isArray(content) ? content : [];
  const texts = parts
    .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
    .map((part) => part.text);
  // Browser screenshots are MCP image blocks. Keep bounded raster data so
  // vision-capable models can see the page instead of silently losing it.
  const images = parts.flatMap((part): Array<{ type: "image"; data: string; mimeType: string }> => {
    if (typeof part !== "object" || part === null) return [];
    const image = part as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string"
      || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)
      || image.data.length === 0 || image.data.length > 8 * 1024 * 1024
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return [];
    return [{ type: "image", data: image.data, mimeType: image.mimeType }];
  }).slice(0, 5);
  const omittedImages = parts.filter((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image").length - images.length;
  const text = [texts.join("\n"), ...(omittedImages ? [`[${omittedImages} unsupported or oversized MCP image(s) omitted. Use a DOM snapshot or a smaller screenshot.]`] : [])].filter(Boolean).join("\n");
  return {
    content: [{ type: "text", text: text || "(no output)" }, ...images],
    details: {
      raw: parts as unknown as Record<string, unknown>,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    } as Record<string, unknown>,
  };
}

function bearerToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown; accessToken?: unknown };
    const token = typeof parsed.access_token === "string" ? parsed.access_token : typeof parsed.accessToken === "string" ? parsed.accessToken : null;
    return token?.trim() || null;
  } catch {
    return raw.trim() || null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function cachedTool(
  spec: McpServerSpec,
  cached: McpCachedTool,
  invoke: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<Record<string, unknown>>>,
): AgentTool {
  return {
    name: `mcp__${sanitizeName(spec.name)}__${sanitizeName(cached.name)}`,
    label: `${spec.name}: ${cached.name}`,
    description: cached.description ?? `Tool ${cached.name} from MCP server ${spec.name}`,
    parameters: cached.inputSchema as TSchema,
    execute: async (_toolCallId, params, signal) => invoke(cached.name, (params ?? {}) as Record<string, unknown>, signal),
  } as AgentTool;
}

function liveToolDefinition(tool: { name: string; description?: string | undefined; inputSchema?: unknown; annotations?: unknown }): McpCachedTool {
  const annotations = tool.annotations && typeof tool.annotations === "object"
    ? compactAnnotations(tool.annotations as NonNullable<McpCachedTool["annotations"]>)
    : undefined;
  return {
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

/**
 * Every page of tools/list. A server that keeps returning cursors past the
 * page limit yields the tools received so far, marked incomplete.
 */
async function listAllTools(client: Client, signal?: AbortSignal): Promise<LiveToolListing> {
  const tools = new Map<string, McpCachedTool>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, signal ? { signal } : undefined);
    for (const tool of result.tools) {
      if (!tools.has(tool.name)) tools.set(tool.name, liveToolDefinition(tool));
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) return { tools: [...tools.values()], complete: true };
  }
  return { tools: [...tools.values()], complete: false };
}

function sameReviewedToolDefinition(reviewed: McpCachedTool, live: McpCachedTool): boolean {
  return canonicalJson(reviewDocument(reviewed)) === canonicalJson(reviewDocument(live));
}

function reviewDocument(tool: McpCachedTool): Record<string, unknown> {
  const annotations = tool.annotations ? compactAnnotations(tool.annotations) : undefined;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
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

/**
 * Records on a failed call which side of dispatch it failed on, as
 * `toolCallPhase`: "not_sent" before the request reached the server, so the
 * tool did not run, or "dispatched" after it was sent, when the tool may have
 * run. A result the SDK rejects after the tool ran (an output schema
 * mismatch) is a dispatched failure, whatever its wording. Only a typed HTTP
 * transport refusal is "rejected"; statuses inside a tool result are not.
 */
function failedCall(error: unknown, phase: "not_sent" | "dispatched" | "rejected"): unknown {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "toolCallPhase", { value: phase, configurable: true, enumerable: true });
      return error;
    } catch {
      // A frozen error is wrapped below.
    }
  }
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { toolCallPhase: phase });
}

/**
 * An MCP tool returned an error result. The structured content (error codes,
 * statuses, diagnostics) stays attached so callers can classify the failure
 * without parsing its text.
 */
export class McpToolError extends Error {
  readonly structuredContent: unknown;
  /** The server answered a dispatched call. */
  readonly toolCallPhase = "dispatched";

  constructor(message: string, structuredContent: unknown) {
    super(message);
    this.name = "McpToolError";
    this.structuredContent = structuredContent;
  }
}

/** Connects MCP servers independently. Cached schemas are usable before connecting. */
export class McpToolSource {
  readonly #options: McpToolSourceOptions;
  readonly #servers = new Map<string, ConnectedServer>();
  readonly #connecting = new Map<string, { version: string | undefined; promise: Promise<ConnectedServer> }>();
  readonly #relisting = new Map<ConnectedServer, Promise<void>>();
  /** Advanced by close() so connections still starting at that moment are not kept. */
  #generation = 0;

  constructor(options: McpToolSourceOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    await Promise.all(this.#options.servers.map(async (spec) => {
      if (!spec.enabled) return;
      if (!spec.trusted) {
        this.#options.log?.("warn", `MCP server ${spec.name} is enabled but not trusted; skipping`);
        return;
      }
      try {
        await this.discoverServer(spec.id);
      } catch {
        // Each server publishes its own health and does not make the source fail.
      }
    }));
  }

  connectInBackground(): void {
    void this.connect();
  }

  /**
   * Lazily list tools for trusted servers that were admitted without a cached
   * catalog. This keeps startup non-blocking while ensuring tool_search can
   * bootstrap a newly connected service instead of disappearing forever.
   */
  async discoverTools(serverIds?: readonly string[], signal?: AbortSignal): Promise<AgentTool[]> {
    const selected = serverIds ? new Set(serverIds) : null;
    await Promise.all(this.#options.servers.map(async (spec) => {
      if (!spec.enabled || !spec.trusted || (selected && !selected.has(spec.id))) return;
      try {
        await this.discoverServer(spec.id, signal);
      } catch {
        // One unavailable connector must not hide healthy authorized servers.
      }
    }));
    return this.listTools();
  }

  async discoverServer(id: string, signal?: AbortSignal): Promise<McpCachedTool[]> {
    const spec = this.#options.servers.find((server) => server.id === id && server.enabled && server.trusted);
    if (!spec) throw new McpConnectionError("configuration", true);
    return this.#withConnection(spec, signal, true, async (server) => server.cachedTools);
  }

  /**
   * Lists tools again for the given trusted servers (all when omitted): a
   * connected server re-lists on its open connection and any other connects.
   * One server's failure leaves its previous tools in place and does not
   * affect the others. Concurrent calls for a server share one request.
   */
  async refreshTools(serverIds?: readonly string[], signal?: AbortSignal): Promise<AgentTool[]> {
    const selected = serverIds ? new Set(serverIds) : null;
    await Promise.all(this.#options.servers.map(async (spec) => {
      if (!spec.enabled || !spec.trusted || (selected && !selected.has(spec.id))) return;
      try {
        const existing = this.#servers.get(spec.id);
        await this.#withConnection(spec, signal, true, async (server) => {
          if (server === existing) await this.#relist(server, "refresh", signal);
        });
      } catch {
        // The cached or previously listed tools stay in use.
      }
    }));
    return this.listTools();
  }

  /** When this source last listed the server's tools live (epoch ms), or null if it has not. */
  listedAt(serverId: string): number | null {
    return this.#servers.get(serverId)?.listedAt ?? null;
  }

  async #ensureConnected(spec: McpServerSpec, version?: string, signal?: AbortSignal): Promise<ConnectedServer> {
    signal?.throwIfAborted();
    const generation = this.#generation;
    const existing = this.#servers.get(spec.id);
    if (existing && existing.version === version) return existing;
    if (existing) this.#retire(existing);
    const pending = this.#connecting.get(spec.id);
    if (pending) {
      if (pending.version === version) return pending.promise;
      await pending.promise.catch(() => undefined);
      if (generation !== this.#generation) throw new McpConnectionError("temporary", true);
      return this.#ensureConnected(spec, version, signal);
    }
    const started = Date.now();
    // The SDK installs this handler only when the server advertises
    // tools.listChanged; Berry lists every page itself instead of autoRefresh.
    const client: Client = new Client({ name: "berry-desktop", version: "0.1.0" }, {
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 300,
          onChanged: () => {
            if (this.#options.enableToolListNotifications === false) return;
            const server = this.#servers.get(spec.id);
            if (server?.client === client) void this.#relist(server, "list_changed").catch(() => undefined);
          },
        },
      },
    });
    const promise = Promise.resolve().then(async () => {
      await this.#options.onHealth?.({ id: spec.id, status: "connecting", toolCount: spec.cachedTools?.length ?? 0, latencyMs: null, lastError: null, tools: spec.cachedTools ?? [] });
      return withTimeout(this.#connectServer(spec, client, version, signal), this.#options.connectTimeoutMs ?? 10_000, `MCP server ${spec.name}`);
    })
      .then(async (server) => {
        // A connection that finishes after close() (a background refresh
        // outliving its turn) is shut down instead of kept open unowned.
        if (generation !== this.#generation) throw new Error(`MCP server ${spec.name} connected after its source closed`);
        this.#servers.set(spec.id, server);
        this.#options.log?.("info", `MCP server ${spec.name} exposed ${server.tools.length} tool(s)`);
        await this.#options.onHealth?.({ id: spec.id, status: "connected", toolCount: server.tools.length, latencyMs: Date.now() - started, lastError: null, tools: server.cachedTools });
        return server;
      })
      .catch(async (error: unknown) => {
        void client.close().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        const status = /unauthorized|401|authorization|auth required/i.test(message) ? "auth-required" as const : "error" as const;
        this.#options.log?.("error", `MCP server ${spec.name} failed to start: ${message}`);
        await this.#options.onHealth?.({ id: spec.id, status, toolCount: spec.cachedTools?.length ?? 0, latencyMs: Date.now() - started, lastError: message, tools: spec.cachedTools ?? [] });
        throw error;
      })
      .finally(() => {
        if (this.#connecting.get(spec.id)?.promise === promise) this.#connecting.delete(spec.id);
      });
    this.#connecting.set(spec.id, { version, promise });
    return promise;
  }

  async #connectServer(spec: McpServerSpec, client: Client, version?: string, signal?: AbortSignal): Promise<ConnectedServer> {
    if (spec.transport === "stdio") {
      if (!spec.command) throw new Error("stdio MCP server has no command");
      await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: mcpProcessEnv(spec.env), stderr: "ignore" }));
    } else {
      const url = this.#remoteUrl(spec);
      // Managed tool POSTs must never be resubmitted by HTTP redirect handling.
      const fetchRemote = createPublicRemoteFetch({ bearerToken: version ? spec.credential ?? null : bearerToken(spec.credential), ...(version ? { redirect: "manual" as const } : {}) });
      if (spec.transport === "streamable-http") {
        const remoteFetch = version ? observeMcpTransport(fetchRemote, true, () => mcpRequestSignal.getStore()) : fetchRemote;
        await client.connect(new StreamableHTTPClientTransport(url, {
          fetch: remoteFetch,
          // Berry owns replay. Disable the SDK's separate SSE reconnection loop.
          ...(version ? { reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } } : {}),
        }) as never, signal ? { signal } : undefined);
      } else {
        // EventSource replaces errors raised by its fetch callback. Preserve
        // the inspected failure for the initialization that installed it.
        let opening = true;
        let failure: McpConnectionError | undefined;
        const remoteFetch = version ? observeMcpTransport(fetchRemote, false, () => mcpRequestSignal.getStore(), (error) => {
          if (opening) failure = error;
        }) : fetchRemote;
        try { await client.connect(new SSEClientTransport(url, { fetch: remoteFetch }), signal ? { signal } : undefined); }
        catch (cause) { throw failure ?? cause; }
        finally { opening = false; }
      }
    }
    const listing = await listAllTools(client, signal);
    const server: ConnectedServer = { spec, client, tools: [], cachedTools: [], version, inUse: 0, retired: false, listedAt: 0 };
    this.#adopt(server, listing, "connect");
    return server;
  }

  /** Installs a live listing on a connection and reports it to onToolsListed. */
  #adopt(server: ConnectedServer, listing: LiveToolListing, reason: McpToolListReason): void {
    const { spec, client } = server;
    if (!listing.complete) {
      this.#options.log?.("warn", `MCP server ${spec.name} returned more than ${MAX_TOOL_LIST_PAGES} pages of tools; using the tools received`);
    }
    server.cachedTools = this.#acceptedTools(spec, listing.tools);
    server.tools = server.cachedTools.map((tool) => cachedTool(spec, tool, async (name, args, signal) => this.#call(client, name, args, signal, spec)));
    server.listedAt = Date.now();
    // A partial listing would read as removed tools, so only report complete ones.
    if (!listing.complete || !this.#options.onToolsListed) return;
    try {
      void Promise.resolve(this.#options.onToolsListed(spec, listing.tools.map((tool) => structuredClone(tool)), reason)).catch(() => {});
    } catch {
      // Observers never affect the connection.
    }
  }

  /** The live tools this source exposes for a server, after its allowlist and review rules. */
  #acceptedTools(spec: McpServerSpec, live: readonly McpCachedTool[]): McpCachedTool[] {
    const allow = spec.allowedTools ? new Set(spec.allowedTools) : null;
    const reviewed = allow
      ? new Map((spec.cachedTools ?? []).filter((tool) => allow.has(tool.name)).map((tool) => [tool.name, tool]))
      : null;
    return live.flatMap((tool): McpCachedTool[] => {
      if (allow && !allow.has(tool.name)) return [];
      if (!reviewed) return [tool];
      const approved = reviewed.get(tool.name);
      if (approved && sameReviewedToolDefinition(approved, tool)) return [approved];
      if (spec.followApprovedToolChanges) return [tool];
      this.#options.log?.("warn", `MCP tool ${spec.name}:${tool.name} changed after administrator review; disabling it until republished`);
      return [];
    });
  }

  #remoteUrl(spec: McpServerSpec): URL {
    if (!spec.url) throw new McpConnectionError("configuration", true, {}, `${spec.transport} MCP server has no URL.`);
    const url = validatedRemoteMcpUrl(spec.url);
    const policy = this.#options.networkPolicy;
    if (policy?.egress === "off") throw new McpConnectionError("configuration", true, {}, "network egress is off for remote MCP servers");
    if (policy && !networkDomainAllowed(url.hostname, policy.allowedDomains)) throw new McpConnectionError("configuration", true, {}, `${url.hostname} is not in the network domain allowlist`);
    const decision = new ExecPolicyEngine(this.#options.execPolicyRules ?? []).evaluateNetwork(url.toString());
    if (decision.decision === "forbid") throw new McpConnectionError("configuration", true, {}, `Execution policy forbids remote MCP server ${url.hostname}.`);
    return url;
  }

  async #withConnection<T>(
    spec: McpServerSpec, signal: AbortSignal | undefined, safeToReplay: boolean,
    execute: (server: ConnectedServer) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const generation = this.#generation;
    // Check policy before an OAuth resolution can contact the issuer.
    if (this.#options.resolveCredential && spec.transport !== "stdio") this.#remoteUrl(spec);
    let credential = await this.#options.resolveCredential?.(spec, signal);
    let connection: ConnectedServer | undefined;
    const attempt = async () => {
      signal?.throwIfAborted();
      if (generation !== this.#generation) throw new McpConnectionError("temporary", true);
      const effective = credential ? { ...spec, credential: credential.accessToken } : spec;
      let server: ConnectedServer;
      try {
        server = await this.#ensureConnected(effective, credential?.version, signal);
      } catch (cause) {
        if (!credential) throw failedCall(cause, "not_sent");
        if (signal?.aborted) throw cause;
        if (cause instanceof McpConnectionError) throw new McpConnectionError(cause.kind, true, cause.details, cause.message);
        throw new McpConnectionError("temporary", true);
      }
      if (server.retired) throw new McpConnectionError("temporary", true);
      connection = server;
      server.inUse += 1;
      try { return await execute(server); }
      finally {
        server.inUse -= 1;
        if (server.retired && server.inUse === 0) void server.client.close().catch(() => undefined);
      }
    };
    if (!credential) return attempt();
    return mcpRequestSignal.run(signal, async () => {
      try { return await attempt(); }
      catch (cause) {
        if (!(cause instanceof McpConnectionError) || signal?.aborted) throw cause;
        if (!cause.beforeDispatch && !safeToReplay) throw cause;
        if (cause.kind === "token_rejected") {
          credential = await this.#options.resolveCredential!(spec, signal, credential!.version);
          if (!credential) throw new McpConnectionError("configuration", true);
          if (connection) this.#retire(connection);
        } else if (cause.kind === "session_expired") {
          if (connection) this.#retire(connection);
        } else if (cause.kind === "temporary") {
          if (!await waitForMcpRetry(cause.details.retryAfterMs, signal)) {
            throw new McpConnectionError("temporary", cause.beforeDispatch, { ...cause.details, exhausted: true });
          }
        } else throw cause;

        try { return await attempt(); }
        catch (retry) {
          if (!(retry instanceof McpConnectionError)) throw retry;
          const kind = retry.kind === "token_rejected" || retry.kind === "session_expired" ? "temporary" : retry.kind;
          throw new McpConnectionError(kind, cause.beforeDispatch && retry.beforeDispatch, { ...retry.details, exhausted: true });
        }
      }
    });
  }

  #retire(server: ConnectedServer): void {
    if (this.#servers.get(server.spec.id) === server) this.#servers.delete(server.spec.id);
    if (server.retired) return;
    server.retired = true;
    if (server.inUse === 0) void server.client.close().catch(() => undefined);
  }

  /** Runs tools/list again on an open connection. Concurrent calls share one request. */
  async #relist(server: ConnectedServer, reason: McpToolListReason, signal?: AbortSignal): Promise<void> {
    const pending = this.#relisting.get(server);
    if (pending) return pending;
    const promise = withTimeout(listAllTools(server.client, signal), this.#options.connectTimeoutMs ?? 10_000, `MCP server ${server.spec.name} tools/list`)
      .then((listing) => {
        if (this.#servers.get(server.spec.id) !== server) return;
        this.#adopt(server, listing, reason);
        this.#options.log?.("info", `MCP server ${server.spec.name} exposed ${server.tools.length} tool(s) after ${reason}`);
      })
      .finally(() => {
        if (this.#relisting.get(server) === promise) this.#relisting.delete(server);
      });
    this.#relisting.set(server, promise);
    return promise;
  }

  async #call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    spec?: McpServerSpec,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    if (signal?.aborted) throw signal.reason;
    // Reviewed browser action batches can run for 120 seconds. Give their
    // response room to settle instead of timing out at the SDK's 60s default.
    const browserCall = spec && isOfficialBerryCrawlServer(spec) && name.startsWith("berrycrawl_browser_");
    const requestOptions = { ...(signal ? { signal } : {}), ...(browserCall ? { timeout: 150_000 } : {}) };
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      const operationId = operationContext.getStore();
      result = await client.callTool({ name, arguments: args, ...(operationId ? { _meta: { "berry.dev/operation-id": operationId } } : {}) }, undefined, requestOptions);
    } catch (error) {
      if (error instanceof McpConnectionError) throw error;
      // Only a refusal from the HTTP transport proves the tool did not run.
      const rejected = error instanceof StreamableHTTPError && typeof error.code === "number"
        && error.code >= 400 && error.code < 500 && error.code !== 408;
      throw failedCall(error, rejected ? "rejected" : "dispatched");
    }
    if (result.isError) {
      const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
      const failure = contentToToolResult(result.content, structuredContent);
      const text = failure.content[0];
      throw new McpToolError(text && text.type === "text" ? text.text : "MCP tool failed", structuredContent);
    }
    return contentToToolResult(result.content, (result as { structuredContent?: unknown }).structuredContent);
  }

  listTools(): AgentTool[] {
    return this.#options.servers.flatMap((spec) => {
      if (!spec.enabled || !spec.trusted) return [];
      const live = this.#servers.get(spec.id);
      const allowed = spec.allowedTools ? new Set(spec.allowedTools) : null;
      const cached = (live?.cachedTools ?? spec.cachedTools ?? []).filter((tool) => tool.name !== "berry_close_unapplied_operation" && (!allowed || allowed.has(tool.name)));
      return cached.map((tool) => cachedTool(spec, tool, (name, args, signal) => this.#executeTool(spec, name, args, signal, false)));
    });
  }

  async readOperationReceipt(serverId: string, toolName: string, operationId: string, args: unknown, signal: AbortSignal, closeUnapplied = false) {
    const spec = this.#options.servers.find((entry) => entry.id === serverId && entry.trusted && entry.enabled && entry.transport !== "stdio");
    if (!spec || !z.string().uuid().safeParse(operationId).success) return;
    const uri = `berry-receipt://operations/${operationId}`;
    return this.#withConnection(spec, signal, true, async (server) => {
      const tool = server.cachedTools.find((entry) => `mcp__${sanitizeName(spec.name)}__${sanitizeName(entry.name)}` === toolName);
      if (!tool || !server.client.getServerCapabilities()?.resources) return;
      const reply = await server.client.readResource({ uri }, { signal, timeout: 8_000 });
      const item = reply.contents[0];
      if (reply.contents.length !== 1 || item?.uri !== uri || !("text" in item) || typeof item.text !== "string" || item.text.length > 1_048_576) return;
      const parsed = operationReceipt.safeParse(JSON.parse(item.text));
      if (!parsed.success || parsed.data.operationId !== operationId) return;
      let receipt = parsed.data;
      const expected = createHash("sha256").update(wireJson(args)).digest("hex");
      if (receipt.status === "unknown") {
        if (receipt.supportedTools && !receipt.supportedTools.includes(tool.name)) return;
        const closeName = receipt.closeUnappliedTool;
        const reviewed = spec.cachedTools?.find(entry => entry.name === closeName);
        const live = server.cachedTools.find(entry => entry.name === closeName);
        if (!closeUnapplied || closeName !== "berry_close_unapplied_operation" || !receipt.supportedTools?.includes(tool.name)
            || spec.approvalRequiredTools?.includes(closeName)
            || (spec.allowedTools && !spec.allowedTools.includes(closeName))
            || !reviewed || !live || !sameReviewedToolDefinition(reviewed, live)
            || reviewed.annotations?.idempotentHint !== true || reviewed.annotations?.readOnlyHint !== false) {
          return { status: "pending" as const };
        }
        const closed = await server.client.callTool({ name: closeName, arguments: {
          operationId, tool: tool.name, argumentsHash: expected,
        } }, undefined, { signal, timeout: 8_000 });
        const content = closed.content;
        if (closed.isError || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text"
            || typeof content[0].text !== "string" || content[0].text.length > 1_048_576) return;
        const final = operationReceipt.safeParse(JSON.parse(content[0].text));
        if (!final.success || final.data.status === "unknown" || final.data.operationId !== operationId) return;
        receipt = final.data;
      }
      if (receipt.tool !== tool.name || receipt.argumentsHash !== expected) return;
      if (receipt.status === "applied" && receipt.result === undefined) return;
      return receipt;
    });
  }

  async executeReviewedRead(serverId: string, wireName: string, args: Record<string, unknown>, signal: AbortSignal) {
    const spec = this.#options.servers.find((entry) => entry.id === serverId && entry.enabled && entry.trusted);
    const reviewed = spec?.cachedTools?.find((tool) => tool.name === wireName && tool.annotations?.readOnlyHint === true && !tool.annotations.destructiveHint);
    if (!spec || !reviewed) throw new Error("The configured read tool has not been reviewed");
    return this.#withConnection(spec, signal, true, async (server) => {
      const live = server.cachedTools.find((tool) => tool.name === wireName);
      if (!live || !sameReviewedToolDefinition(reviewed, live)) throw new Error("The configured read tool changed");
      return this.#call(server.client, wireName, args, signal, spec);
    });
  }

  async executeTool(serverId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal, safeToReplay = false): Promise<AgentToolResult<Record<string, unknown>>> {
    const spec = this.#options.servers.find((server) => server.id === serverId && server.enabled && server.trusted);
    if (!spec) throw new McpConnectionError("configuration", true);
    const prefix = `mcp__${sanitizeName(spec.name)}__`;
    const tool = (this.#servers.get(spec.id)?.cachedTools ?? spec.cachedTools)?.find((candidate) => `${prefix}${sanitizeName(candidate.name)}` === toolName);
    if (!tool) throw new McpConnectionError("configuration", true);
    return this.#executeTool(spec, tool.name, args, signal, safeToReplay);
  }

  #executeTool(spec: McpServerSpec, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, safeToReplay: boolean) {
    let previousDefinition: McpCachedTool | undefined;
    return this.#withConnection(spec, signal, safeToReplay, async (server) => {
      const definition = server.cachedTools.find((candidate) => candidate.name === name);
      if ((!definition && (spec.allowedTools || server.version)) || (previousDefinition && definition && !sameReviewedToolDefinition(previousDefinition, definition))) {
        throw new McpConnectionError("configuration", true, {}, `MCP tool ${spec.name}:${name} is unavailable because its definition changed after administrator review`);
      }
      previousDefinition = definition;
      return this.#call(server.client, name, args, signal, spec);
    });
  }

  listDefaultTools(): AgentTool[] {
    const names = new Set(this.#options.servers.flatMap((server) => {
      const prefix = `mcp__${sanitizeName(server.name)}__`;
      return (server.defaultTools ?? []).map((name) =>
        name.startsWith("mcp__") ? name : `${prefix}${sanitizeName(name)}`
      );
    }));
    return this.listTools().filter((tool) => names.has(tool.name));
  }

  approvalHints(toolName: string): {
    readOnly: boolean;
    trustedReadOnly?: true;
    nonReplayable?: true;
    mandatoryApproval?: true;
    requiresApproval?: true;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
  } | undefined {
    for (const spec of this.#options.servers) {
      const prefix = `mcp__${sanitizeName(spec.name)}__`;
      if (!toolName.startsWith(prefix)) continue;
      const remoteName = toolName.slice(prefix.length);
      const tools = this.#servers.get(spec.id)?.cachedTools ?? spec.cachedTools ?? [];
      const tool = tools.find((candidate) => sanitizeName(candidate.name) === remoteName);
      if (!tool) return undefined;
      return {
        readOnly: tool.annotations?.readOnlyHint === true,
        ...(spec.trustReadOnlyAnnotations === true && tool.annotations?.readOnlyHint === true ? { trustedReadOnly: true as const } : {}),
        ...(spec.nonReplayableTools?.includes(tool.name) ? { nonReplayable: true as const } : {}),
        ...(spec.approvalRequiredTools?.includes(tool.name) ? { mandatoryApproval: true as const } : {}),
        ...(spec.trustReadOnlyAnnotations !== true || spec.approvalRequiredTools?.includes(tool.name)
          ? { requiresApproval: true as const }
          : {}),
        destructive: tool.annotations?.destructiveHint === true,
        idempotent: tool.annotations?.idempotentHint === true,
        openWorld: tool.annotations?.openWorldHint === true,
      };
    }
    return undefined;
  }

  createToolSearch(onReveal: (tools: AgentTool[]) => Promise<void>): AgentTool {
    return {
      name: "tool_search",
      label: "Search MCP tools",
      description: "Search deferred MCP connector tools by capability. Matching tools become available for the next tool call.",
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      execute: async (_toolCallId, params) => {
        const input = params as { query: string; limit?: number };
        const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = this.listTools()
          .map((tool) => ({ tool, score: terms.reduce((score, term) => score + (`${tool.name} ${tool.description}`.toLowerCase().includes(term) ? 1 : 0), 0) }))
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
          .slice(0, input.limit ?? 8)
          .map((item) => item.tool);
        await onReveal(matches);
        return {
          content: [{ type: "text", text: matches.length > 0 ? `Enabled MCP tools: ${matches.map((tool) => tool.name).join(", ")}` : "No matching MCP tools." }],
          details: { tools: matches.map((tool) => ({ name: tool.name, description: tool.description })) },
        };
      },
    } as AgentTool;
  }

  listServers(): Array<{ id: string; name: string; toolCount: number }> {
    return this.#options.servers.filter((spec) => this.#servers.has(spec.id)).map((spec) => ({ id: spec.id, name: spec.name, toolCount: this.#servers.get(spec.id)?.tools.length ?? 0 }));
  }

  async close(): Promise<void> {
    this.#generation += 1;
    this.#connecting.clear();
    this.#relisting.clear();
    const servers = [...this.#servers.values()];
    this.#servers.clear();
    await Promise.all(servers.map(async (server) => {
      try { await server.client.close(); } catch { /* best effort */ }
    }));
  }
}

/** Performs one bounded initialize/tools-list cycle for an administrator review. */
export async function discoverRemoteMcpTools(input: {
  id: string;
  name: string;
  url: string;
  transport: "http-sse" | "streamable-http";
  credential?: string | null;
  timeoutMs?: number;
  resolveCredential?: McpToolSourceOptions["resolveCredential"];
}): Promise<McpCachedTool[]> {
  const source = new McpToolSource({
    connectTimeoutMs: input.timeoutMs ?? 10_000,
    servers: [{
      id: input.id,
      name: input.name,
      url: validatedRemoteMcpUrl(input.url).toString(),
      transport: input.transport,
      command: null,
      args: [],
      env: {},
      enabled: true,
      trusted: true,
      ...(input.credential ? { credential: input.credential } : {}),
    }],
    ...(input.resolveCredential ? { resolveCredential: input.resolveCredential } : {}),
  });
  try {
    const discovered = await source.discoverServer(input.id);
    if (!discovered.length) throw new Error("MCP server did not expose any tools");
    return discovered;
  } finally {
    await source.close();
  }
}

function compactAnnotations(
  value: {
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
    openWorldHint?: boolean | undefined;
  },
): NonNullable<McpCachedTool["annotations"]> {
  return {
    ...(value.readOnlyHint !== undefined ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(value.destructiveHint !== undefined ? { destructiveHint: value.destructiveHint } : {}),
    ...(value.idempotentHint !== undefined ? { idempotentHint: value.idempotentHint } : {}),
    ...(value.openWorldHint !== undefined ? { openWorldHint: value.openWorldHint } : {}),
  };
}
