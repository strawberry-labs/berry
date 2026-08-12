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
import type { BerryWorkerDependencies } from "./processor.js";
import { processBerryWorkerJob } from "./processor.js";
import { classifyProviderFailure } from "./provider-retry.js";

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
  readonly #foreground: BullMqBerryQueueClient;
  readonly #background: BullMqBerryQueueClient;
  readonly #legacy: BullMqBerryQueueClient;

  constructor(
    foregroundQueue: Queue = createBerryQueue({ queueName: FOREGROUND_WORKER_QUEUE_NAME }),
    backgroundQueue: Queue = createBerryQueue({ queueName: BACKGROUND_WORKER_QUEUE_NAME }),
    legacyQueue: Queue = createBerryQueue({ queueName: LEGACY_WORKER_QUEUE_NAME }),
  ) {
    this.#foreground = new BullMqBerryQueueClient(foregroundQueue);
    this.#background = new BullMqBerryQueueClient(backgroundQueue);
    this.#legacy = new BullMqBerryQueueClient(legacyQueue);
  }

  enqueue<Name extends BerryWorkerJobName>(
    name: Name,
    payload: BerryWorkerJobMap[Name],
    options: JobsOptions = {},
  ): Promise<{ id: string | undefined; name: Name }> {
    return this.client(workerQueueKind(name)).enqueue(name, payload, options);
  }

  async close(): Promise<void> {
    await Promise.all([this.#foreground.close(), this.#background.close(), this.#legacy.close()]);
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([
      this.#foreground.waitUntilReady(),
      this.#background.waitUntilReady(),
      this.#legacy.waitUntilReady(),
    ]);
  }

  async ping(): Promise<void> {
    await Promise.all([this.#foreground.ping(), this.#background.ping(), this.#legacy.ping()]);
  }

  async operationalMetrics(nowMs = Date.now()): Promise<BerryQueueOperationalMetrics[]> {
    return Promise.all([
      this.#foreground.operationalMetrics("foreground", nowMs),
      this.#background.operationalMetrics("background", nowMs),
      this.#legacy.operationalMetrics("legacy", nowMs),
    ]);
  }

  private client(kind: BerryWorkerQueueKind): BullMqBerryQueueClient {
    return kind === "foreground" ? this.#foreground : this.#background;
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
  backgroundQueueName?: string;
  legacyQueueName?: string;
} = {}): BullMqBerryQueueRouter {
  const connection = options.redisUrl ? { redisUrl: options.redisUrl } : {};
  return new BullMqBerryQueueRouter(
    createBerryQueue({ ...connection, queueName: options.foregroundQueueName ?? FOREGROUND_WORKER_QUEUE_NAME }),
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
  } = {},
): Worker {
  const queueKind = options.queueKind ?? "legacy";
  const queueName = options.queueName ?? queueNameForKind(queueKind);
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
  const failure = classifyProviderFailure(error);
  if (failure.retryable) return error;
  const diagnostics = {
    event: "berry.worker.provider_failure",
    jobName,
    retryable: false,
    category: failure.category,
    status: failure.status ?? null,
    code: failure.code ?? null,
    requestId: failure.requestId ?? null,
  };
  console.warn(JSON.stringify(diagnostics));
  return new UnrecoverableError([
    `Non-retryable ${jobName} provider failure`,
    failure.status ? `status=${failure.status}` : null,
    failure.code ? `code=${failure.code}` : null,
    failure.requestId ? `requestId=${failure.requestId}` : null,
  ].filter(Boolean).join(" "));
}

function queueNameForKind(kind: BerryWorkerQueueKind | "legacy"): string {
  if (kind === "foreground") return FOREGROUND_WORKER_QUEUE_NAME;
  if (kind === "background") return BACKGROUND_WORKER_QUEUE_NAME;
  return LEGACY_WORKER_QUEUE_NAME;
}

function createRedisConnection(redisUrl = process.env.BERRY_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}
