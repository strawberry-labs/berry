#!/usr/bin/env node
// Use an isolated, migrated loopback PostgreSQL database. No live models or credentials.
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-scheduled-tasks.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { SqlScheduledTaskRepository } from "../packages/db/dist/index.js";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { ScheduledTasksService } from "../apps/api/dist/schedules/scheduled-tasks.service.js";
import { ScheduledTaskDispatcher } from "../apps/api/dist/schedules/scheduled-task-dispatcher.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlDurableTurnRepository, DurableTurnRunner } from "../apps/worker/dist/turn-runner.js";
import { DurableScheduledTaskToolExecutor } from "../apps/worker/dist/schedules/tools.js";

const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use a disposable loopback database");
const pool = new Pool({ connectionString: url.href, max: 16 });
const sql = new PgSqlExecutor(pool);
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const repository = new SqlScheduledTaskRepository(sql);
const db = new CloudDatabaseService(sql);
const turns = new DurableTurnService(db, true);
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const scope = { tenantId, userId };
const services = new ScheduledTasksService(db, true);
// The fixture tenant is isolated from the self-host default.
Object.defineProperty(services, "tenantId", { value: tenantId });
const runner = new DurableTurnRunner(new SqlDurableTurnRepository(sql), {
  call: async (snapshot, _step, context) => {
    const text = `Scheduled result: ${snapshot.runtimeRequest.input}`;
    await context.emitDelta(text, "text");
    return { text, inputTokens: 10, outputTokens: 5, toolCalls: [] };
  },
}, { execute: async () => ({ output: {}, summary: "" }) }, { owner: "scheduled-task-integration" });

async function admit(claim) {
  const [task] = await query("SELECT task_id FROM sessions WHERE id=$1", [claim.sessionId]);
  const result = await turns.admit({ tenantId, userId: claim.userId, workspaceId: claim.workspaceId,
    taskId: task.task_id, sessionId: claim.sessionId, requestId: `model_${claim.id}`, operationFingerprint: claim.id,
    input: claim.input.prompt, runtimeRequest: { input: claim.input.prompt, timezone: claim.input.timezone },
    groundingContext: {}, budgetReservationRequired: false });
  return result.runId;
}
async function drain(runId) {
  for (let i = 0; i < 12; i++) {
    const result = await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason: "continue" }));
    if (["completed", "failed", "cancelled", "recovery_required"].includes(result.state)) {
      assert.equal(result.state, "completed"); return;
    }
  }
  throw new Error("Scheduled turn did not finish");
}
const create = (changes = {}) => repository.create(scope, { operationId: randomUUID(), workspaceId,
  name: "Daily briefing", prompt: "Prepare the daily briefing with sources", schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Dubai" }, ...changes });
const makeDue = (id) => query("UPDATE scheduled_tasks SET next_run_at=now()-interval '2 days' WHERE id=$1", [id]);
const claim = async () => { const owner = randomUUID(); return { owner, claims: await repository.claimPending(tenantId, owner) }; };
async function settlePending() {
  const { owner, claims } = await claim();
  for (const c of claims) { const turnId = await admit(c); await repository.admitted(tenantId, c.id, owner, turnId); await drain(turnId); }
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1::uuid,'Schedule tests',$1::text)", [tenantId]);
  await query("INSERT INTO users(id,email,name) VALUES($1,$2,'Schedule Tester')", [userId, `${userId}@schedule.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Schedule tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("concurrent create retries store one reminder anchored to the database clock", async () => {
    const input = { operationId: randomUUID(), workspaceId, name: "Reminder", prompt: "Prepare a summary", schedule: { kind: "delay", minutes: 20, timezone: "Asia/Dubai" } };
    const [a, b] = await Promise.all([repository.create(scope, input), repository.create(scope, input)]);
    assert.equal(a.id, b.id); assert.equal(a.schedule.runAt, b.schedule.runAt);
    assert(Math.abs(new Date(a.nextRunAt).getTime() - Date.now() - 20 * 60_000) < 10_000);
    await assert.rejects(() => repository.create(scope, { ...input, prompt: "Different task" }), /different schedule change/);
    await repository.remove(scope, a.id);
  });
  await test("replica claims create exactly one chat and coalesce two days of downtime", async () => {
    const s = await create({ schedule: { kind: "cron", expression: "* * * * *", timezone: "UTC" } }); await makeDue(s.id);
    await Promise.all(Array.from({ length: 8 }, () => repository.enqueueDue(tenantId)));
    let history = await repository.history(scope, s.id); assert.equal(history.length, 1); assert(history[0].taskId); assert(history[0].sessionId);
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => repository.claimPending(tenantId, `replica-${i}`)))).flat();
    assert.equal(claims.length, 1); assert.equal(claims[0].id, history[0].id);
    const next = (await repository.list(scope)).find((v) => v.id === s.id).nextRunAt; assert(new Date(next) > new Date());
    const turnId = await admit(claims[0]);
    // Simulate process death after admission, before the scheduler settles its lease.
    assert.equal((await repository.claimPending(tenantId, "restarted-process")).length, 0);
    history = await repository.history(scope, s.id); assert.equal(history[0].turnId, turnId); assert.equal(history[0].state, "admitted");
    assert.equal((await query("SELECT count(*)::int AS n FROM runtime_outbox WHERE aggregate_id=$1 AND event_type='turn.execute'", [turnId]))[0].n, 1);
    await drain(turnId); history = await repository.history(scope, s.id); assert.equal(history[0].turnState, "completed"); assert(history[0].finishedAt);
    assert((await query("SELECT p.content::text AS text FROM messages m JOIN message_parts p ON p.message_id=m.id WHERE m.session_id=$1 AND m.role='assistant'", [history[0].sessionId])).some((v) => v.text.includes("Scheduled result:")));
    await repository.remove(scope, s.id);
  });
  await test("manual retries are idempotent, do not shift recurring time, and prevent overlap", async () => {
    const s = await create(), key = randomUUID();
    const [a, b] = await Promise.all([repository.runNow(scope, s.id, key), repository.runNow(scope, s.id, key)]); assert.equal(a.id, b.id);
    assert.equal((await repository.list(scope)).find((v) => v.id === s.id).nextRunAt, s.nextRunAt);
    await assert.rejects(() => repository.runNow(scope, s.id, randomUUID()), /in progress/);
    await makeDue(s.id); await repository.enqueueDue(tenantId);
    assert((await repository.history(scope, s.id)).some((v) => v.state === "skipped" && v.error.includes("Previous run")));
    await settlePending(); await repository.remove(scope, s.id);
  });
  await test("one-time due work fires once and must be rescheduled before restarting", async () => {
    const s = await create({ schedule: { kind: "delay", minutes: 1, timezone: "Asia/Dubai" } });
    await makeDue(s.id); await repository.enqueueDue(tenantId); await repository.enqueueDue(tenantId);
    assert.equal((await repository.history(scope, s.id)).length, 1);
    assert.equal((await repository.list(scope)).find((v) => v.id === s.id).state, "completed");
    await settlePending();
    await query("UPDATE scheduled_tasks SET schedule=jsonb_set(schedule,'{runAt}',to_jsonb((now()-interval '1 minute')::text)) WHERE id=$1", [s.id]);
    await assert.rejects(() => repository.update(scope, s.id, { state: "active" }), /future time/);
    // Supply a new valid instant; pending occurrences from the old schedule stay cancelled.
    await repository.update(scope, s.id, { schedule: { kind: "delay", minutes: 5, timezone: "UTC" } });
    await repository.runNow(scope, s.id, randomUUID());
    await repository.update(scope, s.id, { schedule: { kind: "delay", minutes: 10, timezone: "UTC" } });
    assert((await repository.history(scope, s.id)).some((v) => v.state === "skipped"));
    await repository.remove(scope, s.id);
  });
  await test("pause, reschedule and delete cancel queued runs but preserve dispatched chats", async () => {
    const s = await create(); const run = await repository.runNow(scope, s.id, randomUUID());
    await repository.update(scope, s.id, { state: "paused" });
    assert.equal((await repository.history(scope, s.id))[0].state, "skipped");
    assert.equal((await query("SELECT status FROM tasks WHERE id=$1", [run.taskId]))[0].status, "cancelled");
    const nameOnly = await repository.update(scope, s.id, { name: "Edited while paused" }); assert.equal(nameOnly.state, "paused");
    await repository.update(scope, s.id, { state: "active" }); await repository.runNow(scope, s.id, randomUUID());
    const { owner, claims } = await claim(); const dispatched = claims.find((v) => v.workspaceId === workspaceId); assert(dispatched);
    await repository.remove(scope, s.id); assert.equal(await repository.authorizeClaim(tenantId, dispatched.id, owner), true);
    const turnId = await admit(dispatched); await repository.admitted(tenantId, dispatched.id, owner, turnId); await drain(turnId);
    assert.equal((await query("SELECT state FROM turn_runs WHERE id=$1", [turnId]))[0].state, "completed");
    assert((await query("SELECT id FROM tasks WHERE id=$1", [run.taskId])).length);
  });
  await test("lost admission response recovers the existing turn rather than failing its chat", async () => {
    const s = await create(); await repository.runNow(scope, s.id, randomUUID()); const { owner, claims } = await claim(); const c = claims[0];
    const turnId = await admit(c); await repository.failed(tenantId, c.id, owner, "Lost response", true);
    const [run] = await repository.history(scope, s.id); assert.equal(run.state, "admitted"); assert.equal(run.turnId, turnId); assert.equal(run.error, null);
    assert.notEqual((await query("SELECT status FROM tasks WHERE id=$1", [run.taskId]))[0].status, "failed");
    await drain(turnId); await repository.remove(scope, s.id);
  });
  await test("expired dispatch leases recover and old owners cannot settle the replacement", async () => {
    const s = await create(); await repository.runNow(scope, s.id, randomUUID()); const a = await claim(); assert.equal(a.claims.length, 1);
    assert.equal((await repository.claimPending(tenantId, "another-owner")).length, 0);
    await query("UPDATE scheduled_task_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [a.claims[0].id]);
    const b = await claim(); assert.equal(b.claims[0].id, a.claims[0].id);
    await repository.failed(tenantId, a.claims[0].id, a.owner, "Stale owner", false);
    assert.equal((await repository.history(scope, s.id))[0].state, "dispatching");
    const turnId = await admit(b.claims[0]); await repository.admitted(tenantId, b.claims[0].id, b.owner, turnId); await drain(turnId); await repository.remove(scope, s.id);
  });
  await test("transient failures retry at most three times and terminal failures retain their chat", async () => {
    const s = await create(); const r = await repository.runNow(scope, s.id, randomUUID());
    for (let i = 0; i < 3; i++) {
      const { owner, claims } = await claim(); assert.equal(claims[0].id, r.id);
      await repository.failed(tenantId, r.id, owner, "Temporary failure", true);
      assert.equal((await repository.history(scope, s.id))[0].state, i < 2 ? "pending" : "failed");
      await query("UPDATE scheduled_task_runs SET retry_at=now() WHERE id=$1", [r.id]);
    }
    assert.equal((await repository.claimPending(tenantId, "final")).length, 0);
    assert.equal((await query("SELECT status FROM tasks WHERE id=$1", [r.taskId]))[0].status, "failed"); await repository.remove(scope, s.id);
  });
  await test("revoked membership prevents both new due runs and claimed admission", async () => {
    const s = await create(), r = await repository.runNow(scope, s.id, randomUUID()); const { owner } = await claim();
    await query("UPDATE tenant_memberships SET status='suspended' WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
    try {
      assert.equal(await repository.authorizeClaim(tenantId, r.id, owner), false);
      await makeDue(s.id); await repository.enqueueDue(tenantId); assert.equal((await repository.list(scope)).find((v) => v.id === s.id).state, "paused");
      await assert.rejects(() => repository.runNow(scope, s.id, randomUUID()), /membership/);
      await repository.failed(tenantId, r.id, owner, "Access removed", false);
    } finally { await query("UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]); }
    await repository.remove(scope, s.id);
  });
  await test("API dispatcher creates a real durable turn through the normal admission port", async () => {
    const s = await create(); await repository.runNow(scope, s.id, randomUUID());
    const dispatcher = new ScheduledTaskDispatcher(services, { startTurn: async (request, sessionId, body) => {
      assert.equal(request.auth.user.id, userId); assert.equal(body.timezone, "Asia/Dubai");
      return { turnId: await admit({ id: body.operationId, userId, workspaceId, sessionId, input: { prompt: body.input, timezone: body.timezone } }) };
    } }, { config: { workspacePath: "/workspace" } });
    await dispatcher.tick(); await dispatcher.onModuleDestroy(); const [run] = await repository.history(scope, s.id);
    assert.equal(run.state, "admitted"); await drain(run.turnId); await repository.remove(scope, s.id);
  });
  await test("scheduled work remains subject to the normal worker spend limits", async () => {
    const s = await create(); await repository.runNow(scope, s.id, randomUUID()); const { owner, claims } = await claim(); const c = claims[0];
    const turnId = await admit(c); await repository.admitted(tenantId, c.id, owner, turnId);
    await query("UPDATE turn_runs SET runtime_request=jsonb_set(runtime_request,'{budgetReservationRequired}','true'::jsonb) WHERE id=$1", [turnId]);
    await query("INSERT INTO budget_limits(tenant_id,scope_type,scope_id,period,hard_limit_micros) VALUES($1,'user',$2,'month',1) ON CONFLICT (tenant_id,scope_type,scope_id,period) DO UPDATE SET hard_limit_micros=1", [tenantId, userId]);
    try {
      const workerRepo = new SqlDurableTurnRepository(sql);
      const snapshot = await sql.runWithTenant(tenantId, () => workerRepo.claim({ tenantId, runId: turnId }, "schedule-budget-test", 30)); assert(snapshot);
      const reservation = await sql.runWithTenant(tenantId, () => workerRepo.reserveNextModelCall(snapshot, "100")); assert.equal(reservation.allowed, false);
    } finally { await query("DELETE FROM budget_limits WHERE tenant_id=$1", [tenantId]); await turns.cancel(tenantId, c.sessionId); }
    await repository.remove(scope, s.id);
  });
  await test("chat tools work inside any task, inherit model and timezone, and replay safely", async () => {
    const taskId = randomUUID(), sessionId = randomUUID();
    await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Conversation schedule source')", [taskId, tenantId, workspaceId, userId]);
    await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
    const tools = new DurableScheduledTaskToolExecutor({ definitions: async () => [], execute: async () => ({ output: {}, summary: "base" }) }, sql);
    const snapshot = { tenantId, userId, workspaceId, taskId, sessionId, runtimeRequest: {
      capabilityVersion: 1, input: "Every weekday at 9am prepare my briefing", providerId: "test-provider",
      provider: { id: "test-provider", name: "Test provider", kind: "openai-compatible", baseUrl: "https://provider.invalid/v1", defaultModel: "test-model", authType: "none" }, model: "test-model",
      workspaceId, workspacePath: "/workspace", permissionMode: "full-access", builtInTools: [],
      maxTokens: 4000, contextWindowTokens: 128000, reasoning: "high", timezone: "Asia/Dubai",
    } };
    assert((await tools.definitions(snapshot)).find((v) => v.function.name === "create_scheduled_task").function.description.includes("Asia/Dubai"));
    const step = { id: randomUUID(), type: "tool:create_scheduled_task", input: { toolName: "create_scheduled_task", arguments: { name: "From chat", prompt: "Prepare my briefing", schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Dubai" } } } };
    const a = await tools.execute(snapshot, step), b = await tools.execute(snapshot, step); assert.equal(a.output.scheduledTask.id, b.output.scheduledTask.id);
    const s = a.output.scheduledTask; assert.equal(s.sourceTaskId, taskId); assert.equal(s.model, "test-model"); assert.equal(s.modelProviderId, "test-provider"); assert.equal(s.reasoning, "high");
    const update = { id: randomUUID(), type: "tool:update_scheduled_task", input: { arguments: { id: s.id, changes: { schedule: { kind: "delay", minutes: 20, timezone: "Asia/Dubai" } } } } };
    const x = await tools.execute(snapshot, update), y = await tools.execute(snapshot, update); assert.equal(x.output.scheduledTask.nextRunAt, y.output.scheduledTask.nextRunAt);
    assert.equal((await tools.execute(snapshot, { id: randomUUID(), type: "tool:list_scheduled_tasks", input: { arguments: {} } })).output.schedules.length, 1);
    const deletion = { id: randomUUID(), type: "tool:delete_scheduled_task", input: { arguments: { id: s.id } } }; await tools.execute(snapshot, deletion); await tools.execute(snapshot, deletion);
    assert.equal((await repository.list(scope)).length, 0);
  });
  await test("ownership checks reject another member and another tenant", async () => {
    const s = await create(); const other = { tenantId, userId: randomUUID() }, cross = { tenantId: randomUUID(), userId };
    for (const unauthorized of [other, cross]) {
      assert.equal((await repository.list(unauthorized)).length, 0);
      await assert.rejects(() => repository.update(unauthorized, s.id, { prompt: "Steal task" }), /not found/);
      await assert.rejects(() => repository.runNow(unauthorized, s.id, randomUUID()), /not found/);
      await assert.rejects(() => repository.history(unauthorized, s.id), /not found/);
      await assert.rejects(() => repository.remove(unauthorized, s.id), /not found/);
    }
    await repository.remove(scope, s.id);
  });
  await test("forced RLS hides schedules from a restricted database role in a different tenant", async () => {
    const s = await create(); const role = `schedule_rls_${randomUUID().replaceAll("-", "")}`;
    await query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    await query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await query(`GRANT SELECT ON scheduled_tasks,scheduled_task_runs,scheduled_task_operations TO ${role}`);
    await query(`GRANT EXECUTE ON FUNCTION berry_set_tenant_id(uuid) TO ${role}`);
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`); await c.query("SELECT berry_set_tenant_id($1::uuid)", [randomUUID()]);
      assert.equal((await c.query("SELECT id FROM scheduled_tasks WHERE id=$1", [s.id])).rows.length, 0);
      await c.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]); assert.equal((await c.query("SELECT id FROM scheduled_tasks WHERE id=$1", [s.id])).rows.length, 1);
      await c.query("ROLLBACK");
    } finally { c.release(); await query(`DROP OWNED BY ${role}`); await query(`DROP ROLE ${role}`); }
    await repository.remove(scope, s.id);
  });
  console.log(`${passed} PostgreSQL scheduled-task integration scenarios passed`);
  if (process.argv.includes("--serve")) {
    const { serveScheduledTasksFixture } = await import("./scheduled-tasks-browser-server.mjs");
    await serveScheduledTasksFixture({ tenantId, userId, workspaceId, scope, repository, services, query, claim, admit, drain, turns, makeDue });
  }
} finally {
  // Audit-protected fixtures remain for inspection in this disposable database.
  console.log(`Fixture tenant: ${tenantId}`); await pool.end();
}
