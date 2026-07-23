import { Inject, Injectable } from "@nestjs/common";
import { cloudMigrations, SELF_HOST_TENANT_ID } from "@berry/db";

export const CLOUD_DATABASE_EXECUTOR = Symbol("CLOUD_DATABASE_EXECUTOR");

export interface SqlExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction?<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

@Injectable()
export class CloudDatabaseService {
  readonly selfHostTenantId = SELF_HOST_TENANT_ID;

  constructor(@Inject(CLOUD_DATABASE_EXECUTOR) private readonly executor: SqlExecutor) {}

  async migrate(): Promise<void> {
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applyPending = async (executor: SqlExecutor): Promise<void> => {
      await executor.execute("SELECT pg_advisory_xact_lock(hashtextextended('berry-cloud-migrations', 0))");
      const applied = new Set(
        (await executor.query<{ id: number }>("SELECT id FROM schema_migrations")).map((row) => row.id),
      );
      for (const migration of cloudMigrations) {
        if (applied.has(migration.id)) continue;
        await executor.execute(migration.sql);
        await executor.execute("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [migration.id, migration.name]);
      }
    };
    if (this.executor.transaction) {
      await this.executor.transaction(applyPending);
      return;
    }
    await applyPending(this.executor);
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
    return this.executor.query<T>(sql, params);
  }
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid tenant id: ${value}`);
  }
}
