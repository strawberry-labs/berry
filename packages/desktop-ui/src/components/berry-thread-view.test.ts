import { describe, expect, it } from "vitest";
import type { Message } from "@berry/shared";
import { collectMessageDraftParts, isContinuableAssistantTurn, partitionAssistantParts } from "./berry-thread-view";

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

  it("offers continuation when the latest assistant boundary was cancelled", () => {
    expect(isContinuableAssistantTurn([
      assistant("cancelled", "assistant_cancelled"),
    ])).toBe(true);
  });

  it("removes continuation after a later assistant response completes", () => {
    expect(isContinuableAssistantTurn([
      assistant("failed", "assistant_failure"),
      assistant("complete", "assistant_recovered"),
    ])).toBe(false);
  });
});

describe("structured writing block projection", () => {
  it("keeps every card when later tool results reuse the same draft id", () => {
    const first = assistant("complete", "assistant_draft_1");
    first.parts = [{
      ...first.parts[0]!,
      id: "draft_part_1",
      kind: "tool-result",
      content: {
        name: "compose_message",
        status: "completed",
        output: {
          draft: {
            id: "project-update",
            kind: "email",
            variants: [{ label: "Professional", subject: "Original", body: "Original body" }],
          },
        },
      },
    }];
    const second = assistant("complete", "assistant_draft_2");
    second.parts = [{
      ...second.parts[0]!,
      id: "draft_part_2",
      kind: "tool-result",
      content: {
        name: "compose_message",
        status: "completed",
        output: {
          draft: {
            id: "project-update",
            kind: "email",
            variants: [{ label: "Professional", subject: "Revised", body: "Revised body" }],
          },
        },
      },
    }];

    const resolutions = collectMessageDraftParts([first, second]);
    expect(resolutions.get("draft_part_1")).toMatchObject({
      draft: { variants: [{ subject: "Original", body: "Original body" }] },
    });
    expect(resolutions.get("draft_part_2")).toMatchObject({
      draft: { variants: [{ subject: "Revised", body: "Revised body" }] },
    });
    expect(partitionAssistantParts(first.parts, resolutions).segments).toEqual([
      expect.objectContaining({
        kind: "writing-block",
        id: "writing-block-draft_part_1",
        draft: expect.objectContaining({ id: "project-update" }),
      }),
    ]);
    expect(partitionAssistantParts(second.parts, resolutions).segments).toEqual([
      expect.objectContaining({
        kind: "writing-block",
        id: "writing-block-draft_part_2",
        draft: expect.objectContaining({
          id: "project-update",
          variants: [{ label: "Professional", subject: "Revised", body: "Revised body" }],
        }),
      }),
    ]);
  });
});

describe("citation projection", () => {
  it("omits legacy citation parts from the conversation UI", () => {
    const message = assistant("complete", "assistant_with_sources");
    message.parts = [
      {
        ...message.parts[0]!,
        id: "answer_part",
        kind: "text",
        content: "Grounded answer",
      },
      {
        ...message.parts[0]!,
        id: "citation_part",
        kind: "citation",
        position: 1,
        content: {
          sourceId: "source_1",
          chunkId: "chunk_1",
          label: "Internal document, page 1",
          href: "/v1/files/source_1",
        },
      },
    ];

    expect(partitionAssistantParts(message.parts).segments).toEqual([
      expect.objectContaining({ kind: "text", text: "Grounded answer" }),
    ]);
  });
});
