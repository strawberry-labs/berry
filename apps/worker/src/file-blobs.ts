import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { FileBlobJobPayload, FileDeleteBlobJobPayload } from "./jobs.js";
import { deleteEveryObjectVersion } from "./file-deletion.js";
import type { SqlExecutor } from "./sql-repositories.js";

const SEVEN_DAY_GRACE_SQL = "interval '7 days'";

type BlobRow = {
  id: string;
  tenant_id: string;
  bucket: string;
  object_key: string;
  size_bytes: string | number;
  sha256: string | null;
  etag: string | null;
  object_version_id: string | null;
  verification_status: "unverified" | "verifying" | "verified" | "failed" | "pending_delete" | "deleted";
  delete_after: Date | string | null;
  deleted_at: Date | string | null;
  updated_at: Date | string;
};

export interface FileBlobProcessor {
  verify(payload: FileBlobJobPayload): Promise<{ status: "verified" | "deduplicated" | "skipped"; sha256?: string }>;
  delete(payload: FileDeleteBlobJobPayload): Promise<{ deleted: number; cancelled?: boolean }>;
}

export class SqlFileBlobProcessor implements FileBlobProcessor {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly client: S3Client,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv, executor: SqlExecutor): SqlFileBlobProcessor | null {
    const endpoint = env.BERRY_ARTIFACT_S3_ENDPOINT;
    const accessKeyId = env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) return null;
    return new SqlFileBlobProcessor(executor, new S3Client({
      endpoint,
      region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }));
  }

  async verify(payload: FileBlobJobPayload): Promise<{ status: "verified" | "deduplicated" | "skipped"; sha256?: string }> {
    const claimed = await this.withTenant(payload.tenantId, async (executor) => {
      const [blob] = await executor.query<BlobRow>(`
        SELECT * FROM file_blobs
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE
      `, [payload.tenantId, payload.blobId]);
      if (!blob) throw new Error("File blob not found");
      if (blob.verification_status === "verified" || blob.verification_status === "pending_delete" || blob.verification_status === "deleted") {
        await completeVerificationWatchdog(executor, payload);
        return null;
      }
      if (blob.verification_status === "verifying"
        && Date.now() - new Date(blob.updated_at).getTime() < 15 * 60 * 1_000) return null;
      await executor.execute(`
        UPDATE file_blobs
        SET verification_status = 'verifying', updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [payload.tenantId, payload.blobId]);
      await executor.execute(`
        INSERT INTO runtime_outbox (
          tenant_id,event_type,aggregate_id,dedupe_key,payload,available_at
        ) VALUES (
          $1::uuid,'file.verify-blob',$2,$3,$4::jsonb,now()+interval '15 minutes'
        )
        ON CONFLICT (tenant_id,dedupe_key) DO UPDATE SET
          completed_at=NULL,available_at=EXCLUDED.available_at,
          lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
      `, [payload.tenantId, payload.blobId, `file.verify-blob:${payload.blobId}`, JSON.stringify(payload)]);
      return blob;
    });
    if (!claimed) return { status: "skipped" };

    let digest: string;
    let byteCount = 0;
    try {
      const object = await this.client.send(new GetObjectCommand({
        Bucket: claimed.bucket,
        Key: claimed.object_key,
        ...(claimed.object_version_id ? { VersionId: claimed.object_version_id } : {}),
      }));
      if (!object.Body) throw new Error("Stored file blob has no response body");
      const hash = createHash("sha256");
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        byteCount += bytes.length;
        hash.update(bytes);
      }
      digest = hash.digest("hex");
      if (byteCount !== Number(claimed.size_bytes)) {
        throw new Error(`Stored file blob size mismatch: expected ${claimed.size_bytes}, received ${byteCount}`);
      }
    } catch (error) {
      await this.withTenant(payload.tenantId, (executor) => executor.execute(`
        UPDATE file_blobs
        SET verification_status = 'failed',
            metadata = metadata || jsonb_build_object('verificationError', $3::text),
            updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND verification_status = 'verifying'
      `, [payload.tenantId, payload.blobId, error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)]));
      throw error;
    }

    try {
      return await this.finalizeVerification(payload, digest);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.finalizeVerification(payload, digest, true);
    }
  }

  async delete(payload: FileDeleteBlobJobPayload): Promise<{ deleted: number; cancelled?: boolean }> {
    return this.withTenant(payload.tenantId, async (executor) => {
      const [locationGuard] = await executor.query<{ guard_name: string | null }>(`
        SELECT to_regclass('file_blobs_physical_location_unique')::text AS guard_name
      `);
      if (!locationGuard?.guard_name) {
        throw new Error("Physical file-location uniqueness guard is unavailable; refusing blob deletion");
      }
      const lockedFiles = await executor.query<{ id: string; deleted_at: Date | string | null }>(`
        SELECT id, deleted_at FROM files
        WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
        ORDER BY id
        FOR UPDATE
      `, [payload.tenantId, payload.blobId]);
      const [blob] = await executor.query<BlobRow>(`
        SELECT * FROM file_blobs
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE
      `, [payload.tenantId, payload.blobId]);
      if (!blob) throw new Error("File blob not found");
      const [outbox] = await executor.query<{ id: string }>(`
        SELECT id FROM runtime_outbox
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND event_type = 'file.delete-blob' AND aggregate_id = $3
        FOR UPDATE
      `, [payload.tenantId, payload.outboxId, payload.blobId]);
      if (!outbox) throw new Error("Blob-deletion outbox receipt could not be recorded");
      if (blob.verification_status === "deleted" || blob.deleted_at) {
        await acknowledgeBlobOutbox(executor, payload, null);
        return { deleted: 0 };
      }
      const liveFile = lockedFiles.find((file) => !file.deleted_at);
      const [liveReferences] = liveFile ? [{ reference_exists: true }] : await executor.query<{ reference_exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM files f
          WHERE f.tenant_id = $1::uuid AND f.blob_id = $2::uuid
            AND (
              EXISTS (
                SELECT 1 FROM file_library_entries library
                WHERE library.tenant_id=f.tenant_id AND library.file_id=f.id
                  AND library.deleted_at IS NULL
              ) OR EXISTS (
                SELECT 1 FROM file_associations association
                WHERE association.tenant_id=f.tenant_id AND association.file_id=f.id
              ) OR EXISTS (
                SELECT 1 FROM workspace_files wf
                WHERE wf.tenant_id=f.tenant_id AND wf.file_id=f.id
                  AND wf.deleted_at IS NULL
              ) OR EXISTS (
                SELECT 1
                FROM knowledge_sources source
                JOIN workspace_files wf
                  ON wf.tenant_id=source.tenant_id
                 AND wf.workspace_id=source.workspace_id
                 AND wf.file_id=f.id
                 AND wf.deleted_at IS NULL
                WHERE source.tenant_id=f.tenant_id
                  AND source.source_type='file'
                  AND source.source_id=f.id::text
                  AND source.tombstoned_at IS NULL
              ) OR EXISTS (
                SELECT 1 FROM file_uploads upload
                WHERE upload.tenant_id=f.tenant_id AND upload.file_id=f.id
                  AND upload.status='uploading'
              )
            )
        ) AS reference_exists
      `, [payload.tenantId, payload.blobId]);
      if (liveReferences?.reference_exists) {
        await executor.execute(`
          UPDATE file_blobs
          SET verification_status = CASE
                WHEN sha256 IS NULL THEN 'unverified'::file_blob_verification_status
                ELSE 'verified'::file_blob_verification_status
              END,
              delete_after = NULL, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
        `, [payload.tenantId, payload.blobId]);
        await acknowledgeBlobOutbox(executor, payload, "Cancelled because a live file reference exists");
        return { deleted: 0, cancelled: true };
      }
      if (blob.verification_status !== "pending_delete" || !blob.delete_after || new Date(blob.delete_after).getTime() > Date.now()) {
        throw new Error("File blob is not eligible for physical deletion");
      }
      await deleteEveryObjectVersion(this.client, blob.bucket, [blob.object_key]);
      await executor.execute(`
        UPDATE file_blobs
        SET verification_status = 'deleted', deleted_at = COALESCE(deleted_at, now()), updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [payload.tenantId, payload.blobId]);
      await acknowledgeBlobOutbox(executor, payload, null);
      return { deleted: 1 };
    });
  }

  private async finalizeVerification(
    payload: FileBlobJobPayload,
    digest: string,
    afterConflict = false,
  ): Promise<{ status: "verified" | "deduplicated"; sha256: string }> {
    return this.withTenant(payload.tenantId, async (executor) => {
      await executor.query<{ id: string }>(`
        SELECT id FROM files
        WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
        ORDER BY id
        FOR UPDATE
      `, [payload.tenantId, payload.blobId]);
      const [blob] = await executor.query<BlobRow>(`
        SELECT * FROM file_blobs
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE
      `, [payload.tenantId, payload.blobId]);
      if (!blob) throw new Error("File blob not found");
      if (blob.verification_status === "pending_delete" || blob.verification_status === "deleted") {
        await completeVerificationWatchdog(executor, payload);
        return { status: "deduplicated", sha256: digest };
      }
      const winners = await executor.query<BlobRow>(`
        SELECT * FROM file_blobs
        WHERE tenant_id = $1::uuid AND sha256 = $2
          AND size_bytes = $3 AND verification_status = 'verified'
          AND deleted_at IS NULL AND id <> $4::uuid
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR UPDATE
      `, [payload.tenantId, digest, Number(blob.size_bytes), payload.blobId]);
      const winner = winners[0];
      if (!winner) {
        if (afterConflict) throw new Error("Verified blob uniqueness conflict did not expose a tenant-local winner");
        await executor.execute(`
          UPDATE file_blobs
          SET sha256 = $3, verification_status = 'verified', verified_at = now(),
              delete_after = NULL, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
        `, [payload.tenantId, payload.blobId, digest]);
        await executor.execute(`
          UPDATE files SET sha256 = $3, size_bytes = $4, updated_at = now()
          WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
        `, [payload.tenantId, payload.blobId, digest, Number(blob.size_bytes)]);
        await completeVerificationWatchdog(executor, payload);
        return { status: "verified", sha256: digest };
      }

      await executor.execute(`
        UPDATE files
        SET blob_id = $3::uuid, sha256 = $4, size_bytes = $5, updated_at = now()
        WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
      `, [payload.tenantId, payload.blobId, winner.id, digest, Number(winner.size_bytes)]);
      const [scheduled] = await executor.query<{ delete_after: Date | string }>(`
        UPDATE file_blobs
        SET sha256 = $3, verification_status = 'pending_delete',
            delete_after = COALESCE(delete_after, now() + ${SEVEN_DAY_GRACE_SQL}),
            updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        RETURNING delete_after
      `, [payload.tenantId, payload.blobId, digest]);
      if (!scheduled) throw new Error("Duplicate blob could not be scheduled for deletion");
      await executor.execute(`
        INSERT INTO runtime_outbox (
          tenant_id, event_type, aggregate_id, dedupe_key, payload, available_at
        ) VALUES ($1::uuid, 'file.delete-blob', $2, $3, $4::jsonb, $5::timestamptz)
        ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
          available_at = EXCLUDED.available_at, completed_at = NULL,
          last_error = NULL, updated_at = now()
      `, [payload.tenantId, payload.blobId, `file.delete-blob:${payload.blobId}`, JSON.stringify(payload), new Date(scheduled.delete_after).toISOString()]);
      await completeVerificationWatchdog(executor, payload);
      return { status: "deduplicated", sha256: digest };
    });
  }

  private withTenant<T>(tenantId: string, callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(executor);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }
}

async function completeVerificationWatchdog(executor: SqlExecutor, payload: FileBlobJobPayload): Promise<void> {
  await executor.execute(`
    UPDATE runtime_outbox
    SET completed_at=COALESCE(completed_at,now()),lease_owner=NULL,
        lease_expires_at=NULL,last_error=NULL,updated_at=now()
    WHERE tenant_id=$1::uuid AND event_type='file.verify-blob'
      AND aggregate_id=$2 AND dedupe_key=$3
  `, [payload.tenantId, payload.blobId, `file.verify-blob:${payload.blobId}`]);
}

async function acknowledgeBlobOutbox(
  executor: SqlExecutor,
  payload: FileDeleteBlobJobPayload,
  note: string | null,
): Promise<void> {
  const rows = await executor.query<{ id: string }>(`
    UPDATE runtime_outbox
    SET completed_at = COALESCE(completed_at, now()),
        lease_owner = NULL, lease_expires_at = NULL,
        last_error = $4, updated_at = now()
    WHERE tenant_id = $1::uuid AND id = $2::uuid
      AND event_type = 'file.delete-blob' AND aggregate_id = $3
    RETURNING id
  `, [payload.tenantId, payload.outboxId, payload.blobId, note]);
  if (!rows[0]) throw new Error("Blob-deletion outbox receipt could not be recorded");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
