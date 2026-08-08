#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Pool } from "pg";

import { BudgetService, InMemoryBudgetHotCounters, PostgresBudgetRepository } from "../../api/dist/budget/budget.service.js";
import { CloudDatabaseService } from "../../api/dist/db/cloud-database.service.js";
import { PgSqlExecutor as ApiPgSqlExecutor } from "../../api/dist/db/pg-executor.js";
import { FilePlatformService } from "../../api/dist/files/file-platform.service.js";
import { DurableTurnService } from "../../api/dist/runtime/durable-turn.service.js";
import { PgSqlExecutor as WorkerPgSqlExecutor } from "../dist/pg-executor.js";
import { RuntimeOutboxDispatcher } from "../dist/outbox.js";
import { SqlSandboxSnapshotRepository } from "../dist/sandbox-continuity.js";
import { DurableTurnRunner, SqlDurableTurnRepository } from "../dist/turn-runner.js";
import { KnowledgeProcessor } from "../dist/knowledge/processor.js";
import { SqlKnowledgeRepository } from "../dist/knowledge/repository.js";
import { DocumentExtractor, KnowledgeChunker, S3KnowledgeObjectStore } from "../dist/knowledge/services.js";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const adminUrl = required("BERRY_INTEGRATION_ADMIN_DATABASE_URL");
const apiUrl = required("BERRY_INTEGRATION_API_DATABASE_URL");
const workerUrl = required("BERRY_INTEGRATION_WORKER_DATABASE_URL");
const s3Endpoint = required("BERRY_INTEGRATION_S3_ENDPOINT");
const s3Bucket = process.env.BERRY_INTEGRATION_S3_BUCKET ?? "berry-runtime-integration";
const tikaUrl = required("BERRY_INTEGRATION_TIKA_URL");
const redisHost = process.env.BERRY_INTEGRATION_REDIS_HOST ?? "127.0.0.1";
const redisPort = Number(process.env.BERRY_INTEGRATION_REDIS_PORT ?? "6379");

const ids = {
  tenantA: randomUUID(),
  tenantB: randomUUID(),
  user: randomUUID(),
  workspace: randomUUID(),
  task: randomUUID(),
  session: randomUUID(),
};
const runSuffix = randomUUID();
const requestId = `production-integration-turn-${runSuffix}`;

process.env.BERRY_PROJECT_KNOWLEDGE_ENABLED = "false";

const admin = new Pool({ connectionString: adminUrl });
const apiExecutor = ApiPgSqlExecutor.fromConnectionString(apiUrl);
const workerExecutor = WorkerPgSqlExecutor.fromConnectionString(workerUrl);
const apiDatabase = new CloudDatabaseService(apiExecutor);
const s3 = new S3Client({
  endpoint: s3Endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BERRY_INTEGRATION_S3_ACCESS_KEY_ID ?? "berry",
    secretAccessKey: process.env.BERRY_INTEGRATION_S3_SECRET_ACCESS_KEY ?? "berry-integration-password",
  },
});
const uploadedKeys = [];

try {
  await waitFor("PostgreSQL", async () => {
    await admin.query("SELECT 1");
  });
  await waitFor("Redis", () => pingRedis(redisHost, redisPort));
  await waitFor("Tika", async () => {
    const response = await fetch(`${tikaUrl.replace(/\/$/, "")}/version`);
    if (!response.ok) throw new Error(`Tika returned ${response.status}`);
  });
  await waitFor("S3", async () => {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: s3Bucket }));
    } catch (error) {
      if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error?.name)) throw error;
    }
  });

  await verifyDatabaseRoles();
  await seedRuntime();
  await verifyTenantIsolationAndDurableTurn();
  await verifyUploadSizeEnforcement();
  console.log("[integration] durable runtime, RLS, billing, SSE, Redis, S3 upload limits, and knowledge ingestion are production-ready");
} finally {
  await Promise.allSettled(uploadedKeys.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key }))));
  await admin.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [[ids.tenantA, ids.tenantB]]).catch(() => undefined);
  await admin.query("DELETE FROM users WHERE id=$1::uuid", [ids.user]).catch(() => undefined);
  await Promise.allSettled([apiExecutor.close(), workerExecutor.close(), admin.end(), s3.destroy()]);
}

async function verifyDatabaseRoles() {
  const roles = await admin.query(
    `SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls
     FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [["berry_api", "berry_platform", "berry_worker"]],
  );
  assert.deepEqual(roles.rows, [
    { rolname: "berry_api", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
    { rolname: "berry_platform", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: true },
    { rolname: "berry_worker", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
  ]);
  const grants = await admin.query(
    `SELECT
       has_table_privilege('berry_api','platform_rollout_rules','SELECT') AS api_platform_select,
       has_table_privilege('berry_worker','platform_rollout_rules','SELECT') AS worker_platform_select,
       has_table_privilege('berry_platform','tasks','SELECT') AS platform_task_select,
       has_table_privilege('berry_platform','usage_events','SELECT') AS platform_usage_select,
       has_function_privilege('berry_api','berry_set_tenant_id(uuid)','EXECUTE') AS api_tenant_context,
       has_function_privilege('berry_worker','berry_set_tenant_id(uuid)','EXECUTE') AS worker_tenant_context,
       has_function_privilege('berry_platform','berry_set_tenant_id(uuid)','EXECUTE') AS platform_tenant_context`,
  );
  assert.deepEqual(grants.rows[0], {
    api_platform_select: false,
    worker_platform_select: false,
    platform_task_select: false,
    platform_usage_select: true,
    api_tenant_context: true,
    worker_tenant_context: true,
    platform_tenant_context: false,
  });
}

async function seedRuntime() {
  await admin.query(
    `INSERT INTO tenants (id,name,slug,status) VALUES
      ($1::uuid,'Integration tenant A',$3,'active'),
      ($2::uuid,'Integration tenant B',$4,'active')`,
    [ids.tenantA, ids.tenantB, `integration-a-${runSuffix}`, `integration-b-${runSuffix}`],
  );
  await admin.query(
    "INSERT INTO users (id,email,name,status) VALUES ($1::uuid,$2,'Runtime Integration','active')",
    [ids.user, `runtime-${runSuffix}@berry.invalid`],
  );
  await admin.query(
    "INSERT INTO tenant_memberships (tenant_id,user_id,status) VALUES ($1::uuid,$2::uuid,'active')",
    [ids.tenantA, ids.user],
  );
  await admin.query(
    "INSERT INTO workspaces (id,tenant_id,owner_id,name,slug,trust_state) VALUES ($1::uuid,$2::uuid,$3::uuid,'Integration','integration','trusted')",
    [ids.workspace, ids.tenantA, ids.user],
  );
  await admin.query(
    "INSERT INTO tasks (id,tenant_id,workspace_id,user_id,title,status) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'Durable integration','queued')",
    [ids.task, ids.tenantA, ids.workspace, ids.user],
  );
  await admin.query(
    "INSERT INTO sessions (id,tenant_id,task_id,user_id,model_provider_id,model) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'fixture','fixture-model')",
    [ids.session, ids.tenantA, ids.task, ids.user],
  );
  await admin.query("UPDATE tasks SET active_session_id=$2::uuid WHERE id=$1::uuid", [ids.task, ids.session]);
}

async function verifyTenantIsolationAndDurableTurn() {
  const budget = new BudgetService({
    repository: new PostgresBudgetRepository(apiDatabase),
    hotCounters: new InMemoryBudgetHotCounters(),
    enabled: true,
    failClosed: true,
  });
  const reservation = await budget.reserve({
    tenantId: ids.tenantA,
    requestId,
    userId: ids.user,
    taskId: ids.task,
    sessionId: ids.session,
    feature: "model.turn",
    provider: "fixture",
    model: "fixture-model",
    estimatedCostMicros: "100",
    estimatedTokens: 15,
  });
  assert.equal(reservation.allowed, true);
  assert.equal(reservation.reservation?.reservedMicros, "100");

  const durable = new DurableTurnService(apiDatabase, true);
  const admitted = await durable.admit({
    tenantId: ids.tenantA,
    userId: ids.user,
    workspaceId: ids.workspace,
    taskId: ids.task,
    sessionId: ids.session,
    requestId,
    input: "Verify the production durable runtime",
    runtimeRequest: {
      providerId: "fixture",
      model: "fixture-model",
      modelPricing: { input: 1, output: 2 },
    },
    groundingContext: {},
  });

  const noTenantRows = await workerExecutor.query("SELECT id FROM turn_runs WHERE id=$1::uuid", [admitted.runId]);
  assert.equal(noTenantRows.length, 0, "worker queries without tenant context must see no tenant rows");
  const tenantARows = await workerExecutor.runWithTenant(ids.tenantA, () =>
    workerExecutor.query("SELECT id FROM turn_runs WHERE id=$1::uuid", [admitted.runId]));
  assert.equal(tenantARows.length, 1);
  const tenantBRows = await workerExecutor.runWithTenant(ids.tenantB, () =>
    workerExecutor.query("SELECT id FROM turn_runs WHERE id=$1::uuid", [admitted.runId]));
  assert.equal(tenantBRows.length, 0, "tenant B must not see tenant A's run");
  const apiTenantBRows = await apiDatabase.withTenant(ids.tenantB, (executor) =>
    executor.query("SELECT id FROM turn_runs WHERE id=$1::uuid", [admitted.runId]));
  assert.equal(apiTenantBRows.length, 0);

  const queued = [];
  const queue = {
    async enqueue(name, payload) {
      queued.push({ name, payload });
      return { id: `${name}-${queued.length}`, name };
    },
    async close() {},
  };
  const dispatcher = new RuntimeOutboxDispatcher(workerExecutor, queue, {
    workerId: "production-integration-dispatcher",
    batchSize: 20,
  });
  const model = {
    async call(_snapshot, _step, context) {
      const text = "The durable production integration completed.";
      await context.emitDelta(text, "text");
      return {
        text,
        inputTokens: 10,
        outputTokens: 5,
        usage: {
          kind: "usage",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costRawMicros: "20",
          servedProvider: "fixture",
          servedModel: "fixture-model",
        },
        toolCalls: [],
      };
    },
  };
  const tools = {
    async execute() {
      throw new Error("No tool should run in the production integration turn");
    },
  };

  let state = "queued";
  for (let wake = 0; wake < 10 && state !== "completed"; wake += 1) {
    await dispatcher.dispatchDue();
    const index = queued.findIndex((job) => job.name === "turn.execute" || job.name === "turn.resume");
    assert.notEqual(index, -1, `no durable wake was dispatched while the run was ${state}`);
    const [{ payload }] = queued.splice(index, 1);
    const runner = new DurableTurnRunner(
      new SqlDurableTurnRepository(workerExecutor),
      model,
      tools,
      { owner: `restart-${wake}` },
    );
    const result = await workerExecutor.runWithTenant(payload.tenantId, () => runner.execute(payload));
    state = result.state;
  }
  assert.equal(state, "completed", "the restarted durable runner must reach a terminal state");

  const events = await durable.eventsAfter(ids.tenantA, ids.session, null, 500, new Date(0));
  const kinds = events.map(({ event }) => event.kind);
  for (const kind of ["turn.start", "message.start", "message.delta", "message.end", "usage", "turn.end"]) {
    assert.ok(kinds.includes(kind), `SSE replay is missing ${kind}`);
  }
  const usage = await admin.query(
    "SELECT tokens_in,tokens_out,cost_raw_micros::text,status FROM usage_events WHERE tenant_id=$1::uuid AND request_id=$2",
    [ids.tenantA, requestId],
  );
  assert.deepEqual(usage.rows[0], { tokens_in: 10, tokens_out: 5, cost_raw_micros: "20", status: "completed" });
  const reconciled = await admin.query(
    "SELECT actual_cost_micros::text,status FROM budget_reservations WHERE tenant_id=$1::uuid AND request_id=$2",
    [ids.tenantA, requestId],
  );
  assert.deepEqual(reconciled.rows[0], { actual_cost_micros: "20", status: "reconciled" });
  const ledger = await admin.query(
    "SELECT COALESCE(sum(amount_micros),0)::text AS total FROM credit_ledger_entries WHERE tenant_id=$1::uuid AND request_id=$2 AND scope_type='org'",
    [ids.tenantA, requestId],
  );
  assert.equal(ledger.rows[0]?.total, "20");
  const task = await admin.query("SELECT status::text FROM tasks WHERE id=$1::uuid", [ids.task]);
  assert.equal(task.rows[0]?.status, "completed");

  const cancelledRequestId = `${requestId}-cancelled`;
  await budget.reserve({
    tenantId: ids.tenantA,
    requestId: cancelledRequestId,
    userId: ids.user,
    taskId: ids.task,
    sessionId: ids.session,
    feature: "model.turn",
    provider: "fixture",
    model: "fixture-model",
    estimatedCostMicros: "100",
    estimatedTokens: 3,
  });
  const cancelled = await durable.admit({
    tenantId: ids.tenantA,
    userId: ids.user,
    workspaceId: ids.workspace,
    taskId: ids.task,
    sessionId: ids.session,
    requestId: cancelledRequestId,
    input: "Cancel after the provider has reported usage",
    runtimeRequest: { providerId: "fixture", model: "fixture-model" },
    groundingContext: {},
  });
  await admin.query(
    `INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
     VALUES ($1::uuid,$2::uuid,$3::uuid,2,'usage',$4::jsonb)`,
    [
      ids.tenantA,
      cancelled.runId,
      ids.session,
      JSON.stringify({
        kind: "usage",
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
        costRawMicros: "7",
        servedProvider: "fixture",
        servedModel: "fixture-model",
      }),
    ],
  );
  assert.equal(await durable.cancel(ids.tenantA, ids.session), true);
  const cancelledUsage = await admin.query(
    "SELECT cost_raw_micros::text,status FROM usage_events WHERE tenant_id=$1::uuid AND request_id=$2",
    [ids.tenantA, cancelledRequestId],
  );
  assert.deepEqual(cancelledUsage.rows[0], { cost_raw_micros: "7", status: "cancelled" });
  const cancelledReservation = await admin.query(
    "SELECT actual_cost_micros::text,status FROM budget_reservations WHERE tenant_id=$1::uuid AND request_id=$2",
    [ids.tenantA, cancelledRequestId],
  );
  assert.deepEqual(cancelledReservation.rows[0], { actual_cost_micros: "7", status: "reconciled" });
}

async function verifyUploadSizeEnforcement() {
  const previousProjectKnowledge = process.env.BERRY_PROJECT_KNOWLEDGE_ENABLED;
  process.env.BERRY_PROJECT_KNOWLEDGE_ENABLED = "true";
  const service = new FilePlatformService(apiDatabase, {
    client: s3,
    presignClient: s3,
    bucket: s3Bucket,
    prefix: "integration",
    maxUploadBytes: 1_024,
    maxIndexableBytes: 512,
    partSize: 5 * 1024 * 1024,
    presignSeconds: 60,
  });
  if (previousProjectKnowledge === undefined) delete process.env.BERRY_PROJECT_KNOWLEDGE_ENABLED;
  else process.env.BERRY_PROJECT_KNOWLEDGE_ENABLED = previousProjectKnowledge;

  const valid = await service.initiateUpload(ids.tenantA, ids.user, {
    name: "valid.txt",
    mediaType: "text/plain",
    size: 5,
    taskId: ids.task,
  });
  const validStorage = await uploadStorage(valid.fileId, Buffer.from("berry"));
  uploadedKeys.push(validStorage.objectKey);
  const completed = await service.completeUpload(ids.tenantA, ids.user, valid.fileId, valid.uploadId, [{
    PartNumber: 1,
    ETag: validStorage.etag,
  }]);
  assert.equal(completed.size, 5);
  assert.equal(completed.status, "processing");
  const indexedSource = await admin.query(
    `SELECT ks.id::text AS knowledge_source_id,ks.source_id,ks.source_revision,ks.index_status,wf.visibility,wf.originating_task_id::text
     FROM knowledge_sources ks
     JOIN workspace_files wf
       ON wf.tenant_id=ks.tenant_id
      AND wf.workspace_id=ks.workspace_id
      AND wf.file_id::text=ks.source_id
     WHERE ks.tenant_id=$1::uuid AND ks.source_id=$2`,
    [ids.tenantA, valid.fileId],
  );
  assert.equal(indexedSource.rows[0]?.source_id, valid.fileId);
  assert.equal(indexedSource.rows[0]?.index_status, "pending");
  assert.equal(indexedSource.rows[0]?.visibility, "task_only");
  assert.equal(indexedSource.rows[0]?.originating_task_id, ids.task);
  const extractionWake = await admin.query(
    "SELECT event_type FROM runtime_outbox WHERE tenant_id=$1::uuid AND event_type='knowledge.extract' AND aggregate_id=$2",
    [ids.tenantA, indexedSource.rows[0]?.knowledge_source_id],
  );
  assert.equal(extractionWake.rowCount, 1);

  const knowledgeProcessor = new KnowledgeProcessor({
    repository: new SqlKnowledgeRepository(workerExecutor),
    objects: new S3KnowledgeObjectStore(s3, 512),
    extractor: new DocumentExtractor(tikaUrl),
    chunker: new KnowledgeChunker(16, 2),
    embeddings: null,
  });
  const knowledgePayload = {
    tenantId: ids.tenantA,
    sourceId: indexedSource.rows[0]?.knowledge_source_id,
    revision: indexedSource.rows[0]?.source_revision,
  };
  await knowledgeProcessor.process("knowledge.extract", knowledgePayload);
  await knowledgeProcessor.process("knowledge.chunk", knowledgePayload);
  const indexedKnowledge = await admin.query(
    `SELECT ks.extraction_status,ks.index_status,ks.vector_ready,wf.index_status AS workspace_index_status,
            count(kc.id)::int AS chunk_count,min(kc.text_content) AS text_content
     FROM knowledge_sources ks
     JOIN workspace_files wf
       ON wf.tenant_id=ks.tenant_id
      AND wf.workspace_id=ks.workspace_id
      AND wf.file_id::text=ks.source_id
     LEFT JOIN knowledge_chunks kc ON kc.source_id=ks.id
     WHERE ks.tenant_id=$1::uuid AND ks.id=$2::uuid
     GROUP BY ks.extraction_status,ks.index_status,ks.vector_ready,wf.index_status`,
    [ids.tenantA, knowledgePayload.sourceId],
  );
  assert.deepEqual(indexedKnowledge.rows[0], {
    extraction_status: "available",
    index_status: "indexed",
    vector_ready: false,
    workspace_index_status: "indexed",
    chunk_count: 1,
    text_content: "berry",
  });
  const derivative = await admin.query(
    "SELECT object_key FROM file_derivatives WHERE tenant_id=$1::uuid AND file_id=$2::uuid AND kind='text_extract'",
    [ids.tenantA, valid.fileId],
  );
  if (derivative.rows[0]?.object_key) uploadedKeys.push(derivative.rows[0].object_key);

  const requestMessageId = randomUUID();
  const stagingRunId = randomUUID();
  await admin.query(
    `INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user','complete')`,
    [requestMessageId, ids.tenantA, ids.session, ids.task],
  );
  await admin.query(
    `INSERT INTO file_associations (
       tenant_id,file_id,task_id,session_id,message_id,role,created_by_user_id
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'input',$6::uuid)`,
    [ids.tenantA, valid.fileId, ids.task, ids.session, requestMessageId, ids.user],
  );
  await admin.query(
    `INSERT INTO turn_runs (
       id,tenant_id,user_id,workspace_id,task_id,session_id,request_id,request_message_id,state
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,'completed')`,
    [stagingRunId, ids.tenantA, ids.user, ids.workspace, ids.task, ids.session, `model_verify_${stagingRunId}`, requestMessageId],
  );
  const sandboxRepository = new SqlSandboxSnapshotRepository(workerExecutor);
  const stagedInputs = await workerExecutor.runWithTenant(
    ids.tenantA,
    () => sandboxRepository.inputFiles(ids.tenantA, stagingRunId),
  );
  assert.deepEqual(stagedInputs, [{
    fileId: valid.fileId,
    name: "valid.txt",
    mediaType: "text/plain",
    sizeBytes: 5,
    objectKey: validStorage.objectKey,
    objectVersionId: null,
  }]);

  const mismatch = await service.initiateUpload(ids.tenantA, ids.user, {
    name: "mismatch.txt",
    mediaType: "text/plain",
    size: 1,
  });
  const mismatchStorage = await uploadStorage(mismatch.fileId, Buffer.from("no"));
  await assert.rejects(
    service.completeUpload(ids.tenantA, ids.user, mismatch.fileId, mismatch.uploadId, [{
      PartNumber: 1,
      ETag: mismatchStorage.etag,
    }]),
    /uploaded object size does not match/i,
  );
  const failed = await admin.query("SELECT status::text,size_bytes::text FROM files WHERE id=$1::uuid", [mismatch.fileId]);
  assert.equal(failed.rows[0]?.status, "deleted");
  await assert.rejects(
    s3.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: mismatchStorage.objectKey })),
    (error) => error?.$metadata?.httpStatusCode === 404,
  );
}

async function uploadStorage(fileId, body) {
  const row = await admin.query(
    `SELECT f.object_key,u.provider_upload_id
     FROM files f JOIN file_uploads u ON u.file_id=f.id
     WHERE f.id=$1::uuid`,
    [fileId],
  );
  assert.ok(row.rows[0]);
  const result = await s3.send(new UploadPartCommand({
    Bucket: s3Bucket,
    Key: row.rows[0].object_key,
    UploadId: row.rows[0].provider_upload_id,
    PartNumber: 1,
    Body: body,
    ContentLength: body.length,
  }));
  assert.ok(result.ETag);
  return { objectKey: row.rows[0].object_key, etag: result.ETag };
}

async function pingRedis(host, port) {
  const socket = createConnection({ host, port });
  socket.setTimeout(2_000);
  try {
    await once(socket, "connect");
    socket.write("*1\r\n$4\r\nPING\r\n");
    const [chunk] = await once(socket, "data");
    if (!String(chunk).startsWith("+PONG")) throw new Error(`unexpected Redis response: ${chunk}`);
  } finally {
    socket.destroy();
  }
}

async function waitFor(name, operation, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`${name} did not become ready`, { cause: lastError });
}
