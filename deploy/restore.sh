#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ "${BERRY_RESTORE_CONFIRM:-}" != "YES" ]; then
  echo "Restore is destructive. Set BERRY_RESTORE_CONFIRM=YES and pass the backup directory." >&2
  exit 1
fi

backup_dir="${1:-}"
if [ ! -d "$backup_dir" ]; then
  echo "Backup directory not found: $backup_dir" >&2
  exit 1
fi

backup_dir="$(cd "$backup_dir" && pwd)"
env_file="${BERRY_ENV_FILE:-deploy/.env.production}"
background_worker_replicas="$(sed -n 's/^BERRY_BACKGROUND_WORKER_REPLICAS=//p' "$env_file" | tail -n 1)"
foreground_worker_replicas="$(sed -n 's/^BERRY_FOREGROUND_WORKER_REPLICAS=//p' "$env_file" | tail -n 1)"
background_worker_replicas="${background_worker_replicas:-1}"
foreground_worker_replicas="${foreground_worker_replicas:-5}"
case "$background_worker_replicas:$foreground_worker_replicas" in
  *[!0-9:]*|0:*|*:0)
    echo "Worker replica counts must be positive integers in $env_file." >&2
    exit 1
    ;;
esac

(cd "$backup_dir" && sha256sum -c SHA256SUMS)

restore_dir="$(mktemp -d)"
trap 'rm -rf "$restore_dir"' EXIT
if [ -f "$backup_dir/minio-data.tar.gz" ]; then
  tar -C "$restore_dir" -xzf "$backup_dir/minio-data.tar.gz"
fi

docker compose --env-file "$env_file" -f deploy/compose.yaml stop api worker worker-foreground mem0 alertmanager prometheus web
docker compose --env-file "$env_file" -f deploy/compose.yaml exec -T postgres \
  sh -c 'pg_restore --clean --if-exists --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$backup_dir/postgres.dump"

if [ -f "$backup_dir/mem0-postgres.dump" ]; then
  docker compose --env-file "$env_file" -f deploy/compose.yaml exec -T mem0-postgres \
    sh -c 'pg_restore --clean --if-exists --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
    < "$backup_dir/mem0-postgres.dump"
fi

if [ -f "$backup_dir/minio-data.tar.gz" ]; then
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml run --rm --no-deps -T \
    -v "$restore_dir:/restore:ro" \
    --entrypoint /bin/sh minio-init -c \
    'mc alias set berry-minio http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
     mc mirror --overwrite /restore/"$BERRY_ARTIFACT_S3_BUCKET" berry-minio/"$BERRY_ARTIFACT_S3_BUCKET" &&
     mc mirror --overwrite /restore/"$BERRY_AUDIT_S3_BUCKET" berry-minio/"$BERRY_AUDIT_S3_BUCKET"'
fi

docker compose --env-file "$env_file" -f deploy/compose.yaml up -d \
  --scale "worker=$background_worker_replicas" \
  --scale "worker-foreground=$foreground_worker_replicas" \
  mem0 api worker worker-foreground alertmanager prometheus web
echo "Restore completed from $backup_dir"
