import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { JsonValue } from "@berry/shared";

export const SELF_HOST_TENANT_ID = "00000000-0000-7000-8000-000000000001";
export const SELF_HOST_TENANT_SLUG = "self-host";
export const SELF_HOST_WORKSPACE_ID = "00000000-0000-7000-8000-000000000101";
export const SELF_HOST_WORKSPACE_SLUG = "default";

export const deploymentModeEnum = pgEnum("deployment_mode", ["shared", "dedicated", "selfhost"]);
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "deleted"]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled", "deleted"]);
export const taskStatusEnum = pgEnum("task_status", ["queued", "running", "waiting-for-approval", "cancelled", "failed", "completed"]);
export const sessionStatusEnum = pgEnum("session_status", ["active", "compacted", "forked", "rewound", "archived"]);
export const permissionModeEnum = pgEnum("permission_mode", ["ask", "auto-edit", "plan", "full-access"]);
export const messageRoleEnum = pgEnum("message_role", ["system", "user", "assistant", "tool"]);
export const messageStatusEnum = pgEnum("message_status", ["streaming", "complete", "cancelled", "failed"]);
export const messagePartKindEnum = pgEnum("message_part_kind", [
  "text",
  "code",
  "reasoning",
  "tool-call",
  "tool-result",
  "image",
  "attachment",
  "citation",
  "terminal",
  "browser-screenshot",
  "error",
]);
export const toolCallStatusEnum = pgEnum("tool_call_status", ["pending", "waiting-for-approval", "running", "cancelled", "denied", "failed", "completed"]);
export const approvalKindEnum = pgEnum("approval_kind", ["file-edit", "shell", "terminal", "mcp", "browser", "credential", "workspace-trust"]);
export const approvalStatusEnum = pgEnum("approval_status", ["pending", "approved", "denied", "expired"]);
export const uiModeEnum = pgEnum("ui_mode", ["chat", "code", "cowork"]);
export const uiModeSourceEnum = pgEnum("ui_mode_source", ["classifier", "agent", "user"]);
export const conversationKindEnum = pgEnum("conversation_kind", ["chat", "code"]);
export const workspaceKindEnum = pgEnum("workspace_kind", ["project", "general"]);
export const fileOriginEnum = pgEnum("file_origin", ["user_upload", "sandbox_output", "image_generation", "browser_capture", "legacy_artifact", "connector_import"]);
export const fileStatusEnum = pgEnum("file_status", ["initiated", "uploading", "scanning", "processing", "available", "failed", "quarantined", "deleted"]);
export const fileAssociationRoleEnum = pgEnum("file_association_role", ["input", "output", "reference"]);
export const fileDerivativeKindEnum = pgEnum("file_derivative_kind", ["thumbnail", "pdf_preview", "text_extract", "sheet_data", "slide_image"]);
export const fileProcessingStatusEnum = pgEnum("file_processing_status", ["queued", "processing", "available", "failed"]);
export const fileBlobVerificationStatusEnum = pgEnum("file_blob_verification_status", [
  "unverified",
  "verifying",
  "verified",
  "failed",
  "pending_delete",
  "deleted",
]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const jsonObject = (name: string) => jsonb(name).$type<JsonValue>().notNull().default(sql`'{}'::jsonb`);
const jsonArray = (name: string) => jsonb(name).$type<JsonValue>().notNull().default(sql`'[]'::jsonb`);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  deploymentMode: deploymentModeEnum("deployment_mode").notNull().default("selfhost"),
  plan: text("plan").notNull().default("selfhost"),
  status: tenantStatusEnum("status").notNull().default("active"),
  settings: jsonObject("settings"),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("tenants_slug_unique").on(table.slug),
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  emailVerified: boolean("email_verified").notNull().default(false),
  avatarUrl: text("avatar_url"),
  status: userStatusEnum("status").notNull().default("active"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
]);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("auth_sessions_token_unique").on(table.token),
  index("auth_sessions_user_idx").on(table.userId),
]);

export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("auth_accounts_provider_account_unique").on(table.providerId, table.accountId),
  index("auth_accounts_user_idx").on(table.userId),
]);

export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  index("auth_verifications_identifier_idx").on(table.identifier),
]);

export const tenantMemberships = pgTable("tenant_memberships", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  role: text("role").notNull().default("member"),
  source: text("source").notNull().default("manual"),
  externalId: text("external_id"),
  defaultGroupId: uuid("default_group_id"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  deprovisionedAt: timestamp("deprovisioned_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("tenant_memberships_tenant_user_unique").on(table.tenantId, table.userId),
  index("tenant_memberships_user_idx").on(table.userId),
]);

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  externalId: text("external_id"),
  status: text("status").notNull().default("active"),
  settings: jsonObject("settings"),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("departments_tenant_slug_unique").on(table.tenantId, table.slug),
  uniqueIndex("departments_tenant_external_unique").on(table.tenantId, table.externalId),
  index("departments_tenant_parent_idx").on(table.tenantId, table.parentId),
]);

export const departmentMemberships = pgTable("department_memberships", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  departmentId: uuid("department_id").notNull().references(() => departments.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  source: text("source").notNull().default("manual"),
  externalId: text("external_id"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("department_memberships_tenant_dept_user_unique").on(table.tenantId, table.departmentId, table.userId),
  index("department_memberships_tenant_user_idx").on(table.tenantId, table.userId),
]);

export const tenantHostnames = pgTable("tenant_hostnames", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull(),
  deploymentMode: deploymentModeEnum("deployment_mode").notNull().default("dedicated"),
  status: text("status").notNull().default("active"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("tenant_hostnames_hostname_unique").on(table.hostname),
  index("tenant_hostnames_tenant_idx").on(table.tenantId),
]);

export const ssoConnections = pgTable("sso_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  provider: text("provider").notNull().default("generic"),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("draft"),
  issuer: text("issuer"),
  ssoUrl: text("sso_url"),
  metadataUrl: text("metadata_url"),
  entityId: text("entity_id"),
  clientId: text("client_id"),
  clientSecretRef: text("client_secret_ref"),
  clientSecretEnvelope: jsonb("client_secret_envelope").$type<JsonValue>(),
  certificate: text("certificate"),
  domains: jsonArray("domains"),
  jitProvisioning: boolean("jit_provisioning").notNull().default(true),
  defaultRole: text("default_role").notNull().default("member"),
  scimEnabled: boolean("scim_enabled").notNull().default(false),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("sso_connections_tenant_slug_unique").on(table.tenantId, table.slug),
  uniqueIndex("sso_connections_tenant_provider_enabled_unique")
    .on(table.tenantId, table.provider)
    .where(sql`${table.status} = 'enabled' AND ${table.provider} <> 'generic'`),
  index("sso_connections_tenant_status_idx").on(table.tenantId, table.status),
]);

export const scimIdentities = pgTable("scim_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  externalId: text("external_id").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  raw: jsonb("raw").$type<JsonValue>().notNull().default(sql`'{}'::jsonb`),
  createdAt,
  updatedAt,
  deprovisionedAt: timestamp("deprovisioned_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("scim_identities_tenant_resource_external_unique").on(table.tenantId, table.resourceType, table.externalId),
  index("scim_identities_tenant_user_idx").on(table.tenantId, table.userId),
]);

export const rolePermissionDefaults = pgTable("role_permission_defaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  permissions: jsonArray("permissions"),
  source: text("source").notNull().default("system"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("role_permission_defaults_tenant_role_unique").on(table.tenantId, table.role),
  index("role_permission_defaults_tenant_source_idx").on(table.tenantId, table.source),
]);

export const resourceAcls = pgTable("resource_acls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  principalType: text("principal_type").notNull(),
  principalId: text("principal_id").notNull(),
  allow: jsonArray("allow"),
  deny: jsonArray("deny"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("resource_acls_tenant_resource_principal_unique").on(table.tenantId, table.resourceType, table.resourceId, table.principalType, table.principalId),
  index("resource_acls_tenant_principal_idx").on(table.tenantId, table.principalType, table.principalId),
]);

export const featureFlags = pgTable("feature_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  flag: text("flag").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  roleDefaults: jsonb("role_defaults").$type<JsonValue>().notNull().default(sql`'{}'::jsonb`),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("feature_flags_tenant_flag_unique").on(table.tenantId, table.flag),
  index("feature_flags_tenant_enabled_idx").on(table.tenantId, table.enabled),
]);

export const modelGovernancePolicies = pgTable("model_governance_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  displayName: text("display_name"),
  presetId: text("preset_id"),
  apiType: text("api_type"),
  capabilities: jsonb("capabilities").$type<JsonValue>().notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("allowed"),
  enforce: boolean("enforce").notNull().default(false),
  modeAllow: jsonb("mode_allow").$type<JsonValue>().notNull().default(sql`'["chat","code"]'::jsonb`),
  kindAllow: jsonb("kind_allow").$type<JsonValue>().notNull().default(sql`'["chat","code"]'::jsonb`),
  metadata: jsonb("metadata").$type<JsonValue>().notNull().default(sql`'{}'::jsonb`),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_governance_policies_tenant_model_unique").on(table.tenantId, table.providerId, table.model),
  index("model_governance_policies_tenant_status_idx").on(table.tenantId, table.status),
  index("model_governance_policies_tenant_enforce_idx").on(table.tenantId, table.enforce),
]);

export const modelModeDefaults = pgTable("model_mode_defaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  enforce: boolean("enforce").notNull().default(false),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_mode_defaults_tenant_mode_unique").on(table.tenantId, table.mode),
  index("model_mode_defaults_tenant_provider_idx").on(table.tenantId, table.providerId),
]);

export const modelAuxiliaryDefaults = pgTable("model_auxiliary_defaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_auxiliary_defaults_tenant_purpose_unique").on(table.tenantId, table.purpose),
  index("model_auxiliary_defaults_tenant_provider_idx").on(table.tenantId, table.providerId),
]);

export const modelConversationKindDefaults = pgTable("model_conversation_kind_defaults", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationKind: conversationKindEnum("conversation_kind").notNull(),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  enforce: boolean("enforce").notNull().default(false),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("model_conversation_kind_defaults_tenant_kind_unique").on(table.tenantId, table.conversationKind),
  index("model_conversation_kind_defaults_tenant_provider_idx").on(table.tenantId, table.providerId),
]);

export const policyVersions = pgTable("policy_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").notNull().default("active"),
  bundle: jsonb("bundle").$type<JsonValue>().notNull(),
  bundleHash: text("bundle_hash").notNull(),
  keyId: text("key_id").notNull(),
  publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  auditEventId: uuid("audit_event_id"),
  note: text("note"),
  createdAt,
}, (table) => [
  uniqueIndex("policy_versions_tenant_version_unique").on(table.tenantId, table.version),
  uniqueIndex("policy_versions_tenant_active_unique").on(table.tenantId).where(sql`${table.status} = 'active'`),
  index("policy_versions_tenant_published_idx").on(table.tenantId, table.publishedAt),
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  workspaceKind: workspaceKindEnum("workspace_kind").notNull().default("project"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  trustState: text("trust_state").notNull().default("untrusted"),
  settings: jsonObject("settings"),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("workspaces_tenant_slug_unique").on(table.tenantId, table.slug),
  index("workspaces_tenant_updated_idx").on(table.tenantId, table.updatedAt),
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  status: taskStatusEnum("status").notNull().default("queued"),
  activeSessionId: uuid("active_session_id"),
  conversationKind: conversationKindEnum("conversation_kind").notNull().default("chat"),
  uiMode: uiModeEnum("ui_mode"),
  uiModePinned: boolean("ui_mode_pinned").notNull().default(false),
  uiModeSource: uiModeSourceEnum("ui_mode_source"),
  pinned: boolean("pinned").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  worktreePath: text("worktree_path"),
  worktreeBranch: text("worktree_branch"),
  worktreeBaseRef: text("worktree_base_ref"),
  worktreeBaseSha: text("worktree_base_sha"),
  pullRequestUrl: text("pull_request_url"),
  pullRequestNumber: integer("pull_request_number"),
  unreadAt: timestamp("unread_at", { withTimezone: true }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("tasks_tenant_workspace_updated_idx").on(table.tenantId, table.workspaceId, table.updatedAt),
  index("tasks_tenant_status_idx").on(table.tenantId, table.status),
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  parentSessionId: uuid("parent_session_id"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  status: sessionStatusEnum("status").notNull().default("active"),
  modelProviderId: text("model_provider_id"),
  model: text("model"),
  permissionMode: permissionModeEnum("permission_mode").notNull().default("full-access"),
  runtimeMetadata: jsonObject("runtime_metadata"),
  messageHistoryRevision: bigint("message_history_revision", { mode: "bigint" }).notNull().default(0n),
  messageHistoryDeletionRevision: bigint("message_history_deletion_revision", { mode: "bigint" }).notNull().default(0n),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("sessions_tenant_task_updated_idx").on(table.tenantId, table.taskId, table.updatedAt),
  index("sessions_tenant_parent_idx").on(table.tenantId, table.parentSessionId),
]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sequenceId: bigint("sequence_id", { mode: "number" }).generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"),
  role: messageRoleEnum("role").notNull(),
  status: messageStatusEnum("status").notNull().default("complete"),
  model: text("model"),
  finishReason: text("finish_reason"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  generationMs: integer("generation_ms").notNull().default(0),
  createdAt,
  updatedAt,
}, (table) => [
  index("messages_tenant_session_sequence_idx").on(table.tenantId, table.sessionId, table.sequenceId),
  index("messages_tenant_task_created_idx").on(table.tenantId, table.taskId, table.createdAt),
]);

export const messageParts = pgTable("message_parts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  type: messagePartKindEnum("type").notNull(),
  content: jsonb("content").$type<JsonValue>().notNull(),
  ordinal: integer("ordinal").notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("message_parts_message_ordinal_unique").on(table.messageId, table.ordinal),
  index("message_parts_tenant_message_idx").on(table.tenantId, table.messageId),
  index("message_parts_tenant_message_ordinal_idx").on(table.tenantId, table.messageId, table.ordinal),
]);

export const fileBlobs = pgTable("file_blobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  bucket: text("bucket").notNull(),
  objectKey: text("object_key").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  sha256: text("sha256"),
  etag: text("etag"),
  objectVersionId: text("object_version_id"),
  verificationStatus: fileBlobVerificationStatusEnum("verification_status").notNull().default("unverified"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  metadata: jsonObject("metadata"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("file_blobs_tenant_id_id_unique").on(table.tenantId, table.id),
  uniqueIndex("file_blobs_physical_location_unique").on(table.bucket, table.objectKey),
  uniqueIndex("file_blobs_tenant_location_unique").on(table.tenantId, table.bucket, table.objectKey),
  uniqueIndex("file_blobs_tenant_verified_hash_unique")
    .on(table.tenantId, table.sha256, table.sizeBytes)
    .where(sql`${table.sha256} IS NOT NULL AND ${table.verificationStatus} = 'verified' AND ${table.deletedAt} IS NULL`),
  index("file_blobs_tenant_status_created_idx").on(table.tenantId, table.verificationStatus, table.createdAt),
  index("file_blobs_pending_delete_idx").on(table.tenantId, table.deleteAfter),
]);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  blobId: uuid("blob_id").references(() => fileBlobs.id, { onDelete: "restrict" }),
  originalName: text("original_name").notNull(),
  displayName: text("display_name").notNull(),
  mediaType: text("media_type").notNull().default("application/octet-stream"),
  detectedMediaType: text("detected_media_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
  sha256: text("sha256"),
  bucket: text("bucket").notNull(),
  objectKey: text("object_key").notNull(),
  etag: text("etag"),
  objectVersionId: text("object_version_id"),
  origin: fileOriginEnum("origin").notNull(),
  status: fileStatusEnum("status").notNull().default("initiated"),
  metadata: jsonObject("metadata"),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  foreignKey({
    columns: [table.tenantId, table.blobId],
    foreignColumns: [fileBlobs.tenantId, fileBlobs.id],
    name: "files_tenant_blob_id_fkey",
  }).onDelete("restrict"),
  uniqueIndex("files_tenant_object_key_unique").on(table.tenantId, table.objectKey),
  index("files_tenant_owner_created_idx").on(table.tenantId, table.ownerUserId, table.createdAt),
  index("files_tenant_status_created_idx").on(table.tenantId, table.status, table.createdAt),
]);

export const fileLibraryEntries = pgTable("file_library_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("file_library_entries_tenant_user_file_unique").on(table.tenantId, table.userId, table.fileId),
  index("file_library_entries_tenant_user_active_idx").on(table.tenantId, table.userId, table.deletedAt, table.createdAt),
  index("file_library_entries_tenant_file_active_idx").on(table.tenantId, table.fileId, table.deletedAt),
]);

export const fileAssociations = pgTable("file_associations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
  turnId: text("turn_id"),
  role: fileAssociationRoleEnum("role").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt,
}, (table) => [
  uniqueIndex("file_associations_context_unique").on(table.fileId, table.taskId, table.sessionId, table.messageId, table.turnId, table.role),
  index("file_associations_tenant_task_created_idx").on(table.tenantId, table.taskId, table.createdAt),
  index("file_associations_tenant_message_idx").on(table.tenantId, table.messageId),
]);

export const fileUploads = pgTable("file_uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  providerUploadId: text("provider_upload_id").notNull(),
  partSize: integer("part_size").notNull(),
  partCount: integer("part_count").notNull(),
  status: text("status").notNull().default("uploading"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  abortedAt: timestamp("aborted_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("file_uploads_file_active_unique").on(table.fileId, table.providerUploadId),
  index("file_uploads_tenant_status_expiry_idx").on(table.tenantId, table.status, table.expiresAt),
]);

export const fileDerivatives = pgTable("file_derivatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  kind: fileDerivativeKindEnum("kind").notNull(),
  status: fileProcessingStatusEnum("status").notNull().default("queued"),
  objectKey: text("object_key"),
  mediaType: text("media_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  generatorVersion: text("generator_version").notNull().default("v1"),
  metadata: jsonObject("metadata"),
  error: text("error"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("file_derivatives_file_kind_version_unique").on(table.fileId, table.kind, table.generatorVersion),
  index("file_derivatives_tenant_status_idx").on(table.tenantId, table.status),
]);

export const memorySettings = pgTable("memory_settings", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  memoryEnabled: boolean("memory_enabled").notNull().default(true),
  implicitMemoryEnabled: boolean("implicit_memory_enabled").notNull().default(true),
  updatedAt,
}, (table) => [
  uniqueIndex("memory_settings_tenant_user_unique").on(table.tenantId, table.userId),
]);

export const memoryItems = pgTable("memory_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  scope: text("scope").notNull().default("personal"),
  kind: text("kind").notNull(),
  stableKey: text("stable_key").notNull(),
  content: text("content").notNull(),
  structuredValue: jsonObject("structured_value"),
  status: text("status").notNull().default("active"),
  explicit: boolean("explicit").notNull().default(false),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("0.5"),
  salience: numeric("salience", { precision: 5, scale: 4 }).notNull().default("0.5"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  extractorVersion: text("extractor_version").notNull().default("v1"),
  sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
  sourceSessionId: uuid("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
  sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
  supersededItemId: uuid("superseded_item_id"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("memory_items_active_key_unique").on(table.tenantId, table.userId, table.workspaceId, table.stableKey).where(sql`${table.status} = 'active'`),
  index("memory_items_recall_idx").on(table.tenantId, table.userId, table.workspaceId, table.status, table.salience),
  index("memory_items_expiry_idx").on(table.tenantId, table.expiresAt),
]);

export const memoryItemVersions = pgTable("memory_item_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  memoryItemId: uuid("memory_item_id").notNull().references(() => memoryItems.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(),
  beforeValue: jsonb("before_value").$type<JsonValue>(),
  afterValue: jsonb("after_value").$type<JsonValue>(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
  sourceSessionId: uuid("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
  sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
  extractorVersion: text("extractor_version"),
  reason: text("reason"),
  createdAt,
}, (table) => [
  index("memory_item_versions_item_created_idx").on(table.tenantId, table.memoryItemId, table.createdAt),
]);

export const workspaceFiles = pgTable("workspace_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  visibility: text("visibility").notNull().default("project"),
  originatingTaskId: uuid("originating_task_id").references(() => tasks.id, { onDelete: "set null" }),
  indexStatus: text("index_status").notNull().default("pending"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("workspace_files_workspace_file_unique").on(table.tenantId, table.workspaceId, table.fileId),
  index("workspace_files_list_idx").on(table.tenantId, table.workspaceId, table.visibility, table.indexStatus, table.createdAt),
]);

export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  sourceRevision: text("source_revision").notNull(),
  contentHash: text("content_hash").notNull(),
  title: text("title").notNull(),
  authority: numeric("authority", { precision: 5, scale: 4 }).notNull().default("0.5"),
  visibility: text("visibility").notNull().default("project"),
  aclVersion: integer("acl_version").notNull().default(1),
  extractionStatus: text("extraction_status").notNull().default("pending"),
  indexStatus: text("index_status").notNull().default("pending"),
  vectorReady: boolean("vector_ready").notNull().default(false),
  extractorVersion: text("extractor_version").notNull().default("v1"),
  chunkerVersion: text("chunker_version").notNull().default("v1"),
  failureReason: text("failure_reason"),
  metadata: jsonObject("metadata"),
  tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("knowledge_sources_revision_unique").on(table.tenantId, table.workspaceId, table.sourceType, table.sourceId, table.sourceRevision),
  index("knowledge_sources_active_idx").on(table.tenantId, table.workspaceId, table.indexStatus, table.sourceType),
  index("knowledge_sources_cleanup_idx").on(table.tenantId, table.tombstonedAt),
]);

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => knowledgeSources.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  textContent: text("text_content").notNull(),
  tokenEstimate: integer("token_estimate").notNull().default(0),
  metadata: jsonObject("metadata"),
  embedding: vector("embedding", { dimensions: 768 }),
  embeddingProfileId: text("embedding_profile_id"),
  embeddingProvider: text("embedding_provider"),
  embeddingModel: text("embedding_model"),
  embeddingDimensions: integer("embedding_dimensions"),
  embeddingProfileVersion: integer("embedding_profile_version"),
  embeddingHash: text("embedding_hash"),
  vectorReady: boolean("vector_ready").notNull().default(false),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("knowledge_chunks_source_ordinal_unique").on(table.sourceId, table.ordinal),
  index("knowledge_chunks_scope_idx").on(table.tenantId, table.workspaceId, table.sourceId),
  index("knowledge_chunks_vector_ready_idx").on(table.tenantId, table.workspaceId, table.vectorReady),
  index("knowledge_chunks_embedding_hnsw_idx")
    .using("hnsw", table.embedding.op("vector_cosine_ops"))
    .where(sql`${table.vectorReady} = true AND ${table.embedding} IS NOT NULL`),
]);

export const retrievalSnapshots = pgTable("retrieval_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  runId: uuid("run_id"),
  queryHash: text("query_hash").notNull(),
  candidates: jsonArray("candidates"),
  selectedSourceIds: jsonArray("selected_source_ids"),
  selectedChunkIds: jsonArray("selected_chunk_ids"),
  componentScores: jsonObject("component_scores"),
  selectionReason: text("selection_reason"),
  tokenBudget: integer("token_budget").notNull(),
  tokensSelected: integer("tokens_selected").notNull().default(0),
  retrievalVersion: text("retrieval_version").notNull(),
  embeddingProfileId: text("embedding_profile_id"),
  createdAt,
}, (table) => [
  index("retrieval_snapshots_turn_idx").on(table.tenantId, table.sessionId, table.createdAt),
  index("retrieval_snapshots_workspace_idx").on(table.tenantId, table.workspaceId, table.createdAt),
]);

export const sessionEntries = pgTable("session_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  entryId: text("entry_id").notNull(),
  parentEntryId: text("parent_entry_id"),
  entryType: text("entry_type").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  payload: jsonb("payload").$type<JsonValue>().notNull(),
  isLeafMarker: boolean("is_leaf_marker").notNull().default(false),
  runId: uuid("run_id"),
  stepId: uuid("step_id"),
  checkpointId: uuid("checkpoint_id"),
  createdAt,
}, (table) => [
  uniqueIndex("session_entries_session_entry_unique").on(table.tenantId, table.sessionId, table.entryId),
  uniqueIndex("session_entries_session_sequence_unique").on(table.tenantId, table.sessionId, table.sequence),
  index("session_entries_parent_idx").on(table.tenantId, table.sessionId, table.parentEntryId),
]);

export const sessionCheckpoints = pgTable("session_checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  sourceLeafId: text("source_leaf_id").notNull(),
  coveredEntryStart: text("covered_entry_start"),
  coveredEntryEnd: text("covered_entry_end"),
  schemaVersion: integer("schema_version").notNull().default(2),
  checkpoint: jsonb("checkpoint").$type<JsonValue>().notNull(),
  validationStatus: text("validation_status").notNull().default("valid"),
  modelProvider: text("model_provider"),
  model: text("model"),
  promptManifestHash: text("prompt_manifest_hash"),
  createdAt,
}, (table) => [
  uniqueIndex("session_checkpoints_idempotency_unique").on(table.tenantId, table.sessionId, table.kind, table.sourceLeafId, table.coveredEntryEnd, table.schemaVersion),
  index("session_checkpoints_latest_idx").on(table.tenantId, table.sessionId, table.createdAt),
]);

export const sessionCompactionLeases = pgTable("session_compaction_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  leaseOwner: text("lease_owner").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
  lastError: text("last_error"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("session_compaction_leases_session_unique").on(table.tenantId, table.sessionId),
  index("session_compaction_leases_expiry_idx").on(table.tenantId, table.leaseExpiresAt),
]);

export const turnRuns = pgTable("turn_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  requestMessageId: uuid("request_message_id").references(() => messages.id, { onDelete: "set null" }),
  state: text("state").notNull().default("queued"),
  attempt: integer("attempt").notNull().default(0),
  version: integer("version").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAction: text("next_action"),
  waitingReason: text("waiting_reason"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  error: text("error"),
  runtimeRequest: jsonObject("runtime_request"),
  groundingContext: jsonObject("grounding_context"),
  promptManifest: jsonObject("prompt_manifest"),
  sandboxProvider: text("sandbox_provider"),
  sandboxId: text("sandbox_id"),
  sandboxState: text("sandbox_state"),
  sandboxHeartbeatAt: timestamp("sandbox_heartbeat_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  index("turn_runs_claim_idx").on(table.tenantId, table.state, table.leaseExpiresAt),
  index("turn_runs_session_idx").on(table.tenantId, table.sessionId, table.createdAt),
  uniqueIndex("turn_runs_tenant_request_unique").on(table.tenantId, table.requestId),
  index("turn_runs_terminal_sandbox_cleanup_idx")
    .on(table.tenantId, table.updatedAt)
    .where(sql`${table.state} IN ('completed','failed','cancelled','recovery_required')
      AND ${table.sandboxId} IS NOT NULL
      AND COALESCE(${table.sandboxState},'running') NOT IN ('paused','missing','stopped','destroyed','pause_requested')`),
]);

export const turnAdmissionIntents = pgTable("turn_admission_intents", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  operationFingerprint: text("operation_fingerprint"),
  state: text("state").notNull().default("preparing"),
  runId: uuid("run_id").references(() => turnRuns.id, { onDelete: "set null" }),
  preparationMs: integer("preparation_ms"),
  admittedAt: timestamp("admitted_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.requestId] }),
  index("turn_admission_intents_session_idx").on(table.tenantId, table.sessionId, table.createdAt),
  index("turn_admission_intents_state_idx").on(table.tenantId, table.state, table.updatedAt),
]);

export const turnSteps = pgTable("turn_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => turnRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  stepType: text("step_type").notNull(),
  state: text("state").notNull().default("pending"),
  input: jsonObject("input"),
  output: jsonb("output").$type<JsonValue>(),
  retryClass: text("retry_class"),
  idempotencyKey: text("idempotency_key"),
  sessionEntryId: text("session_entry_id"),
  checkpointId: uuid("checkpoint_id"),
  attempt: integer("attempt").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("turn_steps_run_sequence_unique").on(table.tenantId, table.runId, table.sequence),
  uniqueIndex("turn_steps_idempotency_unique").on(table.tenantId, table.runId, table.idempotencyKey),
  index("turn_steps_state_idx").on(table.tenantId, table.state, table.createdAt),
]);

export const turnEvents = pgTable("turn_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => turnRuns.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<JsonValue>().notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("turn_events_run_sequence_unique").on(table.tenantId, table.runId, table.sequence),
  index("turn_events_session_sequence_idx").on(table.tenantId, table.sessionId, table.sequence),
  index("turn_events_retention_idx").on(table.tenantId, table.createdAt),
]);

export const runtimeOutbox = pgTable("runtime_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payload: jsonb("payload").$type<JsonValue>().notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("runtime_outbox_dedupe_unique").on(table.tenantId, table.dedupeKey),
  index("runtime_outbox_due_idx").on(table.tenantId, table.completedAt, table.availableAt, table.leaseExpiresAt),
]);

export const sandboxSnapshots = pgTable("sandbox_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => turnRuns.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  sandboxProvider: text("sandbox_provider").notNull(),
  sandboxId: text("sandbox_id").notNull(),
  storageFileId: uuid("storage_file_id").references(() => files.id, { onDelete: "set null" }),
  objectKey: text("object_key").notNull(),
  contentHash: text("content_hash").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull().default("pending"),
  sessionLeafId: text("session_leaf_id"),
  failureReason: text("failure_reason"),
  createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("sandbox_snapshots_run_sequence_unique").on(table.tenantId, table.runId, table.sequence),
  index("sandbox_snapshots_restore_idx").on(table.tenantId, table.runId, table.status, table.sequence),
]);

export const maintenanceRuns = pgTable("maintenance_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("queued"),
  cursor: jsonObject("cursor"),
  scannedCount: bigint("scanned_count", { mode: "number" }).notNull().default(0),
  changedCount: bigint("changed_count", { mode: "number" }).notNull().default(0),
  enqueuedCount: bigint("enqueued_count", { mode: "number" }).notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  lastError: text("last_error"),
  requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  index("maintenance_runs_tenant_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const toolCalls = pgTable("tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => turnRuns.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => turnSteps.id, { onDelete: "set null" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  toolName: text("tool_name").notNull(),
  status: toolCallStatusEnum("status").notNull().default("pending"),
  input: jsonb("input").$type<JsonValue>().notNull(),
  output: jsonb("output").$type<JsonValue>(),
  children: jsonArray("children"),
  decisionTrace: jsonArray("decision_trace"),
  approvalId: uuid("approval_id"),
  retryClass: text("retry_class"),
  idempotencyKey: text("idempotency_key"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  index("tool_calls_tenant_session_idx").on(table.tenantId, table.sessionId),
  index("tool_calls_tenant_message_idx").on(table.tenantId, table.messageId),
  index("tool_calls_tenant_status_idx").on(table.tenantId, table.status),
]);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => turnRuns.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => turnSteps.id, { onDelete: "set null" }),
  toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
  kind: approvalKindEnum("kind").notNull(),
  status: approvalStatusEnum("status").notNull().default("pending"),
  request: jsonb("request").$type<JsonValue>().notNull(),
  decision: jsonb("decision").$type<JsonValue>(),
  createdAt,
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (table) => [
  index("approvals_tenant_status_created_idx").on(table.tenantId, table.status, table.createdAt),
  index("approvals_tenant_task_idx").on(table.tenantId, table.taskId),
]);

export const turnQuestions = pgTable("turn_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => turnRuns.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => turnSteps.id, { onDelete: "set null" }),
  toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
  question: text("question").notNull(),
  options: jsonArray("options"),
  questions: jsonArray("questions"),
  multi: boolean("multi").notNull().default(false),
  status: text("status").notNull().default("pending"),
  answer: jsonb("answer").$type<JsonValue>(),
  createdAt,
  answeredAt: timestamp("answered_at", { withTimezone: true }),
}, (table) => [
  index("turn_questions_session_status_idx").on(table.tenantId, table.sessionId, table.status, table.createdAt),
  index("turn_questions_run_idx").on(table.tenantId, table.runId, table.createdAt),
]);

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  idempotencyKey: text("idempotency_key"),
  source: text("source").notNull().default("api"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
  feature: text("feature").notNull(),
  provider: text("provider"),
  model: text("model"),
  agentId: text("agent_id"),
  sandboxId: text("sandbox_id"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  tokensCached: integer("tokens_cached").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  cacheCreationTokens1h: integer("cache_creation_tokens_1h").notNull().default(0),
  cacheCreationTokens5m: integer("cache_creation_tokens_5m").notNull().default(0),
  cacheEligible: boolean("cache_eligible").notNull().default(false),
  cacheProvider: text("cache_provider"),
  cacheKeyHash: text("cache_key_hash"),
  promptManifestHash: text("prompt_manifest_hash"),
  cacheMissReason: text("cache_miss_reason"),
  sandboxUsage: jsonObject("sandbox_usage"),
  costRawMicros: numeric("cost_raw_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  costBilledMicros: numeric("cost_billed_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  latencyMs: integer("latency_ms"),
  ttftMs: integer("ttft_ms"),
  status: text("status").notNull().default("completed"),
  metadata: jsonObject("metadata"),
  signedPayload: jsonObject("signed_payload"),
  signature: jsonObject("signature"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  createdAt,
}, (table) => [
  uniqueIndex("usage_events_tenant_request_unique").on(table.tenantId, table.requestId),
  index("usage_events_tenant_ts_idx").on(table.tenantId, table.ts),
  index("usage_events_tenant_feature_ts_idx").on(table.tenantId, table.feature, table.ts),
  index("usage_events_tenant_user_ts_idx").on(table.tenantId, table.userId, table.ts),
  index("usage_events_tenant_department_ts_idx").on(table.tenantId, table.departmentId, table.ts),
  index("usage_events_tenant_model_ts_idx").on(table.tenantId, table.model, table.ts),
  index("usage_events_tenant_status_ts_idx").on(table.tenantId, table.status, table.ts),
  index("usage_events_tenant_workspace_ts_idx").on(table.tenantId, table.workspaceId, table.ts),
  index("usage_events_tenant_agent_ts_idx").on(table.tenantId, table.agentId, table.ts),
  check("usage_events_nonnegative_tokens", sql`${table.tokensIn} >= 0 AND ${table.tokensOut} >= 0 AND ${table.tokensCached} >= 0 AND ${table.cacheReadTokens} >= 0 AND ${table.cacheWriteTokens} >= 0`),
]);

export const visionObservationCache = pgTable("vision_observation_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  cacheKey: text("cache_key").notNull(),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  imageCount: integer("image_count").notNull(),
  observation: text("observation").notNull(),
  createdAt,
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("vision_observation_cache_tenant_key_unique").on(table.tenantId, table.cacheKey),
  index("vision_observation_cache_tenant_last_used_idx").on(table.tenantId, table.lastUsedAt),
]);

export const usageRollups = pgTable("usage_rollups", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
  bucketEnd: timestamp("bucket_end", { withTimezone: true }).notNull(),
  granularity: text("granularity").notNull().default("day"),
  feature: text("feature").notNull(),
  provider: text("provider"),
  model: text("model"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  agentId: text("agent_id"),
  sandboxId: text("sandbox_id"),
  status: text("status").notNull().default("completed"),
  requestCount: integer("request_count").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  tokensCached: integer("tokens_cached").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costRawMicros: numeric("cost_raw_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  costBilledMicros: numeric("cost_billed_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  latencyMsTotal: integer("latency_ms_total").notNull().default(0),
  latencyMsCount: integer("latency_ms_count").notNull().default(0),
  ttftMsTotal: integer("ttft_ms_total").notNull().default(0),
  ttftMsCount: integer("ttft_ms_count").notNull().default(0),
  sourceEventMinTs: timestamp("source_event_min_ts", { withTimezone: true }),
  sourceEventMaxTs: timestamp("source_event_max_ts", { withTimezone: true }),
  metadata: jsonObject("metadata"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("usage_rollups_tenant_bucket_dimension_unique").on(
    table.tenantId,
    table.bucketStart,
    table.granularity,
    table.feature,
    table.provider,
    table.model,
    table.status,
    table.userId,
    table.departmentId,
    table.workspaceId,
    table.agentId,
    table.sandboxId,
  ),
  index("usage_rollups_tenant_bucket_idx").on(table.tenantId, table.bucketStart),
  index("usage_rollups_tenant_user_bucket_idx").on(table.tenantId, table.userId, table.bucketStart),
  index("usage_rollups_tenant_department_bucket_idx").on(table.tenantId, table.departmentId, table.bucketStart),
  index("usage_rollups_tenant_workspace_bucket_idx").on(table.tenantId, table.workspaceId, table.bucketStart),
  index("usage_rollups_tenant_agent_bucket_idx").on(table.tenantId, table.agentId, table.bucketStart),
  check("usage_rollups_nonnegative_counts", sql`${table.requestCount} >= 0 AND ${table.tokensIn} >= 0 AND ${table.tokensOut} >= 0 AND ${table.tokensCached} >= 0 AND ${table.cacheReadTokens} >= 0 AND ${table.cacheWriteTokens} >= 0`),
]);

export const budgetLimits = pgTable("budget_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  period: text("period").notNull().default("month"),
  softLimitMicros: numeric("soft_limit_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  hardLimitMicros: numeric("hard_limit_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  requestLimit: integer("request_limit"),
  tokenLimit: integer("token_limit"),
  sandboxMinuteLimit: numeric("sandbox_minute_limit", { precision: 12, scale: 2 }),
  thresholdPercentages: jsonArray("threshold_percentages"),
  status: text("status").notNull().default("active"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("budget_limits_tenant_scope_period_unique").on(table.tenantId, table.scopeType, table.scopeId, table.period),
  index("budget_limits_tenant_status_idx").on(table.tenantId, table.status),
]);

export const budgetReservations = pgTable("budget_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  feature: text("feature").notNull(),
  provider: text("provider"),
  model: text("model"),
  estimatedCostMicros: numeric("estimated_cost_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  reservedMicros: numeric("reserved_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  actualCostMicros: numeric("actual_cost_micros", { precision: 20, scale: 0 }),
  status: text("status").notNull().default("reserved"),
  blockReason: text("block_reason"),
  metadata: jsonObject("metadata"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("budget_reservations_tenant_request_unique").on(table.tenantId, table.requestId),
  index("budget_reservations_tenant_status_idx").on(table.tenantId, table.status),
  index("budget_reservations_tenant_user_idx").on(table.tenantId, table.userId),
]);

export const creditLedgerEntries = pgTable("credit_ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  reservationId: uuid("reservation_id").references(() => budgetReservations.id, { onDelete: "set null" }),
  requestId: text("request_id"),
  kind: text("kind").notNull(),
  amountMicros: numeric("amount_micros", { precision: 20, scale: 0 }).notNull(),
  balanceAfterMicros: numeric("balance_after_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  metadata: jsonObject("metadata"),
  createdAt,
}, (table) => [
  uniqueIndex("credit_ledger_entries_tenant_request_scope_kind_unique").on(table.tenantId, table.requestId, table.scopeType, table.scopeId, table.kind),
  index("credit_ledger_entries_tenant_scope_idx").on(table.tenantId, table.scopeType, table.scopeId, table.createdAt),
]);

export const budgetCounterSnapshots = pgTable("budget_counter_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  spentMicros: numeric("spent_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  reservedMicros: numeric("reserved_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  source: text("source").notNull().default("redis"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("budget_counter_snapshots_tenant_scope_period_unique").on(table.tenantId, table.scopeType, table.scopeId, table.periodStart),
]);

export const billingCreditGrants = pgTable("billing_credit_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("manual"),
  amountMicros: numeric("amount_micros", { precision: 20, scale: 0 }).notNull(),
  remainingMicros: numeric("remaining_micros", { precision: 20, scale: 0 }).notNull(),
  currency: text("currency").notNull().default("usd"),
  externalRef: text("external_ref"),
  status: text("status").notNull().default("active"),
  metadata: jsonObject("metadata"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("billing_credit_grants_tenant_external_unique").on(table.tenantId, table.externalRef),
  index("billing_credit_grants_tenant_status_idx").on(table.tenantId, table.status),
  check("billing_credit_grants_nonnegative", sql`${table.amountMicros} >= 0 AND ${table.remainingMicros} >= 0`),
]);

export const billingMeterEvents = pgTable("billing_meter_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  usageEventId: uuid("usage_event_id").references(() => usageEvents.id, { onDelete: "set null" }),
  requestId: text("request_id").notNull(),
  meter: text("meter").notNull(),
  quantity: numeric("quantity", { precision: 20, scale: 0 }).notNull(),
  costBilledMicros: numeric("cost_billed_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  provider: text("provider").notNull().default("none"),
  externalEventId: text("external_event_id"),
  status: text("status").notNull().default("pending"),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  metadata: jsonObject("metadata"),
  createdAt,
}, (table) => [
  uniqueIndex("billing_meter_events_tenant_request_meter_unique").on(table.tenantId, table.requestId, table.meter),
  uniqueIndex("billing_meter_events_tenant_external_unique").on(table.tenantId, table.externalEventId),
  index("billing_meter_events_tenant_status_idx").on(table.tenantId, table.status),
  index("billing_meter_events_tenant_created_idx").on(table.tenantId, table.createdAt),
  check("billing_meter_events_nonnegative", sql`${table.quantity} >= 0 AND ${table.costBilledMicros} >= 0`),
]);

export const billingInvoices = pgTable("billing_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("none"),
  externalInvoiceId: text("external_invoice_id"),
  status: text("status").notNull().default("draft"),
  totalMicros: numeric("total_micros", { precision: 20, scale: 0 }).notNull().default("0"),
  currency: text("currency").notNull().default("usd"),
  hostedInvoiceUrl: text("hosted_invoice_url"),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  metadata: jsonObject("metadata"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("billing_invoices_tenant_external_unique").on(table.tenantId, table.externalInvoiceId),
  index("billing_invoices_tenant_status_idx").on(table.tenantId, table.status),
  check("billing_invoices_nonnegative", sql`${table.totalMicros} >= 0`),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
  before: jsonb("before").$type<JsonValue>(),
  after: jsonb("after").$type<JsonValue>(),
  metadata: jsonObject("metadata"),
  previousHash: text("previous_hash").notNull(),
  eventHash: text("event_hash").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '90 days'`),
  createdAt,
}, (table) => [
  uniqueIndex("audit_events_tenant_sequence_unique").on(table.tenantId, table.sequence),
  index("audit_events_tenant_ts_idx").on(table.tenantId, table.ts),
  index("audit_events_tenant_session_idx").on(table.tenantId, table.sessionId),
]);

export const auditSettings = pgTable("audit_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  retentionDays: integer("retention_days").notNull().default(90),
  clientIngestEnabled: boolean("client_ingest_enabled").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("audit_settings_tenant_unique").on(table.tenantId),
  check("audit_settings_retention_days_range", sql`${table.retentionDays} >= 1 AND ${table.retentionDays} <= 3650`),
]);

export const auditExportConfigs = pgTable("audit_export_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("enabled"),
  destination: text("destination").notNull(),
  format: text("format").notNull().default("json"),
  config: jsonObject("config"),
  lastExportedAt: timestamp("last_exported_at", { withTimezone: true }),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("audit_export_configs_tenant_kind_destination_unique").on(table.tenantId, table.kind, table.destination),
  index("audit_export_configs_tenant_status_idx").on(table.tenantId, table.status),
]);

export const mobileDevices = pgTable("mobile_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  deviceId: text("device_id").notNull(),
  platform: text("platform").notNull(),
  pushProvider: text("push_provider").notNull().default("none"),
  pushTokenCiphertext: text("push_token_ciphertext"),
  pushTokenLast4: text("push_token_last4"),
  endpointMode: text("endpoint_mode").notNull(),
  appVersion: text("app_version"),
  capabilities: jsonArray("capabilities"),
  status: text("status").notNull().default("active"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("mobile_devices_tenant_device_unique").on(table.tenantId, table.deviceId),
  index("mobile_devices_tenant_user_idx").on(table.tenantId, table.userId),
  index("mobile_devices_tenant_status_idx").on(table.tenantId, table.status),
  check("mobile_devices_platform_check", sql`${table.platform} IN ('ios', 'android', 'expo')`),
  check("mobile_devices_push_provider_check", sql`${table.pushProvider} IN ('expo', 'apns', 'fcm', 'none')`),
  check("mobile_devices_endpoint_mode_check", sql`${table.endpointMode} IN ('berry-account', 'self-hosted', 'custom-openai', 'lan-local')`),
]);

export const allowanceProfiles = pgTable("allowance_profiles", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(), description: text("description").notNull().default(""), period: text("period").notNull().default("month"),
  softLimitMicros: numeric("soft_limit_micros", { precision: 20, scale: 0 }), hardLimitMicros: numeric("hard_limit_micros", { precision: 20, scale: 0 }),
  requestLimit: integer("request_limit"), tokenLimit: integer("token_limit"), sandboxMinuteLimit: numeric("sandbox_minute_limit", { precision: 12, scale: 2 }),
  thresholdPercentages: jsonArray("threshold_percentages"), status: text("status").notNull().default("active"), createdAt, updatedAt,
}, (table) => [uniqueIndex("allowance_profiles_tenant_name_unique").on(table.tenantId, table.name), index("allowance_profiles_tenant_status_idx").on(table.tenantId, table.status)]);

export const allowanceDefaultAssignments = pgTable("allowance_default_assignments", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").references(() => allowanceProfiles.id, { onDelete: "set null" }), role: text("role"),
  departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }), priority: integer("priority").notNull().default(0), createdAt, updatedAt,
}, (table) => [uniqueIndex("allowance_defaults_tenant_role_department_unique").on(table.tenantId, table.role, table.departmentId)]);

export const allowanceMemberOverrides = pgTable("allowance_member_overrides", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amountMicros: numeric("amount_micros", { precision: 20, scale: 0 }).notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt,
  updatedAt,
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.userId] }),
  index("allowance_member_overrides_tenant_idx").on(table.tenantId),
]);

export const allowanceBulkOperations = pgTable("allowance_bulk_operations", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(), result: jsonObject("result"), createdAt,
}, (table) => [uniqueIndex("allowance_bulk_tenant_key_unique").on(table.tenantId, table.idempotencyKey)]);

export const billingAutoRefillConfigs = pgTable("billing_auto_refill_configs", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }), enabled: boolean("enabled").notNull().default(false),
  triggerBalanceMicros: numeric("trigger_balance_micros", { precision: 20, scale: 0 }), purchaseAmountMicros: numeric("purchase_amount_micros", { precision: 20, scale: 0 }),
  currency: text("currency").notNull().default("usd"), idempotencyKey: text("idempotency_key"), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }), updatedAt,
});

export const organizationAiAccessRules = pgTable("organization_ai_access_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  effect: text("effect").notNull().default("allowed"),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("organization_ai_access_rules_scope_resource_unique").on(table.tenantId, table.scopeType, table.scopeId, table.resourceType, table.resourceId),
  index("organization_ai_access_rules_tenant_resource_idx").on(table.tenantId, table.resourceType, table.resourceId),
]);

export const savedAnalyticsViews = pgTable("saved_analytics_views", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }), name: text("name").notNull(),
  filters: jsonObject("filters"), visibility: text("visibility").notNull().default("private"), createdAt, updatedAt,
}, (table) => [index("saved_analytics_views_tenant_owner_idx").on(table.tenantId, table.ownerUserId)]);

export const reportSchedules = pgTable("report_schedules", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  savedViewId: uuid("saved_view_id").notNull().references(() => savedAnalyticsViews.id, { onDelete: "cascade" }), name: text("name").notNull(),
  format: text("format").notNull(), cadence: text("cadence").notNull(), timezone: text("timezone").notNull(), recipients: jsonArray("recipients"),
  status: text("status").notNull().default("active"), nextRunAt: timestamp("next_run_at", { withTimezone: true }), lastRunAt: timestamp("last_run_at", { withTimezone: true }), createdAt, updatedAt,
}, (table) => [index("report_schedules_tenant_next_run_idx").on(table.tenantId, table.status, table.nextRunAt)]);

export const reportRuns = pgTable("report_runs", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  scheduleId: uuid("schedule_id").notNull().references(() => reportSchedules.id, { onDelete: "cascade" }), windowKey: text("window_key").notNull(),
  status: text("status").notNull().default("queued"), artifactRef: text("artifact_ref"), error: text("error"), startedAt: timestamp("started_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }), createdAt,
}, (table) => [uniqueIndex("report_runs_tenant_schedule_window_unique").on(table.tenantId, table.scheduleId, table.windowKey), index("report_runs_tenant_created_idx").on(table.tenantId, table.createdAt)]);

export const alertDestinations = pgTable("alert_destinations", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), label: text("label").notNull(), emailRecipients: jsonArray("email_recipients"), secretRef: text("secret_ref"), configured: boolean("configured").notNull().default(false), createdAt, updatedAt,
}, (table) => [index("alert_destinations_tenant_kind_idx").on(table.tenantId, table.kind)]);

export const alertRules = pgTable("alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(), signal: text("signal").notNull(), enabled: boolean("enabled").notNull().default(true), scopeType: text("scope_type"), scopeId: text("scope_id"),
  threshold: numeric("threshold", { precision: 20, scale: 4 }).notNull(), windowMinutes: integer("window_minutes").notNull(), destinationIds: jsonArray("destination_ids"), createdAt, updatedAt,
}, (table) => [index("alert_rules_tenant_enabled_idx").on(table.tenantId, table.enabled)]);

export const alertEvents = pgTable("alert_events", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  ruleId: uuid("rule_id").notNull().references(() => alertRules.id, { onDelete: "cascade" }), windowKey: text("window_key").notNull(),
  observed: numeric("observed", { precision: 20, scale: 4 }).notNull(), baseline: numeric("baseline", { precision: 20, scale: 4 }), status: text("status").notNull().default("open"), createdAt,
}, (table) => [uniqueIndex("alert_events_tenant_rule_window_unique").on(table.tenantId, table.ruleId, table.windowKey), index("alert_events_tenant_created_idx").on(table.tenantId, table.createdAt)]);

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  alertEventId: uuid("alert_event_id").references(() => alertEvents.id, { onDelete: "cascade" }), reportRunId: uuid("report_run_id").references(() => reportRuns.id, { onDelete: "cascade" }),
  destinationId: uuid("destination_id").notNull().references(() => alertDestinations.id, { onDelete: "cascade" }), attempt: integer("attempt").notNull().default(1),
  status: text("status").notNull().default("pending"), providerMessageId: text("provider_message_id"), error: text("error"), createdAt,
}, (table) => [uniqueIndex("delivery_attempts_tenant_target_destination_attempt_unique").on(table.tenantId, table.alertEventId, table.reportRunId, table.destinationId, table.attempt)]);

export const executionNetworkPolicies = pgTable("execution_network_policies", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }), policy: jsonObject("policy"), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }), createdAt, updatedAt,
});
export const authenticationPolicies = pgTable("authentication_policies", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }), policy: jsonObject("policy"), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }), createdAt, updatedAt,
});
export const dataGovernancePolicies = pgTable("data_governance_policies", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }), policy: jsonObject("policy"), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }), createdAt, updatedAt,
});
export const organizationProfiles = pgTable("organization_profiles", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }), timezone: text("timezone").notNull().default("UTC"), language: text("language").notNull().default("en"),
  logoUrl: text("logo_url"), supportEmail: text("support_email"), securityEmail: text("security_email"), announcements: jsonArray("announcements"), termsUrl: text("terms_url"), privacyUrl: text("privacy_url"), branding: jsonObject("branding"), updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }), createdAt, updatedAt,
});
export const organizationDomains = pgTable("organization_domains", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }), domain: text("domain").notNull(),
  status: text("status").notNull().default("pending"), customDomain: boolean("custom_domain").notNull().default(false), verificationTokenHash: text("verification_token_hash"), verifiedAt: timestamp("verified_at", { withTimezone: true }), createdAt, updatedAt,
}, (table) => [uniqueIndex("organization_domains_domain_unique").on(table.domain), index("organization_domains_tenant_status_idx").on(table.tenantId, table.status)]);
export const serviceAccounts = pgTable("service_accounts", {
  id: uuid("id").primaryKey().defaultRandom(), tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }), name: text("name").notNull(),
  status: text("status").notNull().default("active"), permissions: jsonArray("permissions"), departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
  resourceRestrictions: jsonArray("resource_restrictions"), tokenHash: text("token_hash").notNull(), tokenLast4: text("token_last4").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), lastUsedAt: timestamp("last_used_at", { withTimezone: true }), createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), createdAt, updatedAt,
}, (table) => [uniqueIndex("service_accounts_tenant_name_unique").on(table.tenantId, table.name), index("service_accounts_tenant_status_idx").on(table.tenantId, table.status)]);

// Platform rollout state is intentionally not covered by tenant RLS. Access
// goes through the separate platform database path and platform authorizer.
export const platformRolloutRules = pgTable("platform_rollout_rules", {
  id: uuid("id").primaryKey().defaultRandom(), feature: text("feature").notNull(), status: text("status").notNull().default("draft"), exposurePercent: numeric("exposure_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  target: jsonObject("target"), exclusions: jsonArray("exclusions"), rollbackThreshold: numeric("rollback_threshold", { precision: 5, scale: 2 }), ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }), createdAt, updatedAt,
}, (table) => [uniqueIndex("platform_rollout_rules_feature_unique").on(table.feature)]);
export const platformOperatorAuditEvents = pgTable("platform_operator_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(), actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }), action: text("action").notNull(),
  targetType: text("target_type").notNull(), targetId: text("target_id").notNull(), auditNote: text("audit_note").notNull(), before: jsonObject("before"), after: jsonObject("after"),
  idempotencyKey: text("idempotency_key").notNull(), createdAt,
}, (table) => [uniqueIndex("platform_operator_audit_idempotency_unique").on(table.idempotencyKey), index("platform_operator_audit_created_idx").on(table.createdAt)]);

export const cloudSchema = {
  tenants,
  users,
  authSessions,
  authAccounts,
  authVerifications,
  tenantMemberships,
  departments,
  departmentMemberships,
  tenantHostnames,
  ssoConnections,
  scimIdentities,
  rolePermissionDefaults,
  resourceAcls,
  featureFlags,
  workspaces,
  tasks,
  sessions,
  messages,
  messageParts,
  fileBlobs,
  files,
  fileLibraryEntries,
  fileAssociations,
  fileUploads,
  fileDerivatives,
  memorySettings,
  memoryItems,
  memoryItemVersions,
  workspaceFiles,
  knowledgeSources,
  knowledgeChunks,
  retrievalSnapshots,
  sessionEntries,
  sessionCheckpoints,
  sessionCompactionLeases,
  turnAdmissionIntents,
  turnRuns,
  turnSteps,
  turnEvents,
  runtimeOutbox,
  sandboxSnapshots,
  maintenanceRuns,
  toolCalls,
  approvals,
  turnQuestions,
  usageEvents,
  usageRollups,
  budgetLimits,
  budgetReservations,
  creditLedgerEntries,
  budgetCounterSnapshots,
  billingCreditGrants,
  billingMeterEvents,
  billingInvoices,
  modelGovernancePolicies,
  modelModeDefaults,
  policyVersions,
  auditEvents,
  auditSettings,
  auditExportConfigs,
  mobileDevices,
  allowanceProfiles, allowanceDefaultAssignments, allowanceMemberOverrides, allowanceBulkOperations, billingAutoRefillConfigs, savedAnalyticsViews, reportSchedules, reportRuns,
  alertDestinations, alertRules, alertEvents, deliveryAttempts, executionNetworkPolicies, authenticationPolicies,
  dataGovernancePolicies, organizationProfiles, organizationDomains, serviceAccounts, platformRolloutRules, platformOperatorAuditEvents,
};

export const CLOUD_SCHEMA_TABLES = [
  "tenants",
  "users",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
  "tenant_memberships",
  "workspaces",
  "tasks",
  "sessions",
  "messages",
  "message_parts",
  "file_blobs",
  "files",
  "file_library_entries",
  "file_associations",
  "file_uploads",
  "file_derivatives",
  "memory_settings",
  "memory_items",
  "memory_item_versions",
  "workspace_files",
  "knowledge_sources",
  "knowledge_chunks",
  "retrieval_snapshots",
  "session_entries",
  "session_checkpoints",
  "session_compaction_leases",
  "turn_admission_intents",
  "turn_runs",
  "turn_steps",
  "turn_events",
  "runtime_outbox",
  "sandbox_snapshots",
  "maintenance_runs",
  "tool_calls",
  "approvals",
  "turn_questions",
  "usage_events",
  "usage_rollups",
  "audit_events",
] as const;

export const DURABLE_CONTEXT_TABLES = [
  "memory_settings",
  "memory_items",
  "memory_item_versions",
  "workspace_files",
  "knowledge_sources",
  "knowledge_chunks",
  "retrieval_snapshots",
  "session_entries",
  "session_checkpoints",
  "turn_runs",
  "turn_steps",
  "turn_events",
  "runtime_outbox",
  "sandbox_snapshots",
] as const;

export const TENANT_SCOPED_TABLES = [
  "tenant_memberships",
  "workspaces",
  "tasks",
  "sessions",
  "messages",
  "message_parts",
  "file_blobs",
  "files",
  "file_library_entries",
  "file_associations",
  "file_uploads",
  "file_derivatives",
  ...DURABLE_CONTEXT_TABLES,
  "turn_admission_intents",
  "session_compaction_leases",
  "maintenance_runs",
  "tool_calls",
  "approvals",
  "turn_questions",
  "usage_events",
  "usage_rollups",
  "audit_events",
] as const;

export const ENTERPRISE_IDENTITY_TABLES = [
  "departments",
  "department_memberships",
  "tenant_hostnames",
  "sso_connections",
  "scim_identities",
] as const;

export const ENTERPRISE_IDENTITY_TENANT_SCOPED_TABLES = ENTERPRISE_IDENTITY_TABLES;

export const ENTERPRISE_RBAC_TABLES = [
  "role_permission_defaults",
  "resource_acls",
  "feature_flags",
] as const;

export const ENTERPRISE_RBAC_TENANT_SCOPED_TABLES = ENTERPRISE_RBAC_TABLES;

export const BUDGET_LEDGER_TABLES = [
  "budget_limits",
  "budget_reservations",
  "credit_ledger_entries",
  "budget_counter_snapshots",
] as const;

export const BUDGET_LEDGER_TENANT_SCOPED_TABLES = BUDGET_LEDGER_TABLES;

export const MODEL_GOVERNANCE_TABLES = [
  "model_governance_policies",
  "model_mode_defaults",
  "model_conversation_kind_defaults",
] as const;

export const MODEL_GOVERNANCE_TENANT_SCOPED_TABLES = MODEL_GOVERNANCE_TABLES;

export const POLICY_DISTRIBUTION_TABLES = [
  "policy_versions",
] as const;

export const POLICY_DISTRIBUTION_TENANT_SCOPED_TABLES = POLICY_DISTRIBUTION_TABLES;

export const AUDIT_PLATFORM_TABLES = [
  "audit_settings",
  "audit_export_configs",
] as const;

export const AUDIT_PLATFORM_TENANT_SCOPED_TABLES = AUDIT_PLATFORM_TABLES;

export const BILLING_PLATFORM_TABLES = [
  "billing_credit_grants",
  "billing_meter_events",
  "billing_invoices",
] as const;

export const BILLING_PLATFORM_TENANT_SCOPED_TABLES = BILLING_PLATFORM_TABLES;

export const MOBILE_COMPANION_TABLES = [
  "mobile_devices",
] as const;

export const MOBILE_COMPANION_TENANT_SCOPED_TABLES = MOBILE_COMPANION_TABLES;

export const MANAGEMENT_ADMIN_TABLES = [
  "allowance_profiles", "allowance_default_assignments", "allowance_bulk_operations", "billing_auto_refill_configs", "saved_analytics_views", "report_schedules", "report_runs",
  "alert_destinations", "alert_rules", "alert_events", "delivery_attempts", "execution_network_policies",
  "authentication_policies", "data_governance_policies", "organization_profiles", "organization_domains", "service_accounts",
] as const;
export const MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES = MANAGEMENT_ADMIN_TABLES;

export const CLOUD_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE deployment_mode AS ENUM ('shared', 'dedicated', 'selfhost');
CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE user_status AS ENUM ('active', 'disabled', 'deleted');
CREATE TYPE task_status AS ENUM ('queued', 'running', 'waiting-for-approval', 'cancelled', 'failed', 'completed');
CREATE TYPE session_status AS ENUM ('active', 'compacted', 'forked', 'rewound', 'archived');
CREATE TYPE permission_mode AS ENUM ('ask', 'auto-edit', 'plan', 'full-access');
CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
CREATE TYPE message_status AS ENUM ('streaming', 'complete', 'cancelled', 'failed');
CREATE TYPE message_part_kind AS ENUM ('text', 'code', 'reasoning', 'tool-call', 'tool-result', 'image', 'attachment', 'terminal', 'browser-screenshot', 'error');
CREATE TYPE tool_call_status AS ENUM ('pending', 'waiting-for-approval', 'running', 'cancelled', 'denied', 'failed', 'completed');
CREATE TYPE approval_kind AS ENUM ('file-edit', 'shell', 'terminal', 'mcp', 'browser', 'credential', 'workspace-trust');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'denied', 'expired');
CREATE TYPE ui_mode AS ENUM ('chat', 'code', 'cowork');
CREATE TYPE ui_mode_source AS ENUM ('classifier', 'agent', 'user');
CREATE TYPE conversation_kind AS ENUM ('chat', 'code');
CREATE TYPE workspace_kind AS ENUM ('project', 'general');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  deployment_mode deployment_mode NOT NULL DEFAULT 'selfhost',
  plan text NOT NULL DEFAULT 'selfhost',
  status tenant_status NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  avatar_url text,
  status user_status NOT NULL DEFAULT 'active',
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  default_group_id uuid,
  joined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_idx ON tenant_memberships (user_id);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_kind workspace_kind NOT NULL DEFAULT 'project',
  name text NOT NULL,
  slug text NOT NULL,
  trust_state text NOT NULL DEFAULT 'untrusted',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX workspaces_tenant_updated_idx ON workspaces (tenant_id, updated_at DESC);
CREATE UNIQUE INDEX workspaces_tenant_owner_general_unique ON workspaces (tenant_id, owner_id) WHERE workspace_kind = 'general' AND deleted_at IS NULL;

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  status task_status NOT NULL DEFAULT 'queued',
  active_session_id uuid,
  conversation_kind conversation_kind NOT NULL DEFAULT 'chat',
  ui_mode ui_mode,
  ui_mode_pinned boolean NOT NULL DEFAULT false,
  ui_mode_source ui_mode_source,
  pinned boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  worktree_path text,
  worktree_branch text,
  worktree_base_ref text,
  worktree_base_sha text,
  pull_request_url text,
  pull_request_number integer,
  unread_at timestamptz,
  last_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX tasks_tenant_workspace_updated_idx ON tasks (tenant_id, workspace_id, updated_at DESC);
CREATE INDEX tasks_tenant_status_idx ON tasks (tenant_id, status);
CREATE INDEX tasks_tenant_workspace_kind_updated_idx ON tasks (tenant_id, workspace_id, conversation_kind, updated_at DESC);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status session_status NOT NULL DEFAULT 'active',
  model_provider_id text,
  model text,
  permission_mode permission_mode NOT NULL DEFAULT 'full-access',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX sessions_tenant_task_updated_idx ON sessions (tenant_id, task_id, updated_at DESC);
CREATE INDEX sessions_tenant_parent_idx ON sessions (tenant_id, parent_session_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  role message_role NOT NULL,
  status message_status NOT NULL DEFAULT 'complete',
  model text,
  finish_reason text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  generation_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_tenant_session_sequence_idx ON messages (tenant_id, session_id, sequence_id);
CREATE INDEX messages_tenant_task_created_idx ON messages (tenant_id, task_id, created_at);

CREATE TABLE message_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type message_part_kind NOT NULL,
  content jsonb NOT NULL,
  ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, ordinal)
);
CREATE INDEX message_parts_tenant_message_idx ON message_parts (tenant_id, message_id);

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  status tool_call_status NOT NULL DEFAULT 'pending',
  input jsonb NOT NULL,
  output jsonb,
  children jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_trace jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_tenant_session_idx ON tool_calls (tenant_id, session_id);
CREATE INDEX tool_calls_tenant_message_idx ON tool_calls (tenant_id, message_id);
CREATE INDEX tool_calls_tenant_status_idx ON tool_calls (tenant_id, status);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  kind approval_kind NOT NULL,
  status approval_status NOT NULL DEFAULT 'pending',
  request jsonb NOT NULL,
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz
);
CREATE INDEX approvals_tenant_status_created_idx ON approvals (tenant_id, status, created_at);
CREATE INDEX approvals_tenant_task_idx ON approvals (tenant_id, task_id);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  idempotency_key text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  feature text NOT NULL,
  provider text,
  model text,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  tokens_cached integer NOT NULL DEFAULT 0,
  sandbox_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_raw_micros numeric(20, 0) NOT NULL DEFAULT 0,
  cost_billed_micros numeric(20, 0) NOT NULL DEFAULT 0,
  latency_ms integer,
  ttft_ms integer,
  status text NOT NULL DEFAULT 'completed',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ts timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_nonnegative_tokens CHECK (tokens_in >= 0 AND tokens_out >= 0 AND tokens_cached >= 0),
  UNIQUE (tenant_id, request_id)
);
CREATE INDEX usage_events_tenant_ts_idx ON usage_events (tenant_id, ts DESC);

CREATE TABLE usage_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  granularity text NOT NULL DEFAULT 'day',
  feature text NOT NULL,
  provider text,
  model text,
  status text NOT NULL DEFAULT 'completed',
  request_count integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  tokens_cached integer NOT NULL DEFAULT 0,
  cost_raw_micros numeric(20, 0) NOT NULL DEFAULT 0,
  cost_billed_micros numeric(20, 0) NOT NULL DEFAULT 0,
  latency_ms_total integer NOT NULL DEFAULT 0,
  latency_ms_count integer NOT NULL DEFAULT 0,
  ttft_ms_total integer NOT NULL DEFAULT 0,
  ttft_ms_count integer NOT NULL DEFAULT 0,
  source_event_min_ts timestamptz,
  source_event_max_ts timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_rollups_nonnegative_counts CHECK (request_count >= 0 AND tokens_in >= 0 AND tokens_out >= 0 AND tokens_cached >= 0),
  UNIQUE (tenant_id, bucket_start, granularity, feature, provider, model, status)
);
CREATE INDEX usage_rollups_tenant_bucket_idx ON usage_rollups (tenant_id, bucket_start DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  category text NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  before jsonb,
  after jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash text NOT NULL,
  event_hash text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sequence)
);
CREATE INDEX audit_events_tenant_ts_idx ON audit_events (tenant_id, ts DESC);
CREATE INDEX audit_events_tenant_session_idx ON audit_events (tenant_id, session_id);

ALTER TABLE tasks ADD CONSTRAINT tasks_active_session_fk FOREIGN KEY (active_session_id) REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_approval_fk FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL;
`.trim();

export const TENANT_CONTEXT_SQL = `
CREATE OR REPLACE FUNCTION berry_current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('berry.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION berry_set_tenant_id(target_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('berry.tenant_id', target_tenant_id::text, true);
END;
$$;
`.trim();

export function tenantRlsSql(tableName: string): string {
  return `
ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${tableName}_tenant_isolation ON ${tableName}
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();
}

// Migration 1 can only reference the tables it creates. Keep this frozen while
// TENANT_SCOPED_TABLES continues to describe the complete live schema.
const INITIAL_TENANT_SCOPED_TABLES = [
  "tenant_memberships",
  "workspaces",
  "tasks",
  "sessions",
  "messages",
  "message_parts",
  "tool_calls",
  "approvals",
  "usage_events",
  "usage_rollups",
  "audit_events",
] as const;
const INITIAL_TENANT_RLS_SQL = INITIAL_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n");
export const TENANT_RLS_SQL = TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n");

export const APPEND_ONLY_SQL = `
CREATE OR REPLACE FUNCTION berry_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER usage_events_reject_update
BEFORE UPDATE ON usage_events
FOR EACH ROW EXECUTE FUNCTION berry_reject_append_only_mutation();

CREATE TRIGGER usage_events_reject_delete
BEFORE DELETE ON usage_events
FOR EACH ROW EXECUTE FUNCTION berry_reject_append_only_mutation();

CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION berry_reject_append_only_mutation();

CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION berry_reject_append_only_mutation();
`.trim();

export const SELF_HOST_SEED_SQL = `
INSERT INTO tenants (id, name, slug, deployment_mode, plan, status, settings)
VALUES ('${SELF_HOST_TENANT_ID}', 'Berry Self-Host', '${SELF_HOST_TENANT_SLUG}', 'selfhost', 'selfhost', 'active', '{"singleTenant":true}'::jsonb)
ON CONFLICT (id) DO UPDATE
SET name = excluded.name,
    slug = excluded.slug,
    deployment_mode = excluded.deployment_mode,
    plan = excluded.plan,
    status = excluded.status,
    settings = tenants.settings || excluded.settings,
    updated_at = now();

INSERT INTO workspaces (id, tenant_id, name, slug, trust_state, settings)
VALUES ('${SELF_HOST_WORKSPACE_ID}', '${SELF_HOST_TENANT_ID}', 'Default Workspace', '${SELF_HOST_WORKSPACE_SLUG}', 'trusted', '{"selfHostDefault":true}'::jsonb)
ON CONFLICT (tenant_id, slug) DO UPDATE
SET name = excluded.name,
    trust_state = excluded.trust_state,
    settings = workspaces.settings || excluded.settings,
    updated_at = now();
`.trim();

export const CLOUD_INITIAL_MIGRATION = [
  CLOUD_SCHEMA_SQL,
  TENANT_CONTEXT_SQL,
  INITIAL_TENANT_RLS_SQL,
  APPEND_ONLY_SQL,
  SELF_HOST_SEED_SQL,
].join("\n\n");

export const BETTER_AUTH_MINIMAL_MIGRATION = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  id_token text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX IF NOT EXISTS auth_accounts_user_idx ON auth_accounts (user_id);

CREATE TABLE IF NOT EXISTS auth_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications (identifier);
`.trim();

export const USAGE_ROLLUPS_MIGRATION = `
CREATE TABLE IF NOT EXISTS usage_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  granularity text NOT NULL DEFAULT 'day',
  feature text NOT NULL,
  provider text,
  model text,
  status text NOT NULL DEFAULT 'completed',
  request_count integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  tokens_cached integer NOT NULL DEFAULT 0,
  cost_raw_micros numeric(20, 0) NOT NULL DEFAULT 0,
  cost_billed_micros numeric(20, 0) NOT NULL DEFAULT 0,
  latency_ms_total integer NOT NULL DEFAULT 0,
  latency_ms_count integer NOT NULL DEFAULT 0,
  ttft_ms_total integer NOT NULL DEFAULT 0,
  ttft_ms_count integer NOT NULL DEFAULT 0,
  source_event_min_ts timestamptz,
  source_event_max_ts timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_rollups_nonnegative_counts CHECK (request_count >= 0 AND tokens_in >= 0 AND tokens_out >= 0 AND tokens_cached >= 0),
  UNIQUE (tenant_id, bucket_start, granularity, feature, provider, model, status)
);
CREATE INDEX IF NOT EXISTS usage_rollups_tenant_bucket_idx ON usage_rollups (tenant_id, bucket_start DESC);
`.trim();

export const ENTERPRISE_IDENTITY_MIGRATION = `
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS deprovisioned_at timestamptz;

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  slug text NOT NULL,
  external_id text,
  status text NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS departments_tenant_parent_idx ON departments (tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS department_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  source text NOT NULL DEFAULT 'manual',
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, department_id, user_id)
);
CREATE INDEX IF NOT EXISTS department_memberships_tenant_user_idx ON department_memberships (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS tenant_hostnames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE,
  deployment_mode deployment_mode NOT NULL DEFAULT 'dedicated',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_hostnames_tenant_idx ON tenant_hostnames (tenant_id);

CREATE TABLE IF NOT EXISTS sso_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('saml', 'oidc')),
  provider text NOT NULL DEFAULT 'generic',
  slug text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  issuer text,
  sso_url text,
  metadata_url text,
  entity_id text,
  client_id text,
  client_secret_ref text,
  client_secret_envelope jsonb,
  certificate text,
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  jit_provisioning boolean NOT NULL DEFAULT true,
  default_role text NOT NULL DEFAULT 'member' CHECK (default_role IN ('member')),
  scim_enabled boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS sso_connections_tenant_status_idx ON sso_connections (tenant_id, status);

CREATE TABLE IF NOT EXISTS scim_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('User', 'Group')),
  external_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deprovisioned_at timestamptz,
  UNIQUE (tenant_id, resource_type, external_id)
);
CREATE INDEX IF NOT EXISTS scim_identities_tenant_user_idx ON scim_identities (tenant_id, user_id);

${ENTERPRISE_IDENTITY_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const GOOGLE_WORKSPACE_SSO_MIGRATION = `
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'generic';
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS client_secret_envelope jsonb;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS jit_provisioning boolean NOT NULL DEFAULT true;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS default_role text NOT NULL DEFAULT 'member';
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS last_error_code text;

DO $$ BEGIN
  ALTER TABLE sso_connections
    ADD CONSTRAINT sso_connections_default_role_check CHECK (default_role IN ('member'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sso_connections_tenant_provider_enabled_unique
  ON sso_connections (tenant_id, provider)
  WHERE status = 'enabled' AND provider <> 'generic';
`.trim();

export const ENTERPRISE_RBAC_MIGRATION = `
CREATE TABLE IF NOT EXISTS role_permission_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, role)
);
CREATE INDEX IF NOT EXISTS role_permission_defaults_tenant_source_idx ON role_permission_defaults (tenant_id, source);

CREATE TABLE IF NOT EXISTS resource_acls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'role', 'department')),
  principal_id text NOT NULL,
  allow jsonb NOT NULL DEFAULT '[]'::jsonb,
  deny jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS resource_acls_tenant_principal_idx ON resource_acls (tenant_id, principal_type, principal_id);

CREATE TABLE IF NOT EXISTS feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  role_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, flag)
);
CREATE INDEX IF NOT EXISTS feature_flags_tenant_enabled_idx ON feature_flags (tenant_id, enabled);

INSERT INTO role_permission_defaults (tenant_id, role, permissions, source)
SELECT id, 'owner', '["org:read","org:admin","departments:read","departments:write","sso:read","sso:write","rbac:read","rbac:write","feature_flags:read","feature_flags:write","acl:read","acl:write"]'::jsonb, 'system'
FROM tenants
ON CONFLICT (tenant_id, role) DO NOTHING;

INSERT INTO role_permission_defaults (tenant_id, role, permissions, source)
SELECT id, 'admin', '["org:read","org:admin","departments:read","departments:write","sso:read","sso:write","rbac:read","feature_flags:read","acl:read"]'::jsonb, 'system'
FROM tenants
ON CONFLICT (tenant_id, role) DO NOTHING;

INSERT INTO role_permission_defaults (tenant_id, role, permissions, source)
SELECT id, 'member', '["org:read","departments:read","sso:read"]'::jsonb, 'system'
FROM tenants
ON CONFLICT (tenant_id, role) DO NOTHING;

INSERT INTO feature_flags (tenant_id, flag, enabled, role_defaults)
SELECT id, 'enterprise-governance', true, '{"owner":["budgets:read","budgets:write","models:read","models:write","policy:read","policy:write","audit:read","audit:export"],"admin":["budgets:read","budgets:write","models:read","models:write","policy:read","audit:read"],"member":["models:read"]}'::jsonb
FROM tenants
ON CONFLICT (tenant_id, flag) DO NOTHING;

${ENTERPRISE_RBAC_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const BUDGET_LEDGER_MIGRATION = `
CREATE TABLE IF NOT EXISTS budget_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'department', 'user')),
  scope_id text NOT NULL,
  period text NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'month')),
  soft_limit_micros numeric(20, 0) NOT NULL DEFAULT 0,
  hard_limit_micros numeric(20, 0) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_limits_nonnegative CHECK (soft_limit_micros >= 0 AND hard_limit_micros >= 0),
  UNIQUE (tenant_id, scope_type, scope_id, period)
);
CREATE INDEX IF NOT EXISTS budget_limits_tenant_status_idx ON budget_limits (tenant_id, status);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  feature text NOT NULL,
  provider text,
  model text,
  estimated_cost_micros numeric(20, 0) NOT NULL DEFAULT 0,
  reserved_micros numeric(20, 0) NOT NULL DEFAULT 0,
  actual_cost_micros numeric(20, 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'reconciled', 'released', 'blocked')),
  block_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_reservations_nonnegative CHECK (estimated_cost_micros >= 0 AND reserved_micros >= 0 AND (actual_cost_micros IS NULL OR actual_cost_micros >= 0)),
  UNIQUE (tenant_id, request_id)
);
CREATE INDEX IF NOT EXISTS budget_reservations_tenant_status_idx ON budget_reservations (tenant_id, status);
CREATE INDEX IF NOT EXISTS budget_reservations_tenant_user_idx ON budget_reservations (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'department', 'user')),
  scope_id text NOT NULL,
  reservation_id uuid REFERENCES budget_reservations(id) ON DELETE SET NULL,
  request_id text,
  kind text NOT NULL CHECK (kind IN ('credit', 'reserve', 'release', 'reconcile')),
  amount_micros numeric(20, 0) NOT NULL,
  balance_after_micros numeric(20, 0) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id, scope_type, scope_id, kind)
);
CREATE INDEX IF NOT EXISTS credit_ledger_entries_tenant_scope_idx ON credit_ledger_entries (tenant_id, scope_type, scope_id, created_at);

CREATE TABLE IF NOT EXISTS budget_counter_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'department', 'user')),
  scope_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  spent_micros numeric(20, 0) NOT NULL DEFAULT 0,
  reserved_micros numeric(20, 0) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'redis',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_counter_snapshots_nonnegative CHECK (spent_micros >= 0 AND reserved_micros >= 0),
  UNIQUE (tenant_id, scope_type, scope_id, period_start)
);

INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, status)
SELECT id, 'org', id::text, 'month', 0, 0, 'disabled'
FROM tenants
ON CONFLICT (tenant_id, scope_type, scope_id, period) DO NOTHING;

${BUDGET_LEDGER_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const USAGE_PIPELINE_MIGRATION = `
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api';
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS signed_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS signature jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS usage_events_tenant_feature_ts_idx ON usage_events (tenant_id, feature, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_tenant_user_ts_idx ON usage_events (tenant_id, user_id, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_tenant_department_ts_idx ON usage_events (tenant_id, department_id, ts DESC);
`.trim();

export const MODEL_GOVERNANCE_MIGRATION = `
CREATE TABLE IF NOT EXISTS model_governance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  model text NOT NULL,
  display_name text,
  preset_id text,
  api_type text CHECK (api_type IS NULL OR api_type IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'blocked')),
  enforce boolean NOT NULL DEFAULT false,
  mode_allow jsonb NOT NULL DEFAULT '["chat","code"]'::jsonb,
  kind_allow jsonb NOT NULL DEFAULT '["chat","code"]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_id, model)
);
CREATE INDEX IF NOT EXISTS model_governance_policies_tenant_status_idx ON model_governance_policies (tenant_id, status);
CREATE INDEX IF NOT EXISTS model_governance_policies_tenant_enforce_idx ON model_governance_policies (tenant_id, enforce);

CREATE TABLE IF NOT EXISTS model_mode_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('chat', 'code')),
  provider_id text NOT NULL,
  model text NOT NULL,
  enforce boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mode)
);
CREATE INDEX IF NOT EXISTS model_mode_defaults_tenant_provider_idx ON model_mode_defaults (tenant_id, provider_id);

CREATE TABLE IF NOT EXISTS model_conversation_kind_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_kind conversation_kind NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  enforce boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_kind)
);
CREATE INDEX IF NOT EXISTS model_conversation_kind_defaults_tenant_provider_idx
  ON model_conversation_kind_defaults (tenant_id, provider_id);

INSERT INTO model_governance_policies (tenant_id, provider_id, model, display_name, preset_id, api_type, capabilities, status, enforce, mode_allow, metadata)
SELECT id, 'router', 'berry/auto', 'Berry Router Auto', 'berry-router', 'openai-chat-completions', '{"tools":true,"vision":true,"reasoning":true}'::jsonb, 'allowed', false, '["chat","code"]'::jsonb, '{"source":"self-host-seed"}'::jsonb
FROM tenants
WHERE NOT EXISTS (
  SELECT 1 FROM model_governance_policies existing WHERE existing.tenant_id = tenants.id
)
ON CONFLICT (tenant_id, provider_id, model) DO NOTHING;

INSERT INTO model_mode_defaults (tenant_id, mode, provider_id, model, enforce)
SELECT id, mode, 'router', 'berry/auto', false
FROM tenants
CROSS JOIN (VALUES ('chat'), ('code')) AS defaults(mode)
ON CONFLICT (tenant_id, mode) DO NOTHING;

INSERT INTO model_conversation_kind_defaults (tenant_id, conversation_kind, provider_id, model, enforce)
SELECT id, conversation_kind::conversation_kind, 'router', 'berry/auto', false
FROM tenants
CROSS JOIN (VALUES ('chat'), ('code')) AS defaults(conversation_kind)
ON CONFLICT (tenant_id, conversation_kind) DO NOTHING;

${MODEL_GOVERNANCE_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const POLICY_DISTRIBUTION_MIGRATION = `
CREATE TABLE IF NOT EXISTS policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'revoked')),
  bundle jsonb NOT NULL,
  bundle_hash text NOT NULL,
  key_id text NOT NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  audit_event_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS policy_versions_tenant_active_unique ON policy_versions (tenant_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS policy_versions_tenant_published_idx ON policy_versions (tenant_id, published_at DESC);

${POLICY_DISTRIBUTION_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const AUDIT_PLATFORM_MIGRATION = `
CREATE TABLE IF NOT EXISTS audit_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days >= 1 AND retention_days <= 3650),
  client_ingest_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS audit_export_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('webhook', 's3')),
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  destination text NOT NULL,
  format text NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'csv')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_exported_at timestamptz,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, destination)
);
CREATE INDEX IF NOT EXISTS audit_export_configs_tenant_status_idx ON audit_export_configs (tenant_id, status);

INSERT INTO audit_settings (tenant_id, retention_days, client_ingest_enabled)
SELECT id, 90, false
FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

${AUDIT_PLATFORM_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const BILLING_PLATFORM_MIGRATION = `
CREATE TABLE IF NOT EXISTS billing_credit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('stripe', 'manual', 'support', 'fixture')),
  amount_micros numeric(20, 0) NOT NULL,
  remaining_micros numeric(20, 0) NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  external_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided', 'exhausted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_credit_grants_nonnegative CHECK (amount_micros >= 0 AND remaining_micros >= 0),
  UNIQUE (tenant_id, external_ref)
);
CREATE INDEX IF NOT EXISTS billing_credit_grants_tenant_status_idx ON billing_credit_grants (tenant_id, status);

CREATE TABLE IF NOT EXISTS billing_meter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_event_id uuid REFERENCES usage_events(id) ON DELETE SET NULL,
  request_id text NOT NULL,
  meter text NOT NULL,
  quantity numeric(20, 0) NOT NULL,
  cost_billed_micros numeric(20, 0) NOT NULL DEFAULT 0,
  provider text NOT NULL DEFAULT 'none' CHECK (provider IN ('none', 'stripe', 'lago')),
  external_event_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reported', 'skipped', 'failed')),
  reported_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_meter_events_nonnegative CHECK (quantity >= 0 AND cost_billed_micros >= 0),
  UNIQUE (tenant_id, request_id, meter),
  UNIQUE (tenant_id, external_event_id)
);
CREATE INDEX IF NOT EXISTS billing_meter_events_tenant_status_idx ON billing_meter_events (tenant_id, status);
CREATE INDEX IF NOT EXISTS billing_meter_events_tenant_created_idx ON billing_meter_events (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'none' CHECK (provider IN ('none', 'stripe', 'lago')),
  external_invoice_id text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  total_micros numeric(20, 0) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  hosted_invoice_url text,
  period_start timestamptz,
  period_end timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_invoices_nonnegative CHECK (total_micros >= 0),
  UNIQUE (tenant_id, external_invoice_id)
);
CREATE INDEX IF NOT EXISTS billing_invoices_tenant_status_idx ON billing_invoices (tenant_id, status);

INSERT INTO billing_credit_grants (tenant_id, source, amount_micros, remaining_micros, currency, external_ref, status, metadata)
SELECT id, 'fixture', 0, 0, 'usd', 'self-host-no-billing', 'active', '{"selfHostNoBillingDependency":true}'::jsonb
FROM tenants
WHERE deployment_mode = 'selfhost'
ON CONFLICT (tenant_id, external_ref) DO NOTHING;

${BILLING_PLATFORM_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const MOBILE_COMPANION_MIGRATION = `
CREATE TABLE IF NOT EXISTS mobile_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'expo')),
  push_provider text NOT NULL DEFAULT 'none' CHECK (push_provider IN ('expo', 'apns', 'fcm', 'none')),
  push_token_ciphertext text,
  push_token_last4 text,
  endpoint_mode text NOT NULL CHECK (endpoint_mode IN ('berry-account', 'self-hosted', 'custom-openai', 'lan-local')),
  app_version text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id)
);
CREATE INDEX IF NOT EXISTS mobile_devices_tenant_user_idx ON mobile_devices (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS mobile_devices_tenant_status_idx ON mobile_devices (tenant_id, status);

${MOBILE_COMPANION_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION = `
DO $$ BEGIN
  CREATE TYPE conversation_kind AS ENUM ('chat', 'code');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE workspace_kind AS ENUM ('project', 'general');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS workspace_kind workspace_kind NOT NULL DEFAULT 'project';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS conversation_kind conversation_kind NOT NULL DEFAULT 'chat';
UPDATE tasks
SET conversation_kind = CASE
  WHEN ui_mode = 'code' THEN 'code'::conversation_kind
  WHEN ui_mode IN ('chat', 'cowork') THEN 'chat'::conversation_kind
  WHEN ui_mode IS NULL AND worktree_path IS NOT NULL AND btrim(worktree_path) <> '' THEN 'code'::conversation_kind
  ELSE 'chat'::conversation_kind
END;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_tenant_owner_general_unique
  ON workspaces (tenant_id, owner_id)
  WHERE workspace_kind = 'general' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_tenant_workspace_kind_updated_idx
  ON tasks (tenant_id, workspace_id, conversation_kind, updated_at DESC);

ALTER TABLE model_governance_policies ADD COLUMN IF NOT EXISTS kind_allow jsonb NOT NULL DEFAULT '["chat","code"]'::jsonb;
UPDATE model_governance_policies
SET kind_allow = (
  SELECT COALESCE(jsonb_agg(kind ORDER BY kind), '[]'::jsonb)
  FROM (
    SELECT DISTINCT CASE
      WHEN value IN ('chat', 'cowork') THEN 'chat'
      WHEN value = 'code' THEN 'code'
    END AS kind
    FROM jsonb_array_elements_text(mode_allow)
  ) mapped
  WHERE kind IS NOT NULL
);

CREATE TABLE IF NOT EXISTS model_conversation_kind_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_kind conversation_kind NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  enforce boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_kind)
);
CREATE INDEX IF NOT EXISTS model_conversation_kind_defaults_tenant_provider_idx
  ON model_conversation_kind_defaults (tenant_id, provider_id);
INSERT INTO model_conversation_kind_defaults (tenant_id, conversation_kind, provider_id, model, enforce, created_at, updated_at)
SELECT tenant_id, 'chat'::conversation_kind, provider_id, model, enforce, created_at, updated_at
FROM (
  SELECT DISTINCT ON (tenant_id) tenant_id, provider_id, model, enforce, created_at, updated_at,
    CASE mode WHEN 'chat' THEN 0 ELSE 1 END AS preference
  FROM model_mode_defaults
  WHERE mode IN ('chat', 'cowork')
  ORDER BY tenant_id, preference, updated_at DESC
) preferred_chat
ON CONFLICT (tenant_id, conversation_kind) DO NOTHING;
INSERT INTO model_conversation_kind_defaults (tenant_id, conversation_kind, provider_id, model, enforce, created_at, updated_at)
SELECT tenant_id, 'code'::conversation_kind, provider_id, model, enforce, created_at, updated_at
FROM model_mode_defaults
WHERE mode = 'code'
ON CONFLICT (tenant_id, conversation_kind) DO NOTHING;

ALTER TABLE model_conversation_kind_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_conversation_kind_defaults FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_conversation_kind_defaults_tenant_isolation ON model_conversation_kind_defaults;
CREATE POLICY model_conversation_kind_defaults_tenant_isolation ON model_conversation_kind_defaults
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const REMOVE_QUEUED_FOLLOW_UPS_MIGRATION = `
DROP TABLE IF EXISTS queued_follow_ups;
DELETE FROM schema_migrations WHERE id IN (14, 22);
`.trim();

export const MESSAGE_SEQUENCE_MIGRATION = `
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sequence_id bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX IF NOT EXISTS messages_tenant_session_sequence_idx
  ON messages (tenant_id, session_id, sequence_id);
`.trim();

export const MESSAGE_HISTORY_PAGINATION_MIGRATION = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_parts_tenant_message_ordinal_idx
  ON message_parts (tenant_id, message_id, ordinal);
`.trim();

export type MessageHistoryTriggerTable = "messages" | "message_parts";
export type MessageHistoryTriggerOperation = "INSERT" | "UPDATE" | "DELETE";

/**
 * Contract shared by the history-revision migration and its regression tests:
 * every mutation of an existing message/projection invalidates ordinary
 * history, while only a deleted message row invalidates already-loaded
 * cursors. Inserts are discovered by the after-cursor itself and therefore
 * do not force a full loaded-range refresh on every completed turn.
 */
export function messageHistoryRevisionDelta(
  table: MessageHistoryTriggerTable,
  operation: MessageHistoryTriggerOperation,
): { historyRevision: 0 | 1; historyDeletionRevision: 0 | 1 } {
  return {
    historyRevision: operation === "INSERT" ? 0 : 1,
    historyDeletionRevision: table === "messages" && operation === "DELETE" ? 1 : 0,
  };
}

export const MESSAGE_HISTORY_REVISION_MIGRATION = `
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS message_history_revision bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION berry_touch_session_message_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  touched_session_id uuid;
  touched_tenant_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'message_parts' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT session_id, tenant_id INTO touched_session_id, touched_tenant_id
      FROM messages WHERE id = OLD.message_id AND tenant_id = OLD.tenant_id;
    ELSE
      SELECT session_id, tenant_id INTO touched_session_id, touched_tenant_id
      FROM messages WHERE id = NEW.message_id AND tenant_id = NEW.tenant_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    touched_session_id := OLD.session_id;
    touched_tenant_id := OLD.tenant_id;
  ELSE
    touched_session_id := NEW.session_id;
    touched_tenant_id := NEW.tenant_id;
  END IF;
  UPDATE sessions
  SET message_history_revision = message_history_revision + 1,
      updated_at = now()
  WHERE id = touched_session_id AND tenant_id = touched_tenant_id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS sessions_message_history_revision ON messages;
CREATE TRIGGER sessions_message_history_revision
AFTER UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION berry_touch_session_message_history();
DROP TRIGGER IF EXISTS message_parts_history_revision ON message_parts;
CREATE TRIGGER message_parts_history_revision
AFTER UPDATE OR DELETE ON message_parts
FOR EACH ROW EXECUTE FUNCTION berry_touch_session_message_history();
`.trim();

export const MESSAGE_HISTORY_DELETION_REVISION_MIGRATION = `
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS message_history_deletion_revision bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION berry_touch_session_message_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  touched_session_id uuid;
  touched_tenant_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'message_parts' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT session_id, tenant_id INTO touched_session_id, touched_tenant_id
      FROM messages WHERE id = OLD.message_id AND tenant_id = OLD.tenant_id;
    ELSE
      SELECT session_id, tenant_id INTO touched_session_id, touched_tenant_id
      FROM messages WHERE id = NEW.message_id AND tenant_id = NEW.tenant_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    touched_session_id := OLD.session_id;
    touched_tenant_id := OLD.tenant_id;
  ELSE
    touched_session_id := NEW.session_id;
    touched_tenant_id := NEW.tenant_id;
  END IF;
  UPDATE sessions
  SET message_history_revision = message_history_revision + 1,
      message_history_deletion_revision = message_history_deletion_revision + CASE WHEN TG_TABLE_NAME = 'messages' AND TG_OP = 'DELETE' THEN 1 ELSE 0 END,
      updated_at = now()
  WHERE id = touched_session_id AND tenant_id = touched_tenant_id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS sessions_message_history_revision ON messages;
CREATE TRIGGER sessions_message_history_revision
AFTER UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION berry_touch_session_message_history();
`.trim();

/** Keyset pagination and archive/search indexes for enterprise collections. */
export const ENTERPRISE_COLLECTION_PAGINATION_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS workspaces_tenant_owner_updated_id_idx
     ON workspaces (tenant_id, owner_id, updated_at DESC, id ASC)
     WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_tenant_user_updated_id_idx
     ON tasks (tenant_id, user_id, updated_at DESC, id ASC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_tenant_user_archive_updated_id_idx
     ON tasks (tenant_id, user_id, archived, deleted_at, updated_at DESC, id ASC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_tenant_workspace_archive_updated_id_idx
     ON tasks (tenant_id, workspace_id, archived, deleted_at, updated_at DESC, id ASC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_tenant_title_prefix_idx
     ON tasks (tenant_id, lower(title) text_pattern_ops)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS tenant_memberships_tenant_updated_user_idx
     ON tenant_memberships (tenant_id, updated_at DESC, user_id ASC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS users_lower_email_idx
     ON users (lower(email), id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS department_memberships_tenant_user_department_idx
     ON department_memberships (tenant_id, user_id, department_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS departments_tenant_updated_id_idx
     ON departments (tenant_id, updated_at DESC, id ASC)
     WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS departments_tenant_name_id_idx
     ON departments (tenant_id, name ASC, id ASC)
     WHERE deleted_at IS NULL`,
] as const;
export const ENTERPRISE_COLLECTION_PAGINATION_MIGRATION = ENTERPRISE_COLLECTION_PAGINATION_STATEMENTS.join(";\n");

export const SANDBOX_WORKSPACES_MIGRATION = `
CREATE TABLE IF NOT EXISTS sandbox_workspaces (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sandbox_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'recovering', 'failed')),
  root text NOT NULL DEFAULT '/workspace',
  provider text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id)
);
ALTER TABLE sandbox_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sandbox_workspaces_tenant_isolation ON sandbox_workspaces;
CREATE POLICY sandbox_workspaces_tenant_isolation ON sandbox_workspaces
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const PERSONAL_CAPABILITIES_MIGRATION = `
CREATE TABLE IF NOT EXISTS personal_skills (
  id text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id text NOT NULL,
  name text NOT NULL, description text NOT NULL, content text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  trusted boolean NOT NULL DEFAULT false, source text NOT NULL CHECK (source IN ('text', 'upload', 'git')),
  source_url text, version text, hash text NOT NULL, diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_skills_owner_idx ON personal_skills (tenant_id, user_id);
CREATE TABLE IF NOT EXISTS personal_mcp_servers (
  id text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id text NOT NULL,
  name text NOT NULL, url text NOT NULL, transport text NOT NULL CHECK (transport IN ('http-sse', 'streamable-http')),
  auth text NOT NULL CHECK (auth IN ('none', 'bearer', 'oauth')), credential_ref text, credential_envelope jsonb,
  enabled boolean NOT NULL DEFAULT true, trusted boolean NOT NULL DEFAULT false,
  health text NOT NULL DEFAULT 'unknown', tool_count integer NOT NULL DEFAULT 0, last_checked_at timestamptz,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE personal_mcp_servers ADD COLUMN IF NOT EXISTS credential_envelope jsonb;
CREATE INDEX IF NOT EXISTS personal_mcp_servers_owner_idx ON personal_mcp_servers (tenant_id, user_id);
ALTER TABLE personal_skills ENABLE ROW LEVEL SECURITY; ALTER TABLE personal_skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_skills_tenant_isolation ON personal_skills;
CREATE POLICY personal_skills_tenant_isolation ON personal_skills USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
ALTER TABLE personal_mcp_servers ENABLE ROW LEVEL SECURITY; ALTER TABLE personal_mcp_servers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_mcp_servers_tenant_isolation ON personal_mcp_servers;
CREATE POLICY personal_mcp_servers_tenant_isolation ON personal_mcp_servers USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const ORG_CAPABILITIES_MIGRATION = `
CREATE TABLE IF NOT EXISTS organization_capabilities (
  id text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('skill', 'mcp')), capability_id text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
  assignment text NOT NULL CHECK (assignment IN ('required', 'default-on', 'available', 'blocked')),
  allow_user_disable boolean NOT NULL DEFAULT false, content_hash text, config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, kind, capability_id)
);
CREATE TABLE IF NOT EXISTS capability_user_overrides (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('skill', 'mcp')),
  capability_id text NOT NULL, enabled boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, user_id, kind, capability_id)
);
CREATE TABLE IF NOT EXISTS organization_capability_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, allow_personal_skills boolean NOT NULL DEFAULT true,
  allow_personal_mcp boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE organization_capabilities ENABLE ROW LEVEL SECURITY; ALTER TABLE organization_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_user_overrides ENABLE ROW LEVEL SECURITY; ALTER TABLE capability_user_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_capability_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE organization_capability_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_capabilities_tenant_isolation ON organization_capabilities USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
CREATE POLICY capability_user_overrides_tenant_isolation ON capability_user_overrides USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
CREATE POLICY organization_capability_settings_tenant_isolation ON organization_capability_settings USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const SKILL_PACKAGE_FILES_MIGRATION = `
CREATE UNIQUE INDEX IF NOT EXISTS personal_skills_tenant_id_id_unique ON personal_skills (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS organization_capabilities_tenant_id_id_unique ON organization_capabilities (tenant_id, id);
CREATE TABLE IF NOT EXISTS personal_skill_files (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  path text NOT NULL,
  content bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mode integer NOT NULL DEFAULT 420 CHECK (mode >= 0 AND mode <= 511),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, path),
  FOREIGN KEY (tenant_id, skill_id) REFERENCES personal_skills(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS personal_skill_files_owner_idx ON personal_skill_files (tenant_id, skill_id);
ALTER TABLE personal_skill_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_skill_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_skill_files_tenant_isolation ON personal_skill_files;
CREATE POLICY personal_skill_files_tenant_isolation ON personal_skill_files
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());

CREATE TABLE IF NOT EXISTS organization_skill_files (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization_capability_id text NOT NULL,
  path text NOT NULL,
  content bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mode integer NOT NULL DEFAULT 420 CHECK (mode >= 0 AND mode <= 511),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_capability_id, path),
  FOREIGN KEY (tenant_id, organization_capability_id) REFERENCES organization_capabilities(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS organization_skill_files_owner_idx ON organization_skill_files (tenant_id, organization_capability_id);
ALTER TABLE organization_skill_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_skill_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_skill_files_tenant_isolation ON organization_skill_files;
CREATE POLICY organization_skill_files_tenant_isolation ON organization_skill_files
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const TURN_ADMISSION_INTENTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS turn_admission_intents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  operation_fingerprint text,
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing','admitted','cancelled')),
  run_id uuid REFERENCES turn_runs(id) ON DELETE SET NULL,
  preparation_ms integer CHECK (preparation_ms IS NULL OR preparation_ms >= 0),
  admitted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id)
);
CREATE INDEX IF NOT EXISTS turn_admission_intents_session_idx
  ON turn_admission_intents (tenant_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS turn_admission_intents_state_idx
  ON turn_admission_intents (tenant_id, state, updated_at);
ALTER TABLE turn_admission_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_admission_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS turn_admission_intents_tenant_isolation ON turn_admission_intents;
CREATE POLICY turn_admission_intents_tenant_isolation ON turn_admission_intents
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const DEEP_RESEARCH_SKILL_MIGRATION = `
DO $berry_deep_research$
DECLARE
  target_tenant record;
  legacy_skill record;
  package_file record;
  migrated_content text;
  package_payload bytea;
  migrated_hash text;
BEGIN
  FOR target_tenant IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM berry_set_tenant_id(target_tenant.id);
    SELECT * INTO legacy_skill
    FROM organization_capabilities
    WHERE tenant_id = target_tenant.id
      AND kind = 'skill'
      AND capability_id = 'research';

    IF FOUND THEN
      IF EXISTS (
        SELECT 1 FROM organization_capabilities
        WHERE tenant_id = target_tenant.id
          AND kind = 'skill'
          AND capability_id = 'deep-research'
      ) THEN
        -- Preserve both packages when an administrator already created the replacement,
        -- but ensure the legacy broad trigger can no longer be invoked.
        UPDATE organization_capabilities
        SET assignment = 'blocked', allow_user_disable = false, updated_at = now()
        WHERE id = legacy_skill.id;
      ELSE
        migrated_content := legacy_skill.config->>'content';
        migrated_hash := NULL;
        IF migrated_content IS NOT NULL THEN
          migrated_content := regexp_replace(
            migrated_content,
            '^[ \\t]*name:[^\\n\\r]*\\r?$',
            'name: deep-research',
            'im'
          );
          migrated_content := regexp_replace(
            migrated_content,
            '^[ \\t]*description:[^\\n\\r]*\\r?$',
            'description: Conduct deep, extensive, multi-source research only when explicitly requested.',
            'im'
          );
          package_payload := convert_to('SKILL.md', 'UTF8')
            || decode('00', 'hex')
            || convert_to(migrated_content, 'UTF8');
          FOR package_file IN
            SELECT path, content
            FROM organization_skill_files
            WHERE organization_capability_id = legacy_skill.id
            ORDER BY path COLLATE "C"
          LOOP
            package_payload := package_payload
              || decode('00', 'hex')
              || convert_to(package_file.path, 'UTF8')
              || decode('00', 'hex')
              || package_file.content;
          END LOOP;
          migrated_hash := encode(digest(package_payload, 'sha256'), 'hex');
        END IF;

        INSERT INTO capability_user_overrides (
          tenant_id, user_id, kind, capability_id, enabled, updated_at
        )
        SELECT tenant_id, user_id, kind, 'deep-research', enabled, updated_at
        FROM capability_user_overrides
        WHERE tenant_id = target_tenant.id
          AND kind = 'skill'
          AND capability_id = 'research'
        ON CONFLICT (tenant_id, user_id, kind, capability_id) DO UPDATE
        SET enabled = CASE
              WHEN EXCLUDED.updated_at >= capability_user_overrides.updated_at
                THEN EXCLUDED.enabled
              ELSE capability_user_overrides.enabled
            END,
            updated_at = GREATEST(EXCLUDED.updated_at, capability_user_overrides.updated_at);

        DELETE FROM capability_user_overrides
        WHERE tenant_id = target_tenant.id
          AND kind = 'skill'
          AND capability_id = 'research';

        UPDATE organization_capabilities
        SET capability_id = 'deep-research',
            name = 'deep-research',
            description = 'Conduct deep, extensive, multi-source research only when explicitly requested.',
            config = CASE
              WHEN migrated_content IS NULL THEN config
              ELSE jsonb_set(config, '{content}', to_jsonb(migrated_content), false)
            END,
            content_hash = migrated_hash,
            updated_at = now()
        WHERE id = legacy_skill.id;
      END IF;
    END IF;
  END LOOP;
  PERFORM set_config('berry.tenant_id', '', true);
END;
$berry_deep_research$;
`.trim();

export const TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION = `
ALTER TABLE model_governance_policies ALTER COLUMN mode_allow SET DEFAULT '["chat","code"]'::jsonb;
UPDATE model_governance_policies
SET mode_allow = (
  SELECT jsonb_agg(value ORDER BY value)
  FROM (
    SELECT DISTINCT CASE WHEN value = 'cowork' THEN 'chat' ELSE value END AS value
    FROM jsonb_array_elements_text(mode_allow)
  ) normalized
)
WHERE mode_allow ? 'cowork';
INSERT INTO model_mode_defaults (tenant_id, mode, provider_id, model, enforce, updated_at)
SELECT tenant_id, 'chat', provider_id, model, enforce, updated_at
FROM model_mode_defaults
WHERE mode = 'cowork'
ON CONFLICT (tenant_id, mode) DO NOTHING;
DELETE FROM model_mode_defaults WHERE mode = 'cowork';
`.trim();

export const MANAGEMENT_ADMIN_MIGRATION = `
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS sandbox_id text;
ALTER TABLE usage_rollups ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE usage_rollups ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE usage_rollups ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE usage_rollups ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE usage_rollups ADD COLUMN IF NOT EXISTS sandbox_id text;
DROP INDEX IF EXISTS usage_rollups_tenant_bucket_dimension_unique;
CREATE UNIQUE INDEX usage_rollups_tenant_bucket_dimension_unique
ON usage_rollups (tenant_id, bucket_start, granularity, feature, provider, model, status, user_id, department_id, workspace_id, agent_id, sandbox_id) NULLS NOT DISTINCT;
ALTER TABLE budget_limits ADD COLUMN IF NOT EXISTS request_limit integer;
ALTER TABLE budget_limits ADD COLUMN IF NOT EXISTS token_limit integer;
ALTER TABLE budget_limits ADD COLUMN IF NOT EXISTS sandbox_minute_limit numeric(12, 2);
ALTER TABLE budget_limits ADD COLUMN IF NOT EXISTS threshold_percentages jsonb NOT NULL DEFAULT '[80,100]'::jsonb;
UPDATE role_permission_defaults
SET permissions = permissions || '["members:read","members:write","org_settings:read"]'::jsonb
WHERE role = 'admin';
UPDATE role_permission_defaults
SET permissions = permissions || '["members:read","members:write","org_settings:read","org_settings:write"]'::jsonb
WHERE role = 'owner';
UPDATE feature_flags
SET role_defaults = jsonb_set(
  jsonb_set(role_defaults, '{owner}', coalesce(role_defaults->'owner', '[]'::jsonb) || '["usage:read","usage:export","reports:read","reports:write","alerts:read","alerts:write","billing:read","billing:write","guardrails:read","guardrails:write","data_policy:read","data_policy:write","auth_policy:read","auth_policy:write","service_accounts:read","service_accounts:write"]'::jsonb),
  '{admin}', coalesce(role_defaults->'admin', '[]'::jsonb) || '["usage:read","usage:export","reports:read","reports:write","alerts:read","alerts:write","billing:read","guardrails:read","guardrails:write","data_policy:read","auth_policy:read","service_accounts:read"]'::jsonb
)
WHERE flag = 'enterprise-governance';
CREATE INDEX IF NOT EXISTS usage_events_tenant_model_ts_idx ON usage_events (tenant_id, model, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_tenant_status_ts_idx ON usage_events (tenant_id, status, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_tenant_workspace_ts_idx ON usage_events (tenant_id, workspace_id, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_tenant_agent_ts_idx ON usage_events (tenant_id, agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS usage_rollups_tenant_user_bucket_idx ON usage_rollups (tenant_id, user_id, bucket_start DESC);
CREATE INDEX IF NOT EXISTS usage_rollups_tenant_department_bucket_idx ON usage_rollups (tenant_id, department_id, bucket_start DESC);
CREATE INDEX IF NOT EXISTS usage_rollups_tenant_workspace_bucket_idx ON usage_rollups (tenant_id, workspace_id, bucket_start DESC);
CREATE INDEX IF NOT EXISTS usage_rollups_tenant_agent_bucket_idx ON usage_rollups (tenant_id, agent_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS allowance_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 name text NOT NULL, description text NOT NULL DEFAULT '', period text NOT NULL DEFAULT 'month' CHECK (period IN ('day','month')),
 soft_limit_micros numeric(20,0), hard_limit_micros numeric(20,0), request_limit integer, token_limit integer, sandbox_minute_limit numeric(12,2),
 threshold_percentages jsonb NOT NULL DEFAULT '[80,100]'::jsonb, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS allowance_profiles_tenant_status_idx ON allowance_profiles (tenant_id, status);
CREATE TABLE IF NOT EXISTS allowance_default_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 profile_id uuid REFERENCES allowance_profiles(id) ON DELETE SET NULL, role text, department_id uuid REFERENCES departments(id) ON DELETE CASCADE,
 priority integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT (tenant_id, role, department_id), CHECK (role IS NOT NULL OR department_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS allowance_bulk_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL, result jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS billing_auto_refill_configs (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT false,
 trigger_balance_micros numeric(20,0), purchase_amount_micros numeric(20,0), currency text NOT NULL DEFAULT 'usd',
 idempotency_key text, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION apply_default_allowance_to_membership() RETURNS trigger AS $$
DECLARE selected_profile allowance_profiles%ROWTYPE;
BEGIN
  SELECT p.* INTO selected_profile FROM allowance_default_assignments d
  JOIN allowance_profiles p ON p.id=d.profile_id AND p.tenant_id=d.tenant_id AND p.status='active'
  WHERE d.tenant_id=NEW.tenant_id AND d.role=NEW.role AND d.department_id IS NULL ORDER BY d.priority DESC LIMIT 1;
  IF selected_profile.id IS NOT NULL THEN
    INSERT INTO budget_limits (tenant_id,scope_type,scope_id,period,soft_limit_micros,hard_limit_micros,request_limit,token_limit,sandbox_minute_limit,threshold_percentages,status)
    VALUES (NEW.tenant_id,'user',NEW.user_id::text,selected_profile.period,COALESCE(selected_profile.soft_limit_micros,0),COALESCE(selected_profile.hard_limit_micros,0),selected_profile.request_limit,selected_profile.token_limit,selected_profile.sandbox_minute_limit,selected_profile.threshold_percentages,'active')
    ON CONFLICT (tenant_id,scope_type,scope_id,period) DO UPDATE SET soft_limit_micros=excluded.soft_limit_micros,hard_limit_micros=excluded.hard_limit_micros,request_limit=excluded.request_limit,token_limit=excluded.token_limit,sandbox_minute_limit=excluded.sandbox_minute_limit,threshold_percentages=excluded.threshold_percentages,status='active',updated_at=now();
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tenant_membership_default_allowance ON tenant_memberships;
CREATE TRIGGER tenant_membership_default_allowance AFTER INSERT OR UPDATE OF role,status ON tenant_memberships FOR EACH ROW WHEN (NEW.status='active') EXECUTE FUNCTION apply_default_allowance_to_membership();
CREATE TABLE IF NOT EXISTS saved_analytics_views (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, filters jsonb NOT NULL DEFAULT '{}'::jsonb,
 visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','tenant')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_analytics_views_tenant_owner_idx ON saved_analytics_views (tenant_id, owner_user_id);
CREATE TABLE IF NOT EXISTS report_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 saved_view_id uuid NOT NULL REFERENCES saved_analytics_views(id) ON DELETE CASCADE, name text NOT NULL, format text NOT NULL CHECK (format IN ('csv','html')),
 cadence text NOT NULL CHECK (cadence IN ('daily','weekly','monthly')), timezone text NOT NULL, recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')), next_run_at timestamptz, last_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_schedules_tenant_next_run_idx ON report_schedules (tenant_id, status, next_run_at);
CREATE TABLE IF NOT EXISTS report_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 schedule_id uuid NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE, window_key text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','delivered','failed')), artifact_ref text, error text,
 started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, schedule_id, window_key)
);
CREATE INDEX IF NOT EXISTS report_runs_tenant_created_idx ON report_runs (tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS alert_destinations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('email','webhook')), label text NOT NULL, email_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
 secret_ref text, configured boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_destinations_tenant_kind_idx ON alert_destinations (tenant_id, kind);
CREATE TABLE IF NOT EXISTS alert_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 name text NOT NULL, signal text NOT NULL, enabled boolean NOT NULL DEFAULT true, scope_type text, scope_id text,
 threshold numeric(20,4) NOT NULL, window_minutes integer NOT NULL, destination_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_rules_tenant_enabled_idx ON alert_rules (tenant_id, enabled);
CREATE TABLE IF NOT EXISTS alert_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 rule_id uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE, window_key text NOT NULL, observed numeric(20,4) NOT NULL, baseline numeric(20,4),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, rule_id, window_key)
);
CREATE INDEX IF NOT EXISTS alert_events_tenant_created_idx ON alert_events (tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS delivery_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 alert_event_id uuid REFERENCES alert_events(id) ON DELETE CASCADE, report_run_id uuid REFERENCES report_runs(id) ON DELETE CASCADE,
 destination_id uuid NOT NULL REFERENCES alert_destinations(id) ON DELETE CASCADE, attempt integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')), provider_message_id text, error text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE NULLS NOT DISTINCT (tenant_id, alert_event_id, report_run_id, destination_id, attempt),
 CHECK ((alert_event_id IS NOT NULL) <> (report_run_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS execution_network_policies (tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, policy jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS authentication_policies (tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, policy jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS data_governance_policies (tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, policy jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS organization_profiles (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, timezone text NOT NULL DEFAULT 'UTC', language text NOT NULL DEFAULT 'en', logo_url text,
 support_email text, security_email text, announcements jsonb NOT NULL DEFAULT '[]'::jsonb, terms_url text, privacy_url text,
 branding jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_domains (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, domain text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed')), custom_domain boolean NOT NULL DEFAULT false,
 verification_token_hash text, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_domains_tenant_status_idx ON organization_domains (tenant_id, status);
CREATE TABLE IF NOT EXISTS service_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, name text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')), permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
 department_id uuid REFERENCES departments(id) ON DELETE SET NULL, resource_restrictions jsonb NOT NULL DEFAULT '[]'::jsonb,
 token_hash text NOT NULL, token_last4 text NOT NULL, expires_at timestamptz, last_used_at timestamptz, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS service_accounts_tenant_status_idx ON service_accounts (tenant_id, status);
CREATE TABLE IF NOT EXISTS platform_rollout_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feature text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'draft', exposure_percent numeric(5,2) NOT NULL DEFAULT 0,
 target jsonb NOT NULL DEFAULT '{}'::jsonb, exclusions jsonb NOT NULL DEFAULT '[]'::jsonb, rollback_threshold numeric(5,2),
 owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_operator_audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL,
 target_type text NOT NULL, target_id text NOT NULL, audit_note text NOT NULL, before jsonb, after jsonb, idempotency_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_operator_audit_created_idx ON platform_operator_audit_events (created_at DESC);

${MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}
`.trim();

export const MESSAGE_ATTACHMENTS_MIGRATION = `
ALTER TYPE message_part_kind ADD VALUE IF NOT EXISTS 'attachment';
`.trim();

export const FILE_PLATFORM_MIGRATION = `
DO $$ BEGIN
  CREATE TYPE file_origin AS ENUM ('user_upload', 'sandbox_output', 'image_generation', 'browser_capture', 'legacy_artifact');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE file_status AS ENUM ('initiated', 'uploading', 'scanning', 'processing', 'available', 'failed', 'quarantined', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE file_association_role AS ENUM ('input', 'output', 'reference');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE file_derivative_kind AS ENUM ('thumbnail', 'pdf_preview', 'text_extract', 'sheet_data', 'slide_image');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE file_processing_status AS ENUM ('queued', 'processing', 'available', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  original_name text NOT NULL,
  display_name text NOT NULL,
  media_type text NOT NULL DEFAULT 'application/octet-stream',
  detected_media_type text,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 text,
  bucket text NOT NULL,
  object_key text NOT NULL,
  etag text,
  object_version_id text,
  origin file_origin NOT NULL,
  status file_status NOT NULL DEFAULT 'initiated',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, object_key)
);
CREATE INDEX IF NOT EXISTS files_tenant_owner_created_idx ON files (tenant_id, owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_tenant_status_created_idx ON files (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS file_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  turn_id text,
  role file_association_role NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS file_associations_context_unique
  ON file_associations (file_id, COALESCE(task_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(message_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(turn_id, ''), role);
CREATE INDEX IF NOT EXISTS file_associations_tenant_task_created_idx ON file_associations (tenant_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS file_associations_tenant_message_idx ON file_associations (tenant_id, message_id);

CREATE TABLE IF NOT EXISTS file_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  provider_upload_id text NOT NULL,
  part_size integer NOT NULL CHECK (part_size >= 5242880),
  part_count integer NOT NULL CHECK (part_count > 0 AND part_count <= 10000),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'completed', 'aborted', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  aborted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, provider_upload_id)
);
CREATE INDEX IF NOT EXISTS file_uploads_tenant_status_expiry_idx ON file_uploads (tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS file_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind file_derivative_kind NOT NULL,
  status file_processing_status NOT NULL DEFAULT 'queued',
  object_key text,
  media_type text,
  size_bytes bigint,
  generator_version text NOT NULL DEFAULT 'v1',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, kind, generator_version)
);
CREATE INDEX IF NOT EXISTS file_derivatives_tenant_status_idx ON file_derivatives (tenant_id, status);

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE file_associations ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_associations FORCE ROW LEVEL SECURITY;
ALTER TABLE file_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE file_derivatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_derivatives FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS files_tenant_isolation ON files;
CREATE POLICY files_tenant_isolation ON files USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
DROP POLICY IF EXISTS file_associations_tenant_isolation ON file_associations;
CREATE POLICY file_associations_tenant_isolation ON file_associations USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
DROP POLICY IF EXISTS file_uploads_tenant_isolation ON file_uploads;
CREATE POLICY file_uploads_tenant_isolation ON file_uploads USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
DROP POLICY IF EXISTS file_derivatives_tenant_isolation ON file_derivatives;
CREATE POLICY file_derivatives_tenant_isolation ON file_derivatives USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const CAPABILITY_PERMISSION_DEFAULTS_MIGRATION = `
UPDATE feature_flags
SET role_defaults = jsonb_set(
  jsonb_set(
    jsonb_set(
      role_defaults,
      '{owner}',
      coalesce(role_defaults->'owner', '[]'::jsonb) || '["skills:read","skills:write","mcp:read","mcp:write"]'::jsonb
    ),
    '{admin}',
    coalesce(role_defaults->'admin', '[]'::jsonb) || '["skills:read","skills:write","mcp:read","mcp:write"]'::jsonb
  ),
  '{member}',
  coalesce(role_defaults->'member', '[]'::jsonb) || '["skills:read","mcp:read"]'::jsonb
)
WHERE flag = 'enterprise-governance';
`.trim();

export const FILE_LIBRARY_SEARCH_MIGRATION = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS files_display_name_original_name_trgm_idx
  ON files USING gin (display_name gin_trgm_ops, original_name gin_trgm_ops)
  WHERE deleted_at IS NULL AND status IN ('available', 'processing');
`.trim();

export const DURABLE_CONTEXT_MIGRATION = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_enabled boolean NOT NULL DEFAULT true,
  implicit_memory_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'project')),
  kind text NOT NULL,
  stable_key text NOT NULL,
  content text NOT NULL,
  structured_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'forgotten', 'expired', 'rejected')),
  explicit boolean NOT NULL DEFAULT false,
  confidence numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  salience numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
  valid_from timestamptz,
  valid_until timestamptz,
  expires_at timestamptz,
  extractor_version text NOT NULL DEFAULT 'v1',
  source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  superseded_item_id uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  last_seen_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_items_scope_workspace_check CHECK (
    (scope = 'personal' AND workspace_id IS NULL) OR
    (scope = 'project' AND workspace_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX memory_items_active_key_unique
  ON memory_items (tenant_id, user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), stable_key)
  WHERE status = 'active';
CREATE INDEX memory_items_recall_idx ON memory_items (tenant_id, user_id, workspace_id, status, salience DESC);
CREATE INDEX memory_items_expiry_idx ON memory_items (tenant_id, expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE memory_item_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('ADD', 'SUPERSEDE', 'REFRESH', 'NOOP', 'FORGET')),
  before_value jsonb,
  after_value jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  extractor_version text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_item_versions_item_created_idx ON memory_item_versions (tenant_id, memory_item_id, created_at DESC);

CREATE TABLE workspace_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'project' CHECK (visibility IN ('project', 'task_only')),
  originating_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  index_status text NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending', 'extracting', 'chunking', 'embedding', 'indexed', 'failed', 'deleted')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, workspace_id, file_id)
);
CREATE INDEX workspace_files_list_idx ON workspace_files (tenant_id, workspace_id, visibility, index_status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('file', 'task_outcome', 'message', 'checkpoint', 'memory')),
  source_id text NOT NULL,
  source_revision text NOT NULL,
  content_hash text NOT NULL,
  title text NOT NULL,
  authority numeric(5,4) NOT NULL DEFAULT 0.5 CHECK (authority >= 0 AND authority <= 1),
  visibility text NOT NULL DEFAULT 'project' CHECK (visibility IN ('project', 'task_only', 'private')),
  acl_version integer NOT NULL DEFAULT 1,
  extraction_status text NOT NULL DEFAULT 'pending',
  index_status text NOT NULL DEFAULT 'pending',
  vector_ready boolean NOT NULL DEFAULT false,
  extractor_version text NOT NULL DEFAULT 'v1',
  chunker_version text NOT NULL DEFAULT 'v1',
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, source_type, source_id, source_revision)
);
CREATE INDEX knowledge_sources_active_idx ON knowledge_sources (tenant_id, workspace_id, index_status, source_type)
  WHERE tombstoned_at IS NULL;
CREATE INDEX knowledge_sources_cleanup_idx ON knowledge_sources (tenant_id, tombstoned_at)
  WHERE tombstoned_at IS NOT NULL;

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text_content text NOT NULL,
  token_estimate integer NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(text_content, ''))) STORED,
  embedding vector(1536),
  embedding_profile_id text,
  embedding_provider text,
  embedding_model text,
  embedding_dimensions integer,
  embedding_profile_version integer,
  embedding_hash text,
  vector_ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, ordinal),
  CONSTRAINT knowledge_chunks_embedding_dimensions_check CHECK (
    embedding IS NULL OR embedding_dimensions = 1536
  )
);
CREATE INDEX knowledge_chunks_scope_idx ON knowledge_chunks (tenant_id, workspace_id, source_id);
CREATE INDEX knowledge_chunks_search_idx ON knowledge_chunks USING gin (search_document);
CREATE INDEX knowledge_chunks_vector_ready_idx ON knowledge_chunks (tenant_id, workspace_id, vector_ready)
  WHERE vector_ready = true;

CREATE TABLE retrieval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id uuid,
  query_hash text NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_chunk_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  component_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  selection_reason text,
  token_budget integer NOT NULL CHECK (token_budget >= 0),
  tokens_selected integer NOT NULL DEFAULT 0 CHECK (tokens_selected >= 0),
  retrieval_version text NOT NULL,
  embedding_profile_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_snapshots_turn_idx ON retrieval_snapshots (tenant_id, session_id, created_at DESC);
CREATE INDEX retrieval_snapshots_workspace_idx ON retrieval_snapshots (tenant_id, workspace_id, created_at DESC);

CREATE TABLE session_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  parent_entry_id text,
  entry_type text NOT NULL,
  sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  is_leaf_marker boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, entry_id),
  UNIQUE (tenant_id, session_id, sequence)
);
CREATE INDEX session_entries_parent_idx ON session_entries (tenant_id, session_id, parent_entry_id);

CREATE TABLE session_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('segment', 'rolling')),
  source_leaf_id text NOT NULL,
  covered_entry_start text,
  covered_entry_end text,
  schema_version integer NOT NULL DEFAULT 2,
  checkpoint jsonb NOT NULL,
  validation_status text NOT NULL DEFAULT 'valid',
  model_provider text,
  model text,
  prompt_manifest_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, kind, source_leaf_id, covered_entry_end, schema_version)
);
CREATE INDEX session_checkpoints_latest_idx ON session_checkpoints (tenant_id, session_id, created_at DESC);

CREATE TABLE turn_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'assembling_context', 'calling_model', 'persisting_response',
    'executing_tool', 'compacting', 'waiting', 'finalizing', 'completed',
    'failed', 'cancelled', 'recovery_required'
  )),
  attempt integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  next_action text,
  waiting_reason text,
  heartbeat_at timestamptz,
  error text,
  runtime_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  grounding_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  sandbox_provider text,
  sandbox_id text,
  sandbox_state text,
  sandbox_heartbeat_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX turn_runs_claim_idx ON turn_runs (tenant_id, state, lease_expires_at);
CREATE INDEX turn_runs_session_idx ON turn_runs (tenant_id, session_id, created_at DESC);
CREATE INDEX turn_runs_terminal_sandbox_cleanup_idx ON turn_runs (tenant_id, updated_at)
  WHERE state IN ('completed','failed','cancelled','recovery_required')
    AND sandbox_id IS NOT NULL
    AND COALESCE(sandbox_state,'running') NOT IN ('paused','missing','stopped','destroyed','pause_requested');
CREATE UNIQUE INDEX turn_runs_active_session_unique ON turn_runs (tenant_id, session_id)
  WHERE state NOT IN ('completed', 'failed', 'cancelled', 'recovery_required');

ALTER TABLE retrieval_snapshots
  ADD CONSTRAINT retrieval_snapshots_run_fk FOREIGN KEY (run_id) REFERENCES turn_runs(id) ON DELETE SET NULL;

CREATE TABLE turn_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  step_type text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  retry_class text CHECK (retry_class IS NULL OR retry_class IN ('read_only', 'idempotent', 'idempotent_with_key', 'non_idempotent_manual')),
  idempotency_key text,
  attempt integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_events_run_sequence_unique UNIQUE (tenant_id, run_id, sequence)
);
CREATE UNIQUE INDEX turn_steps_idempotency_unique ON turn_steps (tenant_id, run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX turn_steps_state_idx ON turn_steps (tenant_id, state, created_at);

CREATE TABLE turn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, run_id, sequence)
);
CREATE INDEX turn_events_session_sequence_idx ON turn_events (tenant_id, session_id, sequence);
CREATE INDEX turn_events_retention_idx ON turn_events (tenant_id, created_at);

CREATE TABLE runtime_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX runtime_outbox_due_idx ON runtime_outbox (tenant_id, completed_at, available_at, lease_expires_at);

CREATE TABLE sandbox_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sandbox_provider text NOT NULL,
  sandbox_id text NOT NULL,
  storage_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  object_key text NOT NULL,
  content_hash text NOT NULL,
  sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'complete', 'failed', 'deleted')),
  session_leaf_id text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, run_id, sequence)
);
CREATE INDEX sandbox_snapshots_restore_idx ON sandbox_snapshots (tenant_id, run_id, status, sequence DESC);

ALTER TABLE usage_events
  ADD COLUMN cache_read_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_creation_tokens_1h integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_creation_tokens_5m integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN cache_provider text,
  ADD COLUMN cache_key_hash text,
  ADD COLUMN prompt_manifest_hash text,
  ADD COLUMN cache_miss_reason text;

ALTER TABLE usage_rollups
  ADD COLUMN cache_read_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_tokens integer NOT NULL DEFAULT 0;

${DURABLE_CONTEXT_TABLES.map((tableName) => tenantRlsSql(tableName)).join("\n\n")}

CREATE TRIGGER memory_item_versions_reject_update
BEFORE UPDATE ON memory_item_versions
FOR EACH ROW EXECUTE FUNCTION berry_reject_append_only_mutation();
CREATE TRIGGER memory_item_versions_reject_delete
BEFORE DELETE ON memory_item_versions
FOR EACH ROW EXECUTE FUNCTION berry_reject_append_only_mutation();
`.trim();

export const SESSION_COMPACTION_LEASES_MIGRATION = `
CREATE TABLE session_compaction_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id)
);
CREATE INDEX session_compaction_leases_expiry_idx
  ON session_compaction_leases (tenant_id, lease_expires_at);

${tenantRlsSql("session_compaction_leases")}
`.trim();

export const DURABLE_TURN_BINDINGS_MIGRATION = `
ALTER TABLE sessions
  ADD COLUMN runtime_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE turn_runs
  ADD COLUMN version integer NOT NULL DEFAULT 0;

ALTER TABLE turn_steps
  ADD COLUMN session_entry_id text,
  ADD COLUMN checkpoint_id uuid REFERENCES session_checkpoints(id) ON DELETE SET NULL;

ALTER TABLE session_entries
  ADD COLUMN run_id uuid REFERENCES turn_runs(id) ON DELETE SET NULL,
  ADD COLUMN step_id uuid REFERENCES turn_steps(id) ON DELETE SET NULL,
  ADD COLUMN checkpoint_id uuid REFERENCES session_checkpoints(id) ON DELETE SET NULL;
CREATE INDEX session_entries_run_idx
  ON session_entries (tenant_id, run_id, sequence);

ALTER TABLE tool_calls
  ADD COLUMN run_id uuid REFERENCES turn_runs(id) ON DELETE CASCADE,
  ADD COLUMN step_id uuid REFERENCES turn_steps(id) ON DELETE SET NULL,
  ADD COLUMN retry_class text CHECK (
    retry_class IS NULL OR retry_class IN (
      'read_only', 'idempotent', 'idempotent_with_key', 'non_idempotent_manual'
    )
  ),
  ADD COLUMN idempotency_key text;
CREATE INDEX tool_calls_run_idx ON tool_calls (tenant_id, run_id, created_at);

ALTER TABLE approvals
  ADD COLUMN run_id uuid REFERENCES turn_runs(id) ON DELETE CASCADE,
  ADD COLUMN step_id uuid REFERENCES turn_steps(id) ON DELETE SET NULL;
CREATE INDEX approvals_run_idx ON approvals (tenant_id, run_id, created_at);
`.trim();

export const DURABLE_TURN_QUESTIONS_MIGRATION = `
CREATE TABLE turn_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id uuid REFERENCES turn_steps(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  multi boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','answered','cancelled','expired')),
  answer jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX turn_questions_session_status_idx
  ON turn_questions (tenant_id, session_id, status, created_at);
CREATE INDEX turn_questions_run_idx
  ON turn_questions (tenant_id, run_id, created_at);

${tenantRlsSql("turn_questions")}
`.trim();

export const MESSAGE_CITATIONS_MIGRATION = `
ALTER TYPE message_part_kind ADD VALUE IF NOT EXISTS 'citation';
`.trim();

export const MAINTENANCE_RUNS_MIGRATION = `
CREATE TABLE maintenance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('context_backfill','retention_cleanup')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  changed_count bigint NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  enqueued_count bigint NOT NULL DEFAULT 0 CHECK (enqueued_count >= 0),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error text,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_runs_tenant_status_idx
  ON maintenance_runs (tenant_id, status, updated_at DESC);

${tenantRlsSql("maintenance_runs")}
`.trim();

export const SELF_HOSTED_EMBEDDING_PROFILE_MIGRATION = `
UPDATE knowledge_chunks
SET embedding = NULL,
    embedding_profile_id = NULL,
    embedding_provider = NULL,
    embedding_model = NULL,
    embedding_dimensions = NULL,
    embedding_profile_version = NULL,
    embedding_hash = NULL,
    vector_ready = false
WHERE embedding IS NOT NULL OR vector_ready = true;

UPDATE knowledge_sources
SET vector_ready = false
WHERE vector_ready = true;

ALTER TABLE knowledge_chunks
  DROP CONSTRAINT knowledge_chunks_embedding_dimensions_check;
ALTER TABLE knowledge_chunks
  ALTER COLUMN embedding TYPE vector(768);
ALTER TABLE knowledge_chunks
  ADD CONSTRAINT knowledge_chunks_embedding_dimensions_check CHECK (
    embedding IS NULL OR embedding_dimensions = 768
  );
`.trim();

export const KNOWLEDGE_VECTOR_HNSW_MIGRATION = `
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
ON knowledge_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE vector_ready = true AND embedding IS NOT NULL;
`.trim();

export const TENANT_CONTEXT_EXECUTE_HARDENING_MIGRATION = `
REVOKE ALL ON FUNCTION berry_set_tenant_id(uuid) FROM PUBLIC;
`.trim();

export const PERSONALIZATION_PROFILE_MIGRATION = `
CREATE TABLE IF NOT EXISTS personalization_profiles (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  nickname text NOT NULL DEFAULT '',
  occupation text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  custom_instructions text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE personalization_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE personalization_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personalization_profiles_tenant_isolation ON personalization_profiles;
CREATE POLICY personalization_profiles_tenant_isolation ON personalization_profiles
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const ALLOWANCE_CYCLES_MIGRATION = `
ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS primary_department_id uuid REFERENCES departments(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS allowance_cycle_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC',
  anchor_day integer NOT NULL DEFAULT 1 CHECK (anchor_day BETWEEN 1 AND 28),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS allowance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_micros numeric(20, 0) NOT NULL CHECK (amount_micros > 0),
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  cycle_start timestamptz NOT NULL,
  cycle_end timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (cycle_end > cycle_start)
);
CREATE INDEX IF NOT EXISTS allowance_adjustments_tenant_user_cycle_idx
  ON allowance_adjustments (tenant_id, user_id, cycle_start, cycle_end);

ALTER TABLE allowance_cycle_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowance_cycle_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allowance_cycle_settings_tenant_isolation ON allowance_cycle_settings;
CREATE POLICY allowance_cycle_settings_tenant_isolation ON allowance_cycle_settings
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());

ALTER TABLE allowance_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowance_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allowance_adjustments_tenant_isolation ON allowance_adjustments;
CREATE POLICY allowance_adjustments_tenant_isolation ON allowance_adjustments
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const ALLOWANCE_BASE_HIERARCHY_MIGRATION = `
ALTER TABLE allowance_default_assignments
  DROP CONSTRAINT IF EXISTS allowance_default_assignments_check;

CREATE TABLE IF NOT EXISTS allowance_member_overrides (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_micros numeric(20, 0) NOT NULL CHECK (amount_micros > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS allowance_member_overrides_tenant_idx
  ON allowance_member_overrides (tenant_id);

${tenantRlsSql("allowance_member_overrides")}

INSERT INTO allowance_member_overrides (tenant_id, user_id, amount_micros)
SELECT tenant_id, scope_id::uuid, hard_limit_micros
FROM budget_limits
WHERE scope_type = 'user'
  AND period = 'month'
  AND status = 'active'
  AND hard_limit_micros > 0
  AND scope_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT (tenant_id, user_id) DO NOTHING;

INSERT INTO allowance_profiles (
  tenant_id, name, description, period, soft_limit_micros,
  hard_limit_micros, threshold_percentages, status
)
SELECT
  id,
  'Organization default allowance',
  '$20 monthly base allowance for organization members',
  'month',
  16000000,
  20000000,
  '[80,100]'::jsonb,
  'active'
FROM tenants
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO allowance_default_assignments (
  tenant_id, profile_id, role, department_id, priority
)
SELECT p.tenant_id, p.id, NULL, NULL, 0
FROM allowance_profiles p
WHERE p.name = 'Organization default allowance'
ON CONFLICT (tenant_id, role, department_id) DO UPDATE
SET profile_id = COALESCE(allowance_default_assignments.profile_id, excluded.profile_id),
    updated_at = now();

CREATE OR REPLACE FUNCTION refresh_member_base_allowance(
  p_tenant_id uuid,
  p_user_id uuid
) RETURNS void AS $$
DECLARE
  member_role text;
  member_department_id uuid;
  override_amount numeric(20, 0);
  selected_profile allowance_profiles%ROWTYPE;
BEGIN
  SELECT
    tm.role,
    COALESCE(
      (
        SELECT dm.department_id
        FROM department_memberships dm
        WHERE dm.tenant_id = tm.tenant_id
          AND dm.user_id = tm.user_id
          AND dm.department_id = tm.primary_department_id
        LIMIT 1
      ),
      (
        SELECT dm.department_id
        FROM department_memberships dm
        WHERE dm.tenant_id = tm.tenant_id AND dm.user_id = tm.user_id
        ORDER BY dm.created_at, dm.department_id
        LIMIT 1
      )
    )
  INTO member_role, member_department_id
  FROM tenant_memberships tm
  WHERE tm.tenant_id = p_tenant_id
    AND tm.user_id = p_user_id
    AND tm.status = 'active';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO allowance_profiles (
    tenant_id, name, description, period, soft_limit_micros,
    hard_limit_micros, threshold_percentages, status
  ) VALUES (
    p_tenant_id,
    'Organization default allowance',
    '$20 monthly base allowance for organization members',
    'month',
    16000000,
    20000000,
    '[80,100]'::jsonb,
    'active'
  )
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO allowance_default_assignments (
    tenant_id, profile_id, role, department_id, priority
  )
  SELECT p_tenant_id, p.id, NULL, NULL, 0
  FROM allowance_profiles p
  WHERE p.tenant_id = p_tenant_id
    AND p.name = 'Organization default allowance'
  ON CONFLICT (tenant_id, role, department_id) DO UPDATE
  SET profile_id = COALESCE(allowance_default_assignments.profile_id, excluded.profile_id),
      updated_at = now();

  SELECT amount_micros
  INTO override_amount
  FROM allowance_member_overrides
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id;

  IF override_amount IS NOT NULL THEN
    INSERT INTO budget_limits (
      tenant_id, scope_type, scope_id, period, soft_limit_micros,
      hard_limit_micros, request_limit, token_limit,
      sandbox_minute_limit, threshold_percentages, status
    ) VALUES (
      p_tenant_id, 'user', p_user_id::text, 'month',
      floor(override_amount * 0.8), override_amount,
      NULL, NULL, NULL, '[80,100]'::jsonb, 'active'
    )
    ON CONFLICT (tenant_id, scope_type, scope_id, period) DO UPDATE
    SET soft_limit_micros = excluded.soft_limit_micros,
        hard_limit_micros = excluded.hard_limit_micros,
        status = 'active',
        updated_at = now();
    RETURN;
  END IF;

  SELECT p.*
  INTO selected_profile
  FROM allowance_default_assignments d
  JOIN allowance_profiles p
    ON p.id = d.profile_id
   AND p.tenant_id = d.tenant_id
   AND p.status = 'active'
   AND p.period = 'month'
  WHERE d.tenant_id = p_tenant_id
    AND (
      (
        member_department_id IS NOT NULL
        AND d.department_id = member_department_id
        AND (d.role IS NULL OR d.role = member_role)
      )
      OR (d.department_id IS NULL AND d.role = member_role)
      OR (d.department_id IS NULL AND d.role IS NULL)
    )
  ORDER BY
    CASE
      WHEN d.department_id = member_department_id THEN 3
      WHEN d.role = member_role THEN 2
      ELSE 1
    END DESC,
    d.priority DESC,
    d.updated_at DESC
  LIMIT 1;

  IF selected_profile.id IS NULL
    OR selected_profile.hard_limit_micros IS NULL
    OR selected_profile.hard_limit_micros <= 0 THEN
    UPDATE budget_limits
    SET status = 'disabled', updated_at = now()
    WHERE tenant_id = p_tenant_id
      AND scope_type = 'user'
      AND scope_id = p_user_id::text
      AND period = 'month';
    RETURN;
  END IF;

  INSERT INTO budget_limits (
    tenant_id, scope_type, scope_id, period, soft_limit_micros,
    hard_limit_micros, request_limit, token_limit,
    sandbox_minute_limit, threshold_percentages, status
  ) VALUES (
    p_tenant_id, 'user', p_user_id::text, selected_profile.period,
    COALESCE(selected_profile.soft_limit_micros, floor(selected_profile.hard_limit_micros * 0.8)),
    selected_profile.hard_limit_micros,
    selected_profile.request_limit,
    selected_profile.token_limit,
    selected_profile.sandbox_minute_limit,
    selected_profile.threshold_percentages,
    'active'
  )
  ON CONFLICT (tenant_id, scope_type, scope_id, period) DO UPDATE
  SET soft_limit_micros = excluded.soft_limit_micros,
      hard_limit_micros = excluded.hard_limit_micros,
      request_limit = excluded.request_limit,
      token_limit = excluded.token_limit,
      sandbox_minute_limit = excluded.sandbox_minute_limit,
      threshold_percentages = excluded.threshold_percentages,
      status = 'active',
      updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_default_allowance_to_membership()
RETURNS trigger AS $$
BEGIN
  PERFORM refresh_member_base_allowance(NEW.tenant_id, NEW.user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_membership_default_allowance ON tenant_memberships;
CREATE TRIGGER tenant_membership_default_allowance
AFTER INSERT OR UPDATE OF role, status, primary_department_id
ON tenant_memberships
FOR EACH ROW
WHEN (NEW.status = 'active')
EXECUTE FUNCTION apply_default_allowance_to_membership();

CREATE OR REPLACE FUNCTION refresh_allowance_after_department_membership()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_member_base_allowance(OLD.tenant_id, OLD.user_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND (OLD.tenant_id, OLD.user_id) IS DISTINCT FROM (NEW.tenant_id, NEW.user_id) THEN
    PERFORM refresh_member_base_allowance(OLD.tenant_id, OLD.user_id);
  END IF;
  PERFORM refresh_member_base_allowance(NEW.tenant_id, NEW.user_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS department_membership_default_allowance ON department_memberships;
CREATE TRIGGER department_membership_default_allowance
AFTER INSERT OR UPDATE OR DELETE
ON department_memberships
FOR EACH ROW
EXECUTE FUNCTION refresh_allowance_after_department_membership();

DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT tenant_id, user_id
    FROM tenant_memberships
    WHERE status = 'active'
  LOOP
    PERFORM refresh_member_base_allowance(membership.tenant_id, membership.user_id);
  END LOOP;
END;
$$;
`.trim();

export const ORGANIZATION_MODEL_PROVIDERS_MIGRATION = `
CREATE TABLE IF NOT EXISTS organization_model_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  display_name text NOT NULL,
  kind text NOT NULL,
  api_type text NOT NULL,
  base_url text NOT NULL,
  endpoint_path text,
  models_path text,
  auth_type text NOT NULL,
  credential_ref text,
  default_model text,
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','active','error','disabled')),
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_id)
);
CREATE INDEX IF NOT EXISTS organization_model_providers_tenant_status_idx
  ON organization_model_providers (tenant_id, status, display_name);
ALTER TABLE organization_model_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_model_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_model_providers_tenant_isolation ON organization_model_providers;
CREATE POLICY organization_model_providers_tenant_isolation ON organization_model_providers
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const ORGANIZATION_AI_ACCESS_RULES_MIGRATION = `
CREATE TABLE IF NOT EXISTS organization_ai_access_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org','department','user')),
  scope_id text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('model','feature','skill','mcp','execution')),
  resource_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allowed','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,scope_type,scope_id,resource_type,resource_id),
  CHECK (scope_type <> 'org' OR scope_id = tenant_id::text)
);
CREATE INDEX IF NOT EXISTS organization_ai_access_rules_tenant_resource_idx
  ON organization_ai_access_rules (tenant_id,resource_type,resource_id);
ALTER TABLE organization_ai_access_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_ai_access_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_ai_access_rules_tenant_isolation ON organization_ai_access_rules;
CREATE POLICY organization_ai_access_rules_tenant_isolation ON organization_ai_access_rules
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const TERMINAL_SANDBOX_CLEANUP_INDEX_MIGRATION = `
CREATE INDEX IF NOT EXISTS turn_runs_terminal_sandbox_cleanup_idx ON turn_runs (tenant_id, updated_at)
  WHERE state IN ('completed','failed','cancelled','recovery_required')
    AND sandbox_id IS NOT NULL
    AND COALESCE(sandbox_state,'running') NOT IN ('paused','missing','stopped','destroyed','pause_requested');
`.trim();

export const TURN_RUN_ADMISSION_IDEMPOTENCY_MIGRATION = `
ALTER TABLE turn_runs ADD COLUMN IF NOT EXISTS request_id text;
UPDATE turn_runs
SET request_id = COALESCE(NULLIF(runtime_request->>'requestId',''), 'legacy_' || id::text)
WHERE request_id IS NULL;
ALTER TABLE turn_runs ALTER COLUMN request_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS turn_runs_tenant_request_unique
  ON turn_runs (tenant_id, request_id);
`.trim();

export const FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION = `
DO $$ BEGIN
  CREATE TYPE file_blob_verification_status AS ENUM ('unverified','verifying','verified','failed','pending_delete','deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS file_blobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  object_key text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 text,
  etag text,
  object_version_id text,
  verification_status file_blob_verification_status NOT NULL DEFAULT 'unverified',
  verified_at timestamptz,
  delete_after timestamptz,
  deleted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bucket, object_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS file_blobs_tenant_verified_hash_unique
  ON file_blobs (tenant_id, sha256, size_bytes)
  WHERE sha256 IS NOT NULL AND verification_status = 'verified' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_blobs_tenant_status_created_idx
  ON file_blobs (tenant_id, verification_status, created_at);
CREATE INDEX IF NOT EXISTS file_blobs_pending_delete_idx
  ON file_blobs (tenant_id, delete_after)
  WHERE verification_status = 'pending_delete' AND deleted_at IS NULL;

ALTER TABLE files ADD COLUMN IF NOT EXISTS blob_id uuid;
DO $$ BEGIN
  ALTER TABLE files
    ADD CONSTRAINT files_blob_id_fkey
    FOREIGN KEY (blob_id) REFERENCES file_blobs(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS files_tenant_blob_idx ON files (tenant_id, blob_id);

CREATE TABLE IF NOT EXISTS file_library_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, user_id, file_id)
);
CREATE INDEX IF NOT EXISTS file_library_entries_tenant_user_active_idx
  ON file_library_entries (tenant_id, user_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS file_library_entries_tenant_file_active_idx
  ON file_library_entries (tenant_id, file_id)
  WHERE deleted_at IS NULL;

DO $berry_file_backfill$
DECLARE
  target_tenant record;
BEGIN
  FOR target_tenant IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM berry_set_tenant_id(target_tenant.id);

    INSERT INTO file_blobs (
      tenant_id, bucket, object_key, size_bytes, sha256, etag,
      object_version_id, verification_status, metadata, created_at, updated_at
    )
    SELECT f.tenant_id, f.bucket, f.object_key, f.size_bytes, NULL, f.etag,
           f.object_version_id, 'unverified',
           jsonb_build_object('backfilledFromFileId', f.id::text),
           f.created_at, f.updated_at
    FROM files f
    WHERE f.tenant_id = target_tenant.id AND f.blob_id IS NULL
    ON CONFLICT (tenant_id, bucket, object_key) DO NOTHING;

    UPDATE files f
    SET blob_id = blob.id, updated_at = f.updated_at
    FROM file_blobs blob
    WHERE f.tenant_id = target_tenant.id AND f.blob_id IS NULL
      AND blob.tenant_id = f.tenant_id
      AND blob.bucket = f.bucket
      AND blob.object_key = f.object_key;

    INSERT INTO file_library_entries (tenant_id, user_id, file_id, created_at, updated_at)
    SELECT f.tenant_id, f.owner_user_id, f.id, f.created_at, f.updated_at
    FROM files f
    WHERE f.tenant_id = target_tenant.id
      AND f.owner_user_id IS NOT NULL AND f.deleted_at IS NULL
      AND f.status IN ('scanning', 'processing', 'available')
    ON CONFLICT (tenant_id, user_id, file_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('berry.tenant_id', '', true);
END;
$berry_file_backfill$;

ALTER TABLE file_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_blobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_blobs_tenant_isolation ON file_blobs;
CREATE POLICY file_blobs_tenant_isolation ON file_blobs
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());

ALTER TABLE file_library_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_library_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_library_entries_tenant_isolation ON file_library_entries;
CREATE POLICY file_library_entries_tenant_isolation ON file_library_entries
  USING (tenant_id = berry_current_tenant_id())
  WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION = `
CREATE OR REPLACE FUNCTION berry_file_blob_before_insert_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.blob_id IS NULL THEN
    INSERT INTO file_blobs (
      tenant_id, bucket, object_key, size_bytes, etag, object_version_id,
      verification_status, metadata, created_at, updated_at
    ) VALUES (
      NEW.tenant_id, NEW.bucket, NEW.object_key, NEW.size_bytes, NEW.etag,
      NEW.object_version_id, 'unverified',
      jsonb_build_object('legacyWriterFileId', NEW.id::text),
      NEW.created_at, NEW.updated_at
    )
    RETURNING id INTO NEW.blob_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_blob_before_insert_compat ON files;
CREATE TRIGGER files_blob_before_insert_compat
BEFORE INSERT ON files
FOR EACH ROW
EXECUTE FUNCTION berry_file_blob_before_insert_compat();

CREATE OR REPLACE FUNCTION berry_file_library_after_insert_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND NEW.status IN ('scanning', 'processing', 'available') THEN
    INSERT INTO file_library_entries (
      tenant_id, user_id, file_id, created_at, updated_at
    ) VALUES (
      NEW.tenant_id, NEW.owner_user_id, NEW.id, NEW.created_at, NEW.updated_at
    )
    ON CONFLICT (tenant_id, user_id, file_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_library_after_insert_compat ON files;
CREATE TRIGGER files_library_after_insert_compat
AFTER INSERT ON files
FOR EACH ROW
EXECUTE FUNCTION berry_file_library_after_insert_compat();

CREATE UNIQUE INDEX IF NOT EXISTS file_blobs_tenant_id_id_unique
  ON file_blobs (tenant_id, id);
DO $$ BEGIN
  ALTER TABLE files
    ADD CONSTRAINT files_tenant_blob_id_fkey
    FOREIGN KEY (tenant_id, blob_id)
    REFERENCES file_blobs(tenant_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $berry_file_catchup$
DECLARE
  target_tenant record;
BEGIN
  FOR target_tenant IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM berry_set_tenant_id(target_tenant.id);

    INSERT INTO file_blobs (
      tenant_id, bucket, object_key, size_bytes, sha256, etag,
      object_version_id, verification_status, metadata, created_at, updated_at
    )
    SELECT f.tenant_id, f.bucket, f.object_key, f.size_bytes, NULL, f.etag,
           f.object_version_id, 'unverified',
           jsonb_build_object('legacyWriterCatchupFileId', f.id::text),
           f.created_at, f.updated_at
    FROM files f
    WHERE f.tenant_id = target_tenant.id AND f.blob_id IS NULL
    ON CONFLICT (tenant_id, bucket, object_key) DO NOTHING;

    UPDATE files f
    SET blob_id = blob.id, updated_at = f.updated_at
    FROM file_blobs blob
    WHERE f.tenant_id = target_tenant.id AND f.blob_id IS NULL
      AND blob.tenant_id = f.tenant_id
      AND blob.bucket = f.bucket
      AND blob.object_key = f.object_key;

    INSERT INTO file_library_entries (tenant_id, user_id, file_id, created_at, updated_at)
    SELECT f.tenant_id, f.owner_user_id, f.id, f.created_at, f.updated_at
    FROM files f
    WHERE f.tenant_id = target_tenant.id
      AND f.owner_user_id IS NOT NULL AND f.deleted_at IS NULL
      AND f.status IN ('scanning', 'processing', 'available')
    ON CONFLICT (tenant_id, user_id, file_id) DO NOTHING;
  END LOOP;
  PERFORM set_config('berry.tenant_id', '', true);
END;
$berry_file_catchup$;

-- Object storage addresses are global within a bucket, even though logical
-- rows are tenant-scoped. Refuse the migration instead of allowing two
-- tenants to claim the same physical bytes: otherwise either tenant's later
-- garbage collection could destroy the other tenant's data.
DO $berry_file_location_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM file_blobs
    GROUP BY bucket, object_key
    HAVING count(DISTINCT tenant_id) > 1
  ) THEN
    RAISE EXCEPTION 'Cross-tenant file blob location conflict detected; migration stopped without deleting data';
  END IF;
END;
$berry_file_location_guard$;
CREATE UNIQUE INDEX IF NOT EXISTS file_blobs_physical_location_unique
  ON file_blobs (bucket, object_key);
`.trim();

export const CONNECTORS_MIGRATION = `
CREATE TABLE IF NOT EXISTS connector_provider_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  client_id text NOT NULL,
  client_secret_envelope jsonb NOT NULL,
  hosted_domain text,
  picker_api_key_envelope jsonb,
  picker_project_number text,
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','verified','error')),
  last_tested_at timestamptz,
  last_error_code text,
  configured_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE IF NOT EXISTS organization_connectors (
  id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('app','custom_mcp')),
  provider text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  max_access_level text NOT NULL DEFAULT 'read' CHECK (max_access_level IN ('read','full')),
  workspace_access_mode text CHECK (workspace_access_mode IS NULL OR workspace_access_mode IN ('selected_files','search_workspace')),
  auth_strategy text NOT NULL DEFAULT 'personal' CHECK (auth_strategy IN ('personal','shared')),
  transport text CHECK (transport IS NULL OR transport IN ('http-sse','streamable-http')),
  endpoint_url text,
  auth_type text NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('none','bearer','oauth')),
  shared_credential_envelope jsonb,
  publication_status text NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft','published')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connector_key)
);
CREATE INDEX IF NOT EXISTS organization_connectors_tenant_kind_enabled_idx
  ON organization_connectors (tenant_id, kind, enabled, name);

CREATE TABLE IF NOT EXISTS connector_connections (
  id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  user_id text,
  access_level text NOT NULL DEFAULT 'read' CHECK (access_level IN ('read','full')),
  credential_envelope jsonb,
  account_email text,
  account_subject text,
  granted_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','reauth_required','revoked','error')),
  expires_at timestamptz,
  last_error_code text,
  last_successful_use_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES organization_connectors(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_personal_unique
  ON connector_connections (tenant_id, connector_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_shared_unique
  ON connector_connections (tenant_id, connector_id) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS connector_connections_user_status_idx
  ON connector_connections (tenant_id, user_id, status);

CREATE TABLE IF NOT EXISTS connector_oauth_states (
  state_digest text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  user_id text NOT NULL,
  access_level text NOT NULL CHECK (access_level IN ('read','full')),
  requested_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  code_verifier_envelope jsonb NOT NULL,
  redirect_after text NOT NULL DEFAULT '/settings/connectors',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, state_digest),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES organization_connectors(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS connector_oauth_states_expiry_idx
  ON connector_oauth_states (tenant_id, expires_at);

ALTER TABLE connector_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_provider_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_provider_credentials_tenant_isolation ON connector_provider_credentials;
CREATE POLICY connector_provider_credentials_tenant_isolation ON connector_provider_credentials
  USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());

ALTER TABLE organization_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_connectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organization_connectors_tenant_isolation ON organization_connectors;
CREATE POLICY organization_connectors_tenant_isolation ON organization_connectors
  USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());

ALTER TABLE connector_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_connections_tenant_isolation ON connector_connections;
CREATE POLICY connector_connections_tenant_isolation ON connector_connections
  USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());

ALTER TABLE connector_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connector_oauth_states_tenant_isolation ON connector_oauth_states;
CREATE POLICY connector_oauth_states_tenant_isolation ON connector_oauth_states
  USING (tenant_id = berry_current_tenant_id()) WITH CHECK (tenant_id = berry_current_tenant_id());
`.trim();

export const PLATFORM_ROLE_RLS_TABLES = [
  "tenant_memberships",
  "tenant_hostnames",
  "usage_events",
  "billing_credit_grants",
  "billing_invoices",
  "billing_meter_events",
] as const;

export const PLATFORM_ROLE_RLS_MIGRATION = PLATFORM_ROLE_RLS_TABLES.map((tableName) => `
DROP POLICY IF EXISTS ${tableName}_platform_read ON ${tableName};
CREATE POLICY ${tableName}_platform_read ON ${tableName}
  FOR SELECT
  USING (current_user = 'berry_platform');
`.trim()).join("\n\n");

export const CONNECTOR_ARTIFACTS_AND_FULL_ACCESS_MIGRATION = `
ALTER TYPE file_origin ADD VALUE IF NOT EXISTS 'connector_import';
ALTER TABLE sessions ALTER COLUMN permission_mode SET DEFAULT 'full-access';
DO $berry_full_access$
DECLARE
  target_tenant record;
BEGIN
  FOR target_tenant IN SELECT id FROM tenants ORDER BY id LOOP
    PERFORM berry_set_tenant_id(target_tenant.id);
    UPDATE sessions SET permission_mode = 'full-access', updated_at = now()
    WHERE tenant_id = target_tenant.id AND permission_mode <> 'full-access';
  END LOOP;
  PERFORM set_config('berry.tenant_id', '', true);
END;
$berry_full_access$;
`.trim();

export const VISION_MODEL_ROUTING_MIGRATION = `
CREATE TABLE IF NOT EXISTS model_auxiliary_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('vision')),
  provider_id text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, purpose)
);
CREATE INDEX IF NOT EXISTS model_auxiliary_defaults_tenant_provider_idx
  ON model_auxiliary_defaults (tenant_id, provider_id);

CREATE TABLE IF NOT EXISTS vision_observation_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  image_count integer NOT NULL CHECK (image_count > 0),
  observation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cache_key)
);
CREATE INDEX IF NOT EXISTS vision_observation_cache_tenant_last_used_idx
  ON vision_observation_cache (tenant_id, last_used_at DESC);

${tenantRlsSql("model_auxiliary_defaults")}

${tenantRlsSql("vision_observation_cache")}
`.trim();

export const cloudMigrations = [
  {
    id: 1,
    name: "cloud_postgres_v1",
    sql: CLOUD_INITIAL_MIGRATION,
  },
  {
    id: 2,
    name: "better_auth_minimal_v1",
    sql: BETTER_AUTH_MINIMAL_MIGRATION,
  },
  {
    id: 3,
    name: "usage_rollups_v1",
    sql: USAGE_ROLLUPS_MIGRATION,
  },
  {
    id: 4,
    name: "enterprise_identity_v1",
    sql: ENTERPRISE_IDENTITY_MIGRATION,
  },
  {
    id: 5,
    name: "enterprise_rbac_acl_v1",
    sql: ENTERPRISE_RBAC_MIGRATION,
  },
  {
    id: 6,
    name: "budget_ledger_v1",
    sql: BUDGET_LEDGER_MIGRATION,
  },
  {
    id: 7,
    name: "usage_pipeline_v1",
    sql: USAGE_PIPELINE_MIGRATION,
  },
  {
    id: 8,
    name: "model_governance_v1",
    sql: MODEL_GOVERNANCE_MIGRATION,
  },
  {
    id: 9,
    name: "policy_distribution_v1",
    sql: POLICY_DISTRIBUTION_MIGRATION,
  },
  {
    id: 10,
    name: "audit_platform_v1",
    sql: AUDIT_PLATFORM_MIGRATION,
  },
  {
    id: 11,
    name: "billing_platform_v1",
    sql: BILLING_PLATFORM_MIGRATION,
  },
  {
    id: 12,
    name: "mobile_companion_v1",
    sql: MOBILE_COMPANION_MIGRATION,
  },
  {
    id: 13,
    name: "conversation_kind_and_general_workspaces_v1",
    sql: CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION,
  },
  {
    id: 15,
    name: "sandbox_workspaces_v1",
    sql: SANDBOX_WORKSPACES_MIGRATION,
  },
  {
    id: 16,
    name: "personal_capabilities_v1",
    sql: PERSONAL_CAPABILITIES_MIGRATION,
  },
  { id: 17, name: "organization_capabilities_v1", sql: ORG_CAPABILITIES_MIGRATION },
  { id: 18, name: "two_profile_model_governance_v1", sql: TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION },
  { id: 19, name: "settings_administration_v1", sql: MANAGEMENT_ADMIN_MIGRATION },
  { id: 20, name: "message_attachments_v1", sql: MESSAGE_ATTACHMENTS_MIGRATION },
  { id: 21, name: "file_platform_v1", sql: FILE_PLATFORM_MIGRATION },
  { id: 23, name: "capability_permission_defaults_v1", sql: CAPABILITY_PERMISSION_DEFAULTS_MIGRATION },
  { id: 24, name: "remove_queued_follow_ups_v1", sql: REMOVE_QUEUED_FOLLOW_UPS_MIGRATION },
  { id: 25, name: "message_sequence_v1", sql: MESSAGE_SEQUENCE_MIGRATION },
  { id: 26, name: "file_library_search_v1", sql: FILE_LIBRARY_SEARCH_MIGRATION },
  { id: 27, name: "durable_context_memory_knowledge_runner_v1", sql: DURABLE_CONTEXT_MIGRATION },
  { id: 28, name: "session_compaction_leases_v1", sql: SESSION_COMPACTION_LEASES_MIGRATION },
  { id: 29, name: "durable_turn_bindings_v1", sql: DURABLE_TURN_BINDINGS_MIGRATION },
  { id: 30, name: "durable_turn_questions_v1", sql: DURABLE_TURN_QUESTIONS_MIGRATION },
  { id: 31, name: "message_citations_v1", sql: MESSAGE_CITATIONS_MIGRATION },
  { id: 32, name: "maintenance_runs_v1", sql: MAINTENANCE_RUNS_MIGRATION },
  { id: 33, name: "self_hosted_embedding_profile_v2", sql: SELF_HOSTED_EMBEDDING_PROFILE_MIGRATION },
  { id: 34, name: "knowledge_vector_hnsw_v1", sql: KNOWLEDGE_VECTOR_HNSW_MIGRATION },
  { id: 35, name: "tenant_context_execute_hardening_v1", sql: TENANT_CONTEXT_EXECUTE_HARDENING_MIGRATION },
  { id: 36, name: "personalization_profiles_v1", sql: PERSONALIZATION_PROFILE_MIGRATION },
  { id: 37, name: "allowance_cycles_v1", sql: ALLOWANCE_CYCLES_MIGRATION },
  { id: 38, name: "organization_model_providers_v1", sql: ORGANIZATION_MODEL_PROVIDERS_MIGRATION },
  { id: 39, name: "organization_ai_access_rules_v1", sql: ORGANIZATION_AI_ACCESS_RULES_MIGRATION },
  { id: 40, name: "allowance_base_hierarchy_v1", sql: ALLOWANCE_BASE_HIERARCHY_MIGRATION },
  { id: 41, name: "terminal_sandbox_cleanup_index_v1", sql: TERMINAL_SANDBOX_CLEANUP_INDEX_MIGRATION },
  { id: 42, name: "turn_run_admission_idempotency_v1", sql: TURN_RUN_ADMISSION_IDEMPOTENCY_MIGRATION },
  { id: 43, name: "file_reference_safe_lifecycle_v1", sql: FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION },
  { id: 44, name: "file_reference_safe_legacy_writer_compat_v1", sql: FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION },
  { id: 45, name: "connectors_v1", sql: CONNECTORS_MIGRATION },
  { id: 46, name: "google_workspace_sso_v1", sql: GOOGLE_WORKSPACE_SSO_MIGRATION },
  { id: 47, name: "platform_role_rls_v1", sql: PLATFORM_ROLE_RLS_MIGRATION },
  { id: 48, name: "connector_artifacts_and_full_access_v1", sql: CONNECTOR_ARTIFACTS_AND_FULL_ACCESS_MIGRATION },
  { id: 49, name: "vision_model_routing_v1", sql: VISION_MODEL_ROUTING_MIGRATION },
  { id: 50, name: "skill_package_files_v1", sql: SKILL_PACKAGE_FILES_MIGRATION },
  { id: 51, name: "turn_admission_intents_v1", sql: TURN_ADMISSION_INTENTS_MIGRATION },
  { id: 52, name: "deep_research_skill_v1", sql: DEEP_RESEARCH_SKILL_MIGRATION },
  {
    id: 53,
    name: "message_history_pagination_v1",
    sql: MESSAGE_HISTORY_PAGINATION_MIGRATION,
    transactional: false,
    onlineIndexName: "message_parts_tenant_message_ordinal_idx",
  },
  { id: 54, name: "message_history_revision_v1", sql: MESSAGE_HISTORY_REVISION_MIGRATION },
  { id: 55, name: "message_history_deletion_revision_v1", sql: MESSAGE_HISTORY_DELETION_REVISION_MIGRATION },
  {
    id: 56,
    name: "enterprise_collection_pagination_v1",
    sql: ENTERPRISE_COLLECTION_PAGINATION_MIGRATION,
    transactional: false,
    onlineIndexNames: [
      "workspaces_tenant_owner_updated_id_idx",
      "tasks_tenant_user_updated_id_idx",
      "tasks_tenant_user_archive_updated_id_idx",
      "tasks_tenant_workspace_archive_updated_id_idx",
      "tasks_tenant_title_prefix_idx",
      "tenant_memberships_tenant_updated_user_idx",
      "users_lower_email_idx",
      "department_memberships_tenant_user_department_idx",
      "departments_tenant_updated_id_idx",
      "departments_tenant_name_id_idx",
    ],
    onlineSql: ENTERPRISE_COLLECTION_PAGINATION_STATEMENTS,
  },
] as const;
