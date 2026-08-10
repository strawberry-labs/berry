import type { AgentTool, AgentToolResult } from "@berry/harness";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type TSchema } from "typebox";
import { ExecPolicyEngine, type ExecPolicyRule } from "@berry/execpolicy";
import { networkDomainAllowed, type NetworkPolicy } from "@berry/shared";
import { z } from "zod";
import { createPublicRemoteFetch, validatedPublicRemoteUrl } from "./remote-fetch.ts";

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

export interface McpToolSourceOptions {
  servers: McpServerSpec[];
  log?: (level: "info" | "warn" | "error", message: string) => void;
  connectTimeoutMs?: number;
  onHealth?: (health: McpServerHealth) => void | Promise<void>;
  networkPolicy?: NetworkPolicy;
  execPolicyRules?: ExecPolicyRule[];
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
    const credential = server.credentialEnv
      ? env[server.credentialEnv]?.trim()
      : server.credential?.trim();
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
      ...(server.cachedTools ? {
        cachedTools: server.cachedTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: compactAnnotations(tool.annotations) } : {}),
        })),
      } : {}),
      ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
      ...(server.trustReadOnlyAnnotations ? { trustReadOnlyAnnotations: true } : {}),
      ...(server.approvalRequiredTools ? { approvalRequiredTools: server.approvalRequiredTools } : {}),
      ...(credential ? { credential } : {}),
    };
  });
}

interface ConnectedServer {
  spec: McpServerSpec;
  client: Client;
  tools: AgentTool[];
  cachedTools: McpCachedTool[];
}

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
  return {
    content: [{ type: "text", text: texts.join("\n") || "(no output)" }],
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

function cachedTool(spec: McpServerSpec, cached: McpCachedTool, invoke: (name: string, args: Record<string, unknown>) => Promise<AgentToolResult<Record<string, unknown>>>): AgentTool {
  return {
    name: `mcp__${sanitizeName(spec.name)}__${sanitizeName(cached.name)}`,
    label: `${spec.name}: ${cached.name}`,
    description: cached.description ?? `Tool ${cached.name} from MCP server ${spec.name}`,
    parameters: cached.inputSchema as TSchema,
    execute: async (_toolCallId, params) => invoke(cached.name, (params ?? {}) as Record<string, unknown>),
  } as AgentTool;
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

/** Connects MCP servers independently. Cached schemas are usable immediately; live startup never needs to block turn creation. */
export class McpToolSource {
  readonly #options: McpToolSourceOptions;
  readonly #servers = new Map<string, ConnectedServer>();
  readonly #connecting = new Map<string, Promise<ConnectedServer>>();

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
        await this.#ensureConnected(spec);
      } catch {
        // Each server publishes its own health and does not make the source fail.
      }
    }));
  }

  connectInBackground(): void {
    void this.connect();
  }

  async #ensureConnected(spec: McpServerSpec): Promise<ConnectedServer> {
    const existing = this.#servers.get(spec.id);
    if (existing) return existing;
    const pending = this.#connecting.get(spec.id);
    if (pending) return pending;
    const started = Date.now();
    await this.#options.onHealth?.({ id: spec.id, status: "connecting", toolCount: spec.cachedTools?.length ?? 0, latencyMs: null, lastError: null, tools: spec.cachedTools ?? [] });
    const client = new Client({ name: "berry-desktop", version: "0.1.0" });
    const promise = withTimeout(this.#connectServer(spec, client), this.#options.connectTimeoutMs ?? 10_000, `MCP server ${spec.name}`)
      .then(async (server) => {
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
      .finally(() => this.#connecting.delete(spec.id));
    this.#connecting.set(spec.id, promise);
    return promise;
  }

  async #connectServer(spec: McpServerSpec, client: Client): Promise<ConnectedServer> {
    if (spec.transport === "stdio") {
      if (!spec.command) throw new Error("stdio MCP server has no command");
      await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: mcpProcessEnv(spec.env), stderr: "ignore" }));
    } else {
      if (!spec.url) throw new Error(`${spec.transport} MCP server has no url`);
      const url = validatedRemoteMcpUrl(spec.url);
      const networkPolicy = this.#options.networkPolicy;
      if (networkPolicy?.egress === "off") throw new Error("network egress is off for remote MCP servers");
      if (networkPolicy && !networkDomainAllowed(url.hostname, networkPolicy.allowedDomains)) throw new Error(`${url.hostname} is not in the network domain allowlist`);
      const networkDecision = new ExecPolicyEngine(this.#options.execPolicyRules ?? []).evaluateNetwork(url.toString());
      if (networkDecision.decision === "forbid") throw new Error(`execpolicy forbids remote MCP server ${url.hostname}`);
      const remoteFetch = createPublicRemoteFetch({ bearerToken: bearerToken(spec.credential) });
      if (spec.transport === "streamable-http") {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch: remoteFetch }) as never);
      } else {
        await client.connect(new SSEClientTransport(url, { fetch: remoteFetch }));
      }
    }
    const listed = await client.listTools();
    const allow = spec.allowedTools ? new Set(spec.allowedTools) : null;
    const reviewed = allow
      ? new Map((spec.cachedTools ?? []).filter((tool) => allow.has(tool.name)).map((tool) => [tool.name, tool]))
      : null;
    const cachedTools = listed.tools.flatMap((tool): McpCachedTool[] => {
      if (allow && !allow.has(tool.name)) return [];
      const annotations = (tool as { annotations?: NonNullable<McpCachedTool["annotations"]> }).annotations;
      const live = {
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        ...(annotations ? { annotations } : {}),
      };
      if (!reviewed) return [live];
      const approved = reviewed.get(tool.name);
      if (!approved || !sameReviewedToolDefinition(approved, live)) {
        this.#options.log?.("warn", `MCP tool ${spec.name}:${tool.name} changed after administrator review; disabling it until republished`);
        return [];
      }
      return [approved];
    });
    const tools = cachedTools.map((tool) => cachedTool(spec, tool, async (name, args) => this.#call(client, name, args)));
    return { spec, client, tools, cachedTools };
  }

  async #call(client: Client, name: string, args: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const failure = contentToToolResult(result.content, (result as { structuredContent?: unknown }).structuredContent);
      const text = failure.content[0];
      throw new Error(text && text.type === "text" ? text.text : "MCP tool failed");
    }
    return contentToToolResult(result.content, (result as { structuredContent?: unknown }).structuredContent);
  }

  listTools(): AgentTool[] {
    return this.#options.servers.flatMap((spec) => {
      if (!spec.enabled || !spec.trusted) return [];
      const live = this.#servers.get(spec.id);
      const allowed = spec.allowedTools ? new Set(spec.allowedTools) : null;
      const cached = (live?.cachedTools ?? spec.cachedTools ?? []).filter((tool) => !allowed || allowed.has(tool.name));
      return cached.map((tool) => cachedTool(spec, tool, async (name, args) => {
        const server = await this.#ensureConnected(spec);
        if (spec.allowedTools && !server.cachedTools.some((candidate) => candidate.name === name)) {
          throw new Error(`MCP tool ${spec.name}:${name} is unavailable because its definition changed after administrator review`);
        }
        return this.#call(server.client, name, args);
      }));
    });
  }

  approvalHints(toolName: string): {
    readOnly: boolean;
    trustedReadOnly?: true;
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
    await Promise.all([...this.#servers.values()].map(async (server) => {
      try { await server.client.close(); } catch { /* best effort */ }
    }));
    this.#servers.clear();
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
}): Promise<McpCachedTool[]> {
  let discovered: McpCachedTool[] = [];
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
    onHealth: (health) => { if (health.status === "connected") discovered = health.tools; },
  });
  try {
    await source.connect();
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
