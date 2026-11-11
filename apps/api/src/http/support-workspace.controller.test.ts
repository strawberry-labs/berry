import "reflect-metadata";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it, vi } from "vitest";
import { AllowanceController } from "../budget/allowance.controller.ts";
import { ScheduledTasksController } from "../schedules/scheduled-tasks.controller.ts";
import { UsageController } from "../usage/usage.controller.ts";
import { SupportViewController } from "./support-view.controller.ts";
import { SupportWorkspaceController } from "./support-workspace.controller.ts";

const actorId = "00000000-0000-4000-8000-000000000001";
const subjectId = "00000000-0000-4000-8000-000000000002";
const automationId = "00000000-0000-4000-8000-000000000003";
const operationId = "00000000-0000-4000-8000-000000000004";
const workspaceId = "00000000-0000-4000-8000-000000000005";
const from = "2026-11-01T00:00:00.000Z";
const to = "2026-12-01T00:00:00.000Z";
const input = { operationId, name: "Daily briefing", prompt: "Prepare a briefing", schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Dubai" } };
const balance = { tenantId: SELF_HOST_TENANT_ID, userId: subjectId, cycleStart: from, cycleEnd: to, baseLimitMicros: "100000000", adjustmentMicros: "0", effectiveLimitMicros: "100000000", usedMicros: "20000000", reservedMicros: "5000000", availableMicros: "75000000", status: "healthy" };
const analytics = { tenantId: SELF_HOST_TENANT_ID, from, to, totals: { billedCostMicros: "20000000", requests: 1, tokens: 100, successRate: 1, projectedMonthEndMicros: null }, series: [], breakdowns: {}, performance: { latencyP50Ms: null, latencyP95Ms: null, ttftP50Ms: null, ttftP95Ms: null, cachedTokens: 0, sandboxMinutes: 0 }, anomalies: [] };

function setup(options: { role?: string; subjectStatus?: string; subjectMissing?: boolean } = {}) {
  const request = { auth: { user: { id: actorId }, session: { userId: actorId } }, headers: {} } as any;
  const identity = {
    getMembership: vi.fn(async (_tenantId: string, id: string) => id === subjectId && options.subjectMissing ? null : ({
      userId: id, name: id === actorId ? "Admin" : "Member", email: `${id}@example.test`,
      role: id === actorId ? options.role ?? "admin" : "member", status: id === actorId ? "active" : options.subjectStatus ?? "active",
    })),
    authorize: vi.fn(async () => true),
    listMemberships: vi.fn(async () => []), listDepartments: vi.fn(async () => []),
  };
  const audit = { append: vi.fn(async () => ({})) };
  const support = new SupportViewController({} as any, identity as any, {} as any, audit as any);
  const service = {
    list: vi.fn(async (_userId: string) => []),
    create: vi.fn(async (_userId: string, _input: unknown) => ({ id: automationId })),
    update: vi.fn(async (_userId: string, _id: string, _changes: unknown, _operationId?: string) => ({ id: automationId })),
    remove: vi.fn(async (_userId: string, _id: string) => ({ removed: true })),
    runNow: vi.fn(async (_userId: string, _id: string, _operationId: string) => ({ id: operationId })),
    history: vi.fn(async (_userId: string, _id: string, _limit: number) => []),
  };
  const tasks = { ensureGeneralWorkspace: vi.fn(async (_userId: string) => ({ id: workspaceId })) };
  const personal = {
    listSkills: vi.fn(async (_request: unknown) => []),
    skillPackage: vi.fn(async (_request: unknown, _id: string) => ({ content: "# Skill", resourceFiles: [] })),
    installPackage: vi.fn(async (_request: unknown, _body: unknown) => ({ id: "skill" })),
  };
  const members = {
    list: vi.fn(async (_request: unknown, _tenantId: string, _userId: string) => ({ personal: [], effective: [] })),
    save: vi.fn(async (_request: unknown, _tenantId: string, _userId: string, _body: unknown) => ({ id: "skill" })),
    toggle: vi.fn(async (_request: unknown, _tenantId: string, _userId: string, _id: string, _body: unknown) => ({ id: "skill" })),
    remove: vi.fn(async (_request: unknown, _tenantId: string, _userId: string, _id: string) => ({ ok: true })),
  };
  const allowances = { balance: vi.fn(async (_tenantId: string, _userId: string) => balance) };
  const usage = {
    analytics: vi.fn(async (_tenantId: string, _query: unknown) => analytics),
    requestPage: vi.fn(async (_tenantId: string, _query: unknown, _userId: string) => ({ items: [], hasMore: false, nextCursor: null })),
    listEvents: vi.fn(async (_tenantId: string, _query: unknown) => []),
  };
  const browsers = { state: vi.fn(async () => ({ active: true })), takeControl: vi.fn(async () => ({ active: true })), connection: vi.fn(async () => ({ url: "wss://api.berrycrawl.com/scoped" })), resume: vi.fn(async () => ({ active: true })) };
  const controller = new SupportWorkspaceController(support, new ScheduledTasksController(service as any, tasks as any), personal as any, {} as any, members as any, new AllowanceController(allowances as any, identity as any), new UsageController(usage as any, {} as any, identity as any), browsers as any);
  return { controller, request, audit, service, tasks, personal, members, allowances, usage, browsers };
}

describe("support workspace", () => {
  it("authorizes and audits browser takeover and handback as the selected member", async () => {
    const { controller, request, browsers, audit } = setup();
    const sessionId = "00000000-0000-7000-8000-000000000099";
    await controller.browserState(request, SELF_HOST_TENANT_ID, subjectId, sessionId);
    await controller.browserTakeControl(request, SELF_HOST_TENANT_ID, subjectId, sessionId, { browserId: "bses_test" });
    await controller.browserConnection(request, SELF_HOST_TENANT_ID, subjectId, sessionId, { browserId: "bses_test", control: true });
    await controller.browserResume(request, SELF_HOST_TENANT_ID, subjectId, sessionId, { browserId: "bses_test", handoffId: operationId });
    expect(browsers.resume).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ user: expect.objectContaining({ id: subjectId }) }) }), sessionId, { browserId: "bses_test", handoffId: operationId });
    expect(audit.append).toHaveBeenCalled();
    const denied = setup({ role: "member" });
    await expect(denied.controller.browserTakeControl(denied.request, SELF_HOST_TENANT_ID, subjectId, sessionId, { browserId: "bses_test" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(denied.browsers.takeControl).not.toHaveBeenCalled();
  });

  it("creates and manages automations as the selected member while auditing the administrator", async () => {
    const { controller, request, service, tasks, audit } = setup();
    await controller.listAutomations(request, SELF_HOST_TENANT_ID, subjectId);
    await controller.createAutomation(request, SELF_HOST_TENANT_ID, subjectId, input);
    await controller.updateAutomation(request, SELF_HOST_TENANT_ID, subjectId, automationId, { changes: { state: "paused" }, operationId });
    await controller.runAutomation(request, SELF_HOST_TENANT_ID, subjectId, automationId, { operationId });
    await controller.automationRuns(request, SELF_HOST_TENANT_ID, subjectId, automationId, "20");
    await controller.deleteAutomation(request, SELF_HOST_TENANT_ID, subjectId, automationId);
    expect(tasks.ensureGeneralWorkspace).toHaveBeenCalledWith(subjectId);
    expect(service.list).toHaveBeenCalledWith(subjectId);
    expect(service.create).toHaveBeenCalledWith(subjectId, { ...input, workspaceId });
    expect(service.update).toHaveBeenCalledWith(subjectId, automationId, { state: "paused" }, operationId);
    expect(service.runNow).toHaveBeenCalledWith(subjectId, automationId, operationId);
    expect(service.history).toHaveBeenCalledWith(subjectId, automationId, 20);
    expect(service.remove).toHaveBeenCalledWith(subjectId, automationId);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: actorId, action: "support-view-write", targetType: "automation", metadata: { subjectUserId: subjectId, operation: "createAutomation" } }));
    expect(request.auth.user.id).toBe(actorId);
    expect(request.auth.session.userId).toBe(actorId);
  });

  it.each([
    { role: "member" }, { subjectStatus: "suspended" }, { subjectMissing: true },
  ])("rejects unauthorized writes before touching an automation: %j", async (options) => {
    const { controller, request, service, tasks, audit } = setup(options);
    await expect(controller.createAutomation(request, SELF_HOST_TENANT_ID, subjectId, input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
    expect(tasks.ensureGeneralWorkspace).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("does not access another tenant or fall back to an administrator's automation", async () => {
    const { controller, request, service, audit } = setup();
    await expect(controller.listAutomations(request, automationId, subjectId)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.list).not.toHaveBeenCalled();
    service.remove.mockRejectedValueOnce(new NotFoundException("Scheduled task not found"));
    await expect(controller.deleteAutomation(request, SELF_HOST_TENANT_ID, subjectId, automationId)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.remove).toHaveBeenCalledWith(subjectId, automationId);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("loads the member's allowance and forces usage filters to that member", async () => {
    const { controller, request, allowances, usage, audit } = setup();
    await expect(controller.allowance(request, SELF_HOST_TENANT_ID, subjectId)).resolves.toMatchObject({ userId: subjectId, availableMicros: "75000000" });
    await controller.myUsage(request, SELF_HOST_TENANT_ID, subjectId, { from, to, memberId: actorId });
    await controller.usageRequests(request, SELF_HOST_TENANT_ID, subjectId, { from, to });
    await controller.exportUsage(request, SELF_HOST_TENANT_ID, subjectId, { from, to, userId: actorId });
    expect(allowances.balance).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, subjectId);
    expect(usage.analytics).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, expect.objectContaining({ memberId: subjectId }));
    expect(usage.requestPage).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, expect.anything(), subjectId);
    expect(usage.listEvents).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, expect.objectContaining({ userId: subjectId }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: actorId, action: "support-view-read", metadata: { subjectUserId: subjectId, operation: "allowance" } }));
  });

  it("scopes skill reads and uploaded archives to the member and uses the existing admin skill mutations", async () => {
    const { controller, request, personal, members, audit } = setup();
    await controller.skills(request, SELF_HOST_TENANT_ID, subjectId);
    await controller.skillPackage(request, SELF_HOST_TENANT_ID, subjectId, "skill");
    await controller.installSkill(request, SELF_HOST_TENANT_ID, subjectId, { fileId: operationId });
    await controller.saveSkill(request, SELF_HOST_TENANT_ID, subjectId, { content: "# Skill" });
    await controller.updateSkill(request, SELF_HOST_TENANT_ID, subjectId, "skill", { enabled: false });
    await controller.deleteSkill(request, SELF_HOST_TENANT_ID, subjectId, "skill");
    await controller.effectiveCapabilities(request, SELF_HOST_TENANT_ID, subjectId);
    expect(personal.listSkills).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ user: expect.objectContaining({ id: subjectId }) }) }));
    expect(personal.installPackage).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ user: expect.objectContaining({ id: subjectId }) }) }), { fileId: operationId });
    expect(members.save).toHaveBeenCalledWith(request, SELF_HOST_TENANT_ID, subjectId, { content: "# Skill" });
    expect(members.toggle).toHaveBeenCalledWith(request, SELF_HOST_TENANT_ID, subjectId, "skill", { enabled: false });
    expect(members.remove).toHaveBeenCalledWith(request, SELF_HOST_TENANT_ID, subjectId, "skill");
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: actorId, action: "support-view-write", metadata: { subjectUserId: subjectId, operation: "installSkill" } }));
  });

  it("denies skill and usage reads to non-administrators", async () => {
    const { controller, request, personal, usage } = setup({ role: "member" });
    await expect(controller.skills(request, SELF_HOST_TENANT_ID, subjectId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.myUsage(request, SELF_HOST_TENANT_ID, subjectId, { from, to })).rejects.toBeInstanceOf(ForbiddenException);
    expect(personal.listSkills).not.toHaveBeenCalled();
    expect(usage.analytics).not.toHaveBeenCalled();
  });
});
