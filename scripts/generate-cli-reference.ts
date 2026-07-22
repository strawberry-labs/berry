import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_VERSION, renderCliReferenceMarkdown } from "../apps/cli/src/command-reference.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "docs/reference/cli.md");
const expected = renderCliReferenceMarkdown(CLI_VERSION);
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== expected) {
    console.error(`${outputPath} is stale. Run: corepack pnpm exec tsx scripts/generate-cli-reference.ts`);
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, expected);
console.log(`wrote ${outputPath}`);
