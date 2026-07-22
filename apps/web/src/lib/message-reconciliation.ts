import type { Message } from "@berry/shared";

/** IDs created in the browser before the API confirms the persisted message. */
export const OPTIMISTIC_MESSAGE_ID_PREFIX = "local_message_";

function fingerprint(message: Message): string {
  return JSON.stringify({
    role: message.role,
    // PostgreSQL jsonb canonicalizes object-key order. Normalize recursively so
    // an optimistic attachment and its persisted copy compare by value rather
    // than by the order in which their object properties were inserted.
    parts: message.parts.map(({ kind, content, position }) => ({ kind, content: stableValue(content), position })),
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

/**
 * A route-load request can finish after a user has submitted a message, but
 * before the API has committed that message. Keep that optimistic message in
 * the thread until a matching persisted copy arrives.
 */
export function reconcileFetchedSessionMessages(serverMessages: Message[], localMessages: Message[]): Message[] {
  // Use counts rather than a Set. Two identical prompts are two separate
  // turns; one persisted copy must only consume one optimistic copy.
  const serverFingerprintCounts = new Map<string, number>();
  for (const serverMessage of serverMessages) {
    const key = fingerprint(serverMessage);
    serverFingerprintCounts.set(key, (serverFingerprintCounts.get(key) ?? 0) + 1);
  }
  const pendingLocalMessages = localMessages.filter((message) => {
    if (!message.id.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX)) return false;
    const key = fingerprint(message);
    const remaining = serverFingerprintCounts.get(key) ?? 0;
    if (remaining <= 0) return true;
    serverFingerprintCounts.set(key, remaining - 1);
    return false;
  });
  return [...serverMessages, ...pendingLocalMessages];
}

/**
 * Replace the exact optimistic row as soon as appendMessage returns. The
 * persisted row may already have arrived through a concurrent route/SSE
 * refresh, so remove the optimistic row instead of inserting a second copy.
 */
export function confirmOptimisticMessage(messages: Message[], optimisticMessageId: string, persistedMessage: Message): Message[] {
  const persistedAlreadyPresent = messages.some((message) => message.id === persistedMessage.id);
  return messages.flatMap((message) => {
    if (message.id !== optimisticMessageId) return [message];
    return persistedAlreadyPresent ? [] : [persistedMessage];
  });
}
