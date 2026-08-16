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
const operationFingerprint = "a".repeat(64);

describe("DurableTurnService", () => {
  it("loads task activity for multiple sessions with one database query", async () => {
    const secondSessionId = "00000000-0000-7000-8000-000000000009";
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params = []) => {
        queries.push({ sql, params });
        return [
          {
            session_id: sessionId,
            run_id: runId,
            run_state: "completed",
            run_created_at: "2026-08-13T09:00:00.000Z",
            admission_state: "admitted",
            admission_created_at: "2026-08-13T08:59:59.000Z",
            admission_updated_at: "2026-08-13T09:00:00.000Z",
          },
          {
            session_id: secondSessionId,
            run_id: null,
            run_state: null,
            run_created_at: null,
            admission_state: "preparing",
            admission_created_at: "2026-08-13T09:01:00.000Z",
            admission_updated_at: "2026-08-13T09:01:01.000Z",
          },
        ] as T[];
      },
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    const activity = await service.taskActivity(tenantId, [sessionId, secondSessionId, sessionId]);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("LEFT JOIN LATERAL");
    expect(queries[0]?.params).toEqual([tenantId, [sessionId, secondSessionId]]);
    expect(activity.get(sessionId)).toMatchObject({ runId, runState: "completed" });
    expect(activity.get(secondSessionId)).toMatchObject({ runId: null, admissionState: "preparing" });
  });

  it("rejects admission after the matching pending submission was cancelled", async () => {
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM turn_admission_intents")) {
          return [{
            session_id: sessionId,
            operation_fingerprint: operationFingerprint,
            state: "cancelled",
            run_id: null,
          }] as T[];
        }
        throw new Error(`Admission continued after cancellation: ${sql}`);
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
      requestId: "model_cancelled_before_admission",
      operationFingerprint,
      budgetReservationRequired: false,
      input: "Do not run this",
      runtimeRequest: {},
      groundingContext: {},
    })).rejects.toMatchObject({ status: 409 });

    expect(executions).not.toContainEqual(expect.stringContaining("INSERT INTO turn_runs"));
    expect(executions).not.toContainEqual(expect.stringContaining("runtime_outbox"));
  });

  it("records and idempotently accepts cancellation before a run exists", async () => {
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM turn_admission_intents")) {
          return [{
            session_id: sessionId,
            operation_fingerprint: null,
            state: "cancelled",
            run_id: null,
          }] as T[];
        }
        if (sql.includes("FROM turn_runs")) return [] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.cancel(tenantId, sessionId, "model_pending_operation")).resolves.toBe(true);

    expect(executions).toContainEqual(expect.stringContaining("INSERT INTO turn_admission_intents"));
    expect(executions).not.toContainEqual(expect.stringContaining("UPDATE turn_runs"));
  });

  it("does not let a delayed operation-scoped cancel stop a newer run in the same session", async () => {
    const requestIdA = "model_operation_a";
    const newerRunId = "00000000-0000-7000-8000-000000000009";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    let activeSelector: { sql: string; params: readonly unknown[] } | undefined;
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string, params = []) => {
        if (sql.includes("FROM turn_admission_intents")) {
          return [{
            session_id: sessionId,
            operation_fingerprint: operationFingerprint,
            state: "admitted",
            run_id: runId,
          }] as T[];
        }
        if (sql.includes("SELECT id,task_id,session_id,request_message_id")) {
          activeSelector = { sql, params };
          // Simulate operation B being active. Before the request_id predicate
          // existed this row was selected and the delayed cancel for A stopped B.
          return sql.includes("($3::text IS NULL OR request_id=$3)")
            ? [] as T[]
            : [{ id: newerRunId, task_id: taskId, session_id: sessionId, request_message_id: userId }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.cancel(tenantId, sessionId, requestIdA)).resolves.toBe(true);

    expect(activeSelector?.sql).toContain("($3::text IS NULL OR request_id=$3)");
    expect(activeSelector?.params).toEqual([tenantId, sessionId, requestIdA]);
    expect(executions.some(({ sql }) => sql.includes("UPDATE turn_runs") && sql.includes("state='cancelled'")))
      .toBe(false);
  });

  it("returns the original run for a retried admission without writing another run", async () => {
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("WHERE tenant_id=$1::uuid AND request_id=$2")) {
          return [{
            id: runId,
            user_id: userId,
            workspace_id: workspaceId,
            task_id: taskId,
            session_id: sessionId,
            runtime_request: { admissionFingerprint: operationFingerprint },
          }] as T[];
        }
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
      requestId: "model_operation_1",
      operationFingerprint,
      budgetReservationRequired: false,
      requestMessageId: userId,
      input: "Do the work",
      runtimeRequest: {},
      groundingContext: {},
    })).resolves.toEqual({ runId, sessionId });

    expect(executions).not.toContainEqual(expect.stringContaining("INSERT INTO turn_runs"));
  });

  it("rejects a reused operation key when the request fingerprint changes", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => sql.includes("FROM turn_runs")
        ? [{
            id: runId,
            user_id: userId,
            workspace_id: workspaceId,
            task_id: taskId,
            session_id: sessionId,
            runtime_request: { admissionFingerprint: operationFingerprint },
          }] as T[]
        : [],
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.replayAdmission({
      tenantId,
      userId,
      workspaceId,
      taskId,
      sessionId,
      requestId: "model_operation_1",
      operationFingerprint: "b".repeat(64),
    })).rejects.toMatchObject({ status: 409 });
  });

  it("does not admit a new run after its budget reservation was settled", async () => {
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("FROM budget_reservations")) return [{ status: "reconciled" }] as T[];
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
      requestId: "model_settled_operation",
      operationFingerprint,
      budgetReservationRequired: true,
      input: "Do the work",
      runtimeRequest: {},
      groundingContext: {},
    })).rejects.toMatchObject({ status: 409 });

    expect(executions).not.toContainEqual(expect.stringContaining("INSERT INTO turn_runs"));
  });

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
      operationFingerprint,
      budgetReservationRequired: false,
      requestMessageId: userId,
      input: "Visible prompt\n\nUser instructions:\nUse terse replies.",
      runtimeRequest: {},
      groundingContext: {},
    });

    expect(executions.some((sql) => sql.startsWith("INSERT INTO messages"))).toBe(false);
  });

  it("creates the client-selected user message inside durable admission", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
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
      requestId: "request_atomic_message",
      operationFingerprint,
      budgetReservationRequired: false,
      requestMessageId: userId,
      input: "Create this message atomically.",
      runtimeRequest: {},
      groundingContext: {},
    });

    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("INSERT INTO messages"),
      params: [userId, tenantId, sessionId, taskId],
    }));
  });

  it("rewinds and replaces an edited message in the admission transaction", async () => {
    const replacementId = "00000000-0000-7000-8000-000000000009";
    const parentEntryId = "00000000-0000-7000-8000-000000000010";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("SELECT sequence_id") && sql.includes("FOR UPDATE")) return [{ sequence_id: 42 }] as T[];
        if (sql.includes("SELECT parent_entry_id FROM session_entries")) return [{ parent_entry_id: parentEntryId }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 43 }] as T[];
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
      requestId: "request_edit",
      operationFingerprint,
      budgetReservationRequired: false,
      requestMessageId: replacementId,
      replaceFromMessageId: userId,
      input: "Edited prompt",
      runtimeRequest: {},
      groundingContext: {},
    });

    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("DELETE FROM messages"),
      params: [tenantId, sessionId, 42],
    }));
    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("INSERT INTO messages"),
      params: [replacementId, tenantId, sessionId, taskId],
    }));
    expect(executions.find(({ sql }) => sql.includes("DELETE FROM messages"))?.sql)
      .toContain("sequence_id >= $3");
  });

  it("rejects a stale edit without appending another user message", async () => {
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
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
      requestId: "request_stale_edit",
      operationFingerprint,
      budgetReservationRequired: false,
      requestMessageId: "00000000-0000-7000-8000-000000000009",
      replaceFromMessageId: userId,
      input: "Edited prompt",
      runtimeRequest: {},
      groundingContext: {},
    })).rejects.toThrow("stale or no longer exists");

    expect(executions.some((sql) => sql.startsWith("INSERT INTO messages"))).toBe(false);
    expect(executions.some((sql) => sql.startsWith("INSERT INTO turn_runs"))).toBe(false);
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
      operationFingerprint,
      budgetReservationRequired: false,
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
            continuation: true,
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
    expect(state.continuation).toBe(true);
    expect(state.bufferedEvents).toEqual([
      { kind: "message.start", messageId: questionId, role: "assistant" },
      { kind: "message.delta", messageId: questionId, delta: "Hello", channel: "text" },
    ]);
    expect(queries.find(({ sql }) => sql.includes("sequence >= $3"))?.params[2]).toBe(10);
  });

  it("resets a future or unknown event cursor to the latest run", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params = []) => {
        queries.push({ sql, params });
        return [{
          run_id: runId,
          sequence: 1,
          payload: { kind: "turn.start", turnId: runId },
          created_at: "2026-08-05T13:42:15.000Z",
        }] as T[];
      },
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);
    const unknownRunId = "00000000-0000-7000-8000-000000000099";

    const events = await service.eventsAfter(tenantId, sessionId, `${unknownRunId}:999`, 500);

    expect(events).toEqual([expect.objectContaining({ id: `${runId}:1`, runId, sequence: 1 })]);
    expect(queries[0]?.sql).toContain("valid_cursor");
    expect(queries[0]?.sql).toContain("fallback_run");
    expect(queries[0]?.sql).toContain("WHEN r.state IN ('completed','failed','cancelled','recovery_required')");
    expect(queries[0]?.sql).toContain("THEN COALESCE(MAX(e.sequence),0)");
    expect(queries[0]?.params).toEqual([tenantId, sessionId, unknownRunId, 999, 500]);
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
      operationFingerprint,
      budgetReservationRequired: false,
      input: "Remember that my name is Chirag.",
      runtimeRequest: {},
      groundingContext: {},
    })).resolves.toMatchObject({ sessionId });

    expect(executions.every(({ sql }) => !/;\s*\S/.test(sql))).toBe(true);
    expect(executions.some(({ sql }) => sql.startsWith("UPDATE tasks SET status='running'"))).toBe(true);
    expect(executions.some(({ sql }) => sql.startsWith("UPDATE sessions"))).toBe(true);
  });

  it("marks a continued run and its first stream event as a continuation", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("SELECT request_message_id") && sql.includes("state IN ('failed','cancelled')")) {
          return [{ request_message_id: userId }] as T[];
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
      requestId: "request_continuation",
      operationFingerprint,
      budgetReservationRequired: false,
      continueInterruptedTurn: true,
      input: "",
      runtimeRequest: {},
      groundingContext: {},
    });

    const runInsert = executions.find(({ sql }) => sql.startsWith("INSERT INTO turn_runs"));
    expect(JSON.parse(String(runInsert?.params[8]))).toMatchObject({ continueInterruptedTurn: true });
    const startEvent = executions.find(({ sql }) => sql.includes("'turn.start'"));
    expect(JSON.parse(String(startEvent?.params[3]))).toEqual({
      kind: "turn.start",
      turnId: expect.any(String),
      continuation: true,
    });
  });

  it("uses the same project-file access rules during durable attachment admission", async () => {
    const fileId = "00000000-0000-7000-8000-000000000009";
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string, params = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM sessions s")) return [{ session_id: sessionId }] as T[];
        if (sql.includes("SELECT f.id") && sql.includes("file_library_entries")) return [{ id: fileId }] as T[];
        if (sql.includes("SELECT f.id,f.blob_id") && sql.includes("FOR UPDATE OF f")) return [{ id: fileId, blob_id: null }] as T[];
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
      requestId: "request_project_file",
      operationFingerprint,
      budgetReservationRequired: false,
      input: "Use the project file.",
      attachments: [{ fileId, name: "brief.pdf", mediaType: "application/pdf", size: 12 }],
      runtimeRequest: {},
      groundingContext: {},
    })).resolves.toMatchObject({ sessionId });

    const authorization = queries.find(({ sql }) => sql.includes("SELECT f.id") && sql.includes("file_library_entries"));
    expect(authorization?.sql).toContain("workspace_access_task.workspace_id=workspace.id");
    expect(authorization?.sql).toContain("workspace_access_task.deleted_at IS NULL");
    expect(authorization?.sql).toContain("wf.visibility='project'");
    expect(authorization?.sql).toContain("originating_task.id=wf.originating_task_id");
    const authorizationSql = authorization?.sql ?? "";
    const associationAccess = authorizationSql.slice(
      authorizationSql.indexOf("FROM file_associations access_link"),
      authorizationSql.indexOf("FROM workspace_files wf"),
    );
    expect(associationAccess).toContain("access_task.deleted_at IS NULL");
    expect(authorization?.params).toEqual([tenantId, userId, [fileId]]);
    expect(executions.some(({ sql, params }) => sql.includes("INSERT INTO file_associations") && params.includes(fileId))).toBe(true);
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
      answerMessageId: userId,
    })).resolves.toBe(true);

    const outboxInsert = executions.find((call) => call.sql.includes("'turn.resume'"));
    expect(outboxInsert).toBeDefined();
    expect(executions).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("INSERT INTO messages"),
      params: [userId, tenantId, sessionId, taskId],
    }));
    expect(JSON.parse(String(outboxInsert?.params[3]))).toEqual({
      tenantId,
      runId,
      reason: "user-input",
    });
  });

  it("resolves an approval and projects task running state in one transaction", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM approvals a")) {
          return [{
            id: "00000000-0000-7000-8000-000000000010",
            run_id: runId,
            step_id: stepId,
            tool_call_id: null,
            session_id: sessionId,
            task_id: taskId,
            status: "pending",
            expires_at: "2099-01-01T00:00:00.000Z",
          }] as T[];
        }
        if (sql.includes("COALESCE(MAX(sequence),0) AS sequence")) return [{ sequence: 0 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.decideApproval(tenantId, userId, "00000000-0000-7000-8000-000000000010", {
      decision: "approve",
    })).resolves.toBe(true);

    expect(executions.some(({ sql }) => sql.includes("UPDATE tasks") && sql.includes("status='running'"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("human_wait_ms") && sql.includes("version=version+1"))).toBe(true);
  });

  it("expires a late question answer without resuming the waiting run", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
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
            expires_at: "2026-07-29T00:00:00.000Z",
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.answerQuestion(tenantId, userId, questionId, { answer: "Staging" }))
      .resolves.toBe(false);
    expect(executions.some(({ sql }) => sql.includes("status='expired'"))).toBe(true);
    expect(executions.some(({ params }) => params.some((value) => String(value).includes('"kind":"question.expired"')))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("state=$3") && sql.includes("state='waiting'"))).toBe(true);
  });

  it("associates question uploads and persists their message parts in the answer transaction", async () => {
    const fileId = "00000000-0000-7000-8000-000000000009";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM turn_questions q")) {
          return [{
            id: questionId,
            run_id: runId,
            session_id: sessionId,
            step_id: stepId,
            tool_call_id: null,
            question: "Upload the brief",
            status: "pending",
            run_state: "waiting",
            task_id: taskId,
            created_at: "2026-07-28T00:00:00.000Z",
          }] as T[];
        }
        if (sql.includes("FROM tasks") && sql.includes("workspace_id")) {
          return [{ id: taskId, workspace_id: workspaceId }] as T[];
        }
        if (sql.includes("SELECT f.id, f.blob_id")) {
          return [{ id: fileId, blob_id: null }] as T[];
        }
        if (sql.includes("SELECT f.*") && sql.includes("f.owner_user_id")) {
          return [{
            id: fileId,
            blob_id: null,
            owner_user_id: userId,
            display_name: "brief.pdf",
            original_name: "brief.pdf",
            media_type: "application/pdf",
            detected_media_type: "application/pdf",
            size_bytes: 42,
            bucket: "files",
            object_key: "brief.pdf",
            etag: null,
            object_version_id: null,
            origin: "user_upload",
            status: "available",
            created_at: "2026-07-28T00:00:00.000Z",
            updated_at: "2026-07-28T00:00:00.000Z",
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
      answer: "Upload the brief: Attached files: brief.pdf",
      answerMessageId: userId,
      answers: [{
        question: "Upload the brief",
        answer: "",
        attachments: [{ fileId, name: "client-name.pdf", mediaType: "text/plain", size: 1 }],
      }],
    })).resolves.toBe(true);

    const associationIndex = executions.findIndex(({ sql }) => sql.includes("INSERT INTO file_associations"));
    const answerIndex = executions.findIndex(({ sql }) => sql.includes("UPDATE turn_questions"));
    expect(associationIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeGreaterThan(associationIndex);
    expect(executions[associationIndex]?.params).toContain(userId);
    const attachmentPart = executions.find(({ sql, params }) =>
      sql.includes("'attachment'") && params.includes(userId));
    expect(JSON.parse(String(attachmentPart?.params[2]))).toMatchObject({
      fileId,
      name: "brief.pdf",
      mediaType: "application/pdf",
      size: 42,
    });
  });

  it("treats an identical answered question as a successful replay", async () => {
    const updates: string[] = [];
    const storedAnswer = {
      selectedOptions: ["Staging"],
      answerMessageId: null,
      answers: [{ skipped: false, selectedOptions: ["Staging"], answer: "Staging", question: "Which environment?" }],
      answer: "Staging",
    };
    const executor: SqlExecutor = {
      execute: async (sql) => { updates.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM turn_questions q")) {
          return [{
            id: questionId,
            run_id: runId,
            session_id: sessionId,
            step_id: stepId,
            tool_call_id: null,
            question: "Which environment?",
            status: "answered",
            answer: storedAnswer,
            run_state: "waiting",
            task_id: taskId,
            created_at: "2026-07-28T00:00:00.000Z",
          }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);
    const replay = {
      answer: "Staging",
      selectedOptions: ["Staging"],
      answers: [{ question: "Which environment?", answer: "Staging", selectedOptions: ["Staging"] }],
    };

    await expect(service.answerQuestion(tenantId, userId, questionId, replay)).resolves.toBe(true);
    await expect(service.answerQuestion(tenantId, userId, questionId, {
      ...replay,
      answers: [{ question: "Which environment?", answer: "Production", selectedOptions: ["Production"] }],
    })).resolves.toBe(false);
    expect(updates.some((sql) => sql.includes("UPDATE turn_questions"))).toBe(false);
  });

  it("atomically cancels an active run and projects its partial assistant output", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT id,task_id,session_id,request_message_id")) {
          return [{ id: runId, task_id: taskId, session_id: sessionId, request_message_id: userId }] as T[];
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
    expect(executions.some(({ sql }) =>
      sql.startsWith("UPDATE turn_runs") && sql.includes("state=CASE") && sql.includes("ELSE 'cancelled'")
    )).toBe(true);
    expect(executions.some(({ params }) =>
      params.some((value) => typeof value === "string" && value.includes('"kind":"turn.end"'))
    )).toBe(true);
  });

  it("cancels active durable work and soft-deletes the task in one transaction", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    let transactionCount = 0;
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT id FROM tasks")) return [{ id: taskId }] as T[];
        if (sql.includes("SELECT id,task_id,session_id,request_message_id")) {
          return [{ id: runId, task_id: taskId, session_id: sessionId, request_message_id: userId }] as T[];
        }
        if (sql.includes("FROM turn_events") && sql.includes("ORDER BY sequence ASC")) return [] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0)+1 AS value")) return [{ value: 1 }] as T[];
        if (sql.includes("COALESCE(MAX(sequence),0) AS sequence")) return [{ sequence: 1 }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => {
        transactionCount += 1;
        return callback(executor);
      },
    };
    const service = new DurableTurnService(new CloudDatabaseService(executor), true);

    await expect(service.deleteTask(tenantId, userId, taskId)).resolves.toBe(true);

    expect(transactionCount).toBe(1);
    expect(executions.some(({ sql }) =>
      sql.startsWith("UPDATE turn_runs") && sql.includes("state=CASE") && sql.includes("ELSE 'cancelled'")
    )).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("SET deleted_at=COALESCE(deleted_at,now())"))).toBe(true);
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
