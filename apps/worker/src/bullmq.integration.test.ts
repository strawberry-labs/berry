import { randomUUID } from "node:crypto";
import { QueueEvents, type Queue, type Worker } from "bullmq";
import { RouterClientError } from "@berry/router-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BullMqBerryQueueClient,
  createBerryQueue,
  createBerryWorker,
} from "./bullmq.js";
import type { BerryWorkerDependencies } from "./processor.js";

const redisUrl = process.env.BERRY_TEST_REDIS_URL?.trim();
const integration = redisUrl ? describe : describe.skip;

integration("BullMQ provider retry policy", () => {
  const queueName = `berry-provider-retry-${randomUUID()}`;
  let queue: Queue;
  let client: BullMqBerryQueueClient;
  let events: QueueEvents;
  let worker: Worker;
  let memoryProcessingAttempts = 0;
  let titleProcessingAttempts = 0;

  beforeAll(async () => {
    queue = createBerryQueue({ redisUrl: redisUrl!, queueName });
    client = new BullMqBerryQueueClient(queue);
    events = new QueueEvents(queueName, {
      connection: { url: redisUrl!, maxRetriesPerRequest: null },
    });
    worker = createBerryWorker({
      titles: {
        async updateTaskTitle() {
          throw new Error("A rejected title must not be persisted");
        },
      },
      compactor: {} as BerryWorkerDependencies["compactor"],
      usage: {} as BerryWorkerDependencies["usage"],
      titleGenerator: {
        async generateTitle() {
          titleProcessingAttempts += 1;
          throw new RouterClientError("Provider rejected title request", 400, "sensitive title body", {
            code: "invalid_request",
            requestId: "router-title-400",
          });
        },
      },
      memory: {
        async process() {
          memoryProcessingAttempts += 1;
          throw new RouterClientError("Provider rejected memory tool call", 400, "sensitive body", {
            code: "invalid_request",
            requestId: "router-memory-400",
          });
        },
      } as unknown as BerryWorkerDependencies["memory"],
    }, {
      redisUrl: redisUrl!,
      queueName,
      queueKind: "background",
      concurrency: 1,
    });
    await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await client.close();
  });

  it("attempts a provider 400 memory job exactly once even when attempts is three", async () => {
    const jobId = `memory-400-${randomUUID()}`;
    const enqueued = await client.enqueue("memory.extract", {
      tenantId: "00000000-0000-7000-8000-000000000001",
      userId: "00000000-0000-7000-8000-000000000002",
      workspaceId: "00000000-0000-7000-8000-000000000003",
      taskId: "00000000-0000-7000-8000-000000000004",
      sessionId: "00000000-0000-7000-8000-000000000005",
      userMessageId: "00000000-0000-7000-8000-000000000006",
      assistantMessageId: "00000000-0000-7000-8000-000000000007",
      revision: "retry-policy-v1",
      extractorVersion: "memory-extractor-v1",
      userText: "Remember this preference",
      assistantText: "Saved",
    }, { jobId, attempts: 3 });

    const job = await queue.getJob(enqueued.id!);
    await expect(job!.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "Non-retryable memory.extract provider failure",
    );
    const failed = await queue.getJob(jobId);
    expect(memoryProcessingAttempts).toBe(1);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.opts.attempts).toBe(3);
    expect(failed?.failedReason).not.toContain("sensitive body");
  }, 15_000);

  it("attempts a provider 400 non-memory job exactly once even when attempts is three", async () => {
    const jobId = `title-400-${randomUUID()}`;
    const enqueued = await client.enqueue("title.generate", {
      tenantId: "00000000-0000-7000-8000-000000000001",
      taskId: "task-provider-400",
      sourceText: "Generate a title using the provider",
    }, { jobId, attempts: 3 });

    const job = await queue.getJob(enqueued.id!);
    await expect(job!.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "Non-retryable title.generate provider failure",
    );
    const failed = await queue.getJob(jobId);
    expect(titleProcessingAttempts).toBe(1);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.opts.attempts).toBe(3);
    expect(failed?.failedReason).not.toContain("sensitive title body");
  }, 15_000);
});
