import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServerQueuedFollowUp } from "@berry/shared";
import { nextQueuedFollowUp, serverQueuedFollowUpToClient, type QueuedFollowUp } from "@/lib/queued-follow-ups";
import {
  QUEUE_ROW_PRESENCE_MS,
  QueuedMessageList,
  mergeQueuePresentationRows,
  queuedActionLabel,
  reorderQueuedFollowUps,
  reorderableFollowUps,
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

  it("shows expired text as not sent, with Copy and Remove but no send, edit or reorder (H-015)", () => {
    const expired = { ...followUp("item-1"), status: "expired" as const, error: "This queued follow-up expired" };
    const pending = followUp("item-2");
    const noop = async () => undefined;
    const html = renderToStaticMarkup(createElement(QueuedMessageList, {
      followUps: [expired, pending],
      active: false,
      onRemove: noop,
      onRetry: noop,
      onReorder: () => undefined,
      onSendNow: noop,
      onEdit: () => undefined,
      onResume: noop,
    }));
    const [expiredRow, pendingRow] = html.split('role="listitem"').slice(1);

    expect(expiredRow).toContain("Expired, not sent");
    expect(expiredRow).toContain("Copy");
    expect(expiredRow).toContain("Remove expired message Queued message item-1");
    expect(expiredRow).not.toContain("Send now");
    expect(expiredRow).not.toContain("draggable");
    expect(pendingRow).toContain("Send now");
    expect(reorderableFollowUps([expired, pending]).map((item) => item.id)).toEqual(["item-2"]);
  });

  it("keeps expired server items expired and never delivers them (H-015)", () => {
    const server: ServerQueuedFollowUp = {
      id: "00000000-0000-7000-8000-000000000011",
      workspaceId: "00000000-0000-7000-8000-000000000012",
      taskId: "00000000-0000-7000-8000-000000000013",
      sessionId: "00000000-0000-7000-8000-000000000014",
      creatorUserId: "00000000-0000-7000-8000-000000000015",
      ownerUserId: "00000000-0000-7000-8000-000000000015",
      ordinal: 0,
      input: "Send the revised schedule",
      attachments: [],
      status: "expired",
      idempotencyKey: "queue-1",
      deliveryKey: null,
      attemptCount: 0,
      error: "This queued follow-up expired",
      expiresAt: "2026-10-14T00:00:00.000Z",
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z",
      deliveredAt: null,
    };
    const expired = serverQueuedFollowUpToClient(server);
    expect(expired.status).toBe("expired");
    const pending = followUp("item-2");
    expect(nextQueuedFollowUp([expired])).toBeNull();
    expect(nextQueuedFollowUp([expired, pending])?.id).toBe("item-2");
  });
});
