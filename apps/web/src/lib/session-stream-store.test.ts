import { describe, expect, it, vi } from "vitest";
import { IDLE } from "@berry/desktop-ui/components/thread-stream";
import { SessionStreamStore } from "./session-stream-store";

describe("SessionStreamStore", () => {
  it("notifies only listeners for the changed task", () => {
    const store = new SessionStreamStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe("task-a", first);
    store.subscribe("task-b", second);

    store.update("task-a", { kind: "turn.start", turnId: "turn-a" });

    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(store.get("task-a").turnId).toBe("turn-a");
    expect(store.get("task-b")).toBe(IDLE);
  });

  it("coalesces token bursts and cancels pending work when a task is reset", () => {
    vi.useFakeTimers();
    try {
      const store = new SessionStreamStore();
      const listener = vi.fn();
      store.subscribe("task-a", listener);
      store.update("task-a", { kind: "turn.start", turnId: "turn-a" });
      listener.mockClear();
      store.update("task-a", { kind: "message.delta", messageId: "message-a", delta: "one", channel: "text" });
      store.update("task-a", { kind: "message.delta", messageId: "message-a", delta: " two", channel: "text" });
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);
      expect(listener).toHaveBeenCalledOnce();
      expect(store.get("task-a").text).toBe("one two");

      listener.mockClear();
      store.update("task-a", { kind: "message.delta", messageId: "message-a", delta: " stale", channel: "text" });
      store.reset("task-a");
      vi.advanceTimersByTime(16);
      expect(listener).toHaveBeenCalledOnce();
      expect(store.get("task-a")).toBe(IDLE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels queued tokens when a replay snapshot replaces a task", () => {
    vi.useFakeTimers();
    try {
      const store = new SessionStreamStore();
      store.update("task-a", { kind: "turn.start", turnId: "turn-a" });
      store.update("task-a", { kind: "message.delta", messageId: "message-a", delta: "stale", channel: "text" });
      store.set("task-a", IDLE);
      vi.advanceTimersByTime(16);
      expect(store.get("task-a")).toBe(IDLE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a reset question authoritative instead of retaining the prior prompt", () => {
    const store = new SessionStreamStore();
    store.update("task-a", { kind: "question.request", questionId: "question-a", toolCallId: "tool-a", question: "Choose", options: [], multi: false });
    expect(store.get("task-a").question?.questionId).toBe("question-a");
    store.reset("task-a");
    expect(store.get("task-a").question).toBeNull();
  });
});
