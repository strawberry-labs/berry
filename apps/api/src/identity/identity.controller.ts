import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Put, Query, Req, ServiceUnavailableException } from "@nestjs/common";
import {
  DepartmentSchema,
  EffectivePermissionsSchema,
  FeatureFlagSchema,
  OrgMembershipSchema,
  OrgMembershipUpdateSchema,
  OrgPermissionSchema,
  OrganizationSchema,
  ResourceAclPrincipalTypeSchema,
  ResourceAclSchema,
  RolePermissionSetSchema,
  SsoConnectionKindSchema,
  SsoConnectionSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  IdentityMemberConflictError,
  IdentityMemberLimitError,
  type EnterpriseIdentityRepository,
} from "./identity.repository.ts";

const CreateOrgMemberRequestSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(128),
  role: z.enum(["admin", "member"]).default("member"),
}).strict();

const CreateDepartmentRequestSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).optional(),
  externalId: z.string().nullable().optional(),
}).strict();

const CreateSsoConnectionRequestSchema = z.object({
  kind: SsoConnectionKindSchema,
  provider: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default("generic"),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  displayName: z.string().trim().min(1).max(120),
  status: z.enum(["draft", "enabled", "disabled"]).default("draft"),
  issuer: z.string().url().nullable().optional(),
  ssoUrl: z.string().url().nullable().optional(),
  metadataUrl: z.string().url().nullable().optional(),
  entityId: z.string().trim().max(1024).nullable().optional(),
  clientId: z.string().trim().max(1024).nullable().optional(),
  clientSecret: z.string().trim().min(1).max(8192).optional(),
  domains: z.array(z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)).max(20).default([]),
  jitProvisioning: z.boolean().default(true),
  defaultRole: z.literal("member").default("member"),
  scimEnabled: z.boolean().default(false),
}).strict();

const UpdateRolePermissionsRequestSchema = z.object({
  permissions: z.array(OrgPermissionSchema),
  source: z.string().trim().min(1).optional(),
}).strict();

const UpsertFeatureFlagRequestSchema = z.object({
  enabled: z.boolean(),
  roleDefaults: z.record(z.array(OrgPermissionSchema)).optional(),
}).strict();

const UpsertResourceAclRequestSchema = z.object({
  resourceType: z.string().trim().min(1),
  resourceId: z.string().trim().min(1),
  principalType: ResourceAclPrincipalTypeSchema,
  principalId: z.string().trim().min(1),
  allow: z.array(OrgPermissionSchema).optional(),
  deny: z.array(OrgPermissionSchema).optional(),
}).strict();

@Controller("/v1/orgs")
export class IdentityController {
  constructor(
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly repository: EnterpriseIdentityRepository,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  @Get()
  async listOrganizations(@Req() request: AuthenticatedRequest, @Query("host") host?: string) {
    return z.array(OrganizationSchema).parse(await this.repository.listOrganizations(request.auth!.user.id, host ?? request.headers.host));
  }

  @Get("/current")
  async currentOrganization(@Req() request: AuthenticatedRequest, @Query("host") host?: string) {
    const organization = await this.repository.resolveOrganizationByHost(host ?? request.headers.host ?? "localhost");
    if (organization) return OrganizationSchema.parse(organization);
    const organizations = await this.repository.listOrganizations(request.auth!.user.id);
    return OrganizationSchema.parse(organizations[0]);
  }

  @Get("/:tenantId/members")
  async listMembers(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "members:read");
    return z.array(OrgMembershipSchema).parse(await this.repository.listMemberships(tenantId));
  }

  @Post("/:tenantId/members")
  async createMember(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "members:write");
    const parsed = parseBody(CreateOrgMemberRequestSchema, body);
    try {
      const membership = OrgMembershipSchema.parse(await this.repository.createMembership({ tenantId, ...parsed }));
      await this.auditAdminMutation(request, tenantId, "identity", "member-created", "user", membership.userId, membership);
      return membership;
    } catch (cause) {
      if (cause instanceof IdentityMemberConflictError || cause instanceof IdentityMemberLimitError) {
        throw new ConflictException(cause.message);
      }
      throw cause;
    }
  }

  @Put("/:tenantId/members/:userId")
  async updateMember(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    await this.requirePermission(request, tenantId, "members:write");
    const parsed = parseBody(OrgMembershipUpdateSchema, body);
    const current = await this.repository.getMembership(tenantId, userId);
    if (!current) throw new BadRequestException("Organization member not found");
    if (current.role === "owner" && (parsed.role !== undefined || parsed.status && parsed.status !== "active")) {
      throw new BadRequestException("The organization owner cannot be demoted, blocked, or offboarded here");
    }
    if (request.auth?.user.id === userId && parsed.status && parsed.status !== "active") {
      throw new BadRequestException("You cannot block or offboard your own account");
    }
    const departmentIds = parsed.departmentIds ?? current.departmentIds;
    const primaryDepartmentId = parsed.primaryDepartmentId !== undefined
      ? parsed.primaryDepartmentId
      : current.primaryDepartmentId ?? null;
    const validDepartments = new Set((await this.repository.listDepartments(tenantId)).map((department) => department.id));
    if (departmentIds.some((departmentId) => !validDepartments.has(departmentId))) {
      throw new BadRequestException("One or more selected departments do not belong to this organization");
    }
    if (primaryDepartmentId && !departmentIds.includes(primaryDepartmentId)) {
      throw new BadRequestException("Primary department must be included in the member's departments");
    }
    const membership = OrgMembershipSchema.parse(await this.repository.updateMembership(tenantId, userId, parsed));
    await this.auditAdminMutation(request, tenantId, "identity", "member-updated", "user", userId, membership);
    return membership;
  }

  @Get("/:tenantId/departments")
  async listDepartments(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "departments:read");
    return z.array(DepartmentSchema).parse(await this.repository.listDepartments(tenantId));
  }

  @Post("/:tenantId/departments")
  async createDepartment(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "departments:write");
    const parsed = parseBody(CreateDepartmentRequestSchema, body);
    const department = DepartmentSchema.parse(await this.repository.createDepartment({ tenantId, ...parsed }));
    await this.auditAdminMutation(request, tenantId, "identity", "department-created", "department", department.id, department);
    return department;
  }

  @Get("/:tenantId/permissions/me")
  async effectivePermissions(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "org:read");
    return EffectivePermissionsSchema.parse(await this.repository.getEffectivePermissions(tenantId, request.auth!.user.id));
  }

  @Get("/:tenantId/roles")
  async listRolePermissions(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "rbac:read");
    return z.array(RolePermissionSetSchema).parse(await this.repository.listRolePermissions(tenantId));
  }

  @Put("/:tenantId/roles/:role/permissions")
  async updateRolePermissions(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("role") role: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "rbac:write");
    const parsed = parseBody(UpdateRolePermissionsRequestSchema, body);
    const permissions = RolePermissionSetSchema.parse(await this.repository.upsertRolePermissions({ tenantId, role, ...parsed }));
    await this.auditAdminMutation(request, tenantId, "rbac", "role-permissions-updated", "role", role, permissions);
    return permissions;
  }

  @Get("/:tenantId/feature-flags")
  async listFeatureFlags(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "feature_flags:read");
    return z.array(FeatureFlagSchema).parse(await this.repository.listFeatureFlags(tenantId));
  }

  @Put("/:tenantId/feature-flags/:flag")
  async upsertFeatureFlag(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("flag") flag: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "feature_flags:write");
    const parsed = parseBody(UpsertFeatureFlagRequestSchema, body);
    const featureFlag = FeatureFlagSchema.parse(await this.repository.upsertFeatureFlag({ tenantId, flag, ...parsed }));
    await this.auditAdminMutation(request, tenantId, "rbac", "feature-flag-updated", "feature_flag", flag, featureFlag);
    return featureFlag;
  }

  @Get("/:tenantId/acls")
  async listResourceAcls(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query("resourceType") resourceType?: string, @Query("resourceId") resourceId?: string) {
    await this.requirePermission(request, tenantId, "acl:read");
    const resource = resourceType && resourceId ? { type: resourceType, id: resourceId } : undefined;
    return z.array(ResourceAclSchema).parse(await this.repository.listResourceAcls(tenantId, resource));
  }

  @Put("/:tenantId/acls")
  async upsertResourceAcl(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "acl:write");
    const parsed = parseBody(UpsertResourceAclRequestSchema, body);
    const acl = ResourceAclSchema.parse(await this.repository.upsertResourceAcl({ tenantId, ...parsed }));
    await this.auditAdminMutation(request, tenantId, "rbac", "resource-acl-updated", "resource_acl", acl.id, acl);
    return acl;
  }

  @Get("/:tenantId/sso/connections")
  async listSsoConnections(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "sso:read");
    return z.array(SsoConnectionSchema).parse(await this.repository.listSsoConnections(tenantId));
  }

  @Post("/:tenantId/sso/connections")
  async createSsoConnection(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "sso:write");
    const parsed = parseBody(CreateSsoConnectionRequestSchema, body);
    const existing = (await this.repository.listSsoConnections(tenantId)).find((connection) => connection.slug === parsed.slug);
    if (parsed.provider === "google") {
      if (parsed.kind !== "oidc") throw new BadRequestException("Google Workspace SSO must use OIDC");
      if (parsed.domains.length !== 1) throw new BadRequestException("Google Workspace SSO requires exactly one hosted domain");
      if (!parsed.clientId) throw new BadRequestException("Google Workspace SSO requires a client ID");
      if (existing?.clientId && existing.clientId !== parsed.clientId && !parsed.clientSecret) {
        throw new BadRequestException("Enter the matching client secret when changing the Google client ID");
      }
      if (parsed.status === "enabled" && !parsed.clientSecret && !existing?.clientSecretConfigured) {
        throw new BadRequestException("Enter a Google client secret before enabling SSO");
      }
    } else if (parsed.status === "enabled") {
      throw new BadRequestException("Only Google Workspace OIDC can be enabled in this release");
    }

    try {
      const connection = SsoConnectionSchema.parse(await this.repository.createSsoConnection({
        tenantId,
        ...parsed,
        issuer: parsed.provider === "google" ? "https://accounts.google.com" : parsed.issuer,
      }));
      await this.auditAdminMutation(
        request,
        tenantId,
        "identity",
        existing ? "sso-connection-updated" : "sso-connection-created",
        "sso_connection",
        connection.id,
        connection,
      );
      return connection;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("BERRY_CONNECTOR_ENCRYPTION_KEY")) {
        throw new ServiceUnavailableException("SSO secret encryption is not configured on this deployment");
      }
      throw cause;
    }
  }

  private async requirePermission(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    const allowed = await this.repository.authorize(request.auth!.user.id, tenantId, permission);
    if (!allowed) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }

  private async auditAdminMutation(request: AuthenticatedRequest, tenantId: string, category: string, action: string, targetType: string, targetId: string, after: unknown): Promise<void> {
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category,
      action,
      targetType,
      targetId,
      after: after as never,
      metadata: { surface: "admin-api" },
    });
  }
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
