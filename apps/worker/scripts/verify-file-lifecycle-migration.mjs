#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { cloudMigrations } from "../../../packages/db/dist/index.js";

const adminUrl = requiredLoopbackUrl("BERRY_INTEGRATION_ADMIN_DATABASE_URL");
const databaseName = `berry_file_lifecycle_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: adminUrl });
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

const ids = {
  tenantA: "10000000-0000-7000-8000-000000000001",
  tenantB: "10000000-0000-7000-8000-000000000002",
  userA: "10000000-0000-7000-8000-000000000011",
  userB: "10000000-0000-7000-8000-000000000012",
  fileA: "10000000-0000-7000-8000-000000000021",
  fileB: "10000000-0000-7000-8000-000000000022",
  deletedFile: "10000000-0000-7000-8000-000000000023",
  ownerlessFile: "10000000-0000-7000-8000-000000000024",
  legacyWriterFile: "10000000-0000-7000-8000-000000000025",
  rejectedFile: "10000000-0000-7000-8000-000000000026",
};
const sharedLegacyKey = "artifacts/legacy/shared-location.bin";
const repairedTenantBKey = "artifacts/legacy/tenant-b-location.bin";

let database;
try {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  database = new Pool({ connectionString: databaseUrl.toString() });
  await applyThrough(database, 42);
  await seedLegacyRows(database);

  const before = await snapshotLegacyFiles(database);
  assert.equal(before.length, 4, "the migration fixture must start with four legacy logical files");

  await applyMigration(database, requiredMigration(43));
  const afterFirstBackfill = await snapshotFiles(database);
  assert.equal(afterFirstBackfill.length, before.length, "migration 43 must not remove logical files");
  assert.ok(afterFirstBackfill.every((row) => row.blob_id), "every legacy file must receive a blob id");

  await assert.rejects(
    applyMigration(database, requiredMigration(44)),
    /Cross-tenant file blob location conflict detected/,
    "migration 44 must fail closed when two tenants claim one physical object",
  );
  assert.deepEqual(await snapshotFiles(database), afterFirstBackfill, "a rejected migration must not mutate or remove logical files");
  assert.equal(await scalar(database, "SELECT count(*)::int FROM file_blobs"), 4, "a rejected migration must not remove blobs");
  assert.equal(await scalar(database, "SELECT count(*)::int FROM schema_migrations WHERE id=44"), 0, "a rejected migration must remain pending");

  // The fixture now models an operator resolving the conflict by copying the
  // second tenant's bytes to a distinct key before retrying the migration.
  await database.query(
    "UPDATE files SET object_key=$3 WHERE tenant_id=$1::uuid AND id=$2::uuid",
    [ids.tenantB, ids.fileB, repairedTenantBKey],
  );
  await database.query(
    "UPDATE file_blobs SET object_key=$3 WHERE tenant_id=$1::uuid AND id=(SELECT blob_id FROM files WHERE id=$2::uuid)",
    [ids.tenantB, ids.fileB, repairedTenantBKey],
  );
  await applyMigration(database, requiredMigration(44));

  await verifyBackfill(database);
  await verifyRls(database);
  await verifyLegacyWriterCompatibility(database);
  await verifyGlobalLocationIsolation(database);
  await verifyIdempotency(database);

  console.log("[integration] file lifecycle migrations 42 -> 44 preserve rows, backfill safely, enforce RLS, and fail closed on cross-tenant object aliases");
} finally {
  await database?.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}

async function applyThrough(pool, finalId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const migration of cloudMigrations.filter((candidate) => candidate.id <= finalId)) {
    await applyMigration(pool, migration);
  }
}

async function applyMigration(pool, migration) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations (id,name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name",
      [migration.id, migration.name],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedLegacyRows(pool) {
  await pool.query(
    `INSERT INTO tenants (id,name,slug,status) VALUES
      ($1::uuid,'Lifecycle tenant A','lifecycle-migration-a','active'),
      ($2::uuid,'Lifecycle tenant B','lifecycle-migration-b','active')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO users (id,email,name,status) VALUES
      ($1::uuid,'lifecycle-a@berry.invalid','Lifecycle A','active'),
      ($2::uuid,'lifecycle-b@berry.invalid','Lifecycle B','active')`,
    [ids.userA, ids.userB],
  );
  await pool.query(
    `INSERT INTO files (
       id,tenant_id,owner_user_id,original_name,display_name,media_type,size_bytes,
       sha256,bucket,object_key,etag,object_version_id,origin,status,deleted_at
     ) VALUES
      ($1::uuid,$5::uuid,$7::uuid,'tenant-a.bin','tenant-a.bin','application/octet-stream',11,
       repeat('a',64),'berry-lifecycle',$9,'etag-a','version-a','legacy_artifact','available',NULL),
      ($2::uuid,$6::uuid,$8::uuid,'tenant-b.bin','tenant-b.bin','application/octet-stream',12,
       repeat('b',64),'berry-lifecycle',$9,'etag-b','version-b','legacy_artifact','available',NULL),
      ($3::uuid,$5::uuid,$7::uuid,'deleted.bin','deleted.bin','application/octet-stream',13,
       repeat('c',64),'berry-lifecycle','artifacts/legacy/deleted.bin','etag-c',NULL,'legacy_artifact','deleted',now()),
      ($4::uuid,$5::uuid,NULL,'ownerless.bin','ownerless.bin','application/octet-stream',14,
       repeat('d',64),'berry-lifecycle','artifacts/legacy/ownerless.bin','etag-d',NULL,'legacy_artifact','available',NULL)`,
    [
      ids.fileA,
      ids.fileB,
      ids.deletedFile,
      ids.ownerlessFile,
      ids.tenantA,
      ids.tenantB,
      ids.userA,
      ids.userB,
      sharedLegacyKey,
    ],
  );
}

async function verifyBackfill(pool) {
  const files = await snapshotFiles(pool);
  assert.equal(files.length, 4);
  assert.ok(files.every((file) => file.blob_id));
  const blobs = await pool.query(
    `SELECT blob.tenant_id::text,blob.bucket,blob.object_key,blob.size_bytes::int,
            blob.sha256,blob.verification_status::text,file.id::text AS file_id
     FROM file_blobs blob JOIN files file ON file.blob_id=blob.id
     ORDER BY file.id`,
  );
  assert.equal(blobs.rows.length, 4);
  assert.ok(blobs.rows.every((row) => row.sha256 === null), "legacy hashes must not be trusted as verified blob identity");
  assert.ok(blobs.rows.every((row) => row.verification_status === "unverified"));
  assert.equal(blobs.rows.find((row) => row.file_id === ids.fileA)?.object_key, sharedLegacyKey);
  assert.equal(blobs.rows.find((row) => row.file_id === ids.fileB)?.object_key, repairedTenantBKey);

  const memberships = await pool.query(
    "SELECT user_id::text,file_id::text,deleted_at FROM file_library_entries ORDER BY file_id,user_id",
  );
  assert.deepEqual(memberships.rows, [
    { user_id: ids.userA, file_id: ids.fileA, deleted_at: null },
    { user_id: ids.userB, file_id: ids.fileB, deleted_at: null },
  ]);
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM files WHERE blob_id IS NULL"), 0);
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM schema_migrations WHERE id IN (43,44)"), 2);

  const globalIndex = await pool.query(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname='public' AND indexname='file_blobs_physical_location_unique'`,
  );
  assert.match(globalIndex.rows[0]?.indexdef ?? "", /UNIQUE INDEX.*\(bucket, object_key\)/);
  const tenantForeignKey = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint WHERE conname='files_tenant_blob_id_fkey'`,
  );
  assert.match(tenantForeignKey.rows[0]?.definition ?? "", /FOREIGN KEY \(tenant_id, blob_id\).*file_blobs\(tenant_id, id\).*ON DELETE RESTRICT/);
}

async function verifyRls(pool) {
  const flags = await pool.query(
    `SELECT relname,relrowsecurity,relforcerowsecurity
     FROM pg_class WHERE relname IN ('files','file_blobs','file_library_entries') ORDER BY relname`,
  );
  assert.equal(flags.rows.length, 3);
  assert.ok(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  await pool.query("GRANT USAGE ON SCHEMA public TO berry_api");
  await pool.query("GRANT SELECT ON files,file_blobs,file_library_entries TO berry_api");
  await pool.query("GRANT EXECUTE ON FUNCTION berry_set_tenant_id(uuid) TO berry_api");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE berry_api");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [ids.tenantA]);
    const visible = await client.query("SELECT tenant_id::text FROM files ORDER BY id");
    assert.ok(visible.rows.length > 0);
    assert.ok(visible.rows.every((row) => row.tenant_id === ids.tenantA), "tenant RLS must hide tenant B's migrated rows");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function verifyLegacyWriterCompatibility(pool) {
  const key = "artifacts/legacy/writer-after-migration.bin";
  await pool.query(
    `INSERT INTO files (
       id,tenant_id,owner_user_id,original_name,display_name,media_type,size_bytes,
       bucket,object_key,origin,status
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,'writer.bin','writer.bin','application/octet-stream',15,
       'berry-lifecycle',$4,'legacy_artifact','available')`,
    [ids.legacyWriterFile, ids.tenantA, ids.userA, key],
  );
  const [row] = (await pool.query(
    `SELECT file.blob_id::text,blob.object_key,library.deleted_at
     FROM files file
     JOIN file_blobs blob ON blob.id=file.blob_id
     JOIN file_library_entries library ON library.file_id=file.id AND library.user_id=file.owner_user_id
     WHERE file.id=$1::uuid`,
    [ids.legacyWriterFile],
  )).rows;
  assert.ok(row?.blob_id);
  assert.equal(row.object_key, key);
  assert.equal(row.deleted_at, null);
}

async function verifyGlobalLocationIsolation(pool) {
  await assert.rejects(
    pool.query(
      `INSERT INTO files (
         id,tenant_id,owner_user_id,original_name,display_name,media_type,size_bytes,
         bucket,object_key,origin,status
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,'collision.bin','collision.bin','application/octet-stream',11,
         'berry-lifecycle',$4,'legacy_artifact','available')`,
      [ids.rejectedFile, ids.tenantB, ids.userB, sharedLegacyKey],
    ),
    (error) => error?.code === "23505" && String(error.constraint).includes("file_blobs_physical_location_unique"),
  );
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM files WHERE id=$1::uuid", [ids.rejectedFile]), 0);
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM file_blobs WHERE bucket='berry-lifecycle' AND object_key=$1", [sharedLegacyKey]), 1);
}

async function verifyIdempotency(pool) {
  const beforeFiles = await snapshotFiles(pool);
  const beforeBlobs = await scalar(pool, "SELECT count(*)::int FROM file_blobs");
  const beforeMemberships = await scalar(pool, "SELECT count(*)::int FROM file_library_entries");
  await pool.query(requiredMigration(43).sql);
  await pool.query(requiredMigration(44).sql);
  assert.deepEqual(await snapshotFiles(pool), beforeFiles);
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM file_blobs"), beforeBlobs);
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM file_library_entries"), beforeMemberships);
}

async function snapshotFiles(pool) {
  const result = await pool.query(
    `SELECT id::text,tenant_id::text,owner_user_id::text,blob_id::text,object_key,
            status::text,deleted_at
     FROM files WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[ids.fileA, ids.fileB, ids.deletedFile, ids.ownerlessFile, ids.legacyWriterFile]],
  );
  return result.rows.map((row) => ({
    ...row,
    deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
  }));
}

async function snapshotLegacyFiles(pool) {
  const result = await pool.query(
    `SELECT id::text,tenant_id::text,owner_user_id::text,object_key,status::text,deleted_at
     FROM files WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[ids.fileA, ids.fileB, ids.deletedFile, ids.ownerlessFile]],
  );
  return result.rows;
}

async function scalar(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0] ?? {})[0];
}

function requiredMigration(id) {
  const migration = cloudMigrations.find((candidate) => candidate.id === id);
  assert.ok(migration, `migration ${id} must exist`);
  return migration;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackUrl(name) {
  const value = required(name);
  const hostname = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error(`${name} must target an isolated loopback test database`);
  }
  return value;
}

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Unsafe temporary database name");
  return `"${value}"`;
}
