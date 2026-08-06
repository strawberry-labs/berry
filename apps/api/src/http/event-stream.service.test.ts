import { afterEach, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { ApiEventStreamService, DURABLE_EVENT_POLL_MS } from "./event-stream.service.ts";
import { DurableTurnService } from "../runtime/durable-turn.service.ts";

afterEach(() => vi.useRealTimers());

describe("ApiEventStreamService", () => {
  it("receives durable event storage through Nest dependency injection", async () => {
    const durable = {
      eventsAfter: vi.fn(async () => []),
    };
    const module = await Test.createTestingModule({
      providers: [
        ApiEventStreamService,
        { provide: DurableTurnService, useValue: durable },
      ],
    }).compile();
    const service = module.get(ApiEventStreamService);

    const stream = await service.streamDurable(
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      null,
    );

    expect(stream).toBeDefined();
    expect(durable.eventsAfter).toHaveBeenCalledOnce();
    await module.close();
  });

  it("drops a malformed durable cursor instead of polling from it forever", async () => {
    const durable = {
      eventsAfter: vi.fn(async () => []),
    } as unknown as DurableTurnService;
    const service = new ApiEventStreamService(durable);

    const stream = await service.streamDurable(
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      "not-a-cursor",
    );

    expect(stream).toBeDefined();
    expect(durable.eventsAfter).toHaveBeenCalledWith(
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      null,
      500,
      expect.any(Date),
    );
  });

  it("emits default SSE messages so EventSource.onmessage receives replayed and live events", () => {
    const service = new ApiEventStreamService();
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
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

  it("replays durable event sequences and ignores a duplicate returned during live polling", async () => {
    vi.useFakeTimers();
    const runId = "00000000-0000-7000-8000-000000000011";
    const pages = [
      [
        envelope(runId, 1, { kind: "turn.start", turnId: runId }),
        envelope(runId, 2, { kind: "message.start", messageId: "message-1", role: "assistant" }),
      ],
      [
        envelope(runId, 2, { kind: "message.start", messageId: "message-1", role: "assistant" }),
        envelope(runId, 3, { kind: "message.delta", messageId: "message-1", delta: "hello", channel: "text" }),
      ],
    ];
    let call = 0;
    const durable = {
      eventsAfter: async () => pages[Math.min(call++, pages.length - 1)]!,
    } as unknown as DurableTurnService;
    const service = new ApiEventStreamService(durable);
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const stream = await service.streamDurable(
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      null,
    );
    const subscription = stream.subscribe((event) => received.push(event));

    await vi.advanceTimersByTimeAsync(DURABLE_EVENT_POLL_MS);

    expect(received.map((event) => event.id)).toEqual([
      `${runId}:1`,
      `${runId}:2`,
      `${runId}:3`,
    ]);
    expect(received.map((event) => event.data)).toEqual([
      { kind: "turn.start", turnId: runId },
      { kind: "message.start", messageId: "message-1", role: "assistant" },
      { kind: "message.delta", messageId: "message-1", delta: "hello", channel: "text" },
    ]);
    subscription.unsubscribe();
  });
});

function envelope(
  runId: string,
  sequence: number,
  event: Parameters<ApiEventStreamService["publish"]>[1],
) {
  return {
    id: `${runId}:${sequence}`,
    runId,
    sequence,
    event,
    createdAt: `2026-07-28T12:00:0${sequence}.000Z`,
  };
}
