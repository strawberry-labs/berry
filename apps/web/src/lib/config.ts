import { z } from "zod";

const ProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  defaultModel: z.string(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).default([]),
  enabled: z.boolean().default(true),
});

const McpHttpConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  auth: z.enum(["none", "bearer", "oauth"]).default("none"),
  enabled: z.boolean().default(true),
});

const SkillConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().default(true),
});

const OrganizationConfigSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  deploymentMode: z.enum(["shared", "dedicated", "selfhost"]),
  plan: z.string(),
  status: z.enum(["active", "suspended", "deleted"]),
  role: z.string().default("member"),
  hostname: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const PublicDeploymentModeSchema = z.enum(["managed", "dedicated", "self-hosted"]);

const PlatformTenantConfigSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  deploymentMode: z.enum(["shared", "dedicated", "selfhost"]),
  lifecycle: z.enum(["provisioning", "active", "suspended", "deleting"]),
  hostname: z.string().nullable(),
  plan: z.string(),
  region: z.string(),
  monthlySpendMicros: z.string(),
  usageEvents: z.number().int().nonnegative(),
  seats: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const PlatformUsageConfigSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  tenants: z.number().int().nonnegative(),
  activeTenants: z.number().int().nonnegative(),
  totalSpendMicros: z.string(),
  totalUsageEvents: z.number().int().nonnegative(),
  topTenants: z.array(z.object({
    tenantId: z.string(),
    tenantName: z.string(),
    spendMicros: z.string(),
    usageEvents: z.number().int().nonnegative(),
  })),
});

const OrgPermissionSchema = z.enum([
  "org:read",
  "org:admin",
  "departments:read",
  "departments:write",
  "sso:read",
  "sso:write",
  "rbac:read",
  "rbac:write",
  "feature_flags:read",
  "feature_flags:write",
  "acl:read",
  "acl:write",
  "budgets:read",
  "budgets:write",
  "models:read",
  "models:write",
  "policy:read",
  "policy:write",
  "audit:read",
  "audit:export",
  "skills:read",
  "skills:write",
  "mcp:read",
  "mcp:write",
  "members:read",
  "members:write",
  "usage:read",
  "usage:export",
  "reports:read",
  "reports:write",
  "alerts:read",
  "alerts:write",
  "billing:read",
  "billing:write",
  "guardrails:read",
  "guardrails:write",
  "data_policy:read",
  "data_policy:write",
  "auth_policy:read",
  "auth_policy:write",
  "service_accounts:read",
  "service_accounts:write",
  "org_settings:read",
  "org_settings:write",
]);

const RolePermissionConfigSchema = z.object({
  tenantId: z.string(),
  role: z.string(),
  permissions: z.array(OrgPermissionSchema),
  source: z.string().default("system"),
  updatedAt: z.string().datetime({ offset: true }),
});

const FeatureFlagConfigSchema = z.object({
  tenantId: z.string(),
  flag: z.string(),
  enabled: z.boolean(),
  roleDefaults: z.record(z.array(OrgPermissionSchema)).default({}),
  updatedAt: z.string().datetime({ offset: true }),
});

const DepartmentConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(["active", "deleted"]).default("active"),
  updatedAt: z.string().datetime({ offset: true }),
});

const SsoConnectionConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(["saml", "oidc"]),
  displayName: z.string(),
  status: z.string(),
  domains: z.array(z.string()).default([]),
  scimEnabled: z.boolean().default(false),
  updatedAt: z.string().datetime({ offset: true }),
});

const ResourceAclConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  principalType: z.enum(["user", "role", "department"]),
  principalId: z.string(),
  allow: z.array(OrgPermissionSchema).default([]),
  deny: z.array(OrgPermissionSchema).default([]),
  updatedAt: z.string().datetime({ offset: true }),
});

const BudgetLimitConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  scopeType: z.enum(["org", "department", "user"]),
  scopeId: z.string(),
  period: z.enum(["day", "month"]),
  softLimitMicros: z.string(),
  hardLimitMicros: z.string(),
  status: z.enum(["active", "disabled"]),
  updatedAt: z.string().datetime({ offset: true }),
});

const UsageDashboardConfigSchema = z.object({
  tenantId: z.string(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  totals: z.object({
    requests: z.number().int().nonnegative(),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    costBilledMicros: z.string(),
  }),
  byFeature: z.array(z.object({ feature: z.string(), requests: z.number().int().nonnegative(), costBilledMicros: z.string(), tokens: z.number().int().nonnegative() })),
  byModel: z.array(z.object({ model: z.string(), requests: z.number().int().nonnegative(), costBilledMicros: z.string(), tokens: z.number().int().nonnegative() })),
  byUser: z.array(z.object({ userId: z.string().nullable(), requests: z.number().int().nonnegative(), costBilledMicros: z.string(), tokens: z.number().int().nonnegative() })),
  byDepartment: z.array(z.object({ departmentId: z.string().nullable(), requests: z.number().int().nonnegative(), costBilledMicros: z.string(), tokens: z.number().int().nonnegative() })),
  burnDown: z.array(z.object({ date: z.string(), costBilledMicros: z.string(), requests: z.number().int().nonnegative() })),
});

const BillingCreditGrantConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  source: z.enum(["stripe", "manual", "support", "fixture"]),
  amountMicros: z.string(),
  remainingMicros: z.string(),
  currency: z.string().default("usd"),
  externalRef: z.string().nullable(),
  status: z.enum(["active", "voided", "exhausted"]),
  updatedAt: z.string().datetime({ offset: true }),
});

const BillingMeterEventConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  requestId: z.string(),
  meter: z.string(),
  quantity: z.string(),
  costBilledMicros: z.string(),
  provider: z.enum(["none", "stripe", "lago"]),
  status: z.enum(["pending", "reported", "skipped", "failed"]),
  reportedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

const BillingInvoiceConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  provider: z.enum(["none", "stripe", "lago"]),
  externalInvoiceId: z.string().nullable(),
  status: z.enum(["draft", "open", "paid", "void", "uncollectible"]),
  totalMicros: z.string(),
  currency: z.string().default("usd"),
  hostedInvoiceUrl: z.string().nullable(),
  periodStart: z.string().datetime({ offset: true }).nullable(),
  periodEnd: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

const BillingSummaryConfigSchema = z.object({
  tenantId: z.string(),
  provider: z.enum(["none", "stripe", "lago"]),
  providerConfigured: z.boolean(),
  billingDependencyRequired: z.boolean(),
  prepaidBalanceMicros: z.string(),
  currency: z.string().default("usd"),
  activeGrants: z.array(BillingCreditGrantConfigSchema),
  recentMeterEvents: z.array(BillingMeterEventConfigSchema),
  invoices: z.array(BillingInvoiceConfigSchema),
  updatedAt: z.string().datetime({ offset: true }),
});

const ModelPolicyConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  providerId: z.string(),
  model: z.string(),
  displayName: z.string().nullable().default(null),
  status: z.enum(["allowed", "blocked"]),
  enforce: z.boolean(),
  modeAllow: z.array(z.enum(["chat", "code"])),
  updatedAt: z.string().datetime({ offset: true }),
});

const ModelDefaultConfigSchema = z.object({
  tenantId: z.string(),
  mode: z.enum(["chat", "code"]),
  providerId: z.string(),
  model: z.string(),
  enforce: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
});

const PolicyVersionConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active", "revoked"]),
  bundlePath: z.string(),
  keyId: z.string(),
  locks: z.array(z.enum(["execpolicy", "models", "mcp", "plugins", "sandbox", "telemetry"])),
  publishedAt: z.string().datetime({ offset: true }),
});

const AuditSettingsConfigSchema = z.object({
  tenantId: z.string(),
  retentionDays: z.number().int().positive(),
  clientIngestEnabled: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
});

const AuditEventConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  sequence: z.number().int().positive(),
  actorUserId: z.string().nullable(),
  category: z.string(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ts: z.string().datetime({ offset: true }),
});

const AuditExportConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(["webhook", "s3"]),
  status: z.enum(["enabled", "disabled"]),
  destination: z.string(),
  format: z.enum(["json", "csv"]),
  lastExportedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

export const WebConfigSchema = z.object({
  apiBaseUrl: z.string().url().nullable(),
  deploymentMode: PublicDeploymentModeSchema,
  workspaceId: z.string(),
  workspacePath: z.string(),
  activeOrganizationId: z.string(),
  organizations: z.array(OrganizationConfigSchema),
  rolePermissions: z.array(RolePermissionConfigSchema),
  featureFlags: z.array(FeatureFlagConfigSchema),
  departments: z.array(DepartmentConfigSchema),
  ssoConnections: z.array(SsoConnectionConfigSchema),
  resourceAcls: z.array(ResourceAclConfigSchema),
  budgetLimits: z.array(BudgetLimitConfigSchema),
  usageDashboards: z.array(UsageDashboardConfigSchema),
  billingSummaries: z.array(BillingSummaryConfigSchema),
  modelPolicies: z.array(ModelPolicyConfigSchema),
  modelDefaults: z.array(ModelDefaultConfigSchema),
  policyVersions: z.array(PolicyVersionConfigSchema),
  auditSettings: z.array(AuditSettingsConfigSchema),
  auditEvents: z.array(AuditEventConfigSchema),
  auditExports: z.array(AuditExportConfigSchema),
  platformTenants: z.array(PlatformTenantConfigSchema),
  platformUsage: PlatformUsageConfigSchema,
  platformAuthorized: z.boolean().default(false),
  sandboxTerminalWsUrl: z.string().url().nullable(),
  demoMode: z.boolean(),
  providers: z.array(ProviderConfigSchema),
  mcpServers: z.array(McpHttpConfigSchema),
  skills: z.array(SkillConfigSchema),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;
