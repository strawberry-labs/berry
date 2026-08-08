# Plan 005: Preserve conversation files and garbage-collect deduplicated blobs safely

> **Executor instructions**: Follow this plan in order. Run every verification
> command and confirm the expected result before moving on. Preserve all
> pre-existing user files and changes. Do not commit, push, or deploy unless the
> operator explicitly requests it. If a STOP condition occurs, report it and do
> not improvise.
>
> **Drift check (run first)**:
> `git diff --stat 5e826d3..HEAD -- packages/db/src packages/shared/src packages/api-client/src apps/api/src/files apps/api/src/runtime apps/worker/src packages/desktop-ui/src/components/generated-image-gallery.tsx packages/desktop-ui/src/components/generated-image-gallery.module.css apps/web/src/components/library apps/web/src/components/tasks apps/web/tests deploy docs`
>
> If an in-scope file changed, compare the current-state excerpts below with the
> live code. A behavioral mismatch is a STOP condition until the plan is
> reconciled.

## Status

- **Priority**: P1
- **Effort**: L (roughly 2–4 focused engineering days, plus a seven-day physical-deletion grace period)
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug, migration, tech-debt
- **Planned at**: commit `5e826d3`, 2026-08-06

## Why this matters

`DELETE /v1/files/:fileId` currently tombstones the complete logical file and
immediately queues its original object and derivatives for physical deletion.
Conversation message parts retain `/v1/files/:fileId/content`, so an image that
was removed from Library becomes a broken image shell in its original
conversation. The same deletion also invalidates project access for every user
who could reach that single file row.

Berry also stores `sha256`, but ordinary browser uploads are not server-verified
and there is no hash uniqueness or physical-blob ownership model. The target is
to separate physical bytes from logical files and their references: removing a
Library entry changes only that user's Library; conversations and projects keep
working; object storage is reclaimed only after every live reference is gone.

## Product contract and non-negotiable invariants

| Operation | Required result |
|---|---|
| Remove from Library | Tombstone only the requesting user's Library membership. Do not alter conversations, projects, knowledge, or other users. |
| Open an old conversation | Continue serving the file while that conversation/task association exists. |
| Unlink a project file | Remove only that workspace link and its knowledge source; retain Library and conversation references. |
| Delete bytes | Delete original S3 versions only after no live logical file references the blob and the rollback grace period expires. |
| Deduplicate | Reuse bytes only inside one tenant, using a SHA-256 digest calculated by Berry from the stored object. Never trust a client-provided digest as proof. |
| Missing historical asset | Render a compact unavailable-file card with no broken browser icon and no edit/download controls. |

Additional invariants:

1. Reference counts are derived from authoritative rows inside transactions;
   do not add a mutable `ref_count` column that can drift.
2. A conversation association, active workspace link, active Library
   membership, in-progress upload, or knowledge source backed by an active
   workspace link prevents logical garbage collection. An orphan knowledge
   source must be tombstoned and re-evaluated; it must not pin storage forever.
3. Task soft deletion continues retaining files because tasks are restorable.
   File associations disappear only when their referenced records are hard
   deleted or explicitly detached.
4. Deduplication is tenant-scoped. Do not expose whether another tenant or user
   already owns the same bytes.
5. Object deletion remains outbox-driven, retryable, idempotent, and receipt
   acknowledged only after every object version and delete marker is removed.

## Target data model

```text
file_blobs (one physical object, tenant-scoped, server-verified hash)
    1
    └── N files (logical file metadata: owner, name, origin, status)
            ├── N file_library_entries (per-user Library visibility)
            ├── N file_associations (task/session/message/turn history)
            ├── N workspace_files (project visibility)
            ├── N knowledge_sources (derived project knowledge)
            └── N file_derivatives (previews/extractions; cleaned separately)
```

Add `file_blobs` with these fields:

- `id`, `tenant_id`, `bucket`, `object_key`, `size_bytes`;
- nullable `sha256` until server verification finishes;
- `etag`, `object_version_id`;
- `verification_status`: `unverified`, `verifying`, `verified`, `failed`,
  `pending_delete`, or `deleted`;
- `verified_at`, `delete_after`, `deleted_at`, `metadata`, `created_at`,
  `updated_at`;
- unique `(tenant_id, bucket, object_key)`;
- partial unique `(tenant_id, sha256, size_bytes)` where the digest is not null,
  status is `verified`, and `deleted_at IS NULL`;
- tenant RLS matching every other tenant-owned table.

Add `files.blob_id UUID NULL REFERENCES file_blobs(id) ON DELETE RESTRICT`.
Keep the existing `files.bucket`, `object_key`, `etag`, `object_version_id`, and
`sha256` columns during this plan as rollback compatibility shadows. New code
must read the blob row first and fall back to the legacy file columns only when
`blob_id` is null. Do not drop or weaken the existing legacy object-key unique
constraint in this plan.

Add `file_library_entries` with `id`, `tenant_id`, `user_id`, `file_id`,
`created_at`, `updated_at`, and nullable `deleted_at`. Enforce one row per
`(tenant_id, user_id, file_id)` and add tenant/user/active-list indexes plus
tenant RLS. Re-adding a file to Library must revive the same row idempotently.

## Current state

- `packages/db/src/index.ts:453-494` defines one `files.owner_user_id` and no
  Library membership table. `file_associations` records task/session/message
  use but has no role in current physical deletion.

- `apps/api/src/files/file-platform.service.ts:181-203` allocates a unique
  user/file object key and stores an optional caller-provided `sha256`; it does
  not use that hash for deduplication.

  ```ts
  const objectKey = `${config.prefix}/tenants/${tenantId}/users/${userId}/files/${fileId}/original/${name}`;
  // ...
  INSERT INTO files (... sha256, bucket, object_key ...)
  ```

- `apps/api/src/files/file-platform.service.ts:536-597` locks the owned file,
  tombstones every project/knowledge link, marks the complete file deleted, and
  immediately writes `file.delete-object` outbox rows containing the original
  and derivative keys.

- `apps/web/src/components/library/artifact-library.tsx:123-138` calls
  `client.deleteFile(file.id)`. Its confirmation at lines 223-229 explicitly
  says the action removes the file from every task and project.

- `packages/desktop-ui/src/components/generated-image-gallery.tsx:124-170`
  always renders `ProgressiveImage` and download/edit controls. Although
  `ProgressiveImage` accepts `onError`, `GeneratedImageCard` does not pass or
  handle it, so a 404 leaves a broken image element.

- `apps/worker/src/file-deletion.ts:28-89` correctly enumerates and removes all
  S3 versions, handles exact-key pagination, rejects partial failures, and
  acknowledges the outbox only after deletion. Preserve this behavior.

- `apps/api/src/db/cloud-database.service.ts:49-56` runs tenant work inside one
  database transaction when the executor supports transactions. Use this
  boundary for all reference mutation and garbage-collection decisions.

- `apps/api/src/runtime/durable-turn.service.ts:1660-1710` and
  `apps/api/src/http/cloud-task-store.ts:630-650` hard-delete message ranges.
  Foreign-key cascades remove `file_associations`, but no current hook checks
  whether those files became unreferenced.

- `apps/worker/src/maintenance.ts` has no orphan-file/blob phase. It must become
  the crash/cascade safety net rather than relying only on API call paths.

## Repository conventions to preserve

- Migrations are ordered additive constants in `packages/db/src/index.ts` and
  are applied transactionally by `CloudDatabaseService.migrate`. Migration 42
  is currently latest; this plan uses migration 43.
- New tenant tables enable and force RLS, then create a direct
  `berry_current_tenant_id()` policy. Match `FILE_PLATFORM_MIGRATION`.
- Durable side effects are inserted into `runtime_outbox` in the same
  transaction as state changes. Match the existing knowledge and file deletion
  paths.
- API services throw Nest `NotFoundException` for inaccessible resources and
  validate route bodies with strict Zod schemas.
- UI colors, borders, text, and focus states use existing `--berry-*` variables.
  Keep 14px body, 12px secondary, and 11px metadata sizing.
- Production schema changes deploy API, worker, and web through
  `deploy/server-deploy.sh`; `deploy/.env.production` is never generated,
  replaced, or committed.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| DB tests | `pnpm --filter @berry/db test` | exit 0; migration 43 tests pass |
| Shared/API client tests | `pnpm --filter @berry/shared --filter @berry/api-client test` | exit 0 |
| API tests | `pnpm --filter @berry/api test -- file-platform durable-turn` | exit 0 |
| Worker tests | `pnpm --filter @berry/worker test -- file-deletion file-blobs outbox maintenance knowledge` | exit 0 |
| Shared UI tests | `pnpm --filter @berry/desktop-ui test` | exit 0 |
| Web tests | `pnpm --filter @berry/web test` | exit 0 |
| Focused typecheck | `pnpm --filter @berry/web... typecheck && pnpm --filter @berry/api... typecheck && pnpm --filter @berry/worker... typecheck` | all exit 0 |
| Web build | `pnpm --filter @berry/web... build` | exit 0 |
| Deployment classification | `pnpm check:deploy` | exit 0 |

## Suggested executor toolkit

- Use the `nestjs-best-practices` skill, if available, when changing the file
  controller/service boundary and dependency injection.
- Use the `i-have-adhd` skill for progress updates and the final handoff.
- Do not use a UI redesign skill: the required UI is a compact error state
  inside the existing generated-image component.

## Scope

**In scope**:

- `packages/db/src/index.ts`, `packages/db/src/index.test.ts`
- `packages/shared/src/index.ts` and its focused tests if response contracts change
- `packages/api-client/src/index.ts`, `packages/api-client/src/index.test.ts`
- `apps/api/src/files/file-platform.controller.ts` and tests
- `apps/api/src/files/file-platform.service.ts` and tests
- message-range deletion callers under `apps/api/src/runtime/` and
  `apps/api/src/http/cloud-task-store.ts`, with focused tests
- `apps/worker/src/jobs.ts`, `processor.ts`, `outbox.ts`, `main.ts`, and tests
- `apps/worker/src/file-deletion.ts` and tests
- `apps/worker/src/file-blobs.ts` and `file-blobs.test.ts` (create)
- `apps/worker/src/maintenance.ts` and tests
- `apps/worker/src/sandbox-continuity.ts` and tests
- `apps/worker/src/knowledge/repository.ts` and tests
- `packages/desktop-ui/src/components/generated-image-gallery.tsx`
- `packages/desktop-ui/src/components/generated-image-gallery.module.css`
- generated-image tests and, only if required for DOM coverage,
  `packages/desktop-ui/package.json` plus `pnpm-lock.yaml`
- `apps/web/src/components/library/artifact-library.tsx` and tests
- `apps/web/src/components/tasks/web-task-view.tsx` only if the adapter needs a
  deleted-file callback
- `apps/web/tests/file-lifecycle.spec.ts` (create)
- `docs/file-lifecycle.md` (create) and a short link from the relevant
  operations/deployment documentation
- `deploy/deployment-impact.sh` and its test only if a new shared package is
  introduced; prefer not to introduce one
- `plans/README.md` status row for Plan 005

**Out of scope**:

- Cross-tenant physical deduplication.
- A user-facing “delete everywhere” action. This plan makes Library removal
  safe; explicit global purge requires separate product/authorization design.
- Quota or billing changes based on logical versus physical bytes.
- Dropping legacy storage columns or the legacy object-key unique constraint.
- Desktop, mobile, extension, CLI, or release-packaging UI work.
- Hard-deleting soft-deleted tasks or changing task retention policy.
- Replacing object storage, changing bucket encryption, or exposing direct
  object keys to the browser.

## Git workflow

- Work on the current `main` branch, matching the operator's stated preference.
- Preserve unrelated untracked files (`Ops Team (AI Access).xlsx`, `outputs/`,
  and `tmp/` were present when this plan was written).
- Use conventional commit messages if the operator later asks for commits;
  an appropriate final message is `fix: make file deletion reference safe`.
- Do not commit, push, or deploy until explicitly requested after review.

## Steps

### Step 1: Add characterization tests before changing behavior

Extend the existing file platform, durable message deletion, worker deletion,
and generated-image tests to pin current contracts. Add failing regression
tests for the desired behavior:

1. Removing a Library entry does not modify `file_associations`, active
   `workspace_files`, or `knowledge_sources`.
2. A conversation-associated image remains readable after Library removal.
3. A file shared by two users' Library entries remains visible to the second
   user after the first user removes it.
4. A zero-reference file becomes logically deleted, but its blob is scheduled
   no earlier than seven days later.
5. A truly unavailable generated image renders a named fallback without edit,
   regenerate, open, or download controls.

Model service tests after
`apps/api/src/files/file-platform.service.test.ts:318-427`; model object-deletion
tests after `apps/worker/src/file-deletion.test.ts`; use Playwright for the
actual image `error` event if the shared UI package has no DOM test runtime.

**Verify**:

- Existing tests still pass.
- New regression tests fail for the expected old behavior, not because of
  invalid fixtures or missing test dependencies.

### Step 2: Add migration 43 and backfill without deleting data

In `packages/db/src/index.ts`:

1. Define Drizzle tables for `fileBlobs` and `fileLibraryEntries` and add
   nullable `blobId` to `files`.
2. Add `FILE_REFERENCE_SAFE_LIFECYCLE_MIGRATION` as migration 43 named
   `file_reference_safe_lifecycle_v1`.
3. Create both tables, checks, partial uniqueness, indexes, forced RLS, and
   tenant policies.
4. Add `files.blob_id` with an `ON DELETE RESTRICT` foreign key.
5. Backfill exactly one unverified blob row per existing file using its current
   bucket/object key/size/ETag/version. Set the new blob SHA to null even when
   `files.sha256` is populated because historical provenance does not prove it
   was server-verified.
6. Backfill one active Library entry for each non-deleted file with a non-null
   `owner_user_id`. Files without an owner are retained but receive no invented
   user membership.
7. Update `CLOUD_SCHEMA_TABLES`/tenant-scoped table lists and migration tests.

The migration must be idempotent and additive. It must not delete or rewrite
existing messages, file associations, workspace files, knowledge rows, or S3
objects.

**Verify**:

`pnpm --filter @berry/db test` → exit 0, migration ids end at 43, both tables
have forced RLS, and tests assert the migration contains no `DROP TABLE`,
`DROP COLUMN`, or object deletion.

### Step 3: Introduce one physical-location resolver and dual-read all paths

Create small typed helpers in the existing API and worker file modules rather
than a new shared runtime package. Every physical read must resolve:

```sql
COALESCE(blob.bucket, file.bucket) AS resolved_bucket,
COALESCE(blob.object_key, file.object_key) AS resolved_object_key
```

Use blob SHA/size/ETag/version when present, while retaining logical name,
origin, owner, and status from `files`.

Update at least these paths:

- API `get`, `list`, `listWorkspaceFiles`, `streamContent`, multipart complete,
  generated-image persistence, sandbox-output registration, runtime attachment
  resolution, and DTO mapping;
- durable turn attachment authorization and worker `inputFiles`;
- worker `persistOutput`, `publishedOutputs`, maintenance backfill, and
  knowledge source loading/extraction cleanup;
- any SQL found by `rg -n 'f\.(bucket|object_key|etag|object_version_id|sha256)' apps/api/src apps/worker/src`.

New writes must create a blob row, set `files.blob_id`, and create/revive the
owner's `file_library_entries` row atomically, while continuing to populate
legacy physical columns for rollback compatibility. This applies to multipart
uploads, API-generated images, registered sandbox outputs, and durable-worker
outputs. Do not make deduplication active yet; each new write initially owns an
unverified blob.

Replace the current `ON CONFLICT (tenant_id, object_key)` behavior in sandbox
output registration that can overwrite `owner_user_id`. A retry may reuse an
existing logical file only when tenant, stable logical file id, and creator
match; an unexpected cross-user collision must fail closed rather than transfer
ownership.

When creating a file reference, lock the logical file row and reject
`deleted_at IS NOT NULL`. This lock becomes the serialization point shared with
garbage collection.

**Verify**:

- Focused API/worker tests pass with both migrated `blob_id` fixtures and legacy
  null-`blob_id` fixtures.
- `rg -n 'f\.(bucket|object_key)' apps/api/src apps/worker/src` shows only
  documented compatibility fallbacks, migration/backfill code, or tests.

### Step 4: Change DELETE into idempotent “Remove from Library” semantics

Rename the service operation to `removeFromLibrary` and the API client method
to `removeFileFromLibrary`. Keep a deprecated `deleteFile` client alias only if
another checked-in caller still needs it; all Berry web UI must use the new
name.

`DELETE /v1/files/:fileId` remains authenticated and keeps its `{ ok: true }`
response for compatibility, but it must:

1. lock the logical file and the requesting user's Library entry;
2. tombstone only that `file_library_entries` row;
3. leave `file_associations`, `workspace_files`, `knowledge_sources`, and other
   users' Library rows unchanged;
4. invoke the zero-reference logical-file check from Step 5;
5. return success for an already-removed membership owned by the same user,
   without letting a foreign user probe the file.

Change the main Library query from `files.owner_user_id = userId` to an active
`file_library_entries` join. Update accessible-file authorization so a user can
read a file through any one of:

- an active Library membership;
- a file association to a task/session/message the user may access;
- an active accessible project link.

Remove unconditional owner access once the reference predicates are covered.
Update durable input-file admission to reuse the same access rules instead of
requiring `owner_user_id` equality.

Change the Library dialog copy to:

- title: `Remove {name} from Library?`
- description: `The file will remain in conversations and projects where it is used. Storage is cleaned up after nothing references it.`
- action: `Remove from Library`
- success toast: `{name} removed from Library`

**Verify**:

`pnpm --filter @berry/api test -- file-platform && pnpm --filter @berry/api-client test && pnpm --filter @berry/web test` → exit 0 and regression tests prove conversation/project/other-user rows remain untouched.

### Step 5: Add transaction-safe logical-file and blob garbage collection

Add a helper that runs while the logical file row is locked. It may mark a file
deleted only when all of these are absent:

- active `file_library_entries`;
- any `file_associations` row;
- active `workspace_files`;
- active `knowledge_sources` for that file that are backed by an active
  `workspace_files` row;
- an uploading or not-yet-settled `file_uploads` row.

When the last reference disappears:

1. tombstone any knowledge source with no active workspace link and enqueue
   `knowledge.delete` in the same transaction, then re-run the reference check;
2. set `files.status='deleted'` and `files.deleted_at` idempotently;
3. enqueue derivative-key cleanup using the existing exact-key deletion path;
4. lock the referenced blob;
5. if another non-deleted logical file points to the blob, retain it;
6. otherwise set the blob to `pending_delete`, set `delete_after` to at least
   seven days in the future, and insert a durable blob-deletion outbox event
   whose `available_at` matches `delete_after`.

Add a new `file.delete-blob` worker payload keyed by `blobId`; do not reinterpret
already-persisted `file.delete-object` payloads. Reuse the existing S3
version/delete-marker enumeration but add a blob-specific receipt check against
the matching outbox aggregate.

Collect file IDs before hard message-range deletion and run the logical GC
check after the cascading delete, inside the same transaction. Add an
`orphan_files` maintenance phase that finds zero-reference logical files in
bounded `FOR UPDATE SKIP LOCKED` batches. This phase is the repair path for
foreign-key cascades, interrupted API work, and legacy inconsistencies.

Do not treat a soft-deleted task as an absent reference. Its associations remain
live until hard retention removes them.

**Verify**:

`pnpm --filter @berry/api test -- durable-turn file-platform && pnpm --filter @berry/worker test -- file-deletion outbox maintenance` → exit 0. Tests must cover last-reference races, idempotent retries, a shared blob, partial S3 failure, delayed delivery, and maintenance repair.

### Step 6: Add server-verified, tenant-scoped blob deduplication

Add `file.verify-blob` to the worker job schema/processor and create
`apps/worker/src/file-blobs.ts`.

For each unverified blob:

1. claim it with a row lock and an idempotent `verifying` transition;
2. stream the exact S3 object through Node `createHash('sha256')`; never buffer
   the full object and never accept the client digest as verification;
3. confirm streamed byte count equals `size_bytes`;
4. in a new transaction, lock the blob and search only the same tenant for an
   active verified blob with identical SHA-256 and size;
5. if none exists, mark this blob verified and update its logical files'
   compatibility SHA values;
6. if a winner exists, repoint all logical `files.blob_id` references to the
   winner, mark the duplicate blob `pending_delete`, and schedule its physical
   key for deletion after the seven-day rollback grace period;
7. handle a concurrent partial-unique-index conflict by reloading the winner
   and completing the loser path, not by failing permanently.

Multipart completion must enqueue verification transactionally. API-generated
images and sandbox artifacts already calculate hashes locally, but they should
still use the same finalization state machine; an internally calculated digest
may be recorded as an expectation, not as a substitute for the streamed
verification until tests prove every write path covers the exact stored bytes.

Backfilled legacy blobs are not automatically flooded into the queue during
migration. Extend the maintenance CLI with an explicit, resumable
`verify_file_blobs` phase/run that enqueues bounded batches. It must be safe to
pause, resume, and rerun.

Never disclose a dedupe hit in upload responses, timing-dependent API fields,
or user-visible notifications.

**Verify**:

`pnpm --filter @berry/worker test -- file-blobs sandbox-continuity maintenance && pnpm --filter @berry/api test -- file-platform` → exit 0. Tests must cover different tenants with the same digest, same-tenant winners, size mismatch, read failure/retry, concurrent verification, logical-file repointing, and delayed loser deletion.

### Step 7: Render unavailable historical images gracefully

In `GeneratedImageCard`, track load failure per image id and pass `onError` to
`ProgressiveImage`. On failure, replace both image layers with a compact card
that preserves the expected aspect ratio and shows:

- file/image icon;
- original title;
- `Image unavailable`;
- `This image was deleted or you no longer have access.`

Do not show edit, regenerate, fullscreen, or download controls for a failed
asset. The lightbox center and rail must also avoid broken `<img>` elements if
an asset fails after the lightbox opens. Reset failure state when the image id
or source changes.

Use existing Berry theme variables and reduced-motion behavior. Do not perform
an eager `HEAD` request; rely on the actual authenticated image request so the
browser does not double network traffic.

This fallback is defense in depth. The primary regression test must still prove
that removing an item from Library leaves a conversation-associated image
loadable rather than showing the fallback.

**Verify**:

- `pnpm --filter @berry/desktop-ui test` → exit 0.
- `pnpm --dir apps/web exec playwright test tests/file-lifecycle.spec.ts` → exit 0 and screenshots/DOM assertions show no broken image icon.

### Step 8: Add the end-to-end lifecycle test and operator runbook

Create `apps/web/tests/file-lifecycle.spec.ts` covering:

1. generate or fixture an image in a conversation;
2. confirm it appears in Library and conversation;
3. remove it from Library;
4. revisit/refresh the conversation and confirm the image still loads;
5. confirm Library no longer lists it;
6. simulate an actually unavailable historical source and assert the graceful
   fallback;
7. verify a project/member reference is not invalidated by another user's
   Library removal.

Create `docs/file-lifecycle.md` describing the logical/physical model,
reference definitions, tenant dedupe boundary, verification jobs, GC grace,
outbox repair, metrics to watch, and recovery commands. Include a rollout:

1. take and verify Postgres and object-storage backups;
2. deploy migration 43 plus API/worker/web together;
3. confirm migration/RLS/indexes and smoke-test new uploads;
4. confirm Library removal preserves a conversation and project file;
5. monitor verification/outbox failures before running legacy backfill;
6. start one bounded legacy verification run for the self-host tenant;
7. wait through the seven-day grace before judging physical storage savings;
8. roll back application images only during the grace window; retain the
   additive schema. A database rollback requires stopping writers and restoring
   the verified backup.

Document queries by column/table name but never include credentials or contents
from `deploy/.env.production`.

**Verify**:

- `rg -n 'file_blobs|file_library_entries|seven-day|rollback|outbox|tenant' docs/file-lifecycle.md` → all terms are present.
- `pnpm --dir apps/web exec playwright test tests/file-lifecycle.spec.ts` → exit 0.

### Step 9: Run the complete focused release gate

Run exactly:

```sh
pnpm --filter @berry/db test
pnpm --filter @berry/shared --filter @berry/api-client test
pnpm --filter @berry/api test
pnpm --filter @berry/worker test
pnpm --filter @berry/desktop-ui test
pnpm --filter @berry/web test
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
pnpm --dir apps/web exec playwright test tests/file-lifecycle.spec.ts
pnpm check:deploy
git diff --check
git status --short
```

**Verify**: every command exits 0. `git status --short` contains only the
approved in-scope changes plus the pre-existing unrelated untracked files.

## Test plan

### Database and migration

- Migration 43 ordering and idempotence.
- RLS/forced RLS on both new tables.
- Partial verified-hash uniqueness is tenant-scoped and size-aware.
- Existing files backfill one blob each without trusting historical hashes.
- Owner memberships backfill; ownerless files are retained.
- No destructive migration statements.

### API and authorization

- Remove active Library membership, retry removal, and reject foreign probes.
- Preserve same-user and other-user conversations/projects.
- Library listing uses membership, not owner.
- Content access through Library, task association, and project association.
- Last-reference logical deletion and shared-blob retention.
- Message edit/delete cascades trigger candidate GC without affecting retained
  files.

### Worker and storage

- Streamed digest/byte-count verification.
- Same hash within one tenant deduplicates; same hash in different tenants does
  not.
- Verification and deletion retries are idempotent.
- Unique-index races converge on one winner.
- All S3 versions/delete markers are removed only after the grace period.
- Partial S3 failures leave the outbox pending.
- Maintenance repairs zero-reference and unverified legacy rows in bounded
  resumable batches.

### Web and shared UI

- Confirmation and toast say “Remove from Library”.
- Conversation image survives Library removal and refresh.
- Failed images show the graceful unavailable state.
- Failed images expose no edit, regenerate, lightbox, or download action.
- Project/member reference survives another user's Library removal.

## Done criteria

- [ ] `DELETE /v1/files/:fileId` removes only the current user's Library entry.
- [ ] Conversation, project, and knowledge references are unchanged by Library removal.
- [ ] Files remain readable through authorized conversation/project references.
- [ ] `file_blobs` and `file_library_entries` are migrated, backfilled, indexed, and protected by RLS.
- [ ] All new physical writes have a blob row and every physical read supports blob-first/legacy-fallback resolution.
- [ ] SHA-256 dedupe is server-verified and tenant-scoped.
- [ ] No S3 original is deleted while any live logical file references its blob.
- [ ] Physical blob deletion is delayed at least seven days and is outbox-retry safe.
- [ ] Message-range cascades and maintenance both feed logical GC.
- [ ] Historical missing images render a clean fallback with destructive actions disabled.
- [ ] Focused unit, integration, Playwright, typecheck, build, and deployment checks all pass.
- [ ] No production secret file is read, modified, generated, or committed.
- [ ] `plans/README.md` marks Plan 005 `DONE` only after every gate passes.

## STOP conditions

Stop and report instead of improvising if:

- Any checked-in caller depends on `DELETE /v1/files/:fileId` globally removing
  project or conversation data, beyond the Library UI already identified.
- Migration 43 would require dropping a legacy column/constraint or rewriting
  message-part JSON to proceed.
- A physical-delete path cannot prove zero live blob references while holding
  the logical file/blob locks.
- Deduplication would operate across tenants or use a client digest without
  reading/verifying the stored bytes.
- The object provider cannot stream reads or enumerate version/delete-marker
  pages with the current S3-compatible contract.
- A migration/backfill test finds multiple existing active file rows with the
  same `(tenant_id, bucket, object_key)` despite the current unique constraint.
- A verification command fails twice after a bounded, plan-aligned correction.
- The implementation needs to touch an out-of-scope client surface or delete
  production data during development/testing.

## Maintenance notes

- Reviewers should scrutinize lock ordering. Use logical file lock first, then
  blob lock consistently to avoid deadlocks between reference creation, GC,
  and dedupe verification.
- The partial hash index is correctness-critical. A failed/ pending-delete blob
  must never block a new verified winner indefinitely.
- Legacy physical columns remain a temporary rollback adapter. A later plan may
  remove them only after the seven-day grace model has run successfully in
  production and old application rollback is no longer required.
- Monitor counts/ages for `unverified`, `verifying`, `pending_delete`, failed
  outbox rows, and blobs with no logical files. Alert on age, not only totals.
- Storage savings from historical files are intentionally delayed. Do not
  shorten the grace period to make metrics look better.
