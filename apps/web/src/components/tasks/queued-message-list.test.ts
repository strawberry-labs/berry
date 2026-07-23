import { describe, expect, it } from "vitest";
import type { QueuedFollowUp } from "@/lib/queued-follow-ups";
import {
  QUEUE_ROW_PRESENCE_MS,
  mergeQueuePresentationRows,
  queuedActionLabel,
  reorderQueuedFollowUps,
} from "./queued-message-list.tsx";

function followUp(id: string): QueuedFollowUp {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    ordinal: Number(id.slice(-1)),
    input: `Queued message ${id}`,
    attachments: [],
    status: "queued",
    error: null,
    pausedReason: null,
    messageId: null,
    deliveryMode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("queued message presentation", () => {
  it("keeps insertion order and supports drag reordering", () => {
    const queued = [followUp("item-1"), followUp("item-2"), followUp("item-3")];
    expect(reorderQueuedFollowUps(queued, "item-1", "item-3", true).map((item) => item.id)).toEqual(["item-2", "item-3", "item-1"]);
  });

  it("retains a removed middle row for the 180ms exit lifecycle", () => {
    const first = followUp("item-1");
    const middle = followUp("item-2");
    const last = followUp("item-3");
    const rows = mergeQueuePresentationRows([first, last], new Set(), [{ followUp: middle, index: 1 }]);

    expect(QUEUE_ROW_PRESENCE_MS).toBe(180);
    expect(rows.map((row) => `${row.followUp.id}:${row.presence}`)).toEqual(["item-1:present", "item-2:exiting", "item-3:present"]);
  });

  it("uses compact direct actions for steer, send, and retry", () => {
    expect(queuedActionLabel({ active: true, failed: false })).toBe("Steer");
    expect(queuedActionLabel({ active: false, failed: false })).toBe("Send now");
    expect(queuedActionLabel({ active: true, failed: true })).toBe("Retry");
  });
});
