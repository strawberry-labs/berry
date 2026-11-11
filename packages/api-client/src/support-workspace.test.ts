import { describe, expect, it, vi } from "vitest";
import { BerryApiClient } from "./index.ts";

const tenantId = "tenant";
const userId = "member/target";
const base = "https://api.berry.test";
const prefix = `${base}/v1/orgs/tenant/support/users/member%2Ftarget`;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const from = "2026-11-01T00:00:00.000Z", to = "2026-12-01T00:00:00.000Z";

describe("support workspace routing", () => {
  it("routes automations, personal skills and effective skill reads to the member", async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = new BerryApiClient({ baseUrl: base, supportView: { tenantId, userId }, fetchImpl });
    await client.listScheduledTasks();
    await client.listScheduledTaskRuns("automation");
    await client.listPersonalSkills();
    await client.effectiveCapabilities(tenantId);
    expect(fetchImpl.mock.calls.map((call: any[]) => call[0])).toEqual([
      `${prefix}/scheduled-tasks`, `${prefix}/scheduled-tasks/automation/runs?limit=30`, `${prefix}/me/skills`, `${prefix}/capabilities/effective/me`,
    ]);
  });

  it("loads the member allowance with abort support and routes usage logs and CSV", async () => {
    const balance = { tenantId, userId, cycleStart: from, cycleEnd: to, baseLimitMicros: "100", adjustmentMicros: "0", effectiveLimitMicros: "100", usedMicros: "20", reservedMicros: "5", availableMicros: "75", status: "healthy" };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(balance)).mockResolvedValueOnce(json({ items: [], nextCursor: null, hasMore: false })).mockResolvedValueOnce(new Response("usage,cost"));
    const client = new BerryApiClient({ baseUrl: base, supportView: { tenantId, userId }, fetchImpl });
    const { signal } = new AbortController();
    await expect(client.myAllowanceBalance(tenantId, { signal })).resolves.toMatchObject({ userId, availableMicros: "75" });
    await client.myUsageRequests(tenantId, { from, to, limit: 50 });
    await expect(client.exportMyUsageCsv(tenantId, { from, to })).resolves.toBe("usage,cost");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${prefix}/allowances/me`, expect.objectContaining({ signal, credentials: "include" }));
    expect(fetchImpl.mock.calls[1]?.[0]).toContain(`${prefix}/usage/me/requests?`);
    expect(fetchImpl.mock.calls[2]?.[0]).toContain(`${prefix}/usage/me/export.csv?`);
  });

  it("routes browser viewer, pause and handback through the same audited support scope", async () => {
    const state = { runId: "run", active: true, sessions: [], handoff: null };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(state)).mockResolvedValueOnce(json(state)).mockResolvedValueOnce(json({ url: "wss://api.berrycrawl.com/session", expiresAt: to })).mockResolvedValueOnce(json(state));
    const client = new BerryApiClient({ baseUrl: base, supportView: { tenantId, userId }, fetchImpl });
    await client.browserState("chat"); await client.takeBrowserControl("chat", "bses_test");
    await client.browserConnection("chat", "bses_test", true); await client.resumeBrowserAgent("chat", "bses_test", "handoff");
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([`${prefix}/sessions/chat/browser`, `${prefix}/sessions/chat/browser/take-control`, `${prefix}/sessions/chat/browser/connection`, `${prefix}/sessions/chat/browser/resume`]);
  });

  it("keeps other tenants and organization administration outside the support scope", async () => {
    const fetchImpl = vi.fn();
    const client = new BerryApiClient({ baseUrl: base, supportView: { tenantId, userId }, fetchImpl });
    await expect(client.myAllowanceBalance("another-tenant")).rejects.toMatchObject({ status: 403 });
    await expect(client.listOrganizations()).rejects.toMatchObject({ status: 403 });
    await expect(client.setCapabilityOverride(tenantId, "mcp", "server", true)).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
