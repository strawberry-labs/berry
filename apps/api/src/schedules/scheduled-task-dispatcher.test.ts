import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AgentApiController } from "../http/agent-api.controller.ts";
import type { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import type { ScheduledTasksService } from "./scheduled-tasks.service.ts";
import { ScheduledTaskDispatcher } from "./scheduled-task-dispatcher.ts";

function fixture() {
  const claim = { id: "run", userId: "owner", sessionId: "session", workspaceId: "workspace", email: "owner@berry.invalid", name: "Owner", input: { prompt: "Prepare my briefing", timezone: "Asia/Dubai", reasoning: "high" } };
  const repo = { enqueueDue: vi.fn().mockResolvedValue(1), claimPending: vi.fn().mockResolvedValue([claim]), authorizeClaim: vi.fn().mockResolvedValue(true), admitted: vi.fn().mockResolvedValue(undefined), failed: vi.fn().mockResolvedValue(undefined) };
  const schedules = { enabled: true, tenantId: "tenant", repository: async (fn: (r: typeof repo) => Promise<unknown>) => fn(repo) };
  const agent = { startTurn: vi.fn().mockResolvedValue({ turnId: "turn" }) };
  const dispatcher = new ScheduledTaskDispatcher(schedules as unknown as ScheduledTasksService, agent as unknown as AgentApiController, { config: { workspacePath: "/workspace" } } as CloudRuntimeConfigService);
  return { claim, repo, schedules, agent, dispatcher };
}
describe("scheduled task dispatcher", () => {
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
