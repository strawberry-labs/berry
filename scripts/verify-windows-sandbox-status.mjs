#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sandbox = read("packages/local-agent/src/sandbox.ts");
const sandboxTest = read("packages/local-agent/src/sandbox.test.ts");
const sandboxDocs = read("docs/sandbox.md");
const adr = read("docs/adr/0003-sandbox-tiers-and-execpolicy.md");
const ciSmoke = read("scripts/check-sandbox-enforcement.mjs");
const packageJson = JSON.parse(read("package.json"));

assert(
  sandbox.includes("Windows restricted-token enforcement is not available yet; approvals remain active."),
  "Windows sandbox status must report approval-only restricted-token reason",
);
assert(
  sandboxTest.includes("keeps Windows launch posture approval-only") && sandboxTest.includes("expect(enforcer.wrap(invocation, policy)).toBe(invocation)"),
  "Windows approval-only posture must be tested without fake command wrapping",
);
assert(
  sandboxDocs.includes("Phase 11 launch decision") && sandboxDocs.includes("Windows remains approval-only for v1"),
  "docs/sandbox.md must document the Windows launch posture",
);
assert(
  adr.includes("Phase 11 decision: Windows launches approval-only"),
  "sandbox ADR must record the Windows launch decision",
);
assert(
  ciSmoke.includes("Windows approval-only launch status OK") && ciSmoke.includes("restricted-token enforcement is not shipped"),
  "sandbox CI smoke must label Windows approval-only status honestly",
);
assert(
  packageJson.scripts.check.includes("pnpm check:sandbox"),
  "pnpm check must include Windows sandbox status verification",
);

console.log("[sandbox] Windows approval-only launch posture documented and verified");

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
