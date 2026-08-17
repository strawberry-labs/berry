import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { FileBlobJobPayload, FileDeleteBlobJobPayload } from "./jobs.js";
import { deleteCapturedObjectVersion } from "./file-deletion.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { s3ClientOptions } from "./s3-client-options.js";

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
  deletion_claim_id?: string | null;
  deletion_claimed_at?: Date | string | null;
  deleted_at: Date | string | null;
  metadata?: Record<string, unknown>;
  updated_at: Date | string;
};

type BlobDeleteClaim = {
  blob: BlobRow;
  alreadyDeleted?: boolean;
  cancelled?: boolean;
};

class FileBlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileBlobIntegrityError";
  }
}

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
    if (!env.BERRY_ARTIFACT_S3_BUCKET) return null;
    return new SqlFileBlobProcessor(executor, new S3Client(s3ClientOptions({ endpoint, region: env.BERRY_ARTIFACT_S3_REGION, accessKeyId, secretAccessKey })));
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
          lease_owner=NULL,lease_expires_at=NULL,receipt_due_at=NULL,
          dead_lettered_at=NULL,error_category=NULL,last_error=NULL,updated_at=now()
      `, [payload.tenantId, payload.blobId, `file.verify-blob:${payload.blobId}`, JSON.stringify(payload)]);
      return blob;
    });
    if (!claimed) return { status: "skipped" };

    let digest: string | undefined;
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
        throw new FileBlobIntegrityError(`Stored file blob size mismatch: expected ${claimed.size_bytes}, received ${byteCount}`);
      }
      const expectedSha256 = immutableExpectedSha256(claimed);
      if (expectedSha256 && digest !== expectedSha256) {
        throw new FileBlobIntegrityError(`Stored file blob SHA-256 mismatch: expected ${expectedSha256}, received ${digest}`);
      }
      try {
        return await this.finalizeVerification(payload, digest, expectedSha256);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return await this.finalizeVerification(payload, digest, expectedSha256, true);
      }
    } catch (error) {
      await this.recordVerificationFailure(payload, error, digest);
      throw error;
    }
  }

  async delete(payload: FileDeleteBlobJobPayload): Promise<{ deleted: number; cancelled?: boolean }> {
    const claim = await this.claimDeletion(payload);
    if (claim.cancelled) return { deleted: 0, cancelled: true };
    if (claim.alreadyDeleted) return { deleted: 0 };
    try {
      await deleteCapturedObjectVersion(
        this.client,
        claim.blob.bucket,
        claim.blob.object_key,
        claim.blob.object_version_id,
      );
    } catch (error) {
      await this.releaseDeletionClaim(payload);
      throw error;
    }
    return this.completeDeletion(payload);
  }

  private async claimDeletion(payload: FileDeleteBlobJobPayload): Promise<BlobDeleteClaim> {
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
        return { blob, alreadyDeleted: true };
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
        return { blob, cancelled: true };
      }
      if (blob.verification_status !== "pending_delete" || !blob.delete_after || new Date(blob.delete_after).getTime() > Date.now()) {
        throw new Error("File blob is not eligible for physical deletion");
      }
      if (blob.deletion_claim_id
        && blob.deletion_claim_id !== payload.outboxId
        && blob.deletion_claimed_at
        && new Date(blob.deletion_claimed_at).getTime() > Date.now() - 15 * 60 * 1_000) {
        throw new Error("File blob deletion is already claimed by another delivery");
      }
      await executor.execute(`
        UPDATE file_blobs
        SET deletion_claim_id=$3,deletion_claimed_at=now(),updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid
          AND verification_status='pending_delete' AND deleted_at IS NULL
      `, [payload.tenantId, payload.blobId, payload.outboxId]);
      return { blob };
    });
  }

  private async releaseDeletionClaim(payload: FileDeleteBlobJobPayload): Promise<void> {
    await this.withTenant(payload.tenantId, (executor) => executor.execute(`
      UPDATE file_blobs
      SET deletion_claim_id=NULL,deletion_claimed_at=NULL,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND deletion_claim_id=$3
    `, [payload.tenantId, payload.blobId, payload.outboxId]));
  }

  private async completeDeletion(payload: FileDeleteBlobJobPayload): Promise<{ deleted: number }> {
    return this.withTenant(payload.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(`
        UPDATE file_blobs
        SET verification_status='deleted',deleted_at=COALESCE(deleted_at,now()),
            deletion_claim_id=NULL,deletion_claimed_at=NULL,updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid
          AND deletion_claim_id=$3 AND verification_status='pending_delete'
        RETURNING id
      `, [payload.tenantId, payload.blobId, payload.outboxId]);
      if (!rows[0]) {
        const [current] = await executor.query<{ verification_status: string; deleted_at: Date | string | null }>(`
          SELECT verification_status,deleted_at FROM file_blobs
          WHERE tenant_id=$1::uuid AND id=$2::uuid
        `, [payload.tenantId, payload.blobId]);
        if (current?.verification_status !== "deleted" && !current?.deleted_at) {
          throw new Error("File blob deletion claim was lost before receipt");
        }
      }
      await acknowledgeBlobOutbox(executor, payload, null);
      return { deleted: rows[0] ? 1 : 0 };
    });
  }

  private async finalizeVerification(
    payload: FileBlobJobPayload,
    digest: string,
    expectedSha256: string | null,
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
      const currentExpectedSha256 = immutableExpectedSha256(blob);
      if (currentExpectedSha256 !== expectedSha256) {
        throw new FileBlobIntegrityError("Stored file blob expected SHA-256 changed during verification");
      }
      if (currentExpectedSha256 && digest !== currentExpectedSha256) {
        throw new FileBlobIntegrityError(`Stored file blob SHA-256 mismatch: expected ${currentExpectedSha256}, received ${digest}`);
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
          UPDATE files
          SET sha256 = COALESCE(sha256, $3), size_bytes = $4,
              status = CASE
                WHEN status='quarantined' AND metadata->>'verificationBlobId'=$2::text THEN
                  CASE metadata->>'verificationPreviousStatus'
                    WHEN 'scanning' THEN 'scanning'::file_status
                    WHEN 'processing' THEN 'processing'::file_status
                    ELSE 'available'::file_status
                  END
                ELSE status
              END,
              metadata = CASE
                WHEN metadata->>'verificationBlobId'=$2::text
                  THEN metadata - 'verificationBlobId' - 'verificationError'
                    - 'verificationPreviousStatus' - 'verificationObservedSha256'
                ELSE metadata
              END,
              updated_at = now()
          WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
        `, [payload.tenantId, payload.blobId, digest, Number(blob.size_bytes)]);
        await settleArtifactVerification(executor, payload.tenantId, payload.blobId, "verified", null);
        await completeVerificationWatchdog(executor, payload);
        return { status: "verified", sha256: digest };
      }

      await executor.execute(`
        UPDATE files
        SET blob_id = $3::uuid, sha256 = COALESCE(sha256, $4), size_bytes = $5,
            status = CASE
              WHEN status='quarantined' AND metadata->>'verificationBlobId'=$2::text THEN
                CASE metadata->>'verificationPreviousStatus'
                  WHEN 'scanning' THEN 'scanning'::file_status
                  WHEN 'processing' THEN 'processing'::file_status
                  ELSE 'available'::file_status
                END
              ELSE status
            END,
            metadata = CASE
              WHEN metadata->>'verificationBlobId'=$2::text
                THEN metadata - 'verificationBlobId' - 'verificationError'
                  - 'verificationPreviousStatus' - 'verificationObservedSha256'
              ELSE metadata
            END,
            updated_at = now()
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
          receipt_due_at = NULL, dead_lettered_at = NULL, error_category = NULL,
          last_error = NULL, updated_at = now()
      `, [payload.tenantId, payload.blobId, `file.delete-blob:${payload.blobId}`, JSON.stringify(payload), new Date(scheduled.delete_after).toISOString()]);
      await settleArtifactVerification(executor, payload.tenantId, payload.blobId, "verified", null);
      await completeVerificationWatchdog(executor, payload);
      return { status: "deduplicated", sha256: digest };
    });
  }

  private async recordVerificationFailure(
    payload: FileBlobJobPayload,
    error: unknown,
    observedSha256?: string,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
    const errorClass = error instanceof Error ? error.name.slice(0, 128) : "blob_verification_error";
    const quarantine = error instanceof FileBlobIntegrityError;
    await this.withTenant(payload.tenantId, async (executor) => {
      await executor.execute(`
        UPDATE file_blobs
        SET verification_status = 'failed',
            metadata = metadata || jsonb_strip_nulls(jsonb_build_object(
              'verificationError', $3::text,
              'verificationObservedSha256', $4::text
            )),
            updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND verification_status = 'verifying'
      `, [payload.tenantId, payload.blobId, errorMessage, observedSha256 ?? null]);
      if (quarantine) {
        await executor.execute(`
          UPDATE files
          SET status = 'quarantined',
              metadata = metadata || jsonb_build_object(
                'verificationBlobId', $2::text,
                'verificationError', $3::text,
                'verificationPreviousStatus', COALESCE(metadata->>'verificationPreviousStatus', status::text)
              ) || jsonb_strip_nulls(jsonb_build_object('verificationObservedSha256', $4::text)),
              updated_at = now()
          WHERE tenant_id = $1::uuid AND blob_id = $2::uuid
            AND deleted_at IS NULL
            AND status IN ('scanning','processing','available')
        `, [payload.tenantId, payload.blobId, errorMessage, observedSha256 ?? null]);
      }
      await settleArtifactVerification(executor, payload.tenantId, payload.blobId, "failed", errorClass);
      await executor.execute(`
        INSERT INTO file_lifecycle_events (
          tenant_id,blob_id,event_type,dedupe_key,payload
        ) VALUES (
          $1::uuid,$2::uuid,'file.verification_failed',
          'file.verification_failed:' || $2::text,
          jsonb_strip_nulls(jsonb_build_object(
            'blobId',$2::text,'error',$3::text,'errorClass',$4::text,
            'observedSha256',$5::text,'quarantined',$6::boolean
          ))
        )
        ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
      `, [payload.tenantId, payload.blobId, errorMessage, errorClass, observedSha256 ?? null, quarantine]);
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

function immutableExpectedSha256(blob: BlobRow): string | null {
  const metadataExpected = blob.metadata?.expectedSha256;
  const candidate = metadataExpected ?? blob.sha256;
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate !== "string" || !/^[0-9a-f]{64}$/i.test(candidate)) {
    throw new FileBlobIntegrityError("Stored file blob expected SHA-256 is invalid");
  }
  return candidate.toLowerCase();
}

async function settleArtifactVerification(
  executor: SqlExecutor,
  tenantId: string,
  blobId: string,
  verificationStatus: "verified" | "failed",
  errorClass: string | null,
): Promise<void> {
  await executor.execute(`
    WITH target_blob AS (
      SELECT id,bucket,object_key
      FROM file_blobs
      WHERE tenant_id=$1::uuid AND id=$2::uuid
    ), target_files AS (
      SELECT id FROM files
      WHERE tenant_id=$1::uuid AND blob_id IN (SELECT id FROM target_blob)
    )
    UPDATE artifact_operations operation
    SET status=CASE WHEN $3::text='verified' THEN 'complete' ELSE 'failed' END,
        verification_status=$3,
        error_class=CASE WHEN $3::text='verified' THEN NULL ELSE $4 END,
        updated_at=now()
    WHERE operation.tenant_id=$1::uuid
      AND (
        operation.file_id IN (SELECT id FROM target_files)
        OR EXISTS (
          SELECT 1 FROM target_blob blob
          WHERE operation.storage_receipt->>'bucket'=blob.bucket
            AND operation.storage_receipt->>'key'=blob.object_key
        )
      )
  `, [tenantId, blobId, verificationStatus, errorClass]);
  await executor.execute(`
    WITH target_blob AS (
      SELECT id,bucket,object_key
      FROM file_blobs
      WHERE tenant_id=$1::uuid AND id=$2::uuid
    ), target_files AS (
      SELECT id FROM files
      WHERE tenant_id=$1::uuid AND blob_id IN (SELECT id FROM target_blob)
    ), affected AS (
      SELECT DISTINCT operation.finalization_id
      FROM artifact_operations operation
      WHERE operation.tenant_id=$1::uuid
        AND operation.finalization_id IS NOT NULL
        AND (
          operation.file_id IN (SELECT id FROM target_files)
          OR EXISTS (
            SELECT 1 FROM target_blob blob
            WHERE operation.storage_receipt->>'bucket'=blob.bucket
              AND operation.storage_receipt->>'key'=blob.object_key
          )
        )
    ), counts AS (
      SELECT operation.finalization_id,
             COUNT(*)::integer AS item_count,
             COUNT(*) FILTER (
               WHERE operation.status='complete' AND operation.verification_status='verified'
             )::integer AS completed_count,
             COUNT(*) FILTER (
               WHERE operation.status='failed' OR operation.verification_status='failed'
             )::integer AS failed_count
      FROM artifact_operations operation
      JOIN affected ON affected.finalization_id=operation.finalization_id
      WHERE operation.tenant_id=$1::uuid
      GROUP BY operation.finalization_id
    )
    UPDATE turn_finalizations finalization
    SET item_count=GREATEST(finalization.item_count,counts.item_count),
        completed_count=counts.completed_count,
        failed_count=counts.failed_count,
        status=CASE
          WHEN finalization.status='running' THEN 'running'
          WHEN counts.completed_count=GREATEST(finalization.item_count,counts.item_count) THEN 'complete'
          WHEN counts.failed_count=GREATEST(finalization.item_count,counts.item_count) THEN 'failed'
          ELSE 'partial'
        END,
        last_error=CASE
          WHEN counts.failed_count>0 THEN COALESCE($3::text,finalization.last_error,'artifact_verification_failed')
          ELSE NULL
        END,
        completed_at=CASE
          WHEN finalization.status='running' THEN NULL
          WHEN counts.completed_count+counts.failed_count>=GREATEST(finalization.item_count,counts.item_count) THEN now()
          ELSE NULL
        END,
        lease_owner=CASE WHEN finalization.status='running' THEN finalization.lease_owner ELSE NULL END,
        lease_expires_at=CASE WHEN finalization.status='running' THEN finalization.lease_expires_at ELSE NULL END,
        updated_at=now()
    FROM counts
    WHERE finalization.tenant_id=$1::uuid AND finalization.id=counts.finalization_id
  `, [tenantId, blobId, errorClass]);
  if (verificationStatus === "verified") {
    await executor.execute(`
      WITH target_blob AS (
        SELECT id,bucket,object_key
        FROM file_blobs
        WHERE tenant_id=$1::uuid AND id=$2::uuid
      ), target_files AS (
        SELECT id FROM files
        WHERE tenant_id=$1::uuid AND blob_id IN (SELECT id FROM target_blob)
      ), affected AS (
        SELECT DISTINCT operation.finalization_id
        FROM artifact_operations operation
        WHERE operation.tenant_id=$1::uuid
          AND operation.finalization_id IS NOT NULL
          AND (
            operation.file_id IN (SELECT id FROM target_files)
            OR EXISTS (
              SELECT 1 FROM target_blob blob
              WHERE operation.storage_receipt->>'bucket'=blob.bucket
                AND operation.storage_receipt->>'key'=blob.object_key
            )
          )
      ), completed AS (
        SELECT finalization.run_id,run.session_id,finalization.operation_key,
               finalization.item_count,finalization.completed_count,finalization.failed_count
        FROM turn_finalizations finalization
        JOIN affected ON affected.finalization_id=finalization.id
        JOIN turn_runs run
          ON run.tenant_id=finalization.tenant_id AND run.id=finalization.run_id
        WHERE finalization.tenant_id=$1::uuid AND finalization.status='complete'
      )
      INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
      SELECT $1::uuid,completed.run_id,completed.session_id,
             (SELECT COALESCE(MAX(event.sequence),0)+1
              FROM turn_events event
              WHERE event.tenant_id=$1::uuid AND event.run_id=completed.run_id),
             'finalization.end',
             jsonb_build_object(
               'kind','finalization.end','runId',completed.run_id::text,
               'operationKey',completed.operation_key,'status','complete',
               'itemCount',completed.item_count,
               'completedCount',completed.completed_count,
               'failedCount',completed.failed_count
             )
      FROM completed
      WHERE NOT EXISTS (
        SELECT 1 FROM turn_events event
        WHERE event.tenant_id=$1::uuid AND event.run_id=completed.run_id
          AND event.event_type='finalization.end'
          AND event.payload->>'operationKey'=completed.operation_key
          AND event.payload->>'status'='complete'
      )
      ON CONFLICT (tenant_id,run_id,sequence) DO NOTHING
    `, [tenantId, blobId]);
  } else {
    await executor.execute(`
      WITH target_blob AS (
        SELECT id,bucket,object_key
        FROM file_blobs
        WHERE tenant_id=$1::uuid AND id=$2::uuid
      ), target_files AS (
        SELECT id FROM files
        WHERE tenant_id=$1::uuid AND blob_id IN (SELECT id FROM target_blob)
      ), affected AS (
        SELECT DISTINCT operation.finalization_id
        FROM artifact_operations operation
        WHERE operation.tenant_id=$1::uuid
          AND operation.finalization_id IS NOT NULL
          AND (
            operation.file_id IN (SELECT id FROM target_files)
            OR EXISTS (
              SELECT 1 FROM target_blob blob
              WHERE operation.storage_receipt->>'bucket'=blob.bucket
                AND operation.storage_receipt->>'key'=blob.object_key
            )
          )
      ), failed AS (
        SELECT finalization.run_id,run.session_id,finalization.operation_key,
               COALESCE(finalization.last_error,$3::text,'artifact_verification_failed') AS error_class
        FROM turn_finalizations finalization
        JOIN affected ON affected.finalization_id=finalization.id
        JOIN turn_runs run
          ON run.tenant_id=finalization.tenant_id AND run.id=finalization.run_id
        WHERE finalization.tenant_id=$1::uuid AND finalization.status='failed'
      )
      INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
      SELECT $1::uuid,failed.run_id,failed.session_id,
             (SELECT COALESCE(MAX(event.sequence),0)+1
              FROM turn_events event
              WHERE event.tenant_id=$1::uuid AND event.run_id=failed.run_id),
             'finalization.error',
             jsonb_build_object(
               'kind','finalization.error','runId',failed.run_id::text,
               'operationKey',failed.operation_key,
               'errorClass',LEFT(failed.error_class,128)
             )
      FROM failed
      WHERE NOT EXISTS (
        SELECT 1 FROM turn_events event
        WHERE event.tenant_id=$1::uuid AND event.run_id=failed.run_id
          AND event.event_type='finalization.error'
          AND event.payload->>'operationKey'=failed.operation_key
      )
      ON CONFLICT (tenant_id,run_id,sequence) DO NOTHING
    `, [tenantId, blobId, errorClass]);
  }
}

async function completeVerificationWatchdog(executor: SqlExecutor, payload: FileBlobJobPayload): Promise<void> {
  await executor.execute(`
    UPDATE runtime_outbox
    SET completed_at=COALESCE(completed_at,now()),
        delivered_at=COALESCE(delivered_at,now()),receipt_at=COALESCE(receipt_at,now()),
        receipt_due_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
        last_error=NULL,error_category=NULL,updated_at=now()
    WHERE tenant_id=$1::uuid AND event_type='file.verify-blob'
      AND aggregate_id=$2 AND dedupe_key=$3
      AND ($4::uuid IS NULL OR id=$4::uuid)
      AND completed_at IS NULL AND dead_lettered_at IS NULL
      AND ($5::bigint IS NULL OR lease_epoch=$5::bigint)
  `, [payload.tenantId, payload.blobId, `file.verify-blob:${payload.blobId}`, payload.outboxId ?? null, payload.leaseEpoch ?? null]);
}

async function acknowledgeBlobOutbox(
  executor: SqlExecutor,
  payload: FileDeleteBlobJobPayload,
  note: string | null,
): Promise<void> {
  const rows = await executor.query<{ id: string }>(`
    WITH acknowledged AS (
    UPDATE runtime_outbox
    SET completed_at = COALESCE(completed_at, now()),
        delivered_at = COALESCE(delivered_at, now()),
        receipt_at = COALESCE(receipt_at, now()), receipt_due_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL,
        last_error = $4, error_category = CASE WHEN $4 IS NULL THEN NULL ELSE 'cancelled' END, updated_at = now()
    WHERE tenant_id = $1::uuid AND id = $2::uuid
      AND event_type = 'file.delete-blob' AND aggregate_id = $3
      AND completed_at IS NULL AND dead_lettered_at IS NULL
      AND lease_epoch = $5::bigint
    RETURNING id
    ), already_acknowledged AS (
      SELECT id FROM runtime_outbox
      WHERE tenant_id = $1::uuid AND id = $2::uuid
        AND event_type = 'file.delete-blob' AND aggregate_id = $3
        AND completed_at IS NOT NULL AND dead_lettered_at IS NULL
    )
    SELECT id FROM acknowledged
    UNION ALL
    SELECT id FROM already_acknowledged
    LIMIT 1
  `, [payload.tenantId, payload.outboxId, payload.blobId, note, payload.leaseEpoch ?? 1]);
  if (!rows[0]) throw new Error("Blob-deletion outbox receipt could not be recorded");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
