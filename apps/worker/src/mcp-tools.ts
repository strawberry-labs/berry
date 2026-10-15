import {
  McpToolSource,
  mcpServerSpecsFromJson,
  type McpServerSpec,
} from "@berry/local-agent/mcp";
import {
  DurableTurnRuntimeRequestSchema,
  NetworkPolicySchema,
  normalizeWorkerRole,
  openDurableSecret,
  sourceRevisionFromEnv,
  type JsonValue,
} from "@berry/shared";
import type { ChatContentPart, ChatToolDefinition } from "@berry/router-client";
import {
  CONTEXT_ENTRY_TYPE,
  USE_TOOL_NAME,
  type DurableToolPolicy,
  type DurableTurnSnapshot,
  type DurableTurnStep,
  type DurableTurnToolExecutor,
  type TurnToolResult,
} from "./turn-runner.js";
import { emitWorkerOperationalEvent } from "./operational-telemetry.js";

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
      log: (level, _message) => {
        emitMcpLog(level);
      },
    });
  }

  /**
   * The declared tools never include connector tools themselves: tool_search
   * finds them and use_tool runs them, so revealing a tool appends to the
   * conversation instead of rewriting the tool list, and the provider's cached
   * prefix survives (H-032). Both stay declared while connectors are
   * configured but unavailable for a turn (H-050).
   */
  async definitions(snapshot: DurableTurnSnapshot): Promise<readonly ChatToolDefinition[]> {
    const context = await this.#context(snapshot);
    const inherited = await (this.base.definitions?.(snapshot) ?? Promise.resolve([]));
    return [
      ...inherited,
      ...(context.servers.length > 0 || context.unavailable.length > 0 || connectorsUnavailableReason(snapshot)
        ? [durableToolSearchDefinition(), durableUseToolDefinition()]
        : []),
    ];
  }

  /** The connector catalog and the connector tools ready this turn, with schemas. */
  async turnContext(snapshot: DurableTurnSnapshot): Promise<string> {
    const inherited = await (this.base.turnContext?.(snapshot) ?? Promise.resolve(""));
    const context = await this.#context(snapshot);
    const tools = context.source.listTools();
    const catalog = context.servers
      .filter((server) => tools.some((tool) => this.#serverForTool(tool.name, [server]) !== undefined))
      .map((server) => `${server.id} (${server.name})`);
    const unavailable = context.unavailable.map((server) => `- ${server.id} (${server.name}): ${server.reason}`);
    if (catalog.length === 0) {
      return unavailable.length > 0
        ? [inherited, ["Connectors unavailable for this message (their tools cannot run):", ...unavailable].join("\n")].filter(Boolean).join("\n\n")
        : inherited;
    }
    const visible = this.#visibleToolNames(snapshot, context);
    const ready = tools.filter((tool) => visible.has(tool.name));
    const lines: string[] = [];
    let budget = CONNECTOR_CONTEXT_SCHEMA_CHARACTERS;
    let withoutSchema = 0;
    for (const tool of ready) {
      if (connectorSchemaGiven(snapshot, tool.name)) continue;
      const schema = JSON.stringify(jsonValue(tool.parameters));
      const line = `- ${tool.name}: ${tool.description}\n  input schema: ${schema}`;
      if (line.length <= budget) {
        lines.push(line);
        budget -= line.length;
      } else {
        lines.push(`- ${tool.name}: ${tool.description}`);
        withoutSchema += 1;
      }
    }
    const section = [
      `Connectors available to this task: ${catalog.join(", ")}. Call tool_search to find their tools, then run a found tool with use_tool.`,
      ...(lines.length > 0 ? ["Connector tools ready now (run with use_tool, passing the exact name and arguments that match the schema):", ...lines] : []),
      ...(withoutSchema > 0 ? [`Call tool_search for the input schema of the ${withoutSchema} tool${withoutSchema === 1 ? "" : "s"} listed without one.`] : []),
      ...(unavailable.length > 0 ? ["Connectors unavailable for this message (their tools cannot run):", ...unavailable] : []),
    ].join("\n");
    return [inherited, section].filter(Boolean).join("\n\n");
  }

  async modelContent(
    snapshot: DurableTurnSnapshot,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<readonly ChatContentPart[]> {
    return this.base.modelContent?.(snapshot, signal, reportProgress) ?? [];
  }

  async release(snapshot: DurableTurnSnapshot): Promise<void> {
    try {
      await this.base.release?.(snapshot);
    } finally {
      await this.#releaseTurnContext(snapshot.id);
    }
  }

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    try {
      return await (this.base.finalize?.(snapshot) ?? []);
    } finally {
      await this.#releaseTurnContext(snapshot.id);
    }
  }

  policy(
    snapshot: DurableTurnSnapshot,
    toolName: string,
    permissionMode: string,
  ): DurableToolPolicy | undefined {
    if (toolName === "tool_search" || toolName === USE_TOOL_NAME) {
      // A use_tool step only exists when the call could not be unwrapped; it
      // runs nothing and fails with guidance.
      return {
        retryClass: "read_only",
        repeatPolicy: "compare_result",
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
        repeatPolicy: "block_after_success",
        requiresApproval: true,
        approvalKind: "mcp",
      };
    }
    const hints = source.approvalHints(toolName);
    return durableMcpToolPolicy(server, hints, permissionMode);
  }

  supportsAbort(snapshot: DurableTurnSnapshot, step: DurableTurnStep): boolean {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "tool_search" || toolName === USE_TOOL_NAME) return false;
    // Connector setup, lazy discovery, and artifact staging can still await
    // work that has no AbortSignal contract. Keep the whole MCP path
    // non-abortable until every one of those seams is signal-aware.
    if (toolName.startsWith("mcp__")) return false;
    return this.base.supportsAbort?.(snapshot, step) === true;
  }

  async execute(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "tool_search") return this.#searchTools(snapshot, step);
    if (toolName === USE_TOOL_NAME) {
      throw new Error('use_tool needs {"tool": "<exact connector tool name>", "arguments": {...}}. Call tool_search to find tool names and their input schemas.');
    }
    const unavailable = connectorsUnavailableReason(snapshot);
    if (unavailable && toolName.startsWith("mcp__") && !(await this.#context(snapshot)).servers.some((server) => this.#serverForTool(toolName, [server]))) {
      throw new Error(`Connectors are unavailable for this message: ${unavailable}`);
    }
    if (!toolName.startsWith("mcp__")) {
      return signal || reportProgress
        ? this.base.execute(snapshot, step, signal, reportProgress)
        : this.base.execute(snapshot, step);
    }
    const context = await this.#context(snapshot);
    if (!this.#serverForTool(toolName, context.servers)) {
      const lost = context.unavailable.find((server) => toolName.startsWith(`mcp__${sanitizeName(server.name)}__`));
      if (lost) throw new Error(`The ${lost.name} connector is unavailable for this message: ${lost.reason}`);
      throw new Error(`MCP tool ${toolName} is not enabled for this turn`);
    }
    if (!this.#visibleToolNames(snapshot, context).has(toolName)) {
      throw new Error(deferredMcpToolError(toolName));
    }
    const tool = context.source.listTools().find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`MCP tool ${toolName} is unavailable`);
    const callId = stringValue(step.input.toolCallId) ?? step.id;
    // Repeating an import whose file was not staged retries staging of the
    // Berry file already held instead of downloading it again (H-068).
    const resumed = this.base.stageAssociatedInputFiles ? resumableConnectorImport(snapshot, step, toolName) : null;
    const result = resumed
      ? { content: [], details: resumed.details }
      : signal || reportProgress
        ? await tool.execute(callId, (record(step.input.arguments) ?? {}) as never, signal, reportProgress)
        : await tool.execute(callId, (record(step.input.arguments) ?? {}) as never);
    let text = boundedMcpText(result.content.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []
    ).join("\n"), record(result.details)?.structuredContent);
    const artifact = connectorArtifact(result.details);
    let staged: Awaited<ReturnType<NonNullable<DurableTurnToolExecutor["stageAssociatedInputFiles"]>>> = [];
    let stagingError: string | undefined;
    if (artifact && this.base.stageAssociatedInputFiles) {
      try {
        staged = await this.base.stageAssociatedInputFiles(snapshot, [artifact.fileId], {
          ...(signal ? { signal } : {}),
          ...(reportProgress ? { reportProgress } : {}),
        });
      } catch (error) {
        // Cancellation ends the call. Any other staging failure leaves the
        // import itself intact, so report it rather than discard the receipt.
        if (signal?.aborted) throw error;
        stagingError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    }
    const stagedArtifact = artifact ? staged.find((item) => item.fileId === artifact.fileId) : undefined;
    if (artifact) {
      text = connectorArtifactText(artifact, stagedArtifact, Boolean(this.base.stageAssociatedInputFiles), stagingError);
    }
    const parts = sanitizeMcpJournalValue(result.content);
    return {
      output: {
        content: text || "(no output)",
        tool: toolName,
        details: sanitizeMcpJournalValue(result.details),
        parts,
        ...(staged.length ? { artifacts: staged.map((item) => ({ ...item })) } : {}),
        ...(artifact && this.base.stageAssociatedInputFiles
          ? {
              stagingStatus: stagedArtifact ? "ready" : stagingError ? "failed" : "pending_verification",
              ...(stagingError && !stagedArtifact ? { stagingError } : {}),
              ...(resumed ? { resumedFromStep: resumed.stepId } : {}),
            }
          : {}),
      },
      summary: text ? `${toolName} returned results` : `${toolName} completed`,
    };
  }

  async close(): Promise<void> {
    const contexts = [...this.#turnContexts.values()];
    this.#turnContexts.clear();
    await Promise.all([
      this.#source.close(),
      ...contexts.map((context) => context.source.close()),
    ]);
  }

  async #releaseTurnContext(runId: string): Promise<void> {
    const context = this.#turnContexts.get(runId);
    if (!context) return;
    this.#turnContexts.delete(runId);
    await context.source.close();
  }

  async #context(snapshot: DurableTurnSnapshot): Promise<DurableMcpTurnContext> {
    const existing = this.#turnContexts.get(snapshot.id);
    if (existing) return existing;
    const runtime = DurableTurnRuntimeRequestSchema.safeParse(snapshot.runtimeRequest);
    if (!runtime.success) {
      return { source: this.#source, servers: this.#allowedServers(snapshot), unavailable: [] };
    }
    // Each connector opens its own credentials: one that cannot be opened is
    // unavailable for this turn without blocking healthy connectors or a
    // request that needs none (H-077).
    const enabled = runtime.data.mcpServers.filter((server) => server.enabled && server.trusted);
    const prepared = await Promise.allSettled(enabled
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
    const servers = prepared.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const unavailable = prepared.flatMap((result, index) => result.status === "rejected"
      ? [{
          id: enabled[index]!.id,
          name: enabled[index]!.name,
          reason: `its credentials could not be opened (${(result.reason instanceof Error ? result.reason.message : String(result.reason)).replace(/\s+/g, " ").slice(0, 200)}). An administrator or the connection owner should reconnect it.`,
        }]
      : []);
    const policy = NetworkPolicySchema.safeParse(runtime.data.networkPolicy);
    const source = new McpToolSource({
      servers: [...servers],
      ...(policy.success ? { networkPolicy: policy.data } : {}),
      connectTimeoutMs: this.connectTimeoutMs,
      log: (level, _message) => {
        emitMcpLog(level, snapshot.id);
      },
    });
    // Cached, administrator-reviewed schemas are enough for model preparation.
    // McpToolSource connects only when one exposed tool is actually executed.
    const context = { source, servers, unavailable };
    this.#turnContexts.set(snapshot.id, context);
    return context;
  }

  async #searchTools(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const context = await this.#context(snapshot);
    const unavailable = connectorsUnavailableReason(snapshot);
    if (unavailable && context.servers.length === 0) {
      throw new Error(`Connectors are unavailable for this message: ${unavailable}`);
    }
    if (context.servers.length === 0 && context.unavailable.length > 0) {
      throw new Error(`Connectors are unavailable for this message: ${context.unavailable.map((server) => `${server.name}: ${server.reason}`).join("; ")}`);
    }
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
    const lostConnector = connectorId && !connector
      ? context.unavailable.find((server) => server.id === connectorId || normalizeCatalogIdentity(server.name) === normalizedConnectorId)
      : undefined;
    if (lostConnector) throw new Error(`The ${lostConnector.name} connector is unavailable for this message: ${lostConnector.reason}`);
    if (connectorId && !connector) {
      throw new Error(`Unknown or unauthorized connector: ${connectorId}`);
    }
    const limitValue = typeof input.limit === "number" && Number.isSafeInteger(input.limit)
      ? input.limit
      : 8;
    const limit = Math.max(1, Math.min(20, limitValue));
    const uncachedServerIds = (connector ? [connector] : context.servers)
      .filter((server) => (server.cachedTools?.length ?? 0) === 0)
      .map((server) => server.id);
    if (uncachedServerIds.length > 0) {
      await context.source.discoverTools(uncachedServerIds);
    }
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
      ? [
          'Connector tools found. Run one with use_tool: {"tool": "<name>", "arguments": {...}} using arguments that match its input schema.',
          ...matches.map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(jsonValue(tool.parameters))}`),
        ].join("\n")
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

function emitMcpLog(level: "debug" | "info" | "warn" | "error", runId?: string): void {
  emitWorkerOperationalEvent(
    "phase.transition",
    normalizeWorkerRole(process.env.BERRY_WORKER_ROLE),
    sourceRevisionFromEnv(process.env),
    {
      ...(runId ? { runId } : {}),
      phase: "mcp",
      outcome: `connector_${level}`,
      toolFamily: "mcp",
    },
  );
}

type DurableMcpTurnContext = {
  source: McpToolSource;
  servers: readonly McpServerSpec[];
  /** Enabled connectors whose credentials or environment could not be opened this turn (H-077). */
  unavailable: readonly { id: string; name: string; reason: string }[];
};

/** Stable across turns and tenants: the connector catalog lives in the turn context (H-032). */
function durableToolSearchDefinition(): ChatToolDefinition {
  return {
    type: "function",
    function: {
      name: "tool_search",
      description: "Find connector tools by capability. The connectors this task may use are listed in the turn context. Select a connector when the request uses a paraphrase that may not occur in a tool name. Results give each tool's input schema; run a found tool with use_tool.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          connector: {
            type: "string",
            description: "Optional exact connector id from the turn context's connector list.",
          },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

function durableUseToolDefinition(): ChatToolDefinition {
  return {
    type: "function",
    function: {
      name: USE_TOOL_NAME,
      description: "Run a connector tool that tool_search returned or the turn context lists as ready. Pass its exact name and arguments that match its input schema.",
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", minLength: 1, description: "Exact connector tool name, for example mcp__drive__search." },
          arguments: { type: "object", description: "Arguments matching that tool's input schema." },
        },
        required: ["tool", "arguments"],
        additionalProperties: false,
      },
    },
  };
}

/** Connector schemas the turn context lists, at most this many characters per turn. */
const CONNECTOR_CONTEXT_SCHEMA_CHARACTERS = 16_000;

/** True when this conversation already gave the tool's schema (turn context or tool_search). */
function connectorSchemaGiven(snapshot: DurableTurnSnapshot, toolName: string): boolean {
  const marker = `- ${toolName}: `;
  return snapshot.entries.some((entry) => {
    const payload = record(entry.payload);
    if (entry.entryType === CONTEXT_ENTRY_TYPE) {
      const text = typeof payload?.text === "string" ? payload.text : "";
      return text.includes(marker) && text.includes("input schema");
    }
    const message = record(payload?.message);
    if (message?.role !== "toolResult" || message.toolName !== "tool_search") return false;
    const text = mcpToolNamesInContent(message.content).includes(toolName) ? JSON.stringify(message.content) : "";
    return text.includes(marker) && text.includes("input schema");
  });
}

/** Why configured connectors could not be prepared for this turn, if they could not (H-050). */
function connectorsUnavailableReason(snapshot: DurableTurnSnapshot): string | null {
  if (!Array.isArray(snapshot.runtimeRequest.capabilityNotices)) return null;
  for (const candidate of snapshot.runtimeRequest.capabilityNotices) {
    const notice = record(candidate);
    if (notice?.capability === "connectors" && typeof notice.reason === "string" && notice.reason) return notice.reason;
  }
  return null;
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
  return `MCP tool ${toolName} has not been found in this conversation yet. Call tool_search for it to get its input schema, then run it with use_tool.`;
}

function isDeferredMcpToolFailure(step: DurableTurnStep, toolName: string): boolean {
  if (step.state !== "failed" || typeof step.error !== "string") return false;
  return step.error === deferredMcpToolError(toolName)
    || step.error === `MCP tool ${toolName} was deferred because its connector schema was not active. The connector is now enabled for the next model call; retry the tool with the provided schema.`
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
      repeatPolicy: "block_after_success",
      requiresApproval: hints.requiresApproval === true && permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }
  if (hints?.requiresApproval) {
    return {
      retryClass: hints.idempotent ? "idempotent_with_key" : "non_idempotent_manual",
      repeatPolicy: "block_after_success",
      requiresApproval: permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }
  if (hints?.trustedReadOnly) {
    return {
      retryClass: "read_only",
      repeatPolicy: "compare_result",
      requiresApproval: false,
      approvalKind: "mcp",
    };
  }
  // Only Berry-owned adapters opt into authoritative annotations. A custom
  // server cannot waive approval or claim that a side effect is retry-safe.
  if (server.trustReadOnlyAnnotations !== true) {
    return {
      retryClass: "non_idempotent_manual",
      repeatPolicy: "block_after_success",
      requiresApproval: permissionMode !== "full-access",
      approvalKind: "mcp",
    };
  }
  const requiresApproval = permissionMode !== "full-access";
  if (hints?.destructive) {
    return {
      retryClass: "non_idempotent_manual",
      repeatPolicy: "block_after_success",
      requiresApproval,
      approvalKind: "mcp",
    };
  }
  if (hints?.idempotent) {
    return {
      retryClass: "idempotent_with_key",
      repeatPolicy: "block_after_success",
      requiresApproval,
      approvalKind: "mcp",
    };
  }
  return {
    retryClass: "non_idempotent_manual",
    repeatPolicy: "block_after_success",
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

/**
 * The latest earlier call of the same tool with the same arguments, when it
 * imported a file that did not reach the sandbox. Its stored receipt holds the
 * Berry file identity, so staging can be retried without the remote call.
 */
function resumableConnectorImport(
  snapshot: DurableTurnSnapshot,
  step: DurableTurnStep,
  toolName: string,
): { stepId: string; details: unknown } | null {
  const argumentsKey = canonicalJson(record(step.input.arguments) ?? {});
  const previous = snapshot.steps
    .filter((candidate) => candidate.id !== step.id
      && candidate.sequence < step.sequence
      && candidate.state === "completed"
      && (stringValue(candidate.input.toolName) ?? candidate.type.slice(5)) === toolName
      && canonicalJson(record(candidate.input.arguments) ?? {}) === argumentsKey)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const output = record(previous?.output);
  if (!previous || (output?.stagingStatus !== "pending_verification" && output?.stagingStatus !== "failed")) return null;
  return connectorArtifact(output.details) ? { stepId: previous.id, details: output.details } : null;
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
      : item;
  return JSON.stringify(canonical(value)) ?? "";
}

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
  stagingAvailable = true,
  stagingError?: string,
): string {
  const disposition = artifact.library === true
    ? `Saved ${artifact.name} to the Berry Library.`
    : artifact.library === false
      ? `Downloaded ${artifact.name} for temporary use in this task.`
      : `Imported ${artifact.name} into Berry.`;
  // Without a sandbox path the file is not usable yet; say so explicitly so the
  // model neither assumes a path nor searches the filesystem for it.
  const retry = "Call this tool again with the same arguments to stage it: Berry reuses the file it already downloaded and does not download it again.";
  const storage = staged
    ? `Sandbox path: ${staged.path}`
    : !stagingAvailable
      ? artifact.library === false
        ? "The file is stored as a task-scoped Berry artifact."
        : "The file is stored as a Berry artifact."
      : stagingError
        ? `Berry could not copy ${artifact.name} (Berry file ${artifact.fileId}) into the sandbox: ${stagingError}. It is not at any sandbox path. ${retry} If it fails again, tell the user the file could not be opened. Do not search the filesystem for it.`
        : `Berry is still verifying ${artifact.name} (Berry file ${artifact.fileId}), so it is not in the sandbox yet. ${retry} Do not search the filesystem for it.`;
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

const MCP_MODEL_TEXT_LIMIT = 120_000;
const CURSOR_KEYS = ["nextPageToken", "nextCursor", "next_cursor", "nextPage", "cursor"] as const;

/**
 * Bound a tool result for the model without breaking it: JSON stays valid
 * (the largest top-level list is shortened), top-level fields such as the
 * next-page cursor are kept, and every cut is disclosed with counts (H-070).
 */
export function boundedMcpText(text: string, structured?: unknown, limit = MCP_MODEL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const cursor = cursorFrom(structured);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const container = Array.isArray(parsed) ? { items: parsed } : record(parsed);
  if (container) {
    const lists = Object.entries(container).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]));
    const [field, items] = lists.sort((left, right) => JSON.stringify(right[1]).length - JSON.stringify(left[1]).length)[0] ?? [];
    if (field && items) {
      const render = (kept: number) => JSON.stringify({
        ...container,
        [field]: items.slice(0, kept),
        ...(cursor && !Object.values(container).includes(cursor) ? { nextPageToken: cursor } : {}),
        berryTruncation: {
          field,
          returnedItems: kept,
          totalItems: items.length,
          originalCharacters: text.length,
          note: `Only the first ${kept} of ${items.length} ${field} fit in this result. Request a smaller page or narrower query for the rest; any page cursor above is exact.`,
        },
      });
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (render(middle).length <= limit) low = middle;
        else high = middle - 1;
      }
      const fitted = render(low);
      if (fitted.length <= limit) return fitted;
    }
  }
  const marker = `\n[Berry truncated this tool result: showing ${limit.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters. Request a narrower range or a smaller page.${cursor ? ` Exact next-page cursor: ${cursor}` : ""}]`;
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function cursorFrom(value: unknown): string | null {
  const object = record(value);
  if (!object) return null;
  for (const key of CURSOR_KEYS) {
    const cursor = object[key];
    if (typeof cursor === "string" && cursor.trim()) return cursor;
  }
  return null;
}

const MCP_JOURNAL_STRING_LIMIT = 120_000;
const MCP_JOURNAL_ARRAY_LIMIT = 256;
const MCP_JOURNAL_OBJECT_LIMIT = 128;
const MCP_JOURNAL_DEPTH_LIMIT = 8;
const MCP_BINARY_FIELD = /^(?:b64_json|base64|blob|bytes|data)$/i;

/**
 * Removes binary MCP payloads and bounds structured metadata before journaling
 * it. Every cut says what was left out, so a bounded record is never read as
 * the complete response (H-070).
 */
export function sanitizeMcpJournalValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > MCP_JOURNAL_STRING_LIMIT
      ? `${value.slice(0, MCP_JOURNAL_STRING_LIMIT)}…[Berry kept ${MCP_JOURNAL_STRING_LIMIT.toLocaleString("en-US")} of ${value.length.toLocaleString("en-US")} characters]`
      : value;
  }
  if (depth >= MCP_JOURNAL_DEPTH_LIMIT) return "[omitted: MCP metadata nesting limit reached]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, MCP_JOURNAL_ARRAY_LIMIT).map((item) => sanitizeMcpJournalValue(item, depth + 1));
    return value.length > MCP_JOURNAL_ARRAY_LIMIT
      ? [...kept, `[Berry omitted ${value.length - MCP_JOURNAL_ARRAY_LIMIT} more of ${value.length} items]`]
      : kept;
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
  const allEntries = Object.entries(object);
  const entries = allEntries.slice(0, MCP_JOURNAL_OBJECT_LIMIT);
  return Object.fromEntries([
    ...entries.map(([key, item]) => [
      key,
      MCP_BINARY_FIELD.test(key)
        ? "[omitted: binary MCP content is not stored in the journal]"
        : sanitizeMcpJournalValue(item, depth + 1),
    ]),
    ...(allEntries.length > MCP_JOURNAL_OBJECT_LIMIT
      ? [["berryOmittedFields", `${allEntries.length - MCP_JOURNAL_OBJECT_LIMIT} more of ${allEntries.length} fields`]]
      : []),
  ]);
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
