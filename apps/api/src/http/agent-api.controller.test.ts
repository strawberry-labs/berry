import "reflect-metadata";
import { ConflictException, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { AgentStreamEvent } from "@berry/shared";
import type { SessionHost, StartTurnOptions } from "@berry/local-agent";
import request from "supertest";
import { firstValueFrom, take } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiModule } from "./agent-api.module.ts";
import { CloudDatabaseModule } from "../db/cloud-database.module.ts";
import { InMemoryCloudTaskStore, type CloudTaskStore } from "./cloud-task-store.ts";
import { ApiEventStreamService } from "./event-stream.service.ts";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { BudgetService, InMemoryBudgetHotCounters, InMemoryBudgetRepository } from "../budget/budget.service.ts";
import { InMemoryModelGovernanceRepository, ModelGovernanceService } from "../model-governance/model-governance.service.ts";
import { InMemoryUsageRepository, USAGE_REPOSITORY, type UsageRepository } from "../usage/usage.repository.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import { DurableTurnService, type DurableTurnAdmission, type DurableTurnAdmissionReplay } from "../runtime/durable-turn.service.ts";
import { ContextAssemblyService } from "../memory/context-assembly.service.ts";
import { InMemoryEnterpriseIdentityRepository, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { apiRuntimeMetrics } from "../runtime/runtime-metrics.ts";
import { durableAdmissionPreparationTimeoutMs, durableTaskReconciliationStatus, normalizeImprovedPrompt, preservePromptSkillTokens, PROMPT_IMPROVEMENT_MODEL, promptImprovementModelInput, promptImprovementSkills, turnAdmissionFingerprint } from "./agent-api.controller.ts";

describe("AgentApiController", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("normalizes prompt-only model output without altering the rewritten content", () => {
    expect(normalizeImprovedPrompt("Improved prompt: Write a three-part executive summary.")).toBe("Write a three-part executive summary.");
    expect(normalizeImprovedPrompt("```text\nUse the attached report to identify five risks.\n```")).toBe("Use the attached report to identify five risks.");
  });

  it("preserves explicitly selected Berry skill tokens in improved prompts", () => {
    const prompt = "Find the latest AI news with $research";
    expect(promptImprovementSkills(prompt, ["research", "missing"])).toEqual(["research"]);
    expect(promptImprovementModelInput(prompt, ["research"])).toContain("Required Berry skill tokens");
    expect(preservePromptSkillTokens("Find and cite the latest AI news.", ["research"]))
      .toBe("$research\n\nFind and cite the latest AI news.");
    expect(preservePromptSkillTokens("Use $research to find and cite the latest AI news.", ["research"]))
      .toBe("Use $research to find and cite the latest AI news.");
  });

  it("keeps a task active while its durable admission intent is still preparing", () => {
    const activity = {
      sessionId: "session_pending",
      runId: null,
      runState: null,
      runCreatedAt: null,
      admissionState: "preparing" as const,
      admissionCreatedAt: "2026-08-13T10:00:00.000Z",
      admissionUpdatedAt: "2026-08-13T10:00:30.000Z",
    };
    expect(durableTaskReconciliationStatus(
      activity,
      "2026-08-13T10:00:00.000Z",
      Date.parse("2026-08-13T10:01:00.000Z"),
    )).toBeNull();
    expect(durableTaskReconciliationStatus(
      activity,
      "2026-08-13T10:00:00.000Z",
      Date.parse("2026-08-13T10:03:00.001Z"),
    )).toBe("failed");
  });

  it("lets a newer cancelled admission supersede an older completed run", () => {
    expect(durableTaskReconciliationStatus({
      sessionId: "session_cancelled",
      runId: "run_old",
      runState: "completed",
      runCreatedAt: "2026-08-13T09:00:00.000Z",
      admissionState: "cancelled",
      admissionCreatedAt: "2026-08-13T10:00:00.000Z",
      admissionUpdatedAt: "2026-08-13T10:00:01.000Z",
    }, "2026-08-13T10:00:00.000Z")).toBe("cancelled");
  });

  it("improves prompts with the fixed low-cost model and records measured usage", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: "completion_prompt_improve",
      model: PROMPT_IMPROVEMENT_MODEL,
      choices: [{ message: { content: "Improved prompt: Write a concise executive summary for senior leaders, followed by three prioritized recommendations." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144, prompt_tokens_details: { cached_tokens: 80 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchImpl);
    const usageRepository = new InMemoryUsageRepository();
    app = await createApp(fakeSessionHost(), {
      runtimeConfig: promptImprovementRuntimeConfig(),
      usageRepository,
    });

    await request(app.getHttpServer())
      .post("/v1/prompts/improve")
      .set(authHeader())
      .send({ prompt: "summarize this for leadership" })
      .expect(201)
      .expect(({ body }) => expect(body).toEqual({
        prompt: "Write a concise executive summary for senior leaders, followed by three prioritized recommendations.",
        model: PROMPT_IMPROVEMENT_MODEL,
      }));

    expect(fetchImpl).toHaveBeenCalledOnce();
    const upstreamRequest = fetchImpl.mock.calls[0]![1]!;
    const upstreamBody = JSON.parse(String(upstreamRequest.body)) as Record<string, unknown>;
    expect(upstreamBody).toMatchObject({ model: PROMPT_IMPROVEMENT_MODEL, stream: false, temperature: 0.2 });
    expect(upstreamBody).not.toHaveProperty("tools");
    expect(upstreamBody.messages).toEqual([
      expect.objectContaining({ role: "system", content: expect.stringContaining("Return only the improved prompt") }),
      { role: "user", content: "summarize this for leadership" },
    ]);
    const usageEvents = await usageRepository.listEvents(SELF_HOST_TENANT_ID);
    expect(usageEvents).toEqual([
      expect.objectContaining({
        feature: "prompt.improve",
        provider: "router",
        model: PROMPT_IMPROVEMENT_MODEL,
        tokensIn: 120,
        tokensOut: 24,
        cacheReadTokens: 80,
        status: "completed",
      }),
    ]);
  });

  it("rejects blank prompt improvements before calling the model", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    app = await createApp(fakeSessionHost(), { runtimeConfig: promptImprovementRuntimeConfig() });

    await request(app.getHttpServer())
      .post("/v1/prompts/improve")
      .set(authHeader())
      .send({ prompt: "   " })
      .expect(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a selected skill when the improvement model omits it", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: "completion_prompt_improve_skill",
      model: PROMPT_IMPROVEMENT_MODEL,
      choices: [{ message: { content: "Find and cite five current AI news stories from reliable sources." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 80, completion_tokens: 18, total_tokens: 98 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchImpl);
    app = await createApp(fakeSessionHost(), { runtimeConfig: promptImprovementRuntimeConfig() });

    await request(app.getHttpServer())
      .post("/v1/prompts/improve")
      .set(authHeader())
      .send({ prompt: "What is the latest AI news? $research", skills: ["research"] })
      .expect(201)
      .expect(({ body }) => expect(body.prompt).toBe(
        "$research\n\nFind and cite five current AI news stories from reliable sources.",
      ));

    const upstream = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(upstream).toMatchObject({ reasoning: { effort: "minimal" }, max_tokens: 1_024 });
    expect(JSON.stringify(upstream.messages)).toContain("$research");
  });

  it("fingerprints the request payload independently from its operation key", () => {
    const request = {
      operationId: "00000000-0000-7000-8000-000000000001",
      input: "Run the task",
      workspacePath: "/workspace",
      provider: { id: "provider" },
    };
    expect(turnAdmissionFingerprint(request)).toBe(turnAdmissionFingerprint({
      ...request,
      operationId: "00000000-0000-7000-8000-000000000002",
    }));
    expect(turnAdmissionFingerprint(request)).not.toBe(turnAdmissionFingerprint({
      ...request,
      input: "Run a different task",
    }));
  });

  it("caps optional durable admission preparation below the two-second SLA", () => {
    expect(durableAdmissionPreparationTimeoutMs({})).toBe(1_500);
    expect(durableAdmissionPreparationTimeoutMs({
      BERRY_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS: "5000",
    })).toBe(1_500);
    expect(durableAdmissionPreparationTimeoutMs({
      BERRY_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS: "25",
    })).toBe(25);
  });

  it("admits with degraded context when context and checkpoint preparation hang", async () => {
    vi.stubEnv("BERRY_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS", "50");
    const never = new Promise<never>(() => undefined);
    const contextAssembly = {
      assemble: vi.fn(() => never),
      portableCheckpoint: vi.fn(() => never),
    };
    const admit = vi.fn(async (input: DurableTurnAdmission) => ({
      runId: "turn_bounded_preparation",
      sessionId: input.sessionId,
    }));
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "chat-model",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
    });
    app = await createApp(fakeSessionHost(), {
      contextAssembly,
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: chatRuntimeConfig(),
      durableTurns: { enabled: true, replayAdmission: async () => null, admit },
    });
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Bounded admission" })
      .expect(201);

    const startedAt = Date.now();
    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        input: "Run despite unavailable optional context",
        workspacePath: "/workspace",
      })
      .expect(201)
      .expect({ turnId: "turn_bounded_preparation", sessionId: created.body.session.id });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(contextAssembly.assemble).toHaveBeenCalledOnce();
    expect(contextAssembly.portableCheckpoint).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      groundingContext: expect.objectContaining({
        retrieval: expect.objectContaining({ degradedReason: "context_timeout" }),
      }),
      runtimeRequest: expect.objectContaining({
        providerId: "router",
        model: "chat-model",
      }),
    }));
    expect(admit.mock.calls[0]?.[0].runtimeRequest).not.toHaveProperty("portableCheckpoint");
  });

  it("observes concurrent admission failures immediately and records the failed attempt", async () => {
    const runtimeConfig = chatRuntimeConfig();
    const resolveRuntime = runtimeConfig.resolve.bind(runtimeConfig);
    vi.spyOn(runtimeConfig, "resolve").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return resolveRuntime(...args);
    });
    const identityFailure = new Error("identity unavailable");
    const identityRepository = new InMemoryEnterpriseIdentityRepository();
    const getMembership = identityRepository.getMembership.bind(identityRepository);
    let failMembershipLookup = false;
    vi.spyOn(identityRepository, "getMembership").mockImplementation(async (...args) => {
      if (failMembershipLookup) throw identityFailure;
      return getMembership(...args);
    });
    const before = admissionMetricCount("failed", "unknown");
    app = await createApp(fakeSessionHost(), {
      identityRepository,
      runtimeConfig,
      durableTurns: {
        enabled: true,
        replayAdmission: async () => null,
        admit: async (input) => ({ runId: "turn_not_admitted", sessionId: input.sessionId }),
      },
    });
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Failed admission" })
      .expect(201);
    failMembershipLookup = true;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const startRequest = request(app.getHttpServer())
        .post(`/v1/sessions/${created.body.session.id}/turns`)
        .set(authHeader())
        .send({ input: "Fail during preparation", workspacePath: "/workspace" })
        .then((response) => response);
      await nextTick();
      expect(unhandled).not.toHaveBeenCalled();
      expect((await startRequest).status).toBe(500);
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(admissionMetricCount("failed", "unknown")).toBe(before + 1);
  });

  it("does not enqueue a provider call when pending admission is cancelled during preparation", async () => {
    vi.stubEnv("BERRY_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS", "100");
    const never = new Promise<never>(() => undefined);
    const contextAssembly = {
      assemble: vi.fn(() => never),
      portableCheckpoint: vi.fn(() => never),
    };
    let admissionStarted!: () => void;
    const beganAdmission = new Promise<void>((resolve) => { admissionStarted = resolve; });
    let cancelled = false;
    let enqueuedProviderCalls = 0;
    const admit = vi.fn(async (input: DurableTurnAdmission) => {
      if (cancelled) {
        throw new ConflictException({
          code: "turn_admission_cancelled",
          message: "This turn submission was cancelled before durable admission completed.",
        });
      }
      enqueuedProviderCalls += 1;
      return { runId: "turn_should_not_exist", sessionId: input.sessionId };
    });
    const cancel = vi.fn(async () => {
      cancelled = true;
      return true;
    });
    const operationId = "00000000-0000-7000-8000-000000000091";
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "chat-model",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
    });
    app = await createApp(fakeSessionHost(), {
      contextAssembly,
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: chatRuntimeConfig(),
      durableTurns: {
        enabled: true,
        replayAdmission: async () => null,
        beginAdmission: async () => {
          admissionStarted();
          return null;
        },
        admit,
        cancel,
      },
    });
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Cancelled admission" })
      .expect(201);

    const startRequest = request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        operationId,
        input: "Do not run after cancellation",
        workspacePath: "/workspace",
        provider: { id: "router" },
        model: "chat-model",
      })
      .then((response) => response);
    await beganAdmission;
    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/cancel`)
      .set(authHeader())
      .send({ operationId })
      .expect(201)
      .expect({ ok: true });
    const response = await startRequest;

    expect(response.status).toBe(409);
    expect(cancel).toHaveBeenCalledWith(
      SELF_HOST_TENANT_ID,
      created.body.session.id,
      `model_${operationId}`,
    );
    expect(admit).toHaveBeenCalledOnce();
    expect(enqueuedProviderCalls).toBe(0);
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
    await request(app.getHttpServer()).patch(`/v1/tasks/${created.body.task.id}`).set(authHeader()).send({ status: "running" }).expect(200);
    await request(app.getHttpServer()).patch(`/v1/tasks/${created.body.task.id}`).set(authHeader()).send({ status: "completed" }).expect(200).expect(({ body }) => {
      expect(body.unreadAt).toEqual(expect.any(String));
    });
    await request(app.getHttpServer()).patch(`/v1/tasks/${created.body.task.id}`).set(authHeader()).send({ read: true }).expect(200).expect(({ body }) => {
      expect(body.unreadAt).toBeNull();
      expect(body.lastReadAt).toEqual(expect.any(String));
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

  it("snapshots the current organization default on each new chat", async () => {
    const runtimeConfig = new CloudRuntimeConfigService({
      ...chatRuntimeEnv(),
      BERRY_ROUTER_DEFAULT_MODEL: "primary-model",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([
        { id: "primary-model", name: "Primary Model" },
        { id: "backup-model", name: "Backup Model" },
      ]),
    });
    const modelGovernance = new ModelGovernanceService(new InMemoryModelGovernanceRepository(false));
    const runtime = await runtimeConfig.resolve(SELF_HOST_TENANT_ID, {});
    await modelGovernance.synchronizeRuntimeCatalog(SELF_HOST_TENANT_ID, runtime.provider);
    await modelGovernance.upsertDefault({
      tenantId: SELF_HOST_TENANT_ID,
      mode: "chat",
      providerId: "router",
      model: "backup-model",
      enforce: false,
    });
    app = await createApp(fakeSessionHost(), { modelGovernance, runtimeConfig });

    await request(app.getHttpServer())
      .get("/v1/models/catalog")
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => expect(body.defaultModel).toBe("backup-model"));

    const beforeSwitch = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Before outage switch" })
      .expect(201);
    expect(beforeSwitch.body.session).toMatchObject({
      modelProviderId: "router",
      model: "backup-model",
    });

    await modelGovernance.upsertDefault({
      tenantId: SELF_HOST_TENANT_ID,
      mode: "chat",
      providerId: "router",
      model: "primary-model",
      enforce: false,
    });
    const afterSwitch = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "After outage switch" })
      .expect(201);
    expect(afterSwitch.body.session).toMatchObject({
      modelProviderId: "router",
      model: "primary-model",
    });

    await request(app.getHttpServer())
      .get(`/v1/sessions/${beforeSwitch.body.session.id}`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        modelProviderId: "router",
        model: "backup-model",
      }));
  });

  it("reports context usage with the current draft in fallback runtime mode", async () => {
    let observedInput = "";
    app = await createApp(fakeSessionHost({
      contextStats: async (_sessionId, options) => {
        observedInput = options?.pendingInput ?? "";
        return { usedTokens: 12_000, source: "provider-reported" };
      },
    }));
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Context stats task", model: "berry/auto" })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/context-stats`)
      .set(authHeader())
      .send({ model: "berry/auto", pendingInput: "Continue this task" })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          usedTokens: 12_000,
          contextWindow: 200_000,
          percentUsed: 6,
          tokensLeft: 188_000,
          source: "provider-reported",
          thresholdState: "normal",
        });
      });
    expect(observedInput).toBe("Continue this task");
  });

  it("updates and removes a user-owned project", async () => {
    app = await createApp(fakeSessionHost());
    const project = await request(app.getHttpServer())
      .post("/v1/workspaces")
      .set(authHeader())
      .send({ name: "Sidebar project" })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/v1/workspaces/${project.body.id}`)
      .set(authHeader())
      .send({ name: "Pinned sidebar project", pinned: true })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ name: "Pinned sidebar project", pinned: true }));

    await request(app.getHttpServer())
      .delete(`/v1/workspaces/${project.body.id}`)
      .set(authHeader())
      .expect(200)
      .expect({ removed: true });
  });

  it("deduplicates retries by message id without deduplicating identical prompt text", async () => {
    app = await createApp(fakeSessionHost());
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Message identity task" })
      .expect(201);
    const sessionId = created.body.session.id as string;
    const firstId = "e6e39930-cc25-47ca-a42d-2bd38f0ff573";
    const secondId = "75d7b975-24ae-42d9-af3c-2e1507e865b8";
    const messageBody = (messageId: string) => ({
      messageId,
      role: "user",
      parts: [{ kind: "text", content: "Run the same prompt again" }],
    });

    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/messages`).set(authHeader()).send(messageBody(firstId)).expect(201);
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/messages`).set(authHeader()).send(messageBody(firstId)).expect(201);
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/messages`).set(authHeader()).send(messageBody(secondId)).expect(201);

    await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}/messages`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.map((message: { id: string }) => message.id)).toEqual([firstId, secondId]);
      expect(body.map((message: { parts: Array<{ content: unknown }> }) => message.parts[0]?.content)).toEqual([
        "Run the same prompt again",
        "Run the same prompt again",
      ]);
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
    expect(first.body.session).toMatchObject({ id: sessionId, permissionMode: "full-access" });

    await request(app.getHttpServer()).get("/v1/tasks?workspaceKind=general").set(authHeader("berry-other-session")).expect(200).expect([]);
    await request(app.getHttpServer()).patch(`/v1/tasks/${taskId}`).set(authHeader("berry-other-session")).send({ conversationKind: "chat" }).expect(404);
    const other = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader("berry-other-session"))
      .send({ workspaceKind: "general", title: "Other chat" })
      .expect(201);
    expect(other.body.task.workspaceId).not.toBe(workspaceId);
  });

  it("isolates project workspaces, tasks, and messages by user", async () => {
    app = await createApp(fakeSessionHost());
    const workspace = await request(app.getHttpServer())
      .post("/v1/workspaces")
      .set(authHeader())
      .send({ name: "Private project" })
      .expect(201);
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: workspace.body.id, title: "Private task" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/messages`)
      .set(authHeader())
      .send({ role: "user", parts: [{ kind: "text", content: "private" }] })
      .expect(201);

    await request(app.getHttpServer())
      .get("/v1/workspaces?includeGeneral=true")
      .set(authHeader("berry-other-session"))
      .expect(200)
      .expect(({ body }) => expect(body).not.toContainEqual(expect.objectContaining({ id: workspace.body.id })));
    await request(app.getHttpServer())
      .get("/v1/tasks")
      .set(authHeader("berry-other-session"))
      .expect(200)
      .expect([]);
    await request(app.getHttpServer())
      .get(`/v1/tasks/${created.body.task.id}`)
      .set(authHeader("berry-other-session"))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/sessions/${created.body.session.id}/messages`)
      .set(authHeader("berry-other-session"))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/v1/tasks/${created.body.task.id}/sessions`)
      .set(authHeader("berry-other-session"))
      .send({})
      .expect(404);
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
      permissionMode: "full-access",
    }));
    await request(app.getHttpServer()).get("/v1/tasks").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body[0]).toMatchObject({ id: created.body.task.id, status: "completed" });
    });
  });

  it("does not publish inline turn completion before usage and projections settle", async () => {
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    const usageRepository = new InMemoryUsageRepository();
    const originalIngest = usageRepository.ingestInternal.bind(usageRepository);
    vi.spyOn(usageRepository, "ingestInternal").mockImplementation(async (...args) => {
      await usageGate;
      return originalIngest(...args);
    });
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onEvent({ kind: "turn.start", turnId: "turn_ordered" });
      options.onEvent({ kind: "turn.end", turnId: "turn_ordered", status: "completed" });
      return { turnId: "turn_ordered" };
    });
    app = await createApp(fakeSessionHost({ startTurn }), { usageRepository });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);
    const observed: AgentStreamEvent[] = [];
    const subscription = app.get(ApiEventStreamService)
      .stream(created.body.session.id, [])
      .subscribe((event) => observed.push(event.data));

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201);
    await nextTick();
    expect(observed).toContainEqual({ kind: "turn.start", turnId: "turn_ordered" });
    expect(observed).not.toContainEqual(expect.objectContaining({ kind: "turn.end" }));

    releaseUsage();
    await nextTick();
    await nextTick();
    expect(observed).toContainEqual({ kind: "turn.end", turnId: "turn_ordered", status: "completed" });
    subscription.unsubscribe();
  });

  it("publishes a failed terminal even when the fallback task-status write fails", async () => {
    const taskStore = new InMemoryCloudTaskStore();
    const updateTask = taskStore.updateTask.bind(taskStore);
    vi.spyOn(taskStore, "updateTask").mockImplementation(async (taskId, input, ownerUserId) => {
      if (input.status === "completed" || input.status === "failed") {
        throw new Error("Task status persistence unavailable");
      }
      return updateTask(taskId, input, ownerUserId);
    });
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onEvent({ kind: "turn.start", turnId: "turn_fallback_terminal" });
      options.onEvent({ kind: "turn.end", turnId: "turn_fallback_terminal", status: "completed" });
      return { turnId: "turn_fallback_terminal" };
    });
    app = await createApp(fakeSessionHost({ startTurn }), { taskStore });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);
    const observed: AgentStreamEvent[] = [];
    const subscription = app.get(ApiEventStreamService)
      .stream(created.body.session.id, [])
      .subscribe((event) => observed.push(event.data));

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 1_400));

    expect(observed).toContainEqual({
      kind: "turn.end",
      turnId: "turn_fallback_terminal",
      status: "failed",
    });
    subscription.unsubscribe();
  }, 5_000);

  it("continues a failed assistant turn without sending another user message", async () => {
    let attempt = 0;
    const startTurn = vi.fn((options: StartTurnOptions) => {
      attempt += 1;
      const turnId = `turn_continue_${attempt}`;
      options.onEvent({ kind: "turn.start", turnId });
      if (attempt === 1) {
        options.onEvent({ kind: "error", message: "Provider request failed with 504" });
        options.onEvent({ kind: "turn.end", turnId, status: "failed" });
      } else {
        options.onEvent({ kind: "turn.end", turnId, status: "completed" });
      }
      return { turnId };
    });
    app = await createApp(fakeSessionHost({ startTurn }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Continue task" }).expect(201);
    const sessionId = created.body.session.id as string;

    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/messages`).set(authHeader()).send({
      role: "user",
      parts: [{ kind: "text", content: "Do the work" }],
    }).expect(201);
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/turns`).set(authHeader()).send({
      input: "Do the work",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201);
    await nextTick();

    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/turns`).set(authHeader()).send({
      continueInterruptedTurn: true,
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201);

    expect(startTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId,
      input: "",
      continueInterruptedTurn: true,
      attachments: [],
    }));
    const messages = await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}/messages`).set(authHeader()).expect(200);
    expect(messages.body.filter((message: { role: string }) => message.role === "user")).toHaveLength(1);
  });

  it("rejects continuation unless the latest assistant turn is interrupted", async () => {
    const startTurn = vi.fn(() => ({ turnId: "turn_never" }));
    app = await createApp(fakeSessionHost({ startTurn }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Invalid continuation" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      continueInterruptedTurn: true,
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(400);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("cancels an active session turn through SessionHost", async () => {
    const cancel = vi.fn(async () => true);
    app = await createApp(fakeSessionHost({ cancel }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Cancel task" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/cancel`).set(authHeader()).expect(201).expect({ ok: true });
    expect(cancel).toHaveBeenCalledWith(created.body.session.id);
  });

  it("persists an interrupted assistant boundary before the next steered user message", async () => {
    const cancel = vi.fn(async () => true);
    const bufferedEvents: AgentStreamEvent[] = [
      { kind: "turn.start", turnId: "turn_interrupted" },
      { kind: "message.start", messageId: "message_interrupted", role: "assistant" },
      { kind: "message.delta", messageId: "message_interrupted", channel: "reasoning", delta: "Researching the data center figures." },
    ];
    app = await createApp(fakeSessionHost({
      cancel,
      turnState: () => ({ active: true, turnId: "turn_interrupted", bufferedEvents }),
    }));
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Interrupted task" })
      .expect(201);
    const sessionId = created.body.session.id as string;

    await request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/messages`)
      .set(authHeader())
      .send({ role: "user", parts: [{ kind: "text", content: "Start researching" }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/cancel`)
      .set(authHeader())
      .expect(201)
      .expect({ ok: true });
    await request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/messages`)
      .set(authHeader())
      .send({ role: "user", parts: [{ kind: "text", content: "Steer the research" }] })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/v1/sessions/${sessionId}/messages`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
        expect(body[1]).toMatchObject({
          status: "cancelled",
          parts: [expect.objectContaining({ kind: "reasoning", content: "Researching the data center figures." })],
        });
      });
  });

  it("queues steering input while a session turn is active", async () => {
    const steer = vi.fn(async () => ({ queued: true as const }));
    app = await createApp(fakeSessionHost({ steer }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Steer task" }).expect(201);
    const messageId = "46df263a-3453-4d22-9b65-fb585ba71c9b";
    const steeringRequest = {
      messageId,
      input: "Use the existing component",
      attachments: [{ id: "attachment_1", name: "very-long-project-brief.pdf", mediaType: "application/pdf", size: 151552, sourceKind: "web-upload" }],
    };

    const sendSteeringRequest = () => request(app!.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/steer`)
      .set(authHeader())
      .send(steeringRequest)
      .expect(201);
    const concurrentResponses = await Promise.all([sendSteeringRequest(), sendSteeringRequest()]);
    for (const response of concurrentResponses) {
      expect(response.body).toMatchObject({ queued: true, message: { id: messageId, role: "user" } });
    }
    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/steer`).set(authHeader()).send(steeringRequest)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ queued: true, message: { id: messageId, role: "user" } });
      });
    expect(steer).toHaveBeenCalledWith(created.body.session.id, "Use the existing component", [], [expect.objectContaining({ id: "attachment_1", name: "very-long-project-brief.pdf" })]);
    expect(steer).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get(`/v1/sessions/${created.body.session.id}/messages`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.filter((message: { id: string }) => message.id === messageId)).toEqual([expect.objectContaining({
        id: messageId,
        role: "user",
        parts: [
          expect.objectContaining({ kind: "text", content: "Use the existing component" }),
          expect.objectContaining({ kind: "attachment", content: expect.objectContaining({ name: "very-long-project-brief.pdf", mediaType: "application/pdf", size: 151552 }) }),
        ],
      })]);
    });
  });

  it("does not expose server-side queued follow-up persistence", async () => {
    app = await createApp(fakeSessionHost());
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Local queue task" }).expect(201);
    const sessionId = created.body.session.id as string;

    await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).expect(404);
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/follow-ups`).set(authHeader()).send({ input: "Keep this in the browser" }).expect(404);
    await request(app.getHttpServer()).patch("/v1/follow-ups/queue_item").set(authHeader()).send({ status: "queued" }).expect(404);
  });

  it("owns a bounded browser-safe sandbox workspace per task", async () => {
    app = await createApp(fakeSessionHost());
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Code workspace", conversationKind: "code", permissionMode: "ask" }).expect(201);
    const taskId = created.body.task.id as string;

    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace`).set(authHeader()).expect(404);
    await request(app.getHttpServer()).get(`/v1/tasks/${taskId}/workspace/capture`).set(authHeader()).expect(404);
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
    await request(app.getHttpServer()).post(`/v1/tasks/${taskId}/workspace/terminals/${terminal.body.id}/input`).set(authHeader()).send({ input: "pwd" }).expect(201);
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
    const skill = await request(app.getHttpServer()).post("/v1/me/skills").set(authHeader()).send({ name: "review-helper", description: "Reviews changes", content: skillContent, source: "text", enabled: true }).expect(201);
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

  it("blocks disallowed image models before budget reservation and generation", async () => {
    const generateImage = vi.fn(async () => ({ model: "image-model", data: [{ b64_json: "image" }] }));
    const runtimeConfig = {
      imageGenerationInfo: () => ({ providerId: "provider", model: "image-model", costMicros: "10" }),
      generateImage,
    } as unknown as CloudRuntimeConfigService;
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "provider",
      model: "image-model",
      status: "blocked",
      enforce: true,
      modeAllow: ["chat"],
    });
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig,
    });

    await request(app.getHttpServer())
      .post("/v1/images/generations")
      .set(authHeader())
      .send({ prompt: "A governed image" })
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: "image_generation_governance_blocked",
          decision: { reason: "model_blocked", allowed: false },
        });
      });
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("reports image capability from the same per-user governance decision used for admission", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "chat-model",
      status: "allowed",
      enforce: true,
      modeAllow: ["chat"],
    });
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: imageRuntimeConfig(),
    });

    await request(app.getHttpServer())
      .get("/v1/models/catalog")
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => expect(body.capabilities.imageGeneration).toMatchObject({
        available: false,
        model: "openai/gpt-image-2",
        reason: "not_in_enforced_allowlist",
      }));

    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "openai/gpt-image-2",
      displayName: "GPT Image 2",
      status: "allowed",
      enforce: true,
      modeAllow: ["chat"],
    });

    await request(app.getHttpServer())
      .get("/v1/models/catalog")
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => expect(body.capabilities.imageGeneration).toEqual({
        available: true,
        model: "openai/gpt-image-2",
        reason: null,
        message: null,
      }));
  });

  it("fails an explicit image turn before admission when governance removes the image tool", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "chat-model",
      status: "allowed",
      enforce: true,
      modeAllow: ["chat"],
    });
    const admit = vi.fn(async () => ({ runId: "turn_never", sessionId: "session_never" }));
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: imageRuntimeConfig(),
      durableTurns: { enabled: true, replayAdmission: async () => null, admit },
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Image task" }).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        input: "Create image\nA red berry icon",
        intent: "image_generation",
        workspacePath: "/workspace",
        provider: { id: "router" },
        model: "chat-model",
      })
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({
        code: "image_generation_governance_blocked",
        decision: { allowed: false, reason: "not_in_enforced_allowlist" },
      }));
    expect(admit).not.toHaveBeenCalled();
  });

  it("fails an explicit image turn clearly when image generation is not configured", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "chat-model",
      status: "allowed",
      enforce: true,
      modeAllow: ["chat"],
    });
    const admit = vi.fn(async () => ({ runId: "turn_never", sessionId: "session_never" }));
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: chatRuntimeConfig(),
      durableTurns: { enabled: true, replayAdmission: async () => null, admit },
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Image task" }).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        input: "Create image\nA red berry icon",
        intent: "image_generation",
        workspacePath: "/workspace",
        provider: { id: "router" },
        model: "chat-model",
      })
      .expect(503)
      .expect(({ body }) => expect(body).toMatchObject({
        code: "image_generation_unavailable",
        message: "Image generation is not configured for this deployment.",
      }));
    expect(admit).not.toHaveBeenCalled();
  });

  it("persists explicit image intent and the admitted create_image capability for durable execution", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    for (const model of ["chat-model", "openai/gpt-image-2"]) {
      await repository.upsertPolicy({
        tenantId: SELF_HOST_TENANT_ID,
        providerId: "router",
        model,
        status: "allowed",
        enforce: true,
        modeAllow: ["chat"],
      });
    }
    const admit = vi.fn(async (input: DurableTurnAdmission) => ({ runId: "turn_image", sessionId: input.sessionId }));
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: imageRuntimeConfig(),
      durableTurns: { enabled: true, replayAdmission: async () => null, admit },
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Image task" }).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        input: "Create image\nA red berry icon",
        intent: "image_generation",
        workspacePath: "/workspace",
        provider: { id: "router" },
        model: "chat-model",
      })
      .expect(201)
      .expect({ turnId: "turn_image", sessionId: created.body.session.id });

    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      runtimeRequest: expect.objectContaining({
        intent: "image_generation",
        workspacePath: "/home/user/workspace",
        builtInTools: expect.arrayContaining(["create_image"]),
        imageGeneration: expect.objectContaining({ providerId: "router", model: "openai/gpt-image-2" }),
      }),
    }));
  });

  it("keeps the conservative output default when model metadata is missing", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "chat-model",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
    });
    const admit = vi.fn(async (input: DurableTurnAdmission) => ({
      runId: "turn_metadata_poor",
      sessionId: input.sessionId,
    }));
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: new CloudRuntimeConfigService({
        ...chatRuntimeEnv(),
        BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS: "384000",
      }),
      durableTurns: { enabled: true, replayAdmission: async () => null, admit },
    });
    const created = await request(app.getHttpServer())
      .post("/v1/tasks")
      .set(authHeader())
      .send({ workspaceId: "workspace_cloud", title: "Metadata-poor model" })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        input: "Run the task",
        workspacePath: "/workspace",
        provider: { id: "router" },
        model: "chat-model",
      })
      .expect(201);

    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      runtimeRequest: expect.objectContaining({
        model: "chat-model",
        maxTokens: 16_384,
      }),
    }));
  });

  it("admits the governed vision adapter only for a text-only primary model", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "deepseek-v4-flash",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
      capabilities: { vision: false, cost: { input: 0.14, output: 0.28, cacheRead: 0.03 } },
    });
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "minimax-m3",
      status: "allowed",
      enforce: false,
      modeAllow: [],
      capabilities: { vision: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
    });
    await repository.upsertAuxiliaryDefault({
      tenantId: SELF_HOST_TENANT_ID,
      purpose: "vision",
      providerId: "router",
      model: "minimax-m3",
    });
    const admit = vi.fn(async (input: DurableTurnAdmission) => ({ runId: "turn_vision", sessionId: input.sessionId }));
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: visionRuntimeConfig(),
      durableTurns: { enabled: true, replayAdmission: async () => null, admit },
    });
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud", title: "Vision task" }).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/sessions/${created.body.session.id}/turns`)
      .set(authHeader())
      .send({
        input: "Describe the attached image",
        workspacePath: "/workspace",
        provider: { id: "router" },
        model: "deepseek-v4-flash",
      })
      .expect(201);

    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      runtimeRequest: expect.objectContaining({
        model: "deepseek-v4-flash",
        maxTokens: 384_000,
        modelAcceptsImages: false,
        builtInTools: expect.arrayContaining(["inspect_images"]),
        vision: expect.objectContaining({
          providerId: "router",
          model: "minimax-m3",
          maxTokens: 1_536,
          estimatedCostMicros: "5444",
          modelPricing: expect.objectContaining({ input: 0.3, output: 1.2, cacheRead: 0.06 }),
        }),
      }),
    }));
  });

  it("hides auxiliary-only models from the chat model catalog", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "deepseek-v4-flash",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
      capabilities: { vision: false },
    });
    await repository.upsertPolicy({
      tenantId: SELF_HOST_TENANT_ID,
      providerId: "router",
      model: "minimax-m3",
      status: "allowed",
      enforce: false,
      modeAllow: [],
      capabilities: { vision: true },
    });
    app = await createApp(fakeSessionHost(), {
      modelGovernance: new ModelGovernanceService(repository),
      runtimeConfig: visionRuntimeConfig(),
    });

    await request(app.getHttpServer())
      .get("/v1/models/catalog")
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.models.map((model: { id: string }) => model.id)).toEqual(["deepseek-v4-flash"]);
      });
  });

  it("reserves and reconciles successful model turns", async () => {
    const budget = new BudgetService({
      repository: new InMemoryBudgetRepository([{
        tenantId: SELF_HOST_TENANT_ID,
        scopeType: "org",
        scopeId: SELF_HOST_TENANT_ID,
        period: "month",
        softLimitMicros: "0",
        hardLimitMicros: "50000",
        status: "active",
      }]),
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });
    const reconcile = vi.spyOn(budget, "reconcile");
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onEvent({
        kind: "usage",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheWriteTokens: 6,
        cacheEligible: true,
        cacheProvider: "router",
        cacheKeyHash: "cache-hash",
        promptManifestHash: "manifest-hash",
        servedProvider: "router",
        servedModel: "gpt-test",
      });
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
        tokensCached: 4,
        cacheReadTokens: 4,
        cacheWriteTokens: 6,
        promptManifestHash: "manifest-hash",
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
    const created = await taskStore.createTask({ workspaceId: "workspace_cloud", title: "Interrupted task", ownerUserId: "user_1" });
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

  it("settles a durable recovery-required task even when its terminal event is missing", async () => {
    const taskStore = new InMemoryCloudTaskStore();
    const created = await taskStore.createTask({ workspaceId: "workspace_cloud", title: "Interrupted durable task", ownerUserId: "user_1" });
    await taskStore.updateTask(created.task.id, { status: "running" });
    app = await createApp(fakeSessionHost(), {
      taskStore,
      durableTurns: {
        enabled: true,
        replayAdmission: async () => null,
        admit: async () => ({ runId: "turn_recovery", sessionId: created.session.id }),
        state: async () => ({
          active: false,
          turnId: "turn_recovery",
          bufferedEvents: [],
          replayOnly: false,
          runState: "recovery_required",
          waitingReason: null,
          nextAction: null,
          error: "Worker exited during a non-idempotent tool",
        }),
        taskActivity: async (_tenantId, sessionIds) => new Map(sessionIds.map((id) => [id, {
          sessionId: id,
          runId: "turn_recovery",
          runState: "recovery_required",
          runCreatedAt: "2026-08-13T08:00:00.000Z",
          admissionState: "admitted" as const,
          admissionCreatedAt: "2026-08-13T08:00:00.000Z",
          admissionUpdatedAt: "2026-08-13T08:00:00.000Z",
        }])),
      },
    });

    await request(app.getHttpServer())
      .get("/v1/tasks?workspaceId=workspace_cloud")
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body[0]).toMatchObject({ id: created.task.id, status: "failed" });
        expect(body[0].unreadAt).toEqual(expect.any(String));
      });
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
      expect(body.at(-1)).toMatchObject({
        role: "assistant",
        status: "failed",
        parts: [expect.objectContaining({ kind: "error", content: "Provider stream ended before completion" })],
      });
      expect(body.filter((message: { parts: Array<{ kind: string }> }) => message.parts.some((part) => part.kind === "error"))).toHaveLength(1);
    });
  });

  it("persists a usable generation duration when a provider omits one", async () => {
    const startTurn = vi.fn((options: StartTurnOptions) => {
      options.onAssistantMessage?.({
        parts: [{ kind: "text", content: "Completed response." }],
        status: "complete",
        model: "gpt-test",
        usage: { inputTokens: 10, outputTokens: 5 },
        generationMs: 0,
      });
      options.onEvent({ kind: "turn.end", turnId: "turn_duration_fallback", status: "completed" });
      return { turnId: "turn_duration_fallback" };
    });
    app = await createApp(fakeSessionHost({ startTurn }));
    const created = await request(app.getHttpServer()).post("/v1/tasks").set(authHeader()).send({ workspaceId: "workspace_cloud" }).expect(201);

    await request(app.getHttpServer()).post(`/v1/sessions/${created.body.session.id}/turns`).set(authHeader()).send({
      input: "run",
      workspacePath: "/workspace",
      provider: { id: "provider", kind: "custom", name: "Mock", baseUrl: "https://example.test", apiType: "openai-chat-completions", authType: "none" },
    }).expect(201);

    await request(app.getHttpServer()).get(`/v1/sessions/${created.body.session.id}/messages`).set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.at(-1)).toMatchObject({
        role: "assistant",
        outputTokens: 5,
        generationMs: expect.any(Number),
      });
      expect(body.at(-1).generationMs).toBeGreaterThan(0);
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

  it("rejects authenticated sessions after organization membership is deactivated", async () => {
    app = await createApp(fakeSessionHost(), { membershipActive: false });

    await request(app.getHttpServer())
      .get("/v1/tasks")
      .set(authHeader())
      .expect(403)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: "organization_membership_inactive" });
      });
    await request(app.getHttpServer()).get("/v1/auth/config").expect(200);
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
    await request(app.getHttpServer()).post("/v1/auth/setup").send({
      organizationName: "Acme",
      name: "Owner",
      email: "owner@example.test",
      password: "test-password",
      setupToken: "test-setup-token",
    }).expect(201).expect(({ body }) => {
      expect(body).toMatchObject({ ok: true, user: { email: "owner@example.test" } });
    });
  });
});

type CreateAppOptions = {
  budget?: BudgetService | undefined;
  contextAssembly?: Pick<ContextAssemblyService, "assemble" | "portableCheckpoint"> | undefined;
  modelGovernance?: ModelGovernanceService | undefined;
  taskStore?: CloudTaskStore | undefined;
  runtimeConfig?: CloudRuntimeConfigService | undefined;
  usageRepository?: UsageRepository | undefined;
  identityRepository?: EnterpriseIdentityRepository | undefined;
  membershipActive?: boolean | undefined;
  durableTurns?: {
    enabled: boolean;
    replayAdmission: (input: DurableTurnAdmissionReplay) => Promise<{ runId: string; sessionId: string } | null>;
    beginAdmission?: DurableTurnService["beginAdmission"];
    admit: (input: DurableTurnAdmission) => Promise<{ runId: string; sessionId: string }>;
    cancel?: DurableTurnService["cancel"];
    state?: DurableTurnService["state"];
    taskActivity?: DurableTurnService["taskActivity"];
  } | undefined;
};

async function createApp(
  sessionHost: SessionHost,
  options: CreateAppOptions = {},
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [
      CloudDatabaseModule.register({
        useValue: {
          execute: async () => undefined,
          query: async <T,>(sql: string): Promise<readonly T[]> =>
            (sql.includes("FROM workspaces") ? [{ id: "workspace_cloud" }] : []) as T[],
        },
      }),
      AgentApiModule.register({
      sessionHost: { useValue: sessionHost },
      auth: { useValue: fakeAuthRuntime(options.membershipActive ?? true) },
      ...(options.identityRepository ? { identity: { repository: { useValue: options.identityRepository } } } : {}),
      ...(options.taskStore ? { taskStore: { useValue: options.taskStore } } : {}),
      ...(options.budget ? { budget: { service: { useValue: options.budget } } } : {}),
      ...(options.usageRepository ? { usage: { repository: { useValue: options.usageRepository } } } : {}),
      ...(options.modelGovernance ? { modelGovernance: { service: { useValue: options.modelGovernance } } } : {}),
      }),
    ],
  })
    .overrideProvider(FilePlatformService)
    .useValue(fakeFilePlatformService)
    .overrideProvider(CloudRuntimeConfigService)
    .useValue(options.runtimeConfig ?? new CloudRuntimeConfigService());
  if (options.durableTurns) {
    builder = builder.overrideProvider(DurableTurnService).useValue({
      ...options.durableTurns,
      beginAdmission: options.durableTurns.beginAdmission ?? (async () => null),
      state: options.durableTurns.state ?? (async () => ({ active: false, turnId: null, bufferedEvents: [], replayOnly: false })),
      taskActivity: options.durableTurns.taskActivity ?? (async () => new Map()),
    });
  }
  if (options.contextAssembly) {
    builder = builder.overrideProvider(ContextAssemblyService).useValue(options.contextAssembly);
  }
  const moduleRef = await builder.compile();
  const nestApp = moduleRef.createNestApplication();
  await nestApp.init();
  return nestApp;
}

const fakeFilePlatformService = {
  runtimeAttachments: async (_tenantId: string, _userId: string, attachments: unknown[]) => attachments,
  associateInputFiles: async () => undefined,
};

function imageRuntimeConfig(): CloudRuntimeConfigService {
  return new CloudRuntimeConfigService({
    ...chatRuntimeEnv(),
    BERRY_SANDBOX_CWD: "/home/user/workspace",
    BERRY_ROUTER_IMAGE_MODEL: "openai/gpt-image-2",
    BERRY_ROUTER_IMAGE_COST_MICROS: "10",
  });
}

function chatRuntimeConfig(): CloudRuntimeConfigService {
  return new CloudRuntimeConfigService(chatRuntimeEnv());
}

function promptImprovementRuntimeConfig(): CloudRuntimeConfigService {
  return new CloudRuntimeConfigService({
    ...chatRuntimeEnv(),
    BERRY_ROUTER_API_KEY: "router-test-key",
    BERRY_ROUTER_DEFAULT_MODEL: PROMPT_IMPROVEMENT_MODEL,
    BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
      id: PROMPT_IMPROVEMENT_MODEL,
      name: "DeepSeek V4 Flash",
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      capabilities: {
        tools: true,
        reasoning: true,
        json: true,
        cost: { input: 0.14, output: 0.28, cacheRead: 0.03 },
      },
    }]),
  });
}

function visionRuntimeConfig(): CloudRuntimeConfigService {
  return new CloudRuntimeConfigService({
    ...chatRuntimeEnv(),
    BERRY_ROUTER_DEFAULT_MODEL: "deepseek-v4-flash",
    BERRY_ROUTER_MODELS_JSON: JSON.stringify([
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        capabilities: { vision: false, cost: { input: 0.14, output: 0.28, cacheRead: 0.03 } },
      },
      {
        id: "minimax-m3",
        name: "MiniMax M3",
        contextWindow: 1_000_000,
        maxOutputTokens: 524_288,
        capabilities: { vision: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.06 } },
      },
    ]),
  });
}

function chatRuntimeEnv(): NodeJS.ProcessEnv {
  return {
    BERRY_API_MODEL_MODE: "live",
    BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
    BERRY_ROUTER_PROVIDER_ID: "router",
    BERRY_ROUTER_DEFAULT_MODEL: "chat-model",
    BERRY_ROUTER_MODELS_JSON: JSON.stringify([{ id: "chat-model", name: "Chat Model" }]),
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function admissionMetricCount(outcome: string, status: string): number {
  const prefix = `berry_api_turn_admissions_total{outcome="${outcome}",status="${status}"} `;
  const line = apiRuntimeMetrics.render().split("\n").find((candidate) => candidate.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

function authHeader(token = "berry-test-session") {
  return { Authorization: `Bearer ${token}` };
}

function fakeAuthRuntime(membershipActive = true): BerryAuthRuntime {
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
      signupEnabled: false,
      setup: { required: false, available: false, ownerEmail: null, missingConfiguration: [] },
      socialProviders: ["github"],
      storage: "memory",
    }),
    setupOwner: async (input) => {
      const body = input as { name: string; email: string };
      return {
        ok: true,
        user: { id: "user_owner", email: body.email, name: body.name },
        organization: { id: "org_1", name: "Acme" },
      };
    },
    getSession,
    requireSession: async (headers) => {
      const session = await getSession(headers);
      if (!session) throw new UnauthorizedException("Authentication required");
      return session;
    },
    authorizeSession: async () => membershipActive,
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
    fork: async () => ({ sessionId: "session_fork" }),
    rewind: async () => {},
    rewindForEdit: async () => {},
    compact: async () => ({ summary: "summary", tokensBefore: 1 }),
    listLoadedSkills: () => [],
    dispose: async () => {},
    ...overrides,
  } as SessionHost;
}
