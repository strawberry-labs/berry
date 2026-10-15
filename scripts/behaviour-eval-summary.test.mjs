// Run: node --test scripts/behaviour-eval-summary.test.mjs
// Synthetic reports only; no model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeReports } from "./behaviour-eval-summary.mjs";

test("summarises reports by outcome and skips unrelated JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-summary-"));
  try {
    writeFileSync(join(directory, "glm-baseline.json"), JSON.stringify({
      byIssue: { "H-012": { cases: 5 } },
      usage: { prompt: 120, completion: 30 },
      results: [
        { id: "a", outcome: "passed", pass: true },
        { id: "b", outcome: "failed", pass: false },
        { id: "c", outcome: "tool_pending", pass: false },
        { id: "d", outcome: "token_limited", pass: false },
        { id: "e", outcome: "api_error", pass: false, error: "HTTP 404" },
      ],
    }));
    // Written before outcomes existed.
    writeFileSync(join(directory, "older.json"), JSON.stringify({
      byIssue: { "H-002": { cases: 3, passed: 1, errors: 1 } },
      usage: { prompt: 1, completion: 1 },
      results: [{ id: "x", pass: true }, { id: "y", pass: false }, { id: "z", pass: false, error: "HTTP 500" }],
    }));
    writeFileSync(join(directory, "final-audit-verification.json"), JSON.stringify({ files: 27, verified: true }));
    writeFileSync(join(directory, "broken.json"), "{");

    const { lines, skipped } = summarizeReports(directory);

    assert.deepEqual(lines, [
      "glm-baseline.json: 1/2 completed answers passed; 1 tool-pending, 1 token-limited, 1 API errors; 120 prompt + 30 completion tokens",
      "older.json: 1/2 completed answers passed; 1 API errors; 1 prompt + 1 completion tokens",
    ]);
    assert.deepEqual(skipped, ["broken.json (not valid JSON)", "final-audit-verification.json (not an evaluation report)"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
