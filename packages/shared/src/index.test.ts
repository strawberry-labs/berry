import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentStreamEventSchema,
  ApprovalPushPayloadSchema,
  HostMethodCatalog,
  HostPushEventSchema,
  MobileDeviceRegistrationCreateSchema,
  MobileDeviceRegistrationSchema,
  AlertRuleCreateSchema,
  ArchivedChatsSearchSchema,
  BulkLimitMutationSchema,
  EffectiveLimitSchema,
  FinancialMutationSchema,
  ServiceAccountTokenResponseSchema,
  UsageAnalyticsQuerySchema,
  UsageRequestDetailSchema,
  OrgModelDefaultSchema,
  OrgModelPolicySchema,
  RemoteModelSchema,
  PROTOCOL_VERSION,
  TerminalSessionSchema,
  TaskGroupSchema,
  TaskSchema,
  UiModeSchema,
  WorkspaceSchema,
  resolveModelCapabilities,
  networkDomainAllowed,
  networkPolicyForSandbox,
  parseNetworkDomainAllowlist,
  type AgentStreamEvent,
} from "./index.ts";
import { renderHostProtocolDocs } from "./protocol-docs.ts";
import { builtInCommandManifests, parseSlashCommand } from "./commands.ts";

describe("AgentStreamEventSchema", () => {
  it("parses every event kind in the turn vocabulary", () => {
    const events: AgentStreamEvent[] = [
      { kind: "turn.start", turnId: "turn_1" },
      { kind: "message.start", messageId: "msg_1", role: "assistant" },
      { kind: "message.delta", messageId: "msg_1", delta: "Hello", channel: "text" },
      { kind: "message.end", messageId: "msg_1" },
      { kind: "tool.start", toolCallId: "tc_1", name: "read_file", title: "Reading file" },
      { kind: "tool.update", toolCallId: "tc_1", detail: "50%" },
      { kind: "tool.end", toolCallId: "tc_1", status: "completed", durationMs: 42, summary: "Read 12 lines" },
      {
        kind: "approval.request",
        approvalId: "ap_1",
        approvalKind: "shell",
        title: "Run `pnpm test`",
        detail: "pnpm test",
        rawDetail: "FOO=1 /usr/bin/pnpm test",
        diff: "--- a/x\n+++ b/x",
        destructive: true,
        openWorld: true,
      },
      { kind: "usage", inputTokens: 100, outputTokens: 25, model: "berry/router-auto" },
      { kind: "session.note", note: "compacted" },
      { kind: "mode.changed", mode: "code", source: "classifier", reason: "Repository inspection requested", applied: true, pinnedByUser: false },
      { kind: "error", message: "provider unavailable" },
      { kind: "turn.end", turnId: "turn_1", status: "completed" },
    ];
    for (const event of events) {
      expect(AgentStreamEventSchema.parse(event)).toMatchObject({ kind: event.kind });
    }
  });

  it("defaults message.delta channel to text", () => {
    const parsed = AgentStreamEventSchema.parse({
      kind: "message.delta",
      messageId: "msg_1",
      delta: "chunk",
    });
    expect(parsed).toMatchObject({ channel: "text" });
  });

  it("rejects unknown kinds and bad tool status", () => {
    expect(() => AgentStreamEventSchema.parse({ kind: "bogus" })).toThrow();
    expect(() =>
      AgentStreamEventSchema.parse({ kind: "tool.end", toolCallId: "tc", status: "exploded" }),
    ).toThrow();
  });
});

describe("settings and administration contracts", () => {
  it("validates URL-backed analytics filters and rejects inverted ranges", () => {
    const query = UsageAnalyticsQuerySchema.parse({ from: "2026-07-01T00:00:00.000Z", to: "2026-07-21T00:00:00.000Z", departmentId: "engineering", agentId: "agent_release", limit: "25" });
    expect(query).toMatchObject({ departmentId: "engineering", agentId: "agent_release", limit: 25 });
    expect(() => UsageAnalyticsQuerySchema.parse({ from: query.to, to: query.from })).toThrow();
  });

  it("allows only redacted request detail fields", () => {
    const detail = UsageRequestDetailSchema.parse({ id: "evt_1", requestId: "req_redacted", ts: "2026-07-21T00:00:00.000Z", userId: "user_1", departmentId: null, workspaceId: "workspace_1", agentId: "agent_1", feature: "code", provider: "router", model: "kimi-2.6", status: "completed", tokensIn: 10, tokensOut: 20, tokensCached: 4, billedCostMicros: "1200", latencyMs: 340, ttftMs: 80, reservationStatus: "reconciled", taskId: "task_1", sessionId: "session_1", sandboxId: "sandbox_1", reservationId: "reservation_1", safeMetadata: { region: "uae", retry: false }, prompt: "must not survive parsing" });
    expect(detail).not.toHaveProperty("prompt");
    expect(detail.safeMetadata).toEqual({ region: "uae", retry: false });
  });

  it("requires confirmation and deterministic limit mutations", () => {
    expect(FinancialMutationSchema.parse({ amountMicros: "25000000", source: "support", reason: "Contract credit", confirmation: true, idempotencyKey: "grant-2026-001" })).toMatchObject({ confirmation: true });
    expect(() => FinancialMutationSchema.parse({ amountMicros: "25000000", source: "support", reason: "ok", confirmation: false, idempotencyKey: "short" })).toThrow();
    expect(BulkLimitMutationSchema.parse({ idempotencyKey: "limits-2026-001", reason: "Quarterly allowance update", items: [{ scopeType: "user", scopeId: "user_1", period: "month", hardLimitMicros: "25000000" }] }).dryRun).toBe(false);
    expect(EffectiveLimitSchema.parse({ tenantId: "tenant_1", userId: "user_1", metric: "cost", period: "month", effectiveValue: "25000000", used: "10000000", reserved: "2000000", available: "13000000", projected: "22000000", status: "healthy", trace: [{ limitId: "limit_user", scopeType: "user", scopeId: "user_1", metric: "cost", value: "25000000", active: true, winning: true, reason: "Most restrictive active hard limit" }] }).trace[0]?.winning).toBe(true);
  });

  it("keeps alert inputs strict and service tokens one-time response shaped", () => {
    expect(() => AlertRuleCreateSchema.parse({ name: "Budget", signal: "spend_threshold", enabled: true, threshold: 80, windowMinutes: 60, destinationIds: [], secret: "leak" })).toThrow();
    expect(ServiceAccountTokenResponseSchema.parse({ account: { id: "sa_1", tenantId: "tenant_1", name: "CI", status: "active", permissions: ["usage:read"], departmentId: null, resourceRestrictions: [], expiresAt: null, lastUsedAt: null, tokenLast4: "abcd", createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" }, token: "berry_sa_once_only_0123456789" }).token).toContain("once_only");
  });
});

describe("network policy", () => {
  it("normalizes exact and wildcard allowlists conservatively", () => {
    const domains = parseNetworkDomainAllowlist("API.Example.com, *.docs.example.com,api.example.com");
    expect(domains).toEqual(["*.docs.example.com", "api.example.com"]);
    expect(networkDomainAllowed("api.example.com", domains)).toBe(true);
    expect(networkDomainAllowed("v1.docs.example.com", domains)).toBe(true);
    expect(networkDomainAllowed("docs.example.com", domains)).toBe(false);
    expect(networkDomainAllowed("example.com", domains)).toBe(false);
    expect(() => parseNetworkDomainAllowlist("https://example.com/path")).toThrow("Invalid network domain pattern");
  });

  it("maps sandbox tiers onto host-side egress enforcement", () => {
    expect(networkPolicyForSandbox({ tier: "read-only" })).toMatchObject({ egress: "off" });
    expect(networkPolicyForSandbox({ tier: "workspace-write", writableRoots: ["/tmp"], network: "off" })).toMatchObject({ egress: "off" });
    expect(networkPolicyForSandbox({ tier: "workspace-write", writableRoots: ["/tmp"], network: "on" }, ["example.com"])).toEqual({ egress: "on", allowedDomains: ["example.com"] });
    expect(networkPolicyForSandbox({ tier: "danger-full-access" })).toMatchObject({ egress: "unrestricted" });
  });
});

describe("HostPushEventSchema", () => {
  it("parses agent.event envelopes", () => {
    const parsed = HostPushEventSchema.parse({
      type: "agent.event",
      taskId: "task_1",
      sessionId: "session_1",
      event: { kind: "turn.start", turnId: "turn_1" },
    });
    expect(parsed.type).toBe("agent.event");
  });

  it("parses terminal output and exit envelopes", () => {
    expect(
      HostPushEventSchema.parse({ type: "terminal.output", terminalId: "t1", seq: 3, data: "$ " }),
    ).toMatchObject({ terminalId: "t1" });
    expect(
      HostPushEventSchema.parse({ type: "terminal.exit", terminalId: "t1", exitCode: 0 }),
    ).toMatchObject({ exitCode: 0 });
  });

  it("parses session target update envelopes", () => {
    expect(
      HostPushEventSchema.parse({
        type: "session.target.updated",
        sessionId: "session_1",
        target: {
          sessionId: "session_1",
          goalText: "Ship goals",
          status: "active",
          tokenBudget: null,
          timeBudgetMin: 30,
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ type: "session.target.updated" });
  });

  it("parses session lease loss envelopes", () => {
    expect(
      HostPushEventSchema.parse({
        type: "session.lease.lost",
        sessionId: "session_1",
        owner: "cli:b",
        previousOwner: "cli:a",
      }),
    ).toMatchObject({ type: "session.lease.lost" });
  });

  it("parses host shutdown envelopes", () => {
    expect(HostPushEventSchema.parse({ type: "host.shutting_down", reason: "host_shutdown", graceMs: 750 })).toMatchObject({
      type: "host.shutting_down",
      graceMs: 750,
    });
  });

  it("rejects envelopes with a missing discriminator payload", () => {
    expect(() => HostPushEventSchema.parse({ type: "agent.event", taskId: "t" })).toThrow();
  });
});

describe("conversation kind compatibility", () => {
  const baseTask = {
    id: "task_1",
    workspaceId: "workspace_1",
    title: "Legacy task",
    status: "completed",
    activeSessionId: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };

  it("prefers the durable kind and decodes old task rows deterministically", () => {
    expect(TaskSchema.parse({ ...baseTask, conversationKind: "chat", uiMode: "code" }).conversationKind).toBe("chat");
    expect(TaskSchema.parse({ ...baseTask, uiMode: "code" }).conversationKind).toBe("code");
    expect(TaskSchema.parse({ ...baseTask, uiMode: "cowork" }).conversationKind).toBe("chat");
    expect(TaskSchema.parse({ ...baseTask, uiMode: null, worktreePath: "/tmp/worktree" }).conversationKind).toBe("code");
    expect(TaskSchema.parse({ ...baseTask, uiMode: null }).conversationKind).toBe("chat");
  });

  it("defaults legacy workspaces to projects without inventing an owner", () => {
    const workspace = WorkspaceSchema.parse({
      id: "workspace_1",
      path: "/workspace",
      name: "Project",
      trustState: "trusted",
      lastOpenedAt: "2026-07-20T00:00:00.000Z",
      indexedAt: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(workspace).toMatchObject({ workspaceKind: "project", ownerUserId: null, pinned: false });
  });
});

describe("mobile companion schemas", () => {
  it("validates endpoint modes and redacted push-token registrations", () => {
    const createInput = MobileDeviceRegistrationCreateSchema.parse({
      deviceId: "ios-device-1",
      platform: "ios",
      pushProvider: "apns",
      pushToken: "apns-token-secret",
      endpointMode: "self-hosted",
      appVersion: "0.1.0",
      capabilities: ["approvals", "chat", "tasks", "push"],
    });
    expect(createInput.endpointMode).toBe("self-hosted");

    const registration = MobileDeviceRegistrationSchema.parse({
      id: "device_reg_1",
      tenantId: "tenant_1",
      userId: "user_1",
      deviceId: "ios-device-1",
      platform: "ios",
      pushProvider: "apns",
      pushTokenLast4: "cret",
      endpointMode: "self-hosted",
      appVersion: "0.1.0",
      capabilities: ["approvals", "chat", "tasks", "push"],
      status: "active",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      lastSeenAt: "2026-07-11T00:00:00.000Z",
    });
    expect(registration.pushTokenLast4).toBe("cret");
    expect(() => MobileDeviceRegistrationSchema.parse({ ...registration, pushToken: "secret" })).toThrow();
  });

  it("keeps approval push payloads secret-free", () => {
    const payload = ApprovalPushPayloadSchema.parse({
      type: "approval.requested",
      approvalId: "approval_1",
      title: "Run command",
      detail: "Approve or deny in Berry.",
      createdAt: "2026-07-11T00:00:00.000Z",
    });
    expect(JSON.stringify(payload)).not.toContain("token");
    expect(() => ApprovalPushPayloadSchema.parse({ ...payload, secret: "nope" })).toThrow();
  });
});

describe("model capability metadata", () => {
  it("validates context and cost hints and resolves manual overrides first", () => {
    const model = RemoteModelSchema.parse({
      id: "test-model",
      contextWindow: 32_000,
      capabilities: {
        tools: true,
        vision: true,
        context: { windowTokens: 64_000, maxOutputTokens: 8_000 },
        cost: { input: 1, output: 4 },
      },
      capabilityOverrides: {
        vision: false,
        context: { windowTokens: 128_000 },
        cost: { input: 0.5 },
      },
    });
    expect(resolveModelCapabilities(model)).toEqual({
      tools: true,
      vision: false,
      context: { windowTokens: 128_000, maxOutputTokens: 8_000 },
      cost: { input: 0.5, output: 4 },
    });
  });
});

describe("HostMethodCatalog", () => {
  it("validates additive Berry Router account and served-by contracts", () => {
    expect(HostMethodCatalog["router.account.get"].result.parse({
      id: "acct_1",
      email: "router@example.test",
      displayName: null,
      plan: "pro",
      quota: { limit: 100, used: 37, remaining: 63, unit: "usd", resetsAt: "2026-08-01T00:00:00.000Z" },
      aliases: ["berry/fast"],
    })).toMatchObject({ id: "acct_1", aliases: ["berry/fast"] });
    expect(AgentStreamEventSchema.parse({
      kind: "usage",
      inputTokens: 10,
      outputTokens: 2,
      model: "berry/fast",
      requestedModel: "berry/fast",
      servedProvider: "openai",
      servedModel: "openai/gpt-4.1-mini",
    })).toMatchObject({ servedProvider: "openai", servedModel: "openai/gpt-4.1-mini" });
  });
  it("validates categorized provider health results", () => {
    expect(HostMethodCatalog["model.provider.check"].result.parse({
      ok: false,
      status: "model-missing",
      category: "model",
      checkedAt: "2026-07-09T12:00:00.000Z",
      latencyMs: 18,
    })).toMatchObject({ category: "model", latencyMs: 18 });
  });

  it("validates native local-model lifecycle RPCs", () => {
    expect(HostMethodCatalog["model.local.pull"].params.parse({ providerId: "ollama", model: "qwen3:8b" })).toEqual({
      providerId: "ollama",
      model: "qwen3:8b",
    });
    expect(HostMethodCatalog["model.local.cancel"].result.parse({ cancelled: true })).toEqual({ cancelled: true });
    expect(HostMethodCatalog["model.local.download"].params.parse({ providerId: "lm", model: "google/gemma", quantization: "Q4_K_M" })).toMatchObject({
      providerId: "lm",
      model: "google/gemma",
      quantization: "Q4_K_M",
    });
    expect(HostMethodCatalog["model.local.load"].result.parse({ loaded: true, instanceId: "instance-1" })).toEqual({ loaded: true, instanceId: "instance-1" });
    expect(HostMethodCatalog["model.local.unload"].result.parse({ unloaded: true, instanceId: "instance-1" })).toEqual({ unloaded: true, instanceId: "instance-1" });
    expect(() => HostMethodCatalog["model.local.pull"].params.parse({ providerId: "ollama", model: "" })).toThrow();
  });
  it("validates extension native-messaging registration RPCs", () => {
    expect(HostMethodCatalog["extension.nativeMessaging.setEnabled"].params.parse({
      enabled: true,
      extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
    })).toEqual({
      enabled: true,
      extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
    });
    expect(HostMethodCatalog["extension.nativeMessaging.status"].result.parse({
      enabled: true,
      hostName: "com.berry.desktop_host",
      manifestPaths: ["/tmp/com.berry.desktop_host.json"],
      configPath: "/tmp/config.json",
      nativeHostPath: "/tmp/berry-extension-host.mjs",
      socketPath: "/tmp/berry.sock",
      tokenPath: "/tmp/berry.sock.token",
      allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
      requiresExtensionId: false,
    })).toMatchObject({ enabled: true, requiresExtensionId: false });
  });
  it("validates explicit conversation-kind and General-workspace methods", () => {
    expect(HostMethodCatalog["task.setConversationKind"].params.parse({ id: "task_1", conversationKind: "code" })).toEqual({
      id: "task_1",
      conversationKind: "code",
    });
    expect(HostMethodCatalog["task.create"].params.parse({ workspaceKind: "general", conversationKind: "chat" })).toMatchObject({
      workspaceKind: "general",
      conversationKind: "chat",
    });
    expect(HostMethodCatalog["workspace.list"].params.parse({})).toEqual({});
    expect(HostMethodCatalog["task.listGeneral"].params.parse({ limit: 6, offset: 0 })).toEqual({ limit: 6, offset: 0 });
  });

  it("keeps legacy mode and group schemas decodable but removes their active RPCs", () => {
    expect(UiModeSchema.parse("cowork")).toBe("cowork");
    expect(TaskGroupSchema.parse({
      id: "group_1",
      workspaceId: "workspace_1",
      name: "Legacy",
      color: null,
      position: 0,
      collapsed: false,
      taskIds: [],
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    })).toMatchObject({ id: "group_1" });
    expect("intent.classify" in HostMethodCatalog).toBe(false);
    expect("task.setUiMode" in HostMethodCatalog).toBe(false);
    expect(Object.keys(HostMethodCatalog).some((method) => method.startsWith("task.group."))).toBe(false);
  });

  it("normalizes legacy model-governance payloads to the two active profiles", () => {
    const now = "2026-07-20T00:00:00.000Z";
    expect(OrgModelPolicySchema.parse({
      id: "policy_1",
      tenantId: "tenant_1",
      providerId: "router",
      model: "berry/auto",
      modeAllow: ["chat", "cowork", "code"],
      createdAt: now,
      updatedAt: now,
    }).modeAllow).toEqual(["chat", "code"]);
    expect(OrgModelDefaultSchema.parse({
      tenantId: "tenant_1",
      mode: "cowork",
      providerId: "router",
      model: "berry/auto",
      updatedAt: now,
    }).mode).toBe("chat");
  });

  it("keeps MCP protocol changes additive", () => {
    expect(HostMethodCatalog["mcp.server.save"].params.parse({ name: "docs", transport: "streamable-http", url: "https://mcp.example.com/mcp" })).toMatchObject({
      name: "docs",
      transport: "streamable-http",
    });
    expect(Object.keys(HostMethodCatalog)).toEqual(expect.arrayContaining([
      "mcp.server.health",
      "mcp.server.reconnect",
      "mcp.import.scan",
      "mcp.import.apply",
      "mcp.oauth.start",
      "mcp.oauth.exchange",
      "mcp.oauth.poll",
    ]));
  });

  it("exposes managed skill authoring contracts", () => {
    expect(HostMethodCatalog["skill.create"].params.parse({ name: "release-notes", version: "1.0.0" })).toEqual({ name: "release-notes", version: "1.0.0" });
    expect(Object.keys(HostMethodCatalog)).toEqual(expect.arrayContaining(["skill.create", "skill.openFolder", "skill.getUserDirectory"]));
  });

  it("includes session target RPCs", () => {
    expect(Object.keys(HostMethodCatalog)).toEqual(
      expect.arrayContaining(["session.target.get", "session.target.set", "session.target.clear"]),
    );
  });

  it("includes app-server lease RPCs and generated protocol docs", () => {
    expect(Object.keys(HostMethodCatalog)).toEqual(expect.arrayContaining(["host.handshake", "agent.takeover"]));
    const docs = readFileSync(new URL("../../../docs/protocol/host-methods.md", import.meta.url), "utf8");
    expect(docs).toBe(renderHostProtocolDocs());
    expect(docs).toContain(`Protocol version: \`${PROTOCOL_VERSION}\``);
    for (const method of Object.keys(HostMethodCatalog)) {
      expect(docs).toContain(`### \`${method}\``);
    }
  });

  it("validates security management and audit contracts", () => {
    expect(HostMethodCatalog["policy.rule.create"].params.parse({
      layer: "user",
      kind: "exact",
      decision: "allow",
      pattern: ["pnpm", "test"],
    })).toMatchObject({ layer: "user", kind: "exact" });
    expect(() => HostMethodCatalog["policy.rule.create"].params.parse({ layer: "managed", kind: "exact", decision: "allow", pattern: ["pwd"] })).toThrow();
    expect(HostMethodCatalog["audit.export"].params.parse({ format: "csv" })).toEqual({ format: "csv" });
    expect(HostMethodCatalog["policy.sync"].result.parse({
      status: { state: "active", path: "https://api.example.test/policy.json", organization: { id: "acme", name: "Acme" }, version: 1, keyId: "acme-2026", issuedAt: "2026-07-10T00:00:00.000Z", expiresAt: null, error: null, locks: ["models"] },
      bundle: null,
      provenance: { source: "platform", url: "https://api.example.test/policy.json", fetchedAt: "2026-07-10T00:00:00.000Z", verifiedAt: "2026-07-10T00:00:00.000Z", bundleHash: "abc" },
    })).toMatchObject({ status: { state: "active" }, provenance: { source: "platform" } });
    expect(Object.keys(HostMethodCatalog)).toEqual(expect.arrayContaining([
      "permission.grant.list",
      "permission.grant.revoke",
      "policy.rule.list",
      "policy.rule.create",
      "policy.rule.update",
      "policy.rule.delete",
      "policy.sync",
      "audit.list",
      "audit.export",
    ]));
  });

  it("validates support bundle and crash-report contracts", () => {
    expect(HostMethodCatalog["support.issueReport.create"].params.parse({ path: "/tmp/report.json" })).toMatchObject({
      path: "/tmp/report.json",
    });
    expect(HostMethodCatalog["support.issueReport.create"].result.parse({
      path: "/tmp/report.json",
      issueBodyPath: "/tmp/report.json.github-issue.md",
      configHash: "abc",
      logCount: 2,
      usageEventCount: 1,
      crashReportCount: 1,
      telemetryEnabled: true,
      schemaVersion: 1,
    })).toMatchObject({ schemaVersion: 1, telemetryEnabled: true });
    expect(HostMethodCatalog["support.crashReport.record"].result.parse({
      recorded: false,
      id: null,
      reason: "telemetry disabled by policy or settings",
    })).toMatchObject({ recorded: false });
    expect(Object.keys(HostMethodCatalog)).toEqual(expect.arrayContaining([
      "support.issueReport.create",
      "support.crashReport.record",
    ]));
  });
});

describe("TerminalSessionSchema", () => {
  it("accepts lifecycle statuses written by the host terminal service", () => {
    const base = {
      id: "term_1",
      workspaceId: "ws_1",
      cwd: "/tmp",
      shell: "bash",
      cols: 120,
      rows: 32,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    };
    expect(TerminalSessionSchema.parse({ ...base, status: "killed" })).toMatchObject({ status: "killed" });
    expect(TerminalSessionSchema.parse({ ...base, status: "lost" })).toMatchObject({ status: "lost" });
  });
});
describe("shared slash commands", () => {
  it("omits the removed mode command and parses command arguments", () => {
    const commands = builtInCommandManifests("2026-07-20T00:00:00.000Z", "web");
    expect(commands.map((command) => command.name)).toContain("compact");
    expect(commands.map((command) => command.name)).toContain("image");
    expect(commands.map((command) => command.name)).not.toContain("mode");
    expect(parseSlashCommand(" /goal ship the web shell ")).toEqual({ name: "goal", args: ["ship", "the", "web", "shell"] });
  });
});

describe("ArchivedChatsSearchSchema", () => {
  it("defaults archive filters and rejects unsupported states", () => {
    expect(ArchivedChatsSearchSchema.parse({})).toEqual({ kind: "all", workspace: "all", state: "archived" });
    expect(ArchivedChatsSearchSchema.parse({ q: "release", kind: "code", workspace: "workspace_1", state: "deleted" })).toMatchObject({ q: "release", kind: "code", state: "deleted" });
    expect(() => ArchivedChatsSearchSchema.parse({ state: "active" })).toThrow();
  });
});
