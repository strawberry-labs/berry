import { describe, expect, it } from "vitest";
import { SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { InMemoryCloudTaskStore, normalizeWorkspaceId } from "./cloud-task-store.ts";

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
});
