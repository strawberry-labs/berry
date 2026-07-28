import { describe, expect, it } from "vitest";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";
import { DurableTurnService } from "./durable-turn.service.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const taskId = "00000000-0000-7000-8000-000000000003";
const sessionId = "00000000-0000-7000-8000-000000000004";
const runId = "00000000-0000-7000-8000-000000000005";
const questionId = "00000000-0000-7000-8000-000000000006";
const stepId = "00000000-0000-7000-8000-000000000007";
const workspaceId = "00000000-0000-7000-8000-000000000008";

describe("DurableTurnService", () => {
  it("admits a turn using one PostgreSQL command per prepared statement", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        executions.push({ sql, params });
      },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 1 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.admit({
      tenantId,
      userId,
      workspaceId,
      taskId,
      sessionId,
      requestId: "request_1",
      input: "Remember that my name is Chirag.",
      runtimeRequest: {},
      groundingContext: {},
    })).resolves.toMatchObject({ sessionId });

    expect(executions.every(({ sql }) => !/;\s*\S/.test(sql))).toBe(true);
    expect(executions.some(({ sql }) => sql.startsWith("UPDATE tasks SET status='running'"))).toBe(true);
    expect(executions.some(({ sql }) => sql.startsWith("UPDATE sessions"))).toBe(true);
  });

  it("resumes an answered question with a worker-valid user-input reason", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        executions.push({ sql, params });
      },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM turn_questions q")) {
          return [{
            id: questionId,
            run_id: runId,
            session_id: sessionId,
            step_id: stepId,
            tool_call_id: null,
            question: "Which environment?",
            status: "pending",
            run_state: "waiting",
            task_id: taskId,
            created_at: "2026-07-28T00:00:00.000Z",
          }] as T[];
        }
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 1 }] as T[];
        if (sql.includes("COUNT(*) FILTER")) return [{ sequence: 2, iteration: 2 }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0) AS sequence")) return [{ sequence: 4 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.answerQuestion(tenantId, userId, questionId, {
      answer: "Staging",
    })).resolves.toBe(true);

    const outboxInsert = executions.find((call) => call.sql.includes("'turn.resume'"));
    expect(outboxInsert).toBeDefined();
    expect(JSON.parse(String(outboxInsert?.params[3]))).toEqual({
      tenantId,
      runId,
      reason: "user-input",
    });
  });
});
