import { z } from "zod";

export { BUILT_IN_COMMANDS, builtInCommandManifests, parseSlashCommand, type BuiltInCommandDefinition } from "./commands.ts";

/**
 * Pre-1.0 host protocol version shared by desktop, host, CLI, and future
 * app-server clients. Phase 2 freezes this into an additive-only contract.
 */
export const PROTOCOL_VERSION = 1;

export function protocolMajor(version: number): number {
  return Math.trunc(version);
}

export function isProtocolCompatible(version: number): boolean {
  return Number.isFinite(version) && protocolMajor(version) === protocolMajor(PROTOCOL_VERSION);
}

export const ISODateSchema = z.string().datetime({ offset: true });
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const ImageGenerationRequestSchema = z.object({
  providerId: z.string().min(1).optional(),
  credentialRef: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  size: z.string().min(1).optional(),
});
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;

export const ImageGenerationResponseSchema = z.object({
  model: z.string().optional(),
  created: z.number().optional(),
  data: z.array(
    z
      .object({
        url: z.string().url().optional(),
        b64_json: z.string().optional(),
        revised_prompt: z.string().optional(),
      })
      .passthrough()
      .refine((image) => Boolean(image.url || image.b64_json), "Generated image has no payload"),
  ),
}).passthrough();
export type ImageGenerationResponse = z.infer<typeof ImageGenerationResponseSchema>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const PermissionModeSchema = z.enum(["ask", "auto-edit", "plan", "full-access"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const WorkspaceTrustStateSchema = z.enum(["untrusted", "trusted", "blocked"]);
export type WorkspaceTrustState = z.infer<typeof WorkspaceTrustStateSchema>;

export const TaskStatusSchema = z.enum(["queued", "running", "waiting-for-approval", "cancelled", "failed", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const SessionStatusSchema = z.enum(["active", "compacted", "forked", "rewound", "archived"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const MessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessagePartKindSchema = z.enum([
  "text",
  "code",
  "reasoning",
  "tool-call",
  "tool-result",
  "image",
  "attachment",
  "terminal",
  "browser-screenshot",
  "error",
]);
export type MessagePartKind = z.infer<typeof MessagePartKindSchema>;

export const ToolCallStatusSchema = z.enum(["pending", "waiting-for-approval", "running", "cancelled", "denied", "failed", "completed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalKindSchema = z.enum(["file-edit", "shell", "terminal", "mcp", "browser", "credential", "workspace-trust"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const UiModeSchema = z.enum(["chat", "code", "cowork"]);
export type UiMode = z.infer<typeof UiModeSchema>;

export const ConversationKindSchema = z.enum(["chat", "code"]);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const WorkspaceKindSchema = z.enum(["project", "general"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const UiModeSourceSchema = z.enum(["classifier", "agent", "user"]);
export type UiModeSource = z.infer<typeof UiModeSourceSchema>;

export const IntentClassifierModeSchema = z.enum(["model", "heuristics", "off"]);
export type IntentClassifierMode = z.infer<typeof IntentClassifierModeSchema>;

export const IntentClassificationSchema = z.object({
  mode: UiModeSchema.nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  source: z.enum(["model", "heuristics", "off", "existing"]),
  applied: z.boolean(),
});
export type IntentClassification = z.infer<typeof IntentClassificationSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  workspaceKind: WorkspaceKindSchema.default("project"),
  ownerUserId: z.string().nullable().default(null),
  trustState: WorkspaceTrustStateSchema,
  lastOpenedAt: ISODateSchema,
  indexedAt: ISODateSchema.nullable(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
  pinned: z.boolean().default(false),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

const TaskFieldsSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  activeSessionId: z.string().nullable(),
  conversationKind: ConversationKindSchema,
  uiMode: UiModeSchema.nullable().optional(),
  uiModePinned: z.boolean().optional(),
  uiModeSource: UiModeSourceSchema.nullable().optional(),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  deletedAt: ISODateSchema.nullable().default(null),
  unreadAt: ISODateSchema.nullable().default(null),
  lastReadAt: ISODateSchema.nullable().default(null),
  worktreePath: z.string().nullable().default(null),
  worktreeBranch: z.string().nullable().default(null),
  worktreeBaseRef: z.string().nullable().default(null),
  worktreeBaseSha: z.string().nullable().default(null),
  pullRequestUrl: z.string().nullable().default(null),
  pullRequestNumber: z.number().int().positive().nullable().default(null),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export const TaskSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const task = value as Record<string, unknown>;
  if (task.conversationKind !== undefined) return task;
  return {
    ...task,
    conversationKind: task.uiMode === "code" || (task.uiMode == null && typeof task.worktreePath === "string" && task.worktreePath.length > 0)
      ? "code"
      : "chat",
  };
}, TaskFieldsSchema);
export type Task = z.infer<typeof TaskSchema>;

export const DeploymentModeSchema = z.enum(["shared", "dedicated", "selfhost"]);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const TenantStatusSchema = z.enum(["active", "suspended", "deleted"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const OrganizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  deploymentMode: DeploymentModeSchema,
  plan: z.string(),
  status: TenantStatusSchema,
  role: z.string().default("member"),
  hostname: z.string().nullable().default(null),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const DepartmentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  slug: z.string(),
  externalId: z.string().nullable().default(null),
  status: z.enum(["active", "disabled", "deleted"]).default("active"),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type Department = z.infer<typeof DepartmentSchema>;

export const OrgMembershipSchema = z.object({
  tenantId: z.string(),
  userId: z.string(),
  email: z.string().email(),
  name: z.string().default(""),
  status: z.enum(["active", "disabled", "deprovisioned"]).default("active"),
  role: z.string().default("member"),
  departmentIds: z.array(z.string()).default([]),
  externalId: z.string().nullable().default(null),
  source: z.enum(["manual", "sso", "scim"]).default("manual"),
  joinedAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type OrgMembership = z.infer<typeof OrgMembershipSchema>;

export const OrgPermissionSchema = z.enum([
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
export type OrgPermission = z.infer<typeof OrgPermissionSchema>;

export const RolePermissionSetSchema = z.object({
  tenantId: z.string(),
  role: z.string(),
  permissions: z.array(OrgPermissionSchema).default([]),
  source: z.string().default("system"),
  updatedAt: ISODateSchema,
});
export type RolePermissionSet = z.infer<typeof RolePermissionSetSchema>;

export const FeatureFlagSchema = z.object({
  tenantId: z.string(),
  flag: z.string(),
  enabled: z.boolean(),
  roleDefaults: z.record(z.array(OrgPermissionSchema)).default({}),
  updatedAt: ISODateSchema,
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export const ResourceAclPrincipalTypeSchema = z.enum(["user", "role", "department"]);
export type ResourceAclPrincipalType = z.infer<typeof ResourceAclPrincipalTypeSchema>;

export const ResourceAclSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  principalType: ResourceAclPrincipalTypeSchema,
  principalId: z.string(),
  allow: z.array(OrgPermissionSchema).default([]),
  deny: z.array(OrgPermissionSchema).default([]),
  updatedAt: ISODateSchema,
});
export type ResourceAcl = z.infer<typeof ResourceAclSchema>;

export const EffectivePermissionsSchema = z.object({
  tenantId: z.string(),
  userId: z.string(),
  role: z.string(),
  permissions: z.array(OrgPermissionSchema),
  featureFlags: z.array(FeatureFlagSchema).default([]),
});
export type EffectivePermissions = z.infer<typeof EffectivePermissionsSchema>;

export const BudgetScopeTypeSchema = z.enum(["org", "department", "user"]);
export type BudgetScopeType = z.infer<typeof BudgetScopeTypeSchema>;

export const BudgetLimitSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  scopeType: BudgetScopeTypeSchema,
  scopeId: z.string(),
  period: z.enum(["day", "month"]),
  softLimitMicros: z.string(),
  hardLimitMicros: z.string(),
  requestLimit: z.number().int().nonnegative().nullable().default(null),
  tokenLimit: z.number().int().nonnegative().nullable().default(null),
  sandboxMinuteLimit: z.number().int().nonnegative().nullable().default(null),
  thresholdPercentages: z.array(z.number().int().min(1).max(100)).default([80, 100]),
  status: z.enum(["active", "disabled"]),
  updatedAt: ISODateSchema,
});
export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;

export const BudgetReservationStatusSchema = z.enum(["reserved", "reconciled", "released", "blocked"]);
export type BudgetReservationStatus = z.infer<typeof BudgetReservationStatusSchema>;

export const BudgetReservationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  requestId: z.string(),
  userId: z.string().nullable(),
  departmentId: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  feature: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  estimatedCostMicros: z.string(),
  reservedMicros: z.string(),
  actualCostMicros: z.string().nullable(),
  status: BudgetReservationStatusSchema,
  blockReason: z.string().nullable(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export const BudgetCheckSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().nullable(),
  reservation: BudgetReservationSchema.nullable(),
  limit: BudgetLimitSchema.nullable(),
  retryAfterSeconds: z.number().int().positive().nullable().default(null),
});
export type BudgetCheck = z.infer<typeof BudgetCheckSchema>;

export const BudgetErrorSchema = z.object({
  code: z.literal("budget_exceeded"),
  message: z.string(),
  check: BudgetCheckSchema,
});
export type BudgetError = z.infer<typeof BudgetErrorSchema>;

export const BillingProviderKindSchema = z.enum(["none", "stripe", "lago"]);
export type BillingProviderKind = z.infer<typeof BillingProviderKindSchema>;

export const BillingCreditGrantSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  source: z.enum(["stripe", "manual", "support", "fixture"]),
  amountMicros: z.string(),
  remainingMicros: z.string(),
  currency: z.string().default("usd"),
  externalRef: z.string().nullable().default(null),
  status: z.enum(["active", "voided", "exhausted"]),
  metadata: JsonValueSchema.default({}),
  createdBy: z.string().nullable().default(null),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type BillingCreditGrant = z.infer<typeof BillingCreditGrantSchema>;

export const BillingCreditGrantCreateSchema = z.object({
  source: z.enum(["stripe", "manual", "support", "fixture"]).default("manual"),
  amountMicros: z.string().regex(/^\d+$/),
  currency: z.string().default("usd"),
  externalRef: z.string().nullable().optional(),
  reason: z.string().min(3).max(500),
  confirmation: z.literal(true),
  idempotencyKey: z.string().min(8),
  metadata: JsonValueSchema.default({}),
}).strict();
export type BillingCreditGrantCreate = z.infer<typeof BillingCreditGrantCreateSchema>;

export const BillingMeterEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  usageEventId: z.string().nullable().default(null),
  requestId: z.string(),
  meter: z.string(),
  quantity: z.string(),
  costBilledMicros: z.string(),
  provider: BillingProviderKindSchema,
  externalEventId: z.string().nullable().default(null),
  status: z.enum(["pending", "reported", "skipped", "failed"]),
  reportedAt: ISODateSchema.nullable().default(null),
  metadata: JsonValueSchema.default({}),
  createdAt: ISODateSchema,
});
export type BillingMeterEvent = z.infer<typeof BillingMeterEventSchema>;

export const BillingMeterEventCreateSchema = z.object({
  usageEventId: z.string().nullable().optional(),
  requestId: z.string().min(1),
  meter: z.string().min(1),
  quantity: z.string().regex(/^\d+$/),
  costBilledMicros: z.string().regex(/^\d+$/).default("0"),
  metadata: JsonValueSchema.default({}),
}).strict();
export type BillingMeterEventCreate = z.infer<typeof BillingMeterEventCreateSchema>;

export const BillingInvoiceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  provider: BillingProviderKindSchema,
  externalInvoiceId: z.string().nullable().default(null),
  status: z.enum(["draft", "open", "paid", "void", "uncollectible"]),
  totalMicros: z.string(),
  currency: z.string().default("usd"),
  hostedInvoiceUrl: z.string().nullable().default(null),
  periodStart: ISODateSchema.nullable().default(null),
  periodEnd: ISODateSchema.nullable().default(null),
  metadata: JsonValueSchema.default({}),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type BillingInvoice = z.infer<typeof BillingInvoiceSchema>;

export const BillingAccountSummarySchema = z.object({
  tenantId: z.string(),
  provider: BillingProviderKindSchema,
  providerConfigured: z.boolean(),
  billingDependencyRequired: z.boolean(),
  prepaidBalanceMicros: z.string(),
  currency: z.string().default("usd"),
  activeGrants: z.array(BillingCreditGrantSchema),
  recentMeterEvents: z.array(BillingMeterEventSchema),
  invoices: z.array(BillingInvoiceSchema),
  updatedAt: ISODateSchema,
});
export type BillingAccountSummary = z.infer<typeof BillingAccountSummarySchema>;

export const CloudUsageSignatureSchema = z.object({
  algorithm: z.enum(["hmac-sha256"]),
  keyId: z.string().min(1),
  signedAt: ISODateSchema,
  signature: z.string().min(1),
});
export type CloudUsageSignature = z.infer<typeof CloudUsageSignatureSchema>;

export const CloudUsageEventRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  requestId: z.string(),
  source: z.enum(["api", "router", "sandbox", "fixture"]).default("api"),
  userId: z.string().nullable(),
  departmentId: z.string().nullable().default(null),
  workspaceId: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  agentId: z.string().nullable().default(null),
  sandboxId: z.string().nullable().default(null),
  feature: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  tokensCached: z.number().int().nonnegative(),
  sandboxUsage: JsonValueSchema.default({}),
  costRawMicros: z.string(),
  costBilledMicros: z.string(),
  latencyMs: z.number().int().nonnegative().nullable(),
  ttftMs: z.number().int().nonnegative().nullable(),
  status: z.string(),
  metadata: JsonValueSchema.default({}),
  signedPayload: JsonValueSchema.default({}),
  signature: CloudUsageSignatureSchema.nullable().default(null),
  ts: ISODateSchema,
  createdAt: ISODateSchema,
});
export type CloudUsageEventRecord = z.infer<typeof CloudUsageEventRecordSchema>;

export const CloudUsageIngestRequestSchema = z.object({
  source: z.enum(["router", "sandbox", "fixture"]),
  event: JsonValueSchema,
  signature: CloudUsageSignatureSchema,
  normalized: z.object({
    requestId: z.string().min(1),
    userId: z.string().nullable().optional(),
    departmentId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    toolCallId: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
    sandboxId: z.string().nullable().optional(),
    feature: z.string().min(1),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    tokensIn: z.number().int().nonnegative().default(0),
    tokensOut: z.number().int().nonnegative().default(0),
    tokensCached: z.number().int().nonnegative().default(0),
    sandboxUsage: JsonValueSchema.default({}),
    costRawMicros: z.string().regex(/^\d+$/).default("0"),
    costBilledMicros: z.string().regex(/^\d+$/).default("0"),
    latencyMs: z.number().int().nonnegative().nullable().optional(),
    ttftMs: z.number().int().nonnegative().nullable().optional(),
    status: z.string().default("completed"),
    metadata: JsonValueSchema.default({}),
    ts: ISODateSchema.optional(),
  }).strict(),
}).strict();
export type CloudUsageIngestRequest = z.infer<typeof CloudUsageIngestRequestSchema>;

export const CloudUsageRollupSchema = z.object({
  tenantId: z.string(),
  bucketStart: ISODateSchema,
  bucketEnd: ISODateSchema,
  granularity: z.enum(["day"]),
  feature: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  userId: z.string().nullable().default(null),
  departmentId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  agentId: z.string().nullable().default(null),
  sandboxId: z.string().nullable().default(null),
  status: z.string(),
  requestCount: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  tokensCached: z.number().int().nonnegative(),
  costRawMicros: z.string(),
  costBilledMicros: z.string(),
});
export type CloudUsageRollup = z.infer<typeof CloudUsageRollupSchema>;

export const CloudUsageDashboardSchema = z.object({
  tenantId: z.string(),
  from: ISODateSchema,
  to: ISODateSchema,
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
export type CloudUsageDashboard = z.infer<typeof CloudUsageDashboardSchema>;

export const SsoConnectionKindSchema = z.enum(["saml", "oidc"]);
export type SsoConnectionKind = z.infer<typeof SsoConnectionKindSchema>;

export const SsoConnectionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: SsoConnectionKindSchema,
  slug: z.string(),
  displayName: z.string(),
  status: z.enum(["draft", "enabled", "disabled"]).default("draft"),
  issuer: z.string().nullable().default(null),
  ssoUrl: z.string().url().nullable().default(null),
  metadataUrl: z.string().url().nullable().default(null),
  entityId: z.string().nullable().default(null),
  clientId: z.string().nullable().default(null),
  clientSecretRef: z.string().nullable().default(null),
  domains: z.array(z.string()).default([]),
  scimEnabled: z.boolean().default(false),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type SsoConnection = z.infer<typeof SsoConnectionSchema>;

export const SsoStartResponseSchema = z.object({
  connectionId: z.string(),
  kind: SsoConnectionKindSchema,
  redirectUrl: z.string().url(),
  state: z.string(),
});
export type SsoStartResponse = z.infer<typeof SsoStartResponseSchema>;

export const ScimUserSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable().default(null),
  userName: z.string().email(),
  active: z.boolean().default(true),
  name: z.object({
    formatted: z.string().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  }).default({}),
  emails: z.array(z.object({
    value: z.string().email(),
    primary: z.boolean().optional(),
  })).default([]),
  groups: z.array(z.object({
    value: z.string(),
    display: z.string().optional(),
  })).default([]),
});
export type ScimUser = z.infer<typeof ScimUserSchema>;

export const ScimGroupSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable().default(null),
  displayName: z.string(),
  members: z.array(z.object({
    value: z.string(),
    display: z.string().optional(),
  })).default([]),
});
export type ScimGroup = z.infer<typeof ScimGroupSchema>;

export const WorktreeSchema = z.object({
  path: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  taskId: z.string().nullable(),
  main: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  dirty: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const WorktreeApplyBackPreviewSchema = z.object({
  taskId: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  mainSha: z.string(),
  patch: z.string(),
  files: z.array(z.string()),
  applicable: z.boolean(),
  conflict: z.string().nullable(),
});
export type WorktreeApplyBackPreview = z.infer<typeof WorktreeApplyBackPreviewSchema>;

export const WorktreeApplyBackResultSchema = z.object({
  applied: z.boolean(),
  files: z.array(z.string()),
  autoCheckpointId: z.string().nullable(),
});
export type WorktreeApplyBackResult = z.infer<typeof WorktreeApplyBackResultSchema>;

export const WorktreeOrphanSchema = z.object({
  path: z.string(),
  workspaceId: z.string(),
  taskId: z.string().nullable(),
  reason: z.enum(["unassociated", "missing-path", "missing-registration"]),
  action: z.string(),
});
export type WorktreeOrphan = z.infer<typeof WorktreeOrphanSchema>;

export const GitPrStatusSchema = z.object({
  installed: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().nullable(),
  hostname: z.string(),
  account: z.string().nullable(),
  error: z.string().nullable(),
  setupCommands: z.array(z.string()),
});
export type GitPrStatus = z.infer<typeof GitPrStatusSchema>;

export const GitPrDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  base: z.string(),
  head: z.string(),
});
export type GitPrDraft = z.infer<typeof GitPrDraftSchema>;

export const GitPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  base: z.string(),
  head: z.string(),
  draft: z.boolean(),
  state: z.string(),
  taskId: z.string().nullable(),
});
export type GitPullRequest = z.infer<typeof GitPullRequestSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  parentSessionId: z.string().nullable(),
  status: SessionStatusSchema,
  modelProviderId: z.string().nullable(),
  model: z.string().nullable(),
  permissionMode: PermissionModeSchema,
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionTargetStatusSchema = z.enum(["active", "met", "paused", "cleared"]);
export type SessionTargetStatus = z.infer<typeof SessionTargetStatusSchema>;

export const SessionTargetSchema = z.object({
  sessionId: z.string(),
  goalText: z.string(),
  status: SessionTargetStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  timeBudgetMin: z.number().int().positive().nullable(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type SessionTarget = z.infer<typeof SessionTargetSchema>;

export const MessagePartSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  kind: MessagePartKindSchema,
  content: JsonValueSchema,
  position: z.number().int().nonnegative(),
  createdAt: ISODateSchema,
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  status: z.enum(["streaming", "complete", "cancelled", "failed"]),
  parts: z.array(MessagePartSchema),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  generationMs: z.number().default(0),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  toolName: z.string(),
  status: ToolCallStatusSchema,
  input: JsonValueSchema,
  output: JsonValueSchema.nullable(),
  decisionTrace: z.array(JsonValueSchema).default([]),
  approvalId: z.string().nullable(),
  startedAt: ISODateSchema.nullable(),
  completedAt: ISODateSchema.nullable(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  kind: ApprovalKindSchema,
  status: ApprovalStatusSchema,
  request: JsonValueSchema,
  createdAt: ISODateSchema,
  decidedAt: ISODateSchema.nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const MobileEndpointModeSchema = z.enum(["berry-account", "self-hosted", "custom-openai", "lan-local"]);
export type MobileEndpointMode = z.infer<typeof MobileEndpointModeSchema>;

export const MobileDevicePlatformSchema = z.enum(["ios", "android", "expo"]);
export type MobileDevicePlatform = z.infer<typeof MobileDevicePlatformSchema>;

export const MobilePushProviderSchema = z.enum(["expo", "apns", "fcm", "none"]);
export type MobilePushProvider = z.infer<typeof MobilePushProviderSchema>;

export const MobileDeviceRegistrationCreateSchema = z.object({
  deviceId: z.string().min(4),
  platform: MobileDevicePlatformSchema,
  pushProvider: MobilePushProviderSchema.default("none"),
  pushToken: z.string().min(8).nullable().optional(),
  endpointMode: MobileEndpointModeSchema,
  appVersion: z.string().nullable().optional(),
  capabilities: z.array(z.enum(["approvals", "chat", "tasks", "push"])).default(["approvals", "chat", "tasks"]),
}).strict();
export type MobileDeviceRegistrationCreate = z.infer<typeof MobileDeviceRegistrationCreateSchema>;

export const MobileDeviceRegistrationSchema = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  userId: z.string().nullable(),
  deviceId: z.string(),
  platform: MobileDevicePlatformSchema,
  pushProvider: MobilePushProviderSchema,
  pushTokenLast4: z.string().nullable(),
  endpointMode: MobileEndpointModeSchema,
  appVersion: z.string().nullable(),
  capabilities: z.array(z.string()),
  status: z.enum(["active", "disabled"]),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
  lastSeenAt: ISODateSchema,
}).strict();
export type MobileDeviceRegistration = z.infer<typeof MobileDeviceRegistrationSchema>;

export const ApprovalPushPayloadSchema = z.object({
  type: z.literal("approval.requested"),
  approvalId: z.string(),
  title: z.string(),
  detail: z.string(),
  createdAt: ISODateSchema,
}).strict();
export type ApprovalPushPayload = z.infer<typeof ApprovalPushPayloadSchema>;

export const QuestionStatusSchema = z.enum(["pending", "answered", "cancelled", "expired"]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** One decision in a potentially batched ask_user_question request. */
export const QuestionPromptSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  options: z.array(QuestionOptionSchema).max(12).default([]),
  multi: z.boolean().default(false),
});
export type QuestionPrompt = z.infer<typeof QuestionPromptSchema>;

/** A durable answer record. `skipped` deliberately remains explicit so an
 * agent can distinguish "no answer yet" from a user choosing to move on. */
export const QuestionAnswerSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  answer: z.string().trim().min(1).max(4_000),
  selectedOptions: z.array(z.string().trim().min(1)).max(24).default([]),
  skipped: z.boolean().default(false),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const QuestionRequestSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  sessionId: z.string(),
  toolCallId: z.string().nullable(),
  status: QuestionStatusSchema,
  question: z.string(),
  options: z.array(QuestionOptionSchema).default([]),
  multi: z.boolean().default(false),
  /** New clients receive the complete batch; older records keep the first
   * decision in the legacy top-level fields above. */
  questions: z.array(QuestionPromptSchema).min(1).max(5).optional(),
  answer: JsonValueSchema.nullable(),
  createdAt: ISODateSchema,
  answeredAt: ISODateSchema.nullable(),
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  approvalId: z.string(),
  decision: z.enum(["approved_once", "approved_for_session", "approved_rule", "denied", "abort", "approve", "deny"]),
  remember: z.boolean().default(false),
  reason: z.string().optional(),
  decidedAt: ISODateSchema,
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ReasoningLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

export const TerminalSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  shell: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: z.enum(["starting", "running", "exited", "failed", "killed", "lost"]),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const ModelProviderKindSchema = z.enum([
  "berry-router",
  "openai",
  "anthropic",
  "openai-compatible",
  "ollama",
  "lm-studio",
  "local",
  "custom",
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>;

export const ModelApiTypeSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);
export type ModelApiType = z.infer<typeof ModelApiTypeSchema>;

export const ProviderAuthTypeSchema = z.enum(["none", "bearer", "optional-bearer", "x-api-key"]);
export type ProviderAuthType = z.infer<typeof ProviderAuthTypeSchema>;

export const ProviderSourceSchema = z.enum(["preset", "custom", "discovered"]);
export type ProviderSource = z.infer<typeof ProviderSourceSchema>;

export const ModelContextHintsSchema = z.object({
  windowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type ModelContextHints = z.infer<typeof ModelContextHintsSchema>;

/** Provider prices in USD per one million tokens. */
export const ModelCostHintsSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});
export type ModelCostHints = z.infer<typeof ModelCostHintsSchema>;

export const ModelCapabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  json: z.boolean().optional(),
  context: ModelContextHintsSchema.optional(),
  cost: ModelCostHintsSchema.optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/** A model advertised by a provider (live-fetched, cached, or manually entered). */
export const RemoteModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  ownedBy: z.string().optional(),
  apiType: ModelApiTypeSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.string()).optional(),
  outputModalities: z.array(z.string()).optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  /** User-authored values that override native and catalog capability metadata. */
  capabilityOverrides: ModelCapabilitiesSchema.optional(),
  family: z.string().optional(),
  families: z.array(z.string()).optional(),
  parameterSize: z.string().optional(),
  quantization: z.string().optional(),
  format: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sizeVramBytes: z.number().int().nonnegative().optional(),
  loaded: z.boolean().optional(),
  loadedInstanceIds: z.array(z.string()).optional(),
  expiresAt: ISODateSchema.optional(),
  raw: JsonValueSchema.optional(),
});
export type RemoteModel = z.infer<typeof RemoteModelSchema>;

/** Resolves manual overrides over provider/catalog metadata and legacy fields. */
export function resolveModelCapabilities(model: RemoteModel | undefined): ModelCapabilities {
  if (!model) return {};
  const detected = model.capabilities ?? {};
  const overrides = model.capabilityOverrides ?? {};
  const detectedContext = detected.context ?? {};
  const overrideContext = overrides.context ?? {};
  return {
    ...detected,
    ...overrides,
    context: {
      ...(model.contextWindow ? { windowTokens: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...detectedContext,
      ...overrideContext,
    },
    cost: { ...(detected.cost ?? {}), ...(overrides.cost ?? {}) },
  };
}

export const DiscoveredLocalProviderSchema = z.object({
  presetId: z.enum(["jan-llamacpp", "ollama", "lm-studio"]),
  kind: ModelProviderKindSchema,
  name: z.string(),
  baseUrl: z.string().url(),
  apiType: ModelApiTypeSchema,
  authType: ProviderAuthTypeSchema,
  running: z.boolean(),
  models: z.array(RemoteModelSchema),
  version: z.string().optional(),
  nativeApi: z.boolean().default(false),
  helpCommand: z.string().optional(),
});
export type DiscoveredLocalProvider = z.infer<typeof DiscoveredLocalProviderSchema>;

export const ProviderCapabilitiesSchema = z.object({
  reasoning: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  imageInput: z.boolean().optional(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ModelProviderSchema = z.object({
  id: z.string(),
  kind: ModelProviderKindSchema,
  name: z.string(),
  apiType: ModelApiTypeSchema,
  baseUrl: z.string().url(),
  /** Request path appended to baseUrl for turns; null = the apiType default. */
  endpointPath: z.string().nullable(),
  /** Path for listing models; null = manual/cached models only (e.g. Anthropic). */
  modelsPath: z.string().nullable(),
  defaultModel: z.string(),
  /** Keychain reference; null for keyless (local) providers. */
  credentialRef: z.string().nullable(),
  authType: ProviderAuthTypeSchema,
  enabled: z.boolean(),
  /** Cached model list (last fetch or manual entries). */
  models: z.array(RemoteModelSchema).default([]),
  capabilities: ProviderCapabilitiesSchema.default({}),
  headers: z.record(z.string()).default({}),
  source: ProviderSourceSchema.default("custom"),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const OrgModelPolicyStatusSchema = z.enum(["allowed", "blocked"]);
export type OrgModelPolicyStatus = z.infer<typeof OrgModelPolicyStatusSchema>;

const LegacyConversationKindSchema = z.preprocess(
  (value) => value === "cowork" ? "chat" : value,
  ConversationKindSchema,
);
const ConversationKindListSchema = z.preprocess(
  (value) => Array.isArray(value)
    ? [...new Set(value.map((item) => item === "cowork" ? "chat" : item))]
    : value,
  z.array(ConversationKindSchema),
);

export const OrgModelPolicySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  providerId: z.string(),
  model: z.string(),
  displayName: z.string().nullable().default(null),
  presetId: z.string().nullable().default(null),
  apiType: ModelApiTypeSchema.nullable().default(null),
  capabilities: ModelCapabilitiesSchema.default({}),
  status: OrgModelPolicyStatusSchema.default("allowed"),
  enforce: z.boolean().default(false),
  modeAllow: ConversationKindListSchema.default(["chat", "code"]),
  metadata: JsonValueSchema.default({}),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type OrgModelPolicy = z.infer<typeof OrgModelPolicySchema>;

export const OrgModelDefaultSchema = z.object({
  tenantId: z.string(),
  mode: LegacyConversationKindSchema,
  providerId: z.string(),
  model: z.string(),
  enforce: z.boolean().default(false),
  updatedAt: ISODateSchema,
});
export type OrgModelDefault = z.infer<typeof OrgModelDefaultSchema>;

export const ModelGovernanceDecisionSchema = z.object({
  tenantId: z.string(),
  mode: LegacyConversationKindSchema,
  requestedProviderId: z.string().nullable(),
  requestedModel: z.string().nullable(),
  providerId: z.string(),
  model: z.string(),
  allowed: z.boolean(),
  enforced: z.boolean(),
  reason: z.string(),
  policy: OrgModelPolicySchema.nullable(),
  default: OrgModelDefaultSchema.nullable(),
});
export type ModelGovernanceDecision = z.infer<typeof ModelGovernanceDecisionSchema>;

export const McpTransportSchema = z.enum(["stdio", "http-sse", "streamable-http"]);
export const McpAuthTypeSchema = z.enum(["none", "bearer-api-key", "oauth-authorization-code", "oauth-device"]);
export const McpHealthStatusSchema = z.enum(["disconnected", "connecting", "connected", "auth-required", "error"]);
export const McpOAuthConfigSchema = z.object({
  clientId: z.string(),
  authorizationUrl: z.string().url().nullable(),
  tokenUrl: z.string().url(),
  deviceAuthorizationUrl: z.string().url().nullable(),
  scopes: z.array(z.string()).default([]),
}).nullable();
export const McpCachedToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: JsonValueSchema,
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
});

export const PermissionGrantSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  mode: PermissionModeSchema,
  subject: z.string(),
  decision: z.string(),
  expiresAt: ISODateSchema.nullable(),
  createdAt: ISODateSchema,
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const ExecPolicyStoredRuleSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  layer: z.enum(["managed", "workspace", "user", "session"]),
  kind: z.enum(["prefix_rule", "exact", "regex-lite", "network"]),
  decision: z.enum(["allow", "prompt", "forbid"]),
  pattern: z.union([z.string(), z.array(z.string())]),
  description: z.string().nullable(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type ExecPolicyStoredRule = z.infer<typeof ExecPolicyStoredRuleSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  category: z.string(),
  action: z.string(),
  actor: z.string(),
  workspaceId: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  subject: z.string().nullable(),
  metadata: JsonValueSchema,
  previousHash: z.string(),
  eventHash: z.string(),
  createdAt: ISODateSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const CloudAuditEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  sequence: z.number().int().positive(),
  actorUserId: z.string().nullable(),
  category: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  before: JsonValueSchema.nullable(),
  after: JsonValueSchema.nullable(),
  metadata: JsonValueSchema,
  previousHash: z.string(),
  eventHash: z.string(),
  ts: ISODateSchema,
  expiresAt: ISODateSchema,
  createdAt: ISODateSchema,
});
export type CloudAuditEvent = z.infer<typeof CloudAuditEventSchema>;

export const CloudAuditIngestEventSchema = z.object({
  id: z.string().optional(),
  sequence: z.number().int().positive().optional(),
  actor: z.string().nullable().optional(),
  category: z.string().trim().min(1),
  action: z.string().trim().min(1),
  targetType: z.string().trim().min(1).nullable().optional(),
  targetId: z.string().trim().min(1).nullable().optional(),
  workspaceId: z.string().trim().min(1).nullable().optional(),
  taskId: z.string().trim().min(1).nullable().optional(),
  sessionId: z.string().trim().min(1).nullable().optional(),
  before: JsonValueSchema.nullable().optional(),
  after: JsonValueSchema.nullable().optional(),
  metadata: JsonValueSchema.optional(),
  ts: ISODateSchema.optional(),
}).strict();
export type CloudAuditIngestEvent = z.infer<typeof CloudAuditIngestEventSchema>;

export const CloudAuditIngestRequestSchema = z.object({
  source: z.enum(["desktop", "cli", "mobile", "extension", "platform", "fixture"]),
  events: z.array(CloudAuditIngestEventSchema).min(1).max(250),
}).strict();
export type CloudAuditIngestRequest = z.infer<typeof CloudAuditIngestRequestSchema>;

export const CloudAuditSettingsSchema = z.object({
  tenantId: z.string(),
  retentionDays: z.number().int().min(1).max(3650),
  clientIngestEnabled: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: ISODateSchema,
});
export type CloudAuditSettings = z.infer<typeof CloudAuditSettingsSchema>;

export const CloudAuditSettingsUpdateSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
  clientIngestEnabled: z.boolean().optional(),
}).strict();
export type CloudAuditSettingsUpdate = z.infer<typeof CloudAuditSettingsUpdateSchema>;

export const CloudAuditExportConfigSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.enum(["webhook", "s3"]),
  status: z.enum(["enabled", "disabled"]),
  destination: z.string().min(1),
  format: z.enum(["json", "csv"]).default("json"),
  config: JsonValueSchema,
  lastExportedAt: ISODateSchema.nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: ISODateSchema,
});
export type CloudAuditExportConfig = z.infer<typeof CloudAuditExportConfigSchema>;

export const CloudAuditExportConfigUpsertSchema = z.object({
  kind: z.enum(["webhook", "s3"]),
  status: z.enum(["enabled", "disabled"]).default("enabled").optional(),
  destination: z.string().trim().min(1),
  format: z.enum(["json", "csv"]).default("json").optional(),
  config: JsonValueSchema.optional(),
}).strict();
export type CloudAuditExportConfigUpsert = z.infer<typeof CloudAuditExportConfigUpsertSchema>;

export const CloudAuditExportResultSchema = z.object({
  tenantId: z.string(),
  configId: z.string().nullable(),
  kind: z.enum(["download", "webhook", "s3"]),
  format: z.enum(["json", "csv"]),
  count: z.number().int().nonnegative(),
  chainValid: z.boolean(),
  destination: z.string().nullable(),
  delivered: z.boolean(),
  exportedAt: ISODateSchema,
});
export type CloudAuditExportResult = z.infer<typeof CloudAuditExportResultSchema>;

export const ManagedPolicyBundleSchema = z.object({
  version: z.number().int().positive(),
  organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  issuedAt: ISODateSchema,
  expiresAt: ISODateSchema.nullable().optional(),
  policy: z.object({
    execpolicy: z.array(z.object({
      id: z.string().min(1),
      kind: z.enum(["prefix_rule", "exact", "regex-lite", "network"]),
      decision: z.enum(["allow", "prompt", "forbid"]),
      pattern: z.union([z.string(), z.array(z.string())]),
      description: z.string().optional(),
    })).default([]),
    modelAllowlist: z.array(z.string().min(1)).default([]),
    mcpAllowlist: z.array(z.string().min(1)).default([]),
    pluginAllowlist: z.array(z.string().min(1)).default([]),
    personalAdditions: z.object({ skills: z.boolean(), mcp: z.boolean() }).optional(),
    capabilityCatalog: z.array(z.object({
      kind: z.enum(["skill", "mcp"]), id: z.string(), name: z.string().optional(), description: z.string().optional(),
      hash: z.string().nullable(), assignment: z.enum(["required", "default-on", "available", "blocked"]),
      content: z.string().optional(), url: z.string().url().optional(), transport: z.enum(["http-sse", "streamable-http"]).optional(),
    })).optional(),
    sandboxFloor: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
    telemetry: z.enum(["disabled", "optional", "required"]).default("optional"),
  }),
  signature: z.object({
    algorithm: z.literal("ed25519"),
    keyId: z.string().min(1),
    value: z.string().min(1),
  }),
});
export type ManagedPolicyBundle = z.infer<typeof ManagedPolicyBundleSchema>;

export const ManagedPolicyUnsignedBundleSchema = ManagedPolicyBundleSchema.omit({ signature: true });
export type ManagedPolicyUnsignedBundle = z.infer<typeof ManagedPolicyUnsignedBundleSchema>;

export const ManagedPolicyPublishRequestSchema = z.object({
  organization: ManagedPolicyBundleSchema.shape.organization.optional(),
  expiresAt: ISODateSchema.nullable().optional(),
  policy: ManagedPolicyBundleSchema.shape.policy,
  status: z.enum(["draft", "active", "revoked"]).default("active").optional(),
  note: z.string().max(5000).nullable().optional(),
});
export type ManagedPolicyPublishRequest = z.infer<typeof ManagedPolicyPublishRequestSchema>;

export const ManagedPolicyVersionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active", "revoked"]),
  bundle: ManagedPolicyBundleSchema,
  bundlePath: z.string(),
  bundleHash: z.string().min(1),
  keyId: z.string().min(1),
  publishedBy: z.string().nullable(),
  publishedAt: ISODateSchema,
  revokedAt: ISODateSchema.nullable(),
  auditEventId: z.string().nullable(),
  note: z.string().nullable(),
});
export type ManagedPolicyVersion = z.infer<typeof ManagedPolicyVersionSchema>;

export const ManagedPolicyStatusSchema = z.object({
  state: z.enum(["absent", "active", "rejected"]),
  path: z.string().nullable(),
  organization: ManagedPolicyBundleSchema.shape.organization.nullable(),
  version: z.number().int().positive().nullable(),
  keyId: z.string().nullable(),
  issuedAt: ISODateSchema.nullable(),
  expiresAt: ISODateSchema.nullable(),
  error: z.string().nullable(),
  locks: z.array(z.enum(["execpolicy", "models", "skills", "mcp", "plugins", "sandbox", "telemetry"])),
  personalAdditions: ManagedPolicyBundleSchema.shape.policy.shape.personalAdditions.nullable().default(null),
  capabilityCatalog: ManagedPolicyBundleSchema.shape.policy.shape.capabilityCatalog.default([]),
});
export type ManagedPolicyStatus = z.infer<typeof ManagedPolicyStatusSchema>;

export const ManagedPolicySyncResultSchema = z.object({
  status: ManagedPolicyStatusSchema,
  bundle: ManagedPolicyBundleSchema.nullable(),
  provenance: z.object({
    source: z.enum(["platform", "mdm", "manual", "development"]),
    url: z.string().nullable(),
    fetchedAt: ISODateSchema,
    verifiedAt: ISODateSchema.nullable(),
    bundleHash: z.string().nullable(),
  }),
});
export type ManagedPolicySyncResult = z.infer<typeof ManagedPolicySyncResultSchema>;

export const PlatformOrgSessionSchema = z.object({
  state: z.enum(["signed-out", "connected"]),
  baseUrl: z.string().url().nullable(),
  tenantId: z.string().nullable(),
  organization: ManagedPolicyBundleSchema.shape.organization.nullable(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email().nullable(),
    name: z.string().nullable(),
  }).nullable(),
  credentialRef: z.string().min(1).nullable(),
  tokenType: z.string().nullable(),
  expiresAt: ISODateSchema.nullable(),
  policyUrl: z.string().url().nullable(),
  policyPublicKeys: z.record(z.string()).default({}),
  usageIngestUrl: z.string().url().nullable(),
  usageSigningKeyId: z.string().nullable(),
  usageUploadEnabled: z.boolean(),
  connectedAt: ISODateSchema.nullable(),
  updatedAt: ISODateSchema.nullable(),
});
export type PlatformOrgSession = z.infer<typeof PlatformOrgSessionSchema>;

export const PlatformLoginStartResultSchema = z.object({
  authorizationUrl: z.string().url(),
  state: z.string().min(1),
  redirectUri: z.string().url(),
  baseUrl: z.string().url(),
});
export type PlatformLoginStartResult = z.infer<typeof PlatformLoginStartResultSchema>;

export const PlatformLoginExchangeResultSchema = z.object({
  session: PlatformOrgSessionSchema,
  policy: ManagedPolicySyncResultSchema.nullable(),
});
export type PlatformLoginExchangeResult = z.infer<typeof PlatformLoginExchangeResultSchema>;

export const PlatformUsageFlushResultSchema = z.object({
  uploaded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reason: z.string().nullable(),
});
export type PlatformUsageFlushResult = z.infer<typeof PlatformUsageFlushResultSchema>;

export const McpServerConfigSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  transport: McpTransportSchema,
  command: z.string().nullable(),
  args: z.array(z.string()).default([]),
  url: z.string().url().nullable(),
  env: z.record(z.string()).default({}),
  authType: McpAuthTypeSchema.default("none"),
  credentialRef: z.string().nullable().default(null),
  oauth: McpOAuthConfigSchema.default(null),
  source: z.string().default("manual"),
  trusted: z.boolean(),
  enabled: z.boolean(),
  healthStatus: McpHealthStatusSchema.default("disconnected"),
  toolCount: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  lastCheckedAt: ISODateSchema.nullable().default(null),
  cachedTools: z.array(McpCachedToolSchema).default([]),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpImportCandidateSchema = z.object({
  source: z.enum(["claude-code", "codex", "zcode", "agents"]),
  sourcePath: z.string(),
  name: z.string(),
  transport: McpTransportSchema,
  command: z.string().nullable(),
  args: z.array(z.string()).default([]),
  url: z.string().url().nullable(),
  env: z.record(z.string()).default({}),
});
export type McpImportCandidate = z.infer<typeof McpImportCandidateSchema>;

export const SkillManifestSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  sourcePath: z.string(),
  originPath: z.string().nullable().default(null),
  version: z.string().default("0.1.0"),
  contentHash: z.string().default(""),
  updateAvailable: z.boolean().default(false),
  pendingContentHash: z.string().nullable().default(null),
  scope: z.enum(["workspace", "workspace-legacy", "user", "user-legacy", "codex", "registered", "plugin"]).default("registered"),
  readOnly: z.boolean().default(false),
  trusted: z.boolean(),
  enabled: z.boolean(),
  shadowedBy: z.string().nullable().default(null),
  shadows: z.array(z.string()).default([]),
  diagnostic: z.string().nullable().default(null),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillPackageLimitsSchema = z.object({
  maxArchiveBytes: z.number().positive().optional(),
  maxExtractedBytes: z.number().positive().optional(),
  maxIndividualFileBytes: z.number().positive().optional(),
  maxFiles: z.number().int().positive().optional(),
  maxPathLength: z.number().int().positive().optional(),
  maxDirectoryDepth: z.number().int().positive().optional(),
  maxCompressionRatio: z.number().positive().optional(),
  maxEntryCompressionRatio: z.number().positive().optional(),
}).default({});
export type SkillPackageLimits = z.infer<typeof SkillPackageLimitsSchema>;

export const SkillImportPreviewSchema = z.object({
  archivePath: z.string(),
  archiveName: z.string(),
  fingerprint: z.string(),
  name: z.string(),
  description: z.string(),
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  allowedTools: z.string().nullable(),
  metadata: z.record(z.string()),
  version: z.string(),
  archiveSize: z.number().nonnegative(),
  extractedSize: z.number().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  rootLayout: z.enum(["archive-root", "top-level-directory"]),
  sourceDirectoryName: z.string().nullable(),
  hasScripts: z.boolean(),
  scripts: z.array(z.string()),
  references: z.array(z.string()),
  assets: z.array(z.string()),
  resources: z.array(z.string()),
  projectAvailable: z.boolean(),
  projectTrusted: z.boolean(),
  destinations: z.object({ project: z.string().nullable(), global: z.string() }),
  conflicts: z.object({ project: z.boolean(), global: z.boolean() }),
  limits: SkillPackageLimitsSchema,
});
export type SkillImportPreview = z.infer<typeof SkillImportPreviewSchema>;

export const CommandManifestSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  sourcePath: z.string().nullable(),
  trusted: z.boolean(),
  enabled: z.boolean(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type CommandManifest = z.infer<typeof CommandManifestSchema>;

export const SkillScopeSchema = z.enum(["workspace", "workspace-legacy", "user", "user-legacy", "codex", "registered", "plugin"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const TaskGroupSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  position: z.number().int().default(0),
  collapsed: z.boolean().default(false),
  taskIds: z.array(z.string()).default([]),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type TaskGroup = z.infer<typeof TaskGroupSchema>;

export const WorkspaceIndexStatusSchema = z.object({
  id: z.string().nullable(),
  workspaceId: z.string(),
  rootPath: z.string(),
  status: z.enum(["missing", "ready", "indexing", "failed"]),
  watcherStatus: z.enum(["unavailable", "watching", "pending", "error"]).default("unavailable"),
  watcherPending: z.number().int().nonnegative().default(0),
  watcherError: z.string().nullable().default(null),
  fileCount: z.number().int().nonnegative(),
  indexedAt: ISODateSchema.nullable(),
  error: z.string().nullable(),
  metadata: JsonValueSchema.default({}),
});
export type WorkspaceIndexStatus = z.infer<typeof WorkspaceIndexStatusSchema>;

export const WorkspaceIndexSearchResultSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  absolutePath: z.string(),
  kind: z.string(),
  language: z.string().nullable(),
  size: z.number().int().nonnegative(),
  updatedAt: ISODateSchema,
  snippet: z.string(),
  score: z.number().optional(),
});
export type WorkspaceIndexSearchResult = z.infer<typeof WorkspaceIndexSearchResultSchema>;

export const WorkspaceWikiSchema = z.object({
  workspaceId: z.string(),
  generatedAt: ISODateSchema,
  updatedAt: ISODateSchema,
  overview: z.string(),
  languages: z.array(z.object({ name: z.string(), files: z.number().int().nonnegative() })).default([]),
  topDirectories: z.array(z.object({ path: z.string(), files: z.number().int().nonnegative() })).default([]),
  entrypoints: z.array(z.string()).default([]),
});
export type WorkspaceWiki = z.infer<typeof WorkspaceWikiSchema>;

export const PluginInstallSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  source: z.string(),
  sourcePath: z.string().nullable(),
  sourceKind: z.enum(["manifest", "folder", "git"]).default("manifest"),
  sourceUrl: z.string().nullable().default(null),
  commitHash: z.string().nullable().default(null),
  contentHash: z.string().default(""),
  signatureStatus: z.enum(["unsigned", "verified", "invalid"]).default("unsigned"),
  signatureFingerprint: z.string().nullable().default(null),
  updateAvailable: z.boolean().default(false),
  pendingVersion: z.string().nullable().default(null),
  pendingContentHash: z.string().nullable().default(null),
  pendingCommitHash: z.string().nullable().default(null),
  capabilityDiff: z.array(z.string()).default([]),
  manifest: JsonValueSchema,
  trusted: z.boolean(),
  enabled: z.boolean(),
  installedAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type PluginInstall = z.infer<typeof PluginInstallSchema>;

export const HookLifecycleSchema = z.enum(["PreToolUse", "PostToolUse", "TurnStart", "TurnEnd"]);
export type HookLifecycle = z.infer<typeof HookLifecycleSchema>;

export const CommandHookSchema = z.object({
  id: z.string().optional(),
  event: HookLifecycleSchema,
  matcher: z.string().default(".*"),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  failurePolicy: z.enum(["block", "continue"]).default("block"),
  source: z.enum(["user", "workspace", "plugin"]).default("user"),
});
export type CommandHook = z.infer<typeof CommandHookSchema>;

export const HookConfigSchema = z.object({ hooks: z.array(CommandHookSchema).default([]) });
export type HookConfig = z.infer<typeof HookConfigSchema>;

export const SandboxPolicySchema = z.discriminatedUnion("tier", [
  z.object({ tier: z.literal("read-only") }),
  z.object({
    tier: z.literal("workspace-write"),
    writableRoots: z.array(z.string()).min(1),
    network: z.enum(["on", "off"]).default("off"),
  }),
  z.object({ tier: z.literal("danger-full-access") }),
]);
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export const SandboxStatusSchema = z.object({
  platform: z.enum(["macos", "linux", "windows", "other"]),
  tier: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  enforcement: z.enum(["enforced", "approval-only"]),
  mechanism: z.enum(["seatbelt", "bubblewrap", "none"]),
  network: z.enum(["on", "off", "unrestricted"]),
  reason: z.string().nullable(),
});
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const NetworkPolicySchema = z.object({
  egress: z.enum(["off", "on", "unrestricted"]),
  allowedDomains: z.array(z.string()).default([]),
});
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export function parseNetworkDomainAllowlist(value: JsonValue | undefined): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const domains = values.map((item) => typeof item === "string" ? item.trim().toLowerCase().replace(/\.$/, "") : "").filter(Boolean);
  for (const domain of domains) {
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes("..")) {
      throw new Error(`Invalid network domain pattern: ${domain}`);
    }
  }
  return [...new Set(domains)].sort();
}

export function networkDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((pattern) => pattern.startsWith("*.")
    ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
    : host === pattern);
}

export function networkPolicyForSandbox(policy: SandboxPolicy, allowedDomains: string[] = []): NetworkPolicy {
  if (policy.tier === "danger-full-access") return { egress: "unrestricted", allowedDomains };
  if (policy.tier === "read-only") return { egress: "off", allowedDomains };
  return { egress: policy.network, allowedDomains };
}

export function sandboxPolicyForPermission(
  permissionMode: PermissionMode,
  workspaceRoot: string,
  options: { writableRoots?: string[]; network?: "on" | "off" } = {},
): SandboxPolicy {
  if (permissionMode === "plan") return { tier: "read-only" };
  if (permissionMode === "full-access") return { tier: "danger-full-access" };
  return {
    tier: "workspace-write",
    writableRoots: options.writableRoots?.length ? options.writableRoots : [workspaceRoot],
    network: options.network ?? "off",
  };
}

export const UsageEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  providerId: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  name: z.string(),
  status: z.string().nullable(),
  value: JsonValueSchema,
  createdAt: ISODateSchema,
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const RouterAttributionSchema = z.object({
  requestedModel: z.string(),
  servedProvider: z.string().optional(),
  servedModel: z.string().optional(),
});
export type RouterAttribution = z.infer<typeof RouterAttributionSchema>;

export const RouterQuotaSchema = z.object({
  limit: z.number().nonnegative().nullable(),
  used: z.number().nonnegative(),
  remaining: z.number().nonnegative().nullable(),
  unit: z.string(),
  resetsAt: ISODateSchema.nullable(),
});
export type RouterQuota = z.infer<typeof RouterQuotaSchema>;

export const RouterAccountSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  plan: z.string(),
  quota: RouterQuotaSchema,
  aliases: z.array(z.string()),
});
export type RouterAccount = z.infer<typeof RouterAccountSchema>;

export const RouterContractStatusSchema = z.object({
  oauthAvailable: z.boolean(),
  redirectUri: z.string(),
  accountPath: z.string(),
});
export type RouterContractStatus = z.infer<typeof RouterContractStatusSchema>;

/** Scope/provenance of a sub-agent, in precedence order (later wins on name). */
export const SubagentScopeSchema = z.enum(["built-in", "user", "workspace"]);
export type SubagentScope = z.infer<typeof SubagentScopeSchema>;

/**
 * A sub-agent: a Markdown file with YAML frontmatter (metadata) + body (system
 * prompt). Built-ins are synthesized, not file-backed.
 */
export const SubagentManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string().default(""),
  model: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  /** Allowed tool names; ["*"] = all tools. */
  tools: z.array(z.string()).default(["*"]),
  disallowedTools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  permissionMode: z.string().nullable().default(null),
  maxTurns: z.number().nullable().default(null),
  scope: SubagentScopeSchema,
  /** Absolute path to the .md file, or "built-in:<name>". */
  path: z.string(),
  enabled: z.boolean().default(true),
  /** Only user-scope agents can be edited/deleted/disabled. */
  readOnly: z.boolean().default(false),
});
export type SubagentManifest = z.infer<typeof SubagentManifestSchema>;

export const BrowserSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.enum(["starting", "running", "closed", "failed"]),
  currentUrl: z.string().nullable(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

export const ContextStatsSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive().nullable(),
  percentUsed: z.number().min(0).max(100).nullable(),
  tokensLeft: z.number().int().nullable(),
  source: z.enum(["estimated", "provider-reported", "unknown"]),
  thresholdState: z.enum(["unknown", "normal", "warning", "critical"]),
});
export type ContextStats = z.infer<typeof ContextStatsSchema>;

export const GitChangedFileSchema = z.object({
  path: z.string(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
});
export type GitChangedFile = z.infer<typeof GitChangedFileSchema>;

export const GitInfoSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  diffBase: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirty: z.boolean(),
  changedFiles: z.number().int().nonnegative(),
  stagedFiles: z.number().int().nonnegative(),
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

export const GitBranchInfoSchema = z.object({
  name: z.string(),
  current: z.boolean(),
});
export type GitBranchInfo = z.infer<typeof GitBranchInfoSchema>;

export const ReviewScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working-tree"), baseBranch: z.string().min(1).nullable().optional() }),
  z.object({ kind: z.literal("branch"), branch: z.string().min(1), baseBranch: z.string().min(1) }),
  z.object({ kind: z.literal("range"), from: z.string().min(1), to: z.string().min(1) }),
]);
export type ReviewScope = z.infer<typeof ReviewScopeSchema>;

export const ReviewSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  taskId: z.string().nullable().default(null),
  scope: ReviewScopeSchema,
  commitSha: z.string().min(7),
  status: z.enum(["active", "completed"]),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type ReviewSession = z.infer<typeof ReviewSessionSchema>;

export const ReviewCommentAnchorSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable(),
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
  commitSha: z.string().min(7),
  contextHash: z.string().min(1),
});
export type ReviewCommentAnchor = z.infer<typeof ReviewCommentAnchorSchema>;

export const ReviewCommentSchema = z.object({
  id: z.string(),
  reviewSessionId: z.string(),
  anchor: ReviewCommentAnchorSchema,
  body: z.string().min(1),
  resolved: z.boolean(),
  source: z.enum(["local", "github"]).optional(),
  author: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  externalId: z.number().int().positive().nullable().optional(),
  inReplyToId: z.number().int().positive().nullable().optional(),
  outdated: z.boolean().optional(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const GitPullRequestViewSchema = GitPullRequestSchema.extend({
  headSha: z.string().min(7),
  mergeable: z.string().nullable(),
  diff: z.string(),
  comments: z.array(ReviewCommentSchema),
});
export type GitPullRequestView = z.infer<typeof GitPullRequestViewSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string(),
  reviewSessionId: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  anchor: ReviewCommentAnchorSchema,
  title: z.string(),
  rationale: z.string(),
  suggestionPatch: z.string().nullable(),
  verificationReason: z.string(),
  convertedCommentId: z.string().nullable(),
  applied: z.boolean(),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const TimelineItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkpoint"), id: z.string(), taskId: z.string().nullable(), sessionId: z.string().nullable(), entryId: z.string().nullable(), commitSha: z.string(), message: z.string(), reason: z.enum(["manual", "auto-rewind", "auto-restore", "auto-merge"]), createdAt: ISODateSchema }),
  z.object({ kind: z.literal("conversation"), id: z.string(), sessionId: z.string(), entryId: z.string(), role: z.enum(["user", "assistant"]), summary: z.string(), createdAt: ISODateSchema }),
]);
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const HostRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: JsonValueSchema.optional(),
});
export type HostRequest = z.infer<typeof HostRequestSchema>;

export const HostResponseSchema = z.object({
  id: z.string(),
  result: JsonValueSchema.optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: JsonValueSchema.optional(),
    })
    .optional(),
});
export type HostResponse = z.infer<typeof HostResponseSchema>;

export const HostEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  workspaceId: z.string().nullable(),
  taskId: z.string().nullable(),
  payload: JsonValueSchema,
  createdAt: ISODateSchema,
});
export type HostEvent = z.infer<typeof HostEventSchema>;

export const TurnEndStatusSchema = z.enum(["completed", "cancelled", "failed"]);
export type TurnEndStatus = z.infer<typeof TurnEndStatusSchema>;

export const SessionNoteKindSchema = z.enum(["compacted", "resumed", "forked", "rewound", "steered", "followed-up"]);
export type SessionNoteKind = z.infer<typeof SessionNoteKindSchema>;

/**
 * Streaming vocabulary for a single agent turn. The host pushes these to the
 * renderer as JSON-RPC notifications; the renderer folds them into thread state.
 */
export const AgentStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn.start"),
    turnId: z.string(),
    /** The provider is resuming the interrupted assistant turn in place. */
    continuation: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("message.start"), messageId: z.string(), role: MessageRoleSchema }),
  z.object({
    kind: z.literal("message.delta"),
    messageId: z.string(),
    delta: z.string(),
    channel: z.enum(["text", "reasoning"]).default("text"),
  }),
  z.object({ kind: z.literal("message.end"), messageId: z.string() }),
  z.object({
    kind: z.literal("tool.start"),
    toolCallId: z.string(),
    name: z.string(),
    title: z.string().optional(),
    args: JsonValueSchema.optional(),
    /** Set when this tool call belongs to a sub-agent, referencing its `task` call. */
    parentToolCallId: z.string().optional(),
  }),
  z.object({ kind: z.literal("tool.update"), toolCallId: z.string(), detail: z.string().optional(), parentToolCallId: z.string().optional() }),
  z.object({
    kind: z.literal("tool.end"),
    toolCallId: z.string(),
    status: z.enum(["completed", "failed", "denied"]),
    durationMs: z.number().optional(),
    summary: z.string().optional(),
    parentToolCallId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("approval.request"),
    approvalId: z.string(),
    approvalKind: ApprovalKindSchema,
    title: z.string(),
    detail: z.string().optional(),
    subject: z.string().optional(),
    rawDetail: z.string().optional(),
    diff: z.string().optional(),
    destructive: z.boolean().optional(),
    openWorld: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("question.request"),
    questionId: z.string(),
    toolCallId: z.string(),
    question: z.string(),
    options: z.array(QuestionOptionSchema).default([]),
    multi: z.boolean().default(false),
    questions: z.array(QuestionPromptSchema).min(1).max(5).optional(),
  }),
  z.object({ kind: z.literal("question.answered"), questionId: z.string() }),
  z.object({
    kind: z.literal("usage"),
    inputTokens: z.number(),
    outputTokens: z.number(),
    model: z.string().optional(),
    requestedModel: z.string().optional(),
    servedProvider: z.string().optional(),
    servedModel: z.string().optional(),
  }),
  z.object({ kind: z.literal("session.note"), note: SessionNoteKindSchema, detail: z.string().optional() }),
  z.object({
    kind: z.literal("mode.changed"),
    mode: UiModeSchema,
    source: UiModeSourceSchema,
    reason: z.string(),
    applied: z.boolean(),
    pinnedByUser: z.boolean(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("turn.end"), turnId: z.string(), status: TurnEndStatusSchema }),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

export const TurnStateSchema = z.object({
  active: z.boolean(),
  turnId: z.string().nullable(),
  bufferedEvents: z.array(AgentStreamEventSchema),
  replayOnly: z.boolean().default(false),
  owner: z.string().nullable().optional(),
});
export type TurnState = z.infer<typeof TurnStateSchema>;

/** Envelope for every host-to-renderer push event. */
export const HostPushEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.event"),
    taskId: z.string(),
    sessionId: z.string(),
    event: AgentStreamEventSchema,
  }),
  z.object({
    type: z.literal("terminal.output"),
    terminalId: z.string(),
    seq: z.number(),
    data: z.string(),
  }),
  z.object({ type: z.literal("terminal.exit"), terminalId: z.string(), exitCode: z.number().nullable() }),
  z.object({ type: z.literal("task.updated"), task: TaskSchema }),
  z.object({ type: z.literal("approval.updated"), approval: ApprovalRequestSchema }),
  z.object({ type: z.literal("question.updated"), question: QuestionRequestSchema }),
  z.object({ type: z.literal("browser.session.updated"), session: BrowserSessionSchema }),
  z.object({ type: z.literal("session.target.updated"), target: SessionTargetSchema.nullable(), sessionId: z.string() }),
  z.object({ type: z.literal("session.lease.lost"), sessionId: z.string(), owner: z.string(), previousOwner: z.string().nullable() }),
  z.object({
    type: z.literal("model.local.progress"),
    operationId: z.string(),
    providerId: z.string(),
    model: z.string(),
    action: z.enum(["pull", "download", "load", "unload"]),
    status: z.string(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    percent: z.number().min(0).max(100).optional(),
    done: z.boolean(),
    cancelled: z.boolean().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("host.shutting_down"), reason: z.string(), graceMs: z.number().int().nonnegative() }),
]);
export type HostPushEvent = z.infer<typeof HostPushEventSchema>;

export const HOST_NAMESPACES = [
  "workspace",
  "task",
  "session",
  "agent",
  "model",
  "file",
  "search",
  "git",
  "terminal",
  "approval",
  "question",
  "permission",
  "policy",
  "audit",
  "settings",
  "credential",
  "mcp",
  "skill",
  "command",
  "plugin",
  "browser",
  "usage",
  "logs",
  "support",
  "updater",
] as const;

export type HostNamespace = (typeof HOST_NAMESPACES)[number];

const EmptyParamsSchema = z.object({}).passthrough().optional();
const OkSchema = z.object({ ok: z.boolean() }).passthrough();
const IdSchema = z.object({ id: z.string() });
const WorkspaceIdSchema = z.object({ workspaceId: z.string(), taskId: z.string().optional() });
const CommandOutputSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
}).passthrough();
const FileTreeEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["dir", "file"]),
  size: z.number().int().nonnegative().optional(),
  updatedAt: ISODateSchema.optional(),
});
const FileListResultSchema = z.object({
  root: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      relativePath: z.string(),
      kind: z.enum(["directory", "file"]),
    }),
  ),
  truncated: z.boolean().default(false),
});
const FileReadResultSchema = z.object({
  path: z.string().optional(),
  content: z.string(),
  truncated: z.boolean(),
});
const CredentialStatusSchema = z.object({
  exists: z.boolean().optional(),
  hint: z.string().nullable().optional(),
  owner: z.string().optional(),
  storage: z.string(),
  plaintext: z.boolean().optional(),
  plaintextSqliteStorage: z.boolean().optional(),
}).passthrough();
export const ProviderCheckResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  category: z.enum(["healthy", "auth", "network", "model", "server"]).optional(),
  message: z.string().optional(),
  modelCount: z.number().int().optional(),
  httpStatus: z.number().int().optional(),
  checkedAt: ISODateSchema.optional(),
  latencyMs: z.number().int().nonnegative().optional(),
}).passthrough();
export type ProviderCheckResult = z.infer<typeof ProviderCheckResultSchema>;
const UsageSummarySchema = z.object({
  days: z.array(z.object({ date: z.string(), tokens: z.number(), turns: z.number() })),
  models: z.array(z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), requests: z.number() })),
  tools: z.array(z.object({ name: z.string(), calls: z.number(), denied: z.number().optional() })),
}).passthrough();
const CompactionResultSchema = z.object({
  summary: z.string(),
  tokensBefore: z.number().int().nonnegative(),
}).passthrough();
const AgentListResultSchema = z.object({
  agents: z.array(SubagentManifestSchema),
  diagnostics: z.array(JsonValueSchema).default([]),
});
const LogsRowSchema = z.object({
  id: z.string(),
  level: z.string(),
  source: z.string(),
  message: z.string(),
  metadata: JsonValueSchema,
  createdAt: ISODateSchema,
});
const SupportIssueReportResultSchema = z.object({
  path: z.string(),
  issueBodyPath: z.string().nullable(),
  configHash: z.string(),
  logCount: z.number().int().nonnegative(),
  usageEventCount: z.number().int().nonnegative(),
  crashReportCount: z.number().int().nonnegative(),
  telemetryEnabled: z.boolean(),
  schemaVersion: z.literal(1),
});
const SupportCrashReportResultSchema = z.object({
  recorded: z.boolean(),
  id: z.string().nullable(),
  reason: z.string().nullable(),
});
const UpdaterStatusSchema = z.object({
  status: z.enum(["development", "not-configured", "current", "available", "error"]),
  feed: z.string(),
  configured: z.boolean(),
  endpoint: z.string().optional(),
  signingKeyPresent: z.boolean().optional(),
  currentVersion: z.string().optional(),
  version: z.string().optional(),
  date: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  rolloutEligible: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();
const UpdaterInstallResultSchema = z.object({
  installed: z.boolean(),
  status: z.enum(["installed", "current", "not-configured", "error"]),
  version: z.string().optional(),
  restartRequired: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();
export const AttachmentInputSchema = z.object({
  id: z.string().optional(),
  fileId: z.string().uuid().optional(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  dataUrl: z.string().nullable().optional(),
  textContent: z.string().nullable().optional(),
  localPath: z.string().nullable().optional(),
  sourceKind: z.string().nullable().optional(),
});
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;

export const MessageAttachmentContentSchema = z.object({
  id: z.string().optional(),
  fileId: z.string().uuid().optional(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  sourceKind: z.string().nullable().optional(),
});
export type MessageAttachmentContent = z.infer<typeof MessageAttachmentContentSchema>;

export function messageAttachmentContent(attachment: AttachmentInput): JsonValue {
  return {
    ...(attachment.id ? { id: attachment.id } : {}),
    ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    ...(attachment.sourceKind !== undefined ? { sourceKind: attachment.sourceKind } : {}),
  };
}

export const ArtifactLibraryItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  url: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: ISODateSchema,
  category: z.enum(["images", "documents"]),
});
export type ArtifactLibraryItem = z.infer<typeof ArtifactLibraryItemSchema>;

export const FileOriginSchema = z.enum(["user_upload", "sandbox_output", "image_generation", "browser_capture", "legacy_artifact"]);
export const FileStatusSchema = z.enum(["initiated", "uploading", "scanning", "processing", "available", "failed", "quarantined", "deleted"]);
export const FileAssociationRoleSchema = z.enum(["input", "output", "reference"]);

export const StoredFileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  originalName: z.string(),
  mediaType: z.string(),
  detectedMediaType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  origin: FileOriginSchema,
  status: FileStatusSchema,
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
  taskIds: z.array(z.string().uuid()).default([]),
  roles: z.array(FileAssociationRoleSchema).default([]),
  downloadUrl: z.string(),
  previewUrl: z.string(),
});
export type StoredFile = z.infer<typeof StoredFileSchema>;

export const StoredFilePageSchema = z.object({
  items: z.array(StoredFileSchema),
  nextCursor: z.string().nullable(),
});
export type StoredFilePage = z.infer<typeof StoredFilePageSchema>;

export const MultipartUploadInitiateSchema = z.object({
  fileId: z.string().uuid(),
  uploadId: z.string().uuid(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().positive(),
  expiresAt: ISODateSchema,
});
export type MultipartUploadInitiate = z.infer<typeof MultipartUploadInitiateSchema>;

export const MultipartUploadPartUrlSchema = z.object({
  partNumber: z.number().int().positive(),
  url: z.string().url(),
});
export const MultipartUploadPartUrlsSchema = z.object({ parts: z.array(MultipartUploadPartUrlSchema) });
export type MultipartUploadPartUrl = z.infer<typeof MultipartUploadPartUrlSchema>;

export const QueuedFollowUpStatusSchema = z.enum(["queued", "delivered", "failed", "removed"]);
export const QueuedFollowUpSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sessionId: z.string(),
  ordinal: z.number().int().nonnegative(),
  input: z.string(),
  attachments: z.array(AttachmentInputSchema).default([]),
  status: QueuedFollowUpStatusSchema,
  error: z.string().nullable().default(null),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type QueuedFollowUp = z.infer<typeof QueuedFollowUpSchema>;

export const CloudWorkspaceStateSchema = z.object({
  taskId: z.string().min(1),
  sandboxId: z.string().min(1),
  status: z.enum(["running", "recovering", "failed"]),
  root: z.literal("/workspace"),
  provider: z.string().min(1),
  expiresAt: ISODateSchema.nullable(),
  updatedAt: ISODateSchema,
});
export type CloudWorkspaceState = z.infer<typeof CloudWorkspaceStateSchema>;

export const CloudWorkspaceFileEntrySchema = z.object({
  path: z.string().min(1),
  type: z.enum(["file", "directory", "symlink"]),
  sizeBytes: z.number().int().nonnegative(),
  mtime: ISODateSchema.nullable(),
});
export type CloudWorkspaceFileEntry = z.infer<typeof CloudWorkspaceFileEntrySchema>;

export const CloudTerminalEventSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["input", "stdout", "stderr", "exit", "error"]),
  data: z.string().max(262_144),
});
export type CloudTerminalEvent = z.infer<typeof CloudTerminalEventSchema>;

export const CloudTerminalSessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  status: z.enum(["running", "exited", "closed", "failed"]),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});
export type CloudTerminalSession = z.infer<typeof CloudTerminalSessionSchema>;

export const CloudGitStateSchema = z.object({
  branch: z.string().nullable(),
  clean: z.boolean(),
  status: z.string().max(262_144),
  diff: z.string().max(1_048_576),
});
export type CloudGitState = z.infer<typeof CloudGitStateSchema>;

export const CloudPreviewSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  protocol: z.enum(["http", "https"]),
  url: z.string().url(),
  expiresAt: ISODateSchema.nullable(),
});
export type CloudPreview = z.infer<typeof CloudPreviewSchema>;

export const PersonalSkillSchema = z.object({
  id: z.string().min(1), tenantId: z.string().uuid(), userId: z.string().min(1),
  name: z.string().trim().min(1).max(64), description: z.string().trim().min(1).max(1024),
  content: z.string().min(1).max(262_144), enabled: z.boolean(), trusted: z.boolean(),
  source: z.enum(["text", "upload", "git"]), sourceUrl: z.string().url().nullable(),
  version: z.string().max(64).nullable(), hash: z.string().regex(/^[a-f0-9]{64}$/), diagnostics: z.array(z.string()).default([]),
  createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export type PersonalSkill = z.infer<typeof PersonalSkillSchema>;

export const PersonalSkillReviewSchema = z.object({
  name: z.string(), description: z.string(), source: z.enum(["text", "upload", "git"]),
  hash: z.string(), bytes: z.number().int().nonnegative(), warnings: z.array(z.string()),
  version: z.string().nullable(), license: z.string().nullable(), compatibility: z.string().nullable(), allowedTools: z.string().nullable(),
  resources: z.array(z.string()).default([]), hasScripts: z.boolean().default(false),
});
export type PersonalSkillReview = z.infer<typeof PersonalSkillReviewSchema>;

export const PersonalMcpServerSchema = z.object({
  id: z.string().min(1), tenantId: z.string().uuid(), userId: z.string().min(1),
  name: z.string().trim().min(1).max(100), url: z.string().url(),
  transport: z.enum(["http-sse", "streamable-http"]), auth: z.enum(["none", "bearer", "oauth"]),
  credentialRef: z.string().nullable(), credentialConfigured: z.boolean(),
  enabled: z.boolean(), trusted: z.boolean(), health: z.enum(["unknown", "healthy", "unreachable", "unauthorized", "invalid-response"]),
  toolCount: z.number().int().nonnegative(), lastCheckedAt: ISODateSchema.nullable(), diagnostics: z.array(z.string()).default([]),
  createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export type PersonalMcpServer = z.infer<typeof PersonalMcpServerSchema>;

export const OrgCapabilityAssignmentSchema = z.enum(["required", "default-on", "available", "blocked"]);
export type OrgCapabilityAssignment = z.infer<typeof OrgCapabilityAssignmentSchema>;
export const OrgCapabilitySchema = z.object({
  id: z.string().min(1), tenantId: z.string().uuid(), kind: z.enum(["skill", "mcp"]), capabilityId: z.string().min(1),
  name: z.string().min(1), description: z.string().default(""), assignment: OrgCapabilityAssignmentSchema,
  allowUserDisable: z.boolean(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), config: JsonValueSchema.default({}),
  createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export type OrgCapability = z.infer<typeof OrgCapabilitySchema>;
export const CapabilityUserOverrideSchema = z.object({ tenantId: z.string().uuid(), userId: z.string(), capabilityId: z.string(), enabled: z.boolean(), updatedAt: ISODateSchema });
export type CapabilityUserOverride = z.infer<typeof CapabilityUserOverrideSchema>;
export const EffectiveCapabilitySchema = z.object({
  kind: z.enum(["skill", "mcp"]), capabilityId: z.string(), name: z.string(), enabled: z.boolean(), locked: z.boolean(),
  assignment: OrgCapabilityAssignmentSchema.nullable(), provenance: z.enum(["organization", "personal", "self-host-bootstrap"]),
  reason: z.enum(["required", "default", "user-enabled", "user-disabled", "available", "blocked", "personal", "personal-blocked"]), contentHash: z.string().nullable(),
});
export type EffectiveCapability = z.infer<typeof EffectiveCapabilitySchema>;

export const McpOAuthFlowSchema = z.object({
  serverId: z.string(), state: z.string(), authorizationUrl: z.string().url(), expiresAt: ISODateSchema,
});
export type McpOAuthFlow = z.infer<typeof McpOAuthFlowSchema>;

export const RuntimeMcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "http-sse"]),
  command: z.string().nullable(),
  args: z.array(z.string()).default([]),
  url: z.string().nullable(),
  env: z.record(z.string()).default({}),
});
export type RuntimeMcpServer = z.infer<typeof RuntimeMcpServerSchema>;

export const ExtensionNativeMessagingStatusSchema = z.object({
  enabled: z.boolean(),
  hostName: z.string(),
  manifestPaths: z.array(z.string()),
  configPath: z.string(),
  nativeHostPath: z.string(),
  socketPath: z.string().nullable(),
  tokenPath: z.string().nullable(),
  allowedOrigins: z.array(z.string()),
  requiresExtensionId: z.boolean(),
});
export type ExtensionNativeMessagingStatus = z.infer<typeof ExtensionNativeMessagingStatusSchema>;

export const HostMethodCatalog = {
  "host.handshake": {
    params: z.object({ nonce: z.string().optional(), protocolVersion: z.number().nonnegative().optional() }).passthrough(),
    result: z.object({ ok: z.boolean(), protocolVersion: z.number().int(), capabilities: z.array(z.string()).default([]) }),
  },
  "workspace.open": {
    params: z.object({ path: z.string(), name: z.string().optional(), trusted: z.boolean().optional() }),
    result: WorkspaceSchema,
  },
  "workspace.list": { params: z.object({ includeGeneral: z.boolean().optional() }).default({}), result: z.array(WorkspaceSchema) },
  "workspace.get": { params: IdSchema, result: WorkspaceSchema.nullable() },
  "workspace.update": {
    params: IdSchema.extend({ name: z.string().min(1).optional(), pinned: z.boolean().optional() }),
    result: WorkspaceSchema,
  },
  "workspace.ensureGeneral": { params: EmptyParamsSchema, result: WorkspaceSchema },
  "workspace.remove": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "workspace.index.status": { params: WorkspaceIdSchema, result: WorkspaceIndexStatusSchema },
  "workspace.index.rebuild": {
    params: WorkspaceIdSchema.extend({ force: z.boolean().optional() }),
    result: WorkspaceIndexStatusSchema.extend({ wiki: WorkspaceWikiSchema }),
  },
  "workspace.index.search": {
    params: WorkspaceIdSchema.extend({ query: z.string(), limit: z.number().int().positive().optional() }),
    result: z.object({ results: z.array(WorkspaceIndexSearchResultSchema) }),
  },
  "workspace.wiki.get": { params: WorkspaceIdSchema, result: WorkspaceWikiSchema.nullable() },
  "task.create": {
    params: z.object({
      workspaceId: z.string().optional(),
      workspaceKind: WorkspaceKindSchema.optional(),
      conversationKind: ConversationKindSchema.default("chat"),
      title: z.string().optional(),
      permissionMode: PermissionModeSchema.optional(),
      modelProviderId: z.string().optional(),
      model: z.string().optional(),
    }),
    result: z.object({ task: TaskSchema, session: SessionSchema }),
  },
  "task.list": { params: WorkspaceIdSchema.extend({ includeArchived: z.boolean().optional(), includeDeleted: z.boolean().optional() }), result: z.array(TaskSchema) },
  "task.listGeneral": {
    params: z.object({ includeArchived: z.boolean().optional(), includeDeleted: z.boolean().optional(), limit: z.number().int().positive().max(500).optional(), offset: z.number().int().nonnegative().optional() }).default({}),
    result: z.array(TaskSchema),
  },
  "task.search": {
    params: WorkspaceIdSchema.extend({
      query: z.string(),
      includeArchived: z.boolean().optional(),
      includeDeleted: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.array(TaskSchema),
  },
  "task.update": { params: IdSchema.extend({ title: z.string() }), result: TaskSchema },
  "task.setConversationKind": {
    params: IdSchema.extend({ conversationKind: ConversationKindSchema }),
    result: TaskSchema,
  },
  "task.setPinned": { params: IdSchema.extend({ pinned: z.boolean() }), result: TaskSchema },
  "task.setArchived": { params: IdSchema.extend({ archived: z.boolean() }), result: TaskSchema },
  "task.markRead": { params: IdSchema.extend({ unread: z.boolean().optional() }), result: TaskSchema },
  "task.delete": { params: IdSchema.extend({ deleted: z.boolean().optional() }), result: TaskSchema },
  "task.restore": { params: IdSchema, result: TaskSchema },
  "session.get": { params: z.object({ sessionId: z.string() }), result: SessionSchema },
  "session.messages": { params: z.object({ sessionId: z.string() }), result: z.array(MessageSchema) },
  "session.appendMessage": {
    params: z.object({ sessionId: z.string(), role: MessageRoleSchema.optional(), parts: z.array(z.object({ kind: z.string(), content: JsonValueSchema })) }),
    result: z.object({ id: z.string() }),
  },
  "session.setModel": { params: z.object({ sessionId: z.string(), providerId: z.string(), model: z.string() }), result: OkSchema },
  "session.target.get": { params: z.object({ sessionId: z.string() }), result: SessionTargetSchema.nullable() },
  "session.target.set": {
    params: z.object({
      sessionId: z.string(),
      goalText: z.string(),
      status: SessionTargetStatusSchema.optional(),
      tokenBudget: z.number().int().positive().nullable().optional(),
      timeBudgetMin: z.number().int().positive().nullable().optional(),
    }),
    result: SessionTargetSchema,
  },
  "session.target.clear": { params: z.object({ sessionId: z.string() }), result: OkSchema },
  "session.fork": { params: z.object({ sessionId: z.string(), entryId: z.string().optional() }), result: z.object({ sessionId: z.string() }) },
  "session.rewind": { params: z.object({ sessionId: z.string(), entryId: z.string() }), result: OkSchema },
  "session.compact": { params: z.object({ sessionId: z.string() }).passthrough(), result: CompactionResultSchema },
  "session.contextStats": {
    params: z.object({
      sessionId: z.string(),
      providerId: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      pendingInput: z.string().optional(),
      attachments: z.array(AttachmentInputSchema).optional(),
    }).passthrough(),
    result: ContextStatsSchema,
  },
  "settings.get": { params: z.object({ key: z.string() }), result: JsonValueSchema.nullable() },
  "settings.set": { params: z.object({ key: z.string(), value: JsonValueSchema.optional() }), result: OkSchema },
  "settings.list": { params: EmptyParamsSchema, result: z.array(z.object({ key: z.string(), value: JsonValueSchema, updatedAt: ISODateSchema })) },
  "extension.nativeMessaging.status": { params: EmptyParamsSchema, result: ExtensionNativeMessagingStatusSchema },
  "extension.nativeMessaging.setEnabled": {
    params: z.object({ enabled: z.boolean(), extensionIds: z.array(z.string().regex(/^[a-p]{32}$/)).optional() }),
    result: ExtensionNativeMessagingStatusSchema,
  },
  "model.provider.list": { params: EmptyParamsSchema, result: z.array(ModelProviderSchema) },
  "model.preset.list": { params: EmptyParamsSchema, result: z.array(z.any()) },
  "model.local.discover": { params: EmptyParamsSchema, result: z.array(DiscoveredLocalProviderSchema) },
  "model.local.pull": {
    params: z.object({ providerId: z.string(), model: z.string().min(1) }).passthrough(),
    result: z.object({ operationId: z.string(), started: z.boolean() }),
  },
  "model.local.download": {
    params: z.object({ providerId: z.string(), model: z.string().min(1), quantization: z.string().optional() }).passthrough(),
    result: z.object({ operationId: z.string(), started: z.boolean() }),
  },
  "model.local.load": {
    params: z.object({ providerId: z.string(), model: z.string().min(1), contextLength: z.number().int().positive().optional() }).passthrough(),
    result: z.object({ loaded: z.boolean(), instanceId: z.string() }),
  },
  "model.local.unload": {
    params: z.object({ providerId: z.string(), instanceId: z.string().min(1) }).passthrough(),
    result: z.object({ unloaded: z.boolean(), instanceId: z.string() }),
  },
  "model.local.cancel": {
    params: z.object({ operationId: z.string() }).passthrough(),
    result: z.object({ cancelled: z.boolean() }),
  },
  "model.provider.models": { params: z.object({ providerId: z.string().optional() }).passthrough(), result: z.array(RemoteModelSchema) },
  "model.provider.check": { params: z.object({ providerId: z.string().optional() }).passthrough(), result: ProviderCheckResultSchema },
  "model.provider.save": { params: z.object({ name: z.string(), baseUrl: z.string(), defaultModel: z.string() }).passthrough(), result: ModelProviderSchema },
  "model.provider.delete": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "router.contract.status": { params: EmptyParamsSchema, result: RouterContractStatusSchema },
  "router.oauth.start": {
    params: z.object({ redirectUri: z.string().url().optional() }).optional(),
    result: z.object({ authorizationUrl: z.string().url(), state: z.string() }),
  },
  "router.oauth.exchange": {
    params: z.object({ code: z.string().min(1), state: z.string().min(1), redirectUri: z.string().url().optional() }),
    result: z.object({ accessToken: z.string().min(1), tokenType: z.string(), expiresAt: ISODateSchema.nullable() }),
  },
  "router.account.get": {
    params: z.object({ providerId: z.string().optional(), credentialRef: z.string().optional(), apiKey: z.string().optional() }).passthrough(),
    result: RouterAccountSchema,
  },
  "router.image.generate": {
    params: ImageGenerationRequestSchema,
    result: ImageGenerationResponseSchema,
  },
  "file.tree": { params: WorkspaceIdSchema.extend({ path: z.string().optional() }), result: z.array(FileTreeEntrySchema) },
  "file.list": { params: WorkspaceIdSchema, result: FileListResultSchema },
  "file.read": { params: WorkspaceIdSchema.extend({ path: z.string() }), result: FileReadResultSchema },
  "file.write": { params: WorkspaceIdSchema.extend({ path: z.string(), content: z.string() }).passthrough(), result: z.object({ path: z.string(), bytes: z.number().int().nonnegative() }) },
  "search.ripgrep": { params: WorkspaceIdSchema.extend({ query: z.string() }).passthrough(), result: CommandOutputSchema },
  "git.status": { params: WorkspaceIdSchema, result: CommandOutputSchema },
  "git.diff": { params: WorkspaceIdSchema.extend({ path: z.string().optional(), baseBranch: z.string().nullable().optional() }), result: CommandOutputSchema },
  "git.branch": { params: WorkspaceIdSchema, result: CommandOutputSchema },
  "git.log": { params: WorkspaceIdSchema.extend({ limit: z.number().optional() }), result: CommandOutputSchema },
  "git.checkpoint": { params: WorkspaceIdSchema.extend({ message: z.string().optional(), taskId: z.string().optional(), sessionId: z.string().optional(), entryId: z.string().optional(), reason: z.enum(["manual", "auto-rewind", "auto-restore", "auto-merge"]).optional() }), result: CommandOutputSchema },
  "git.pr.status": { params: WorkspaceIdSchema, result: GitPrStatusSchema },
  "git.pr.draft": { params: z.object({ taskId: z.string(), base: z.string().optional(), providerId: z.string().optional(), model: z.string().optional() }).passthrough(), result: GitPrDraftSchema },
  "git.pr.create": { params: z.object({ taskId: z.string(), title: z.string().trim().min(1).max(256).optional(), body: z.string().max(100_000).optional(), base: z.string().min(1), draft: z.boolean().optional() }).passthrough(), result: GitPullRequestSchema },
  "git.pr.list": { params: WorkspaceIdSchema.extend({ state: z.enum(["open", "closed", "merged", "all"]).optional(), limit: z.number().int().positive().max(100).optional() }), result: z.array(GitPullRequestSchema) },
  "git.pr.view": { params: WorkspaceIdSchema.extend({ number: z.number().int().positive(), taskId: z.string().optional() }), result: GitPullRequestViewSchema },
  "git.pr.comment.create": { params: WorkspaceIdSchema.extend({ taskId: z.string(), number: z.number().int().positive(), anchor: ReviewCommentAnchorSchema, body: z.string().trim().min(1).max(20_000) }).passthrough(), result: ReviewCommentSchema },
  "git.pr.comment.reply": { params: WorkspaceIdSchema.extend({ taskId: z.string(), number: z.number().int().positive(), commentId: z.number().int().positive(), body: z.string().trim().min(1).max(20_000) }).passthrough(), result: ReviewCommentSchema },
  "git.info": { params: WorkspaceIdSchema, result: GitInfoSchema },
  "git.branches": { params: WorkspaceIdSchema, result: z.object({ current: z.string().nullable(), branches: z.array(GitBranchInfoSchema) }) },
  "git.switchBranch": { params: WorkspaceIdSchema.extend({ branch: z.string() }).passthrough(), result: CommandOutputSchema },
  "git.diffBase": { params: WorkspaceIdSchema.extend({ baseBranch: z.string().nullable().optional() }), result: z.object({ baseBranch: z.string().nullable(), mergeBase: z.string().nullable() }) },
  "git.changedFiles": { params: WorkspaceIdSchema, result: z.array(GitChangedFileSchema) },
  "git.stage": { params: WorkspaceIdSchema.extend({ paths: z.array(z.string()) }).passthrough(), result: CommandOutputSchema },
  "git.unstage": { params: WorkspaceIdSchema.extend({ paths: z.array(z.string()) }).passthrough(), result: CommandOutputSchema },
  "git.revertFile": { params: WorkspaceIdSchema.extend({ path: z.string() }).passthrough(), result: CommandOutputSchema },
  "git.copyPatch": { params: WorkspaceIdSchema.extend({ path: z.string().optional(), baseBranch: z.string().nullable().optional() }), result: z.object({ patch: z.string() }) },
  "review.session.create": { params: WorkspaceIdSchema.extend({ scope: ReviewScopeSchema }), result: ReviewSessionSchema },
  "review.session.list": { params: WorkspaceIdSchema, result: z.array(ReviewSessionSchema) },
  "review.session.get": { params: IdSchema, result: ReviewSessionSchema },
  "review.session.complete": { params: IdSchema, result: ReviewSessionSchema },
  "review.comment.create": {
    params: z.object({ reviewSessionId: z.string(), anchor: ReviewCommentAnchorSchema, body: z.string().trim().min(1).max(20_000) }),
    result: ReviewCommentSchema,
  },
  "review.comment.list": { params: z.object({ reviewSessionId: z.string() }), result: z.array(ReviewCommentSchema) },
  "review.comment.resolve": { params: IdSchema.extend({ resolved: z.boolean() }), result: ReviewCommentSchema },
  "review.start": { params: z.object({ reviewSessionId: z.string(), providerId: z.string().optional(), model: z.string().optional() }).passthrough(), result: z.object({ session: ReviewSessionSchema, findings: z.array(ReviewFindingSchema) }) },
  "review.finding.list": { params: z.object({ reviewSessionId: z.string() }), result: z.array(ReviewFindingSchema) },
  "review.finding.convert": { params: IdSchema, result: ReviewCommentSchema },
  "review.finding.apply": { params: IdSchema.passthrough(), result: z.object({ applied: z.boolean(), files: z.array(z.string()) }) },
  "timeline.list": { params: z.object({ taskId: z.string() }), result: z.array(TimelineItemSchema) },
  "timeline.restore": { params: z.object({ taskId: z.string(), mode: z.enum(["files", "conversation", "both"]), checkpointId: z.string().optional(), entryId: z.string().optional() }).passthrough(), result: z.object({ ok: z.boolean(), autoCheckpointId: z.string().nullable() }) },
  "worktree.create": { params: z.object({ taskId: z.string(), baseRef: z.string().optional(), path: z.string().optional(), branch: z.string().optional() }).passthrough(), result: WorktreeSchema },
  "worktree.list": { params: WorkspaceIdSchema, result: z.array(WorktreeSchema) },
  "worktree.status": { params: z.object({ taskId: z.string() }), result: WorktreeSchema },
  "worktree.remove": { params: z.object({ taskId: z.string(), force: z.boolean().optional() }).passthrough(), result: z.object({ ok: z.boolean(), path: z.string() }) },
  "worktree.applyBack.preview": { params: z.object({ taskId: z.string() }), result: WorktreeApplyBackPreviewSchema },
  "worktree.applyBack": { params: z.object({ taskId: z.string() }).passthrough(), result: WorktreeApplyBackResultSchema },
  "worktree.prepareBranch": { params: z.object({ taskId: z.string(), message: z.string().trim().min(1).max(500).optional() }), result: WorktreeSchema },
  "worktree.orphans": { params: EmptyParamsSchema, result: z.array(WorktreeOrphanSchema) },
  "system.openPath": { params: z.object({ workspaceId: z.string().optional(), taskId: z.string().optional(), path: z.string() }), result: CommandOutputSchema.or(OkSchema) },
  "terminal.create": { params: WorkspaceIdSchema.passthrough(), result: TerminalSessionSchema },
  "terminal.write": { params: z.object({ id: z.string(), data: z.string() }), result: OkSchema },
  "terminal.resize": { params: z.object({ id: z.string(), cols: z.number(), rows: z.number() }), result: OkSchema },
  "terminal.close": { params: IdSchema, result: OkSchema },
  "terminal.events": { params: IdSchema.extend({ limit: z.number().optional() }), result: z.array(JsonValueSchema) },
  "terminal.list": { params: z.object({ workspaceId: z.string().optional(), taskId: z.string().optional() }), result: z.array(TerminalSessionSchema) },
  "sandbox.status": { params: WorkspaceIdSchema.extend({ permissionMode: PermissionModeSchema }), result: SandboxStatusSchema },
  "approval.list": { params: EmptyParamsSchema, result: z.array(ApprovalRequestSchema) },
  "approval.decide": { params: IdSchema.passthrough(), result: OkSchema },
  "question.list": { params: EmptyParamsSchema, result: z.array(QuestionRequestSchema) },
  "question.answer": {
    params: IdSchema.extend({ answer: z.string(), selectedOptions: z.array(z.string()).optional() }).passthrough(),
    result: OkSchema,
  },
  "permission.mode.get": { params: EmptyParamsSchema, result: PermissionModeSchema },
  "permission.mode.set": { params: z.object({ mode: PermissionModeSchema }), result: OkSchema },
  "permission.grant.list": { params: z.object({ workspaceId: z.string().optional() }).optional(), result: z.array(PermissionGrantSchema) },
  "permission.grant.revoke": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "policy.rule.list": { params: z.object({ workspaceId: z.string().optional() }).optional(), result: z.array(ExecPolicyStoredRuleSchema) },
  "policy.rule.create": {
    params: z.object({
      workspaceId: z.string().optional(),
      layer: z.enum(["user", "workspace"]),
      kind: z.enum(["prefix_rule", "exact", "regex-lite", "network"]),
      decision: z.enum(["allow", "prompt", "forbid"]),
      pattern: z.union([z.string(), z.array(z.string())]),
      description: z.string().optional(),
    }),
    result: ExecPolicyStoredRuleSchema,
  },
  "policy.rule.update": {
    params: z.object({
      id: z.string(),
      kind: z.enum(["prefix_rule", "exact", "regex-lite", "network"]),
      decision: z.enum(["allow", "prompt", "forbid"]),
      pattern: z.union([z.string(), z.array(z.string())]),
      description: z.string().nullable().optional(),
    }),
    result: ExecPolicyStoredRuleSchema,
  },
  "policy.rule.delete": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "policy.get": { params: EmptyParamsSchema, result: ManagedPolicyStatusSchema },
  "policy.sync": {
    params: z.object({
      url: z.string().url().optional(),
      tenantId: z.string().optional(),
      accessToken: z.string().optional(),
      publicKeys: z.record(z.string()).optional(),
    }).optional(),
    result: ManagedPolicySyncResultSchema,
  },
  "platform.login.start": {
    params: z.object({ baseUrl: z.string().url().optional(), redirectUri: z.string().url().optional() }).optional(),
    result: PlatformLoginStartResultSchema,
  },
  "platform.login.exchange": {
    params: z.object({
      code: z.string().min(1),
      state: z.string().min(1),
      baseUrl: z.string().url().optional(),
      redirectUri: z.string().url().optional(),
      publicKeys: z.record(z.string()).optional(),
    }),
    result: PlatformLoginExchangeResultSchema,
  },
  "platform.session.get": { params: EmptyParamsSchema, result: PlatformOrgSessionSchema },
  "platform.logout": { params: EmptyParamsSchema, result: OkSchema },
  "platform.usage.flush": { params: z.object({ limit: z.number().int().positive().max(1000).optional() }).optional(), result: PlatformUsageFlushResultSchema },
  "audit.list": {
    params: z.object({
      limit: z.number().int().positive().max(5000).optional(),
      sessionId: z.string().optional(),
      taskId: z.string().optional(),
      category: z.string().optional(),
    }).optional(),
    result: z.array(AuditEventSchema),
  },
  "audit.export": {
    params: z.object({
      format: z.enum(["json", "csv"]),
      path: z.string().optional(),
      sessionId: z.string().optional(),
      taskId: z.string().optional(),
      category: z.string().optional(),
    }),
    result: z.object({ path: z.string(), count: z.number().int().nonnegative(), format: z.enum(["json", "csv"]), chainValid: z.boolean() }),
  },
  "agent.turnState": { params: z.object({ sessionId: z.string() }), result: TurnStateSchema },
  "agent.turn": {
    params: z.object({
      taskId: z.string(),
      input: z.string().optional(),
      continueInterruptedTurn: z.boolean().optional(),
      owner: z.string().optional(),
      mcpServers: z.array(RuntimeMcpServerSchema).optional(),
    }).passthrough(),
    result: z.object({ turnId: z.string(), sessionId: z.string() }),
  },
  "agent.takeover": { params: z.object({ sessionId: z.string(), owner: z.string() }), result: z.object({ ok: z.boolean(), previousOwner: z.string().nullable() }) },
  "agent.steer": { params: z.object({ sessionId: z.string(), input: z.string(), owner: z.string().optional() }).passthrough(), result: JsonValueSchema },
  "agent.followUp": { params: z.object({ sessionId: z.string(), input: z.string(), owner: z.string().optional() }).passthrough(), result: JsonValueSchema },
  "agent.cancel": { params: z.object({ sessionId: z.string(), owner: z.string().optional() }), result: z.object({ cancelled: z.boolean() }) },
  "agent.list": { params: z.object({ workspaceId: z.string().optional() }).optional(), result: AgentListResultSchema },
  "agent.create": { params: z.object({ name: z.string() }).passthrough(), result: SubagentManifestSchema },
  "agent.delete": { params: z.object({ name: z.string() }), result: OkSchema },
  "agent.enable": { params: IdSchema.extend({ enabled: z.boolean() }), result: OkSchema },
  "agent.getUserDirectory": { params: EmptyParamsSchema, result: z.object({ path: z.string() }) },
  "command.list": { params: z.object({ workspaceId: z.string().optional() }).optional(), result: z.array(CommandManifestSchema) },
  "command.save": { params: z.object({ name: z.string(), command: z.string() }).passthrough(), result: CommandManifestSchema },
  "command.run": { params: IdSchema.extend({ workspaceId: z.string() }).passthrough(), result: CommandOutputSchema },
  "command.delete": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "mcp.server.list": { params: EmptyParamsSchema, result: z.array(McpServerConfigSchema) },
  "mcp.server.save": { params: z.object({ name: z.string(), transport: McpTransportSchema }).passthrough(), result: McpServerConfigSchema },
  "mcp.server.enable": { params: IdSchema.extend({ enabled: z.boolean() }), result: OkSchema },
  "mcp.server.trust": { params: IdSchema.extend({ trusted: z.boolean() }), result: OkSchema },
  "mcp.server.health": { params: IdSchema.extend({ credentialRef: z.string().optional() }).passthrough(), result: McpServerConfigSchema },
  "mcp.server.reconnect": { params: IdSchema.extend({ credentialRef: z.string().optional() }).passthrough(), result: McpServerConfigSchema },
  "mcp.import.scan": { params: z.object({ paths: z.array(z.string()).optional() }).optional(), result: z.array(McpImportCandidateSchema) },
  "mcp.import.apply": { params: z.object({ servers: z.array(McpImportCandidateSchema) }), result: z.array(McpServerConfigSchema) },
  "mcp.oauth.start": { params: IdSchema.extend({ redirectUri: z.string().url().optional() }), result: z.object({ flow: z.enum(["authorization-code", "device"]), state: z.string(), authorizationUrl: z.string().url().nullable(), verificationUri: z.string().url().nullable(), userCode: z.string().nullable(), intervalSeconds: z.number().int().positive().nullable() }) },
  "mcp.oauth.exchange": { params: IdSchema.extend({ state: z.string(), code: z.string() }), result: z.object({ credentialRef: z.string(), secret: z.string() }) },
  "mcp.oauth.poll": { params: IdSchema.extend({ state: z.string() }), result: z.object({ status: z.enum(["pending", "complete"]), credentialRef: z.string().nullable(), secret: z.string().nullable() }) },
  "skill.list": { params: z.object({ workspaceId: z.string().optional() }).optional(), result: z.array(SkillManifestSchema) },
  "skill.inspect": { params: z.object({ path: z.string(), workspaceId: z.string().optional(), limits: SkillPackageLimitsSchema.optional() }), result: SkillImportPreviewSchema },
  "skill.save": { params: z.object({ name: z.string(), sourcePath: z.string() }).passthrough(), result: SkillManifestSchema },
  "skill.create": { params: z.object({ name: z.string(), description: z.string().optional(), version: z.string().optional(), workspaceId: z.string().optional(), scope: z.enum(["project", "global"]).optional() }).passthrough(), result: SkillManifestSchema },
  "skill.import": { params: z.object({
    path: z.string(),
    workspaceId: z.string().optional(),
    scope: z.enum(["project", "global"]).optional(),
    conflictAction: z.enum(["replace", "keep", "cancel"]).optional(),
    expectedFingerprint: z.string().optional(),
    trusted: z.boolean().optional(),
    enabled: z.boolean().optional(),
    limits: SkillPackageLimitsSchema.optional(),
  }).passthrough(), result: z.array(SkillManifestSchema) },
  "skill.enable": { params: IdSchema.extend({ enabled: z.boolean() }).passthrough(), result: OkSchema },
  "skill.trust": { params: IdSchema.extend({ trusted: z.boolean() }), result: OkSchema },
  "skill.openFolder": { params: IdSchema.passthrough(), result: CommandOutputSchema.or(OkSchema) },
  "skill.openFile": { params: IdSchema.passthrough(), result: CommandOutputSchema.or(OkSchema) },
  "skill.getUserDirectory": { params: EmptyParamsSchema, result: z.object({ path: z.string() }) },
  "skill.delete": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "plugin.list": { params: z.object({ workspaceId: z.string().optional() }).optional(), result: z.array(PluginInstallSchema) },
  "plugin.installManifest": { params: z.object({ manifest: JsonValueSchema }).passthrough(), result: PluginInstallSchema },
  "plugin.installPath": { params: z.object({ path: z.string() }).passthrough(), result: PluginInstallSchema },
  "plugin.installGit": { params: z.object({ url: z.string() }).passthrough(), result: PluginInstallSchema },
  "plugin.checkUpdate": { params: IdSchema, result: PluginInstallSchema },
  "plugin.applyUpdate": { params: IdSchema.extend({ confirmHash: z.string() }), result: PluginInstallSchema },
  "plugin.enable": { params: IdSchema.extend({ enabled: z.boolean() }), result: OkSchema },
  "plugin.trust": { params: IdSchema.extend({ trusted: z.boolean() }), result: OkSchema },
  "plugin.delete": { params: IdSchema, result: z.object({ removed: z.boolean() }) },
  "browser.session.create": { params: WorkspaceIdSchema.passthrough(), result: BrowserSessionSchema.passthrough() },
  "browser.session.list": { params: WorkspaceIdSchema.optional(), result: z.array(BrowserSessionSchema) },
  "browser.navigate": { params: IdSchema.extend({ url: z.string() }).passthrough(), result: CommandOutputSchema },
  "browser.back": { params: IdSchema.passthrough(), result: CommandOutputSchema },
  "browser.forward": { params: IdSchema.passthrough(), result: CommandOutputSchema },
  "browser.reload": { params: IdSchema.passthrough(), result: CommandOutputSchema },
  "browser.snapshot": { params: IdSchema.passthrough(), result: CommandOutputSchema },
  "browser.screenshot": {
    params: IdSchema.passthrough(),
    result: CommandOutputSchema.extend({
      path: z.string(),
      name: z.string().optional(),
      mediaType: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
      dataUrl: z.string().optional(),
    }),
  },
  "browser.click": { params: IdSchema.extend({ selector: z.string() }).passthrough(), result: CommandOutputSchema },
  "browser.type": { params: IdSchema.extend({ selector: z.string(), text: z.string() }).passthrough(), result: CommandOutputSchema },
  "browser.fill": { params: IdSchema.extend({ selector: z.string(), text: z.string() }).passthrough(), result: CommandOutputSchema },
  "browser.press": { params: IdSchema.extend({ key: z.string() }).passthrough(), result: CommandOutputSchema },
  "browser.close": { params: IdSchema.passthrough(), result: CommandOutputSchema },
  "usage.list": { params: EmptyParamsSchema, result: z.array(JsonValueSchema) },
  "usage.summary": { params: EmptyParamsSchema, result: UsageSummarySchema },
  "usage.events": { params: z.object({ limit: z.number().int().positive().optional() }).optional(), result: z.array(UsageEventSchema) },
  "logs.list": { params: z.object({ limit: z.number().optional() }).optional(), result: z.array(LogsRowSchema) },
  "logs.export": { params: z.object({ path: z.string().optional() }).optional(), result: z.object({ path: z.string() }) },
  "support.issueReport.create": {
    params: z.object({
      path: z.string().optional(),
      includeIssueBody: z.boolean().default(true).optional(),
      issueTitle: z.string().max(200).optional(),
    }).optional(),
    result: SupportIssueReportResultSchema,
  },
  "support.crashReport.record": {
    params: z.object({
      name: z.string().max(200).optional(),
      message: z.string().max(4000),
      stack: z.string().max(12000).optional(),
      componentStack: z.string().max(12000).optional(),
      route: z.string().max(1000).optional(),
      fatal: z.boolean().default(false).optional(),
      metadata: JsonValueSchema.optional(),
    }),
    result: SupportCrashReportResultSchema,
  },
  "credential.status": { params: z.object({ reference: z.string().optional() }).optional(), result: CredentialStatusSchema },
  "credential.set": { params: z.object({ reference: z.string(), secret: z.string() }), result: OkSchema },
  "credential.delete": { params: z.object({ reference: z.string() }), result: OkSchema },
  "updater.status": { params: EmptyParamsSchema, result: UpdaterStatusSchema },
  "updater.install": { params: EmptyParamsSchema, result: UpdaterInstallResultSchema },
} as const;

export type HostMethod = keyof typeof HostMethodCatalog;
export type HostMethodParams<TMethod extends HostMethod> = z.input<(typeof HostMethodCatalog)[TMethod]["params"]>;
export type HostMethodResult<TMethod extends HostMethod> = z.output<(typeof HostMethodCatalog)[TMethod]["result"]>;

export function isHostMethod(method: string): method is HostMethod {
  return Object.prototype.hasOwnProperty.call(HostMethodCatalog, method);
}

export function validateHostParams(method: string, params: unknown): unknown {
  if (!isHostMethod(method)) return params;
  return HostMethodCatalog[method].params.parse(params === null ? undefined : params);
}

export function validateHostResult(method: string, result: unknown): unknown {
  if (!isHostMethod(method)) return result;
  return HostMethodCatalog[method].result.parse(result === undefined ? {} : result);
}

// Settings and administration contracts. These schemas are shared by the
// API, typed client, route search parameters, forms, and demo adapters.
export const CursorPageSchema = z.object({
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export const AdminNavigationCapabilitiesSchema = z.object({
  tenantId: z.string(),
  permissions: z.array(OrgPermissionSchema),
  readableRoutes: z.array(z.string()),
  writableRoutes: z.array(z.string()),
  platformAuthorized: z.boolean().default(false),
});
export type AdminNavigationCapabilities = z.infer<typeof AdminNavigationCapabilitiesSchema>;

const AdminMetricSchema = z.object({ value: z.string(), changePercent: z.number().nullable().default(null) });
const AdminHealthSchema = z.object({ key: z.string(), label: z.string(), status: z.enum(["healthy", "warning", "error", "unavailable"]), detail: z.string() });
export const OrganizationOverviewSchema = z.object({
  tenantId: z.string(),
  activeMembers: z.number().int().nonnegative(),
  billedSpendMicros: z.string(),
  budgetUsedPercent: z.number().nonnegative().nullable(),
  successfulRequestRate: z.number().min(0).max(1).nullable(),
  projectedMonthEndMicros: z.string().nullable(),
  metrics: z.record(AdminMetricSchema).default({}),
  health: z.array(AdminHealthSchema).default([]),
  attention: z.array(z.object({ id: z.string(), label: z.string(), href: z.string(), severity: z.enum(["info", "warning", "error"]) })).default([]),
  topDepartments: z.array(z.object({ departmentId: z.string(), name: z.string(), billedCostMicros: z.string(), requests: z.number().int().nonnegative() })).default([]),
  recentActivity: z.array(z.object({ id: z.string(), actorName: z.string(), action: z.string(), target: z.string(), ts: ISODateSchema })).default([]),
});
export type OrganizationOverview = z.infer<typeof OrganizationOverviewSchema>;

export const MemberListQuerySchema = z.object({
  search: z.string().trim().max(200).default(""), status: z.string().optional(), role: z.string().optional(),
  departmentId: z.string().optional(), source: z.enum(["manual", "sso", "scim"]).optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const MemberPageSchema = CursorPageSchema.extend({ items: z.array(OrgMembershipSchema), total: z.number().int().nonnegative().optional() });
export type MemberListQuery = z.infer<typeof MemberListQuerySchema>;
export type MemberPage = z.infer<typeof MemberPageSchema>;

export const DepartmentListQuerySchema = z.object({
  search: z.string().trim().max(200).default(""), status: z.string().optional(), parentId: z.string().nullable().optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const DepartmentPageSchema = CursorPageSchema.extend({ items: z.array(DepartmentSchema), total: z.number().int().nonnegative().optional() });

export const UsageAnalyticsQueryFieldsSchema = z.object({
  from: ISODateSchema, to: ISODateSchema, compareFrom: ISODateSchema.optional(), compareTo: ISODateSchema.optional(),
  departmentId: z.string().optional(), memberId: z.string().optional(), model: z.string().optional(), provider: z.string().optional(),
  feature: z.string().optional(), status: z.string().optional(), workspaceId: z.string().optional(), agentId: z.string().optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const UsageAnalyticsQuerySchema = UsageAnalyticsQueryFieldsSchema.refine((value) => new Date(value.from) <= new Date(value.to), { message: "from must be before to", path: ["from"] });
export type UsageAnalyticsQuery = z.infer<typeof UsageAnalyticsQuerySchema>;
export const AdminAnalyticsSearchSchema = UsageAnalyticsQueryFieldsSchema.partial().extend({
  view: z.enum(["overview", "people", "models", "agents", "requests", "reports"]).optional(),
});
export type AdminAnalyticsSearch = z.infer<typeof AdminAnalyticsSearchSchema>;
export const ArchivedChatsSearchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(["all", "chat", "code"]).default("all"),
  workspace: z.string().trim().max(200).default("all"),
  state: z.enum(["archived", "deleted", "all"]).default("archived"),
});
export type ArchivedChatsSearch = z.infer<typeof ArchivedChatsSearchSchema>;

export const UsageSeriesPointSchema = z.object({
  ts: ISODateSchema, billedCostMicros: z.string(), requests: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(), failures: z.number().int().nonnegative(),
});
export const UsageBreakdownRowSchema = z.object({
  dimension: z.string(), id: z.string().nullable(), label: z.string(), billedCostMicros: z.string(), requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(), errorRate: z.number().min(0).max(1).nullable(), latencyP50Ms: z.number().nonnegative().nullable(), latencyP95Ms: z.number().nonnegative().nullable(),
});
export const UsagePerformanceSummarySchema = z.object({
  latencyP50Ms: z.number().nonnegative().nullable(), latencyP95Ms: z.number().nonnegative().nullable(), ttftP50Ms: z.number().nonnegative().nullable(),
  ttftP95Ms: z.number().nonnegative().nullable(), cachedTokens: z.number().int().nonnegative(), sandboxMinutes: z.number().nonnegative(),
});
export const UsageAnomalySchema = z.object({
  id: z.string(), kind: z.enum(["spend", "requests", "failures", "latency", "budget_projection"]), severity: z.enum(["info", "warning", "error"]),
  label: z.string(), baseline: z.number(), observed: z.number(), unit: z.string(), windowStart: ISODateSchema, windowEnd: ISODateSchema,
  dimension: z.object({ kind: z.string(), id: z.string().nullable(), label: z.string() }), explanation: z.string(),
});
export const UsageAnalyticsSchema = z.object({
  tenantId: z.string(), from: ISODateSchema, to: ISODateSchema,
  totals: z.object({ billedCostMicros: z.string(), requests: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), successRate: z.number().min(0).max(1).nullable(), projectedMonthEndMicros: z.string().nullable() }),
  series: z.array(UsageSeriesPointSchema), breakdowns: z.record(z.array(UsageBreakdownRowSchema)), performance: UsagePerformanceSummarySchema,
  anomalies: z.array(UsageAnomalySchema), unavailableDimensions: z.array(z.string()).default([]),
});
export type UsageAnalytics = z.infer<typeof UsageAnalyticsSchema>;

export const UsageRequestSummarySchema = z.object({
  id: z.string(), requestId: z.string(), ts: ISODateSchema, userId: z.string().nullable(), departmentId: z.string().nullable(), workspaceId: z.string().nullable(),
  agentId: z.string().nullable(), feature: z.string(), provider: z.string().nullable(), model: z.string().nullable(), status: z.string(),
  tokensIn: z.number().int().nonnegative(), tokensOut: z.number().int().nonnegative(), tokensCached: z.number().int().nonnegative(),
  billedCostMicros: z.string(), latencyMs: z.number().int().nonnegative().nullable(), ttftMs: z.number().int().nonnegative().nullable(),
  reservationStatus: BudgetReservationStatusSchema.nullable(),
});
export const UsageRequestDetailSchema = UsageRequestSummarySchema.extend({
  taskId: z.string().nullable(), sessionId: z.string().nullable(), sandboxId: z.string().nullable(), reservationId: z.string().nullable(),
  safeMetadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export const UsageRequestPageSchema = CursorPageSchema.extend({ items: z.array(UsageRequestSummarySchema) });
export type UsageRequestSummary = z.infer<typeof UsageRequestSummarySchema>;
export type UsageRequestDetail = z.infer<typeof UsageRequestDetailSchema>;
export type UsageRequestPage = z.infer<typeof UsageRequestPageSchema>;

export const SavedAnalyticsViewSchema = z.object({
  id: z.string(), tenantId: z.string(), name: z.string(), ownerUserId: z.string(), filters: UsageAnalyticsQueryFieldsSchema.partial(),
  visibility: z.enum(["private", "tenant"]), createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export const SavedAnalyticsViewCreateSchema = SavedAnalyticsViewSchema.pick({ name: true, filters: true, visibility: true }).strict();
export type SavedAnalyticsView = z.infer<typeof SavedAnalyticsViewSchema>;
export type SavedAnalyticsViewCreate = z.infer<typeof SavedAnalyticsViewCreateSchema>;

export const ReportScheduleSchema = z.object({
  id: z.string(), tenantId: z.string(), name: z.string(), savedViewId: z.string(), format: z.enum(["csv", "html"]), cadence: z.enum(["daily", "weekly", "monthly"]),
  timezone: z.string(), recipients: z.array(z.string().email()), status: z.enum(["active", "paused", "disabled"]), nextRunAt: ISODateSchema.nullable(), lastRunAt: ISODateSchema.nullable(),
  createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export const ReportScheduleCreateSchema = ReportScheduleSchema.pick({ name: true, savedViewId: true, format: true, cadence: true, timezone: true, recipients: true }).strict();
export type ReportSchedule = z.infer<typeof ReportScheduleSchema>;
export type ReportScheduleCreate = z.infer<typeof ReportScheduleCreateSchema>;
export const ReportRunSchema = z.object({
  id: z.string(), tenantId: z.string(), scheduleId: z.string(), windowKey: z.string(), status: z.enum(["queued", "running", "delivered", "failed"]),
  artifactRef: z.string().nullable(), error: z.string().nullable(), startedAt: ISODateSchema.nullable(), completedAt: ISODateSchema.nullable(), createdAt: ISODateSchema,
});
export type ReportRun = z.infer<typeof ReportRunSchema>;

export const AlertDestinationSchema = z.object({
  id: z.string(), tenantId: z.string(), kind: z.enum(["email", "webhook"]), label: z.string(), configured: z.boolean(),
  emailRecipients: z.array(z.string().email()).default([]), createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export type AlertDestination = z.infer<typeof AlertDestinationSchema>;
export const AlertRuleSchema = z.object({
  id: z.string(), tenantId: z.string(), name: z.string(), signal: z.enum(["spend_threshold", "quota_threshold", "projected_overrun", "credits", "unusual_spend", "request_volume", "error_rate", "latency", "blocked_requests", "system_health"]),
  enabled: z.boolean(), scopeType: BudgetScopeTypeSchema.optional(), scopeId: z.string().optional(), threshold: z.number().nonnegative(), windowMinutes: z.number().int().positive(),
  destinationIds: z.array(z.string()), createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export const AlertRuleCreateSchema = AlertRuleSchema.omit({ id: true, tenantId: true, createdAt: true, updatedAt: true }).strict();
export type AlertRule = z.infer<typeof AlertRuleSchema>;
export type AlertRuleCreate = z.infer<typeof AlertRuleCreateSchema>;
export const AlertEventSchema = z.object({ id: z.string(), tenantId: z.string(), ruleId: z.string(), windowKey: z.string(), observed: z.number(), baseline: z.number().nullable(), status: z.enum(["open", "resolved"]), createdAt: ISODateSchema });
export const DeliveryAttemptSchema = z.object({ id: z.string(), tenantId: z.string(), alertEventId: z.string().nullable(), reportRunId: z.string().nullable(), destinationId: z.string(), attempt: z.number().int().positive(), status: z.enum(["pending", "delivered", "failed"]), providerMessageId: z.string().nullable(), error: z.string().nullable(), createdAt: ISODateSchema });
export type AlertEvent = z.infer<typeof AlertEventSchema>;
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

export const QuotaMetricSchema = z.enum(["cost", "requests", "tokens", "sandbox_minutes"]);
export type QuotaMetric = z.infer<typeof QuotaMetricSchema>;
export const AllowanceProfileSchema = z.object({
  id: z.string(), tenantId: z.string(), name: z.string(), description: z.string().default(""), period: z.enum(["day", "month"]),
  softLimitMicros: z.string().nullable(), hardLimitMicros: z.string().nullable(), requestLimit: z.number().int().nonnegative().nullable(), tokenLimit: z.number().int().nonnegative().nullable(),
  sandboxMinuteLimit: z.number().nonnegative().nullable(), thresholdPercentages: z.array(z.number().int().min(1).max(100)).default([80, 100]), status: z.enum(["active", "archived"]),
  createdAt: ISODateSchema, updatedAt: ISODateSchema,
});
export type AllowanceProfile = z.infer<typeof AllowanceProfileSchema>;
export const AllowanceProfileUpsertSchema = AllowanceProfileSchema.omit({ id: true, tenantId: true, createdAt: true, updatedAt: true }).partial({ status: true }).strict();
export type AllowanceProfileUpsert = z.infer<typeof AllowanceProfileUpsertSchema>;
export const AllowanceDefaultAssignmentSchema = z.object({ id: z.string(), tenantId: z.string(), profileId: z.string().nullable(), role: z.string().nullable(), departmentId: z.string().nullable(), priority: z.number().int(), createdAt: ISODateSchema, updatedAt: ISODateSchema });
export type AllowanceDefaultAssignment = z.infer<typeof AllowanceDefaultAssignmentSchema>;
export const AllowanceDefaultUpsertSchema = AllowanceDefaultAssignmentSchema.omit({ id: true, tenantId: true, createdAt: true, updatedAt: true }).strict();
export type AllowanceDefaultUpsert = z.infer<typeof AllowanceDefaultUpsertSchema>;
export const BulkLimitItemSchema = z.object({ scopeType: BudgetScopeTypeSchema, scopeId: z.string(), period: z.enum(["day", "month"]), profileId: z.string().nullable().optional(), softLimitMicros: z.string().regex(/^\d+$/).nullable().optional(), hardLimitMicros: z.string().regex(/^\d+$/).nullable().optional(), requestLimit: z.number().int().nonnegative().nullable().optional(), tokenLimit: z.number().int().nonnegative().nullable().optional(), sandboxMinuteLimit: z.number().nonnegative().nullable().optional() });
export const BulkLimitMutationSchema = z.object({ idempotencyKey: z.string().min(8), reason: z.string().min(3).max(500), dryRun: z.boolean().default(false), items: z.array(BulkLimitItemSchema).min(1).max(1000) }).strict();
export type BulkLimitMutation = z.infer<typeof BulkLimitMutationSchema>;
export const BulkLimitResultSchema = z.object({ idempotencyKey: z.string(), dryRun: z.boolean(), results: z.array(z.object({ scopeType: BudgetScopeTypeSchema, scopeId: z.string(), status: z.enum(["valid", "applied", "error"]), message: z.string().nullable() })) });
export type BulkLimitResult = z.infer<typeof BulkLimitResultSchema>;
export const LimitTraceEntrySchema = z.object({ limitId: z.string(), scopeType: BudgetScopeTypeSchema, scopeId: z.string(), metric: QuotaMetricSchema, value: z.string(), active: z.boolean(), winning: z.boolean(), reason: z.string() });
export const EffectiveLimitSchema = z.object({ tenantId: z.string(), userId: z.string(), metric: QuotaMetricSchema, period: z.enum(["day", "month"]), effectiveValue: z.string().nullable(), used: z.string(), reserved: z.string(), available: z.string().nullable(), projected: z.string().nullable(), status: z.enum(["healthy", "warning", "blocked", "unlimited"]), trace: z.array(LimitTraceEntrySchema) });
export type EffectiveLimit = z.infer<typeof EffectiveLimitSchema>;
export const BlockedRequestSummarySchema = z.object({ id: z.string(), requestId: z.string(), userId: z.string().nullable(), departmentId: z.string().nullable(), feature: z.string(), reason: z.string(), limitId: z.string().nullable(), estimatedCostMicros: z.string(), ts: ISODateSchema });
export const BlockedRequestPageSchema = CursorPageSchema.extend({ items: z.array(BlockedRequestSummarySchema) });
export type BlockedRequestPage = z.infer<typeof BlockedRequestPageSchema>;

export const OrganizationBillingHealthSchema = z.object({ status: z.enum(["healthy", "degraded", "blocked", "not_configured"]), provider: BillingProviderKindSchema, reservationHealthy: z.boolean(), ingestHealthy: z.boolean(), explanation: z.string(), recoveryStatus: z.string().nullable() });
export const AutoRefillConfigurationSchema = z.object({ supported: z.boolean(), enabled: z.boolean(), triggerBalanceMicros: z.string().nullable(), purchaseAmountMicros: z.string().nullable(), currency: z.string().default("usd") });
export type AutoRefillConfiguration = z.infer<typeof AutoRefillConfigurationSchema>;
export const CreditLedgerRecordSchema = z.object({ id: z.string(), tenantId: z.string(), kind: z.enum(["purchase", "reservation", "reconciliation", "release", "refund", "expiration", "grant", "adjustment"]), amountMicros: z.string(), balanceAfterMicros: z.string(), source: z.string(), externalRef: z.string().nullable(), actorUserId: z.string().nullable(), status: z.string(), createdAt: ISODateSchema });
export const CreditLedgerPageSchema = CursorPageSchema.extend({ items: z.array(CreditLedgerRecordSchema) });
export const FinancialMutationSchema = z.object({ amountMicros: z.string().regex(/^\d+$/), source: z.string().min(1), externalRef: z.string().nullable().optional(), reason: z.string().min(3).max(500), confirmation: z.literal(true), idempotencyKey: z.string().min(8) }).strict();

export const ExecutionNetworkPolicySchema = z.object({ tenantId: z.string(), sandboxEnabled: z.boolean(), codeExecutionEnabled: z.boolean(), approvalRequired: z.boolean(), outboundNetwork: z.enum(["blocked", "allowlist", "unrestricted"]), allowedDomains: z.array(z.string()), blockedDomains: z.array(z.string()), allowedToolClasses: z.array(z.string()), maxRunSeconds: z.number().int().positive(), maxConcurrency: z.number().int().positive(), requestsPerMinute: z.number().int().positive(), tokenQuota: z.number().int().nonnegative().nullable(), sandboxMinuteQuota: z.number().nonnegative().nullable(), updatedAt: ISODateSchema });
export type ExecutionNetworkPolicy = z.infer<typeof ExecutionNetworkPolicySchema>;
export const AuthenticationPolicySchema = z.object({ tenantId: z.string(), mfaRequired: z.boolean(), sessionMaxAgeMinutes: z.number().int().positive(), idleTimeoutMinutes: z.number().int().positive(), trustedDevicesAllowed: z.boolean(), allowedLoginMethods: z.array(z.enum(["password", "magic_link", "oidc", "saml"])), allowedDomains: z.array(z.string()), emergencyLocalOwnerEnabled: z.boolean(), updatedAt: ISODateSchema });
export type AuthenticationPolicy = z.infer<typeof AuthenticationPolicySchema>;
export const DataGovernancePolicySchema = z.object({ tenantId: z.string(), conversationRetentionDays: z.number().int().nonnegative(), temporaryChatHours: z.number().int().nonnegative(), retentionByDataType: z.record(z.number().int().nonnegative()), residency: z.string(), piiFilterMode: z.enum(["off", "warn", "block"]), credentialFilterMode: z.enum(["off", "warn", "block"]), moderationHookConfigured: z.boolean(), legalHoldEnabled: z.boolean(), updatedAt: ISODateSchema });
export type DataGovernancePolicy = z.infer<typeof DataGovernancePolicySchema>;
export const OrganizationDomainSchema = z.object({ id: z.string(), domain: z.string(), status: z.enum(["pending", "verified", "failed"]), customDomain: z.boolean(), verifiedAt: ISODateSchema.nullable() });
export const OrganizationProfileSchema = z.object({ tenantId: z.string(), name: z.string(), slug: z.string(), logoUrl: z.string().nullable(), timezone: z.string(), language: z.string(), supportEmail: z.string().email().nullable(), securityEmail: z.string().email().nullable(), deploymentMode: z.string(), region: z.string().nullable(), announcements: z.array(z.object({ id: z.string(), message: z.string(), active: z.boolean() })), termsUrl: z.string().url().nullable(), privacyUrl: z.string().url().nullable(), branding: z.record(JsonValueSchema), domains: z.array(OrganizationDomainSchema), updatedAt: ISODateSchema });
export type OrganizationProfile = z.infer<typeof OrganizationProfileSchema>;

export const ServiceAccountSchema = z.object({ id: z.string(), tenantId: z.string(), name: z.string(), status: z.enum(["active", "revoked", "expired"]), permissions: z.array(OrgPermissionSchema), departmentId: z.string().nullable(), resourceRestrictions: z.array(z.object({ type: z.string(), id: z.string() })), expiresAt: ISODateSchema.nullable(), lastUsedAt: ISODateSchema.nullable(), tokenLast4: z.string(), createdAt: ISODateSchema, updatedAt: ISODateSchema });
export const ServiceAccountCreateSchema = z.object({ name: z.string().min(1).max(120), permissions: z.array(OrgPermissionSchema), departmentId: z.string().nullable().optional(), resourceRestrictions: z.array(z.object({ type: z.string(), id: z.string() })).default([]), expiresAt: ISODateSchema.nullable().optional() }).strict();
export const ServiceAccountTokenResponseSchema = z.object({ account: ServiceAccountSchema, token: z.string().min(20) });
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;
export type ServiceAccountCreate = z.infer<typeof ServiceAccountCreateSchema>;
export type ServiceAccountTokenResponse = z.infer<typeof ServiceAccountTokenResponseSchema>;

export const PlatformOverviewSchema = z.object({ tenants: z.number().int().nonnegative(), activeTenants: z.number().int().nonnegative(), billedSpendMicros: z.string(), rawCostMicros: z.string(), marginMicros: z.string(), successfulRequestRate: z.number().min(0).max(1).nullable(), routerLagSeconds: z.number().nonnegative().nullable(), incidents: z.array(AdminHealthSchema), recentOperatorActivity: z.array(JsonValueSchema) });
export type PlatformOverview = z.infer<typeof PlatformOverviewSchema>;
export const PlatformTenantSummarySchema = z.object({ tenantId: z.string(), name: z.string(), slug: z.string(), lifecycle: z.string(), deploymentMode: z.string(), region: z.string().nullable(), hostname: z.string().nullable(), plan: z.string(), seats: z.number().int().nonnegative(), monthlySpendMicros: z.string(), prepaidBalanceMicros: z.string(), billingHealth: z.string(), ssoHealth: z.string(), updatedAt: ISODateSchema });
export type PlatformTenantSummary = z.infer<typeof PlatformTenantSummarySchema>;
const PlatformMutationSafetySchema = z.object({ auditNote: z.string().min(3).max(500), confirmation: z.literal(true), idempotencyKey: z.string().min(8).max(200) });
export const PlatformTenantProvisionSchema = PlatformMutationSafetySchema.extend({ name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]+$/), deploymentMode: z.enum(["shared", "dedicated", "selfhost"]), plan: z.string().min(1), region: z.string().min(1).nullable() }).strict();
export const PlatformTenantLifecycleMutationSchema = PlatformMutationSafetySchema.extend({ lifecycle: z.enum(["active", "suspended"]) }).strict();
export type PlatformTenantProvision = z.infer<typeof PlatformTenantProvisionSchema>;
export type PlatformTenantLifecycleMutation = z.infer<typeof PlatformTenantLifecycleMutationSchema>;
export const RouterHealthSummarySchema = z.object({ status: z.string(), contractVersion: z.string(), priceSnapshotAt: ISODateSchema.nullable(), eventLagSeconds: z.number().nonnegative().nullable(), signatureSuccessRate: z.number().min(0).max(1).nullable(), providers: z.array(z.object({ provider: z.string(), models: z.number().int().nonnegative(), requestShare: z.number().min(0).max(1), latencyP95Ms: z.number().nonnegative().nullable(), errorRate: z.number().min(0).max(1), status: z.string() })) });
export type RouterHealthSummary = z.infer<typeof RouterHealthSummarySchema>;
export const BillingOperationsSummarySchema = z.object({ prepaidLiabilityMicros: z.string(), consumedThisMonthMicros: z.string(), invoicesDue: z.number().int().nonnegative(), failedPayments: z.number().int().nonnegative(), blockedTenants: z.number().int().nonnegative(), tenants: z.array(PlatformTenantSummarySchema) });
export type BillingOperationsSummary = z.infer<typeof BillingOperationsSummarySchema>;
export const RolloutRuleSchema = z.object({ id: z.string(), feature: z.string(), status: z.enum(["draft", "internal", "beta", "gradual", "general"]), exposurePercent: z.number().min(0).max(100), target: z.record(JsonValueSchema), exclusions: z.array(z.string()), errorRateRollbackPercent: z.number().min(0).max(100).nullable(), ownerUserId: z.string(), updatedAt: ISODateSchema });
export type RolloutRule = z.infer<typeof RolloutRuleSchema>;
export const PlatformRolloutMutationSchema = RolloutRuleSchema.omit({ id: true, ownerUserId: true, updatedAt: true }).extend({
  auditNote: z.string().min(3).max(500), confirmation: z.literal(true), idempotencyKey: z.string().min(8).max(200),
}).strict();
export type PlatformRolloutMutation = z.infer<typeof PlatformRolloutMutationSchema>;

export {
  MODEL_PROVIDER_PRESETS,
  defaultEndpointPath,
  findModelProviderPreset,
  type ModelProviderPreset,
} from "./model-presets.ts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
