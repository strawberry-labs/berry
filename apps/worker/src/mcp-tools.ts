import {
  McpToolSource,
  mcpServerSpecsFromJson,
  type McpServerSpec,
} from "@berry/local-agent/mcp";
import {
  DurableTurnRuntimeRequestSchema,
  NetworkPolicySchema,
  openDurableSecret,
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
  readonly #turnContexts = new Map<string, { source: McpToolSource; servers: readonly McpServerSpec[]; ready: Promise<void> }>();

  constructor(
    private readonly base: DurableTurnToolExecutor,
    servers: readonly McpServerSpec[],
    networkPolicy: ReturnType<typeof NetworkPolicySchema.parse> | undefined,
    private readonly connectTimeoutMs = 10_000,
    private readonly env: NodeJS.ProcessEnv = process.env,
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
    const context = await this.#context(snapshot);
    const [inherited] = await Promise.all([
      this.base.definitions?.(snapshot) ?? Promise.resolve([]),
      context.ready,
    ]);
    const mcpTools = context.source.listTools()
      .filter((tool) => this.#serverForTool(tool.name, context.servers) !== undefined)
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

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    try {
      return await (this.base.finalize?.(snapshot) ?? []);
    } finally {
      const context = this.#turnContexts.get(snapshot.id);
      if (context) {
        this.#turnContexts.delete(snapshot.id);
        await context.source.close();
      }
    }
  }

  policy(
    snapshot: DurableTurnSnapshot,
    toolName: string,
    permissionMode: string,
  ): DurableToolPolicy | undefined {
    if (!toolName.startsWith("mcp__")) {
      return this.base.policy?.(snapshot, toolName, permissionMode);
    }
    const context = this.#turnContexts.get(snapshot.id);
    const source = context?.source ?? this.#source;
    const servers = context?.servers ?? this.#allowedServers(snapshot);
    const server = this.#serverForTool(toolName, servers);
    if (!server) {
      return {
        retryClass: "non_idempotent_manual",
        requiresApproval: true,
        approvalKind: "mcp",
      };
    }
    const hints = source.approvalHints(toolName);
    return durableMcpToolPolicy(server, hints, permissionMode);
  }

  async execute(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (!toolName.startsWith("mcp__")) return this.base.execute(snapshot, step);
    const context = await this.#context(snapshot);
    await context.ready;
    if (!this.#serverForTool(toolName, context.servers)) {
      throw new Error(`MCP tool ${toolName} is not enabled for this turn`);
    }
    const tool = context.source.listTools().find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`MCP tool ${toolName} is unavailable`);
    const callId = stringValue(step.input.toolCallId) ?? step.id;
    const result = await tool.execute(
      callId,
      (record(step.input.arguments) ?? {}) as never,
    );
    let text = result.content.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []
    ).join("\n").slice(0, 120_000);
    const artifact = connectorArtifact(result.details);
    const staged = artifact && this.base.stageAssociatedInputFiles
      ? await this.base.stageAssociatedInputFiles(snapshot, [artifact.fileId])
      : [];
    if (artifact) {
      const stagedArtifact = staged.find((item) => item.fileId === artifact.fileId);
      text = connectorArtifactText(artifact, stagedArtifact);
    }
    const parts = sanitizeMcpJournalValue(result.content);
    return {
      output: {
        content: text || "(no output)",
        tool: toolName,
        details: sanitizeMcpJournalValue(result.details),
        parts,
        ...(staged.length ? { artifacts: staged.map((item) => ({ ...item })) } : {}),
      },
      summary: text ? `${toolName} returned results` : `${toolName} completed`,
    };
  }

  async close(): Promise<void> {
    await this.#source.close();
    await Promise.all([...this.#turnContexts.values()].map((context) => context.source.close()));
  }

  async #context(snapshot: DurableTurnSnapshot): Promise<{ source: McpToolSource; servers: readonly McpServerSpec[]; ready: Promise<void> }> {
    const existing = this.#turnContexts.get(snapshot.id);
    if (existing) return existing;
    const runtime = DurableTurnRuntimeRequestSchema.safeParse(snapshot.runtimeRequest);
    if (!runtime.success) {
      return { source: this.#source, servers: this.#allowedServers(snapshot), ready: this.#ready };
    }
    const servers = await Promise.all(runtime.data.mcpServers
      .filter((server) => server.enabled && server.trusted)
      .map(async (server): Promise<McpServerSpec> => {
        const credential = await durableMcpCredential(server.credential, server.credentialRef, this.env);
        const environment = await durableMcpEnvironment(server.environment, server.env, this.env);
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          env: environment,
          enabled: server.enabled,
          trusted: server.trusted,
          credentialKey: server.credentialRef,
          ...(server.cachedTools ? { cachedTools: server.cachedTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: compactMcpAnnotations(tool.annotations) } : {}),
          })) } : {}),
          ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
          ...(server.trustReadOnlyAnnotations ? { trustReadOnlyAnnotations: true } : {}),
          ...(server.approvalRequiredTools ? { approvalRequiredTools: server.approvalRequiredTools } : {}),
          ...(credential ? { credential } : {}),
        };
      }));
    const policy = NetworkPolicySchema.safeParse(runtime.data.networkPolicy);
    const source = new McpToolSource({
      servers: [...servers],
      ...(policy.success ? { networkPolicy: policy.data } : {}),
      connectTimeoutMs: this.connectTimeoutMs,
      log: (level, message) => {
        const output = `[durable-mcp:${snapshot.id}] ${message}`;
        if (level === "error") console.error(output);
        else if (level === "warn") console.warn(output);
        else console.info(output);
      },
    });
    const context = { source, servers, ready: source.connect() };
    this.#turnContexts.set(snapshot.id, context);
    return context;
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

export function durableMcpToolPolicy(
  server: Pick<McpServerSpec, "trustReadOnlyAnnotations">,
  hints: ReturnType<McpToolSource["approvalHints"]>,
  permissionMode: string,
): DurableToolPolicy {
  if (hints?.requiresApproval) {
    return {
      retryClass: hints.idempotent ? "idempotent_with_key" : "non_idempotent_manual",
      requiresApproval: permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }
  if (hints?.trustedReadOnly) {
    return {
      retryClass: "read_only",
      requiresApproval: false,
      approvalKind: "mcp",
    };
  }
  // Only Berry-owned adapters opt into authoritative annotations. A custom
  // server cannot waive approval or claim that a side effect is retry-safe.
  if (server.trustReadOnlyAnnotations !== true) {
    return {
      retryClass: "non_idempotent_manual",
      requiresApproval: permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }
  const requiresApproval = permissionMode !== "full-access";
  if (hints?.destructive) {
    return {
      retryClass: "non_idempotent_manual",
      requiresApproval,
      approvalKind: "mcp",
    };
  }
  if (hints?.idempotent) {
    return {
      retryClass: "idempotent_with_key",
      requiresApproval,
      approvalKind: "mcp",
    };
  }
  return {
    retryClass: "non_idempotent_manual",
    requiresApproval,
    approvalKind: "mcp",
  };
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
    env,
  );
}

async function durableMcpCredential(
  envelope: Parameters<typeof openDurableSecret>[0] | undefined,
  reference: string | null,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (envelope) {
    const key = env.BERRY_DURABLE_CAPABILITY_KEY?.trim();
    if (!key) throw new Error("BERRY_DURABLE_CAPABILITY_KEY is required to open admitted MCP credentials");
    return openDurableSecret(envelope, key);
  }
  if (!reference) return undefined;
  const name = reference.startsWith("env:") ? reference.slice(4) : reference;
  const credential = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? env[name]?.trim() : undefined;
  if (!credential) throw new Error(`Credential reference ${reference} is not available to the durable Worker`);
  return credential;
}

async function durableMcpEnvironment(
  envelope: Parameters<typeof openDurableSecret>[0] | undefined,
  fallback: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  if (!envelope) return fallback;
  const key = env.BERRY_DURABLE_CAPABILITY_KEY?.trim();
  if (!key) throw new Error("BERRY_DURABLE_CAPABILITY_KEY is required to open an admitted MCP environment");
  const parsed = JSON.parse(await openDurableSecret(envelope, key)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The admitted MCP environment is invalid");
  }
  const entries = Object.entries(parsed);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("The admitted MCP environment must contain only string values");
  }
  return Object.fromEntries(entries);
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

type ConnectorArtifact = {
  fileId: string;
  name: string;
  mediaType: string;
  library: boolean | null;
};

type StagedConnectorArtifact = {
  name: string;
  mediaType: string;
  path: string;
};

function connectorArtifact(value: unknown): ConnectorArtifact | null {
  const details = record(value);
  const structured = record(details?.structuredContent);
  const artifact = record(structured?.artifact);
  const fileId = stringValue(artifact?.fileId);
  const name = stringValue(artifact?.name);
  const mediaType = stringValue(artifact?.mediaType);
  const library = typeof artifact?.library === "boolean" ? artifact.library : null;
  return fileId && name && mediaType ? { fileId, name, mediaType, library } : null;
}

export function connectorArtifactText(
  artifact: ConnectorArtifact,
  staged: StagedConnectorArtifact | undefined,
): string {
  const disposition = artifact.library === true
    ? `Saved ${artifact.name} to the Berry Library.`
    : artifact.library === false
      ? `Downloaded ${artifact.name} for temporary use in this task.`
      : `Imported ${artifact.name} into Berry.`;
  const storage = staged
    ? `Sandbox path: ${staged.path}`
    : artifact.library === false
      ? "The file is stored as a task-scoped Berry artifact."
      : "The file is stored as a Berry artifact.";
  const persistence = artifact.library === false
    ? "It was not added to the Berry Library or project knowledge."
    : "";
  return [
    disposition,
    storage,
    persistence,
    staged ? documentProcessingHint(staged.name, staged.mediaType, artifact.library !== false) : "",
  ].filter(Boolean).join("\n");
}

function documentProcessingHint(name: string, mediaType: string, indexed: boolean): string {
  if (!indexed) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".pdf") || mediaType === "application/pdf") return "Use read on the sandbox path to extract the PDF for this task.";
    if (/\.(xlsx?|xlsm|csv)$/.test(lower) || /spreadsheet|excel|csv/.test(mediaType)) return "Use the sandbox path with the spreadsheet tools for this task.";
    if (/\.docx?$/.test(lower) || /wordprocessingml|msword/.test(mediaType)) return "Use the sandbox path with the document tools for this task.";
    if (/\.pptx?$/.test(lower) || /presentationml|powerpoint/.test(mediaType)) return "Use the sandbox path with the presentation tools for this task.";
    return "Use the sandbox path for this task.";
  }
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") || mediaType === "application/pdf") return "The PDF skill is active for structured reading; searchable extraction is queued through Tika.";
  if (/\.(xlsx?|xlsm|csv)$/.test(lower) || /spreadsheet|excel|csv/.test(mediaType)) return "The XLSX skill is active for structured spreadsheet analysis; searchable extraction is queued through Tika.";
  if (/\.docx?$/.test(lower) || /wordprocessingml|msword/.test(mediaType)) return "The DOCX skill is active for structured document analysis; searchable extraction is queued through Tika.";
  if (/\.pptx?$/.test(lower) || /presentationml|powerpoint/.test(mediaType)) return "The PPTX skill is active for structured presentation analysis; searchable extraction is queued through Tika.";
  return "Searchable extraction is queued through Tika.";
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

const MCP_JOURNAL_STRING_LIMIT = 120_000;
const MCP_JOURNAL_ARRAY_LIMIT = 256;
const MCP_JOURNAL_OBJECT_LIMIT = 128;
const MCP_JOURNAL_DEPTH_LIMIT = 8;
const MCP_BINARY_FIELD = /^(?:b64_json|base64|blob|bytes|data)$/i;

/** Removes binary MCP payloads and bounds structured metadata before journaling it. */
export function sanitizeMcpJournalValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, MCP_JOURNAL_STRING_LIMIT);
  if (depth >= MCP_JOURNAL_DEPTH_LIMIT) return "[omitted: MCP metadata nesting limit reached]";
  if (Array.isArray(value)) {
    return value.slice(0, MCP_JOURNAL_ARRAY_LIMIT)
      .map((item) => sanitizeMcpJournalValue(item, depth + 1));
  }
  const object = record(value);
  if (!object) return String(value).slice(0, MCP_JOURNAL_STRING_LIMIT);
  const type = stringValue(object.type);
  if (type && type !== "text") {
    return {
      type,
      omitted: "binary MCP content is not stored in the journal",
      ...(stringValue(object.mimeType) ? { mimeType: stringValue(object.mimeType)! } : {}),
      ...(stringValue(object.name) ? { name: stringValue(object.name)! } : {}),
      ...(stringValue(object.uri) ? { uri: stringValue(object.uri)! } : {}),
    };
  }
  const entries = Object.entries(object).slice(0, MCP_JOURNAL_OBJECT_LIMIT);
  return Object.fromEntries(entries.map(([key, item]) => [
    key,
    MCP_BINARY_FIELD.test(key)
      ? "[omitted: binary MCP content is not stored in the journal]"
      : sanitizeMcpJournalValue(item, depth + 1),
  ]));
}

function compactMcpAnnotations(value: {
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}): NonNullable<NonNullable<McpServerSpec["cachedTools"]>[number]["annotations"]> {
  return {
    ...(value.readOnlyHint !== undefined ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(value.destructiveHint !== undefined ? { destructiveHint: value.destructiveHint } : {}),
    ...(value.idempotentHint !== undefined ? { idempotentHint: value.idempotentHint } : {}),
    ...(value.openWorldHint !== undefined ? { openWorldHint: value.openWorldHint } : {}),
  };
}
