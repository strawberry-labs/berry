#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
env_file="${BERRY_ENV_FILE:-deploy/.env.production}"
backup_root="${BERRY_BACKUP_DIR:-/var/backups/berry}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_root/$timestamp"
mkdir -p "$target"

docker compose --env-file "$env_file" -f deploy/compose.yaml exec -T postgres \
  sh -c 'pg_dump --format=custom --no-owner --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$target/postgres.dump"

storage_mode="$(sed -n 's/^BERRY_OBJECT_STORAGE_MODE=//p' "$env_file" | tail -n 1)"
storage_mode="${storage_mode:-minio}"
if [ "$storage_mode" = "minio" ]; then
  mkdir -p "$target/minio-data"
  docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml run --rm --no-deps -T \
    -v "$target/minio-data:/backup" \
    --entrypoint /bin/sh minio-init -c \
    'mc alias set berry-minio http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
     mc mirror --overwrite berry-minio/"$BERRY_ARTIFACT_S3_BUCKET" /backup/"$BERRY_ARTIFACT_S3_BUCKET" &&
     mc mirror --overwrite berry-minio/"$BERRY_AUDIT_S3_BUCKET" /backup/"$BERRY_AUDIT_S3_BUCKET"'
  tar -C "$target/minio-data" -czf "$target/minio-data.tar.gz" .
  rm -rf "$target/minio-data"
  sha256sum "$target/postgres.dump" "$target/minio-data.tar.gz" > "$target/SHA256SUMS"
else
  sha256sum "$target/postgres.dump" > "$target/SHA256SUMS"
  echo "R2 object data is external and was not copied by this database backup." > "$target/OBJECT_STORAGE.txt"
fi
echo "Backup written to $target"
