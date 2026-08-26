#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CANOPYWAVE_API_KEY:-}" ]]; then
  echo "Set CANOPYWAVE_API_KEY to a Canopy Wave test key." >&2
  exit 1
fi

run_request() {
  local name="$1"
  local model="$2"

  curl --http1.1 \
    --silent \
    --show-error \
    --no-buffer \
    --max-time 600 \
    --dump-header "${name}.headers.txt" \
    --output "${name}.response.txt" \
    --write-out $'model='"${model}"$'\nhttp=%{http_code}\nupload_bytes=%{size_upload}\nttfb_seconds=%{time_starttransfer}\ntotal_seconds=%{time_total}\n' \
    'https://inference.canopywave.io/v1/chat/completions' \
    -H "Authorization: Bearer ${CANOPYWAVE_API_KEY}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: text/event-stream' \
    --data-binary "@${name}.json" | tee "${name}.timing.txt"
}

run_request "kimi-k26" "moonshotai/kimi-k2.6"
run_request "minimax-m3" "minimax/minimax-m3"
