import {
  McpToolSource,
  mcpServerSpecsFromJson,
  type McpServerSpec,
} from "@berry/local-agent/mcp";
import {
  NetworkPolicySchema,
  type JsonValue,
} from "@berry/shared";
import type { ChatContentPart, ChatToolDefinition } from "@berry/router-client";
import type {
  DurableToolPolicy,
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  TurnToolResult,
} from "./turn-runner.js";

export class DurableMcpToolExecutor implements DurableTurnToolExecutor {
  readonly #source: McpToolSource;
  readonly #servers: readonly McpServerSpec[];
  readonly #ready: Promise<void>;

  constructor(
    private readonly base: DurableTurnToolExecutor,
    servers: readonly McpServerSpec[],
    networkPolicy: ReturnType<typeof NetworkPolicySchema.parse> | undefined,
    connectTimeoutMs = 10_000,
  ) {
    this.#servers = servers;
    this.#source = new McpToolSource({
      servers: [...servers],
      ...(networkPolicy ? { networkPolicy } : {}),
      connectTimeoutMs,
      log: (level, message) => {
        const output = `[durable-mcp] ${message}`;
        if (level === "error") console.error(output);
        else if (level === "warn") console.warn(output);
        else console.info(output);
      },
    });
    this.#ready = this.#source.connect();
  }

  async definitions(snapshot: DurableTurnSnapshot): Promise<readonly ChatToolDefinition[]> {
    const [inherited] = await Promise.all([
      this.base.definitions?.(snapshot) ?? Promise.resolve([]),
      this.#ready,
    ]);
    const allowed = this.#allowedServers(snapshot);
    const mcpTools = this.#source.listTools()
      .filter((tool) => this.#serverForTool(tool.name, allowed) !== undefined)
      .map((tool): ChatToolDefinition => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: jsonValue(tool.parameters),
        },
      }));
    return [...inherited, ...mcpTools];
  }

  async modelContent(snapshot: DurableTurnSnapshot): Promise<readonly ChatContentPart[]> {
    return this.base.modelContent?.(snapshot) ?? [];
  }

  policy(
    snapshot: DurableTurnSnapshot,
    toolName: string,
    permissionMode: string,
  ): DurableToolPolicy | undefined {
    if (!toolName.startsWith("mcp__")) {
      return this.base.policy?.(snapshot, toolName, permissionMode);
    }
    const server = this.#serverForTool(toolName, this.#allowedServers(snapshot));
    if (!server) {
      return {
        retryClass: "non_idempotent_manual",
        requiresApproval: true,
        approvalKind: "mcp",
      };
    }
    const hints = this.#source.approvalHints(toolName);
    const berryCrawl = server.id.toLowerCase() === "berrycrawl"
      || server.name.toLowerCase().includes("berrycrawl");
    if (hints?.readOnly || berryCrawl) {
      return {
        retryClass: "read_only",
        requiresApproval: false,
        approvalKind: "mcp",
      };
    }
    if (hints?.destructive) {
      return {
        retryClass: "non_idempotent_manual",
        requiresApproval: permissionMode !== "full-access",
        approvalKind: "mcp",
      };
    }
    if (hints?.idempotent) {
      return {
        retryClass: "idempotent_with_key",
        requiresApproval: permissionMode !== "full-access",
        approvalKind: "mcp",
      };
    }
    return {
      retryClass: "non_idempotent_manual",
      requiresApproval: permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }

  async execute(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (!toolName.startsWith("mcp__")) return this.base.execute(snapshot, step);
    await this.#ready;
    const allowed = this.#allowedServers(snapshot);
    if (!this.#serverForTool(toolName, allowed)) {
      throw new Error(`MCP tool ${toolName} is not enabled for this turn`);
    }
    const tool = this.#source.listTools().find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`MCP tool ${toolName} is unavailable`);
    const callId = stringValue(step.input.toolCallId) ?? step.id;
    const result = await tool.execute(
      callId,
      (record(step.input.arguments) ?? {}) as never,
    );
    const text = result.content.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []
    ).join("\n").slice(0, 120_000);
    return {
      output: {
        content: text || "(no output)",
        tool: toolName,
      },
      summary: text ? `${toolName} returned results` : `${toolName} completed`,
    };
  }

  async close(): Promise<void> {
    await this.#source.close();
  }

  #allowedServers(snapshot: DurableTurnSnapshot): readonly McpServerSpec[] {
    const configuredIds = Array.isArray(snapshot.runtimeRequest.mcpServerIds)
      ? new Set(snapshot.runtimeRequest.mcpServerIds.filter((value): value is string => typeof value === "string"))
      : null;
    return this.#servers.filter((server) =>
      server.enabled
      && server.trusted
      && (configuredIds === null || configuredIds.has(server.id))
    );
  }

  #serverForTool(toolName: string, candidates: readonly McpServerSpec[]): McpServerSpec | undefined {
    return candidates.find((server) => toolName.startsWith(`mcp__${sanitizeName(server.name)}__`));
  }
}

export function createDurableTurnToolsFromEnv(
  env: NodeJS.ProcessEnv,
  base: DurableTurnToolExecutor,
): DurableMcpToolExecutor {
  const servers = mcpServerSpecsFromJson(env.BERRY_CLOUD_MCP_SERVERS_JSON, env);
  const networkPolicy = servers.length > 0
    ? NetworkPolicySchema.parse({
        egress: env.BERRY_CLOUD_NETWORK_EGRESS?.trim() || "on",
        allowedDomains: csv(env.BERRY_CLOUD_NETWORK_ALLOWED_DOMAINS),
      })
    : undefined;
  return new DurableMcpToolExecutor(
    base,
    servers,
    networkPolicy,
    positiveInteger(env.BERRY_MCP_CONNECT_TIMEOUT_MS) ?? 10_000,
  );
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
