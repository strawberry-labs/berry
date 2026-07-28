import { createHash } from "node:crypto";
import type { TextChunk } from "./services.js";
import type { SqlExecutor } from "../sql-repositories.js";

export type KnowledgeSourceRecord = {
  id: string;
  tenantId: string;
  workspaceId: string;
  userId: string | null;
  sourceType: "file" | "task_outcome" | "message" | "checkpoint" | "memory";
  sourceId: string;
  revision: string;
  contentHash: string;
  title: string;
  visibility: "project" | "task_only" | "private";
  status: string;
  mediaType: string;
  bucket: string | null;
  objectKey: string | null;
  derivativeObjectKey: string | null;
  inlineText: string | null;
  tombstonedAt: Date | string | null;
};

export type StoredKnowledgeChunk = {
  id: string;
  text: string;
  ordinal: number;
  tokenEstimate: number;
};

export class SqlKnowledgeRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async loadSource(tenantId: string, sourceId: string, revision: string): Promise<KnowledgeSourceRecord | null> {
    return this.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<SourceRow>(`
        SELECT ks.id, ks.tenant_id, ks.workspace_id, ks.user_id, ks.source_type,
               ks.source_id, ks.source_revision, ks.content_hash, ks.title, ks.visibility,
               ks.index_status, ks.metadata, ks.tombstoned_at,
               f.media_type, f.bucket, f.object_key,
               derivative.object_key AS derivative_object_key
        FROM knowledge_sources ks
        LEFT JOIN files f ON ks.source_type = 'file' AND f.id = ks.source_id::uuid
        LEFT JOIN LATERAL (
          SELECT fd.object_key
          FROM file_derivatives fd
          WHERE f.id IS NOT NULL AND fd.file_id = f.id AND fd.kind = 'text_extract'
            AND fd.status = 'available'
          ORDER BY fd.updated_at DESC
          LIMIT 1
        ) derivative ON true
        WHERE ks.tenant_id = $1::uuid AND ks.id = $2::uuid
          AND ks.source_revision = $3
      `, [tenantId, sourceId, revision]);
      return row ? sourceFromRow(row) : null;
    });
  }

  async markExtracting(tenantId: string, sourceId: string, revision: string): Promise<boolean> {
    return this.transition(tenantId, sourceId, revision, `
      extraction_status = 'extracting', index_status = 'extracting',
      failure_reason = NULL, updated_at = now()
    `, "extracting", `
      AND (
        extraction_status IN ('pending', 'failed') OR
        (extraction_status = 'extracting' AND updated_at < now() - interval '5 minutes')
      )
    `);
  }

  async saveExtraction(input: {
    tenantId: string;
    source: KnowledgeSourceRecord;
    derivativeObjectKey: string;
    mediaType: string;
    sizeBytes: number;
    contentHash: string;
  }): Promise<void> {
    await this.withTenant(input.tenantId, async (executor) => {
      if (input.source.sourceType !== "file") throw new Error("Only file sources create text derivatives");
      await executor.execute(`
        INSERT INTO file_derivatives (
          tenant_id, file_id, kind, status, object_key, media_type, size_bytes,
          generator_version, metadata
        ) VALUES (
          $1::uuid, $2::uuid, 'text_extract', 'available', $3, $4, $5,
          'tika-v1', jsonb_build_object('contentHash', $6)
        )
        ON CONFLICT (file_id, kind, generator_version) DO UPDATE SET
          status = 'available', object_key = EXCLUDED.object_key,
          media_type = EXCLUDED.media_type, size_bytes = EXCLUDED.size_bytes,
          metadata = EXCLUDED.metadata, error = NULL, updated_at = now()
      `, [input.tenantId, input.source.sourceId, input.derivativeObjectKey, input.mediaType, input.sizeBytes, input.contentHash]);
      await executor.execute(`
        UPDATE knowledge_sources
        SET extraction_status = 'available', index_status = 'chunking',
            content_hash = $4, failure_reason = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
      `, [input.tenantId, input.source.id, input.source.revision, input.contentHash]);
      await this.enqueue(executor, input.tenantId, "knowledge.chunk", input.source.id, input.source.revision);
    });
  }

  async reuseExtraction(tenantId: string, source: KnowledgeSourceRecord): Promise<void> {
    await this.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        UPDATE knowledge_sources
        SET extraction_status = 'available', index_status = 'chunking',
            failure_reason = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
      `, [tenantId, source.id, source.revision]);
      await this.enqueue(executor, tenantId, "knowledge.chunk", source.id, source.revision, "cached-extract");
    });
  }

  async replaceChunks(input: {
    tenantId: string;
    source: KnowledgeSourceRecord;
    chunks: readonly TextChunk[];
  }): Promise<void> {
    await this.withTenant(input.tenantId, async (executor) => {
      const [current] = await executor.query<{ id: string }>(`
        SELECT id FROM knowledge_sources
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
        FOR UPDATE
      `, [input.tenantId, input.source.id, input.source.revision]);
      if (!current) return;
      const existing = await executor.query<{ ordinal: number; content_hash: string | null }>(`
        SELECT ordinal, metadata->>'contentHash' AS content_hash
        FROM knowledge_chunks
        WHERE tenant_id = $1::uuid AND source_id = $2::uuid
        ORDER BY ordinal ASC
      `, [input.tenantId, input.source.id]);
      const unchanged = existing.length === input.chunks.length && existing.every((row, index) => {
        const chunk = input.chunks[index];
        return chunk?.ordinal === row.ordinal && chunk.metadata.contentHash === row.content_hash;
      });
      if (unchanged) {
        await this.markTextReady(executor, input);
        await this.enqueue(
          executor,
          input.tenantId,
          "knowledge.embed",
          input.source.id,
          input.source.revision,
          input.chunks.map((chunk) => chunk.metadata.contentHash).join("").slice(0, 64),
        );
        return;
      }
      await executor.execute("DELETE FROM knowledge_chunks WHERE tenant_id = $1::uuid AND source_id = $2::uuid", [input.tenantId, input.source.id]);
      for (const chunk of input.chunks) {
        await executor.execute(`
          INSERT INTO knowledge_chunks (
            tenant_id, workspace_id, source_id, ordinal, text_content,
            token_estimate, metadata, vector_ready
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, false)
        `, [
          input.tenantId,
          input.source.workspaceId,
          input.source.id,
          chunk.ordinal,
          chunk.text,
          chunk.tokenEstimate,
          JSON.stringify(chunk.metadata),
        ]);
      }
      await this.markTextReady(executor, input);
      await this.enqueue(executor, input.tenantId, "knowledge.embed", input.source.id, input.source.revision);
    });
  }

  async listChunks(tenantId: string, sourceId: string, revision: string): Promise<StoredKnowledgeChunk[]> {
    return this.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<ChunkRow>(`
        SELECT kc.id, kc.text_content, kc.ordinal, kc.token_estimate
        FROM knowledge_chunks kc
        JOIN knowledge_sources ks ON ks.id = kc.source_id
        WHERE kc.tenant_id = $1::uuid AND kc.source_id = $2::uuid
          AND ks.source_revision = $3 AND ks.tombstoned_at IS NULL
        ORDER BY kc.ordinal ASC
      `, [tenantId, sourceId, revision]);
      return rows.map((row) => ({
        id: row.id,
        text: row.text_content,
        ordinal: row.ordinal,
        tokenEstimate: row.token_estimate,
      }));
    });
  }

  async saveEmbeddings(input: {
    tenantId: string;
    source: KnowledgeSourceRecord;
    chunks: readonly StoredKnowledgeChunk[];
    vectors: readonly number[][];
    profile: { id: string; provider: string; model: string; dimensions: number; version: number };
  }): Promise<void> {
    if (input.chunks.length !== input.vectors.length) throw new Error("Embedding count does not match chunk count");
    await this.withTenant(input.tenantId, async (executor) => {
      for (let index = 0; index < input.chunks.length; index += 1) {
        const chunk = input.chunks[index]!;
        const vector = input.vectors[index]!;
        await executor.execute(`
          UPDATE knowledge_chunks SET
            embedding = $4::vector,
            embedding_profile_id = $5,
            embedding_provider = $6,
            embedding_model = $7,
            embedding_dimensions = $8,
            embedding_profile_version = $9,
            embedding_hash = $10,
            vector_ready = true,
            updated_at = now()
          WHERE tenant_id = $1::uuid AND source_id = $2::uuid AND id = $3::uuid
        `, [
          input.tenantId,
          input.source.id,
          chunk.id,
          `[${vector.join(",")}]`,
          input.profile.id,
          input.profile.provider,
          input.profile.model,
          input.profile.dimensions,
          input.profile.version,
          createHash("sha256").update(JSON.stringify(vector)).digest("hex"),
        ]);
      }
      await executor.execute(`
        UPDATE knowledge_sources
        SET vector_ready = true, index_status = 'indexed', failure_reason = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
      `, [input.tenantId, input.source.id, input.source.revision]);
    });
  }

  async markEmbeddingRetryable(tenantId: string, sourceId: string, revision: string, reason: string): Promise<void> {
    await this.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        UPDATE knowledge_sources
        SET vector_ready = false, index_status = 'indexed',
            failure_reason = $4, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
      `, [tenantId, sourceId, revision, safeReason(reason)]);
    });
  }

  async markFailed(tenantId: string, sourceId: string, revision: string, reason: string): Promise<void> {
    await this.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        UPDATE knowledge_sources
        SET extraction_status = 'failed', index_status = 'failed',
            vector_ready = false, failure_reason = $4, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
      `, [tenantId, sourceId, revision, safeReason(reason)]);
      await executor.execute(`
        UPDATE workspace_files wf SET index_status = 'failed', updated_at = now()
        FROM knowledge_sources ks
        WHERE ks.tenant_id = $1::uuid AND ks.id = $2::uuid
          AND wf.tenant_id = ks.tenant_id AND wf.workspace_id = ks.workspace_id
          AND wf.file_id::text = ks.source_id AND wf.deleted_at IS NULL
      `, [tenantId, sourceId]);
    });
  }

  async deleteSource(tenantId: string, sourceId: string, revision: string): Promise<void> {
    await this.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        DELETE FROM knowledge_chunks
        WHERE tenant_id = $1::uuid AND source_id = $2::uuid
      `, [tenantId, sourceId]);
      await executor.execute(`
        UPDATE knowledge_sources
        SET index_status = 'deleted', vector_ready = false,
            tombstoned_at = COALESCE(tombstoned_at, now()), updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND source_revision = $3
      `, [tenantId, sourceId, revision]);
    });
  }

  async resetForReindex(tenantId: string, sourceId: string, revision: string): Promise<void> {
    await this.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        UPDATE knowledge_sources
        SET extraction_status = 'pending', index_status = 'pending',
            vector_ready = false, failure_reason = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
      `, [tenantId, sourceId, revision]);
      await this.enqueue(executor, tenantId, "knowledge.extract", sourceId, revision, "reindex");
    });
  }

  async createTaskOutcomeSource(input: {
    tenantId: string;
    workspaceId: string;
    taskId: string;
    sessionId: string;
    revision: string;
  }): Promise<{ source: KnowledgeSourceRecord; text: string } | null> {
    return this.withTenant(input.tenantId, async (executor) => {
      const [task] = await executor.query<{ title: string; user_id: string | null }>(`
        SELECT title, user_id FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND workspace_id = $3::uuid AND status = 'completed' AND deleted_at IS NULL
      `, [input.tenantId, input.taskId, input.workspaceId]);
      if (!task) return null;
      const parts = await executor.query<{ role: string; type: string; content: unknown; created_at: Date | string }>(`
        SELECT m.role::text, mp.type::text, mp.content, m.created_at
        FROM messages m
        JOIN message_parts mp ON mp.message_id = m.id
        WHERE m.tenant_id = $1::uuid AND m.session_id = $2::uuid
          AND m.role IN ('user', 'assistant')
          AND mp.type IN ('text', 'code')
          AND m.status = 'complete'
        ORDER BY m.sequence_id ASC, mp.ordinal ASC
      `, [input.tenantId, input.sessionId]);
      const [checkpoint] = await executor.query<{ checkpoint: unknown }>(`
        SELECT checkpoint FROM session_checkpoints
        WHERE tenant_id = $1::uuid AND session_id = $2::uuid
          AND kind = 'rolling' AND validation_status = 'valid'
        ORDER BY created_at DESC LIMIT 1
      `, [input.tenantId, input.sessionId]);
      const textParts = parts.flatMap((part) => {
        const content = textContent(part.content);
        return content ? [`${part.role === "user" ? "User request" : "Assistant result"}:\n${content}`] : [];
      });
      const checkpointSummary = checkpointNarrative(checkpoint?.checkpoint);
      if (checkpointSummary) textParts.push(`Portable checkpoint:\n${checkpointSummary}`);
      const text = textParts.join("\n\n").trim();
      if (!text) return null;
      const contentHash = createHash("sha256").update(text).digest("hex");
      const [row] = await executor.query<SourceRow>(`
        INSERT INTO knowledge_sources (
          tenant_id, user_id, workspace_id, source_type, source_id,
          source_revision, content_hash, title, authority, visibility,
          extraction_status, index_status, extractor_version, chunker_version,
          metadata
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'task_outcome', $4, $5, $6, $7,
          0.8, 'project', 'available', 'chunking', 'task-outcome-v1',
          'recursive-v1', jsonb_build_object('sessionId', $8, 'inlineText', $9)
        )
        ON CONFLICT (tenant_id, workspace_id, source_type, source_id, source_revision)
        DO UPDATE SET content_hash = EXCLUDED.content_hash, title = EXCLUDED.title,
          metadata = EXCLUDED.metadata, tombstoned_at = NULL, updated_at = now()
        RETURNING id, tenant_id, workspace_id, user_id, source_type, source_id,
                  source_revision, content_hash, title, visibility, index_status, metadata,
                  tombstoned_at, NULL::text AS media_type, NULL::text AS bucket,
                  NULL::text AS object_key, NULL::text AS derivative_object_key
      `, [
        input.tenantId,
        task.user_id,
        input.workspaceId,
        input.taskId,
        input.revision,
        contentHash,
        task.title,
        input.sessionId,
        text,
      ]);
      if (!row) return null;
      await executor.execute(`
        DELETE FROM knowledge_chunks
        WHERE tenant_id = $1::uuid AND source_id IN (
          SELECT id FROM knowledge_sources
          WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
            AND source_type = 'task_outcome' AND source_id = $3
            AND id <> $4::uuid
        )
      `, [input.tenantId, input.workspaceId, input.taskId, row.id]);
      await executor.execute(`
        UPDATE knowledge_sources
        SET tombstoned_at = COALESCE(tombstoned_at, now()),
            index_status = 'deleted', vector_ready = false, updated_at = now()
        WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
          AND source_type = 'task_outcome' AND source_id = $3
          AND id <> $4::uuid AND tombstoned_at IS NULL
      `, [input.tenantId, input.workspaceId, input.taskId, row.id]);
      return { source: sourceFromRow(row), text };
    });
  }

  private async transition(
    tenantId: string,
    sourceId: string,
    revision: string,
    assignment: string,
    workspaceStatus: string,
    predicate = "",
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(`
        UPDATE knowledge_sources SET ${assignment}
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND source_revision = $3 AND tombstoned_at IS NULL
          ${predicate}
        RETURNING id
      `, [tenantId, sourceId, revision]);
      if (rows.length === 0) return false;
      await executor.execute(`
        UPDATE workspace_files wf SET index_status = $3, updated_at = now()
        FROM knowledge_sources ks
        WHERE ks.tenant_id = $1::uuid AND ks.id = $2::uuid
          AND wf.tenant_id = ks.tenant_id AND wf.workspace_id = ks.workspace_id
          AND wf.file_id::text = ks.source_id AND wf.deleted_at IS NULL
      `, [tenantId, sourceId, workspaceStatus]);
      return true;
    });
  }

  private async markTextReady(
    executor: SqlExecutor,
    input: { tenantId: string; source: KnowledgeSourceRecord },
  ): Promise<void> {
    await executor.execute(`
      UPDATE knowledge_sources
      SET index_status = 'indexed', extraction_status = 'available',
          vector_ready = false, failure_reason = NULL, updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND source_revision = $3
    `, [input.tenantId, input.source.id, input.source.revision]);
    if (input.source.sourceType !== "file") return;
    await executor.execute(`
      UPDATE workspace_files SET index_status = 'indexed', updated_at = now()
      WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid
        AND file_id = $3::uuid AND deleted_at IS NULL
    `, [input.tenantId, input.source.workspaceId, input.source.sourceId]);
    await executor.execute(`
      UPDATE files SET status = 'available', updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL
    `, [input.tenantId, input.source.sourceId]);
  }

  private async enqueue(
    executor: SqlExecutor,
    tenantId: string,
    eventType: string,
    sourceId: string,
    revision: string,
    suffix = "",
  ): Promise<void> {
    const dedupeKey = `${eventType}:${sourceId}:${revision}${suffix ? `:${suffix}` : ""}`;
    await executor.execute(`
      INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    `, [tenantId, eventType, sourceId, dedupeKey, JSON.stringify({ tenantId, sourceId, revision })]);
  }

  private async withTenant<T>(tenantId: string, callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(executor);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }
}

type SourceRow = {
  id: string;
  tenant_id: string;
  workspace_id: string;
  user_id: string | null;
  source_type: KnowledgeSourceRecord["sourceType"];
  source_id: string;
  source_revision: string;
  content_hash: string;
  title: string;
  visibility: KnowledgeSourceRecord["visibility"];
  index_status: string;
  metadata: unknown;
  tombstoned_at: Date | string | null;
  media_type: string | null;
  bucket: string | null;
  object_key: string | null;
  derivative_object_key: string | null;
};

type ChunkRow = {
  id: string;
  text_content: string;
  ordinal: number;
  token_estimate: number;
};

function sourceFromRow(row: SourceRow): KnowledgeSourceRecord {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    revision: row.source_revision,
    contentHash: row.content_hash,
    title: row.title,
    visibility: row.visibility,
    status: row.index_status,
    mediaType: row.media_type ?? "text/plain",
    bucket: row.bucket,
    objectKey: row.object_key,
    derivativeObjectKey: row.derivative_object_key,
    inlineText: typeof metadata.inlineText === "string" ? metadata.inlineText : null,
    tombstonedAt: row.tombstoned_at,
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "code"]) {
    if (typeof record[key] === "string") return record[key].trim();
  }
  return "";
}

function checkpointNarrative(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const checkpoint = value as Record<string, unknown>;
  const parts = [
    typeof checkpoint.goal === "string" ? `Goal: ${checkpoint.goal}` : "",
    typeof checkpoint.narrative === "string" ? checkpoint.narrative : "",
    ...stringList(checkpoint.completedWork).map((item) => `Completed: ${item}`),
    ...checkpointDecisionList(checkpoint.decisions).map((item) => `Decision: ${item}`),
    ...checkpointArtifactList(checkpoint.artifacts).map((item) => `Artifact: ${item}`),
    typeof checkpoint.nextAction === "string" ? `Next action: ${checkpoint.nextAction}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function checkpointDecisionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const detail = (item as Record<string, unknown>).detail;
    return typeof detail === "string" ? [detail] : [];
  });
}

function checkpointArtifactList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label : "";
    const path = typeof record.path === "string" ? record.path : "";
    return label || path ? [[label, path].filter(Boolean).join(" — ")] : [];
  });
}

function safeReason(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 2_000);
}
