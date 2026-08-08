#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ci = readFileSync(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
const normalizedCi = ci.replace(/\s+/g, " ");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

assert(ci.includes("ubuntu-24.04"), "Web-platform CI must use the supported Ubuntu runner");
for (const workspace of ["@berry/web...", "@berry/api...", "@berry/worker...", "@berry/mem0..."]) {
  assert(ci.includes(`--filter ${workspace}`), `CI must build and typecheck ${workspace}`);
}
assert(
  normalizedCi.includes("pnpm --filter @berry/web... --filter @berry/api... --filter @berry/worker... --filter @berry/mem0... build"),
  "CI must build the shared web graph once instead of rebuilding overlapping dependencies",
);
assert(
  normalizedCi.includes("pnpm --filter @berry/web... --filter @berry/api... --filter @berry/worker... --filter @berry/mem0... typecheck"),
  "CI must typecheck the shared web graph once",
);
assert(
  normalizedCi.includes(
    "pnpm --filter @berry/shared --filter @berry/db --filter @berry/api --filter @berry/worker --filter @berry/mem0 --filter @berry/web test",
  ),
  "CI must test every production web workspace",
);
assert(!ci.includes("needs: compile"), "Production integration should run in parallel with compile checks");
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
assert(
  ci.includes("node apps/worker/scripts/verify-file-lifecycle-migration.mjs"),
  "Production integration CI must execute the file lifecycle migration and backfill test",
);
assert(
  ci.includes("playwright test --config playwright.file-lifecycle.config.ts"),
  "Production integration CI must exercise the real PostgreSQL and object-storage file lifecycle in a browser",
);
assert(packageJson.scripts.check.includes("pnpm check:ci"), "pnpm check must include CI verification");
assert(packageJson.scripts.check.includes("pnpm check:deploy"), "pnpm check must include deployment-impact tests");
assert(packageJson.scripts.check.includes("pnpm check:docker"), "pnpm check must include Docker context verification");
assert(
  ci.includes("pnpm check:compose && pnpm check:docker && pnpm check:ci && pnpm check:deploy"),
  "CI must validate deployment assets",
);

console.log("[ci] web compile, tests, and production runtime integration matrix OK");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
