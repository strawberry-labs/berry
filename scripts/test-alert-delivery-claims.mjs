#!/usr/bin/env node
// Administrator alert email must never be sent twice automatically when an
// earlier send may have reached SES (H-005). Exercises the real claim SQL.
// Run against a migrated, disposable loopback PostgreSQL database only:
// pnpm --filter @berry/worker... build
// BERRY_TEST_DATABASE_URL=postgresql://... node scripts/test-alert-delivery-claims.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PgSqlExecutor } from "../apps/worker/dist/pg-executor.js";
import { SqlProviderCreditAlertStore, deliverAlertEmail } from "../apps/worker/dist/provider-credit-alerts.js";
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { Pool } = require("pg");
const url = new URL(process.env.BERRY_TEST_DATABASE_URL || "");
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Tests require a disposable loopback database");
const pool = new Pool({ connectionString: url.href });
const store = new SqlProviderCreditAlertStore(new PgSqlExecutor(pool));
const tenantId = randomUUID();
const query = async (text, params = []) => (await pool.query(text, params)).rows;
const message = { subject: "Berry: provider is out of credit", text: "text", html: "<p>html</p>" };

/** One event and one email destination; every scenario starts from no attempts. */
async function target() {
  const rule = await store.ensureRule(tenantId);
  const window = randomUUID();
  const event = await store.openEvent({ tenantId, ruleId: rule.id, prefix: `provider-credits/exhausted/${window}/`, windowKey: `provider-credits/exhausted/${window}/2026-10-15T09`, observed: 0, baseline: null });
  const destinationId = randomUUID();
  await query("INSERT INTO alert_destinations(id,tenant_id,kind,label,email_recipients,configured) VALUES($1,$2,'email','Ops','[\"ops@example.com\"]'::jsonb,true)", [destinationId, tenantId]);
  return { tenantId, eventId: event.id, destinationId };
}
const attempts = (input) => query(
  "SELECT attempt,status,error FROM delivery_attempts WHERE tenant_id=$1 AND alert_event_id=$2 AND destination_id=$3 ORDER BY attempt",
  [input.tenantId, input.eventId, input.destinationId],
);
function sender(behaviour) {
  const sender = { provider: "ses", sends: 0, send: async () => {
    sender.sends += 1;
    return behaviour(sender.sends);
  } };
  return sender;
}
const deliver = (input, emailSender, options = {}) => deliverAlertEmail(options.store ?? store, emailSender, { ...input, recipients: ["ops@example.com"], message, maxAttempts: options.maxAttempts ?? 5 });

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
try {
  await query("INSERT INTO tenants(id,name,slug) VALUES($1,'Alert delivery tests',$2)", [tenantId, tenantId]);

  await test("a send whose SES response was lost stays unresolved and is not sent again", async () => {
    const input = await target();
    const lost = sender(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    assert.equal(await deliver(input, lost), "unknown");
    const [row] = await attempts(input);
    assert.equal(row.status, "pending");
    assert.match(row.error, /^The email may have been sent; .*TimeoutError/);
    assert.equal(await deliver(input, lost), "unresolved");
    const repeated = await Promise.all(Array.from({ length: 5 }, () => deliver(input, lost)));
    assert.deepEqual([...new Set(repeated)], ["unresolved"]);
    assert.equal(lost.sends, 1);
    assert.equal((await attempts(input)).length, 1);
  });

  await test("an SES server error after acceptance stays unresolved and is not sent again", async () => {
    const input = await target();
    // SES can accept a message and still answer 500 or 503.
    const serverError = sender((sends) => {
      if (sends === 1) throw Object.assign(new Error("We encountered an internal error"), { name: "InternalFailure", $metadata: { httpStatusCode: 500 } });
      return { messageId: `ses-${sends}` };
    });
    assert.equal(await deliver(input, serverError), "unknown");
    assert.equal(await deliver(input, serverError), "unresolved");
    await query("UPDATE delivery_attempts SET created_at=now()-interval '11 minutes' WHERE tenant_id=$1 AND alert_event_id=$2", [input.tenantId, input.eventId]);
    assert.equal(await deliver(input, serverError), "unresolved");
    assert.equal(serverError.sends, 1);
    const rows = await attempts(input);
    assert.deepEqual(rows.map((row) => row.status), ["pending"]);
    assert.match(rows[0].error, /^The email may have been sent; .*InternalFailure/);
  });

  await test("a receipt that could not be recorded after SES accepted the email is not sent again", async () => {
    const input = await target();
    const accepted = sender(() => ({ messageId: "ses-accepted" }));
    const failingStore = { claimDelivery: (claim) => store.claimDelivery(claim), recordDelivery: async () => { throw new Error("Connection terminated unexpectedly"); } };
    await assert.rejects(() => deliver(input, accepted, { store: failingStore }), /Connection terminated/);
    assert.equal(await deliver(input, accepted), "in_flight");
    // Long after the worker stopped, the attempt is still unresolved, not failed.
    await query("UPDATE delivery_attempts SET created_at=now()-interval '11 minutes' WHERE tenant_id=$1 AND alert_event_id=$2", [input.tenantId, input.eventId]);
    assert.equal(await deliver(input, accepted), "unresolved");
    assert.equal(await deliver(input, accepted), "unresolved");
    assert.equal(accepted.sends, 1);
    const rows = await attempts(input);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.match(rows[0].error, /^The email may have been sent; .*worker stopped/);
  });

  await test("an expired pending attempt from a stopped worker is never replayed", async () => {
    const input = await target();
    await query(
      "INSERT INTO delivery_attempts(tenant_id,alert_event_id,destination_id,attempt,status,created_at) VALUES($1,$2,$3,1,'pending',now()-interval '2 hours')",
      [input.tenantId, input.eventId, input.destinationId],
    );
    assert.deepEqual(await store.claimDelivery({ ...input, maxAttempts: 5 }), { claimed: false, reason: "unresolved" });
    const rows = await attempts(input);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
  });

  await test("concurrent workers claim one attempt", async () => {
    const input = await target();
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimDelivery({ ...input, maxAttempts: 5 })));
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.deepEqual([...new Set(claims.filter((claim) => !claim.claimed).map((claim) => claim.reason))], ["in_flight"]);
  });

  await test("a definite SES rejection is retried until the attempts are used", async () => {
    const input = await target();
    const rejected = sender(() => { throw Object.assign(new Error("Email address is not verified"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } }); });
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(await deliver(input, rejected, { maxAttempts: 3 }), "failed");
    assert.equal(await deliver(input, rejected, { maxAttempts: 3 }), "attempts_exhausted");
    assert.equal(rejected.sends, 3);
    assert.deepEqual((await attempts(input)).map((row) => row.status), ["failed", "failed", "failed"]);
    const delivered = await target();
    assert.equal(await deliver(delivered, sender(() => ({ messageId: "ses-1" }))), "sent");
    assert.equal(await deliver(delivered, sender(() => ({ messageId: "ses-2" }))), "already_delivered");
  });

  console.log(`${passed} PostgreSQL alert delivery scenarios passed`);
} finally {
  console.log(`Fixture tenant: ${tenantId}`);
  await pool.end();
}
