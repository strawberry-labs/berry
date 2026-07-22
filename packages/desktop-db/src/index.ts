import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createId,
  nowIso,
  type ConversationKind,
  type JsonValue,
  type MessageRole,
  type PermissionMode,
  type TaskStatus,
  type UiMode,
  type UiModeSource,
  type WorkspaceKind,
} from "@berry/shared";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "desktop_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        trust_state TEXT NOT NULL DEFAULT 'untrusted',
        last_opened_at TEXT NOT NULL,
        indexed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        active_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        model_provider_id TEXT,
        model TEXT,
        permission_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_parts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_parts_order ON message_parts(message_id, position);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        approval_id TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        decision_json TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);

      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        subject TEXT NOT NULL,
        decision TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        cwd TEXT NOT NULL,
        shell TEXT NOT NULL,
        cols INTEGER NOT NULL,
        rows INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terminal_events (
        id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_terminal_events_terminal ON terminal_events(terminal_id, created_at);

      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        current_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        default_model TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        provider_id TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL,
        url TEXT,
        env_json TEXT NOT NULL,
        trusted INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        source_path TEXT NOT NULL,
        trusted INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        source_path TEXT,
        trusted INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_indexes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL,
        status TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs_metadata (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS host_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "session_entries_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS session_entries (
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        parent_id TEXT,
        entry_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, entry_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_entries_position ON session_entries(session_id, position);
    `,
  },
  {
    id: 3,
    name: "tasks_pinned_archived_v1",
    sql: `
      ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_tasks_pinned ON tasks(workspace_id, pinned DESC, updated_at DESC);
    `,
  },
  {
    id: 4,
    name: "message_usage_tokens_v1",
    sql: `
      ALTER TABLE messages ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 5,
    name: "message_generation_ms_v1",
    sql: `
      ALTER TABLE messages ADD COLUMN generation_ms INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 6,
    name: "tool_calls_children_v1",
    sql: `
      ALTER TABLE tool_calls ADD COLUMN children_json TEXT;
    `,
  },
  {
    // Provider transports: api_type/auth_type/endpoint paths/cached models, and
    // credential_ref becomes nullable (local providers have no key). SQLite
    // can't relax NOT NULL in place, so rebuild the table and map old rows:
    // 'openrouter-compatible' -> 'openai-compatible' on the Chat Completions
    // transport; 'berry-router' keeps its kind.
    id: 7,
    name: "model_provider_api_types_v1",
    sql: `
      CREATE TABLE model_providers_v2 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        api_type TEXT NOT NULL DEFAULT 'openai-chat-completions',
        base_url TEXT NOT NULL,
        endpoint_path TEXT,
        models_path TEXT,
        default_model TEXT NOT NULL,
        credential_ref TEXT,
        auth_type TEXT NOT NULL DEFAULT 'bearer',
        enabled INTEGER NOT NULL,
        headers_json TEXT NOT NULL DEFAULT '{}',
        models_json TEXT NOT NULL DEFAULT '[]',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'custom',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO model_providers_v2
        (id, kind, name, api_type, base_url, endpoint_path, models_path, default_model,
         credential_ref, auth_type, enabled, headers_json, models_json, capabilities_json,
         source, created_at, updated_at)
      SELECT
        id,
        CASE kind WHEN 'openrouter-compatible' THEN 'openai-compatible' ELSE kind END,
        name,
        'openai-chat-completions',
        base_url,
        '/chat/completions',
        '/models',
        default_model,
        NULLIF(credential_ref, ''),
        'bearer',
        enabled,
        '{}',
        '[]',
        '{}',
        CASE WHEN kind = 'berry-router' OR id = 'fireworks' THEN 'preset' ELSE 'custom' END,
        created_at,
        updated_at
      FROM model_providers;

      DROP TABLE model_providers;
      ALTER TABLE model_providers_v2 RENAME TO model_providers;
    `,
  },
  {
    id: 8,
    name: "durability_groups_index_plugins_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS active_turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        stale_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_active_turns_session ON active_turns(session_id, status, started_at DESC);

      CREATE TABLE IF NOT EXISTS turn_events (
        turn_id TEXT NOT NULL REFERENCES active_turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (turn_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, seq);

      CREATE TABLE IF NOT EXISTS task_groups (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_groups_workspace ON task_groups(workspace_id, position, name);

      CREATE TABLE IF NOT EXISTS task_group_members (
        group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        PRIMARY KEY (group_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_task_group_members_task ON task_group_members(task_id);

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        provider_id TEXT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        status TEXT,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_events_task ON usage_events(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS workspace_index_files (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content_snippet TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE (workspace_id, relative_path)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_index_files_workspace ON workspace_index_files(workspace_id, relative_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS workspace_index_fts USING fts5(
        file_id UNINDEXED,
        workspace_id UNINDEXED,
        relative_path,
        content,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS workspace_wiki (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
        summary_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_installs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT,
        manifest_json TEXT NOT NULL,
        trusted INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plugin_installs_workspace ON plugin_installs(workspace_id, enabled, name);
    `,
  },
  {
    id: 9,
    name: "task_lifecycle_search_v1",
    sql: `
      ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
      ALTER TABLE tasks ADD COLUMN unread_at TEXT;
      ALTER TABLE tasks ADD COLUMN last_read_at TEXT;
      ALTER TABLE tasks ADD COLUMN searchable_text TEXT NOT NULL DEFAULT '';

      UPDATE tasks SET searchable_text = title WHERE searchable_text = '';

      CREATE INDEX IF NOT EXISTS idx_tasks_active_lifecycle
        ON tasks(workspace_id, deleted_at, archived, pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_unread
        ON tasks(workspace_id, unread_at DESC);
    `,
  },
  {
    id: 10,
    name: "questions_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool_call_id TEXT,
        status TEXT NOT NULL,
        question_json TEXT NOT NULL,
        answer_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id, created_at);
    `,
  },
  {
    id: 11,
    name: "session_targets_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS session_targets (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        goal_text TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        time_budget_min INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_targets_status ON session_targets(status, updated_at DESC);
    `,
  },
  {
    id: 12,
    name: "active_turns_owner_v1",
    sql: `
      ALTER TABLE active_turns ADD COLUMN owner TEXT;
      CREATE INDEX IF NOT EXISTS idx_active_turns_owner ON active_turns(owner, status);
      UPDATE active_turns AS current
         SET status = 'failed', ended_at = COALESCE(ended_at, datetime('now')), stale_reason = 'lease_migration_duplicate'
       WHERE status = 'running'
         AND EXISTS (
           SELECT 1
             FROM active_turns AS newer
            WHERE newer.session_id = current.session_id
              AND newer.status = 'running'
              AND (newer.started_at > current.started_at OR (newer.started_at = current.started_at AND newer.id > current.id))
         );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_turns_running_session
        ON active_turns(session_id) WHERE status = 'running';
    `,
  },
  {
    id: 13,
    name: "task_ui_mode_v1",
    sql: `
      ALTER TABLE tasks ADD COLUMN ui_mode TEXT
        CHECK (ui_mode IS NULL OR ui_mode IN ('chat', 'code', 'cowork'));
      ALTER TABLE tasks ADD COLUMN ui_mode_pinned INTEGER NOT NULL DEFAULT 0
        CHECK (ui_mode_pinned IN (0, 1));
      ALTER TABLE tasks ADD COLUMN ui_mode_source TEXT
        CHECK (ui_mode_source IS NULL OR ui_mode_source IN ('classifier', 'agent', 'user'));
    `,
  },
  {
    id: 14,
    name: "session_ui_mode_history_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS session_ui_mode_history (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('chat', 'code', 'cowork')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, mode)
      );
    `,
  },
  {
    id: 15,
    name: "mcp_depth_v1",
    sql: `
      ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'
        CHECK (auth_type IN ('none', 'oauth-authorization-code', 'oauth-device'));
      ALTER TABLE mcp_servers ADD COLUMN credential_ref TEXT;
      ALTER TABLE mcp_servers ADD COLUMN oauth_json TEXT;
      ALTER TABLE mcp_servers ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE mcp_servers ADD COLUMN health_status TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (health_status IN ('disconnected', 'connecting', 'connected', 'auth-required', 'error'));
      ALTER TABLE mcp_servers ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mcp_servers ADD COLUMN last_error TEXT;
      ALTER TABLE mcp_servers ADD COLUMN latency_ms INTEGER;
      ALTER TABLE mcp_servers ADD COLUMN last_checked_at TEXT;
      ALTER TABLE mcp_servers ADD COLUMN cached_tools_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 16,
    name: "skill_install_metadata_v1",
    sql: `
      ALTER TABLE skills ADD COLUMN origin_path TEXT;
      ALTER TABLE skills ADD COLUMN version TEXT NOT NULL DEFAULT '0.1.0';
      ALTER TABLE skills ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 17,
    name: "plugin_source_metadata_v1",
    sql: `
      ALTER TABLE plugin_installs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manifest'
        CHECK (source_kind IN ('manifest', 'folder', 'git'));
      ALTER TABLE plugin_installs ADD COLUMN source_url TEXT;
      ALTER TABLE plugin_installs ADD COLUMN commit_hash TEXT;
      ALTER TABLE plugin_installs ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE plugin_installs ADD COLUMN signature_status TEXT NOT NULL DEFAULT 'unsigned'
        CHECK (signature_status IN ('unsigned', 'verified', 'invalid'));
      ALTER TABLE plugin_installs ADD COLUMN signature_fingerprint TEXT;
      ALTER TABLE plugin_installs ADD COLUMN pending_path TEXT;
      ALTER TABLE plugin_installs ADD COLUMN pending_version TEXT;
      ALTER TABLE plugin_installs ADD COLUMN pending_content_hash TEXT;
      ALTER TABLE plugin_installs ADD COLUMN pending_commit_hash TEXT;
      ALTER TABLE plugin_installs ADD COLUMN pending_manifest_json TEXT;
      ALTER TABLE plugin_installs ADD COLUMN capability_diff_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 18,
    name: "execpolicy_v1",
    sql: `
      ALTER TABLE tool_calls ADD COLUMN decision_trace_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE IF NOT EXISTS execpolicy_rules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        layer TEXT NOT NULL CHECK (layer IN ('managed', 'workspace', 'user', 'session')),
        kind TEXT NOT NULL CHECK (kind IN ('prefix_rule', 'exact', 'regex-lite', 'network')),
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'prompt', 'forbid')),
        pattern_json TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_execpolicy_rules_workspace
        ON execpolicy_rules(workspace_id, layer, created_at);
    `,
  },
  {
    id: 19,
    name: "browser_network_policy_v1",
    sql: `
      ALTER TABLE browser_sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'
        CHECK (permission_mode IN ('ask', 'auto-edit', 'plan', 'full-access'));
    `,
  },
  {
    id: 20,
    name: "audit_events_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        workspace_id TEXT,
        task_id TEXT,
        session_id TEXT,
        subject TEXT,
        metadata_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_created
        ON audit_events(created_at DESC, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_session
        ON audit_events(session_id, sequence);
    `,
  },
  {
    id: 21,
    name: "audit_append_only_v1",
    sql: `
      CREATE TRIGGER IF NOT EXISTS audit_events_reject_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_events_reject_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only');
      END;
    `,
  },
  {
    id: 22,
    name: "review_sessions_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS review_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('working-tree', 'branch', 'range')),
        base_ref TEXT,
        head_ref TEXT,
        commit_sha TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_sessions_workspace
        ON review_sessions(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        old_path TEXT,
        side TEXT NOT NULL CHECK (side IN ('old', 'new')),
        line INTEGER NOT NULL CHECK (line > 0),
        commit_sha TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_comments_session
        ON review_comments(review_session_id, path, line, created_at);
    `,
  },
  {
    id: 23,
    name: "review_findings_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS review_findings (
        id TEXT PRIMARY KEY,
        review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
        severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        path TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('old', 'new')),
        line INTEGER NOT NULL CHECK (line > 0),
        commit_sha TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        suggestion_patch TEXT,
        verification_reason TEXT NOT NULL,
        converted_comment_id TEXT REFERENCES review_comments(id) ON DELETE SET NULL,
        applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_findings_session
        ON review_findings(review_session_id, severity, path, line);
    `,
  },
  {
    id: 24,
    name: "git_checkpoints_v1",
    sql: `
      CREATE TABLE IF NOT EXISTS git_checkpoints (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        entry_id TEXT,
        commit_sha TEXT NOT NULL,
        message TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('manual', 'auto-rewind', 'auto-restore', 'auto-merge')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_git_checkpoints_task
        ON git_checkpoints(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_git_checkpoints_workspace
        ON git_checkpoints(workspace_id, created_at DESC);
    `,
  },
  {
    id: 25,
    name: "task_worktrees_v1",
    sql: `
      ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
      ALTER TABLE tasks ADD COLUMN worktree_branch TEXT;
      ALTER TABLE tasks ADD COLUMN worktree_base_ref TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_worktree_path
        ON tasks(worktree_path) WHERE worktree_path IS NOT NULL;
    `,
  },
  {
    id: 26,
    name: "review_task_context_v1",
    sql: `
      ALTER TABLE review_sessions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_review_sessions_task ON review_sessions(task_id, updated_at DESC);
    `,
  },
  {
    id: 27,
    name: "workspace_index_roots_v1",
    sql: `
      ALTER TABLE workspace_index_files RENAME TO workspace_index_files_legacy;

      CREATE TABLE workspace_index_files (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content_snippet TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE (workspace_id, absolute_path)
      );

      INSERT INTO workspace_index_files
        (id, workspace_id, relative_path, absolute_path, kind, language, size, mtime_ms, content_hash, content_snippet, indexed_at)
      SELECT id, workspace_id, relative_path, absolute_path, kind, language, size, mtime_ms, content_hash, content_snippet, indexed_at
      FROM workspace_index_files_legacy;

      DROP TABLE workspace_index_files_legacy;
      CREATE INDEX idx_workspace_index_files_workspace ON workspace_index_files(workspace_id, relative_path);
    `,
  },
  {
    id: 28,
    name: "worktree_base_sha_v1",
    sql: `
      ALTER TABLE tasks ADD COLUMN worktree_base_sha TEXT;
    `,
  },
  {
    id: 29,
    name: "task_pull_requests_v1",
    sql: `
      ALTER TABLE tasks ADD COLUMN pull_request_url TEXT;
      ALTER TABLE tasks ADD COLUMN pull_request_number INTEGER;
    `,
  },
  {
    id: 30,
    name: "mcp_bearer_api_key_v1",
    sql: `
      CREATE TABLE mcp_servers_rebuilt (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL,
        url TEXT,
        env_json TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'none'
          CHECK (auth_type IN ('none', 'bearer-api-key', 'oauth-authorization-code', 'oauth-device')),
        credential_ref TEXT,
        oauth_json TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        trusted INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        health_status TEXT NOT NULL DEFAULT 'disconnected'
          CHECK (health_status IN ('disconnected', 'connecting', 'connected', 'auth-required', 'error')),
        tool_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        latency_ms INTEGER,
        last_checked_at TEXT,
        cached_tools_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO mcp_servers_rebuilt
        (id, workspace_id, name, transport, command, args_json, url, env_json, auth_type, credential_ref,
         oauth_json, source, trusted, enabled, health_status, tool_count, last_error, latency_ms,
         last_checked_at, cached_tools_json, created_at, updated_at)
      SELECT id, workspace_id, name, transport, command, args_json, url, env_json, auth_type, credential_ref,
             oauth_json, source, trusted, enabled, health_status, tool_count, last_error, latency_ms,
             last_checked_at, cached_tools_json, created_at, updated_at
      FROM mcp_servers;

      DROP TABLE mcp_servers;
      ALTER TABLE mcp_servers_rebuilt RENAME TO mcp_servers;
    `,
  },
  {
    id: 31,
    name: "conversation_kind_and_general_workspaces_v1",
    sql: `
      ALTER TABLE workspaces ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'project'
        CHECK (workspace_kind IN ('project', 'general'));
      ALTER TABLE workspaces ADD COLUMN owner_user_id TEXT;

      ALTER TABLE tasks ADD COLUMN conversation_kind TEXT NOT NULL DEFAULT 'chat'
        CHECK (conversation_kind IN ('chat', 'code'));
      UPDATE tasks
      SET conversation_kind = CASE
        WHEN ui_mode = 'code' THEN 'code'
        WHEN ui_mode IN ('chat', 'cowork') THEN 'chat'
        WHEN ui_mode IS NULL AND worktree_path IS NOT NULL AND TRIM(worktree_path) <> '' THEN 'code'
        ELSE 'chat'
      END;

      CREATE UNIQUE INDEX idx_workspaces_single_general
        ON workspaces(workspace_kind)
        WHERE workspace_kind = 'general';
      CREATE INDEX idx_tasks_workspace_kind_updated
        ON tasks(workspace_id, conversation_kind, updated_at DESC);
    `,
  },
  {
    id: 32,
    name: "workspace_pinning_v1",
    sql: `
      ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_workspaces_pinned
        ON workspaces(workspace_kind, pinned DESC, last_opened_at DESC);
    `,
  },
];

export function getDefaultDesktopDbPath(platform = process.platform, env = process.env): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Berry", "desktop.db");
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Berry", "desktop.db");
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Berry", "desktop.db");
}

export interface WorkspaceRow {
  id: string;
  path: string;
  name: string;
  workspace_kind: WorkspaceKind;
  owner_user_id: string | null;
  trust_state: string;
  last_opened_at: string;
  indexed_at: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
}

export interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  status: TaskStatus;
  active_session_id: string | null;
  conversation_kind: ConversationKind;
  ui_mode: UiMode | null;
  ui_mode_pinned: number;
  ui_mode_source: UiModeSource | null;
  pinned: number;
  archived: number;
  deleted_at: string | null;
  unread_at: string | null;
  last_read_at: string | null;
  searchable_text: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  worktree_base_sha: string | null;
  pull_request_url: string | null;
  pull_request_number: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskGroupRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string | null;
  position: number;
  collapsed: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  task_id: string;
  parent_session_id: string | null;
  status: string;
  model_provider_id: string | null;
  model: string | null;
  permission_mode: PermissionMode;
  created_at: string;
  updated_at: string;
}

export interface MessageWithParts {
  id: string;
  sessionId: string;
  role: MessageRole;
  status: string;
  inputTokens: number;
  outputTokens: number;
  generationMs: number;
  parts: Array<{ id: string; messageId: string; kind: string; content: JsonValue; position: number; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export class BerryDatabase {
  readonly db: DatabaseSync;

  constructor(path = getDefaultDesktopDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  migrate(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
      const seen = new Set(
        this.db.prepare("SELECT id FROM schema_migrations").all().map((row) => Number((row as { id: number }).id)),
      );
      for (const migration of migrations) {
        if (seen.has(migration.id)) continue;
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.id, migration.name, nowIso());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  workspaces(): WorkspaceRepository {
    return new WorkspaceRepository(this.db);
  }

  tasks(): TaskRepository {
    return new TaskRepository(this.db);
  }

  settings(): SettingsRepository {
    return new SettingsRepository(this.db);
  }

  logs(): LogsRepository {
    return new LogsRepository(this.db);
  }

  sessionEntries(): SessionEntriesRepository {
    return new SessionEntriesRepository(this.db);
  }
}

export interface SessionEntryRow {
  sessionId: string;
  entryId: string;
  parentId: string | null;
  entryType: string;
  timestamp: string;
  position: number;
  payload: JsonValue;
}

export class SessionEntriesRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(sessionId: string, entry: { id: string; parentId: string | null; type: string; timestamp: string; payload: JsonValue }): void {
    const next = this.db
      .prepare("SELECT COALESCE(MAX(position) + 1, 0) AS position FROM session_entries WHERE session_id = ?")
      .get(sessionId) as { position: number };
    this.db
      .prepare(
        "INSERT INTO session_entries (session_id, entry_id, parent_id, entry_type, timestamp, position, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, entry.id, entry.parentId, entry.type, entry.timestamp, next.position, JSON.stringify(entry.payload));
  }

  list(sessionId: string): SessionEntryRow[] {
    return (
      this.db
        .prepare("SELECT * FROM session_entries WHERE session_id = ? ORDER BY position ASC")
        .all(sessionId) as Array<{
        session_id: string;
        entry_id: string;
        parent_id: string | null;
        entry_type: string;
        timestamp: string;
        position: number;
        payload_json: string;
      }>
    ).map((row) => ({
      sessionId: row.session_id,
      entryId: row.entry_id,
      parentId: row.parent_id,
      entryType: row.entry_type,
      timestamp: row.timestamp,
      position: row.position,
      payload: JSON.parse(row.payload_json) as JsonValue,
    }));
  }

  listSessionIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT session_id FROM session_entries ORDER BY session_id").all() as Array<{ session_id: string }>).map(
      (row) => row.session_id,
    );
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(sessionId);
  }
}

export class WorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  open(path: string, name?: string, trusted = false): WorkspaceRow {
    const now = nowIso();
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE path = ?").get(path) as WorkspaceRow | undefined;
    if (existing) {
      this.db.prepare("UPDATE workspaces SET name = ?, last_opened_at = ?, updated_at = ? WHERE id = ?").run(name?.trim() || existing.name, now, now, existing.id);
      return this.get(existing.id)!;
    }
    const id = createId("ws");
    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, path, name, trust_state, last_opened_at, indexed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, path, name?.trim() || basenameFromPath(path), trusted ? "trusted" : "untrusted", now, now, now);
    return this.get(id)!;
  }

  get(id: string): WorkspaceRow | undefined {
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
  }

  ensureGeneral(path: string, name = "Chats"): WorkspaceRow {
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE workspace_kind = 'general'").get() as WorkspaceRow | undefined;
    if (existing) return existing;
    mkdirSync(path, { recursive: true });
    const now = nowIso();
    const id = createId("ws");
    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, path, name, workspace_kind, owner_user_id, trust_state, last_opened_at, indexed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'general', NULL, 'trusted', ?, NULL, ?, ?)`,
      )
      .run(id, path, name, now, now, now);
    return this.get(id)!;
  }

  list(includeGeneral = false): WorkspaceRow[] {
    const where = includeGeneral ? "" : "WHERE workspace_kind = 'project'";
    return this.db.prepare(`SELECT * FROM workspaces ${where} ORDER BY pinned DESC, last_opened_at DESC, id ASC`).all() as unknown as WorkspaceRow[];
  }

  update(id: string, input: { name?: string; pinned?: boolean }): WorkspaceRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const name = input.name?.trim() || current.name;
    const pinned = input.pinned === undefined ? current.pinned : input.pinned ? 1 : 0;
    this.db.prepare("UPDATE workspaces SET name = ?, pinned = ?, updated_at = ? WHERE id = ?").run(name, pinned, nowIso(), id);
    return this.get(id);
  }

  /**
   * Detaches a workspace from Berry. Files on disk are untouched; the row and
   * its tasks/sessions/messages are removed via ON DELETE CASCADE. Returns
   * whether a matching workspace existed.
   */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(
    workspaceId: string,
    title: string,
    permissionMode: PermissionMode,
    modelProviderId?: string,
    model?: string,
    conversationKind: ConversationKind = "chat",
  ): {
    task: TaskRow;
    session: SessionRow;
  } {
    const now = nowIso();
    const taskId = createId("task");
    const sessionId = createId("session");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO tasks
            (id, workspace_id, title, status, active_session_id, conversation_kind, searchable_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, workspaceId, title, "running", sessionId, conversationKind, title, now, now);
      this.db
        .prepare(
          `INSERT INTO sessions
            (id, task_id, parent_session_id, status, model_provider_id, model, permission_mode, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, taskId, "active", modelProviderId ?? null, model ?? null, permissionMode, now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { task: this.getTask(taskId)!, session: this.getSession(sessionId)! };
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  list(workspaceId: string, includeArchived = false, includeDeleted = false): TaskRow[] {
    const where = `${includeArchived ? "" : "AND archived = 0 "}${includeDeleted ? "" : "AND deleted_at IS NULL "}`;
    return this.db
      .prepare(`SELECT * FROM tasks WHERE workspace_id = ? ${where}ORDER BY pinned DESC, updated_at DESC`)
      .all(workspaceId) as unknown as TaskRow[];
  }

  listGeneral(includeArchived = false, includeDeleted = false, limit = 50, offset = 0): TaskRow[] {
    const where = `${includeArchived ? "" : "AND t.archived = 0 "}${includeDeleted ? "" : "AND t.deleted_at IS NULL "}`;
    const safeLimit = Math.max(1, Math.min(500, Math.round(limit)));
    const safeOffset = Math.max(0, Math.round(offset));
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN workspaces w ON w.id = t.workspace_id
         WHERE w.workspace_kind = 'general' ${where}
         ORDER BY t.pinned DESC, t.updated_at DESC, t.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(safeLimit, safeOffset) as unknown as TaskRow[];
  }

  search(workspaceId: string, query: string, includeArchived = false, includeDeleted = false, limit = 50): TaskRow[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return this.list(workspaceId, includeArchived, includeDeleted).slice(0, limit);
    const where = `${includeArchived ? "" : "AND archived = 0 "}${includeDeleted ? "" : "AND deleted_at IS NULL "}`;
    const pattern = `%${trimmed.replace(/[%_\\]/g, "\\$&")}%`;
    const safeLimit = Math.max(1, Math.min(200, Math.round(limit)));
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE workspace_id = ? ${where}
           AND (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(searchable_text) LIKE ? ESCAPE '\\')
         ORDER BY pinned DESC, unread_at DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, pattern, pattern, safeLimit) as unknown as TaskRow[];
  }

  /** Rename a task and bump its updated_at. Returns the refreshed row. */
  updateTitle(id: string, title: string): TaskRow | undefined {
    this.db
      .prepare("UPDATE tasks SET title = ?, searchable_text = TRIM(? || ' ' || COALESCE(searchable_text, '')), updated_at = ? WHERE id = ?")
      .run(title, title, nowIso(), id);
    return this.getTask(id);
  }

  setConversationKind(id: string, conversationKind: ConversationKind): TaskRow | undefined {
    this.db
      .prepare("UPDATE tasks SET conversation_kind = ?, updated_at = ? WHERE id = ?")
      .run(conversationKind, nowIso(), id);
    return this.getTask(id);
  }

  /** Pin or unpin a task. Returns the refreshed row. */
  setPinned(id: string, pinned: boolean): TaskRow | undefined {
    this.db.prepare("UPDATE tasks SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, nowIso(), id);
    return this.getTask(id);
  }

  /** Archive or unarchive a task. Returns the refreshed row. */
  setArchived(id: string, archived: boolean): TaskRow | undefined {
    this.db.prepare("UPDATE tasks SET archived = ?, updated_at = ? WHERE id = ?").run(archived ? 1 : 0, nowIso(), id);
    return this.getTask(id);
  }

  setDeleted(id: string, deleted: boolean): TaskRow | undefined {
    const now = nowIso();
    this.db.prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?").run(deleted ? now : null, now, id);
    return this.getTask(id);
  }

  markRead(id: string, unread: boolean): TaskRow | undefined {
    const now = nowIso();
    this.db
      .prepare("UPDATE tasks SET unread_at = ?, last_read_at = ? WHERE id = ?")
      .run(unread ? now : null, unread ? null : now, id);
    return this.getTask(id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  addMessage(
    sessionId: string,
    role: MessageRole,
    parts: Array<{ kind: string; content: JsonValue }>,
    status = "complete",
    usage?: { inputTokens?: number; outputTokens?: number; generationMs?: number },
  ): string {
    const now = nowIso();
    const messageId = createId("msg");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO messages (id, session_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          messageId,
          sessionId,
          role,
          status,
          Math.round(usage?.inputTokens ?? 0),
          Math.round(usage?.outputTokens ?? 0),
          Math.round(usage?.generationMs ?? 0),
          now,
          now,
        );
      const insertPart = this.db.prepare(
        "INSERT INTO message_parts (id, message_id, kind, content_json, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      parts.forEach((part, index) => insertPart.run(createId("part"), messageId, part.kind, JSON.stringify(part.content), index, now));
      const searchable = searchableTextFromParts(parts);
      if (searchable) {
        this.db
          .prepare(
            `UPDATE tasks
             SET searchable_text = TRIM(SUBSTR(COALESCE(NULLIF(searchable_text, ''), title) || ' ' || ?, 1, 20000)),
                 unread_at = CASE WHEN ? = 1 THEN ? ELSE unread_at END
             WHERE active_session_id = ?`,
          )
          .run(searchable, role !== "user" && status !== "streaming" ? 1 : 0, now, sessionId);
      } else if (role !== "user" && status !== "streaming") {
        this.db.prepare("UPDATE tasks SET unread_at = ? WHERE active_session_id = ?").run(now, sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return messageId;
  }

  /**
   * 1-based position of a user message among the session's user messages
   * (insertion order). Used to line the UI projection up with the session tree
   * when editing/rewinding. Returns null if the message isn't found.
   */
  userMessageOrdinal(sessionId: string, messageId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE session_id = ? AND role = 'user'
           AND rowid <= (SELECT rowid FROM messages WHERE id = ? AND session_id = ?)`,
      )
      .get(sessionId, messageId, sessionId) as { n: number } | undefined;
    if (!row || row.n <= 0) return null;
    return row.n;
  }

  /**
   * Drop the given message and every message after it in the session (insertion
   * order). message_parts cascade. Used by edit-and-resubmit to truncate the UI
   * projection back to the edited turn.
   */
  deleteMessagesFrom(sessionId: string, messageId: string): void {
    const target = this.db
      .prepare("SELECT rowid AS rid FROM messages WHERE id = ? AND session_id = ?")
      .get(messageId, sessionId) as { rid: number } | undefined;
    if (!target) return;
    this.db.prepare("DELETE FROM messages WHERE session_id = ? AND rowid >= ?").run(sessionId, target.rid);
  }

  /**
   * Turn the latest failed/cancelled assistant projection back into ordinary
   * activity before a provider continuation. Partial text, reasoning, and tool
   * calls stay in place; only the interruption error/status is removed.
   */
  resumeInterruptedMessage(sessionId: string): void {
    const latest = this.db
      .prepare("SELECT id, role, status FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(sessionId) as { id: string; role: MessageRole; status: string } | undefined;
    if (!latest || latest.role !== "assistant" || (latest.status !== "failed" && latest.status !== "cancelled")) return;

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM message_parts WHERE message_id = ? AND kind = 'error'").run(latest.id);
      const remaining = this.db
        .prepare("SELECT COUNT(*) AS count FROM message_parts WHERE message_id = ?")
        .get(latest.id) as { count: number };
      if (remaining.count === 0) this.db.prepare("DELETE FROM messages WHERE id = ?").run(latest.id);
      else this.db.prepare("UPDATE messages SET status = 'complete' WHERE id = ?").run(latest.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  messages(sessionId: string): MessageWithParts[] {
    const messages = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      role: MessageRole;
      status: string;
      input_tokens: number;
      output_tokens: number;
      generation_ms: number;
      created_at: string;
      updated_at: string;
    }>;
    const selectParts = this.db.prepare("SELECT * FROM message_parts WHERE message_id = ? ORDER BY position ASC");
    const selectToolCall = this.db.prepare(
      "SELECT status, output_json, children_json, decision_trace_json, started_at, completed_at FROM tool_calls WHERE id = ?",
    );
    // Tool-call parts persist only {toolCallId, name, arguments}; the final
    // status/output/duration live in tool_calls. Merge them at read time so
    // the renderer can show settled tool runs (command output, failures).
    const enrichToolCall = (content: JsonValue): JsonValue => {
      if (!content || typeof content !== "object" || Array.isArray(content)) return content;
      const meta = content as Record<string, JsonValue>;
      if (typeof meta.toolCallId !== "string") return content;
      const row = selectToolCall.get(meta.toolCallId) as
        | {
            status: string;
            output_json: string | null;
            children_json: string | null;
            decision_trace_json: string;
            started_at: string | null;
            completed_at: string | null;
          }
        | undefined;
      if (!row) return content;
      const enriched: Record<string, JsonValue> = { ...meta, status: row.status };
      if (row.output_json !== null) {
        try {
          enriched.output = JSON.parse(row.output_json) as JsonValue;
        } catch {
          enriched.output = row.output_json;
        }
      }
      if (row.children_json !== null) {
        try {
          enriched.children = JSON.parse(row.children_json) as JsonValue;
        } catch {
          /* ignore malformed children */
        }
      }
      try {
        enriched.decisionTrace = JSON.parse(row.decision_trace_json) as JsonValue;
      } catch {
        enriched.decisionTrace = [];
      }
      if (row.started_at && row.completed_at) {
        const durationMs = Date.parse(row.completed_at) - Date.parse(row.started_at);
        if (Number.isFinite(durationMs) && durationMs >= 0) enriched.durationMs = durationMs;
      }
      return enriched;
    };
    return messages.map((message) => ({
      id: message.id,
      sessionId: message.session_id,
      role: message.role,
      status: message.status,
      inputTokens: Number(message.input_tokens ?? 0),
      outputTokens: Number(message.output_tokens ?? 0),
      generationMs: Number(message.generation_ms ?? 0),
      parts: (selectParts.all(message.id) as Array<{ id: string; message_id: string; kind: string; content_json: string; position: number; created_at: string }>).map(
        (part) => {
          const content = JSON.parse(part.content_json) as JsonValue;
          return {
            id: part.id,
            messageId: part.message_id,
            kind: part.kind,
            content: part.kind === "tool-call" ? enrichToolCall(content) : content,
            position: part.position,
            createdAt: part.created_at,
          };
        },
      ),
      createdAt: message.created_at,
      updatedAt: message.updated_at,
    }));
  }
}

function searchableTextFromParts(parts: Array<{ kind: string; content: JsonValue }>): string {
  return parts
    .map((part) => {
      if (typeof part.content === "string") return part.content;
      if (part.content && typeof part.content === "object" && !Array.isArray(part.content)) {
        const content = part.content as Record<string, JsonValue>;
        if (typeof content.text === "string") return content.text;
        if (typeof content.summary === "string") return content.summary;
      }
      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get<T extends JsonValue>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  set(key: string, value: JsonValue): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  list(): Array<{ key: string; value: JsonValue; updatedAt: string }> {
    return (this.db.prepare("SELECT * FROM settings ORDER BY key ASC").all() as Array<{ key: string; value_json: string; updated_at: string }>).map(
      (row) => ({ key: row.key, value: JSON.parse(row.value_json) as JsonValue, updatedAt: row.updated_at }),
    );
  }
}

export class LogsRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(input: { workspaceId?: string; taskId?: string; level: string; source: string; message: string; metadata?: JsonValue }): string {
    const id = createId("log");
    this.db
      .prepare(
        `INSERT INTO logs_metadata (id, workspace_id, task_id, level, source, message, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId ?? null, input.taskId ?? null, input.level, input.source, input.message, JSON.stringify(input.metadata ?? {}), nowIso());
    return id;
  }

  list(limit = 200): Array<{ id: string; level: string; source: string; message: string; metadata: JsonValue; createdAt: string }> {
    return (
      this.db
        .prepare("SELECT id, level, source, message, metadata_json, created_at FROM logs_metadata ORDER BY created_at DESC LIMIT ?")
        .all(limit) as Array<{ id: string; level: string; source: string; message: string; metadata_json: string; created_at: string }>
    ).map((row) => ({
      id: row.id,
      level: row.level,
      source: row.source,
      message: row.message,
      metadata: JSON.parse(row.metadata_json) as JsonValue,
      createdAt: row.created_at,
    }));
  }
}

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
