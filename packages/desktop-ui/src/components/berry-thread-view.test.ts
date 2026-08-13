import { describe, expect, it } from "vitest";
import type { Message } from "@berry/shared";
import {
  collectMessageDraftParts,
  isContinuableAssistantTurn,
  latestTerminalMessageStatus,
  latestArtifactToolCallIds,
  partitionAssistantParts,
  shouldReplaceLatestSettledAssistantWithLiveTurn,
} from "./berry-thread-view";
import { classifyTurnSegments } from "./thread-stream";

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

describe("continued assistant turn projection", () => {
  it("keeps the interrupted settled assistant visible beside resumed live work", () => {
    expect(shouldReplaceLatestSettledAssistantWithLiveTurn({
      liveVisible: true,
      latestTurnHasUser: true,
      continuation: true,
    })).toBe(false);
  });

  it("still replaces a normal turn's optimistic settled projection", () => {
    expect(shouldReplaceLatestSettledAssistantWithLiveTurn({
      liveVisible: true,
      latestTurnHasUser: true,
      continuation: false,
    })).toBe(true);
  });
});

describe("terminal tool projection", () => {
  it("does not settle a streaming continuation from an older terminal message", () => {
    expect(latestTerminalMessageStatus([
      assistant("complete", "assistant_previous"),
      assistant("streaming", "assistant_active"),
    ])).toBeUndefined();
    expect(latestTerminalMessageStatus([
      assistant("streaming", "assistant_previous"),
      assistant("failed", "assistant_terminal"),
    ])).toBe("failed");
  });

  it.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["complete", "completed"],
  ] as const)("settles unmatched historical tool calls for a %s turn", (messageStatus, toolStatus) => {
    const call = assistant("complete", `assistant_${messageStatus}_call`);
    call.parts = [{
      ...call.parts[0]!,
      kind: "tool-call",
      content: {
        toolCallId: `tool_${messageStatus}`,
        name: "task",
        status: "running",
        arguments: { description: "Inspect files" },
        children: [{
          toolCallId: `child_${messageStatus}`,
          name: "read",
          status: "running",
          args: { path: "/workspace/input.txt" },
        }],
      },
    }];

    const projected = partitionAssistantParts(call.parts, new Map(), undefined, messageStatus);
    expect(projected.segments).toEqual([
      expect.objectContaining({
        kind: "tools",
        tools: [expect.objectContaining({
          toolCallId: `tool_${messageStatus}`,
          status: toolStatus,
          children: [expect.objectContaining({
            toolCallId: `child_${messageStatus}`,
            status: toolStatus,
          })],
        })],
      }),
    ]);
  });

  it("keeps an explicit tool result status instead of overriding it from the turn", () => {
    const call = assistant("complete", "assistant_explicit_failure");
    call.parts = [{
      ...call.parts[0]!,
      kind: "tool-result",
      content: {
        toolCallId: "tool_explicit_failure",
        name: "write",
        status: "failed",
        summary: "write requires a non-empty path",
      },
    }];

    const projected = partitionAssistantParts(call.parts, new Map(), undefined, "cancelled");
    expect(projected.segments).toEqual([
      expect.objectContaining({
        kind: "tools",
        tools: [expect.objectContaining({ status: "failed" })],
      }),
    ]);
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

describe("artifact batch projection", () => {
  it("shows only the latest assistant publication batch", () => {
    const messages: Message[] = [];
    const appendBatch = (prefix: string, names: string[]) => {
      const callMessage = assistant("complete", `${prefix}_calls`);
      callMessage.parts = names.map((name, index) => ({
        ...callMessage.parts[0]!,
        id: `${prefix}_call_part_${index}`,
        kind: "tool-call" as const,
        position: index,
        content: {
          toolCallId: `${prefix}_call_${index}`,
          name: "persist_artifact",
          arguments: { path: `/workspace/outputs/${name}` },
        },
      }));
      messages.push(callMessage);
      names.forEach((name, index) => {
        const resultMessage = assistant("complete", `${prefix}_result_${index}`);
        resultMessage.parts = [{
          ...resultMessage.parts[0]!,
          id: `${prefix}_result_part_${index}`,
          kind: "tool-result",
          content: {
            toolCallId: `${prefix}_call_${index}`,
            name: "persist_artifact",
            status: "completed",
            output: {
              artifact: {
                name,
                path: `/v1/files/${prefix}-${index}`,
                mediaType: "image/png",
              },
            },
          },
        }];
        messages.push(resultMessage);
      });
    };

    appendBatch("first", ["old-a.png", "old-b.png"]);
    messages.push(assistant("complete", "more_work"));
    appendBatch("latest", ["new-a.png", "new-b.png", "new-c.png"]);

    const visible = latestArtifactToolCallIds(messages);
    const projected = partitionAssistantParts(
      messages.flatMap((message) => message.parts),
      new Map(),
      visible,
    );

    expect([...visible ?? []]).toEqual(["latest_call_0", "latest_call_1", "latest_call_2"]);
    expect(projected.segments.flatMap((segment) => segment.kind === "artifact" ? [segment.name] : []))
      .toEqual(["new-a.png", "new-b.png", "new-c.png"]);
    expect(projected.segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []))
      .toHaveLength(3);
  });

  it("keeps automatic publications from older output files out of the current turn", () => {
    const call = assistant("complete", "current_call");
    call.parts = [{
      ...call.parts[0]!,
      id: "current_call_part",
      kind: "tool-call",
      content: {
        toolCallId: "current_call_id",
        name: "persist_artifact",
        arguments: { path: "/workspace/outputs/current.png" },
      },
    }];
    const result = assistant("complete", "current_result");
    result.parts = [{
      ...result.parts[0]!,
      id: "current_result_part",
      kind: "tool-result",
      content: {
        toolCallId: "current_call_id",
        name: "persist_artifact",
        status: "completed",
        output: { artifact: { name: "current.png", path: "/v1/files/current" } },
      },
    }];
    const answer = assistant("complete", "answer");
    answer.parts[0] = { ...answer.parts[0]!, content: "The current image is ready." };
    const oldAutomatic = assistant("complete", "old_automatic");
    oldAutomatic.parts = [{
      ...oldAutomatic.parts[0]!,
      id: "old_automatic_part",
      kind: "tool-result",
      content: {
        toolCallId: "old_automatic_id",
        name: "persist_artifact",
        status: "completed",
        arguments: {},
        output: { artifact: { name: "old.png", path: "/v1/files/old" } },
      },
    }];
    const messages = [call, result, answer, oldAutomatic];

    const projected = partitionAssistantParts(
      messages.flatMap((message) => message.parts),
      new Map(),
      latestArtifactToolCallIds(messages),
    );
    const classified = classifyTurnSegments(projected.segments);

    expect(projected.segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []))
      .toEqual([expect.objectContaining({ toolCallId: "current_call_id" })]);
    expect(projected.segments.flatMap((segment) => segment.kind === "artifact" ? [segment.name] : []))
      .toEqual(["current.png"]);
    expect(classified.hasFinalText).toBe(true);
    expect(classified.body).toContainEqual(expect.objectContaining({ kind: "text", text: "The current image is ready." }));
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
