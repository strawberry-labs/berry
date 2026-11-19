import { describe, expect, it } from "vitest";
import type { UsageAnalytics } from "@berry/shared";
import type { WebConfig } from "./config";
import { DEMO_MANAGEMENT_METHODS, createDemoManagementClient } from "./demo-management-client";
import { createLazyDemoManagementClient } from "./demo-management-client.lazy";

const TENANT = "00000000-0000-7000-8000-000000000001";
const DAY = 86_400_000;

const config = {
  workspaceId: "workspace-demo",
  organizations: [{ id: TENANT, slug: "self-host", name: "Berry Self-Host", deploymentMode: "selfhost", plan: "selfhost", status: "active", role: "owner", hostname: "localhost" }],
  rolePermissions: [],
} as unknown as WebConfig;

const client = createDemoManagementClient(config, TENANT);
const range = (days: number) => ({ from: new Date(Date.now() - days * DAY).toISOString(), to: new Date().toISOString(), limit: 50 });

const calls: Record<(typeof DEMO_MANAGEMENT_METHODS)[number], () => Promise<unknown>> = {
  usageAnalytics: () => client.usageAnalytics(TENANT, range(30)),
  usageRequests: () => client.usageRequests(TENANT, range(30)),
  usageRequestDetail: () => client.usageRequestDetail(TENANT, "ue_unknown"),
  myUsage: () => client.myUsage(TENANT, range(30)),
  myUsageRequests: () => client.myUsageRequests(TENANT, range(30)),
  exportMyUsageCsv: () => client.exportMyUsageCsv(TENANT, range(30)),
  savedAnalyticsViews: () => client.savedAnalyticsViews(TENANT),
  listOrgMembers: () => client.listOrgMembers(TENANT),
  listOrgMembersPage: () => client.listOrgMembersPage(TENANT, { limit: 25 }),
  listDepartments: () => client.listDepartments(TENANT),
  listDepartmentsPage: () => client.listDepartmentsPage(TENANT),
  listMemberMobileDevices: () => client.listMemberMobileDevices(TENANT, "usr_0001"),
  memberSkills: () => client.memberSkills(TENANT, "usr_0001"),
  authConfig: () => client.authConfig(),
  effectivePermissions: () => client.effectivePermissions(TENANT),
  organizationProfile: () => client.organizationProfile(TENANT),
  listRolePermissions: () => client.listRolePermissions(TENANT),
  listFeatureFlags: () => client.listFeatureFlags(TENANT),
  listResourceAcls: () => client.listResourceAcls(TENANT),
  listSsoConnections: () => client.listSsoConnections(TENANT),
  listPolicyVersions: () => client.listPolicyVersions(TENANT),
  listAuditEvents: () => client.listAuditEvents(TENANT, { limit: 100 }),
  serviceAccounts: () => client.serviceAccounts(TENANT),
  createServiceAccount: () => client.createServiceAccount(TENANT, { name: "Test account", permissions: ["org:read"], resourceRestrictions: [] }),
  executionPolicy: () => client.executionPolicy(TENANT),
  authenticationPolicy: () => client.authenticationPolicy(TENANT),
  dataGovernancePolicy: () => client.dataGovernancePolicy(TENANT),
  listBudgetLimits: () => client.listBudgetLimits(TENANT),
  listAllowanceProfiles: () => client.listAllowanceProfiles(TENANT),
  listAllowanceDefaults: () => client.listAllowanceDefaults(TENANT),
  allowanceCycle: () => client.allowanceCycle(TENANT),
  allowanceBalances: () => client.allowanceBalances(TENANT),
  myAllowanceBalance: () => client.myAllowanceBalance(TENANT),
  allowanceBalance: () => client.allowanceBalance(TENANT, "usr_0001"),
  allowanceAdjustments: () => client.allowanceAdjustments(TENANT),
  billingSummary: () => client.billingSummary(TENANT),
  billingHealth: () => client.billingHealth(TENANT),
  billingLedger: () => client.billingLedger(TENANT),
  autoRefill: () => client.autoRefill(TENANT),
  listOrganizationModelProviders: () => client.listOrganizationModelProviders(TENANT),
  testOrganizationModelProvider: () => client.testOrganizationModelProvider(TENANT, "anthropic"),
  listOrgTaskModels: () => client.listOrgTaskModels(TENANT, { includeBlocked: true }),
  listOrgModelDefaults: () => client.listOrgModelDefaults(TENANT),
  listOrgAuxiliaryModelDefaults: () => client.listOrgAuxiliaryModelDefaults(TENANT),
  listOrgAiAccessRules: () => client.listOrgAiAccessRules(TENANT),
  listOrganizationCapabilities: () => client.listOrganizationCapabilities(TENANT),
  organizationCapabilitySettings: () => client.organizationCapabilitySettings(TENANT),
  effectiveCapabilities: () => client.effectiveCapabilities(TENANT),
  organizationSkillPackage: () => client.organizationSkillPackage(TENANT, "code-review"),
  organizationSkillPackageFile: () => client.organizationSkillPackageFile(TENANT, "code-review", "SKILL.md"),
  listOrganizationConnectors: () => client.listOrganizationConnectors(TENANT),
  googleConnectorConfiguration: () => client.googleConnectorConfiguration(TENANT),
  listConnectors: () => client.listConnectors(),
  listConnectorRequests: () => client.listConnectorRequests(),
  listPersonalMcpServers: () => client.listPersonalMcpServers(),
  testPersonalMcpServer: () => client.testPersonalMcpServer("unknown"),
  listPersonalSkills: () => client.listPersonalSkills(),
  personalSkillPackage: () => client.personalSkillPackage("unknown"),
  listMemories: () => client.listMemories({ scope: "personal", status: "active", limit: 50 }),
  memorySettings: () => client.memorySettings(),
  exportMemories: () => client.exportMemories(),
  listArchivedTasksPage: () => client.listArchivedTasksPage({ state: "all", limit: 50 }),
  deleteAllArchivedTasks: () => client.deleteAllArchivedTasks(),
  listScheduledTasks: () => client.listScheduledTasks(),
  listScheduledTaskRuns: async () => client.listScheduledTaskRuns((await client.listScheduledTasks())[0]!.id),
  reportSchedules: () => client.reportSchedules(TENANT),
  reportRuns: () => client.reportRuns(TENANT),
  alertDestinations: () => client.alertDestinations(TENANT),
  alertRules: () => client.alertRules(TENANT),
  alertDeliveries: () => client.alertDeliveries(TENANT),
  platformOverview: () => client.platformOverview(),
  platformOrganizations: () => client.platformOrganizations(),
  platformBilling: () => client.platformBilling(),
  platformRouterHealth: () => client.platformRouterHealth(),
  platformRollouts: () => client.platformRollouts(),
};

function expectBreakdownMatchesTotals(analytics: UsageAnalytics, dimension: string) {
  const rows = analytics.breakdowns[dimension] ?? [];
  const sum = (read: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + read(row), 0);
  expect(rows.length).toBeGreaterThan(0);
  expect(sum((row) => row.tokens)).toBe(analytics.totals.tokens);
  expect(sum((row) => row.inputTokens)).toBe(analytics.totals.inputTokens);
  expect(sum((row) => row.outputTokens)).toBe(analytics.totals.outputTokens);
  expect(sum((row) => row.cacheReadTokens)).toBe(analytics.performance.cacheReadTokens);
  expect(sum((row) => row.requests)).toBe(analytics.totals.requests);
  expect(sum((row) => Number(row.billedCostMicros))).toBe(Number(analytics.totals.billedCostMicros));
}

describe("demo management client", () => {
  it.each(DEMO_MANAGEMENT_METHODS)("%s resolves with data", async (method) => {
    const value = await calls[method]();
    expect(value).not.toBeNull();
    expect(value).not.toBeUndefined();
    if (Array.isArray(value)) expect(value.length).toBeGreaterThan(0);
  });

  it("models a large organization whose breakdowns add up to the totals", async () => {
    const analytics = await client.usageAnalytics(TENANT, range(30));
    expect(analytics.totals.tokens).toBeGreaterThan(10_000_000_000);
    expect(analytics.totals.inputTokens).toBeGreaterThan(40_000_000_000);
    expect(analytics.totals.outputTokens).toBeGreaterThan(6_000_000_000);
    expect(analytics.totals.requests).toBeGreaterThan(3_000_000);
    expect(Number(analytics.totals.billedCostMicros) / 1e6).toBeGreaterThan(200_000);
    expect(Number(analytics.totals.billedCostMicros) / 1e6).toBeLessThan(225_000);
    expect(analytics.totals.successRate).toBeGreaterThan(0.98);
    expect(analytics.totals.successRate).toBeLessThan(0.992);
    for (const dimension of ["models", "departments", "members", "providers", "features", "agents", "workspaces", "statuses"]) {
      expectBreakdownMatchesTotals(analytics, dimension);
    }
    expect(analytics.breakdowns.models).toHaveLength(8);
    expect(analytics.breakdowns.departments).toHaveLength(12);
    expect(analytics.breakdowns.members?.filter((row) => row.email)).toHaveLength(25);
    expect(analytics.series.reduce((total, point) => total + point.requests, 0)).toBe(analytics.totals.requests);
    expect(analytics.anomalies.length).toBeGreaterThanOrEqual(2);
  });

  it("ends the daily series today and sizes it to the requested range", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const month = await client.usageAnalytics(TENANT, { from: `${new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`, to: `${today}T23:59:59.999Z`, limit: 50 });
    expect(month.series).toHaveLength(31);
    expect(month.series.at(-1)?.ts.slice(0, 10)).toBe(today);
    const week = await client.usageAnalytics(TENANT, range(7));
    const quarter = await client.usageAnalytics(TENANT, range(90));
    const day = await client.myUsage(TENANT, range(1));
    expect(week.series.length).toBeGreaterThanOrEqual(28);
    expect(week.series.length).toBeLessThanOrEqual(29);
    expect(quarter.series.length).toBeGreaterThanOrEqual(30);
    expect(quarter.series.length).toBeLessThanOrEqual(31);
    expect(day.series.length).toBeGreaterThanOrEqual(48);
    expect(quarter.totals.tokens).toBeGreaterThan(month.totals.tokens);
    expect(week.totals.tokens).toBeLessThan(month.totals.tokens);
  });

  it("narrows totals when a filter is applied", async () => {
    const all = await client.usageAnalytics(TENANT, range(30));
    const filtered = await client.usageAnalytics(TENANT, { ...range(30), model: "claude-sonnet-4-5" });
    expect(filtered.breakdowns.models).toHaveLength(1);
    expect(filtered.breakdowns.providers?.map((row) => row.id)).toEqual(["anthropic"]);
    expect(filtered.totals.requests).toBeLessThan(all.totals.requests);
    expectBreakdownMatchesTotals(filtered, "departments");
  });

  it("returns fifty varied requests and a matching detail", async () => {
    const page = await client.usageRequests(TENANT, range(30));
    expect(page.items).toHaveLength(50);
    expect(new Set(page.items.map((row) => row.model)).size).toBeGreaterThan(3);
    expect(page.items.some((row) => row.status !== "completed")).toBe(true);
    const first = page.items[0]!;
    const detail = await client.usageRequestDetail(TENANT, first.id);
    expect(detail.requestId).toBe(first.requestId);
    expect(detail.billedCostMicros).toBe(first.billedCostMicros);
    expect(Object.keys(detail.safeMetadata).length).toBeGreaterThan(3);
  });

  it("gives one heavy personal user", async () => {
    const mine = await client.myUsage(TENANT, range(30));
    expect(mine.totals.tokens).toBeGreaterThan(290_000_000);
    expect(mine.totals.tokens).toBeLessThan(330_000_000);
    expect(mine.totals.requests).toBeGreaterThan(9_000);
    expectBreakdownMatchesTotals(mine, "models");
  });

  it("keeps directory, allowance and billing data consistent", async () => {
    const [members, departments, balances, summary, ledger, audit] = await Promise.all([
      client.listOrgMembers(TENANT), client.listDepartments(TENANT), client.allowanceBalances(TENANT), client.billingSummary(TENANT), client.billingLedger(TENANT), client.listAuditEvents(TENANT, { limit: 100 }),
    ]);
    expect(members).toHaveLength(1_850);
    expect(new Set(members.map((member) => member.email)).size).toBe(1_850);
    expect(new Set(members.map((member) => member.userId)).size).toBe(1_850);
    expect(departments).toHaveLength(12);
    const memberIds = new Set(members.map((member) => member.userId));
    expect(audit.every((event) => event.actorUserId === null || memberIds.has(event.actorUserId))).toBe(true);
    const departmentIds = new Set(departments.map((department) => department.id));
    expect(members.every((member) => member.departmentIds.every((id) => departmentIds.has(id)))).toBe(true);
    expect(balances.map((balance) => balance.userId)).toEqual(members.map((member) => member.userId));
    expect(new Set(balances.map((balance) => balance.status)).size).toBeGreaterThanOrEqual(3);
    expect(ledger.items[0]?.balanceAfterMicros).toBe(summary.prepaidBalanceMicros);
    expect(Number(summary.prepaidBalanceMicros)).toBeGreaterThan(0);
    expect(audit.length).toBeGreaterThanOrEqual(60);
  });

  it("lists the whole organization with a realistic status and activity mix", async () => {
    const members = await client.listOrgMembers(TENANT);
    const count = (status: string) => members.filter((member) => member.status === status).length;
    expect(count("pending")).toBe(40);
    expect(count("disabled") + count("deprovisioned")).toBe(25);
    expect(count("active")).toBe(1_785);
    const dormant = members.filter((member) => member.status === "active" && Date.now() - new Date(member.updatedAt).getTime() > 30 * DAY);
    expect(dormant.length).toBeGreaterThan(150);
    expect(dormant.length).toBeLessThan(260);
    // Seats follow department headcounts.
    const engineering = members.filter((member) => member.primaryDepartmentId === "dept_engineering").length;
    const legal = members.filter((member) => member.primaryDepartmentId === "dept_legal").length;
    expect(engineering).toBe(512);
    expect(legal).toBe(42);
    expect(members.filter((member) => member.role === "owner")).toHaveLength(1);
    expect(members.filter((member) => member.role !== "member").every((member) => member.status === "active")).toBe(true);
  });

  it("names the top spenders from the same directory the People screen lists", async () => {
    const [members, top, everyone, balances] = await Promise.all([
      client.listOrgMembers(TENANT), client.usageAnalytics(TENANT, range(30)), client.usageAnalytics(TENANT, { ...range(30), limit: 100 }), client.allowanceBalances(TENANT),
    ]);
    const byId = new Map(members.map((member) => [member.userId, member]));
    const named = (top.breakdowns.members ?? []).filter((row) => row.email);
    expect(named).toHaveLength(25);
    for (const row of named) {
      expect(byId.get(row.id ?? "")?.name).toBe(row.label);
      expect(byId.get(row.id ?? "")?.email).toBe(row.email);
      expect(byId.get(row.id ?? "")?.status).toBe("active");
    }
    // A request for more than a page returns every member with usage, and still adds up.
    const listed = (everyone.breakdowns.members ?? []).filter((row) => row.email);
    expect(listed.length).toBeGreaterThan(1_500);
    expect(listed.every((row) => byId.has(row.id ?? ""))).toBe(true);
    expectBreakdownMatchesTotals(everyone, "members");
    // Dormant, invited and suspended members spent nothing this cycle.
    const used = new Map(balances.map((balance) => [balance.userId, Number(balance.usedMicros)]));
    const spenders = new Set(listed.map((row) => row.id));
    expect(members.filter((member) => !spenders.has(member.userId)).every((member) => used.get(member.userId) === 0)).toBe(true);
    const devices = await client.listMemberMobileDevices(TENANT, named[0]!.id!);
    expect(devices[0]?.displayName).toContain(named[0]!.label.split(" ")[0]);
  });

  it("pages, searches and filters the member list", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.listOrgMembersPage(TENANT, { limit: 100, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(1_850);
      seen.push(...page.items.map((member) => member.userId));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(19);
    expect(new Set(seen).size).toBe(1_850);
    const pending = await client.listOrgMembersPage(TENANT, { status: "pending", limit: 100 });
    expect(pending.items).toHaveLength(40);
    expect(pending.hasMore).toBe(false);
    const first = (await client.listOrgMembers(TENANT))[0]!;
    const found = await client.listOrgMembersPage(TENANT, { search: first.email.toUpperCase(), limit: 25 });
    expect(found.items.map((member) => member.userId)).toEqual([first.userId]);
    const engineering = await client.listOrgMembersPage(TENANT, { departmentId: "dept_engineering", limit: 25 });
    expect(engineering.total).toBeGreaterThanOrEqual(512);
    expect(engineering.items).toHaveLength(25);
    expect(engineering.hasMore).toBe(true);
  });

  it("loads the data module lazily behind a proxy that is not a thenable", async () => {
    const lazy = createLazyDemoManagementClient(config, TENANT);
    const loose = lazy as unknown as Record<string | symbol, unknown>;
    expect(loose.then).toBeUndefined();
    expect(loose[Symbol.iterator]).toBeUndefined();
    expect(loose[Symbol.toPrimitive]).toBeUndefined();
    expect(loose.$$typeof).toBeUndefined();
    expect(loose.constructor).toBeUndefined();
    expect(await Promise.resolve(lazy)).toBe(lazy);
    expect(lazy.listOrgMembers).toBe(lazy.listOrgMembers);
    const [members, departments] = await Promise.all([lazy.listOrgMembers(TENANT), lazy.listDepartments(TENANT)]);
    expect(members.map((member) => member.email)).toEqual((await client.listOrgMembers(TENANT)).map((member) => member.email));
    expect(departments).toHaveLength(12);
    expect((await lazy.usageAnalytics(TENANT, range(30))).totals.tokens).toBeGreaterThan(10_000_000_000);
    const fallbacks = lazy as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    expect(await fallbacks.listSomethingNew!()).toEqual([]);
    expect(await fallbacks.deletePersonalSkill!("skill")).toBeUndefined();
  });

  it("lists automations with run history that matches their schedules", async () => {
    const tasks = await client.listScheduledTasks();
    expect(tasks).toHaveLength(9);
    expect(tasks.filter((task) => task.state === "paused")).toHaveLength(1);
    expect(tasks.filter((task) => task.lastError)).toHaveLength(1);
    expect(tasks.filter((task) => task.state === "completed")).toHaveLength(1);
    expect(new Set(tasks.map((task) => task.schedule.timezone)).size).toBeGreaterThanOrEqual(5);
    for (const task of tasks) {
      const runs = await client.listScheduledTaskRuns(task.id);
      expect(runs.every((run) => run.scheduleId === task.id)).toBe(true);
      expect(new Date(task.lastRunAt!).getTime()).toBeLessThanOrEqual(Date.now());
      if (task.state === "active") {
        expect(new Date(task.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
        expect(runs.length).toBeGreaterThanOrEqual(5);
        expect(runs.length).toBeLessThanOrEqual(10);
      } else {
        expect(task.nextRunAt).toBeNull();
      }
      if (task.lastError) expect(runs[0]?.turnState).toBe("failed");
    }
    const weekly = tasks.find((task) => task.schedule.kind === "cron" && task.schedule.expression === "0 16 * * 5")!;
    const local = new Intl.DateTimeFormat("en-US", { timeZone: weekly.schedule.timezone, weekday: "short", hour: "numeric", hourCycle: "h23" }).format(new Date(weekly.nextRunAt!));
    expect(local.replace(",", "")).toBe("Fri 16");
    const allRuns = (await Promise.all(tasks.map((task) => client.listScheduledTaskRuns(task.id)))).flat();
    expect(allRuns.some((run) => run.turnState === "completed")).toBe(true);
    expect(allRuns.some((run) => run.turnState === "failed" || run.state === "failed")).toBe(true);
  });

  it("is deterministic across client instances", async () => {
    const other = createDemoManagementClient(config, TENANT);
    expect(await other.listOrgMembers(TENANT).then((rows) => rows.map((row) => row.email))).toEqual(await client.listOrgMembers(TENANT).then((rows) => rows.map((row) => row.email)));
    expect((await other.listPolicyVersions(TENANT)).map((version) => version.bundleHash)).toEqual((await client.listPolicyVersions(TENANT)).map((version) => version.bundleHash));
  });

  it("answers unimplemented methods without throwing and is not a thenable", async () => {
    const loose = client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & { then?: unknown };
    expect(loose.then).toBeUndefined();
    expect(await Promise.resolve(client)).toBe(client);
    expect(await loose.listSomethingNew!()).toEqual([]);
    expect(await loose.upsertFeatureFlag!(TENANT, "memory", { enabled: false })).toEqual({ enabled: false });
    expect(await loose.updateMemberAllowanceBase!(TENANT, "usr_0001")).toEqual({});
    expect(await loose.deletePersonalSkill!("skill")).toBeUndefined();
    expect(await loose.revokeMemberMobileDevice!(TENANT, "usr_0001", "device")).toBeUndefined();
    expect(typeof (await loose.exportUsageCsv!(TENANT))).toBe("string");
    expect(await loose.personalizationProfile!()).toBeNull();
  });
});
