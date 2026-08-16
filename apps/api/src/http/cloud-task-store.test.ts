import { describe, expect, it, vi } from "vitest";
import { SELF_HOST_TENANT_ID, SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { InMemoryCloudTaskStore, normalizeWorkspaceId, PostgresCloudTaskStore } from "./cloud-task-store.ts";
import type { SqlExecutor } from "../db/cloud-database.service.ts";

describe("cloud workspace identifiers", () => {
  it("preserves valid project UUIDs instead of moving tasks to the default workspace", () => {
    const projectId = "f7faac34-1cc1-4395-8092-81ce5586a2cf";

    expect(normalizeWorkspaceId(projectId)).toBe(projectId);
  });

  it("retains the legacy self-host fallback for non-UUID workspace aliases", () => {
    expect(normalizeWorkspaceId("self-host")).toBe(SELF_HOST_WORKSPACE_ID);
  });
});

describe("task unread state", () => {
  it("normalizes legacy task kinds without persisting a web mode choice", async () => {
    const store = new InMemoryCloudTaskStore();
    const workspace = await store.createWorkspace({ name: "Project", ownerUserId: "user_1" });
    const created = await store.createTask({ workspaceId: workspace.id, ownerUserId: "user_1", conversationKind: "code" });

    expect(created.task.conversationKind).toBe("chat");
    const updated = await store.updateTask(created.task.id, { conversationKind: "code" }, "user_1");
    expect(updated.conversationKind).toBe("chat");
    expect(updated.updatedAt).toBe(created.task.updatedAt);
  });

  it("marks terminal work unread and clears it when the task is opened", async () => {
    const store = new InMemoryCloudTaskStore();
    const workspace = await store.createWorkspace({ name: "Project", ownerUserId: "user_1" });
    const { task } = await store.createTask({ workspaceId: workspace.id, ownerUserId: "user_1" });

    await store.updateTask(task.id, { status: "running" }, "user_1");
    const completed = await store.updateTask(task.id, { status: "completed" }, "user_1");
    expect(completed.unreadAt).not.toBeNull();
    expect(completed.lastReadAt).toBeNull();

    const read = await store.updateTask(task.id, { read: true }, "user_1");
    expect(read.unreadAt).toBeNull();
    expect(read.lastReadAt).not.toBeNull();
    expect(read.updatedAt).toBe(completed.updatedAt);
  });

  it("does not let a delayed read acknowledgement erase newer activity", async () => {
    const store = new InMemoryCloudTaskStore();
    const workspace = await store.createWorkspace({ name: "Project", ownerUserId: "user_1" });
    const { task } = await store.createTask({ workspaceId: workspace.id, ownerUserId: "user_1" });

    await store.updateTask(task.id, { status: "running" }, "user_1");
    const completed = await store.updateTask(task.id, { status: "completed" }, "user_1");
    const delayed = await store.updateTask(task.id, {
      read: true,
      readThrough: "2000-01-01T00:00:00.000Z",
    }, "user_1");

    expect(delayed.unreadAt).toBe(completed.unreadAt);
    expect(delayed.lastReadAt).toBeNull();
  });

  it("limits task listings to the requested task IDs", async () => {
    const store = new InMemoryCloudTaskStore();
    const workspace = await store.createWorkspace({ name: "Project", ownerUserId: "user_1" });
    const first = await store.createTask({ workspaceId: workspace.id, ownerUserId: "user_1" });
    const second = await store.createTask({ workspaceId: workspace.id, ownerUserId: "user_1" });

    await expect(store.listTasks({ ownerUserId: "user_1", taskIds: [second.task.id] }))
      .resolves.toEqual([second.task]);
    expect(first.task.id).not.toBe(second.task.id);
  });

  it("paginates enterprise task collections with a stable cursor and bulk-deletes only matching archived tasks", async () => {
    const store = new InMemoryCloudTaskStore();
    const project = await store.createWorkspace({ name: "Project", ownerUserId: "user_1" });
    const otherProject = await store.createWorkspace({ name: "Other", ownerUserId: "user_2" });
    const tasks = await Promise.all([
      store.createTask({ workspaceId: project.id, ownerUserId: "user_1", title: "Alpha" }),
      store.createTask({ workspaceId: project.id, ownerUserId: "user_1", title: "Beta" }),
      store.createTask({ workspaceId: project.id, ownerUserId: "user_1", title: "Gamma" }),
      store.createTask({ workspaceId: otherProject.id, ownerUserId: "user_2", title: "Alpha other user" }),
    ]);
    await store.updateTask(tasks[0]!.task.id, { archived: true }, "user_1");
    await store.updateTask(tasks[1]!.task.id, { archived: true }, "user_1");

    const first = await store.listTaskPage({ ownerUserId: "user_1", state: "archived", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = await store.listTaskPage({ ownerUserId: "user_1", state: "archived", limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.hasMore).toBe(false);

    await expect(store.listTaskPage({ ownerUserId: "user_1", state: "archived", search: "beta", limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ id: tasks[1]!.task.id, title: "Beta", archived: true })] });
    await expect(store.deleteArchivedTasks({ search: "alpha" }, "user_1")).resolves.toEqual({ deletedCount: 1 });
    await expect(store.listTaskPage({ ownerUserId: "user_1", state: "deleted", limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ id: tasks[0]!.task.id })] });
    await expect(store.listTaskPage({ ownerUserId: "user_2", state: "archived", limit: 10 }))
      .resolves.toMatchObject({ items: [] });
  });
});

describe("cloud message history pagination", () => {
  it("uses insertion order when timestamps collide and keeps cursors gap-safe", async () => {
    const store = new InMemoryCloudTaskStore();
    const { session } = await store.createTask({ workspaceId: SELF_HOST_WORKSPACE_ID, ownerUserId: null, title: "history" });
    const ids = ["first", "second", "third", "fourth"].map((name) => `msg_${name}`);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
    try {
      await Promise.all(ids.map((id, index) => store.appendMessage(session.id, {
        id,
        role: "user",
        parts: [{ kind: "text", content: `prompt-${index}` }],
      })));
    } finally {
      vi.useRealTimers();
    }

    const newest = await store.listMessagePage(session.id, { limit: 2 });
    expect(newest.messages.map((message) => message.id)).toEqual(ids.slice(-2));
    expect(newest.oldestSequence).toBe("3");
    expect(newest.newestSequence).toBe("4");
    expect(newest.historyRevision).toBe("0");

    const older = await store.listMessagePage(session.id, { limit: 2, before: newest.oldestSequence! });
    expect(older.messages.map((message) => message.id)).toEqual(ids.slice(0, 2));
    expect(older.hasOlder).toBe(false);
    expect(older.hasNewer).toBe(true);

    await Promise.all([
      store.appendMessage(session.id, {
        id: "msg_concurrent_a",
        role: "assistant",
        parts: [{ kind: "text", content: "arrived concurrently a" }],
      }),
      store.appendMessage(session.id, {
        id: "msg_concurrent_b",
        role: "assistant",
        parts: [{ kind: "text", content: "arrived concurrently b" }],
      }),
    ]);
    const after = await store.listMessagePage(session.id, { after: newest.newestSequence!, limit: 10 });
    expect(after.messages.map((message) => message.id)).toEqual(["msg_concurrent_a", "msg_concurrent_b"]);
    expect(after.historyRevision).toBe("0");
  });

  it("benchmarks a persisted-shaped 10,000-message history through bounded pages", async () => {
    const store = new InMemoryCloudTaskStore();
    const { session } = await store.createTask({ workspaceId: SELF_HOST_WORKSPACE_ID, ownerUserId: null, title: "10k history benchmark" });
    for (let index = 0; index < 10_000; index += 1) {
      await store.appendMessage(session.id, {
        id: `msg_benchmark_${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [{ kind: "text", content: `Persisted benchmark row ${index}` }],
      });
    }
    let page = await store.listMessagePage(session.id, { limit: 50 });
    let count = page.messages.length;
    let requests = 1;
    while (page.hasOlder && page.oldestSequence && requests < 300) {
      page = await store.listMessagePage(session.id, { limit: 50, before: page.oldestSequence });
      count += page.messages.length;
      requests += 1;
    }
    expect(count).toBe(10_000);
    expect(requests).toBe(200);
    expect(page.hasOlder).toBe(false);
    expect(page.messages).toHaveLength(50);
  });

  it("exercises the Postgres batched-parts and locking query path", async () => {
    const sessionId = "00000000-0000-7000-8000-000000000010";
    const messageId = "00000000-0000-7000-8000-000000000011";
    const calls: string[] = [];
    const executor: SqlExecutor = {
      async execute() {},
      async query<T>(sql: string): Promise<readonly T[]> {
        calls.push(sql);
        if (sql.includes("message_history_revision")) return [{ message_history_revision: "9", message_history_deletion_revision: "0" }] as T[];
        if (sql.includes("FROM sessions")) {
          return [{ id: sessionId, task_id: "00000000-0000-7000-8000-000000000012", parent_session_id: null, status: "active", model_provider_id: null, model: null, permission_mode: "full-access", created_at: new Date(), updated_at: new Date() }] as T[];
        }
        if (sql.includes("FROM messages") && sql.includes("LIMIT")) {
          return [{ id: messageId, session_id: sessionId, sequence_id: "7", role: "user", status: "complete", input_tokens: 0, output_tokens: 0, generation_ms: 0, created_at: new Date(), updated_at: new Date() }] as T[];
        }
        if (sql.includes("FROM message_parts")) {
          return [{ id: "00000000-0000-7000-8000-000000000013", message_id: messageId, type: "text", content: "batched", ordinal: 0, created_at: new Date() }] as T[];
        }
        if (sql.includes("SELECT EXISTS")) return [{ exists: false }] as T[];
        return [];
      },
    };
    const database = {
      withTenant: async <T>(_tenantId: string, work: (value: SqlExecutor) => Promise<T>) => work(executor),
    } as never;
    const store = new PostgresCloudTaskStore(database, SELF_HOST_TENANT_ID);

    const page = await store.listMessagePage(sessionId, { limit: 1 });
    expect(page.messages[0]?.parts[0]?.content).toBe("batched");
    expect(calls.some((sql) => sql.includes("FOR SHARE"))).toBe(true);
    expect(calls.some((sql) => sql.includes("ANY($2::uuid[])"))).toBe(true);
    expect(page.historyRevision).toBe("9");
    expect(page.historyDeletionRevision).toBe("0");
  });

  it("looks up a persisted message by session-scoped ID without materializing history", async () => {
    const store = new InMemoryCloudTaskStore();
    const { session } = await store.createTask({ workspaceId: SELF_HOST_WORKSPACE_ID, ownerUserId: null, title: "message lookup" });
    const message = await store.appendMessage(session.id, {
      id: "msg_lookup",
      role: "user",
      parts: [{ kind: "text", content: "persisted" }],
    });

    await expect(store.getMessage(session.id, message.id)).resolves.toEqual(message);
    await expect(store.getLatestUserMessage(session.id)).resolves.toEqual(message);
    await store.appendMessage(session.id, { id: "msg_lookup_assistant", role: "assistant", parts: [{ kind: "text", content: "reply" }] });
    await expect(store.getMessagePosition(session.id, message.id)).resolves.toMatchObject({ message, userOrdinal: 1 });
    await expect(store.getMessage(session.id, "msg_missing")).rejects.toThrow("Message not found");
    expect(await store.hasCancelledMessageAfter(session.id, message.id)).toBe(false);
    await store.appendMessage(session.id, { id: "msg_cancelled", role: "assistant", status: "cancelled", parts: [{ kind: "reasoning", content: "interrupted" }] });
    expect(await store.hasCancelledMessageAfter(session.id, message.id)).toBe(true);
  });

  it("does not return records deleted between page requests", async () => {
    const store = new InMemoryCloudTaskStore();
    const { session } = await store.createTask({ workspaceId: SELF_HOST_WORKSPACE_ID, ownerUserId: null, title: "deleted history" });
    const ids = ["keep_a", "remove", "keep_b"].map((id) => `msg_${id}`);
    for (const id of ids) {
      await store.appendMessage(session.id, { id, role: "user", parts: [{ kind: "text", content: id }] });
    }
    await store.deleteMessagesFrom(session.id, ids[1]!);
    const page = await store.listMessagePage(session.id, { limit: 10 });
    expect(page.messages.map((message) => message.id)).toEqual([ids[0]]);
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);
    expect(page.historyDeletionRevision).toBe("1");
  });

  it("derives directional flags from retained rows at deletion and cursor boundaries", async () => {
    const store = new InMemoryCloudTaskStore();
    const { session } = await store.createTask({ workspaceId: SELF_HOST_WORKSPACE_ID, ownerUserId: null, title: "boundaries" });
    for (const id of ["one", "two", "three"]) {
      await store.appendMessage(session.id, { id: `msg_${id}`, role: "user", parts: [{ kind: "text", content: id }] });
    }
    await store.deleteMessagesFrom(session.id, "msg_two");

    const emptyBeforeFirst = await store.listMessagePage(session.id, { before: "1", limit: 10 });
    expect(emptyBeforeFirst.messages).toHaveLength(0);
    expect(emptyBeforeFirst.hasOlder).toBe(false);
    expect(emptyBeforeFirst.hasNewer).toBe(true);

    const newest = await store.listMessagePage(session.id, { limit: 10 });
    expect(newest.messages.map((message) => message.id)).toEqual(["msg_one"]);
    expect(newest.hasOlder).toBe(false);
    expect(newest.hasNewer).toBe(false);

    const emptyAfterGap = await store.listMessagePage(session.id, { after: "3", limit: 10 });
    expect(emptyAfterGap.messages).toHaveLength(0);
    expect(emptyAfterGap.hasOlder).toBe(true);
    expect(emptyAfterGap.hasNewer).toBe(false);
  });
});
