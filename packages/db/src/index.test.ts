import {
  ApprovalKindSchema,
  ApprovalStatusSchema,
  ConversationKindSchema,
  MessagePartKindSchema,
  MessageRoleSchema,
  PermissionModeSchema,
  SessionStatusSchema,
  TaskStatusSchema,
  ToolCallStatusSchema,
  UiModeSchema,
  UiModeSourceSchema,
  WorkspaceKindSchema,
} from "@berry/shared";
import { describe, expect, it } from "vitest";
import {
  APPEND_ONLY_SQL,
  AUDIT_PLATFORM_MIGRATION,
  AUDIT_PLATFORM_TABLES,
  AUDIT_PLATFORM_TENANT_SCOPED_TABLES,
  BETTER_AUTH_MINIMAL_MIGRATION,
  BILLING_PLATFORM_MIGRATION,
  BILLING_PLATFORM_TABLES,
  BILLING_PLATFORM_TENANT_SCOPED_TABLES,
  BUDGET_LEDGER_MIGRATION,
  BUDGET_LEDGER_TABLES,
  BUDGET_LEDGER_TENANT_SCOPED_TABLES,
  CAPABILITY_PERMISSION_DEFAULTS_MIGRATION,
  CLOUD_INITIAL_MIGRATION,
  CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION,
  CLOUD_SCHEMA_SQL,
  CLOUD_SCHEMA_TABLES,
  ENTERPRISE_IDENTITY_MIGRATION,
  ENTERPRISE_IDENTITY_TABLES,
  ENTERPRISE_IDENTITY_TENANT_SCOPED_TABLES,
  ENTERPRISE_RBAC_MIGRATION,
  ENTERPRISE_RBAC_TABLES,
  ENTERPRISE_RBAC_TENANT_SCOPED_TABLES,
  FILE_PLATFORM_MIGRATION,
  MODEL_GOVERNANCE_MIGRATION,
  MODEL_GOVERNANCE_TABLES,
  MODEL_GOVERNANCE_TENANT_SCOPED_TABLES,
  MOBILE_COMPANION_MIGRATION,
  MOBILE_COMPANION_TABLES,
  MOBILE_COMPANION_TENANT_SCOPED_TABLES,
  MANAGEMENT_ADMIN_MIGRATION,
  MANAGEMENT_ADMIN_TABLES,
  MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES,
  POLICY_DISTRIBUTION_MIGRATION,
  POLICY_DISTRIBUTION_TABLES,
  POLICY_DISTRIBUTION_TENANT_SCOPED_TABLES,
  QUEUED_FOLLOW_UPS_MIGRATION,
  SANDBOX_WORKSPACES_MIGRATION,
  PERSONAL_CAPABILITIES_MIGRATION,
  ORG_CAPABILITIES_MIGRATION,
  TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION,
  SELF_HOST_SEED_SQL,
  SELF_HOST_TENANT_ID,
  SELF_HOST_WORKSPACE_ID,
  SELF_HOST_WORKSPACE_SLUG,
  TENANT_CONTEXT_SQL,
  TENANT_RLS_SQL,
  TENANT_SCOPED_TABLES,
  USAGE_PIPELINE_MIGRATION,
  USAGE_ROLLUPS_MIGRATION,
  approvalKindEnum,
  approvalStatusEnum,
  cloudMigrations,
  conversationKindEnum,
  messagePartKindEnum,
  messageRoleEnum,
  permissionModeEnum,
  sessionStatusEnum,
  taskStatusEnum,
  toolCallStatusEnum,
  uiModeEnum,
  uiModeSourceEnum,
  workspaceKindEnum,
} from "./index.ts";

describe("cloud postgres schema", () => {
  it("defines the Phase 8 table set named in the execution plan", () => {
    expect(CLOUD_SCHEMA_TABLES).toEqual([
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
      "tool_calls",
      "approvals",
      "usage_events",
      "usage_rollups",
      "audit_events",
    ]);
    const fullMigrationSql = [CLOUD_SCHEMA_SQL, BETTER_AUTH_MINIMAL_MIGRATION, USAGE_ROLLUPS_MIGRATION].join("\n");
    for (const table of CLOUD_SCHEMA_TABLES) {
      expect(fullMigrationSql).toContain(`CREATE TABLE`);
      expect(fullMigrationSql).toContain(table);
    }
    expect(CLOUD_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
  });

  it("keeps database enums aligned with shared Zod contracts", () => {
    expect(taskStatusEnum.enumValues).toEqual(TaskStatusSchema.options);
    expect(sessionStatusEnum.enumValues).toEqual(SessionStatusSchema.options);
    expect(permissionModeEnum.enumValues).toEqual(PermissionModeSchema.options);
    expect(messageRoleEnum.enumValues).toEqual(MessageRoleSchema.options);
    expect(messagePartKindEnum.enumValues).toEqual(MessagePartKindSchema.options);
    expect(toolCallStatusEnum.enumValues).toEqual(ToolCallStatusSchema.options);
    expect(approvalKindEnum.enumValues).toEqual(ApprovalKindSchema.options);
    expect(approvalStatusEnum.enumValues).toEqual(ApprovalStatusSchema.options);
    expect(uiModeEnum.enumValues).toEqual(UiModeSchema.options);
    expect(uiModeSourceEnum.enumValues).toEqual(UiModeSourceSchema.options);
    expect(conversationKindEnum.enumValues).toEqual(ConversationKindSchema.options);
    expect(workspaceKindEnum.enumValues).toEqual(WorkspaceKindSchema.options);
  });

  it("puts every tenant-owned table behind direct tenant GUC RLS", () => {
    expect(TENANT_CONTEXT_SQL).toContain("current_setting('berry.tenant_id', true)");
    expect(TENANT_CONTEXT_SQL).toContain("set_config('berry.tenant_id'");
    for (const table of TENANT_SCOPED_TABLES) {
      expect(TENANT_RLS_SQL).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(TENANT_RLS_SQL).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(TENANT_RLS_SQL).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
      expect(TENANT_RLS_SQL).toContain("USING (tenant_id = berry_current_tenant_id())");
      expect(TENANT_RLS_SQL).toContain("WITH CHECK (tenant_id = berry_current_tenant_id())");
    }
    expect(TENANT_SCOPED_TABLES).not.toContain("users");
    expect(TENANT_SCOPED_TABLES).not.toContain("auth_sessions");
    expect(TENANT_SCOPED_TABLES).not.toContain("auth_accounts");
    expect(TENANT_SCOPED_TABLES).not.toContain("auth_verifications");
  });

  it("adds Better Auth storage as an additive migration without overloading agent sessions", () => {
    expect(BETTER_AUTH_MINIMAL_MIGRATION).toContain("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified");
    expect(BETTER_AUTH_MINIMAL_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS auth_sessions");
    expect(BETTER_AUTH_MINIMAL_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS auth_accounts");
    expect(BETTER_AUTH_MINIMAL_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS auth_verifications");
    expect(BETTER_AUTH_MINIMAL_MIGRATION).not.toContain("CREATE TABLE IF NOT EXISTS sessions");
  });

  it("persists usage and audit records append-only with idempotent usage requests", () => {
    expect(CLOUD_SCHEMA_SQL).toContain("UNIQUE (tenant_id, request_id)");
    expect(CLOUD_SCHEMA_SQL).toContain("UNIQUE (tenant_id, sequence)");
    expect(APPEND_ONLY_SQL).toContain("usage_events_reject_update");
    expect(APPEND_ONLY_SQL).toContain("usage_events_reject_delete");
    expect(APPEND_ONLY_SQL).toContain("audit_events_reject_update");
    expect(APPEND_ONLY_SQL).toContain("audit_events_reject_delete");
  });

  it("adds usage rollups as a derived additive table without weakening usage event append-only semantics", () => {
    expect(USAGE_ROLLUPS_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS usage_rollups");
    expect(USAGE_ROLLUPS_MIGRATION).toContain("UNIQUE (tenant_id, bucket_start, granularity, feature, provider, model, status)");
    expect(USAGE_ROLLUPS_MIGRATION).toContain("usage_rollups_nonnegative_counts");
    expect(USAGE_ROLLUPS_MIGRATION).not.toContain("ALTER TABLE usage_events");
    expect(cloudMigrations.map((migration) => migration.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it("adds canonical files, associations, multipart uploads, and derivatives behind tenant RLS", () => {
    for (const table of ["files", "file_associations", "file_uploads", "file_derivatives"]) {
      expect(FILE_PLATFORM_MIGRATION).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(FILE_PLATFORM_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(FILE_PLATFORM_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(FILE_PLATFORM_MIGRATION).toContain("file_associations_context_unique");
    expect(FILE_PLATFORM_MIGRATION).toContain("file_uploads_tenant_status_expiry_idx");
    expect(FILE_PLATFORM_MIGRATION).not.toContain("DROP TABLE");
  });

  it("adds tenant-scoped queued follow-ups without changing legacy task tables", () => {
    expect(QUEUED_FOLLOW_UPS_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS queued_follow_ups");
    expect(QUEUED_FOLLOW_UPS_MIGRATION).toContain("UNIQUE (tenant_id, session_id, ordinal)");
    expect(QUEUED_FOLLOW_UPS_MIGRATION).toContain("queued_follow_ups_tenant_isolation");
    expect(QUEUED_FOLLOW_UPS_MIGRATION).not.toContain("DROP TABLE");
    expect(SANDBOX_WORKSPACES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS sandbox_workspaces");
    expect(SANDBOX_WORKSPACES_MIGRATION).toContain("sandbox_workspaces_tenant_isolation");
    expect(PERSONAL_CAPABILITIES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS personal_skills");
    expect(PERSONAL_CAPABILITIES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS personal_mcp_servers");
    expect(PERSONAL_CAPABILITIES_MIGRATION).not.toContain("credential text");
    expect(ORG_CAPABILITIES_MIGRATION).toContain("organization_capabilities");
    expect(ORG_CAPABILITIES_MIGRATION).toContain("capability_user_overrides");
  });

  it("adds enterprise identity tables and host mapping additively in Phase 9", () => {
    expect(ENTERPRISE_IDENTITY_TABLES).toEqual([
      "departments",
      "department_memberships",
      "tenant_hostnames",
      "sso_connections",
      "scim_identities",
    ]);
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("ALTER TABLE tenant_memberships ADD COLUMN IF NOT EXISTS role");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS departments");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("parent_id uuid REFERENCES departments(id) ON DELETE SET NULL");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS department_memberships");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS tenant_hostnames");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("hostname text NOT NULL UNIQUE");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS sso_connections");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("kind text NOT NULL CHECK (kind IN ('saml', 'oidc'))");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS scim_identities");
    expect(ENTERPRISE_IDENTITY_MIGRATION).toContain("UNIQUE (tenant_id, resource_type, external_id)");
    expect(ENTERPRISE_IDENTITY_MIGRATION).not.toContain("DROP TABLE");
  });

  it("protects enterprise identity tenant-owned tables with additive RLS policies", () => {
    for (const table of ENTERPRISE_IDENTITY_TENANT_SCOPED_TABLES) {
      expect(ENTERPRISE_IDENTITY_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(ENTERPRISE_IDENTITY_MIGRATION).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(ENTERPRISE_IDENTITY_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
  });

  it("adds enterprise RBAC, ACL, and feature-flag defaults additively in Phase 9", () => {
    expect(ENTERPRISE_RBAC_TABLES).toEqual([
      "role_permission_defaults",
      "resource_acls",
      "feature_flags",
    ]);
    expect(ENTERPRISE_RBAC_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS role_permission_defaults");
    expect(ENTERPRISE_RBAC_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS resource_acls");
    expect(ENTERPRISE_RBAC_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS feature_flags");
    expect(ENTERPRISE_RBAC_MIGRATION).toContain("'enterprise-governance'");
    expect(ENTERPRISE_RBAC_MIGRATION).toContain('"policy:write"');
    expect(ENTERPRISE_RBAC_MIGRATION).not.toContain("DROP TABLE");
    expect(ENTERPRISE_RBAC_MIGRATION).not.toContain("ALTER TABLE tenants");
  });

  it("backfills Skills and MCP permissions using the application role defaults", () => {
    expect(CAPABILITY_PERMISSION_DEFAULTS_MIGRATION).toContain(`'{owner}'`);
    expect(CAPABILITY_PERMISSION_DEFAULTS_MIGRATION).toContain(`'{admin}'`);
    expect(CAPABILITY_PERMISSION_DEFAULTS_MIGRATION).toContain(`'{member}'`);
    expect(CAPABILITY_PERMISSION_DEFAULTS_MIGRATION).toContain('"skills:write"');
    expect(CAPABILITY_PERMISSION_DEFAULTS_MIGRATION).toContain('"mcp:write"');
    expect(CAPABILITY_PERMISSION_DEFAULTS_MIGRATION).not.toContain("DROP TABLE");
  });

  it("protects enterprise RBAC tenant-owned tables with additive RLS policies", () => {
    for (const table of ENTERPRISE_RBAC_TENANT_SCOPED_TABLES) {
      expect(ENTERPRISE_RBAC_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(ENTERPRISE_RBAC_MIGRATION).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(ENTERPRISE_RBAC_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
  });

  it("adds budget ledgers and hot-counter snapshots additively in Phase 9", () => {
    expect(BUDGET_LEDGER_TABLES).toEqual([
      "budget_limits",
      "budget_reservations",
      "credit_ledger_entries",
      "budget_counter_snapshots",
    ]);
    expect(BUDGET_LEDGER_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS budget_limits");
    expect(BUDGET_LEDGER_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS budget_reservations");
    expect(BUDGET_LEDGER_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS credit_ledger_entries");
    expect(BUDGET_LEDGER_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS budget_counter_snapshots");
    expect(BUDGET_LEDGER_MIGRATION).toContain("UNIQUE (tenant_id, request_id, scope_type, scope_id, kind)");
    expect(BUDGET_LEDGER_MIGRATION).toContain("budget_reservations_nonnegative");
    expect(BUDGET_LEDGER_MIGRATION).toContain("'disabled'");
    expect(BUDGET_LEDGER_MIGRATION).not.toContain("ALTER TABLE usage_events");
    expect(BUDGET_LEDGER_MIGRATION).not.toContain("DROP TABLE");
  });

  it("protects budget tenant-owned tables with additive RLS policies", () => {
    for (const table of BUDGET_LEDGER_TENANT_SCOPED_TABLES) {
      expect(BUDGET_LEDGER_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(BUDGET_LEDGER_MIGRATION).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(BUDGET_LEDGER_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
  });

  it("adds signed usage pipeline metadata additively while preserving append-only events", () => {
    expect(USAGE_PIPELINE_MIGRATION).toContain("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source");
    expect(USAGE_PIPELINE_MIGRATION).toContain("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS department_id");
    expect(USAGE_PIPELINE_MIGRATION).toContain("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS signed_payload");
    expect(USAGE_PIPELINE_MIGRATION).toContain("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS signature");
    expect(USAGE_PIPELINE_MIGRATION).toContain("usage_events_tenant_feature_ts_idx");
    expect(USAGE_PIPELINE_MIGRATION).toContain("usage_events_tenant_department_ts_idx");
    expect(USAGE_PIPELINE_MIGRATION).not.toContain("DROP");
    expect(USAGE_PIPELINE_MIGRATION).not.toContain("DISABLE TRIGGER");
    expect(APPEND_ONLY_SQL).toContain("usage_events_reject_update");
    expect(APPEND_ONLY_SQL).toContain("usage_events_reject_delete");
  });

  it("adds model governance policies and per-mode defaults additively with RLS", () => {
    expect(MODEL_GOVERNANCE_TABLES).toEqual(["model_governance_policies", "model_mode_defaults", "model_conversation_kind_defaults"]);
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS model_governance_policies");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS model_mode_defaults");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS model_conversation_kind_defaults");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("UNIQUE (tenant_id, provider_id, model)");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("UNIQUE (tenant_id, mode)");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("'berry/auto'");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain(`mode_allow jsonb NOT NULL DEFAULT '["chat","code"]'::jsonb`);
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("CROSS JOIN (VALUES ('chat'), ('code')) AS defaults(mode)");
    expect(MODEL_GOVERNANCE_MIGRATION).toContain("WHERE NOT EXISTS");
    for (const table of MODEL_GOVERNANCE_TENANT_SCOPED_TABLES) {
      expect(MODEL_GOVERNANCE_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(MODEL_GOVERNANCE_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(MODEL_GOVERNANCE_MIGRATION).not.toContain("ALTER TABLE usage_events");
    expect(MODEL_GOVERNANCE_MIGRATION).not.toContain("DROP TABLE");
  });

  it("normalizes existing model governance records to Chat and Code without dropping compatibility columns", () => {
    expect(TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION).toContain("ALTER COLUMN mode_allow SET DEFAULT");
    expect(TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION).toContain("CASE WHEN value = 'cowork' THEN 'chat'");
    expect(TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION).toContain("ON CONFLICT (tenant_id, mode) DO NOTHING");
    expect(TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION).toContain("DELETE FROM model_mode_defaults WHERE mode = 'cowork'");
    expect(TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION).not.toContain("DROP TABLE");
    expect(TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION).not.toContain("DROP COLUMN");
  });

  it("adds conversation kinds and owner-scoped General workspaces without deleting legacy fields", () => {
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("ADD COLUMN IF NOT EXISTS workspace_kind");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("ADD COLUMN IF NOT EXISTS conversation_kind");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("WHEN ui_mode = 'code' THEN 'code'");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("WHEN ui_mode IN ('chat', 'cowork') THEN 'chat'");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("workspaces_tenant_owner_general_unique");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("WHERE workspace_kind = 'general' AND deleted_at IS NULL");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("CASE mode WHEN 'chat' THEN 0 ELSE 1 END");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).toContain("model_conversation_kind_defaults_tenant_isolation");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).not.toContain("DROP TABLE");
    expect(CONVERSATION_KIND_AND_GENERAL_WORKSPACES_MIGRATION).not.toContain("DROP COLUMN");
  });

  it("adds signed policy distribution versions additively with RLS", () => {
    expect(POLICY_DISTRIBUTION_TABLES).toEqual(["policy_versions"]);
    expect(POLICY_DISTRIBUTION_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS policy_versions");
    expect(POLICY_DISTRIBUTION_MIGRATION).toContain("bundle jsonb NOT NULL");
    expect(POLICY_DISTRIBUTION_MIGRATION).toContain("bundle_hash text NOT NULL");
    expect(POLICY_DISTRIBUTION_MIGRATION).toContain("key_id text NOT NULL");
    expect(POLICY_DISTRIBUTION_MIGRATION).toContain("UNIQUE (tenant_id, version)");
    expect(POLICY_DISTRIBUTION_MIGRATION).toContain("WHERE status = 'active'");
    for (const table of POLICY_DISTRIBUTION_TENANT_SCOPED_TABLES) {
      expect(POLICY_DISTRIBUTION_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(POLICY_DISTRIBUTION_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(POLICY_DISTRIBUTION_MIGRATION).not.toContain("ALTER TABLE usage_events");
    expect(POLICY_DISTRIBUTION_MIGRATION).not.toContain("DROP TABLE");
  });

  it("adds audit retention and export configuration additively with RLS", () => {
    expect(AUDIT_PLATFORM_TABLES).toEqual(["audit_settings", "audit_export_configs"]);
    expect(AUDIT_PLATFORM_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS audit_settings");
    expect(AUDIT_PLATFORM_MIGRATION).toContain("retention_days integer NOT NULL DEFAULT 90");
    expect(AUDIT_PLATFORM_MIGRATION).toContain("client_ingest_enabled boolean NOT NULL DEFAULT false");
    expect(AUDIT_PLATFORM_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS audit_export_configs");
    expect(AUDIT_PLATFORM_MIGRATION).toContain("CHECK (kind IN ('webhook', 's3'))");
    expect(AUDIT_PLATFORM_MIGRATION).toContain("UNIQUE (tenant_id, kind, destination)");
    for (const table of AUDIT_PLATFORM_TENANT_SCOPED_TABLES) {
      expect(AUDIT_PLATFORM_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(AUDIT_PLATFORM_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(AUDIT_PLATFORM_MIGRATION).not.toContain("ALTER TABLE audit_events");
    expect(AUDIT_PLATFORM_MIGRATION).not.toContain("DISABLE TRIGGER");
    expect(AUDIT_PLATFORM_MIGRATION).not.toContain("DROP TABLE");
  });

  it("adds prepaid-credit billing records and meter reporting state additively with RLS", () => {
    expect(BILLING_PLATFORM_TABLES).toEqual([
      "billing_credit_grants",
      "billing_meter_events",
      "billing_invoices",
    ]);
    expect(BILLING_PLATFORM_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS billing_credit_grants");
    expect(BILLING_PLATFORM_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS billing_meter_events");
    expect(BILLING_PLATFORM_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS billing_invoices");
    expect(BILLING_PLATFORM_MIGRATION).toContain("CHECK (source IN ('stripe', 'manual', 'support', 'fixture'))");
    expect(BILLING_PLATFORM_MIGRATION).toContain("CHECK (provider IN ('none', 'stripe', 'lago'))");
    expect(BILLING_PLATFORM_MIGRATION).toContain("UNIQUE (tenant_id, request_id, meter)");
    expect(BILLING_PLATFORM_MIGRATION).toContain("self-host-no-billing");
    for (const table of BILLING_PLATFORM_TENANT_SCOPED_TABLES) {
      expect(BILLING_PLATFORM_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(BILLING_PLATFORM_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(BILLING_PLATFORM_MIGRATION).not.toContain("ALTER TABLE usage_events");
    expect(BILLING_PLATFORM_MIGRATION).not.toContain("DROP TABLE");
  });

  it("adds mobile companion device registration additively with RLS", () => {
    expect(MOBILE_COMPANION_TABLES).toEqual(["mobile_devices"]);
    expect(MOBILE_COMPANION_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS mobile_devices");
    expect(MOBILE_COMPANION_MIGRATION).toContain("push_token_ciphertext text");
    expect(MOBILE_COMPANION_MIGRATION).toContain("push_token_last4 text");
    expect(MOBILE_COMPANION_MIGRATION).toContain("CHECK (push_provider IN ('expo', 'apns', 'fcm', 'none'))");
    expect(MOBILE_COMPANION_MIGRATION).toContain("CHECK (endpoint_mode IN ('berry-account', 'self-hosted', 'custom-openai', 'lan-local'))");
    expect(MOBILE_COMPANION_MIGRATION).toContain("UNIQUE (tenant_id, device_id)");
    for (const table of MOBILE_COMPANION_TENANT_SCOPED_TABLES) {
      expect(MOBILE_COMPANION_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(MOBILE_COMPANION_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(MOBILE_COMPANION_MIGRATION).not.toContain("ALTER TABLE usage_events");
    expect(MOBILE_COMPANION_MIGRATION).not.toContain("DROP TABLE");
  });

  it("adds settings and administration storage additively with forced tenant RLS", () => {
    expect(MANAGEMENT_ADMIN_TABLES).toContain("allowance_profiles");
    expect(MANAGEMENT_ADMIN_TABLES).toContain("service_accounts");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS agent_id");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("ALTER TABLE budget_limits ADD COLUMN IF NOT EXISTS request_limit");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("UNIQUE (tenant_id, schedule_id, window_key)");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("UNIQUE (tenant_id, rule_id, window_key)");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("token_hash text NOT NULL");
    expect(MANAGEMENT_ADMIN_MIGRATION).not.toContain("token text");
    expect(MANAGEMENT_ADMIN_MIGRATION).not.toContain("DROP TABLE");
    for (const table of MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES) {
      expect(MANAGEMENT_ADMIN_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(MANAGEMENT_ADMIN_MIGRATION).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(MANAGEMENT_ADMIN_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
      expect(MANAGEMENT_ADMIN_MIGRATION).toContain("USING (tenant_id = berry_current_tenant_id())");
    }
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS platform_rollout_rules");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS platform_operator_audit_events");
    expect(MANAGEMENT_ADMIN_MIGRATION).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES).not.toContain("platform_rollout_rules");
    expect(MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES).not.toContain("platform_operator_audit_events");
  });

  it("seeds a single-tenant self-host default without requiring a cloud account", () => {
    expect(SELF_HOST_TENANT_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(SELF_HOST_WORKSPACE_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(SELF_HOST_SEED_SQL).toContain("INSERT INTO tenants");
    expect(SELF_HOST_SEED_SQL).toContain("INSERT INTO workspaces");
    expect(SELF_HOST_SEED_SQL).toContain("'self-host'");
    expect(SELF_HOST_SEED_SQL).toContain(`'${SELF_HOST_WORKSPACE_SLUG}'`);
    expect(SELF_HOST_SEED_SQL).toContain("'selfhost'");
    expect(SELF_HOST_SEED_SQL).toContain("ON CONFLICT");
  });

  it("exports ordered additive migrations for API startup and compose smoke tests", () => {
    expect(CLOUD_INITIAL_MIGRATION).toContain(CLOUD_SCHEMA_SQL);
    expect(CLOUD_INITIAL_MIGRATION).toContain(TENANT_CONTEXT_SQL);
    expect(CLOUD_INITIAL_MIGRATION).toContain(TENANT_RLS_SQL);
    expect(CLOUD_INITIAL_MIGRATION).toContain(APPEND_ONLY_SQL);
    expect(CLOUD_INITIAL_MIGRATION).toContain(SELF_HOST_SEED_SQL);
    expect(BETTER_AUTH_MINIMAL_MIGRATION).not.toContain("CREATE TYPE deployment_mode");
    expect(USAGE_ROLLUPS_MIGRATION).not.toContain("CREATE TYPE deployment_mode");
  });

  it("keeps the initial usage_events SQL runnable on Postgres", () => {
    const usageEventsBlock = CLOUD_SCHEMA_SQL.match(/CREATE TABLE usage_events \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(usageEventsBlock.match(/\bsession_id\b/g)).toHaveLength(1);
  });
});
