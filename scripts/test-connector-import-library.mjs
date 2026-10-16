#!/usr/bin/env node
// Temporary connector imports must not be persisted to the Library (H-069).
// The legacy insert trigger only exists in PostgreSQL, so this runs against a
// migrated, disposable loopback database:
// pnpm --filter @berry/api... build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-connector-import-library.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { CloudDatabaseService } from "../apps/api/dist/db/cloud-database.service.js";
import { FilePlatformService } from "../apps/api/dist/files/file-platform.service.js";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const db = new CloudDatabaseService(new PgSqlExecutor(pool));
const s3 = {
  send: async (command) => {
    const name = command.constructor.name;
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
const tenantId = randomUUID(), userId = randomUUID(), workspaceId = randomUUID(), taskId = randomUUID(), sessionId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const libraryRows = (fileId) => query("SELECT count(*)::int AS n FROM file_library_entries WHERE file_id=$1 AND deleted_at IS NULL", [fileId]).then((rows) => rows[0].n);
const importFile = (sourceFileId, saveToLibrary) => files.importConnectorArtifact(tenantId, userId, {
  connectorKey: "google-workspace", accountEmail: "person@example.com", sourceFileId, sourceRevision: "rev-1",
  sourceMimeType: "application/pdf", exportMimeType: null, saveToLibrary, name: `${sourceFileId}.pdf`, contentType: "application/pdf",
  declaredSize: 4, sourceMetadata: { id: sourceFileId, version: "1" },
  body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); } }),
  taskId, sessionId,
});

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Import tests',$2)", [tenantId, tenantId]);
  await query("INSERT INTO users(id,email) VALUES($1,$2)", [userId, `${userId}@import.invalid`]);
  await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'member')", [tenantId, userId]);
  await query("INSERT INTO workspaces(id,tenant_id,owner_id,name,slug) VALUES($1::uuid,$2,$3,'Import tests',$1::text)", [workspaceId, tenantId, userId]);
  await query("INSERT INTO tasks(id,tenant_id,workspace_id,user_id,title) VALUES($1,$2,$3,$4,'Imports')", [taskId, tenantId, workspaceId, userId]);
  await query("INSERT INTO sessions(id,tenant_id,task_id,user_id) VALUES($1,$2,$3,$4)", [sessionId, tenantId, taskId, userId]);

  await test("a temporary Drive import stays out of the Library and remains a task input", async () => {
    const { artifact } = await importFile("drive-temporary", false);
    assert.equal(artifact.library, false);
    assert.equal(await libraryRows(artifact.fileId), 0);
    assert.equal((await query("SELECT count(*)::int AS n FROM file_associations WHERE file_id=$1 AND task_id=$2 AND role='input'", [artifact.fileId, taskId]))[0].n, 1);
    const repeat = await importFile("drive-temporary", false);
    assert.equal(repeat.artifact.reused, true);
    assert.equal(repeat.artifact.library, false);
  });

  await test("an explicit Save to Library import adds exactly one Library entry", async () => {
    const { artifact } = await importFile("drive-saved", true);
    assert.equal(artifact.library, true);
    assert.equal(await libraryRows(artifact.fileId), 1);
  });

  await test("saving a previously temporary import later still adds it", async () => {
    const first = await importFile("drive-promoted", false);
    assert.equal(await libraryRows(first.artifact.fileId), 0);
    const saved = await importFile("drive-promoted", true);
    assert.equal(saved.artifact.library, true);
    assert.equal(await libraryRows(first.artifact.fileId), 1);
  });

  console.log(`${passed} PostgreSQL connector-import Library scenarios passed`);
} finally {
  await pool.end();
}
