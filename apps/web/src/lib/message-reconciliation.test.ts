import { describe, expect, it } from "vitest";
import { message } from "./fixtures";
import { confirmOptimisticMessage, OPTIMISTIC_MESSAGE_ID_PREFIX, reconcileDurableEventCursor, reconcileFetchedSessionMessages } from "./message-reconciliation";

describe("reconcileFetchedSessionMessages", () => {
  it("keeps a just-submitted prompt when a route-load response is stale", () => {
    const local = message(`${OPTIMISTIC_MESSAGE_ID_PREFIX}1`, "session_1", "user", "Show the latest status");

    expect(reconcileFetchedSessionMessages([], [local])).toEqual([local]);
  });

  it("keeps a UUID-backed durable prompt while its admission is pending", () => {
    const requestMessageId = "ba2f8d43-c491-4318-b0dc-f60b7d4b8360";
    const local = message(requestMessageId, "session_1", "user", "Review the attached file");

    expect(reconcileFetchedSessionMessages([], [local], new Set([requestMessageId]))).toEqual([local]);
  });

  it("settles a UUID-backed durable prompt once the server returns it", () => {
    const requestMessageId = "ba2f8d43-c491-4318-b0dc-f60b7d4b8360";
    const local = message(requestMessageId, "session_1", "user", "Review the attached file");
    const persisted = message(requestMessageId, "session_1", "user", "Review the attached file");

    expect(reconcileFetchedSessionMessages(
      [persisted],
      [local],
      new Set([requestMessageId]),
    )).toEqual([persisted]);
  });

  it("does not preserve an absent settled UUID message", () => {
    const settled = message("ba2f8d43-c491-4318-b0dc-f60b7d4b8360", "session_1", "user", "Old prompt");

    expect(reconcileFetchedSessionMessages([], [settled])).toEqual([]);
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

describe("reconcileDurableEventCursor", () => {
  it("accepts increasing event sequences and rejects replay overlap per run", () => {
    const first = reconcileDurableEventCursor({}, "ba2f8d43-c491-4318-b0dc-f60b7d4b8360:7");
    const duplicate = reconcileDurableEventCursor(first.sequences, "ba2f8d43-c491-4318-b0dc-f60b7d4b8360:7");
    const next = reconcileDurableEventCursor(first.sequences, "ba2f8d43-c491-4318-b0dc-f60b7d4b8360:8");
    const otherRun = reconcileDurableEventCursor(first.sequences, "d3ddcd40-e234-41f7-94b6-c55eef7d3492:1");

    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    expect(next.accepted).toBe(true);
    expect(otherRun.accepted).toBe(true);
  });

  it("fails open for legacy streams without a durable cursor", () => {
    expect(reconcileDurableEventCursor({}, null).accepted).toBe(true);
    expect(reconcileDurableEventCursor({}, "legacy-event-id").accepted).toBe(true);
  });
});
