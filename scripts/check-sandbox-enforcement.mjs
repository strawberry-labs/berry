#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const crate = join(root, "crates", "berry-sandbox");
const exe = process.platform === "win32" ? ".exe" : "";

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1];
if (!triple) throw new Error("Unable to determine Rust host triple");

run("cargo", ["test"], { cwd: crate });
run("cargo", ["build", "--release"], { cwd: crate });

const binary = join(crate, "target", "release", `berry-sandbox${exe}`);
if (!existsSync(binary)) throw new Error(`Missing berry-sandbox binary: ${binary}`);

const dangerPolicy = policy({ tier: "danger-full-access" });
const echo = process.platform === "win32"
  ? ["cmd.exe", "/c", "echo", "sandbox-smoke-ok"]
  : ["/bin/echo", "sandbox-smoke-ok"];
const danger = spawnSync(binary, ["--policy-base64", dangerPolicy, "--", ...echo], { encoding: "utf8" });
assert(danger.status === 0, `danger-full-access smoke failed: ${danger.stderr || danger.stdout}`);
assert(danger.stdout.includes("sandbox-smoke-ok"), "danger-full-access smoke did not run command");

if (process.platform === "darwin" || process.platform === "linux") {
  const readOnly = policy({ tier: "read-only" });
  const denied = spawnSync(
    binary,
    ["--policy-base64", readOnly, "--", "/bin/sh", "-c", "touch /tmp/berry-sandbox-denied-$$"],
    { encoding: "utf8" },
  );
  assert(denied.status !== 0, "read-only sandbox allowed a write probe");
  console.log(`[sandbox] ${process.platform} enforcement smoke OK (${triple})`);
} else if (process.platform === "win32") {
  console.log(`[sandbox] Windows approval-only launch status OK (${triple}); restricted-token enforcement is not shipped`);
} else {
  console.log(`[sandbox] ${process.platform} direct fallback smoke OK (${triple})`);
}

function policy(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
