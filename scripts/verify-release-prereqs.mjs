#!/usr/bin/env node

const common = ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_UPDATER_PUBLIC_KEY", "TAURI_UPDATER_ENDPOINT"];
const byPlatform = {
  darwin: ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"],
  win32: ["WINDOWS_CERTIFICATE", "WINDOWS_CERTIFICATE_PASSWORD"],
  linux: [],
};

const platform = process.argv.includes("--all")
  ? "all"
  : process.argv.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length) || process.platform;

const required =
  platform === "all"
    ? [...common, ...new Set(Object.values(byPlatform).flat())]
    : [...common, ...(byPlatform[platform] ?? [])];

const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing release prerequisite${missing.length === 1 ? "" : "s"}:`);
  for (const name of missing) console.error(`- ${name}`);
  process.exit(1);
}

if (process.argv.includes("--check-sidecars")) {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1];
  const exe = process.platform === "win32" ? ".exe" : "";
  const binariesDir = join(dirname(fileURLToPath(import.meta.url)), "../apps/desktop/src-tauri/binaries");
  const sidecars = ["berry-host", "berry-pty", "agent-browser"].map((name) => join(binariesDir, `${name}-${triple}${exe}`));
  const absent = sidecars.filter((path) => !existsSync(path));
  if (absent.length > 0) {
    console.error("Missing sidecar binaries (run `node scripts/build-sidecars.mjs`):");
    for (const path of absent) console.error(`- ${path}`);
    process.exit(1);
  }
  console.log("Sidecar binaries present.");
}

console.log(`Release prerequisites present for ${platform}.`);
