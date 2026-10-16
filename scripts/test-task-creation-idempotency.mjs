#!/usr/bin/env node
// Task creation is idempotent per tenant, user and Idempotency-Key, including
// for concurrent duplicates, and the migration that adds the key leaves
// existing tasks untouched (H-035).
// Runs against an EMPTY, disposable loopback PostgreSQL database with pgvector:
// pnpm --filter @berry/api... build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-task-creation-idempotency.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cloudMigrations } from "../packages/db/dist/index.js";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { PgSqlExecutor } from "../apps/api/dist/db/pg-executor.js";
import { PostgresCloudTaskStore } from "../apps/api/dist/http/cloud-task-store.js";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href, max: 16 });
const db = new CloudDatabaseService(new PgSqlExecutor(pool));
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const MIGRATION_ID = 74;
const tenantId = randomUUID(), userId = randomUUID(), otherUserId = randomUUID(), workspaceId = randomUUID();
const store = new PostgresCloudTaskStore(db, tenantId);
const create = (idempotency, title = "Draw five foxes", owner = userId) =>
  store.createTask({ workspaceId, ownerUserId: owner, title, ...(idempotency ? { idempotency } : {}) });
const keyedRows = async (key) => Number((await query(
  "SELECT count(*)::int AS n FROM tasks WHERE tenant_id=$1 AND creation_idempotency_key=$2", [tenantId, key],
))[0].n);
const sessionRows = async (taskId) => Number((await query("SELECT count(*)::int AS n FROM sessions WHERE task_id=$1", [taskId]))[0].n);
const legacyTasks = () => query(
  "SELECT to_jsonb(t) - 'creation_idempotency_key' - 'creation_fingerprint' AS row FROM tasks t ORDER BY id",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }

try {
  assert.equal((await query("SELECT to_regclass('public.tenants') AS existing"))[0].existing, null, "Database must be empty");

  // The production database today: every migration before this change.
  const migrator = await pool.connect();
  try {
    for (const migration of cloudMigrations.filter((candidate) => candidate.id < MIGRATION_ID)) {
      if ("onlineSql" in migration) for (const statement of migration.onlineSql) await migrator.query(statement);
      else await migrator.query(migration.sql);
      await migrator.query("INSERT INTO schema_migrations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING", [migration.id, migration.name]);
    }
  } finally { migrator.release(); }
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Idempotency tests',$2)", [tenantId, tenantId]);
  for (const id of [userId, otherUserId]) {
    await query("INSERT INTO users(id,email) VALUES($1,$2)", [id, `${id}@idempotency.invalid`]);
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, id]);
  }
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Idempotency tests',$1::text)", [workspaceId, tenantId, userId]);
  // Existing tasks, including the production pattern: same user, same title, seconds apart.
  for (const title of ["Draw five foxes", "Draw five foxes", "Quarterly report"]) {
    const taskId = randomUUID(), sessionId = randomUUID();
    await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title,status) VALUES($1,$2,$3,$4,$5,'completed')", [taskId, tenantId, workspaceId, userId, title]);
    await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
    await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
  }
  const before = await legacyTasks();

  await test("migration 74 adds the key without changing existing tasks and is safe to re-run", async () => {
    await db.migrate();
    assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE id=$1", [MIGRATION_ID]))[0].n, 1);
    const columns = await query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name='tasks' AND column_name IN ('creation_idempotency_key','creation_fingerprint') ORDER BY column_name`,
    );
    assert.deepEqual(columns, [
      { column_name: "creation_fingerprint", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "creation_idempotency_key", data_type: "text", is_nullable: "YES", column_default: null },
    ]);
    const [index] = await query(
      `SELECT i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='tasks_creation_idempotency_unique'`,
    );
    assert.equal(index.indisunique, true);
    assert.equal(index.indisvalid, true);
    assert.match(index.definition, /\(tenant_id, user_id, creation_idempotency_key\) WHERE \(creation_idempotency_key IS NOT NULL\)/);
    assert.deepEqual(await legacyTasks(), before);
    assert.equal((await query("SELECT count(*)::int AS n FROM tasks WHERE creation_idempotency_key IS NOT NULL OR creation_fingerprint IS NOT NULL"))[0].n, 0);
    await db.migrate();
    for (const statement of cloudMigrations.find((migration) => migration.id === MIGRATION_ID).onlineSql) await query(statement);
    assert.deepEqual(await legacyTasks(), before);
  });

  await test("a repeated key returns the original task and session", async () => {
    const idempotency = { key: randomUUID(), fingerprint: "fingerprint-a" };
    const first = await create(idempotency);
    const retried = await create(idempotency);
    assert.equal(retried.task.id, first.task.id);
    assert.equal(retried.session.id, first.session.id);
    assert.deepEqual(await store.findCreatedTask(userId, idempotency), retried);
    assert.equal(await keyedRows(idempotency.key), 1);
    assert.equal(await sessionRows(first.task.id), 1);
    assert.equal(await store.findCreatedTask(userId, { key: randomUUID(), fingerprint: "fingerprint-a" }), null);
  });

  await test("a key reused with a different request is rejected with 409", async () => {
    const key = randomUUID();
    await create({ key, fingerprint: "fingerprint-a" });
    for (const attempt of [() => create({ key, fingerprint: "fingerprint-b" }, "Draw six foxes"), () => store.findCreatedTask(userId, { key, fingerprint: "fingerprint-b" })]) {
      await assert.rejects(attempt, (error) => error.getStatus() === 409 && error.getResponse().code === "idempotency_key_reused");
    }
    assert.equal(await keyedRows(key), 1);
  });

  await test("new keys, requests without a key, and other users always create new tasks", async () => {
    const shared = { key: randomUUID(), fingerprint: "fingerprint-a" };
    const ids = [
      (await create(shared)).task.id,
      (await create({ key: randomUUID(), fingerprint: "fingerprint-a" })).task.id,
      (await create(undefined)).task.id,
      (await create(undefined)).task.id,
    ];
    const otherWorkspaceId = randomUUID();
    await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Other user',$1::text)", [otherWorkspaceId, tenantId, otherUserId]);
    const other = await store.createTask({ workspaceId: otherWorkspaceId, ownerUserId: otherUserId, title: "Draw five foxes", idempotency: shared });
    ids.push(other.task.id);
    assert.equal(new Set(ids).size, 5);
    assert.equal(await keyedRows(shared.key), 2);
  });

  await test("ten concurrent duplicates store one task and one session", async () => {
    const idempotency = { key: randomUUID(), fingerprint: "fingerprint-a" };
    const results = await Promise.all(Array.from({ length: 10 }, () => create(idempotency, "Five image tasks")));
    assert.equal(new Set(results.map((result) => result.task.id)).size, 1);
    assert.equal(new Set(results.map((result) => result.session.id)).size, 1);
    assert.equal(await keyedRows(idempotency.key), 1);
    assert.equal(await sessionRows(results[0].task.id), 1);
  });

  await test("a duplicate waits for an uncommitted first insert and returns its task", async () => {
    const idempotency = { key: randomUUID(), fingerprint: "fingerprint-a" };
    const holder = await pool.connect();
    try {
      const heldTaskId = randomUUID(), heldSessionId = randomUUID();
      await holder.query("BEGIN");
      await holder.query(
        "INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title,creation_idempotency_key,creation_fingerprint) VALUES($1,$2,$3,$4,'Draw five foxes',$5,$6)",
        [heldTaskId, tenantId, workspaceId, userId, idempotency.key, idempotency.fingerprint],
      );
      await holder.query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [heldSessionId, tenantId, heldTaskId, userId]);
      let settled = false;
      const duplicate = create(idempotency).finally(() => { settled = true; });
      await sleep(300);
      assert.equal(settled, false, "the duplicate must block on the unique index, not insert");
      await holder.query("COMMIT");
      const result = await duplicate;
      assert.equal(result.task.id, heldTaskId);
      assert.equal(result.session.id, heldSessionId);
      assert.equal(await keyedRows(idempotency.key), 1);
    } finally { holder.release(); }
  });

  await test("a rolled-back first insert does not consume the key", async () => {
    const idempotency = { key: randomUUID(), fingerprint: "fingerprint-a" };
    const holder = await pool.connect();
    try {
      const heldTaskId = randomUUID();
      await holder.query("BEGIN");
      await holder.query(
        "INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title,creation_idempotency_key,creation_fingerprint) VALUES($1,$2,$3,$4,'Draw five foxes',$5,$6)",
        [heldTaskId, tenantId, workspaceId, userId, idempotency.key, idempotency.fingerprint],
      );
      const duplicate = create(idempotency);
      await sleep(300);
      await holder.query("ROLLBACK");
      const result = await duplicate;
      assert.notEqual(result.task.id, heldTaskId);
      assert.equal(await keyedRows(idempotency.key), 1);
      assert.equal(await sessionRows(result.task.id), 1);
    } finally { holder.release(); }
  });

  assert.deepEqual(
    (await legacyTasks()).filter(({ row }) => before.some((legacy) => legacy.row.id === row.id)),
    before,
    "existing tasks are still unchanged after the idempotency tests",
  );
  console.log(`${passed} PostgreSQL task-creation idempotency scenarios passed`);
} finally {
  await pool.end();
}
