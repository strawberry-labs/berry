import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderGeneratedTokens } from "../src/generate-source.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageDir, "src/tokens.generated.ts");
writeFileSync(output, renderGeneratedTokens((path) => readFileSync(resolve(packageDir, "../..", path), "utf8")));
console.log(`Wrote ${output}`);
