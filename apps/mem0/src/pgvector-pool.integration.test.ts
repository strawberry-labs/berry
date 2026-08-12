import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { installMem0PgVectorPool } from "./pgvector-pool.js";

const databaseUrl = process.env.BERRY_MEM0_TEST_DATABASE_URL?.trim();
const integration = databaseUrl ? describe : describe.skip;

type Mem0PgVectorLike = {
  initialize(): Promise<void>;
  insert(vectors: number[][], ids: string[], payloads: Array<Record<string, unknown>>): Promise<void>;
  search(vector: number[], topK: number, filters?: Record<string, unknown>): Promise<unknown[]>;
  deleteCol(): Promise<void>;
  close(): Promise<void>;
  client: { query(sql: string): Promise<unknown> };
};

integration("Mem0 PGVector pooled-client integration", () => {
  it("survives 50 concurrent searches and a terminated PostgreSQL backend", async () => {
    const pgModule = await import("pg");
    const ControlPool = pgModule.default.Pool;
    const control = new ControlPool({
      connectionString: databaseUrl!,
      max: 2,
      application_name: "berry-mem0-integration-control",
    });
    const idleErrors: string[] = [];
    const installed = await installMem0PgVectorPool({
      max: 8,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      onIdleError: ({ code }) => idleErrors.push(code),
    });
    const collectionName = `berry_mem0_pool_${randomUUID().replaceAll("-", "")}`;
    let vectorStore: Mem0PgVectorLike | null = null;

    try {
      // This import must happen after installMem0PgVectorPool. Mem0 3.1 captures
      // pg.Client at module evaluation time inside its bundled PGVector adapter.
      const { PGVector } = await import("mem0ai/oss");
      vectorStore = new PGVector({
        connectionString: databaseUrl!,
        collectionName,
        embeddingModelDims: 3,
        hnsw: false,
      }) as unknown as Mem0PgVectorLike;
      if (!vectorStore) throw new Error("Mem0 PGVector did not initialize");
      await vectorStore.initialize();
      await vectorStore.insert(
        [[1, 0, 0]],
        [randomUUID()],
        [{ user_id: "berry-pool-integration", text: "pool recovery fixture" }],
      );

      const interrupted = vectorStore.client.query("SELECT pg_sleep(30)").then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const backendPid = await waitForActiveBackend(control, "SELECT pg_sleep(30)");
      const terminated = await control.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1) AS terminated",
        [backendPid],
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      const interruptedResult = await interrupted;
      expect(interruptedResult.ok).toBe(false);
      expect(postgresCode(interruptedResult.error)).toMatch(/^(57P01|ECONNRESET)$/);

      const searches = await Promise.all(Array.from({ length: 50 }, () =>
        vectorStore!.search([1, 0, 0], 5, { user_id: "berry-pool-integration" }),
      ));
      expect(searches).toHaveLength(50);
      expect(searches.every((result) => result.length === 1)).toBe(true);
      // Depending on timing, node-postgres reports an active-query failure to
      // that query only or also emits a bounded pool error. Neither may crash.
      expect(idleErrors.every((code) => /^[A-Z0-9_-]+$/.test(code))).toBe(true);
    } finally {
      if (vectorStore) {
        await vectorStore.deleteCol().catch(() => undefined);
        await vectorStore.close().catch(() => undefined);
      }
      await installed.close();
      await control.end();
    }
  }, 45_000);
});

async function waitForActiveBackend(
  control: Pool,
  queryFragment: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await control.query<{ pid: number }>(
      `
SELECT pid
FROM pg_stat_activity
WHERE application_name='berry-mem0'
  AND state='active'
  AND query LIKE $1
ORDER BY query_start
LIMIT 1
      `.trim(),
      [`%${queryFragment}%`],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the Mem0 PGVector backend query");
}

function postgresCode(error: unknown): string {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "UNKNOWN";
}
