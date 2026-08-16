import { Inject, Injectable, Optional } from "@nestjs/common";
import { cloudMigrations, SELF_HOST_TENANT_ID } from "@berry/db";

export const CLOUD_DATABASE_EXECUTOR = Symbol("CLOUD_DATABASE_EXECUTOR");
export const CLOUD_PLATFORM_DATABASE_EXECUTOR = Symbol("CLOUD_PLATFORM_DATABASE_EXECUTOR");

export interface SqlExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction?<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  /** Run several statements on one dedicated, non-transactional connection. */
  session?<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

@Injectable()
export class CloudDatabaseService {
  readonly selfHostTenantId = SELF_HOST_TENANT_ID;

  constructor(
    @Inject(CLOUD_DATABASE_EXECUTOR) private readonly executor: SqlExecutor,
    @Optional() @Inject(CLOUD_PLATFORM_DATABASE_EXECUTOR)
    private readonly platformExecutor?: SqlExecutor,
  ) {}

  async migrate(): Promise<void> {
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applyTransactionalRange = async (executor: SqlExecutor, start: number, end: number): Promise<void> => {
      await executor.execute("SELECT pg_advisory_xact_lock(hashtextextended('berry-cloud-migrations', 0))");
      const applied = new Set(
        (await executor.query<{ id: number }>("SELECT id FROM schema_migrations")).map((row) => row.id),
      );
      for (const migration of cloudMigrations.slice(start, end)) {
        if ("transactional" in migration && migration.transactional === false) continue;
        if (applied.has(migration.id)) continue;
        await executor.execute(migration.sql);
        await executor.execute("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [migration.id, migration.name]);
      }
    };
    const applyOnlineMigration = async (migration: (typeof cloudMigrations)[number]): Promise<void> => {
      const run = async (executor: SqlExecutor): Promise<void> => {
        // CREATE/DROP INDEX CONCURRENTLY cannot run in a transaction. Keep a
        // session-level advisory lock on the same connection so two API pods
        // cannot race an invalid or half-built index.
        await executor.execute("SELECT pg_advisory_lock(hashtextextended('berry-cloud-migrations', 0))");
        try {
          const applied = new Set(
            (await executor.query<{ id: number }>("SELECT id FROM schema_migrations")).map((row) => row.id),
          );
          const indexNames: readonly string[] = "onlineIndexNames" in migration
            ? (migration.onlineIndexNames as readonly string[])
            : "onlineIndexName" in migration
              ? [migration.onlineIndexName as string]
              : [];
          const statements: readonly string[] = "onlineSql" in migration
            ? (migration.onlineSql as readonly string[])
            : [migration.sql];
          if (indexNames.length === 0) {
            if (!applied.has(migration.id)) {
              for (const statement of statements) await executor.execute(statement);
            }
          } else {
            const indexStates = await Promise.all(indexNames.map(async (indexName) => {
              const rows = await executor.query<{ indisvalid: boolean }>(
                `SELECT i.indisvalid
                 FROM pg_class c
                 JOIN pg_index i ON i.indexrelid = c.oid
                 WHERE c.relname = '${indexName}'`,
              );
              return { indexName, state: rows[0] };
            }));
            for (const { indexName, state } of indexStates) {
              if (state && !state.indisvalid) {
                // Only an invalid index object is removed; table/message data is
                // never touched. A failed CONCURRENTLY build is safe to repair
                // on the next startup before retrying the migration.
                await executor.execute(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
              }
            }
            if (!applied.has(migration.id) || indexStates.some(({ state }) => !state || !state.indisvalid)) {
              for (const statement of statements) await executor.execute(statement);
            }
            for (const indexName of indexNames) {
              const [valid] = await executor.query<{ indisvalid: boolean }>(
                `SELECT i.indisvalid
                 FROM pg_class c
                 JOIN pg_index i ON i.indexrelid = c.oid
                 WHERE c.relname = '${indexName}'`,
              );
              if (!valid || !valid.indisvalid) throw new Error(`${indexName} is missing or invalid after migration`);
            }
          }
          await executor.execute(
            "INSERT INTO schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
            [migration.id, migration.name],
          );
        } finally {
          await executor.execute("SELECT pg_advisory_unlock(hashtextextended('berry-cloud-migrations', 0))");
        }
      };
      if (this.executor.session) await this.executor.session(run);
      else await run(this.executor);
    };
    let start = 0;
    while (start < cloudMigrations.length) {
      const onlineIndex = cloudMigrations.findIndex((migration, index) =>
        index >= start && "transactional" in migration && migration.transactional === false,
      );
      const end = onlineIndex === -1 ? cloudMigrations.length : onlineIndex;
      if (end > start) {
        const run = (executor: SqlExecutor) => applyTransactionalRange(executor, start, end);
        if (this.executor.transaction) await this.executor.transaction(run);
        else await run(this.executor);
      }
      if (onlineIndex === -1) break;
      await applyOnlineMigration(cloudMigrations[onlineIndex]!);
      start = onlineIndex + 1;
    }
  }

  async withTenant<T>(tenantId: string, callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    assertUuid(tenantId);
    const run = async (executor: SqlExecutor): Promise<T> => {
      await executor.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(executor);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }

  async ping(): Promise<void> {
    await this.executor.query("SELECT 1 AS ok");
  }

  /** Cross-tenant query seam. Only platform services guarded by PlatformAuthorizer may call this. */
  async privilegedQuery<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    return (this.platformExecutor ?? this.executor).query<T>(sql, params);
  }
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid tenant id: ${value}`);
  }
}
