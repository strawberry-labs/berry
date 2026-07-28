import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Put, Query, Req, UnauthorizedException } from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { MemoryStatusSchema } from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { MemoryService } from "./memory.service.js";

const ScopeSchema = z.enum(["personal", "project"]);
const ListSchema = z.object({
  scope: ScopeSchema.default("personal"),
  workspaceId: z.string().uuid().optional(),
  status: MemoryStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(1_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const RememberSchema = z.object({
  scope: ScopeSchema.default("personal"),
  workspaceId: z.string().uuid().optional(),
  kind: z.string().trim().min(1).max(80),
  stableKey: z.string().trim().max(240).optional(),
  content: z.string().trim().min(1).max(20_000),
  value: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  salience: z.number().min(0).max(1).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
const UpdateSchema = RememberSchema.pick({
  kind: true,
  content: true,
  value: true,
  confidence: true,
  salience: true,
  expiresAt: true,
}).partial({ kind: true, value: true, confidence: true, salience: true, expiresAt: true });
const SettingsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  implicitMemoryEnabled: z.boolean().optional(),
}).strict().refine((value) => value.memoryEnabled !== undefined || value.implicitMemoryEnabled !== undefined, {
  message: "At least one memory setting is required",
});

@Controller("/v1/memory")
export class MemoryController {
  constructor(@Inject(MemoryService) private readonly memory: MemoryService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const input = parse(ListSchema, query);
    return this.memory.list({
      tenantId: tenant(),
      userId: user(request),
      scope: input.scope,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
  }

  @Get("/export")
  export(@Req() request: AuthenticatedRequest) {
    return this.memory.export(tenant(), user(request));
  }

  @Get("/settings")
  settings(@Req() request: AuthenticatedRequest) {
    return this.memory.settings(tenant(), user(request));
  }

  @Put("/settings")
  updateSettings(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(SettingsSchema, body);
    return this.memory.updateSettings(tenant(), user(request), {
      ...(input.memoryEnabled !== undefined ? { memoryEnabled: input.memoryEnabled } : {}),
      ...(input.implicitMemoryEnabled !== undefined ? { implicitMemoryEnabled: input.implicitMemoryEnabled } : {}),
    });
  }

  @Get(":memoryId")
  get(@Req() request: AuthenticatedRequest, @Param("memoryId") memoryId: string) {
    return this.memory.get(tenant(), user(request), z.string().uuid().parse(memoryId));
  }

  @Put()
  remember(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(RememberSchema, body);
    return this.memory.remember({
      tenantId: tenant(),
      userId: user(request),
      scope: input.scope,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      kind: input.kind,
      ...(input.stableKey ? { stableKey: input.stableKey } : {}),
      content: input.content,
      ...(input.value ? { value: input.value } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.salience !== undefined ? { salience: input.salience } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  @Patch(":memoryId")
  update(@Req() request: AuthenticatedRequest, @Param("memoryId") memoryId: string, @Body() body: unknown) {
    const input = parse(UpdateSchema, body);
    return this.memory.update({
      tenantId: tenant(),
      userId: user(request),
      memoryId: z.string().uuid().parse(memoryId),
      content: input.content,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.value ? { value: input.value } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.salience !== undefined ? { salience: input.salience } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  @Delete()
  clear(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const input = parse(ListSchema.pick({ scope: true, workspaceId: true }), query);
    return this.memory.clear({
      tenantId: tenant(),
      userId: user(request),
      scope: input.scope,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
  }

  @Delete(":memoryId")
  forget(@Req() request: AuthenticatedRequest, @Param("memoryId") memoryId: string) {
    return this.memory.forget(tenant(), user(request), z.string().uuid().parse(memoryId));
  }
}

function parse<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

function tenant(): string {
  return process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID;
}

function user(request: AuthenticatedRequest): string {
  const id = request.auth?.user.id;
  if (!id) throw new UnauthorizedException("Authentication required");
  return id;
}
