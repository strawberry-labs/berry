import { describe, expect, it } from "vitest";
import { RouterClientError } from "@berry/router-client";
import {
  BullMqBerryQueueClient,
  BullMqBerryQueueRouter,
  foregroundQueueNameForShard,
  foregroundQueueShardForKey,
  workerFailureForRetryPolicy,
} from "./bullmq.js";
import { CompactionTerminalError } from "./compaction.js";
import { LEGACY_WORKER_QUEUE_NAME, type BerryWorkerJobName, workerQueueKind } from "./jobs.js";

describe("BullMqBerryQueueClient", () => {
  it("keeps only durable turn execution on foreground capacity", () => {
    const backgroundJobs: BerryWorkerJobName[] = [
      "title.generate",
      "session.compact",
      "sandbox.snapshot",
      "usage.rollup",
      "report.run",
      "alerts.evaluate",
      "knowledge.extract",
      "knowledge.chunk",
      "knowledge.embed",
      "knowledge.index-task",
      "knowledge.delete",
      "knowledge.reindex",
      "file.delete-object",
      "file.delete-blob",
      "file.verify-blob",
      "memory.extract",
      "context.backfill",
      "context.cleanup",
    ];

    expect(workerQueueKind("turn.execute")).toBe("foreground");
    expect(workerQueueKind("turn.resume")).toBe("foreground");
    expect(backgroundJobs.every((name) => workerQueueKind(name) === "background")).toBe(true);
    expect(LEGACY_WORKER_QUEUE_NAME).toBe("berry-cloud");
  });

  it("enqueues typed jobs with retry defaults", async () => {
    const added: unknown[] = [];
    const queue = {
      async add(name: string, payload: unknown, options: unknown) {
        added.push({ name, payload, options });
        return { id: "job_1" };
      },
      async close() {},
    };
    const client = new BullMqBerryQueueClient(queue as never);

    await expect(client.enqueue("usage.rollup", {
      tenantId: "00000000-0000-7000-8000-000000000001",
      from: "2026-07-10T00:00:00.000Z",
      to: "2026-07-11T00:00:00.000Z",
      granularity: "day",
    })).resolves.toEqual({ id: "job_1", name: "usage.rollup" });

    expect(added).toEqual([
      {
        name: "usage.rollup",
        payload: {
          tenantId: "00000000-0000-7000-8000-000000000001",
          from: "2026-07-10T00:00:00.000Z",
          to: "2026-07-11T00:00:00.000Z",
          granularity: "day",
        },
        options: expect.objectContaining({ attempts: 3, removeOnComplete: 1_000, removeOnFail: 5_000 }),
      },
    ]);
  });

  it("honors an outbox-specific job id instead of collapsing equal payloads", async () => {
    const added: unknown[] = [];
    const queue = {
      async add(name: string, payload: unknown, options: unknown) {
        added.push({ name, payload, options });
        return { id: "outbox-turn-execute-1" };
      },
      async close() {},
    };
    const client = new BullMqBerryQueueClient(queue as never);
    const payload = {
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId: "00000000-0000-7000-8000-000000000002",
      reason: "continue" as const,
    };

    await client.enqueue("turn.execute", payload, { jobId: "outbox-turn-execute-1" });
    await client.enqueue("turn.execute", payload, { jobId: "outbox-turn-execute-2" });

    expect(added).toEqual([
      expect.objectContaining({ options: expect.objectContaining({ jobId: "outbox-turn-execute-1" }) }),
      expect.objectContaining({ options: expect.objectContaining({ jobId: "outbox-turn-execute-2" }) }),
    ]);
  });

  it.each(["memory.extract", "title.generate", "session.compact", "turn.execute"])(
    "marks provider 400 failures unrecoverable for %s",
    (jobName) => {
      const permanent = workerFailureForRetryPolicy(
        jobName,
        new RouterClientError("Provider request failed", 400, "redacted", { requestId: "router_400" }),
      );

      expect(permanent).toMatchObject({ name: "UnrecoverableError" });
      expect((permanent as Error).message).toContain(`Non-retryable ${jobName} provider failure`);
      expect((permanent as Error).message).toContain("status=400");
      expect((permanent as Error).message).not.toContain("redacted");
    },
  );

  it.each([
    new RouterClientError("Provider request timed out", 408),
    new RouterClientError("Provider rate limited the request", 429),
    new RouterClientError("Provider unavailable", 503),
    Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  ])("preserves BullMQ retries for transient non-memory provider failures", (transient) => {
    expect(workerFailureForRetryPolicy("title.generate", transient)).toBe(transient);
  });

  it("maps terminal compaction failures before provider classification and exposes only safe state", () => {
    const terminal = new CompactionTerminalError("provider_permanent_client", 409);
    Object.defineProperty(terminal, "requestId", { value: "provider-secret-request" });

    const failure = workerFailureForRetryPolicy("session.compact", terminal);

    expect(failure).toMatchObject({ name: "UnrecoverableError" });
    expect((failure as Error).message).toContain("category=provider_permanent_client");
    expect((failure as Error).message).toContain("status=409");
    expect((failure as Error).message).toContain("The compaction provider rejected the request.");
    expect((failure as Error).message).not.toContain("provider-secret-request");
  });

  it("preserves retries for generic non-provider worker failures", () => {
    const error = new Error("database write failed");
    expect(workerFailureForRetryPolicy("title.generate", error)).toBe(error);
  });

  it("reports ready and prioritized jobs as waiting and calculates the oldest wait", async () => {
    const queue = {
      async getJobCounts() {
        return { waiting: 3, prioritized: 2, active: 4, failed: 5 };
      },
      async getJobs() {
        return [{ timestamp: 9_000 }];
      },
    };
    const client = new BullMqBerryQueueClient(queue as never);

    await expect(client.operationalMetrics("foreground", 12_500)).resolves.toEqual({
      queue: "foreground",
      waiting: 5,
      active: 4,
      failed: 5,
      oldestWaitingSeconds: 3.5,
    });
  });

  it("keeps the legacy berry-cloud drain visible with the split queues", async () => {
    const queue = (waiting: number, active: number, failed: number, timestamp?: number) => ({
      async getJobCounts() { return { waiting, prioritized: 0, active, failed }; },
      async getJobs() { return timestamp === undefined ? [] : [{ timestamp }]; },
    });
    const router = new BullMqBerryQueueRouter(
      queue(1, 2, 3, 9_000) as never,
      queue(4, 5, 6, 8_000) as never,
      queue(7, 8, 9, 7_000) as never,
    );

    await expect(router.operationalMetrics(10_000)).resolves.toEqual([
      { queue: "foreground", waiting: 1, active: 2, failed: 3, oldestWaitingSeconds: 1 },
      { queue: "background", waiting: 4, active: 5, failed: 6, oldestWaitingSeconds: 2 },
      { queue: "legacy", waiting: 7, active: 8, failed: 9, oldestWaitingSeconds: 3 },
    ]);
  });

  it("isolates a foreground burst from a simultaneous background failure flood", async () => {
    const foreground: Array<{ name: string; options: Record<string, unknown> }> = [];
    const background: Array<{ name: string; options: Record<string, unknown> }> = [];
    const queue = (target: typeof foreground) => ({
      async add(name: string, _payload: unknown, options: Record<string, unknown>) {
        target.push({ name, options });
        return { id: String(options.jobId) };
      },
      async close() {},
      async waitUntilReady() {},
      async getJobCounts() { return { waiting: target.length }; },
    });
    const legacy: typeof foreground = [];
    const router = new BullMqBerryQueueRouter(
      queue(foreground) as never,
      queue(background) as never,
      queue(legacy) as never,
    );
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const runId = "00000000-0000-7000-8000-000000000002";
    const memoryPayload = {
      tenantId,
      userId: "00000000-0000-7000-8000-000000000003",
      workspaceId: "00000000-0000-7000-8000-000000000004",
      taskId: "00000000-0000-7000-8000-000000000005",
      sessionId: "00000000-0000-7000-8000-000000000006",
      userMessageId: "00000000-0000-7000-8000-000000000007",
      assistantMessageId: "00000000-0000-7000-8000-000000000008",
      revision: "revision-1",
      extractorVersion: "extractor-1",
      userText: "remember this",
      assistantText: "acknowledged",
    };

    await Promise.all([
      ...Array.from({ length: 100 }, (_, index) => router.enqueue(
        index % 2 === 0 ? "turn.execute" : "turn.resume",
        index % 2 === 0
          ? { tenantId, runId, reason: "continue" as const }
          : { tenantId, runId, reason: "operator-recovery" as const },
        { jobId: `foreground-${index}` },
      )),
      ...Array.from({ length: 506 }, (_, index) => router.enqueue(
        "memory.extract",
        memoryPayload,
        { jobId: `background-${index}` },
      )),
    ]);

    expect(foreground).toHaveLength(100);
    expect(foreground.every(({ name }) => workerQueueKind(name as "turn.execute" | "turn.resume") === "foreground")).toBe(true);
    expect(background).toHaveLength(506);
    expect(background.every(({ name }) => name === "memory.extract")).toBe(true);
    expect(foreground.map(({ options }) => options.jobId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `foreground-${index}`),
    );
  });

  it("routes every phase for one run to the same deterministic foreground shard", async () => {
    const shards: Array<Array<{ name: string; payload: unknown }>> = [[], [], []];
    const queue = (target: Array<{ name: string; payload: unknown }>) => ({
      async add(name: string, payload: unknown) {
        target.push({ name, payload });
        return { id: `${name}-${target.length}` };
      },
      async close() {},
      async waitUntilReady() {},
      async getJobCounts() { return {}; },
      async getJobs() { return []; },
    });
    const router = new BullMqBerryQueueRouter(
      shards.map((target) => queue(target)) as never,
      queue([]) as never,
      queue([]) as never,
    );
    const payload = {
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId: "00000000-0000-7000-8000-000000000002",
      reason: "continue" as const,
    };

    await router.enqueue("turn.execute", payload, { jobId: "phase-1" });
    await router.enqueue("turn.resume", { ...payload, reason: "operator-recovery" }, { jobId: "phase-2" });

    const selected = shards.filter((shard) => shard.length > 0);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.map((job) => job.name)).toEqual(["turn.execute", "turn.resume"]);
    expect(foregroundQueueShardForKey(payload.runId, 3)).toBe(shards.indexOf(selected[0]!));
  });

  it("keeps shard zero on the original queue for rolling queue migrations", () => {
    expect(foregroundQueueNameForShard("berry-cloud-turns", 0, 5)).toBe("berry-cloud-turns");
    expect(foregroundQueueNameForShard("berry-cloud-turns", 1, 5)).toBe("berry-cloud-turns-1");
    expect(foregroundQueueNameForShard("berry-cloud-turns", 0, 1)).toBe("berry-cloud-turns");
  });
});
