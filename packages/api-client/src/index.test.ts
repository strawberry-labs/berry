import { describe, expect, it, vi } from "vitest";
import type { ManagedPolicyBundle } from "@berry/shared";
import { BerryApiClient, BerryApiError } from "./index.ts";

describe("BerryApiClient", () => {
  it("calls browser-style fetch implementations without a class receiver", async () => {
    let receiver: unknown = "not-called";
    const fetchImpl = async function(this: unknown) {
      receiver = this;
      return json([]);
    };
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.listTasks();

    expect(receiver).toBeUndefined();
  });

  it("decodes legacy task list mode fields through the shared compatibility schema", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      {
        id: "task_1",
        workspaceId: "workspace_1",
        title: "Cloud task",
        status: "running",
        activeSessionId: "session_1",
        uiMode: "chat",
        uiModePinned: false,
        uiModeSource: "classifier",
        pinned: false,
        archived: false,
        deletedAt: null,
        unreadAt: null,
        lastReadAt: null,
        worktreePath: null,
        worktreeBranch: null,
        worktreeBaseRef: null,
        worktreeBaseSha: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
    ]), { headers: { "content-type": "application/json" } }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test/", fetchImpl: fetchImpl as unknown as typeof fetch });

    const tasks = await client.listTasks({ workspaceId: "workspace_1" });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Cloud task");
    expect(tasks[0]?.conversationKind).toBe("chat");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.berry.test/v1/tasks?workspaceId=workspace_1", expect.objectContaining({ method: "GET" }));
  });

  it("sends explicit kind targets and stable task-list pagination", async () => {
    const createdAt = "2026-07-20T00:00:00.000Z";
    const task = {
      id: "task_1", workspaceId: "general_1", title: "General code", status: "queued", activeSessionId: "session_1",
      conversationKind: "code", pinned: false, archived: false,
      deletedAt: null, unreadAt: null, lastReadAt: null, worktreePath: null, worktreeBranch: null, worktreeBaseRef: null,
      worktreeBaseSha: null, pullRequestUrl: null, pullRequestNumber: null, createdAt, updatedAt: createdAt,
    };
    const session = { id: "session_1", taskId: "task_1", parentSessionId: null, status: "active", modelProviderId: null, model: null, permissionMode: "ask", createdAt, updatedAt: createdAt };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/v1/tasks?") ? json([task]) : json({ task, session }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.createTask({ workspaceKind: "general", conversationKind: "code", title: "General code" });
    await client.listTasks({ workspaceKind: "general", limit: 6, offset: 0 });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.berry.test/v1/tasks", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ workspaceKind: "general", conversationKind: "code", title: "General code" }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.berry.test/v1/tasks?workspaceKind=general&limit=6&offset=0", expect.objectContaining({ method: "GET" }));
  });

  it("persists task title updates", async () => {
    const task = {
      id: "task_1",
      workspaceId: "workspace_1",
      title: "Persistent title",
      status: "running",
      activeSessionId: "session_1",
      conversationKind: "chat",
      pinned: false,
      archived: false,
      deletedAt: null,
      unreadAt: null,
      lastReadAt: null,
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
      worktreeBaseSha: null,
      pullRequestUrl: null,
      pullRequestNumber: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:01.000Z",
    };
    const fetchImpl = vi.fn(async () => json(task));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.updateTask("task_1", { title: "Persistent title" })).resolves.toMatchObject({ title: "Persistent title" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.berry.test/v1/tasks/task_1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ title: "Persistent title" }),
    }));
  });

  it("cancels an active session turn", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.cancelTurn("session_1")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.berry.test/v1/sessions/session_1/cancel", expect.objectContaining({ method: "POST" }));
  });

  it("reads replayable per-session turn state", async () => {
    const fetchImpl = vi.fn(async () => json({
      active: true,
      turnId: "turn_1",
      bufferedEvents: [{ kind: "turn.start", turnId: "turn_1" }],
      replayOnly: false,
      owner: null,
    }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.turnState("session_1")).resolves.toMatchObject({ active: true, turnId: "turn_1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.berry.test/v1/sessions/session_1/turn-state", expect.objectContaining({ method: "GET" }));
  });

  it("queues steering input for an active turn", async () => {
    const fetchImpl = vi.fn(async () => json({ queued: true }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.steerTurn("session_1", { input: "Use the existing component" })).resolves.toEqual({ queued: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.berry.test/v1/sessions/session_1/steer", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ input: "Use the existing component" }),
    }));
  });

  it("redacts fetch mechanics behind structured API errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listMessages("session_1")).rejects.toMatchObject({
      name: "BerryApiError",
      status: 401,
      body: { message: "nope" },
    } satisfies Partial<BerryApiError>);
  });

  it("validates enterprise org and SSO responses through shared schemas", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/orgs?host=berry.example.test")) {
        return json([{
          id: "00000000-0000-7000-8000-000000000001",
          slug: "acme",
          name: "Acme",
          deploymentMode: "dedicated",
          plan: "enterprise",
          status: "active",
          role: "admin",
          hostname: "berry.example.test",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        }]);
      }
      if (url.includes("/sso/start?")) {
        return json({
          connectionId: "sso_1",
          kind: "oidc",
          redirectUrl: "https://idp.example.test/authorize?client_id=berry",
          state: "berry_state",
        });
      }
      return json([]);
    });
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    const orgs = await client.listOrganizations("berry.example.test");
    const start = await client.startSso(orgs[0]!.id, "okta", "https://berry.example.test/callback");

    expect(orgs[0]?.deploymentMode).toBe("dedicated");
    expect(start.kind).toBe("oidc");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.berry.test/v1/orgs/00000000-0000-7000-8000-000000000001/sso/start?connection=okta&redirectUri=https%3A%2F%2Fberry.example.test%2Fcallback",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("validates RBAC, feature flags, and ACL responses through shared schemas", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/permissions/me")) {
        return json({
          tenantId: "tenant_1",
          userId: "user_1",
          role: "owner",
          permissions: ["org:read", "rbac:write", "policy:write"],
          featureFlags: [{
            tenantId: "tenant_1",
            flag: "enterprise-governance",
            enabled: true,
            roleDefaults: { owner: ["policy:write"] },
            updatedAt: "2026-07-10T00:00:00.000Z",
          }],
        });
      }
      if (url.endsWith("/roles/member/permissions")) {
        return json({ tenantId: "tenant_1", role: "member", permissions: ["org:read", "models:read"], source: "fixture", updatedAt: "2026-07-10T00:00:00.000Z" });
      }
      if (url.includes("/feature-flags/agent-browser")) {
        return json({ tenantId: "tenant_1", flag: "agent-browser", enabled: true, roleDefaults: { member: ["models:read"] }, updatedAt: "2026-07-10T00:00:00.000Z" });
      }
      if (url.includes("/acls?")) {
        return json([{
          id: "acl_1",
          tenantId: "tenant_1",
          resourceType: "workspace",
          resourceId: "default",
          principalType: "role",
          principalId: "member",
          allow: ["departments:read"],
          deny: ["sso:write"],
          updatedAt: "2026-07-10T00:00:00.000Z",
        }]);
      }
      if (url.endsWith("/budgets/limits")) {
        return json({
          id: "budget_1",
          tenantId: "tenant_1",
          scopeType: "org",
          scopeId: "tenant_1",
          period: "month",
          softLimitMicros: "8000000000",
          hardLimitMicros: "10000000000",
          status: "active",
          updatedAt: "2026-07-10T00:00:00.000Z",
        });
      }
      if (url.endsWith("/usage/events")) {
        if (requestInit?.method === "POST") return json(usageEvent());
        return json([usageEvent()]);
      }
      if (url.includes("/usage/events?")) {
        return json([usageEvent()]);
      }
      if (url.endsWith("/usage/rollups")) {
        return json([usageRollup()]);
      }
      if (url.includes("/usage/dashboard?")) {
        return json(usageDashboard());
      }
      if (url.endsWith("/usage/export.csv")) {
        return new Response("ts,source,request_id\n2026-07-10T00:00:00.000Z,router,usage_req_1\n", { headers: { "content-type": "text/csv" } });
      }
      if (url.endsWith("/billing")) {
        return json(billingSummary());
      }
      if (url.endsWith("/billing/credits")) {
        return json(billingGrant());
      }
      if (url.endsWith("/billing/meter-events")) {
        return json(billingMeterEvent());
      }
      if (url.endsWith("/billing/invoices")) {
        return json([billingInvoice()]);
      }
      if (url.endsWith("/approvals")) {
        return json([approvalRequest()]);
      }
      if (url.endsWith("/devices")) {
        if (requestInit?.method === "POST") return json(mobileDevice());
        return json([mobileDevice()]);
      }
      if (url.endsWith("/devices/device_reg_1")) {
        return json({ ok: true });
      }
      if (url.includes("/models?")) {
        return json([modelPolicy()]);
      }
      if (url.endsWith("/models/policies")) {
        return json(modelPolicy());
      }
      if (url.endsWith("/models/defaults")) {
        return json([modelDefault()]);
      }
      if (url.endsWith("/models/defaults/code")) {
        return json(modelDefault());
      }
      if (url.endsWith("/models/resolve")) {
        return json(modelDecision());
      }
      if (url.endsWith("/policy/versions")) {
        return json([policyVersion()]);
      }
      if (url.endsWith("/policy/berry-policy.json")) {
        return json(policyBundle());
      }
      if (url.endsWith("/policy")) {
        return json(policyVersion());
      }
      if (url.endsWith("/audit/settings")) {
        return json({ tenantId: "tenant_1", retentionDays: 180, clientIngestEnabled: true, updatedBy: "user_1", updatedAt: "2026-07-10T00:00:00.000Z" });
      }
      if (url.endsWith("/audit/events")) {
        if (requestInit?.method === "POST") return json([auditEvent({ category: "approval", action: "approval-denied", targetType: "tool_call", targetId: "tool_1" })]);
        return json([auditEvent()]);
      }
      if (url.includes("/audit/events?")) {
        return json([auditEvent()]);
      }
      if (url.endsWith("/audit/exports")) {
        return json(auditExportConfig());
      }
      return json([]);
    });
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });

    const effective = await client.effectivePermissions("tenant_1");
    const role = await client.updateRolePermissions("tenant_1", "member", { permissions: ["org:read", "models:read"], source: "fixture" });
    const flag = await client.upsertFeatureFlag("tenant_1", "agent-browser", { enabled: true, roleDefaults: { member: ["models:read"] } });
    const acls = await client.listResourceAcls("tenant_1", { resourceType: "workspace", resourceId: "default" });
    const budget = await client.upsertBudgetLimit("tenant_1", {
      scopeType: "org",
      scopeId: "tenant_1",
      period: "month",
      softLimitMicros: "8000000000",
      hardLimitMicros: "10000000000",
      status: "active",
    });
    const usage = await client.ingestUsageEvent("tenant_1", usageIngest());
    const events = await client.listUsageEvents("tenant_1", { feature: "model.turn" });
    const rollups = await client.listUsageRollups("tenant_1");
    const dashboard = await client.usageDashboard("tenant_1", { model: "berry/auto" });
    const csv = await client.exportUsageCsv("tenant_1");
    const billing = await client.billingSummary("tenant_1");
    const creditGrant = await client.createBillingCreditGrant("tenant_1", { source: "manual", amountMicros: "25000000000", reason: "Approved fixture grant", confirmation: true, idempotencyKey: "fixture-grant-1", metadata: { note: "fixture" } });
    const meterEvent = await client.reportBillingMeterEvent("tenant_1", { requestId: "usage_req_1", meter: "model_tokens", quantity: "384", costBilledMicros: "1200000" });
    const invoices = await client.listBillingInvoices("tenant_1");
    const approvals = await client.listApprovals();
    const mobileDeviceRegistration = await client.registerMobileDevice({
      deviceId: "ios-device-1",
      platform: "ios",
      pushProvider: "apns",
      pushToken: "secret-token-1234",
      endpointMode: "berry-account",
      appVersion: "0.1.0",
      capabilities: ["approvals", "chat", "tasks", "push"],
    });
    const mobileDevices = await client.listMobileDevices();
    const deletedMobileDevice = await client.deleteMobileDevice("device_reg_1");
    const models = await client.listOrgModels("tenant_1", { mode: "code", includeBlocked: true });
    const policy = await client.upsertOrgModelPolicy("tenant_1", {
      providerId: "router",
      model: "gpt-5",
      apiType: "openai-responses",
      capabilities: { tools: true, reasoning: true },
      enforce: true,
      modeAllow: ["code"],
    });
    const defaults = await client.listOrgModelDefaults("tenant_1");
    const modelDefaultResult = await client.upsertOrgModelDefault("tenant_1", "code", { providerId: "router", model: "gpt-5", enforce: true });
    const decision = await client.resolveOrgModel("tenant_1", { mode: "code", providerId: "router", model: "gpt-5" });
    const policyVersions = await client.listPolicyVersions("tenant_1");
    const activePolicy = await client.activePolicyVersion("tenant_1");
    const activeBundle = await client.activePolicyBundle("tenant_1");
    const publishedPolicy = await client.publishManagedPolicy("tenant_1", {
      organization: { id: "tenant_1", name: "Tenant 1" },
      policy: policyBundle().policy,
      note: "fixture",
    });
    const auditSettings = await client.updateAuditSettings("tenant_1", { retentionDays: 180, clientIngestEnabled: true });
    const ingestedAudit = await client.ingestAuditEvents("tenant_1", auditIngest());
    const auditEvents = await client.listAuditEvents("tenant_1", { category: "policy", limit: 25 });
    const auditExport = await client.upsertAuditExportConfig("tenant_1", { kind: "webhook", destination: "https://siem.example.test/audit", format: "json" });

    expect(effective.permissions).toContain("policy:write");
    expect(role.permissions).toContain("models:read");
    expect(flag.roleDefaults.member).toContain("models:read");
    expect(acls[0]?.deny).toContain("sso:write");
    expect(budget.hardLimitMicros).toBe("10000000000");
    expect(usage.source).toBe("router");
    expect(events[0]?.feature).toBe("model.turn");
    expect(rollups[0]?.requestCount).toBe(1);
    expect(dashboard.byFeature[0]?.tokens).toBe(384);
    expect(csv).toContain("usage_req_1");
    expect(billing.provider).toBe("stripe");
    expect(creditGrant.remainingMicros).toBe("25000000000");
    expect(meterEvent.status).toBe("reported");
    expect(invoices[0]?.externalInvoiceId).toBe("in_test_1");
    expect(approvals[0]?.id).toBe("approval_1");
    expect(mobileDeviceRegistration.pushTokenLast4).toBe("1234");
    expect(mobileDevices[0]?.endpointMode).toBe("berry-account");
    expect(deletedMobileDevice.ok).toBe(true);
    expect(models[0]?.model).toBe("gpt-5");
    expect(policy.enforce).toBe(true);
    expect(defaults[0]?.mode).toBe("code");
    expect(modelDefaultResult.model).toBe("gpt-5");
    expect(decision.allowed).toBe(true);
    expect(policyVersions[0]?.bundle.policy.sandboxFloor).toBe("workspace-write");
    expect(activePolicy?.keyId).toBe("policy-key-1");
    expect(activeBundle?.signature.algorithm).toBe("ed25519");
    expect(publishedPolicy.bundleHash).toBe("abc123");
    expect(auditSettings.retentionDays).toBe(180);
    expect(ingestedAudit[0]?.action).toBe("approval-denied");
    expect(auditEvents[0]?.category).toBe("policy");
    expect(auditExport.destination).toBe("https://siem.example.test/audit");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.berry.test/v1/orgs/tenant_1/acls?resourceType=workspace&resourceId=default",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("serializes analytics filters and validates redacted request responses", async () => {
    const analytics = {
      tenantId: "tenant_1", from: "2026-07-01T00:00:00.000Z", to: "2026-07-11T00:00:00.000Z",
      totals: { billedCostMicros: "1200", requests: 1, tokens: 30, successRate: 1, projectedMonthEndMicros: "3720" },
      series: [{ ts: "2026-07-10T00:00:00.000Z", billedCostMicros: "1200", requests: 1, tokens: 30, successes: 1, failures: 0 }],
      breakdowns: {}, performance: { latencyP50Ms: 100, latencyP95Ms: 100, ttftP50Ms: 20, ttftP95Ms: 20, cachedTokens: 0, sandboxMinutes: 0 },
      anomalies: [], unavailableDimensions: [],
    };
    const summary = {
      id: "event_1", requestId: "usage_…0001", ts: "2026-07-10T00:00:00.000Z", userId: "user_1", departmentId: null,
      workspaceId: "workspace_1", agentId: "agent_1", feature: "model.turn", provider: "router", model: "berry/auto", status: "completed",
      tokensIn: 10, tokensOut: 20, tokensCached: 0, billedCostMicros: "1200", latencyMs: 100, ttftMs: 20, reservationStatus: "reconciled",
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/usage/me/export.csv?")) return new Response("request_id,user_id\nrequest_1,user_1\n", { status: 200 });
      if (url.includes("/usage/analytics?") || url.includes("/usage/me?")) return json(analytics);
      if (url.includes("/usage/requests?")) return json({ items: [summary], nextCursor: null, hasMore: false });
      if (url.endsWith("/usage/requests/event_1")) return json({ ...summary, taskId: null, sessionId: null, sandboxId: null, reservationId: null, safeMetadata: { region: "us" } });
      return json({});
    });
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const query = { from: analytics.from, to: analytics.to, departmentId: "dept 1", agentId: "agent_1", limit: 25 };
    await expect(client.usageAnalytics("tenant_1", query)).resolves.toMatchObject({ totals: { requests: 1 } });
    await expect(client.usageRequests("tenant_1", query)).resolves.toMatchObject({ hasMore: false });
    await expect(client.usageRequestDetail("tenant_1", "event_1")).resolves.toMatchObject({ safeMetadata: { region: "us" } });
    await expect(client.myUsage("tenant_1", query)).resolves.toMatchObject({ tenantId: "tenant_1" });
    await expect(client.exportMyUsageCsv("tenant_1", query)).resolves.toContain("request_1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.berry.test/v1/orgs/tenant_1/usage/analytics?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&departmentId=dept+1&agentId=agent_1&limit=25",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.berry.test/v1/orgs/tenant_1/usage/me/export.csv?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&departmentId=dept+1&agentId=agent_1&limit=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("serializes confirmed platform rollout mutations without client-owned operator fields", async () => {
    const updatedAt = "2026-07-21T00:00:00.000Z";
    const response = { id: "rule_1", feature: "new-admin", status: "gradual", exposurePercent: 10, target: { channel: "stable" }, exclusions: [], errorRateRollbackPercent: 5, ownerUserId: "operator_1", updatedAt };
    const fetchImpl = vi.fn(async () => json(response));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const input = { feature: "new-admin", status: "gradual" as const, exposurePercent: 10, target: { channel: "stable" }, exclusions: [], errorRateRollbackPercent: 5, auditNote: "Gradual production validation", confirmation: true as const, idempotencyKey: "rollout-001" };
    await expect(client.upsertPlatformRollout(input)).resolves.toMatchObject({ ownerUserId: "operator_1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.berry.test/v1/platform/rollouts", expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
  });

  it("uploads files as direct multipart object-storage requests without embedding bytes in API JSON", async () => {
    const fileId = "00000000-0000-7000-8000-000000000101";
    const uploadId = "00000000-0000-7000-8000-000000000102";
    const taskId = "00000000-0000-7000-8000-000000000103";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/files/uploads")) return json({ fileId, uploadId, partSize: 3, partCount: 2, expiresAt: "2026-07-22T10:00:00.000Z" });
      if (url.endsWith(`/v1/files/${fileId}/uploads/${uploadId}/parts`)) {
        return json({ parts: [{ partNumber: 1, url: "https://files.berry.test/part-1" }, { partNumber: 2, url: "https://files.berry.test/part-2" }] });
      }
      if (url.startsWith("https://files.berry.test/part-")) {
        const part = url.endsWith("1") ? "1" : "2";
        return new Response(null, { status: 200, headers: { etag: `\"etag-${part}\"` } });
      }
      if (url.endsWith(`/v1/files/${fileId}/uploads/${uploadId}/complete`)) {
        return json({
          id: fileId, name: "report.pdf", originalName: "report.pdf", mediaType: "application/pdf", detectedMediaType: null,
          size: 6, sha256: null, origin: "user_upload", status: "available", createdAt: "2026-07-22T09:00:00.000Z",
          updatedAt: "2026-07-22T09:00:01.000Z", taskIds: [taskId], roles: ["input"],
          downloadUrl: `/v1/files/${fileId}/content?download=1`, previewUrl: `/v1/files/${fileId}/content`,
        });
      }
      if (init?.method === "DELETE") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], "report.pdf", { type: "application/pdf" });
    const progress: number[] = [];

    await expect(client.uploadFile(file, { taskId, concurrency: 2, onProgress: ({ uploadedBytes }) => progress.push(uploadedBytes) })).resolves.toMatchObject({ id: fileId, size: 6 });

    const initiate = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/v1/files/uploads"));
    expect(initiate?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "report.pdf", mediaType: "application/pdf", size: 6, taskId }) });
    const partPuts = fetchImpl.mock.calls.filter(([url]) => String(url).startsWith("https://files.berry.test/part-"));
    expect(partPuts).toHaveLength(2);
    expect(partPuts.every(([, init]) => init?.body instanceof Blob)).toBe(true);
    expect(Math.max(...progress)).toBe(6);
    expect(JSON.stringify(fetchImpl.mock.calls.filter(([url]) => String(url).startsWith("https://api.berry.test")))).not.toContain("data:");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function auditIngest() {
  return {
    source: "desktop" as const,
    events: [{
      category: "approval",
      action: "approval-denied",
      targetType: "tool_call",
      targetId: "tool_1",
      metadata: { reason: "fixture" },
      ts: "2026-07-10T00:00:00.000Z",
    }],
  };
}

function auditEvent(overrides: Partial<{ category: string; action: string; targetType: string; targetId: string }> = {}) {
  return {
    id: "audit_1",
    tenantId: "tenant_1",
    sequence: 1,
    actorUserId: "user_1",
    category: overrides.category ?? "policy",
    action: overrides.action ?? "published",
    targetType: overrides.targetType ?? "policy_version",
    targetId: overrides.targetId ?? "1",
    workspaceId: null,
    taskId: null,
    sessionId: null,
    before: null,
    after: null,
    metadata: {},
    previousHash: "0".repeat(64),
    eventHash: "a".repeat(64),
    ts: "2026-07-10T00:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function auditExportConfig() {
  return {
    id: "audit_export_1",
    tenantId: "tenant_1",
    kind: "webhook",
    status: "enabled",
    destination: "https://siem.example.test/audit",
    format: "json",
    config: {},
    lastExportedAt: null,
    updatedBy: "user_1",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function usageIngest() {
  return {
    source: "router",
    event: { request_id: "usage_req_1", provider: "router", model: "berry/auto" },
    signature: {
      algorithm: "hmac-sha256",
      keyId: "fixture",
      signedAt: "2026-07-10T00:00:00.000Z",
      signature: "fixture-signature",
    },
    normalized: {
      requestId: "usage_req_1",
      userId: "user_1",
      departmentId: "dept_1",
      feature: "model.turn",
      provider: "router",
      model: "berry/auto",
      tokensIn: 128,
      tokensOut: 256,
      tokensCached: 0,
      sandboxUsage: {},
      costRawMicros: "1200",
      costBilledMicros: "1500",
      status: "completed",
      metadata: {},
      ts: "2026-07-10T00:00:00.000Z",
    },
  } as const;
}

function usageEvent() {
  return {
    id: "usage_1",
    tenantId: "tenant_1",
    requestId: "usage_req_1",
    source: "router",
    userId: "user_1",
    departmentId: "dept_1",
    workspaceId: null,
    taskId: null,
    sessionId: null,
    toolCallId: null,
    feature: "model.turn",
    provider: "router",
    model: "berry/auto",
    tokensIn: 128,
    tokensOut: 256,
    tokensCached: 0,
    sandboxUsage: {},
    costRawMicros: "1200",
    costBilledMicros: "1500",
    latencyMs: null,
    ttftMs: null,
    status: "completed",
    metadata: {},
    signedPayload: usageIngest().event,
    signature: usageIngest().signature,
    ts: "2026-07-10T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function usageRollup() {
  return {
    tenantId: "tenant_1",
    bucketStart: "2026-07-10T00:00:00.000Z",
    bucketEnd: "2026-07-11T00:00:00.000Z",
    granularity: "day",
    feature: "model.turn",
    provider: "router",
    model: "berry/auto",
    status: "completed",
    requestCount: 1,
    tokensIn: 128,
    tokensOut: 256,
    tokensCached: 0,
    costRawMicros: "1200",
    costBilledMicros: "1500",
  };
}

function usageDashboard() {
  return {
    tenantId: "tenant_1",
    from: "2026-07-10T00:00:00.000Z",
    to: "2026-07-11T00:00:00.000Z",
    totals: { requests: 1, tokensIn: 128, tokensOut: 256, costBilledMicros: "1500" },
    byFeature: [{ feature: "model.turn", requests: 1, costBilledMicros: "1500", tokens: 384 }],
    byModel: [{ model: "berry/auto", requests: 1, costBilledMicros: "1500", tokens: 384 }],
    byUser: [{ userId: "user_1", requests: 1, costBilledMicros: "1500", tokens: 384 }],
    byDepartment: [{ departmentId: "dept_1", requests: 1, costBilledMicros: "1500", tokens: 384 }],
    burnDown: [{ date: "2026-07-10", costBilledMicros: "1500", requests: 1 }],
  };
}

function billingSummary() {
  return {
    tenantId: "tenant_1",
    provider: "stripe",
    providerConfigured: true,
    billingDependencyRequired: true,
    prepaidBalanceMicros: "25000000000",
    currency: "usd",
    activeGrants: [billingGrant()],
    recentMeterEvents: [billingMeterEvent()],
    invoices: [billingInvoice()],
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function approvalRequest() {
  return {
    id: "approval_1",
    taskId: "task_1",
    toolCallId: "tool_1",
    kind: "shell",
    status: "pending",
    request: { title: "Run command", detail: "pnpm test" },
    createdAt: "2026-07-10T00:00:00.000Z",
    decidedAt: null,
  };
}

function billingGrant() {
  return {
    id: "grant_1",
    tenantId: "tenant_1",
    source: "manual",
    amountMicros: "25000000000",
    remainingMicros: "25000000000",
    currency: "usd",
    externalRef: null,
    status: "active",
    metadata: { note: "fixture" },
    createdBy: "user_1",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function billingMeterEvent() {
  return {
    id: "meter_event_1",
    tenantId: "tenant_1",
    usageEventId: null,
    requestId: "usage_req_1",
    meter: "model_tokens",
    quantity: "384",
    costBilledMicros: "1200000",
    provider: "stripe",
    externalEventId: "mtr_evt_test_1",
    status: "reported",
    reportedAt: "2026-07-10T00:00:00.000Z",
    metadata: { stripeStatus: 200 },
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function billingInvoice() {
  return {
    id: "invoice_1",
    tenantId: "tenant_1",
    provider: "stripe",
    externalInvoiceId: "in_test_1",
    status: "open",
    totalMicros: "1200000",
    currency: "usd",
    hostedInvoiceUrl: "https://billing.stripe.com/test/in_test_1",
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-07-31T23:59:59.000Z",
    metadata: {},
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function mobileDevice() {
  return {
    id: "device_reg_1",
    tenantId: "tenant_1",
    userId: "user_1",
    deviceId: "ios-device-1",
    platform: "ios",
    pushProvider: "apns",
    pushTokenLast4: "1234",
    endpointMode: "berry-account",
    appVersion: "0.1.0",
    capabilities: ["approvals", "chat", "tasks", "push"],
    status: "active",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    lastSeenAt: "2026-07-11T00:00:00.000Z",
  };
}

function modelPolicy() {
  return {
    id: "model_policy_1",
    tenantId: "tenant_1",
    providerId: "router",
    model: "gpt-5",
    displayName: "GPT-5",
    presetId: "berry-router",
    apiType: "openai-responses",
    capabilities: { tools: true, reasoning: true },
    status: "allowed",
    enforce: true,
    modeAllow: ["code"],
    metadata: {},
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function modelDefault() {
  return {
    tenantId: "tenant_1",
    mode: "code",
    providerId: "router",
    model: "gpt-5",
    enforce: true,
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function modelDecision() {
  return {
    tenantId: "tenant_1",
    mode: "code",
    requestedProviderId: "router",
    requestedModel: "gpt-5",
    providerId: "router",
    model: "gpt-5",
    allowed: true,
    enforced: true,
    reason: "allowed_by_policy",
    policy: modelPolicy(),
    default: modelDefault(),
  };
}

function policyBundle(): ManagedPolicyBundle {
  return {
    version: 1,
    organization: { id: "tenant_1", name: "Tenant 1" },
    issuedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: null,
    policy: {
      execpolicy: [{ id: "block-kubectl-delete", kind: "regex-lite", decision: "forbid", pattern: String.raw`kubectl\s+delete`, description: "No destructive cluster changes" }],
      modelAllowlist: ["router:gpt-5"],
      mcpAllowlist: ["github"],
      pluginAllowlist: ["openai-bundled/browser"],
      sandboxFloor: "workspace-write",
      telemetry: "required",
    },
    signature: { algorithm: "ed25519", keyId: "policy-key-1", value: "fixture-signature" },
  };
}

function policyVersion() {
  return {
    id: "policy_version_1",
    tenantId: "tenant_1",
    version: 1,
    status: "active",
    bundle: policyBundle(),
    bundlePath: "/v1/orgs/tenant_1/policy/berry-policy.json",
    bundleHash: "abc123",
    keyId: "policy-key-1",
    publishedBy: "user_1",
    publishedAt: "2026-07-10T00:00:00.000Z",
    revokedAt: null,
    auditEventId: "audit_1",
    note: "fixture",
  };
}
