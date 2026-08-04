import { SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it, vi } from "vitest";
import {
  BudgetService,
  InMemoryBudgetHotCounters,
  InMemoryBudgetRepository,
  PostgresBudgetRepository,
  allowanceCycleWindow,
  budgetEstimateFromRequest,
  usageCostMicros,
} from "./budget.service.ts";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.ts";

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

  it("uses exact provider usage cost, preserves explicit zero pricing, and falls back when pricing is absent", () => {
    const usage = {
      kind: "usage" as const,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };

    expect(usageCostMicros({ ...usage, costRawMicros: "7" }, 99n, {})).toBe(7n);
    expect(usageCostMicros(usage, 99n, { cost: { input: 0, output: 0 } })).toBe(0n);
    expect(usageCostMicros(usage, 99n, {})).toBe(99n);
  });

  it("computes anchored monthly cycles in the organization timezone", () => {
    const window = allowanceCycleWindow(
      { timezone: "Asia/Dubai", anchorDay: 15 },
      new Date("2026-08-04T12:00:00.000Z"),
    );
    expect(window.start.toISOString()).toBe("2026-07-14T20:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-08-14T20:00:00.000Z");
  });

  it("makes a current-cycle member top-up enforceable immediately", async () => {
    const repository = new InMemoryBudgetRepository([
      activeLimit("user", "user_1", "5"),
    ]);
    const service = new BudgetService({
      repository,
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });

    await service.reserve({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: "before-top-up",
      userId: "user_1",
      taskId: null,
      sessionId: null,
      feature: "model",
      estimatedCostMicros: "5",
    });
    await service.createAllowanceAdjustment({
      tenantId: SELF_HOST_TENANT_ID,
      userId: "user_1",
      amountMicros: "3",
      reason: "Approved temporary increase",
      idempotencyKey: "top-up-test-1",
      createdBy: "owner_1",
    });

    await expect(
      service.reserve({
        tenantId: SELF_HOST_TENANT_ID,
        requestId: "after-top-up",
        userId: "user_1",
        taskId: null,
        sessionId: null,
        feature: "model",
        estimatedCostMicros: "3",
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(service.allowanceBalance(SELF_HOST_TENANT_ID, "user_1"))
      .resolves.toMatchObject({
        baseLimitMicros: "5",
        adjustmentMicros: "3",
        effectiveLimitMicros: "8",
        availableMicros: "0",
      });
  });

  it("sets and clears a recurring member base override", async () => {
    const repository = new InMemoryBudgetRepository();
    const service = new BudgetService({
      repository,
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });

    await service.setMemberAllowanceBase(
      SELF_HOST_TENANT_ID,
      "user_1",
      "20000000",
      "owner_1",
    );
    await expect(service.allowanceBalance(SELF_HOST_TENANT_ID, "user_1"))
      .resolves.toMatchObject({
        baseLimitMicros: "20000000",
        baseSource: "member",
        baseSourceId: "user_1",
      });

    await service.setMemberAllowanceBase(
      SELF_HOST_TENANT_ID,
      "user_1",
      null,
      "owner_1",
    );
    await expect(service.allowanceBalance(SELF_HOST_TENANT_ID, "user_1"))
      .resolves.toMatchObject({
        baseLimitMicros: null,
        baseSource: "unlimited",
        baseSourceId: null,
      });
  });

  it("loads balances for many members with one grouped spend query", async () => {
    const repository = new InMemoryBudgetRepository([
      activeLimit("user", "user_1", "10"),
      activeLimit("user", "user_2", "20"),
    ]);
    const groupedSpend = vi.spyOn(repository, "currentUserSpendForUsers");
    const service = new BudgetService({
      repository,
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });

    await expect(service.allowanceBalances(SELF_HOST_TENANT_ID, ["user_1", "user_2"]))
      .resolves.toMatchObject([
        { userId: "user_1", baseLimitMicros: "10" },
        { userId: "user_2", baseLimitMicros: "20" },
      ]);
    expect(groupedSpend).toHaveBeenCalledOnce();
    expect(groupedSpend.mock.calls[0]?.[1]).toEqual(["user_1", "user_2"]);
  });

  it("attributes reconciliation deltas to the reservation's original cycle", async () => {
    const createdAt = "2026-07-31T23:59:59.000Z";
    const reservation = {
      id: "00000000-0000-7000-8000-000000000301",
      tenant_id: SELF_HOST_TENANT_ID,
      request_id: "cycle-boundary-request",
      user_id: "00000000-0000-7000-8000-000000000201",
      department_id: null,
      task_id: null,
      session_id: null,
      feature: "model",
      provider: "router",
      model: "model-a",
      estimated_cost_micros: "10",
      reserved_micros: "10",
      actual_cost_micros: null,
      status: "reserved",
      block_reason: null,
      metadata: {},
      created_at: createdAt,
      updated_at: createdAt,
    };
    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => undefined);
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.startsWith("SELECT * FROM budget_reservations")) return [reservation];
      if (sql.includes("UPDATE budget_reservations")) {
        return [{ ...reservation, actual_cost_micros: "4", status: "reconciled" }];
      }
      if (sql.includes("FROM allowance_cycle_settings")) return [];
      if (sql.includes("FROM credit_ledger_entries")) return [{ total: "10" }];
      return [];
    });
    const executor: SqlExecutor = {
      execute,
      query: query as SqlExecutor["query"],
      transaction: async (callback) => callback(executor),
    };
    const repository = new PostgresBudgetRepository(new CloudDatabaseService(executor));

    await repository.reconcile({
      tenantId: SELF_HOST_TENANT_ID,
      requestId: "cycle-boundary-request",
      actualCostMicros: "4",
    });

    const monthlyLedgerRead = query.mock.calls.find(([sql, params]) =>
      sql.includes("FROM credit_ledger_entries")
      && params?.[3] === "2026-07-01T00:00:00.000Z",
    );
    expect(monthlyLedgerRead?.[1]?.[4]).toBe("2026-08-01T00:00:00.000Z");
    const reconcileWrites = execute.mock.calls.filter(([sql]) => sql.includes("'reconcile'"));
    expect(reconcileWrites).toHaveLength(2);
    expect(reconcileWrites.every(([, params]) => params?.[8] === createdAt)).toBe(true);
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
