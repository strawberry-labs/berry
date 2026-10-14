#!/usr/bin/env bash
# Run the behaviour evaluation (scripts/eval-behaviour.mjs) for several models
# and prompt variants against one OpenAI-compatible endpoint.
#
#   export BERRY_EVAL_API_KEY=...   # never stored in the repository
#   scripts/run-behaviour-evals.sh https://openrouter.ai/api/v1 z-ai/glm-5.3-flash qwen/qwen3.8-flash
#
# Variants: today's prompt (baseline), today's prompt plus targeted rules, and
# the SYSTEM_PROMPT.md proposal (skipped when that file is absent). Reports go
# to eval-results/ (ignored by git); a summary is printed at the end.
set -euo pipefail
base_url="${1:?Usage: $0 <base-url> <model> [model...]}"
shift
[[ $# -gt 0 ]] || { echo "Name at least one model." >&2; exit 1; }
: "${BERRY_EVAL_API_KEY:?Export BERRY_EVAL_API_KEY first}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[[ -f apps/worker/dist/turn-runner.js ]] || { echo "Build first: pnpm --filter @berry/worker... build" >&2; exit 1; }
mkdir -p eval-results
variants=(baseline scripts/behaviour-eval-candidates/targeted-rules.json)
[[ -f SYSTEM_PROMPT.md ]] && variants+=(scripts/behaviour-eval-candidates/system-prompt-proposal.json)
for model in "$@"; do
  for variant in "${variants[@]}"; do
    name="$(printf '%s-%s' "$model" "$(basename "$variant" .json)" | tr '/:' '__')"
    candidate=()
    [[ "$variant" != baseline ]] && candidate=(--candidate "$variant")
    echo "Running $model / $(basename "$variant" .json) (log: eval-results/$name.log)"
    node scripts/eval-behaviour.mjs --base-url "$base_url" --model "$model" ${candidate[@]+"${candidate[@]}"} \
      --samples "${BERRY_EVAL_SAMPLES:-1}" --out "eval-results/$name.json" > "eval-results/$name.log" 2>&1 \
      || echo "  failed; see eval-results/$name.log" >&2
  done
done
node -e '
const fs = require("node:fs");
for (const file of fs.readdirSync("eval-results").filter((name) => name.endsWith(".json")).sort()) {
  const report = JSON.parse(fs.readFileSync(`eval-results/${file}`, "utf8"));
  const total = Object.values(report.byIssue).reduce((sum, item) => ({ cases: sum.cases + item.cases, passed: sum.passed + item.passed }), { cases: 0, passed: 0 });
  console.log(`${file}: ${total.passed}/${total.cases} passed, ${report.usage.prompt} prompt + ${report.usage.completion} completion tokens`);
}'
