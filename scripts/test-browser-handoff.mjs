#!/usr/bin/env node
// Disposable loopback PostgreSQL only. No live models or Berrycrawl credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { BrowserHandoffService } from "../apps/api/dist/browser/browser-handoff.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlDurableTurnRepository, DurableTurnRunner, modelMessages } from "../apps/worker/dist/turn-runner.js";
import { DurableTurnRuntimeRequestSchema } from "../packages/shared/dist/index.js";
import { SqlScheduledTaskRepository } from "../packages/db/dist/index.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Use a disposable loopback database");
const pool = new Pool({ connectionString: url.href, max: 16 });
const sql = new PgSqlExecutor(pool), database = new CloudDatabaseService(sql);
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const turns = new DurableTurnService(database, true);
const handoffs = new BrowserHandoffService(database, { BERRYCRAWL_API_KEY: "test-browser-secret" });
const schedules = new SqlScheduledTaskRepository(sql);
const runtime = DurableTurnRuntimeRequestSchema.parse({
  capabilityVersion: 1, input: "Complete the report after human login", providerId: "test",
  provider: { id: "test", name: "Test model", kind: "berry-router", baseUrl: "https://model.invalid/v1", defaultModel: "test", apiType: "openai-chat-completions", authType: "none" },
  model: "test", conversationKind: "chat", workspacePath: "/workspace", workspaceId,
  permissionMode: "full-access", reasoning: "off", maxTokens: 1000, contextWindowTokens: 32000,
  modelAcceptsImages: false, builtInTools: [],
  mcpServers: [{ id: "berrycrawl", name: "BerryCrawl", transport: "streamable-http", url: "https://api.berrycrawl.com/api/v1/mcp", credentialRef: "env:BERRYCRAWL_API_KEY" }],
});
let remoteStatus = 200, remoteCalls = [], human = false, remoteEnvelope = "wrapped";
const reply = (data) => Response.json(remoteEnvelope === "raw" ? data : { success: remoteEnvelope !== "failed", data: remoteEnvelope === "invalid" ? [] : data });
const realFetch = globalThis.fetch;
globalThis.fetch = async (target, init) => {
  const address = new URL(target); assert.equal(address.origin, "https://api.berrycrawl.com");
  assert.equal(init.headers.authorization, "Bearer test-browser-secret");
  remoteCalls.push({ url: address.pathname, body: JSON.parse(init.body) });
  const status = human ? 423 : remoteStatus;
  if (status !== 200) return Response.json({ code: status === 423 ? "SESSION_UNDER_HUMAN_CONTROL" : "SESSION_EXPIRED" }, { status });
  if (address.pathname.endsWith("/tokens")) {
    const body = JSON.parse(init.body), id = address.pathname.split("/").at(-2);
    return reply({ url: `https://api.berrycrawl.com/api/v1/browser/sessions/${id}/live?${body.scope === "live_control" ? "controlToken" : "viewToken"}=test-scoped-secret`, scope: body.scope, expires_at: new Date(Date.now() + 120000).toISOString() });
  }
  return reply({ results: [{ ok: true, result: { snapshot: "Logged in. Report is ready. [ref=e1]" } }], page: { url: "https://example.invalid/report" }, tabs: [{ tab_id: "tab_1", active: true }], blocked: null });
};
const browser = (id = "bses_test") => ({ sessionId: id, serverId: "berrycrawl", expiresAt: new Date(Date.now() + 600000).toISOString(), closed: false });
async function makeRun(existing) {
  let sessionId = existing?.sessionId, taskId;
  if (!sessionId) {
    taskId = randomUUID(); sessionId = randomUUID();
    await query("INSERT INTO tasks(id,tenant_id,user_id,workspace_id,title) VALUES($1,$2,$3,$4,'Browser handoff')", [taskId, tenantId, userId, workspaceId]);
    await query("INSERT INTO sessions(id,tenant_id,user_id,task_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, userId, taskId]);
  } else taskId = (await query("SELECT task_id FROM sessions WHERE id=$1", [sessionId]))[0].task_id;
  const admitted = await turns.admit({ tenantId, userId, workspaceId, taskId, sessionId, requestId: randomUUID(), operationFingerprint: "a".repeat(64), input: runtime.input, runtimeRequest: runtime, groundingContext: {}, budgetReservationRequired: false });
  const runId = admitted.runId;
  await query("UPDATE turn_runs SET state='executing_tool' WHERE id=$1", [runId]);
  await query("UPDATE turn_steps SET state='completed' WHERE run_id=$1", [runId]);
  await query("INSERT INTO turn_steps(tenant_id,run_id,sequence,step_type,state,input,output,retry_class) VALUES($1,$2,2,'tool.mcp__BerryCrawl__berrycrawl_browser_open','completed',$3,$4,'non_idempotent_manual')", [tenantId, runId, JSON.stringify({ toolName: "mcp__BerryCrawl__berrycrawl_browser_open", toolCallId: randomUUID(), arguments: { url: "https://example.invalid" } }), JSON.stringify({ _berryBrowserSession: browser() })]);
  return { sessionId, runId, taskId };
}
async function planned(run, name = "mcp__BerryCrawl__berrycrawl_browser_click", seq = 3) {
  const stepId = randomUUID(), callId = randomUUID();
  await query("INSERT INTO turn_steps(id,tenant_id,run_id,sequence,step_type,state,input,retry_class) VALUES($1,$2,$3,$4,$5,'pending',$6,'non_idempotent_manual')", [stepId, tenantId, run.runId, seq, `tool.${name}`, JSON.stringify({ toolCallId: callId, toolName: name, arguments: name === "request_browser_handoff" ? { session_id: "bses_test", reason: "Complete the login" } : { session_id: "bses_test", ref: "stale-ref" } })]);
  await query("INSERT INTO tool_calls(id,tenant_id,session_id,run_id,step_id,tool_name,input,status,retry_class) VALUES($1,$2,$3,$4,$5,$6,$7,'pending','non_idempotent_manual')", [callId, tenantId, run.sessionId, run.runId, stepId, name, JSON.stringify({ session_id: "bses_test", ref: "stale-ref" })]);
  return { stepId, callId };
}
let passed = 0;
async function test(name, fn) { remoteStatus = 200; human = false; remoteEnvelope = "wrapped"; remoteCalls = []; await fn(); passed++; console.log(`PASS ${name}`); }
try {
  await database.migrate();
  await query("INSERT INTO tenants(id,name,slug) VALUES($1::uuid,'Browser handoff tests',$1::text)", [tenantId]);
  await query("INSERT INTO users(id,email,name) VALUES($1,$2,'Browser Tester')", [userId, `${userId}@handoff.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Browser tests',$1::text)", [workspaceId, tenantId, userId]);
  await test("owner receipt and control credentials cannot cross users, chats or pending pauses", async () => {
    const run = await makeRun();
    await assert.rejects(() => handoffs.state(tenantId, randomUUID(), run.sessionId), /Chat not found/);
    await assert.rejects(() => handoffs.connection(tenantId, userId, run.sessionId, "bses_other_user", false), /Browser not found/);
    await assert.rejects(() => handoffs.connection(tenantId, userId, run.sessionId, "bses_test", true), /has not paused/);
    const view = await handoffs.connection(tenantId, userId, run.sessionId, "bses_test", false); assert(view.url.startsWith("wss://api.berrycrawl.com/"));
    const state = await handoffs.request(tenantId, userId, run.sessionId, "bses_test"); assert.equal(state.handoff.state, "ready");
    const connection = await handoffs.connection(tenantId, userId, run.sessionId, "bses_test", true); assert(connection.url.includes("controlToken="));
    assert(!JSON.stringify(await turns.state(tenantId, run.sessionId)).includes("test-scoped-secret"));
  });
  await test("provider response envelopes preserve control and fail closed on invalid or failed data", async () => {
    const run = await makeRun();
    remoteEnvelope = "raw";
    assert((await handoffs.connection(tenantId, userId, run.sessionId, "bses_test", false)).url.startsWith("wss://api.berrycrawl.com/"));
    for (const mode of ["invalid", "failed"]) {
      remoteEnvelope = mode;
      await assert.rejects(() => handoffs.connection(tenantId, userId, run.sessionId, "bses_test", false), /Invalid browser response/);
    }
    remoteEnvelope = "wrapped";
    const pause = await handoffs.request(tenantId, userId, run.sessionId, "bses_test");
    for (const mode of ["invalid", "failed"]) {
      remoteEnvelope = mode;
      await assert.rejects(() => handoffs.resume(tenantId, userId, run.sessionId, "bses_test", pause.handoff.id), /Invalid browser response/);
      assert.equal((await handoffs.state(tenantId, userId, run.sessionId)).handoff.state, "ready");
    }
  });
  await test("concurrent pause requests are idempotent; refresh and process restart retain the checkpoint", async () => {
    const run = await makeRun();
    const states = await Promise.all(Array.from({ length: 8 }, () => handoffs.request(tenantId, userId, run.sessionId, "bses_test")));
    assert.equal(new Set(states.map((s) => s.handoff.id)).size, 1);
    const restarted = new BrowserHandoffService(database, { BERRYCRAWL_API_KEY: "test-browser-secret" });
    assert.equal((await restarted.state(tenantId, userId, run.sessionId)).handoff.state, "ready");
    assert.equal((await turns.state(tenantId, run.sessionId)).waitingReason, "browser_handoff");
    assert.equal((await query("SELECT count(*)::int AS n FROM turn_events WHERE run_id=$1 AND event_type='browser.handoff'", [run.runId]))[0].n, 1);
  });
  await test("a leased operation completes before pause; no action starts under human control", async () => {
    const run = await makeRun();
    const repository = new SqlDurableTurnRepository(sql);
    const snapshot = await repository.claim({ tenantId, runId: run.runId }, "active-worker", 90);
    const pause = await handoffs.request(tenantId, userId, run.sessionId, "bses_test"); assert.equal(pause.handoff.state, "requested");
    await repository.commit(snapshot, { expectedState: "executing_tool", nextState: "executing_tool", keepLease: true });
    assert.equal((await handoffs.state(tenantId, userId, run.sessionId)).handoff.state, "requested");
    await repository.commit(snapshot, { expectedState: "executing_tool", nextState: "calling_model", outbox: [{ eventType: "turn.resume", dedupeKey: "must-not-run-during-control", payload: { tenantId, runId: run.runId } }] });
    assert.equal((await handoffs.state(tenantId, userId, run.sessionId)).handoff.state, "ready");
    assert.equal((await turns.state(tenantId, run.sessionId)).bufferedEvents.filter((event) => event.kind === "browser.handoff" && event.state === "ready").length, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM runtime_outbox WHERE dedupe_key='must-not-run-during-control'"))[0].n, 0);
    let executed = 0;
    const runner = new DurableTurnRunner(repository, { call: async () => { executed++; throw new Error("Must remain paused"); } }, { execute: async () => { executed++; throw new Error("Must remain paused"); } });
    assert.equal((await runner.execute({ tenantId, runId: run.runId })).state, "waiting"); assert.equal(executed, 0);
  });
  await test("an approval or question wins a pending takeover race without issuing control", async () => {
    const run = await makeRun(), repository = new SqlDurableTurnRepository(sql);
    const snapshot = await repository.claim({ tenantId, runId: run.runId }, "approval-worker", 90);
    await handoffs.request(tenantId, userId, run.sessionId, "bses_test");
    await repository.commit(snapshot, { expectedState: "executing_tool", nextState: "waiting", waitingReason: "approval" });
    assert.equal((await handoffs.state(tenantId, userId, run.sessionId)).handoff, null);
    await assert.rejects(() => handoffs.connection(tenantId, userId, run.sessionId, "bses_test", true), /has not paused/);
    assert.equal((await turns.state(tenantId, run.sessionId)).waitingReason, "approval");
  });
  await test("return refuses active human control; one resume replans, cancels stale tools and preserves journal integrity", async () => {
    const run = await makeRun(), tool = await planned(run);
    const pause = await handoffs.request(tenantId, userId, run.sessionId, "bses_test");
    human = true;
    await assert.rejects(() => handoffs.resume(tenantId, userId, run.sessionId, "bses_test", pause.handoff.id), /Release browser control/);
    assert.equal((await turns.state(tenantId, run.sessionId)).runState, "waiting");
    human = false;
    await Promise.all(Array.from({ length: 5 }, () => handoffs.resume(tenantId, userId, run.sessionId, "bses_test", pause.handoff.id)));
    assert.equal((await query("SELECT state FROM turn_steps WHERE id=$1", [tool.stepId]))[0].state, "cancelled");
    assert.equal((await query("SELECT count(*)::int AS n FROM runtime_outbox WHERE dedupe_key=$1", [`${run.runId}:browser-return:${pause.handoff.id}`]))[0].n, 1);
    assert.equal((await query("SELECT count(*)::int AS n FROM turn_steps WHERE run_id=$1 AND step_type='model.call' AND state='pending'", [run.runId]))[0].n, 1);
    const restored = await new SqlDurableTurnRepository(sql).claim({ tenantId, runId: run.runId }, "resumed-worker", 90);
    const context = JSON.stringify(modelMessages(restored).messages);
    assert(context.includes("Logged in. Report is ready")); assert(context.includes("stale")); assert(!context.includes("test-browser-secret")); assert(!context.includes("test-scoped-secret"));
    assert.equal((await turns.state(tenantId, run.sessionId)).bufferedEvents.some((event) => event.kind === "tool.end" && event.toolCallId === tool.callId), true);
    assert.equal((await turns.state(tenantId, run.sessionId)).bufferedEvents.filter((event) => event.kind === "browser.handoff" && event.state === "resumed").length, 1);
  });
  await test("browser expiry does not wedge the run; explicit return tells the agent to recover", async () => {
    const run = await makeRun(), pause = await handoffs.request(tenantId, userId, run.sessionId, "bses_test");
    remoteStatus = 410;
    assert.equal((await handoffs.resume(tenantId, userId, run.sessionId, "bses_test", pause.handoff.id)).handoff.state, "resumed");
    const entries = await query("SELECT payload FROM session_entries WHERE run_id=$1", [run.runId]); assert(JSON.stringify(entries).includes("browserEnded"));
  });
  await test("a transient browser failure keeps the checkpoint and cancellation prevents resume", async () => {
    const run = await makeRun(), pause = await handoffs.request(tenantId, userId, run.sessionId, "bses_test");
    remoteStatus = 503;
    await assert.rejects(() => handoffs.resume(tenantId, userId, run.sessionId, "bses_test", pause.handoff.id), /remains paused/);
    await turns.cancel(tenantId, run.sessionId);
    remoteStatus = 200;
    await assert.rejects(() => handoffs.resume(tenantId, userId, run.sessionId, "bses_test", pause.handoff.id), /has ended/);
  });
  await test("agent-requested takeover pauses an Automation and suppresses overlapping runs", async () => {
    const scope = { tenantId, userId };
    const schedule = await schedules.create(scope, { operationId: randomUUID(), workspaceId, name: "Login report", prompt: runtime.input, schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" } });
    const automation = await schedules.runNow(scope, schedule.id, randomUUID());
    const claims = await schedules.claimPending(tenantId, "automation-dispatch");
    const claimed = claims.find((item) => item.id === automation.id); assert(claimed);
    const run = await makeRun(claimed); await schedules.admitted(tenantId, automation.id, "automation-dispatch", run.runId);
    await query("UPDATE turn_runs SET state='calling_model' WHERE id=$1", [run.runId]);
    await query("INSERT INTO turn_steps(tenant_id,run_id,sequence,step_type,state,input,retry_class,idempotency_key) VALUES($1,$2,3,'model.call','pending',$3,'idempotent_with_key',$4)", [tenantId, run.runId, JSON.stringify({ iteration: 1 }), `${run.runId}:model:1`]);
    const runner = new DurableTurnRunner(new SqlDurableTurnRepository(sql), {
      call: async () => ({ text: "Please complete the login in the browser.", inputTokens: 10, outputTokens: 8,
        toolCalls: [{ id: randomUUID(), name: "request_browser_handoff", input: { session_id: "bses_test", reason: "Complete the login" }, retryClass: "read_only", idempotencyKey: null, requiresApproval: false, approvalKind: "browser" }],
      }),
    }, { definitions: async () => [{ type: "function", function: { name: "request_browser_handoff", parameters: { type: "object", properties: { session_id: { type: "string" }, reason: { type: "string" } }, required: ["session_id", "reason"] } } }], execute: async () => { throw new Error("Unexpected tool execution"); } });
    assert.equal((await runner.execute({ tenantId, runId: run.runId })).state, "executing_tool");
    assert.equal((await runner.execute({ tenantId, runId: run.runId })).state, "waiting");
    const request = { stepId: (await query("SELECT id FROM turn_steps WHERE run_id=$1 AND step_type='tool.request_browser_handoff'", [run.runId]))[0].id };
    const state = await handoffs.state(tenantId, userId, run.sessionId); assert.equal(state.handoff.requestedBy, "agent");
    assert.equal((await schedules.history(scope, schedule.id))[0].waitingReason, "browser_handoff");
    await assert.rejects(() => schedules.runNow(scope, schedule.id, randomUUID()), /in progress/);
    await handoffs.resume(tenantId, userId, run.sessionId, "bses_test", state.handoff.id);
    assert.equal((await query("SELECT state FROM turn_steps WHERE id=$1", [request.stepId]))[0].state, "completed");
    let continued = false;
    const resumedRunner = new DurableTurnRunner(new SqlDurableTurnRepository(sql), {
      call: async (snapshot) => {
        const transcript = JSON.stringify(modelMessages(snapshot).messages);
        assert(transcript.includes("Logged in. Report is ready"));
        assert.equal(snapshot.id, run.runId); assert.equal(snapshot.sessionId, run.sessionId);
        continued = true;
        return { text: "Completed the automation after your login.", inputTokens: 10, outputTokens: 8, toolCalls: [] };
      },
    }, { execute: async () => { throw new Error("A queued browser click must never be replayed"); } });
    for (let phase = 0; phase < 6; phase++) {
      const result = await resumedRunner.execute({ tenantId, runId: run.runId });
      if (result.state === "completed") break;
      assert(!["failed", "cancelled", "recovery_required", "waiting"].includes(result.state));
    }
    assert(continued); assert.equal((await schedules.history(scope, schedule.id))[0].turnState, "completed");
    await schedules.remove(scope, schedule.id);
  });
  console.log(`${passed} browser handoff integration checks passed`);
} finally {
  globalThis.fetch = realFetch;
  await pool.end();
}
