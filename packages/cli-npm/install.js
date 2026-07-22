#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function platformTarget(platform = process.platform, arch = process.arch) {
  const targets = {
    "darwin/arm64": "aarch64-apple-darwin",
    "darwin/x64": "x86_64-apple-darwin",
    "linux/arm64": "aarch64-unknown-linux-gnu",
    "linux/x64": "x86_64-unknown-linux-gnu",
    "win32/x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[`${platform}/${arch}`];
  if (!target) throw new Error(`Berry CLI does not publish a binary for ${platform}/${arch}`);
  return target;
}

export async function installBinary(options = {}) {
  const packageJson = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
  const version = options.version ?? packageJson.version;
  const repository = options.repository ?? process.env.BERRY_GITHUB_REPOSITORY ?? packageJson.berry?.repository;
  const baseUrl = options.baseUrl ?? process.env.BERRY_DOWNLOAD_BASE_URL ?? repositoryBase(repository, version);
  const target = options.target ?? platformTarget();
  const suffix = process.platform === "win32" ? ".exe" : "";
  const name = `berry-${target}${suffix}`;
  const destination = options.destination ?? resolve(here, "vendor", `berry${suffix}`);
  const fetchImpl = options.fetchImpl ?? fetch;

  const [binaryResponse, checksumResponse] = await Promise.all([
    fetchImpl(`${baseUrl}/${name}`),
    fetchImpl(`${baseUrl}/${name}.sha256`),
  ]);
  if (!binaryResponse.ok) throw new Error(`Berry binary download failed (${binaryResponse.status})`);
  if (!checksumResponse.ok) throw new Error(`Berry checksum download failed (${checksumResponse.status})`);
  const binary = Buffer.from(await binaryResponse.arrayBuffer());
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || actual !== expected) throw new Error(`Berry CLI checksum mismatch for ${name}`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, binary);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  return destination;
}

function repositoryBase(repository, version) {
  if (!repository || repository === "__BERRY_GITHUB_REPOSITORY__") {
    throw new Error("Berry release repository is not configured in the npm package");
  }
  return `https://github.com/${repository}/releases/download/cli-v${version}`;
}

function isWorkspaceCheckout() {
  return existsSync(resolve(here, "..", "..", "pnpm-workspace.yaml"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!isWorkspaceCheckout() || process.env.BERRY_FORCE_BINARY_DOWNLOAD === "1") {
    installBinary().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
