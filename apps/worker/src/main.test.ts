import { describe, expect, it } from "vitest";
import { workerProcessConfigFromEnv } from "./main.js";

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
});
