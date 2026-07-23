import { describe, expect, it } from "vitest";
import {
  commitQueuedFollowUps,
  nextQueuedFollowUp,
  parseQueuedFollowUps,
  queuedFollowUpStorageKey,
  readQueuedFollowUps,
  reconcileInterruptedQueuedFollowUps,
  writeQueuedFollowUps,
  type QueuedFollowUp,
} from "./queued-follow-ups.ts";

function followUp(id: string, sessionId = "session-1", ordinal = 0): QueuedFollowUp {
  return {
    id,
    taskId: "task-1",
    sessionId,
    ordinal,
    input: `Prompt ${id}`,
    attachments: [],
    status: "queued",
    error: null,
    pausedReason: null,
    messageId: null,
    deliveryMode: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("queued follow-up local storage", () => {
  it("round-trips the ordered queue for one session", () => {
    const storage = memoryStorage();
    expect(writeQueuedFollowUps("session-1", [followUp("second", "session-1", 8), followUp("first", "session-1", 3)], storage)).toBe(true);

    expect(readQueuedFollowUps("session-1", storage)).toEqual([
      expect.objectContaining({ id: "second", ordinal: 0 }),
      expect.objectContaining({ id: "first", ordinal: 1 }),
    ]);
  });

  it("keeps identical prompt text as separate queue iterations", () => {
    const storage = memoryStorage();
    const first = { ...followUp("iteration-1"), input: "Run this prompt again" };
    const second = { ...followUp("iteration-2", "session-1", 1), input: "Run this prompt again" };

    expect(writeQueuedFollowUps("session-1", [first, second], storage)).toBe(true);
    expect(readQueuedFollowUps("session-1", storage)).toEqual([
      expect.objectContaining({ id: "iteration-1", input: "Run this prompt again" }),
      expect.objectContaining({ id: "iteration-2", input: "Run this prompt again" }),
    ]);

    const cache = { "session-1": [first, second] };
    commitQueuedFollowUps(cache, "session-1", (current) => current.filter((item) => item.id !== first.id), storage);
    expect(readQueuedFollowUps("session-1", storage)).toEqual([
      expect.objectContaining({ id: "iteration-2", input: "Run this prompt again", ordinal: 0 }),
    ]);
  });

  it("ignores corrupt data and entries from another session", () => {
    expect(parseQueuedFollowUps("{broken", "session-1")).toEqual([]);
    expect(parseQueuedFollowUps(JSON.stringify([
      followUp("kept", "session-1"),
      followUp("ignored", "session-2"),
    ]), "session-1")).toEqual([
      expect.objectContaining({ id: "kept" }),
    ]);
  });

  it("removes the storage key when the queue becomes empty", () => {
    const storage = memoryStorage();
    storage.setItem(queuedFollowUpStorageKey("session-1"), "stale");

    expect(writeQueuedFollowUps("session-1", [], storage)).toBe(true);
    expect(storage.getItem(queuedFollowUpStorageKey("session-1"))).toBeNull();
  });

  it("makes rapid deletions authoritative before a turn-completion callback can drain", () => {
    const storage = memoryStorage();
    const cache: Record<string, QueuedFollowUp[]> = {};
    const queued = Array.from({ length: 10 }, (_, index) => followUp(`item-${index}`, "session-1", index));

    commitQueuedFollowUps(cache, "session-1", () => queued, storage);
    for (const item of queued) {
      commitQueuedFollowUps(cache, "session-1", (current) => current.filter((followUp) => followUp.id !== item.id), storage);
    }

    expect(cache["session-1"]).toEqual([]);
    expect(readQueuedFollowUps("session-1", storage)).toEqual([]);
    expect(nextQueuedFollowUp(cache["session-1"] ?? [])).toBeNull();
  });

  it("does not drain past an edited, paused, failed, or sending head item", () => {
    const queued = followUp("head");
    expect(nextQueuedFollowUp([queued], queued.id)).toBeNull();
    for (const status of ["paused", "failed", "sending"] as const) {
      expect(nextQueuedFollowUp([{ ...queued, status }])).toBeNull();
    }
    expect(nextQueuedFollowUp([queued])?.id).toBe("head");
  });

  it("only clears a refresh-interrupted send after its exact message is confirmed active", () => {
    const sending = { ...followUp("sending"), status: "sending" as const, messageId: "message-iteration-1", deliveryMode: "turn" as const };
    const next = followUp("next", "session-1", 1);

    expect(reconcileInterruptedQueuedFollowUps([sending, next], true, new Set(["message-iteration-1"]))).toEqual([next]);
    expect(reconcileInterruptedQueuedFollowUps([sending, next], true, new Set(["another-message"]))).toEqual([
      expect.objectContaining({
        id: "sending",
        status: "failed",
        error: "Delivery was interrupted by a refresh. Retry this message.",
      }),
      next,
    ]);
    expect(reconcileInterruptedQueuedFollowUps([sending, next], false, new Set(["message-iteration-1"]))).toEqual([
      expect.objectContaining({
        id: "sending",
        status: "failed",
        error: "The message was saved, but its turn did not start. Retry to continue without adding it twice.",
      }),
      next,
    ]);
    expect(reconcileInterruptedQueuedFollowUps(
      [{ ...sending, deliveryMode: "steer" }, next],
      false,
      new Set(["message-iteration-1"]),
    )).toEqual([next]);
  });
});
