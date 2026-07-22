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

if grep -Eq '^BERRY_AUTH_ALLOWED_EMAILS=.*@example\.com' "$env_file"; then
  echo "$env_file still contains the example account allow-list." >&2
  exit 1
fi

sandbox_provider="$(sed -n 's/^BERRY_SANDBOX_PROVIDER=//p' "$env_file" | tail -n 1)"
e2b_api_key="$(sed -n 's/^E2B_API_KEY=//p' "$env_file" | tail -n 1)"
if [ "$sandbox_provider" = "e2b" ] && [ -z "$e2b_api_key" ]; then
  echo "E2B_API_KEY is required when BERRY_SANDBOX_PROVIDER=e2b." >&2
  exit 1
fi

storage_mode="$(sed -n 's/^BERRY_OBJECT_STORAGE_MODE=//p' "$env_file" | tail -n 1)"
storage_mode="${storage_mode:-minio}"
if [ "$storage_mode" = "r2" ]; then
  for name in BERRY_ARTIFACT_S3_ENDPOINT BERRY_ARTIFACT_S3_BUCKET BERRY_ARTIFACT_S3_ACCESS_KEY_ID BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY BERRY_AUDIT_S3_ENDPOINT BERRY_AUDIT_S3_BUCKET BERRY_AUDIT_S3_ACCESS_KEY_ID BERRY_AUDIT_S3_SECRET_ACCESS_KEY; do
    value="$(sed -n "s/^${name}=//p" "$env_file" | tail -n 1)"
    if [ -z "$value" ]; then
      echo "$name is required when BERRY_OBJECT_STORAGE_MODE=r2." >&2
      exit 1
    fi
  done
  docker compose --env-file "$env_file" -f deploy/compose.yaml config --quiet
  docker compose --env-file "$env_file" -f deploy/compose.yaml pull postgres redis caddy
  docker compose --env-file "$env_file" -f deploy/compose.yaml build api worker web
  docker compose --env-file "$env_file" -f deploy/compose.yaml up -d --remove-orphans
  docker compose --env-file "$env_file" -f deploy/compose.yaml ps
elif [ "$storage_mode" = "minio" ]; then
  minio_password="$(sed -n 's/^MINIO_ROOT_PASSWORD=//p' "$env_file" | tail -n 1)"
  if [ -z "$minio_password" ]; then
    echo "MINIO_ROOT_PASSWORD is required when BERRY_OBJECT_STORAGE_MODE=minio." >&2
    exit 1
  fi
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml config --quiet
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml pull postgres redis minio minio-init caddy
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml build api worker web
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml up -d --remove-orphans
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml ps
else
  echo "BERRY_OBJECT_STORAGE_MODE must be r2 or minio." >&2
  exit 1
fi

domain="$(sed -n 's/^BERRY_DOMAIN=//p' "$env_file" | tail -n 1)"
echo "Berry is starting at https://$domain"
echo "Verify with: curl -fsS https://$domain/healthz"
