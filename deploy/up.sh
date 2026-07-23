#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

env_file="${1:-deploy/.env}"
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy deploy/.env.example (local) or deploy/.env.production.example (production) first." >&2
  exit 1
fi

env_value() {
  sed -n "s/^${1}=//p" "$env_file" | tail -n 1
}

if grep -q "REPLACE_WITH" "$env_file"; then
  echo "$env_file still contains REPLACE_WITH placeholders." >&2
  exit 1
fi

auth_mode="$(env_value BERRY_AUTH_MODE)"
auth_mode="${auth_mode:-better-auth}"
if [ "$auth_mode" != "better-auth" ]; then
  echo "BERRY_AUTH_MODE must be better-auth. Local and production use the same owner setup flow." >&2
  exit 1
fi

auth_secret="$(env_value BETTER_AUTH_SECRET)"
if [ "${#auth_secret}" -lt 32 ]; then
  echo "BETTER_AUTH_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 36" >&2
  exit 1
fi

domain="$(env_value BERRY_DOMAIN)"
files_domain="$(env_value BERRY_FILES_DOMAIN)"
if [ -z "$domain" ] || [ -z "$files_domain" ]; then
  echo "BERRY_DOMAIN and BERRY_FILES_DOMAIN are required." >&2
  exit 1
fi
if [ "$domain" = "$files_domain" ]; then
  echo "BERRY_DOMAIN and BERRY_FILES_DOMAIN must be different hostnames." >&2
  exit 1
fi

setup_email="$(env_value BERRY_SETUP_OWNER_EMAIL)"
setup_token="$(env_value BERRY_SETUP_TOKEN)"
if { [ -n "$setup_email" ] && [ -z "$setup_token" ]; } || { [ -z "$setup_email" ] && [ -n "$setup_token" ]; }; then
  echo "Set both BERRY_SETUP_OWNER_EMAIL and BERRY_SETUP_TOKEN, or leave both blank after setup is complete." >&2
  exit 1
fi
if [ -n "$setup_token" ] && [ "${#setup_token}" -lt 32 ]; then
  echo "BERRY_SETUP_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

sandbox_provider="$(env_value BERRY_SANDBOX_PROVIDER)"
e2b_api_key="$(env_value E2B_API_KEY)"
if [ "$sandbox_provider" = "e2b" ] && [ -z "$e2b_api_key" ]; then
  echo "E2B_API_KEY is required when BERRY_SANDBOX_PROVIDER=e2b." >&2
  exit 1
fi

storage_mode="$(env_value BERRY_OBJECT_STORAGE_MODE)"
storage_mode="${storage_mode:-minio}"
if [ "$storage_mode" = "r2" ]; then
  for name in BERRY_ARTIFACT_S3_ENDPOINT BERRY_ARTIFACT_S3_BUCKET BERRY_ARTIFACT_S3_ACCESS_KEY_ID BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY BERRY_AUDIT_S3_ENDPOINT BERRY_AUDIT_S3_BUCKET BERRY_AUDIT_S3_ACCESS_KEY_ID BERRY_AUDIT_S3_SECRET_ACCESS_KEY; do
    value="$(env_value "$name")"
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
  minio_password="$(env_value MINIO_ROOT_PASSWORD)"
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

public_url="$(env_value BERRY_WEB_PUBLIC_URL)"
if [ -z "$public_url" ]; then
  public_url="https://${domain}"
fi

echo "Berry is starting at $public_url"
if [ -n "$setup_token" ]; then
  echo "First owner email: $setup_email"
  echo "One-time setup URL: ${public_url%/}/#setup=$setup_token"
else
  echo "No setup key is configured. Existing owners can sign in normally."
fi
