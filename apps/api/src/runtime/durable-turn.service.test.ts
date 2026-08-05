import { describe, expect, it } from "vitest";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";
import { compactReplayEvents, DurableTurnService } from "./durable-turn.service.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const taskId = "00000000-0000-7000-8000-000000000003";
const sessionId = "00000000-0000-7000-8000-000000000004";
const runId = "00000000-0000-7000-8000-000000000005";
const questionId = "00000000-0000-7000-8000-000000000006";
const stepId = "00000000-0000-7000-8000-000000000007";
const workspaceId = "00000000-0000-7000-8000-000000000008";

describe("DurableTurnService", () => {
  it("reports context from the durable journal, including trailing and in-flight text", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT entry_id,sequence,payload")) {
          return [
            {
              entry_id: "entry-user",
              sequence: 1,
              payload: { message: { role: "user", content: [{ type: "text", text: "hello" }] } },
            },
            {
              entry_id: "entry-assistant",
              sequence: 2,
              payload: {
                message: {
                  role: "assistant",
                  stopReason: "toolUse",
                  content: [{ type: "text", text: "answer" }],
                  usage: { input: 4_800, output: 200, totalTokens: 5_000 },
                },
              },
            },
            {
              entry_id: "entry-tool",
              sequence: 3,
              payload: { message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(40) }] } },
            },
          ] as T[];
        }
        if (sql.includes("FROM session_checkpoints")) return [] as T[];
        if (sql.includes("FROM turn_runs r")) {
          return [{
            id: runId,
            state: "calling_model",
            prompt_manifest: {},
            grounding_context: {},
            partial_chars: 80,
          }] as T[];
        }
        return [] as T[];
      },
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.contextStats(tenantId, sessionId, {
      pendingInput: "12345678901234567890",
    })).resolves.toEqual({
      usedTokens: 5_035,
      source: "provider-reported",
    });
  });

  it("drops provider usage covered by the latest rolling checkpoint", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT entry_id,sequence,payload")) {
          return [
            {
              entry_id: "entry-covered",
              sequence: 1,
              payload: {
                message: {
                  role: "assistant",
                  stopReason: "stop",
                  content: [{ type: "text", text: "old" }],
                  usage: { input: 8_000, output: 1_000, totalTokens: 9_000 },
                },
              },
            },
            {
              entry_id: "entry-recent",
              sequence: 2,
              payload: { message: { role: "user", content: [{ type: "text", text: "x".repeat(400) }] } },
            },
          ] as T[];
        }
        if (sql.includes("FROM session_checkpoints")) {
          return [{ checkpoint: { summary: "x".repeat(40) }, covered_entry_end: "entry-covered" }] as T[];
        }
        if (sql.includes("FROM turn_runs r")) {
          return [{
            id: runId,
            state: "completed",
            prompt_manifest: {
              version: 1,
              provider: "berry-router",
              model: "model",
              route: "openai-completions",
              components: [],
              cacheRetention: "none",
              stablePrefixTokens: 100,
              dynamicContextBoundary: 0,
              stablePrefixHash: "stable",
              manifestHash: "manifest",
            },
            grounding_context: {},
            partial_chars: 0,
          }] as T[];
        }
        return [] as T[];
      },
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    const stats = await service.contextStats(tenantId, sessionId);

    expect(stats.source).toBe("estimated");
    expect(stats.usedTokens).toBeGreaterThan(200);
    expect(stats.usedTokens).toBeLessThan(9_000);
  });

  it("compacts redundant active-run replay without losing streamed text", () => {
    expect(compactReplayEvents([
      { kind: "message.start", messageId: "message-1", role: "assistant" },
      { kind: "message.delta", messageId: "message-1", delta: "Hello", channel: "text" },
      { kind: "message.delta", messageId: "message-1", delta: " world", channel: "text" },
      { kind: "usage", inputTokens: 1, outputTokens: 1 },
      { kind: "usage", inputTokens: 2, outputTokens: 2 },
    ])).toEqual([
      { kind: "message.start", messageId: "message-1", role: "assistant" },
      { kind: "message.delta", messageId: "message-1", delta: "Hello world", channel: "text" },
      { kind: "usage", inputTokens: 2, outputTokens: 2 },
    ]);
  });

  it("uses the exact persisted user message instead of matching transformed prompt text", async () => {
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("AND id=$4::uuid AND role='user'")) return [{ id: userId }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 1 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await service.admit({
      tenantId,
      userId,
      workspaceId,
      taskId,
      sessionId,
      requestId: "request_exact",
      requestMessageId: userId,
      input: "Visible prompt\n\nUser instructions:\nUse terse replies.",
      runtimeRequest: {},
      groundingContext: {},
    });

    expect(executions.some((sql) => sql.startsWith("INSERT INTO messages"))).toBe(false);
  });

  it("rewinds the active journal leaf without deleting the abandoned branch", async () => {
    const parentEntryId = "00000000-0000-7000-8000-000000000009";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT parent_entry_id FROM session_entries")) {
          return [{ parent_entry_id: parentEntryId }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await service.rewindJournalBefore(tenantId, sessionId, userId);

    const journalExecutions = executions.filter(({ sql }) =>
      sql.includes("session_entries") || sql.includes("UPDATE sessions SET runtime_metadata")
    );
    expect(journalExecutions).toHaveLength(2);
    expect(journalExecutions[0]).toMatchObject({
      sql: expect.stringContaining("SET is_leaf_marker=COALESCE(entry_id=$3,false)"),
      params: [tenantId, sessionId, parentEntryId],
    });
    expect(journalExecutions[1]).toMatchObject({
      sql: expect.stringContaining("jsonb_build_object('leafId',$3::text)"),
      params: [tenantId, sessionId, parentEntryId],
    });
    expect(executions.every(({ sql }) => !sql.includes("DELETE FROM session_entries"))).toBe(true);
  });

  it("backfills a pre-rollout edit target before rewinding its durable branch", async () => {
    const previousMessageId = "00000000-0000-7000-8000-000000000008";
    const durableRootId = "00000000-0000-7000-8000-000000000009";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("LEFT JOIN message_parts p")) {
          return [
            {
              message_id: previousMessageId,
              sequence_id: 1,
              role: "user",
              status: "complete",
              created_at: "2026-07-01T00:00:00.000Z",
              type: "text",
              content: "Earlier question",
              ordinal: 0,
            },
            {
              message_id: userId,
              sequence_id: 2,
              role: "user",
              status: "complete",
              created_at: "2026-07-02T00:00:00.000Z",
              type: "text",
              content: "Edited question",
              ordinal: 0,
            },
          ] as T[];
        }
        if (sql.includes("COALESCE(MIN(sequence),0)")) {
          return [{
            minimum: 1,
            maximum: 2,
            first_created_at: "2026-08-01T00:00:00.000Z",
            leaf_id: durableRootId,
            root_id: durableRootId,
          }] as T[];
        }
        if (sql.includes("SELECT parent_entry_id FROM session_entries")) {
          return [{ parent_entry_id: previousMessageId }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await service.rewindJournalBefore(tenantId, sessionId, userId);

    expect(queries[0]).toContain("LEFT JOIN message_parts p");
    expect(queries[0]).toContain("tool_result_projection.content->>'toolCallId'");
    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("INSERT INTO session_entries"),
      params: expect.arrayContaining([userId, previousMessageId]),
    }));
    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("SET is_leaf_marker=COALESCE(entry_id=$3,false)"),
      params: [tenantId, sessionId, previousMessageId],
    }));
  });

  it("links pre-rollout messages into the active journal ancestry", async () => {
    const historicalMessageId = "00000000-0000-7000-8000-000000000009";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("FROM turn_runs") && sql.includes("state NOT IN")) return [] as T[];
        if (sql.includes("AND id=$4::uuid AND role='user'")) return [{ id: userId }] as T[];
        if (sql.includes("LEFT JOIN message_parts")) {
          return [{
            message_id: historicalMessageId,
            sequence_id: 1,
            role: "assistant",
            status: "complete",
            created_at: "2026-07-01T00:00:00.000Z",
            type: "text",
            content: "Earlier conversation",
            ordinal: 0,
          }] as T[];
        }
        if (sql.includes("COALESCE(MIN(sequence),0)")) {
          return [{
            minimum: 1,
            maximum: 1,
            first_created_at: "2026-08-01T00:00:00.000Z",
            leaf_id: userId,
            root_id: userId,
          }] as T[];
        }
        if (sql.includes("SELECT entry_id FROM session_entries") && sql.includes("entry_id=$3")) {
          return [{ entry_id: userId }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await service.admit({
      tenantId,
      userId,
      workspaceId,
      taskId,
      sessionId,
      requestId: "request_backfill",
      requestMessageId: userId,
      input: "Current message",
      runtimeRequest: {},
      groundingContext: {},
    });

    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("SET parent_entry_id=$4"),
      params: [tenantId, sessionId, userId, historicalMessageId],
    }));
    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("INSERT INTO session_entries"),
      params: expect.arrayContaining([historicalMessageId, 0]),
    }));
  });

  it("replays only the open model segment while keeping the latest durable cursor", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params = []) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT id,state,lease_owner")) {
          return [{
            id: runId,
            state: "calling_model",
            lease_owner: "worker",
            waiting_reason: null,
            next_action: "Model request in progress",
            error: null,
            created_at: "2026-08-05T13:42:15.000Z",
          }] as T[];
        }
        if (sql.includes("MAX(sequence) FILTER")) {
          return [{
            message_start: 10,
            message_end: 5,
            tool_start: null,
            tool_end: null,
            turn_start: 1,
            maximum: 12,
          }] as T[];
        }
        if (sql.includes("sequence >= $3")) {
          return [
            { sequence: 10, payload: { kind: "message.start", messageId: questionId, role: "assistant" } },
            { sequence: 11, payload: { kind: "message.delta", messageId: questionId, delta: "Hel", channel: "text" } },
            { sequence: 12, payload: { kind: "message.delta", messageId: questionId, delta: "lo", channel: "text" } },
          ] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    const state = await service.state(tenantId, sessionId);

    expect(state.lastEventId).toBe(`${runId}:12`);
    expect(state.startedAt).toBe("2026-08-05T13:42:15.000Z");
    expect(state.bufferedEvents).toEqual([
      { kind: "message.start", messageId: questionId, role: "assistant" },
      { kind: "message.delta", messageId: questionId, delta: "Hello", channel: "text" },
    ]);
    expect(queries.find(({ sql }) => sql.includes("sequence >= $3"))?.params[2]).toBe(10);
  });

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
        if (sql.includes("m.id=$4::uuid AND m.role='user'")) return [{ id: userId }] as T[];
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
      answerMessageId: userId,
    })).resolves.toBe(true);

    const outboxInsert = executions.find((call) => call.sql.includes("'turn.resume'"));
    expect(outboxInsert).toBeDefined();
    expect(JSON.parse(String(outboxInsert?.params[3]))).toEqual({
      tenantId,
      runId,
      reason: "user-input",
    });
  });

  it("atomically cancels an active run and projects its partial assistant output", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT id,task_id,request_message_id")) {
          return [{ id: runId, task_id: taskId, request_message_id: userId }] as T[];
        }
        if (sql.includes("FROM turn_events") && sql.includes("ORDER BY sequence ASC")) {
          return [
            { payload: { kind: "message.start", messageId: questionId, role: "assistant" } },
            { payload: { kind: "message.delta", messageId: questionId, delta: "Partial", channel: "text" } },
          ] as T[];
        }
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 2 }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0) AS sequence")) return [{ sequence: 2 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.cancel(tenantId, sessionId)).resolves.toBe(true);

    expect(executions.some(({ sql, params }) =>
      sql.startsWith("INSERT INTO messages") && params.includes("cancelled")
    )).toBe(true);
    expect(executions.some(({ sql }) => sql.startsWith("UPDATE turn_runs") && sql.includes("state='cancelled'"))).toBe(true);
    expect(executions.some(({ params }) =>
      params.some((value) => typeof value === "string" && value.includes('"kind":"turn.end"'))
    )).toBe(true);
  });

  it("continues model execution after an operator marks an ambiguous tool call complete", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM turn_runs r JOIN tasks")) {
          return [{
            id: runId,
            session_id: sessionId,
            task_id: taskId,
            tool_call_id: questionId,
            tool_call_step_id: stepId,
            tool_call_name: "mcp__BerryCrawl__search",
            tool_call_input: { query: "today's AI news" },
            version: 3,
          }] as T[];
        }
        if (sql.includes("FROM session_entries") && sql.includes("is_leaf_marker=true")) {
          return [{
            entry_id: userId,
            entry_type: "message",
            payload: { type: "message", message: { role: "assistant" } },
          }] as T[];
        }
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 4 }] as T[];
        if (sql.includes("COUNT(*) FILTER")) return [{ sequence: 6, iteration: 3 }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0) AS sequence")) return [{ sequence: 8 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.recover(tenantId, userId, runId, "mark-complete")).resolves.toBe(true);

    expect(executions.some(({ sql }) =>
      sql.startsWith("INSERT INTO session_entries") && sql.includes("'message'")
    )).toBe(true);
    expect(executions.some(({ sql }) =>
      sql.startsWith("INSERT INTO turn_steps") && sql.includes("'model.call','pending'")
    )).toBe(true);
    expect(executions.some(({ sql }) =>
      sql.startsWith("UPDATE turn_runs") && sql.includes("state='calling_model'")
    )).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("'turn.resume'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("FOR UPDATE OF r"))).toBe(true);
  });
});
