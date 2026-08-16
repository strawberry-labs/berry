import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  QueuedFollowUpCreateSchema,
  QueuedFollowUpPageSchema,
  QueuedFollowUpUpdateSchema,
  ServerQueuedFollowUpSchema,
  type AttachmentInput,
  type JsonValue,
  type QueuedFollowUpCreate,
  type QueuedFollowUpPage,
  type QueuedFollowUpUpdate,
  type ServerQueuedFollowUp,
} from "@berry/shared";
import { randomUUID } from "node:crypto";
import { CloudDatabaseService, type SqlExecutor } from "./../db/cloud-database.service.js";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_QUEUE_ITEMS = 100;
const ACTIVE_QUEUE_STATUSES = ["queued", "delivering", "paused", "failed"] as const;

type QueueRow = {
  id: string;
  workspace_id: string;
  task_id: string;
  session_id: string;
  creator_user_id: string;
  owner_user_id: string;
  ordinal: number;
  input: string;
  intent: "image_generation" | null;
  attachments: unknown;
  status: ServerQueuedFollowUp["status"];
  idempotency_key: string;
  delivery_key: string | null;
  attempt_count: number;
  last_error: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  delivered_at: Date | string | null;
};

@Injectable()
export class QueuedFollowUpService {
  constructor(private readonly database: CloudDatabaseService) {}

  async enqueue(tenantId: string, userId: string, sessionId: string, value: QueuedFollowUpCreate): Promise<ServerQueuedFollowUp> {
    const input = QueuedFollowUpCreateSchema.parse(value);
    const attachments = durableAttachments(input.attachments);
    return this.database.withTenant(tenantId, async (executor) => {
      const existing = await executor.query<QueueRow>(
        `SELECT id,workspace_id,task_id,session_id,creator_user_id,owner_user_id,ordinal,input,intent,
                attachments,status,idempotency_key,delivery_key,attempt_count,last_error,expires_at,
                created_at,updated_at,delivered_at
         FROM queued_follow_up_items
         WHERE tenant_id=$1::uuid AND idempotency_key=$2
         LIMIT 1`,
        [tenantId, input.idempotencyKey],
      );
      if (existing[0]) {
        if (existing[0].owner_user_id !== userId) throw new ConflictException("The idempotency key belongs to another user");
        return mapQueueRow(existing[0]);
      }

      const active = await executor.query<{
        workspace_id: string;
        task_id: string;
        session_id: string;
        owner_user_id: string;
        runtime_request: JsonValue;
        grounding_context: JsonValue;
        prompt_manifest: JsonValue;
      }>(
        `SELECT t.workspace_id,t.id AS task_id,s.id AS session_id,t.user_id AS owner_user_id,
                r.runtime_request,r.grounding_context,r.prompt_manifest
         FROM tasks t
         JOIN sessions s ON s.tenant_id=t.tenant_id AND s.task_id=t.id AND s.id=$3::uuid
         JOIN turn_runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
         WHERE t.tenant_id=$1::uuid AND t.id=$2::uuid AND t.user_id=$4::uuid
           AND t.workspace_id=$5::uuid AND t.deleted_at IS NULL AND s.deleted_at IS NULL
           AND r.state NOT IN ('completed','failed','cancelled','recovery_required')
         ORDER BY r.created_at DESC
         LIMIT 1
         FOR UPDATE OF t,s,r`,
        [tenantId, input.taskId, sessionId, userId, input.workspaceId],
      );
      const run = active[0];
      if (!run) throw new ConflictException("Follow-ups can only be queued for an active task turn");

      const countRows = await executor.query<{ count: number | string }>(
        `SELECT count(*)::integer AS count FROM queued_follow_up_items
         WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND status = ANY($3::text[])
           AND expires_at > now()`,
        [tenantId, run.session_id, [...ACTIVE_QUEUE_STATUSES]],
      );
      if (Number(countRows[0]?.count ?? 0) >= MAX_QUEUE_ITEMS) {
        throw new ConflictException("This task already has the maximum number of queued follow-ups");
      }
      const ordinalRows = await executor.query<{ ordinal: number | string }>(
        `SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal
         FROM queued_follow_up_items
         WHERE tenant_id=$1::uuid AND session_id=$2::uuid`,
        [tenantId, run.session_id],
      );
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000).toISOString();
      const inserted = await executor.query<QueueRow>(
        `INSERT INTO queued_follow_up_items (
           id,tenant_id,workspace_id,task_id,session_id,creator_user_id,owner_user_id,ordinal,input,intent,
           attachments,runtime_request,grounding_context,prompt_manifest,idempotency_key,expires_at
         ) VALUES (
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$6::uuid,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::timestamptz
         )
         RETURNING id,workspace_id,task_id,session_id,creator_user_id,owner_user_id,ordinal,input,intent,
                   attachments,status,idempotency_key,delivery_key,attempt_count,last_error,expires_at,
                   created_at,updated_at,delivered_at`,
        [
          id,
          tenantId,
          run.workspace_id,
          run.task_id,
          run.session_id,
          userId,
          Number(ordinalRows[0]?.ordinal ?? 0),
          input.input,
          input.intent ?? null,
          JSON.stringify(attachments),
          JSON.stringify(run.runtime_request ?? {}),
          JSON.stringify(run.grounding_context ?? {}),
          JSON.stringify(run.prompt_manifest ?? {}),
          input.idempotencyKey,
          expiresAt,
        ],
      );
      if (!inserted[0]) throw new Error("Unable to persist queued follow-up");
      return mapQueueRow(inserted[0]);
    });
  }

  async list(tenantId: string, userId: string, sessionId: string, cursor?: string, limit = 100): Promise<QueuedFollowUpPage> {
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.database.withTenant(tenantId, async (executor) => {
      await expireQueueItems(executor, tenantId);
      const parsedCursor = parseCursor(cursor);
      const rows = await executor.query<QueueRow>(
        `SELECT q.id,q.workspace_id,q.task_id,q.session_id,q.creator_user_id,q.owner_user_id,q.ordinal,q.input,q.intent,
                q.attachments,q.status,q.idempotency_key,q.delivery_key,q.attempt_count,q.last_error,q.expires_at,
                q.created_at,q.updated_at,q.delivered_at
         FROM queued_follow_up_items q
         JOIN tasks t ON t.tenant_id=q.tenant_id AND t.id=q.task_id
         WHERE q.tenant_id=$1::uuid AND q.session_id=$2::uuid AND t.user_id=$3::uuid
           AND q.status = ANY($4::text[]) AND q.expires_at>now()
           AND ($5::integer IS NULL OR q.ordinal>$5::integer)
         ORDER BY q.ordinal ASC,q.id ASC
         LIMIT $6`,
        [tenantId, sessionId, userId, [...ACTIVE_QUEUE_STATUSES], parsedCursor?.ordinal ?? null, boundedLimit + 1],
      );
      const hasMore = rows.length > boundedLimit;
      const items = rows.slice(0, boundedLimit).map(mapQueueRow);
      return QueuedFollowUpPageSchema.parse({
        items,
        hasMore,
        nextCursor: hasMore && items.length > 0 ? encodeCursor(items.at(-1)!.ordinal, items.at(-1)!.id) : null,
      });
    });
  }

  async scope(tenantId: string, userId: string, id: string): Promise<{ taskId: string; sessionId: string }> {
    return this.database.withTenant(tenantId, async (executor) => {
      const row = await loadOwnedQueueRow(executor, tenantId, userId, id, false);
      if (!row) throw new NotFoundException("Queued follow-up not found");
      return { taskId: row.task_id, sessionId: row.session_id };
    });
  }

  async update(tenantId: string, userId: string, id: string, value: QueuedFollowUpUpdate): Promise<ServerQueuedFollowUp> {
    const input = QueuedFollowUpUpdateSchema.parse(value);
    return this.database.withTenant(tenantId, async (executor) => {
      await expireQueueItems(executor, tenantId);
      const current = await loadOwnedQueueRow(executor, tenantId, userId, id, true);
      if (!current) throw new NotFoundException("Queued follow-up not found");
      if (["delivered", "cancelled", "expired"].includes(current.status)) {
        throw new ConflictException("This queued follow-up is no longer editable");
      }
      if (input.orderedIds) {
        await reorder(executor, tenantId, userId, current.session_id, input.orderedIds);
      }
      const attachments = input.attachments ? durableAttachments(input.attachments) : undefined;
      await executor.execute(
        `UPDATE queued_follow_up_items
         SET input=COALESCE($4,input), intent=CASE WHEN $5::boolean THEN $6 ELSE intent END,
             attachments=COALESCE($7::jsonb,attachments),
             status=COALESCE($8,status), last_error=CASE WHEN $8 IN ('queued','paused') THEN NULL ELSE last_error END,
             cancelled_at=CASE WHEN $8='cancelled' THEN now() ELSE cancelled_at END, updated_at=now()
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND owner_user_id=$3::uuid`,
        [tenantId, id, userId, input.input ?? null, input.intent !== undefined, input.intent ?? null, attachments ? JSON.stringify(attachments) : null, input.status ?? null],
      );
      const updated = await loadOwnedQueueRow(executor, tenantId, userId, id, false);
      if (!updated) throw new NotFoundException("Queued follow-up not found");
      return mapQueueRow(updated);
    });
  }

  async cancel(tenantId: string, userId: string, id: string): Promise<ServerQueuedFollowUp> {
    return this.update(tenantId, userId, id, { status: "cancelled" });
  }
}

function durableAttachments(attachments: readonly AttachmentInput[]): AttachmentInput[] {
  return attachments.map((attachment) => {
    if (!attachment.fileId) throw new ConflictException("Upload attachments before queueing a follow-up");
    return {
      ...(attachment.id ? { id: attachment.id } : {}),
      fileId: attachment.fileId,
      name: attachment.name,
      mediaType: attachment.mediaType,
      ...(attachment.declaredMediaType !== undefined ? { declaredMediaType: attachment.declaredMediaType } : {}),
      ...(attachment.detectedMediaType !== undefined ? { detectedMediaType: attachment.detectedMediaType } : {}),
      size: attachment.size,
      ...(attachment.sourceKind !== undefined ? { sourceKind: attachment.sourceKind } : {}),
    };
  });
}

function mapQueueRow(row: QueueRow): ServerQueuedFollowUp {
  return ServerQueuedFollowUpSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    creatorUserId: row.creator_user_id,
    ownerUserId: row.owner_user_id,
    ordinal: Number(row.ordinal),
    input: row.input,
    ...(row.intent ? { intent: row.intent } : {}),
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    status: row.status,
    idempotencyKey: row.idempotency_key,
    deliveryKey: row.delivery_key,
    attemptCount: Number(row.attempt_count),
    error: row.last_error,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deliveredAt: row.delivered_at ? iso(row.delivered_at) : null,
  });
}

async function loadOwnedQueueRow(executor: SqlExecutor, tenantId: string, userId: string, id: string, lock: boolean): Promise<QueueRow | null> {
  const rows = await executor.query<QueueRow>(
    `SELECT q.id,q.workspace_id,q.task_id,q.session_id,q.creator_user_id,q.owner_user_id,q.ordinal,q.input,q.intent,
            q.attachments,q.status,q.idempotency_key,q.delivery_key,q.attempt_count,q.last_error,q.expires_at,
            q.created_at,q.updated_at,q.delivered_at
     FROM queued_follow_up_items q
     JOIN tasks t ON t.tenant_id=q.tenant_id AND t.id=q.task_id
     WHERE q.tenant_id=$1::uuid AND q.id=$2::uuid AND q.owner_user_id=$3::uuid AND t.user_id=$3::uuid
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id, userId],
  );
  return rows[0] ?? null;
}

async function reorder(executor: SqlExecutor, tenantId: string, userId: string, sessionId: string, orderedIds: readonly string[]): Promise<void> {
  const rows = await executor.query<{ id: string }>(
    `SELECT q.id FROM queued_follow_up_items q JOIN tasks t ON t.tenant_id=q.tenant_id AND t.id=q.task_id
     WHERE q.tenant_id=$1::uuid AND q.session_id=$2::uuid AND q.owner_user_id=$3::uuid
       AND q.status = ANY($4::text[]) AND q.expires_at>now() ORDER BY q.ordinal ASC FOR UPDATE`,
    [tenantId, sessionId, userId, [...ACTIVE_QUEUE_STATUSES]],
  );
  const actual = rows.map((row) => row.id);
  if (actual.length !== orderedIds.length || new Set(actual).size !== new Set(orderedIds).size || orderedIds.some((id) => !actual.includes(id))) {
    throw new ConflictException("The queued follow-up order is stale; refresh and try again");
  }
  const baseRows = await executor.query<{ ordinal: number | string }>(
    `SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal
     FROM queued_follow_up_items
     WHERE tenant_id=$1::uuid AND session_id=$2::uuid`,
    [tenantId, sessionId],
  );
  const temporaryBase = Number(baseRows[0]?.ordinal ?? 0) + 1_000_000;
  await executor.execute(
    `UPDATE queued_follow_up_items SET ordinal=ordinal+$5,updated_at=now()
     WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND owner_user_id=$3::uuid AND status = ANY($4::text[])`,
    [tenantId, sessionId, userId, [...ACTIVE_QUEUE_STATUSES], temporaryBase],
  );
  const base = temporaryBase + orderedIds.length + 1;
  for (const [ordinal, id] of orderedIds.entries()) {
    await executor.execute(
      `UPDATE queued_follow_up_items SET ordinal=$4,updated_at=now()
       WHERE tenant_id=$1::uuid AND id=$2::uuid AND owner_user_id=$3::uuid`,
      [tenantId, id, userId, base + ordinal],
    );
  }
}

async function expireQueueItems(executor: SqlExecutor, tenantId: string): Promise<void> {
  await executor.execute(
    `UPDATE queued_follow_up_items SET status='expired',last_error='This queued follow-up expired',updated_at=now()
     WHERE tenant_id=$1::uuid AND status IN ('queued','delivering','paused','failed') AND expires_at<=now()`,
    [tenantId],
  );
  await executor.execute(
    `UPDATE queued_follow_up_items q
     SET status='cancelled',last_error='Task access was removed',cancelled_at=now(),updated_at=now()
     FROM tasks t
     WHERE q.tenant_id=$1::uuid AND t.tenant_id=q.tenant_id AND t.id=q.task_id
       AND q.status IN ('queued','delivering','paused','failed')
       AND (t.deleted_at IS NOT NULL OR t.user_id IS DISTINCT FROM q.owner_user_id)`,
    [tenantId],
  );
}

function encodeCursor(ordinal: number, id: string): string {
  return Buffer.from(JSON.stringify({ ordinal, id }), "utf8").toString("base64url");
}

function parseCursor(value: string | undefined): { ordinal: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { ordinal?: unknown; id?: unknown };
    return typeof parsed.ordinal === "number" && Number.isInteger(parsed.ordinal) && typeof parsed.id === "string" ? { ordinal: parsed.ordinal, id: parsed.id } : null;
  } catch {
    return null;
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
