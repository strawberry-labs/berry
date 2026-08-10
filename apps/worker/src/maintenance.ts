import { z } from "zod";
import type {
  ContextBackfillJobPayload,
  RetentionCleanupJobPayload,
} from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";

const BackfillPhaseSchema = z.enum(["workspace_files", "file_sources", "task_outcomes", "verify_file_blobs"]);
const CleanupPhaseSchema = z.enum(["expired_memory", "turn_events", "retrieval_snapshots", "vision_observations", "knowledge_tombstones", "orphan_budget_reservations", "orphan_files", "runtime_outbox"]);
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
        const run = await this.claim(executor, payload, "context_backfill", { phase: payload.phase ?? "workspace_files", lastId: null });
        if (run.status === "completed" || run.status === "cancelled") {
          return { runId: payload.runId, status: run.status, phase: "done", scanned: 0, changed: 0, enqueued: 0 };
        }
        const cursor = BackfillCursorSchema.parse(run.cursor);
        const batch = cursor.phase === "workspace_files"
          ? await this.backfillWorkspaceFiles(executor, payload, cursor.lastId)
          : cursor.phase === "file_sources"
            ? await this.backfillFileSources(executor, payload, cursor.lastId)
            : cursor.phase === "task_outcomes"
              ? await this.backfillTaskOutcomes(executor, payload, cursor.lastId)
              : await this.enqueueBlobVerification(executor, payload, cursor.lastId);
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
          enqueued: batch.enqueued,
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
    // Reference creation and garbage collection serialize on the logical file
    // row. Keep lock ordering deterministic when a batch contains many files.
    const mutationRows = [...rows].sort((left, right) =>
      left.file_id.localeCompare(right.file_id) || left.association_id.localeCompare(right.association_id));
    for (const row of mutationRows) {
      const [locked] = await executor.query<{ id: string }>(`
        SELECT f.id
        FROM files f
        JOIN file_associations fa
          ON fa.tenant_id = f.tenant_id AND fa.file_id = f.id
        WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid
          AND fa.id = $3::uuid AND f.deleted_at IS NULL
        FOR UPDATE OF f
      `, [payload.tenantId, row.file_id, row.association_id]);
      // The candidate query is intentionally paginated without holding locks.
      // If collection won the race, do not revive a reference to a tombstone.
      if (!locked) continue;
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
             wf.originating_task_id, f.owner_user_id, f.display_name, f.media_type,
             CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS object_key,
             COALESCE(
               NULLIF(CASE WHEN f.blob_id IS NOT NULL THEN blob.object_version_id ELSE f.object_version_id END,''),
               NULLIF(CASE WHEN f.blob_id IS NOT NULL THEN blob.etag ELSE f.etag END,''),
               NULLIF(CASE WHEN f.blob_id IS NOT NULL THEN blob.sha256 ELSE f.sha256 END,''),
               'legacy-' || f.id::text
             ) AS revision,
             COALESCE(
               NULLIF(CASE WHEN f.blob_id IS NOT NULL THEN blob.sha256 ELSE f.sha256 END,''),
               NULLIF(CASE WHEN f.blob_id IS NOT NULL THEN blob.etag ELSE f.etag END,''),
               NULLIF(CASE WHEN f.blob_id IS NOT NULL THEN blob.object_version_id ELSE f.object_version_id END,''),
               'legacy-' || f.id::text
             ) AS content_hash
      FROM workspace_files wf
      JOIN files f ON f.tenant_id = wf.tenant_id AND f.id = wf.file_id
      LEFT JOIN file_blobs blob ON blob.tenant_id = f.tenant_id AND blob.id = f.blob_id
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
    } else if (phase === "vision_observations") {
      rows = await executor.query<{ id: string }>(`
        DELETE FROM vision_observation_cache observation
        WHERE observation.id IN (
          SELECT id FROM vision_observation_cache
          WHERE tenant_id = $1::uuid
            AND last_used_at < now() - ($2::int * interval '1 day')
          ORDER BY last_used_at ASC, id ASC
          LIMIT $3
        )
        RETURNING observation.id
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
    } else if (phase === "orphan_budget_reservations") {
      rows = await executor.query<{ id: string }>(`
        WITH candidates AS (
          SELECT reservation.id
          FROM budget_reservations reservation
          WHERE reservation.tenant_id = $1::uuid
            AND reservation.status = 'reserved'
            AND reservation.feature = 'model'
            AND reservation.request_id LIKE 'model_%'
            AND reservation.created_at < now() - interval '15 minutes'
            AND NOT EXISTS (
              SELECT 1 FROM turn_runs run
              WHERE run.tenant_id = reservation.tenant_id
                AND run.request_id = reservation.request_id
            )
          ORDER BY reservation.created_at ASC, reservation.id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        ), released AS (
          UPDATE budget_reservations reservation
          SET status = 'released', actual_cost_micros = 0, updated_at = now()
          FROM candidates
          WHERE reservation.tenant_id = $1::uuid AND reservation.id = candidates.id
          RETURNING reservation.*
        ), scopes AS (
          SELECT released.id AS reservation_id, released.request_id,
                 scope.scope_type, scope.scope_id, -released.reserved_micros AS amount_micros
          FROM released
          CROSS JOIN LATERAL (
            VALUES
              ('org'::text, released.tenant_id::text),
              ('department'::text, released.department_id::text),
              ('user'::text, released.user_id::text)
          ) AS scope(scope_type, scope_id)
          WHERE scope.scope_id IS NOT NULL
        ), ledger AS (
          INSERT INTO credit_ledger_entries (
            tenant_id, scope_type, scope_id, reservation_id, request_id,
            kind, amount_micros, metadata
          )
          SELECT $1::uuid, scope_type, scope_id, reservation_id, request_id,
                 'release', amount_micros, '{"reason":"orphan_admission_timeout"}'::jsonb
          FROM scopes
          ON CONFLICT (tenant_id, request_id, scope_type, scope_id, kind) DO NOTHING
          RETURNING reservation_id
        )
        SELECT DISTINCT reservation_id AS id FROM ledger
      `, [payload.tenantId, payload.batchSize]);
    } else if (phase === "orphan_files") {
      return this.cleanupOrphanFiles(executor, payload);
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

  private async enqueueBlobVerification(
    executor: SqlExecutor,
    payload: ContextBackfillJobPayload,
    lastId: string | null,
  ): Promise<BatchResult> {
    const rows = await executor.query<{ id: string }>(`
      SELECT id
      FROM file_blobs
      WHERE tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR id > $2::uuid)
        AND (
          verification_status IN ('unverified','failed')
          OR (verification_status='verifying' AND updated_at < now()-interval '15 minutes')
        )
        AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT $3
    `, [payload.tenantId, lastId, payload.batchSize]);
    for (const row of rows) {
      await executor.execute(`
        INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
        VALUES ($1::uuid,'file.verify-blob',$2,$3,$4::jsonb)
        ON CONFLICT (tenant_id,dedupe_key) DO UPDATE SET
          completed_at=NULL,available_at=now(),last_error=NULL,updated_at=now()
      `, [payload.tenantId, row.id, `file.verify-blob:${row.id}`, JSON.stringify({ tenantId: payload.tenantId, blobId: row.id })]);
    }
    return {
      scanned: rows.length,
      changed: 0,
      enqueued: rows.length,
      exhausted: rows.length < payload.batchSize,
      lastId: rows.at(-1)?.id ?? lastId,
    };
  }

  private async cleanupOrphanFiles(
    executor: SqlExecutor,
    payload: RetentionCleanupJobPayload,
  ): Promise<BatchResult> {
    await this.retireExpiredUploads(executor, payload);
    const rows = await executor.query<{ id: string; blob_id: string | null; bucket: string; object_key: string; deleted_at: Date | string | null }>(`
      SELECT f.id, f.blob_id, f.deleted_at,
        CASE WHEN f.blob_id IS NOT NULL THEN blob.bucket ELSE f.bucket END AS bucket,
        CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS object_key
      FROM files f
      LEFT JOIN file_blobs blob ON blob.tenant_id=f.tenant_id AND blob.id=f.blob_id
      WHERE f.tenant_id=$1::uuid
        AND (
          f.deleted_at IS NULL
          OR (
            f.blob_id IS NOT NULL
            AND blob.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM files live_file
              WHERE live_file.tenant_id=f.tenant_id
                AND live_file.blob_id=f.blob_id
                AND live_file.deleted_at IS NULL
            )
            AND (
              blob.verification_status IS DISTINCT FROM 'pending_delete'
              OR NOT EXISTS (
                SELECT 1 FROM runtime_outbox pending_delete
                WHERE pending_delete.tenant_id=f.tenant_id
                  AND pending_delete.event_type='file.delete-blob'
                  AND pending_delete.aggregate_id=f.blob_id::text
                  AND pending_delete.completed_at IS NULL
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM file_library_entries library
          WHERE library.tenant_id=f.tenant_id AND library.file_id=f.id AND library.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM file_associations association
          WHERE association.tenant_id=f.tenant_id AND association.file_id=f.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM workspace_files wf
          WHERE wf.tenant_id=f.tenant_id AND wf.file_id=f.id AND wf.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM file_uploads upload
          WHERE upload.tenant_id=f.tenant_id AND upload.file_id=f.id AND upload.status='uploading'
        )
      ORDER BY f.id ASC
      FOR UPDATE OF f SKIP LOCKED
      LIMIT $2
    `, [payload.tenantId, payload.batchSize]);
    let enqueued = 0;
    let changed = 0;
    for (const row of rows) {
      // The candidate statement may have waited on a concurrent reference
      // creator. Recheck in a new statement after owning the file lock so a
      // reference committed while we waited is visible before tombstoning.
      const [references] = await executor.query<{ reference_exists: boolean }>(`
        SELECT (
          EXISTS (
            SELECT 1 FROM file_library_entries library
            WHERE library.tenant_id=$1::uuid AND library.file_id=$2::uuid
              AND library.deleted_at IS NULL
          ) OR EXISTS (
            SELECT 1 FROM file_associations association
            WHERE association.tenant_id=$1::uuid AND association.file_id=$2::uuid
          ) OR EXISTS (
            SELECT 1 FROM workspace_files wf
            WHERE wf.tenant_id=$1::uuid AND wf.file_id=$2::uuid
              AND wf.deleted_at IS NULL
          ) OR EXISTS (
            SELECT 1
            FROM knowledge_sources source
            JOIN workspace_files wf
              ON wf.tenant_id=source.tenant_id
             AND wf.workspace_id=source.workspace_id
             AND wf.file_id=$2::uuid
             AND wf.deleted_at IS NULL
            WHERE source.tenant_id=$1::uuid
              AND source.source_type='file'
              AND source.source_id=$2::uuid::text
              AND source.tombstoned_at IS NULL
          ) OR EXISTS (
            SELECT 1 FROM file_uploads upload
            WHERE upload.tenant_id=$1::uuid AND upload.file_id=$2::uuid
              AND upload.status='uploading'
          )
        ) AS reference_exists
      `, [payload.tenantId, row.id]);
      if (references?.reference_exists) continue;
      const sources = await executor.query<{ id: string; source_revision: string }>(`
        UPDATE knowledge_sources
        SET tombstoned_at=COALESCE(tombstoned_at,now()),extraction_status='deleted',
            index_status='deleted',vector_ready=false,updated_at=now()
        WHERE tenant_id=$1::uuid AND source_type='file' AND source_id=$2::uuid::text
          AND tombstoned_at IS NULL
        RETURNING id,source_revision
      `, [payload.tenantId, row.id]);
      for (const source of sources) {
        await executor.execute(`
          INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
          VALUES ($1::uuid,'knowledge.delete',$2,$3,$4::jsonb)
          ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `, [payload.tenantId, source.id, `knowledge.delete:${source.id}:${source.source_revision}`, JSON.stringify({ tenantId: payload.tenantId, sourceId: source.id, revision: source.source_revision })]);
        enqueued += 1;
      }
      const derivatives = await executor.query<{ object_key: string }>(`
        SELECT object_key FROM file_derivatives
        WHERE tenant_id=$1::uuid AND file_id=$2::uuid AND object_key IS NOT NULL
      `, [payload.tenantId, row.id]);
      if (derivatives.length) {
        await executor.execute(`
          INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
          VALUES ($1::uuid,'file.delete-object',$2,$3,$4::jsonb)
          ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `, [payload.tenantId, row.id, `file.delete-derivatives:${row.id}:maintenance`, JSON.stringify({ tenantId: payload.tenantId, fileId: row.id, bucket: row.bucket, keys: [...new Set(derivatives.map((item) => item.object_key))] })]);
        enqueued += 1;
      }
      await executor.execute(`
        UPDATE files SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid
      `, [payload.tenantId, row.id]);
      if (!row.deleted_at) changed += 1;
      if (row.blob_id) {
        // Multiple logical files can converge on one tenant-scoped blob after
        // verification. Serialize last-reference admission on the blob row so
        // concurrent maintenance batches cannot both observe the other file
        // as live and leave the final blob permanently unscheduled.
        const [lockedBlob] = await executor.query<{ id: string }>(`
          SELECT id FROM file_blobs
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL
          FOR UPDATE
        `, [payload.tenantId, row.blob_id]);
        if (!lockedBlob) continue;
        const [other] = await executor.query<{ id: string }>(`
          SELECT id FROM files
          WHERE tenant_id=$1::uuid AND blob_id=$2::uuid AND id<>$3::uuid AND deleted_at IS NULL
          LIMIT 1
        `, [payload.tenantId, row.blob_id, row.id]);
        if (!other) {
          const [blob] = await executor.query<{ delete_after: Date | string }>(`
            UPDATE file_blobs SET verification_status='pending_delete',
              delete_after=COALESCE(delete_after,now()+interval '7 days'),updated_at=now()
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL
            RETURNING delete_after
          `, [payload.tenantId, row.blob_id]);
          if (blob) {
            await executor.execute(`
              INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload,available_at)
              VALUES ($1::uuid,'file.delete-blob',$2,$3,$4::jsonb,$5::timestamptz)
              ON CONFLICT (tenant_id,dedupe_key) DO UPDATE SET
                available_at=EXCLUDED.available_at,completed_at=NULL,last_error=NULL,updated_at=now()
            `, [payload.tenantId, row.blob_id, `file.delete-blob:${row.blob_id}`, JSON.stringify({ tenantId: payload.tenantId, blobId: row.blob_id }), new Date(blob.delete_after).toISOString()]);
            enqueued += 1;
          }
        }
      } else {
        await executor.execute(`
          INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload,available_at)
          VALUES ($1::uuid,'file.delete-object',$2,$3,$4::jsonb,now()+interval '7 days')
          ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `, [payload.tenantId, row.id, `file.delete-object:legacy:${row.id}`, JSON.stringify({ tenantId: payload.tenantId, fileId: row.id, bucket: row.bucket, keys: [row.object_key] })]);
        enqueued += 1;
      }
    }
    return { scanned: rows.length, changed, enqueued, exhausted: rows.length < payload.batchSize };
  }

  private async retireExpiredUploads(
    executor: SqlExecutor,
    payload: RetentionCleanupJobPayload,
  ): Promise<void> {
    const expired = await executor.query<{ file_id: string }>(`
      WITH candidates AS (
        SELECT upload.id
        FROM file_uploads upload
        WHERE upload.tenant_id=$1::uuid AND upload.status='uploading'
          AND upload.expires_at<=now()
        ORDER BY upload.expires_at,upload.id
        FOR UPDATE OF upload SKIP LOCKED
        LIMIT $2
      )
      UPDATE file_uploads upload
      SET status='expired',updated_at=now()
      FROM candidates
      WHERE upload.tenant_id=$1::uuid AND upload.id=candidates.id
      RETURNING upload.file_id
    `, [payload.tenantId, payload.batchSize]);
    const fileIds = [...new Set(expired.map((row) => row.file_id))].sort();
    for (const fileId of fileIds) {
      const [file] = await executor.query<{ id: string }>(`
        SELECT f.id FROM files f
        WHERE f.tenant_id=$1::uuid AND f.id=$2::uuid AND f.deleted_at IS NULL
        FOR UPDATE OF f
      `, [payload.tenantId, fileId]);
      if (!file) continue;
      await executor.execute(`
        UPDATE files
        SET status='failed',
            metadata=metadata || jsonb_build_object('uploadFailure','expired'),
            updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL
      `, [payload.tenantId, fileId]);
      await executor.execute(`
        UPDATE file_library_entries
        SET deleted_at=COALESCE(deleted_at,now()),updated_at=now()
        WHERE tenant_id=$1::uuid AND file_id=$2::uuid AND deleted_at IS NULL
      `, [payload.tenantId, fileId]);
      await executor.execute(`
        DELETE FROM file_associations
        WHERE tenant_id=$1::uuid AND file_id=$2::uuid
      `, [payload.tenantId, fileId]);
      await executor.execute(`
        UPDATE workspace_files
        SET deleted_at=COALESCE(deleted_at,now()),index_status='deleted',updated_at=now()
        WHERE tenant_id=$1::uuid AND file_id=$2::uuid AND deleted_at IS NULL
      `, [payload.tenantId, fileId]);
    }
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
  if (phase === "retrieval_snapshots") return "vision_observations";
  if (phase === "vision_observations") return "knowledge_tombstones";
  if (phase === "knowledge_tombstones") return "orphan_budget_reservations";
  if (phase === "orphan_budget_reservations") return "orphan_files";
  if (phase === "orphan_files") return "runtime_outbox";
  return null;
}
