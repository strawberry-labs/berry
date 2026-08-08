# Reference-safe file lifecycle

Berry separates a logical file from the physical object that stores its bytes. `files` keeps names, ownership, origin, processing state, and compatibility storage columns. `file_blobs` owns the bucket, object key, byte size, server-verified SHA-256 digest, verification state, and physical-deletion schedule. Physical `(bucket, object_key)` locations are globally unique, while verified-hash deduplication remains tenant-scoped. Multiple logical files may point to one verified blob inside the same tenant.

`file_library_entries` is the per-user Library membership. Removing a file from Library tombstones only the requesting user's row. It does not remove `file_associations`, `workspace_files`, or `knowledge_sources`, so conversations and projects continue to read the logical file. Task soft deletion is restorable and does not remove file associations.

## Live references and collection

A logical file remains live while any of these references exists:

- an active `file_library_entries` row;
- any `file_associations` row, including one belonging to a soft-deleted task;
- an active `workspace_files` row;
- an active file `knowledge_sources` row backed by an active workspace link;
- an uploading `file_uploads` row.

Reference creation locks the logical file and rejects a tombstoned file. Logical garbage collection uses the same lock, tombstones orphan knowledge sources, queues derivative cleanup, and marks the file deleted only after the transaction derives a zero-reference result. Message-range deletion gathers affected file IDs before cascades and rechecks them afterward. The `orphan_files` maintenance phase provides bounded `FOR UPDATE SKIP LOCKED` repair for cascades and interrupted API work, with a second authoritative reference check after each candidate lock is acquired.

A blob is eligible only after no non-deleted logical file points to it. Berry marks it `pending_delete`, sets `delete_after` no earlier than seven days later, and writes a `file.delete-blob` runtime outbox event with the same availability time. Adding a live reference during the grace period cancels the pending deletion. The worker rechecks live files while holding the file/blob locks, enumerates every exact-key object version and delete marker, and acknowledges the outbox only after all physical deletion succeeds. Retries are idempotent. Existing `file.delete-object` events remain compatible for derivative cleanup, but the worker filters out canonical blob keys. Both deletion paths refuse storage access unless the global physical-location unique index exists; canonical originals can be removed only by `file.delete-blob` after its reference check and grace period.

## Verification and tenant deduplication

Every new physical write creates an unverified blob and queues `file.verify-blob`. Claiming the job reopens its outbox event as a 15-minute recovery watchdog; successful finalization closes it, so a worker crash does not strand a blob in `verifying`. The worker streams the exact stored object through Node's SHA-256 implementation and verifies the byte count against `size_bytes`. A client-provided digest or an internally calculated expectation may be recorded in metadata, but neither becomes blob identity until the worker reads the stored bytes.

Migration 44 keeps this invariant active during a rolling deploy or application rollback. A legacy writer that omits `files.blob_id` receives a new unverified blob row in a `BEFORE INSERT` trigger, and an owner Library membership in an `AFTER INSERT` trigger. After installing both triggers, the migration repeats the additive backfill to catch rows written between migrations 43 and 44. It then refuses to complete if existing tenants claim the same physical location and installs the global `(bucket, object_key)` unique index. The trigger's blob insert intentionally has no conflict-reuse path: an unexpected object-key collision aborts the logical write instead of transferring an existing blob to another file or user.

The verified lookup and partial unique index both use `(tenant_id, sha256, size_bytes)`. A matching digest in another tenant is invisible and cannot be reused. A same-tenant winner receives the logical file references; the duplicate physical key receives its own seven-day deletion schedule. Concurrent unique-index conflicts reload the tenant-local winner and converge on the same result. API responses do not reveal whether deduplication occurred.

## Operations and recovery

Watch the age and count of these states, split by tenant:

- `file_blobs.verification_status` values `unverified`, `verifying`, `failed`, and `pending_delete`;
- incomplete or repeatedly attempted `runtime_outbox` rows for `file.verify-blob`, `file.delete-blob`, `file.delete-object`, and `knowledge.delete`;
- blobs with no rows in `files` and files with no live references;
- oldest `delete_after` timestamp and failed verification error metadata.

Useful read-only checks:

```sql
SELECT verification_status, count(*), min(created_at)
FROM file_blobs
GROUP BY verification_status;

SELECT event_type, count(*), min(available_at), max(attempts)
FROM runtime_outbox
WHERE completed_at IS NULL
GROUP BY event_type;

SELECT blob.id, blob.verification_status, blob.delete_after
FROM file_blobs blob
LEFT JOIN files file ON file.blob_id = blob.id AND file.deleted_at IS NULL
WHERE file.id IS NULL
ORDER BY blob.created_at;
```

Run a bounded, resumable legacy verification pass only after new uploads and outbox delivery are healthy:

```sh
pnpm --filter @berry/worker build
pnpm --filter @berry/worker maintenance -- verify_file_blobs --tenant <tenant-uuid> --batch 50
pnpm --filter @berry/worker maintenance -- status --tenant <tenant-uuid> --run <run-uuid>
pnpm --filter @berry/worker maintenance -- cancel --tenant <tenant-uuid> --run <run-uuid>
```

Rerunning the same run ID resumes its stored cursor. A new run safely revisits unverified or failed blobs. Do not shorten the seven-day grace period to accelerate storage metrics.

## Release and rollback

1. Take Postgres and object-storage backups and verify that both can be restored.
2. Quiesce pre-Plan-005 workers, then deploy migrations 43 and 44 with the new API, worker, and web images as one coordinated release through `deploy/server-deploy.sh`. The release must run both the `db-migrate` and `postgres-roles` one-shot services so the least-privilege API and worker roles receive grants on the new tables. Do not replace `deploy/.env.production`. Do not let a pre-Plan worker consume file-deletion events after the migration starts.
3. Confirm forced RLS on `file_blobs` and `file_library_entries`, the tenant verified-hash partial index, the global physical-location unique index, the blob foreign key, both compatibility triggers, and backfill counts. Smoke-test a new upload through verification.
4. Remove one file from Library and confirm its conversation download and project link still work.
5. Monitor verification age, outbox retries, and object-deletion receipts before starting legacy verification.
6. Run one bounded `verify_file_blobs` batch for the self-host tenant, then pause and inspect results before continuing.
7. Wait through the seven-day grace period before measuring physical storage savings.
8. During the grace window, a web-only rollback may retain the new API and worker plus additive migrations 43 and 44, their compatibility triggers, and the legacy columns. Do not restore the pre-Plan DELETE implementation or pre-Plan deletion worker: those binaries predate Library membership and canonical-key protection. If API/worker rollback is unavoidable, disable `DELETE /v1/files/:fileId`, stop file-deletion delivery, and restore the new lifecycle services before resuming either. A database rollback requires stopped writers plus the verified database and object-storage backups.

If deletion must be stopped, cancel the maintenance run and stop workers before changing data. Preserve pending outbox rows for replay. Never mark a blob deleted or complete a deletion receipt by hand unless object-version enumeration has independently proven the key is absent.
