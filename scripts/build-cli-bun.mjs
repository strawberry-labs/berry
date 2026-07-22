#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "artifacts/cli");
const scratchDir = join(root, "apps/desktop/src-tauri/target/bun-scratch");
const exe = process.platform === "win32" ? ".exe" : "";
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1];
if (!triple) throw new Error("Unable to determine target triple from rustc -vV");

const runPnpm = (args) => execFileSync("corepack", ["pnpm", ...args], { cwd: root, stdio: "inherit" });
if (!process.argv.includes("--skip-build")) runPnpm(["--filter", "berry", "build"]);

mkdirSync(outDir, { recursive: true });
mkdirSync(scratchDir, { recursive: true });
const output = join(outDir, `berry-bun-${triple}${exe}`);
const bundle = join(scratchDir, "berry-bun.mjs");
rmSync(output, { force: true });
runPnpm([
  "exec",
  "esbuild",
  "apps/cli/src/main.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--alias:node:sqlite=./scripts/bun-sqlite-compat.mjs",
  "--external:bun:sqlite",
  `--outfile=${bundle}`,
]);
runPnpm(["dlx", "bun@1.3.14", "build", bundle, "--compile", `--outfile=${output}`]);
if (process.platform !== "win32") chmodSync(output, 0o755);

const checksum = createHash("sha256").update(readFileSync(output)).digest("hex");
writeFileSync(`${output}.sha256`, `${checksum}  ${output.split(/[\\/]/).at(-1)}\n`);
const version = execFileSync(output, ["--version"], { encoding: "utf8" }).trim();
if (!/^berry \d+\.\d+\.\d+/.test(version)) throw new Error(`Unexpected Bun CLI version output: ${version}`);
console.log(`[bun-cli] wrote ${output}`);
console.log(`[bun-cli] smoke OK (${version})`);
