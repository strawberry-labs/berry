import { describe, expect, it, vi } from "vitest";
import { assertWorkerReady } from "./readiness.ts";

describe("worker readiness", () => {
  it("checks the worker, database, and queue", async () => {
    const pingDatabase = vi.fn(async () => undefined);
    const pingQueue = vi.fn(async () => undefined);
    await expect(assertWorkerReady({ pingDatabase, pingQueue, isWorkerRunning: () => true })).resolves.toBeUndefined();
    expect(pingDatabase).toHaveBeenCalledOnce();
    expect(pingQueue).toHaveBeenCalledOnce();
  });

  it("fails while job processing is stopped", async () => {
    await expect(assertWorkerReady({
      pingDatabase: async () => undefined,
      pingQueue: async () => undefined,
      isWorkerRunning: () => false,
    })).rejects.toThrow("Worker is not running");
  });
});
