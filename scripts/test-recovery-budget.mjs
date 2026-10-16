#!/usr/bin/env node
// Operator recovery must reach the next model call under a fresh budget
// generation without re-billing settled usage (H-066).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-recovery-budget.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { BudgetService, PostgresBudgetRepository, InMemoryBudgetHotCounters } from "../apps/api/dist/budget/budget.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlDurableTurnRepository, DurableTurnRunner } from "../apps/worker/dist/turn-runner.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const sql = new PgSqlExecutor(pool);
const db = new CloudDatabaseService(sql);
const turns = new DurableTurnService(db, true);
const budgets = new BudgetService({ repository: new PostgresBudgetRepository(db), hotCounters: new InMemoryBudgetHotCounters(), enabled: true });
const repository = new SqlDurableTurnRepository(sql);
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;

const usage = (costRawMicros) => ({
  kind: "usage", inputTokens: 100, outputTokens: 20, totalTokens: 120,
  costRawMicros: String(costRawMicros), pricingSource: "measured", servedProvider: "router", servedModel: "test-model",
});
/** First call asks for a connector change (shell commands never wait for review); later calls answer. */
function model(costs) {
  let calls = 0;
  return {
    call: async () => {
      calls += 1;
      if (calls === 1 && costs.first !== undefined) {
        return {
          text: "", inputTokens: 100, outputTokens: 20, usage: usage(costs.first),
          toolCalls: [{
            id: randomUUID(), name: "mcp__Connect_Aesg_MCP__recalculate_workbook", input: { workbook: "input.xlsx" },
            retryClass: "non_idempotent_manual", repeatPolicy: "compare_result", idempotencyKey: null,
            requiresApproval: false, approvalKind: "mcp",
          }],
        };
      }
      return { text: "Recalculated workbook is ready.", inputTokens: 100, outputTokens: 20, usage: usage(costs.next), toolCalls: [] };
    },
  };
}
const tools = (behaviour) => ({
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (behaviour === "lost") throw new Error("Connection lost before receiving the command result");
    return { output: { exitCode: 0, content: "converted" }, summary: "Conversion completed" };
  },
});
async function drive(runner, runId) {
  let result;
  for (let i = 0; i < 12; i += 1) {
    result = await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason: "continue" }));
    if (["completed", "failed", "cancelled", "recovery_required"].includes(result.state)) return result.state;
  }
  throw new Error("Run did not settle");
}
async function fixture() {
  const taskId = randomUUID(), sessionId = randomUUID();
  await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Recovery budget')", [taskId, tenantId, workspaceId, userId]);
  await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
  await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
  return { taskId, sessionId };
}
/** A budgeted turn whose mutating tool loses its receipt after the deadline. */
async function interruptedRun(f) {
  const requestId = randomUUID();
  await budgets.reserve({ tenantId, userId, taskId: f.taskId, sessionId: f.sessionId, requestId, feature: "model", estimatedCostMicros: 1_000, estimatedTokens: 4000 });
  const { runId } = await turns.admit({
    tenantId, userId, workspaceId, ...f, requestId, operationFingerprint: randomUUID(), input: "Recalculate the workbook",
    runtimeRequest: { input: "Recalculate the workbook" }, groundingContext: {}, budgetReservationRequired: true,
  });
  const runner = new DurableTurnRunner(repository, model({ first: 5_000, next: 0 }), tools("lost"), { owner: "recovery-first", toolIdleTimeoutMs: 5, toolMaxDurationMs: 1_000 });
  assert.equal(await drive(runner, runId), "recovery_required");
  const reservation = (await query("SELECT status,actual_cost_micros::text AS actual FROM budget_reservations WHERE tenant_id=$1 AND request_id=$2", [tenantId, requestId]))[0];
  assert.deepEqual(reservation, { status: "reconciled", actual: "5000" });
  return { runId, requestId };
}
const reserver = (action, runId) => async ({ requestId, taskId, sessionId }) => {
  const check = await budgets.reserve({ tenantId, userId, taskId, sessionId, requestId, feature: "model", estimatedCostMicros: 0, estimatedTokens: 4000, metadata: { runId, operatorRecovery: action } });
  return Boolean(check.reservation);
};
const lastAssistantText = async (f) => (await query(
  `SELECT p.content #>> '{}' AS text FROM messages m JOIN message_parts p ON p.message_id=m.id
   WHERE m.session_id=$1 AND m.role='assistant' AND p.type='text' ORDER BY m.sequence_id DESC,p.ordinal DESC LIMIT 1`, [f.sessionId]))[0]?.text;

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Recovery budget tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@recovery.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Recovery budget tests',$1::text)", [workspaceId, tenantId, userId]);

  for (const action of ["retry", "mark-complete"]) {
    await test(`operator ${action} reaches the next model call and bills each generation once`, async () => {
      const f = await fixture();
      const { runId, requestId } = await interruptedRun(f);
      assert.equal(await turns.recover(tenantId, userId, runId, action, reserver(action, runId)), true);
      const runner = new DurableTurnRunner(repository, model({ next: 7_000 }), tools("ok"), { owner: `recovery-${action}` });
      assert.equal(await drive(runner, runId), "completed");
      assert.equal(await lastAssistantText(f), "Recalculated workbook is ready.");
      const reservations = await query(
        "SELECT request_id,status,actual_cost_micros::text AS actual FROM budget_reservations WHERE tenant_id=$1 AND request_id LIKE $2 ORDER BY created_at",
        [tenantId, `${requestId}%`],
      );
      assert.deepEqual(reservations, [
        { request_id: requestId, status: "reconciled", actual: "5000" },
        { request_id: `${requestId}:recovery:1`, status: "reconciled", actual: "7000" },
      ]);
      const events = await query("SELECT request_id,cost_raw_micros::text AS cost FROM usage_events WHERE tenant_id=$1 AND request_id LIKE $2 ORDER BY created_at", [tenantId, `${requestId}%`]);
      assert.deepEqual(events, [{ request_id: requestId, cost: "5000" }, { request_id: `${requestId}:recovery:1`, cost: "7000" }]);
      const org = await query(
        "SELECT COALESCE(sum(amount_micros),0)::text AS total, count(*)::int AS n FROM credit_ledger_entries WHERE tenant_id=$1 AND scope_type='org' AND request_id LIKE $2",
        [tenantId, `${requestId}%`],
      );
      assert.deepEqual(org[0], { total: "12000", n: 4 });
    });
  }

  await test("a true hard limit still blocks recovery and leaves the run recoverable", async () => {
    const f = await fixture();
    const { runId, requestId } = await interruptedRun(f);
    await query(
      "INSERT INTO budget_limits(tenant_id,scope_type,scope_id,period,hard_limit_micros) VALUES($1,'user',$2,'month',1) ON CONFLICT (tenant_id,scope_type,scope_id,period) DO UPDATE SET hard_limit_micros=1,status='active'",
      [tenantId, userId],
    );
    try {
      await assert.rejects(() => turns.recover(tenantId, userId, runId, "retry", reserver("retry", runId)));
    } finally {
      await query("DELETE FROM budget_limits WHERE tenant_id=$1", [tenantId]);
    }
    assert.equal((await query("SELECT state FROM turn_runs WHERE id=$1", [runId]))[0].state, "recovery_required");
    const active = await query("SELECT count(*)::int AS n FROM budget_reservations WHERE tenant_id=$1 AND request_id LIKE $2 AND status='reserved'", [tenantId, `${requestId}%`]);
    assert.equal(active[0].n, 0);
  });

  await test("cancel from recovery stays terminal without a new reservation", async () => {
    const f = await fixture();
    const { runId, requestId } = await interruptedRun(f);
    assert.equal(await turns.recover(tenantId, userId, runId, "cancel", reserver("cancel", runId)), true);
    assert.equal((await query("SELECT state FROM turn_runs WHERE id=$1", [runId]))[0].state, "cancelled");
    const reservations = await query("SELECT count(*)::int AS n FROM budget_reservations WHERE tenant_id=$1 AND request_id LIKE $2", [tenantId, `${requestId}%`]);
    assert.equal(reservations[0].n, 1);
  });

  console.log(`${passed} PostgreSQL recovery-budget scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
