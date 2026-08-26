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
  AGENT_HARNESS_COMPACTION_ALGORITHM_KEY_MIGRATION,
  AGENT_OPERATIONAL_EVENTS_RETENTION_INDEX_MIGRATION,
  ALLOWANCE_BASE_HIERARCHY_MIGRATION,
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
  CONNECTOR_APPROVAL_WORKFLOW_MIGRATION,
  CONNECTOR_APPROVAL_REQUESTS_MIGRATION,
  CONNECTORS_MIGRATION,
  CLOUD_SCHEMA_SQL,
  CLOUD_SCHEMA_TABLES,
  DURABLE_CONTEXT_MIGRATION,
  DURABLE_CONTEXT_TABLES,
  DURABLE_TURN_BINDINGS_MIGRATION,
  DURABLE_TURN_QUESTIONS_MIGRATION,
  DEEP_RESEARCH_SKILL_MIGRATION,
  ENTERPRISE_IDENTITY_MIGRATION,
  ENTERPRISE_IDENTITY_TABLES,
  ENTERPRISE_IDENTITY_TENANT_SCOPED_TABLES,
  ENTERPRISE_RBAC_MIGRATION,
  ENTERPRISE_RBAC_TABLES,
  ENTERPRISE_RBAC_TENANT_SCOPED_TABLES,
  FILE_PLATFORM_MIGRATION,
  FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION,
  FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION,
  GOOGLE_WORKSPACE_SSO_MIGRATION,
  FILE_LIBRARY_SEARCH_MIGRATION,
  MODEL_GOVERNANCE_MIGRATION,
  MODEL_GOVERNANCE_TABLES,
  MODEL_GOVERNANCE_TENANT_SCOPED_TABLES,
  MOBILE_COMPANION_MIGRATION,
  MOBILE_COMPANION_TABLES,
  MOBILE_COMPANION_TENANT_SCOPED_TABLES,
  MANAGEMENT_ADMIN_MIGRATION,
  MANAGEMENT_ADMIN_TABLES,
  MANAGEMENT_ADMIN_TENANT_SCOPED_TABLES,
  MAINTENANCE_RUNS_MIGRATION,
  MESSAGE_HISTORY_DELETION_REVISION_MIGRATION,
  MESSAGE_HISTORY_REVISION_MIGRATION,
  MESSAGE_CITATIONS_MIGRATION,
  MESSAGE_SEQUENCE_MIGRATION,
  POLICY_DISTRIBUTION_MIGRATION,
  POLICY_DISTRIBUTION_TABLES,
  POLICY_DISTRIBUTION_TENANT_SCOPED_TABLES,
  PLATFORM_ROLE_RLS_MIGRATION,
  PLATFORM_ROLE_RLS_TABLES,
  REMOVE_QUEUED_FOLLOW_UPS_MIGRATION,
  SANDBOX_WORKSPACES_MIGRATION,
  SELF_HOSTED_EMBEDDING_PROFILE_MIGRATION,
  KNOWLEDGE_VECTOR_HNSW_MIGRATION,
  SESSION_COMPACTION_LEASES_MIGRATION,
  SESSION_CHECKPOINT_SERIALIZED_BYTES_MIGRATION,
  SKILL_PACKAGE_FILES_MIGRATION,
  TURN_ADMISSION_INTENTS_MIGRATION,
  PERSONAL_CAPABILITIES_MIGRATION,
  ORG_CAPABILITIES_MIGRATION,
  TWO_PROFILE_MODEL_GOVERNANCE_MIGRATION,
  SELF_HOST_SEED_SQL,
  SELF_HOST_TENANT_ID,
  SELF_HOST_WORKSPACE_ID,
  SELF_HOST_WORKSPACE_SLUG,
  TENANT_CONTEXT_SQL,
  TENANT_CONTEXT_EXECUTE_HARDENING_MIGRATION,
  TENANT_RLS_SQL,
  TENANT_SCOPED_TABLES,
  USAGE_PIPELINE_MIGRATION,
  USAGE_ROLLUPS_MIGRATION,
  VISION_MODEL_ROUTING_MIGRATION,
  approvalKindEnum,
  approvalStatusEnum,
  cloudMigrations,
  conversationKindEnum,
  messagePartKindEnum,
  messageHistoryRevisionDelta,
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
    expect(CLOUD_SCHEMA_TABLES).toEqual(expect.arrayContaining([
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
      ...DURABLE_CONTEXT_TABLES,
    ]));
    const fullMigrationSql = cloudMigrations.map((migration) => migration.sql).join("\n");
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
    expect(cloudMigrations.map((migration) => migration.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
  });

  it("replaces legacy checkpoint uniqueness with the algorithm-version key", () => {
    expect(cloudMigrations.find((migration) => migration.id === 65)).toMatchObject({
      name: "agent_harness_compaction_algorithm_key_v1",
    });
    expect(AGENT_HARNESS_COMPACTION_ALGORITHM_KEY_MIGRATION).toContain(
      "ALTER TABLE session_checkpoints DROP CONSTRAINT",
    );
    expect(AGENT_HARNESS_COMPACTION_ALGORITHM_KEY_MIGRATION).toContain(
      "tenant_id,session_id,kind,source_leaf_id,covered_entry_end,schema_version,algorithm_version",
    );
    expect(AGENT_HARNESS_COMPACTION_ALGORITHM_KEY_MIGRATION).toContain(
      "DROP INDEX IF EXISTS session_checkpoints_idempotency_unique",
    );
  });

  it("stages agent-harness migrations outside one release-wide transaction", () => {
    expect(cloudMigrations
      .filter((migration) => migration.id >= 58)
      .every((migration) => "transactional" in migration && migration.transactional === false)).toBe(true);
  });

  it("adds an online retention index for operational telemetry cleanup", () => {
    expect(AGENT_OPERATIONAL_EVENTS_RETENTION_INDEX_MIGRATION).toContain("CREATE INDEX CONCURRENTLY");
    expect(AGENT_OPERATIONAL_EVENTS_RETENTION_INDEX_MIGRATION).toContain("tenant_id, created_at");
    expect(cloudMigrations.find((migration) => migration.id === 66)).toMatchObject({
      transactional: false,
      onlineIndexName: "agent_operational_events_retention_idx",
    });
  });

  it("adds exact serialized-byte accounting for session checkpoints", () => {
    expect(SESSION_CHECKPOINT_SERIALIZED_BYTES_MIGRATION).toContain(
      "ADD COLUMN IF NOT EXISTS serialized_bytes integer NOT NULL DEFAULT 0",
    );
    expect(cloudMigrations.find((migration) => migration.id === 67)).toMatchObject({
      name: "session_checkpoint_serialized_bytes_v1",
      transactional: false,
    });
  });

  it("tracks projection updates separately from message deletions", () => {
    expect(MESSAGE_HISTORY_REVISION_MIGRATION).toContain("AFTER UPDATE OR DELETE ON messages");
    expect(MESSAGE_HISTORY_REVISION_MIGRATION).toContain("AFTER UPDATE OR DELETE ON message_parts");
    expect(MESSAGE_HISTORY_DELETION_REVISION_MIGRATION).toContain("AFTER UPDATE OR DELETE ON messages");
    expect(MESSAGE_HISTORY_DELETION_REVISION_MIGRATION).toContain("TG_TABLE_NAME = 'messages' AND TG_OP = 'DELETE'");
  });

  it("executes the history trigger contract for every row operation", () => {
    const operations = ["INSERT", "UPDATE", "DELETE"] as const;
    for (const table of ["messages", "message_parts"] as const) {
      for (const operation of operations) {
        const delta = messageHistoryRevisionDelta(table, operation);
        expect(delta.historyRevision).toBe(operation === "INSERT" ? 0 : 1);
        expect(delta.historyDeletionRevision).toBe(table === "messages" && operation === "DELETE" ? 1 : 0);
      }
    }
    // Keep the executable contract tied to the deployed trigger expression,
    // so a future SQL edit cannot silently change the client reset semantics.
    expect(MESSAGE_HISTORY_DELETION_REVISION_MIGRATION).toContain(
      "message_history_deletion_revision = message_history_deletion_revision + CASE WHEN TG_TABLE_NAME = 'messages' AND TG_OP = 'DELETE' THEN 1 ELSE 0 END",
    );
  });

  it("stores personal and organization skill package files with tenant isolation", () => {
    expect(SKILL_PACKAGE_FILES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS personal_skill_files");
    expect(SKILL_PACKAGE_FILES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS organization_skill_files");
    expect(SKILL_PACKAGE_FILES_MIGRATION).toContain("content bytea NOT NULL");
    expect(SKILL_PACKAGE_FILES_MIGRATION).toContain("personal_skill_files_tenant_isolation");
    expect(SKILL_PACKAGE_FILES_MIGRATION).toContain("organization_skill_files_tenant_isolation");
    expect(cloudMigrations.find((migration) => migration.id === 50)).toMatchObject({ id: 50, name: "skill_package_files_v1" });
    expect(cloudMigrations.find((migration) => migration.id === 51)).toMatchObject({ id: 51, name: "turn_admission_intents_v1" });
    expect(TURN_ADMISSION_INTENTS_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS turn_admission_intents");
    expect(TURN_ADMISSION_INTENTS_MIGRATION).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("renames the legacy organization research skill without deleting its package", () => {
    expect(cloudMigrations.find((migration) => migration.id === 52)).toMatchObject({
      id: 52,
      name: "deep_research_skill_v1",
    });
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("capability_id = 'research'");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("capability_id = 'deep-research'");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("name: deep-research");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("[^\\n\\r]*\\r?$");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("INSERT INTO capability_user_overrides");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("FROM organization_skill_files");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).toContain("SET assignment = 'blocked'");
    expect(DEEP_RESEARCH_SKILL_MIGRATION).not.toMatch(/DELETE FROM organization_(?:capabilities|skill_files)/);
  });

  it("adds inherited organization, department, and member base allowances", () => {
    expect(ALLOWANCE_BASE_HIERARCHY_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS allowance_member_overrides");
    expect(ALLOWANCE_BASE_HIERARCHY_MIGRATION).toContain("Organization default allowance");
    expect(ALLOWANCE_BASE_HIERARCHY_MIGRATION).toContain("20000000");
    expect(ALLOWANCE_BASE_HIERARCHY_MIGRATION).toContain("refresh_member_base_allowance");
    expect(ALLOWANCE_BASE_HIERARCHY_MIGRATION).toContain("department_membership_default_allowance");
    expect(ALLOWANCE_BASE_HIERARCHY_MIGRATION).toContain("ALTER TABLE allowance_member_overrides ENABLE ROW LEVEL SECURITY");
    expect(cloudMigrations.find((migration) => migration.id === 40)).toMatchObject({ id: 40, name: "allowance_base_hierarchy_v1" });
  });

  it("indexes only terminal sandboxes that still need cleanup", () => {
    const migration = cloudMigrations.find((candidate) => candidate.id === 41);
    expect(migration).toMatchObject({ id: 41, name: "terminal_sandbox_cleanup_index_v1" });
    expect(migration?.sql).toContain("turn_runs_terminal_sandbox_cleanup_idx");
    expect(migration?.sql).toContain("sandbox_id IS NOT NULL");
    expect(migration?.sql).toContain("'pause_requested'");
  });

  it("makes durable turn admission idempotent per tenant request", () => {
    const migration = cloudMigrations.find((candidate) => candidate.id === 42);
    expect(migration).toMatchObject({ id: 42, name: "turn_run_admission_idempotency_v1" });
    expect(migration?.sql).toContain("ADD COLUMN IF NOT EXISTS request_id");
    expect(migration?.sql).toContain("turn_runs_tenant_request_unique");
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

  it("adds reference-safe blobs and per-user Library memberships without destructive migration SQL", () => {
    expect(cloudMigrations.find((migration) => migration.id === 43)).toMatchObject({ id: 43, name: "file_reference_safe_lifecycle_v1" });
    for (const table of ["file_blobs", "file_library_entries"]) {
      expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
      expect(CLOUD_SCHEMA_TABLES).toContain(table);
      expect(TENANT_SCOPED_TABLES).toContain(table);
    }
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain("FOREIGN KEY (blob_id) REFERENCES file_blobs(id) ON DELETE RESTRICT");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain("WHERE sha256 IS NOT NULL AND verification_status = 'verified' AND deleted_at IS NULL");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain("SELECT f.tenant_id, f.bucket, f.object_key, f.size_bytes, NULL");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain("FOR target_tenant IN SELECT id FROM tenants ORDER BY id LOOP");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain("PERFORM berry_set_tenant_id(target_tenant.id)");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION.indexOf("$berry_file_backfill$")).toBeLessThan(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION.indexOf("ALTER TABLE file_blobs ENABLE ROW LEVEL SECURITY"));
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).toContain("f.owner_user_id IS NOT NULL AND f.deleted_at IS NULL");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).not.toContain("file.delete-object");
    expect(FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION).not.toContain("DELETE FROM files");
  });

  it("keeps legacy writers reference-safe after the one-time lifecycle backfill", () => {
    expect(cloudMigrations.find((migration) => migration.id === 44)).toMatchObject({ id: 44, name: "file_reference_safe_legacy_writer_compat_v1" });
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("BEFORE INSERT ON files");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("RETURNING id INTO NEW.blob_id");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("'unverified'");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("AFTER INSERT ON files");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("NEW.owner_user_id IS NOT NULL");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("NEW.deleted_at IS NULL");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("NEW.status IN ('scanning', 'processing', 'available')");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("FOREIGN KEY (tenant_id, blob_id)");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("REFERENCES file_blobs(tenant_id, id) ON DELETE RESTRICT");
    const blobTrigger = FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION.split("CREATE OR REPLACE FUNCTION berry_file_library_after_insert_compat")[0]!;
    expect(blobTrigger).not.toContain("ON CONFLICT");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("legacyWriterCatchupFileId");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("$berry_file_catchup$");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("PERFORM berry_set_tenant_id(target_tenant.id)");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("AND f.blob_id IS NULL");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("f.owner_user_id IS NOT NULL AND f.deleted_at IS NULL");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("f.status IN ('scanning', 'processing', 'available')");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("Cross-tenant file blob location conflict detected");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("file_blobs_physical_location_unique");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).toContain("ON file_blobs (bucket, object_key)");
    expect(FILE_REFERENCE_SAFE_LEGACY_WRITER_COMPAT_MIGRATION).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it("stores tenant-scoped connector policy and encrypted credentials behind RLS", () => {
    expect(cloudMigrations.find((migration) => migration.id === 45)).toMatchObject({ id: 45, name: "connectors_v1" });
    for (const table of ["connector_provider_credentials", "organization_connectors", "connector_connections", "connector_oauth_states"]) {
      expect(CONNECTORS_MIGRATION).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(CONNECTORS_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(CONNECTORS_MIGRATION).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(CONNECTORS_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(CONNECTORS_MIGRATION).toContain("client_secret_envelope jsonb NOT NULL");
    expect(CONNECTORS_MIGRATION).toContain("credential_envelope jsonb");
    expect(CONNECTORS_MIGRATION).toContain("PRIMARY KEY (tenant_id, state_digest)");
    expect(CONNECTORS_MIGRATION).not.toMatch(/client_secret\s+text|refresh_token\s+text|access_token\s+text/);
  });

  it("adds an online organization approval queue for custom MCP servers", () => {
    expect(cloudMigrations.find((migration) => migration.id === 68)).toMatchObject({
      name: "connector_approval_workflow_v1",
      transactional: false,
      onlineIndexName: "organization_connectors_approval_queue_idx",
    });
    expect(CONNECTOR_APPROVAL_WORKFLOW_MIGRATION).toContain("approval_status");
    expect(CONNECTOR_APPROVAL_WORKFLOW_MIGRATION).toContain("requested_by");
    expect(CONNECTOR_APPROVAL_WORKFLOW_MIGRATION).toContain("reviewed_by");
    expect(CONNECTOR_APPROVAL_WORKFLOW_MIGRATION).toContain("CREATE INDEX CONCURRENTLY");
  });

  it("tracks each member who requests an MCP server behind tenant RLS", () => {
    expect(cloudMigrations.find((migration) => migration.id === 69)).toMatchObject({
      name: "connector_approval_requests_v1",
      transactional: false,
    });
    expect(CONNECTOR_APPROVAL_REQUESTS_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS connector_approval_requests");
    expect(CONNECTOR_APPROVAL_REQUESTS_MIGRATION).toContain("PRIMARY KEY (tenant_id, connector_id, user_id)");
    expect(CONNECTOR_APPROVAL_REQUESTS_MIGRATION).toContain("CREATE POLICY connector_approval_requests_tenant_isolation");
    expect(CONNECTOR_APPROVAL_REQUESTS_MIGRATION).toContain("requested_by IS NOT NULL");
  });

  it("removes obsolete server-side queued follow-up storage", () => {
    expect(REMOVE_QUEUED_FOLLOW_UPS_MIGRATION).toContain("DROP TABLE IF EXISTS queued_follow_ups;");
    expect(REMOVE_QUEUED_FOLLOW_UPS_MIGRATION).toContain("DELETE FROM schema_migrations WHERE id IN (14, 22);");
    expect(cloudMigrations.find((migration) => migration.id === 24)).toMatchObject({ id: 24, name: "remove_queued_follow_ups_v1" });
  });

  it("orders messages by a monotonic insertion sequence", () => {
    expect(cloudMigrations.find((migration) => migration.id === 25)).toMatchObject({ id: 25, name: "message_sequence_v1" });
    expect(MESSAGE_SEQUENCE_MIGRATION).toContain("sequence_id bigint GENERATED ALWAYS AS IDENTITY");
    expect(MESSAGE_SEQUENCE_MIGRATION).toContain("messages_tenant_session_sequence_idx");
    expect(CLOUD_SCHEMA_SQL).toContain("sequence_id bigint GENERATED ALWAYS AS IDENTITY");
  });

  it("adds durable context storage, vector search, critical indexes, and tenant RLS in migration 27", () => {
    expect(cloudMigrations.find((migration) => migration.id === 27)).toMatchObject({ id: 27, name: "durable_context_memory_knowledge_runner_v1" });
    expect(DURABLE_CONTEXT_MIGRATION).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(DURABLE_CONTEXT_MIGRATION).toContain("embedding vector(1536)");
    expect(DURABLE_CONTEXT_MIGRATION).toContain("knowledge_chunks_search_idx");
    expect(DURABLE_CONTEXT_MIGRATION).toContain("turn_runs_claim_idx");
    expect(DURABLE_CONTEXT_MIGRATION).toContain("turn_events_run_sequence_unique");
    for (const table of DURABLE_CONTEXT_TABLES) {
      expect(DURABLE_CONTEXT_MIGRATION).toContain(`CREATE TABLE ${table}`);
      expect(DURABLE_CONTEXT_MIGRATION).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(DURABLE_CONTEXT_MIGRATION).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
    }
    expect(DURABLE_CONTEXT_MIGRATION).not.toContain("DROP TABLE");
    expect(FILE_LIBRARY_SEARCH_MIGRATION).toContain("files_display_name_original_name_trgm_idx");
  });

  it("adds compaction leases, turn bindings, durable questions, and citations additively", () => {
    expect(SESSION_COMPACTION_LEASES_MIGRATION).toContain("CREATE TABLE session_compaction_leases");
    expect(DURABLE_TURN_BINDINGS_MIGRATION).toContain("ADD COLUMN runtime_metadata");
    expect(DURABLE_TURN_BINDINGS_MIGRATION).toContain("ADD COLUMN run_id uuid REFERENCES turn_runs");
    expect(DURABLE_TURN_QUESTIONS_MIGRATION).toContain("CREATE TABLE turn_questions");
    expect(DURABLE_TURN_QUESTIONS_MIGRATION).toContain("CREATE POLICY turn_questions_tenant_isolation");
    expect(MESSAGE_CITATIONS_MIGRATION).toContain("ADD VALUE IF NOT EXISTS 'citation'");
    expect(MAINTENANCE_RUNS_MIGRATION).toContain("CREATE POLICY maintenance_runs_tenant_isolation");
    expect(MAINTENANCE_RUNS_MIGRATION).toContain("failure_count integer NOT NULL DEFAULT 0");
    expect(cloudMigrations.find((migration) => migration.id === 32)).toMatchObject({ id: 32, name: "maintenance_runs_v1" });
  });

  it("adds the self-hosted 768-dimensional embedding profile as an additive migration", () => {
    expect(cloudMigrations.find((migration) => migration.id === 33)).toMatchObject({ id: 33, name: "self_hosted_embedding_profile_v2" });
    expect(SELF_HOSTED_EMBEDDING_PROFILE_MIGRATION).toContain("ALTER COLUMN embedding TYPE vector(768)");
    expect(SELF_HOSTED_EMBEDDING_PROFILE_MIGRATION).toContain("embedding_dimensions = 768");
    expect(SELF_HOSTED_EMBEDDING_PROFILE_MIGRATION).toContain("vector_ready = false");
  });

  it("adds a filtered cosine HNSW index for production vector retrieval", () => {
    expect(cloudMigrations.find((migration) => migration.id === 34)).toMatchObject({ id: 34, name: "knowledge_vector_hnsw_v1" });
    expect(KNOWLEDGE_VECTOR_HNSW_MIGRATION).toContain("USING hnsw (embedding vector_cosine_ops)");
    expect(KNOWLEDGE_VECTOR_HNSW_MIGRATION).toContain("WHERE vector_ready = true AND embedding IS NOT NULL");
  });

  it("removes public access to selecting an arbitrary tenant context", () => {
    expect(cloudMigrations.find((migration) => migration.id === 35)).toMatchObject({ id: 35, name: "tenant_context_execute_hardening_v1" });
    expect(TENANT_CONTEXT_EXECUTE_HARDENING_MIGRATION).toContain("FROM PUBLIC");
  });

  it("keeps later platform migrations intact", () => {
    expect(SANDBOX_WORKSPACES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS sandbox_workspaces");
    expect(SANDBOX_WORKSPACES_MIGRATION).toContain("sandbox_workspaces_tenant_isolation");
    expect(PERSONAL_CAPABILITIES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS personal_skills");
    expect(PERSONAL_CAPABILITIES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS personal_mcp_servers");
    expect(PERSONAL_CAPABILITIES_MIGRATION).not.toContain("credential text");
    expect(ORG_CAPABILITIES_MIGRATION).toContain("organization_capabilities");
    expect(ORG_CAPABILITIES_MIGRATION).toContain("capability_user_overrides");
  });

  it("adds a session history revision trigger without destructive SQL", () => {
    const migration = cloudMigrations.find((candidate) => candidate.id === 54);
    expect(migration).toMatchObject({ id: 54, name: "message_history_revision_v1" });
    expect(migration?.sql).toContain("message_history_revision");
    expect(migration?.sql).toContain("AFTER UPDATE OR DELETE ON messages");
    expect(migration?.sql).toContain("AFTER UPDATE OR DELETE ON message_parts");
    expect(migration?.sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
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

  it("adds encrypted Google Workspace SSO configuration without replacing the provider-neutral identity tables", () => {
    expect(cloudMigrations.find((migration) => migration.id === 46)).toMatchObject({
      id: 46,
      name: "google_workspace_sso_v1",
    });
    expect(GOOGLE_WORKSPACE_SSO_MIGRATION).toContain("client_secret_envelope jsonb");
    expect(GOOGLE_WORKSPACE_SSO_MIGRATION).toContain("jit_provisioning boolean NOT NULL DEFAULT true");
    expect(GOOGLE_WORKSPACE_SSO_MIGRATION).toContain("default_role IN ('member')");
    expect(GOOGLE_WORKSPACE_SSO_MIGRATION).toContain("provider <> 'generic'");
    expect(GOOGLE_WORKSPACE_SSO_MIGRATION).not.toContain("client_secret text");
    expect(GOOGLE_WORKSPACE_SSO_MIGRATION).not.toContain("DROP TABLE");
  });

  it("gives the platform login explicit read policies without PostgreSQL BYPASSRLS", () => {
    expect(cloudMigrations.find((migration) => migration.id === 47)).toMatchObject({
      id: 47,
      name: "platform_role_rls_v1",
    });
    for (const table of PLATFORM_ROLE_RLS_TABLES) {
      expect(PLATFORM_ROLE_RLS_MIGRATION).toContain(`CREATE POLICY ${table}_platform_read ON ${table}`);
    }
    expect(PLATFORM_ROLE_RLS_MIGRATION).toContain("current_user = 'berry_platform'");
    expect(PLATFORM_ROLE_RLS_MIGRATION).not.toContain("BYPASSRLS");
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

  it("adds tenant-scoped vision defaults and reusable observations additively", () => {
    expect(VISION_MODEL_ROUTING_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS model_auxiliary_defaults");
    expect(VISION_MODEL_ROUTING_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS vision_observation_cache");
    expect(VISION_MODEL_ROUTING_MIGRATION).toContain("UNIQUE (tenant_id, purpose)");
    expect(VISION_MODEL_ROUTING_MIGRATION).toContain("UNIQUE (tenant_id, cache_key)");
    expect(VISION_MODEL_ROUTING_MIGRATION).toContain("model_auxiliary_defaults_tenant_isolation");
    expect(VISION_MODEL_ROUTING_MIGRATION).toContain("vision_observation_cache_tenant_isolation");
    expect(VISION_MODEL_ROUTING_MIGRATION).not.toContain("DROP TABLE");
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
    expect(CLOUD_INITIAL_MIGRATION).toContain("CREATE POLICY tenant_memberships_tenant_isolation");
    expect(CLOUD_INITIAL_MIGRATION).not.toContain("CREATE POLICY memory_items_tenant_isolation");
    expect(DURABLE_CONTEXT_MIGRATION).toContain("CREATE POLICY memory_items_tenant_isolation");
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
