import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.ts";

export type FileStorageConfig = {
  client: S3Client;
  presignClient: S3Client;
  bucket: string;
  prefix: string;
  maxUploadBytes: number;
  partSize: number;
  presignSeconds: number;
};

export const FILE_STORAGE_CONFIG = Symbol("FILE_STORAGE_CONFIG");

type FileRow = {
  id: string;
  owner_user_id: string | null;
  original_name: string;
  display_name: string;
  media_type: string;
  detected_media_type: string | null;
  size_bytes: string | number;
  sha256: string | null;
  bucket: string;
  object_key: string;
  etag: string | null;
  origin: "user_upload" | "sandbox_output" | "image_generation" | "browser_capture" | "legacy_artifact";
  status: "initiated" | "uploading" | "scanning" | "processing" | "available" | "failed" | "quarantined" | "deleted";
  created_at: Date | string;
  updated_at: Date | string;
  task_ids?: string[] | null;
  roles?: Array<"input" | "output" | "reference"> | null;
};

type UploadRow = {
  id: string;
  file_id: string;
  provider_upload_id: string;
  part_size: number;
  part_count: number;
  status: string;
  expires_at: Date | string;
  object_key: string;
};

@Injectable()
export class FilePlatformService {
  constructor(
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(FILE_STORAGE_CONFIG) private readonly config: FileStorageConfig | null,
  ) {}

  async list(tenantId: string, userId: string, filters: { taskId?: string; category?: string; search?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    return this.database.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        WITH expired AS (
          UPDATE file_uploads SET status = 'expired', updated_at = now()
          WHERE tenant_id = $1::uuid AND status = 'uploading' AND expires_at <= now()
          RETURNING file_id
        )
        UPDATE files SET status = 'failed', updated_at = now()
        WHERE tenant_id = $1::uuid AND id IN (SELECT file_id FROM expired) AND status = 'uploading'
      `, [tenantId]);
      const values: unknown[] = [tenantId, userId];
      const where = ["f.tenant_id = $1::uuid", "f.owner_user_id = $2::uuid", "f.deleted_at IS NULL", "f.status IN ('available', 'processing')"];
      if (filters.taskId) {
        values.push(filters.taskId);
        where.push(`EXISTS (SELECT 1 FROM file_associations task_link WHERE task_link.file_id = f.id AND task_link.task_id = $${values.length}::uuid)`);
      }
      if (filters.category === "images") where.push("f.media_type LIKE 'image/%'");
      if (filters.category === "documents") where.push("f.media_type NOT LIKE 'image/%'");
      if (filters.search?.trim()) {
        values.push(`%${filters.search.trim()}%`);
        where.push(`f.display_name ILIKE $${values.length}`);
      }
      if (filters.cursor) {
        const [createdAt, id] = decodeCursor(filters.cursor);
        values.push(createdAt, id);
        where.push(`(f.created_at, f.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);
      const rows = await executor.query<FileRow>(`
        SELECT f.*,
          COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
          COALESCE(
            array_remove(array_agg(DISTINCT a.role::text), NULL),
            ARRAY[]::text[]
          ) AS roles
        FROM files f
        LEFT JOIN file_associations a ON a.file_id = f.id
        WHERE ${where.join(" AND ")}
        GROUP BY f.id
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $${values.length}
      `, values);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(fileDto),
        nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      };
    });
  }

  async get(tenantId: string, userId: string, fileId: string): Promise<FileRow> {
    return this.database.withTenant(tenantId, async (executor) => this.requireOwnedFile(executor, tenantId, userId, fileId));
  }

  async initiateUpload(tenantId: string, userId: string, input: {
    name: string;
    mediaType: string;
    size: number;
    taskId?: string;
    sessionId?: string;
    sha256?: string;
    origin?: "user_upload" | "image_generation" | "browser_capture";
    associationRole?: "input" | "output" | "reference";
  }) {
    const config = this.requireConfig();
    const name = safeFileName(input.name);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > config.maxUploadBytes) {
      throw new BadRequestException(`Files are limited to ${config.maxUploadBytes} bytes`);
    }
    const partCount = Math.max(1, Math.ceil(input.size / config.partSize));
    if (partCount > 10_000) throw new BadRequestException("The file requires too many upload parts");
    const fileId = randomUUID();
    const objectKey = `${config.prefix}/tenants/${tenantId}/users/${userId}/files/${fileId}/original/${name}`;
    const created = await config.client.send(new CreateMultipartUploadCommand({
      Bucket: config.bucket,
      Key: objectKey,
      ContentType: input.mediaType || "application/octet-stream",
      Metadata: { "file-id": fileId, "original-name": encodeURIComponent(input.name), source: "web-upload" },
    }));
    if (!created.UploadId) throw new Error("Object storage did not return a multipart upload id");
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    try {
      await this.database.withTenant(tenantId, async (executor) => {
        if (input.taskId) await requireTask(executor, tenantId, input.taskId);
        await executor.execute(`
          INSERT INTO files (id, tenant_id, owner_user_id, original_name, display_name, media_type, size_bytes, sha256, bucket, object_key, origin, status)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $4, $5, $6, $7, $8, $9, $10::file_origin, 'uploading')
        `, [fileId, tenantId, userId, input.name, input.mediaType || "application/octet-stream", input.size, input.sha256 ?? null, config.bucket, objectKey, input.origin ?? "user_upload"]);
        await executor.execute(`
          INSERT INTO file_uploads (id, tenant_id, file_id, provider_upload_id, part_size, part_count, expires_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
        `, [uploadId, tenantId, fileId, created.UploadId, config.partSize, partCount, expiresAt.toISOString()]);
        if (input.taskId) await associate(executor, { tenantId, fileId, taskId: input.taskId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), role: input.associationRole ?? "input", userId });
      });
    } catch (error) {
      await config.client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: objectKey, UploadId: created.UploadId })).catch(() => undefined);
      throw error;
    }
    return { fileId, uploadId, partSize: config.partSize, partCount, expiresAt: expiresAt.toISOString() };
  }

  async presignParts(tenantId: string, userId: string, fileId: string, uploadId: string, partNumbers: number[]) {
    const config = this.requireConfig();
    const upload = await this.requireUpload(tenantId, userId, fileId, uploadId);
    const unique = [...new Set(partNumbers)];
    if (unique.length === 0 || unique.length > 100 || unique.some((part) => !Number.isInteger(part) || part < 1 || part > upload.part_count)) {
      throw new BadRequestException("A valid batch of upload part numbers is required");
    }
    const parts = await Promise.all(unique.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(config.presignClient, new UploadPartCommand({
        Bucket: config.bucket,
        Key: upload.object_key,
        UploadId: upload.provider_upload_id,
        PartNumber: partNumber,
      }), { expiresIn: config.presignSeconds }),
    })));
    return { parts };
  }

  async completeUpload(tenantId: string, userId: string, fileId: string, uploadId: string, parts: CompletedPart[]) {
    const config = this.requireConfig();
    const upload = await this.requireUpload(tenantId, userId, fileId, uploadId);
    const ordered = [...parts].sort((left, right) => Number(left.PartNumber) - Number(right.PartNumber));
    if (ordered.length !== upload.part_count || ordered.some((part, index) => part.PartNumber !== index + 1 || !part.ETag)) {
      throw new BadRequestException("Every uploaded part and ETag is required");
    }
    const completed = await config.client.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: upload.object_key,
      UploadId: upload.provider_upload_id,
      MultipartUpload: { Parts: ordered },
    }));
    const head = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: upload.object_key }));
    const file = await this.database.withTenant(tenantId, async (executor) => {
      await executor.execute(`UPDATE file_uploads SET status = 'completed', completed_at = now(), updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, uploadId]);
      await executor.execute(`
        UPDATE files SET status = 'available', size_bytes = $3, etag = $4, object_version_id = $5, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [tenantId, fileId, Number(head.ContentLength ?? 0), cleanEtag(head.ETag ?? completed.ETag), completed.VersionId ?? null]);
      return this.requireOwnedFile(executor, tenantId, userId, fileId);
    });
    return fileDto(file);
  }

  async abortUpload(tenantId: string, userId: string, fileId: string, uploadId: string) {
    const config = this.requireConfig();
    const upload = await this.requireUpload(tenantId, userId, fileId, uploadId);
    await config.client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: upload.object_key, UploadId: upload.provider_upload_id }));
    await this.database.withTenant(tenantId, async (executor) => {
      await executor.execute(`UPDATE file_uploads SET status = 'aborted', aborted_at = now(), updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, uploadId]);
      await executor.execute(`UPDATE files SET status = 'failed', updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, fileId]);
    });
    return { ok: true };
  }

  async associateInputFiles(tenantId: string, userId: string, input: { fileIds: string[]; taskId: string; sessionId: string; messageId?: string }) {
    if (input.fileIds.length === 0) return;
    await this.database.withTenant(tenantId, async (executor) => {
      await requireTask(executor, tenantId, input.taskId);
      for (const fileId of [...new Set(input.fileIds)]) {
        await this.requireOwnedFile(executor, tenantId, userId, fileId);
        await associate(executor, { tenantId, fileId, taskId: input.taskId, sessionId: input.sessionId, ...(input.messageId ? { messageId: input.messageId } : {}), role: "input", userId });
      }
    });
  }

  async runtimeAttachments(tenantId: string, userId: string, attachments: Array<{ fileId?: string | undefined; id?: string | undefined; name: string; mediaType: string; size: number; sourceKind?: string | null | undefined; dataUrl?: string | null | undefined; textContent?: string | null | undefined; localPath?: string | null | undefined }>, context: { taskId: string; sessionId: string }) {
    const config = this.requireConfig();
    const resolved = [];
    for (const attachment of attachments) {
      const fileId = attachment.fileId ?? (attachment.id && /^[0-9a-f-]{36}$/i.test(attachment.id) ? attachment.id : undefined);
      if (!fileId) {
        resolved.push(attachment);
        continue;
      }
      const file = await this.get(tenantId, userId, fileId);
      if (file.status !== "available" && file.status !== "processing") throw new BadRequestException(`File ${file.display_name} is not available`);
      const remoteUrl = await getSignedUrl(config.presignClient, new GetObjectCommand({ Bucket: file.bucket, Key: file.object_key }), { expiresIn: config.presignSeconds });
      const mediaType = file.detected_media_type ?? file.media_type;
      let dataUrl = attachment.dataUrl ?? null;
      if (!dataUrl && mediaType.startsWith("image/") && Number(file.size_bytes) <= 25 * 1024 * 1024) {
        const image = await config.client.send(new GetObjectCommand({ Bucket: file.bucket, Key: file.object_key }));
        if (image.Body) dataUrl = `data:${mediaType};base64,${Buffer.from(await image.Body.transformToByteArray()).toString("base64")}`;
      }
      resolved.push({
        ...attachment,
        id: file.id,
        fileId: file.id,
        name: file.display_name,
        mediaType,
        size: Number(file.size_bytes),
        remoteUrl,
        ...(dataUrl ? { dataUrl } : {}),
        sourceKind: attachment.sourceKind ?? "object-storage",
      });
    }
    await this.associateInputFiles(tenantId, userId, { fileIds: resolved.flatMap((item) => "fileId" in item && typeof item.fileId === "string" ? [item.fileId] : []), ...context });
    return resolved;
  }

  async registerSandboxOutput(tenantId: string, userId: string, input: { key: string; name: string; mediaType: string; size?: number; taskId: string; sessionId: string; turnId?: string; origin?: "sandbox_output" | "image_generation" | "browser_capture" }) {
    const config = this.requireConfig();
    if (!input.key.startsWith(`${config.prefix}/`) || input.key.includes("..") || input.key.includes("\\")) throw new BadRequestException("Invalid artifact object key");
    const head = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: input.key }));
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<FileRow>(`
        INSERT INTO files (tenant_id, owner_user_id, original_name, display_name, media_type, size_bytes, bucket, object_key, etag, origin, status)
        VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5, $6, $7, $8, $9::file_origin, 'available')
        ON CONFLICT (tenant_id, object_key) DO UPDATE SET
          owner_user_id = EXCLUDED.owner_user_id,
          display_name = EXCLUDED.display_name,
          media_type = EXCLUDED.media_type,
          size_bytes = EXCLUDED.size_bytes,
          etag = EXCLUDED.etag,
          status = 'available',
          updated_at = now()
        RETURNING *
      `, [tenantId, userId, input.name, input.mediaType, Number(head.ContentLength ?? input.size ?? 0), config.bucket, input.key, cleanEtag(head.ETag), input.origin ?? "sandbox_output"]);
      const file = rows[0]!;
      await associate(executor, { tenantId, fileId: file.id, taskId: input.taskId, sessionId: input.sessionId, ...(input.turnId ? { turnId: input.turnId } : {}), role: "output", userId });
      return fileDto({ ...file, task_ids: [input.taskId], roles: ["output"] });
    });
  }

  async streamContent(tenantId: string, userId: string, fileId: string, range: string | undefined, response: ServerResponse, download = false) {
    const config = this.requireConfig();
    const file = await this.get(tenantId, userId, fileId);
    if (file.status !== "available" && file.status !== "processing") throw new NotFoundException("File is not available");
    const object = await config.client.send(new GetObjectCommand({ Bucket: file.bucket, Key: file.object_key, ...(range ? { Range: range } : {}) }));
    if (!object.Body) throw new NotFoundException("File content is unavailable");
    response.statusCode = object.ContentRange ? 206 : 200;
    response.setHeader("Content-Type", object.ContentType ?? file.media_type);
    if (object.ContentLength != null) response.setHeader("Content-Length", String(object.ContentLength));
    if (object.ContentRange) response.setHeader("Content-Range", object.ContentRange);
    response.setHeader("Accept-Ranges", object.AcceptRanges ?? "bytes");
    response.setHeader("Cache-Control", "private, max-age=300");
    response.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.display_name)}`);
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  }

  private requireConfig(): FileStorageConfig {
    if (!this.config) throw new BadRequestException("File storage is not configured");
    return this.config;
  }

  private async requireUpload(tenantId: string, userId: string, fileId: string, uploadId: string): Promise<UploadRow> {
    return this.database.withTenant(tenantId, async (executor) => {
      await this.requireOwnedFile(executor, tenantId, userId, fileId);
      const [row] = await executor.query<UploadRow>(`
        SELECT u.*, f.object_key FROM file_uploads u JOIN files f ON f.id = u.file_id
        WHERE u.tenant_id = $1::uuid AND u.id = $2::uuid AND u.file_id = $3::uuid AND u.status = 'uploading' AND u.expires_at > now()
      `, [tenantId, uploadId, fileId]);
      if (!row) throw new NotFoundException("Upload session not found or expired");
      return row;
    });
  }

  private async requireOwnedFile(executor: SqlExecutor, tenantId: string, userId: string, fileId: string): Promise<FileRow> {
    const [row] = await executor.query<FileRow>(`
      SELECT f.*,
        COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
        COALESCE(
          array_remove(array_agg(DISTINCT a.role::text), NULL),
          ARRAY[]::text[]
        ) AS roles
      FROM files f LEFT JOIN file_associations a ON a.file_id = f.id
      WHERE f.tenant_id = $1::uuid AND f.owner_user_id = $2::uuid AND f.id = $3::uuid AND f.deleted_at IS NULL
      GROUP BY f.id
    `, [tenantId, userId, fileId]);
    if (!row) throw new NotFoundException("File not found");
    return row;
  }
}

function fileDto(row: FileRow) {
  return {
    id: row.id,
    name: row.display_name,
    originalName: row.original_name,
    mediaType: row.detected_media_type ?? row.media_type,
    detectedMediaType: row.detected_media_type,
    size: Number(row.size_bytes),
    sha256: row.sha256,
    origin: row.origin,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    taskIds: row.task_ids ?? [],
    roles: row.roles ?? [],
    downloadUrl: `/v1/files/${row.id}/content?download=1`,
    previewUrl: `/v1/files/${row.id}/content`,
  };
}

async function requireTask(executor: SqlExecutor, tenantId: string, taskId: string) {
  const [task] = await executor.query<{ id: string }>("SELECT id FROM tasks WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL", [tenantId, taskId]);
  if (!task) throw new NotFoundException("Task not found");
}

async function associate(executor: SqlExecutor, input: { tenantId: string; fileId: string; taskId?: string; sessionId?: string; messageId?: string; turnId?: string; role: string; userId: string }) {
  await executor.execute(`
    INSERT INTO file_associations (tenant_id, file_id, task_id, session_id, message_id, turn_id, role, created_by_user_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::file_association_role, $8::uuid)
    ON CONFLICT DO NOTHING
  `, [input.tenantId, input.fileId, input.taskId ?? null, input.sessionId ?? null, input.messageId ?? null, input.turnId ?? null, input.role, input.userId]);
}

function safeFileName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\\/\0]/g, "-").replace(/[^\p{L}\p{N}._() -]+/gu, "-").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!normalized) throw new BadRequestException("A valid filename is required");
  return normalized;
}

function cleanEtag(value: string | undefined): string | null {
  return value ? value.replace(/^\"|\"$/g, "") : null;
}

function encodeCursor(createdAt: Date | string, id: string): string {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) throw new Error("invalid");
    return [createdAt, id];
  } catch {
    throw new BadRequestException("Invalid file-list cursor");
  }
}
