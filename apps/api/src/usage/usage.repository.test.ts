import { CloudUsageIngestRequestSchema, UsageAnalyticsQuerySchema } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { InMemoryUsageRepository, PostgresUsageRepository } from "./usage.repository.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000002";

function query() {
  return UsageAnalyticsQuerySchema.parse({
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
    limit: 50,
  });
}

function repository() {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const database = {
    withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
      execute: async () => undefined,
      query: async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
        return [];
      },
    }),
  };
  return { usage: new PostgresUsageRepository(database as never), statements };
}

describe("PostgresUsageRepository pagination", () => {
  it("aggregates analytics in Postgres without materializing all-time events", async () => {
    const { usage, statements } = repository();

    await usage.analytics(TENANT_ID, query());

    expect(statements).toHaveLength(3);
    expect(statements.every((statement) => !/SELECT\s+\*\s+FROM\s+usage_events/i.test(statement.sql))).toBe(true);
    expect(statements[0]?.sql).toContain("SUM(cost_billed_micros)");
    expect(statements[1]?.sql).toContain("GROUP BY 1");
    expect(statements[2]?.sql).toContain("dimension_rank <= 100");
  });

  it("paginates request logs in newest-first order at the database", async () => {
    const { usage, statements } = repository();

    await usage.requestPage(TENANT_ID, query(), USER_ID);

    expect(statements[0]?.sql).toMatch(/ORDER BY ts DESC,id DESC LIMIT \$/i);
    expect(statements[0]?.params.at(-1)).toBe(51);
  });

  it("applies the request cursor before fetching the next page", async () => {
    const { usage, statements } = repository();
    const cursor = "2026-07-31T12:00:00.000Z|00000000-0000-7000-8000-000000000099";

    await usage.requestPage(TENANT_ID, { ...query(), cursor }, USER_ID);

    expect(statements[0]?.sql).toContain("ts <");
    expect(statements[0]?.sql).toContain("id <");
    expect(statements[0]?.params).toContain("2026-07-31T12:00:00.000Z");
  });
});

describe("task token usage", () => {
  const taskId = "task_1";
  function event(requestId: string, tokensIn: number, tokensOut: number, cached: number, extra: Record<string, unknown> = {}) {
    return CloudUsageIngestRequestSchema.shape.normalized.parse({
      requestId, taskId, sessionId: "session_1", feature: "model.turn",
      tokensIn, tokensOut, tokensCached: cached, cacheReadTokens: cached,
      cacheWriteTokens: 200, cacheEligible: true, status: "completed", ...extra,
    });
  }

  it("includes every session and historical turn, excludes other tasks and tenants, and counts retried records once", async () => {
    const usage = new InMemoryUsageRepository();
    const first = event("turn_1", 1_000, 100, 500, { ts: "2025-01-01T00:00:00Z" });
    await usage.ingestInternal(TENANT_ID, first);
    await usage.ingestInternal(TENANT_ID, first);
    await usage.ingestInternal(TENANT_ID, event("turn_2", 3_000, 200, 1_000, { sessionId: "session_2", status: "failed" }));
    await usage.ingestInternal(TENANT_ID, event("other_task", 50_000, 5_000, 40_000, { taskId: "task_2" }));
    await usage.ingestInternal("other_tenant", event("other_tenant", 50_000, 5_000, 40_000));
    expect(await usage.taskTokenUsage(TENANT_ID, taskId)).toEqual({
      taskId, inputTokens: 4_000, outputTokens: 300, totalTokens: 4_300,
      cachedInputTokens: 1_500, uncachedInputTokens: 2_500, cacheHitRate: 0.375,
    });
  });

  it("distinguishes an unused task from a task with no cache hits", async () => {
    const usage = new InMemoryUsageRepository();
    expect(await usage.taskTokenUsage(TENANT_ID, taskId)).toMatchObject({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cacheHitRate: null });
    await usage.ingestInternal(TENANT_ID, event("uncached", 1_000, 50, 0));
    expect(await usage.taskTokenUsage(TENANT_ID, taskId)).toMatchObject({ totalTokens: 1_050, uncachedInputTokens: 1_000, cachedInputTokens: 0, cacheHitRate: 0 });
  });

  it("converts PostgreSQL bigint totals without counting cached input twice", async () => {
    const usage = new PostgresUsageRepository({
      withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
        query: async () => [{ input_tokens: "8000", output_tokens: "250", cached_input_tokens: "6000" }],
      }),
    } as never);
    expect(await usage.taskTokenUsage(TENANT_ID, taskId)).toEqual({
      taskId, inputTokens: 8_000, outputTokens: 250, totalTokens: 8_250,
      cachedInputTokens: 6_000, uncachedInputTokens: 2_000, cacheHitRate: 0.75,
    });
  });
});
