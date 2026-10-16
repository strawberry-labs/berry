#!/usr/bin/env node
// Summarises behaviour-evaluation reports in a directory (eval-results/).
// Other JSON files in the directory (audit metadata, manifests) are skipped,
// and inconclusive outcomes are listed apart from completed-answer results.
// Usage: node scripts/behaviour-eval-summary.mjs [directory]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Reads every report in `directory`; returns one line per report plus skipped files. */
export function summarizeReports(directory) {
  const lines = [];
  const skipped = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    let report;
    try {
      report = JSON.parse(readFileSync(join(directory, file), "utf8"));
    } catch {
      skipped.push(`${file} (not valid JSON)`);
      continue;
    }
    if (!report || typeof report !== "object" || !report.byIssue || typeof report.byIssue !== "object" || !Array.isArray(report.results)) {
      skipped.push(`${file} (not an evaluation report)`);
      continue;
    }
    const outcomes = { passed: 0, failed: 0, tool_pending: 0, token_limited: 0, api_error: 0 };
    for (const result of report.results) {
      // Reports written before outcomes existed only record pass and error.
      const outcome = result.outcome ?? (result.error ? "api_error" : result.pass ? "passed" : "failed");
      if (outcome in outcomes) outcomes[outcome] += 1;
    }
    const evaluated = outcomes.passed + outcomes.failed;
    const inconclusive = [
      outcomes.tool_pending ? `${outcomes.tool_pending} tool-pending` : "",
      outcomes.token_limited ? `${outcomes.token_limited} token-limited` : "",
      outcomes.api_error ? `${outcomes.api_error} API errors` : "",
    ].filter(Boolean).join(", ");
    const usage = report.usage ?? {};
    lines.push(`${file}: ${outcomes.passed}/${evaluated} completed answers passed${inconclusive ? `; ${inconclusive}` : ""}; ${usage.prompt ?? 0} prompt + ${usage.completion ?? 0} completion tokens`);
  }
  return { lines, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { lines, skipped } = summarizeReports(process.argv[2] ?? "eval-results");
  for (const line of lines) console.log(line);
  if (skipped.length) console.log(`Skipped ${skipped.length} other JSON file(s): ${skipped.join(", ")}`);
}
