#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ci = readFileSync(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

assert(ci.includes("ubuntu-24.04"), "Web-platform CI must use the supported Ubuntu runner");
for (const workspace of ["@berry/shared", "@berry/db", "@berry/api", "@berry/worker", "@berry/web"]) {
  assert(ci.includes(`pnpm --filter ${workspace} test`), `CI must test ${workspace}`);
}
for (const workspace of ["@berry/web...", "@berry/api...", "@berry/worker..."]) {
  assert(ci.includes(`pnpm --filter ${workspace} build`), `CI must build ${workspace}`);
  assert(ci.includes(`pnpm --filter ${workspace} typecheck`), `CI must typecheck ${workspace}`);
}
for (const service of [
  "pgvector/pgvector:0.8.2-pg16-bookworm",
  "redis:7-alpine",
  "apache/tika:3.2.3.0-full",
  "minio/minio:RELEASE.2025-09-07T16-13-09Z",
]) {
  assert(ci.includes(service), `Production integration CI must include ${service}`);
}
assert(ci.includes("node apps/api/dist/migrate.js"), "Production integration CI must run migrations");
assert(
  ci.includes("node apps/api/dist/configure-service-roles.js"),
  "Production integration CI must exercise the same least-privilege role bootstrap used by Helm",
);
assert(
  ci.includes("node apps/worker/scripts/verify-production-runtime.mjs"),
  "Production integration CI must exercise admission, outbox, worker recovery, SSE, RLS, billing, and uploads",
);
assert(packageJson.scripts.check.includes("pnpm check:ci"), "pnpm check must include CI verification");

console.log("[ci] web compile, tests, and production runtime integration matrix OK");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
