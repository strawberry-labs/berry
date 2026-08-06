import { describe, expect, it } from "vitest";
import { SqlMaintenanceRunner } from "./maintenance.js";
import type { SqlExecutor } from "./sql-repositories.js";

describe("SqlMaintenanceRunner", () => {
  it("releases stale model reservations that never reached durable admission", async () => {
    const queries: string[] = [];
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "orphan_budget_reservations" } }] as T[];
        }
        if (sql.includes("WITH candidates AS") && sql.includes("budget_reservations")) {
          return [{ id: "00000000-0000-7000-8000-000000000099" }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.cleanup({
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      eventRetentionDays: 30,
      diagnosticRetentionDays: 30,
      outboxRetentionDays: 7,
    })).resolves.toMatchObject({
      status: "running",
      phase: "runtime_outbox",
      changed: 1,
    });

    const cleanup = queries.find((sql) => sql.includes("WITH candidates AS"));
    expect(cleanup).toContain("run.request_id = reservation.request_id");
    expect(cleanup).toContain("SET status = 'released'");
    expect(cleanup).toContain("orphan_admission_timeout");
    expect(executions.some((sql) => sql.includes("INSERT INTO runtime_outbox"))).toBe(true);
  });
});
