#!/usr/bin/env node
// A failed search index must not leave a stored file "processing" forever (H-062).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-index-failure-file-state.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlKnowledgeRepository } from "../apps/worker/dist/knowledge/repository.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const repository = new SqlKnowledgeRepository(new PgSqlExecutor(pool));
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;

/** A stored upload whose knowledge source is being indexed. */
async function indexedFile(fileStatus, revision = "r1") {
  const fileId = randomUUID(), sourceId = randomUUID();
  await query(
    `INSERT INTO files(id,tenant_id,owner_user_id,original_name,display_name,media_type,size_bytes,bucket,object_key,origin,status)
     VALUES($1,$2,$3,'screenshot.png','screenshot.png','image/png',1024,'berry',$4,'user_upload',$5)`,
    [fileId, tenantId, userId, `objects/${fileId}`, fileStatus],
  );
  await query(
    `INSERT INTO knowledge_sources(id,tenant_id,workspace_id,user_id,source_type,source_id,source_revision,content_hash,title,index_status,extraction_status)
     VALUES($1,$2,$3,$4,'file',$5,$6,'sha256:fixture','screenshot.png','pending','pending')`,
    [sourceId, tenantId, workspaceId, userId, fileId, revision],
  );
  await query(
    "INSERT INTO workspace_files(tenant_id,workspace_id,file_id,index_status) VALUES($1,$2,$3,'pending')",
    [tenantId, workspaceId, fileId],
  );
  return { fileId, sourceId };
}
const state = async ({ fileId, sourceId }) => (await query(
  `SELECT f.status::text AS file, ks.index_status AS source, wf.index_status AS workspace
   FROM files f JOIN knowledge_sources ks ON ks.id=$2 JOIN workspace_files wf ON wf.file_id=f.id
   WHERE f.id=$1`, [fileId, sourceId]))[0];

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Index failure tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@index.invalid`]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Index tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("a failed index leaves the stored file available, not processing", async () => {
    const file = await indexedFile("processing");
    await repository.markFailed(tenantId, file.sourceId, "r1", "Document extraction produced no text.");
    assert.deepEqual(await state(file), { file: "available", source: "failed", workspace: "failed" });
  });

  await test("a failure for a superseded revision does not change the file", async () => {
    const file = await indexedFile("processing", "r2");
    await repository.markFailed(tenantId, file.sourceId, "r1", "stale revision");
    assert.equal((await state(file)).file, "processing");
  });

  await test("a file held for blob verification keeps its quarantine", async () => {
    const file = await indexedFile("quarantined");
    await repository.markFailed(tenantId, file.sourceId, "r1", "Tika returned HTTP 422");
    assert.equal((await state(file)).file, "quarantined");
  });

  console.log(`${passed} PostgreSQL index-failure file state scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
