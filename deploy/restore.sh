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

(cd "$backup_dir" && sha256sum -c SHA256SUMS)

restore_dir="$(mktemp -d)"
trap 'rm -rf "$restore_dir"' EXIT
if [ -f "$backup_dir/minio-data.tar.gz" ]; then
  tar -C "$restore_dir" -xzf "$backup_dir/minio-data.tar.gz"
fi

docker compose --env-file "$env_file" -f deploy/compose.yaml stop api worker web
docker compose --env-file "$env_file" -f deploy/compose.yaml exec -T postgres \
  sh -c 'pg_restore --clean --if-exists --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$backup_dir/postgres.dump"

if [ -f "$backup_dir/minio-data.tar.gz" ]; then
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml run --rm --no-deps -T \
    -v "$restore_dir:/restore:ro" \
    --entrypoint /bin/sh minio-init -c \
    'mc alias set berry-minio http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
     mc mirror --overwrite /restore/"$BERRY_ARTIFACT_S3_BUCKET" berry-minio/"$BERRY_ARTIFACT_S3_BUCKET" &&
     mc mirror --overwrite /restore/"$BERRY_AUDIT_S3_BUCKET" berry-minio/"$BERRY_AUDIT_S3_BUCKET"'
fi

docker compose --env-file "$env_file" -f deploy/compose.yaml start api worker web
echo "Restore completed from $backup_dir"
