# Skill package migration and recovery runbook

This runbook covers the additive skill-package tables, the organization
`research` to `deep-research` rename, and recovery of files referenced through
old task-scoped `/workspace/inputs/<file-id>/...` paths.

The database migrations and recovery are separate operations:

1. Migrations 50 and 52 create package-file storage and safely rename the
   managed research capability. They do not delete personal skills,
   organization skills, or package files.
2. The backfill copies recoverable task input objects into the owning skill
   package and rewrites only exact legacy paths. It is audit-only unless
   `--apply` is passed.

The old browser importer did not upload ancillary bytes. A legacy skill that
mentions a relative `assets/`, `scripts/`, or `references/` path but has no
matching package-file row cannot be reconstructed from the Berry database.
The audit reports these as `manual-reupload-required`; an administrator must
obtain the original `.skill` archive or source directory and re-upload it.
Berry never invents an empty replacement or silently points the skill at a
different file.

Do not combine the audit and apply steps. Keep the audit report with the change
record and resolve every `unresolved`, `path-mismatch`, or `oversized` result
before applying.

## Local integration verification

Point the harness at an isolated loopback PostgreSQL server whose account may
create temporary databases:

```sh
BERRY_INTEGRATION_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm --filter @berry/api verify:skill-package-migrations
```

The harness rejects non-loopback database URLs. It creates a random temporary
database, executes the real migration and backfill code with an in-memory
object response, verifies preservation, hashes, conflict handling, RLS flags,
and idempotency, then drops the temporary database.

## Production prerequisite checklist

- Take and retain a restorable database backup.
- Confirm the deployment revision contains migrations 50 and 52.
- Confirm migration 50 has completed before invoking the backfill; the
  `personal_skill_files` and `organization_skill_files` tables must exist.
- Use the deployment's existing database and AWS credentials. Do not copy,
  replace, print, or commit `deploy/.env.production`.
- Confirm the source objects are still available in the configured artifact
  bucket. The backfill reads objects but never changes or deletes them.

On a provisioned production host, use the API container from the deployed
revision. The host does not require Node.js or pnpm. From the Berry checkout,
define this storage-aware helper once in the current shell:

```sh
cd "${BERRY_DEPLOY_REPO_DIR:-/opt/berry}"
berry_env_file="$PWD/deploy/.env.production"
test -f "$berry_env_file"
berry_storage_mode="$(sed -n 's/^BERRY_OBJECT_STORAGE_MODE=//p' "$berry_env_file" | tail -n 1)"

case "$berry_storage_mode" in
  aws)
    berry_compose() {
      docker compose --env-file "$berry_env_file" \
        -f deploy/compose.yaml -f deploy/compose.aws.yaml "$@"
    }
    ;;
  r2)
    berry_compose() {
      docker compose --env-file "$berry_env_file" \
        -f deploy/compose.yaml "$@"
    }
    ;;
  minio)
    berry_compose() {
      docker compose --profile minio --env-file "$berry_env_file" \
        -f deploy/compose.yaml "$@"
    }
    ;;
  *)
    echo "Unsupported BERRY_OBJECT_STORAGE_MODE: $berry_storage_mode" >&2
    berry_compose() { return 1; }
    ;;
esac

berry_compose config --quiet
```

The helper passes `deploy/.env.production` to Compose without sourcing or
printing it. Keep the audit and apply commands in separate operator steps.

## Step 1: audit only

Run the compiled API command without `--apply` in the deployment environment:

```sh
berry_compose run --rm --no-deps -T api \
  node apps/api/dist/backfill-skill-packages.js
```

Audit mode opens tenant-scoped transactions and rolls them back. It does not
read object bodies, write package rows, or rewrite skill content. Review the
JSON-line diagnostics and final summary:

- `candidates`: skills containing a legacy task-scoped input path;
- `recovered`: references that can be mapped to an available file record;
- `unresolved`: missing, unavailable, wrong-owner, or path-mismatched files;
- `oversized`: packages whose projected extracted size exceeds 5 MB.
- `manualReuploadSkills`: skills that reference legacy relative package files
  whose bytes were never retained by the old importer;
- `manualReuploadReferences`: total missing relative resource paths across
  those skills.

Stop if any unresolved, oversized, or manual-reupload item is unexpected. Fix
the source record or migrate that skill manually, then repeat the audit until
the report is accepted. For `manual-reupload-required`, export or obtain the
original package, verify every reported relative path is present, and import
the complete package through Personal Skills or Organization Skills. If the
original bytes cannot be recovered, leave the existing skill unchanged and
record it for owner review; do not run apply under the assumption it was
migrated.

## Step 2: apply

Using the same reviewed revision and credentials, run:

```sh
berry_compose run --rm --no-deps -T api \
  node apps/api/dist/backfill-skill-packages.js --apply
```

Apply mode downloads each accepted source object, verifies its stored byte
size from the canonical `file_blobs` object, inserts a new package resource
without overwriting an existing path,
rewrites the exact legacy path, and recomputes the full package hash. Each
tenant is committed atomically. Existing package files and old single-file
skills are preserved. Apply does not resolve `manual-reupload-required` items.

After apply:

1. Run audit mode again; successfully migrated skills should no longer be
   candidates.
2. Export and re-import a representative personal skill and organization skill
   with a template or script.
3. Activate each representative skill in a new task and verify that its
   `SKILL.md` and resources are staged under the same runtime package revision.
4. Confirm the legacy `research` capability is either renamed to
   `deep-research`, or blocked when an administrator-created `deep-research`
   skill already existed.

If verification fails, stop skill writes, restore the database backup, and
leave artifact objects in place; the backfill never mutates them.
