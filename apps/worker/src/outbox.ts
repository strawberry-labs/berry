import { BerryWorkerJobNameSchema, type BerryWorkerJobMap, type BerryWorkerJobName } from "./jobs.js";
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

  constructor(
    private readonly executor: SqlExecutor,
    private readonly queue: BerryQueueClient,
    private readonly options: { tenantId: string; workerId: string; pollMs?: number; batchSize?: number },
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
      await this.withTenant((executor) => executor.execute(`
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
              AND pending.completed_at IS NULL
          )
        ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
      `, [this.options.tenantId]));
      const rows = await this.withTenant(async (executor) => executor.query<OutboxRow>(`
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
      `, [this.options.tenantId, this.options.workerId, this.options.batchSize ?? 50]));
      let dispatched = 0;
      for (const row of rows) {
        const parsedName = BerryWorkerJobNameSchema.safeParse(row.event_type);
        if (!parsedName.success) {
          await this.fail(row, `Unsupported outbox event type: ${row.event_type}`, true);
          continue;
        }
        try {
          const name = parsedName.data;
          await this.queue.enqueue(
            name,
            row.payload as BerryWorkerJobMap[typeof name],
            { jobId: outboxJobId(name, row.id) },
          );
          await this.withTenant((executor) => executor.execute(`
            UPDATE runtime_outbox
            SET completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
                last_error = NULL, updated_at = now()
            WHERE tenant_id = $1::uuid AND id = $2::uuid AND lease_owner = $3
          `, [row.tenant_id, row.id, this.options.workerId]));
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

  private async fail(row: OutboxRow, reason: string, terminal: boolean): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(row.attempts, 8));
    await this.withTenant((executor) => executor.execute(`
      UPDATE runtime_outbox
      SET lease_owner = NULL, lease_expires_at = NULL,
          available_at = CASE WHEN $4::boolean THEN available_at ELSE now() + ($5 || ' seconds')::interval END,
          completed_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
          last_error = $3, updated_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
    `, [row.tenant_id, row.id, reason.slice(0, 2_000), terminal, delaySeconds]));
  }

  private async withTenant<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const run = async (executor: SqlExecutor) => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [this.options.tenantId]);
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

export function outboxJobId(name: BerryWorkerJobName, outboxId: string): string {
  return `outbox-${name.replaceAll(".", "-")}-${outboxId}`;
}
