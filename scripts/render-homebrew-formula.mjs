#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
];

export function renderFormula(options) {
  const template = readFileSync(options.templatePath ?? join(root, "distribution/homebrew/berry.rb.template"), "utf8");
  let output = template
    .replaceAll("__REPOSITORY__", options.repository)
    .replaceAll("__VERSION__", options.version);
  for (const target of targets) {
    const name = `berry-${target}`;
    const checksumPath = findFile(options.artifactDir, `${name}.sha256`);
    const checksum = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
    const key = target.toUpperCase().replaceAll("-", "_");
    output = output
      .replaceAll(`__URL_${key}__`, `${options.baseUrl}/${name}`)
      .replaceAll(`__SHA_${key}__`, checksum);
  }
  if (/__[A-Z0-9_]+__/.test(output)) throw new Error("Homebrew formula still contains unresolved placeholders");
  return output;
}

function findFile(rootDir, name) {
  const direct = join(rootDir, name);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      return findFile(join(rootDir, entry.name), name);
    } catch {
      // Search the next artifact directory.
    }
  }
  throw new Error(`Missing release checksum: ${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = process.env.BERRY_VERSION;
  const repository = process.env.BERRY_GITHUB_REPOSITORY;
  const artifactDir = resolve(process.env.BERRY_ARTIFACT_DIR ?? "release-artifacts");
  const outputPath = resolve(process.env.BERRY_FORMULA_OUTPUT ?? "artifacts/homebrew/berry.rb");
  if (!version || !repository) throw new Error("BERRY_VERSION and BERRY_GITHUB_REPOSITORY are required");
  const formula = renderFormula({
    version,
    repository,
    artifactDir,
    baseUrl: `https://github.com/${repository}/releases/download/cli-v${version}`,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, formula);
  console.log(`Wrote ${outputPath}`);
}
