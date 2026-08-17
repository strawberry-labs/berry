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

deployment_profile="$(env_value BERRY_DEPLOYMENT_PROFILE)"
if [ -z "$deployment_profile" ]; then
  case "$env_file" in
    .env.production|*/.env.production) deployment_profile=production ;;
    *) deployment_profile=local ;;
  esac
fi
case "$deployment_profile" in
  local|production) ;;
  *)
    echo "BERRY_DEPLOYMENT_PROFILE must be local or production." >&2
    exit 1
    ;;
esac

for name in BERRY_API_DATABASE_PASSWORD BERRY_WORKER_DATABASE_PASSWORD BERRY_PLATFORM_DATABASE_PASSWORD; do
  value="$(env_value "$name")"
  if [ "${#value}" -lt 16 ]; then
    echo "$name must be at least 16 URL-safe characters. Generate one with: openssl rand -hex 32" >&2
    exit 1
  fi
  case "$value" in
    *[:/@]*)
      echo "$name must be URL-safe because it is used in a PostgreSQL connection URL." >&2
      exit 1
      ;;
  esac
done

auth_mode="$(env_value BERRY_AUTH_MODE)"
auth_mode="${auth_mode:-better-auth}"
if [ "$auth_mode" != "better-auth" ]; then
  echo "BERRY_AUTH_MODE must be better-auth. Local and production use the same owner setup flow." >&2
  exit 1
fi

auth_login_methods="$(env_value BERRY_AUTH_LOGIN_METHODS)"
if [ "$deployment_profile" = "production" ] && [ "$auth_login_methods" != "google" ]; then
  echo "Production requires BERRY_AUTH_LOGIN_METHODS=google for Google-only sign-in." >&2
  exit 1
fi

auth_secret="$(env_value BETTER_AUTH_SECRET)"
if [ "${#auth_secret}" -lt 32 ]; then
  echo "BETTER_AUTH_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 36" >&2
  exit 1
fi

if [ "$deployment_profile" = "production" ]; then
  connector_encryption_key="$(env_value BERRY_CONNECTOR_ENCRYPTION_KEY)"
  connector_encryption_key_bytes="$(
    printf %s "$connector_encryption_key" |
      openssl base64 -d -A 2>/dev/null |
      wc -c |
      tr -d '[:space:]'
  )"
  if [ "$connector_encryption_key_bytes" != "32" ]; then
    echo "BERRY_CONNECTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate one with: openssl rand -base64 32" >&2
    exit 1
  fi
fi

storage_mode="$(env_value BERRY_OBJECT_STORAGE_MODE)"
storage_mode="${storage_mode:-minio}"
background_worker_replicas="$(env_value BERRY_BACKGROUND_WORKER_REPLICAS)"
foreground_worker_replicas="$(env_value BERRY_FOREGROUND_WORKER_REPLICAS)"
foreground_queue_shard_count="$(env_value BERRY_FOREGROUND_QUEUE_SHARD_COUNT)"
background_worker_replicas="${background_worker_replicas:-1}"
foreground_worker_replicas="${foreground_worker_replicas:-5}"
foreground_queue_shard_count="${foreground_queue_shard_count:-$foreground_worker_replicas}"
case "$background_worker_replicas:$foreground_worker_replicas" in
  *[!0-9:]*|0:*|*:0)
    echo "BERRY_BACKGROUND_WORKER_REPLICAS and BERRY_FOREGROUND_WORKER_REPLICAS must be positive integers." >&2
    exit 1
    ;;
esac
if [ "$foreground_queue_shard_count" != "$foreground_worker_replicas" ]; then
  echo "BERRY_FOREGROUND_QUEUE_SHARD_COUNT must equal BERRY_FOREGROUND_WORKER_REPLICAS so every affinity shard has one consumer." >&2
  exit 1
fi
case "$foreground_queue_shard_count" in
  *[!0-9]*|0*)
    echo "BERRY_FOREGROUND_QUEUE_SHARD_COUNT must be a positive integer." >&2
    exit 1
    ;;
esac
if [ "$foreground_queue_shard_count" -gt 128 ]; then
  echo "BERRY_FOREGROUND_QUEUE_SHARD_COUNT must not exceed 128." >&2
  exit 1
fi
domain="$(env_value BERRY_DOMAIN)"
if [ -z "$domain" ]; then
  echo "BERRY_DOMAIN is required." >&2
  exit 1
fi
if [ "$storage_mode" = "minio" ]; then
  files_domain="$(env_value BERRY_FILES_DOMAIN)"
  if [ -z "$files_domain" ]; then
    echo "BERRY_FILES_DOMAIN is required when BERRY_OBJECT_STORAGE_MODE=minio." >&2
    exit 1
  fi
  if [ "$domain" = "$files_domain" ]; then
    echo "BERRY_DOMAIN and BERRY_FILES_DOMAIN must be different hostnames when using MinIO." >&2
    exit 1
  fi
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

mem0_api_key="$(env_value BERRY_MEM0_API_KEY)"
mem0_postgres_password="$(env_value BERRY_MEM0_POSTGRES_PASSWORD)"
mem0_llm_base_url="$(env_value BERRY_MEM0_LLM_BASE_URL)"
mem0_llm_api_key="$(env_value BERRY_MEM0_LLM_API_KEY)"
mem0_llm_model="$(env_value BERRY_MEM0_LLM_MODEL)"
mem0_embedding_base_url="$(env_value BERRY_MEM0_EMBEDDING_BASE_URL)"
mem0_embedding_api_key="$(env_value BERRY_MEM0_EMBEDDING_API_KEY)"
router_base_url="$(env_value BERRY_ROUTER_INFERENCE_BASE_URL)"
router_api_key="$(env_value BERRY_ROUTER_API_KEY)"
router_model="$(env_value BERRY_ROUTER_DEFAULT_MODEL)"
memory_model="$(env_value BERRY_MEMORY_MODEL)"
if [ "${#mem0_api_key}" -lt 16 ]; then
  echo "BERRY_MEM0_API_KEY must be at least 16 characters. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi
if [ -z "$mem0_postgres_password" ]; then
  echo "BERRY_MEM0_POSTGRES_PASSWORD is required." >&2
  exit 1
fi
if { [ -z "$mem0_llm_base_url" ] && [ -z "$router_base_url" ]; } ||
   { [ -z "$mem0_llm_api_key" ] && [ -z "$router_api_key" ]; } ||
   { [ -z "$mem0_llm_model" ] && [ -z "$memory_model" ] && [ -z "$router_model" ]; }; then
  echo "Configure BERRY_MEM0_LLM_* or the equivalent Berry Router URL, key, and model." >&2
  exit 1
fi
if { [ -z "$mem0_embedding_base_url" ] && [ -z "$router_base_url" ]; } ||
   { [ -z "$mem0_embedding_api_key" ] && [ -z "$router_api_key" ]; }; then
  echo "Configure BERRY_MEM0_EMBEDDING_* or an equivalent Berry Router URL and key." >&2
  exit 1
fi

if [ "$storage_mode" = "aws" ]; then
  for name in BERRY_DATABASE_URL BERRY_API_DATABASE_URL BERRY_WORKER_DATABASE_URL BERRY_PLATFORM_DATABASE_URL BERRY_MEM0_DATABASE_URL BERRY_ARTIFACT_S3_REGION BERRY_ARTIFACT_S3_BUCKET BERRY_AUDIT_S3_REGION BERRY_AUDIT_S3_BUCKET; do
    value="$(env_value "$name")"
    if [ -z "$value" ]; then
      echo "$name is required when BERRY_OBJECT_STORAGE_MODE=aws." >&2
      exit 1
    fi
  done
  export BERRY_STORAGE_PROXY_IMPORT='/etc/caddy/storage/native/*.caddy'
  docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.aws.yaml config --quiet
  docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.aws.yaml pull embeddings tika redis alertmanager prometheus caddy
  docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.aws.yaml build mem0 api worker web
  docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.aws.yaml up -d --remove-orphans \
    --scale "worker=$background_worker_replicas" \
    --scale "worker-foreground=$foreground_worker_replicas"
  docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.aws.yaml ps
elif [ "$storage_mode" = "r2" ]; then
  for name in BERRY_ARTIFACT_S3_ENDPOINT BERRY_ARTIFACT_S3_BUCKET BERRY_ARTIFACT_S3_ACCESS_KEY_ID BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY BERRY_AUDIT_S3_ENDPOINT BERRY_AUDIT_S3_BUCKET BERRY_AUDIT_S3_ACCESS_KEY_ID BERRY_AUDIT_S3_SECRET_ACCESS_KEY; do
    value="$(env_value "$name")"
    if [ -z "$value" ]; then
      echo "$name is required when BERRY_OBJECT_STORAGE_MODE=r2." >&2
      exit 1
    fi
  done
  export BERRY_STORAGE_PROXY_IMPORT='/etc/caddy/storage/native/*.caddy'
  docker compose --env-file "$env_file" -f deploy/compose.yaml config --quiet
  docker compose --env-file "$env_file" -f deploy/compose.yaml pull postgres mem0-postgres embeddings tika redis alertmanager prometheus caddy
  docker compose --env-file "$env_file" -f deploy/compose.yaml build mem0 api worker web
  docker compose --env-file "$env_file" -f deploy/compose.yaml up -d --remove-orphans \
    --scale "worker=$background_worker_replicas" \
    --scale "worker-foreground=$foreground_worker_replicas"
  docker compose --env-file "$env_file" -f deploy/compose.yaml ps
elif [ "$storage_mode" = "minio" ]; then
  minio_password="$(env_value MINIO_ROOT_PASSWORD)"
  if [ -z "$minio_password" ]; then
    echo "MINIO_ROOT_PASSWORD is required when BERRY_OBJECT_STORAGE_MODE=minio." >&2
    exit 1
  fi
  export BERRY_STORAGE_PROXY_IMPORT='/etc/caddy/storage/minio/*.caddy'
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml config --quiet
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml pull postgres mem0-postgres embeddings tika redis minio minio-init alertmanager prometheus caddy
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml build mem0 api worker web
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml up -d --remove-orphans \
    --scale "worker=$background_worker_replicas" \
    --scale "worker-foreground=$foreground_worker_replicas"
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml ps
else
  echo "BERRY_OBJECT_STORAGE_MODE must be aws, r2, or minio." >&2
  exit 1
fi

public_url="$(env_value BERRY_WEB_PUBLIC_URL)"
if [ -z "$public_url" ]; then
  public_url="https://${domain}"
fi

echo "Berry is starting at $public_url"
if [ -n "$setup_token" ]; then
  echo "First owner email: $setup_email"
  echo "Open ${public_url%/}/ and append #setup=<BERRY_SETUP_TOKEN> locally. The setup key is not printed."
else
  echo "No setup key is configured. Existing owners can sign in normally."
fi
