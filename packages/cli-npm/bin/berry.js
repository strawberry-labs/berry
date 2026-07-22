#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.BERRY_CLI_BINARY ?? resolve(here, "..", "vendor", process.platform === "win32" ? "berry.exe" : "berry");
if (!existsSync(binary)) {
  console.error("Berry CLI binary is missing. Reinstall @berry/cli or set BERRY_FORCE_BINARY_DOWNLOAD=1 and run its install script.");
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
