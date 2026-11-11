import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { Client } = createRequire(new URL("../apps/api/package.json", import.meta.url))("pg");
import { RealBetterAuthRuntime } from "../apps/api/dist/auth/auth-runtime.js";

// Run only against an isolated local PostgreSQL instance. No production URL.
const url = process.env.BERRY_BUDGET_TEST_DATABASE_URL;
assert(url && ["localhost", "127.0.0.1"].includes(new URL(url).hostname));
const db = new Client({ connectionString: url });
await db.connect();
const tenant = "00000000-0000-7000-8000-000000000001";
const user = "00000000-0000-7000-8000-000000000201";
await db.query(`CREATE TEMP TABLE budget_limits (
 tenant_id uuid NOT NULL, scope_type text NOT NULL, scope_id text NOT NULL,
 period text NOT NULL, soft_limit_micros bigint NOT NULL, hard_limit_micros bigint NOT NULL,
 status text NOT NULL, updated_at timestamptz DEFAULT now(),
 UNIQUE(tenant_id,scope_type,scope_id,period)
)`);
const query = async (sql, params) => {
 if (sql.includes("INSERT INTO budget_limits")) return db.query(sql, params);
 if (sql.includes("AS eligible")) return { rows: [{ eligible: true }] };
 if (sql.includes("SELECT status FROM tenant_memberships")) return { rows: [{ status: "active" }] };
 if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: false }] };
 if (sql.includes("INSERT INTO users")) return { rows: [{ id: user }] };
 if (sql.includes("UPDATE tenants") || sql.includes("UPDATE workspaces")) return { rows: [], rowCount: 1 };
 return { rows: [] };
};
const description = {
 basePath: "/v1/auth", emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
 signupEnabled: false, socialProviders: [], storage: "postgres"
};
const env = {
 BERRY_SETUP_OWNER_EMAIL: "owner@example.test",
 BERRY_SETUP_TOKEN: "isolated-test-token-at-least-thirty-two-characters",
 BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS: "500000000",
 BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS: "15000000"
};
const runtime = () => new RealBetterAuthRuntime({
 handler() {}, api: { getSession: async () => ({
 session: { id: "fixture", userId: user }, user: { id: user, email: "member@example.test" }
 }) }
}, description, { connect: async () => ({ query, release() {} }) }, env);
const seed = async (scope, soft, hard, status) => db.query(
 "INSERT INTO budget_limits VALUES ($1,$2,$3,'month',$4,$5,$6,'2026-01-01T00:00:00Z')",
 [tenant, scope, scope === "org" ? tenant : user, soft, hard, status]
);
const rows = async () => (await db.query("SELECT * FROM budget_limits ORDER BY scope_type")).rows;
const reset = () => db.query("TRUNCATE pg_temp.budget_limits");
let passed = 0;
for (const status of ["active", "disabled"]) {
 await reset(); await seed("org", 400000000, 1000000000, status); await seed("user", 40000000, 50000000, status);
 const before = await rows();
 await runtime().getSession({}); await runtime().getSession({});
 assert.deepEqual(await rows(), before);
 console.log("PASS login/restart preserves existing " + status + " org and member limits"); passed++;
}
await reset(); await seed("org", 0, 0, "active"); await seed("user", 0, 0, "active");
let before = await rows(); await runtime().getSession({}); assert.deepEqual(await rows(), before);
console.log("PASS unlimited limits preserved"); passed++;
await reset(); await seed("org", 0, 0, "disabled");
before = await rows(); await runtime().getSession({});
assert.deepEqual((await rows()).filter(r => r.scope_type === "org"), before);
assert.equal((await rows()).find(r => r.scope_type === "user").hard_limit_micros, "15000000");
console.log("PASS login preserves disabled org placeholder and creates missing member limit"); passed++;
await reset(); await runtime().getSession({});
assert.equal((await rows()).find(r => r.scope_type === "org").hard_limit_micros, "500000000");
assert.equal((await rows()).find(r => r.scope_type === "user").hard_limit_micros, "15000000");
console.log("PASS missing limits initialized"); passed++;
const setup = () => runtime().setupOwner({
 organizationName: "Fixture", name: "Owner", email: env.BERRY_SETUP_OWNER_EMAIL,
 password: "isolated-fixture-password", setupToken: env.BERRY_SETUP_TOKEN
});
await reset(); await seed("org", 0, 0, "disabled"); await setup();
assert.equal((await rows()).find(r => r.scope_type === "org").hard_limit_micros, "500000000");
assert.equal((await rows()).find(r => r.scope_type === "org").status, "active");
console.log("PASS initial owner activates seeded placeholder"); passed++;
for (const status of ["active", "disabled"]) {
 await reset(); await seed("org", 400000000, 1000000000, status); await seed("user", 40000000, 50000000, status);
 before = await rows(); await setup(); assert.deepEqual(await rows(), before);
 console.log("PASS owner setup preserves configured " + status + " limits"); passed++;
}
await db.end();
console.log(JSON.stringify({ passed, productionDatabaseAccessed: false }));
