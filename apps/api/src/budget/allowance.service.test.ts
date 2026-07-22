import { describe, expect, it } from "vitest";
import { AllowanceService, InMemoryAllowanceRepository } from "./allowance.service.ts";
import { BudgetService, InMemoryBudgetHotCounters, InMemoryBudgetRepository } from "./budget.service.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000201";

function service(repository = new InMemoryAllowanceRepository()) {
  const budgets = new BudgetService({ repository: new InMemoryBudgetRepository([
    { tenantId, scopeType: "org", scopeId: tenantId, period: "month", softLimitMicros: "8000", hardLimitMicros: "10000", requestLimit: 1000, status: "active" },
    { tenantId, scopeType: "department", scopeId: "dept_1", period: "month", softLimitMicros: "4000", hardLimitMicros: "5000", requestLimit: 500, status: "active" },
    { tenantId, scopeType: "user", scopeId: userId, period: "month", softLimitMicros: "1500", hardLimitMicros: "2000", requestLimit: 200, status: "active" },
  ]), hotCounters: new InMemoryBudgetHotCounters(), enabled: true });
  return { allowances: new AllowanceService(repository, budgets), budgets };
}

describe("allowance provisioning", () => {
  it("uses the most restrictive applicable limit and includes reserved spend", async () => {
    const repository = new InMemoryAllowanceRepository();
    repository.usageFor = async () => ({ used: "500", reserved: "250" });
    const { allowances } = service(repository);
    const effective = await allowances.effective(tenantId, userId, ["dept_1"], "cost", "month");
    expect(effective).toMatchObject({ effectiveValue: "2000", used: "500", reserved: "250", available: "1250", status: "healthy" });
    expect(effective.trace).toHaveLength(3);
    expect(effective.trace.find((entry) => entry.winning)).toMatchObject({ scopeType: "user", reason: "Most restrictive applicable limit" });
  });

  it("dry-runs and idempotently applies a deterministic bulk mutation", async () => {
    const { allowances, budgets } = service();
    const input = { idempotencyKey: "bulk-key-123", reason: "Quarterly allocation", dryRun: false, items: [
      { scopeType: "user" as const, scopeId: "user_2", period: "month" as const, softLimitMicros: "900", hardLimitMicros: "1000", tokenLimit: 20000 },
    ] };
    const first = await allowances.bulk(tenantId, input);
    const repeated = await allowances.bulk(tenantId, { ...input, items: [{ ...input.items[0]!, hardLimitMicros: "9999" }] });
    expect(first).toEqual(repeated);
    expect(first.results).toEqual([{ scopeType: "user", scopeId: "user_2", status: "applied", message: null }]);
    expect((await budgets.listLimits(tenantId)).find((limit) => limit.scopeId === "user_2")).toMatchObject({ hardLimitMicros: "1000", tokenLimit: 20000 });
  });

  it("validates profiles and returns inherited request quotas", async () => {
    const { allowances } = service();
    const profile = await allowances.upsertProfile(tenantId, null, { name: "Standard", description: "$25 monthly", period: "month", softLimitMicros: "2000", hardLimitMicros: "2500", requestLimit: 250, tokenLimit: null, sandboxMinuteLimit: null, thresholdPercentages: [80, 100], status: "active" });
    expect((await allowances.listProfiles(tenantId))[0]?.id).toBe(profile.id);
    await expect(allowances.effective(tenantId, userId, ["dept_1"], "requests", "month")).resolves.toMatchObject({ effectiveValue: "200" });
  });
});
