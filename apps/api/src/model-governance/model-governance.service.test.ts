import { describe, expect, it } from "vitest";
import {
  InMemoryModelGovernanceRepository,
  ModelGovernanceService,
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
