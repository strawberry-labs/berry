#!/usr/bin/env node
// A failed provider call must not reach the next model as an assistant answer (H-048).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-provider-error-history.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { RouterClientError } from "../packages/router-client/dist/index.js";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlDurableTurnRepository, DurableTurnRunner, modelMessages } from "../apps/worker/dist/turn-runner.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const sql = new PgSqlExecutor(pool);
const db = new CloudDatabaseService(sql);
const turns = new DurableTurnService(db, true);
const repository = new SqlDurableTurnRepository(sql);
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;

async function drive(runner, runId) {
  for (let i = 0; i < 12; i += 1) {
    const result = await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason: "continue" }));
    if (["completed", "failed", "cancelled", "recovery_required"].includes(result.state)) return result.state;
  }
  throw new Error("Run did not settle");
}
const admit = (f, input) => turns.admit({
  tenantId, userId, workspaceId, ...f, requestId: randomUUID(), operationFingerprint: randomUUID(),
  input, runtimeRequest: { input }, groundingContext: {}, budgetReservationRequired: false,
});

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Provider error history',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@history.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'History tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("a provider rejection is shown to the user but not replayed as assistant history", async () => {
    const taskId = randomUUID(), sessionId = randomUUID();
    await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Fees')", [taskId, tenantId, workspaceId, userId]);
    await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
    await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
    const f = { taskId, sessionId };

    const first = await admit(f, "What are the professional registration fees?");
    const rejecting = new DurableTurnRunner(repository, {
      call: async () => { throw new RouterClientError("Invalid request", 400, "INVALID_ARGUMENT", { code: "invalid_request" }); },
    }, { execute: async () => ({ output: {}, summary: "" }) }, { owner: "history-provider-400" });
    assert.equal(await drive(rejecting, first.runId), "failed");
    const visibleError = (await query(
      `SELECT p.content #>> '{}' AS text FROM messages m JOIN message_parts p ON p.message_id=m.id
       WHERE m.session_id=$1 AND m.role='assistant' AND p.type='error' LIMIT 1`, [sessionId]))[0]?.text;
    assert(visibleError, "the failure stays visible in the transcript");

    // The user retries on another model; admission projects the failed message into the journal.
    const second = await admit(f, "What are the professional registration fees?");
    const snapshot = await sql.runWithTenant(tenantId, () => repository.claim({ tenantId, runId: second.runId }, "history-inspect", 30));
    assert(snapshot);
    const history = modelMessages(snapshot).messages;
    const assistant = history.filter((message) => message.role === "assistant").map((message) => JSON.stringify(message.content)).join("\n");
    assert(!assistant.includes(visibleError), `assistant history must not contain the platform error: ${assistant}`);
    assert.equal(history.at(-1).role, "user");
    assert.match(JSON.stringify(history.at(-1).content), /registration fees/);
  });

  console.log(`${passed} PostgreSQL provider-error history scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
