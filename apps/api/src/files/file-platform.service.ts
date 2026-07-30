import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { durableContextConfigFromEnv } from "@berry/shared";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.ts";

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
  workspace_id?: string | null;
  workspace_visibility?: "project" | "task_only" | null;
  index_status?: "pending" | "extracting" | "chunking" | "embedding" | "indexed" | "failed" | "deleted" | null;
  vector_ready?: boolean | null;
  failure_reason?: string | null;
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
  declared_size_bytes: number | string;
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
    return this.database.withTenant(tenantId, async (executor) => this.requireAccessibleFile(executor, tenantId, userId, fileId));
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
          INSERT INTO files (id, tenant_id, owner_user_id, original_name, display_name, media_type, size_bytes, sha256, bucket, object_key, origin, status)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $4, $5, $6, $7, $8, $9, $10::file_origin, 'uploading')
        `, [fileId, tenantId, userId, input.name, input.mediaType || "application/octet-stream", input.size, input.sha256 ?? null, config.bucket, objectKey, input.origin ?? "user_upload"]);
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
      });
      throw new BadRequestException("The uploaded object size does not match the requested upload");
    }
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
        UPDATE files SET status = $6::file_status, size_bytes = $3, etag = $4, object_version_id = $5, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [tenantId, fileId, actualSize, cleanEtag(head.ETag ?? completed.ETag), completed.VersionId ?? null, shouldIndex ? "processing" : "available"]);
      if (workspaceFile && shouldIndex) {
        const revision = completed.VersionId ?? cleanEtag(head.ETag ?? completed.ETag) ?? `upload-${uploadId}`;
        const contentHash = cleanEtag(head.ETag ?? completed.ETag) ?? `file-${fileId}-${revision}`;
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
                   'mediaType', f.media_type,
                   'objectKey', f.object_key,
                   'taskId', wf.originating_task_id
                 ))
          FROM workspace_files wf
          JOIN files f ON f.id = wf.file_id
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
          wf.workspace_id,
          wf.visibility AS workspace_visibility,
          wf.index_status,
          source.vector_ready,
          source.failure_reason,
          COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
          COALESCE(array_remove(array_agg(DISTINCT a.role::text), NULL), ARRAY[]::text[]) AS roles
        FROM workspace_files wf
        JOIN files f ON f.id = wf.file_id
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
        GROUP BY f.id, wf.id, source.vector_ready, source.failure_reason
        ORDER BY wf.created_at DESC, wf.id DESC
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
      return { ok: true };
    });
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
      await requireTask(executor, tenantId, input.taskId, userId);
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
    if (bytes.length === 0 || bytes.length > config.maxUploadBytes) {
      throw new BadRequestException(`Generated images are limited to ${config.maxUploadBytes} bytes`);
    }
    const fileId = randomUUID();
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
      const rows = await executor.query<FileRow>(`
        INSERT INTO files (id, tenant_id, owner_user_id, original_name, display_name, media_type, size_bytes, bucket, object_key, etag, origin, status)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $4, $5, $6, $7, $8, $9, 'image_generation', 'available')
        RETURNING *
      `, [fileId, tenantId, userId, name, input.mediaType, bytes.length, config.bucket, objectKey, cleanEtag(stored.ETag)]);
      const file = rows[0]!;
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
        SELECT u.*, f.object_key, f.size_bytes AS declared_size_bytes
        FROM file_uploads u JOIN files f ON f.id = u.file_id
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

  private async requireAccessibleFile(executor: SqlExecutor, tenantId: string, userId: string, fileId: string): Promise<FileRow> {
    const [row] = await executor.query<FileRow>(`
      SELECT f.*,
        project_link.workspace_id,
        project_link.visibility AS workspace_visibility,
        project_link.index_status,
        source.vector_ready,
        source.failure_reason,
        COALESCE(array_remove(array_agg(DISTINCT a.task_id), NULL), '{}') AS task_ids,
        COALESCE(array_remove(array_agg(DISTINCT a.role::text), NULL), ARRAY[]::text[]) AS roles
      FROM files f
      LEFT JOIN file_associations a ON a.file_id = f.id
      LEFT JOIN LATERAL (
        SELECT wf.workspace_id, wf.visibility, wf.index_status
        FROM workspace_files wf
        JOIN workspaces w ON w.id = wf.workspace_id
        WHERE wf.tenant_id = f.tenant_id AND wf.file_id = f.id AND wf.deleted_at IS NULL
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
              WHERE access_task.id = wf.originating_task_id
                AND (access_task.user_id = $2::uuid OR access_task.user_id IS NULL)
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
        AND (f.owner_user_id = $2::uuid OR project_link.workspace_id IS NOT NULL)
      GROUP BY f.id, project_link.workspace_id, project_link.visibility,
               project_link.index_status, source.vector_ready, source.failure_reason
    `, [tenantId, userId, fileId]);
    if (!row) throw new NotFoundException("File not found");
    return row;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function expectedPartBytes(upload: UploadRow, partNumber: number): number {
  const declared = Number(upload.declared_size_bytes);
  const offset = (partNumber - 1) * upload.part_size;
  return Math.max(0, Math.min(upload.part_size, declared - offset));
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
    ...(row.workspace_id !== undefined ? { workspaceId: row.workspace_id } : {}),
    ...(row.workspace_visibility !== undefined ? { workspaceVisibility: row.workspace_visibility } : {}),
    ...(row.index_status ? { indexStatus: row.index_status } : {}),
    ...(row.vector_ready !== undefined && row.vector_ready !== null ? { vectorReady: row.vector_ready } : {}),
    ...(row.failure_reason !== undefined ? { indexFailureReason: row.failure_reason } : {}),
    downloadUrl: `/v1/files/${row.id}/content?download=1`,
    previewUrl: `/v1/files/${row.id}/content`,
  };
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
