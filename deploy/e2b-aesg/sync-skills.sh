#!/usr/bin/env sh
set -eu

repo_dir="${BERRY_DEPLOY_REPO_DIR:-/opt/berry}"
tenant_id="${AESG_TENANT_ID:-00000000-0000-7000-8000-000000000001}"
env_file="$repo_dir/deploy/.env.production"
backup_dir="$repo_dir/backups/organization-skills"

if [ ! -f "$env_file" ]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$env_file" -f "$repo_dir/deploy/compose.yaml" "$@"
}

database_url=""
if ! compose ps --services --status running 2>/dev/null | grep -qx postgres; then
  database_url="$(awk -F= '/^(DATABASE_URL|BERRY_DATABASE_URL|BERRY_POSTGRES_URL)=/ { sub(/^[^=]*=/, ""); print; exit }' "$env_file")"
  case "$database_url" in
    \"*\") database_url="${database_url#\"}"; database_url="${database_url%\"}" ;;
    \'*\') database_url="${database_url#\'}"; database_url="${database_url%\'}" ;;
  esac
  if [ -z "$database_url" ]; then
    echo "Production database URL is not configured" >&2
    exit 1
  fi
  command -v psql >/dev/null 2>&1 || { echo "psql is required for managed database sync" >&2; exit 1; }
  command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump is required for managed database backup" >&2; exit 1; }
fi

database_psql() {
  if [ -n "$database_url" ]; then
    psql "$database_url" "$@"
  else
    compose exec -T postgres psql -U berry -d berry "$@"
  fi
}

database_dump() {
  if [ -n "$database_url" ]; then
    pg_dump "$database_url" "$@"
  else
    compose exec -T postgres pg_dump -U berry -d berry "$@"
  fi
}

mkdir -p "$backup_dir"
backup_file="$backup_dir/organization-capabilities-$(date -u +%Y%m%dT%H%M%SZ).sql"
umask 077
database_dump \
  --data-only \
  --table=organization_capabilities \
  --table=organization_skill_files > "$backup_file"
chmod 0600 "$backup_file"

compose exec -T api node apps/api/dist/sync-organization-skill-packages.js \
  --root /organization-skill-import \
  --tenant "$tenant_id"

database_psql -v ON_ERROR_STOP=1 -v tenant_id="$tenant_id" <<'SQL'
UPDATE organization_capability_settings
SET allow_personal_skills = true, updated_at = now()
WHERE tenant_id = :'tenant_id'::uuid;
SQL

database_psql -Atc \
  "SELECT c.capability_id || '|' || c.name || '|' || c.assignment || '|' || c.content_hash || '|' || count(f.path) FROM organization_capabilities c LEFT JOIN organization_skill_files f ON f.organization_capability_id=c.id WHERE c.tenant_id='$tenant_id'::uuid AND c.kind='skill' GROUP BY c.id ORDER BY c.capability_id;"

echo "Organization skill packages synced from deploy/skills into database package rows. Backup: $backup_file"
