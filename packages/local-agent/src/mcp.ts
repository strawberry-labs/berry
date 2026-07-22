import type { AgentTool, AgentToolResult } from "@berry/harness";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type TSchema } from "typebox";
import { ExecPolicyEngine, type ExecPolicyRule } from "@berry/execpolicy";
import { networkDomainAllowed, type NetworkPolicy } from "@berry/shared";

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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224;
}

function isBlockedMcpHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  return isPrivateIpv4(normalized);
}

export function validatedRemoteMcpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("remote MCP servers must use https");
  if (url.username || url.password) throw new Error("remote MCP URLs must not contain credentials");
  if (isBlockedMcpHostname(url.hostname)) throw new Error("remote MCP servers must not target localhost or private networks");
  return url;
}

function contentToToolResult(content: unknown): AgentToolResult<Record<string, unknown>> {
  const parts = Array.isArray(content) ? content : [];
  const texts = parts
    .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
    .map((part) => part.text);
  return {
    content: [{ type: "text", text: texts.join("\n") || "(no output)" }],
    details: { raw: parts as unknown as Record<string, unknown> } as Record<string, unknown>,
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

function fetchWithBearer(token: string | null): typeof fetch | undefined {
  if (!token) return undefined;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
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
      const authorizedFetch = fetchWithBearer(bearerToken(spec.credential));
      if (spec.transport === "streamable-http") {
        await client.connect(new StreamableHTTPClientTransport(url, { ...(authorizedFetch ? { fetch: authorizedFetch } : {}) }) as never);
      } else {
        await client.connect(new SSEClientTransport(url, { ...(authorizedFetch ? { fetch: authorizedFetch } : {}) }));
      }
    }
    const listed = await client.listTools();
    const cachedTools = listed.tools.map((tool): McpCachedTool => {
      const annotations = (tool as { annotations?: NonNullable<McpCachedTool["annotations"]> }).annotations;
      return {
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        ...(annotations ? { annotations } : {}),
      };
    });
    const tools = cachedTools.map((tool) => cachedTool(spec, tool, async (name, args) => this.#call(client, name, args)));
    return { spec, client, tools, cachedTools };
  }

  async #call(client: Client, name: string, args: Record<string, unknown>): Promise<AgentToolResult<Record<string, unknown>>> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const failure = contentToToolResult(result.content);
      const text = failure.content[0];
      throw new Error(text && text.type === "text" ? text.text : "MCP tool failed");
    }
    return contentToToolResult(result.content);
  }

  listTools(): AgentTool[] {
    return this.#options.servers.flatMap((spec) => {
      if (!spec.enabled || !spec.trusted) return [];
      const live = this.#servers.get(spec.id);
      const cached = live?.cachedTools ?? spec.cachedTools ?? [];
      return cached.map((tool) => cachedTool(spec, tool, async (name, args) => {
        const server = await this.#ensureConnected(spec);
        return this.#call(server.client, name, args);
      }));
    });
  }

  approvalHints(toolName: string): { destructive: boolean; openWorld: boolean } | undefined {
    for (const spec of this.#options.servers) {
      const prefix = `mcp__${sanitizeName(spec.name)}__`;
      if (!toolName.startsWith(prefix)) continue;
      const remoteName = toolName.slice(prefix.length);
      const tools = this.#servers.get(spec.id)?.cachedTools ?? spec.cachedTools ?? [];
      const tool = tools.find((candidate) => sanitizeName(candidate.name) === remoteName);
      if (!tool) return undefined;
      return { destructive: tool.annotations?.destructiveHint === true, openWorld: tool.annotations?.openWorldHint === true };
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
