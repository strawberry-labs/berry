import { createServer, type Server } from "node:http";
import type { Worker } from "bullmq";
import type { BerryQueueOperationalMetrics } from "./bullmq.js";
import { workerRuntimeMetrics } from "./runtime-metrics.js";

export type WorkerReadinessDependencies = {
  pingDatabase: () => Promise<unknown>;
  pingQueue: () => Promise<unknown>;
  isWorkerRunning: () => boolean;
  collectMetrics?: () => Promise<WorkerMetricsSnapshot>;
};

export type WorkerProcessMetrics = {
  role: "foreground" | "background" | "all";
  active: number;
  capacity: number;
  running: boolean;
  startTimeSeconds: number;
};

export type WorkerMetricsSnapshot = {
  queues: BerryQueueOperationalMetrics[];
  process: WorkerProcessMetrics;
};

export class WorkerProcessActivityTracker {
  readonly #activeJobIds = new Set<string>();
  readonly #workers: Worker[] = [];
  readonly #startTimeSeconds: number;

  constructor(
    readonly role: WorkerProcessMetrics["role"],
    startedAtMs = Date.now(),
  ) {
    this.#startTimeSeconds = startedAtMs / 1_000;
  }

  observe(worker: Worker): void {
    this.#workers.push(worker);
    const key = (jobId: string): string => `${worker.id}:${jobId}`;
    worker.on("active", (job) => {
      if (job.id) this.#activeJobIds.add(key(job.id));
    });
    worker.on("completed", (job) => {
      if (job.id) this.#activeJobIds.delete(key(job.id));
    });
    worker.on("failed", (job) => {
      if (job?.id) this.#activeJobIds.delete(key(job.id));
    });
    worker.on("stalled", (jobId) => this.#activeJobIds.delete(key(jobId)));
  }

  snapshot(running: boolean): WorkerProcessMetrics {
    return {
      role: this.role,
      active: this.#activeJobIds.size,
      capacity: this.#workers.reduce((total, worker) => total + worker.concurrency, 0),
      running,
      startTimeSeconds: this.#startTimeSeconds,
    };
  }
}

export async function assertWorkerReady(dependencies: WorkerReadinessDependencies): Promise<void> {
  if (!dependencies.isWorkerRunning()) throw new Error("Worker is not running");
  await Promise.all([dependencies.pingDatabase(), dependencies.pingQueue()]);
}

export function startWorkerReadinessServer(
  dependencies: WorkerReadinessDependencies,
  port: number,
  host = "127.0.0.1",
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics" && dependencies.collectMetrics) {
      void dependencies.collectMetrics().then(
        (snapshot) => response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        }).end(renderWorkerMetrics(snapshot)),
        () => response.writeHead(503, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
        }).end("# berry worker metrics unavailable\n"),
      );
      return;
    }
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }
    void assertWorkerReady(dependencies).then(
      () => response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"service":"berry-worker","ready":true}'),
      () => response.writeHead(503, { "content-type": "application/json" }).end('{"ok":false,"service":"berry-worker","ready":false}'),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export function renderWorkerMetrics(snapshot: WorkerMetricsSnapshot): string {
  const lines = [
    "# HELP berry_worker_queue_jobs Jobs currently recorded by BullMQ queue and state.",
    "# TYPE berry_worker_queue_jobs gauge",
  ];
  for (const queue of snapshot.queues) {
    const label = `queue="${escapePrometheusLabel(queue.queue)}"`;
    lines.push(
      `berry_worker_queue_jobs{${label},state="waiting"} ${queue.waiting}`,
      `berry_worker_queue_jobs{${label},state="active"} ${queue.active}`,
      `berry_worker_queue_jobs{${label},state="failed"} ${queue.failed}`,
    );
  }
  lines.push(
    "# HELP berry_worker_queue_oldest_waiting_seconds Age of the oldest ready job in each queue.",
    "# TYPE berry_worker_queue_oldest_waiting_seconds gauge",
  );
  for (const queue of snapshot.queues) {
    lines.push(
      `berry_worker_queue_oldest_waiting_seconds{queue="${escapePrometheusLabel(queue.queue)}"} ${finiteMetric(queue.oldestWaitingSeconds)}`,
    );
  }
  const role = `role="${escapePrometheusLabel(snapshot.process.role)}"`;
  const utilization = snapshot.process.capacity > 0
    ? snapshot.process.active / snapshot.process.capacity
    : 0;
  lines.push(
    "# HELP berry_worker_process_active_jobs Jobs currently executing in this worker process.",
    "# TYPE berry_worker_process_active_jobs gauge",
    `berry_worker_process_active_jobs{${role}} ${snapshot.process.active}`,
    "# HELP berry_worker_process_capacity_slots Configured concurrency slots in this worker process.",
    "# TYPE berry_worker_process_capacity_slots gauge",
    `berry_worker_process_capacity_slots{${role}} ${snapshot.process.capacity}`,
    "# HELP berry_worker_process_capacity_utilization_ratio Active jobs divided by configured process capacity.",
    "# TYPE berry_worker_process_capacity_utilization_ratio gauge",
    `berry_worker_process_capacity_utilization_ratio{${role}} ${finiteMetric(utilization)}`,
    "# HELP berry_worker_process_running Whether every BullMQ worker in this process is running.",
    "# TYPE berry_worker_process_running gauge",
    `berry_worker_process_running{${role}} ${snapshot.process.running ? 1 : 0}`,
    "# HELP berry_worker_process_start_time_seconds Unix timestamp when this process metrics tracker started.",
    "# TYPE berry_worker_process_start_time_seconds gauge",
    `berry_worker_process_start_time_seconds{${role}} ${finiteMetric(snapshot.process.startTimeSeconds)}`,
  );
  return `${lines.join("\n")}\n${workerRuntimeMetrics.render()}`;
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function escapePrometheusLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
