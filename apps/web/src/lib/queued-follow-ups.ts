import { AttachmentInputSchema, type AttachmentInput } from "@berry/shared";
import { z } from "zod";

export const QUEUED_FOLLOW_UP_STORAGE_PREFIX = "berry.web.queuedFollowUps.v1:";

export const QueuedFollowUpSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  input: z.string().min(1),
  attachments: z.array(AttachmentInputSchema).default([]),
  status: z.enum(["queued", "sending", "paused", "failed"]),
  error: z.string().nullable().default(null),
  pausedReason: z.string().nullable().default(null),
  messageId: z.string().nullable().default(null),
  deliveryMode: z.enum(["steer", "turn"]).nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type QueuedFollowUp = z.infer<typeof QueuedFollowUpSchema>;
export type QueuedFollowUpsBySession = Record<string, QueuedFollowUp[]>;

export function queuedFollowUpStorageKey(sessionId: string): string {
  return `${QUEUED_FOLLOW_UP_STORAGE_PREFIX}${sessionId}`;
}

export function createQueuedFollowUp(input: {
  taskId: string;
  sessionId: string;
  ordinal: number;
  input: string;
  attachments?: AttachmentInput[];
}): QueuedFollowUp {
  const now = new Date().toISOString();
  return {
    id: `queued_follow_up_${globalThis.crypto.randomUUID()}`,
    taskId: input.taskId,
    sessionId: input.sessionId,
    ordinal: input.ordinal,
    input: input.input,
    attachments: input.attachments ?? [],
    status: "queued",
    error: null,
    pausedReason: null,
    messageId: null,
    deliveryMode: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function reindexQueuedFollowUps(followUps: QueuedFollowUp[]): QueuedFollowUp[] {
  return followUps.map((followUp, ordinal) => followUp.ordinal === ordinal
    ? followUp
    : { ...followUp, ordinal });
}

export function parseQueuedFollowUps(value: string | null, sessionId: string): QueuedFollowUp[] {
  if (!value) return [];
  try {
    const parsed = z.array(QueuedFollowUpSchema).safeParse(JSON.parse(value));
    if (!parsed.success) return [];
    return reindexQueuedFollowUps(parsed.data.filter((followUp) => followUp.sessionId === sessionId));
  } catch {
    return [];
  }
}

export function readQueuedFollowUps(sessionId: string, storage: Pick<Storage, "getItem"> = window.localStorage): QueuedFollowUp[] {
  try {
    return parseQueuedFollowUps(storage.getItem(queuedFollowUpStorageKey(sessionId)), sessionId);
  } catch {
    return [];
  }
}

export function writeQueuedFollowUps(
  sessionId: string,
  followUps: QueuedFollowUp[],
  storage: Pick<Storage, "setItem" | "removeItem"> = window.localStorage,
): boolean {
  try {
    const ordered = reindexQueuedFollowUps(followUps);
    if (ordered.length === 0) {
      storage.removeItem(queuedFollowUpStorageKey(sessionId));
      return true;
    }
    storage.setItem(queuedFollowUpStorageKey(sessionId), JSON.stringify(ordered));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the mutable cache authoritative so queue mutations are visible to SSE
 * completion handlers immediately, before React schedules its next render.
 */
export function commitQueuedFollowUps(
  cache: QueuedFollowUpsBySession,
  sessionId: string,
  update: (current: QueuedFollowUp[]) => QueuedFollowUp[],
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage,
): { followUps: QueuedFollowUp[]; persisted: boolean } {
  const current = sessionId in cache ? cache[sessionId]! : readQueuedFollowUps(sessionId, storage);
  const followUps = reindexQueuedFollowUps(update(current));
  cache[sessionId] = followUps;
  return {
    followUps,
    persisted: writeQueuedFollowUps(sessionId, followUps, storage),
  };
}

export function nextQueuedFollowUp(
  followUps: readonly QueuedFollowUp[],
  editingFollowUpId: string | null = null,
): QueuedFollowUp | null {
  const next = followUps[0];
  return next?.status === "queued" && next.id !== editingFollowUpId ? next : null;
}

export function reconcileInterruptedQueuedFollowUps(
  followUps: readonly QueuedFollowUp[],
  active: boolean,
  persistedMessageIds: ReadonlySet<string>,
): QueuedFollowUp[] {
  return followUps.flatMap((followUp) => {
    if (followUp.status !== "sending") return [followUp];
    const messageWasSaved = Boolean(followUp.messageId && persistedMessageIds.has(followUp.messageId));
    if (messageWasSaved && (followUp.deliveryMode === "steer" || active)) return [];
    return [{
      ...followUp,
      status: "failed" as const,
      error: messageWasSaved
        ? "The message was saved, but its turn did not start. Retry to continue without adding it twice."
        : "Delivery was interrupted by a refresh. Retry this message.",
      updatedAt: new Date().toISOString(),
    }];
  });
}
