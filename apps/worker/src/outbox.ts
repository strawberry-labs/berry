import {
  BerryWorkerJobNameSchema,
  SandboxSnapshotJobPayloadSchema,
  parseWorkerJob,
  type BerryWorkerJobMap,
  type BerryWorkerJobName,
} from "./jobs.js";
import { ZodError } from "zod";
import type { BerryQueueClient } from "./bullmq.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { workerRuntimeMetrics } from "./runtime-metrics.js";
import {
  emitWorkerOperationalEvent,
  persistWorkerOperationalEvent,
} from "./operational-telemetry.js";
import { normalizeWorkerRole, type OperationalWorkerRole } from "@berry/shared";

type OutboxRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_id?: string;
  payload: unknown;
  attempts: number | string;
  created_at?: Date | string;
  available_at?: Date | string;
  first_available_at?: Date | string;
  claimed_at?: Date | string | null;
  delivered_at?: Date | string | null;
  receipt_at?: Date | string | null;
  lease_epoch?: number | string;
  priority_class?: string;
  max_attempts?: number | string;
  worker_role?: string;
  source_revision?: string;
};

type OutboxLifecycleRow = Pick<OutboxRow, "id" | "attempts" | "first_available_at" | "claimed_at" | "delivered_at" | "receipt_at" | "lease_epoch" | "priority_class">;

export class RuntimeOutboxDispatcher {
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #nextTerminalCleanupAt = 0;

  constructor(
    private readonly executor: SqlExecutor,
    private readonly queue: BerryQueueClient,
    private readonly options: {
      tenantId?: string;
      workerId: string;
      pollMs?: number;
      batchSize?: number;
      terminalCleanupIntervalMs?: number;
      terminalCleanupBatchSize?: number;
      deliveryReceiptRetryMs?: number;
      maxAttempts?: number;
      enableWaitExpiry?: boolean;
      enableTerminalFinalization?: boolean;
      workerRole?: OperationalWorkerRole;
      sourceRevision?: string;
    },
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#dispatchSafely();
    this.#timer = setInterval(() => this.#dispatchSafely(), this.options.pollMs ?? 1_000);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    while (this.#running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async dispatchDue(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const rows: OutboxRow[] = [];
      const tenantIds = await this.tenantIds();
      const runTerminalCleanup = this.terminalCleanupDue();
      for (const tenantId of tenantIds) {
        await this.withTenant(tenantId, (executor) => this.recoverExpiredAdmissions(executor, tenantId));
        if (this.options.enableWaitExpiry) {
          await this.withTenant(tenantId, (executor) => this.superviseWaits(executor, tenantId));
        }
        if (this.options.enableTerminalFinalization) {
          await this.withTenant(tenantId, (executor) => this.enqueuePendingFinalizations(executor, tenantId));
        }
        await this.withTenant(tenantId, (executor) => executor.execute(`
        INSERT INTO runtime_outbox (
          tenant_id,event_type,aggregate_id,dedupe_key,payload,available_at
        )
        SELECT r.tenant_id,'turn.execute',r.id::text,
               r.id::text || ':recovery:' || r.version::text,
               jsonb_build_object(
                 'tenantId',r.tenant_id::text,
                 'runId',r.id::text,
                 'reason','lease-recovery'
               ),
               now()
        FROM turn_runs r
        WHERE r.tenant_id=$1::uuid
          AND r.state NOT IN ('completed','failed','cancelled','recovery_required','waiting')
          AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= now())
          AND r.updated_at <= now() - interval '5 seconds'
          AND NOT EXISTS (
            SELECT 1 FROM runtime_outbox pending
            WHERE pending.tenant_id=r.tenant_id
              AND pending.aggregate_id=r.id::text
              AND pending.event_type IN ('turn.execute','turn.resume')
              AND pending.completed_at IS NULL
          )
        ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
      `, [tenantId]));
        if (runTerminalCleanup) await this.withTenant(tenantId, (executor) => executor.execute(`
        WITH candidates AS (
          SELECT r.tenant_id,r.id,r.version
          FROM turn_runs r
          WHERE r.tenant_id=$1::uuid
            AND r.state IN ('completed','failed','cancelled','recovery_required')
            AND r.sandbox_id IS NOT NULL
            AND COALESCE(r.sandbox_state,'running') NOT IN ('paused','missing','stopped','destroyed','pause_requested')
            AND NOT EXISTS (
              SELECT 1 FROM runtime_outbox pending
              WHERE pending.tenant_id=r.tenant_id
                AND pending.aggregate_id=r.id::text
                AND pending.event_type='sandbox.snapshot'
                AND COALESCE(pending.payload->>'reason','interval')='before-finalize'
                AND pending.completed_at IS NULL
            )
          ORDER BY r.updated_at ASC
          LIMIT $2
        )
        INSERT INTO runtime_outbox (
          tenant_id,event_type,aggregate_id,dedupe_key,payload,available_at
        )
        SELECT candidates.tenant_id,'sandbox.snapshot',candidates.id::text,
               candidates.id::text || ':snapshot:terminal-cleanup:' || candidates.version::text,
               jsonb_build_object(
                 'tenantId',candidates.tenant_id::text,
                 'runId',candidates.id::text,
                 'reason','before-finalize'
               ),
               now()
        FROM candidates
        ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
      `, [tenantId, this.options.terminalCleanupBatchSize ?? 25]));
        const remaining = (this.options.batchSize ?? 50) - rows.length;
        if (remaining <= 0) break;
        const fairShare = tenantIds.length > 1
          ? Math.max(1, Math.ceil((this.options.batchSize ?? 50) / tenantIds.length))
          : remaining;
        const claimLimit = Math.min(remaining, fairShare);
        const claimed = await this.withTenant(tenantId, async (executor) => executor.query<OutboxRow>(`
        WITH due AS (
          SELECT id
          FROM runtime_outbox
          WHERE tenant_id = $1::uuid
            AND completed_at IS NULL
            AND dead_lettered_at IS NULL
            AND COALESCE(receipt_due_at, available_at) <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY CASE priority_class
                     WHEN 'interactive' THEN 0
                     WHEN 'post_turn' THEN 1
                     WHEN 'normal' THEN 2
                     WHEN 'cleanup' THEN 3
                     ELSE 4
                   END,
                   COALESCE(receipt_due_at, available_at) ASC,
                   first_available_at ASC,
                   created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $5
        )
        UPDATE runtime_outbox outbox
        SET lease_owner = $2, worker_role = $3, source_revision = $4,
            lease_expires_at = now() + interval '30 seconds',
            lease_epoch = outbox.lease_epoch + 1,
            claimed_at = COALESCE(outbox.claimed_at, now()),
            receipt_due_at = NULL,
            attempts = outbox.attempts + 1, updated_at = now()
        FROM due
        WHERE outbox.id = due.id
        RETURNING outbox.id, outbox.tenant_id, outbox.event_type,
            outbox.payload, outbox.attempts, outbox.created_at, outbox.available_at,
                  outbox.first_available_at, outbox.claimed_at, outbox.delivered_at,
                  outbox.receipt_at, outbox.lease_epoch, outbox.priority_class,
                  outbox.max_attempts, outbox.worker_role, outbox.source_revision
      `, [
        tenantId,
        this.options.workerId,
        this.options.workerRole ?? "unknown",
        this.options.sourceRevision ?? "unknown",
        claimLimit,
      ]));
        rows.push(...claimed);
      }
      let dispatched = 0;
      for (const row of rows) {
        const parsedName = BerryWorkerJobNameSchema.safeParse(row.event_type);
        if (!parsedName.success) {
          await this.fail(row, `Unsupported outbox event type: ${row.event_type}`, true, "unsupported_event");
          continue;
        }
        try {
          const name = parsedName.data;
          await this.prepare(row, name);
          const payload = parseWorkerJob(name, {
            ...(isRecord(row.payload) ? row.payload : {}),
            ...(requiresDeliveryReceipt(name)
              ? {
                  outboxId: row.id,
                  ...(row.lease_epoch === undefined ? {} : { leaseEpoch: Number(row.lease_epoch) }),
                }
              : {}),
          });
          await this.queue.enqueue(
            name,
            payload as BerryWorkerJobMap[typeof name],
            {
              jobId: outboxJobId(name, row.id, Number(row.attempts) || 1),
              priority: outboxJobPriority(name),
            },
          );
          const deliveredAt = new Date();
          await this.withTenant(row.tenant_id, (executor) => persistWorkerOperationalEvent(executor, {
            tenantId: row.tenant_id,
            runId: row.event_type.startsWith("turn.") ? row.aggregate_id ?? null : null,
            eventType: "outbox.transition",
            dedupeKey: `${row.id}:dispatch:${leaseEpoch(row)}`,
            claimEpoch: leaseEpoch(row),
            workerRole: normalizeWorkerRole(row.worker_role ?? this.options.workerRole ?? "unknown"),
            sourceRevision: row.source_revision ?? this.options.sourceRevision ?? "unknown",
            fields: outboxTransitionFields(row, deliveredAt),
          })).catch(() => undefined);
          if (requiresDeliveryReceipt(name)) await this.deferForDeliveryReceipt(row);
          else await this.complete(row);
          logOutboxDispatch(
            row,
            name,
            normalizeWorkerRole(row.worker_role ?? this.options.workerRole ?? "unknown"),
            row.source_revision ?? this.options.sourceRevision ?? "unknown",
            deliveredAt,
          );
          dispatched += 1;
        } catch (error) {
          const malformed = error instanceof ZodError;
          await this.fail(
            row,
            error instanceof Error ? error.message : String(error),
            malformed,
            malformed ? "malformed_payload" : "dispatch_error",
          );
        }
      }
      return dispatched;
    } finally {
      this.#running = false;
    }
  }

  private async prepare(row: OutboxRow, name: BerryWorkerJobName): Promise<void> {
    const snapshot = name === "sandbox.snapshot"
      ? SandboxSnapshotJobPayloadSchema.safeParse(row.payload)
      : null;
    if (!snapshot?.success || snapshot.data.reason !== "before-finalize") return;
    await this.withTenant(row.tenant_id, async (executor) => {
      await executor.execute(`
        UPDATE turn_runs
        SET sandbox_state='pause_requested',sandbox_heartbeat_at=now(),updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid
          AND state IN ('completed','failed','cancelled','recovery_required')
          AND sandbox_id IS NOT NULL
          AND COALESCE(sandbox_state,'running') NOT IN ('paused','missing','stopped','destroyed','pause_requested')
      `, [row.tenant_id, snapshot.data.runId]);
      await executor.execute(`
        UPDATE runtime_outbox
        SET completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
            last_error='Superseded by terminal sandbox cleanup',updated_at=now()
        WHERE tenant_id=$1::uuid AND aggregate_id=$2
          AND event_type='sandbox.snapshot' AND id<>$3::uuid
          AND completed_at IS NULL
          AND COALESCE(payload->>'reason','interval')<>'before-finalize'
      `, [row.tenant_id, snapshot.data.runId, row.id]);
    });
  }

  private async recoverExpiredAdmissions(executor: SqlExecutor, tenantId: string): Promise<void> {
    const expired = await executor.query<{ request_id: string; session_id: string }>(
      `
WITH candidates AS (
  SELECT tenant_id,request_id,session_id
  FROM turn_admission_intents
  WHERE tenant_id=$1::uuid
    AND state='preparing'
    AND preparation_lease_expires_at IS NOT NULL
    AND preparation_lease_expires_at <= now()
  ORDER BY preparation_lease_expires_at ASC,created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 100
), transitioned AS (
  UPDATE turn_admission_intents i
  SET state='expired',
      preparation_lease_expires_at=NULL,
      preparation_ms=COALESCE(
        preparation_ms,
        GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-COALESCE(preparation_started_at,created_at)))*1000)::integer)
      ),
      terminal_reason_code='preparation_lease_expired',
      terminal_at=COALESCE(terminal_at,now()),
      updated_at=now()
  FROM candidates c
  WHERE i.tenant_id=c.tenant_id AND i.request_id=c.request_id
    AND i.state='preparing'
  RETURNING i.request_id,i.session_id
)
SELECT request_id,session_id FROM transitioned
      `.trim(),
      [tenantId],
    );
    if (expired.length === 0) return;
    await executor.execute(
      `
UPDATE tasks t
SET status='queued',updated_at=now()
FROM sessions s
JOIN turn_admission_intents i
  ON i.tenant_id=s.tenant_id AND i.session_id=s.id AND i.state='expired'
WHERE s.tenant_id=$1::uuid
  AND t.tenant_id=s.tenant_id AND t.id=s.task_id
  AND i.request_id = ANY($2::text[])
  AND i.preparation_lease_expires_at IS NULL
  AND i.terminal_reason_code='preparation_lease_expired'
  AND t.status IN ('queued','running')
  AND NOT EXISTS (
    SELECT 1 FROM turn_runs r
    WHERE r.tenant_id=t.tenant_id AND r.session_id=s.id
      AND r.state NOT IN ('completed','failed','cancelled','recovery_required')
  )
      `.trim(),
      [tenantId, expired.map((item) => item.request_id)],
    );
    for (const item of expired) {
      const reservations = await executor.query<{
        id: string;
        user_id: string | null;
        department_id: string | null;
        reserved_micros: string;
      }>(
        `
UPDATE budget_reservations
SET actual_cost_micros=0,status='reconciled',
    block_reason='admission_preparation_lease_expired',updated_at=now()
WHERE tenant_id=$1::uuid AND request_id=$2 AND status='reserved'
RETURNING id,user_id,department_id,reserved_micros::text
        `.trim(),
        [tenantId, item.request_id],
      );
      const reservation = reservations[0];
      if (!reservation) continue;
      const scopes = [
        { type: "org", id: tenantId },
        ...(reservation.department_id ? [{ type: "department", id: reservation.department_id }] : []),
        ...(reservation.user_id ? [{ type: "user", id: reservation.user_id }] : []),
      ];
      for (const scope of scopes) {
        const prior = await executor.query<{ total: string }>(
          `
SELECT COALESCE(SUM(amount_micros),0)::text AS total
FROM credit_ledger_entries
WHERE tenant_id=$1::uuid AND scope_type=$2 AND scope_id=$3
          `.trim(),
          [tenantId, scope.type, scope.id],
        );
        const adjustment = -safeBigInt(reservation.reserved_micros);
        const balanceAfter = safeBigInt(prior[0]?.total) + adjustment;
        await executor.execute(
          `
INSERT INTO credit_ledger_entries (
  tenant_id,scope_type,scope_id,reservation_id,request_id,kind,
  amount_micros,balance_after_micros,metadata
) VALUES ($1::uuid,$2,$3,$4::uuid,$5,'reconcile',$6,$7,$8::jsonb)
ON CONFLICT (tenant_id,request_id,scope_type,scope_id,kind) DO NOTHING
          `.trim(),
          [
            tenantId,
            scope.type,
            scope.id,
            reservation.id,
            item.request_id,
            adjustment.toString(),
            balanceAfter.toString(),
            JSON.stringify({ reason: "admission_preparation_lease_expired", sessionId: item.session_id }),
          ],
        );
      }
    }
  }

  private async superviseWaits(executor: SqlExecutor, tenantId: string): Promise<void> {
    const questionReminders = await executor.query<{ id: string; run_id: string; session_id: string; reminder_count: number | string }>(
      `
UPDATE turn_questions
SET reminder_count=reminder_count+1,last_reminded_at=now(),
    reminder_at=CASE WHEN reminder_count=0 THEN now()+interval '48 hours' ELSE NULL END,
    updated_at=now()
WHERE tenant_id=$1::uuid AND status='pending' AND reminder_at IS NOT NULL AND reminder_at<=now()
RETURNING id,run_id,session_id,reminder_count
      `.trim(),
      [tenantId],
    );
    for (const reminder of questionReminders) {
      await appendWaitEvent(executor, tenantId, reminder.run_id, reminder.session_id, {
        kind: "question.reminded",
        questionId: reminder.id,
        reminderCount: Number(reminder.reminder_count),
      });
    }
    const approvalReminders = await executor.query<{ id: string; run_id: string; session_id: string; reminder_count: number | string }>(
      `
UPDATE approvals
SET reminder_count=reminder_count+1,last_reminded_at=now(),reminder_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND status='pending' AND reminder_at IS NOT NULL AND reminder_at<=now()
RETURNING id,run_id,session_id,reminder_count
      `.trim(),
      [tenantId],
    );
    for (const reminder of approvalReminders) {
      await appendWaitEvent(executor, tenantId, reminder.run_id, reminder.session_id, {
        kind: "approval.reminded",
        approvalId: reminder.id,
        reminderCount: Number(reminder.reminder_count),
      });
    }
  }

  private async enqueuePendingFinalizations(executor: SqlExecutor, tenantId: string): Promise<void> {
    await executor.execute(
      `
UPDATE turn_finalizations
SET status='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND status='running' AND lease_expires_at<=now()
      `.trim(),
      [tenantId],
    );
    await executor.execute(
      `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
SELECT f.tenant_id,'sandbox.snapshot',f.run_id::text,
       f.run_id::text || ':snapshot:finalization:' || (f.attempt+1)::text,
       jsonb_build_object('tenantId',f.tenant_id::text,'runId',f.run_id::text,'reason','before-finalize')
FROM turn_finalizations f
JOIN turn_runs r ON r.tenant_id=f.tenant_id AND r.id=f.run_id
WHERE f.tenant_id=$1::uuid AND f.status IN ('pending','failed','partial')
  AND r.state IN ('completed','failed','cancelled','recovery_required')
  AND r.sandbox_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM runtime_outbox pending
    WHERE pending.tenant_id=f.tenant_id AND pending.aggregate_id=f.run_id::text
      AND pending.event_type='sandbox.snapshot' AND pending.completed_at IS NULL
      AND COALESCE(pending.payload->>'reason','interval')='before-finalize'
  )
ON CONFLICT (tenant_id,dedupe_key) DO UPDATE
SET completed_at=NULL,available_at=now(),lease_owner=NULL,lease_expires_at=NULL,
    receipt_due_at=NULL,dead_lettered_at=NULL,error_category=NULL,last_error=NULL,updated_at=now()
WHERE runtime_outbox.completed_at IS NOT NULL
      `.trim(),
      [tenantId],
    );
  }

  private async complete(row: OutboxRow): Promise<void> {
    await this.withTenant(row.tenant_id, async (executor) => {
      const rows = await executor.query<{ id: string }>(`
        UPDATE runtime_outbox
        SET completed_at = COALESCE(completed_at, now()),
            delivered_at = COALESCE(delivered_at, now()),
            receipt_at = COALESCE(receipt_at, now()),
            receipt_due_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL, error_category = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND lease_owner = $3 AND lease_epoch = $4::bigint
          AND completed_at IS NULL AND dead_lettered_at IS NULL
        RETURNING id
      `, [row.tenant_id, row.id, this.options.workerId, leaseEpoch(row)]);
      if (!rows[0]) workerRuntimeMetrics.outboxFenceMiss("complete");
    });
  }

  private async deferForDeliveryReceipt(row: OutboxRow): Promise<void> {
    const retryMs = Math.max(30_000, this.options.deliveryReceiptRetryMs ?? 900_000);
    await this.withTenant(row.tenant_id, async (executor) => {
      const rows = await executor.query<{ id: string }>(`
        UPDATE runtime_outbox
        SET delivered_at = COALESCE(delivered_at, now()),
            receipt_due_at = now() + ($4::bigint * interval '1 millisecond'),
            lease_owner = NULL, lease_expires_at = NULL,
            last_error = 'Awaiting worker delivery receipt', error_category = 'delivery_receipt_pending', updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND lease_owner = $3 AND lease_epoch = $5::bigint
          AND completed_at IS NULL AND dead_lettered_at IS NULL
        RETURNING id
      `, [row.tenant_id, row.id, this.options.workerId, retryMs, leaseEpoch(row)]);
      if (!rows[0]) workerRuntimeMetrics.outboxFenceMiss("defer");
    });
  }

  private terminalCleanupDue(): boolean {
    const now = Date.now();
    if (now < this.#nextTerminalCleanupAt) return false;
    this.#nextTerminalCleanupAt = now + Math.max(
      1_000,
      this.options.terminalCleanupIntervalMs ?? 60_000,
    );
    return true;
  }

  private async fail(row: OutboxRow, reason: string, terminal: boolean, category = "dispatch_error"): Promise<void> {
    const attempts = Number(row.attempts) || 0;
    const configuredMax = this.options.maxAttempts ?? Number(row.max_attempts ?? 8);
    const maxAttempts = Math.max(1, Math.min(100, Number.isFinite(configuredMax) ? configuredMax : 8));
    const deadLetter = terminal || attempts >= maxAttempts;
    const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
    await this.withTenant(row.tenant_id, async (executor) => {
      const rows = await executor.query<{ id: string }>(`
        UPDATE runtime_outbox
        SET lease_owner = NULL, lease_expires_at = NULL, receipt_due_at = NULL,
            available_at = CASE WHEN $4::boolean THEN available_at ELSE now() + ($5 || ' seconds')::interval END,
            completed_at = CASE WHEN $4::boolean THEN COALESCE(completed_at, now()) ELSE NULL END,
            dead_lettered_at = CASE WHEN $4::boolean THEN COALESCE(dead_lettered_at, now()) ELSE NULL END,
            error_category = $6, last_error = $3, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND lease_owner = $7 AND lease_epoch = $8::bigint
          AND completed_at IS NULL AND dead_lettered_at IS NULL
        RETURNING id
      `, [
        row.tenant_id,
        row.id,
        reason.slice(0, 2_000),
        deadLetter,
        delaySeconds,
        category,
        this.options.workerId,
        leaseEpoch(row),
      ]);
      if (!rows[0]) workerRuntimeMetrics.outboxFenceMiss("fail");
    });
  }

  private async tenantIds(): Promise<string[]> {
    if (this.options.tenantId) return [this.options.tenantId];
    const rows = await this.executor.query<{ id: string }>(
      "SELECT id::text FROM tenants WHERE status='active' ORDER BY id",
    );
    return rows.map((row) => row.id);
  }

  private async withTenant<T>(tenantId: string, callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(executor);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }

  #dispatchSafely(): void {
    void this.dispatchDue().catch(() => {
      emitWorkerOperationalEvent("outbox.transition", this.options.workerRole ?? "unknown", this.options.sourceRevision ?? "unknown", {
        outcome: "dispatch_cycle_failed",
      });
    });
  }
}

function logOutboxDispatch(
  row: OutboxRow,
  name: BerryWorkerJobName,
  workerRole: OperationalWorkerRole,
  sourceRevision: string,
  deliveredAt: Date,
): void {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.getTime()
    : typeof row.created_at === "string"
      ? Date.parse(row.created_at)
      : Number.NaN;
  const latencyMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : null;
  workerRuntimeMetrics.outboxDispatch(name, latencyMs);
  emitWorkerOperationalEvent("outbox.transition", workerRole, sourceRevision, {
    ...outboxTransitionFields(row, deliveredAt),
  });
}

function outboxTransitionFields(row: OutboxLifecycleRow, deliveredAt: Date): Record<string, unknown> {
  const claimedAt = row.claimed_at ?? deliveredAt;
  const recordedDeliveredAt = row.delivered_at ?? deliveredAt;
  return {
    outboxId: row.id,
    claimEpoch: leaseEpoch(row),
    attempt: row.attempts,
    priority: row.priority_class,
    firstAvailableAt: toIsoString(row.first_available_at),
    claimedAt: toIsoString(row.claimed_at),
    deliveredAt: toIsoString(row.delivered_at) ?? deliveredAt.toISOString(),
    receiptAt: toIsoString(row.receipt_at),
    queueWaitMs: durationBetween(row.first_available_at, claimedAt),
    deliveryLatencyMs: durationBetween(claimedAt, recordedDeliveredAt),
    receiptLatencyMs: durationBetween(recordedDeliveredAt, row.receipt_at),
  };
}

function durationBetween(start: Date | string | null | undefined, end: Date | string | null | undefined): number | null {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  return startMs === null || endMs === null ? null : Math.max(0, endMs - startMs);
}

function timestampMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  const timestamp = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : null;
}

export function outboxJobId(name: BerryWorkerJobName, outboxId: string, attempt = 1): string {
  const base = `outbox-${name.replaceAll(".", "-")}-${outboxId}`;
  return requiresDeliveryReceipt(name)
    ? `${base}-delivery-${attempt}`
    : base;
}

export interface RuntimeOutboxDeliveryReceipts {
  acknowledge(tenantId: string, outboxId: string, aggregateId?: string, leaseEpoch?: number): Promise<void>;
}

export class SqlRuntimeOutboxDeliveryReceipts implements RuntimeOutboxDeliveryReceipts {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly telemetry: {
      workerRole?: OperationalWorkerRole;
      sourceRevision?: string;
    } = {},
  ) {}

  async acknowledge(tenantId: string, outboxId: string, aggregateId?: string, leaseEpochValue?: number): Promise<void> {
    await this.executor.execute(`
WITH acknowledged AS (
  UPDATE runtime_outbox
  SET completed_at=COALESCE(completed_at,now()),
      delivered_at=COALESCE(delivered_at,now()),
      receipt_at=COALESCE(receipt_at,now()),receipt_due_at=NULL,
      lease_owner=NULL,lease_expires_at=NULL,
      last_error=NULL,error_category=NULL,updated_at=now()
  WHERE tenant_id=$1::uuid AND id=$2::uuid AND completed_at IS NULL
    AND dead_lettered_at IS NULL AND lease_epoch=$4::bigint
  RETURNING id
)
    UPDATE turn_runs
SET updated_at=now()
  WHERE tenant_id=$1::uuid AND id=$3::uuid
  AND EXISTS (SELECT 1 FROM acknowledged)
    `.trim(), [tenantId, outboxId, aggregateId ?? null, leaseEpochValue ?? 1]);
    const rows = await this.executor.query<OutboxLifecycleRow>(`
      SELECT id,attempts,first_available_at,claimed_at,delivered_at,receipt_at,lease_epoch,priority_class
      FROM runtime_outbox
      WHERE tenant_id=$1::uuid AND id=$2::uuid
    `, [tenantId, outboxId]).catch(() => [] as readonly OutboxLifecycleRow[]);
    const row = rows[0];
    if (row && Number(row.lease_epoch) === (leaseEpochValue ?? 1) && row.receipt_at) {
      await persistWorkerOperationalEvent(this.executor, {
        tenantId,
        runId: aggregateId ?? null,
        eventType: "outbox.transition",
        dedupeKey: `${outboxId}:receipt:${leaseEpochValue ?? 1}`,
        claimEpoch: leaseEpochValue ?? 1,
        workerRole: this.telemetry.workerRole ?? "unknown",
        sourceRevision: this.telemetry.sourceRevision ?? "unknown",
        fields: {
          ...outboxTransitionFields(row, row.delivered_at instanceof Date ? row.delivered_at : new Date()),
          outcome: "receipt_recorded",
        },
      }).catch(() => undefined);
    }
  }
}

export function acknowledgeDeliveryAtStart(name: BerryWorkerJobName): boolean {
  return name === "turn.execute" || name === "turn.resume" || name === "sandbox.snapshot";
}

function requiresDeliveryReceipt(name: BerryWorkerJobName): boolean {
  return acknowledgeDeliveryAtStart(name)
    || name === "file.delete-object"
    || name === "file.delete-blob"
    || name === "file.verify-blob";
}

function outboxJobPriority(name: BerryWorkerJobName): number {
  if (name === "turn.execute" || name === "turn.resume") return 1;
  if (name === "title.generate" || name === "session.compact") return 5;
  if (name === "sandbox.snapshot") return 50;
  if (name === "context.backfill" || name === "context.cleanup") return 100;
  return 20;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function leaseEpoch(row: Pick<OutboxRow, "lease_epoch">): number {
  const value = Number(row.lease_epoch);
  return Number.isSafeInteger(value) && value >= 0 ? value : 1;
}

function safeBigInt(value: unknown): bigint {
  try {
    return BigInt(typeof value === "string" || typeof value === "number" ? value : 0);
  } catch {
    return 0n;
  }
}

async function appendWaitEvent(
  executor: SqlExecutor,
  tenantId: string,
  runId: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const sequence = await executor.query<{ value: number | string }>(
    "SELECT COALESCE(MAX(sequence),0)+1 AS value FROM turn_events WHERE tenant_id=$1::uuid AND run_id=$2::uuid",
    [tenantId, runId],
  );
  const eventType = typeof event.kind === "string" ? event.kind : "error";
  await executor.execute(
    eventType === "turn.end"
      ? `
INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM turn_events WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type='turn.end'
)
        `.trim()
      : `
INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)
ON CONFLICT (tenant_id,run_id,sequence) DO NOTHING
        `.trim(),
    [tenantId, runId, sessionId, Number(sequence[0]?.value ?? 1), eventType, JSON.stringify(event)],
  );
}
