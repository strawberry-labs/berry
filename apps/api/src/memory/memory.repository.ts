import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  MemoryItemSchema,
  MemoryOperationSchema,
  decideMemoryOperation,
  type MemoryItem,
  type MemoryOperation,
  type MemoryScope,
} from "@berry/shared";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";

export type MemoryIdentity = {
  tenantId: string;
  userId: string;
  workspaceId: string | null;
  scope: MemoryScope;
};

export type MemorySource = {
  actorUserId: string | null;
  taskId: string | null;
  sessionId: string | null;
  messageId: string | null;
  extractorVersion: string;
};

export type MemoryMutationResult = {
  operation: "ADD" | "SUPERSEDE" | "REFRESH" | "NOOP";
  reason: string;
  item: MemoryItem | null;
};

export interface MemoryRepository {
  assertWorkspaceAccess(tenantId: string, userId: string, workspaceId: string): Promise<void>;
  list(input: MemoryIdentity & {
    status?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: MemoryItem[]; nextCursor: string | null }>;
  get(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem>;
  settings(tenantId: string, userId: string): Promise<{ memoryEnabled: boolean; implicitMemoryEnabled: boolean }>;
  updateSettings(tenantId: string, userId: string, input: {
    memoryEnabled?: boolean;
    implicitMemoryEnabled?: boolean;
  }): Promise<{ memoryEnabled: boolean; implicitMemoryEnabled: boolean }>;
  recall(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    query: string;
    limit: number;
  }): Promise<MemoryItem[]>;
  apply(identity: MemoryIdentity, operation: MemoryOperation, source: MemorySource): Promise<MemoryMutationResult>;
  forget(tenantId: string, userId: string, memoryId: string, source: MemorySource): Promise<MemoryItem>;
  export(tenantId: string, userId: string): Promise<{ items: MemoryItem[]; versions: unknown[] }>;
}

@Injectable()
export class SqlMemoryRepository implements MemoryRepository {
  constructor(@Inject(CloudDatabaseService) private readonly database: CloudDatabaseService) {}

  async assertWorkspaceAccess(tenantId: string, userId: string, workspaceId: string): Promise<void> {
    await this.database.withTenant(tenantId, async (executor) => {
      const [workspace] = await executor.query<{ id: string }>(`
        SELECT w.id FROM workspaces w
        WHERE w.tenant_id = $1::uuid AND w.id = $2::uuid AND w.deleted_at IS NULL
          AND (
            w.owner_id = $3::uuid OR w.owner_id IS NULL OR
            EXISTS (
              SELECT 1 FROM tasks access_task
              WHERE access_task.tenant_id = w.tenant_id
                AND access_task.workspace_id = w.id
                AND access_task.user_id = $3::uuid
                AND access_task.deleted_at IS NULL
            )
          )
      `, [tenantId, workspaceId, userId]);
      if (!workspace) throw new ForbiddenException("Workspace is not accessible");
    });
  }

  async list(input: MemoryIdentity & {
    status?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: MemoryItem[]; nextCursor: string | null }> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const values: unknown[] = [input.tenantId, input.userId, input.scope, input.workspaceId];
      const where = [
        "tenant_id = $1::uuid",
        "user_id = $2::uuid",
        "scope = $3",
        "workspace_id IS NOT DISTINCT FROM $4::uuid",
      ];
      if (input.status) {
        values.push(input.status);
        where.push(`status = $${values.length}`);
      }
      if (input.search?.trim()) {
        values.push(`%${escapeLike(input.search.trim())}%`);
        where.push(`(content ILIKE $${values.length} ESCAPE '\\' OR stable_key ILIKE $${values.length} ESCAPE '\\')`);
      }
      if (input.cursor) {
        const [updatedAt, id] = decodeCursor(input.cursor);
        values.push(updatedAt, id);
        where.push(`(updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(input.limit + 1);
      const rows = await executor.query<MemoryRow>(`
        SELECT * FROM memory_items
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id DESC
        LIMIT $${values.length}
      `, values);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map(memoryFromRow),
        nextCursor: rows.length > input.limit && last ? encodeCursor(last.updated_at, last.id) : null,
      };
    });
  }

  async get(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<MemoryRow>(`
        SELECT * FROM memory_items
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
      `, [tenantId, userId, memoryId]);
      if (!row) throw new NotFoundException("Memory item not found");
      return memoryFromRow(row);
    });
  }

  async settings(tenantId: string, userId: string): Promise<{ memoryEnabled: boolean; implicitMemoryEnabled: boolean }> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<{ memory_enabled: boolean; implicit_memory_enabled: boolean }>(`
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

  async updateSettings(tenantId: string, userId: string, input: {
    memoryEnabled?: boolean;
    implicitMemoryEnabled?: boolean;
  }): Promise<{ memoryEnabled: boolean; implicitMemoryEnabled: boolean }> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<{ memory_enabled: boolean; implicit_memory_enabled: boolean }>(`
        INSERT INTO memory_settings (
          tenant_id, user_id, memory_enabled, implicit_memory_enabled
        ) VALUES ($1::uuid, $2::uuid, COALESCE($3, true), COALESCE($4, true))
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET
          memory_enabled = COALESCE($3, memory_settings.memory_enabled),
          implicit_memory_enabled = COALESCE($4, memory_settings.implicit_memory_enabled),
          updated_at = now()
        RETURNING memory_enabled, implicit_memory_enabled
      `, [tenantId, userId, input.memoryEnabled ?? null, input.implicitMemoryEnabled ?? null]);
      return {
        memoryEnabled: row?.memory_enabled ?? true,
        implicitMemoryEnabled: row?.implicit_memory_enabled ?? true,
      };
    });
  }

  async recall(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    query: string;
    limit: number;
  }): Promise<MemoryItem[]> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<MemoryRow>(`
        SELECT mi.*
        FROM memory_items mi
        LEFT JOIN memory_settings settings
          ON settings.tenant_id = mi.tenant_id AND settings.user_id = mi.user_id
        WHERE mi.tenant_id = $1::uuid AND mi.user_id = $2::uuid
          AND COALESCE(settings.memory_enabled, true) = true
          AND mi.status = 'active'
          AND (mi.expires_at IS NULL OR mi.expires_at > now())
          AND (
            (mi.scope = 'personal' AND mi.workspace_id IS NULL) OR
            (mi.scope = 'project' AND mi.workspace_id = $3::uuid)
          )
        ORDER BY
          CASE WHEN lower(mi.stable_key) = ANY($5::text[]) THEN 1 ELSE 0 END DESC,
          CASE
            WHEN to_tsvector('simple', mi.stable_key || ' ' || mi.content)
              @@ websearch_to_tsquery('simple', $4)
            THEN ts_rank_cd(
              to_tsvector('simple', mi.stable_key || ' ' || mi.content),
              websearch_to_tsquery('simple', $4)
            )
            ELSE 0
          END DESC,
          mi.explicit DESC, mi.salience DESC, mi.confidence DESC,
          mi.last_seen_at DESC NULLS LAST, mi.updated_at DESC, mi.id
        LIMIT $6
      `, [
        input.tenantId,
        input.userId,
        input.workspaceId,
        input.query.slice(0, 4_000),
        stableKeyTerms(input.query),
        input.limit,
      ]);
      if (rows.length > 0) {
        await executor.execute(`
          UPDATE memory_items SET last_used_at = now(), updated_at = updated_at
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = ANY($3::uuid[])
        `, [input.tenantId, input.userId, rows.map((row) => row.id)]);
      }
      return rows.map(memoryFromRow);
    });
  }

  async apply(identity: MemoryIdentity, rawOperation: MemoryOperation, source: MemorySource): Promise<MemoryMutationResult> {
    const operation = MemoryOperationSchema.parse(rawOperation);
    return this.database.withTenant(identity.tenantId, async (executor) => {
      const [existingRow] = await executor.query<MemoryRow>(`
        SELECT * FROM memory_items
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid
          AND workspace_id IS NOT DISTINCT FROM $3::uuid
          AND stable_key = $4 AND status = 'active'
        FOR UPDATE
      `, [identity.tenantId, identity.userId, identity.workspaceId, operation.stableKey]);
      const existing = existingRow ? memoryFromRow(existingRow) : null;
      const decision = decideMemoryOperation(existing, operation, identity.scope);
      if (decision.operation === "NOOP") {
        if (existingRow) {
          await insertVersion(executor, identity.tenantId, existingRow.id, "NOOP", existingRow, existingRow, source, decision.reason);
        }
        return { operation: "NOOP", reason: decision.reason, item: existing };
      }
      if (decision.operation === "REFRESH" && existingRow) {
        const [row] = await executor.query<MemoryRow>(`
          UPDATE memory_items
          SET confidence = GREATEST(confidence, $4),
              salience = GREATEST(salience, $5),
              last_seen_at = now(),
              expires_at = COALESCE($6::timestamptz, expires_at),
              source_task_id = COALESCE($7::uuid, source_task_id),
              source_session_id = COALESCE($8::uuid, source_session_id),
              source_message_id = COALESCE($9::uuid, source_message_id),
              updated_at = now()
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
          RETURNING *
        `, [
          identity.tenantId,
          identity.userId,
          existingRow.id,
          operation.confidence,
          operation.salience,
          operation.expiresAt,
          source.taskId,
          source.sessionId,
          source.messageId,
        ]);
        if (!row) throw new Error("Memory refresh lost its target row");
        await insertVersion(executor, identity.tenantId, row.id, "REFRESH", existingRow, row, source, decision.reason);
        return { operation: "REFRESH", reason: decision.reason, item: memoryFromRow(row) };
      }
      if (decision.operation === "SUPERSEDE" && existingRow) {
        await executor.execute(`
          UPDATE memory_items
          SET status = 'superseded', updated_at = now()
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
        `, [identity.tenantId, identity.userId, existingRow.id]);
      }
      const [created] = await executor.query<MemoryRow>(`
        INSERT INTO memory_items (
          tenant_id, user_id, workspace_id, scope, kind, stable_key, content,
          structured_value, status, explicit, confidence, salience, expires_at,
          extractor_version, source_task_id, source_session_id, source_message_id,
          superseded_item_id, last_seen_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, 'active',
          $9, $10, $11, $12::timestamptz, $13, $14::uuid, $15::uuid, $16::uuid,
          $17::uuid, now()
        )
        RETURNING *
      `, [
        identity.tenantId,
        identity.userId,
        identity.workspaceId,
        identity.scope,
        operation.kind,
        operation.stableKey,
        operation.content.trim(),
        JSON.stringify(operation.value),
        operation.explicit,
        operation.confidence,
        operation.salience,
        operation.expiresAt,
        source.extractorVersion,
        source.taskId,
        source.sessionId,
        source.messageId,
        existingRow?.id ?? null,
      ]);
      if (!created) throw new Error("Memory insert returned no row");
      await insertVersion(
        executor,
        identity.tenantId,
        created.id,
        decision.operation,
        existingRow ?? null,
        created,
        source,
        decision.reason,
      );
      return { operation: decision.operation, reason: decision.reason, item: memoryFromRow(created) };
    });
  }

  async forget(tenantId: string, userId: string, memoryId: string, source: MemorySource): Promise<MemoryItem> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [before] = await executor.query<MemoryRow>(`
        SELECT * FROM memory_items
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
        FOR UPDATE
      `, [tenantId, userId, memoryId]);
      if (!before) throw new NotFoundException("Memory item not found");
      const [after] = await executor.query<MemoryRow>(`
        UPDATE memory_items
        SET status = 'forgotten', updated_at = now()
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid
        RETURNING *
      `, [tenantId, userId, memoryId]);
      if (!after) throw new NotFoundException("Memory item not found");
      await insertVersion(executor, tenantId, memoryId, "FORGET", before, after, source, "explicit_forget");
      return memoryFromRow(after);
    });
  }

  async export(tenantId: string, userId: string): Promise<{ items: MemoryItem[]; versions: unknown[] }> {
    return this.database.withTenant(tenantId, async (executor) => {
      const items = await executor.query<MemoryRow>(`
        SELECT * FROM memory_items
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid
        ORDER BY created_at ASC, id ASC
      `, [tenantId, userId]);
      const versions = await executor.query<Record<string, unknown>>(`
        SELECT version.*
        FROM memory_item_versions version
        JOIN memory_items item ON item.id = version.memory_item_id
        WHERE version.tenant_id = $1::uuid AND item.user_id = $2::uuid
        ORDER BY version.created_at ASC, version.id ASC
      `, [tenantId, userId]);
      return { items: items.map(memoryFromRow), versions: [...versions] };
    });
  }
}

type MemoryRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string | null;
  scope: MemoryScope;
  kind: string;
  stable_key: string;
  content: string;
  structured_value: unknown;
  status: MemoryItem["status"];
  explicit: boolean;
  confidence: string | number;
  salience: string | number;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  expires_at: Date | string | null;
  extractor_version: string;
  source_task_id: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
  superseded_item_id: string | null;
  last_seen_at: Date | string | null;
  last_used_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function memoryFromRow(row: MemoryRow): MemoryItem {
  return MemoryItemSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    kind: row.kind,
    stableKey: row.stable_key,
    content: row.content,
    value: asRecord(row.structured_value),
    status: row.status,
    explicit: row.explicit,
    confidence: Number(row.confidence),
    salience: Number(row.salience),
    validFrom: isoOrNull(row.valid_from),
    validUntil: isoOrNull(row.valid_until),
    expiresAt: isoOrNull(row.expires_at),
    extractorVersion: row.extractor_version,
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    supersededItemId: row.superseded_item_id,
    lastSeenAt: isoOrNull(row.last_seen_at),
    lastUsedAt: isoOrNull(row.last_used_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

async function insertVersion(
  executor: SqlExecutor,
  tenantId: string,
  memoryItemId: string,
  operation: "ADD" | "SUPERSEDE" | "REFRESH" | "NOOP" | "FORGET",
  before: unknown,
  after: unknown,
  source: MemorySource,
  reason: string,
): Promise<void> {
  await executor.execute(`
    INSERT INTO memory_item_versions (
      tenant_id, memory_item_id, operation, before_value, after_value,
      actor_user_id, source_task_id, source_session_id, source_message_id,
      extractor_version, reason
    ) VALUES (
      $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb,
      $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10, $11
    )
  `, [
    tenantId,
    memoryItemId,
    operation,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    source.actorUserId,
    source.taskId,
    source.sessionId,
    source.messageId,
    source.extractorVersion,
    reason,
  ]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function stableKeyTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/[^a-z0-9._:-]+/).filter((term) => term.length >= 3))].slice(0, 24);
}

function encodeCursor(updatedAt: Date | string, id: string): string {
  return Buffer.from(`${iso(updatedAt)}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(value: string): [string, string] {
  const [updatedAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt))) throw new Error("Invalid memory cursor");
  return [updatedAt, id];
}
