import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createPersonalMemoryProviderFromEnv } from "@berry/personal-memory";
import { BullMqBerryQueueClient, createBerryQueue, createBerryWorker } from "./bullmq.ts";
import { durableContextConfigFromEnv } from "@berry/shared";
import { PgSqlExecutor } from "./pg-executor.ts";
import { SqlManagementJobRepository, SqlTaskTitleRepository, SqlUsageRollupRepository } from "./sql-repositories.ts";
import { KnowledgeProcessor } from "./knowledge/processor.ts";
import { SqlKnowledgeRepository } from "./knowledge/repository.ts";
import { DocumentExtractor, KnowledgeChunker, S3KnowledgeObjectStore, createEmbeddingProviderFromEnv, type KnowledgeObjectStore } from "./knowledge/services.ts";
import { RuntimeOutboxDispatcher } from "./outbox.ts";
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

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const durableConfig = durableContextConfigFromEnv(env);
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const executor = PgSqlExecutor.fromConnectionString(databaseUrl);
  const redisUrl = env.BERRY_REDIS_URL ?? env.REDIS_URL;
  const workerOptions = redisUrl
    ? { redisUrl, concurrency: Number(env.BERRY_WORKER_CONCURRENCY ?? 4) }
    : { concurrency: Number(env.BERRY_WORKER_CONCURRENCY ?? 4) };
  const queueOptions = redisUrl ? { redisUrl } : {};
  const queue = new BullMqBerryQueueClient(createBerryQueue(queueOptions));
  const sandboxContinuity = new SandboxContinuityManager(
    createWorkerSandboxProvider(env),
    new SqlSandboxSnapshotRepository(executor),
    S3SandboxSnapshotObjectStore.fromEnv(env),
    {
      image: env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm",
      cwd: env.BERRY_SANDBOX_CWD ?? "/workspace",
      ttlSeconds: Math.min(positiveInteger(env.BERRY_SANDBOX_TTL_SECONDS) ?? 300, 300),
      maxInputBytes: durableConfig.sandboxInputMaxBytes,
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
    extractor: new DocumentExtractor(durableConfig.tikaUrl, {
      timeoutMs: 60_000,
      maxInputBytes: durableConfig.knowledgeMaxInputBytes,
      maxOutputBytes: durableConfig.knowledgeMaxOutputBytes,
    }),
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
  const memoryTools = new DurablePersonalMemoryToolExecutor(
    sandboxContinuity,
    memoryRepository,
    personalMemory,
    durableConfig.memoryEnabled,
  );
  const durableTools = createDurableTurnToolsFromEnv(env, memoryTools);
  const fileDeleter = S3FileObjectDeleter.fromEnv(env, new SqlFileDeletionReceiptStore(executor));
  const fileBlobs = SqlFileBlobProcessor.fromEnv(env, executor);
  const worker = createBerryWorker({
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
      new SqlDurableTurnRepository(executor),
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
        compactor,
      },
    ),
    snapshotter: sandboxContinuity,
    maintenance: new SqlMaintenanceRunner(executor),
    ...(fileDeleter ? { fileDeleter } : {}),
    ...(fileBlobs ? { fileBlobs } : {}),
    tenantContext: {
      run: (tenantId, callback) => executor.runWithTenant(tenantId, callback),
    },
  }, workerOptions);
  const outbox = new RuntimeOutboxDispatcher(executor, queue, {
    ...(env.BERRY_TENANT_ID ? { tenantId: env.BERRY_TENANT_ID } : {}),
    workerId: `${hostname()}:${process.pid}:${randomUUID()}`,
    pollMs: positiveInteger(env.BERRY_OUTBOX_POLL_MS) ?? 100,
  });
  outbox.start();

  const shutdown = async () => {
    await outbox.stop();
    await queue.close();
    await worker.close();
    await durableTools.close();
    await executor.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
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
  bootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
