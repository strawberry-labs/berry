import { describe, expect, it, vi } from "vitest";
import type { BerryQueueClient } from "./bullmq.js";
import { parseWorkerJob } from "./jobs.js";
import { outboxJobId, RuntimeOutboxDispatcher, SqlRuntimeOutboxDeliveryReceipts } from "./outbox.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const runId = "00000000-0000-7000-8000-000000000002";
const outboxId = "00000000-0000-7000-8000-000000000003";

describe("RuntimeOutboxDispatcher", () => {
  it("acknowledges delivery and defers lease recovery in one statement", async () => {
    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => undefined);

    await new SqlRuntimeOutboxDeliveryReceipts({
      execute,
      query: vi.fn(async () => []),
    }).acknowledge(tenantId, outboxId, runId, 7);

    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/WITH acknowledged[\s\S]*UPDATE turn_runs[\s\S]*SET updated_at=now\(\)/),
      [tenantId, outboxId, runId, 7],
    );
  });

  it("uses a fresh queue identity when blob verification is explicitly re-enqueued", () => {
    expect(outboxJobId("file.verify-blob", outboxId, 1)).not.toBe(outboxJobId("file.verify-blob", outboxId, 2));
  });

  it("keeps blob verification pending until the verifier records completion", async () => {
    const statements: string[] = [];
    let claimed = false;
    const executor: SqlExecutor = {
      execute: async (sql) => { statements.push(sql); },
      query: async <T>(sql: string) => {
        statements.push(sql);
        if (sql.includes("RETURNING outbox.id") && !claimed) {
          claimed = true;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "file.verify-blob",
            payload: { tenantId, blobId: runId },
            attempts: 1,
            lease_epoch: 1,
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const enqueue = vi.fn(async () => ({ id: "queued", name: "file.verify-blob" as const }));
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: enqueue as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, { tenantId, workerId: "worker-test", deliveryReceiptRetryMs: 30_000 });

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);

    expect(enqueue).toHaveBeenCalledWith("file.verify-blob", { tenantId, blobId: runId, outboxId, leaseEpoch: 1 }, {
      jobId: `outbox-file-verify-blob-${outboxId}-delivery-1`,
      priority: 20,
    });
    expect(statements.some((sql) => sql.includes("Awaiting worker delivery receipt"))).toBe(true);
    expect(statements.some((sql) => sql.includes("dead_lettered_at") && sql.includes("completed_at = COALESCE"))).toBe(false);
  });

  it("propagates worker role/revision and immutable lifecycle timestamps into dispatch telemetry", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    let claimed = false;
    const firstAvailableAt = "2026-08-17T00:00:00.000Z";
    const claimedAt = "2026-08-17T00:00:01.000Z";
    const executor: SqlExecutor = {
      execute: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        executions.push({ sql, params });
      }),
      query: async <T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> => {
        queries.push({ sql, params });
        if (!claimed && sql.includes("RETURNING outbox.id")) {
          claimed = true;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "turn.execute",
            payload: { tenantId, runId, reason: "continue" },
            attempts: 1,
            first_available_at: firstAvailableAt,
            claimed_at: claimedAt,
            delivered_at: null,
            receipt_at: null,
            lease_epoch: 3,
            priority_class: "interactive",
            worker_role: "foreground",
            source_revision: "release/2026.08",
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: vi.fn(async () => ({ id: "queued", name: "turn.execute" as const })) as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, {
      tenantId,
      workerId: "worker-test",
      workerRole: "foreground",
      sourceRevision: "release/2026.08",
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);

    const claim = queries.find(({ sql }) => sql.includes("RETURNING outbox.id"));
    expect(claim?.sql).toContain("outbox.claimed_at");
    expect(claim?.sql).toContain("outbox.delivered_at");
    expect(claim?.sql).toContain("outbox.receipt_at");
    expect(claim?.params.slice(1, 4)).toEqual(["worker-test", "foreground", "release/2026.08"]);
    const telemetry = executions.find(({ sql }) => sql.includes("INSERT INTO agent_operational_events"));
    expect(telemetry?.params[7]).toBe("foreground");
    expect(telemetry?.params[8]).toBe("release/2026.08");
    expect(JSON.parse(String(telemetry?.params[9]))).toMatchObject({
      outboxId,
      claimEpoch: 3,
      firstAvailableAt,
      claimedAt,
      deliveredAt: expect.any(String),
      receiptAt: null,
    });
  });

  it("ignores pending maintenance work when deciding whether a run needs recovery", async () => {
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

    const recovery = statements.find((sql) => sql.includes("':recovery:'"));
    expect(recovery).toContain("pending.event_type IN ('turn.execute','turn.resume')");
  });

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
    expect(cleanup).toContain("LIMIT $2");
    expect(cleanup).toContain("'pause_requested'");
    expect(cleanup).toContain("'reason','before-finalize'");
    expect(cleanup).toContain("COALESCE(pending.payload->>'reason','interval')='before-finalize'");

    await expect(dispatcher.dispatchDue()).resolves.toBe(0);
    expect(statements.filter((sql) => sql.includes("snapshot:terminal-cleanup"))).toHaveLength(1);
  });

  it("reminds pending questions and approvals exactly once per due reminder row", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: string[] = [];
    const executor: SqlExecutor = {
      execute: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
      }),
      query: async <T>(sql: string): Promise<readonly T[]> => {
        queries.push(sql);
        if (sql.includes("UPDATE turn_questions")) {
          return [{ id: "question-1", run_id: runId, session_id: "session-1", reminder_count: 1 }] as T[];
        }
        if (sql.includes("UPDATE approvals")) {
          return [{ id: "approval-1", run_id: runId, session_id: "session-1", reminder_count: 1 }] as T[];
        }
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 3 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: vi.fn() as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, {
      tenantId,
      workerId: "worker-wait-supervisor",
      enableWaitExpiry: true,
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(0);

    expect(statements.some(({ params }) => params.some((value) => String(value).includes('"kind":"question.reminded"')))).toBe(true);
    expect(statements.some(({ params }) => params.some((value) => String(value).includes('"kind":"approval.reminded"')))).toBe(true);
    expect(queries.some((sql) => sql.includes("reminder_at=CASE WHEN reminder_count=0"))).toBe(true);
    expect(queries.some((sql) => sql.includes("last_reminded_at=now()") && sql.includes("reminder_at=NULL"))).toBe(true);
  });

  it("atomically marks terminal sandboxes as pause requested when dispatching their snapshot", async () => {
    const statements: string[] = [];
    let claimed = false;
    let pauseRequestedBeforeEnqueue = false;
    const executor: SqlExecutor = {
      execute: vi.fn(async (sql: string) => {
        statements.push(sql);
      }),
      query: async <T>(sql: string): Promise<readonly T[]> => {
        statements.push(sql);
        if (!claimed && sql.includes("RETURNING outbox.id")) {
          claimed = true;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "sandbox.snapshot",
            payload: { tenantId, runId, reason: "before-finalize" },
            attempts: 1,
            lease_epoch: 1,
          }] as T[];
        }
        return [];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const enqueue = vi.fn(async () => {
      pauseRequestedBeforeEnqueue = statements.some((sql) => sql.includes("sandbox_state='pause_requested'"));
      return { id: "queued", name: "sandbox.snapshot" as const };
    });
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: enqueue as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, {
      tenantId,
      workerId: "worker-test",
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);

    expect(statements.find((sql) => sql.includes("sandbox_state='pause_requested'")))
      .toContain("state IN ('completed','failed','cancelled','recovery_required')");
    expect(pauseRequestedBeforeEnqueue).toBe(true);
    expect(statements.find((sql) => sql.includes("Superseded by terminal sandbox cleanup")))
      .toContain("COALESCE(payload->>'reason','interval')<>'before-finalize'");
    expect(statements.some((sql) => sql.includes("UPDATE runtime_outbox") && sql.includes("lease_epoch"))).toBe(true);
  });

  it("keeps a turn outbox row pending until its queued job starts", async () => {
    let claimed = false;
    const statements: string[] = [];
    const executor: SqlExecutor = {
      execute: vi.fn(async (sql: string) => { statements.push(sql); }),
      query: async <T>(sql: string): Promise<readonly T[]> => {
        if (sql.includes("UPDATE runtime_outbox") && sql.includes("Awaiting worker delivery receipt")) statements.push(sql);
        if (!claimed && sql.includes("RETURNING outbox.id")) {
          claimed = true;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "turn.execute",
            payload: { tenantId, runId, reason: "continue" },
            attempts: 1,
            lease_epoch: 1,
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
      { tenantId, runId, reason: "continue", outboxId, leaseEpoch: 1 },
      { jobId: `outbox-turn-execute-${outboxId}-delivery-1`, priority: 1 },
    );
    expect(statements.some((sql) => sql.includes("Awaiting worker delivery receipt"))).toBe(true);
  });

  it("keeps object deletion pending until the worker records a delivery receipt", async () => {
    let claimCount = 0;
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
      }),
      query: async <T>(sql: string): Promise<readonly T[]> => {
        statements.push({ sql, params: [] });
        if (sql.includes("RETURNING outbox.id") && claimCount < 2) {
          claimCount += 1;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "file.delete-object",
            payload: {
              tenantId,
              fileId: runId,
              bucket: "berry-test",
              keys: ["artifacts/file.png"],
            },
            attempts: claimCount,
            lease_epoch: claimCount,
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const enqueue = vi.fn(async () => ({ id: "queued", name: "file.delete-object" as const }));
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: enqueue as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, {
      tenantId,
      workerId: "worker-test",
      deliveryReceiptRetryMs: 30_000,
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(1);
    await expect(dispatcher.dispatchDue()).resolves.toBe(1);

    expect(enqueue).toHaveBeenNthCalledWith(1, "file.delete-object", {
      outboxId,
      tenantId,
      fileId: runId,
      leaseEpoch: 1,
      bucket: "berry-test",
      keys: ["artifacts/file.png"],
    }, { jobId: `outbox-file-delete-object-${outboxId}-delivery-1`, priority: 20 });
    expect(enqueue).toHaveBeenNthCalledWith(2, "file.delete-object", expect.any(Object), {
      jobId: `outbox-file-delete-object-${outboxId}-delivery-2`,
      priority: 20,
    });
    const receiptWaits = statements.filter(({ sql }) => sql.includes("Awaiting worker delivery receipt"));
    expect(receiptWaits).toHaveLength(2);
    expect(receiptWaits.every(({ sql }) => sql.includes("completed_at IS NULL"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("dead_lettered_at") && sql.includes("completed_at = COALESCE"))).toBe(false);
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
            lease_epoch: 1,
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

  it("dead-letters a recognized job with a malformed payload", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    let claimed = false;
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (!claimed && sql.includes("RETURNING outbox.id")) {
          claimed = true;
          return [{
            id: outboxId,
            tenant_id: tenantId,
            event_type: "title.generate",
            payload: { tenantId, taskId: "task-without-source" },
            attempts: 1,
            lease_epoch: 1,
            max_attempts: 8,
          }] as T[];
        }
        if (sql.includes("dead_lettered_at")) return [{ id: outboxId }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const enqueue = vi.fn() as BerryQueueClient["enqueue"];
    const dispatcher = new RuntimeOutboxDispatcher(executor, { enqueue, close: async () => undefined }, {
      tenantId,
      workerId: "worker-malformed",
    });

    await expect(dispatcher.dispatchDue()).resolves.toBe(0);

    const deadLetter = queries.find(({ sql }) => sql.includes("lease_owner = $7"));
    expect(deadLetter?.sql).toContain("lease_owner = $7");
    expect(deadLetter?.sql).toContain("lease_epoch = $8::bigint");
    expect(deadLetter?.params).toContain("malformed_payload");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps the queued-follow-up producer and consumer contract aligned", () => {
    expect(parseWorkerJob("turn.execute", {
      tenantId,
      runId,
      reason: "queued-follow-up",
    })).toMatchObject({ tenantId, runId, reason: "queued-follow-up" });
  });

  it("claims interactive work ahead of cleanup work and fences receipt writes by epoch", async () => {
    const queries: string[] = [];
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        queries.push(sql);
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const dispatcher = new RuntimeOutboxDispatcher(executor, {
      enqueue: vi.fn() as BerryQueueClient["enqueue"],
      close: async () => undefined,
    }, { tenantId, workerId: "worker-priority" });

    await dispatcher.dispatchDue();

    const claim = queries.find((sql) => sql.includes("ORDER BY CASE priority_class"));
    expect(claim).toContain("WHEN 'interactive' THEN 0");
    expect(claim).toContain("COALESCE(receipt_due_at, available_at)");

    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => undefined);
    await new SqlRuntimeOutboxDeliveryReceipts({ execute, query: vi.fn(async () => []) })
      .acknowledge(tenantId, outboxId, runId, 42);
    expect(execute.mock.calls[0]?.[0]).toContain("lease_epoch=$4::bigint");
    expect(execute.mock.calls[0]?.[1]).toEqual([tenantId, outboxId, runId, 42]);
  });
});
