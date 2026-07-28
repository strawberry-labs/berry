import { describe, expect, it, vi } from "vitest";
import type { BerryQueueClient } from "./bullmq.js";
import { RuntimeOutboxDispatcher } from "./outbox.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const runId = "00000000-0000-7000-8000-000000000002";
const outboxId = "00000000-0000-7000-8000-000000000003";

describe("RuntimeOutboxDispatcher", () => {
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
});
