#!/usr/bin/env node
// A change-making tool call whose response was lost must never be replayed
// automatically (H-003, H-014). Exercises the real runner and journal SQL.
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-uncertain-mutation-recovery.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DurableTurnRuntimeRequestSchema } from "../packages/shared/dist/index.js";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { McpToolSource } from "../packages/local-agent/dist/mcp.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SandboxContinuityManager } from "../apps/worker/dist/sandbox-continuity.js";
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
const CREATE = "mcp__Connect_Aesg_MCP__create_record";

async function fixture() {
  const taskId = randomUUID(), sessionId = randomUUID();
  await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Create Tender A')", [taskId, tenantId, workspaceId, userId]);
  await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);
  await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2", [sessionId, taskId]);
  return { taskId, sessionId };
}
const admit = (f, extra = {}) => turns.admit({
  tenantId, userId, workspaceId, ...f, requestId: randomUUID(), operationFingerprint: randomUUID(),
  input: "Create Tender A", runtimeRequest: { input: "Create Tender A" }, groundingContext: {}, budgetReservationRequired: false, ...extra,
});
const intent = (name, input, retryClass) => ({
  id: randomUUID(), name, input, retryClass, repeatPolicy: retryClass === "read_only" ? "compare_result" : "block_after_success",
  idempotencyKey: null, requiresApproval: false, approvalKind: name.startsWith("mcp__") ? "mcp" : "file-edit",
});
/** Model call n asks for `script[n - 1]`, then answers. */
function model(script) {
  let calls = 0;
  return {
    calls: () => calls,
    call: async () => {
      const next = script[calls];
      calls += 1;
      return { text: next ? "" : "Done.", inputTokens: 10, outputTokens: 5, toolCalls: next ? [intent(...next)] : [] };
    },
  };
}
/** The connector accepts every write; `fail(n)` decides what Berry hears back for write n. */
function connector(fail = () => null) {
  const target = {
    writes: [],
    execute: async (_snapshot, step) => {
      const name = step.input.toolName;
      if (name === CREATE) {
        target.writes.push(step.input.arguments);
        const error = fail(target.writes.length);
        if (error) throw error;
      }
      return { output: { ok: true }, summary: `Completed ${name}` };
    },
  };
  return target;
}
async function drive(runner, runId, reason = "continue") {
  let result;
  for (let i = 0; i < 25; i += 1) {
    result = await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason }));
    if (result.noOp || ["completed", "failed", "cancelled", "recovery_required"].includes(result.state)) return result.state;
  }
  throw new Error("Run did not settle");
}
const toolSteps = (runId) => query(
  "SELECT id,step_type,state,outcome_certainty,output,error FROM turn_steps WHERE run_id=$1 AND step_type LIKE 'tool.%' ORDER BY sequence",
  [runId],
);
const run = async (runId) => (await query("SELECT state,error,recovery_step_id,recovery_tool_call_id FROM turn_runs WHERE id=$1", [runId]))[0];
/** A run whose first write was applied by the connector but whose response Berry lost. */
async function uncertainWrite(lose, between = [["ls", { path: "/workspace" }, "read_only"]]) {
  const f = await fixture();
  const { runId } = await admit(f);
  const target = connector((write) => write === 1 ? lose() : null);
  const script = [[CREATE, { title: "Tender A" }, "non_idempotent_manual"], ...between, [CREATE, { title: "Tender A" }, "non_idempotent_manual"]];
  const runner = new DurableTurnRunner(repository, model(script), target, { owner: "uncertain-write-first" });
  const state = await drive(runner, runId);
  return { f, runId, target, state };
}
const reserveNothing = async () => true;
/** Rewrites the run's failed write into the shape older workers stored and reopens the run. */
async function legacyShape(affected, error) {
  const [step] = await toolSteps(affected.runId);
  await query("UPDATE turn_steps SET state='failed',output=NULL,outcome_certainty=NULL,error=$2 WHERE id=$1", [step.id, `Tool failed (repair attempt 1/5). ${error}`]);
  await query("UPDATE turn_runs SET state='calling_model',error=NULL,recovery_step_id=NULL,recovery_tool_call_id=NULL,completed_at=NULL,cancelled_at=NULL,version=version+1 WHERE id=$1", [affected.runId]);
  await query("UPDATE tasks SET status='running' WHERE id=$1", [affected.f.taskId]);
  await query(
    "INSERT INTO turn_steps(tenant_id,run_id,sequence,step_type,state,input,retry_class,idempotency_key) SELECT $1::uuid,$2::uuid,MAX(sequence)+1,'model.call','pending','{\"iteration\":2}'::jsonb,'idempotent_with_key',$2::text||':model:2:legacy' FROM turn_steps WHERE run_id=$2::uuid",
    [tenantId, affected.runId],
  );
}
/** A loopback endpoint that counts the POSTs it accepted; `delay(path, n)` holds the nth response for that many ms. */
async function endpoint(delay) {
  const accepted = { create: 0, notify: 0 };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = request.url === "/notify" ? "notify" : "create";
      accepted[path] += 1;
      const ms = delay(path, accepted[path]);
      if (ms) setTimeout(() => response.end(path), ms).unref();
      else response.end(path);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    accepted,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
const exec = promisify(execFile);
/** Runs a bash call in a real local shell and reports a failure the way the sandbox does. */
const shell = {
  execute: async (_snapshot, step) => {
    try {
      const { stdout } = await exec("/bin/sh", ["-c", step.input.arguments.command]);
      return { output: { exitCode: 0, output: stdout }, summary: "Command completed with exit code 0" };
    } catch (error) {
      throw new Error(`${`${error.stdout ?? ""}${error.stderr ?? ""}`.trim()}\n\nCommand exited with code ${error.code}`);
    }
  },
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Uncertain mutation tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@uncertain.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Uncertain mutation tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("a lost response stops for recovery and an unrelated listing cannot unlock a replay", async () => {
    const { runId, target, state } = await uncertainWrite(() => new Error("socket hang up"));
    assert.equal(target.writes.length, 1, "The connector applied the first write; listing the workspace cannot show that it failed");
    assert.equal(state, "recovery_required");
    const steps = await toolSteps(runId);
    assert.deepEqual(steps.map((step) => [step.step_type, step.state, step.outcome_certainty]), [[`tool.${CREATE}`, "recovery_required", "unknown"]]);
    assert.equal(steps[0].output?.failure?.category, "unknown_outcome");
    const current = await run(runId);
    assert.equal(current.state, "recovery_required");
    assert.equal(current.error, "ambiguous_external_operation");
    assert.equal(current.recovery_step_id, steps[0].id);
    assert.ok(current.recovery_tool_call_id, "Operator recovery needs the exact tool call");
  });

  await test("a failed read in between cannot unlock a replay either", async () => {
    const { target, state } = await uncertainWrite(() => new Error("socket hang up"), [["read", { path: "/workspace/missing.md" }, "read_only"]]);
    assert.equal(target.writes.length, 1);
    assert.equal(state, "recovery_required");
  });

  await test("a server error after the connector accepted the write is an unknown outcome", async () => {
    const { target, state } = await uncertainWrite(() => Object.assign(new Error("Service Unavailable"), { status: 503 }));
    assert.equal(target.writes.length, 1);
    assert.equal(state, "recovery_required");
  });

  await test("a restarted worker, a lease recovery and Continue do not replay it", async () => {
    const { f, runId, target } = await uncertainWrite(() => new Error("socket hang up"));
    for (const reason of ["continue", "lease-recovery"]) {
      const restarted = new DurableTurnRunner(repository, model([[CREATE, { title: "Tender A" }, "non_idempotent_manual"]]), target, { owner: `uncertain-write-${reason}` });
      await drive(restarted, runId, reason);
    }
    await assert.rejects(() => admit(f, { continueInterruptedTurn: true }), /No failed or cancelled durable turn can be continued/);
    assert.equal(target.writes.length, 1);
    assert.equal((await run(runId)).state, "recovery_required");
    assert.equal((await query("SELECT count(*)::int AS n FROM turn_runs WHERE session_id=$1", [f.sessionId]))[0].n, 1);
  });

  await test("only an explicit recovery action resolves it", async () => {
    // Mark complete: the operator confirms the write happened; nothing is sent again.
    const confirmed = await uncertainWrite(() => new Error("socket hang up"));
    assert.equal(await turns.recover(tenantId, userId, confirmed.runId, "mark-complete", reserveNothing), true);
    assert.equal(await drive(new DurableTurnRunner(repository, model([]), confirmed.target, { owner: "uncertain-write-confirmed" }), confirmed.runId), "completed");
    assert.equal(confirmed.target.writes.length, 1);
    // Retry: the operator chose to send the same write once more.
    const retried = await uncertainWrite(() => new Error("socket hang up"));
    assert.equal(await turns.recover(tenantId, userId, retried.runId, "retry", reserveNothing), true);
    assert.equal(await drive(new DurableTurnRunner(repository, model([]), retried.target, { owner: "uncertain-write-retried" }), retried.runId), "completed");
    assert.equal(retried.target.writes.length, 2);
  });

  await test("a write the connector rejected stays repairable", async () => {
    const f = await fixture();
    const { runId } = await admit(f);
    const target = connector((write) => write === 1 ? Object.assign(new Error("A record with this title already exists"), { status: 409 }) : null);
    const runner = new DurableTurnRunner(repository, model([
      [CREATE, { title: "Tender A" }, "non_idempotent_manual"],
      [CREATE, { title: "Tender A (2)" }, "non_idempotent_manual"],
    ]), target, { owner: "rejected-write" });
    assert.equal(await drive(runner, runId), "completed");
    assert.equal(target.writes.length, 2);
    const steps = await toolSteps(runId);
    assert.deepEqual(steps.map((step) => step.state), ["failed", "completed"]);
    assert.equal(steps[0].output?.failure?.category, "invalid_input");
  });

  await test("a finished curl that gave up waiting for an accepted POST stops for recovery", async () => {
    const server = await endpoint((_path, n) => n === 1 ? 400 : 0);
    try {
      const f = await fixture();
      const { runId } = await admit(f);
      const command = `curl --silent --show-error --max-time 0.1 -X POST ${server.base}/create -d title=TenderA`;
      const bash = ["bash", { command }, "non_idempotent_manual"];
      const state = await drive(new DurableTurnRunner(repository, model([bash, bash]), shell, { owner: "curl-lost-response" }), runId);
      assert.equal(server.accepted.create, 1, "The server accepted the POST that curl stopped waiting for");
      assert.equal(state, "recovery_required");
      assert.equal((await toolSteps(runId))[0].outcome_certainty, "unknown");
    } finally {
      await server.close();
    }
  });

  await test("a compound command whose later request loses its response is not run again", async () => {
    const server = await endpoint((path) => path === "notify" ? 400 : 0);
    try {
      const f = await fixture();
      const { runId } = await admit(f);
      const command = `curl --silent --show-error -X POST ${server.base}/create -d title=TenderA && curl --silent --show-error --max-time 0.1 -X POST ${server.base}/notify`;
      const bash = ["bash", { command }, "non_idempotent_manual"];
      const state = await drive(new DurableTurnRunner(repository, model([bash, bash]), shell, { owner: "compound-lost-response" }), runId);
      assert.equal(server.accepted.create, 1, "The first request of the command was accepted before the later one failed");
      assert.equal(state, "recovery_required");
    } finally {
      await server.close();
    }
  });

  await test("a write an older worker recorded without a failure class is held, and an explicit retry runs it once", async () => {
    const affected = await uncertainWrite(() => new Error("socket hang up"));
    await legacyShape(affected, "socket hang up");
    const resumed = new DurableTurnRunner(repository, model([[CREATE, { title: "Tender A", note: "again" }, "non_idempotent_manual"]]), affected.target, { owner: "legacy-journal" });
    assert.equal(await drive(resumed, affected.runId), "recovery_required");
    assert.equal(affected.target.writes.length, 1, "Missing failure metadata does not show that the first write was rejected");
    const current = await run(affected.runId);
    assert.equal(current.error, "ambiguous_external_operation");
    assert.ok(current.recovery_tool_call_id, "The held call can be resolved through operator recovery");
    await drive(new DurableTurnRunner(repository, model([]), affected.target, { owner: "legacy-journal-restart" }), affected.runId);
    assert.equal((await run(affected.runId)).state, "recovery_required");
    assert.equal(affected.target.writes.length, 1, "A restarted worker does not run the held call");
    assert.equal(await turns.recover(tenantId, userId, affected.runId, "retry", reserveNothing), true);
    assert.equal(await drive(new DurableTurnRunner(repository, model([]), affected.target, { owner: "legacy-journal-retry" }), affected.runId), "completed");
    assert.equal(affected.target.writes.length, 2);
  });

  await test("a definite rejection an older worker recorded stays repairable", async () => {
    const affected = await uncertainWrite(() => new Error("socket hang up"));
    await legacyShape(affected, `${CREATE} was not run: title must not be empty`);
    const resumed = new DurableTurnRunner(repository, model([[CREATE, { title: "Tender A" }, "non_idempotent_manual"]]), affected.target, { owner: "legacy-rejection" });
    assert.equal(await drive(resumed, affected.runId), "completed");
    assert.equal(affected.target.writes.length, 2);
  });

  await test("a command that failed after its POST was accepted holds the next shell call", async () => {
    const server = await endpoint(() => 0);
    try {
      const f = await fixture();
      const { runId } = await admit(f);
      const post = `curl --silent --show-error -X POST ${server.base}/create -d title=TenderA`;
      const script = [["bash", { command: `${post} && false` }, "non_idempotent_manual"], ["bash", { command: post }, "non_idempotent_manual"]];
      const state = await drive(new DurableTurnRunner(repository, model(script), shell, { owner: "partial-command" }), runId);
      assert.equal(server.accepted.create, 1, "A failure after the accepted POST does not show that the POST was rejected");
      assert.equal(state, "recovery_required");
      const steps = await toolSteps(runId);
      assert.deepEqual(steps.map((step) => step.state), ["failed", "recovery_required"]);
      assert.equal(steps[0].output?.failure?.outcome, "unknown");
    } finally {
      await server.close();
    }
  });

  /** Adds a completed call of the tool after the old failure, as older workers allowed. */
  async function laterCompletedCall(affected, args) {
    const [pending] = await query("SELECT id,sequence FROM turn_steps WHERE run_id=$1 AND step_type='model.call' AND state='pending'", [affected.runId]);
    await query("UPDATE turn_steps SET sequence=sequence+1 WHERE id=$1", [pending.id]);
    await query(
      "INSERT INTO turn_steps(tenant_id,run_id,sequence,step_type,state,input,output,retry_class,attempt,completed_at) VALUES ($1,$2,$3,$4,'completed',$5::jsonb,$6::jsonb,'non_idempotent_manual',1,now())",
      [tenantId, affected.runId, pending.sequence, `tool.${CREATE}`, JSON.stringify({ toolName: CREATE, toolCallId: randomUUID(), arguments: args }), JSON.stringify({ ok: true })],
    );
    affected.target.writes.push(args);
  }

  await test("an unrelated completed call of the same tool does not resolve an uncertain write", async () => {
    const affected = await uncertainWrite(() => new Error("socket hang up"));
    await legacyShape(affected, "socket hang up");
    await laterCompletedCall(affected, { title: "Tender B" });
    const resumed = new DurableTurnRunner(repository, model([[CREATE, { title: "Tender A" }, "non_idempotent_manual"]]), affected.target, { owner: "unrelated-success" });
    assert.equal(await drive(resumed, affected.runId), "recovery_required");
    assert.deepEqual(affected.target.writes.map((write) => write.title), ["Tender A", "Tender B"], "Creating Tender B does not show whether Tender A was created");
  });

  await test("the operator's decision on the held call resolves the uncertain write", async () => {
    const affected = await uncertainWrite(() => new Error("socket hang up"));
    await legacyShape(affected, "socket hang up");
    await laterCompletedCall(affected, { title: "Tender B" });
    const resumed = new DurableTurnRunner(repository, model([[CREATE, { title: "Tender A" }, "non_idempotent_manual"]]), affected.target, { owner: "held-for-decision" });
    assert.equal(await drive(resumed, affected.runId), "recovery_required");
    // The operator confirms Tender A exists; the next, different create runs.
    assert.equal(await turns.recover(tenantId, userId, affected.runId, "mark-complete", reserveNothing), true);
    const continued = new DurableTurnRunner(repository, model([[CREATE, { title: "Tender C" }, "non_idempotent_manual"]]), affected.target, { owner: "after-decision" });
    assert.equal(await drive(continued, affected.runId), "completed");
    assert.deepEqual(affected.target.writes.map((write) => write.title), ["Tender A", "Tender B", "Tender C"]);
  });

  await test("a create whose result the MCP SDK rejected after the server ran it is not repeated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "berry-records-"));
    const writes = join(directory, "writes.jsonl");
    const source = new McpToolSource({ servers: [{
      id: "records", name: "Connect_Aesg_MCP", transport: "stdio", command: process.execPath,
      args: [new URL("../packages/local-agent/test/fixtures/mcp-records-server.mjs", import.meta.url).pathname],
      url: null, env: { RECORD_OUTPUT: "malformed", RECORD_WRITES: writes }, enabled: true, trusted: true,
    }] });
    try {
      await source.connect();
      const tool = source.listTools().find((candidate) => candidate.name === CREATE);
      assert.ok(tool, "The real SDK discovered the create tool");
      const target = { execute: async (_snapshot, step) => ({ output: { content: (await tool.execute(step.input.toolCallId, step.input.arguments)).content }, summary: "Created" }) };
      const f = await fixture();
      const { runId } = await admit(f);
      const state = await drive(new DurableTurnRunner(repository, model([
        [CREATE, { title: "Tender A" }, "non_idempotent_manual"],
        [CREATE, { title: "Tender A", note: "with the expected output" }, "non_idempotent_manual"],
      ]), target, { owner: "mcp-output-schema" }), runId);
      assert.equal(readFileSync(writes, "utf8").trim().split("\n").length, 1, "The server created the record before the SDK rejected its result");
      assert.equal(state, "recovery_required");
      assert.equal((await toolSteps(runId))[0].output?.failure?.outcome, "unknown");
    } finally {
      await source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await test("a command failure an older classifier stored as not applied is not proof the POST failed", async () => {
    const server = await endpoint(() => 0);
    try {
      const f = await fixture();
      const { runId } = await admit(f);
      const post = `curl --silent --show-error -X POST ${server.base}/create -d title=TenderA`;
      const runner = new DurableTurnRunner(repository, model([
        ["bash", { command: `${post} && false` }, "non_idempotent_manual"],
        ["bash", { command: post }, "non_idempotent_manual"],
      ]), shell, { owner: "historical-typed" });
      for (let i = 0; i < 8 && (await toolSteps(runId))[0]?.state !== "failed"; i += 1) {
        await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason: "continue" }));
      }
      // What 9f0139f's classifier stored for this failure.
      const [first] = await toolSteps(runId);
      const stored = { category: "unknown", deterministic: false, outcome: "not_applied", action: "Read the error, change the approach or the arguments, and do not repeat the same call unchanged." };
      await query("UPDATE turn_steps SET output=$2::jsonb,outcome_certainty=NULL WHERE id=$1", [first.id, JSON.stringify({ failure: stored })]);
      assert.equal(await drive(runner, runId), "recovery_required");
      assert.equal(server.accepted.create, 1, "A stored older classification does not show that the accepted POST failed");
    } finally {
      await server.close();
    }
  });

  for (const [code, status, rpcCode] of [["RATE_LIMIT", "", ""], ["ECONNREFUSED", "", ""], ["RATE_LIMIT", "429", ""], ["CONFLICT", "409", ""], ["CONFLICT", "", "409"]]) {
    await test(`a create whose error result reported ${code}/${status}/${rpcCode} after the server saved it is not repeated, even after a restart`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "berry-records-"));
      const writes = join(directory, "writes.jsonl");
      const source = new McpToolSource({ servers: [{
        id: "records", name: "Connect_Aesg_MCP", transport: "stdio", command: process.execPath,
        args: [new URL("../packages/local-agent/test/fixtures/mcp-records-server.mjs", import.meta.url).pathname],
        url: null, env: { RECORD_ERROR_CODE: code, RECORD_ERROR_STATUS: status, RECORD_RPC_CODE: rpcCode, RECORD_WRITES: writes }, enabled: true, trusted: true,
      }] });
      try {
        await source.connect();
        const tool = source.listTools().find((candidate) => candidate.name === CREATE);
        assert.ok(tool, "The real SDK discovered the create tool");
        const target = { execute: async (_snapshot, step) => step.input.toolName === CREATE
          ? { output: { content: (await tool.execute(step.input.toolCallId, step.input.arguments)).content }, summary: "Created" }
          : { output: { ok: true }, summary: "Listed" } };
        const f = await fixture();
        const { runId } = await admit(f);
        const script = [
          [CREATE, { title: "Tender A" }, "non_idempotent_manual"],
          ["ls", { path: "/workspace" }, "read_only"],
          [CREATE, { title: "Tender A", note: "retry after indexing error" }, "non_idempotent_manual"],
        ];
        const state = await drive(new DurableTurnRunner(repository, model(script), target, { owner: `mcp-${code}` }), runId);
        assert.equal(readFileSync(writes, "utf8").trim().split("\n").length, 1, "The server saved the record before its index update failed");
        assert.equal(state, "recovery_required");
        const restarted = new DurableTurnRunner(repository, model(script.slice(1)), target, { owner: `mcp-${code}-restarted` });
        await drive(restarted, runId);
        assert.equal(readFileSync(writes, "utf8").trim().split("\n").length, 1);
        assert.equal((await run(runId)).state, "recovery_required");
        assert.equal((await toolSteps(runId))[0].output?.failure?.outcome, "unknown");
      } finally {
        await source.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  await test("a network hint after an accepted POST holds the next command, and an explicit retry runs it once", async () => {
    const server = await endpoint(() => 0);
    const workspace = mkdtempSync(join(tmpdir(), "berry-shell-"));
    try {
      // Runs the sandbox's real command, wrapper script included, in a local directory.
      const provider = {
        kind: "e2b",
        supportsResume: false,
        exec: async function* (input) {
          try {
            const { stdout, stderr } = await exec(input.command[0], input.command.slice(1), { cwd: workspace, timeout: 5_000 });
            if (stdout) yield { kind: "stdout", data: stdout };
            if (stderr) yield { kind: "stderr", data: stderr };
            yield { kind: "exit", exit_code: 0, signal: null };
          } catch (error) {
            if (error.stdout) yield { kind: "stdout", data: error.stdout };
            if (error.stderr) yield { kind: "stderr", data: error.stderr };
            yield { kind: "exit", exit_code: typeof error.code === "number" ? error.code : 1, signal: null };
          }
        },
        files: { list: async (input) => ({ path: input.path, entries: [] }) },
      };
      const manager = new SandboxContinuityManager(provider, { recordSandbox: async () => {}, recordTiming: async () => {} }, null, { image: "berry-sandbox", cwd: workspace });
      const target = { execute: async (snapshot, step) => manager.execute({
        ...snapshot, sandboxId: "local", sandboxProvider: "e2b", sandboxState: "running",
        runtimeRequest: { ...snapshot.runtimeRequest, networkPolicy: { egress: "on", allowedDomains: ["127.0.0.1"] } },
      }, step) };
      const f = await fixture();
      const { runId } = await admit(f);
      const post = `curl --silent --show-error -X POST ${server.base}/create -d title=TenderA`;
      // TLS to the loopback HTTP endpoint ends curl with exit 35, as a blocked host does; localhost is not allowed.
      const blocked = `${server.base.replace("http://127.0.0.1", "https://localhost")}/notify`;
      const state = await drive(new DurableTurnRunner(repository, model([
        ["bash", { command: `${post} && curl --silent --show-error --max-time 2 ${blocked}` }, "non_idempotent_manual"],
        ["bash", { command: post }, "non_idempotent_manual"],
      ]), target, { owner: "network-hint" }), runId);
      assert.equal(server.accepted.create, 1, "A blocked second URL does not undo the first POST");
      assert.equal(state, "recovery_required");
      const [first] = await toolSteps(runId);
      assert.match(first.error, /Network access to localhost is blocked[\s\S]*Command exited with code 35$/);
      // Continue sends the explicit retry: the held command runs once.
      assert.equal(await turns.recover(tenantId, userId, runId, "retry", reserveNothing), true);
      assert.equal(await drive(new DurableTurnRunner(repository, model([]), target, { owner: "network-hint-retried" }), runId), "completed");
      assert.equal(server.accepted.create, 2);
    } finally {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  for (const typed of [true, false]) {
    await test(`a command failure an older worker stored cut at 4,000 characters ${typed ? "with" : "without"} a class is not proof the POST failed`, async () => {
      const server = await endpoint(() => 0);
      try {
        const f = await fixture();
        const { runId } = await admit(f);
        const post = `curl --silent --show-error -X POST ${server.base}/create -d title=TenderA`;
        const runner = new DurableTurnRunner(repository, model([
          ["bash", { command: `${post} && printf '\\ninvalid schema in post-processing: ' && printf '%05000d' 0 && false` }, "non_idempotent_manual"],
          ["bash", { command: post }, "non_idempotent_manual"],
        ]), shell, { owner: `historical-cut-${typed}` });
        for (let i = 0; i < 8 && (await toolSteps(runId))[0]?.state !== "failed"; i += 1) {
          await sql.runWithTenant(tenantId, () => runner.execute({ tenantId, runId, reason: "continue" }));
        }
        const [first] = await toolSteps(runId);
        assert.ok(!first.error.includes("Command exited with code"), "The runner stores the error cut before its exit status");
        // What 9f0139f's classifier stored for the cut error, or no class at all.
        const stored = { category: "invalid_input", deterministic: true, outcome: "not_applied", action: "The arguments are not valid for this tool. Correct them before calling again; the same call fails the same way." };
        await query("UPDATE turn_steps SET output=$2::jsonb,outcome_certainty=NULL WHERE id=$1", [first.id, typed ? JSON.stringify({ failure: stored }) : null]);
        const state = await drive(runner, runId);
        assert.equal(server.accepted.create, 1, "A cut stored error does not show that the accepted POST failed");
        assert.equal(state, "recovery_required");
        await drive(new DurableTurnRunner(repository, model([]), shell, { owner: `historical-cut-${typed}-restarted` }), runId);
        assert.equal((await run(runId)).state, "recovery_required");
        assert.equal(server.accepted.create, 1);
      } finally {
        await server.close();
      }
    });
  }

  await test("a workspace outage after image generation cannot authorize a second generation",async()=>{
    const sharp=require("sharp");
    const image=await sharp({create:{width:16,height:16,channels:3,background:"purple"}}).png().toBuffer();
    const generations=[];
    const server=createServer((request,response)=>{
      let input="";
      request.on("data",chunk=>input+=chunk);
      request.on("end",()=>{
        generations.push({key:request.headers["idempotency-key"],input:JSON.parse(input)});
        response.writeHead(200,{"content-type":"application/json"});
        response.end(JSON.stringify({data:[{b64_json:image.toString("base64")}]}));
      });
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port;
    let resumes=0;
    const provider={
      kind:"e2b",supportsResume:true,
      resume:async()=>{
        resumes++;
        if(resumes===2||resumes===3)throw new Error("read ECONNRESET");
        return {sandbox_id:"review-image",provider:"e2b",status:"running"};
      },
      files:{
        write:async input=>({path:input.path,size_bytes:Buffer.from(input.content,"base64").length,mtime:null}),
        list:async input=>({path:input.path,entries:[]})
      }
    };
    const manager=new SandboxContinuityManager(provider,{
      recordSandbox:async()=>{},recordTiming:async()=>{},latest:async()=>null,continuity:async()=>null,inputFiles:async()=>[]
    },null,{image:"review-local",resumeRetryDelayMs:0,imageGeneration:{
      endpoint:base+"/images/generations",editsEndpoint:base+"/images/edits",apiKey:"review-only",model:"gpt-image-1",responseFormat:"b64_json"
    }});
    const target={execute:async(snapshot,step)=>{
      if(step.input.toolName!=="create_image")return {output:{ok:true},summary:"Read completed"};
      return manager.execute({...snapshot,sandboxId:"review-image",sandboxProvider:"e2b",sandboxState:"running",runtimeRequest:{
        ...snapshot.runtimeRequest,imageGeneration:{version:1,model:"gpt-image-1"}
      }},step);
    }};
    try{

      const runtimeRequest=DurableTurnRuntimeRequestSchema.parse({
        capabilityVersion:1,providerId:"review",provider:{
          id:"review",name:"Review",kind:"openai-compatible",baseUrl:base,defaultModel:"review",
          apiType:"openai-chat-completions",endpointPath:"/chat/completions",authType:"none",completionTransport:"buffered",models:[]
        },model:"review",workspacePath:"/workspace",workspaceId,permissionMode:"full-access",reasoning:"off",
        maxTokens:1000,contextWindowTokens:128000,modelAcceptsImages:true,builtInTools:["ls","create_image"],
        imageGeneration:{providerId:"review",model:"gpt-image-1",costMicros:"1"}
      });
      const f=await fixture(),{runId}=await admit(f,{runtimeRequest,operationFingerprint:"a".repeat(64)});
      const state=await drive(new DurableTurnRunner(repository,model([
        ["create_image",{prompt:"A berry icon",title:"Berry icon",purpose:"draft"},"non_idempotent_manual"],
        ["ls",{path:"/workspace"},"read_only"],
        ["create_image",{prompt:"A berry icon",title:"Berry icon retry",purpose:"draft"},"non_idempotent_manual"]
      ]),target,{owner:"review-generated-image"}),runId);
      const steps=await toolSteps(runId);
      assert.equal(steps[0].output.failure.outcome, "unknown");
      assert.equal(generations.length,1,"The successful paid image generation must not be repeated after a workspace outage");
      assert.equal(state,"recovery_required");
      await drive(new DurableTurnRunner(repository,model([]),target,{owner:"restarted-image"}),runId);
      assert.equal(generations.length,1,"A restart must not regenerate the image");
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });

  for (const typed of [false, true]) {
    for (const status of [409, 429]) {
      await test(`an older ${typed ? "version-3" : "untyped"} connector ${status} error cannot authorize a second write`, async () => {
        const affected = await uncertainWrite(() => new Error("socket hang up"));
        await legacyShape(affected, status === 409 ? "title must not be empty" : "Too Many Requests");
        if (typed) {
          const [step] = await toolSteps(affected.runId);
          await query("UPDATE turn_steps SET output=$2::jsonb WHERE id=$1", [step.id, JSON.stringify({failure:{
            category: status === 409 ? "invalid_input" : "transient", deterministic: status === 409,
            outcome: "not_applied", outcomeVersion: 3, status,
          }})]);
        }
        const runner = new DurableTurnRunner(repository, model([[CREATE, {title:"Tender A",note:"retry"}, "non_idempotent_manual"]]), affected.target, {owner:"old-status"});
        assert.equal(await drive(runner,affected.runId),"recovery_required");
        assert.equal(affected.target.writes.length,1);
      });
    }
  }


  await test("the production-style environment probe reports missing dependencies and the next command runs once", async () => {
    const root = mkdtempSync(join(tmpdir(), "berry-environment-pg-"));
    const shellInputs = [];
    const provider = {
      kind: "e2b", supportsResume: false,
      create: async () => ({ sandbox_id: "environment-local", provider: "e2b", status: "running" }),
      files: { list: async input => ({ path: input.path, entries: [] }) },
      exec: async function* (input) {
        shellInputs.push(input.command);
        try {
          const result = await exec(input.command[0], input.command.slice(1), { cwd: root });
          if (result.stdout) yield { kind: "stdout", data: result.stdout };
          if (result.stderr) yield { kind: "stderr", data: result.stderr };
          yield { kind: "exit", exit_code: 0, signal: null };
        } catch (error) {
          if (error.stdout) yield { kind: "stdout", data: error.stdout };
          if (error.stderr) yield { kind: "stderr", data: error.stderr };
          yield { kind: "exit", exit_code: Number(error.code) || 1, signal: null };
        }
      },
    };
    const manager = new SandboxContinuityManager(provider, {
      recordSandbox: async () => {}, recordTiming: async () => {},
      latest: async () => null, continuity: async () => null, inputFiles: async () => [],
    }, null, { image: "local-environment-test", cwd: root });
    try {
      const f = await fixture(), { runId } = await admit(f);
      const probe = [
        'python3 -c "import json; print(\'json installed\')" 2>/dev/null || echo "no json"',
        'python3 -c "import berry_missing_module; print(\'berry_missing_module installed\')" 2>/dev/null || echo "no berry_missing_module"',
        "which bash berry_missing_program 2>&1",
      ].join("\n");
      const renderer = "printf 'generated once\\n' >> generated.txt";
      const state = await drive(new DurableTurnRunner(repository, model([
        ["bash", { command: probe }, "non_idempotent_manual"],
        ["bash", { command: renderer }, "non_idempotent_manual"],
      ]), manager, { owner: "environment-pg" }), runId);
      assert.equal(state, "completed");
      const steps = await toolSteps(runId);
      assert.deepEqual(steps.map(step => [step.step_type, step.state]), [
        ["tool.check_environment", "completed"], ["tool.bash", "completed"],
      ]);
      assert.equal(steps[0].output.executables.find(item => item.name === "berry_missing_program").available, false);
      assert.equal(steps[0].output.python_modules.find(item => item.name === "berry_missing_module").available, false);
      assert.equal(steps[0].output.python_modules.find(item => item.name === "json").available, true);
      assert.deepEqual(shellInputs[0].slice(0, 4), ["python3", "-I", "-S", "-c"]);
      assert.equal(shellInputs.some(command => command.includes(probe)), false, "The original Python imports must never execute");
      assert.equal(readFileSync(join(root, "generated.txt"), "utf8"), "generated once\n");
      await drive(new DurableTurnRunner(repository, model([]), manager, { owner: "environment-restart" }), runId);
      assert.equal(readFileSync(join(root, "generated.txt"), "utf8"), "generated once\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await test("an environment probe between an accepted POST failure and a retry never releases the second POST", async () => {
    const server = await endpoint(() => 0);
    let checks = 0;
    try {
      const create = "curl --silent -X POST " + server.base + "/create";
      const f = await fixture(), { runId } = await admit(f);
      const target = { execute: async (snapshot, step) => {
        if (step.input.toolName === "check_environment") {
          checks += 1;
          return { output: { executables: [{ name: "pandoc", available: false }] }, summary: "Not installed" };
        }
        return shell.execute(snapshot, step);
      } };
      const runner = new DurableTurnRunner(repository, model([
        ["bash", { command: create + " && false" }, "non_idempotent_manual"],
        ["bash", { command: "which pandoc" }, "non_idempotent_manual"],
        ["bash", { command: create }, "non_idempotent_manual"],
      ]), target, { owner: "environment-cannot-release-write" });
      assert.equal(await drive(runner, runId), "recovery_required");
      assert.equal(server.accepted.create, 1);
      assert.equal(checks, 1);
      await drive(new DurableTurnRunner(repository, model([]), target, { owner: "environment-cannot-release-write-restart" }), runId);
      assert.equal(server.accepted.create, 1);
    } finally {
      await server.close();
    }
  });

  console.log(`${passed} PostgreSQL uncertain-mutation scenarios passed${failed ? `, ${failed} failed` : ""}`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
