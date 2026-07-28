import { describe, expect, it } from "vitest";
import type { BerryWorkerDependencies } from "./processor.js";
import { processBerryWorkerJob } from "./processor.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

function testDependencies(): BerryWorkerDependencies & {
  titles: BerryWorkerDependencies["titles"] & { updates: Array<{ tenantId: string; taskId: string; title: string }> };
  usage: BerryWorkerDependencies["usage"] & { persisted: unknown[] };
} {
  const titles = {
    updates: [] as Array<{ tenantId: string; taskId: string; title: string }>,
    async updateTaskTitle(input: { tenantId: string; taskId: string; title: string }): Promise<void> {
      this.updates.push(input);
    },
  };
  const usage = {
    persisted: [] as unknown[],
    async listUsageEvents(): Promise<[]> {
      return [];
    },
    async upsertUsageRollups(rollups: unknown[]): Promise<void> {
      this.persisted.push(...rollups);
    },
  };
  return {
    titles,
    usage,
    titleGenerator: {
      async generateTitle(): Promise<string> {
        return "Generated title";
      },
    },
    compactor: {
      async compactSession(input) {
        return { sessionId: input.sessionId, summary: "Compacted fixture", tokensBefore: 100, tokensAfter: 42 };
      },
    },
  };
}

describe("processBerryWorkerJob", () => {
  it("validates and dispatches title generation jobs", async () => {
    const dependencies = testDependencies();
    const result = await processBerryWorkerJob("title.generate", {
      tenantId,
      taskId: "task_1",
      sourceText: "Please implement billing dashboards",
    }, dependencies);

    expect(result).toEqual({ taskId: "task_1", title: "Generated title" });
    expect(dependencies.titles.updates).toEqual([{ tenantId, taskId: "task_1", title: "Generated title" }]);
  });

  it("validates and dispatches compaction jobs", async () => {
    const dependencies = testDependencies();
    await expect(processBerryWorkerJob("session.compact", {
      tenantId,
      taskId: "task_1",
      sessionId: "session_1",
      reason: "manual",
    }, dependencies)).resolves.toEqual({
      sessionId: "session_1",
      summary: "Compacted fixture",
      tokensBefore: 100,
      tokensAfter: 42,
    });
  });

  it("rejects malformed job payloads before side effects", async () => {
    const dependencies = testDependencies();
    await expect(processBerryWorkerJob("title.generate", {
      tenantId: "not-a-uuid",
      taskId: "task_1",
      sourceText: "bad",
    }, dependencies)).rejects.toThrow();
    expect(dependencies.titles.updates).toEqual([]);
  });

  it("dispatches bounded maintenance jobs through the typed worker path", async () => {
    const dependencies = testDependencies();
    const calls: string[] = [];
    dependencies.maintenance = {
      async backfill(payload) {
        calls.push(`backfill:${payload.batchSize}:${payload.generation}`);
        return { runId: payload.runId, status: "running", phase: "file_sources", scanned: 50, changed: 20, enqueued: 20 };
      },
      async cleanup(payload) {
        calls.push(`cleanup:${payload.eventRetentionDays}:${payload.batchSize}`);
        return { runId: payload.runId, status: "completed", phase: "done", scanned: 4, changed: 4, enqueued: 0 };
      },
    };
    const runId = "00000000-0000-7000-8000-000000000099";

    await processBerryWorkerJob("context.backfill", { tenantId, runId, batchSize: 50 }, dependencies);
    await processBerryWorkerJob("context.cleanup", { tenantId, runId, batchSize: 25 }, dependencies);

    expect(calls).toEqual(["backfill:50:0", "cleanup:30:25"]);
  });
});
