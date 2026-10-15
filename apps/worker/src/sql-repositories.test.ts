import { describe, expect, it } from "vitest";
import { SqlManagementJobRepository, SqlTaskTitleRepository, SqlUsageRollupRepository, type SqlExecutor } from "./sql-repositories.js";
import { providerCreditRuleId } from "./provider-credit-alerts.js";
import type { EmailMessage } from "./email.js";
import type { UsageRollupRecord } from "./usage-rollups.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

class FakeSqlExecutor implements SqlExecutor {
  readonly calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];
  transactionCount = 0;

  constructor(private readonly rows: readonly unknown[] = []) {}

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.calls.push({ kind: "execute", sql, params });
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    this.calls.push({ kind: "query", sql, params });
    return this.rows as readonly T[];
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return callback(this);
  }
}

describe("SQL worker repositories", () => {
  it("updates task titles within a tenant scope", async () => {
    const executor = new FakeSqlExecutor();
    await new SqlTaskTitleRepository(executor).updateTaskTitle({ tenantId, taskId: "task_1", title: "Cloud worker" });

    expect(executor.calls[0]?.sql).toContain("UPDATE tasks");
    expect(executor.calls[0]?.params).toEqual([tenantId, "task_1", "Cloud worker"]);
  });

  it("maps usage rows and upserts derived rollups in one transaction", async () => {
    const executor = new FakeSqlExecutor([
      {
        tenant_id: tenantId,
        feature: "model",
        provider: "openai",
        model: "gpt-test",
        status: "completed",
        tokens_in: 1,
        tokens_out: 2,
        tokens_cached: 0,
        cost_raw_micros: "3",
        cost_billed_micros: "4",
        latency_ms: 5,
        ttft_ms: null,
        ts: "2026-07-10T00:00:00.000Z",
      },
    ]);
    const repository = new SqlUsageRollupRepository(executor);

    await expect(repository.listUsageEvents({
      tenantId,
      from: new Date("2026-07-10T00:00:00.000Z"),
      to: new Date("2026-07-11T00:00:00.000Z"),
    })).resolves.toMatchObject([
      {
        tenantId,
        feature: "model",
        provider: "openai",
        model: "gpt-test",
        status: "completed",
        tokensIn: 1,
        tokensOut: 2,
        tokensCached: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costRawMicros: "3",
        costBilledMicros: "4",
        latencyMs: 5,
        ttftMs: null,
        ts: new Date("2026-07-10T00:00:00.000Z"),
      },
    ]);

    const rollup: UsageRollupRecord = {
      tenantId,
      userId: null,
      departmentId: null,
      workspaceId: null,
      agentId: null,
      sandboxId: null,
      bucketStart: new Date("2026-07-10T00:00:00.000Z"),
      bucketEnd: new Date("2026-07-11T00:00:00.000Z"),
      granularity: "day",
      feature: "model",
      provider: "openai",
      model: "gpt-test",
      status: "completed",
      requestCount: 1,
      tokensIn: 1,
      tokensOut: 2,
      tokensCached: 0,
      costRawMicros: "3",
      costBilledMicros: "4",
      latencyMsTotal: 5,
      latencyMsCount: 1,
      ttftMsTotal: 0,
      ttftMsCount: 0,
      sourceEventMinTs: new Date("2026-07-10T00:00:00.000Z"),
      sourceEventMaxTs: new Date("2026-07-10T00:00:00.000Z"),
      metadata: {},
    };
    await repository.upsertUsageRollups([rollup]);

    expect(executor.transactionCount).toBe(1);
    const upsert = executor.calls.find((call) => call.sql.includes("INSERT INTO usage_rollups"));
    expect(upsert?.sql).toContain("ON CONFLICT");
    expect(upsert?.params).toContain("gpt-test");
    expect(upsert?.params).toContain(JSON.stringify({}));
  });

  it("emails a configured email alert destination and records the SES message ID (H-005)", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { statements.push({ sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.includes("SELECT kind,email_recipients,configured")) return [{ kind: "email", email_recipients: ["ops@example.com"], configured: true }] as T[];
        if (sql.includes("FROM alert_events e JOIN alert_rules r")) return [{ window_key: "w1", observed: "150", created_at: "2026-10-15T09:00:00.000Z", name: "Spend", signal: "spend_threshold", threshold: "100" }] as T[];
        if (sql.includes("SELECT name FROM tenants")) return [{ name: "Acme" }] as T[];
        if (sql.includes("INSERT INTO delivery_attempts")) return [{ id: "attempt-1", attempt: 1, attempts: 0, delivered: false }] as T[];
        return [] as T[];
      },
      transaction: async (callback) => callback(executor),
    };
    const sent: EmailMessage[] = [];
    const repository = new SqlManagementJobRepository(executor, { email: { provider: "ses", send: async (message) => { sent.push(message); return { messageId: "ses-1" }; } } });
    await expect(repository.deliverAlert({ tenantId, eventId: "00000000-0000-7000-8000-000000000010", destinationId: "00000000-0000-7000-8000-000000000011" }))
      .resolves.toEqual({ status: "delivered", duplicate: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ["ops@example.com"], subject: "Berry alert: Spend" });
    const recorded = statements.find(({ sql }) => sql.startsWith("UPDATE delivery_attempts"));
    expect(recorded?.params).toEqual([tenantId, "attempt-1", "delivered", "ses-1", null]);
  });

  it("keeps the automatic provider credit rule out of alert evaluation (H-005)", async () => {
    const executor = new FakeSqlExecutor();
    await new SqlManagementJobRepository(executor).listAlertRules(tenantId);
    expect(executor.calls[0]?.sql).toContain("AND id<>$2::uuid");
    expect(executor.calls[0]?.params).toEqual([tenantId, providerCreditRuleId(tenantId)]);
  });
});
