#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${BERRY_AWS_ENV_FILE:-$repo_dir/deploy/.env.production}"

: "${BERRY_AWS_PROFILE:?Set BERRY_AWS_PROFILE to the isolated AWS CLI profile}"

for command in aws jq openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is not installed: $command" >&2
    exit 1
  fi
done

region="${BERRY_AWS_REGION:-eu-west-1}"
stack_name="${BERRY_AWS_STACK_NAME:-berry-production}"
temporary_file=""
master_secret=""
master_password=""

cleanup() {
  if [[ -n "$temporary_file" && -f "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
  unset master_secret master_password
}
trap cleanup EXIT INT TERM

if [[ ! -f "$env_file" ]]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi

env_value() {
  sed -n "s/^${1}=//p" "$env_file" | tail -n 1
}

stack_output() {
  aws cloudformation describe-stacks \
    --profile "$BERRY_AWS_PROFILE" \
    --region "$region" \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='${1}'].OutputValue | [0]" \
    --output text
}

uri_encode() {
  jq -nr --arg value "$1" '$value | @uri'
}

update_env() {
  local key="$1"
  local value="$2"
  local found=false
  temporary_file="$(mktemp "${env_file}.tmp.XXXXXX")"
  chmod 0600 "$temporary_file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s=%s\n' "$key" "$value" >>"$temporary_file"
      found=true
    else
      printf '%s\n' "$line" >>"$temporary_file"
    fi
  done <"$env_file"
  if [[ "$found" == false ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$temporary_file"
  fi
  mv -f -- "$temporary_file" "$env_file"
  temporary_file=""
}

database_endpoint="$(stack_output DatabaseEndpoint)"
database_name="$(stack_output DatabaseName)"
database_secret_arn="$(stack_output DatabaseSecretArn)"
artifact_bucket="$(stack_output ArtifactBucketName)"
audit_bucket="$(stack_output AuditBucketName)"

for value in "$database_endpoint" "$database_name" "$database_secret_arn" "$artifact_bucket" "$audit_bucket"; do
  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "Stack $stack_name is missing a required output." >&2
    exit 1
  fi
done

master_secret="$(aws secretsmanager get-secret-value \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --secret-id "$database_secret_arn" \
  --query SecretString \
  --output text)"
master_username="$(printf '%s' "$master_secret" | jq -er '.username')"
master_password="$(printf '%s' "$master_secret" | jq -er '.password')"

api_password="$(env_value BERRY_API_DATABASE_PASSWORD)"
worker_password="$(env_value BERRY_WORKER_DATABASE_PASSWORD)"
platform_password="$(env_value BERRY_PLATFORM_DATABASE_PASSWORD)"
mem0_username="$(env_value BERRY_MEM0_POSTGRES_USER)"
mem0_password="$(env_value BERRY_MEM0_POSTGRES_PASSWORD)"
mem0_database="$(env_value BERRY_MEM0_POSTGRES_DB)"
mem0_username="${mem0_username:-mem0}"
mem0_database="${mem0_database:-mem0}"

if [[ -z "$mem0_password" ]]; then
  mem0_password="$(openssl rand -hex 32)"
fi

for value in "$api_password" "$worker_password" "$platform_password"; do
  if [[ -z "$value" ]]; then
    echo "The production environment is missing a database password." >&2
    exit 1
  fi
done

encoded_database_name="$(uri_encode "$database_name")"
master_url="postgres://$(uri_encode "$master_username"):$(uri_encode "$master_password")@${database_endpoint}:5432/${encoded_database_name}?sslmode=require"
api_url="postgres://berry_api:$(uri_encode "$api_password")@${database_endpoint}:5432/${encoded_database_name}?sslmode=require"
worker_url="postgres://berry_worker:$(uri_encode "$worker_password")@${database_endpoint}:5432/${encoded_database_name}?sslmode=require"
platform_url="postgres://berry_platform:$(uri_encode "$platform_password")@${database_endpoint}:5432/${encoded_database_name}?sslmode=require"
mem0_url="postgres://$(uri_encode "$mem0_username"):$(uri_encode "$mem0_password")@${database_endpoint}:5432/${mem0_database}?sslmode=require"

update_env BERRY_DATABASE_URL "$master_url"
update_env BERRY_API_DATABASE_URL "$api_url"
update_env BERRY_WORKER_DATABASE_URL "$worker_url"
update_env BERRY_PLATFORM_DATABASE_URL "$platform_url"
update_env BERRY_MEM0_DATABASE_URL "$mem0_url"
update_env BERRY_MEM0_POSTGRES_DB "$mem0_database"
update_env BERRY_MEM0_POSTGRES_USER "$mem0_username"
update_env BERRY_MEM0_POSTGRES_PASSWORD "$mem0_password"
update_env BERRY_ARTIFACT_S3_BUCKET "$artifact_bucket"
update_env BERRY_AUDIT_S3_BUCKET "$audit_bucket"
chmod 0600 "$env_file"

echo "Updated RDS and S3 infrastructure values in $env_file without printing credentials."
