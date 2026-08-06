#!/usr/bin/env sh
set -eu

repo_dir="${BERRY_DEPLOY_REPO_DIR:-/opt/berry}"
tenant_id="${AESG_TENANT_ID:-00000000-0000-7000-8000-000000000001}"
env_file="$repo_dir/deploy/.env.production"
skills_dir="$repo_dir/deploy/skills"
backup_dir="$repo_dir/backups/organization-skills"

if [ ! -f "$env_file" ]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$env_file" -f "$repo_dir/deploy/compose.yaml" "$@"
}

mkdir -p "$backup_dir"
backup_file="$backup_dir/organization-capabilities-$(date -u +%Y%m%dT%H%M%SZ).sql"
compose exec -T postgres pg_dump -U berry -d berry \
  --data-only --table=organization_capabilities > "$backup_file"

sync_skill() {
  capability_id="$1"
  display_name="$2"
  description="$3"
  skill_file="$skills_dir/$capability_id/SKILL.md"
  if [ ! -f "$skill_file" ]; then
    echo "Missing skill file: $skill_file" >&2
    exit 1
  fi
  content_hash="$(sha256sum "$skill_file" | awk '{print $1}')"
  content_b64="$(base64 -w 0 "$skill_file")"
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U berry -d berry \
    -v tenant_id="$tenant_id" \
    -v capability_id="$capability_id" \
    -v display_name="$display_name" \
    -v description="$description" \
    -v content_hash="$content_hash" \
    -v content_b64="$content_b64" <<'SQL'
INSERT INTO organization_capabilities (
  id,
  tenant_id,
  kind,
  capability_id,
  name,
  description,
  assignment,
  allow_user_disable,
  content_hash,
  config,
  created_at,
  updated_at
) VALUES (
  'orgcap_' || md5(random()::text || clock_timestamp()::text),
  :'tenant_id'::uuid,
  'skill',
  :'capability_id',
  :'display_name',
  :'description',
  'required',
  false,
  :'content_hash',
  jsonb_build_object(
    'content',
    convert_from(decode(:'content_b64', 'base64'), 'UTF8')
  ),
  now(),
  now()
)
ON CONFLICT (tenant_id, kind, capability_id)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  assignment = EXCLUDED.assignment,
  allow_user_disable = EXCLUDED.allow_user_disable,
  content_hash = EXCLUDED.content_hash,
  config = EXCLUDED.config,
  updated_at = now();
SQL
}

sync_skill "aesg-branding" "AESG branding" "AESG brand authority, retained templates, assets, and artifact QA"
sync_skill "cv-creator" "CV Creator" "Create four AESG CV files from structured data and a profile photo"
sync_skill "docx" "AESG Word documents" "Template-preserving AESG reports, letters, tables, imagery, and document control"
sync_skill "pdf" "AESG PDF documents" "AESG PDF generation through the approved Word templates, with structural and visual QA"
sync_skill "xlsx" "AESG Excel workbooks" "Branded multi-sheet AESG workbooks with formulas, validation, formatting, and charts"
sync_skill "pptx" "AESG PowerPoint presentations" "AESG General Template presentations using approved masters, semantic layouts, and imagery"

compose exec -T postgres psql -U berry -d berry -Atc \
  "SELECT capability_id || '|' || name || '|' || assignment || '|' || content_hash FROM organization_capabilities WHERE tenant_id='$tenant_id'::uuid AND kind='skill' ORDER BY capability_id;"

echo "Organization skills synced. Backup: $backup_file"
