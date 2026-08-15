import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { open as openFile, rm } from "node:fs/promises";
import {
  FILE_RESPONSE_SECURITY_VERSION,
  ORGANIZATION_FAVICON_MAX_BYTES,
  ORGANIZATION_FAVICON_MEDIA_TYPES,
  ORGANIZATION_LOGO_MAX_BYTES,
  ORGANIZATION_LOGO_MEDIA_TYPES,
  durableContextConfigFromEnv,
  type OrganizationBrandingAssetKind,
} from "@berry/shared";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.ts";
import { garbageCollectFileIfUnreferenced } from "./file-lifecycle.ts";
import {
  bufferBodyPrefix,
  detectMediaType,
  FILE_TYPE_SAMPLE_BYTES,
  fileResponsePolicy,
  INVALID_FILE_CACHE_CONTROL,
  normalizeMediaType,
  PROTECTED_FILE_CACHE_CONTROL,
  PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL,
  readBodyBounded,
  setUntrustedFileResponseHeaders,
} from "./file-response-security.ts";

export type FileStorageConfig = {
  client: S3Client;
  presignClient: S3Client;
  bucket: string;
  prefix: string;
  maxUploadBytes: number;
  maxIndexableBytes: number;
  partSize: number;
  presignSeconds: number;
};

export const FILE_STORAGE_CONFIG = Symbol("FILE_STORAGE_CONFIG");

type FileRow = {
  id: string;
  blob_id?: string | null;
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
  object_version_id: string | null;
  origin: "user_upload" | "sandbox_output" | "image_generation" | "browser_capture" | "legacy_artifact" | "connector_import";
  status: "initiated" | "uploading" | "scanning" | "processing" | "available" | "failed" | "quarantined" | "deleted";
  metadata?: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at?: Date | string | null;
  resolved_bucket?: string | null;
  resolved_object_key?: string | null;
  resolved_size_bytes?: string | number | null;
  resolved_sha256?: string | null;
  resolved_etag?: string | null;
  resolved_object_version_id?: string | null;
  task_ids?: string[] | null;
  roles?: Array<"input" | "output" | "reference"> | null;
  workspace_id?: string | null;
  workspace_visibility?: "project" | "task_only" | null;
  index_status?: "pending" | "extracting" | "chunking" | "embedding" | "indexed" | "failed" | "deleted" | null;
  vector_ready?: boolean | null;
  failure_reason?: string | null;
  in_library?: boolean;
};

const FILE_PHYSICAL_COLUMNS = `
  CASE WHEN f.blob_id IS NOT NULL THEN blob.bucket ELSE f.bucket END AS resolved_bucket,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS resolved_object_key,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.size_bytes ELSE f.size_bytes END AS resolved_size_bytes,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.sha256 ELSE f.sha256 END AS resolved_sha256,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.etag ELSE f.etag END AS resolved_etag,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.object_version_id ELSE f.object_version_id END AS resolved_object_version_id
`;

type UploadRow = {
  id: string;
  file_id: string;
  provider_upload_id: string;
  part_size: number;
  part_count: number;
  status: string;
  expires_at: Date | string;
  object_key: string;
  declared_size_bytes: number | string;
  blob_id: string | null;
};

@Injectable()
export class FilePlatformService {
  readonly #durableConfig = durableContextConfigFromEnv(process.env);

  constructor(
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(FILE_STORAGE_CONFIG) private readonly config: FileStorageConfig | null,
  ) {}

  async list(tenantId: string, userId: string, filters: { taskId?: string; workspaceId?: string; category?: string; search?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    return this.database.withTenant(tenantId, async (executor) => {
      if (filters.workspaceId) await requireWorkspaceAccess(executor, tenantId, userId, filters.workspaceId);
      const expiredUploads = await executor.query<{ file_id: string }>(`
        UPDATE file_uploads
        SET status = 'expired', updated_at = now()
        WHERE tenant_id = $1::uuid AND status = 'uploading' AND expires_at <= now()
        RETURNING file_id
      `, [tenantId]);
      for (const upload of expiredUploads) {
        await retireTerminalUpload(executor, tenantId, upload.file_id, {
          status: "failed",
          reason: "expired",
        });
      }
      const values: unknown[] = [tenantId, userId];
      const where = [
        "f.tenant_id = $1::uuid",
        "library.user_id = $2::uuid",
        "library.deleted_at IS NULL",
        "f.deleted_at IS NULL",
        "f.status IN ('available', 'processing')",
      ];
      if (filters.taskId) {
        values.push(filters.taskId);
        where.push(`EXISTS (SELECT 1 FROM file_associations task_link WHERE task_link.file_id = f.id AND task_link.task_id = $${values.length}::uuid)`);
      }
      if (filters.workspaceId) {
        values.push(filters.workspaceId);
        where.push(`(
          EXISTS (
            SELECT 1
            FROM file_associations workspace_task_link
            JOIN tasks workspace_task ON workspace_task.id = workspace_task_link.task_id
            WHERE workspace_task_link.file_id = f.id
              AND workspace_task.tenant_id = f.tenant_id
              AND workspace_task.workspace_id = $${values.length}::uuid
              AND workspace_task.deleted_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM workspace_files project_file_link
            WHERE project_file_link.tenant_id = f.tenant_id
              AND project_file_link.workspace_id = $${values.length}::uuid
              AND project_file_link.file_id = f.id
              AND project_file_link.deleted_at IS NULL
          )
        )`);
      }
      if (filters.category === "images") where.push("f.media_type LIKE 'image/%'");
      if (filters.category === "documents") where.push("f.media_type NOT LIKE 'image/%'");
      if (filters.search?.trim()) {
        values.push(`%${escapeLikePattern(filters.search.trim())}%`);
        where.push(`(f.display_name ILIKE $${values.length} ESCAPE '\\' OR f.original_name ILIKE $${values.length} ESCAPE '\\')`);
      }
      if (filters.cursor) {
        const [createdAt, id] = decodeCursor(filters.cursor);
        values.push(createdAt, id);
        where.push(`(f.created_at, f.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);
      const rows = await executor.query<FileRow>(`
        SELECT f.*,
          ${FILE_PHYSICAL_COLUMNS},
          COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
          COALESCE(
            array_remove(array_agg(DISTINCT a.role::text), NULL),
            ARRAY[]::text[]
          ) AS roles
        FROM files f
        JOIN file_library_entries library
          ON library.tenant_id = f.tenant_id AND library.file_id = f.id
        LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
        LEFT JOIN file_associations a ON a.file_id = f.id
        WHERE ${where.join(" AND ")}
        GROUP BY f.id, blob.id, library.id
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $${values.length}
      `, values);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => fileDto(resolvePhysicalFile(row))),
        nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      };
    });
  }

  async get(tenantId: string, userId: string, fileId: string): Promise<FileRow> {
    return this.database.withTenant(tenantId, async (executor) => this.requireAccessibleFile(executor, tenantId, userId, fileId));
  }

  /**
   * Authorize a legacy object URL through its registered logical file. A false
   * result means the key predates (or never reached) FilePlatform registration;
   * a registered but inaccessible file still fails closed with a 404.
   */
  async authorizeRegisteredArtifactObjectKey(tenantId: string, userId: string, objectKey: string): Promise<boolean> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [registered] = await executor.query<{ id: string }>(`
        SELECT id
        FROM files
        WHERE tenant_id=$1::uuid AND object_key=$2 AND deleted_at IS NULL
        LIMIT 1
      `, [tenantId, objectKey]);
      if (!registered) return false;
      await this.requireAccessibleFile(executor, tenantId, userId, registered.id);
      return true;
    });
  }

  async downloadContentToFile(
    tenantId: string,
    userId: string,
    fileId: string,
    maxBytes: number,
    destination: string,
  ): Promise<{ name: string; mediaType: string; sizeBytes: number }> {
    const config = this.requireConfig();
    const file = await this.get(tenantId, userId, fileId);
    if (file.status !== "available" && file.status !== "processing") throw new NotFoundException("File is not available");
    const declaredBytes = Number(file.size_bytes);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
      throw new BadRequestException(`File exceeds the ${maxBytes} byte limit`);
    }
    const object = await config.client.send(new GetObjectCommand({
      Bucket: file.bucket,
      Key: file.object_key,
      ...(file.object_version_id ? { VersionId: file.object_version_id } : {}),
    }));
    if (!object.Body) throw new NotFoundException("File content is unavailable");
    const output = await openFile(destination, "wx", 0o600);
    let written = 0;
    try {
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        written += chunk.byteLength;
        if (written > declaredBytes || written > maxBytes) throw new BadRequestException(`File exceeds the ${maxBytes} byte limit`);
        await output.write(chunk);
      }
    } catch (cause) {
      await output.close().catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw cause;
    }
    await output.close();
    if (written !== declaredBytes) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw new BadRequestException("Stored file size does not match its upload record");
    }
    return { name: file.display_name, mediaType: file.detected_media_type ?? file.media_type, sizeBytes: written };
  }

  async describe(tenantId: string, userId: string, fileId: string) {
    return fileDto(await this.get(tenantId, userId, fileId));
  }

  async initiateUpload(tenantId: string, userId: string, input: {
    name: string;
    mediaType: string;
    size: number;
    taskId?: string;
    sessionId?: string;
    workspaceId?: string;
    workspaceVisibility?: "project" | "task_only";
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
    const blobId = randomUUID();
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
        const task = input.taskId ? await requireTask(executor, tenantId, input.taskId, userId) : null;
        const workspaceId = input.workspaceId ?? task?.workspace_id;
        if (input.workspaceId) {
          await requireWorkspaceAccess(executor, tenantId, userId, input.workspaceId);
          if (task && task.workspace_id !== input.workspaceId) throw new BadRequestException("Task and workspace do not match");
        }
        await executor.execute(`
          INSERT INTO file_blobs (
            id, tenant_id, bucket, object_key, size_bytes, verification_status, metadata
          ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'unverified', $6::jsonb)
        `, [blobId, tenantId, config.bucket, objectKey, input.size, JSON.stringify({ expectedSha256: input.sha256 ?? null, source: "web-upload" })]);
        await executor.execute(`
          INSERT INTO files (id, tenant_id, owner_user_id, blob_id, original_name, display_name, media_type, size_bytes, sha256, bucket, object_key, origin, status)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, $6, $7, $8, $9, $10, $11::file_origin, 'uploading')
        `, [fileId, tenantId, userId, blobId, input.name, input.mediaType || "application/octet-stream", input.size, input.sha256 ?? null, config.bucket, objectKey, input.origin ?? "user_upload"]);
        await executor.execute(`
          INSERT INTO file_uploads (id, tenant_id, file_id, provider_upload_id, part_size, part_count, expires_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
        `, [uploadId, tenantId, fileId, created.UploadId, config.partSize, partCount, expiresAt.toISOString()]);
        if (input.taskId) await associate(executor, { tenantId, fileId, taskId: input.taskId, ...(input.sessionId ? { sessionId: input.sessionId } : {}), role: input.associationRole ?? "input", userId });
        if (workspaceId) {
          const workspaceVisibility = input.workspaceVisibility ?? (input.workspaceId ? "project" : "task_only");
          await executor.execute(`
            INSERT INTO workspace_files (
              tenant_id, workspace_id, file_id, visibility, originating_task_id,
              index_status, created_by_user_id
            ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'pending', $6::uuid)
            ON CONFLICT (tenant_id, workspace_id, file_id) DO UPDATE SET
              visibility = EXCLUDED.visibility,
              originating_task_id = COALESCE(workspace_files.originating_task_id, EXCLUDED.originating_task_id),
              deleted_at = NULL,
              updated_at = now()
          `, [tenantId, workspaceId, fileId, workspaceVisibility, input.taskId ?? null, userId]);
        }
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
    if (upload.status !== "uploading") throw new BadRequestException("Upload is already complete");
    const unique = [...new Set(partNumbers)];
    if (unique.length === 0 || unique.length > 100 || unique.some((part) => !Number.isInteger(part) || part < 1 || part > upload.part_count)) {
      throw new BadRequestException("A valid batch of upload part numbers is required");
    }
    const parts = await Promise.all(unique.map(async (partNumber) => ({
      partNumber,
      size: expectedPartBytes(upload, partNumber),
      url: await getSignedUrl(config.presignClient, new UploadPartCommand({
        Bucket: config.bucket,
        Key: upload.object_key,
        UploadId: upload.provider_upload_id,
        PartNumber: partNumber,
        ContentLength: expectedPartBytes(upload, partNumber),
      }), { expiresIn: config.presignSeconds }),
    })));
    return { parts };
  }

  async completeUpload(tenantId: string, userId: string, fileId: string, uploadId: string, parts: CompletedPart[]) {
    const config = this.requireConfig();
    const upload = await this.requireUpload(tenantId, userId, fileId, uploadId);
    if (upload.status === "completed") return this.get(tenantId, userId, fileId);
    const ordered = [...parts].sort((left, right) => Number(left.PartNumber) - Number(right.PartNumber));
    if (ordered.length !== upload.part_count || ordered.some((part, index) => part.PartNumber !== index + 1 || !part.ETag)) {
      throw new BadRequestException("Every uploaded part and ETag is required");
    }
    let completedEtag: string | undefined;
    let completedVersionId: string | undefined;
    let head: HeadObjectCommandOutput | undefined;
    try {
      const completed = await config.client.send(new CompleteMultipartUploadCommand({
        Bucket: config.bucket,
        Key: upload.object_key,
        UploadId: upload.provider_upload_id,
        MultipartUpload: { Parts: ordered },
      }));
      completedEtag = completed.ETag;
      completedVersionId = completed.VersionId;
    } catch (completionError) {
      // CompleteMultipartUpload consumes the provider upload id. If the API
      // died after that side effect but before the PostgreSQL update, the
      // retry receives NoSuchUpload even though the final object is valid.
      try {
        head = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: upload.object_key }));
      } catch {
        throw completionError;
      }
    }
    head ??= await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: upload.object_key }));
    const actualSize = Number(head.ContentLength);
    const declaredSize = Number(upload.declared_size_bytes);
    if (!Number.isSafeInteger(actualSize)
      || actualSize < 0
      || actualSize > config.maxUploadBytes
      || actualSize !== declaredSize) {
      const removed = await config.client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: upload.object_key,
      })).then(() => true, () => false);
      await this.database.withTenant(tenantId, async (executor) => {
        await executor.execute(
          "UPDATE file_uploads SET status='failed',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, uploadId],
        );
        await executor.execute(
          "UPDATE files SET status=$3::file_status,metadata=metadata || $4::jsonb,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [
            tenantId,
            fileId,
            removed ? "failed" : "quarantined",
            JSON.stringify({
              uploadValidation: "size_mismatch",
              declaredSize,
              actualSize: Number.isFinite(actualSize) ? actualSize : null,
              objectRemoved: removed,
            }),
          ],
        );
        await retireTerminalUpload(executor, tenantId, fileId, {
          status: removed ? "failed" : "quarantined",
          reason: "size_mismatch",
        });
      });
      throw new BadRequestException("The uploaded object size does not match the requested upload");
    }
    const completedObjectVersionId = completedVersionId ?? head.VersionId;
    const detectedMediaType = await this.detectStoredObjectMediaType({
      bucket: config.bucket,
      objectKey: upload.object_key,
      ...(completedObjectVersionId ? { objectVersionId: completedObjectVersionId } : {}),
      sizeBytes: actualSize,
    });
    const file = await this.database.withTenant(tenantId, async (executor) => {
      await executor.execute(`UPDATE file_uploads SET status = 'completed', completed_at = now(), updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, uploadId]);
      const [workspaceFile] = await executor.query<{ workspace_id: string; visibility: "project" | "task_only"; originating_task_id: string | null }>(`
        SELECT workspace_id, visibility, originating_task_id
        FROM workspace_files
        WHERE tenant_id = $1::uuid AND file_id = $2::uuid AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `, [tenantId, fileId]);
      const shouldIndex = Boolean(
        workspaceFile
        && this.#durableConfig.projectKnowledgeEnabled
        && actualSize <= config.maxIndexableBytes,
      );
      if (workspaceFile && this.#durableConfig.projectKnowledgeEnabled && !shouldIndex) {
        await executor.execute(
          "UPDATE workspace_files SET index_status='failed',updated_at=now() WHERE tenant_id=$1::uuid AND file_id=$2::uuid",
          [tenantId, fileId],
        );
      }
      await executor.execute(`
        UPDATE files SET status = $6::file_status, size_bytes = $3, etag = $4, object_version_id = $5,
          detected_media_type = $7, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [tenantId, fileId, actualSize, cleanEtag(head.ETag ?? completedEtag), completedVersionId ?? head.VersionId ?? null, shouldIndex ? "processing" : "available", detectedMediaType]);
      await reviveLibraryEntry(executor, tenantId, userId, fileId);
      if (upload.blob_id) {
        await executor.execute(`
          UPDATE file_blobs
          SET size_bytes = $3, etag = $4, object_version_id = $5,
              verification_status = CASE
                WHEN verification_status = 'failed' THEN 'unverified'::file_blob_verification_status
                ELSE verification_status
              END,
              updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
        `, [tenantId, upload.blob_id, actualSize, cleanEtag(head.ETag ?? completedEtag), completedVersionId ?? head.VersionId ?? null]);
        await enqueueBlobVerification(executor, tenantId, upload.blob_id);
      }
      if (workspaceFile && shouldIndex) {
        const revision = completedVersionId ?? head.VersionId ?? cleanEtag(head.ETag ?? completedEtag) ?? `upload-${uploadId}`;
        const contentHash = cleanEtag(head.ETag ?? completedEtag) ?? `file-${fileId}-${revision}`;
        const [source] = await executor.query<{ id: string }>(`
          INSERT INTO knowledge_sources (
            tenant_id, user_id, workspace_id, source_type, source_id, source_revision,
            content_hash, title, visibility, extraction_status, index_status,
            extractor_version, chunker_version, metadata
          )
          SELECT $1::uuid, $2::uuid, wf.workspace_id, 'file', $3::uuid::text, $4, $5, f.display_name,
                 wf.visibility, 'pending', 'pending', 'tika-v1', 'recursive-v1',
                 jsonb_strip_nulls(jsonb_build_object(
                   'fileId', f.id,
                   'mediaType', COALESCE(f.detected_media_type, f.media_type),
                   'objectKey', CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END,
                   'taskId', wf.originating_task_id
                 ))
          FROM workspace_files wf
          JOIN files f ON f.id = wf.file_id
          LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
          WHERE wf.tenant_id = $1::uuid AND wf.file_id = $3::uuid AND wf.deleted_at IS NULL
          ON CONFLICT (tenant_id, workspace_id, source_type, source_id, source_revision)
          DO UPDATE SET tombstoned_at = NULL, failure_reason = NULL, updated_at = now()
          RETURNING id
        `, [tenantId, userId, fileId, revision, contentHash]);
        if (source) {
          await executor.execute(`
            UPDATE knowledge_sources
            SET tombstoned_at = COALESCE(tombstoned_at, now()),
                index_status = 'deleted', vector_ready = false, updated_at = now()
            WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
              AND source_type = 'file' AND source_id = $3
              AND id <> $4::uuid AND tombstoned_at IS NULL
          `, [tenantId, workspaceFile.workspace_id, fileId, source.id]);
          await executor.execute(`
            INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
            VALUES ($1::uuid, 'knowledge.extract', $2, $3, $4::jsonb)
            ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
          `, [
            tenantId,
            source.id,
            `knowledge.extract:${source.id}:${revision}`,
            JSON.stringify({ tenantId, sourceId: source.id, revision }),
          ]);
        }
      }
      return this.requireAccessibleFile(executor, tenantId, userId, fileId);
    });
    return fileDto(file);
  }

  async listWorkspaceFiles(tenantId: string, userId: string, workspaceId: string, filters: {
    visibility?: "project" | "task_only";
    status?: "pending" | "extracting" | "chunking" | "embedding" | "indexed" | "failed";
    search?: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    return this.database.withTenant(tenantId, async (executor) => {
      await requireWorkspaceAccess(executor, tenantId, userId, workspaceId);
      const values: unknown[] = [tenantId, workspaceId, userId];
      const where = [
        "wf.tenant_id = $1::uuid",
        "wf.workspace_id = $2::uuid",
        "wf.deleted_at IS NULL",
        "f.deleted_at IS NULL",
        `(wf.visibility = 'project' OR (
          wf.visibility = 'task_only' AND EXISTS (
            SELECT 1 FROM tasks access_task
            WHERE access_task.id = wf.originating_task_id
              AND access_task.tenant_id = wf.tenant_id
              AND (access_task.user_id = $3::uuid OR access_task.user_id IS NULL)
          )
        ))`,
      ];
      if (filters.visibility) {
        values.push(filters.visibility);
        where.push(`wf.visibility = $${values.length}`);
      }
      if (filters.status) {
        values.push(filters.status);
        where.push(`wf.index_status = $${values.length}`);
      }
      if (filters.search?.trim()) {
        values.push(`%${escapeLikePattern(filters.search.trim())}%`);
        where.push(`(f.display_name ILIKE $${values.length} ESCAPE '\\' OR f.original_name ILIKE $${values.length} ESCAPE '\\')`);
      }
      if (filters.cursor) {
        const [createdAt, id] = decodeCursor(filters.cursor);
        values.push(createdAt, id);
        where.push(`(wf.created_at, wf.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);
      const rows = await executor.query<FileRow>(`
        SELECT f.*,
          ${FILE_PHYSICAL_COLUMNS},
          wf.workspace_id,
          wf.visibility AS workspace_visibility,
          wf.index_status,
          source.vector_ready,
          source.failure_reason,
          COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
          COALESCE(array_remove(array_agg(DISTINCT a.role::text), NULL), ARRAY[]::text[]) AS roles
        FROM workspace_files wf
        JOIN files f ON f.id = wf.file_id
        LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
        LEFT JOIN file_associations a ON a.file_id = f.id
        LEFT JOIN LATERAL (
          SELECT ks.vector_ready, ks.failure_reason
          FROM knowledge_sources ks
          WHERE ks.tenant_id = wf.tenant_id
            AND ks.workspace_id = wf.workspace_id
            AND ks.source_type = 'file'
            AND ks.source_id = wf.file_id::text
            AND ks.tombstoned_at IS NULL
          ORDER BY ks.created_at DESC
          LIMIT 1
        ) source ON true
        WHERE ${where.join(" AND ")}
        GROUP BY f.id, blob.id, wf.id, source.vector_ready, source.failure_reason
        ORDER BY wf.created_at DESC, wf.id DESC
        LIMIT $${values.length}
      `, values);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => fileDto(resolvePhysicalFile(row))),
        nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      };
    });
  }

  async retryWorkspaceFile(tenantId: string, userId: string, workspaceId: string, fileId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      await requireWorkspaceAccess(executor, tenantId, userId, workspaceId);
      const retryId = randomUUID();
      const [source] = await executor.query<{ id: string; source_revision: string }>(`
        UPDATE knowledge_sources
        SET extraction_status = 'pending', index_status = 'pending', vector_ready = false,
            failure_reason = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
          AND source_type = 'file' AND source_id = $3 AND tombstoned_at IS NULL
        RETURNING id, source_revision
      `, [tenantId, workspaceId, fileId]);
      if (!source) throw new NotFoundException("Project file source not found");
      await executor.execute(`
        UPDATE workspace_files SET index_status = 'pending', updated_at = now()
        WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND file_id = $3::uuid AND deleted_at IS NULL
      `, [tenantId, workspaceId, fileId]);
      await executor.execute(`
        INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
        VALUES ($1::uuid, 'knowledge.extract', $2, $3, $4::jsonb)
        ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
          completed_at = NULL, available_at = now(), last_error = NULL, updated_at = now()
      `, [
        tenantId,
        source.id,
        `knowledge.extract:${source.id}:${source.source_revision}:retry:${retryId}`,
        JSON.stringify({ tenantId, sourceId: source.id, revision: source.source_revision, retryId }),
      ]);
      return { ok: true };
    });
  }

  async unlinkWorkspaceFile(tenantId: string, userId: string, workspaceId: string, fileId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      await requireWorkspaceAccess(executor, tenantId, userId, workspaceId);
      const [source] = await executor.query<{ id: string; source_revision: string }>(`
        UPDATE knowledge_sources
        SET tombstoned_at = now(), index_status = 'deleted', updated_at = now()
        WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
          AND source_type = 'file' AND source_id = $3 AND tombstoned_at IS NULL
        RETURNING id, source_revision
      `, [tenantId, workspaceId, fileId]);
      const result = await executor.query<{ id: string }>(`
        UPDATE workspace_files
        SET deleted_at = now(), index_status = 'deleted', updated_at = now()
        WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
          AND file_id = $3::uuid AND deleted_at IS NULL
        RETURNING id
      `, [tenantId, workspaceId, fileId]);
      if (result.length === 0) throw new NotFoundException("Project file not found");
      if (source) {
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
      await garbageCollectFileIfUnreferenced(executor, tenantId, fileId);
      return { ok: true };
    });
  }

  async removeFromLibrary(tenantId: string, userId: string, fileId: string) {
    return this.database.withTenant(tenantId, async (executor) => {
      const [membership] = await executor.query<{ file_id: string; deleted_at: Date | string | null }>(`
        SELECT library.file_id, library.deleted_at
        FROM files f
        JOIN file_library_entries library
          ON library.tenant_id = f.tenant_id AND library.file_id = f.id
        WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid
          AND library.user_id = $3::uuid
        FOR UPDATE OF f, library
      `, [tenantId, fileId, userId]);
      if (!membership) throw new NotFoundException("File not found");
      if (!membership.deleted_at) {
        await executor.execute(`
          UPDATE file_library_entries
          SET deleted_at = now(), updated_at = now()
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid
            AND file_id = $3::uuid AND deleted_at IS NULL
        `, [tenantId, userId, fileId]);
      }
      await garbageCollectFileIfUnreferenced(executor, tenantId, fileId);
      return { ok: true as const };
    });
  }

  async abortUpload(tenantId: string, userId: string, fileId: string, uploadId: string) {
    const config = this.requireConfig();
    const upload = await this.requireUpload(tenantId, userId, fileId, uploadId);
    if (upload.status !== "uploading") throw new BadRequestException("Upload is already complete");
    await config.client.send(new AbortMultipartUploadCommand({
      Bucket: config.bucket,
      Key: upload.object_key,
      UploadId: upload.provider_upload_id,
    })).catch((error) => {
      // A previous request can successfully abort at the provider and lose its
      // database response. Treat the provider's missing-upload result as an
      // idempotent retry, but preserve every other storage failure for retry.
      if (!isNoSuchUpload(error)) throw error;
    });
    await this.database.withTenant(tenantId, async (executor) => {
      await executor.execute(`UPDATE file_uploads SET status = 'aborted', aborted_at = now(), updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, uploadId]);
      await retireTerminalUpload(executor, tenantId, fileId, {
        status: "failed",
        reason: "aborted",
      });
    });
    return { ok: true };
  }

  async associateInputFiles(tenantId: string, userId: string, input: { fileIds: string[]; taskId: string; sessionId: string; messageId?: string; turnId?: string }) {
    if (input.fileIds.length === 0) return [];
    return this.database.withTenant(tenantId, (executor) => associateInputFilesInTransaction(
      executor,
      tenantId,
      userId,
      input,
    ));
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
      const remoteUrl = await getSignedUrl(config.presignClient, new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        ...(file.object_version_id ? { VersionId: file.object_version_id } : {}),
      }), { expiresIn: config.presignSeconds });
      const mediaType = file.detected_media_type ?? file.media_type;
      let dataUrl = attachment.dataUrl ?? null;
      if (!dataUrl && mediaType.startsWith("image/") && Number(file.size_bytes) <= 25 * 1024 * 1024) {
        const image = await config.client.send(new GetObjectCommand({
          Bucket: file.bucket,
          Key: file.object_key,
          ...(file.object_version_id ? { VersionId: file.object_version_id } : {}),
        }));
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

  async importConnectorArtifact(tenantId: string, userId: string, input: {
    connectorKey: string;
    accountEmail: string | null;
    sourceFileId: string;
    sourceRevision: string;
    sourceMimeType: string;
    exportMimeType: string | null;
    saveToLibrary: boolean;
    name: string;
    contentType: string;
    declaredSize: number | null;
    sourceMetadata: Record<string, unknown>;
    body: ReadableStream<Uint8Array>;
    taskId: string;
    sessionId: string;
  }) {
    const config = this.requireConfig();
    const name = safeFileName(input.name);
    const identity = [
      tenantId,
      userId,
      input.connectorKey,
      input.sourceFileId,
      input.sourceRevision,
      input.exportMimeType ?? input.sourceMimeType,
    ].join("\u0000");
    const fileId = stableUuid(identity);
    const uploadAttemptId = randomUUID();
    const objectKey = `${config.prefix}/tenants/${tenantId}/users/${userId}/files/${fileId}/imports/${uploadAttemptId}/${name}`;
    const existing = await this.database.withTenant(tenantId, async (executor) => {
      const task = await requireTask(executor, tenantId, input.taskId, userId);
      await requireSessionForTask(executor, tenantId, input.sessionId, input.taskId, userId);
      const file = await connectorImportFile(executor, tenantId, fileId, userId);
      if (!file) return null;
      assertConnectorIdentity(file, input);
      const promoted = input.saveToLibrary && file.in_library !== true;
      if (input.saveToLibrary) await reviveLibraryEntry(executor, tenantId, userId, fileId);
      await associate(executor, { tenantId, fileId, taskId: input.taskId, sessionId: input.sessionId, role: "input", userId });
      if (input.saveToLibrary) {
        await linkWorkspaceFile(executor, { tenantId, workspaceId: task.workspace_id, fileId, taskId: input.taskId, userId });
      }
      return promoteConnectorKnowledgeIfNeeded(executor, {
        file,
        promoted,
        projectKnowledgeEnabled: this.#durableConfig.projectKnowledgeEnabled,
        maxIndexableBytes: config.maxIndexableBytes,
        tenantId,
        userId,
        workspaceId: task.workspace_id,
        taskId: input.taskId,
        revision: input.sourceRevision,
        title: name,
        mediaType: input.contentType,
      });
    });
    if (existing) {
      await input.body.cancel().catch(() => undefined);
      return connectorArtifactDto(existing, input, true, input.saveToLibrary || existing.in_library === true);
    }

    const maximumBytes = Math.min(100 * 1024 * 1024, config.maxUploadBytes);
    const stored = await storeBoundedMultipart(config, {
      objectKey,
      body: input.body,
      contentType: input.contentType || "application/octet-stream",
      declaredSize: input.declaredSize,
      maximumBytes,
      fileId,
      name,
    });
    let registered = false;
    try {
      const file = await this.database.withTenant(tenantId, async (executor) => {
        await lockConnectorImport(executor, fileId);
        const task = await requireTask(executor, tenantId, input.taskId, userId);
        await requireSessionForTask(executor, tenantId, input.sessionId, input.taskId, userId);
        const raced = await connectorImportFile(executor, tenantId, fileId, userId);
        if (raced) {
          assertConnectorIdentity(raced, input);
          const promoted = input.saveToLibrary && raced.in_library !== true;
          if (input.saveToLibrary) await reviveLibraryEntry(executor, tenantId, userId, fileId);
          await associate(executor, { tenantId, fileId, taskId: input.taskId, sessionId: input.sessionId, role: "input", userId });
          if (input.saveToLibrary) {
            await linkWorkspaceFile(executor, { tenantId, workspaceId: task.workspace_id, fileId, taskId: input.taskId, userId });
          }
          const referenced = await promoteConnectorKnowledgeIfNeeded(executor, {
            file: raced,
            promoted,
            projectKnowledgeEnabled: this.#durableConfig.projectKnowledgeEnabled,
            maxIndexableBytes: config.maxIndexableBytes,
            tenantId,
            userId,
            workspaceId: task.workspace_id,
            taskId: input.taskId,
            revision: input.sourceRevision,
            title: name,
            mediaType: input.contentType,
          });
          return { file: referenced, reused: true, library: input.saveToLibrary || raced.in_library === true };
        }
        const blobId = randomUUID();
        const shouldIndex = input.saveToLibrary
          && this.#durableConfig.projectKnowledgeEnabled
          && stored.size <= config.maxIndexableBytes;
        const metadata = connectorImportMetadata(input);
        await executor.execute(`
          INSERT INTO file_blobs (
            id, tenant_id, bucket, object_key, size_bytes, sha256, etag,
            object_version_id, verification_status, metadata
          ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'unverified', $9::jsonb)
        `, [blobId, tenantId, config.bucket, objectKey, stored.size, stored.sha256, stored.etag, stored.versionId, JSON.stringify({ source: "google-drive", expectedSha256: stored.sha256, ...metadata })]);
        const [created] = await executor.query<FileRow>(`
          INSERT INTO files (
            id, tenant_id, owner_user_id, blob_id, original_name, display_name,
            media_type, size_bytes, sha256, bucket, object_key, etag,
            object_version_id, origin, status, metadata
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, $6, $7, $8,
            $9, $10, $11, $12, 'connector_import', $13::file_status, $14::jsonb
          )
          RETURNING *
        `, [fileId, tenantId, userId, blobId, name, input.contentType || "application/octet-stream", stored.size, stored.sha256, config.bucket, objectKey, stored.etag, stored.versionId, shouldIndex ? "processing" : "available", JSON.stringify(metadata)]);
        if (!created) throw new Error("Unable to register the Drive artifact");
        if (input.saveToLibrary) await reviveLibraryEntry(executor, tenantId, userId, fileId);
        await associate(executor, { tenantId, fileId, taskId: input.taskId, sessionId: input.sessionId, role: "input", userId });
        if (input.saveToLibrary) {
          await linkWorkspaceFile(executor, { tenantId, workspaceId: task.workspace_id, fileId, taskId: input.taskId, userId });
        }
        await enqueueBlobVerification(executor, tenantId, blobId);
        if (shouldIndex) {
          await enqueueConnectorKnowledgeExtraction(executor, {
            tenantId,
            userId,
            workspaceId: task.workspace_id,
            taskId: input.taskId,
            fileId,
            revision: input.sourceRevision,
            contentHash: stored.sha256,
            title: name,
            mediaType: input.contentType,
            objectKey,
          });
        }
        return { file: created, reused: false, library: input.saveToLibrary };
      });
      registered = !file.reused;
      if (file.reused) {
        await config.client.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          ...(stored.versionId ? { VersionId: stored.versionId } : {}),
        })).catch(() => undefined);
      }
      return connectorArtifactDto(file.file, input, file.reused, file.library);
    } catch (cause) {
      if (!registered) {
        await config.client.send(new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          ...(stored.versionId ? { VersionId: stored.versionId } : {}),
        })).catch(() => undefined);
      }
      throw cause;
    }
  }

  async registerSandboxOutput(tenantId: string, userId: string, input: { key: string; name: string; mediaType: string; size?: number; taskId: string; sessionId: string; turnId?: string; origin?: "sandbox_output" | "image_generation" | "browser_capture" }) {
    const config = this.requireConfig();
    if (!input.key.startsWith(`${config.prefix}/`) || input.key.includes("..") || input.key.includes("\\")) throw new BadRequestException("Invalid artifact object key");
    const scopedTaskId = sandboxArtifactTaskId(config.prefix, input.key);
    if (scopedTaskId && scopedTaskId !== input.taskId.toLowerCase()) {
      throw new BadRequestException("Artifact object key does not belong to this task");
    }
    const stableFileId = sandboxArtifactFileId(config.prefix, input.key);
    if (!stableFileId) {
      throw new BadRequestException("Artifact object key does not contain a stable logical file id");
    }
    const head = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: input.key }));
    return this.database.withTenant(tenantId, async (executor) => {
      const existing = await executor.query<FileRow>(`
        SELECT f.*, ${FILE_PHYSICAL_COLUMNS}
        FROM files f
        LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1::uuid AND (f.id = $2::uuid OR f.object_key = $3)
        ORDER BY f.id
        FOR UPDATE OF f
      `, [tenantId, stableFileId, input.key]);
      if (existing.length > 0 && (existing.length !== 1
        || existing[0]!.id !== stableFileId
        || existing[0]!.owner_user_id !== userId
        || existing[0]!.object_key !== input.key)) {
        throw new ConflictException("Artifact identity conflicts with an existing file");
      }
      const logicalFile = existing[0] ?? null;
      if (logicalFile && (Number(logicalFile.size_bytes) !== Number(head.ContentLength ?? input.size ?? 0)
        || logicalFile.bucket !== config.bucket
        || logicalFile.object_key !== input.key
        || logicalFile.etag !== cleanEtag(head.ETag)
        || (logicalFile.object_version_id ?? null) !== (head.VersionId ?? null))) {
        throw new ConflictException("Artifact key content changed; register a new object key");
      }
      // Deduplication may move the logical file to a different canonical blob.
      // Retry identity is checked against the rollback-compatible logical
      // columns above; reads still resolve through the canonical blob below.
      let file = logicalFile ? resolvePhysicalFile(logicalFile) : null;
      if (!file) {
        const blobId = randomUUID();
        await executor.execute(`
          INSERT INTO file_blobs (
            id, tenant_id, bucket, object_key, size_bytes, etag, object_version_id,
            verification_status, metadata
          ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'unverified', $8::jsonb)
        `, [blobId, tenantId, config.bucket, input.key, Number(head.ContentLength ?? input.size ?? 0), cleanEtag(head.ETag), head.VersionId ?? null, JSON.stringify({ source: "sandbox-output" })]);
        const rows = await executor.query<FileRow>(`
          INSERT INTO files (
            id, tenant_id, owner_user_id, blob_id, original_name, display_name,
            media_type, size_bytes, bucket, object_key, etag, object_version_id, origin, status
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, $6, $7, $8, $9, $10, $11, $12::file_origin, 'available')
          RETURNING *
        `, [stableFileId, tenantId, userId, blobId, input.name, input.mediaType, Number(head.ContentLength ?? input.size ?? 0), config.bucket, input.key, cleanEtag(head.ETag), head.VersionId ?? null, input.origin ?? "sandbox_output"]);
        file = rows[0] ?? null;
        if (!file) throw new Error("Unable to register sandbox output");
        await enqueueBlobVerification(executor, tenantId, blobId);
      }
      await reviveLibraryEntry(executor, tenantId, userId, file.id);
      await associate(executor, { tenantId, fileId: file.id, taskId: input.taskId, sessionId: input.sessionId, ...(input.turnId ? { turnId: input.turnId } : {}), role: "output", userId });
      return fileDto({ ...file, task_ids: [input.taskId], roles: ["output"] });
    });
  }

  async persistGeneratedImage(tenantId: string, userId: string, input: {
    name: string;
    mediaType: string;
    data: string;
    taskId: string;
    sessionId: string;
    turnId?: string;
  }) {
    const config = this.requireConfig();
    const name = safeFileName(input.name);
    const bytes = Buffer.from(input.data, "base64");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length === 0 || bytes.length > config.maxUploadBytes) {
      throw new BadRequestException(`Generated images are limited to ${config.maxUploadBytes} bytes`);
    }
    const fileId = randomUUID();
    const blobId = randomUUID();
    const objectKey = `${config.prefix}/tenants/${tenantId}/users/${userId}/files/${fileId}/original/${name}`;
    const stored = await config.client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: input.mediaType,
      Metadata: { "file-id": fileId, "original-name": encodeURIComponent(name), source: "image-generation" },
    }));
    return this.database.withTenant(tenantId, async (executor) => {
      await requireTask(executor, tenantId, input.taskId, userId);
      await executor.execute(`
        INSERT INTO file_blobs (
          id, tenant_id, bucket, object_key, size_bytes, etag, object_version_id,
          verification_status, metadata
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'unverified', $8::jsonb)
      `, [blobId, tenantId, config.bucket, objectKey, bytes.length, cleanEtag(stored.ETag), stored.VersionId ?? null, JSON.stringify({ source: "image-generation", expectedSha256 })]);
      const rows = await executor.query<FileRow>(`
        INSERT INTO files (id, tenant_id, owner_user_id, blob_id, original_name, display_name, media_type, size_bytes, bucket, object_key, etag, object_version_id, origin, status)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $5, $6, $7, $8, $9, $10, $11, 'image_generation', 'available')
        RETURNING *
      `, [fileId, tenantId, userId, blobId, name, input.mediaType, bytes.length, config.bucket, objectKey, cleanEtag(stored.ETag), stored.VersionId ?? null]);
      const file = rows[0]!;
      await reviveLibraryEntry(executor, tenantId, userId, fileId);
      await enqueueBlobVerification(executor, tenantId, blobId);
      await associate(executor, {
        tenantId,
        fileId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        role: "output",
        userId,
      });
      return fileDto({ ...file, task_ids: [input.taskId], roles: ["output"] });
    });
  }

  async streamContent(
    tenantId: string,
    userId: string,
    fileId: string,
    range: string | undefined,
    response: ServerResponse,
    download = false,
    ifNoneMatch?: string,
  ) {
    response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    const config = this.requireConfig();
    const file = await this.get(tenantId, userId, fileId);
    if (file.status !== "available" && file.status !== "processing") throw new NotFoundException("File is not available");
    const etag = contentEntityTag(file);
    response.setHeader("ETag", etag);
    response.setHeader("Vary", "Authorization, Cookie");
    response.setHeader("Accept-Ranges", "bytes");
    setUntrustedFileResponseHeaders(response, {
      fileName: file.display_name,
      policy: fileResponsePolicy({
        declaredMediaType: file.media_type,
        detectedMediaType: file.detected_media_type,
        allowInline: !download,
      }),
    });
    if (!range && requestEntityTagMatches(ifNoneMatch, etag)) {
      response.setHeader("Cache-Control", PROTECTED_FILE_CACHE_CONTROL);
      response.statusCode = 304;
      response.end();
      return;
    }
    const object = await config.client.send(new GetObjectCommand({
      Bucket: file.bucket,
      Key: file.object_key,
      ...(file.object_version_id ? { VersionId: file.object_version_id } : {}),
      ...(range ? { Range: range } : {}),
    }));
    if (!object.Body) throw new NotFoundException("File content is unavailable");
    let body = object.Body as AsyncIterable<Uint8Array>;
    let detectedMediaType = normalizeMediaType(file.detected_media_type) ?? "application/octet-stream";
    if (!range || /^bytes=0-/i.test(range.trim())) {
      const inspected = await bufferBodyPrefix(body);
      detectedMediaType = detectMediaType(inspected.sample);
      body = inspected.body;
      if (normalizeMediaType(file.detected_media_type) !== detectedMediaType) {
        try {
          await this.recordDetectedMediaType(tenantId, file.id, detectedMediaType);
        } catch (cause) {
          await inspected.cancel();
          throw cause;
        }
      }
    }
    const policy = fileResponsePolicy({
      declaredMediaType: file.media_type,
      detectedMediaType,
      allowInline: !download,
    });
    response.setHeader("Cache-Control", PROTECTED_FILE_CACHE_CONTROL);
    response.statusCode = object.ContentRange ? 206 : 200;
    if (object.ContentLength != null) response.setHeader("Content-Length", String(object.ContentLength));
    if (object.ContentRange) response.setHeader("Content-Range", object.ContentRange);
    response.setHeader("Accept-Ranges", object.AcceptRanges ?? "bytes");
    setUntrustedFileResponseHeaders(response, { fileName: file.display_name, policy });
    for await (const chunk of body) {
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  }

  async streamBrandingAsset(
    tenantId: string,
    kind: OrganizationBrandingAssetKind,
    version: string | undefined,
    response: ServerResponse,
    ifNoneMatch?: string,
  ) {
    response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    const config = this.requireConfig();
    const file = await this.database.withTenant(tenantId, async (executor) => {
      const [profile] = await executor.query<{ branding: unknown }>(
        "SELECT branding FROM organization_profiles WHERE tenant_id=$1::uuid LIMIT 1",
        [tenantId],
      );
      const branding = profile?.branding && typeof profile.branding === "object" && !Array.isArray(profile.branding)
        ? profile.branding as Record<string, unknown>
        : {};
      const fileId = branding[`${kind}FileId`];
      if (typeof fileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId) || (version && version !== fileId)) {
        throw new NotFoundException("Branding asset not found");
      }
      const [row] = await executor.query<FileRow>(`
        SELECT f.*, ${FILE_PHYSICAL_COLUMNS}
        FROM files f
        LEFT JOIN file_blobs blob ON blob.id=f.blob_id AND blob.tenant_id=f.tenant_id
        WHERE f.tenant_id=$1::uuid AND f.id=$2::uuid AND f.deleted_at IS NULL
        LIMIT 1
      `, [tenantId, fileId]);
      if (!row || (row.status !== "available" && row.status !== "processing")) throw new NotFoundException("Branding asset not found");
      return resolvePhysicalFile(row);
    });
    assertPublicBrandingFile(file, kind);
    const etag = contentEntityTag(file);
    const allowed = kind === "logo" ? ORGANIZATION_LOGO_MEDIA_TYPES : ORGANIZATION_FAVICON_MEDIA_TYPES;
    const cachedPolicy = fileResponsePolicy({
      declaredMediaType: file.media_type,
      detectedMediaType: file.detected_media_type,
      allowInline: true,
    });
    const hasValidatedPassiveContent = cachedPolicy.disposition === "inline"
      && (allowed as readonly string[]).includes(cachedPolicy.detectedMediaType);
    if (hasValidatedPassiveContent && requestEntityTagMatches(ifNoneMatch, etag)) {
      setPublicBrandingHeaders(response, etag);
      setUntrustedFileResponseHeaders(response, {
        fileName: file.display_name,
        policy: cachedPolicy,
        crossOriginResourcePolicy: "cross-origin",
      });
      response.statusCode = 304;
      response.end();
      return;
    }
    let object: GetObjectCommandOutput;
    try {
      object = await config.client.send(new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.object_key,
        ...(file.object_version_id ? { VersionId: file.object_version_id } : {}),
      }));
      if (!object.Body) throw new NotFoundException("Branding asset content is unavailable");
    } catch (cause) {
      response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
      throw cause;
    }
    const maximumBytes = kind === "logo" ? ORGANIZATION_LOGO_MAX_BYTES : ORGANIZATION_FAVICON_MAX_BYTES;
    const contentLength = Number(object.ContentLength);
    if (object.ContentLength == null
      || !Number.isSafeInteger(contentLength)
      || contentLength <= 0
      || contentLength > maximumBytes
      || contentLength !== Number(file.size_bytes)) {
      await cancelStoredObjectBody(object.Body).catch(() => undefined);
      response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
      throw new NotFoundException("Branding asset not found");
    }
    let inspected: Awaited<ReturnType<typeof bufferBodyPrefix>>;
    try {
      inspected = await bufferBodyPrefix(object.Body as AsyncIterable<Uint8Array>);
    } catch {
      response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
      throw new NotFoundException("Branding asset not found");
    }
    const detectedMediaType = detectMediaType(inspected.sample);
    const policy = fileResponsePolicy({
      declaredMediaType: file.media_type,
      detectedMediaType,
      allowInline: true,
    });
    if (normalizeMediaType(file.detected_media_type) !== detectedMediaType) {
      try {
        await this.recordDetectedMediaType(tenantId, file.id, detectedMediaType);
      } catch (cause) {
        await inspected.cancel();
        throw cause;
      }
    }
    if (policy.disposition !== "inline" || !(allowed as readonly string[]).includes(policy.detectedMediaType)) {
      await inspected.cancel();
      response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
      throw new NotFoundException("Branding asset not found");
    }
    setPublicBrandingHeaders(response, etag);
    setUntrustedFileResponseHeaders(response, {
      fileName: file.display_name,
      policy,
      crossOriginResourcePolicy: "cross-origin",
    });
    if (requestEntityTagMatches(ifNoneMatch, etag)) {
      await inspected.cancel();
      response.statusCode = 304;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Length", String(contentLength));
    for await (const chunk of inspected.body) {
      if (!response.write(chunk)) await once(response, "drain");
    }
    response.end();
  }

  private requireConfig(): FileStorageConfig {
    if (!this.config) throw new BadRequestException("File storage is not configured");
    return this.config;
  }

  private async recordDetectedMediaType(tenantId: string, fileId: string, mediaType: string): Promise<void> {
    await this.database.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        UPDATE files
        SET detected_media_type = $3
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND detected_media_type IS DISTINCT FROM $3
      `, [tenantId, fileId, mediaType]);
    });
  }

  private async detectStoredObjectMediaType(input: {
    bucket: string;
    objectKey: string;
    objectVersionId?: string;
    sizeBytes: number;
  }): Promise<string> {
    if (input.sizeBytes === 0) return "application/octet-stream";
    const object = await this.requireConfig().client.send(new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.objectKey,
      ...(input.objectVersionId ? { VersionId: input.objectVersionId } : {}),
      Range: `bytes=0-${FILE_TYPE_SAMPLE_BYTES - 1}`,
    }));
    if (!object.Body) throw new BadRequestException("The uploaded object could not be inspected safely");
    let sample: Uint8Array;
    try {
      sample = await readBodyBounded(object.Body as AsyncIterable<Uint8Array>, FILE_TYPE_SAMPLE_BYTES);
    } catch {
      throw new BadRequestException("The uploaded object could not be inspected safely");
    }
    return detectMediaType(sample);
  }

  private async requireUpload(tenantId: string, userId: string, fileId: string, uploadId: string): Promise<UploadRow> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<UploadRow>(`
        SELECT u.*,
          CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS object_key,
          f.size_bytes AS declared_size_bytes,
          f.blob_id
        FROM file_uploads u
        JOIN files f ON f.id = u.file_id
        LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
        WHERE u.tenant_id = $1::uuid AND u.id = $2::uuid AND u.file_id = $3::uuid
          AND f.tenant_id = u.tenant_id AND f.owner_user_id = $4::uuid AND f.deleted_at IS NULL
          AND (u.status = 'completed' OR (u.status = 'uploading' AND u.expires_at > now()))
      `, [tenantId, uploadId, fileId, userId]);
      if (!row) throw new NotFoundException("Upload session not found or expired");
      return row;
    });
  }

  private async requireAccessibleFile(executor: SqlExecutor, tenantId: string, userId: string, fileId: string): Promise<FileRow> {
    const [row] = await executor.query<FileRow>(`
      SELECT f.*,
        ${FILE_PHYSICAL_COLUMNS},
        project_link.workspace_id,
        project_link.visibility AS workspace_visibility,
        project_link.index_status,
        source.vector_ready,
        source.failure_reason,
        COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
        COALESCE(array_remove(array_agg(DISTINCT a.role::text), NULL), ARRAY[]::text[]) AS roles
      FROM files f
      LEFT JOIN file_blobs blob ON blob.id = f.blob_id AND blob.tenant_id = f.tenant_id
      LEFT JOIN file_associations a ON a.file_id = f.id
      LEFT JOIN LATERAL (
        SELECT wf.workspace_id, wf.visibility, wf.index_status
        FROM workspace_files wf
        JOIN workspaces w
          ON w.tenant_id = wf.tenant_id
         AND w.id = wf.workspace_id
        WHERE wf.tenant_id = f.tenant_id AND wf.file_id = f.id
          AND wf.deleted_at IS NULL AND w.deleted_at IS NULL
          AND (
            w.owner_id = $2::uuid OR w.owner_id IS NULL OR
            EXISTS (
              SELECT 1 FROM tasks access_task
              WHERE access_task.workspace_id = w.id AND access_task.tenant_id = w.tenant_id
                AND access_task.user_id = $2::uuid AND access_task.deleted_at IS NULL
            )
          )
          AND (
            wf.visibility = 'project' OR
            EXISTS (
              SELECT 1 FROM tasks access_task
              WHERE access_task.tenant_id = wf.tenant_id
                AND access_task.id = wf.originating_task_id
                AND (access_task.user_id = $2::uuid OR access_task.user_id IS NULL)
                AND access_task.deleted_at IS NULL
            )
          )
        ORDER BY wf.created_at ASC
        LIMIT 1
      ) project_link ON true
      LEFT JOIN LATERAL (
        SELECT ks.vector_ready, ks.failure_reason
        FROM knowledge_sources ks
        WHERE ks.tenant_id = f.tenant_id AND ks.source_type = 'file'
          AND ks.source_id = f.id::text AND ks.tombstoned_at IS NULL
        ORDER BY ks.created_at DESC LIMIT 1
      ) source ON true
      WHERE f.tenant_id = $1::uuid AND f.id = $3::uuid AND f.deleted_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM file_library_entries library
            WHERE library.tenant_id = f.tenant_id AND library.file_id = f.id
              AND library.user_id = $2::uuid AND library.deleted_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM file_associations access_link
            LEFT JOIN sessions access_session
              ON access_session.tenant_id = access_link.tenant_id
             AND access_session.id = access_link.session_id
            LEFT JOIN tasks access_task
              ON access_task.tenant_id = access_link.tenant_id
             AND access_task.id = COALESCE(access_link.task_id, access_session.task_id)
            WHERE access_link.tenant_id = f.tenant_id
              AND access_link.file_id = f.id
              AND access_task.id IS NOT NULL
              AND (
                access_task.user_id = $2::uuid OR
                (access_task.user_id IS NULL AND access_task.deleted_at IS NULL)
              )
          )
          OR project_link.workspace_id IS NOT NULL
        )
      GROUP BY f.id, blob.id, project_link.workspace_id, project_link.visibility,
               project_link.index_status, source.vector_ready, source.failure_reason
    `, [tenantId, userId, fileId]);
    if (!row) throw new NotFoundException("File not found");
    return resolvePhysicalFile(row);
  }
}

type ConnectorImportIdentity = {
  connectorKey: string;
  accountEmail: string | null;
  sourceFileId: string;
  sourceRevision: string;
  sourceMimeType: string;
  exportMimeType: string | null;
  sourceMetadata: Record<string, unknown>;
};

function connectorImportMetadata(input: ConnectorImportIdentity): Record<string, unknown> {
  return {
    source: "google-drive",
    connectorKey: input.connectorKey,
    accountEmail: input.accountEmail,
    sourceFileId: input.sourceFileId,
    sourceRevision: input.sourceRevision,
    sourceMimeType: input.sourceMimeType,
    exportMimeType: input.exportMimeType,
    sourceModifiedTime: typeof input.sourceMetadata.modifiedTime === "string" ? input.sourceMetadata.modifiedTime : null,
    sourceWebViewLink: typeof input.sourceMetadata.webViewLink === "string" ? input.sourceMetadata.webViewLink : null,
  };
}

function connectorArtifactDto(
  row: FileRow,
  input: ConnectorImportIdentity,
  reused: boolean,
  library: boolean,
): Record<string, unknown> {
  return {
    artifact: {
      fileId: row.id,
      name: row.display_name,
      mediaType: row.detected_media_type ?? row.media_type,
      size: Number(row.size_bytes),
      status: row.status,
      origin: "connector_import",
      source: "google-drive",
      sourceFileId: input.sourceFileId,
      sourceRevision: input.sourceRevision,
      exportMimeType: input.exportMimeType,
      reused,
      library,
    },
  };
}

async function connectorImportFile(
  executor: SqlExecutor,
  tenantId: string,
  fileId: string,
  userId: string,
): Promise<FileRow | null> {
  const [row] = await executor.query<FileRow>(`
    SELECT f.*, ${FILE_PHYSICAL_COLUMNS},
      EXISTS (
        SELECT 1
        FROM file_library_entries library
        WHERE library.tenant_id=f.tenant_id AND library.file_id=f.id
          AND library.user_id=$3::uuid AND library.deleted_at IS NULL
      ) AS in_library
    FROM files f
    LEFT JOIN file_blobs blob ON blob.tenant_id=f.tenant_id AND blob.id=f.blob_id
    WHERE f.tenant_id=$1::uuid AND f.id=$2::uuid AND f.owner_user_id=$3::uuid
      AND f.origin='connector_import' AND f.deleted_at IS NULL
      AND f.status IN ('processing','available')
    FOR UPDATE OF f
  `, [tenantId, fileId, userId]);
  return row ? resolvePhysicalFile(row) : null;
}

async function promoteConnectorKnowledgeIfNeeded(executor: SqlExecutor, input: {
  file: FileRow;
  promoted: boolean;
  projectKnowledgeEnabled: boolean;
  maxIndexableBytes: number;
  tenantId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  revision: string;
  title: string;
  mediaType: string;
}): Promise<FileRow> {
  if (!input.promoted) return input.file;
  const libraryFile = { ...input.file, in_library: true };
  if (!input.projectKnowledgeEnabled
    || Number(input.file.size_bytes) > input.maxIndexableBytes
    || !input.file.sha256) {
    return libraryFile;
  }
  await executor.execute(`
    UPDATE files
    SET status='processing', updated_at=now()
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='available'
  `, [input.tenantId, input.file.id]);
  await enqueueConnectorKnowledgeExtraction(executor, {
    tenantId: input.tenantId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    fileId: input.file.id,
    revision: input.revision,
    contentHash: input.file.sha256,
    title: input.title,
    mediaType: input.mediaType,
    objectKey: input.file.object_key,
  });
  return { ...libraryFile, status: "processing" };
}

async function lockConnectorImport(executor: SqlExecutor, fileId: string): Promise<void> {
  await executor.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`berry:connector-import:${fileId}`],
  );
}

function assertConnectorIdentity(row: FileRow, input: ConnectorImportIdentity): void {
  const metadata = row.metadata ?? {};
  if (metadata.connectorKey !== input.connectorKey
    || metadata.sourceFileId !== input.sourceFileId
    || metadata.sourceRevision !== input.sourceRevision
    || (metadata.exportMimeType ?? null) !== input.exportMimeType) {
    throw new ConflictException("Drive artifact identity conflicts with an existing file");
  }
}

async function requireSessionForTask(
  executor: SqlExecutor,
  tenantId: string,
  sessionId: string,
  taskId: string,
  userId: string,
): Promise<void> {
  const [session] = await executor.query<{ id: string }>(`
    SELECT s.id
    FROM sessions s
    JOIN tasks t ON t.tenant_id=s.tenant_id AND t.id=s.task_id
    WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.task_id=$3::uuid
      AND (s.user_id=$4::uuid OR (s.user_id IS NULL AND (t.user_id=$4::uuid OR t.user_id IS NULL)))
  `, [tenantId, sessionId, taskId, userId]);
  if (!session) throw new NotFoundException("Task session not found");
}

async function linkWorkspaceFile(executor: SqlExecutor, input: {
  tenantId: string;
  workspaceId: string;
  fileId: string;
  taskId: string;
  userId: string;
}): Promise<void> {
  await executor.execute(`
    INSERT INTO workspace_files (
      tenant_id, workspace_id, file_id, visibility, originating_task_id,
      index_status, created_by_user_id
    ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'task_only', $4::uuid, 'pending', $5::uuid)
    ON CONFLICT (tenant_id, workspace_id, file_id) DO UPDATE SET
      visibility='task_only',
      originating_task_id=COALESCE(workspace_files.originating_task_id, EXCLUDED.originating_task_id),
      deleted_at=NULL,
      updated_at=now()
  `, [input.tenantId, input.workspaceId, input.fileId, input.taskId, input.userId]);
}

async function enqueueConnectorKnowledgeExtraction(executor: SqlExecutor, input: {
  tenantId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  fileId: string;
  revision: string;
  contentHash: string;
  title: string;
  mediaType: string;
  objectKey: string;
}): Promise<void> {
  const [source] = await executor.query<{ id: string }>(`
    INSERT INTO knowledge_sources (
      tenant_id, user_id, workspace_id, source_type, source_id, source_revision,
      content_hash, title, visibility, extraction_status, index_status,
      extractor_version, chunker_version, metadata
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, 'file', $4::uuid::text, $5, $6, $7,
      'task_only', 'pending', 'pending', 'tika-v1', 'recursive-v1',
      jsonb_build_object('fileId',$4::uuid,'mediaType',$8::text,'objectKey',$9::text,'taskId',$10::uuid,'source','google-drive')
    )
    ON CONFLICT (tenant_id, workspace_id, source_type, source_id, source_revision)
    DO UPDATE SET tombstoned_at=NULL, failure_reason=NULL, extraction_status='pending',
      index_status='pending', vector_ready=false, updated_at=now()
    RETURNING id
  `, [input.tenantId, input.userId, input.workspaceId, input.fileId, input.revision, input.contentHash, input.title, input.mediaType, input.objectKey, input.taskId]);
  if (!source) throw new Error("Unable to queue Drive artifact extraction");
  await executor.execute(`
    INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
    VALUES ($1::uuid, 'knowledge.extract', $2, $3, $4::jsonb)
    ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
      completed_at = NULL, available_at = now(), last_error = NULL, updated_at = now()
  `, [input.tenantId, source.id, `knowledge.extract:${source.id}:${input.revision}`, JSON.stringify({ tenantId: input.tenantId, sourceId: source.id, revision: input.revision })]);
}

async function storeBoundedMultipart(config: FileStorageConfig, input: {
  objectKey: string;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  declaredSize: number | null;
  maximumBytes: number;
  fileId: string;
  name: string;
}): Promise<{ size: number; sha256: string; etag: string | null; versionId: string | null }> {
  if (input.declaredSize !== null && input.declaredSize > input.maximumBytes) {
    await input.body.cancel().catch(() => undefined);
    throw new BadRequestException("Drive files are limited to 100 MB");
  }
  const created = await config.client.send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: input.objectKey,
    ContentType: input.contentType,
    Metadata: { "file-id": input.fileId, "original-name": encodeURIComponent(input.name), source: "google-drive" },
  }));
  if (!created.UploadId) throw new Error("Object storage did not return a multipart upload id");
  const reader = input.body.getReader();
  const hash = createHash("sha256");
  const completedParts: CompletedPart[] = [];
  let partChunks: Buffer[] = [];
  let partBytes = 0;
  let total = 0;
  const uploadPart = async (): Promise<void> => {
    if (partBytes === 0) return;
    const body = Buffer.concat(partChunks, partBytes);
    const partNumber = completedParts.length + 1;
    const uploaded = await config.client.send(new UploadPartCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      UploadId: created.UploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.byteLength,
    }));
    if (!uploaded.ETag) throw new Error(`Object storage did not return an ETag for Drive part ${partNumber}`);
    completedParts.push({ PartNumber: partNumber, ETag: uploaded.ETag });
    partChunks = [];
    partBytes = 0;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      total += value.byteLength;
      if (total > input.maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BadRequestException("Drive files are limited to 100 MB");
      }
      hash.update(value);
      while (offset < value.byteLength) {
        const take = Math.min(config.partSize - partBytes, value.byteLength - offset);
        partChunks.push(Buffer.from(value.subarray(offset, offset + take)));
        partBytes += take;
        offset += take;
        if (partBytes === config.partSize) await uploadPart();
      }
    }
    if (input.declaredSize !== null && total !== input.declaredSize) {
      throw new BadRequestException("The Drive response size did not match its declared size");
    }
    if (total === 0) {
      await config.client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: input.objectKey, UploadId: created.UploadId })).catch(() => undefined);
      const stored = await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.objectKey,
        Body: new Uint8Array(),
        ContentType: input.contentType,
        Metadata: { "file-id": input.fileId, "original-name": encodeURIComponent(input.name), source: "google-drive" },
      }));
      return { size: 0, sha256: hash.digest("hex"), etag: cleanEtag(stored.ETag), versionId: stored.VersionId ?? null };
    }
    await uploadPart();
    const completed = await config.client.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: input.objectKey,
      UploadId: created.UploadId,
      MultipartUpload: { Parts: completedParts },
    }));
    return { size: total, sha256: hash.digest("hex"), etag: cleanEtag(completed.ETag), versionId: completed.VersionId ?? null };
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    await config.client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: input.objectKey, UploadId: created.UploadId })).catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sandboxArtifactFileId(prefix: string, objectKey: string): string | null {
  const relative = objectKey.slice(prefix.length + 1);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const leading = relative.match(new RegExp(`^(${uuid})(?:-|/)`, "i"));
  if (leading?.[1]) return leading[1].toLowerCase();
  const taskScoped = relative.match(new RegExp(`^tasks/${uuid}/(${uuid})(?:-|/)`, "i"));
  if (taskScoped?.[1]) return taskScoped[1].toLowerCase();
  const namespaced = relative.match(new RegExp(`(?:^|/)files/(${uuid})(?:/|$)`, "i"));
  return namespaced?.[1]?.toLowerCase() ?? null;
}

function sandboxArtifactTaskId(prefix: string, objectKey: string): string | null {
  const relative = objectKey.slice(prefix.length + 1);
  const taskId = relative.match(/^tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i)?.[1];
  return taskId?.toLowerCase() ?? null;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function isNoSuchUpload(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; Code?: unknown; message?: unknown };
  return candidate.name === "NoSuchUpload"
    || candidate.code === "NoSuchUpload"
    || candidate.Code === "NoSuchUpload"
    || (typeof candidate.message === "string" && /\bNoSuchUpload\b/.test(candidate.message));
}

function expectedPartBytes(upload: UploadRow, partNumber: number): number {
  const declared = Number(upload.declared_size_bytes);
  const offset = (partNumber - 1) * upload.part_size;
  return Math.max(0, Math.min(upload.part_size, declared - offset));
}

function fileDto(row: FileRow) {
  const version = encodeURIComponent(contentCacheVersion(row));
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
    ...(row.workspace_id !== undefined ? { workspaceId: row.workspace_id } : {}),
    ...(row.workspace_visibility !== undefined ? { workspaceVisibility: row.workspace_visibility } : {}),
    ...(row.index_status ? { indexStatus: row.index_status } : {}),
    ...(row.vector_ready !== undefined && row.vector_ready !== null ? { vectorReady: row.vector_ready } : {}),
    ...(row.failure_reason !== undefined ? { indexFailureReason: row.failure_reason } : {}),
    downloadUrl: `/v1/files/${row.id}/content?download=1&v=${version}&sv=${FILE_RESPONSE_SECURITY_VERSION}`,
    previewUrl: `/v1/files/${row.id}/content?v=${version}&sv=${FILE_RESPONSE_SECURITY_VERSION}`,
  };
}

function contentCacheVersion(row: FileRow): string {
  return row.sha256
    ?? row.object_version_id
    ?? row.etag
    ?? `${row.id}-${new Date(row.updated_at).getTime()}`;
}

function contentEntityTag(row: FileRow): string {
  const opaque = contentCacheVersion(row).replace(/["\\]/g, "");
  return `"berry-file-response-v${FILE_RESPONSE_SECURITY_VERSION}-${opaque}"`;
}

function requestEntityTagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value.replace(/^W\//, "") === etag;
  });
}

function assertPublicBrandingFile(file: FileRow, kind: OrganizationBrandingAssetKind): void {
  const mediaType = normalizeMediaType(file.media_type);
  const detectedMediaType = file.detected_media_type === null ? null : normalizeMediaType(file.detected_media_type);
  const allowed = kind === "logo" ? ORGANIZATION_LOGO_MEDIA_TYPES : ORGANIZATION_FAVICON_MEDIA_TYPES;
  const maximumBytes = kind === "logo" ? ORGANIZATION_LOGO_MAX_BYTES : ORGANIZATION_FAVICON_MAX_BYTES;
  const sizeBytes = Number(file.size_bytes);
  if (!mediaType
    || !(allowed as readonly string[]).map(normalizeMediaType).includes(mediaType)
    || (file.detected_media_type !== null && detectedMediaType !== mediaType)
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
    || sizeBytes > maximumBytes) {
    throw new NotFoundException("Branding asset not found");
  }
}

async function cancelStoredObjectBody(body: unknown): Promise<void> {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const candidate = body as {
    destroy?: () => void;
    cancel?: () => Promise<unknown> | unknown;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  if (typeof candidate.destroy === "function") {
    candidate.destroy.call(body);
    return;
  }
  if (typeof candidate.cancel === "function") {
    await candidate.cancel.call(body);
    return;
  }
  const createIterator = candidate[Symbol.asyncIterator];
  if (typeof createIterator === "function") {
    const iterator = createIterator.call(body);
    await iterator.return?.();
  }
}

function setPublicBrandingHeaders(response: ServerResponse, etag: string): void {
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL);
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function resolvePhysicalFile(row: FileRow): FileRow {
  if (!row.blob_id) return row;
  if (!row.resolved_bucket || !row.resolved_object_key) {
    throw new Error(`File ${row.id} has an invalid blob reference`);
  }
  return {
    ...row,
    bucket: row.resolved_bucket,
    object_key: row.resolved_object_key,
    size_bytes: row.resolved_size_bytes ?? row.size_bytes,
    sha256: row.resolved_sha256 ?? null,
    etag: row.resolved_etag ?? null,
    object_version_id: row.resolved_object_version_id ?? null,
  };
}

async function reviveLibraryEntry(executor: SqlExecutor, tenantId: string, userId: string, fileId: string): Promise<void> {
  await executor.execute(`
    INSERT INTO file_library_entries (tenant_id, user_id, file_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid)
    ON CONFLICT (tenant_id, user_id, file_id) DO UPDATE
    SET deleted_at = NULL, updated_at = now()
  `, [tenantId, userId, fileId]);
}

async function enqueueBlobVerification(executor: SqlExecutor, tenantId: string, blobId: string): Promise<void> {
  await executor.execute(`
    INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
    VALUES ($1::uuid, 'file.verify-blob', $2, $3, $4::jsonb)
    ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
      completed_at = NULL, available_at = now(), last_error = NULL, updated_at = now()
  `, [tenantId, blobId, `file.verify-blob:${blobId}`, JSON.stringify({ tenantId, blobId })]);
}

async function retireTerminalUpload(
  executor: SqlExecutor,
  tenantId: string,
  fileId: string,
  input: { status: "failed" | "quarantined"; reason: "aborted" | "expired" | "size_mismatch" },
): Promise<void> {
  await executor.execute(`
    UPDATE files
    SET status = $3::file_status,
        metadata = metadata || jsonb_build_object('uploadFailure', $4::text),
        updated_at = now()
    WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL
  `, [tenantId, fileId, input.status, input.reason]);
  await executor.execute(`
    UPDATE file_library_entries
    SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
    WHERE tenant_id = $1::uuid AND file_id = $2::uuid AND deleted_at IS NULL
  `, [tenantId, fileId]);
  await executor.execute(`
    DELETE FROM file_associations
    WHERE tenant_id = $1::uuid AND file_id = $2::uuid
  `, [tenantId, fileId]);
  await executor.execute(`
    UPDATE workspace_files
    SET deleted_at = COALESCE(deleted_at, now()),
        index_status = 'deleted', updated_at = now()
    WHERE tenant_id = $1::uuid AND file_id = $2::uuid AND deleted_at IS NULL
  `, [tenantId, fileId]);
  await garbageCollectFileIfUnreferenced(executor, tenantId, fileId);
}

async function requireTask(executor: SqlExecutor, tenantId: string, taskId: string, userId: string) {
  const [task] = await executor.query<{ id: string; workspace_id: string }>(`
    SELECT id, workspace_id
    FROM tasks
    WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL
      AND (user_id = $3::uuid OR user_id IS NULL)
  `, [tenantId, taskId, userId]);
  if (!task) throw new NotFoundException("Task not found");
  return task;
}

export async function associateInputFilesInTransaction(
  executor: SqlExecutor,
  tenantId: string,
  userId: string,
  input: {
    fileIds: string[];
    taskId: string;
    sessionId: string;
    messageId?: string;
    turnId?: string;
  },
): Promise<Array<{
  fileId: string;
  name: string;
  mediaType: string;
  size: number;
  sourceKind: "object-storage";
}>> {
  if (input.fileIds.length === 0) return [];
  await requireTask(executor, tenantId, input.taskId, userId);
  const resolved: Array<{
    fileId: string;
    name: string;
    mediaType: string;
    size: number;
    sourceKind: "object-storage";
  }> = [];
  for (const fileId of [...new Set(input.fileIds)].sort()) {
    await lockFileForReference(executor, tenantId, fileId);
    const [file] = await executor.query<FileRow>(`
      SELECT f.*, ${FILE_PHYSICAL_COLUMNS}
      FROM files f
      LEFT JOIN file_blobs blob
        ON blob.tenant_id = f.tenant_id AND blob.id = f.blob_id
      WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid
        AND f.owner_user_id = $3::uuid AND f.deleted_at IS NULL
        AND (
          f.blob_id IS NULL OR (
            blob.id IS NOT NULL AND blob.deleted_at IS NULL
            AND blob.verification_status <> 'deleted'
          )
        )
      FOR UPDATE OF f
    `, [tenantId, fileId, userId]);
    if (!file) throw new NotFoundException("File not found");
    const physical = resolvePhysicalFile(file);
    if (physical.status !== "available" && physical.status !== "processing") {
      throw new BadRequestException(`File ${physical.display_name} is not available`);
    }
    await associate(executor, {
      tenantId,
      fileId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      role: "input",
      userId,
    });
    resolved.push({
      fileId: physical.id,
      name: physical.display_name,
      mediaType: physical.detected_media_type ?? physical.media_type,
      size: Number(physical.size_bytes),
      sourceKind: "object-storage",
    });
  }
  return resolved;
}

async function requireWorkspaceAccess(executor: SqlExecutor, tenantId: string, userId: string, workspaceId: string) {
  const [workspace] = await executor.query<{ id: string }>(`
    SELECT w.id
    FROM workspaces w
    WHERE w.tenant_id = $1::uuid AND w.id = $2::uuid AND w.deleted_at IS NULL
      AND (
        w.owner_id = $3::uuid OR w.owner_id IS NULL OR
        EXISTS (
          SELECT 1 FROM tasks access_task
          WHERE access_task.tenant_id = w.tenant_id AND access_task.workspace_id = w.id
            AND access_task.user_id = $3::uuid AND access_task.deleted_at IS NULL
        )
      )
  `, [tenantId, workspaceId, userId]);
  if (!workspace) throw new NotFoundException("Workspace not found");
  return workspace;
}

async function associate(executor: SqlExecutor, input: { tenantId: string; fileId: string; taskId?: string; sessionId?: string; messageId?: string; turnId?: string; role: string; userId: string }) {
  const file = await lockFileForReference(executor, input.tenantId, input.fileId);
  if (file.blob_id) {
    await executor.execute(`
      UPDATE file_blobs
      SET verification_status = CASE
            WHEN sha256 IS NULL THEN 'unverified'::file_blob_verification_status
            ELSE 'verified'::file_blob_verification_status
          END,
          delete_after = NULL, updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
        AND verification_status = 'pending_delete' AND deleted_at IS NULL
    `, [input.tenantId, file.blob_id]);
    await executor.execute(`
      UPDATE runtime_outbox
      SET completed_at = COALESCE(completed_at, now()),
          last_error = 'Cancelled because a file reference was added', updated_at = now()
      WHERE tenant_id = $1::uuid AND aggregate_id = $2
        AND event_type = 'file.delete-blob' AND completed_at IS NULL
    `, [input.tenantId, file.blob_id]);
  }
  await executor.execute(`
    INSERT INTO file_associations (tenant_id, file_id, task_id, session_id, message_id, turn_id, role, created_by_user_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::file_association_role, $8::uuid)
    ON CONFLICT DO NOTHING
  `, [input.tenantId, input.fileId, input.taskId ?? null, input.sessionId ?? null, input.messageId ?? null, input.turnId ?? null, input.role, input.userId]);
}

async function lockFileForReference(
  executor: SqlExecutor,
  tenantId: string,
  fileId: string,
): Promise<{ id: string; blob_id: string | null }> {
  const [file] = await executor.query<{ id: string; blob_id: string | null }>(`
    SELECT f.id, f.blob_id
    FROM files f
    LEFT JOIN file_blobs blob
      ON blob.tenant_id = f.tenant_id AND blob.id = f.blob_id
    WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid AND f.deleted_at IS NULL
      AND (
        f.blob_id IS NULL OR (
          blob.id IS NOT NULL AND blob.deleted_at IS NULL
          AND blob.verification_status <> 'deleted'
        )
      )
    FOR UPDATE OF f
  `, [tenantId, fileId]);
  if (!file) throw new NotFoundException("File not found");
  return file;
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
