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
  readonly #turnContexts = new Map<string, DurableMcpTurnContext>();

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
  }

  async definitions(snapshot: DurableTurnSnapshot): Promise<readonly ChatToolDefinition[]> {
    const context = await this.#context(snapshot);
    const inherited = await (this.base.definitions?.(snapshot) ?? Promise.resolve([]));
    const visibleNames = this.#visibleToolNames(snapshot, context);
    const mcpTools = context.source.listTools()
      .filter((tool) => visibleNames.has(tool.name))
      .map((tool): ChatToolDefinition => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: jsonValue(tool.parameters),
        },
      }));
    return [
      ...inherited,
      ...(context.source.listTools().length > 0
        ? [durableToolSearchDefinition(context.servers)]
        : []),
      ...mcpTools,
    ];
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
    if (toolName === "tool_search") {
      return {
        retryClass: "read_only",
        requiresApproval: false,
        approvalKind: "mcp",
      };
    }
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

  async execute(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "tool_search") return this.#searchTools(snapshot, step);
    if (!toolName.startsWith("mcp__")) {
      return signal || reportProgress
        ? this.base.execute(snapshot, step, signal, reportProgress)
        : this.base.execute(snapshot, step);
    }
    const context = await this.#context(snapshot);
    if (!this.#serverForTool(toolName, context.servers)) {
      throw new Error(`MCP tool ${toolName} is not enabled for this turn`);
    }
    if (!this.#visibleToolNames(snapshot, context).has(toolName)) {
      throw new Error(deferredMcpToolError(toolName));
    }
    const tool = context.source.listTools().find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`MCP tool ${toolName} is unavailable`);
    const callId = stringValue(step.input.toolCallId) ?? step.id;
    const result = signal || reportProgress
      ? await tool.execute(callId, (record(step.input.arguments) ?? {}) as never, signal, reportProgress)
      : await tool.execute(callId, (record(step.input.arguments) ?? {}) as never);
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

  async #context(snapshot: DurableTurnSnapshot): Promise<DurableMcpTurnContext> {
    const existing = this.#turnContexts.get(snapshot.id);
    if (existing) return existing;
    const runtime = DurableTurnRuntimeRequestSchema.safeParse(snapshot.runtimeRequest);
    if (!runtime.success) {
      return { source: this.#source, servers: this.#allowedServers(snapshot) };
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
          ...(server.defaultTools ? { defaultTools: server.defaultTools } : {}),
          ...(server.nonReplayableTools ? { nonReplayableTools: server.nonReplayableTools } : {}),
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
    // Cached, administrator-reviewed schemas are enough for model preparation.
    // McpToolSource connects only when one exposed tool is actually executed.
    const context = { source, servers };
    this.#turnContexts.set(snapshot.id, context);
    return context;
  }

  async #searchTools(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const context = await this.#context(snapshot);
    const input = record(step.input.arguments) ?? {};
    const query = stringValue(input.query);
    if (!query) throw new Error("tool_search requires a non-empty query describing the connector capability needed");
    const connectorId = stringValue(input.connector);
    const normalizedConnectorId = connectorId ? normalizeCatalogIdentity(connectorId) : null;
    const exactConnector = connectorId
      ? context.servers.find((server) => server.id === connectorId)
      : undefined;
    const aliasMatches = connectorId && !exactConnector
      ? context.servers.filter((server) =>
          normalizeCatalogIdentity(server.id) === normalizedConnectorId
          || normalizeCatalogIdentity(server.name) === normalizedConnectorId
        )
      : [];
    if (connectorId && aliasMatches.length > 1) {
      throw new Error(
        `Ambiguous connector alias: ${connectorId}. Use one exact connector id from: ${aliasMatches.map((server) => server.id).join(", ")}`,
      );
    }
    const connector = exactConnector ?? aliasMatches[0];
    if (connectorId && !connector) {
      throw new Error(`Unknown or unauthorized connector: ${connectorId}`);
    }
    const limitValue = typeof input.limit === "number" && Number.isSafeInteger(input.limit)
      ? input.limit
      : 8;
    const limit = Math.max(1, Math.min(20, limitValue));
    let matches: ReturnType<McpToolSource["listTools"]> = [];
    if (connector) {
      const connectorTools = context.source.listTools().filter((tool) =>
        this.#serverForTool(tool.name, [connector]) !== undefined
      );
      matches = connectorToolMatches(connectorTools, query, limit);
    } else {
      const search = context.source.createToolSearch(async (revealed) => {
        matches = revealed;
      });
      await search.execute(stringValue(step.input.toolCallId) ?? step.id, { query, limit } as never);
    }
    const activatedTools = matches.map((tool) => tool.name);
    const activatedServerIds = [...new Set(matches.flatMap((tool) => {
      const server = this.#serverForTool(tool.name, context.servers);
      return server ? [server.id] : [];
    }))];
    const connectorCatalog = context.servers
      .filter((server) => context.source.listTools().some((tool) =>
        this.#serverForTool(tool.name, [server]) !== undefined
      ))
      .map((server) => ({ id: server.id, name: server.name }));
    const content = activatedTools.length > 0
      ? `Enabled connector tools for the next model call: ${activatedTools.join(", ")}`
      : `No authorized connector tools matched that capability. Retry with one connector id from: ${connectorCatalog.map((item) => `${item.id} (${item.name})`).join(", ")}.`;
    return {
      output: {
        content,
        query,
        ...(connector ? { connector: connector.id } : {}),
        connectors: connectorCatalog,
        activatedTools,
        activatedServerIds,
        tools: matches.map((tool) => ({ name: tool.name, description: tool.description })),
      },
      summary: activatedTools.length > 0
        ? `Discovered ${activatedTools.length} connector tool${activatedTools.length === 1 ? "" : "s"}`
        : "No connector tools matched",
    };
  }

  #visibleToolNames(snapshot: DurableTurnSnapshot, context: DurableMcpTurnContext): Set<string> {
    const visible = revealedMcpToolNames(snapshot);
    for (const server of context.servers) {
      const prefix = `mcp__${sanitizeName(server.name)}__`;
      for (const toolName of server.defaultTools ?? []) {
        visible.add(toolName.startsWith("mcp__") ? toolName : `${prefix}${sanitizeName(toolName)}`);
      }
    }
    const selectedServerIds = explicitlyMentionedMcpServerIds(snapshot, context.servers);
    // Model history survives across turns, so keep previously discovered
    // connector schemas visible when those historical tool names remain in it.
    for (const toolName of persistedMcpToolNames(snapshot)) {
      const server = this.#serverForTool(toolName, context.servers);
      if (server) selectedServerIds.add(server.id);
    }
    for (const step of snapshot.steps) {
      const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
      if (!toolName.startsWith("mcp__")) continue;
      // A provider can reuse a historical tool name before calling tool_search.
      // Reveal its admitted connector after that first deferred failure.
      if (step.state !== "completed" && !isDeferredMcpToolFailure(step, toolName)) continue;
      const server = this.#serverForTool(toolName, context.servers);
      if (server) selectedServerIds.add(server.id);
    }
    for (const tool of context.source.listTools()) {
      const server = this.#serverForTool(tool.name, context.servers);
      if (server && selectedServerIds.has(server.id)) visible.add(tool.name);
    }
    return visible;
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

type DurableMcpTurnContext = {
  source: McpToolSource;
  servers: readonly McpServerSpec[];
};

function durableToolSearchDefinition(servers: readonly McpServerSpec[]): ChatToolDefinition {
  const catalog = servers.map((server) => `${server.id} (${server.name})`).join(", ");
  return {
    type: "function",
    function: {
      name: "tool_search",
      description: `Search authorized deferred connector tools by capability. Select a connector when the request uses a paraphrase that may not occur in a tool name. Authorized connectors: ${catalog}. Matching tools become available on the next model call.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          connector: {
            type: "string",
            enum: servers.map((server) => server.id),
            description: "Authorized connector id chosen from the catalog in this tool description.",
          },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

function explicitlyMentionedMcpServerIds(
  snapshot: DurableTurnSnapshot,
  servers: readonly McpServerSpec[],
): Set<string> {
  const intent = [
    stringValue(snapshot.runtimeRequest.input),
    latestUserEntryText(snapshot),
  ].filter(Boolean).join(" ");
  if (!intent) return new Set();
  const normalizedIntent = ` ${normalizeCatalogIdentity(intent)} `;
  const intentTokens = catalogIdentityTokens(intent);
  const identities = servers.map((server) => ({
    id: server.id,
    fullName: normalizeCatalogIdentity(server.name),
    tokens: new Set([
      ...catalogIdentityTokens(server.id),
      ...catalogIdentityTokens(server.name),
    ]),
  }));
  const tokenOwners = new Map<string, number>();
  for (const identity of identities) {
    for (const token of identity.tokens) {
      tokenOwners.set(token, (tokenOwners.get(token) ?? 0) + 1);
    }
  }
  return new Set(identities.filter((identity) =>
    (identity.fullName.length >= 3 && normalizedIntent.includes(` ${identity.fullName} `))
    || [...identity.tokens].some((token) =>
      token.length >= 3 && tokenOwners.get(token) === 1 && intentTokens.has(token)
    )
  ).map((identity) => identity.id));
}

function revealedMcpToolNames(snapshot: DurableTurnSnapshot): Set<string> {
  const names = new Set<string>();
  for (const step of snapshot.steps) {
    if (step.state !== "completed") continue;
    if ((stringValue(step.input.toolName) ?? step.type.slice(5)) !== "tool_search") continue;
    const output = record(step.output);
    for (const name of stringArray(output?.activatedTools)) {
      if (name.startsWith("mcp__")) names.add(name);
    }
  }
  return names;
}

function persistedMcpToolNames(snapshot: DurableTurnSnapshot): Set<string> {
  const names = new Set<string>();
  for (const entry of snapshot.entries) {
    const payload = record(entry.payload);
    const message = record(payload?.message);
    if (message?.role !== "toolResult" || message.isError === true) continue;
    const toolName = stringValue(message.toolName);
    if (toolName?.startsWith("mcp__")) names.add(toolName);
    if (toolName !== "tool_search") continue;
    for (const name of mcpToolNamesInContent(message.content)) names.add(name);
  }
  return names;
}

function mcpToolNamesInContent(content: unknown): string[] {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => {
          const item = record(part);
          return typeof item?.text === "string" ? [item.text] : [];
        }).join("\n")
      : "";
  return text.match(/mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g) ?? [];
}

function deferredMcpToolError(toolName: string): string {
  return `MCP tool ${toolName} was deferred because its connector schema was not active. The connector is now enabled for the next model call; retry the tool with the provided schema.`;
}

function isDeferredMcpToolFailure(step: DurableTurnStep, toolName: string): boolean {
  if (step.state !== "failed" || typeof step.error !== "string") return false;
  return step.error === deferredMcpToolError(toolName)
    || step.error === `MCP tool ${toolName} is deferred. Call tool_search for the required connector capability first.`;
}

function connectorToolMatches<T extends { name: string; description?: string }>(
  tools: readonly T[],
  query: string,
  limit: number,
): T[] {
  const terms = [...catalogIdentityTokens(query)];
  const ranked = tools.map((tool) => ({
    tool,
    score: terms.reduce((score, term) =>
      score + (`${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(term) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
  const matches = ranked.filter((item) => item.score > 0);
  return (matches.length > 0 ? matches : ranked).slice(0, limit).map((item) => item.tool);
}

function normalizeCatalogIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function catalogIdentityTokens(value: string): Set<string> {
  return new Set(normalizeCatalogIdentity(value).split(/\s+/).filter(Boolean));
}

function latestUserEntryText(snapshot: DurableTurnSnapshot): string {
  for (const entry of [...snapshot.entries].reverse()) {
    const payload = record(entry.payload);
    const message = record(payload?.message);
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.flatMap((part) => {
        const item = record(part);
        return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
      }).join(" ");
    }
  }
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function durableMcpToolPolicy(
  server: Pick<McpServerSpec, "trustReadOnlyAnnotations">,
  hints: ReturnType<McpToolSource["approvalHints"]>,
  permissionMode: string,
): DurableToolPolicy {
  if (hints?.nonReplayable) {
    return {
      retryClass: "non_idempotent_manual",
      requiresApproval: hints.requiresApproval === true && permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }
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
