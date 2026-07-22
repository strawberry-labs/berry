import { SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it } from "vitest";
import {
  BudgetService,
  InMemoryBudgetHotCounters,
  InMemoryBudgetRepository,
  budgetEstimateFromRequest,
} from "./budget.service.ts";

describe("BudgetService", () => {
  it("enforces request and token quotas using the most restrictive applicable scope", async () => {
    const repository = new InMemoryBudgetRepository([
      { tenantId: SELF_HOST_TENANT_ID, scopeType: "org", scopeId: SELF_HOST_TENANT_ID, period: "month", softLimitMicros: "100000", hardLimitMicros: "100000", requestLimit: 10, tokenLimit: 1000, status: "active" },
      { tenantId: SELF_HOST_TENANT_ID, scopeType: "user", scopeId: "user_1", period: "month", softLimitMicros: "100000", hardLimitMicros: "100000", requestLimit: 1, tokenLimit: 100, status: "active" },
    ]);
    const service = new BudgetService({ repository, hotCounters: new InMemoryBudgetHotCounters(), enabled: true });
    await expect(service.reserve({ tenantId: SELF_HOST_TENANT_ID, requestId: "quota-1", userId: "user_1", taskId: null, sessionId: null, feature: "model", estimatedCostMicros: "1", estimatedTokens: 80 })).resolves.toMatchObject({ allowed: true });
    await expect(service.reserve({ tenantId: SELF_HOST_TENANT_ID, requestId: "quota-2", userId: "user_1", taskId: null, sessionId: null, feature: "model", estimatedCostMicros: "1", estimatedTokens: 30 })).rejects.toMatchObject({ response: expect.objectContaining({ code: "budget_exceeded" }) });
  });
  it("reserves and reconciles against org, department, and user hard limits", async () => {
    const repository = new InMemoryBudgetRepository([
      activeLimit("org", SELF_HOST_TENANT_ID, "10"),
      activeLimit("department", "dept_1", "5"),
      activeLimit("user", "user_1", "5"),
    ]);
    const service = new BudgetService({ repository, hotCounters: new InMemoryBudgetHotCounters(), enabled: true });

    await expect(service.reserve({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: "req_1",
      userId: "user_1",
      departmentId: "dept_1",
      taskId: "task_1",
      sessionId: "session_1",
      feature: "model",
      estimatedCostMicros: "3",
    })).resolves.toMatchObject({ allowed: true });

    await service.reconcile({ tenantId: SELF_HOST_TENANT_ID, requestId: "req_1", actualCostMicros: "2" });

    await expect(service.reserve({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: "req_2",
      userId: "user_1",
      departmentId: "dept_1",
      taskId: "task_1",
      sessionId: "session_1",
      feature: "model",
      estimatedCostMicros: "4",
    })).rejects.toMatchObject({
      status: 402,
      response: expect.objectContaining({ code: "budget_exceeded" }),
    });
  });

  it("fails closed when hot counters are unhealthy", async () => {
    const service = new BudgetService({
      repository: new InMemoryBudgetRepository(),
      hotCounters: new InMemoryBudgetHotCounters(() => false),
      enabled: true,
      failClosed: true,
    });

    await expect(service.reserve({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: "req_unhealthy",
      userId: "user_1",
      taskId: "task_1",
      sessionId: "session_1",
      feature: "model",
      estimatedCostMicros: "1",
    })).rejects.toMatchObject({
      status: 402,
      response: expect.objectContaining({ code: "budget_exceeded", message: expect.stringContaining("fail-closed") }),
    });
  });

  it("allows soft-limit overages while returning an explanatory warning", async () => {
    const repository = new InMemoryBudgetRepository([{
      ...activeLimit("org", SELF_HOST_TENANT_ID, "10"),
      softLimitMicros: "2",
    }]);
    const service = new BudgetService({ repository, hotCounters: new InMemoryBudgetHotCounters(), enabled: true });

    await expect(service.reserve({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: "req_soft",
      userId: "user_1",
      taskId: "task_1",
      sessionId: "session_1",
      feature: "model",
      estimatedCostMicros: "3",
    })).resolves.toMatchObject({
      allowed: true,
      reason: "org budget soft limit exceeded",
      limit: expect.objectContaining({ softLimitMicros: "2" }),
    });
  });

  it("does not oversubscribe concurrent reservations", async () => {
    const repository = new InMemoryBudgetRepository([
      activeLimit("org", SELF_HOST_TENANT_ID, "5"),
    ]);
    const service = new BudgetService({ repository, hotCounters: new InMemoryBudgetHotCounters(), enabled: true });

    const results = await Promise.allSettled([1, 2].map((index) => service.reserve({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: `req_${index}`,
      userId: "user_1",
      taskId: "task_1",
      sessionId: "session_1",
      feature: "model",
      estimatedCostMicros: "3",
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("estimates model calls from provider price hints", () => {
    expect(budgetEstimateFromRequest({ provider: { cost: { input: 0.25, output: 0.75 } }, model: "test" })).toBe(4000n);
    expect(budgetEstimateFromRequest({ provider: { models: [{ id: "priced", capabilities: { cost: { input: 0.5, output: 1 } } }] }, model: "priced" })).toBe(6000n);
    expect(budgetEstimateFromRequest({ provider: {}, model: "test" })).toBe(1n);
  });
});

function activeLimit(scopeType: "org" | "department" | "user", scopeId: string, hardLimitMicros: string) {
  return {
    tenantId: SELF_HOST_TENANT_ID,
    scopeType,
    scopeId,
    period: "month" as const,
    softLimitMicros: "0",
    hardLimitMicros,
    status: "active" as const,
  };
}
