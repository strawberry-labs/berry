#!/usr/bin/env node
// A tool result containing NUL characters must not fail the run: PostgreSQL
// JSONB rejects U+0000 ("unsupported Unicode escape sequence") (H-011).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-binary-tool-output.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
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

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Binary tool output',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@binary.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Binary tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("a tool result containing NUL characters is journaled and the run completes", async () => {
    const taskId = randomUUID(), sessionId = randomUUID();
    await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Skill package')", [taskId, tenantId, workspaceId, userId]);
    await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
    await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
    const input = "What is inside bundle.skill?";
    const run = await turns.admit({
      tenantId, userId, workspaceId, taskId, sessionId, requestId: randomUUID(), operationFingerprint: randomUUID(),
      input, runtimeRequest: { input }, groundingContext: {}, budgetReservationRequired: false,
    });
    let calls = 0;
    const model = {
      call: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            text: "", inputTokens: 10, outputTokens: 5,
            toolCalls: [{
              id: randomUUID(), name: "read", input: { path: "/workspace/inputs/bundle.skill" },
              retryClass: "read_only", repeatPolicy: "compare_result", idempotencyKey: null,
              requiresApproval: false, approvalKind: "file-edit",
            }],
          };
        }
        return { text: "The package holds a skill manifest.", inputTokens: 10, outputTokens: 5, toolCalls: [] };
      },
    };
    // What a UTF-8 read of a ZIP-based package used to return.
    const tools = { execute: async () => ({ output: { path: "/workspace/inputs/bundle.skill", content: "PK\u0003\u0004\u0014\u0000\u0000\u0000SKILL.md" }, summary: "Read bundle.skill" }) };
    const runner = new DurableTurnRunner(repository, model, tools, { owner: "binary-tool-output" });
    assert.equal(await drive(runner, run.runId), "completed");

    const [step] = await query("SELECT output::text AS output FROM turn_steps WHERE run_id=$1 AND step_type='tool.read'", [run.runId]);
    assert(step, "the tool step is journaled");
    assert(!step.output.includes("\\u0000"), step.output);
    assert(step.output.includes("�") || step.output.includes("\\ufffd"), step.output);
    const answer = await query(
      `SELECT p.content #>> '{}' AS text FROM messages m JOIN message_parts p ON p.message_id=m.id
       WHERE m.session_id=$1 AND m.role='assistant' AND p.type='text'`, [sessionId]);
    assert(answer.some((part) => part.text.includes("skill manifest")), JSON.stringify(answer));
  });

  console.log(`${passed} PostgreSQL binary tool output scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
