import { afterEach, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { ApiEventStreamService, DURABLE_EVENT_IDLE_POLL_MS, DURABLE_EVENT_POLL_MS, LEGACY_EVENT_GLOBAL_ENTRY_CAP, LEGACY_EVENT_SESSION_CAP, LEGACY_EVENT_TTL_MS } from "./event-stream.service.ts";
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

  it("emits replay and live SSE messages with stable legacy cursors", () => {
    const service = new ApiEventStreamService();
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_1", [{ kind: "turn.start", turnId: "turn_1" }]).subscribe((event) => received.push(event));

    service.publish("session_1", { kind: "turn.end", turnId: "turn_1", status: "completed" });

    expect(received).toHaveLength(2);
    expect(received.map((event) => event.id)).toEqual(["legacy:1", "legacy:2"]);
    expect(received.map((event) => event.data)).toEqual([
      { kind: "turn.start", turnId: "turn_1" },
      { kind: "turn.end", turnId: "turn_1", status: "completed" },
    ]);
    subscription.unsubscribe();
  });

  it("does not replay legacy events at or before the reconnect cursor", () => {
    const service = new ApiEventStreamService();
    const replay = [
      { kind: "turn.start" as const, turnId: "turn_1" },
      { kind: "message.delta" as const, messageId: "message_1", delta: "hello", channel: "text" as const },
    ];
    const first: Array<MessageEvent<unknown> & { id?: string }> = [];
    const firstSubscription = service.stream("session_legacy", replay).subscribe((event) => first.push(event));
    service.publish("session_legacy", { kind: "turn.end", turnId: "turn_1", status: "completed" });
    firstSubscription.unsubscribe();

    const second: Array<MessageEvent<unknown> & { id?: string }> = [];
    const secondSubscription = service.stream("session_legacy", replay, "legacy:2").subscribe((event) => second.push(event));
    expect(first.map((event) => event.id)).toEqual(["legacy:1", "legacy:2", "legacy:3"]);
    expect(second).toEqual([]);
    secondSubscription.unsubscribe();
  });

  it("preserves consecutive identical legacy replay events", () => {
    const service = new ApiEventStreamService();
    const replay = [
      { kind: "message.delta" as const, messageId: "message_1", delta: "same", channel: "text" as const },
      { kind: "message.delta" as const, messageId: "message_1", delta: "same", channel: "text" as const },
    ];
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_identical", replay).subscribe((event) => received.push(event));
    expect(received.map((event) => event.id)).toEqual(["legacy:1", "legacy:2"]);
    subscription.unsubscribe();
  });

  it("maps an identical replay suffix after the reconnect cursor", () => {
    const service = new ApiEventStreamService();
    const event = { kind: "message.delta" as const, messageId: "message_suffix", delta: "same", channel: "text" as const };
    service.publish("session_suffix", event);
    service.publish("session_suffix", event);
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_suffix", [event], "legacy:1").subscribe((item) => received.push(item));
    expect(received.map((item) => item.id)).toEqual(["legacy:2"]);
    subscription.unsubscribe();
  });

  it("does not append an exact-cursor replay suffix as a duplicate", () => {
    const service = new ApiEventStreamService();
    const start = { kind: "turn.start" as const, turnId: "turn_exact" };
    const event = { kind: "message.delta" as const, messageId: "message_exact", delta: "same", channel: "text" as const };
    service.publish("session_exact", start);
    service.publish("session_exact", event);
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_exact", [event], "legacy:2", "turn_exact").subscribe((item) => received.push(item));
    expect(received).toEqual([]);
    subscription.unsubscribe();
  });

  it("matches large replay payloads without retaining their body in legacy state", () => {
    const service = new ApiEventStreamService();
    const event = {
      kind: "image.partial" as const,
      toolCallId: "tool_large",
      requestIndex: 0,
      index: 0,
      percentComplete: 0.5,
      b64: "a".repeat(512 * 1024),
      mimeType: "image/png",
      aspectRatio: "1:1" as const,
    };
    service.publish("session_large_replay", event);
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_large_replay", [event], "legacy:1").subscribe((item) => received.push(item));
    expect(received).toEqual([]);
    subscription.unsubscribe();
  });

  it("bounds replay identities across live legacy subjects", () => {
    const service = new ApiEventStreamService();
    const event = { kind: "message.delta" as const, messageId: "message_active_cap", delta: "same", channel: "text" as const };
    const sessionCount = Math.ceil(LEGACY_EVENT_GLOBAL_ENTRY_CAP / 2_048) + 1;
    const subscriptions = Array.from({ length: sessionCount }, (_, index) => (
      service.stream(`session_active_${index}`).subscribe()
    ));
    for (let index = 0; index < sessionCount; index += 1) {
      for (let eventIndex = 0; eventIndex < 2_048; eventIndex += 1) service.publish(`session_active_${index}`, event);
    }
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const reconnect = service.stream(`session_active_0`, [event], "legacy:2048").subscribe((item) => received.push(item));
    expect(received.map((item) => item.id)).toEqual(["legacy:2049"]);
    reconnect.unsubscribe();
    for (const subscription of subscriptions) subscription.unsubscribe();
  });

  it("does not reuse an earlier turn's identical event across a reconnect cursor", () => {
    const service = new ApiEventStreamService();
    const start = { kind: "turn.start" as const, turnId: "turn_1" };
    const event = { kind: "message.delta" as const, messageId: "message_reused", delta: "same", channel: "text" as const };
    service.publish("session_turns", start);
    service.publish("session_turns", event);
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_turns", [
      { kind: "turn.start" as const, turnId: "turn_2" },
      event,
    ], "legacy:2", "turn_2").subscribe((item) => received.push(item));
    expect(received.map((item) => item.id)).toEqual(["legacy:3", "legacy:4"]);
    subscription.unsubscribe();
  });

  it("matches a mid-turn replay to the active turn identity", () => {
    const service = new ApiEventStreamService();
    const delta = { kind: "message.delta" as const, messageId: "message_reused", delta: "same", channel: "text" as const };
    service.publish("session_mid_turn", { kind: "turn.start", turnId: "turn_1" });
    service.publish("session_mid_turn", delta);
    service.publish("session_mid_turn", { kind: "turn.start", turnId: "turn_2" });
    service.publish("session_mid_turn", delta);
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_mid_turn", [delta], "legacy:2", "turn_2").subscribe((item) => received.push(item));
    expect(received.map((item) => item.id)).toEqual(["legacy:4"]);
    subscription.unsubscribe();
  });

  it("bounds idle legacy replay sessions and preserves a reconnect cursor", () => {
    const service = new ApiEventStreamService();
    const event = { kind: "message.delta" as const, messageId: "message_evicted", delta: "same", channel: "text" as const };
    for (let index = 0; index < LEGACY_EVENT_SESSION_CAP + 1; index += 1) {
      service.publish(`session_idle_${index}`, event);
    }
    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service.stream("session_idle_0", [event], "legacy:1").subscribe((item) => received.push(item));
    expect(received.map((item) => item.id)).toEqual(["legacy:2"]);
    subscription.unsubscribe();
  });

  it("expires orphaned active legacy runs after the replay TTL", () => {
    vi.useFakeTimers();
    const service = new ApiEventStreamService();
    service.publish("session_orphaned", { kind: "turn.start", turnId: "turn_orphaned" });

    vi.advanceTimersByTime(LEGACY_EVENT_TTL_MS + 1);

    const received: Array<MessageEvent<unknown> & { id?: string }> = [];
    const subscription = service
      .stream(
        "session_orphaned",
        [{ kind: "message.delta", messageId: "message_after_expiry", delta: "hello", channel: "text" }],
        "legacy:0",
        "turn_orphaned",
      )
      .subscribe((event) => received.push(event));

    // The expired turn.start no longer pins the replay sequence/run identity;
    // the first post-expiry event can safely start a fresh replay window.
    expect(received.map((event) => event.id)).toEqual(["legacy:1"]);
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
    expect(received).toEqual([expect.objectContaining({ data: expect.objectContaining({ type: "task.updated", task: expect.objectContaining({ id: "task_1", conversationKind: "chat" }) }) })]);
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

  it("emits live reasoning before the terminal turn event", async () => {
    vi.useFakeTimers();
    const runId = "00000000-0000-7000-8000-000000000021";
    const pages = [
      [],
      [envelope(runId, 1, { kind: "message.delta", messageId: "message-1", delta: "Checking", channel: "reasoning" })],
      [envelope(runId, 2, { kind: "turn.end", turnId: runId, status: "completed" })],
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
    expect(received.map((event) => event.data)).toEqual([
      { kind: "message.delta", messageId: "message-1", delta: "Checking", channel: "reasoning" },
    ]);

    await vi.advanceTimersByTimeAsync(DURABLE_EVENT_POLL_MS);
    expect(received.at(-1)?.data).toEqual({ kind: "turn.end", turnId: runId, status: "completed" });
    subscription.unsubscribe();
  });

  it("backs off database reads while a durable turn has no new events", async () => {
    vi.useFakeTimers();
    const durable = {
      eventsAfter: vi.fn(async () => []),
    } as unknown as DurableTurnService;
    const service = new ApiEventStreamService(durable);
    const stream = await service.streamDurable(
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002",
      null,
    );
    const subscription = stream.subscribe();

    await vi.advanceTimersByTimeAsync(DURABLE_EVENT_IDLE_POLL_MS * 2);

    expect(durable.eventsAfter).toHaveBeenCalledTimes(5);
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
