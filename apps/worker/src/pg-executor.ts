import { Pool, type PoolClient, type PoolConfig } from "pg";

import type { SqlExecutor } from "./sql-repositories.ts";

export class PgSqlExecutor implements SqlExecutor {
  readonly #pool: Pool | null;
  readonly #client: Pool | PoolClient;

  constructor(client: Pool | PoolClient) {
    this.#client = client;
    this.#pool = client instanceof Pool ? client : null;
  }

  static fromConnectionString(connectionString: string, config: Omit<PoolConfig, "connectionString"> = {}): PgSqlExecutor {
    return new PgSqlExecutor(new Pool({ connectionString, ...config }));
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<unknown> {
    return this.#client.query(sql, [...params]);
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    const result = await this.#client.query(sql, [...params]);
    return result.rows as T[];
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.#pool) return callback(this);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PgSqlExecutor(client));
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
}
