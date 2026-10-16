#!/usr/bin/env node
// Queued, Continue and recovered runs must run on the provider and model their
// turn was admitted with. The runtime JSON goes through the real API write
// paths and PostgreSQL into the worker's strict contract, with no global
// router configured, so a run parsed as legacy fails here (H-001, H-051, H-066).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-admitted-runtime-contract.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DURABLE_BASE_BUILT_IN_TOOLS, DurableTurnRuntimeRequestSchema } from "../packages/shared/dist/index.js";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { QueuedFollowUpService } from "../apps/api/dist/runtime/queued-follow-up.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { BudgetService, PostgresBudgetRepository, InMemoryBudgetHotCounters } from "../apps/api/dist/budget/budget.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlDurableTurnRepository, DurableTurnRunner, SnapshotProviderDurableTurnModel } from "../apps/worker/dist/turn-runner.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const sql = new PgSqlExecutor(pool);
const db = new CloudDatabaseService(sql);
const queue = new QueuedFollowUpService(db);
const turns = new DurableTurnService(db, true);
const budgets = new BudgetService({ repository: new PostgresBudgetRepository(db), hotCounters: new InMemoryBudgetHotCounters(), enabled: true });
const repository = new SqlDurableTurnRepository(sql);
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;

/** The organization's provider: an OpenAI-compatible endpoint that records each request. */
const requests = [];
const replies = [];
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body || "{}");
  requests.push({ path: request.url, model: parsed.model });
  const reply = replies.shift() ?? { text: `Answer ${requests.length}` };
  const message = reply.toolCall
    ? { role: "assistant", content: "", tool_calls: [{ id: reply.toolCall.id, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } }] }
    : { role: "assistant", content: reply.text };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: `response-${requests.length}`, model: parsed.model,
    choices: [{ index: 0, message, finish_reason: reply.toolCall ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 },
  }));
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const transport = {
  id: "org-provider", name: "Organization provider", kind: "openai-compatible",
  baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, defaultModel: "org-default",
  apiType: "openai-chat-completions", endpointPath: "/chat/completions", authType: "none",
  completionTransport: "buffered", models: [],
};
/** What agent-api.controller.ts admits; no global router is configured (legacy model null). */
const admittedRuntime = () => DurableTurnRuntimeRequestSchema.parse({
  capabilityVersion: 1, admissionFingerprint: "a".repeat(64), providerId: transport.id, provider: transport, model: "org-model",
  workflowCategory: "general", workflowCategoryVersion: "workflow-v1", workspacePath: "/workspace", workspaceId,
  permissionMode: "full-access", reasoning: "off", maxTokens: 1_000, contextWindowTokens: 128_000, modelAcceptsImages: false,
  modelPricing: { input: 1, output: 1 }, builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS],
});
const model = new SnapshotProviderDurableTurnModel({}, null);
const tools = (lost = false) => ({ execute: async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (lost) throw new Error("Connection lost before receiving the command result");
  return { output: { exitCode: 0, content: "done" }, summary: "Command completed" };
} });

async function fixture() {
  const taskId = randomUUID(), sessionId = randomUUID();
  await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Admitted runtime')", [taskId, tenantId, workspaceId, userId]);
  await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
  await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
  return { taskId, sessionId };
}
function admit(f, input, extra = {}) {
  return turns.admit({
    tenantId, userId, workspaceId, ...f, requestId: randomUUID(), operationFingerprint: "a".repeat(64), input,
    runtimeRequest: { ...admittedRuntime(), budgetReservationRequired: false }, groundingContext: {}, budgetReservationRequired: false, ...extra,
  });
}
async function drive(runId, runner) {
  for (let i = 0; i < 12; i += 1) {
    const result = await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason: "continue" }));
    if (["completed", "failed", "cancelled", "recovery_required"].includes(result.state)) return result.state;
  }
  throw new Error("Run did not settle");
}
const run = async (runId) => (await query("SELECT state,error,runtime_request FROM turn_runs WHERE id=$1", [runId]))[0];
const latestRun = async (f, exclude) => (await query("SELECT id,runtime_request FROM turn_runs WHERE session_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 1", [f.sessionId, exclude]))[0];

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Admitted runtime tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@runtime.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Admitted runtime tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("a queued follow-up runs on the admitted provider and bills all of its own usage", async () => {
    const f = await fixture();
    const first = await admit(f, "Draft the reply");
    // As if the active run had been reopened by operator recovery.
    await query(`UPDATE turn_runs SET runtime_request=runtime_request || '{"budgetBaseRequestId":"earlier","budgetGeneration":1,"budgetUsageAfterSequence":1000,"budgetBaselineCostMicros":"5000"}'::jsonb WHERE id=$1`, [first.runId]);
    const key = randomUUID();
    await queue.enqueue(tenantId, userId, f.sessionId, { taskId: f.taskId, workspaceId, input: "Make it shorter", attachments: [], idempotencyKey: key }, async (_runtime, requestId) => {
      const check = await budgets.reserve({ tenantId, userId, taskId: f.taskId, sessionId: f.sessionId, requestId, feature: "model", estimatedCostMicros: 0, estimatedTokens: 4000 });
      return Boolean(check.reservation);
    });
    const before = requests.length;
    assert.equal(await drive(first.runId, new DurableTurnRunner(repository, model, tools(), { owner: "runtime-queue-1" })), "completed");
    const queued = await latestRun(f, first.runId);
    assert(queued, "the queued follow-up was not delivered");
    for (const key of ["budgetBaseRequestId", "budgetGeneration", "budgetUsageAfterSequence", "budgetBaselineCostMicros", "continuationSourceRunId", "queuedBudgetRequestId"]) {
      assert(!(key in queued.runtime_request), `queued run inherited ${key}`);
    }
    const state = await drive(queued.id, new DurableTurnRunner(repository, model, tools(), { owner: "runtime-queue-2" }));
    assert.equal(state, "completed", (await run(queued.id)).error ?? state);
    assert.deepEqual(requests.slice(before).map((request) => request.model), ["org-model", "org-model"]);
    const reservation = (await query("SELECT status,actual_cost_micros::text AS actual FROM budget_reservations WHERE tenant_id=$1 AND request_id=$2", [tenantId, `queued:${key}`]))[0];
    // 1,000 input and 1,000 output tokens at 1 USD per million each.
    assert.deepEqual(reservation, { status: "reconciled", actual: "2000" });
  });

  await test("Continue runs on the admitted provider", async () => {
    const f = await fixture();
    const first = await admit(f, "Summarise the report");
    await turns.cancel(tenantId, f.sessionId);
    const resumed = await admit(f, "", { continueInterruptedTurn: true });
    const stored = await run(resumed.runId);
    assert.equal(stored.runtime_request.continuationSourceRunId, first.runId);
    const before = requests.length;
    const state = await drive(resumed.runId, new DurableTurnRunner(repository, model, tools(), { owner: "runtime-continue" }));
    assert.equal(state, "completed", (await run(resumed.runId)).error ?? state);
    assert.deepEqual(requests.slice(before).map((request) => request.model), ["org-model"]);
  });

  await test("an operator-recovered run runs on the admitted provider under its new budget generation", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    await budgets.reserve({ tenantId, userId, taskId: f.taskId, sessionId: f.sessionId, requestId, feature: "model", estimatedCostMicros: 1_000, estimatedTokens: 4000 });
    const { runId } = await turns.admit({
      tenantId, userId, workspaceId, ...f, requestId, operationFingerprint: "a".repeat(64), input: "Convert the workbook",
      runtimeRequest: { ...admittedRuntime(), budgetReservationRequired: true }, groundingContext: {}, budgetReservationRequired: true,
    });
    replies.push({ toolCall: { id: "call-convert", name: "bash", arguments: { command: "soffice --convert-to xlsx input.xlsx" } } });
    const lost = new DurableTurnRunner(repository, model, tools(true), { owner: "runtime-recovery-1", toolIdleTimeoutMs: 5, toolMaxDurationMs: 1_000 });
    assert.equal(await drive(runId, lost), "recovery_required");
    assert.equal(await turns.recover(tenantId, userId, runId, "retry", async ({ requestId: next, taskId, sessionId }) => {
      const check = await budgets.reserve({ tenantId, userId, taskId, sessionId, requestId: next, feature: "model", estimatedCostMicros: 0, estimatedTokens: 4000 });
      return Boolean(check.reservation);
    }), true);
    const reopened = await run(runId);
    assert.equal(reopened.runtime_request.budgetGeneration, 1);
    assert.equal(reopened.runtime_request.requestId, `${requestId}:recovery:1`);
    const before = requests.length;
    const state = await drive(runId, new DurableTurnRunner(repository, model, tools(), { owner: "runtime-recovery-2" }));
    assert.equal(state, "completed", (await run(runId)).error ?? state);
    assert(requests.slice(before).length >= 1);
    assert.deepEqual([...new Set(requests.slice(before).map((request) => request.model))], ["org-model"]);
  });

  assert(requests.every((request) => request.path === "/v1/chat/completions"));
  console.log(`${passed} PostgreSQL admitted-runtime scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  provider.close();
  await pool.end();
}
