import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from "bullmq";
import { WORKER_QUEUE_NAME, type BerryWorkerJobMap, type BerryWorkerJobName } from "./jobs.js";
import type { BerryWorkerDependencies } from "./processor.js";
import { processBerryWorkerJob } from "./processor.js";

export interface BerryQueueClient {
  enqueue<Name extends BerryWorkerJobName>(
    name: Name,
    payload: BerryWorkerJobMap[Name],
    options?: JobsOptions,
  ): Promise<{ id: string | undefined; name: Name }>;
  close(): Promise<void>;
}

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
}

export function createBerryQueue(options: { redisUrl?: string; queueName?: string } = {}): Queue {
  return new Queue(options.queueName ?? WORKER_QUEUE_NAME, {
    connection: createRedisConnection(options.redisUrl),
  });
}

export function createBerryWorker(
  dependencies: BerryWorkerDependencies,
  options: { redisUrl?: string; queueName?: string; concurrency?: number } = {},
): Worker {
  const processor: Processor = async (job) => processBerryWorkerJob(job.name, job.data, dependencies);
  return new Worker(options.queueName ?? WORKER_QUEUE_NAME, processor, {
    connection: createRedisConnection(options.redisUrl),
    concurrency: options.concurrency ?? 4,
  });
}

function createRedisConnection(redisUrl = process.env.BERRY_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}
