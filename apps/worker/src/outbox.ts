import {
  BerryWorkerJobNameSchema,
  FileDeleteBlobJobPayloadSchema,
  FileDeleteObjectJobPayloadSchema,
  SandboxSnapshotJobPayloadSchema,
  type BerryWorkerJobMap,
  type BerryWorkerJobName,
} from "./jobs.js";
import type { BerryQueueClient } from "./bullmq.js";
import type { SqlExecutor } from "./sql-repositories.js";

type OutboxRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
};

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
        const claimed = await this.withTenant(tenantId, async (executor) => executor.query<OutboxRow>(`
        WITH due AS (
          SELECT id
          FROM runtime_outbox
          WHERE tenant_id = $1::uuid
            AND completed_at IS NULL
            AND available_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        UPDATE runtime_outbox outbox
        SET lease_owner = $2, lease_expires_at = now() + interval '30 seconds',
            attempts = outbox.attempts + 1, updated_at = now()
        FROM due
        WHERE outbox.id = due.id
        RETURNING outbox.id, outbox.tenant_id, outbox.event_type,
                  outbox.payload, outbox.attempts
      `, [tenantId, this.options.workerId, remaining]));
        rows.push(...claimed);
      }
      let dispatched = 0;
      for (const row of rows) {
        const parsedName = BerryWorkerJobNameSchema.safeParse(row.event_type);
        if (!parsedName.success) {
          await this.fail(row, `Unsupported outbox event type: ${row.event_type}`, true);
          continue;
        }
        try {
          const name = parsedName.data;
          await this.prepare(row, name);
          const payload = name === "file.delete-object"
            ? FileDeleteObjectJobPayloadSchema.parse({
                ...(isRecord(row.payload) ? row.payload : {}),
                outboxId: row.id,
              })
            : name === "file.delete-blob"
              ? FileDeleteBlobJobPayloadSchema.parse({
                  ...(isRecord(row.payload) ? row.payload : {}),
                  outboxId: row.id,
                })
            : row.payload as BerryWorkerJobMap[typeof name];
          await this.queue.enqueue(
            name,
            payload as BerryWorkerJobMap[typeof name],
            { jobId: outboxJobId(name, row.id, row.attempts) },
          );
          if (name === "file.delete-object" || name === "file.delete-blob" || name === "file.verify-blob") await this.deferForDeliveryReceipt(row);
          else await this.complete(row);
          dispatched += 1;
        } catch (error) {
          await this.fail(row, error instanceof Error ? error.message : String(error), false);
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

  private async complete(row: OutboxRow): Promise<void> {
    await this.withTenant(row.tenant_id, async (executor) => {
      await executor.execute(`
        UPDATE runtime_outbox
        SET completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
            last_error = NULL, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND lease_owner = $3
      `, [row.tenant_id, row.id, this.options.workerId]);
    });
  }

  private async deferForDeliveryReceipt(row: OutboxRow): Promise<void> {
    const retryMs = Math.max(30_000, this.options.deliveryReceiptRetryMs ?? 300_000);
    await this.withTenant(row.tenant_id, async (executor) => {
      await executor.execute(`
        UPDATE runtime_outbox
        SET lease_owner = NULL, lease_expires_at = NULL,
            available_at = now() + ($4::bigint * interval '1 millisecond'),
            last_error = 'Awaiting worker delivery receipt', updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND lease_owner = $3 AND completed_at IS NULL
      `, [row.tenant_id, row.id, this.options.workerId, retryMs]);
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

  private async fail(row: OutboxRow, reason: string, terminal: boolean): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(row.attempts, 8));
    await this.withTenant(row.tenant_id, (executor) => executor.execute(`
      UPDATE runtime_outbox
      SET lease_owner = NULL, lease_expires_at = NULL,
          available_at = CASE WHEN $4::boolean THEN available_at ELSE now() + ($5 || ' seconds')::interval END,
          completed_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
          last_error = $3, updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
    `, [row.tenant_id, row.id, reason.slice(0, 2_000), terminal, delaySeconds]));
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
    void this.dispatchDue().catch((error) => {
      console.error("[runtime-outbox] Dispatch cycle failed; the next poll will retry.", error);
    });
  }
}

export function outboxJobId(name: BerryWorkerJobName, outboxId: string, attempt = 1): string {
  const base = `outbox-${name.replaceAll(".", "-")}-${outboxId}`;
  return name === "file.delete-object" || name === "file.delete-blob" || name === "file.verify-blob"
    ? `${base}-delivery-${attempt}`
    : base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
