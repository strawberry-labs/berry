import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import {
  SELF_HOST_TENANT_ID,
  SELF_HOST_TENANT_SLUG,
  SELF_HOST_WORKSPACE_SLUG,
} from "@berry/db";
import {
  DepartmentSchema,
  EffectivePermissionsSchema,
  FeatureFlagSchema,
  OrganizationSchema,
  ResourceAclSchema,
  RolePermissionSetSchema,
  ScimGroupSchema,
  ScimUserSchema,
  SsoConnectionSchema,
  type Department,
  type EffectivePermissions,
  type FeatureFlag,
  type JsonValue,
  type OrgMembership,
  type OrgPermission,
  type Organization,
  type ResourceAcl,
  type ResourceAclPrincipalType,
  type RolePermissionSet,
  type ScimGroup,
  type ScimUser,
  type SsoConnection,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";

export const ENTERPRISE_IDENTITY_REPOSITORY = Symbol("ENTERPRISE_IDENTITY_REPOSITORY");

const BASE_ROLE_PERMISSIONS: Record<string, OrgPermission[]> = {
  owner: ["org:read", "org:admin", "members:read", "members:write", "departments:read", "departments:write", "sso:read", "sso:write", "rbac:read", "rbac:write", "feature_flags:read", "feature_flags:write", "acl:read", "acl:write", "org_settings:read", "org_settings:write"],
  admin: ["org:read", "org:admin", "members:read", "members:write", "departments:read", "departments:write", "sso:read", "sso:write", "rbac:read", "feature_flags:read", "acl:read", "org_settings:read"],
  member: ["org:read", "departments:read", "sso:read"],
};

const ENTERPRISE_GOVERNANCE_ROLE_DEFAULTS: Record<string, OrgPermission[]> = {
  owner: ["budgets:read", "budgets:write", "usage:read", "usage:export", "reports:read", "reports:write", "alerts:read", "alerts:write", "billing:read", "billing:write", "guardrails:read", "guardrails:write", "data_policy:read", "data_policy:write", "auth_policy:read", "auth_policy:write", "service_accounts:read", "service_accounts:write", "models:read", "models:write", "policy:read", "policy:write", "audit:read", "audit:export", "skills:read", "skills:write", "mcp:read", "mcp:write"],
  admin: ["budgets:read", "budgets:write", "usage:read", "usage:export", "reports:read", "reports:write", "alerts:read", "alerts:write", "billing:read", "guardrails:read", "guardrails:write", "data_policy:read", "auth_policy:read", "service_accounts:read", "models:read", "models:write", "policy:read", "audit:read", "skills:read", "skills:write", "mcp:read", "mcp:write"],
  member: ["models:read", "skills:read", "mcp:read"],
};

export type CreateDepartmentInput = {
  tenantId: string;
  parentId?: string | null | undefined;
  name: string;
  slug?: string | undefined;
  externalId?: string | null | undefined;
};

export type CreateOrgMemberInput = {
  tenantId: string;
  email: string;
  name: string;
  password: string;
  role: "admin" | "member";
};

export class IdentityMemberConflictError extends Error {
  constructor(message = "A user with this email address already exists") {
    super(message);
    this.name = "IdentityMemberConflictError";
  }
}

export class IdentityMemberLimitError extends Error {
  constructor(readonly maxUsers: number) {
    super(`This Berry instance is limited to ${maxUsers} users`);
    this.name = "IdentityMemberLimitError";
  }
}

export type CreateSsoConnectionInput = {
  tenantId: string;
  kind: "saml" | "oidc";
  slug: string;
  displayName: string;
  issuer?: string | null | undefined;
  ssoUrl?: string | null | undefined;
  metadataUrl?: string | null | undefined;
  entityId?: string | null | undefined;
  clientId?: string | null | undefined;
  clientSecretRef?: string | null | undefined;
  domains?: string[] | undefined;
  scimEnabled?: boolean | undefined;
};

export type AuthorizationResource = {
  type: string;
  id: string;
};

export type UpsertRolePermissionsInput = {
  tenantId: string;
  role: string;
  permissions: OrgPermission[];
  source?: string | undefined;
};

export type UpsertFeatureFlagInput = {
  tenantId: string;
  flag: string;
  enabled: boolean;
  roleDefaults?: Record<string, OrgPermission[]> | undefined;
};

export type UpsertResourceAclInput = {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  principalType: ResourceAclPrincipalType;
  principalId: string;
  allow?: OrgPermission[] | undefined;
  deny?: OrgPermission[] | undefined;
};

export interface EnterpriseIdentityRepository {
  listOrganizations(userId: string, host?: string | undefined): Promise<Organization[]>;
  resolveOrganizationByHost(host: string): Promise<Organization | null>;
  listMemberships(tenantId: string): Promise<OrgMembership[]>;
  createMembership(input: CreateOrgMemberInput): Promise<OrgMembership>;
  getMembership(tenantId: string, userId: string): Promise<OrgMembership | null>;
  getEffectivePermissions(tenantId: string, userId: string): Promise<EffectivePermissions>;
  authorize(userId: string, tenantId: string, permission: OrgPermission, resource?: AuthorizationResource | undefined): Promise<boolean>;
  listRolePermissions(tenantId: string): Promise<RolePermissionSet[]>;
  upsertRolePermissions(input: UpsertRolePermissionsInput): Promise<RolePermissionSet>;
  listFeatureFlags(tenantId: string): Promise<FeatureFlag[]>;
  upsertFeatureFlag(input: UpsertFeatureFlagInput): Promise<FeatureFlag>;
  listResourceAcls(tenantId: string, resource?: AuthorizationResource | undefined): Promise<ResourceAcl[]>;
  upsertResourceAcl(input: UpsertResourceAclInput): Promise<ResourceAcl>;
  listDepartments(tenantId: string): Promise<Department[]>;
  createDepartment(input: CreateDepartmentInput): Promise<Department>;
  listSsoConnections(tenantId: string): Promise<SsoConnection[]>;
  createSsoConnection(input: CreateSsoConnectionInput): Promise<SsoConnection>;
  getSsoConnection(tenantId: string, idOrSlug: string): Promise<SsoConnection | null>;
  upsertScimUser(tenantId: string, input: ScimUser): Promise<ScimUser>;
  deprovisionScimUser(tenantId: string, idOrExternalId: string): Promise<{ id: string; alreadyDeprovisioned: boolean }>;
  upsertScimGroup(tenantId: string, input: ScimGroup): Promise<ScimGroup>;
  deprovisionScimGroup(tenantId: string, idOrExternalId: string): Promise<{ id: string; alreadyDeprovisioned: boolean }>;
}

export class InMemoryEnterpriseIdentityRepository implements EnterpriseIdentityRepository {
  readonly #organizations = new Map<string, Organization>();
  readonly #memberships = new Map<string, OrgMembership>();
  readonly #rolePermissions = new Map<string, RolePermissionSet>();
  readonly #featureFlags = new Map<string, FeatureFlag>();
  readonly #resourceAcls = new Map<string, ResourceAcl>();
  readonly #departments = new Map<string, Department>();
  readonly #sso = new Map<string, SsoConnection>();
  readonly #scimUsers = new Map<string, ScimUser>();
  readonly #scimGroups = new Map<string, ScimGroup>();
  readonly #deprovisionedUsers = new Set<string>();
  readonly #deprovisionedGroups = new Set<string>();

  constructor(private readonly maxUsers = 10) {
    const now = new Date().toISOString();
    this.#organizations.set(SELF_HOST_TENANT_ID, OrganizationSchema.parse({
      id: SELF_HOST_TENANT_ID,
      slug: SELF_HOST_TENANT_SLUG,
      name: "Berry Self-Host",
      deploymentMode: "selfhost",
      plan: "selfhost",
      status: "active",
      role: "owner",
      hostname: "localhost",
      createdAt: now,
      updatedAt: now,
    }));
    for (const [role, permissions] of Object.entries(BASE_ROLE_PERMISSIONS)) {
      this.#rolePermissions.set(`${SELF_HOST_TENANT_ID}:${role}`, RolePermissionSetSchema.parse({
        tenantId: SELF_HOST_TENANT_ID,
        role,
        permissions,
        source: "system",
        updatedAt: now,
      }));
    }
    this.#featureFlags.set(`${SELF_HOST_TENANT_ID}:enterprise-governance`, FeatureFlagSchema.parse({
      tenantId: SELF_HOST_TENANT_ID,
      flag: "enterprise-governance",
      enabled: true,
      roleDefaults: ENTERPRISE_GOVERNANCE_ROLE_DEFAULTS,
      updatedAt: now,
    }));
    this.#memberships.set(`${SELF_HOST_TENANT_ID}:00000000-0000-7000-8000-000000000201`, {
      tenantId: SELF_HOST_TENANT_ID,
      userId: "00000000-0000-7000-8000-000000000201",
      email: "test@example.test",
      name: "Test User",
      status: "active",
      role: "owner",
      departmentIds: [],
      externalId: null,
      source: "manual",
      joinedAt: now,
      updatedAt: now,
    });
    this.#memberships.set(`${SELF_HOST_TENANT_ID}:00000000-0000-7000-8000-000000000202`, {
      tenantId: SELF_HOST_TENANT_ID,
      userId: "00000000-0000-7000-8000-000000000202",
      email: "member@example.test",
      name: "Member User",
      status: "active",
      role: "member",
      departmentIds: [],
      externalId: null,
      source: "manual",
      joinedAt: now,
      updatedAt: now,
    });
    this.#departments.set(`${SELF_HOST_TENANT_ID}:default`, DepartmentSchema.parse({
      id: "dept_self_host_default",
      tenantId: SELF_HOST_TENANT_ID,
      parentId: null,
      name: "Default",
      slug: SELF_HOST_WORKSPACE_SLUG,
      externalId: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }));
  }

  async listOrganizations(_userId: string, host?: string | undefined): Promise<Organization[]> {
    const hostOrg = host ? await this.resolveOrganizationByHost(host) : null;
    if (hostOrg) return [hostOrg];
    return [...this.#organizations.values()];
  }

  async resolveOrganizationByHost(host: string): Promise<Organization | null> {
    const normalized = normalizeHost(host);
    return [...this.#organizations.values()].find((org) => org.hostname === normalized || (normalized === "localhost" && org.id === SELF_HOST_TENANT_ID)) ?? null;
  }

  async getMembership(tenantId: string, userId: string): Promise<OrgMembership | null> {
    return this.#memberships.get(`${tenantId}:${userId}`) ?? null;
  }

  async listMemberships(tenantId: string): Promise<OrgMembership[]> {
    return [...this.#memberships.values()]
      .filter((membership) => membership.tenantId === tenantId)
      .sort((left, right) => left.email.localeCompare(right.email));
  }

  async createMembership(input: CreateOrgMemberInput): Promise<OrgMembership> {
    const existing = [...this.#memberships.values()].find((membership) => membership.email.toLowerCase() === input.email.toLowerCase());
    if (existing) throw new IdentityMemberConflictError();
    if ((await this.listMemberships(input.tenantId)).length >= this.maxUsers) throw new IdentityMemberLimitError(this.maxUsers);
    const now = new Date().toISOString();
    const membership: OrgMembership = {
      tenantId: input.tenantId,
      userId: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      status: "active",
      role: input.role,
      departmentIds: [],
      externalId: null,
      source: "manual",
      joinedAt: now,
      updatedAt: now,
    };
    this.#memberships.set(`${input.tenantId}:${membership.userId}`, membership);
    return membership;
  }

  async getEffectivePermissions(tenantId: string, userId: string): Promise<EffectivePermissions> {
    const membership = await this.getMembership(tenantId, userId);
    if (!membership || membership.status !== "active") {
      return EffectivePermissionsSchema.parse({ tenantId, userId, role: "none", permissions: [], featureFlags: [] });
    }
    const flags = await this.listFeatureFlags(tenantId);
    return EffectivePermissionsSchema.parse({
      tenantId,
      userId,
      role: membership.role,
      permissions: effectivePermissionsForRole(membership.role, await this.listRolePermissions(tenantId), flags),
      featureFlags: flags,
    });
  }

  async authorize(userId: string, tenantId: string, permission: OrgPermission, resource?: AuthorizationResource | undefined): Promise<boolean> {
    const effective = await this.getEffectivePermissions(tenantId, userId);
    if (!effective.permissions.includes(permission)) return false;
    if (!resource) return true;
    return aclAllows(permission, await this.listResourceAcls(tenantId, resource), effective.role, userId, []);
  }

  async listRolePermissions(tenantId: string): Promise<RolePermissionSet[]> {
    return [...this.#rolePermissions.values()].filter((entry) => entry.tenantId === tenantId);
  }

  async upsertRolePermissions(input: UpsertRolePermissionsInput): Promise<RolePermissionSet> {
    const now = new Date().toISOString();
    const entry = RolePermissionSetSchema.parse({
      tenantId: input.tenantId,
      role: input.role,
      permissions: uniquePermissions(input.permissions),
      source: input.source ?? "admin",
      updatedAt: now,
    });
    this.#rolePermissions.set(`${input.tenantId}:${input.role}`, entry);
    return entry;
  }

  async listFeatureFlags(tenantId: string): Promise<FeatureFlag[]> {
    return [...this.#featureFlags.values()].filter((flag) => flag.tenantId === tenantId);
  }

  async upsertFeatureFlag(input: UpsertFeatureFlagInput): Promise<FeatureFlag> {
    const now = new Date().toISOString();
    const flag = FeatureFlagSchema.parse({
      tenantId: input.tenantId,
      flag: input.flag,
      enabled: input.enabled,
      roleDefaults: input.roleDefaults ?? {},
      updatedAt: now,
    });
    this.#featureFlags.set(`${input.tenantId}:${input.flag}`, flag);
    return flag;
  }

  async listResourceAcls(tenantId: string, resource?: AuthorizationResource | undefined): Promise<ResourceAcl[]> {
    return [...this.#resourceAcls.values()].filter((acl) =>
      acl.tenantId === tenantId && (!resource || (acl.resourceType === resource.type && acl.resourceId === resource.id)),
    );
  }

  async upsertResourceAcl(input: UpsertResourceAclInput): Promise<ResourceAcl> {
    const now = new Date().toISOString();
    const existing = this.#resourceAcls.get(aclKey(input.tenantId, input.resourceType, input.resourceId, input.principalType, input.principalId));
    const acl = ResourceAclSchema.parse({
      id: existing?.id ?? randomUUID(),
      tenantId: input.tenantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      principalType: input.principalType,
      principalId: input.principalId,
      allow: uniquePermissions(input.allow ?? []),
      deny: uniquePermissions(input.deny ?? []),
      updatedAt: now,
    });
    this.#resourceAcls.set(aclKey(input.tenantId, input.resourceType, input.resourceId, input.principalType, input.principalId), acl);
    return acl;
  }

  async listDepartments(tenantId: string): Promise<Department[]> {
    return [...this.#departments.values()].filter((department) => department.tenantId === tenantId && department.status !== "deleted");
  }

  async createDepartment(input: CreateDepartmentInput): Promise<Department> {
    const now = new Date().toISOString();
    const department = DepartmentSchema.parse({
      id: randomUUID(),
      tenantId: input.tenantId,
      parentId: input.parentId ?? null,
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      externalId: input.externalId ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    this.#departments.set(`${input.tenantId}:${department.id}`, department);
    return department;
  }

  async listSsoConnections(tenantId: string): Promise<SsoConnection[]> {
    return [...this.#sso.values()].filter((connection) => connection.tenantId === tenantId);
  }

  async createSsoConnection(input: CreateSsoConnectionInput): Promise<SsoConnection> {
    const now = new Date().toISOString();
    const connection = SsoConnectionSchema.parse({
      id: randomUUID(),
      tenantId: input.tenantId,
      kind: input.kind,
      slug: input.slug,
      displayName: input.displayName,
      status: "enabled",
      issuer: input.issuer ?? null,
      ssoUrl: input.ssoUrl ?? null,
      metadataUrl: input.metadataUrl ?? null,
      entityId: input.entityId ?? null,
      clientId: input.clientId ?? null,
      clientSecretRef: input.clientSecretRef ?? null,
      domains: input.domains ?? [],
      scimEnabled: input.scimEnabled ?? false,
      createdAt: now,
      updatedAt: now,
    });
    this.#sso.set(`${input.tenantId}:${connection.id}`, connection);
    this.#sso.set(`${input.tenantId}:${connection.slug}`, connection);
    return connection;
  }

  async getSsoConnection(tenantId: string, idOrSlug: string): Promise<SsoConnection | null> {
    return this.#sso.get(`${tenantId}:${idOrSlug}`) ?? null;
  }

  async upsertScimUser(tenantId: string, input: ScimUser): Promise<ScimUser> {
    const external = input.externalId ?? input.userName;
    const existing = this.#scimUsers.get(`${tenantId}:${external}`);
    const user = ScimUserSchema.parse({ ...input, id: existing?.id ?? input.id ?? randomUUID(), externalId: external });
    this.#scimUsers.set(`${tenantId}:${external}`, user);
    this.#scimUsers.set(`${tenantId}:${user.id}`, user);
    if (user.active) this.#deprovisionedUsers.delete(`${tenantId}:${user.id}`);
    return user;
  }

  async deprovisionScimUser(tenantId: string, idOrExternalId: string): Promise<{ id: string; alreadyDeprovisioned: boolean }> {
    const key = `${tenantId}:${idOrExternalId}`;
    const existing = this.#scimUsers.get(key);
    const id = existing?.id ?? idOrExternalId;
    const deprovisionKey = `${tenantId}:${id}`;
    const alreadyDeprovisioned = this.#deprovisionedUsers.has(deprovisionKey);
    this.#deprovisionedUsers.add(deprovisionKey);
    if (existing) {
      const disabled = ScimUserSchema.parse({ ...existing, active: false });
      this.#scimUsers.set(`${tenantId}:${existing.externalId ?? existing.userName}`, disabled);
      this.#scimUsers.set(`${tenantId}:${existing.id}`, disabled);
    }
    return { id, alreadyDeprovisioned };
  }

  async upsertScimGroup(tenantId: string, input: ScimGroup): Promise<ScimGroup> {
    const external = input.externalId ?? input.displayName;
    const existing = this.#scimGroups.get(`${tenantId}:${external}`);
    const group = ScimGroupSchema.parse({ ...input, id: existing?.id ?? input.id ?? randomUUID(), externalId: external });
    this.#scimGroups.set(`${tenantId}:${external}`, group);
    this.#scimGroups.set(`${tenantId}:${group.id}`, group);
    await this.createDepartment({ tenantId, name: group.displayName, slug: slugify(group.displayName), externalId: external });
    if (group.id) this.#deprovisionedGroups.delete(`${tenantId}:${group.id}`);
    return group;
  }

  async deprovisionScimGroup(tenantId: string, idOrExternalId: string): Promise<{ id: string; alreadyDeprovisioned: boolean }> {
    const key = `${tenantId}:${idOrExternalId}`;
    const existing = this.#scimGroups.get(key);
    const id = existing?.id ?? idOrExternalId;
    const deprovisionKey = `${tenantId}:${id}`;
    const alreadyDeprovisioned = this.#deprovisionedGroups.has(deprovisionKey);
    this.#deprovisionedGroups.add(deprovisionKey);
    return { id, alreadyDeprovisioned };
  }
}

export class PostgresEnterpriseIdentityRepository implements EnterpriseIdentityRepository {
  constructor(private readonly database: CloudDatabaseService, private readonly maxUsers = 10) {}

  async listOrganizations(userId: string, host?: string | undefined): Promise<Organization[]> {
    const hostOrg = host ? await this.resolveOrganizationByHost(host) : null;
    if (hostOrg) return [hostOrg];
    const rows = await this.database.withTenant(this.database.selfHostTenantId, (executor) => executor.query<OrganizationRow>(`
      SELECT t.id, t.slug, t.name, t.deployment_mode, t.plan, t.status, tm.role, NULL::text AS hostname, t.created_at, t.updated_at
      FROM tenant_memberships tm
      JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1::uuid AND tm.status = 'active' AND t.deleted_at IS NULL
      ORDER BY t.name ASC
    `, [userId]));
    return rows.map(orgFromRow);
  }

  async resolveOrganizationByHost(host: string): Promise<Organization | null> {
    const rows = await this.database.withTenant(this.database.selfHostTenantId, (executor) => executor.query<OrganizationRow>(`
      SELECT t.id, t.slug, t.name, t.deployment_mode, t.plan, t.status, 'member' AS role, th.hostname, t.created_at, t.updated_at
      FROM tenant_hostnames th
      JOIN tenants t ON t.id = th.tenant_id
      WHERE th.hostname = $1 AND th.status = 'active' AND t.deleted_at IS NULL
      LIMIT 1
    `, [normalizeHost(host)]));
    return rows[0] ? orgFromRow(rows[0]) : null;
  }

  async getMembership(tenantId: string, userId: string): Promise<OrgMembership | null> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<MembershipRow>(`
      SELECT tm.tenant_id, tm.user_id, u.email, u.name, tm.status, tm.role, tm.external_id, tm.source, tm.joined_at, tm.updated_at,
        COALESCE(jsonb_agg(dm.department_id) FILTER (WHERE dm.department_id IS NOT NULL), '[]'::jsonb) AS department_ids
      FROM tenant_memberships tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN department_memberships dm ON dm.tenant_id = tm.tenant_id AND dm.user_id = tm.user_id
      WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid
      GROUP BY tm.tenant_id, tm.user_id, u.email, u.name, tm.status, tm.role, tm.external_id, tm.source, tm.joined_at, tm.updated_at
      LIMIT 1
    `, [tenantId, userId]));
    return rows[0] ? membershipFromRow(rows[0]) : null;
  }

  async listMemberships(tenantId: string): Promise<OrgMembership[]> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<MembershipRow>(`
      SELECT tm.tenant_id, tm.user_id, u.email, u.name, tm.status, tm.role, tm.external_id, tm.source, tm.joined_at, tm.updated_at,
        COALESCE(jsonb_agg(dm.department_id) FILTER (WHERE dm.department_id IS NOT NULL), '[]'::jsonb) AS department_ids
      FROM tenant_memberships tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN department_memberships dm ON dm.tenant_id = tm.tenant_id AND dm.user_id = tm.user_id
      WHERE tm.tenant_id = $1::uuid
      GROUP BY tm.tenant_id, tm.user_id, u.email, u.name, tm.status, tm.role, tm.external_id, tm.source, tm.joined_at, tm.updated_at
      ORDER BY u.email ASC
    `, [tenantId]));
    return rows.map(membershipFromRow);
  }

  async createMembership(input: CreateOrgMemberInput): Promise<OrgMembership> {
    const email = input.email.trim().toLowerCase();
    const password = await hashPassword(input.password);
    const userId = await this.database.withTenant(input.tenantId, async (executor) => {
      const existing = await executor.query<{ id: string }>(
        "SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1",
        [email],
      );
      if (existing[0]) throw new IdentityMemberConflictError();
      const members = await executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM tenant_memberships WHERE tenant_id = $1::uuid AND status <> 'deprovisioned'",
        [input.tenantId],
      );
      if (Number(members[0]?.count ?? "0") >= this.maxUsers) throw new IdentityMemberLimitError(this.maxUsers);
      const users = await executor.query<{ id: string }>(`
        INSERT INTO users (email, name, email_verified, status)
        VALUES ($1, $2, true, 'active')
        RETURNING id
      `, [email, input.name.trim()]);
      const createdUserId = users[0]!.id;
      await executor.execute(`
        INSERT INTO auth_accounts (user_id, account_id, provider_id, password)
        VALUES ($1::uuid, $1, 'credential', $2)
      `, [createdUserId, password]);
      await executor.execute(`
        INSERT INTO tenant_memberships (tenant_id, user_id, status, role, source)
        VALUES ($1::uuid, $2::uuid, 'active', $3, 'manual')
      `, [input.tenantId, createdUserId, input.role]);
      return createdUserId;
    });
    return (await this.getMembership(input.tenantId, userId))!;
  }

  async getEffectivePermissions(tenantId: string, userId: string): Promise<EffectivePermissions> {
    const membership = await this.getMembership(tenantId, userId);
    if (!membership || membership.status !== "active") {
      return EffectivePermissionsSchema.parse({ tenantId, userId, role: "none", permissions: [], featureFlags: [] });
    }
    const flags = await this.listFeatureFlags(tenantId);
    return EffectivePermissionsSchema.parse({
      tenantId,
      userId,
      role: membership.role,
      permissions: effectivePermissionsForRole(membership.role, await this.listRolePermissions(tenantId), flags),
      featureFlags: flags,
    });
  }

  async authorize(userId: string, tenantId: string, permission: OrgPermission, resource?: AuthorizationResource | undefined): Promise<boolean> {
    const membership = await this.getMembership(tenantId, userId);
    if (!membership || membership.status !== "active") return false;
    const permissions = effectivePermissionsForRole(membership.role, await this.listRolePermissions(tenantId), await this.listFeatureFlags(tenantId));
    if (!permissions.includes(permission)) return false;
    if (!resource) return true;
    return aclAllows(permission, await this.listResourceAcls(tenantId, resource), membership.role, userId, membership.departmentIds);
  }

  async listRolePermissions(tenantId: string): Promise<RolePermissionSet[]> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<RolePermissionRow>(`
      SELECT tenant_id, role, permissions, source, updated_at
      FROM role_permission_defaults
      ORDER BY role ASC
    `));
    return rows.map(rolePermissionFromRow);
  }

  async upsertRolePermissions(input: UpsertRolePermissionsInput): Promise<RolePermissionSet> {
    const rows = await this.database.withTenant(input.tenantId, (executor) => executor.query<RolePermissionRow>(`
      INSERT INTO role_permission_defaults (tenant_id, role, permissions, source)
      VALUES ($1::uuid, $2, $3::jsonb, $4)
      ON CONFLICT (tenant_id, role) DO UPDATE
      SET permissions = excluded.permissions, source = excluded.source, updated_at = now()
      RETURNING tenant_id, role, permissions, source, updated_at
    `, [input.tenantId, input.role, JSON.stringify(uniquePermissions(input.permissions)), input.source ?? "admin"]));
    return rolePermissionFromRow(rows[0]!);
  }

  async listFeatureFlags(tenantId: string): Promise<FeatureFlag[]> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<FeatureFlagRow>(`
      SELECT tenant_id, flag, enabled, role_defaults, updated_at
      FROM feature_flags
      ORDER BY flag ASC
    `));
    return rows.map(featureFlagFromRow);
  }

  async upsertFeatureFlag(input: UpsertFeatureFlagInput): Promise<FeatureFlag> {
    const rows = await this.database.withTenant(input.tenantId, (executor) => executor.query<FeatureFlagRow>(`
      INSERT INTO feature_flags (tenant_id, flag, enabled, role_defaults)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
      ON CONFLICT (tenant_id, flag) DO UPDATE
      SET enabled = excluded.enabled, role_defaults = excluded.role_defaults, updated_at = now()
      RETURNING tenant_id, flag, enabled, role_defaults, updated_at
    `, [input.tenantId, input.flag, input.enabled, JSON.stringify(input.roleDefaults ?? {})]));
    return featureFlagFromRow(rows[0]!);
  }

  async listResourceAcls(tenantId: string, resource?: AuthorizationResource | undefined): Promise<ResourceAcl[]> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<ResourceAclRow>(`
      SELECT id, tenant_id, resource_type, resource_id, principal_type, principal_id, allow, deny, updated_at
      FROM resource_acls
      WHERE ($1::text IS NULL OR resource_type = $1) AND ($2::text IS NULL OR resource_id = $2)
      ORDER BY resource_type ASC, resource_id ASC, principal_type ASC, principal_id ASC
    `, [resource?.type ?? null, resource?.id ?? null]));
    return rows.map(resourceAclFromRow);
  }

  async upsertResourceAcl(input: UpsertResourceAclInput): Promise<ResourceAcl> {
    const rows = await this.database.withTenant(input.tenantId, (executor) => executor.query<ResourceAclRow>(`
      INSERT INTO resource_acls (tenant_id, resource_type, resource_id, principal_type, principal_id, allow, deny)
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
      ON CONFLICT (tenant_id, resource_type, resource_id, principal_type, principal_id) DO UPDATE
      SET allow = excluded.allow, deny = excluded.deny, updated_at = now()
      RETURNING id, tenant_id, resource_type, resource_id, principal_type, principal_id, allow, deny, updated_at
    `, [input.tenantId, input.resourceType, input.resourceId, input.principalType, input.principalId, JSON.stringify(uniquePermissions(input.allow ?? [])), JSON.stringify(uniquePermissions(input.deny ?? []))]));
    return resourceAclFromRow(rows[0]!);
  }

  async listDepartments(tenantId: string): Promise<Department[]> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<DepartmentRow>(`
      SELECT id, tenant_id, parent_id, name, slug, external_id, status, created_at, updated_at
      FROM departments
      WHERE deleted_at IS NULL
      ORDER BY name ASC
    `));
    return rows.map(departmentFromRow);
  }

  async createDepartment(input: CreateDepartmentInput): Promise<Department> {
    const rows = await this.database.withTenant(input.tenantId, (executor) => executor.query<DepartmentRow>(`
      INSERT INTO departments (tenant_id, parent_id, name, slug, external_id)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5)
      ON CONFLICT (tenant_id, slug) DO UPDATE
      SET name = excluded.name, parent_id = excluded.parent_id, external_id = excluded.external_id, updated_at = now()
      RETURNING id, tenant_id, parent_id, name, slug, external_id, status, created_at, updated_at
    `, [input.tenantId, input.parentId ?? null, input.name, input.slug ?? slugify(input.name), input.externalId ?? null]));
    return departmentFromRow(rows[0]!);
  }

  async listSsoConnections(tenantId: string): Promise<SsoConnection[]> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<SsoConnectionRow>(`
      SELECT id, tenant_id, kind, slug, display_name, status, issuer, sso_url, metadata_url, entity_id, client_id,
        client_secret_ref, domains, scim_enabled, created_at, updated_at
      FROM sso_connections
      ORDER BY display_name ASC
    `));
    return rows.map(ssoFromRow);
  }

  async createSsoConnection(input: CreateSsoConnectionInput): Promise<SsoConnection> {
    const rows = await this.database.withTenant(input.tenantId, (executor) => executor.query<SsoConnectionRow>(`
      INSERT INTO sso_connections (
        tenant_id, kind, slug, display_name, status, issuer, sso_url, metadata_url, entity_id, client_id,
        client_secret_ref, domains, scim_enabled
      )
      VALUES ($1::uuid, $2, $3, $4, 'enabled', $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      ON CONFLICT (tenant_id, slug) DO UPDATE
      SET kind = excluded.kind, display_name = excluded.display_name, issuer = excluded.issuer, sso_url = excluded.sso_url,
          metadata_url = excluded.metadata_url, entity_id = excluded.entity_id, client_id = excluded.client_id,
          client_secret_ref = excluded.client_secret_ref, domains = excluded.domains, scim_enabled = excluded.scim_enabled,
          updated_at = now()
      RETURNING id, tenant_id, kind, slug, display_name, status, issuer, sso_url, metadata_url, entity_id, client_id,
        client_secret_ref, domains, scim_enabled, created_at, updated_at
    `, [
      input.tenantId,
      input.kind,
      input.slug,
      input.displayName,
      input.issuer ?? null,
      input.ssoUrl ?? null,
      input.metadataUrl ?? null,
      input.entityId ?? null,
      input.clientId ?? null,
      input.clientSecretRef ?? null,
      JSON.stringify(input.domains ?? []),
      input.scimEnabled ?? false,
    ]));
    return ssoFromRow(rows[0]!);
  }

  async getSsoConnection(tenantId: string, idOrSlug: string): Promise<SsoConnection | null> {
    const rows = await this.database.withTenant(tenantId, (executor) => executor.query<SsoConnectionRow>(`
      SELECT id, tenant_id, kind, slug, display_name, status, issuer, sso_url, metadata_url, entity_id, client_id,
        client_secret_ref, domains, scim_enabled, created_at, updated_at
      FROM sso_connections
      WHERE id::text = $1 OR slug = $1
      LIMIT 1
    `, [idOrSlug]));
    return rows[0] ? ssoFromRow(rows[0]) : null;
  }

  async upsertScimUser(tenantId: string, input: ScimUser): Promise<ScimUser> {
    const normalized = ScimUserSchema.parse({ ...input, externalId: input.externalId ?? input.userName });
    await this.database.withTenant(tenantId, async (executor) => {
      const userId = await upsertUser(executor, normalized);
      await executor.execute(`
        INSERT INTO tenant_memberships (tenant_id, user_id, status, role, source, external_id, deprovisioned_at)
        VALUES ($1::uuid, $2::uuid, $3, 'member', 'scim', $4, $5)
        ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET status = excluded.status, source = 'scim', external_id = excluded.external_id,
            deprovisioned_at = excluded.deprovisioned_at, updated_at = now()
      `, [tenantId, userId, normalized.active ? "active" : "deprovisioned", normalized.externalId, normalized.active ? null : new Date()]);
      await executor.execute(`
        INSERT INTO scim_identities (tenant_id, resource_type, external_id, user_id, active, raw, deprovisioned_at)
        VALUES ($1::uuid, 'User', $2, $3::uuid, $4, $5::jsonb, $6)
        ON CONFLICT (tenant_id, resource_type, external_id) DO UPDATE
        SET user_id = excluded.user_id, active = excluded.active, raw = excluded.raw,
            deprovisioned_at = excluded.deprovisioned_at, updated_at = now()
      `, [tenantId, normalized.externalId, userId, normalized.active, JSON.stringify(normalized as unknown as JsonValue), normalized.active ? null : new Date()]);
    });
    return normalized;
  }

  async deprovisionScimUser(tenantId: string, idOrExternalId: string): Promise<{ id: string; alreadyDeprovisioned: boolean }> {
    const rows = await this.database.withTenant(tenantId, async (executor) => {
      const existing = await executor.query<{ user_id: string | null; active: boolean }>(
        "SELECT user_id, active FROM scim_identities WHERE tenant_id = $1::uuid AND resource_type = 'User' AND external_id = $2",
        [tenantId, idOrExternalId],
      );
      await executor.execute(`
        UPDATE scim_identities SET active = false, deprovisioned_at = COALESCE(deprovisioned_at, now()), updated_at = now()
        WHERE tenant_id = $1::uuid AND resource_type = 'User' AND external_id = $2
      `, [tenantId, idOrExternalId]);
      if (existing[0]?.user_id) {
        await executor.execute(`
          UPDATE tenant_memberships SET status = 'deprovisioned', deprovisioned_at = COALESCE(deprovisioned_at, now()), updated_at = now()
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid
        `, [tenantId, existing[0].user_id]);
      }
      return existing;
    });
    return { id: idOrExternalId, alreadyDeprovisioned: rows[0]?.active === false };
  }

  async upsertScimGroup(tenantId: string, input: ScimGroup): Promise<ScimGroup> {
    const normalized = ScimGroupSchema.parse({ ...input, externalId: input.externalId ?? input.displayName });
    const department = await this.createDepartment({ tenantId, name: normalized.displayName, slug: slugify(normalized.displayName), externalId: normalized.externalId });
    await this.database.withTenant(tenantId, (executor) => executor.execute(`
      INSERT INTO scim_identities (tenant_id, resource_type, external_id, department_id, active, raw)
      VALUES ($1::uuid, 'Group', $2, $3::uuid, true, $4::jsonb)
      ON CONFLICT (tenant_id, resource_type, external_id) DO UPDATE
      SET department_id = excluded.department_id, active = true, raw = excluded.raw, deprovisioned_at = NULL, updated_at = now()
    `, [tenantId, normalized.externalId, department.id, JSON.stringify(normalized as unknown as JsonValue)]));
    return normalized;
  }

  async deprovisionScimGroup(tenantId: string, idOrExternalId: string): Promise<{ id: string; alreadyDeprovisioned: boolean }> {
    const rows = await this.database.withTenant(tenantId, async (executor) => {
      const existing = await executor.query<{ active: boolean }>(
        "SELECT active FROM scim_identities WHERE tenant_id = $1::uuid AND resource_type = 'Group' AND external_id = $2",
        [tenantId, idOrExternalId],
      );
      await executor.execute(`
        UPDATE scim_identities SET active = false, deprovisioned_at = COALESCE(deprovisioned_at, now()), updated_at = now()
        WHERE tenant_id = $1::uuid AND resource_type = 'Group' AND external_id = $2
      `, [tenantId, idOrExternalId]);
      return existing;
    });
    return { id: idOrExternalId, alreadyDeprovisioned: rows[0]?.active === false };
  }
}

async function upsertUser(executor: SqlExecutor, input: ScimUser): Promise<string> {
  const email = input.emails.find((mail) => mail.primary)?.value ?? input.emails[0]?.value ?? input.userName;
  const name = input.name.formatted ?? [input.name.givenName, input.name.familyName].filter(Boolean).join(" ");
  const rows = await executor.query<{ id: string }>(`
    INSERT INTO users (email, name, email_verified, status)
    VALUES ($1, $2, true, $3)
    ON CONFLICT (email) DO UPDATE
    SET name = excluded.name, status = excluded.status, updated_at = now()
    RETURNING id
  `, [email, name, input.active ? "active" : "disabled"]);
  return rows[0]!.id;
}

type OrganizationRow = {
  id: string;
  slug: string;
  name: string;
  deployment_mode: "shared" | "dedicated" | "selfhost";
  plan: string;
  status: "active" | "suspended" | "deleted";
  role: string;
  hostname: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DepartmentRow = {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  external_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type SsoConnectionRow = {
  id: string;
  tenant_id: string;
  kind: "saml" | "oidc";
  slug: string;
  display_name: string;
  status: "draft" | "enabled" | "disabled";
  issuer: string | null;
  sso_url: string | null;
  metadata_url: string | null;
  entity_id: string | null;
  client_id: string | null;
  client_secret_ref: string | null;
  domains: unknown;
  scim_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type MembershipRow = {
  tenant_id: string;
  user_id: string;
  email: string;
  name: string;
  status: "active" | "disabled" | "deprovisioned";
  role: string;
  department_ids: unknown;
  external_id: string | null;
  source: "manual" | "sso" | "scim";
  joined_at: Date | string;
  updated_at: Date | string;
};

type RolePermissionRow = {
  tenant_id: string;
  role: string;
  permissions: unknown;
  source: string;
  updated_at: Date | string;
};

type FeatureFlagRow = {
  tenant_id: string;
  flag: string;
  enabled: boolean;
  role_defaults: unknown;
  updated_at: Date | string;
};

type ResourceAclRow = {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  principal_type: ResourceAclPrincipalType;
  principal_id: string;
  allow: unknown;
  deny: unknown;
  updated_at: Date | string;
};

function orgFromRow(row: OrganizationRow): Organization {
  return OrganizationSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    deploymentMode: row.deployment_mode,
    plan: row.plan,
    status: row.status,
    role: row.role,
    hostname: row.hostname,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function departmentFromRow(row: DepartmentRow): Department {
  return DepartmentSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    externalId: row.external_id,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function membershipFromRow(row: MembershipRow): OrgMembership {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    status: row.status,
    role: row.role,
    departmentIds: stringArray(row.department_ids),
    externalId: row.external_id,
    source: row.source,
    joinedAt: toIso(row.joined_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rolePermissionFromRow(row: RolePermissionRow): RolePermissionSet {
  return RolePermissionSetSchema.parse({
    tenantId: row.tenant_id,
    role: row.role,
    permissions: stringArray(row.permissions),
    source: row.source,
    updatedAt: toIso(row.updated_at),
  });
}

function featureFlagFromRow(row: FeatureFlagRow): FeatureFlag {
  return FeatureFlagSchema.parse({
    tenantId: row.tenant_id,
    flag: row.flag,
    enabled: row.enabled,
    roleDefaults: roleDefaultsFromUnknown(row.role_defaults),
    updatedAt: toIso(row.updated_at),
  });
}

function resourceAclFromRow(row: ResourceAclRow): ResourceAcl {
  return ResourceAclSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    allow: stringArray(row.allow),
    deny: stringArray(row.deny),
    updatedAt: toIso(row.updated_at),
  });
}

function ssoFromRow(row: SsoConnectionRow): SsoConnection {
  return SsoConnectionSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status,
    issuer: row.issuer,
    ssoUrl: row.sso_url,
    metadataUrl: row.metadata_url,
    entityId: row.entity_id,
    clientId: row.client_id,
    clientSecretRef: row.client_secret_ref,
    domains: Array.isArray(row.domains) ? row.domains : [],
    scimEnabled: row.scim_enabled,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function effectivePermissionsForRole(role: string, rolePermissions: RolePermissionSet[], flags: FeatureFlag[]): OrgPermission[] {
  const direct = rolePermissions.find((entry) => entry.role === role)?.permissions ?? BASE_ROLE_PERMISSIONS[role] ?? [];
  const fromFlags = flags
    .filter((flag) => flag.enabled)
    .flatMap((flag) => flag.roleDefaults[role] ?? []);
  return uniquePermissions([...direct, ...fromFlags]);
}

function aclAllows(permission: OrgPermission, entries: ResourceAcl[], role: string, userId: string, departmentIds: string[]): boolean {
  const relevant = entries.filter((entry) =>
    (entry.principalType === "user" && entry.principalId === userId)
    || (entry.principalType === "role" && entry.principalId === role)
    || (entry.principalType === "department" && departmentIds.includes(entry.principalId)),
  );
  if (relevant.some((entry) => entry.deny.includes(permission))) return false;
  if (relevant.some((entry) => entry.allow.includes(permission))) return true;
  return true;
}

function uniquePermissions(values: readonly string[]): OrgPermission[] {
  const known = new Set([
    "org:read", "org:admin", "departments:read", "departments:write", "sso:read", "sso:write",
    "rbac:read", "rbac:write", "feature_flags:read", "feature_flags:write", "acl:read", "acl:write",
    "budgets:read", "budgets:write", "models:read", "models:write", "policy:read", "policy:write", "audit:read", "audit:export",
    "skills:read", "skills:write", "mcp:read", "mcp:write",
    "members:read", "members:write", "usage:read", "usage:export", "reports:read", "reports:write", "alerts:read", "alerts:write",
    "billing:read", "billing:write", "guardrails:read", "guardrails:write", "data_policy:read", "data_policy:write",
    "auth_policy:read", "auth_policy:write", "service_accounts:read", "service_accounts:write", "org_settings:read", "org_settings:write",
  ]);
  return [...new Set(values.filter((value) => known.has(value)))] as OrgPermission[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function roleDefaultsFromUnknown(value: unknown): Record<string, OrgPermission[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, OrgPermission[]> = {};
  for (const [role, permissions] of Object.entries(value)) {
    result[role] = uniquePermissions(Array.isArray(permissions) ? permissions.filter((item): item is string => typeof item === "string") : []);
  }
  return result;
}

function aclKey(tenantId: string, resourceType: string, resourceId: string, principalType: string, principalId: string): string {
  return `${tenantId}:${resourceType}:${resourceId}:${principalType}:${principalId}`;
}

function normalizeHost(host: string): string {
  return host.split(":")[0]?.trim().toLowerCase() || "localhost";
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
