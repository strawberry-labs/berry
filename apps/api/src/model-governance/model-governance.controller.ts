import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Put, Query, Req } from "@nestjs/common";
import {
  ModelApiTypeSchema,
  ModelCapabilitiesSchema,
  ModelGovernanceDecisionSchema,
  ConversationKindSchema,
  JsonValueSchema,
  OrgModelDefaultSchema,
  OrgModelPolicySchema,
  OrgPermissionSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { MODEL_GOVERNANCE_SERVICE, type ModelGovernanceService } from "./model-governance.service.ts";

const UpsertModelPolicyRequestSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  displayName: z.string().trim().min(1).nullable().optional(),
  presetId: z.string().trim().min(1).nullable().optional(),
  apiType: ModelApiTypeSchema.nullable().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  status: z.enum(["allowed", "blocked"]).optional(),
  enforce: z.boolean().optional(),
  modeAllow: z.array(ConversationKindSchema).optional(),
  metadata: JsonValueSchema.optional(),
}).strict();

const UpsertModelDefaultRequestSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  enforce: z.boolean().optional(),
}).strict();

const ResolveModelRequestSchema = z.object({
  mode: ConversationKindSchema,
  providerId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
}).strict();

@Controller("/v1/orgs/:tenantId/models")
export class ModelGovernanceController {
  constructor(
    @Inject(MODEL_GOVERNANCE_SERVICE) private readonly models: ModelGovernanceService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  @Get()
  async listModels(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query("mode") mode?: string, @Query("includeBlocked") includeBlocked?: string) {
    await this.requirePermission(request, tenantId, "models:read");
    const parsedMode = mode ? parseConversationKind(mode) : undefined;
    return z.array(OrgModelPolicySchema).parse(await this.models.listModels(tenantId, { mode: parsedMode, includeBlocked: includeBlocked === "true" }));
  }

  @Put("/policies")
  async upsertPolicy(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "models:write");
    const parsed = parseBody(UpsertModelPolicyRequestSchema, body);
    const policy = OrgModelPolicySchema.parse(await this.models.upsertPolicy({ tenantId, ...parsed }));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "models",
      action: "policy-upserted",
      targetType: "model_policy",
      targetId: `${policy.providerId}:${policy.model}`,
      after: policy as never,
      metadata: { surface: "admin-api" },
    });
    return policy;
  }

  @Get("/defaults")
  async listDefaults(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "models:read");
    return z.array(OrgModelDefaultSchema).parse(await this.models.listDefaults(tenantId));
  }

  @Put("/defaults/:mode")
  async upsertDefault(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("mode") mode: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "models:write");
    const parsed = parseBody(UpsertModelDefaultRequestSchema, body);
    const modelDefault = OrgModelDefaultSchema.parse(await this.models.upsertDefault({ tenantId, mode: parseConversationKind(mode), ...parsed }));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "models",
      action: "default-upserted",
      targetType: "model_default",
      targetId: modelDefault.mode,
      after: modelDefault as never,
      metadata: { surface: "admin-api" },
    });
    return modelDefault;
  }

  @Post("/resolve")
  async resolve(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "models:read");
    const parsed = parseBody(ResolveModelRequestSchema, body);
    return ModelGovernanceDecisionSchema.parse(await this.models.resolve({ tenantId, ...parsed }));
  }

  private async requirePermission(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    OrgPermissionSchema.parse(permission);
    const allowed = await this.identity.authorize(request.auth!.user.id, tenantId, permission);
    if (!allowed) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

function parseConversationKind(value: string) {
  const result = ConversationKindSchema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
