import { describe, expect, it } from "vitest";
import { ApiEventStreamService } from "./event-stream.service.ts";

describe("ApiEventStreamService", () => {
  it("emits default SSE messages so EventSource.onmessage receives replayed and live events", () => {
    const service = new ApiEventStreamService();
    const received: Array<MessageEvent<unknown>> = [];
    const subscription = service.stream("session_1", [{ kind: "turn.start", turnId: "turn_1" }]).subscribe((event) => received.push(event));

    service.publish("session_1", { kind: "turn.end", turnId: "turn_1", status: "completed" });

    expect(received).toHaveLength(2);
    expect(received.map((event) => event.type)).toEqual([undefined, undefined]);
    expect(received.map((event) => event.data)).toEqual([
      { kind: "turn.start", turnId: "turn_1" },
      { kind: "turn.end", turnId: "turn_1", status: "completed" },
    ]);
    subscription.unsubscribe();
  });

  it("publishes canonical task.updated events on the task channel", () => {
    const service = new ApiEventStreamService();
    const received: Array<MessageEvent<unknown>> = [];
    const subscription = service.taskStream("task_1").subscribe((event) => received.push(event));
    service.publishTask({
      id: "task_1",
      workspaceId: "workspace_1",
      title: "Task",
      status: "running",
      activeSessionId: "session_1",
      conversationKind: "code",
      pinned: false,
      archived: false,
      deletedAt: null,
      unreadAt: null,
      lastReadAt: null,
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
      worktreeBaseSha: null,
      pullRequestUrl: null,
      pullRequestNumber: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:01.000Z",
    });
    expect(received).toEqual([expect.objectContaining({ data: expect.objectContaining({ type: "task.updated", task: expect.objectContaining({ id: "task_1", conversationKind: "code" }) }) })]);
    subscription.unsubscribe();
  });
});
