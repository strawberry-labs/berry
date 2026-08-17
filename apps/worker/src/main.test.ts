import { describe, expect, it } from "vitest";
import { foregroundQueueShardIndexFromEnv, resolveForegroundQueueShardIndex, workerProcessConfigFromEnv } from "./main.js";

describe("workerProcessConfigFromEnv", () => {
  it("uses the isolated production foreground capacity", () => {
    const config = workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "foreground",
      BERRY_FOREGROUND_WORKER_CONCURRENCY: "20",
      BERRY_FOREGROUND_WORKER_DB_POOL_MAX: "5",
    });

    expect(config).toMatchObject({
      role: "foreground",
      foregroundConcurrency: 20,
      databasePoolMax: 5,
    });
    expect(5 * config.foregroundConcurrency).toBe(100);
    expect(10 * config.foregroundConcurrency).toBe(200);
  });

  it("keeps one bounded legacy drain alongside background work", () => {
    expect(workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "background",
      BERRY_BACKGROUND_WORKER_CONCURRENCY: "6",
      BERRY_LEGACY_WORKER_CONCURRENCY: "1",
      BERRY_BACKGROUND_WORKER_DB_POOL_MAX: "4",
    })).toEqual({
      role: "background",
      foregroundConcurrency: 4,
      backgroundConcurrency: 6,
      legacyConcurrency: 1,
      foregroundQueueShardCount: 1,
      foregroundQueueShardIndex: 0,
      drainLegacyQueue: true,
      databasePoolMax: 4,
    });
  });

  it("can disable the legacy drain only after the old queue is empty", () => {
    expect(workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "background",
      BERRY_LEGACY_QUEUE_DRAIN: "false",
    }).drainLegacyQueue).toBe(false);
  });

  it("rejects an unknown worker role", () => {
    expect(() => workerProcessConfigFromEnv({ BERRY_WORKER_ROLE: "mixed" })).toThrow(
      "BERRY_WORKER_ROLE must be foreground, background, or all",
    );
  });

  it("does not infer a shard from an opaque container hostname", () => {
    expect(workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "foreground",
      BERRY_FOREGROUND_QUEUE_SHARD_COUNT: "5",
      HOSTNAME: "berry-worker-foreground-3",
    }).foregroundQueueShardIndex).toBe(0);

    expect(workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "foreground",
      BERRY_FOREGROUND_QUEUE_SHARD_COUNT: "5",
      HOSTNAME: "berry-worker-foreground",
    }).foregroundQueueShardIndex).toBe(0);
    expect(() => foregroundQueueShardIndexFromEnv({
      BERRY_WORKER_ROLE: "foreground",
      BERRY_FOREGROUND_QUEUE_SHARD_COUNT: "5",
      HOSTNAME: "e0dd97ef8513",
    }, 5)).toThrow("Unable to determine foreground queue shard");
  });

  it("accepts an explicit zero-based shard for non-Compose deployments", () => {
    expect(workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "foreground",
      BERRY_FOREGROUND_QUEUE_SHARD_COUNT: "3",
      BERRY_FOREGROUND_QUEUE_SHARD_INDEX: "1",
    }).foregroundQueueShardIndex).toBe(1);
    expect(() => foregroundQueueShardIndexFromEnv({ BERRY_FOREGROUND_QUEUE_SHARD_INDEX: "1" }, 1))
      .toThrow("BERRY_FOREGROUND_QUEUE_SHARD_INDEX must be between 0 and 0");
  });

  it("rejects an invalid explicit shard count instead of collapsing to one queue", () => {
    expect(() => workerProcessConfigFromEnv({
      BERRY_WORKER_ROLE: "foreground",
      BERRY_FOREGROUND_QUEUE_SHARD_COUNT: "0",
    })).toThrow("BERRY_FOREGROUND_QUEUE_SHARD_COUNT must be an integer between 1 and 128");
  });

  it("resolves an explicit shard without requiring a DNS lookup", async () => {
    await expect(resolveForegroundQueueShardIndex({ BERRY_FOREGROUND_QUEUE_SHARD_INDEX: "2" }, 3)).resolves.toBe(2);
    await expect(resolveForegroundQueueShardIndex({ BERRY_FOREGROUND_QUEUE_SHARD_INDEX: "9" }, 3))
      .rejects.toThrow("BERRY_FOREGROUND_QUEUE_SHARD_INDEX must be between 0 and 2");
  });
});
