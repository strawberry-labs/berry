import { describe, expect, it } from "vitest";
import {
  InMemoryModelGovernanceRepository,
  ModelGovernanceService,
  type ModelGovernanceRepository,
} from "./model-governance.service.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000201";
const departmentId = "00000000-0000-7000-8000-000000000301";

describe("model governance scoped access", () => {
  it("lets a user exception override a department default below the organization ceiling", async () => {
    const service = await modelService();
    await service.upsertAccessRule(tenantId, rule("department", departmentId, "blocked"));

    expect(await resolve(service)).toMatchObject({
      allowed: false,
      reason: "blocked_by_department_rule",
    });

    await service.upsertAccessRule(tenantId, rule("user", userId, "allowed"));
    expect(await resolve(service)).toMatchObject({
      allowed: true,
      reason: "allowed_by_user_rule",
      accessRule: { scopeType: "user", scopeId: userId },
    });
  });

  it("never lets a department or user allow bypass an organization block", async () => {
    const service = await modelService();
    await service.upsertAccessRule(tenantId, rule("org", tenantId, "blocked"));
    await service.upsertAccessRule(tenantId, rule("department", departmentId, "allowed"));
    await service.upsertAccessRule(tenantId, rule("user", userId, "allowed"));

    expect(await resolve(service)).toMatchObject({
      allowed: false,
      enforced: true,
      reason: "blocked_by_organization_rule",
      accessRule: { scopeType: "org", scopeId: tenantId },
    });
  });

  it("persists runtime models and replaces the stale seeded default", async () => {
    const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository());
    await service.synchronizeRuntimeCatalog(tenantId, {
      id: "router",
      name: "Berry Router",
      kind: "berry-router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-chat-completions",
      defaultModel: "kimi-2.6",
      models: [
        { id: "kimi-2.6", name: "Kimi 2.6", capabilities: { tools: true, reasoning: true } },
        { id: "glm-5.2", name: "GLM 5.2", capabilities: { tools: true, reasoning: true } },
      ],
    });

    expect(await service.listDefaults(tenantId)).toEqual([
      expect.objectContaining({ mode: "chat", providerId: "router", model: "kimi-2.6" }),
      expect.objectContaining({ mode: "code", providerId: "router", model: "kimi-2.6" }),
    ]);
    expect(await service.resolve({ tenantId, mode: "chat", providerId: "router" })).toMatchObject({
      allowed: true,
      model: "kimi-2.6",
    });
    expect((await service.listModels(tenantId)).map((model) => model.model)).toEqual(expect.arrayContaining(["kimi-2.6", "glm-5.2"]));
    expect(await service.resolve({ tenantId, mode: "chat", providerId: "router", model: "berry/auto" })).toMatchObject({
      allowed: false,
      reason: "model_blocked",
    });
    expect(await service.listModels(tenantId, { includeBlocked: true })).toContainEqual(
      expect.objectContaining({
        model: "berry/auto",
        status: "blocked",
        metadata: expect.objectContaining({ retiredReason: "not-in-runtime-catalog" }),
      }),
    );
  });

  it("synchronizes Gemini 3.7 Flash with its runtime capabilities and cost hints", async () => {
    const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository());
    const defaultModel = "canopywave/deepseek/deepseek-v4-flash";
    await service.synchronizeRuntimeCatalog(tenantId, {
      id: "router",
      name: "Berry Router",
      kind: "berry-router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-chat-completions",
      defaultModel,
      models: [
        { id: defaultModel, name: "DeepSeek V4 Flash" },
        {
          id: "google-vertex/gemini-3.7-flash",
          name: "Gemini 3.7 Flash",
          ownedBy: "google",
          apiType: "openai-chat-completions",
          family: "gemini-3.7",
          contextWindow: 1_048_576,
          maxOutputTokens: 65_536,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          capabilities: {
            tools: true,
            vision: true,
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"],
            json: true,
            cost: { input: 0.75, output: 3.75, cacheRead: 0.075 },
          },
        },
      ],
    });

    expect(await service.listDefaults(tenantId)).toEqual([
      expect.objectContaining({ mode: "chat", providerId: "router", model: defaultModel }),
      expect.objectContaining({ mode: "code", providerId: "router", model: defaultModel }),
    ]);
    expect(await service.listModels(tenantId)).toContainEqual(expect.objectContaining({
      model: "google-vertex/gemini-3.7-flash",
      displayName: "Gemini 3.7 Flash",
      apiType: "openai-chat-completions",
      status: "allowed",
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
        json: true,
        context: { windowTokens: 1_048_576, maxOutputTokens: 65_536 },
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075 },
      },
    }));
  });

  it("synchronizes Qwen 3.8 Flash Next with its runtime limits and cost hints", async () => {
    const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository());
    const defaultModel = "canopywave/deepseek/deepseek-v4-flash";
    await service.synchronizeRuntimeCatalog(tenantId, {
      id: "router",
      name: "Berry Router",
      kind: "berry-router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-chat-completions",
      defaultModel,
      models: [
        { id: defaultModel, name: "DeepSeek V4 Flash" },
        {
          id: "canopywave/qwen/qwen3.8-flash-next",
          name: "Qwen 3.8 Flash Next",
          ownedBy: "qwen",
          apiType: "openai-chat-completions",
          family: "qwen3.8",
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          capabilities: {
            tools: true,
            vision: true,
            reasoning: true,
            json: true,
            cost: { input: 0.15, output: 0.5, cacheRead: 0.02 },
          },
        },
      ],
    });

    expect(await service.listModels(tenantId)).toContainEqual(expect.objectContaining({
      model: "canopywave/qwen/qwen3.8-flash-next",
      displayName: "Qwen 3.8 Flash Next",
      apiType: "openai-chat-completions",
      status: "allowed",
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        json: true,
        context: { windowTokens: 1_000_000, maxOutputTokens: 128_000 },
        cost: { input: 0.15, output: 0.5, cacheRead: 0.02 },
      },
    }));
  });

  it("does not rewrite an unchanged jsonb policy when object keys are reordered", async () => {
    const base = new InMemoryModelGovernanceRepository(false);
    await base.upsertPolicy({
      tenantId,
      providerId: "router",
      model: "kimi-2.6",
      displayName: "Kimi 2.6",
      presetId: "berry-router",
      apiType: "openai-chat-completions",
      capabilities: { vision: true, tools: true },
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
      metadata: { source: "runtime-catalog" },
    });
    let policyWrites = 0;
    const repository: ModelGovernanceRepository = {
      listProviders: (id) => base.listProviders(id),
      upsertProvider: (id, input) => base.upsertProvider(id, input),
      updateProviderHealth: (id, providerId, status, testedAt) => base.updateProviderHealth(id, providerId, status, testedAt),
      listAccessRules: (id, resource) => base.listAccessRules(id, resource),
      upsertAccessRule: (id, input) => base.upsertAccessRule(id, input),
      listPolicies: (id) => base.listPolicies(id),
      upsertPolicy: async (input) => {
        policyWrites += 1;
        return base.upsertPolicy(input);
      },
      listDefaults: (id) => base.listDefaults(id),
      upsertDefault: (input) => base.upsertDefault(input),
      listAuxiliaryDefaults: (id) => base.listAuxiliaryDefaults(id),
      upsertAuxiliaryDefault: (input) => base.upsertAuxiliaryDefault(input),
    };
    const service = new ModelGovernanceService(repository);

    await service.synchronizeRuntimeCatalog(tenantId, {
      id: "router",
      name: "Berry Router",
      kind: "berry-router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-chat-completions",
      defaultModel: "kimi-2.6",
      models: [{ id: "kimi-2.6", name: "Kimi 2.6", capabilities: { tools: true, vision: true } }],
    });

    expect(policyWrites).toBe(0);
  });

  it("accepts only allowed vision-capable auxiliary defaults", async () => {
    const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository(false));
    await service.upsertPolicy({
      tenantId,
      providerId: "router",
      model: "minimax-m3",
      capabilities: { vision: true },
      status: "allowed",
      modeAllow: [],
    });
    await service.upsertPolicy({
      tenantId,
      providerId: "router",
      model: "deepseek-v4-flash",
      capabilities: { vision: false },
      status: "allowed",
    });

    await expect(service.upsertAuxiliaryDefault({
      tenantId,
      purpose: "vision",
      providerId: "router",
      model: "minimax-m3",
    })).resolves.toMatchObject({ purpose: "vision", model: "minimax-m3" });
    await expect(service.resolve({
      tenantId,
      mode: "chat",
      providerId: "router",
      model: "minimax-m3",
    })).resolves.toMatchObject({ allowed: false, reason: "mode_not_allowed" });
    await expect(service.resolveAuxiliary({
      tenantId,
      purpose: "vision",
      mode: "chat",
    })).resolves.toMatchObject({ allowed: true, model: "minimax-m3" });
    await expect(service.upsertAuxiliaryDefault({
      tenantId,
      purpose: "vision",
      providerId: "router",
      model: "deepseek-v4-flash",
    })).rejects.toThrow("must declare vision support");
  });

  it("maps non-empty legacy mode allowlists to the unified task while preserving empty deny", async () => {
    const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository(false));
    await service.upsertPolicy({
      tenantId,
      providerId: "router",
      model: "legacy-code-only",
      status: "allowed",
      modeAllow: ["code"],
    });
    await service.upsertPolicy({
      tenantId,
      providerId: "router",
      model: "legacy-denied",
      status: "allowed",
      modeAllow: [],
    });

    await expect(service.resolve({ tenantId, mode: "chat", providerId: "router", model: "legacy-code-only" }))
      .resolves.toMatchObject({ allowed: true, model: "legacy-code-only" });
    await expect(service.resolve({ tenantId, mode: "chat", providerId: "router", model: "legacy-denied" }))
      .resolves.toMatchObject({ allowed: false, reason: "mode_not_allowed" });
  });

  it("stores chat defaults as overridable while preserving code enforcement", async () => {
    const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository(false));

    await expect(service.upsertDefault({
      tenantId,
      mode: "chat",
      providerId: "router",
      model: "organization-default",
      enforce: true,
    })).resolves.toMatchObject({ mode: "chat", enforce: false });
    await expect(service.upsertDefault({
      tenantId,
      mode: "code",
      providerId: "router",
      model: "organization-code-default",
      enforce: true,
    })).resolves.toMatchObject({ mode: "code", enforce: true });
  });

  it("ignores legacy chat-default enforcement without weakening policies or code defaults", async () => {
    const repository = new InMemoryModelGovernanceRepository(false);
    await repository.upsertPolicy({
      tenantId,
      providerId: "router",
      model: "organization-default",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
    });
    await repository.upsertPolicy({
      tenantId,
      providerId: "failover",
      model: "browser-choice",
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
    });
    // Seed through the repository to reproduce a row written before chat
    // defaults became explicitly overridable.
    await repository.upsertDefault({
      tenantId,
      mode: "chat",
      providerId: "router",
      model: "organization-default",
      enforce: true,
    });
    await repository.upsertDefault({
      tenantId,
      mode: "code",
      providerId: "router",
      model: "organization-default",
      enforce: true,
    });
    const service = new ModelGovernanceService(repository);

    await expect(service.resolve({
      tenantId,
      mode: "chat",
      providerId: "failover",
      model: "browser-choice",
    })).resolves.toMatchObject({
      allowed: true,
      enforced: false,
      providerId: "failover",
      model: "browser-choice",
    });
    await expect(service.resolve({
      tenantId,
      mode: "code",
      providerId: "failover",
      model: "browser-choice",
    })).resolves.toMatchObject({
      allowed: false,
      enforced: true,
      reason: "mode_default_enforced",
    });

    await repository.upsertPolicy({
      tenantId,
      providerId: "failover",
      model: "browser-choice",
      status: "blocked",
      enforce: true,
      modeAllow: ["chat", "code"],
    });
    await expect(service.resolve({
      tenantId,
      mode: "chat",
      providerId: "failover",
      model: "browser-choice",
    })).resolves.toMatchObject({
      allowed: false,
      enforced: true,
      reason: "model_blocked",
    });
  });
});

async function modelService() {
  const service = new ModelGovernanceService(new InMemoryModelGovernanceRepository(false));
  await service.upsertPolicy({
    tenantId,
    providerId: "openai",
    model: "gpt-test",
    status: "allowed",
    modeAllow: ["chat", "code"],
  });
  return service;
}

function rule(
  scopeType: "org" | "department" | "user",
  scopeId: string,
  effect: "allowed" | "blocked",
) {
  return {
    scopeType,
    scopeId,
    resourceType: "model" as const,
    resourceId: "openai:gpt-test",
    effect,
  };
}

function resolve(service: ModelGovernanceService) {
  return service.resolve({
    tenantId,
    mode: "chat",
    providerId: "openai",
    model: "gpt-test",
    userId,
    departmentId,
  });
}
