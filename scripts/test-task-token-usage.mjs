// Run against a disposable loopback database. Migrations persist; fixtures roll back.
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-task-token-usage.mjs [--serve]
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgSqlExecutor } from "../apps/api/dist/db/pg-executor.js";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { PostgresUsageRepository } from "../apps/api/dist/usage/usage.repository.js";

const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname.includes("_test"), "Use a disposable loopback test database");
const sql = PgSqlExecutor.fromConnectionString(url.href, { max: 1 });
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID(), taskId = randomUUID();
const sessionId = randomUUID(), secondSessionId = randomUUID(), otherTenantId = randomUUID();
const rollback = new Error("ROLL_BACK_TASK_USAGE_TEST");
let scenarios = 0;
function pass(message) { scenarios++; console.log(`PASS ${message}`); }
try {
  await new CloudDatabaseService(sql).migrate();
  const indexes = await sql.query(`SELECT c.relname,i.indisvalid FROM pg_class c
    JOIN pg_index i ON i.indexrelid=c.oid
    WHERE c.relname IN ('usage_events_tenant_task_idx','turn_runs_tenant_task_idx')`);
  assert.equal(indexes.length,2);
  assert(indexes.every((index) => index.indisvalid));
  pass("online task indexes are present and valid");
  await sql.transaction(async (tx) => {
    await tx.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    await tx.execute("INSERT INTO tenants(id,name,slug) VALUES($1::uuid,'Context tests',$1::text)", [tenantId]);
    await tx.execute("INSERT INTO tenants(id,name,slug) VALUES($1::uuid,'Other context tests',$1::text)", [otherTenantId]);
    await tx.execute("INSERT INTO users(id,email,name) VALUES($1,$2,'Context Tester')", [userId, `${userId}@context.invalid`]);
    await tx.execute("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Context tests',$1::text)", [workspaceId,tenantId,userId]);
    await tx.execute("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Context details test')", [taskId,tenantId,workspaceId,userId]);
    for (const id of [sessionId,secondSessionId]) await tx.execute("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [id,tenantId,taskId,userId]);
    await tx.execute("UPDATE tasks SET active_session_id=$2 WHERE id=$1", [taskId,secondSessionId]);
    const usage = new PostgresUsageRepository(new CloudDatabaseService(tx));
    assert.deepEqual(await usage.taskTokenUsage(tenantId,taskId), { taskId, inputTokens:0, outputTokens:0, totalTokens:0, cachedInputTokens:0, uncachedInputTokens:0, cacheHitRate:null });
    pass("empty task has zero tokens and an undefined cache hit rate");
    const record = (requestId, id, input, output, cache, ts) => usage.ingestInternal(tenantId, {
      requestId, taskId, sessionId:id, feature:"model.turn", tokensIn:input, tokensOut:output,
      tokensCached:cache, cacheReadTokens:cache, cacheWriteTokens:200, cacheCreationTokens1h:0, cacheCreationTokens5m:0,
      cacheEligible:true, sandboxUsage:{}, costRawMicros:"0", costBilledMicros:"0", status:"completed", metadata:{}, ...(ts ? { ts } : {}),
    });
    await record("recorded-first",sessionId,1000,100,500,"2025-01-01T00:00:00Z");
    await record("recorded-first",sessionId,1000,100,500);
    await record("recorded-second",secondSessionId,3000,200,1000);
    const baseline = { taskId, inputTokens:4000, outputTokens:300, totalTokens:4300, cachedInputTokens:1500, uncachedInputTokens:2500, cacheHitRate:0.375 };
    assert.deepEqual(await usage.taskTokenUsage(tenantId,taskId),baseline);
    pass("all historical sessions are included and duplicate usage receipts count once");

    const runId = randomUUID(), requestId = `model_${runId}`;
    const createRun = async (id, runtime, request) => tx.execute(`INSERT INTO turn_runs(id,tenant_id,user_id,workspace_id,task_id,session_id,state,request_id,runtime_request)
      VALUES($1,$2,$3,$4,$5,$6,'calling_model',$7,$8::jsonb)`, [id,tenantId,userId,workspaceId,taskId,secondSessionId,request,JSON.stringify(runtime)]);
    await createRun(runId,{ requestId },requestId);
    for (const [sequence,input,output,cached] of [[1,1200,50,800],[2,800,30,400]]) {
      await tx.execute("INSERT INTO turn_events(tenant_id,run_id,session_id,sequence,event_type,payload) VALUES($1,$2,$3,$4,'usage',$5::jsonb)", [tenantId,runId,secondSessionId,sequence,JSON.stringify({ inputTokens:input,outputTokens:output,cacheReadTokens:cached })]);
    }
    const live = { taskId, inputTokens:6000, outputTokens:380, totalTokens:6380, cachedInputTokens:2700, uncachedInputTokens:3300, cacheHitRate:0.45 };
    assert.deepEqual(await usage.taskTokenUsage(tenantId,taskId),live);
    pass("committed model calls in an active turn update all task counters");
    await record(requestId,secondSessionId,2000,80,1200);
    await tx.execute("UPDATE turn_runs SET state='completed' WHERE id=$1", [runId]);
    assert.deepEqual(await usage.taskTokenUsage(tenantId,taskId),live);
    pass("settlement replaces live usage without double counting retained turn events");

    const legacyRunId = randomUUID(), legacyRequest = `turn_${legacyRunId}`;
    await createRun(legacyRunId,{},legacyRequest);
    await tx.execute("INSERT INTO turn_events(tenant_id,run_id,session_id,sequence,event_type,payload) VALUES($1,$2,$3,1,'usage',$4::jsonb)", [tenantId,legacyRunId,secondSessionId,JSON.stringify({ inputTokens:100,outputTokens:10,cacheReadTokens:50 })]);
    const beforeLegacySettlement = await usage.taskTokenUsage(tenantId,taskId);
    const role = `berry_context_probe_${randomUUID().replaceAll("-","")}`;
    await tx.execute(`CREATE ROLE ${role} NOLOGIN`);
    await tx.execute(`GRANT SELECT ON usage_events,turn_runs,turn_events TO ${role}`);
    await tx.execute(`GRANT EXECUTE ON FUNCTION berry_set_tenant_id(uuid) TO ${role}`);
    await tx.execute(`SET LOCAL ROLE ${role}`);
    assert.equal((await usage.taskTokenUsage(tenantId,taskId)).totalTokens,6490);
    assert.equal((await usage.taskTokenUsage(otherTenantId,taskId)).totalTokens,0);
    assert.equal((await tx.query("SELECT id FROM usage_events WHERE task_id=$1", [taskId])).length,0);
    assert.equal((await tx.query("SELECT id FROM turn_runs WHERE task_id=$1", [taskId])).length,0);
    assert.equal((await tx.query("SELECT id FROM turn_events WHERE session_id=$1", [secondSessionId])).length,0);
    await tx.execute("RESET ROLE");
    pass("restricted database role respects tenant RLS for both settled and live usage");
    await record(legacyRequest,secondSessionId,100,10,50);
    assert.deepEqual(await usage.taskTokenUsage(tenantId,taskId),beforeLegacySettlement);
    pass("legacy request IDs settle without changing token totals");
    console.log(`${scenarios} PostgreSQL task token usage scenarios passed; fixture writes will roll back`);
    if (process.argv.includes("--serve")) {
      const { serveTaskTokenUsageFixture } = await import("./task-token-usage-browser-server.mjs");
      await serveTaskTokenUsageFixture({ usage,tenantId,userId,workspaceId,taskId,sessionId:secondSessionId });
    }
    throw rollback;
  });
} catch (error) { if (error !== rollback) throw error; }
finally { await sql.close(); }
