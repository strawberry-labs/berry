import { UsageAnalyticsQuerySchema } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { PostgresUsageRepository } from "./usage.repository.ts";

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
  it("does not cap analytics to an arbitrary event count", async () => {
    const { usage, statements } = repository();

    await usage.analytics(TENANT_ID, query());

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).not.toMatch(/LIMIT\s+10000/i);
    expect(statements[0]?.sql).not.toMatch(/LIMIT\s+\$/i);
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
