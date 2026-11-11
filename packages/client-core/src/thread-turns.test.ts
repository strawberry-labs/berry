import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "@berry/shared";
import type { ActivityTool } from "./activity.ts";
import {
  describeToolRow,
  exploreSummary,
  latestTurnActionText,
  thoughtSuffix,
  toolFlowSegments,
  turnActivityLabel,
} from "./activity-rows.ts";
import { assistantTurnText, groupSettledTurns, partitionAssistantParts, settledTurnTiming } from "./thread-turns.ts";

const at = "2026-10-09T10:00:00.000Z";

function message(id: string, role: Message["role"], parts: Array<Pick<MessagePart, "kind" | "content">>, overrides: Partial<Message> = {}): Message {
  return {
    id,
    sessionId: "s1",
    role,
    status: "complete",
    parts: parts.map((part, index) => ({ id: `${id}-p${index}`, messageId: id, position: index, createdAt: at, ...part })),
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as Message;
}

function tool(name: string, args: Record<string, unknown>, status: ActivityTool["status"] = "completed"): ActivityTool {
  return { toolCallId: `${name}-${JSON.stringify(args)}`, name, args, status, startedAt: 0 };
}

describe("settled turns", () => {
  it("groups consecutive assistant messages under their user turn and keeps keys stable", () => {
    const identities = new Map<string, string>();
    const messages = [message("u1", "user", []), message("a1", "assistant", []), message("a2", "assistant", []), message("u2", "user", [])];
    const groups = groupSettledTurns(messages, identities);
    expect(groups.map((group) => [group.key, group.assistants.map((item) => item.id)])).toEqual([["u1", ["a1", "a2"]], ["u2", []]]);
    // The optimistic user id is replaced by the server id: the turn keeps its key.
    const replaced = groupSettledTurns([message("u1-server", "user", []), message("a1", "assistant", [])], identities);
    expect(replaced[0]?.key).toBe("u1");
  });

  it("merges tool calls with their results and splits reasoning, tools and prose in order", () => {
    const { segments } = partitionAssistantParts([
      { id: "r", messageId: "a", kind: "reasoning", content: "Look first", position: 0, createdAt: at },
      { id: "c", messageId: "a", kind: "tool-call", content: { toolCallId: "t1", name: "read", arguments: { path: "/workspace/src/a.ts" } }, position: 1, createdAt: at },
      { id: "d", messageId: "a", kind: "tool-result", content: { toolCallId: "t1", name: "read", status: "completed", output: "ok" }, position: 2, createdAt: at },
      { id: "t", messageId: "a", kind: "text", content: "Done.", position: 3, createdAt: at },
    ] as MessagePart[]);
    expect(segments.map((segment) => segment.kind)).toEqual(["thought", "tools", "text"]);
    const tools = segments[1]?.kind === "tools" ? segments[1].tools : [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "read", status: "completed", output: "ok", args: { path: "/workspace/src/a.ts" } });
  });

  it("reports the worked-for duration from message timestamps", () => {
    const messages = [message("a1", "assistant", [{ kind: "text", content: "x".repeat(400) }], { createdAt: "2026-10-09T10:00:00.000Z", updatedAt: "2026-10-09T10:01:05.000Z", outputTokens: 130, generationMs: 2_000 })];
    expect(settledTurnTiming(messages, 0)).toMatchObject({ elapsedMs: 65_000, tokensPerSecond: undefined, modelMs: 2_000 });
    expect(assistantTurnText(messages)).toHaveLength(400);
  });
  it("weights decoding by paired tokens/time, excluding first-token wait and tools", () => {
    const messages = [
      message("a1", "assistant", [], { outputTokens: 200, generationMs: 7_000,
        modelTiming: { requestMs: 7_000, firstTokenMs: 5_000, decodeMs: 2_000, decodeTokens: 200 } }),
      message("a2", "assistant", [], { outputTokens: 150, generationMs: 4_000,
        modelTiming: { requestMs: 4_000, firstTokenMs: 1_000, decodeMs: 3_000, decodeTokens: 150 } }),
      message("old", "assistant", [], { outputTokens: 10_000, generationMs: 90_000 }),
    ];
    expect(settledTurnTiming(messages, 30_000, 135_000)).toMatchObject({
      elapsedMs: 135_000, tokensPerSecond: 70, decodeTokens: 350, decodeMs: 5_000,
      modelMs: 101_000, firstTokenMs: 6_000, toolMs: 30_000,
    });
    expect(settledTurnTiming(messages, 300_000).tokensPerSecond).toBe(70);
  });

  it("does not estimate tokens from text or divide by tool/wall time", () => {
    expect(settledTurnTiming([message("a", "assistant", [{ kind: "text", content: "x".repeat(400) }])], 30_000)
      .tokensPerSecond).toBeUndefined();
    expect(settledTurnTiming([message("a", "assistant", [], { outputTokens: 100 })], 30_000)
      .tokensPerSecond).toBeUndefined();
  });
});

describe("activity rows", () => {
  it("folds consecutive read-only calls into one Explore group", () => {
    const segments = toolFlowSegments([
      tool("read", { path: "/workspace/a.ts" }),
      tool("bash", { command: "rg TODO src" }),
      tool("bash", { command: "pnpm test" }),
      tool("task", { description: "Check docs" }),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["explore", "single", "subagent"]);
    expect(exploreSummary(segments[0]?.kind === "explore" ? segments[0].tools : [])).toBe("1 search, 1 file");
  });

  it("describes rows with the same verbs as the web", () => {
    expect(describeToolRow(tool("bash", { command: "pnpm test" }, "running"))).toMatchObject({ label: "Running", secondary: { text: "pnpm test", mono: true } });
    expect(describeToolRow(tool("read", { path: "/workspace/src/a.ts" }), "/workspace")).toMatchObject({ label: "Read", primary: { text: "a.ts", path: "/workspace/src/a.ts" }, secondary: { text: "src/" } });
    expect(describeToolRow(tool("write", { path: "notes.md" }))).toMatchObject({ label: "Wrote", icon: "pencil" });
    expect(describeToolRow(tool("todo_write", { todos: [{ content: "One", status: "completed" }, { content: "Two", status: "in_progress" }] }))).toMatchObject({ label: "Todo", primary: { text: "Two" }, secondary: { text: "1/2" } });
    expect(describeToolRow(tool("mcp.linear_search", {}, "failed"))).toMatchObject({ label: "Mcp Linear Search", status: "Failed" });
  });

  it("labels the turn header and live action", () => {
    expect(turnActivityLabel({ active: true })).toBe("Working...");
    expect(turnActivityLabel({ active: true, elapsedMs: 12_400 })).toBe("Working for 12s");
    expect(turnActivityLabel({ active: false, elapsedMs: 83_000, summary: "read 2 files" })).toBe("Worked for 1m 23s — read 2 files");
    expect(thoughtSuffix(false, 4_000)).toBe("for a few seconds");
    expect(latestTurnActionText([tool("read", { path: "/workspace/a.ts" }, "running")], "/workspace")).toMatchObject({ prefix: "Explore", verb: "Reading", text: "a.ts" });
  });
});
