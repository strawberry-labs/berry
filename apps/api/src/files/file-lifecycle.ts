import type { SqlExecutor } from "../db/cloud-database.service.ts";

export const FILE_BLOB_GRACE_INTERVAL_SQL = "interval '7 days'";

type LockedFile = {
  id: string;
  blob_id: string | null;
  bucket: string;
  object_key: string;
  deleted_at: Date | string | null;
};

export async function lockLiveFile(
  executor: SqlExecutor,
  tenantId: string,
  fileId: string,
): Promise<LockedFile | null> {
  const [file] = await executor.query<LockedFile>(`
    SELECT f.id, f.blob_id,
      CASE WHEN f.blob_id IS NOT NULL THEN blob.bucket ELSE f.bucket END AS bucket,
      CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS object_key,
      f.deleted_at
    FROM files f
    LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
    WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid
    FOR UPDATE OF f
  `, [tenantId, fileId]);
  return file ?? null;
}

export async function garbageCollectFileIfUnreferenced(
  executor: SqlExecutor,
  tenantId: string,
  fileId: string,
): Promise<{ collected: boolean; blobScheduled: boolean }> {
  const file = await lockLiveFile(executor, tenantId, fileId);
  if (!file) return { collected: false, blobScheduled: false };

  const orphanSources = await executor.query<{ id: string; source_revision: string }>(`
    UPDATE knowledge_sources source
    SET tombstoned_at = COALESCE(source.tombstoned_at, now()),
        extraction_status = 'deleted', index_status = 'deleted',
        vector_ready = false, updated_at = now()
    WHERE source.tenant_id = $1::uuid
      AND source.source_type = 'file'
      AND source.source_id = $2::uuid::text
      AND source.tombstoned_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_files wf
        WHERE wf.tenant_id = source.tenant_id
          AND wf.workspace_id = source.workspace_id
          AND wf.file_id = $2::uuid
          AND wf.deleted_at IS NULL
      )
    RETURNING source.id, source.source_revision
  `, [tenantId, fileId]);
  for (const source of orphanSources) {
    await executor.execute(`
      INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
      VALUES ($1::uuid, 'knowledge.delete', $2, $3, $4::jsonb)
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    `, [
      tenantId,
      source.id,
      `knowledge.delete:${source.id}:${source.source_revision}`,
      JSON.stringify({ tenantId, sourceId: source.id, revision: source.source_revision }),
    ]);
  }

  const [references] = await executor.query<{ reference_exists: boolean }>(`
    SELECT (
      EXISTS (
        SELECT 1 FROM file_library_entries library
        WHERE library.tenant_id = $1::uuid AND library.file_id = $2::uuid
          AND library.deleted_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM file_associations association
        WHERE association.tenant_id = $1::uuid AND association.file_id = $2::uuid
      ) OR EXISTS (
        SELECT 1 FROM workspace_files wf
        WHERE wf.tenant_id = $1::uuid AND wf.file_id = $2::uuid
          AND wf.deleted_at IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM knowledge_sources source
        JOIN workspace_files wf
          ON wf.tenant_id = source.tenant_id
         AND wf.workspace_id = source.workspace_id
         AND wf.file_id = $2::uuid
         AND wf.deleted_at IS NULL
        WHERE source.tenant_id = $1::uuid
          AND source.source_type = 'file'
          AND source.source_id = $2::uuid::text
          AND source.tombstoned_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM file_uploads upload
        WHERE upload.tenant_id = $1::uuid AND upload.file_id = $2::uuid
          AND upload.status IN ('uploading')
      )
    ) AS reference_exists
  `, [tenantId, fileId]);
  if (references?.reference_exists) return { collected: false, blobScheduled: false };

  const [deleted] = await executor.query<{ id: string }>(`
    UPDATE files
    SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE tenant_id = $1::uuid AND id = $2::uuid
    RETURNING id
  `, [tenantId, fileId]);
  if (!deleted) return { collected: false, blobScheduled: false };

  const derivatives = await executor.query<{ object_key: string }>(`
    SELECT object_key FROM file_derivatives
    WHERE tenant_id = $1::uuid AND file_id = $2::uuid AND object_key IS NOT NULL
  `, [tenantId, fileId]);
  const derivativeKeys = [...new Set(derivatives.map((item) => item.object_key))];
  for (let offset = 0; offset < derivativeKeys.length; offset += 1_000) {
    const keys = derivativeKeys.slice(offset, offset + 1_000);
    const batch = Math.floor(offset / 1_000);
    await executor.execute(`
      INSERT INTO runtime_outbox (
        tenant_id, event_type, aggregate_id, dedupe_key, payload, available_at
      ) VALUES ($1::uuid, 'file.delete-object', $2, $3, $4::jsonb, now())
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    `, [tenantId, fileId, `file.delete-derivatives:${fileId}:${batch}`, JSON.stringify({ tenantId, fileId, bucket: file.bucket, keys })]);
  }

  if (!file.blob_id) {
    await executor.execute(`
      INSERT INTO runtime_outbox (
        tenant_id, event_type, aggregate_id, dedupe_key, payload, available_at
      ) VALUES (
        $1::uuid, 'file.delete-object', $2, $3, $4::jsonb,
        now() + ${FILE_BLOB_GRACE_INTERVAL_SQL}
      ) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    `, [tenantId, fileId, `file.delete-object:legacy:${fileId}`, JSON.stringify({ tenantId, fileId, bucket: file.bucket, keys: [file.object_key] })]);
    return { collected: true, blobScheduled: true };
  }

  const [blob] = await executor.query<{ id: string }>(`
    SELECT id FROM file_blobs
    WHERE tenant_id = $1::uuid AND id = $2::uuid
    FOR UPDATE
  `, [tenantId, file.blob_id]);
  if (!blob) throw new Error(`File ${fileId} references a missing blob`);
  const [otherFile] = await executor.query<{ id: string }>(`
    SELECT id FROM files
    WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
      AND id <> $3::uuid AND deleted_at IS NULL
    LIMIT 1
  `, [tenantId, file.blob_id, fileId]);
  if (otherFile) return { collected: true, blobScheduled: false };

  const [scheduled] = await executor.query<{ delete_after: Date | string }>(`
    UPDATE file_blobs
    SET verification_status = 'pending_delete',
        delete_after = COALESCE(delete_after, now() + ${FILE_BLOB_GRACE_INTERVAL_SQL}),
        updated_at = now()
    WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL
    RETURNING delete_after
  `, [tenantId, file.blob_id]);
  if (!scheduled) return { collected: true, blobScheduled: false };
  await executor.execute(`
    INSERT INTO runtime_outbox (
      tenant_id, event_type, aggregate_id, dedupe_key, payload, available_at
    ) VALUES ($1::uuid, 'file.delete-blob', $2, $3, $4::jsonb, $5::timestamptz)
    ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
      available_at = EXCLUDED.available_at,
      completed_at = NULL, last_error = NULL, updated_at = now()
  `, [
    tenantId,
    file.blob_id,
    `file.delete-blob:${file.blob_id}`,
    JSON.stringify({ tenantId, blobId: file.blob_id }),
    new Date(scheduled.delete_after).toISOString(),
  ]);
  return { collected: true, blobScheduled: true };
}
