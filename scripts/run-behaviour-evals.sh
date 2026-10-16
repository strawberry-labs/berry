#!/usr/bin/env bash
# Run the behaviour evaluation (scripts/eval-behaviour.mjs) for several models
# and prompt variants against one OpenAI-compatible endpoint.
#
#   export BERRY_EVAL_API_KEY=...   # never stored in the repository
#   scripts/run-behaviour-evals.sh https://openrouter.ai/api/v1 z-ai/glm-5.3-flash qwen/qwen3.8-flash
#
# Variants: today's prompt (baseline), today's prompt plus targeted rules, and
# the SYSTEM_PROMPT.md proposal (skipped when that file is absent). Each case
# runs BERRY_EVAL_SAMPLES times (default 3) at BERRY_EVAL_TEMPERATURE (default
# 0.5), so one lucky or unlucky reply does not decide a variant. Reports go to
# eval-results/ (ignored by git); a summary is printed at the end.
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
      --samples "${BERRY_EVAL_SAMPLES:-3}" --temperature "${BERRY_EVAL_TEMPERATURE:-0.5}" --out "eval-results/$name.json" > "eval-results/$name.log" 2>&1 \
      || echo "  failed; see eval-results/$name.log" >&2
  done
done
node scripts/behaviour-eval-summary.mjs eval-results
