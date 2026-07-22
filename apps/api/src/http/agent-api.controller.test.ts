import "reflect-metadata";
import { UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { AgentStreamEvent } from "@berry/shared";
import type { SessionHost, StartTurnOptions } from "@berry/local-agent";
import request from "supertest";
import { firstValueFrom, take } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiModule } from "./agent-api.module.ts";
import { InMemoryCloudTaskStore, type CloudTaskStore } from "./cloud-task-store.ts";
import { ApiEventStreamService } from "./event-stream.service.ts";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { BudgetService, InMemoryBudgetHotCounters, InMemoryBudgetRepository } from "../budget/budget.service.ts";
import { InMemoryModelGovernanceRepository, ModelGovernanceService } from "../model-governance/model-governance.service.ts";
import { USAGE_REPOSITORY, type UsageRepository } from "../usage/usage.repository.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";

describe("AgentApiController", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("serves task, session, and message CRUD over HTTP", async () => {
    app = await createApp(fakeSessionHost());
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Cloud task", permissionMode: "ask" })
      .expect(201);

    expect(created.body.task).toMatchObject({ workspaceId: "workspace_cloud", title: "Cloud task", activeSessionId: created.body.session.id, status: "queued" });
    await request(app.getHttpServer()).get("/v1/tasks?workspaceId=workspace_cloud").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(created.body.task.id);
    });
    await request(app.getHttpServer()).patch(`/v1/tasks/${created.body.task.id}`).set(authHeader()).send({ title: "Renamed", pinned: true, conversationKind: "code" }).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ title: "Renamed", pinned: true, conversationKind: "code" });
    });
    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/messages`).set(authHeader()).send({
      role: "user",
      parts: [{ kind: "text", content: "hello" }],
    }).expect(201);
    await request(app.getHttpServer()).get(`/v1/sessions/${created.body.session.id}/messages`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body[0]).toMatchObject({ role: "user", parts: [expect.objectContaining({ kind: "text", content: "hello" })] });
    });
    await request(app.getHttpServer()).delete(`/v1/tasks/${created.body.task.id}`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.deletedAt).toEqual(expect.any(String));
    });
    await request(app.getHttpServer()).post(`/v1/tasks/${created.body.task.id}/restore`).set(authHeader()).expect(201).expect(({ body }) => {
      expect(body.deletedAt).toBeNull();
      expect(body.title).toBe("Renamed");
    });
  });

  it("isolates General chats by user and publishes one canonical kind update", async () => {
    app = await createApp(fakeSessionHost());
    const first = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceKind: "general", conversationKind: "chat", title: "Private chat", permissionMode: "plan" })
      .expect(201);
    const taskId = first.body.task.id as string;
    const sessionId = first.body.session.id as string;
    const workspaceId = first.body.task.workspaceId as string;

    await request(app.getHttpServer()).get("/v1/workspaces").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).not.toContainEqual(expect.objectContaining({ id: workspaceId }));
    });
    await request(app.getHttpServer()).get("/v1/workspaces?includeGeneral=true").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toContainEqual(expect.objectContaining({ id: workspaceId, workspaceKind: "general", ownerUserId: "user_1" }));
    });
    await request(app.getHttpServer()).get("/v1/tasks?workspaceKind=general&limit=1&offset=0").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toEqual([expect.objectContaining({ id: taskId, conversationKind: "chat" })]);
    });

    const eventStream = app.get(ApiEventStreamService);
    const updatedEvent = firstValueFrom(eventStream.taskStream(taskId).pipe(take(1)));
    await request(app.getHttpServer())
      .patch(`/v1/tasks/${taskId}`)
      .set(authHeader())
      .send({ conversationKind: "code" })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ id: taskId, workspaceId, activeSessionId: sessionId, conversationKind: "code" });
      });
    await expect(updatedEvent).resolves.toMatchObject({ data: { type: "task.updated", task: { id: taskId, conversationKind: "code" } } });
    expect(first.body.session).toMatchObject({ id: sessionId, permissionMode: "plan" });

    await request(app.getHttpServer()).get("/v1/tasks?workspaceKind=general").set(authHeader("berry-other-session")).expect(200).expect([]);
    await request(app.getHttpServer()).patch(`/v1/tasks/${taskId}`).set(authHeader("berry-other-session")).send({ conversationKind: "chat" }).expect(404);
    const other = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader("berry-other-session"))
      .send({ workspaceKind: "general", title: "Other chat" })
      .expect(201);
    expect(other.body.task.workspaceId).not.toBe(workspaceId);
  });

  it("starts turns through SessionHost and publishes shared stream events", async () => {
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onEvent({ kind: "turn.start", turnId: "turn_http_1" });
      options.onEvent({ kind: "turn.end", turnId: "turn_http_1", status: "completed" });
      return { turnId: "turn_http_1" };
    });
    app = await createApp(fakeSessionHost({ startTurn }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Turn task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201).expect(({ body }) => {
      expect(body).toEqual({ turnId: "turn_http_1", sessionId: created.body.session.id });
    });

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: created.body.session.id,
      taskId: created.body.task.id,
      workspaceId: "workspace_cloud",
      input: "run",
      permissionMode: "ask",
    }));
    await request(app.getHttpServer()).get("/v1/tasks").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body[0]).toMatchObject({ id: created.body.task.id, status: "completed" });
    });
  });

  it("cancels an active session turn through SessionHost", async () => {
    const cancel = vi.fn(async () => true);
    app = await createApp(fakeSessionHost({ cancel }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Cancel task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/cancel`).set(authHeader()).expect(201).expect({ ok: true });
    expect(cancel).toHaveBeenCalledWith(created.body.session.id);
  });

  it("queues steering input while a session turn is active", async () => {
    const steer = vi.fn(async () => ({ queued: true as const }));
    app = await createApp(fakeSessionHost({ steer }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Steer task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/steer`).set(authHeader()).send({
      input: "Use the existing component",
      attachments: [{ id: "attachment_1", name: "very-long-project-brief.pdf", mediaType: "application/pdf", size: 151552, sourceKind: "web-upload" }],
    }).expect(201).expect({ queued: true });
    expect(steer).toHaveBeenCalledWith(created.body.session.id, "Use the existing component", [], [expect.objectContaining({ id: "attachment_1", name: "very-long-project-brief.pdf" })]);
    await request(app.getHttpServer()).get(`/v1/sessions/${created.body.session.id}/messages`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.at(-1)).toMatchObject({
        role: "user",
        parts: [
          expect.objectContaining({ kind: "text", content: "Use the existing component" }),
          expect.objectContaining({ kind: "attachment", content: expect.objectContaining({ name: "very-long-project-brief.pdf", mediaType: "application/pdf", size: 151552 }) }),
        ],
      });
    });
  });

  it("persists queued follow-ups separately from steering", async () => {
    const replaceFollowUpQueue = vi.fn(async () => undefined);
    app = await createApp(fakeSessionHost({ replaceFollowUpQueue }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Queue task" }).expect(201);
    const sessionId = created.body.session.id as string;

    const queued = await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).send({ input: "Run this next" }).expect(201);
    expect(queued.body).toMatchObject({ taskId: created.body.task.id, sessionId, ordinal: 0, input: "Run this next", status: "queued" });
    expect(replaceFollowUpQueue).toHaveBeenCalledWith(sessionId, [expect.objectContaining({ input: "Run this next" })]);
    await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toEqual([expect.objectContaining({ id: queued.body.id, status: "queued" })]);
    });
    await request(app.getHttpServer()).delete(`/v1/follow-ups/${queued.body.id}`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.status).toBe("removed");
    });
    await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).expect(200).expect([]);
  });

  it("pauses interrupted follow-ups and lets the user resume them", async () => {
    const cancel = vi.fn(async () => true);
    app = await createApp(fakeSessionHost({ cancel }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Recover queued work" }).expect(201);
    const sessionId = created.body.session.id as string;

    const queued = await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).send({ input: "Keep this for later" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/cancel`).set(authHeader()).expect(201).expect({ ok: true });
    await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toEqual([expect.objectContaining({ id: queued.body.id, status: "paused", pausedReason: "You interrupted the active run." })]);
    });

    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/follow-ups/resume`).set(authHeader()).expect(201).expect(({ body }) => {
      expect(body).toEqual([expect.objectContaining({ id: queued.body.id, status: "queued", pausedReason: null })]);
    });
  });

  it("loads later queued follow-ups when an idle queued prompt is sent now", async () => {
    const replaceFollowUpQueue = vi.fn(async () => undefined);
    app = await createApp(fakeSessionHost({ replaceFollowUpQueue }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Drain queued work" }).expect(201);
    const sessionId = created.body.session.id as string;
    const first = await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).send({ input: "First queued prompt" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).send({ input: "Second queued prompt" }).expect(201);
    await request(app.getHttpServer()).patch(`/v1/follow-ups/${first.body.id}`).set(authHeader()).send({ status: "sending" }).expect(200);
    replaceFollowUpQueue.mockClear();

    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/turns`).set(authHeader()).send({
      input: "First queued prompt",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
      drainQueuedFollowUps: true,
    }).expect(201);

    expect(replaceFollowUpQueue).toHaveBeenCalledWith(sessionId, [expect.objectContaining({ input: "Second queued prompt" })]);
  });

  it("owns a bounded browser-safe sandbox workspace per task", async () => {
    app = await createApp(fakeSessionHost());
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Code workspace", conversationKind: "code", permissionMode: "ask" }).expect(201);
    const taskId = created.body.task.id as string;

    const first = await request(app.getHttpServer()).post(`/v1/tasks/${taskId}/workspace`).set(authHeader()).send({}).expect(201);
    const second = await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace`).set(authHeader()).expect(200);
    expect(second.body.sandboxId).toBe(first.body.sandboxId);

    await request(app.getHttpServer()).put(`/v1/tasks/${taskId}/workspace/file`).set(authHeader()).send({ path: "README.md", content: "# Browser workspace" }).expect(200);
    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace/files?path=/workspace`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toContainEqual(expect.objectContaining({ path: "/workspace/README.md", type: "file" }));
    });
    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace/file?path=README.md`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.content).toBe("# Browser workspace");
    });
    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace/file?path=../secret`).set(authHeader()).expect(400);

    const terminal = await request(app.getHttpServer()).post(`/v1/tasks/${taskId}/workspace/terminals`).set(authHeader()).send({ cols: 90, rows: 30 }).expect(201);
    await request(app.getHttpServer()).post(`/v1/tasks/${taskId}/workspace/terminals/${terminal.body.id}/input`).set(authHeader()).send({ input: "pwd" }).expect(403).expect(({ body }) => {
      expect(body.code).toBe("approval_required");
    });
    await request(app.getHttpServer()).post(`/v1/tasks/${taskId}/workspace/terminals/${terminal.body.id}/input`).set(authHeader()).send({ input: "pwd", approved: true }).expect(201);
    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace/terminals/${terminal.body.id}/events`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toContainEqual(expect.objectContaining({ kind: "stdout" }));
    });
    await request(app.getHttpServer()).post(`/v1/tasks/${taskId}/workspace/previews`).set(authHeader()).send({ port: 3000, approved: true }).expect(201);

    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace`).set(authHeader("berry-other-session")).expect(404);
    await request(app.getHttpServer()).put(`/v1/tasks/${taskId}/workspace/file`).set(authHeader("berry-other-session")).send({ path: "stolen.txt", content: "no" }).expect(404);
  });

  it("manages user-scoped skills and remote MCP without returning credentials", async () => {
    const startTurn = vi.fn(() => ({ turnId: "turn_capabilities" }));
    app = await createApp(fakeSessionHost({ startTurn }));
    const skillContent = "---\nname: review-helper\ndescription: Reviews changes\n---\n# Review helper\nCheck tests.";
    const review = await request(app.getHttpServer()).post("/v1/me/skills/review").set(authHeader()).send({ name: "review-helper", description: "Reviews changes", content: skillContent, source: "text" }).expect(201);
    const skill = await request(app.getHttpServer()).post("/v1/me/skills").set(authHeader()).send({ name: "review-helper", description: "Reviews changes", content: skillContent, source: "text", confirmedHash: review.body.hash, trusted: true, enabled: true }).expect(201);
    await request(app.getHttpServer()).get("/v1/me/skills").set(authHeader()).expect(200).expect(({ body }) => expect(body).toContainEqual(expect.objectContaining({ id: skill.body.id, trusted: true })));
    await request(app.getHttpServer()).get("/v1/me/skills").set(authHeader("berry-other-session")).expect(200).expect([]);

    const mcp = await request(app.getHttpServer()).post("/v1/me/mcp").set(authHeader()).send({ name: "Remote tools", url: "https://mcp.example.test/rpc", transport: "streamable-http", auth: "bearer", credential: "super-secret", trusted: true }).expect(201);
    expect(JSON.stringify(mcp.body)).not.toContain("super-secret");
    expect(mcp.body).toMatchObject({ credentialConfigured: true, credentialRef: expect.any(String) });
    await request(app.getHttpServer()).get("/v1/me/mcp").set(authHeader("berry-other-session")).expect(200).expect([]);
    await request(app.getHttpServer()).patch(`/v1/me/mcp/${mcp.body.id}`).set(authHeader("berry-other-session")).send({ enabled: false }).expect(404);
    const task = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);
    await request(app.getHttpServer()).post(`/v1/sessions/${task.body.session.id}/turns`).set(authHeader()).send({ input: "Use my capabilities", workspacePath: "/workspace", provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" } }).expect(201);
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ extraSkills: [expect.objectContaining({ name: "review-helper" })], mcpServers: [expect.objectContaining({ id: mcp.body.id })] }));

    const oauth = await request(app.getHttpServer()).post("/v1/me/mcp").set(authHeader()).send({ name: "OAuth tools", url: "https://oauth.example.test/mcp", transport: "http-sse", auth: "oauth" }).expect(201);
    const flow = await request(app.getHttpServer()).post(`/v1/me/mcp/${oauth.body.id}/oauth/start`).set(authHeader()).send({ redirectUri: "https://berry.example.test/oauth/callback" }).expect(201);
    await request(app.getHttpServer()).post("/v1/me/mcp/oauth/complete").set(authHeader("berry-other-session")).send({ state: flow.body.state, code: "stolen" }).expect(400);
    await request(app.getHttpServer()).post("/v1/me/mcp/oauth/complete").set(authHeader()).send({ state: flow.body.state, code: "one-time-code" }).expect(201).expect(({ body }) => {
      expect(body.credentialConfigured).toBe(true);
      expect(JSON.stringify(body)).not.toContain("one-time-code");
    });
    await request(app.getHttpServer()).post("/v1/me/mcp/oauth/poll").set(authHeader()).send({ state: flow.body.state }).expect(201).expect({ status: "complete", serverId: oauth.body.id });
  });

  it("returns a structured 402 before model work when a hard budget limit is exceeded", async () => {
    const startTurn = vi.fn(() => ({ turnId: "turn_never" }));
    app = await createApp(fakeSessionHost({ startTurn }), {
      budget: new BudgetService({
        repository: new InMemoryBudgetRepository([{
          tenantId: SELF_HOST_TENANT_ID,
          scopeType: "org",
          scopeId: SELF_HOST_TENANT_ID,
          period: "month",
          softLimitMicros: "0",
          hardLimitMicros: "1",
          status: "active",
        }]),
        hotCounters: new InMemoryBudgetHotCounters(),
        enabled: true,
      }),
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Budget task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none", cost: { input: 1, output: 1 } },
    }).expect(402).expect(({ body }) => {
      expect(body).toMatchObject({ code: "budget_exceeded", check: { allowed: false } });
      expect(body.message).toContain("hard limit");
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("blocks disallowed models before budget reservation and model work", async () => {
    const startTurn = vi.fn(() => ({ turnId: "turn_never" }));
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "provider",
      model: "blocked-model",
      status: "blocked",
      enforce: true,
      modeAllow: ["chat"],
    });
    app = await createApp(fakeSessionHost({ startTurn }), {
      modelGovernance: new ModelGovernanceService(repository),
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Governed task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
      model: "blocked-model",
    }).expect(403).expect(({ body }) => {
      expect(body).toMatchObject({ code: "model_governance_blocked", decision: { reason: "model_blocked", allowed: false } });
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("reserves and reconciles successful model turns", async () => {
    const budget = new BudgetService({
      repository: new InMemoryBudgetRepository([{
        tenantId: SELF_HOST_TENANT_ID,
        scopeType: "org",
        scopeId: SELF_HOST_TENANT_ID,
        period: "month",
        softLimitMicros: "0",
        hardLimitMicros: "10000",
        status: "active",
      }]),
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });
    const reconcile = vi.spyOn(budget, "reconcile");
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onEvent({ kind: "usage", inputTokens: 10, outputTokens: 5, servedProvider: "router", servedModel: "gpt-test" });
      options.onEvent({ kind: "turn.end", turnId: "turn_budget_ok", status: "completed" });
      return { turnId: "turn_budget_ok" };
    });
    app = await createApp(fakeSessionHost({ startTurn }), { budget });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Budget task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none", cost: { input: 1, output: 1 } },
    }).expect(201);
    await nextTick();

    const usageRepository = app.get<UsageRepository>(USAGE_REPOSITORY);
    const usageEvents = await usageRepository.listEvents(SELF_HOST_TENANT_ID);

    expect(startTurn).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      actualCostMicros: expect.any(BigInt),
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, provider: "router", model: "gpt-test" }),
    }));
    expect(usageEvents).toEqual([
      expect.objectContaining({
        source: "api",
        feature: "model.turn",
        provider: "router",
        model: "gpt-test",
        tokensIn: 10,
        tokensOut: 5,
        status: "completed",
      }),
    ]);
  });

  it("fails closed before model work when budget counters are unhealthy", async () => {
    const startTurn = vi.fn(() => ({ turnId: "turn_never" }));
    app = await createApp(fakeSessionHost({ startTurn }), {
      budget: new BudgetService({
        repository: new InMemoryBudgetRepository(),
        hotCounters: new InMemoryBudgetHotCounters(() => false),
        enabled: true,
        failClosed: true,
      }),
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Budget task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(402).expect(({ body }) => {
      expect(body).toMatchObject({ code: "budget_exceeded", check: { reason: "billing_unhealthy" } });
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("replays buffered SessionHost events through the SSE observable using AgentStreamEvent payloads", async () => {
    const bufferedEvents: AgentStreamEvent[] = [
      { kind: "turn.start", turnId: "turn_replay" },
      { kind: "turn.end", turnId: "turn_replay", status: "completed" },
    ];
    app = await createApp(fakeSessionHost({ turnState: () => ({ active: false, turnId: null, bufferedEvents }) }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);
    const eventStream = app.get(ApiEventStreamService);

    const first = await firstValueFrom(eventStream.stream(created.body.session.id, bufferedEvents).pipe(take(1)));

    expect(first.type).toBeUndefined();
    expect(first.data).toEqual(bufferedEvents[0]);
  });

  it("reports active turn state for clients that navigate back to a running task", async () => {
    const bufferedEvents: AgentStreamEvent[] = [{ kind: "turn.start", turnId: "turn_active" }];
    app = await createApp(fakeSessionHost({ turnState: () => ({ active: true, turnId: "turn_active", bufferedEvents }) }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);

    await request(app.getHttpServer())
      .get(`/v1/sessions/${created.body.session.id}/turn-state`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ active: true, turnId: "turn_active", bufferedEvents }));
  });

  it("settles stale running tasks after the API process restarts", async () => {
    const taskStore = new InMemoryCloudTaskStore();
    const created = await taskStore.createTask({ workspaceId: "workspace_cloud", title: "Interrupted task" });
    await taskStore.appendMessage(created.session.id, {
      role: "assistant",
      parts: [{ kind: "error", content: "Provider stream ended before completion" }],
    });
    await taskStore.updateTask(created.task.id, { status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    app = await createApp(fakeSessionHost(), { taskStore });

    await request(app.getHttpServer())
      .get("/v1/tasks?workspaceId=workspace_cloud")
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => expect(body[0]).toMatchObject({ id: created.task.id, status: "failed" }));
  });

  it("persists provider stream errors before the thread projection is reloaded", async () => {
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onEvent({ kind: "turn.start", turnId: "turn_failed" });
      options.onEvent({ kind: "error", message: "Provider stream ended before completion" });
      options.onAssistantMessage?.({
        parts: [{ kind: "error", content: "Provider stream ended before completion" }],
        status: "failed",
        model: "gpt-test",
      });
      options.onEvent({ kind: "turn.end", turnId: "turn_failed", status: "failed" });
      return { turnId: "turn_failed" };
    });
    app = await createApp(fakeSessionHost({ startTurn }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201);

    await request(app.getHttpServer()).get(`/v1/sessions/${created.body.session.id}/messages`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.at(-1)).toMatchObject({ role: "assistant", parts: [expect.objectContaining({ kind: "error", content: "Provider stream ended before completion" })] });
      expect(body.filter((message: { parts: Array<{ kind: string }> }) => message.parts.some((part) => part.kind === "error"))).toHaveLength(1);
    });
  });

  it("routes approval decisions through the shared decision schema", async () => {
    const resolveApproval = vi.fn(() => true);
    app = await createApp(fakeSessionHost({ resolveApproval }));

    await request(app.getHttpServer()).post("/v1/approvals/approval_1/decision").set(authHeader()).send({ decision: "approved_for_session" }).expect(201).expect(({ body }) => {
      expect(body).toEqual({ ok: true });
    });

    expect(resolveApproval).toHaveBeenCalledWith("approval_1", "approved_for_session");
  });

  it("lists pending approvals for companion clients", async () => {
    app = await createApp(fakeSessionHost({ pendingApprovalIds: () => ["approval_mobile_1"] }));

    await request(app.getHttpServer()).get("/v1/approvals").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toEqual([
        expect.objectContaining({
          id: "approval_mobile_1",
          kind: "shell",
          status: "pending",
          request: expect.objectContaining({ title: "Approval required" }),
          decidedAt: null,
        }),
      ]);
    });
  });

  it("maps detailed background approvals to their owning task", async () => {
    let sessionId = "";
    app = await createApp(fakeSessionHost({ pendingApprovals: () => [{ id: "approval_background", sessionId, kind: "shell", title: "Run tests", detail: "pnpm test" }] }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Background task" }).expect(201);
    sessionId = created.body.session.id;

    await request(app.getHttpServer()).get("/v1/approvals").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body[0]).toMatchObject({ id: "approval_background", taskId: created.body.task.id, kind: "shell", status: "pending", request: { title: "Run tests", detail: "pnpm test" } });
    });
  });

  it("registers mobile devices and never returns raw push tokens", async () => {
    app = await createApp(fakeSessionHost());

    await request(app.getHttpServer()).post("/v1/devices").set(authHeader()).send({
      deviceId: "ios-device-1",
      platform: "ios",
      pushProvider: "apns",
      pushToken: "apns-secret-token-1234",
      endpointMode: "berry-account",
      appVersion: "0.1.0",
      capabilities: ["approvals", "chat", "tasks", "push"],
    }).expect(201).expect(({ body }) => {
      expect(body).toMatchObject({
        deviceId: "ios-device-1",
        platform: "ios",
        pushProvider: "apns",
        pushTokenLast4: "1234",
        endpointMode: "berry-account",
        status: "active",
      });
      expect(JSON.stringify(body)).not.toContain("apns-secret-token");
    });

    await request(app.getHttpServer()).get("/v1/devices").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ deviceId: "ios-device-1", capabilities: expect.arrayContaining(["push"]) });
      expect(JSON.stringify(body)).not.toContain("apns-secret-token");
    });

    await request(app.getHttpServer()).post("/v1/approvals/approval_mobile_1/notify-devices").set(authHeader()).expect(201).expect(({ body }) => {
      expect(body).toEqual([
        expect.objectContaining({
          deviceId: "ios-device-1",
          delivered: false,
          provider: "apns",
          payload: expect.objectContaining({ type: "approval.requested", approvalId: "approval_mobile_1" }),
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain("apns-secret-token");
    });

    await request(app.getHttpServer()).delete("/v1/devices/ios-device-1").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toEqual({ ok: true });
    });
    await request(app.getHttpServer()).get("/v1/devices").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body).toEqual([]);
    });
  });

  it("requires a Better Auth session for protected API routes", async () => {
    app = await createApp(fakeSessionHost());

    await request(app.getHttpServer()).get("/v1/tasks").expect(401);
    await request(app.getHttpServer()).get("/v1/tasks").set(authHeader()).expect(200);
  });

  it("keeps Better Auth discovery public", async () => {
    app = await createApp(fakeSessionHost());

    await request(app.getHttpServer()).get("/v1/auth/config").expect(200).expect(({ body }) => {
      expect(body).toMatchObject({
        basePath: "/v1/auth",
        emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
        socialProviders: ["github"],
      });
    });
    await request(app.getHttpServer()).get("/v1/auth/get-session").expect(200).expect(({ text }) => {
      expect(JSON.parse(text)).toEqual({ ok: true });
    });
    await request(app.getHttpServer()).post("/v1/auth/sign-up/email").send({
      name: "Test User",
      email: "test@example.test",
      password: "test-password",
    }).expect(200).expect(({ text }) => {
      expect(JSON.parse(text)).toEqual({ ok: true });
    });
  });
});

async function createApp(sessionHost: SessionHost, options: { budget?: BudgetService | undefined; modelGovernance?: ModelGovernanceService | undefined; taskStore?: CloudTaskStore | undefined } = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: sessionHost },
      auth: { useValue: fakeAuthRuntime() },
      ...(options.taskStore ? { taskStore: { useValue: options.taskStore } } : {}),
      ...(options.budget ? { budget: { service: { useValue: options.budget } } } : {}),
      ...(options.modelGovernance ? { modelGovernance: { service: { useValue: options.modelGovernance } } } : {}),
    })],
  })
    .overrideProvider(FilePlatformService)
    .useValue(fakeFilePlatformService)
    .compile();
  const nestApp = moduleRef.createNestApplication();
  await nestApp.init();
  return nestApp;
}

const fakeFilePlatformService = {
  runtimeAttachments: async (_tenantId: string, _userId: string, attachments: unknown[]) => attachments,
  associateInputFiles: async () => undefined,
};

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function authHeader(token = "berry-test-session") {
  return { Authorization: `Bearer ${token}` };
}

function fakeAuthRuntime(): BerryAuthRuntime {
  const getSession: BerryAuthRuntime["getSession"] = async (headers) => {
    if (headers.authorization === "Bearer berry-other-session") {
      return {
        session: { id: "auth_session_2", userId: "user_2" },
        user: { id: "user_2", email: "other@example.test", name: "Other User", emailVerified: true },
      };
    }
    if (headers.authorization !== "Bearer berry-test-session") return null;
    return {
      session: { id: "auth_session_1", userId: "user_1" },
      user: { id: "user_1", email: "test@example.test", name: "Test User", emailVerified: true },
    };
  };
  return {
    describe: () => ({
      basePath: "/v1/auth",
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      socialProviders: ["github"],
      storage: "memory",
    }),
    getSession,
    requireSession: async (headers) => {
      const session = await getSession(headers);
      if (!session) throw new UnauthorizedException("Authentication required");
      return session;
    },
    handleNodeRequest: async (_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

function fakeSessionHost(overrides: Partial<SessionHost> = {}): SessionHost {
  return {
    startTurn: () => ({ turnId: "turn_default" }),
    resolveQuestion: () => true,
    resolveApproval: () => true,
    recordApprovalGrant: () => {},
    pendingApprovalIds: () => [],
    pendingQuestionIds: () => [],
    cancel: async () => true,
    turnState: () => ({ active: false, turnId: null, bufferedEvents: [] }),
    contextStats: async () => ({ usedTokens: 0, source: "unknown" }),
    steer: async () => ({ queued: true }),
    followUp: async () => ({ queued: true }),
    replaceFollowUpQueue: async () => undefined,
    fork: async () => ({ sessionId: "session_fork" }),
    rewind: async () => {},
    rewindForEdit: async () => {},
    compact: async () => ({ summary: "summary", tokensBefore: 1 }),
    listLoadedSkills: () => [],
    dispose: async () => {},
    ...overrides,
  } as SessionHost;
}
