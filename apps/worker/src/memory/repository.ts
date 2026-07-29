import {
  decideMemoryOperation,
  normalizeMemoryStableKey,
  type MemoryOperation,
  type MemoryScope,
} from "@berry/shared";
import type { MemoryExtractJobPayload } from "../jobs.js";
import type { SqlExecutor } from "../sql-repositories.js";
import type { ExtractedMemoryOperation } from "./generator.js";

export class SqlWorkerMemoryRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async settings(
    tenantId: string,
    userId: string,
  ): Promise<{ memoryEnabled: boolean; implicitMemoryEnabled: boolean }> {
    return this.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<{
        memory_enabled: boolean;
        implicit_memory_enabled: boolean;
      }>(`
        SELECT memory_enabled, implicit_memory_enabled
        FROM memory_settings
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid
      `, [tenantId, userId]);
      return {
        memoryEnabled: row?.memory_enabled ?? true,
        implicitMemoryEnabled: row?.implicit_memory_enabled ?? true,
      };
    });
  }

  async apply(
    payload: MemoryExtractJobPayload,
    operations: readonly ExtractedMemoryOperation[],
  ): Promise<{ applied: number; noops: number }> {
    return this.withTenant(payload.tenantId, async (executor) => {
      let applied = 0;
      let noops = 0;
      for (const candidate of operations) {
        const operation: MemoryOperation = {
          ...candidate,
          stableKey: normalizeMemoryStableKey(candidate.stableKey),
          explicit: false,
        };
        if (!operation.stableKey) {
          noops += 1;
          continue;
        }
        const workspaceId = candidate.scope === "project" ? payload.workspaceId : null;
        const [existing] = await executor.query<ActiveMemoryRow>(`
          SELECT id, content, explicit, confidence, salience, structured_value
          FROM memory_items
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid
            AND workspace_id IS NOT DISTINCT FROM $3::uuid
            AND stable_key = $4 AND status = 'active'
          FOR UPDATE
        `, [payload.tenantId, payload.userId, workspaceId, operation.stableKey]);
        const decision = decideMemoryOperation(existing ? {
          content: existing.content,
          explicit: existing.explicit,
        } : null, operation, candidate.scope);
        if (decision.operation === "NOOP") {
          noops += 1;
          if (existing) await this.version(executor, payload, existing.id, "NOOP", existing, existing, decision.reason);
          continue;
        }
        if (decision.operation === "REFRESH" && existing) {
          const [after] = await executor.query<ActiveMemoryRow>(`
            UPDATE memory_items
            SET confidence = GREATEST(confidence, $4),
                salience = GREATEST(salience, $5),
                last_seen_at = now(), source_task_id = $6::uuid,
                source_session_id = $7::uuid, source_message_id = $8::uuid,
                expires_at = COALESCE($9::timestamptz, expires_at),
                updated_at = now()
            WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
            RETURNING id, content, explicit, confidence, salience, structured_value
          `, [
            payload.tenantId,
            payload.userId,
            existing.id,
            operation.confidence,
            operation.salience,
            payload.taskId,
            payload.sessionId,
            payload.userMessageId,
            operation.expiresAt,
          ]);
          if (after) await this.version(executor, payload, existing.id, "REFRESH", existing, after, decision.reason);
          applied += 1;
          continue;
        }
        if (decision.operation === "SUPERSEDE" && existing) {
          await executor.execute(`
            UPDATE memory_items SET status = 'superseded', updated_at = now()
            WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
          `, [payload.tenantId, payload.userId, existing.id]);
        }
        const [created] = await executor.query<ActiveMemoryRow>(`
          INSERT INTO memory_items (
            tenant_id, user_id, workspace_id, scope, kind, stable_key, content,
            structured_value, status, explicit, confidence, salience, expires_at,
            extractor_version, source_task_id, source_session_id, source_message_id,
            superseded_item_id, last_seen_at
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, 'active',
            false, $9, $10, $11::timestamptz, $12, $13::uuid, $14::uuid,
            $15::uuid, $16::uuid, now()
          )
          RETURNING id, content, explicit, confidence, salience, structured_value
        `, [
          payload.tenantId,
          payload.userId,
          workspaceId,
          candidate.scope,
          operation.kind,
          operation.stableKey,
          operation.content.trim(),
          JSON.stringify(operation.value),
          operation.confidence,
          operation.salience,
          operation.expiresAt,
          payload.extractorVersion,
          payload.taskId,
          payload.sessionId,
          payload.userMessageId,
          existing?.id ?? null,
        ]);
        if (created) {
          await this.version(executor, payload, created.id, decision.operation, existing ?? null, created, decision.reason);
          applied += 1;
        }
      }
      return { applied, noops };
    });
  }

  private async version(
    executor: SqlExecutor,
    payload: MemoryExtractJobPayload,
    memoryItemId: string,
    operation: "ADD" | "SUPERSEDE" | "REFRESH" | "NOOP",
    before: unknown,
    after: unknown,
    reason: string,
  ): Promise<void> {
    await executor.execute(`
      INSERT INTO memory_item_versions (
        tenant_id, memory_item_id, operation, before_value, after_value,
        source_task_id, source_session_id, source_message_id,
        extractor_version, reason
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb,
        $6::uuid, $7::uuid, $8::uuid, $9, $10
      )
    `, [
      payload.tenantId,
      memoryItemId,
      operation,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      payload.taskId,
      payload.sessionId,
      payload.userMessageId,
      payload.extractorVersion,
      reason,
    ]);
  }

  private async withTenant<T>(tenantId: string, callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(executor);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }
}

type ActiveMemoryRow = {
  id: string;
  content: string;
  explicit: boolean;
  confidence: string | number;
  salience: string | number;
  structured_value: unknown;
};
