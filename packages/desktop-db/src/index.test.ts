import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BerryDatabase, getDefaultDesktopDbPath, migrations } from "./index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDb(): BerryDatabase {
  const dir = mkdtempSync(join(tmpdir(), "berry-db-"));
  tempDirs.push(dir);
  const db = new BerryDatabase(join(dir, "desktop.db"));
  db.migrate();
  return db;
}

describe("desktop db", () => {
  it("adds MCP depth columns without replacing the existing server table", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["auth_type", "credential_ref", "oauth_json", "health_status", "cached_tools_json"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 15, name: "mcp_depth_v1" })]));
  });

  it("adds skill install metadata additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["origin_path", "version", "content_hash"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 16, name: "skill_install_metadata_v1" })]));
  });

  it("adds plugin source and staged-update metadata additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(plugin_installs)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["source_kind", "source_url", "commit_hash", "content_hash", "signature_status", "pending_content_hash", "capability_diff_json"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 17, name: "plugin_source_metadata_v1" })]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 18, name: "execpolicy_v1" })]));
  });

  it("adds execpolicy rules and tool decision traces additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ name: string }>).map((column) => column.name);
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(columns).toContain("decision_trace_json");
    expect(tables.map((row) => row.name)).toContain("execpolicy_rules");
  });

  it("persists the browser session permission mode for network policy", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(browser_sessions)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("permission_mode");
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 19, name: "browser_network_policy_v1" })]));
  });

  it("adds append-only audit storage additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["sequence", "metadata_json", "previous_hash", "event_hash"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 20, name: "audit_events_v1" })]));
  });

  it("rejects updates and deletes against audit events", () => {
    const db = testDb();
    db.db.prepare(
      `INSERT INTO audit_events (id, sequence, category, action, actor, metadata_json, previous_hash, event_hash, created_at)
       VALUES ('audit_1', 1, 'test', 'created', 'test', '{}', ?, ?, ?)`,
    ).run("0".repeat(64), "1".repeat(64), new Date().toISOString());
    expect(() => db.db.prepare("UPDATE audit_events SET action = 'changed' WHERE id = 'audit_1'").run()).toThrow("append-only");
    expect(() => db.db.prepare("DELETE FROM audit_events WHERE id = 'audit_1'").run()).toThrow("append-only");
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 21, name: "audit_append_only_v1" })]));
  });

  it("adds review sessions and anchored comments additively", () => {
    const db = testDb();
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
    const commentColumns = (db.db.prepare("PRAGMA table_info(review_comments)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(tables).toEqual(expect.arrayContaining(["review_sessions", "review_comments"]));
    expect(commentColumns).toEqual(expect.arrayContaining(["path", "old_path", "side", "line", "commit_sha", "context_hash", "resolved"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 22, name: "review_sessions_v1" })]));
  });

  it("adds verified review findings additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(review_findings)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["severity", "commit_sha", "context_hash", "suggestion_patch", "verification_reason", "converted_comment_id", "applied"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 23, name: "review_findings_v1" })]));
  });

  it("adds task-associated git checkpoints additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(git_checkpoints)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["workspace_id", "task_id", "session_id", "entry_id", "commit_sha", "reason"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 24, name: "git_checkpoints_v1" })]));
  });

  it("adds task worktree associations additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["worktree_path", "worktree_branch", "worktree_base_ref"]));
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 25, name: "task_worktrees_v1" })]));
  });

  it("freezes the worktree base commit additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("worktree_base_sha");
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 28, name: "worktree_base_sha_v1" })]));
  });

  it("links pull requests to tasks additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["pull_request_url", "pull_request_number"]));
    expect(migrations).toContainEqual(expect.objectContaining({ id: 29, name: "task_pull_requests_v1" }));
  });

  it("backfills conversation kind and preserves legacy mode data", () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-conversation-kind-"));
    tempDirs.push(dir);
    const db = new BerryDatabase(join(dir, "desktop.db"));
    db.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
    for (const migration of migrations.filter((item) => item.id <= 30)) {
      db.db.exec(migration.sql);
      db.db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const now = "2026-01-01T00:00:00.000Z";
    db.db.prepare(
      "INSERT INTO workspaces (id, path, name, trust_state, last_opened_at, indexed_at, created_at, updated_at) VALUES ('ws', ?, 'Project', 'trusted', ?, NULL, ?, ?)",
    ).run(join(dir, "project"), now, now, now);
    const insert = db.db.prepare(
      `INSERT INTO tasks
        (id, workspace_id, title, status, active_session_id, ui_mode, worktree_path, searchable_text, created_at, updated_at)
       VALUES (?, 'ws', ?, 'idle', NULL, ?, ?, '', ?, ?)`,
    );
    insert.run("code", "Code", "code", null, now, now);
    insert.run("chat", "Chat", "chat", null, now, now);
    insert.run("cowork", "Co-work", "cowork", null, now, now);
    insert.run("worktree", "Worktree", null, join(dir, "worktree"), now, now);
    insert.run("ordinary", "Ordinary", null, null, now, now);

    db.migrate();

    const kinds = db.db.prepare("SELECT id, conversation_kind FROM tasks ORDER BY id").all();
    expect(kinds).toEqual([
      { id: "chat", conversation_kind: "chat" },
      { id: "code", conversation_kind: "code" },
      { id: "cowork", conversation_kind: "chat" },
      { id: "ordinary", conversation_kind: "chat" },
      { id: "worktree", conversation_kind: "code" },
    ]);
    expect(db.db.prepare("SELECT ui_mode FROM tasks WHERE id = 'cowork'").get()).toEqual({ ui_mode: "cowork" });
    db.close();
  });

  it("associates review sessions with task workspace contexts additively", () => {
    const db = testDb();
    const columns = (db.db.prepare("PRAGMA table_info(review_sessions)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("task_id");
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 26, name: "review_task_context_v1" })]));
  });

  it("allows the same relative path in separate workspace roots", () => {
    const db = testDb();
    const workspace = db.workspaces().open("/tmp/index-roots", "index-roots", true);
    const insert = db.db.prepare(
      `INSERT INTO workspace_index_files
        (id, workspace_id, relative_path, absolute_path, kind, language, size, mtime_ms, content_hash, content_snippet, indexed_at)
       VALUES (?, ?, 'src/index.ts', ?, 'file', 'typescript', 1, 1, 'hash', 'content', '2026-01-01T00:00:00.000Z')`,
    );
    insert.run("main-file", workspace.id, "/tmp/index-roots/src/index.ts");
    expect(() => insert.run("worktree-file", workspace.id, "/tmp/worktree/src/index.ts")).not.toThrow();
    expect(migrations).toEqual(expect.arrayContaining([expect.objectContaining({ id: 27, name: "workspace_index_roots_v1" })]));
  });

  it("uses platform-specific data paths", () => {
    expect(getDefaultDesktopDbPath("darwin")).toContain("Library/Application Support/Berry/desktop.db");
    expect(getDefaultDesktopDbPath("win32", { APPDATA: "C:\\Users\\berry\\AppData\\Roaming" })).toContain("Berry");
    expect(getDefaultDesktopDbPath("linux", { XDG_DATA_HOME: "/tmp/data" })).toBe("/tmp/data/Berry/desktop.db");
  });

  it("migrates the full v1 table set", () => {
    const db = testDb();
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "workspaces",
        "tasks",
        "sessions",
        "messages",
        "message_parts",
        "tool_calls",
        "approvals",
        "questions",
        "session_targets",
        "terminal_events",
        "browser_sessions",
        "model_providers",
        "mcp_servers",
        "skills",
        "commands",
        "workspace_indexes",
        "logs_metadata",
        "active_turns",
        "turn_events",
        "task_groups",
        "task_group_members",
        "audit_events",
        "review_sessions",
        "review_comments",
        "review_findings",
        "git_checkpoints",
        "usage_events",
        "workspace_index_files",
        "workspace_index_fts",
        "workspace_wiki",
        "plugin_installs",
        "session_ui_mode_history",
      ]),
    );
    const activeTurnColumns = db.db.prepare("PRAGMA table_info(active_turns)").all().map((row) => (row as { name: string }).name);
    expect(activeTurnColumns).toContain("owner");
    const taskColumns = db.db.prepare("PRAGMA table_info(tasks)").all().map((row) => (row as { name: string }).name);
    expect(taskColumns).toEqual(expect.arrayContaining(["ui_mode", "ui_mode_pinned", "ui_mode_source"]));
    expect(db.db.prepare("PRAGMA index_list(active_turns)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "idx_active_turns_running_session", unique: 1, partial: 1 })]),
    );
    db.close();
  });

  it("appends ordered session entries and round-trips payloads", () => {
    const db = testDb();
    const entries = db.sessionEntries();
    entries.append("session_a", { id: "e1", parentId: null, type: "message", timestamp: "2026-07-01T00:00:00.000Z", payload: { type: "message", id: "e1" } });
    entries.append("session_a", { id: "e2", parentId: "e1", type: "leaf", timestamp: "2026-07-01T00:00:01.000Z", payload: { type: "leaf", id: "e2" } });
    entries.append("session_b", { id: "e1", parentId: null, type: "message", timestamp: "2026-07-01T00:00:02.000Z", payload: { type: "message", id: "e1" } });
    const listed = entries.list("session_a");
    expect(listed.map((entry) => entry.entryId)).toEqual(["e1", "e2"]);
    expect(listed[0]?.payload).toEqual({ type: "message", id: "e1" });
    expect(listed.map((entry) => entry.position)).toEqual([0, 1]);
    expect(entries.listSessionIds()).toEqual(["session_a", "session_b"]);
    entries.deleteSession("session_a");
    expect(entries.list("session_a")).toEqual([]);
    db.close();
  });

  it("migrates legacy model_providers rows onto the transport-aware schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-db-"));
    tempDirs.push(dir);
    const db = new BerryDatabase(join(dir, "desktop.db"));
    // Apply only the pre-provider-transport migrations, seed a legacy row,
    // then run the full migrate() to exercise the v7 table rebuild.
    db.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
    for (const migration of migrations.filter((m) => m.id <= 6)) {
      db.db.exec(migration.sql);
      db.db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    db.db
      .prepare(
        "INSERT INTO model_providers (id, kind, name, base_url, default_model, credential_ref, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .run("legacy", "openrouter-compatible", "Legacy", "https://example.test/v1", "model-a", "legacy-ref", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.migrate();
    const row = db.db.prepare("SELECT * FROM model_providers WHERE id = 'legacy'").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      kind: "openai-compatible",
      api_type: "openai-chat-completions",
      endpoint_path: "/chat/completions",
      models_path: "/models",
      credential_ref: "legacy-ref",
      auth_type: "bearer",
      source: "custom",
    });
    // credential_ref is now nullable: keyless local providers insert cleanly.
    db.db
      .prepare(
        `INSERT INTO model_providers (id, kind, name, api_type, base_url, default_model, credential_ref, auth_type, enabled, created_at, updated_at)
         VALUES ('local', 'local', 'Ollama', 'openai-chat-completions', 'http://localhost:11434/v1', 'llama3', NULL, 'none', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const local = db.db.prepare("SELECT credential_ref, auth_type FROM model_providers WHERE id = 'local'").get() as Record<string, unknown>;
    expect(local).toEqual({ credential_ref: null, auth_type: "none" });
    db.close();
  });

  it("creates workspaces, tasks, sessions, and messages", () => {
    const db = testDb();
    const workspace = db.workspaces().open("/tmp/berry-project", "berry-project", true);
    const { task, session } = db.tasks().create(workspace.id, "Inspect files", "ask");
    db.tasks().addMessage(session.id, "user", [{ kind: "text", content: "hello" }]);
    expect(db.tasks().list(workspace.id)[0]?.id).toBe(task.id);
    expect(db.tasks().messages(session.id)[0]?.parts[0]?.content).toBe("hello");
    db.close();
  });

  it("persists task UI mode and normalizes the unclassified state", () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-db-"));
    tempDirs.push(dir);
    const path = join(dir, "desktop.db");
    const db = new BerryDatabase(path);
    db.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
    for (const migration of migrations.filter((item) => item.id < 31)) {
      db.db.exec(migration.sql);
      db.db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(migration.id, migration.name, "2026-01-01T00:00:00.000Z");
    }
    const workspace = db.workspaces().open("/tmp/berry-mode-project", "berry-mode-project", true);
    const taskId = "task_legacy_mode";
    const now = "2026-01-01T00:00:00.000Z";
    db.db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, active_session_id, created_at, updated_at)
       VALUES (?, ?, 'Inspect mode', 'idle', NULL, ?, ?)`,
    ).run(taskId, workspace.id, now, now);
    db.db.prepare("UPDATE tasks SET ui_mode = 'code', ui_mode_pinned = 1, ui_mode_source = 'user' WHERE id = ?").run(taskId);
    db.migrate();
    expect(db.tasks().getTask(taskId)).toMatchObject({
      ui_mode: "code",
      conversation_kind: "code",
      ui_mode_pinned: 1,
      ui_mode_source: "user",
    });
    db.close();

    const reopened = new BerryDatabase(path);
    reopened.migrate();
    expect(reopened.tasks().getTask(taskId)).toMatchObject({ ui_mode: "code", conversation_kind: "code", ui_mode_pinned: 1, ui_mode_source: "user" });
    reopened.close();
  });

  it("creates one hidden General workspace and paginates its chats", () => {
    const db = testDb();
    const project = db.workspaces().open("/tmp/berry-project", "Project", true);
    const generalPath = join(tempDirs.at(-1)!, "scratch", "general");
    const general = db.workspaces().ensureGeneral(generalPath);
    expect(db.workspaces().ensureGeneral(generalPath).id).toBe(general.id);
    expect(db.workspaces().list()).toEqual([expect.objectContaining({ id: project.id, workspace_kind: "project" })]);
    expect(db.workspaces().list(true)).toEqual(expect.arrayContaining([expect.objectContaining({ id: general.id, workspace_kind: "general" })]));

    const first = db.tasks().create(general.id, "First", "ask", undefined, undefined, "chat").task;
    const second = db.tasks().create(general.id, "Second", "ask", undefined, undefined, "code").task;
    const pages = [
      db.tasks().listGeneral(false, false, 1, 0)[0]?.id,
      db.tasks().listGeneral(false, false, 1, 1)[0]?.id,
    ];
    expect(new Set(pages)).toEqual(new Set([first.id, second.id]));
    expect(db.tasks().setConversationKind(first.id, "code")).toMatchObject({
      id: first.id,
      conversation_kind: "code",
      ui_mode: null,
    });
    db.close();
  });

  it("round-trips the legacy per-mode model defaults used before conversation-kind migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-db-"));
    tempDirs.push(dir);
    const path = join(dir, "desktop.db");
    const db = new BerryDatabase(path);
    db.migrate();
    db.settings().set("model.defaultSelection.chat", { providerId: "router", model: "chat-model" });
    db.settings().set("model.defaultSelection.cowork", { providerId: "router", model: "cowork-model" });
    db.settings().set("model.defaultSelection.code", { providerId: "router", model: "code-model" });
    db.close();

    const reopened = new BerryDatabase(path);
    reopened.migrate();
    expect(reopened.settings().get("model.defaultSelection.chat")).toEqual({ providerId: "router", model: "chat-model" });
    expect(reopened.settings().get("model.defaultSelection.cowork")).toEqual({ providerId: "router", model: "cowork-model" });
    expect(reopened.settings().get("model.defaultSelection.code")).toEqual({ providerId: "router", model: "code-model" });
    reopened.close();
  });

  it("tracks task lifecycle flags and searchable message text", () => {
    const db = testDb();
    const workspace = db.workspaces().open("/tmp/berry-project", "berry-project", true);
    const { task, session } = db.tasks().create(workspace.id, "Inspect files", "ask");

    db.tasks().addMessage(session.id, "assistant", [{ kind: "text", content: "strawberry routing is ready" }]);
    expect(db.tasks().search(workspace.id, "strawberry")[0]?.id).toBe(task.id);
    expect(db.tasks().getTask(task.id)?.unread_at).toEqual(expect.any(String));

    db.tasks().markRead(task.id, false);
    expect(db.tasks().getTask(task.id)?.unread_at).toBeNull();
    expect(db.tasks().getTask(task.id)?.last_read_at).toEqual(expect.any(String));

    db.tasks().setDeleted(task.id, true);
    expect(db.tasks().list(workspace.id)).toEqual([]);
    expect(db.tasks().list(workspace.id, false, true)[0]?.id).toBe(task.id);

    db.tasks().setDeleted(task.id, false);
    expect(db.tasks().list(workspace.id)[0]?.id).toBe(task.id);
    db.close();
  });
});
