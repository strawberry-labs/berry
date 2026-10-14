#!/usr/bin/env node
// Blob-deletion outbox receipts must prepare and record on real PostgreSQL (H-031).
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/worker build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-blob-receipt.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { acknowledgeBlobOutbox } from "../apps/worker/dist/file-blobs.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const sql = new PgSqlExecutor(pool);
const tenantId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;

async function outboxRow() {
  const id = randomUUID(), blobId = randomUUID();
  await query(
    `INSERT INTO runtime_outbox(id,tenant_id,event_type,aggregate_id,dedupe_key,payload,lease_epoch,lease_owner)
     VALUES($1,$2,'file.delete-blob',$3,$4,'{}'::jsonb,1,'receipt-test')`,
    [id, tenantId, blobId, `${blobId}:delete`],
  );
  return { tenantId, outboxId: id, blobId, leaseEpoch: 1 };
}
const row = async (id) => (await query("SELECT completed_at IS NOT NULL AS done,last_error,error_category,lease_owner FROM runtime_outbox WHERE id=$1", [id]))[0];

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Blob receipt tests',$2)", [tenantId, tenantId]);
  await test("a successful deletion records its receipt with a null note", async () => {
    const payload = await outboxRow();
    await sql.runWithTenant(tenantId, () => acknowledgeBlobOutbox(sql, payload, null));
    assert.deepEqual(await row(payload.outboxId), { done: true, last_error: null, error_category: null, lease_owner: null });
  });
  await test("a cancelled deletion records its note and category", async () => {
    const payload = await outboxRow();
    await sql.runWithTenant(tenantId, () => acknowledgeBlobOutbox(sql, payload, "Cancelled because a live file reference exists"));
    assert.deepEqual(await row(payload.outboxId), {
      done: true, last_error: "Cancelled because a live file reference exists", error_category: "cancelled", lease_owner: null,
    });
  });
  await test("a duplicate delivery after the receipt is idempotent", async () => {
    const payload = await outboxRow();
    await sql.runWithTenant(tenantId, () => acknowledgeBlobOutbox(sql, payload, null));
    await sql.runWithTenant(tenantId, () => acknowledgeBlobOutbox(sql, { ...payload, leaseEpoch: 2 }, null));
    assert.equal((await row(payload.outboxId)).done, true);
  });
  await test("a lost lease without a receipt is still rejected", async () => {
    const payload = await outboxRow();
    await assert.rejects(
      () => sql.runWithTenant(tenantId, () => acknowledgeBlobOutbox(sql, { ...payload, leaseEpoch: 9 }, null)),
      /receipt could not be recorded/,
    );
    assert.equal((await row(payload.outboxId)).done, false);
  });
  console.log(`${passed} PostgreSQL blob-receipt scenarios passed`);
} finally {
  await pool.end();
}
