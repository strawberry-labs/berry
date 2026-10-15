-- Releases files left in files.status='processing' after their search indexing
-- failed (H-062). The stored bytes are intact; only search preparation failed.
-- New failures are already handled by the worker (f4f2b1e); this repairs the
-- rows written before that fix.
--
-- A file qualifies only when ALL of these hold:
--   * status is 'processing', it is not deleted, and it is older than 1 hour;
--   * it has a live (not tombstoned) file knowledge source whose index failed;
--   * no live knowledge source for it is still pending or indexing (a retry
--     in progress keeps the file untouched).
-- Only files.status (-> 'available') and files.updated_at change. Nothing is
-- deleted; knowledge_sources keep their failure state and reason.
--
-- Default is a READ ONLY report. Review it, then apply:
--   psql "$DATABASE_URL" -v tenant_id=<uuid> -f scripts/reconcile-stuck-processing-files.sql
--   psql "$DATABASE_URL" -v tenant_id=<uuid> -v apply=1 -f scripts/reconcile-stuck-processing-files.sql
-- tenant_id is needed when row-level security is enforced for the role.
-- The apply run prints every changed file id with its previous status, so the
-- change can be reversed with that list if ever needed.

\set ON_ERROR_STOP on
\pset pager off
\if :{?apply}
BEGIN;
\else
BEGIN TRANSACTION READ ONLY;
\endif
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
\if :{?tenant_id}
SELECT berry_set_tenant_id(:'tenant_id'::uuid);
\endif

-- The qualifying files, as a query reused below (a read-only transaction
-- cannot create a temporary table).
\set candidates 'SELECT f.tenant_id, f.id AS file_id, f.status::text AS previous_status, f.created_at, (array_agg(ks.failure_reason ORDER BY ks.updated_at DESC))[1] AS failure_reason FROM files f JOIN knowledge_sources ks ON ks.tenant_id = f.tenant_id AND ks.source_type = ''file'' AND ks.source_id = f.id::text AND ks.tombstoned_at IS NULL AND ks.index_status = ''failed'' WHERE f.status = ''processing'' AND f.deleted_at IS NULL AND f.created_at < now() - interval ''1 hour'' AND NOT EXISTS ( SELECT 1 FROM knowledge_sources busy WHERE busy.tenant_id = f.tenant_id AND busy.source_type = ''file'' AND busy.source_id = f.id::text AND busy.tombstoned_at IS NULL AND busy.index_status IN (''pending'', ''extracting'', ''chunking'', ''embedding'') ) GROUP BY f.tenant_id, f.id, f.status, f.created_at'

\echo '== Files that qualify, by failure reason =='
SELECT coalesce(left(failure_reason, 60), '(none recorded)') AS failure_reason, count(*) AS files
FROM (:candidates) c GROUP BY 1 ORDER BY 2 DESC;
\echo '== Total =='
SELECT count(*) AS files, count(DISTINCT tenant_id) AS tenants, min(created_at) AS oldest, max(created_at) AS newest
FROM (:candidates) c;

\if :{?apply}
\echo '== Applying: processing -> available =='
UPDATE files f SET status = 'available', updated_at = now()
FROM (:candidates) c
WHERE f.tenant_id = c.tenant_id AND f.id = c.file_id AND f.status = 'processing' AND f.deleted_at IS NULL
RETURNING f.tenant_id, f.id AS file_id, c.previous_status;
COMMIT;
\else
ROLLBACK;
\endif
