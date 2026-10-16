#!/usr/bin/env node
// Continue must recover the workspace of the run it continues (H-051/H-072).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-continue-lineage.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlSandboxSnapshotRepository } from "../apps/worker/dist/sandbox-continuity.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const sql = new PgSqlExecutor(pool);
const db = new CloudDatabaseService(sql);
const turns = new DurableTurnService(db, true);
const snapshots = new SqlSandboxSnapshotRepository(sql);
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const continuity = (runId) => sql.runWithTenant(tenantId, () => snapshots.continuity(tenantId, runId));

async function fixture() {
  const taskId = randomUUID(), sessionId = randomUUID();
  await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Continue lineage')", [taskId, tenantId, workspaceId, userId]);
  await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
  await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
  return { taskId, sessionId };
}
function admit(f, input, extra = {}) {
  return turns.admit({
    tenantId, userId, workspaceId, ...f, requestId: randomUUID(), operationFingerprint: randomUUID(),
    input, runtimeRequest: { input }, groundingContext: {}, budgetReservationRequired: false, ...extra,
  });
}
async function leaf(f) {
  return (await query("SELECT entry_id,sequence FROM session_entries WHERE session_id=$1 AND is_leaf_marker ORDER BY sequence DESC LIMIT 1", [f.sessionId]))[0];
}
/** Mirror the worker: append a run-owned journal entry, attach a sandbox and checkpoint it. */
async function interruptedWork(f, runId, sandboxId) {
  const parent = await leaf(f);
  const entryId = randomUUID();
  await query("UPDATE session_entries SET is_leaf_marker=false WHERE session_id=$1 AND is_leaf_marker", [f.sessionId]);
  await query(
    `INSERT INTO session_entries(tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,is_leaf_marker,run_id)
     VALUES($1,$2,$3,$4,'message',$5,$6::jsonb,true,$7)`,
    [tenantId, f.sessionId, entryId, parent.entry_id, Number(parent.sequence) + 1,
      JSON.stringify({ type: "message", id: entryId, parentId: parent.entry_id, message: { role: "assistant", content: [{ type: "text", text: "Saved outputs/legend.png and preview.png" }] } }), runId],
  );
  await query("UPDATE turn_runs SET sandbox_provider='e2b',sandbox_id=$2,sandbox_state='running' WHERE id=$1", [runId, sandboxId]);
  const snapshot = (await query(
    `INSERT INTO sandbox_snapshots(tenant_id,run_id,session_id,sandbox_provider,sandbox_id,object_key,content_hash,sequence,status,session_leaf_id,completed_at)
     VALUES($1,$2,$3,'e2b',$4,$5,$6,1,'complete',$7,now()) RETURNING id`,
    [tenantId, runId, f.sessionId, sandboxId, `snapshots/${runId}.tar.zst`, `sha256-${runId}`, entryId],
  ))[0];
  return { entryId, snapshotId: snapshot.id };
}

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Continue tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@continue.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Continue tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("Continue restores the interrupted run's sandbox and checkpoint", async () => {
    const f = await fixture();
    const first = await admit(f, "Edit the legend and save a preview");
    const work = await interruptedWork(f, first.runId, "sandbox-interrupted");
    await turns.cancel(tenantId, f.sessionId);
    assert.equal((await query("SELECT state FROM turn_runs WHERE id=$1", [first.runId]))[0].state, "cancelled");
    const resumed = await admit(f, "Continue", { continueInterruptedTurn: true });
    const runtime = (await query("SELECT runtime_request FROM turn_runs WHERE id=$1", [resumed.runId]))[0].runtime_request;
    assert.equal(runtime.continuationSourceRunId, first.runId);
    assert.equal(runtime.continuationHeadEntryId, work.entryId);
    const record = await continuity(resumed.runId);
    assert(record, "continuation must see the interrupted workspace");
    assert.equal(record.sandboxId, "sandbox-interrupted");
    assert.equal(record.snapshot?.id, work.snapshotId);
  });

  await test("Continue after a failure before any output keeps prior completed work", async () => {
    const f = await fixture();
    const earlier = await admit(f, "Draft the report");
    const kept = await interruptedWork(f, earlier.runId, "sandbox-earlier");
    await query("UPDATE turn_runs SET state='completed' WHERE id=$1", [earlier.runId]);
    const failed = await admit(f, "Now add a chart");
    await query("UPDATE turn_runs SET state='failed',error='Gemini HTTP 400' WHERE id=$1", [failed.runId]);
    const resumed = await admit(f, "Continue", { continueInterruptedTurn: true });
    const runtime = (await query("SELECT runtime_request FROM turn_runs WHERE id=$1", [resumed.runId]))[0].runtime_request;
    assert.equal(runtime.continuationSourceRunId, failed.runId);
    const record = await continuity(resumed.runId);
    assert.equal(record?.sandboxId, "sandbox-earlier");
    assert.equal(record?.snapshot?.id, kept.snapshotId);
  });

  await test("an edited earlier message never inherits descendant workspace state", async () => {
    const f = await fixture();
    const first = await admit(f, "Write version one");
    const firstMessage = (await query("SELECT request_message_id FROM turn_runs WHERE id=$1", [first.runId]))[0].request_message_id;
    await interruptedWork(f, first.runId, "sandbox-version-one");
    await turns.cancel(tenantId, f.sessionId);
    const edited = await admit(f, "Write version two instead", { replaceFromMessageId: firstMessage });
    assert.equal(await continuity(edited.runId), null);
  });

  await test("a continuation head on another branch falls back to the request branch", async () => {
    const f = await fixture();
    const first = await admit(f, "Build the table");
    await interruptedWork(f, first.runId, "sandbox-table");
    await query("UPDATE turn_runs SET state='failed',error='provider failure' WHERE id=$1", [first.runId]);
    // Simulate the visible leaf moving to an unrelated root (for example a
    // rewind by another client). The head must not be trusted then.
    const other = randomUUID();
    await query("UPDATE session_entries SET is_leaf_marker=false WHERE session_id=$1", [f.sessionId]);
    await query(
      `INSERT INTO session_entries(tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,is_leaf_marker)
       VALUES($1,$2,$3,NULL,'message',1000,'{"type":"message"}'::jsonb,true)`,
      [tenantId, f.sessionId, other],
    );
    const resumed = await admit(f, "Continue", { continueInterruptedTurn: true });
    const runtime = (await query("SELECT runtime_request FROM turn_runs WHERE id=$1", [resumed.runId]))[0].runtime_request;
    assert.equal(runtime.continuationSourceRunId, first.runId);
    assert.equal(runtime.continuationHeadEntryId, undefined);
    assert.equal(await continuity(resumed.runId), null);
  });

  console.log(`${passed} PostgreSQL continue-lineage scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
