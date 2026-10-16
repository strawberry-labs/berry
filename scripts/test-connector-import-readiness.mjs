#!/usr/bin/env node
// A connector import is staged only after verification, only for its own
// task session, and a repeated import reuses the Berry file (H-068, H-069).
// Runs against a migrated, disposable loopback database:
// pnpm --filter @berry/api... build && pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-connector-import-readiness.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { FilePlatformService } from "../apps/api/dist/files/file-platform.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlSandboxSnapshotRepository } from "../apps/worker/dist/sandbox-continuity.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const sql = new PgSqlExecutor(pool);
const db = new CloudDatabaseService(sql);
const storageCommands = [];
const s3 = {
  send: async (command) => {
    const name = command.constructor.name;
    storageCommands.push(name);
    if (name === "CreateMultipartUploadCommand") return { UploadId: "upload" };
    if (name === "UploadPartCommand") return { ETag: '"part"' };
    if (name === "CompleteMultipartUploadCommand") return { ETag: '"etag"' };
    if (name === "PutObjectCommand") return { ETag: '"etag"' };
    throw new Error(`Unexpected S3 command: ${name}`);
  },
};
const files = new FilePlatformService(db, {
  client: s3, presignClient: s3, bucket: "berry-test", prefix: "artifacts",
  maxUploadBytes: 1024 * 1024, maxIndexableBytes: 1024 * 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
});
const snapshots = new SqlSandboxSnapshotRepository(sql);
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const libraryRows = (fileId) => query("SELECT count(*)::int AS n FROM file_library_entries WHERE file_id=$1 AND deleted_at IS NULL", [fileId]).then((rows) => rows[0].n);

async function taskRun(title, tenant = tenantId) {
  const taskId = randomUUID(), sessionId = randomUUID(), runId = randomUUID();
  await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,$5)", [taskId, tenant, workspaceId, userId, title]);
  await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenant, taskId, userId]);
  await query(`INSERT INTO turn_runs(id,tenant_id,user_id,workspace_id,task_id,session_id,request_id,state,runtime_request)
               VALUES($1,$2,$3,$4,$5,$6,$7,'completed','{"input":"open the file"}'::jsonb)`, [runId, tenant, userId, workspaceId, taskId, sessionId, randomUUID()]);
  return { taskId, sessionId, runId };
}
let bodyCancelled = 0;
// Distinct bytes per source: verified blobs are unique per content hash.
const importFile = (run, sourceFileId) => {
  const bytes = new TextEncoder().encode(`png:${sourceFileId}`);
  return files.importConnectorArtifact(tenantId, userId, {
    connectorKey: "google-workspace", accountEmail: "person@example.com", sourceFileId, sourceRevision: "rev-1",
    sourceMimeType: "image/png", exportMimeType: null, saveToLibrary: false, name: `${sourceFileId}.png`, contentType: "image/png",
    declaredSize: bytes.byteLength, sourceMetadata: { id: sourceFileId, version: "1" },
    body: new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
      cancel() { bodyCancelled += 1; },
    }),
    taskId: run.taskId, sessionId: run.sessionId,
  });
};
const staged = (run, tenant = tenantId) => sql.runWithTenant(tenant, () => snapshots.inputFiles(tenant, run.runId)).then((rows) => rows.map((row) => row.fileId));
const verify = (fileId) => query(`UPDATE file_blobs b SET verification_status='verified' FROM files f
                                  WHERE f.id=$1 AND b.tenant_id=f.tenant_id AND b.id=f.blob_id`, [fileId]);

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await db.migrate();
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Readiness tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@readiness.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Readiness tests',$1::text)", [workspaceId, tenantId, userId]);

  await test("an import is hidden from sandbox staging until its blob is verified", async () => {
    const run = await taskRun("Verification gate");
    const { artifact } = await importFile(run, "drive-gate");
    const [blob] = await query("SELECT b.verification_status FROM files f JOIN file_blobs b ON b.id=f.blob_id WHERE f.id=$1", [artifact.fileId]);
    assert.notEqual(blob.verification_status, "verified");
    assert.deepEqual(await staged(run), []);
    await verify(artifact.fileId);
    assert.deepEqual(await staged(run), [artifact.fileId]);
  });

  await test("deleted files, deleted blobs and removed associations are never staged", async () => {
    const run = await taskRun("Deletion and revocation");
    const deletedFile = (await importFile(run, "drive-deleted-file")).artifact.fileId;
    const deletedBlob = (await importFile(run, "drive-deleted-blob")).artifact.fileId;
    const revoked = (await importFile(run, "drive-revoked")).artifact.fileId;
    for (const fileId of [deletedFile, deletedBlob, revoked]) await verify(fileId);
    assert.deepEqual((await staged(run)).sort(), [deletedFile, deletedBlob, revoked].sort());
    await query("UPDATE files SET deleted_at=now() WHERE id=$1", [deletedFile]);
    await query("UPDATE file_blobs b SET deleted_at=now() FROM files f WHERE f.id=$1 AND b.id=f.blob_id", [deletedBlob]);
    await query("DELETE FROM file_associations WHERE file_id=$1", [revoked]);
    assert.deepEqual(await staged(run), []);
  });

  await test("another task session or tenant cannot stage the import", async () => {
    const owner = await taskRun("Owner task");
    const other = await taskRun("Other task");
    const { artifact } = await importFile(owner, "drive-scoped");
    await verify(artifact.fileId);
    assert.deepEqual(await staged(owner), [artifact.fileId]);
    assert.deepEqual(await staged(other), []);
    const otherTenant = randomUUID();
    assert.deepEqual(await staged(owner, otherTenant), []);
  });

  await test("repeating an import reuses the Berry file without new bytes or a Library entry", async () => {
    const run = await taskRun("Repeat import");
    const first = await importFile(run, "drive-repeat");
    const commands = storageCommands.length;
    const cancelled = bodyCancelled;
    const repeat = await importFile(run, "drive-repeat");
    assert.equal(repeat.artifact.fileId, first.artifact.fileId);
    assert.equal(repeat.artifact.reused, true);
    assert.equal(repeat.artifact.library, false);
    assert.equal(storageCommands.length, commands, "no new object storage writes");
    assert.equal(bodyCancelled, cancelled + 1, "the repeated download stream is cancelled unread");
    assert.equal(await libraryRows(first.artifact.fileId), 0);
  });

  console.log(`${passed} PostgreSQL connector-import readiness scenarios passed`);
} finally {
  await pool.end();
}
