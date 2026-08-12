import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  assertWorkerReady,
  renderWorkerMetrics,
  WorkerProcessActivityTracker,
} from "./readiness.ts";

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

  it("tracks process-local active jobs and capacity", () => {
    const worker = Object.assign(new EventEmitter(), { id: "worker-1", concurrency: 20 });
    const tracker = new WorkerProcessActivityTracker("foreground", 1_000);
    tracker.observe(worker as never);

    worker.emit("active", { id: "job-1" });
    worker.emit("active", { id: "job-2" });
    worker.emit("completed", { id: "job-1" });

    expect(tracker.snapshot(true)).toEqual({
      role: "foreground",
      active: 1,
      capacity: 20,
      running: true,
      startTimeSeconds: 1,
    });
  });

  it("renders queue latency and process capacity as Prometheus metrics", () => {
    const output = renderWorkerMetrics({
      queues: [
        { queue: "foreground", waiting: 7, active: 3, failed: 1, oldestWaitingSeconds: 2.5 },
        { queue: "background", waiting: 11, active: 4, failed: 6, oldestWaitingSeconds: 9 },
        { queue: "legacy", waiting: 2, active: 1, failed: 8, oldestWaitingSeconds: 15 },
      ],
      process: {
        role: "foreground",
        active: 3,
        capacity: 20,
        running: true,
        startTimeSeconds: 1_786_000_000,
      },
    });

    expect(output).toContain('berry_worker_queue_jobs{queue="foreground",state="waiting"} 7');
    expect(output).toContain('berry_worker_queue_oldest_waiting_seconds{queue="foreground"} 2.5');
    expect(output).toContain('berry_worker_queue_jobs{queue="legacy",state="waiting"} 2');
    expect(output).toContain('berry_worker_queue_oldest_waiting_seconds{queue="legacy"} 15');
    expect(output).toContain('berry_worker_process_capacity_slots{role="foreground"} 20');
    expect(output).toContain('berry_worker_process_capacity_utilization_ratio{role="foreground"} 0.15');
    expect(output).toContain('berry_worker_process_running{role="foreground"} 1');
  });
});
