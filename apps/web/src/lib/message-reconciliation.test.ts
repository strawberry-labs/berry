import { describe, expect, it } from "vitest";
import { message } from "./fixtures";
import { confirmOptimisticMessage, OPTIMISTIC_MESSAGE_ID_PREFIX, reconcileFetchedSessionMessages } from "./message-reconciliation";

describe("reconcileFetchedSessionMessages", () => {
  it("keeps a just-submitted prompt when a route-load response is stale", () => {
    const local = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "Show the latest status");

    expect(reconcileFetchedSessionMessages([], [local])).toEqual([local]);
  });

  it("replaces the optimistic prompt with the persisted API message", () => {
    const local = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "Show the latest status");
    const persisted = message("msg_1", "session_1", "user", "Show the latest status");

    expect(reconcileFetchedSessionMessages([persisted], [local])).toEqual([persisted]);
  });

  it("replaces an optimistic attachment when jsonb returns its keys in a different order", () => {
    const local = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "What is in this image?");
    local.parts.push({
      id: "local_part",
      messageId: local.id,
      kind: "attachment",
      content: { fileId: "file_1", name: "logo.png", mediaType: "image/png", size: 8192 },
      position: 1,
      createdAt: local.createdAt,
    });
    const persisted = message("msg_1", "session_1", "user", "What is in this image?");
    persisted.parts.push({
      id: "persisted_part",
      messageId: persisted.id,
      kind: "attachment",
      content: { size: 8192, mediaType: "image/png", name: "logo.png", fileId: "file_1" },
      position: 1,
      createdAt: persisted.createdAt,
    });

    expect(reconcileFetchedSessionMessages([persisted], [local])).toEqual([persisted]);
  });

  it("keeps the second of two identical prompts until its own persisted copy arrives", () => {
    const first = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "Try again");
    const second = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}2`, "session_1", "user", "Try again");
    const persistedFirst = message("msg_1", "session_1", "user", "Try again");

    expect(reconcileFetchedSessionMessages([persistedFirst], [first, second])).toEqual([persistedFirst, second]);
  });

  it("reconciles multiple identical prompts one-for-one without clones", () => {
    const first = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "Try again");
    const second = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}2`, "session_1", "user", "Try again");
    const persistedFirst = message("msg_1", "session_1", "user", "Try again");
    const persistedSecond = message("msg_2", "session_1", "user", "Try again");

    expect(reconcileFetchedSessionMessages([persistedFirst, persistedSecond], [first, second])).toEqual([persistedFirst, persistedSecond]);
  });

  it("confirms the exact optimistic message without duplicating a concurrently fetched persisted copy", () => {
    const local = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "Review this file");
    const persisted = message("msg_1", "session_1", "user", "Review this file");

    expect(confirmOptimisticMessage([local], local.id, persisted)).toEqual([persisted]);
    expect(confirmOptimisticMessage([persisted, local], local.id, persisted)).toEqual([persisted]);
  });
});
