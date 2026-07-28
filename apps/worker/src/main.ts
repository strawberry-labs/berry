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
      ttlSeconds: Number(env.BERRY_SANDBOX_TTL_SECONDS ?? 3600),
    },
  );
  const knowledge = new KnowledgeProcessor({
    repository: new SqlKnowledgeRepository(executor),
    objects: knowledgeObjectStore(env),
    extractor: new DocumentExtractor(durableConfig.tikaUrl),
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
  const worker = createBerryWorker({
    titles: new SqlTaskTitleRepository(executor),
    usage: new SqlUsageRollupRepository(executor),
    management: new SqlManagementJobRepository(executor),
    knowledge,
    memory: new MemoryProcessor(
      new SqlWorkerMemoryRepository(executor),
      createMemoryOperationGenerator(env),
      createPersonalMemoryProviderFromEnv(env),
    ),
    compactor,
    turnRunner: new DurableTurnRunner(
      new SqlDurableTurnRepository(executor),
      createDurableTurnModel(env),
      sandboxContinuity,
      {
        owner: `${hostname()}:${process.pid}:${randomUUID()}:turn`,
        leaseSeconds: durableConfig.runLeaseSeconds,
        snapshotIntervalSeconds: durableConfig.sandboxSnapshotIntervalSeconds,
        compactionTriggerTokens: durableConfig.compactionTriggerTokens,
        compactor,
      },
    ),
    snapshotter: sandboxContinuity,
    maintenance: new SqlMaintenanceRunner(executor),
  }, workerOptions);
  const outbox = new RuntimeOutboxDispatcher(executor, queue, {
    tenantId: env.BERRY_TENANT_ID ?? "00000000-0000-7000-8000-000000000001",
    workerId: `${hostname()}:${process.pid}:${randomUUID()}`,
  });
  outbox.start();

  const shutdown = async () => {
    await outbox.stop();
    await queue.close();
    await worker.close();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
