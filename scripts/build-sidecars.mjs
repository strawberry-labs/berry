#!/usr/bin/env node
/**
 * Builds the production sidecar binaries Tauri bundles via `bundle.externalBin`:
 *
 *   berry-host  — the Node host compiled to a single-file executable (Node SEA)
 *   berry       — the user-facing CLI compiled with the same Node SEA pipeline
 *   berry-pty   — the Rust PTY sidecar (crates/berry-pty)
 *   agent-browser — the native browser automation runtime from the package
 *
 * Desktop outputs use apps/desktop/src-tauri/binaries/<name>-<target-triple>.
 * CLI release outputs use artifacts/cli/berry-<target-triple> plus SHA-256.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "apps/desktop/src-tauri/binaries");
const cliOutDir = join(root, "artifacts/cli");
const scratch = join(root, "apps/desktop/src-tauri/target/sea-scratch");
const exe = process.platform === "win32" ? ".exe" : "";
const cliOnly = process.argv.includes("--cli-only");

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });
const runPnpm = (args, options = {}) => run("corepack", ["pnpm", ...args], options);

const triple = (() => {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = output.match(/host: (\S+)/);
  if (!match) throw new Error("Unable to determine target triple from rustc -vV");
  return match[1];
})();

function agentBrowserPackageBinary(targetTriple) {
  const table = new Map([
    ["aarch64-apple-darwin", "agent-browser-darwin-arm64"],
    ["x86_64-apple-darwin", "agent-browser-darwin-x64"],
    ["aarch64-unknown-linux-gnu", "agent-browser-linux-arm64"],
    ["x86_64-unknown-linux-gnu", "agent-browser-linux-x64"],
    ["aarch64-unknown-linux-musl", "agent-browser-linux-musl-arm64"],
    ["x86_64-unknown-linux-musl", "agent-browser-linux-musl-x64"],
    ["x86_64-pc-windows-msvc", "agent-browser-win32-x64.exe"],
    ["x86_64-pc-windows-gnu", "agent-browser-win32-x64.exe"],
  ]);
  const binary = table.get(targetTriple);
  if (!binary) throw new Error(`agent-browser has no packaged binary mapping for ${targetTriple}`);
  return binary;
}

mkdirSync(outDir, { recursive: true });
mkdirSync(cliOutDir, { recursive: true });
mkdirSync(scratch, { recursive: true });

function buildSeaBinary(name, entry, output) {
  console.log(`[sidecars] bundling ${name} to a single CommonJS file`);
  const bundlePath = join(scratch, `${name}.cjs`);
  const blobPath = join(scratch, `${name}.blob`);
  const seaConfigPath = join(scratch, `${name}-sea-config.json`);
  runPnpm([
    "exec",
    "esbuild",
    entry,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    // import.meta.url appears in ESM sources; point it at the SEA binary path.
    "--define:import.meta.url=__importMetaUrl",
    '--banner:js=const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
    `--outfile=${bundlePath}`,
  ]);
  writeFileSync(seaConfigPath, JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }));
  run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
  rmSync(output, { force: true });
  copyFileSync(process.execPath, output);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", output]);
  runPnpm([
    "exec",
    "postject",
    output,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);
  if (process.platform === "darwin") run("codesign", ["-s", "-", output]);
  if (process.platform !== "win32") chmodSync(output, 0o755);
  console.log(`[sidecars] wrote ${output}`);
}

let hostBinary;
if (!cliOnly) {
  console.log("[sidecars] building @berry/host");
  runPnpm(["--filter", "@berry/host", "build"]);
  hostBinary = join(outDir, `berry-host-${triple}${exe}`);
  buildSeaBinary("berry-host", "packages/host/dist/main.js", hostBinary);
}

// --- berry CLI (Node SEA) ----------------------------------------------------
console.log("[sidecars] building berry CLI");
runPnpm(["exec", "turbo", "run", "build", "--filter=berry"]);
const cliBinary = join(cliOutDir, `berry-${triple}${exe}`);
buildSeaBinary("berry", "apps/cli/dist/main.js", cliBinary);
const cliChecksum = createHash("sha256").update(readFileSync(cliBinary)).digest("hex");
writeFileSync(`${cliBinary}.sha256`, `${cliChecksum}  ${cliBinary.split(/[\\/]/).at(-1)}\n`);
const cliVersion = execFileSync(cliBinary, ["--version"], { encoding: "utf8" }).trim();
if (!/^berry \d+\.\d+\.\d+/.test(cliVersion)) throw new Error(`Unexpected berry CLI version output: ${cliVersion}`);
console.log(`[sidecars] berry CLI smoke OK (${cliVersion})`);

console.log("[sidecars] smoke-testing berry ACP initialize");
const acpSmoke = join(scratch, "acp-smoke.mjs");
writeFileSync(acpSmoke, `
import { spawn } from "node:child_process";
const child = spawn(process.argv[2], ["acp"], {
  env: {
    ...process.env,
    BERRY_DESKTOP_DB: process.argv[3],
    BERRY_HOST_SOCKET: process.argv[4],
    BERRY_HOST_TOKEN: process.argv[4] + ".token",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
let buffer = "";
const timer = setTimeout(() => { console.error("ACP initialize timeout"); child.kill(); process.exit(1); }, 15000);
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === "acp-smoke" && message.result?.protocolVersion === 1) {
      clearTimeout(timer);
      child.stdin.end();
      return;
    }
    console.error("unexpected ACP reply", line);
    child.kill();
    process.exit(1);
  }
});
child.once("exit", (code) => process.exit(code ?? 1));
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: "acp-smoke",
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "berry-build-smoke", version: "1" } },
}) + "\\n");
`);
const acpSmokeSocket = join(scratch, "acp-smoke-missing.sock");
rmSync(acpSmokeSocket, { force: true });
rmSync(`${acpSmokeSocket}.token`, { force: true });
run(process.execPath, [acpSmoke, cliBinary, join(scratch, "acp-smoke.db"), acpSmokeSocket]);
console.log("[sidecars] berry ACP initialize OK");

// --- berry-pty (Rust) ---------------------------------------------------------
const ptyCrate = join(root, "crates/berry-pty");
if (!cliOnly && existsSync(ptyCrate)) {
  console.log("[sidecars] building berry-pty");
  run("cargo", ["build", "--release"], { cwd: ptyCrate });
  const ptyBinary = join(outDir, `berry-pty-${triple}${exe}`);
  rmSync(ptyBinary, { force: true });
  copyFileSync(join(ptyCrate, "target/release", `berry-pty${exe}`), ptyBinary);
  console.log(`[sidecars] wrote ${ptyBinary}`);
} else if (!cliOnly && process.argv.includes("--allow-missing-pty")) {
  console.warn("[sidecars] crates/berry-pty not found; skipping (allowed)");
} else if (!cliOnly) {
  console.error("[sidecars] crates/berry-pty not found");
  process.exit(1);
}

// --- berry-sandbox (Rust OS policy launcher) ---------------------------------
const sandboxCrate = join(root, "crates/berry-sandbox");
if (!cliOnly && existsSync(sandboxCrate)) {
  console.log("[sidecars] building berry-sandbox");
  run("cargo", ["build", "--release"], { cwd: sandboxCrate });
  const sandboxBinary = join(outDir, `berry-sandbox-${triple}${exe}`);
  rmSync(sandboxBinary, { force: true });
  copyFileSync(join(sandboxCrate, "target/release", `berry-sandbox${exe}`), sandboxBinary);
  console.log(`[sidecars] wrote ${sandboxBinary}`);
  const dangerPolicy = Buffer.from(JSON.stringify({ tier: "danger-full-access" })).toString("base64");
  run(sandboxBinary, ["--policy-base64", dangerPolicy, "--", process.platform === "win32" ? "cmd.exe" : "/bin/echo", ...(process.platform === "win32" ? ["/c", "echo", "sandbox-smoke-ok"] : ["sandbox-smoke-ok"])]);
  console.log("[sidecars] berry-sandbox smoke OK");
}

// --- agent-browser (native package binary) -----------------------------------
if (!cliOnly) {
  console.log("[sidecars] bundling agent-browser runtime");
  const agentBrowserPackageJson = execFileSync(
    process.execPath,
    [
      "-e",
      "const {createRequire}=require('node:module'); const r=createRequire(process.cwd() + '/packages/host/package.json'); console.log(r.resolve('agent-browser/package.json'))",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const agentBrowserSource = join(dirname(agentBrowserPackageJson), "bin", agentBrowserPackageBinary(triple));
  if (!existsSync(agentBrowserSource)) {
    console.error(`[sidecars] missing ${agentBrowserSource}`);
    process.exit(1);
  }
  const agentBrowserBinary = join(outDir, `agent-browser-${triple}${exe}`);
  rmSync(agentBrowserBinary, { force: true });
  copyFileSync(agentBrowserSource, agentBrowserBinary);
  if (process.platform !== "win32") chmodSync(agentBrowserBinary, 0o755);
  console.log(`[sidecars] wrote ${agentBrowserBinary}`);

  // The host SEA must boot and answer a handshake over stdio.
  console.log("[sidecars] smoke-testing berry-host handshake");
  const smoke = join(scratch, "smoke.mjs");
  writeFileSync(smoke, `
import { spawn } from "node:child_process";
const child = spawn(process.argv[2], [], {
  env: { ...process.env, BERRY_HOST_NONCE: "smoke", BERRY_DESKTOP_DB: process.argv[3] },
  stdio: ["pipe", "pipe", "inherit"],
});
const timer = setTimeout(() => { console.error("handshake timeout"); child.kill(); process.exit(1); }, 15000);
child.stdout.on("data", (chunk) => {
  const line = chunk.toString().split("\\n")[0];
  const message = JSON.parse(line);
  if (message.result?.ok) { clearTimeout(timer); child.kill(); process.exit(0); }
  console.error("unexpected handshake reply", line); child.kill(); process.exit(1);
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "host.handshake", params: { nonce: "smoke" } }) + "\\n");
`);
  run(process.execPath, [smoke, hostBinary, join(scratch, "smoke.db")]);
  console.log("[sidecars] berry-host handshake OK");
}
