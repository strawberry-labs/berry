#!/usr/bin/env node
import { createHash, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const artifactDir = resolve(process.argv[2] ?? "release-artifacts");
const outputPath = resolve(process.argv[3] ?? join(artifactDir, "berry-cli-update.json"));
const version = requiredEnv("BERRY_VERSION", "GITHUB_REF_NAME").replace(/^cli-v/, "");
const repository = requiredEnv("GITHUB_REPOSITORY", "BERRY_GITHUB_REPOSITORY");
const keyId = requiredEnv("BERRY_CLI_UPDATE_KEY_ID");
const privateKey = requiredEnv("BERRY_CLI_UPDATE_PRIVATE_KEY_PEM").replace(/\\n/g, "\n");
const tag = process.env.GITHUB_REF_NAME ?? `cli-v${version}`;
const artifacts = {};

for (const path of walk(artifactDir)) {
  const target = targetForCliArtifact(path);
  if (!target) continue;
  const bytes = readFileSync(path);
  artifacts[target] = {
    url: `https://github.com/${repository}/releases/download/${tag}/${basename(path)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

if (Object.keys(artifacts).length === 0) throw new Error(`No CLI artifacts found under ${artifactDir}`);

const manifest = {
  version,
  keyId,
  notes: process.env.BERRY_RELEASE_NOTES ?? "",
  pubDate: new Date().toISOString(),
  rollout: { percentage: Number(process.env.BERRY_CLI_UPDATE_ROLLOUT_PERCENTAGE ?? "100"), salt: "berry-cli" },
  artifacts,
};
manifest.signature = sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64");
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(outputPath);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function targetForCliArtifact(path) {
  const name = basename(path).toLowerCase();
  if (!name.startsWith("berry-")) return null;
  if (name.includes("aarch64-apple-darwin")) return "darwin-arm64";
  if (name.includes("x86_64-apple-darwin")) return "darwin-x64";
  if (name.includes("aarch64-unknown-linux")) return "linux-arm64";
  if (name.includes("x86_64-unknown-linux")) return "linux-x64";
  if (name.includes("x86_64-pc-windows")) return "win32-x64";
  return null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}
