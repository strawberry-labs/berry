import { BadGatewayException, BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Put, Query, Req } from "@nestjs/common";
import {
  ModelApiTypeSchema,
  ModelCapabilitiesSchema,
  ModelGovernanceDecisionSchema,
  ConversationKindSchema,
  JsonValueSchema,
  OrgAuxiliaryModelDefaultSchema,
  OrgAuxiliaryModelPurposeSchema,
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
import { MODEL_GOVERNANCE_SERVICE, runtimeModelCapabilities, type ModelGovernanceService } from "./model-governance.service.ts";
import {
  ORGANIZATION_PROVIDER_RUNTIME,
  OrganizationProviderHealthCheckError,
  type OrganizationProviderRuntime,
} from "./organization-provider-runtime.service.ts";
import { createCloudRuntimeConfigFromEnv } from "../runtime/cloud-runtime-config.ts";

const RUNTIME_CATALOG_TIMESTAMP = new Date().toISOString();

const UpsertModelPolicyRequestSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  displayName: z.string().trim().min(1).nullable().optional(),
  presetId: z.string().trim().min(1).nullable().optional(),
  apiType: ModelApiTypeSchema.nullable().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  status: z.enum(["allowed", "blocked"]).optional(),
  enforce: z.boolean().optional(),
  // Accepted for wire compatibility with older desktop clients. The web
  // policy surface no longer writes mode-specific policy values; upsertPolicy
  // deliberately strips this field before calling the repository.
  modeAllow: z.array(z.enum(["chat", "code", "cowork"])).optional(),
  metadata: JsonValueSchema.optional(),
}).strict();

const UpsertModelDefaultRequestSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  enforce: z.boolean().optional(),
}).strict();

const ResolveModelRequestSchema = z.object({
  // Kept optional for older clients; all requests now resolve the one task
  // experience regardless of any legacy mode value.
  mode: ConversationKindSchema.optional(),
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
    await this.synchronizeRuntimeCatalog(tenantId);
    const parsedMode = mode ? parseConversationKind(mode) : undefined;
    const includeBlockedModels = includeBlocked === "true";
    const stored = await this.models.listModels(tenantId, { includeBlocked: true });
    const synchronized = synchronizeRuntimeModels(tenantId, stored)
      .filter((policy) => includeBlockedModels || policy.status === "allowed")
      // Legacy `?mode=` remains a read-only compatibility filter. The web
      // catalog no longer sends it or renders separate mode choices.
      .filter((policy) => !parsedMode || policy.modeAllow.includes(parsedMode));
    return z.array(OrgModelPolicySchema).parse(synchronized);
  }

  @Put("/policies")
  async upsertPolicy(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "models:write");
    const parsed = parseBody(UpsertModelPolicyRequestSchema, body);
    const { modeAllow: _legacyModeAllow, ...taskPolicy } = parsed;
    const policy = OrgModelPolicySchema.parse(await this.models.upsertPolicy({ tenantId, ...taskPolicy }));
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
    await this.synchronizeRuntimeCatalog(tenantId);
    return z.array(OrgModelDefaultSchema).parse(await this.models.listDefaults(tenantId));
  }

  @Put("/default")
  async upsertTaskDefault(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    return this.saveTaskDefault(request, tenantId, body);
  }

  /** Compatibility route for old clients; the web client uses `/default`. */
  @Put("/defaults/:mode")
  async upsertDefault(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("mode") mode: string, @Body() body: unknown) {
    return this.saveLegacyDefault(request, tenantId, parseConversationKind(mode), body);
  }

  private async saveTaskDefault(request: AuthenticatedRequest, tenantId: string, body: unknown) {
    return this.saveLegacyDefault(request, tenantId, "chat", body);
  }

  private async saveLegacyDefault(request: AuthenticatedRequest, tenantId: string, mode: "chat" | "code", body: unknown) {
    await this.requirePermission(request, tenantId, "models:write");
    const parsed = parseBody(UpsertModelDefaultRequestSchema, body);
    const modelDefault = OrgModelDefaultSchema.parse(await this.models.upsertDefault({ tenantId, mode, ...parsed }));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "models",
      action: "default-upserted",
      targetType: "model_default",
      targetId: mode === "chat" ? "task" : mode,
      after: modelDefault as never,
      metadata: { surface: "admin-api" },
    });
    return modelDefault;
  }

  @Get("/auxiliary-defaults")
  async listAuxiliaryDefaults(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "models:read");
    await this.synchronizeRuntimeCatalog(tenantId);
    return z.array(OrgAuxiliaryModelDefaultSchema).parse(
      await this.models.listAuxiliaryDefaults(tenantId),
    );
  }

  @Put("/auxiliary-defaults/:purpose")
  async upsertAuxiliaryDefault(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("purpose") purpose: string,
    @Body() body: unknown,
  ) {
    await this.requirePermission(request, tenantId, "models:write");
    await this.synchronizeRuntimeCatalog(tenantId);
    const parsedPurpose = OrgAuxiliaryModelPurposeSchema.parse(purpose);
    const parsed = parseBody(UpsertModelDefaultRequestSchema.omit({ enforce: true }), body);
    let modelDefault;
    try {
      modelDefault = OrgAuxiliaryModelDefaultSchema.parse(
        await this.models.upsertAuxiliaryDefault({ tenantId, purpose: parsedPurpose, ...parsed }),
      );
    } catch (cause) {
      throw new BadRequestException(cause instanceof Error ? cause.message : "Invalid auxiliary model");
    }
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "models",
      action: "auxiliary-default-upserted",
      targetType: "auxiliary_model_default",
      targetId: modelDefault.purpose,
      after: modelDefault as never,
      metadata: { surface: "admin-api" },
    });
    return modelDefault;
  }

  @Post("/resolve")
  async resolve(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "models:read");
    await this.synchronizeRuntimeCatalog(tenantId);
    const parsed = parseBody(ResolveModelRequestSchema, body);
    const userId = request.auth?.user.id ?? null;
    const membership = userId ? await this.identity.getMembership(tenantId, userId) : null;
    return ModelGovernanceDecisionSchema.parse(await this.models.resolve({
      tenantId,
      mode: parsed.mode ?? "chat",
      providerId: parsed.providerId,
      model: parsed.model,
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

  private async synchronizeRuntimeCatalog(tenantId: string): Promise<void> {
    const provider = runtimeProviderConfiguration()?.provider;
    if (provider) await this.models.synchronizeRuntimeCatalog(tenantId, provider);
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
      synchronizeRuntimeProviders(tenantId, await this.models.listProviders(tenantId)),
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

function runtimeProviderConfiguration(env: NodeJS.ProcessEnv = process.env) {
  try {
    return createCloudRuntimeConfigFromEnv(env);
  } catch {
    return null;
  }
}

export function synchronizeRuntimeProviders(
  tenantId: string,
  stored: Array<z.infer<typeof OrganizationModelProviderSchema>>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const runtime = runtimeProviderConfiguration(env);
  const provider = runtime?.provider;
  if (!provider) return stored;
  const synchronized = OrganizationModelProviderSchema.parse({
    id: `runtime:${provider.id}`,
    tenantId,
    providerId: provider.id,
    displayName: provider.name,
    kind: provider.kind,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    endpointPath: provider.endpointPath ?? null,
    modelsPath: provider.modelsPath ?? null,
    authType: provider.authType,
    credentialRef: runtime.credentialRef ?? null,
    defaultModel: provider.defaultModel,
    enabled: true,
    status: "active",
    lastTestedAt: RUNTIME_CATALOG_TIMESTAMP,
    createdAt: RUNTIME_CATALOG_TIMESTAMP,
    updatedAt: RUNTIME_CATALOG_TIMESTAMP,
  });
  const existing = stored.find((candidate) => candidate.providerId === provider.id);
  if (existing?.status === "active") {
    const merged = OrganizationModelProviderSchema.parse({
      ...existing,
      displayName: provider.name,
      kind: provider.kind,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      endpointPath: provider.endpointPath ?? null,
      modelsPath: provider.modelsPath ?? null,
      authType: provider.authType,
      defaultModel: provider.defaultModel,
      enabled: true,
      status: "active",
    });
    return [merged, ...stored.filter((candidate) => candidate.providerId !== provider.id)];
  }
  return [synchronized, ...stored.filter((candidate) => candidate.providerId !== provider.id)];
}

export function synchronizeRuntimeModels(
  tenantId: string,
  stored: Array<z.infer<typeof OrgModelPolicySchema>>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const provider = runtimeProviderConfiguration(env)?.provider;
  if (!provider || !provider.models?.length) return stored;
  const runtimeIds = new Set(provider.models.map((model) => model.id));
  const retained = stored.filter((policy) => !(
    policy.providerId === provider.id
    && policy.model === "berry/auto"
    && !runtimeIds.has(policy.model)
    && typeof policy.metadata === "object"
    && policy.metadata !== null
    && !Array.isArray(policy.metadata)
    && policy.metadata.source === "self-host-seed"
  ));
  const byKey = new Map(retained.map((policy) => [`${policy.providerId}:${policy.model}`, policy]));
  for (const model of provider.models) {
    const key = `${provider.id}:${model.id}`;
    const existing = byKey.get(key);
    const capabilities = runtimeModelCapabilities(model) ?? existing?.capabilities ?? {};
    byKey.set(key, OrgModelPolicySchema.parse({
      id: existing?.id ?? `runtime:${provider.id}:${model.id}`,
      tenantId,
      providerId: provider.id,
      model: model.id,
      displayName: model.name ?? model.id,
      presetId: provider.kind === "berry-router" ? "berry-router" : existing?.presetId ?? null,
      apiType: model.apiType ?? provider.apiType,
      capabilities,
      status: existing?.status ?? "allowed",
      enforce: existing?.enforce ?? false,
      modeAllow: existing?.modeAllow ?? ["chat", "code"],
      metadata: { ...(typeof existing?.metadata === "object" && existing.metadata !== null && !Array.isArray(existing.metadata) ? existing.metadata : {}), source: "runtime-catalog" },
      createdAt: existing?.createdAt ?? RUNTIME_CATALOG_TIMESTAMP,
      updatedAt: RUNTIME_CATALOG_TIMESTAMP,
    }));
  }
  return [...byKey.values()].sort((left, right) => (left.displayName ?? left.model).localeCompare(right.displayName ?? right.model));
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
  const result = ConversationKindSchema.safeParse(value === "cowork" ? "chat" : value);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
