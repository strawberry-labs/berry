import { HttpException, Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ScheduledRunClaim } from "@berry/db";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { AgentApiController } from "../http/agent-api.controller.ts";
import { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import { ScheduledTasksService } from "./scheduled-tasks.service.ts";

/** Replica-safe wakeups reuse the exact model, connector, memory, and budget admission path of interactive turns. */
@Injectable()
export class ScheduledTaskDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTaskDispatcher.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  constructor(
    @Inject(ScheduledTasksService) private readonly schedules: ScheduledTasksService,
    @Inject(AgentApiController) private readonly agent: AgentApiController,
    @Inject(CloudRuntimeConfigService) private readonly runtime: CloudRuntimeConfigService,
  ) {}
  onApplicationBootstrap(): void {
    if (!this.schedules.enabled) return;
    this.timer = setInterval(() => { void this.tick(); }, 10_000);
    this.timer.unref();
    void this.tick();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
  async tick(): Promise<void> {
    if (this.stopped || this.pending || !this.schedules.enabled) return;
    this.pending = this.dispatch().catch(() => { this.logger.error("Scheduled task dispatch failed; the next poll will retry"); });
    try { await this.pending; } finally { this.pending = null; }
  }
  private async dispatch(): Promise<void> {
    const tenantId = this.schedules.tenantId;
    await this.schedules.repository((repo) => repo.enqueueDue(tenantId));
    const owner = randomUUID();
    const claims = await this.schedules.repository((repo) => repo.claimPending(tenantId, owner));
    const results = await Promise.allSettled(claims.map((claim) => this.launch(claim, owner)));
    if (results.some((result) => result.status === "rejected")) this.logger.error("A scheduled run could not be settled; its durable lease will recover");
  }
  private async launch(claim: ScheduledRunClaim, owner: string): Promise<void> {
    const tenantId = this.schedules.tenantId;
    try {
      if (!await this.schedules.repository((repo) => repo.authorizeClaim(tenantId, claim.id, owner))) {
        await this.schedules.repository((repo) => repo.failed(tenantId, claim.id, owner, "Workspace or active membership is unavailable", false));
        return;
      }
      const request = {
        headers: {},
        auth: { session: { id: claim.id, userId: claim.userId }, user: { id: claim.userId, email: claim.email, name: claim.name } },
      } as AuthenticatedRequest;
      const response = await this.agent.startTurn(request, claim.sessionId, {
        operationId: claim.id, input: claim.input.prompt, workspaceId: claim.workspaceId,
        workspacePath: this.runtime.config.workspacePath, reasoning: claim.input.reasoning, timezone: claim.input.timezone,
      });
      await this.schedules.repository((repo) => repo.admitted(tenantId, claim.id, owner, response.turnId));
    } catch (error) {
      // Store only safe, actionable errors. Provider and database exceptions can
      // contain credentials or request payloads and must never reach run history.
      const http = error instanceof HttpException ? error : null;
      const message = http && http.getStatus() < 500 ? http.message : "Could not start this run. The server will retry transient failures.";
      await this.schedules.repository((repo) => repo.failed(tenantId, claim.id, owner, message, !http || http.getStatus() >= 500 || http.getStatus() === 429));
    }
  }
}
