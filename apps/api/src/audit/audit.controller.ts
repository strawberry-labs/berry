import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import {
  CloudAuditEventSchema,
  CloudAuditExportConfigSchema,
  CloudAuditExportConfigUpsertSchema,
  CloudAuditExportResultSchema,
  CloudAuditIngestRequestSchema,
  CloudAuditSettingsSchema,
  CloudAuditSettingsUpdateSchema,
  OrgPermissionSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { AUDIT_SERVICE, auditEventsCsv, type AuditEventFilter, type AuditService } from "./audit.service.ts";

const AuditQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  category: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  targetType: z.string().trim().min(1).optional(),
  actorUserId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
}).strict();

@Controller("/v1/orgs/:tenantId/audit")
export class AuditController {
  constructor(
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
  ) {}

  @Get("/settings")
  async settings(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "audit:read");
    return CloudAuditSettingsSchema.parse(await this.audit.getSettings(tenantId));
  }

  @Put("/settings")
  async updateSettings(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "audit:export");
    const parsed = parseBody(CloudAuditSettingsUpdateSchema, body);
    return CloudAuditSettingsSchema.parse(await this.audit.updateSettings(tenantId, request.auth?.user.id ?? null, parsed));
  }

  @Post("/events")
  async ingest(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "org:read");
    const parsed = parseBody(CloudAuditIngestRequestSchema, body);
    try {
      return z.array(CloudAuditEventSchema).parse(await this.audit.ingestClientEvents(tenantId, request.auth?.user.id ?? null, parsed));
    } catch (error) {
      if (error instanceof Error && error.message.includes("disabled")) throw new ForbiddenException(error.message);
      throw error;
    }
  }

  @Get("/events")
  async listEvents(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "audit:read");
    return z.array(CloudAuditEventSchema).parse(await this.audit.listEvents(tenantId, auditFilter(query)));
  }

  @Get("/export.json")
  @Header("content-type", "application/json; charset=utf-8")
  async exportJson(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "audit:export");
    return JSON.parse((await this.audit.export(tenantId, { format: "json", filter: auditFilter(query) })).payload);
  }

  @Get("/export.csv")
  @Header("content-type", "text/csv; charset=utf-8")
  async exportCsv(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "audit:export");
    const events = await this.audit.listEvents(tenantId, auditFilter(query));
    return auditEventsCsv(events);
  }

  @Get("/exports")
  async listExportConfigs(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "audit:export");
    return z.array(CloudAuditExportConfigSchema).parse(await this.audit.listExportConfigs(tenantId));
  }

  @Put("/exports")
  async upsertExportConfig(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "audit:export");
    const parsed = parseBody(CloudAuditExportConfigUpsertSchema, body);
    return CloudAuditExportConfigSchema.parse(await this.audit.upsertExportConfig(tenantId, request.auth?.user.id ?? null, parsed));
  }

  @Post("/exports/:configId/run")
  async runExport(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("configId") configId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "audit:export");
    const configs = await this.audit.listExportConfigs(tenantId);
    const config = configs.find((entry) => entry.id === configId);
    if (!config) throw new BadRequestException("Unknown audit export config");
    return CloudAuditExportResultSchema.parse((await this.audit.export(tenantId, { format: config.format, filter: auditFilter(query), configId })).result);
  }

  private async requirePermission(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    OrgPermissionSchema.parse(permission);
    const allowed = await this.identity.authorize(request.auth!.user.id, tenantId, permission);
    if (!allowed) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }
}

function auditFilter(query: unknown): AuditEventFilter {
  const parsed = parseBody(AuditQuerySchema, query);
  return {
    from: parsed.from ? new Date(parsed.from) : undefined,
    to: parsed.to ? new Date(parsed.to) : undefined,
    category: parsed.category,
    action: parsed.action,
    targetType: parsed.targetType,
    actorUserId: parsed.actorUserId,
    sessionId: parsed.sessionId,
    limit: parsed.limit,
  };
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
