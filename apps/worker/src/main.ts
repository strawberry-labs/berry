import { createBerryWorker } from "./bullmq.ts";
import { PgSqlExecutor } from "./pg-executor.ts";
import { SqlManagementJobRepository, SqlTaskTitleRepository, SqlUsageRollupRepository } from "./sql-repositories.ts";

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const executor = PgSqlExecutor.fromConnectionString(databaseUrl);
  const redisUrl = env.BERRY_REDIS_URL ?? env.REDIS_URL;
  const workerOptions = redisUrl
    ? { redisUrl, concurrency: Number(env.BERRY_WORKER_CONCURRENCY ?? 4) }
    : { concurrency: Number(env.BERRY_WORKER_CONCURRENCY ?? 4) };
  const worker = createBerryWorker({
    titles: new SqlTaskTitleRepository(executor),
    usage: new SqlUsageRollupRepository(executor),
    management: new SqlManagementJobRepository(executor),
    compactor: {
      compactSession: async (input) => ({
        sessionId: input.sessionId,
        summary: "Self-host worker compaction runner is configured; model-backed compaction is delegated by the API runtime.",
        tokensBefore: 0,
      }),
    },
  }, workerOptions);

  const shutdown = async () => {
    await worker.close();
    await executor.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
