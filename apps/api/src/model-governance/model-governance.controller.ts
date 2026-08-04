import { BadGatewayException, BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Put, Query, Req } from "@nestjs/common";
import {
  ModelApiTypeSchema,
  ModelCapabilitiesSchema,
  ModelGovernanceDecisionSchema,
  ConversationKindSchema,
  JsonValueSchema,
  OrgAiAccessResourceSchema,
  OrgAiAccessRuleSchema,
  OrgAiAccessRuleUpsertSchema,
  OrgModelDefaultSchema,
  OrgModelPolicySchema,
  OrgPermissionSchema,
  OrganizationModelProviderSchema,
  OrganizationModelProviderUpsertSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { MODEL_GOVERNANCE_SERVICE, type ModelGovernanceService } from "./model-governance.service.ts";
import {
  ORGANIZATION_PROVIDER_RUNTIME,
  OrganizationProviderHealthCheckError,
  type OrganizationProviderRuntime,
} from "./organization-provider-runtime.service.ts";

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

const AccessRuleQuerySchema = z.object({
  resourceType: OrgAiAccessResourceSchema.optional(),
  resourceId: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.resourceType) === Boolean(value.resourceId), {
  message: "resourceType and resourceId must be provided together",
});
const ProviderIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);

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

  @Get("/access-rules")
  async listAccessRules(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Query() query: unknown,
  ) {
    await this.requirePermission(request, tenantId, "models:read");
    const parsed = parseQuery(AccessRuleQuerySchema, query);
    return z.array(OrgAiAccessRuleSchema).parse(
      await this.models.listAccessRules(
        tenantId,
        parsed.resourceType && parsed.resourceId
          ? { resourceType: parsed.resourceType, resourceId: parsed.resourceId }
          : undefined,
      ),
    );
  }

  @Put("/access-rules")
  async upsertAccessRule(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    await this.requirePermission(request, tenantId, "models:write");
    const parsed = parseBody(OrgAiAccessRuleUpsertSchema, body);
    await this.validateAccessRuleTarget(tenantId, parsed);
    const rule = OrgAiAccessRuleSchema.parse(await this.models.upsertAccessRule(tenantId, parsed));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "models",
      action: "access-rule-upserted",
      targetType: `${rule.resourceType}_access_rule`,
      targetId: rule.id,
      after: rule as never,
      metadata: { surface: "admin-api" },
    });
    return rule;
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
    const userId = request.auth?.user.id ?? null;
    const membership = userId ? await this.identity.getMembership(tenantId, userId) : null;
    return ModelGovernanceDecisionSchema.parse(await this.models.resolve({
      tenantId,
      ...parsed,
      userId,
      departmentId: membership?.primaryDepartmentId ?? membership?.departmentIds[0] ?? null,
    }));
  }

  private async validateAccessRuleTarget(
    tenantId: string,
    rule: z.infer<typeof OrgAiAccessRuleUpsertSchema>,
  ): Promise<void> {
    if (rule.scopeType === "org" && rule.scopeId !== tenantId) {
      throw new BadRequestException("Organization rules must target the current organization");
    }
    if (rule.scopeType === "user" && !await this.identity.getMembership(tenantId, rule.scopeId)) {
      throw new BadRequestException("The selected member does not belong to this organization");
    }
    if (rule.scopeType === "department" && !(await this.identity.listDepartments(tenantId)).some((department) => department.id === rule.scopeId)) {
      throw new BadRequestException("The selected department does not belong to this organization");
    }
    if (rule.resourceType === "model") {
      const models = await this.models.listModels(tenantId, { includeBlocked: true });
      if (!models.some((model) => `${model.providerId}:${model.model}` === rule.resourceId)) {
        throw new BadRequestException("The selected model is not registered in this organization");
      }
    }
  }

  private async requirePermission(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    OrgPermissionSchema.parse(permission);
    const allowed = await this.identity.authorize(request.auth!.user.id, tenantId, permission);
    if (!allowed) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }
}

@Controller("/v1/orgs/:tenantId/providers")
export class ModelProviderController {
  constructor(
    @Inject(MODEL_GOVERNANCE_SERVICE) private readonly models: ModelGovernanceService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Inject(ORGANIZATION_PROVIDER_RUNTIME) private readonly providerRuntime: OrganizationProviderRuntime,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "models:read");
    return z.array(OrganizationModelProviderSchema).parse(
      await this.models.listProviders(tenantId),
    );
  }

  @Put()
  async upsert(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    await this.requirePermission(request, tenantId, "models:write");
    const input = parseBody(OrganizationModelProviderUpsertSchema, body);
    const provider = OrganizationModelProviderSchema.parse(
      await this.models.upsertProvider(tenantId, input),
    );
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "models",
      action: "provider-upserted",
      targetType: "model_provider",
      targetId: provider.providerId,
      after: provider as never,
      metadata: { surface: "admin-api", storesSecret: false },
    });
    return provider;
  }

  @Post("/:providerId/test")
  async test(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("providerId") rawProviderId: string,
  ) {
    await this.requirePermission(request, tenantId, "models:write");
    const providerId = parseBody(ProviderIdSchema, rawProviderId);
    try {
      const provider = OrganizationModelProviderSchema.parse(
        await this.providerRuntime.testAndActivate(tenantId, providerId),
      );
      await this.audit?.append({
        tenantId,
        actorUserId: request.auth?.user.id ?? null,
        category: "models",
        action: "provider-activated",
        targetType: "model_provider",
        targetId: providerId,
        after: provider as never,
        metadata: { surface: "admin-api", healthTested: true },
      });
      return provider;
    } catch (cause) {
      if (!(cause instanceof OrganizationProviderHealthCheckError)) throw cause;
      if (cause.provider) {
        await this.audit?.append({
          tenantId,
          actorUserId: request.auth?.user.id ?? null,
          category: "models",
          action: "provider-activation-failed",
          targetType: "model_provider",
          targetId: providerId,
          after: cause.provider as never,
          metadata: { surface: "admin-api", healthTested: true },
        });
      }
      throw new BadGatewayException({
        code: "provider_health_check_failed",
        message: cause.message,
        provider: cause.provider,
      });
    }
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

function parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema> {
  const result = schema.safeParse(query);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

function parseConversationKind(value: string) {
  const result = ConversationKindSchema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
