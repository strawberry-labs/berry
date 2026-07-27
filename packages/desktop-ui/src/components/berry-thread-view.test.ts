import { describe, expect, it } from "vitest";
import type { Message } from "@berry/shared";
import { isContinuableAssistantTurn } from "./berry-thread-view";

function assistant(status: Message["status"], id: string): Message {
  const createdAt = "2026-07-27T05:20:55.000Z";
  return {
    id,
    sessionId: "session_1",
    role: "assistant",
    status,
    parts: [{
      id: `${id}_part`,
      messageId: id,
      kind: status === "failed" ? "error" : "text",
      content: status === "failed" ? "Provider request failed with 504" : "Recovered",
      position: 0,
      createdAt,
    }],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("failed assistant turn recovery", () => {
  it("offers continuation when the latest assistant boundary failed", () => {
    expect(isContinuableAssistantTurn([
      assistant("complete", "assistant_tool_work"),
      assistant("failed", "assistant_failure"),
    ])).toBe(true);
  });

  it("removes continuation after a later assistant response completes", () => {
    expect(isContinuableAssistantTurn([
      assistant("failed", "assistant_failure"),
      assistant("complete", "assistant_recovered"),
    ])).toBe(false);
  });
});
