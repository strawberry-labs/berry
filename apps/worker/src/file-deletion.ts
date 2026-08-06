import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import type { FileDeleteObjectJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";

export interface FileObjectDeleter {
  delete(payload: FileDeleteObjectJobPayload): Promise<{ deleted: number }>;
}

export interface FileDeletionReceiptStore {
  acknowledge(payload: FileDeleteObjectJobPayload): Promise<void>;
}

export class SqlFileDeletionReceiptStore implements FileDeletionReceiptStore {
  constructor(private readonly executor: SqlExecutor) {}

  async acknowledge(payload: FileDeleteObjectJobPayload): Promise<void> {
    const rows = await this.executor.query<{ id: string }>(`
      UPDATE runtime_outbox
      SET completed_at = COALESCE(completed_at, now()),
          lease_owner = NULL, lease_expires_at = NULL,
          last_error = NULL, updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
        AND event_type = 'file.delete-object' AND aggregate_id = $3
      RETURNING id
    `, [payload.tenantId, payload.outboxId, payload.fileId]);
    if (!rows[0]) throw new Error("Object-deletion outbox receipt could not be recorded");
  }
}

export class S3FileObjectDeleter implements FileObjectDeleter {
  constructor(
    private readonly client: S3Client,
    private readonly receipts: FileDeletionReceiptStore,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv, receipts: FileDeletionReceiptStore): S3FileObjectDeleter | null {
    const endpoint = env.BERRY_ARTIFACT_S3_ENDPOINT;
    const accessKeyId = env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) return null;
    return new S3FileObjectDeleter(new S3Client({
      endpoint,
      region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }), receipts);
  }

  async delete(payload: FileDeleteObjectJobPayload): Promise<{ deleted: number }> {
    const keys = [...new Set(payload.keys)];
    const objects: Array<{ Key: string; VersionId?: string }> = [];
    for (const key of keys) {
      objects.push(...await this.listEveryVersion(payload.bucket, key));
    }
    for (let offset = 0; offset < objects.length; offset += 1_000) {
      const response = await this.client.send(new DeleteObjectsCommand({
        Bucket: payload.bucket,
        Delete: {
          Quiet: true,
          Objects: objects.slice(offset, offset + 1_000),
        },
      }));
      if (response.Errors?.length) {
        throw new Error(`Object storage rejected ${response.Errors.length} file deletion${response.Errors.length === 1 ? "" : "s"}`);
      }
    }
    // The outbox row remains pending until this acknowledgement succeeds.
    // Retrying after an acknowledgement failure is safe because S3 deletion
    // is idempotent, and prevents a transient DB error from losing cleanup.
    await this.receipts.acknowledge(payload);
    return { deleted: keys.length };
  }

  private async listEveryVersion(bucket: string, key: string): Promise<Array<{ Key: string; VersionId?: string }>> {
    const objects: Array<{ Key: string; VersionId?: string }> = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const response = await this.client.send(new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }));
      for (const candidate of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
        if (candidate.Key !== key) continue;
        objects.push(candidate.VersionId === undefined
          ? { Key: key }
          : { Key: key, VersionId: candidate.VersionId });
      }
      if (!response.IsTruncated) break;
      const nextKeyMarker = response.NextKeyMarker;
      const nextVersionIdMarker = response.NextVersionIdMarker;
      if ((!nextKeyMarker && !nextVersionIdMarker)
        || (nextKeyMarker === keyMarker && nextVersionIdMarker === versionIdMarker)) {
        throw new Error(`Object storage returned invalid version pagination for ${key}`);
      }
      keyMarker = nextKeyMarker;
      versionIdMarker = nextVersionIdMarker;
    } while (true);

    // Unversioned buckets do not return version entries. A key-only delete is
    // the correct physical delete for that storage mode.
    return objects.length > 0 ? deduplicateObjects(objects) : [{ Key: key }];
  }
}

function deduplicateObjects(
  objects: readonly { Key: string; VersionId?: string }[],
): Array<{ Key: string; VersionId?: string }> {
  const seen = new Set<string>();
  return objects.filter((object) => {
    const identity = `${object.Key}\0${object.VersionId ?? ""}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
