#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const commands = [
  { command: "corepack", args: ["pnpm", "check"], cwd: root },
  { command: "cargo", args: ["check", "--locked"], cwd: join(root, "apps", "desktop", "src-tauri") },
  { command: "cargo", args: ["test"], cwd: join(root, "crates", "berry-pty") },
  { command: "node", args: ["scripts/build-sidecars.mjs"], cwd: root },
  { command: "corepack", args: ["pnpm", "--filter", "@berry/desktop", "test:e2e"], cwd: root },
];

for (const step of commands) {
  const label = `${step.command} ${step.args.join(" ")}`;
  console.log(`\n> ${label}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
