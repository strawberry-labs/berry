import { describe, expect, it, vi } from "vitest";
import type { BerryQueueClient } from "./bullmq.js";
import { RuntimeOutboxDispatcher } from "./outbox.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const runId = "00000000-0000-7000-8000-000000000002";
const outboxId = "00000000-0000-7000-8000-000000000003";

describe("RuntimeOutboxDispatcher", () => {
  it("backfills cleanup snapshots for terminal runs with billable sandboxes", async () => {
    const statements: string[] = [];
    const executor: SqlExecutor = {
      execute: vi.fn(async (sql: string) => {
        statements.push(sql);
      }),
      query: async <T>(): Promise<readonly T[]> => [],
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: vi.fn() as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, {
      tenantId,
      workerId: "worker-test",
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(0);

    const cleanup = statements.find((sql) => sql.includes("snapshot:terminal-cleanup"));
    expect(cleanup).toContain("r.state IN ('completed','failed','cancelled','recovery_required')");
    expect(cleanup).toContain("r.sandbox_id IS NOT NULL");
    expect(cleanup).toContain("'reason','before-finalize'");
  });

  it("uses the unique outbox row for the BullMQ job id", async () => {
    let claimed = false;
    const executor: SqlExecutor = {
      execute: vi.fn(async () => undefined),
      query: async <T>(sql: string): Promise<readonly T[]> => {
        if (!claimed && sql.includes("RETURNING outbox.id")) {
          claimed = true;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "turn.execute",
            payload: { tenantId, runId, reason: "continue" },
            attempts: 1,
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const enqueue = vi.fn(async () => ({ id: "queued", name: "turn.execute" as const }));
    const queue: BerryQueueClient = {
      enqueue: enqueue as BerryQueueClient["enqueue"],
      close: async () => undefined,
    };
    const dispatcher = new RuntimeOutboxDispatcher(executor, queue, {
      tenantId,
      workerId: "worker-test",
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      "turn.execute",
      { tenantId, runId, reason: "continue" },
      { jobId: `outbox-turn-execute-${outboxId}` },
    );
  });

  it("discovers and dispatches due rows for every active tenant", async () => {
    const secondTenantId = "00000000-0000-7000-8000-000000000010";
    const executor: SqlExecutor = {
      execute: vi.fn(async () => undefined),
      query: async <T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> => {
        if (sql.includes("FROM tenants")) {
          return [{ id: tenantId }, { id: secondTenantId }] as T[];
        }
        if (sql.includes("RETURNING outbox.id")) {
          const currentTenant = String(params[0]);
          return [{
            id: currentTenant === tenantId ? outboxId : "00000000-0000-7000-8000-000000000011",
            tenant_id: currentTenant,
            event_type: "turn.execute",
            payload: { tenantId: currentTenant, runId, reason: "continue" },
            attempts: 1,
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const enqueuedTenants: string[] = [];
    const enqueue = vi.fn(async (_name: string, payload: { tenantId: string }) => {
      enqueuedTenants.push(payload.tenantId);
      return { id: "queued", name: "turn.execute" as const };
    });
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: enqueue as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, {
      workerId: "worker-test",
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueuedTenants).toEqual([tenantId, secondTenantId]);
  });
});
