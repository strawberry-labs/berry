import { DeleteObjectsCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import type { FileDeleteObjectJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { s3ClientOptions } from "./s3-client-options.js";

export interface FileObjectDeleter {
  delete(payload: FileDeleteObjectJobPayload): Promise<{ deleted: number }>;
}

export interface FileDeletionReceiptStore {
  deletableKeys?(payload: FileDeleteObjectJobPayload): Promise<readonly string[]>;
  acknowledge(payload: FileDeleteObjectJobPayload): Promise<void>;
}

export class SqlFileDeletionReceiptStore implements FileDeletionReceiptStore {
  constructor(private readonly executor: SqlExecutor) {}

  async deletableKeys(payload: FileDeleteObjectJobPayload): Promise<readonly string[]> {
    const requested = [...new Set(payload.keys)];
    if (requested.length === 0) return [];
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [payload.tenantId]);
      const [locationGuard] = await executor.query<{ guard_name: string | null }>(`
        SELECT to_regclass('file_blobs_physical_location_unique')::text AS guard_name
      `);
      if (!locationGuard?.guard_name) {
        throw new Error("Physical file-location uniqueness guard is unavailable; refusing object deletion");
      }
      const canonical = await executor.query<{ object_key: string }>(`
        SELECT object_key
        FROM file_blobs
        WHERE tenant_id = $1::uuid AND bucket = $2
          AND object_key = ANY($3::text[])
      `, [payload.tenantId, payload.bucket, requested]);
      const protectedKeys = new Set(canonical.map((row) => row.object_key));
      return requested.filter((key) => !protectedKeys.has(key));
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }

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
    if (!env.BERRY_ARTIFACT_S3_BUCKET) return null;
    return new S3FileObjectDeleter(new S3Client(s3ClientOptions({ endpoint, region: env.BERRY_ARTIFACT_S3_REGION, accessKeyId, secretAccessKey })), receipts);
  }

  async delete(payload: FileDeleteObjectJobPayload): Promise<{ deleted: number }> {
    const requested = [...new Set(payload.keys)];
    const allowed = this.receipts.deletableKeys
      ? await this.receipts.deletableKeys(payload)
      : requested;
    const requestedSet = new Set(requested);
    const keys = [...new Set(allowed)].filter((key) => requestedSet.has(key));
    await deleteEveryObjectVersion(this.client, payload.bucket, keys);
    // The outbox row remains pending until this acknowledgement succeeds.
    // Retrying after an acknowledgement failure is safe because S3 deletion
    // is idempotent, and prevents a transient DB error from losing cleanup.
    await this.receipts.acknowledge(payload);
    return { deleted: keys.length };
  }

}

export async function deleteEveryObjectVersion(
  client: Pick<S3Client, "send">,
  bucket: string,
  keys: readonly string[],
): Promise<void> {
  const objects: Array<{ Key: string; VersionId?: string }> = [];
  for (const key of [...new Set(keys)]) {
    objects.push(...await listEveryVersion(client, bucket, key));
  }
  for (let offset = 0; offset < objects.length; offset += 1_000) {
    const response = await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Quiet: true, Objects: objects.slice(offset, offset + 1_000) },
    }));
    if (response.Errors?.length) {
      throw new Error(`Object storage rejected ${response.Errors.length} file deletion${response.Errors.length === 1 ? "" : "s"}`);
    }
  }
}

async function listEveryVersion(
  client: Pick<S3Client, "send">,
  bucket: string,
  key: string,
): Promise<Array<{ Key: string; VersionId?: string }>> {
    const objects: Array<{ Key: string; VersionId?: string }> = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const response = await client.send(new ListObjectVersionsCommand({
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

  if (objects.length > 0) return deduplicateObjects(objects);
  // Avoid creating a fresh delete marker when a retry reaches a versioned key
  // whose versions were removed before the durable receipt committed.
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return [{ Key: key }];
  } catch (error) {
    if (isMissingObject(error)) return [];
    throw error;
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

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NoSuchKey"
    || candidate.name === "NotFound"
    || candidate.$metadata?.httpStatusCode === 404;
}
