import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import { ScheduledTaskCreateSchema, ScheduledTaskUpdateSchema } from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { CLOUD_TASK_STORE, type CloudTaskStore } from "../http/cloud-task-store.ts";
import { ScheduledTasksService } from "./scheduled-tasks.service.ts";

const Uuid = z.string().uuid();
const Update = z.object({ operationId: Uuid.optional(), changes: ScheduledTaskUpdateSchema }).strict();
const Run = z.object({ operationId: Uuid }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}
function user(request: AuthenticatedRequest): string {
  if (!request.auth?.user.id) throw new UnauthorizedException("Authentication required");
  return request.auth.user.id;
}

@Controller("/v1/scheduled-tasks")
export class ScheduledTasksController {
  constructor(
    @Inject(ScheduledTasksService) private readonly schedules: ScheduledTasksService,
    @Inject(CLOUD_TASK_STORE) private readonly tasks: CloudTaskStore,
  ) {}
  @Get() list(@Req() request: AuthenticatedRequest) { return this.schedules.list(user(request)); }
  @Post() async create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(ScheduledTaskCreateSchema, body);
    const userId = user(request);
    const workspaceId = input.workspaceId ?? (await this.tasks.ensureGeneralWorkspace(userId)).id;
    return this.schedules.create(userId, { ...input, workspaceId });
  }
  @Patch(":id") update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(Update, body);
    return this.schedules.update(user(request), parse(Uuid, id), input.changes, input.operationId);
  }
  @Delete(":id") remove(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.schedules.remove(user(request), parse(Uuid, id)); }
  @Get(":id/runs") history(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Query("limit") limit?: string) {
    return this.schedules.history(user(request), parse(Uuid, id), parse(z.coerce.number().int().min(1).max(100), limit ?? 30));
  }
  @Post(":id/run") run(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.schedules.runNow(user(request), parse(Uuid, id), parse(Run, body).operationId);
  }
}
