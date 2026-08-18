import { lookup } from "node:dns/promises";
import { hostname, networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { createPersonalMemoryProviderFromEnv } from "@berry/personal-memory";
import { createBerryQueueRouter, createBerryWorker, foregroundQueueNameForShard } from "./bullmq.ts";
import { FOREGROUND_WORKER_QUEUE_NAME } from "./jobs.ts";
import {
  durableContextConfigFromEnv,
  normalizeWorkerRole,
  operationalLogPolicyFromEnv,
  sourceRevisionFromEnv,
} from "@berry/shared";
import { PgSqlExecutor } from "./pg-executor.ts";
import { SqlManagementJobRepository, SqlTaskTitleRepository, SqlUsageRollupRepository } from "./sql-repositories.ts";
import { KnowledgeProcessor } from "./knowledge/processor.ts";
import { SqlKnowledgeRepository } from "./knowledge/repository.ts";
import { DocumentExtractor, KnowledgeChunker, S3KnowledgeObjectStore, createEmbeddingProviderFromEnv, type KnowledgeObjectStore } from "./knowledge/services.ts";
import { RuntimeOutboxDispatcher, SqlRuntimeOutboxDeliveryReceipts } from "./outbox.ts";
import { emitWorkerOperationalEvent } from "./operational-telemetry.ts";
import { createMemoryOperationGenerator } from "./memory/generator.ts";
import { MemoryProcessor } from "./memory/processor.ts";
import { SqlWorkerMemoryRepository } from "./memory/repository.ts";
import { DurablePersonalMemoryToolExecutor } from "./memory/tools.ts";
import {
  createCheckpointGenerator,
  DurableSessionCompactor,
  SqlSessionCompactionRepository,
} from "./compaction.ts";
import {
  createDurableTurnModel,
  DurableTurnRunner,
  SqlDurableTurnRepository,
} from "./turn-runner.ts";
import {
  createWorkerSandboxProvider,
  S3SandboxSnapshotObjectStore,
  SandboxContinuityManager,
  SqlSandboxSnapshotRepository,
} from "./sandbox-continuity.ts";
import { SqlMaintenanceRunner } from "./maintenance.ts";
import { createDurableTurnToolsFromEnv } from "./mcp-tools.ts";
import { S3FileObjectDeleter, SqlFileDeletionReceiptStore } from "./file-deletion.ts";
import { SqlFileBlobProcessor } from "./file-blobs.ts";
import {
  closeServer,
  startWorkerReadinessServer,
  WorkerProcessActivityTracker,
} from "./readiness.ts";
import { DurableVisionToolExecutor, SqlVisionObservationCache } from "./vision-tools.ts";
import { DurablePersonalSkillToolExecutor } from "./personal-skills/tools.ts";
import {
  ActiveTurnCancellationRegistry,
  TurnCancellationSubscriber,
} from "./turn-cancellation.ts";

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configuredProcess = workerProcessConfigFromEnv(env);
  const processConfig = configuredProcess.foregroundQueueShardCount > 1
    && (configuredProcess.role === "foreground" || configuredProcess.role === "all")
    ? {
        ...configuredProcess,
        foregroundQueueShardIndex: await resolveForegroundQueueShardIndex(
          env,
          configuredProcess.foregroundQueueShardCount,
        ),
      }
    : configuredProcess;
  const workerRole = normalizeWorkerRole(processConfig.role);
  const sourceRevision = sourceRevisionFromEnv(env);
  // The container/runtime owns rotation; parsing the same bounded policy here
  // makes the retention contract explicit for non-Compose deployments too.
  operationalLogPolicyFromEnv(env);
  const durableConfig = durableContextConfigFromEnv(env);
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const executor = PgSqlExecutor.fromConnectionString(databaseUrl, { max: processConfig.databasePoolMax });
  const redisUrl = env.BERRY_REDIS_URL ?? env.REDIS_URL;
  const resolvedRedisUrl = redisUrl ?? "redis://127.0.0.1:6379";
  const turnCancellations = new ActiveTurnCancellationRegistry();
  const cancellationSubscriber = new TurnCancellationSubscriber(resolvedRedisUrl, turnCancellations);
  const queue = createBerryQueueRouter({
    ...(redisUrl ? { redisUrl } : {}),
    ...(env.BERRY_FOREGROUND_QUEUE_NAME?.trim() ? { foregroundQueueName: env.BERRY_FOREGROUND_QUEUE_NAME.trim() } : {}),
    foregroundQueueShardCount: processConfig.foregroundQueueShardCount,
    ...(env.BERRY_BACKGROUND_QUEUE_NAME?.trim() ? { backgroundQueueName: env.BERRY_BACKGROUND_QUEUE_NAME.trim() } : {}),
    ...(env.BERRY_LEGACY_QUEUE_NAME?.trim() ? { legacyQueueName: env.BERRY_LEGACY_QUEUE_NAME.trim() } : {}),
  });
  const documentExtractor = new DocumentExtractor(durableConfig.tikaUrl, {
    timeoutMs: 60_000,
    maxInputBytes: durableConfig.knowledgeMaxInputBytes,
    maxOutputBytes: durableConfig.knowledgeMaxOutputBytes,
  });
  const sandboxContinuity = new SandboxContinuityManager(
    createWorkerSandboxProvider(env),
    new SqlSandboxSnapshotRepository(executor),
    S3SandboxSnapshotObjectStore.fromEnv(env),
    {
      image: env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm",
      cwd: env.BERRY_SANDBOX_CWD ?? "/workspace",
      ttlSeconds: Math.min(positiveInteger(env.BERRY_SANDBOX_TTL_SECONDS) ?? 300, 300),
      maxInputBytes: durableConfig.sandboxInputMaxBytes,
      documentTextExtractor: (input) => documentExtractor.extract(input),
      enableTerminalFinalization: env.BERRY_TERMINAL_FINALIZATION_ENABLED?.trim().toLowerCase() === "true",
      ...(env.BERRY_ROUTER_INFERENCE_BASE_URL?.trim() && env.BERRY_ROUTER_IMAGE_MODEL?.trim()
        ? {
            imageGeneration: {
              endpoint: env.BERRY_ROUTER_IMAGE_GENERATIONS_URL?.trim()
                || joinRouterUrl(env.BERRY_ROUTER_INFERENCE_BASE_URL, env.BERRY_ROUTER_IMAGE_GENERATIONS_PATH || "/images/generations"),
              editsEndpoint: env.BERRY_ROUTER_IMAGE_EDITS_URL?.trim()
                || joinRouterUrl(env.BERRY_ROUTER_INFERENCE_BASE_URL, env.BERRY_ROUTER_IMAGE_EDITS_PATH || "/images/edits"),
              ...(env.BERRY_ROUTER_API_KEY?.trim() ? { apiKey: env.BERRY_ROUTER_API_KEY.trim() } : {}),
              model: env.BERRY_ROUTER_IMAGE_MODEL.trim(),
              responseFormat: env.BERRY_ROUTER_IMAGE_RESPONSE_FORMAT === "url" ? "url" as const : "b64_json" as const,
            },
          }
        : {}),
    },
  );
  const knowledge = new KnowledgeProcessor({
    repository: new SqlKnowledgeRepository(executor),
    objects: knowledgeObjectStore(env),
    extractor: documentExtractor,
    chunker: new KnowledgeChunker(durableConfig.knowledgeChunkTokens, durableConfig.knowledgeChunkOverlapTokens),
    embeddings: createEmbeddingProviderFromEnv(env, {
      provider: durableConfig.embeddingProvider,
      model: durableConfig.embeddingModel,
      dimensions: durableConfig.embeddingDimensions,
      version: durableConfig.embeddingProfileVersion,
    }),
  });
  const compactor = new DurableSessionCompactor(
    new SqlSessionCompactionRepository(executor),
    createCheckpointGenerator(env),
    {
      leaseOwner: `${hostname()}:${process.pid}:${randomUUID()}:compactor`,
      leaseSeconds: durableConfig.runLeaseSeconds,
      fallbackProvider: env.BERRY_COMPACTION_PROVIDER ?? "deterministic",
      fallbackModel: env.BERRY_COMPACTION_MODEL ?? "checkpoint-v2",
    },
  );
  const personalMemory = createPersonalMemoryProviderFromEnv(env);
  const memoryRepository = new SqlWorkerMemoryRepository(executor);
  const visionTools = new DurableVisionToolExecutor(
    sandboxContinuity,
    new SqlVisionObservationCache(executor),
    env,
  );
  const memoryTools = new DurablePersonalMemoryToolExecutor(
    visionTools,
    memoryRepository,
    personalMemory,
    durableConfig.memoryEnabled,
  );
  const personalSkillTools = new DurablePersonalSkillToolExecutor(memoryTools, executor);
  const durableTools = createDurableTurnToolsFromEnv(env, personalSkillTools);
  const fileDeleter = S3FileObjectDeleter.fromEnv(env, new SqlFileDeletionReceiptStore(executor));
  const fileBlobs = SqlFileBlobProcessor.fromEnv(env, executor);
  const dependencies: Parameters<typeof createBerryWorker>[0] = {
    titles: new SqlTaskTitleRepository(executor),
    usage: new SqlUsageRollupRepository(executor),
    management: new SqlManagementJobRepository(executor),
    knowledge,
    memory: new MemoryProcessor(
      memoryRepository,
      createMemoryOperationGenerator(env),
      personalMemory,
      {
        memoryEnabled: durableConfig.memoryEnabled,
        implicitMemoryEnabled: durableConfig.implicitMemoryEnabled,
      },
    ),
    compactor,
    turnRunner: new DurableTurnRunner(
      new SqlDurableTurnRepository(executor, { workerRole, sourceRevision }),
      createDurableTurnModel(env),
      durableTools,
      {
        owner: `${hostname()}:${process.pid}:${randomUUID()}:turn`,
        leaseSeconds: durableConfig.runLeaseSeconds,
        snapshotIntervalSeconds: durableConfig.sandboxSnapshotIntervalSeconds,
        modelIdleTimeoutMs: Math.min(
          positiveInteger(env.BERRY_MODEL_IDLE_TIMEOUT_MS) ?? 240_000,
          300_000,
        ),
        modelMaxDurationMs: Math.min(
          positiveInteger(env.BERRY_MODEL_MAX_DURATION_MS) ?? 900_000,
          1_800_000,
        ),
        maxModelIterations: Math.min(
          positiveInteger(env.BERRY_MAX_MODEL_ITERATIONS) ?? 200,
          200,
        ),
        maxTurnDurationMs: Math.min(
          positiveInteger(env.BERRY_MAX_TURN_DURATION_MS) ?? 7_200_000,
          21_600_000,
        ),
        modelPreparationTimeoutMs: Math.min(
          positiveInteger(env.BERRY_MODEL_PREPARATION_TIMEOUT_MS) ?? 120_000,
          300_000,
        ),
        compactor,
        cancellations: turnCancellations,
        workerRole,
        sourceRevision,
      },
    ),
    snapshotter: sandboxContinuity,
    maintenance: new SqlMaintenanceRunner(executor),
    ...(fileDeleter ? { fileDeleter } : {}),
    ...(fileBlobs ? { fileBlobs } : {}),
    outboxReceipts: new SqlRuntimeOutboxDeliveryReceipts(executor, { workerRole, sourceRevision }),
    tenantContext: {
      run: (tenantId, callback) => executor.runWithTenant(tenantId, callback),
    },
  };
  const workers: ReturnType<typeof createBerryWorker>[] = [];
  const workerActivity = new WorkerProcessActivityTracker(processConfig.role);
  const addWorker = (worker: ReturnType<typeof createBerryWorker>): void => {
    workers.push(worker);
    workerActivity.observe(worker);
  };
  const commonWorkerOptions = redisUrl ? { redisUrl } : {};
  if (processConfig.role === "foreground" || processConfig.role === "all") {
    addWorker(createBerryWorker(dependencies, {
      ...commonWorkerOptions,
      queueKind: "foreground",
      concurrency: processConfig.foregroundConcurrency,
      queueShard: processConfig.foregroundQueueShardIndex,
      queueShardCount: processConfig.foregroundQueueShardCount,
      queueName: foregroundQueueNameForShard(
        env.BERRY_FOREGROUND_QUEUE_NAME?.trim() || FOREGROUND_WORKER_QUEUE_NAME,
        processConfig.foregroundQueueShardIndex,
        processConfig.foregroundQueueShardCount,
      ),
    }));
  }
  if (processConfig.role === "background" || processConfig.role === "all") {
    addWorker(createBerryWorker(dependencies, {
      ...commonWorkerOptions,
      queueKind: "background",
      concurrency: processConfig.backgroundConcurrency,
      ...(env.BERRY_BACKGROUND_QUEUE_NAME?.trim() ? { queueName: env.BERRY_BACKGROUND_QUEUE_NAME.trim() } : {}),
    }));
    if (processConfig.drainLegacyQueue) {
      addWorker(createBerryWorker(dependencies, {
        ...commonWorkerOptions,
        queueKind: "legacy",
        concurrency: processConfig.legacyConcurrency,
        ...(env.BERRY_LEGACY_QUEUE_NAME?.trim() ? { queueName: env.BERRY_LEGACY_QUEUE_NAME.trim() } : {}),
      }));
    }
  }
  // Dispatching is safe to replicate: PostgreSQL row locks, durable delivery
  // receipts, and deterministic BullMQ job IDs prevent duplicate delivery.
  // Every worker pool participates so a background-worker outage cannot leave
  // foreground capacity idle with turns stranded in the runtime outbox.
  const outbox = env.BERRY_OUTBOX_DISPATCH_ENABLED?.trim().toLowerCase() === "false"
    ? null
    : new RuntimeOutboxDispatcher(executor, queue, {
        ...(env.BERRY_TENANT_ID ? { tenantId: env.BERRY_TENANT_ID } : {}),
        workerId: `${hostname()}:${process.pid}:${randomUUID()}`,
        workerRole,
        sourceRevision,
        pollMs: positiveInteger(env.BERRY_OUTBOX_POLL_MS) ?? 250,
        enableWaitExpiry: env.BERRY_WAIT_EXPIRY_ENABLED?.trim().toLowerCase() === "true",
        enableTerminalFinalization: env.BERRY_TERMINAL_FINALIZATION_ENABLED?.trim().toLowerCase() === "true",
      });
  await Promise.all([
    executor.query("SELECT 1"),
    queue.waitUntilReady(),
    cancellationSubscriber.start(),
    ...workers.map((worker) => worker.waitUntilReady()),
  ]);
  outbox?.start();
  const readinessPort = positiveInteger(env.BERRY_WORKER_READINESS_PORT) ?? 3010;
  const workersAreRunning = (): boolean => workers.length > 0 && workers.every((worker) => worker.isRunning());
  const readinessServer = await startWorkerReadinessServer({
    pingDatabase: () => executor.query("SELECT 1"),
    pingQueue: () => queue.ping(),
    isWorkerRunning: workersAreRunning,
    collectMetrics: async () => ({
      queues: await queue.operationalMetrics(),
      process: workerActivity.snapshot(workersAreRunning()),
    }),
  }, readinessPort, env.BERRY_WORKER_READINESS_HOST?.trim() || "127.0.0.1");

  const shutdown = async () => {
    await closeServer(readinessServer);
    await outbox?.stop();
    await Promise.all(workers.map((worker) => worker.close()));
    await cancellationSubscriber.close();
    await queue.close();
    await durableTools.close();
    await executor.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

export type BerryWorkerProcessRole = "foreground" | "background" | "all";

export type BerryWorkerProcessConfig = {
  role: BerryWorkerProcessRole;
  foregroundConcurrency: number;
  backgroundConcurrency: number;
  legacyConcurrency: number;
  foregroundQueueShardCount: number;
  foregroundQueueShardIndex: number;
  drainLegacyQueue: boolean;
  databasePoolMax: number;
};

export function workerProcessConfigFromEnv(env: NodeJS.ProcessEnv): BerryWorkerProcessConfig {
  const rawRole = env.BERRY_WORKER_ROLE?.trim() || "all";
  if (rawRole !== "foreground" && rawRole !== "background" && rawRole !== "all") {
    throw new Error("BERRY_WORKER_ROLE must be foreground, background, or all");
  }
  const role: BerryWorkerProcessRole = rawRole;
  const foregroundQueueShardCount = foregroundQueueShardCountFromEnv(env);
  const foregroundQueueShardIndex = role === "foreground" || role === "all"
    ? foregroundQueueShardIndexFromEnv(env, foregroundQueueShardCount, true)
    : 0;
  const sharedConcurrency = positiveInteger(env.BERRY_WORKER_CONCURRENCY);
  const foregroundConcurrency = positiveInteger(env.BERRY_FOREGROUND_WORKER_CONCURRENCY)
    ?? sharedConcurrency
    ?? (role === "foreground" ? 20 : 4);
  const backgroundConcurrency = positiveInteger(env.BERRY_BACKGROUND_WORKER_CONCURRENCY)
    ?? sharedConcurrency
    ?? 4;
  const legacyConcurrency = positiveInteger(env.BERRY_LEGACY_WORKER_CONCURRENCY) ?? 1;
  const rolePoolMax = role === "foreground"
    ? positiveInteger(env.BERRY_FOREGROUND_WORKER_DB_POOL_MAX)
    : role === "background"
      ? positiveInteger(env.BERRY_BACKGROUND_WORKER_DB_POOL_MAX)
      : undefined;
  return {
    role,
    foregroundConcurrency,
    backgroundConcurrency,
    legacyConcurrency,
    foregroundQueueShardCount,
    foregroundQueueShardIndex,
    drainLegacyQueue: env.BERRY_LEGACY_QUEUE_DRAIN?.trim().toLowerCase() !== "false",
    databasePoolMax: positiveInteger(env.BERRY_WORKER_DB_POOL_MAX) ?? rolePoolMax ?? 10,
  };
}

export function foregroundQueueShardIndexFromEnv(
  env: NodeJS.ProcessEnv,
  shardCount: number,
  allowUnresolved = false,
): number {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 128) {
    throw new Error("BERRY_FOREGROUND_QUEUE_SHARD_COUNT must be an integer between 1 and 128");
  }
  const explicit = env.BERRY_FOREGROUND_QUEUE_SHARD_INDEX?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed < shardCount) return parsed;
    throw new Error(`BERRY_FOREGROUND_QUEUE_SHARD_INDEX must be between 0 and ${shardCount - 1}`);
  }
  if (shardCount === 1) return 0;
  if (allowUnresolved) return 0;
  const runtimeName = env.HOSTNAME?.trim() || hostname();
  throw new Error(
    `Unable to determine foreground queue shard for ${runtimeName}; set BERRY_FOREGROUND_QUEUE_SHARD_INDEX explicitly or configure the foreground service DNS name`,
  );
}

function foregroundQueueShardCountFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.BERRY_FOREGROUND_QUEUE_SHARD_COUNT?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 128) {
    throw new Error("BERRY_FOREGROUND_QUEUE_SHARD_COUNT must be an integer between 1 and 128");
  }
  return parsed;
}

export async function resolveForegroundQueueShardIndex(
  env: NodeJS.ProcessEnv,
  shardCount: number,
): Promise<number> {
  // An explicit index is authoritative. Do not hide a typo by silently
  // falling back to a DNS-derived assignment.
  if (env.BERRY_FOREGROUND_QUEUE_SHARD_INDEX?.trim()) {
    return foregroundQueueShardIndexFromEnv(env, shardCount);
  }
  try {
    return foregroundQueueShardIndexFromEnv(env, shardCount);
  } catch (error) {
    const serviceName = env.BERRY_FOREGROUND_QUEUE_DNS_NAME?.trim() || "worker-foreground";
    const records = await lookup(serviceName, { all: true, verbatim: false }).catch(() => []);
    const addresses = [...new Set(records.map((record) => record.address))].sort();
    const ownAddresses = Object.values(networkInterfaces())
      .flatMap((interfaces) => interfaces ?? [])
      .filter((entry) => !entry.internal)
      .map((entry) => entry.address);
    // A partial DNS answer during a rolling/startup window is not enough to
    // assign ownership: two containers could both choose shard zero. Let the
    // supervisor restart this process once every replica is discoverable.
    if (addresses.length !== shardCount) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; DNS ${serviceName} returned ${addresses.length} addresses, expected ${shardCount} foreground replicas`,
      );
    }
    const ownAddress = ownAddresses.find((address) => addresses.includes(address));
    const index = ownAddress === undefined ? -1 : addresses.indexOf(ownAddress);
    if (index >= 0 && index < shardCount) return index;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; DNS ${serviceName} did not identify this worker among ${shardCount} foreground replicas`,
    );
  }
}

function knowledgeObjectStore(env: NodeJS.ProcessEnv): KnowledgeObjectStore {
  try {
    return S3KnowledgeObjectStore.fromEnv(env);
  } catch (configurationError) {
    const fail = async (): Promise<never> => {
      throw configurationError;
    };
    return { read: fail, write: fail };
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function joinRouterUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch(() => {
    emitWorkerOperationalEvent(
      "phase.transition",
      normalizeWorkerRole(process.env.BERRY_WORKER_ROLE),
      sourceRevisionFromEnv(process.env),
      { phase: "bootstrap", outcome: "failed" },
    );
    process.exitCode = 1;
  });
}
