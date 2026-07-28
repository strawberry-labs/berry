import { z } from "zod";
import type {
  ContextBackfillJobPayload,
  RetentionCleanupJobPayload,
} from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";

const BackfillPhaseSchema = z.enum(["workspace_files", "file_sources", "task_outcomes"]);
const CleanupPhaseSchema = z.enum(["expired_memory", "turn_events", "retrieval_snapshots", "knowledge_tombstones", "runtime_outbox"]);
const BackfillCursorSchema = z.object({
  phase: BackfillPhaseSchema.default("workspace_files"),
  lastId: z.string().uuid().nullable().default(null),
});
const CleanupCursorSchema = z.object({
  phase: CleanupPhaseSchema.default("expired_memory"),
});

type BatchResult = {
  scanned: number;
  changed: number;
  enqueued: number;
  exhausted: boolean;
  lastId?: string | null;
};

type MaintenanceRunRow = {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  cursor: unknown;
};

export type MaintenanceBatchResult = {
  runId: string;
  status: "running" | "completed" | "cancelled";
  phase: string;
  scanned: number;
  changed: number;
  enqueued: number;
};

export interface MaintenanceRunner {
  backfill(payload: ContextBackfillJobPayload): Promise<MaintenanceBatchResult>;
  cleanup(payload: RetentionCleanupJobPayload): Promise<MaintenanceBatchResult>;
}

/**
 * Runs one bounded, tenant-scoped maintenance batch. Progress and the next
 * cursor are committed in the same transaction as mutations and the outbox
 * wakeup, so retries can safely resume without an API-process memory cursor.
 */
export class SqlMaintenanceRunner implements MaintenanceRunner {
  constructor(private readonly executor: SqlExecutor) {}

  async backfill(payload: ContextBackfillJobPayload): Promise<MaintenanceBatchResult> {
    try {
      return await this.withTenant(payload.tenantId, async (executor) => {
        const run = await this.claim(executor, payload, "context_backfill", { phase: "workspace_files", lastId: null });
        if (run.status === "completed" || run.status === "cancelled") {
          return { runId: payload.runId, status: run.status, phase: "done", scanned: 0, changed: 0, enqueued: 0 };
        }
        const cursor = BackfillCursorSchema.parse(run.cursor);
        const batch = cursor.phase === "workspace_files"
          ? await this.backfillWorkspaceFiles(executor, payload, cursor.lastId)
          : cursor.phase === "file_sources"
            ? await this.backfillFileSources(executor, payload, cursor.lastId)
            : await this.backfillTaskOutcomes(executor, payload, cursor.lastId);
        const nextPhase = batch.exhausted ? nextBackfillPhase(cursor.phase) : cursor.phase;
        const completed = batch.exhausted && nextPhase === null;
        const nextCursor = {
          phase: nextPhase ?? cursor.phase,
          lastId: batch.exhausted ? null : batch.lastId ?? cursor.lastId,
        };
        await this.recordProgress(executor, payload, batch, nextCursor, completed);
        if (!completed) await this.enqueueNext(executor, "context.backfill", payload, payload.generation + 1);
        return {
          runId: payload.runId,
          status: completed ? "completed" : "running",
          phase: completed ? "done" : nextCursor.phase,
          scanned: batch.scanned,
          changed: batch.changed,
          enqueued: batch.enqueued,
        };
      });
    } catch (error) {
      await this.recordFailure(payload.tenantId, payload.runId, error);
      throw error;
    }
  }

  async cleanup(payload: RetentionCleanupJobPayload): Promise<MaintenanceBatchResult> {
    try {
      return await this.withTenant(payload.tenantId, async (executor) => {
        const run = await this.claim(executor, payload, "retention_cleanup", { phase: "expired_memory" });
        if (run.status === "completed" || run.status === "cancelled") {
          return { runId: payload.runId, status: run.status, phase: "done", scanned: 0, changed: 0, enqueued: 0 };
        }
        const cursor = CleanupCursorSchema.parse(run.cursor);
        const batch = await this.cleanupPhase(executor, payload, cursor.phase);
        const nextPhase = batch.exhausted ? nextCleanupPhase(cursor.phase) : cursor.phase;
        const completed = batch.exhausted && nextPhase === null;
        const nextCursor = { phase: nextPhase ?? cursor.phase };
        await this.recordProgress(executor, payload, batch, nextCursor, completed);
        if (!completed) await this.enqueueNext(executor, "context.cleanup", payload, payload.generation + 1);
        return {
          runId: payload.runId,
          status: completed ? "completed" : "running",
          phase: completed ? "done" : nextCursor.phase,
          scanned: batch.scanned,
          changed: batch.changed,
          enqueued: 0,
        };
      });
    } catch (error) {
      await this.recordFailure(payload.tenantId, payload.runId, error);
      throw error;
    }
  }

  private async claim(
    executor: SqlExecutor,
    payload: ContextBackfillJobPayload | RetentionCleanupJobPayload,
    kind: "context_backfill" | "retention_cleanup",
    initialCursor: Record<string, unknown>,
  ): Promise<MaintenanceRunRow> {
    await executor.execute(`
      INSERT INTO maintenance_runs (
        id, tenant_id, kind, status, cursor, requested_by_user_id
      ) VALUES ($1::uuid, $2::uuid, $3, 'queued', $4::jsonb, $5::uuid)
      ON CONFLICT (id) DO NOTHING
    `, [
      payload.runId,
      payload.tenantId,
      kind,
      JSON.stringify(initialCursor),
      payload.requestedByUserId ?? null,
    ]);
    const rows = await executor.query<MaintenanceRunRow>(`
      SELECT status, cursor
      FROM maintenance_runs
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND kind = $3
      FOR UPDATE
    `, [payload.tenantId, payload.runId, kind]);
    const run = rows[0];
    if (!run) throw new Error("Maintenance run was not found after admission");
    if (run.status !== "completed" && run.status !== "cancelled") {
      await executor.execute(`
        UPDATE maintenance_runs
        SET status = 'running', started_at = COALESCE(started_at, now()),
            last_error = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [payload.tenantId, payload.runId]);
    }
    return run;
  }

  private async backfillWorkspaceFiles(
    executor: SqlExecutor,
    payload: ContextBackfillJobPayload,
    lastId: string | null,
  ): Promise<BatchResult> {
    const rows = await executor.query<{
      association_id: string;
      file_id: string;
      task_id: string;
      workspace_id: string;
      owner_user_id: string | null;
    }>(`
      SELECT fa.id AS association_id, fa.file_id, t.id AS task_id,
             t.workspace_id, COALESCE(f.owner_user_id, t.user_id) AS owner_user_id
      FROM file_associations fa
      JOIN files f ON f.tenant_id = fa.tenant_id AND f.id = fa.file_id
      JOIN tasks t ON t.tenant_id = fa.tenant_id AND t.id = fa.task_id
      JOIN workspaces w ON w.tenant_id = t.tenant_id AND w.id = t.workspace_id
      WHERE fa.tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR fa.id > $2::uuid)
        AND w.workspace_kind = 'project'
        AND f.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY fa.id ASC
      LIMIT $3
    `, [payload.tenantId, lastId, payload.batchSize]);
    let changed = 0;
    for (const row of rows) {
      const inserted = await executor.query<{ id: string }>(`
        INSERT INTO workspace_files (
          tenant_id, workspace_id, file_id, visibility, originating_task_id,
          index_status, created_by_user_id
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'task_only', $4::uuid, 'pending', $5::uuid)
        ON CONFLICT (tenant_id, workspace_id, file_id) DO NOTHING
        RETURNING id
      `, [payload.tenantId, row.workspace_id, row.file_id, row.task_id, row.owner_user_id]);
      changed += inserted.length;
    }
    return {
      scanned: rows.length,
      changed,
      enqueued: 0,
      exhausted: rows.length < payload.batchSize,
      lastId: rows.at(-1)?.association_id ?? lastId,
    };
  }

  private async backfillFileSources(
    executor: SqlExecutor,
    payload: ContextBackfillJobPayload,
    lastId: string | null,
  ): Promise<BatchResult> {
    const rows = await executor.query<{
      workspace_file_id: string;
      workspace_id: string;
      file_id: string;
      visibility: string;
      owner_user_id: string | null;
      display_name: string;
      media_type: string;
      object_key: string;
      originating_task_id: string | null;
      revision: string;
      content_hash: string;
    }>(`
      SELECT wf.id AS workspace_file_id, wf.workspace_id, wf.file_id, wf.visibility,
             wf.originating_task_id, f.owner_user_id, f.display_name, f.media_type, f.object_key,
             COALESCE(NULLIF(f.object_version_id,''), NULLIF(f.etag,''), NULLIF(f.sha256,''), 'legacy-' || f.id::text) AS revision,
             COALESCE(NULLIF(f.sha256,''), NULLIF(f.etag,''), NULLIF(f.object_version_id,''), 'legacy-' || f.id::text) AS content_hash
      FROM workspace_files wf
      JOIN files f ON f.tenant_id = wf.tenant_id AND f.id = wf.file_id
      WHERE wf.tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR wf.id > $2::uuid)
        AND wf.deleted_at IS NULL AND f.deleted_at IS NULL
        AND f.status IN ('available','processing')
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_sources ks
          WHERE ks.tenant_id = wf.tenant_id AND ks.workspace_id = wf.workspace_id
            AND ks.source_type = 'file' AND ks.source_id = wf.file_id::text
            AND ks.tombstoned_at IS NULL
        )
      ORDER BY wf.id ASC
      LIMIT $3
    `, [payload.tenantId, lastId, payload.batchSize]);
    let changed = 0;
    let enqueued = 0;
    for (const row of rows) {
      const sources = await executor.query<{ id: string }>(`
        INSERT INTO knowledge_sources (
          tenant_id, user_id, workspace_id, source_type, source_id, source_revision,
          content_hash, title, visibility, extraction_status, index_status,
          extractor_version, chunker_version, metadata
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'file', $4, $5, $6, $7, $8,
          'pending', 'pending', 'tika-v1', 'recursive-v1',
          jsonb_strip_nulls(jsonb_build_object(
            'fileId',$4,
            'mediaType',$9,
            'objectKey',$10,
            'taskId',$11::text,
            'backfilled',true
          ))
        )
        ON CONFLICT (tenant_id, workspace_id, source_type, source_id, source_revision)
        DO UPDATE SET tombstoned_at = NULL, failure_reason = NULL,
          extraction_status = 'pending', index_status = 'pending', updated_at = now()
        RETURNING id
      `, [
        payload.tenantId,
        row.owner_user_id,
        row.workspace_id,
        row.file_id,
        row.revision,
        row.content_hash,
        row.display_name,
        row.visibility,
        row.media_type,
        row.object_key,
        row.originating_task_id,
      ]);
      const source = sources[0];
      if (!source) continue;
      changed += 1;
      await executor.execute(`
        INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
        VALUES ($1::uuid, 'knowledge.extract', $2, $3, $4::jsonb)
        ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
      `, [
        payload.tenantId,
        source.id,
        `knowledge.extract:${source.id}:${row.revision}:backfill`,
        JSON.stringify({ tenantId: payload.tenantId, sourceId: source.id, revision: row.revision }),
      ]);
      enqueued += 1;
      await executor.execute(`
        UPDATE files SET status = 'processing', updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'available'
      `, [payload.tenantId, row.file_id]);
    }
    return {
      scanned: rows.length,
      changed,
      enqueued,
      exhausted: rows.length < payload.batchSize,
      lastId: rows.at(-1)?.workspace_file_id ?? lastId,
    };
  }

  private async backfillTaskOutcomes(
    executor: SqlExecutor,
    payload: ContextBackfillJobPayload,
    lastId: string | null,
  ): Promise<BatchResult> {
    const rows = await executor.query<{
      task_id: string;
      workspace_id: string;
      session_id: string;
      updated_at: Date | string;
    }>(`
      SELECT t.id AS task_id, t.workspace_id, t.active_session_id AS session_id, t.updated_at
      FROM tasks t
      JOIN workspaces w ON w.tenant_id = t.tenant_id AND w.id = t.workspace_id
      WHERE t.tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR t.id > $2::uuid)
        AND t.status = 'completed' AND t.active_session_id IS NOT NULL
        AND t.deleted_at IS NULL AND w.deleted_at IS NULL
        AND w.workspace_kind = 'project'
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_sources ks
          WHERE ks.tenant_id = t.tenant_id AND ks.workspace_id = t.workspace_id
            AND ks.source_type = 'task_outcome' AND ks.source_id = t.id::text
            AND ks.tombstoned_at IS NULL
        )
      ORDER BY t.id ASC
      LIMIT $3
    `, [payload.tenantId, lastId, payload.batchSize]);
    let enqueued = 0;
    for (const row of rows) {
      const revision = `backfill-v1:${new Date(row.updated_at).toISOString()}`;
      await executor.execute(`
        INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
        VALUES ($1::uuid, 'knowledge.index-task', $2, $3, $4::jsonb)
        ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
      `, [
        payload.tenantId,
        row.task_id,
        `knowledge.index-task:${row.task_id}:${revision}`,
        JSON.stringify({
          tenantId: payload.tenantId,
          workspaceId: row.workspace_id,
          taskId: row.task_id,
          sessionId: row.session_id,
          revision,
        }),
      ]);
      enqueued += 1;
    }
    return {
      scanned: rows.length,
      changed: 0,
      enqueued,
      exhausted: rows.length < payload.batchSize,
      lastId: rows.at(-1)?.task_id ?? lastId,
    };
  }

  private async cleanupPhase(
    executor: SqlExecutor,
    payload: RetentionCleanupJobPayload,
    phase: z.infer<typeof CleanupPhaseSchema>,
  ): Promise<BatchResult> {
    let rows: readonly { id: string }[];
    if (phase === "expired_memory") {
      rows = await executor.query<{ id: string }>(`
        WITH expired AS (
          SELECT id FROM memory_items
          WHERE tenant_id = $1::uuid AND status = 'active'
            AND expires_at IS NOT NULL AND expires_at <= now()
          ORDER BY expires_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        ),
        versioned AS (
          INSERT INTO memory_item_versions (
            tenant_id, memory_item_id, operation, before_value, after_value,
            extractor_version, reason
          )
          SELECT $1::uuid, item.id, 'FORGET', to_jsonb(item), NULL,
                 'retention-v1', 'expired_by_retention_cleanup'
          FROM memory_items item JOIN expired ON expired.id = item.id
          RETURNING memory_item_id
        )
        UPDATE memory_items item
        SET status = 'forgotten', updated_at = now()
        FROM expired
        WHERE item.tenant_id = $1::uuid AND item.id = expired.id
        RETURNING item.id
      `, [payload.tenantId, payload.batchSize]);
    } else if (phase === "turn_events") {
      rows = await executor.query<{ id: string }>(`
        DELETE FROM turn_events event
        WHERE event.id IN (
          SELECT candidate.id
          FROM turn_events candidate
          JOIN turn_runs run ON run.tenant_id = candidate.tenant_id AND run.id = candidate.run_id
          WHERE candidate.tenant_id = $1::uuid
            AND run.state IN ('completed','failed','cancelled','recovery_required')
            AND run.completed_at < now() - ($2::int * interval '1 day')
          ORDER BY candidate.created_at ASC, candidate.id ASC
          LIMIT $3
        )
        RETURNING event.id
      `, [payload.tenantId, payload.eventRetentionDays, payload.batchSize]);
    } else if (phase === "retrieval_snapshots") {
      rows = await executor.query<{ id: string }>(`
        DELETE FROM retrieval_snapshots snapshot
        WHERE snapshot.id IN (
          SELECT id FROM retrieval_snapshots
          WHERE tenant_id = $1::uuid
            AND created_at < now() - ($2::int * interval '1 day')
          ORDER BY created_at ASC, id ASC
          LIMIT $3
        )
        RETURNING snapshot.id
      `, [payload.tenantId, payload.diagnosticRetentionDays, payload.batchSize]);
    } else if (phase === "knowledge_tombstones") {
      rows = await executor.query<{ id: string }>(`
        DELETE FROM knowledge_sources source
        WHERE source.id IN (
          SELECT id FROM knowledge_sources
          WHERE tenant_id = $1::uuid AND tombstoned_at IS NOT NULL
            AND tombstoned_at < now() - ($2::int * interval '1 day')
          ORDER BY tombstoned_at ASC, id ASC
          LIMIT $3
        )
        RETURNING source.id
      `, [payload.tenantId, payload.diagnosticRetentionDays, payload.batchSize]);
    } else {
      rows = await executor.query<{ id: string }>(`
        DELETE FROM runtime_outbox outbox
        WHERE outbox.id IN (
          SELECT id FROM runtime_outbox
          WHERE tenant_id = $1::uuid AND completed_at IS NOT NULL
            AND completed_at < now() - ($2::int * interval '1 day')
          ORDER BY completed_at ASC, id ASC
          LIMIT $3
        )
        RETURNING outbox.id
      `, [payload.tenantId, payload.outboxRetentionDays, payload.batchSize]);
    }
    return {
      scanned: rows.length,
      changed: rows.length,
      enqueued: 0,
      exhausted: rows.length < payload.batchSize,
    };
  }

  private async recordProgress(
    executor: SqlExecutor,
    payload: ContextBackfillJobPayload | RetentionCleanupJobPayload,
    batch: BatchResult,
    cursor: Record<string, unknown>,
    completed: boolean,
  ): Promise<void> {
    await executor.execute(`
      UPDATE maintenance_runs
      SET status = CASE WHEN $7::boolean THEN 'completed' ELSE 'running' END,
          cursor = $3::jsonb,
          scanned_count = scanned_count + $4,
          changed_count = changed_count + $5,
          enqueued_count = enqueued_count + $6,
          completed_at = CASE WHEN $7::boolean THEN now() ELSE NULL END,
          last_error = NULL,
          updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
    `, [
      payload.tenantId,
      payload.runId,
      JSON.stringify(cursor),
      batch.scanned,
      batch.changed,
      batch.enqueued,
      completed,
    ]);
  }

  private async enqueueNext(
    executor: SqlExecutor,
    eventType: "context.backfill" | "context.cleanup",
    payload: ContextBackfillJobPayload | RetentionCleanupJobPayload,
    generation: number,
  ): Promise<void> {
    await executor.execute(`
      INSERT INTO runtime_outbox (tenant_id, event_type, aggregate_id, dedupe_key, payload)
      VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    `, [
      payload.tenantId,
      eventType,
      payload.runId,
      `maintenance:${payload.runId}:${generation}`,
      JSON.stringify({ ...payload, generation }),
    ]);
  }

  private async recordFailure(tenantId: string, runId: string, error: unknown): Promise<void> {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    await this.withTenant(tenantId, async (executor) => {
      await executor.execute(`
        UPDATE maintenance_runs
        SET status = 'failed', failure_count = failure_count + 1,
            last_error = $3, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [tenantId, runId, reason]);
    }).catch(() => undefined);
  }

  private async withTenant<T>(tenantId: string, callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(executor);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }
}

function nextBackfillPhase(phase: z.infer<typeof BackfillPhaseSchema>): z.infer<typeof BackfillPhaseSchema> | null {
  if (phase === "workspace_files") return "file_sources";
  if (phase === "file_sources") return "task_outcomes";
  return null;
}

function nextCleanupPhase(phase: z.infer<typeof CleanupPhaseSchema>): z.infer<typeof CleanupPhaseSchema> | null {
  if (phase === "expired_memory") return "turn_events";
  if (phase === "turn_events") return "retrieval_snapshots";
  if (phase === "retrieval_snapshots") return "knowledge_tombstones";
  if (phase === "knowledge_tombstones") return "runtime_outbox";
  return null;
}
