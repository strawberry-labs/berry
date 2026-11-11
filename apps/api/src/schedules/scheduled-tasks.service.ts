import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { SELF_HOST_TENANT_ID, SqlScheduledTaskRepository } from "@berry/db";
import type { ScheduledTaskCreate, ScheduledTaskUpdate } from "@berry/shared";
import { CloudDatabaseService } from "../db/cloud-database.service.ts";
import { DURABLE_TURN_RUNNER_ENABLED } from "../runtime/durable-turn.service.ts";

@Injectable()
export class ScheduledTasksService {
  readonly tenantId = process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID;
  constructor(
    @Optional() @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService | undefined,
    @Inject(DURABLE_TURN_RUNNER_ENABLED) readonly enabled: boolean,
  ) {}

  async repository<T>(callback: (repository: SqlScheduledTaskRepository) => Promise<T>): Promise<T> {
    if (!this.enabled || !this.database) throw new ServiceUnavailableException("Scheduled tasks require the durable agent runner");
    return this.database.withTenant(this.tenantId, (sql) => callback(new SqlScheduledTaskRepository(sql)));
  }

  async memberOperation<T>(callback: (repository: SqlScheduledTaskRepository) => Promise<T>): Promise<T> {
    try { return await this.repository(callback); }
    catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      const message = error instanceof Error ? error.message : "Unable to change scheduled task";
      if (message === "Scheduled task not found" || message === "Source task not found" || message === "Workspace or active membership not found") throw new NotFoundException(message);
      if (message.includes("already") || message.includes("100 scheduled tasks")) throw new ConflictException(message);
      // Domain validation errors come from schedule calculations; database errors
      // retain their original exception so infrastructure failures are not 400s.
      if (error instanceof Error && !("code" in error)) throw new BadRequestException(message);
      throw error;
    }
  }
  list(userId: string) { return this.memberOperation((repo) => repo.list({ tenantId: this.tenantId, userId })); }
  create(userId: string, input: ScheduledTaskCreate & { workspaceId: string }) { return this.memberOperation((repo) => repo.create({ tenantId: this.tenantId, userId }, input)); }
  update(userId: string, id: string, input: ScheduledTaskUpdate, operationId?: string) { return this.memberOperation((repo) => repo.update({ tenantId: this.tenantId, userId }, id, input, operationId)); }
  remove(userId: string, id: string) { return this.memberOperation((repo) => repo.remove({ tenantId: this.tenantId, userId }, id)); }
  history(userId: string, id: string, limit: number) { return this.memberOperation((repo) => repo.history({ tenantId: this.tenantId, userId }, id, limit)); }
  runNow(userId: string, id: string, operationId: string) { return this.memberOperation((repo) => repo.runNow({ tenantId: this.tenantId, userId }, id, operationId)); }
}
