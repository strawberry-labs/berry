#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

function includes(path, needles) {
  const text = read(path);
  for (const needle of needles) assert(text.includes(needle), `${path} must include ${needle}`);
  return text;
}

const rootPackage = JSON.parse(read("package.json"));
assert(rootPackage.license === "MIT", "package.json must declare the provisional MIT license");
assert(rootPackage.scripts.check.includes("check:launch"), "pnpm check must include check:launch");
assert(rootPackage.scripts["release:notes"] === "node scripts/generate-release-notes.mjs", "release:notes script must run the generator");

includes("LICENSE", ["MIT License", "Permission is hereby granted"]);
includes("NOTICE", ["Pi", "OpenAI Codex", "Apache-2.0", "Material Icon Theme"]);
includes("THIRD_PARTY_NOTICES.md", ["Pi", "License: MIT", "OpenAI Codex sandbox components", "Apache License 2.0", "Material Icon Theme"]);

const shared = read("packages/shared/src/index.ts");
const protocol = /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(shared)?.[1];
assert(protocol, "PROTOCOL_VERSION must be declared");
includes("docs/release-versioning.md", ["SemVer", `Current host protocol version: \`${protocol}\``, "additive only", "release:notes"]);
includes("docs/brand-domain-cutover.md", ["Berry Desktop", "`berry`", "plans/human-blockers.md", "#33"]);
includes("README.md", ["Berry is a local-first", "No Berry account is required", "Human-Gated Launch Items", "corepack pnpm check"]);

const releaseNotes = execFileSync("node", ["scripts/generate-release-notes.mjs", "--to", "HEAD", "--check"], { encoding: "utf8" });
assert(releaseNotes.includes("## Verification"), "generated release notes must include verification commands");

const launchSensitiveFiles = [
  "apps/desktop/src/lib/file-icons.tsx",
  "apps/desktop/src/lib/mentions.ts",
  "apps/desktop/src/components/markdown.tsx",
  "apps/desktop/src/components/prompt-editor.tsx",
  "apps/desktop/src-tauri/src/main.rs",
];
const banned = ["credentialService"];
for (const path of launchSensitiveFiles) {
  const text = read(path);
  for (const phrase of banned) assert(!text.toLowerCase().includes(phrase.toLowerCase()), `${path} contains prohibited provenance language: ${phrase}`);
}

includes("plans/human-blockers.md", ["## #33 - Phase 11 / Final Public Launch Cutover"]);

console.log("Launch checklist verification passed.");
