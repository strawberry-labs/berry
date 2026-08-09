#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <rds-endpoint> <rds-secret-arn> <production-env-file>" >&2
  exit 1
fi

database_endpoint="$1"
database_secret_arn="$2"
env_file="$3"
region="${BERRY_AWS_REGION:-eu-west-1}"
master_secret=""
PGPASSWORD=""

for command in aws jq psql; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is not installed: $command" >&2
    exit 1
  fi
done

cleanup() {
  unset master_secret PGPASSWORD mem0_password
}
trap cleanup EXIT INT TERM

if [[ ! -f "$env_file" ]]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi

env_value() {
  sed -n "s/^${1}=//p" "$env_file" | tail -n 1
}

mem0_username="$(env_value BERRY_MEM0_POSTGRES_USER)"
mem0_password="$(env_value BERRY_MEM0_POSTGRES_PASSWORD)"
mem0_database="$(env_value BERRY_MEM0_POSTGRES_DB)"
mem0_username="${mem0_username:-mem0}"
mem0_database="${mem0_database:-mem0}"

if [[ ! "$mem0_username" =~ ^[a-zA-Z][a-zA-Z0-9_]*$ ]]; then
  echo "BERRY_MEM0_POSTGRES_USER must be a PostgreSQL identifier." >&2
  exit 1
fi
if [[ ! "$mem0_database" =~ ^[a-zA-Z][a-zA-Z0-9_]*$ ]]; then
  echo "BERRY_MEM0_POSTGRES_DB must be a PostgreSQL identifier." >&2
  exit 1
fi
if [[ -z "$mem0_password" ]]; then
  echo "BERRY_MEM0_POSTGRES_PASSWORD is required." >&2
  exit 1
fi

master_secret="$(aws secretsmanager get-secret-value \
  --region "$region" \
  --secret-id "$database_secret_arn" \
  --query SecretString \
  --output text)"
PGUSER="$(printf '%s' "$master_secret" | jq -er '.username')"
PGPASSWORD="$(printf '%s' "$master_secret" | jq -er '.password')"
export PGHOST="$database_endpoint" PGPORT=5432 PGUSER PGPASSWORD PGSSLMODE=require

psql --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=mem0_user="$mem0_username" \
  --set=mem0_password="$mem0_password" \
  --set=mem0_database="$mem0_database" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'mem0_user',
  :'mem0_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'mem0_user')
\gexec

SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L',
  :'mem0_user',
  :'mem0_password'
)
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'mem0_database', :'mem0_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'mem0_database')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'mem0_database', :'mem0_user')
\gexec

SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'mem0_database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'mem0_database', :'mem0_user')
\gexec
SQL

psql --dbname "$mem0_database" --set=ON_ERROR_STOP=1 \
  --set=mem0_user="$mem0_username" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'mem0_user')
\gexec
SQL

echo "Prepared the private mem0 database and login without printing credentials."
