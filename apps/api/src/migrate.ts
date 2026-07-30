import { pathToFileURL } from "node:url";
import { CloudDatabaseService } from "./db/cloud-database.service.js";
import { PgSqlExecutor } from "./db/pg-executor.js";

export async function migrate(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const executor = PgSqlExecutor.fromConnectionString(databaseUrl);
  try {
    await new CloudDatabaseService(executor).migrate();
  } finally {
    await executor.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate();
}
