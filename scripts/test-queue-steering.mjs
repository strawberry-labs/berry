#!/usr/bin/env node
// Run against a migrated, disposable loopback PostgreSQL database only.
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-queue-steering.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { QueuedFollowUpService } from "../apps/api/dist/runtime/queued-follow-up.service.js";
import { DurableTurnService } from "../apps/api/dist/runtime/durable-turn.service.js";
import { BudgetService, PostgresBudgetRepository, InMemoryBudgetHotCounters } from "../apps/api/dist/budget/budget.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlDurableTurnRepository, DurableTurnRunner, promoteIdleQueuedFollowUps, promoteQueuedFollowUpSafely } from "../apps/worker/dist/turn-runner.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({connectionString:url.href});
const sql = new PgSqlExecutor(pool);
const db = new CloudDatabaseService(sql);
const queue = new QueuedFollowUpService(db);
const turns = new DurableTurnService(db, true);
const budgets = new BudgetService({repository:new PostgresBudgetRepository(db),hotCounters:new InMemoryBudgetHotCounters(),enabled:true});
const tenantId=randomUUID(), userId=randomUUID(), workspaceId=randomUUID();
const repository=new SqlDurableTurnRepository(sql);
const responses=[];
const runner=new DurableTurnRunner(repository,{call:async(snapshot,_step,context)=>{
  const text=`Answer: ${snapshot.runtimeRequest.input}`; responses.push(text);
  await context.emitDelta(text,"text");
  return {text,inputTokens:10,outputTokens:5,toolCalls:[]};
}},{execute:async()=>({output:{},summary:""})},{owner:"queue-integration-test"});
const query=async(text,params=[]) => (await pool.query(text,params)).rows;
const scoped=fn=>db.withTenant(tenantId,fn);
async function fixture() {
 const taskId=randomUUID(), sessionId=randomUUID();
 await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Queue integration')",[taskId,tenantId,workspaceId,userId]);
 await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)",[sessionId,tenantId,taskId,userId]);
 await query("UPDATE tasks SET active_session_id=$1 WHERE id=$2",[sessionId,taskId]);
 return {taskId,sessionId};
}
async function admit(f,input) {
 return turns.admit({tenantId,userId,workspaceId,...f,requestId:randomUUID(),operationFingerprint:randomUUID(),input,runtimeRequest:{input},groundingContext:{},budgetReservationRequired:false});
}
async function enqueue(f,input,key=randomUUID(),attachments=[]) {
 return queue.enqueue(tenantId,userId,f.sessionId,{taskId:f.taskId,workspaceId,input,attachments,idempotencyKey:key},async(runtime,requestId)=>{
  const check=await budgets.reserve({tenantId,userId,taskId:f.taskId,sessionId:f.sessionId,requestId,feature:"model",estimatedCostMicros:0,estimatedTokens:4000});
  return Boolean(check.reservation);
 });
}
async function drain(runId) {
 for(let i=0;i<12;i++) {
  const result=await sql.runWithTenant(tenantId,()=>runner.execute({tenantId,runId,reason:"continue"}));
  if(["completed","failed","cancelled","recovery_required"].includes(result.state)) {assert.equal(result.state,"completed");return;}
 }
 throw new Error("Run did not settle");
}
async function child(f,exclude) {return (await query("SELECT * FROM turn_runs WHERE session_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 1",[f.sessionId,exclude]))[0];}
let passed=0;
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
try {
 await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Queue tests',$2)",[tenantId,tenantId]);
 await query("INSERT INTO users(id,email) VALUES($1,$2)",[userId,`${userId}@queue.invalid`]);
 await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')",[tenantId,userId]);
 await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Queue tests',$1::text)",[workspaceId,tenantId,userId]);
 await test("API enqueue -> real worker -> journal, budget, projection and outbox; FIFO",async()=>{
  const f=await fixture();const first=await admit(f,"original");
  const a=await enqueue(f,"first correction"), b=await enqueue(f,"second correction");
  await drain(first.runId);
  let next=await child(f,first.runId);assert(next);assert.equal(next.runtime_request.input,"first correction");
  assert.equal(next.runtime_request.budgetReservationRequired,true);
  const metadata=(await query("SELECT runtime_metadata FROM sessions WHERE id=$1",[f.sessionId]))[0].runtime_metadata;
  assert.equal(metadata.activeRunId,next.id);assert.equal(metadata.leafId,next.request_message_id);
  assert.equal((await query("SELECT count(*)::int AS n FROM runtime_outbox WHERE aggregate_id=$1 AND event_type='turn.execute'",[next.id]))[0].n,1);
  assert.equal((await query("SELECT status FROM queued_follow_up_items WHERE id=$1",[a.id]))[0].status,"delivered");
  await drain(next.id);next=await child(f,next.id);assert.equal(next.runtime_request.input,"second correction");await drain(next.id);
  assert.equal((await query("SELECT status FROM queued_follow_up_items WHERE id=$1",[b.id]))[0].status,"delivered");
 });
 await test("concurrent duplicate enqueue stores and reserves once",async()=>{
  const f=await fixture();await admit(f,"original");const key=randomUUID();
  const [a,b]=await Promise.all([enqueue(f,"same",key),enqueue(f,"same",key)]);assert.equal(a.id,b.id);
  assert.equal((await query("SELECT count(*)::int AS n FROM budget_reservations WHERE tenant_id=$1 AND request_id=$2",[tenantId,`queued:${key}`]))[0].n,1);
  await assert.rejects(()=>queue.enqueue(tenantId,randomUUID(),f.sessionId,{taskId:f.taskId,workspaceId,input:"steal",attachments:[],idempotencyKey:key}));
 });
 await test("steering cancels predecessor, pauses queued items, admits correction and resumes idle queue",async()=>{
  const f=await fixture(),first=await admit(f,"old instruction"),a=await enqueue(f,"later work");
  await turns.cancel(tenantId,f.sessionId);
  assert.equal((await query("SELECT status FROM queued_follow_up_items WHERE id=$1",[a.id]))[0].status,"paused");
  await scoped(e=>promoteIdleQueuedFollowUps(e,tenantId));assert.equal(await child(f,first.runId),undefined);
  const steered=await admit(f,"new instruction");await drain(steered.runId);
  await queue.update(tenantId,userId,a.id,{status:"queued"});
  await Promise.all([scoped(e=>promoteIdleQueuedFollowUps(e,tenantId)),scoped(e=>promoteIdleQueuedFollowUps(e,tenantId))]);
  const next=await child(f,steered.runId);assert.equal(next.runtime_request.input,"later work");await drain(next.id);
  assert.equal((await query("SELECT count(*)::int AS n FROM turn_runs WHERE session_id=$1",[f.sessionId]))[0].n,3);
 });
 await test("bad follow-up cannot roll back completed answer, input remains retryable",async()=>{
  const f=await fixture(),first=await admit(f,"good answer"),a=await enqueue(f,"bad attachment",randomUUID(),[{fileId:randomUUID(),name:"missing.txt",mediaType:"text/plain",size:1}]);
  await drain(first.runId);
  assert.equal((await query("SELECT state FROM turn_runs WHERE id=$1",[first.runId]))[0].state,"completed");
  const row=(await query("SELECT status,input FROM queued_follow_up_items WHERE id=$1",[a.id]))[0];assert.equal(row.status,"failed");assert.equal(row.input,"bad attachment");
  await queue.update(tenantId,userId,a.id,{attachments:[],status:"queued"});await scoped(e=>promoteIdleQueuedFollowUps(e,tenantId));const next=await child(f,first.runId);await drain(next.id);
 });
 await test("paused FIFO head blocks later prompts; reorder and cancel remain durable",async()=>{
  const f=await fixture(),first=await admit(f,"original"),a=await enqueue(f,"a"),b=await enqueue(f,"b");
  await queue.update(tenantId,userId,a.id,{status:"paused"});await drain(first.runId);assert.equal(await child(f,first.runId),undefined);
  await queue.update(tenantId,userId,b.id,{orderedIds:[b.id,a.id]});await scoped(e=>promoteIdleQueuedFollowUps(e,tenantId));const next=await child(f,first.runId);assert.equal(next.runtime_request.input,"b");
  await queue.cancel(tenantId,userId,a.id);await drain(next.id);
 });
 await test("late predecessor model completion cannot overwrite a steering turn",async()=>{
  const f=await fixture(),first=await admit(f,"old slow prompt");
  let started,release;
  const ready=new Promise(r=>{started=r;});const gate=new Promise(r=>{release=r;});
  const delayed=new DurableTurnRunner(repository,{call:async()=>{started();await gate;return {text:"STALE ANSWER",inputTokens:1,outputTokens:1,toolCalls:[]};}},{execute:async()=>({output:{},summary:""})},{owner:"delayed-model-test"});
  await sql.runWithTenant(tenantId,()=>delayed.execute({tenantId,runId:first.runId,reason:"continue"}));
  const running=sql.runWithTenant(tenantId,()=>delayed.execute({tenantId,runId:first.runId,reason:"continue"})).catch(e=>e);
  await ready;await turns.cancel(tenantId,f.sessionId);const next=await admit(f,"corrected prompt");release();await running;await drain(next.runId);
  assert.equal((await query("SELECT state FROM turn_runs WHERE id=$1",[first.runId]))[0].state,"cancelled");
  assert.equal((await query("SELECT count(*)::int AS n FROM message_parts p JOIN messages m ON m.id=p.message_id WHERE m.session_id=$1 AND p.type='text' AND p.content::text LIKE '%STALE ANSWER%'",[f.sessionId]))[0].n,0);
 });
 await test("queued work cannot bypass spend limits",async()=>{
  const f=await fixture(),first=await admit(f,"original"),a=await enqueue(f,"budget limited");await drain(first.runId);
  const next=await child(f,first.runId);
  await query("INSERT INTO budget_limits(tenant_id,scope_type,scope_id,period,hard_limit_micros) VALUES($1,'user',$2,'month',1) ON CONFLICT (tenant_id,scope_type,scope_id,period) DO UPDATE SET hard_limit_micros=1",[tenantId,userId]);
  try {
   const snapshot=await sql.runWithTenant(tenantId,()=>repository.claim({tenantId,runId:next.id},"budget-test",30));assert(snapshot);
   const result=await sql.runWithTenant(tenantId,()=>repository.reserveNextModelCall(snapshot,"100"));assert.equal(result.allowed,false);
  } finally {await query("DELETE FROM budget_limits WHERE tenant_id=$1",[tenantId]);await turns.cancel(tenantId,f.sessionId);}
 });
 await test("expired queue entries cannot start automatically",async()=>{
  const f=await fixture(),first=await admit(f,"original"),a=await enqueue(f,"expired input");
  await query("UPDATE queued_follow_up_items SET expires_at=now()-interval '1 second' WHERE id=$1",[a.id]);
  await drain(first.runId);await scoped(e=>promoteIdleQueuedFollowUps(e,tenantId));assert.equal(await child(f,first.runId),undefined);
  assert.equal((await query("SELECT status FROM queued_follow_up_items WHERE id=$1",[a.id]))[0].status,"expired");
  assert.equal((await query("SELECT b.status FROM budget_reservations b JOIN queued_follow_up_items q ON b.request_id=q.runtime_request->>'queuedBudgetRequestId' AND b.tenant_id=q.tenant_id WHERE q.id=$1",[a.id]))[0].status,"released");
 });
 console.log(`${passed} PostgreSQL queue/steering integration scenarios passed`);
 if(process.argv.includes("--serve")) {
  const {serveQueueFixture}=await import("./queue-steering-browser-server.mjs");
  await serveQueueFixture({tenantId,userId,workspaceId,fixture,admit,enqueue,drain,query,queue,turns,scoped,promoteIdleQueuedFollowUps});
 }

} finally {
 // Persist audit-protected fixture rows for inspection; use a disposable database.
 console.log(`Fixture tenant: ${tenantId}`);
 await pool.end();
}
