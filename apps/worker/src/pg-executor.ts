import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import type { SqlExecutor } from "./sql-repositories.ts";

export class PgSqlExecutor implements SqlExecutor {
  readonly #pool: Pool | null;
  readonly #client: Pool | PoolClient;
  readonly #tenantContext: AsyncLocalStorage<string>;

  constructor(client: Pool | PoolClient, tenantContext = new AsyncLocalStorage<string>()) {
    this.#client = client;
    this.#pool = client instanceof Pool ? client : null;
    this.#tenantContext = tenantContext;
  }

  static fromConnectionString(connectionString: string, config: Omit<PoolConfig, "connectionString"> = {}): PgSqlExecutor {
    return new PgSqlExecutor(new Pool({ connectionString, ...config }));
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<unknown> {
    if (this.#pool && this.#tenantContext.getStore()) {
      return this.#withTenantClient((client) => client.query(sql, [...params]));
    }
    return this.#client.query(sql, [...params]);
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    const result = this.#pool && this.#tenantContext.getStore()
      ? await this.#withTenantClient((client) => client.query(sql, [...params]))
      : await this.#client.query(sql, [...params]);
    return result.rows as T[];
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.#pool) return callback(this);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const tenantId = this.#tenantContext.getStore();
      if (tenantId) await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      const result = await callback(new PgSqlExecutor(client, this.#tenantContext));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool?.end();
  }

  async runWithTenant<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
    assertUuid(tenantId);
    return this.#tenantContext.run(tenantId, callback);
  }

  async #withTenantClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.#pool) return operation(this.#client as PoolClient);
    const tenantId = this.#tenantContext.getStore();
    if (!tenantId) throw new Error("Tenant-scoped worker query has no tenant context");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid tenant id: ${value}`);
  }
}
