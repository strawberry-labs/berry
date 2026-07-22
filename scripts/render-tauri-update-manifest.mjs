#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const artifactDir = resolve(process.argv[2] ?? "release-artifacts");
const outputPath = resolve(process.argv[3] ?? join(artifactDir, "latest.json"));
const version = requiredEnv("BERRY_VERSION", "GITHUB_REF_NAME").replace(/^desktop-v/, "");
const repository = requiredEnv("GITHUB_REPOSITORY", "BERRY_GITHUB_REPOSITORY");
const tag = process.env.GITHUB_REF_NAME ?? `desktop-v${version}`;
const platforms = {};

for (const sigPath of walk(artifactDir).filter((path) => path.endsWith(".sig"))) {
  const assetPath = sigPath.slice(0, -4);
  const target = targetForPath(assetPath);
  if (!target) continue;
  platforms[target] = {
    signature: readFileSync(sigPath, "utf8").trim(),
    url: `https://github.com/${repository}/releases/download/${tag}/${basename(assetPath)}`,
  };
}

if (Object.keys(platforms).length === 0) throw new Error(`No updater signatures found under ${artifactDir}`);

writeFileSync(outputPath, `${JSON.stringify({
  version,
  notes: process.env.BERRY_RELEASE_NOTES ?? "",
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2)}\n`);
console.log(outputPath);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function targetForPath(path) {
  const lower = path.toLowerCase();
  if (lower.includes("windows") || lower.endsWith(".msi") || lower.endsWith(".exe")) return "windows-x86_64";
  if (lower.includes("linux") || lower.endsWith(".appimage")) return "linux-x86_64";
  if (lower.includes("macos") || lower.includes(".app.tar.gz")) return "darwin-aarch64";
  return null;
}

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}
