#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1];
if (!triple) throw new Error("Unable to determine target triple from rustc -vV");
const exe = process.platform === "win32" ? ".exe" : "";

const candidates = [
  { name: "Node SEA", path: join(root, "artifacts/cli", `berry-${triple}${exe}`) },
  { name: "Bun compile", path: join(root, "artifacts/cli", `berry-bun-${triple}${exe}`) },
];

const results = candidates.map((candidate) => benchmark(candidate));
const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, triple, results };
console.log(JSON.stringify(report, null, 2));

if (process.argv.includes("--write-doc")) {
  const rows = results.map((result) =>
    `| ${result.name} | ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MiB | ${result.versionMedianMs.toFixed(1)} ms | ${result.doctorMedianMs.toFixed(1)} ms | ${result.sqliteCompatible ? "pass" : "fail"} |`,
  );
  const markdown = [
    "# CLI packaging benchmark",
    "",
    `Measured ${report.generatedAt} on ${report.platform} (\`${triple}\`). Times are medians of five cold process launches on this machine.`,
    "",
    "| Packager | Binary size | `--version` | `doctor --json` | SQLite migration |",
    "|---|---:|---:|---:|---|",
    ...rows,
    "",
    "Node SEA is the release default because it runs the same Node runtime and `node:sqlite` implementation as the desktop host. Bun is retained as a CI-built fallback. Its build aliases `node:sqlite` to Bun's native `bun:sqlite`; the doctor smoke must pass before a Bun artifact can be promoted.",
    "",
    "Reproduce with:",
    "",
    "```sh",
    "node scripts/build-sidecars.mjs --cli-only",
    "node scripts/build-cli-bun.mjs",
    "node scripts/benchmark-cli-packagers.mjs --write-doc",
    "```",
    "",
  ].join("\n");
  writeFileSync(join(root, "docs/cli-packaging-benchmark.md"), markdown);
}

function benchmark(candidate) {
  const versionTimings = [];
  const doctorTimings = [];
  let sqliteCompatible = true;
  for (let index = 0; index < 5; index += 1) {
    versionTimings.push(run(candidate.path, ["--version"], 0).elapsedMs);
    const dir = mkdtempSync(join(tmpdir(), "berry-cli-benchmark-"));
    try {
      const doctor = run(candidate.path, ["doctor", "--json", "--db", join(dir, "berry.db")], 2);
      const parsed = JSON.parse(doctor.stdout);
      sqliteCompatible &&= parsed.db?.ok === true;
      doctorTimings.push(doctor.elapsedMs);
    } catch {
      sqliteCompatible = false;
      doctorTimings.push(Number.NaN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    name: candidate.name,
    sizeBytes: statSync(candidate.path).size,
    versionMedianMs: median(versionTimings),
    doctorMedianMs: median(doctorTimings),
    sqliteCompatible,
  };
}

function run(binary, args, expectedStatus) {
  const start = performance.now();
  const result = spawnSync(binary, args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const elapsedMs = performance.now() - start;
  if (result.status !== expectedStatus) throw new Error(`${binary} ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return { elapsedMs, stdout: result.stdout };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.floor(sorted.length / 2)];
}
