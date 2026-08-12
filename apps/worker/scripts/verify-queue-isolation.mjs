import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { BullMqBerryQueueRouter } from "../dist/bullmq.js";

const redisUrl = process.env.BERRY_TEST_REDIS_URL;
if (!redisUrl) throw new Error("BERRY_TEST_REDIS_URL is required");

const shapes = parseShapes(process.env.BERRY_TEST_FOREGROUND_SHAPES ?? "5x20,10x20");
const backgroundReplicas = positiveInteger("BERRY_TEST_BACKGROUND_REPLICAS", 1);
const backgroundConcurrency = positiveInteger("BERRY_TEST_BACKGROUND_CONCURRENCY", 4);
const backgroundJobs = positiveInteger("BERRY_TEST_BACKGROUND_JOBS", 506);
const minimumForegroundTurns = positiveInteger("BERRY_TEST_FOREGROUND_TURNS", 100);
const foregroundWorkMs = positiveInteger("BERRY_TEST_FOREGROUND_WORK_MS", 20);
const backgroundWorkMs = positiveInteger("BERRY_TEST_BACKGROUND_WORK_MS", 250);
const p95LimitMs = positiveInteger("BERRY_TEST_FOREGROUND_P95_LIMIT_MS", 1_000);
const timeoutMs = positiveInteger("BERRY_TEST_TIMEOUT_MS", 5_000);
const results = [];

for (const shape of shapes) {
  results.push(await verifyShape(shape));
}
console.log(JSON.stringify({ runs: results }));

async function verifyShape(shape) {
  const suffix = randomUUID();
  const foregroundName = `berry-test-turns-${shape.replicas}x${shape.concurrency}-${suffix}`;
  const backgroundName = `berry-test-background-${suffix}`;
  const legacyName = `berry-test-legacy-${suffix}`;
  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  const foregroundQueue = new Queue(foregroundName, { connection });
  const backgroundQueue = new Queue(backgroundName, { connection });
  const legacyQueue = new Queue(legacyName, { connection });
  const router = new BullMqBerryQueueRouter(foregroundQueue, backgroundQueue, legacyQueue);
  const foregroundLatencies = [];
  const foregroundTurns = Math.max(minimumForegroundTurns, shape.replicas * shape.concurrency);
  let backgroundStarted = 0;
  let resolveForeground;
  const foregroundDone = new Promise((resolve) => { resolveForeground = resolve; });

  const foregroundWorkers = Array.from({ length: shape.replicas }, () => new Worker(
    foregroundName,
    async (job) => {
      foregroundLatencies.push(Date.now() - job.data.submittedAt);
      await delay(foregroundWorkMs);
      if (foregroundLatencies.length === foregroundTurns) resolveForeground();
    },
    { connection, concurrency: shape.concurrency },
  ));
  const backgroundWorkers = Array.from({ length: backgroundReplicas }, () => new Worker(
    backgroundName,
    async () => {
      backgroundStarted += 1;
      await delay(backgroundWorkMs);
      throw new Error("controlled background provider failure");
    },
    { connection, concurrency: backgroundConcurrency },
  ));

  try {
    await Promise.all([
      foregroundQueue.waitUntilReady(),
      backgroundQueue.waitUntilReady(),
      ...foregroundWorkers.map((worker) => worker.waitUntilReady()),
      ...backgroundWorkers.map((worker) => worker.waitUntilReady()),
    ]);
    const tenantId = randomUUID();
    const memoryBase = {
      tenantId,
      userId: randomUUID(),
      workspaceId: randomUUID(),
      taskId: randomUUID(),
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      revision: "load-test",
      extractorVersion: "load-test",
      userText: "remember",
      assistantText: "acknowledged",
    };
    await Promise.all(Array.from({ length: backgroundJobs }, (_, index) => router.enqueue(
      "memory.extract",
      memoryBase,
      { jobId: `memory-${suffix}-${index}`, attempts: 1, removeOnFail: true },
    )));
    const submittedAt = Date.now();
    await Promise.all(Array.from({ length: foregroundTurns }, (_, index) => router.enqueue(
      "turn.execute",
      { tenantId, runId: randomUUID(), reason: "continue", submittedAt },
      { jobId: `turn-${suffix}-${index}`, attempts: 1, removeOnComplete: true },
    )));
    await Promise.race([
      foregroundDone,
      delay(timeoutMs).then(() => {
        throw new Error(`Foreground ${shape.replicas}x${shape.concurrency} load test exceeded ${timeoutMs}ms`);
      }),
    ]);
    const sorted = foregroundLatencies.toSorted((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    if (p95 === undefined || p95 >= p95LimitMs) {
      throw new Error(
        `Foreground ${shape.replicas}x${shape.concurrency} admission p95 ${p95 ?? "missing"}ms exceeded ${p95LimitMs}ms`,
      );
    }
    const foregroundCounts = await foregroundQueue.getJobCounts("waiting", "active", "completed", "failed");
    const backgroundCounts = await backgroundQueue.getJobCounts("waiting", "active", "completed", "failed");
    return {
      shape: `${shape.replicas}x${shape.concurrency}`,
      capacity: shape.replicas * shape.concurrency,
      foreground: { submitted: foregroundTurns, started: foregroundLatencies.length, p95Ms: p95, counts: foregroundCounts },
      background: {
        replicas: backgroundReplicas,
        concurrency: backgroundConcurrency,
        submitted: backgroundJobs,
        started: backgroundStarted,
        counts: backgroundCounts,
      },
    };
  } finally {
    await Promise.allSettled([
      ...foregroundWorkers.map((worker) => worker.close(true)),
      ...backgroundWorkers.map((worker) => worker.close(true)),
    ]);
    await Promise.allSettled([
      foregroundQueue.obliterate({ force: true }),
      backgroundQueue.obliterate({ force: true }),
      legacyQueue.obliterate({ force: true }),
    ]);
    await router.close();
  }
}

function parseShapes(raw) {
  const parsed = raw.split(",").map((item) => {
    const match = item.trim().match(/^(\d+)x(\d+)$/i);
    if (!match) throw new Error(`Invalid foreground worker shape: ${item}`);
    const replicas = Number(match[1]);
    const concurrency = Number(match[2]);
    if (!Number.isSafeInteger(replicas) || replicas < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error(`Foreground worker shape must use positive integers: ${item}`);
    }
    return { replicas, concurrency };
  });
  if (parsed.length === 0) throw new Error("At least one foreground worker shape is required");
  return parsed;
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
