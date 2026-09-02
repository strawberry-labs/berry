import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { CloudDatabaseModule } from "../db/cloud-database.module.js";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";
import { QueuedFollowUpService } from "./queued-follow-up.service.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const workspaceId = "00000000-0000-7000-8000-000000000003";
const taskId = "00000000-0000-7000-8000-000000000004";
const sessionId = "00000000-0000-7000-8000-000000000005";
const queueId = "00000000-0000-7000-8000-000000000006";

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: queueId,
    workspace_id: workspaceId,
    task_id: taskId,
    session_id: sessionId,
    creator_user_id: userId,
    owner_user_id: userId,
    ordinal: 0,
    input: "Run the next step",
    intent: null,
    attachments: [{ fileId: "00000000-0000-7000-8000-000000000007", name: "brief.txt", mediaType: "text/plain", size: 12 }],
    status: "queued",
    idempotency_key: "browser-queue-1",
    delivery_key: null,
    attempt_count: 0,
    last_error: null,
    expires_at: "2026-08-17T00:00:00.000Z",
    created_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    delivered_at: null,
    ...overrides,
  };
}

function executorFor(options: { existing?: Record<string, unknown>; inserted?: Record<string, unknown> } = {}) {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: SqlExecutor = {
    execute: async (sql, params = []) => { executions.push({ sql, params }); },
    query: async <T>(sql: string, params = []) => {
      queries.push({ sql, params });
      if (sql.includes("idempotency_key=$2")) return (options.existing ? [options.existing] : []) as T[];
      if (sql.includes("FROM tasks t") && sql.includes("r.runtime_request")) {
        return [{
          workspace_id: workspaceId,
          task_id: taskId,
          session_id: sessionId,
          owner_user_id: userId,
          runtime_request: { model: "test" },
          grounding_context: {},
          prompt_manifest: {},
        }] as T[];
      }
      if (sql.includes("count(*)::integer")) return [{ count: 0 }] as T[];
      if (sql.includes("COALESCE(MAX(ordinal)")) return [{ ordinal: 0 }] as T[];
      if (sql.includes("RETURNING id,workspace_id")) return [options.inserted ?? queueRow()] as T[];
      if (sql.includes("FROM queued_follow_up_items q") && sql.includes("ORDER BY q.ordinal")) return [queueRow()] as T[];
      return [] as T[];
    },
    transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
  };
  return { executor, queries, executions };
}

describe("QueuedFollowUpService", () => {
  it("receives CloudDatabaseService through Nest module injection", async () => {
    const fake = executorFor();
    const moduleRef = await Test.createTestingModule({
      imports: [CloudDatabaseModule.register({ useValue: fake.executor })],
      providers: [QueuedFollowUpService],
    }).compile();

    try {
      await expect(moduleRef.get(QueuedFollowUpService).list(tenantId, userId, sessionId)).resolves.toMatchObject({
        items: [{ id: queueId }],
      });
    } finally {
      await moduleRef.close();
    }
  });

  it("is idempotent and strips browser-only attachment payloads before persistence", async () => {
    const first = executorFor({ inserted: queueRow({ attachments: [{ fileId: "00000000-0000-7000-8000-000000000007", name: "brief.txt", mediaType: "text/plain", size: 12 }] }) });
    const service = new QueuedFollowUpService(new CloudDatabaseService(first.executor));
    const value = {
      taskId,
      workspaceId,
      input: "Run the next step",
      attachments: [{ fileId: "00000000-0000-7000-8000-000000000007", name: "brief.txt", mediaType: "text/plain", size: 12, dataUrl: "data:text/plain;base64,secret", localPath: "/tmp/secret" }],
      idempotencyKey: "browser-queue-1",
    };

    await expect(service.enqueue(tenantId, userId, sessionId, value)).resolves.toMatchObject({ id: queueId, status: "queued" });
    const insert = first.queries.find(({ sql }) => sql.includes("RETURNING id,workspace_id"));
    expect(insert?.params[9]).toBe(JSON.stringify([{ fileId: "00000000-0000-7000-8000-000000000007", name: "brief.txt", mediaType: "text/plain", size: 12 }]));

    const duplicate = executorFor({ existing: queueRow() });
    const duplicateService = new QueuedFollowUpService(new CloudDatabaseService(duplicate.executor));
    await expect(duplicateService.enqueue(tenantId, userId, sessionId, value)).resolves.toMatchObject({ id: queueId });
    expect(duplicate.queries.some(({ sql }) => sql.includes("INSERT INTO queued_follow_up_items"))).toBe(false);
  });

  it("scopes listing to active rows and expires stale or unauthorized tasks", async () => {
    const fake = executorFor();
    const service = new QueuedFollowUpService(new CloudDatabaseService(fake.executor));
    await expect(service.list(tenantId, userId, sessionId, undefined, 20)).resolves.toMatchObject({ items: [{ id: queueId }] });
    const list = fake.queries.find(({ sql }) => sql.includes("ORDER BY q.ordinal"));
    expect(list?.sql).toContain("q.status = ANY($4::text[])");
    expect(fake.executions.filter(({ sql }) => sql.includes("status='expired'")).length).toBe(1);
    expect(fake.executions.filter(({ sql }) => sql.includes("status='cancelled'")).length).toBe(1);
  });
});
