#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

env_file="deploy/.env.production"
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy deploy/.env.production.example and fill every REPLACE_WITH value." >&2
  exit 1
fi

if grep -q "REPLACE_WITH" "$env_file"; then
  echo "$env_file still contains REPLACE_WITH placeholders." >&2
  exit 1
fi

exec sh ./deploy/up.sh "$env_file"
