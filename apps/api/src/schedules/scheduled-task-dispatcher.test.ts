import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorsService } from "../connectors/connectors.service.ts";
import { idleMailboxSince, ScheduledConnectionRequired } from "../connectors/scheduled-mail-activity.ts";
import type { AgentApiController } from "../http/agent-api.controller.ts";
import type { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import type { ScheduledTasksService } from "./scheduled-tasks.service.ts";
import { ScheduledTaskDispatcher } from "./scheduled-task-dispatcher.ts";

function fixture() {
  const claim = { id: "run", userId: "owner", sessionId: "session", workspaceId: "workspace", email: "owner@berry.invalid", name: "Owner", input: { prompt: "Prepare my briefing", timezone: "Asia/Dubai", reasoning: "high" } };
  const repo = { skipIdle: vi.fn(), enqueueDue: vi.fn().mockResolvedValue(1), claimPending: vi.fn().mockResolvedValue([claim]), authorizeClaim: vi.fn().mockResolvedValue(true), admitted: vi.fn().mockResolvedValue(undefined), failed: vi.fn().mockResolvedValue(undefined) };
  const schedules = { enabled: true, tenantId: "tenant", repository: async (fn: (r: typeof repo) => Promise<unknown>) => fn(repo) };
  const agent = { startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }) };
  const connectors = { isScheduledMailboxIdle: vi.fn() };
  const dispatcher = new ScheduledTaskDispatcher(schedules as unknown as ScheduledTasksService, agent as unknown as AgentApiController, { config: { workspacePath: "/workspace" } } as CloudRuntimeConfigService, connectors as unknown as ConnectorsService);
  return { claim, repo, schedules, agent, dispatcher, connectors };
}
describe("scheduled task dispatcher", () => {
  it.each(["empty", "work", "unavailable"] as const)("handles a scheduled mailbox with %s", async (state) => {
    const { dispatcher, agent, repo, connectors, claim } = fixture();
    repo.claimPending.mockResolvedValue([{ ...claim, activityGate: { kind: "gmail_since_checkpoint", connectorId: "tracker", checkpointTool: "checkpoint" } }]);
    if (state === "unavailable") connectors.isScheduledMailboxIdle.mockRejectedValue(new Error("offline"));
    else connectors.isScheduledMailboxIdle.mockResolvedValue(state === "empty");
    await dispatcher.tick();
    expect(repo.skipIdle).toHaveBeenCalledTimes(state === "empty" ? 1 : 0);
    expect(agent.startTurn).toHaveBeenCalledTimes(state === "empty" ? 0 : 1);
  });

  it("records a disconnected prerequisite without paying for a model call", async () => {
    const { dispatcher, agent, repo, connectors, claim } = fixture();
    repo.claimPending.mockResolvedValue([{ ...claim, activityGate: { kind: "gmail_since_checkpoint", connectorId: "tracker", checkpointTool: "checkpoint" } }]);
    connectors.isScheduledMailboxIdle.mockRejectedValue(new ScheduledConnectionRequired("Reconnect Gmail"));
    await dispatcher.tick();
    expect(agent.startTurn).not.toHaveBeenCalled();
    expect(repo.skipIdle).not.toHaveBeenCalled();
    expect(repo.failed).toHaveBeenCalledWith("tenant", claim.id, expect.any(String), "Reconnect Gmail", false);
  });

  it("requires both a confirmed idle queue and an empty incremental Gmail result for the same account", async () => {
    const checkpoint = { completedThrough: "2026-11-21T00:00:00.123Z", activity: { mailboxAddress: "owner@example.org", hasPendingWork: false } };
    const search = vi.fn().mockResolvedValue({ resultSizeEstimate: 0 });
    const email = "owner@example.org";
    expect(await idleMailboxSince(checkpoint, "other@example.org", search)).toBe(false);
    expect(await idleMailboxSince({ ...checkpoint, activity: { ...checkpoint.activity, hasPendingWork: true } }, email, search)).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(await idleMailboxSince(checkpoint, email, search)).toBe(true);
    expect(search).toHaveBeenCalledWith({ query: "after:" + (Math.floor(Date.parse(checkpoint.completedThrough) / 1000) - 1) + " -in:spam -in:trash", maxResults: 1, includeSpamTrash: false });
    for (const page of [{ messages: [{ id: "new_message" }] }, { nextPageToken: "next" }, {}, { messages: [], resultSizeEstimate: 1 }]) {
      search.mockResolvedValue(page);
      expect(await idleMailboxSince(checkpoint, email, search)).toBe(false);
    }
  });
  it("admits through the ordinary agent path with owner identity and a stable operation ID", async () => {
    const { claim, repo, agent, dispatcher } = fixture();
    await dispatcher.tick();
    expect(agent.startTurn).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ user: expect.objectContaining({ id: claim.userId }) }) }), claim.sessionId,
      { operationId: claim.id, input: claim.input.prompt, workspaceId: claim.workspaceId, workspacePath: "/workspace", reasoning: "high", timezone: "Asia/Dubai" });
    expect(repo.admitted).toHaveBeenCalledWith("tenant", claim.id, expect.any(String), "turn");
  });
  it("does not start work for a revoked owner", async () => {
    const { repo, agent, dispatcher } = fixture(); repo.authorizeClaim.mockResolvedValue(false);
    await dispatcher.tick(); expect(agent.startTurn).not.toHaveBeenCalled();
    expect(repo.failed).toHaveBeenCalledWith("tenant", "run", expect.any(String), "Workspace or active membership is unavailable", false);
  });
  it("retries transient admission failures without storing provider secrets", async () => {
    const { repo, agent, dispatcher } = fixture(); agent.startTurn.mockRejectedValue(new ServiceUnavailableException("PRIVATE_PROVIDER_KEY"));
    await dispatcher.tick(); expect(repo.failed).toHaveBeenCalledWith("tenant", "run", expect.any(String), expect.not.stringContaining("PRIVATE_PROVIDER_KEY"), true);
  });
  it("shows actionable policy errors without automatically retrying them", async () => {
    const { repo, agent, dispatcher } = fixture(); agent.startTurn.mockRejectedValue(new ForbiddenException("Model access was removed"));
    await dispatcher.tick(); expect(repo.failed).toHaveBeenCalledWith("tenant", "run", expect.any(String), "Model access was removed", false);
  });
  it("prevents overlapping polls and drains a running poll on shutdown", async () => {
    const { repo, dispatcher } = fixture(); let release!: () => void;
    repo.enqueueDue.mockImplementation(() => new Promise<number>((resolve) => { release = () => resolve(1); }));
    const running = dispatcher.tick(); await dispatcher.tick();
    expect(repo.enqueueDue).toHaveBeenCalledTimes(1);
    const stopped = dispatcher.onModuleDestroy(); release(); await Promise.all([running, stopped]);
    await dispatcher.tick(); expect(repo.enqueueDue).toHaveBeenCalledTimes(1);
  });
});
