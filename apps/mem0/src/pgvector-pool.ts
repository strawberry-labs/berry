import type { ClientConfig, PoolConfig } from "pg";

type QueryArguments = unknown[];

export interface PgPoolClientLike {
  release(error?: Error | boolean): void;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): this;
  query(...args: QueryArguments): unknown;
}

export interface PgModuleLike {
  Client: new (config?: string | ClientConfig) => unknown;
  Pool: new (config?: PoolConfig) => PgPoolLike;
}

export interface PgVectorPoolOptions {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  keepAliveInitialDelayMillis?: number;
  onIdleError?: (diagnostic: PgPoolErrorDiagnostic) => void;
}

export interface PgPoolErrorDiagnostic {
  code: string;
  message: string;
}

interface PoolEntry {
  pool: PgPoolLike;
  references: number;
  closing?: Promise<void>;
}

/**
 * Mem0 3.1's pgvector adapter owns one pg.Client and shares it across every
 * request. Replace that constructor before loading Mem0 so each adapter uses a
 * bounded pg.Pool instead. Equivalent connection configs share one pool, which
 * also keeps the main and lazily-created entity collections inside one limit.
 */
export function installPooledPgClient(
  pg: PgModuleLike,
  options: PgVectorPoolOptions,
): { close: () => Promise<void> } {
  const OriginalClient = pg.Client;
  const entries = new Map<string, PoolEntry>();
  let closed = false;

  const getEntry = (input?: string | ClientConfig): { entry: PoolEntry; key: string } => {
    if (closed) throw new Error("Berry Mem0 PostgreSQL pool is closed");
    const clientConfig = normalizeClientConfig(input);
    const poolConfig: PoolConfig = {
      ...clientConfig,
      application_name: clientConfig.application_name || "berry-mem0",
      connectionTimeoutMillis: clientConfig.connectionTimeoutMillis ?? options.connectionTimeoutMillis,
      idleTimeoutMillis: options.idleTimeoutMillis,
      keepAlive: clientConfig.keepAlive ?? true,
      keepAliveInitialDelayMillis:
        clientConfig.keepAliveInitialDelayMillis ?? options.keepAliveInitialDelayMillis ?? 10_000,
      max: options.max,
    };
    const key = stableConfigKey(poolConfig);
    const existing = entries.get(key);
    if (existing && !existing.closing) {
      existing.references += 1;
      return { entry: existing, key };
    }

    const pool = new pg.Pool(poolConfig);
    pool.on("error", (error) => {
      options.onIdleError?.(postgresErrorDiagnostic(error));
    });
    const entry: PoolEntry = { pool, references: 1 };
    entries.set(key, entry);
    return { entry, key };
  };

  const releaseEntry = async (key: string, entry: PoolEntry): Promise<void> => {
    if (entry.references > 0) entry.references -= 1;
    if (entry.references > 0 || entry.closing) {
      await entry.closing;
      return;
    }
    entries.delete(key);
    entry.closing = entry.pool.end();
    await entry.closing;
  };

  class PooledClient {
    readonly #entry: PoolEntry;
    readonly #key: string;
    #ended = false;

    constructor(config?: string | ClientConfig) {
      const acquired = getEntry(config);
      this.#entry = acquired.entry;
      this.#key = acquired.key;
    }

    connect(callback?: (error?: Error) => void): Promise<void> | void {
      const connected = this.#entry.pool.connect().then((client) => {
        client.release();
      });
      if (callback) {
        void connected.then(() => callback()).catch((error: unknown) => callback(asError(error)));
        return;
      }
      return connected;
    }

    query(...args: QueryArguments): unknown {
      if (this.#ended) return Promise.reject(new Error("PostgreSQL client is closed"));
      return Reflect.apply(this.#entry.pool.query, this.#entry.pool, args);
    }

    end(callback?: () => void): Promise<void> | void {
      if (this.#ended) {
        if (callback) callback();
        return callback ? undefined : Promise.resolve();
      }
      this.#ended = true;
      const ended = releaseEntry(this.#key, this.#entry);
      if (callback) {
        void ended.then(callback);
        return;
      }
      return ended;
    }
  }

  pg.Client = PooledClient as PgModuleLike["Client"];

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      if (pg.Client === PooledClient) pg.Client = OriginalClient;
      const openEntries = [...entries.values()];
      entries.clear();
      await Promise.all(openEntries.map((entry) => {
        entry.closing ??= entry.pool.end();
        return entry.closing;
      }));
    },
  };
}

export async function installMem0PgVectorPool(
  options: PgVectorPoolOptions,
): Promise<{ close: () => Promise<void> }> {
  const imported = await import("pg");
  return installPooledPgClient(imported.default as PgModuleLike, options);
}

function normalizeClientConfig(input?: string | ClientConfig): ClientConfig {
  return typeof input === "string" ? { connectionString: input } : { ...input };
}

function stableConfigKey(config: PoolConfig): string {
  return JSON.stringify(sortObject(config));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") {
    if (typeof value === "function") return String(value);
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}

function postgresErrorDiagnostic(error: Error): PgPoolErrorDiagnostic {
  const code = "code" in error && typeof error.code === "string"
    ? error.code.replace(/[^A-Z0-9_-]/gi, "").slice(0, 64) || "UNKNOWN"
    : "UNKNOWN";
  return {
    code,
    message: code === "UNKNOWN" ? "PostgreSQL idle client failed" : `PostgreSQL idle client failed (${code})`,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
