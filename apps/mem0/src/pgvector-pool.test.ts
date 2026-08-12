import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  installPooledPgClient,
  type PgModuleLike,
  type PgPoolClientLike,
  type PgPoolLike,
} from "./pgvector-pool.js";

class FakePool extends EventEmitter implements PgPoolLike {
  static instances: FakePool[] = [];

  readonly max: number;
  active = 0;
  maxActive = 0;
  ended = false;
  failNextQuery: Error | undefined;
  readonly #waiters: Array<() => void> = [];

  constructor(config: { max?: number } = {}) {
    super();
    this.max = config.max ?? 10;
    FakePool.instances.push(this);
  }

  async connect(): Promise<PgPoolClientLike> {
    await this.#acquire();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release();
      },
    };
  }

  async query(_text: unknown, values?: unknown): Promise<{ rows: Array<{ value: unknown }> }> {
    await this.#acquire();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      if (this.failNextQuery) {
        const error = this.failNextQuery;
        this.failNextQuery = undefined;
        throw error;
      }
      return { rows: [{ value: values }] };
    } finally {
      this.#release();
    }
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async #acquire(): Promise<void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  #release(): void {
    this.active -= 1;
    this.#waiters.shift()?.();
  }
}

function testPgModule(): { module: PgModuleLike; originalClient: PgModuleLike["Client"] } {
  FakePool.instances = [];
  const originalClient = class UnsafeSharedClient {};
  return {
    module: {
      Client: originalClient,
      Pool: FakePool as unknown as PgModuleLike["Pool"],
    },
    originalClient,
  };
}

describe("Mem0 pgvector pool compatibility client", () => {
  it("runs 50 simultaneous searches through a bounded shared pool", async () => {
    const pg = testPgModule();
    const installed = installPooledPgClient(pg.module, {
      max: 8,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    });
    const Client = pg.module.Client as unknown as new (config: { connectionString: string }) => {
      connect(): Promise<void>;
      query(text: string, values: unknown[]): Promise<{ rows: Array<{ value: unknown }> }>;
      end(): Promise<void>;
    };
    const memoriesClient = new Client({ connectionString: "postgres://mem0@example/mem0" });
    const entitiesClient = new Client({ connectionString: "postgres://mem0@example/mem0" });

    await memoriesClient.connect();
    const searches = Array.from({ length: 50 }, (_, index) =>
      memoriesClient.query("SELECT id FROM memories ORDER BY vector <=> $1 LIMIT $2", [index, 20]),
    );
    const results = await Promise.all(searches);

    expect(results).toHaveLength(50);
    expect(FakePool.instances).toHaveLength(1);
    expect(FakePool.instances[0]?.maxActive).toBe(8);
    await memoriesClient.end();
    expect(FakePool.instances[0]?.ended).toBe(false);
    await expect(entitiesClient.query("SELECT id FROM memories_entities", [])).resolves.toBeDefined();
    await entitiesClient.end();
    expect(FakePool.instances[0]?.ended).toBe(true);

    await installed.close();
    expect(pg.module.Client).toBe(pg.originalClient);
  });

  it("absorbs idle socket errors and recovers after a terminated active connection", async () => {
    const pg = testPgModule();
    const diagnostics: Array<{ code: string; message: string }> = [];
    const installed = installPooledPgClient(pg.module, {
      max: 4,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      onIdleError: (diagnostic) => diagnostics.push(diagnostic),
    });
    const Client = pg.module.Client as unknown as new (config: string) => {
      query(text: string): Promise<unknown>;
    };
    const client = new Client("postgres://mem0@example/mem0");
    const pool = FakePool.instances[0];
    const idleTimeout = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });

    expect(() => pool?.emit("error", idleTimeout)).not.toThrow();
    expect(diagnostics).toEqual([{
      code: "ETIMEDOUT",
      message: "PostgreSQL idle client failed (ETIMEDOUT)",
    }]);

    const terminated = Object.assign(new Error("terminating connection"), { code: "57P01" });
    if (pool) pool.failNextQuery = terminated;
    await expect(client.query("SELECT id FROM memories")).rejects.toMatchObject({ code: "57P01" });
    await expect(client.query("SELECT id FROM memories")).resolves.toBeDefined();

    await installed.close();
  });
});
