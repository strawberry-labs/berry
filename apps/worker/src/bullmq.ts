import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type JobsOptions, type Processor } from "bullmq";
import { createHash } from "node:crypto";
import {
  BACKGROUND_WORKER_QUEUE_NAME,
  FOREGROUND_WORKER_QUEUE_NAME,
  LEGACY_WORKER_QUEUE_NAME,
  type BerryWorkerJobMap,
  type BerryWorkerJobName,
  type BerryWorkerQueueKind,
  workerQueueKind,
} from "./jobs.js";
import { normalizeWorkerRole, sourceRevisionFromEnv } from "@berry/shared";
import type { BerryWorkerDependencies } from "./processor.js";
import { processBerryWorkerJob } from "./processor.js";
import { CompactionTerminalError } from "./compaction.js";
import { classifyProviderFailure } from "./provider-retry.js";
import { emitWorkerOperationalEvent } from "./operational-telemetry.js";

export interface BerryQueueClient {
  enqueue<Name extends BerryWorkerJobName>(
    name: Name,
    payload: BerryWorkerJobMap[Name],
    options?: JobsOptions,
  ): Promise<{ id: string | undefined; name: Name }>;
  close(): Promise<void>;
}

export type BerryQueueOperationalKind = BerryWorkerQueueKind | "legacy";

export type BerryQueueOperationalMetrics = {
  queue: BerryQueueOperationalKind;
  waiting: number;
  active: number;
  failed: number;
  oldestWaitingSeconds: number;
};

export class BullMqBerryQueueClient implements BerryQueueClient {
  readonly #queue: Queue;

  constructor(queue: Queue = createBerryQueue()) {
    this.#queue = queue;
  }

  async enqueue<Name extends BerryWorkerJobName>(
    name: Name,
    payload: BerryWorkerJobMap[Name],
    options: JobsOptions = {},
  ): Promise<{ id: string | undefined; name: Name }> {
    const job = await this.#queue.add(name, payload, {
      jobId: options.jobId ?? deterministicJobId(name, payload),
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
      ...options,
    });
    return { id: job.id, name };
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }

  async waitUntilReady(): Promise<void> {
    await this.#queue.waitUntilReady();
  }

  async ping(): Promise<void> {
    await this.#queue.getJobCounts("waiting");
  }

  async operationalMetrics(
    queue: BerryQueueOperationalKind,
    nowMs = Date.now(),
  ): Promise<BerryQueueOperationalMetrics> {
    const [counts, oldestWaiting] = await Promise.all([
      this.#queue.getJobCounts("waiting", "prioritized", "active", "failed"),
      this.#queue.getJobs(["waiting", "prioritized"], 0, 0, true),
    ]);
    const oldestTimestamp = oldestWaiting[0]?.timestamp;
    return {
      queue,
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      oldestWaitingSeconds: oldestTimestamp === undefined
        ? 0
        : Math.max(0, (nowMs - oldestTimestamp) / 1_000),
    };
  }
}

/** Routes new jobs by workload class while retaining the existing queue client API. */
export class BullMqBerryQueueRouter implements BerryQueueClient {
  readonly #foreground: readonly BullMqBerryQueueClient[];
  readonly #background: BullMqBerryQueueClient;
  readonly #legacy: BullMqBerryQueueClient;

  constructor(
    foregroundQueue: Queue | readonly Queue[] = createBerryQueue({ queueName: FOREGROUND_WORKER_QUEUE_NAME }),
    backgroundQueue: Queue = createBerryQueue({ queueName: BACKGROUND_WORKER_QUEUE_NAME }),
    legacyQueue: Queue = createBerryQueue({ queueName: LEGACY_WORKER_QUEUE_NAME }),
  ) {
    const foregroundQueues = Array.isArray(foregroundQueue) ? foregroundQueue : [foregroundQueue];
    if (foregroundQueues.length === 0) throw new Error("BullMqBerryQueueRouter requires a foreground queue");
    this.#foreground = foregroundQueues.map((queue) => new BullMqBerryQueueClient(queue));
    this.#background = new BullMqBerryQueueClient(backgroundQueue);
    this.#legacy = new BullMqBerryQueueClient(legacyQueue);
  }

  enqueue<Name extends BerryWorkerJobName>(
    name: Name,
    payload: BerryWorkerJobMap[Name],
    options: JobsOptions = {},
  ): Promise<{ id: string | undefined; name: Name }> {
    if (workerQueueKind(name) === "foreground") {
      return this.foregroundClient(name, payload).enqueue(name, payload, options);
    }
    return this.#background.enqueue(name, payload, options);
  }

  async close(): Promise<void> {
    await Promise.all([
      ...this.#foreground.map((client) => client.close()),
      this.#background.close(),
      this.#legacy.close(),
    ]);
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([
      ...this.#foreground.map((client) => client.waitUntilReady()),
      this.#background.waitUntilReady(),
      this.#legacy.waitUntilReady(),
    ]);
  }

  async ping(): Promise<void> {
    await Promise.all([
      ...this.#foreground.map((client) => client.ping()),
      this.#background.ping(),
      this.#legacy.ping(),
    ]);
  }

  async operationalMetrics(nowMs = Date.now()): Promise<BerryQueueOperationalMetrics[]> {
    const foreground = await Promise.all(
      this.#foreground.map((client) => client.operationalMetrics("foreground", nowMs)),
    );
    const foregroundMetrics = foreground.reduce<BerryQueueOperationalMetrics>((total, current) => ({
      queue: "foreground",
      waiting: total.waiting + current.waiting,
      active: total.active + current.active,
      failed: total.failed + current.failed,
      oldestWaitingSeconds: Math.max(total.oldestWaitingSeconds, current.oldestWaitingSeconds),
    }), { queue: "foreground", waiting: 0, active: 0, failed: 0, oldestWaitingSeconds: 0 });
    return Promise.all([
      Promise.resolve(foregroundMetrics),
      this.#background.operationalMetrics("background", nowMs),
      this.#legacy.operationalMetrics("legacy", nowMs),
    ]);
  }

  private foregroundClient<Name extends BerryWorkerJobName>(
    name: Name,
    payload: BerryWorkerJobMap[Name],
  ): BullMqBerryQueueClient {
    const runId = runIdForPayload(payload);
    const key = runId ?? deterministicJobId(name, payload);
    return this.#foreground[foregroundQueueShardForKey(key, this.#foreground.length)]!;
  }
}

export function deterministicJobId(name: BerryWorkerJobName, payload: BerryWorkerJobMap[BerryWorkerJobName]): string {
  const digest = createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex").slice(0, 32);
  return `${name.replaceAll(".", "-")}-${digest}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function createBerryQueue(options: { redisUrl?: string; queueName?: string } = {}): Queue {
  return new Queue(options.queueName ?? LEGACY_WORKER_QUEUE_NAME, {
    connection: createRedisConnection(options.redisUrl),
  });
}

export function createBerryQueueRouter(options: {
  redisUrl?: string;
  foregroundQueueName?: string;
  foregroundQueueShardCount?: number;
  backgroundQueueName?: string;
  legacyQueueName?: string;
} = {}): BullMqBerryQueueRouter {
  const connection = options.redisUrl ? { redisUrl: options.redisUrl } : {};
  const foregroundQueueShardCount = boundedQueueShardCount(options.foregroundQueueShardCount);
  const foregroundQueueName = options.foregroundQueueName ?? FOREGROUND_WORKER_QUEUE_NAME;
  return new BullMqBerryQueueRouter(
    Array.from({ length: foregroundQueueShardCount }, (_, shard) => createBerryQueue({
      ...connection,
      queueName: foregroundQueueNameForShard(foregroundQueueName, shard, foregroundQueueShardCount),
    })),
    createBerryQueue({ ...connection, queueName: options.backgroundQueueName ?? BACKGROUND_WORKER_QUEUE_NAME }),
    createBerryQueue({ ...connection, queueName: options.legacyQueueName ?? LEGACY_WORKER_QUEUE_NAME }),
  );
}

export function createBerryWorker(
  dependencies: BerryWorkerDependencies,
  options: {
    redisUrl?: string;
    queueName?: string;
    concurrency?: number;
    queueKind?: BerryWorkerQueueKind | "legacy";
    queueShard?: number;
    queueShardCount?: number;
  } = {},
): Worker {
  const queueKind = options.queueKind ?? "legacy";
  const queueShardCount = boundedQueueShardCount(options.queueShardCount);
  const queueName = options.queueName ?? queueNameForKind(queueKind, options.queueShard ?? 0, queueShardCount);
  const processor: Processor = async (job) => {
    if (queueKind !== "legacy" && workerQueueKind(job.name as BerryWorkerJobName) !== queueKind) {
      throw new Error(`Job ${job.name} was delivered to the ${queueKind} worker queue`);
    }
    try {
      return await processBerryWorkerJob(job.name, job.data, dependencies);
    } catch (error) {
      throw workerFailureForRetryPolicy(job.name, error);
    }
  };
  return new Worker(queueName, processor, {
    connection: createRedisConnection(options.redisUrl),
    concurrency: options.concurrency ?? 4,
  });
}

export function workerFailureForRetryPolicy(jobName: string, error: unknown): unknown {
  if (error instanceof CompactionTerminalError) {
    return new UnrecoverableError([
      `Non-retryable ${jobName} compaction failure`,
      `category=${error.failure.category}`,
      error.failure.status === null ? null : `status=${error.failure.status}`,
      error.failure.publicMessage,
    ].filter(Boolean).join(" "));
  }
  const failure = classifyProviderFailure(error);
  if (failure.retryable) return error;
  emitWorkerOperationalEvent(
    "provider.attempt",
    normalizeWorkerRole(process.env.BERRY_WORKER_ROLE),
    sourceRevisionFromEnv(process.env),
    {
      phase: "worker_job",
      category: failure.category,
      statusClass: failure.status === undefined ? "unknown" : String(failure.status),
      retryDecision: "not_retryable",
      outcome: "failed",
    },
  );
  return new UnrecoverableError([
    `Non-retryable ${jobName} provider failure`,
    failure.status ? `status=${failure.status}` : null,
    failure.code ? `code=${failure.code}` : null,
  ].filter(Boolean).join(" "));
}

function queueNameForKind(kind: BerryWorkerQueueKind | "legacy", shard = 0, shardCount = 1): string {
  if (kind === "foreground") return foregroundQueueNameForShard(FOREGROUND_WORKER_QUEUE_NAME, shard, shardCount);
  if (kind === "background") return BACKGROUND_WORKER_QUEUE_NAME;
  return LEGACY_WORKER_QUEUE_NAME;
}

export function foregroundQueueNameForShard(baseName: string, shard: number, shardCount: number): string {
  const count = boundedQueueShardCount(shardCount);
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= count) {
    throw new Error(`Foreground queue shard must be between 0 and ${count - 1}`);
  }
  // Keep shard zero on the original queue so a rolling deployment drains jobs
  // already present in berry-cloud-turns while new shards come online.
  return count === 1 || shard === 0 ? baseName : `${baseName}-${shard}`;
}

export function foregroundQueueShardForKey(key: string, shardCount: number): number {
  const count = boundedQueueShardCount(shardCount);
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) % count;
}

function runIdForPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const runId = (payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId : undefined;
}

function boundedQueueShardCount(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) {
    throw new Error("Foreground queue shard count must be an integer between 1 and 128");
  }
  return value;
}

function createRedisConnection(redisUrl = process.env.BERRY_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}
