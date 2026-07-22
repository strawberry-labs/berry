import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Put, Query, Req } from "@nestjs/common";
import {
  DepartmentSchema,
  EffectivePermissionsSchema,
  FeatureFlagSchema,
  OrgMembershipSchema,
  OrgPermissionSchema,
  OrganizationSchema,
  ResourceAclPrincipalTypeSchema,
  ResourceAclSchema,
  RolePermissionSetSchema,
  SsoConnectionKindSchema,
  SsoConnectionSchema,
  SsoStartResponseSchema,
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
  slug: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  issuer: z.string().nullable().optional(),
  ssoUrl: z.string().url().nullable().optional(),
  metadataUrl: z.string().url().nullable().optional(),
  entityId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  clientSecretRef: z.string().nullable().optional(),
  domains: z.array(z.string()).optional(),
  scimEnabled: z.boolean().optional(),
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
    await this.requirePermission(request, tenantId, "org:admin");
    return z.array(OrgMembershipSchema).parse(await this.repository.listMemberships(tenantId));
  }

  @Post("/:tenantId/members")
  async createMember(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "org:admin");
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
    const connection = SsoConnectionSchema.parse(await this.repository.createSsoConnection({ tenantId, ...parsed }));
    await this.auditAdminMutation(request, tenantId, "identity", "sso-connection-created", "sso_connection", connection.id, connection);
    return connection;
  }

  @Get("/:tenantId/sso/start")
  async startSso(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query("connection") connectionId: string, @Query("redirectUri") redirectUri?: string) {
    await this.requirePermission(request, tenantId, "sso:read");
    if (!connectionId) throw new BadRequestException("connection query parameter is required");
    const connection = await this.repository.getSsoConnection(tenantId, connectionId);
    if (!connection) throw new BadRequestException("Unknown SSO connection");
    const state = `berry_${tenantId}_${Date.now()}`;
    const base = connection.ssoUrl ?? connection.metadataUrl;
    if (!base) throw new BadRequestException("SSO connection needs ssoUrl or metadataUrl before it can start");
    const url = new URL(base);
    if (connection.kind === "oidc") {
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", connection.clientId ?? connection.slug);
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri ?? "https://berry.example.com/v1/orgs/sso/callback");
    } else {
      url.searchParams.set("SAMLRequest", "berry-saml-request-placeholder");
      url.searchParams.set("RelayState", state);
    }
    return SsoStartResponseSchema.parse({
      connectionId: connection.id,
      kind: connection.kind,
      redirectUrl: url.toString(),
      state,
    });
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
