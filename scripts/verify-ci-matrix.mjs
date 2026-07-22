#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ci = readFileSync(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
const playwright = readFileSync(resolve(root, "apps", "desktop", "playwright.config.ts"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

assert(ci.includes("ubuntu-24.04"), "CI must include an Ubuntu runner");
assert(ci.includes("windows-latest"), "CI must include a Windows runner");
assert(ci.includes("macos-latest"), "CI must keep a macOS runner");
assert(ci.includes("node scripts/build-sidecars.mjs"), "CI must build sidecars");
assert(ci.includes("cargo test") && ci.includes("crates/berry-pty"), "CI must run berry-pty cargo tests");
assert(ci.includes("node scripts/check-sandbox-enforcement.mjs"), "CI must run the sandbox enforcement smoke");
assert(!ci.includes("--ignore-snapshots"), "CI must not ignore Playwright snapshots");
assert(ci.includes("--project=chromium") && ci.includes("--project=webkit"), "CI must run Chromium and WebKit projects");
assert(ci.includes("playwright install --with-deps chromium webkit"), "Linux CI must install Chromium and WebKit with dependencies");

assert(!/name:\s*"webkit"[\s\S]*?testMatch:/.test(playwright), "WebKit project must not be narrowed by testMatch");
assert(playwright.includes('{ name: "chromium"') && playwright.includes('name: "webkit"'), "Playwright must define Chromium and WebKit projects");

const snapshotRoot = join(root, "apps", "desktop", "tests");
const darwinSnapshots = listSnapshots(snapshotRoot, "-darwin.png");
const linuxSnapshots = listSnapshots(snapshotRoot, "-linux.png");
assert(darwinSnapshots.length > 0, "Desktop Playwright must keep Darwin snapshot baselines");
assert(linuxSnapshots.length === darwinSnapshots.length, `Linux snapshot baseline count (${linuxSnapshots.length}) must match Darwin (${darwinSnapshots.length})`);

assert(packageJson.scripts.check.includes("pnpm check:ci"), "pnpm check must include CI matrix verification");

console.log("[ci] cross-platform sidecar, Playwright, and sandbox CI matrix OK");

function listSnapshots(dir, suffix) {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...listSnapshots(path, suffix));
    if (entry.isFile() && entry.name.endsWith(suffix)) entries.push(path);
  }
  return entries;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
