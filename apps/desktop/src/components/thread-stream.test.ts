import { describe, expect, it } from "vitest";

import {
  classifyTurnSegments,
  groupLiveTimeline,
  IDLE,
  reduceStream,
  type MessageSegment,
  type StreamState,
} from "./thread-stream";

import type { AgentStreamEvent } from "@berry/shared";

function play(events: AgentStreamEvent[], from: StreamState = IDLE): StreamState {
  return events.reduce(reduceStream, from);
}

const turnStart: AgentStreamEvent = { kind: "turn.start", turnId: "t1" };
const msgStart: AgentStreamEvent = { kind: "message.start", messageId: "m1", role: "assistant" };
const textDelta = (delta: string): AgentStreamEvent => ({ kind: "message.delta", messageId: "m1", delta, channel: "text" });
const reasoningDelta = (delta: string): AgentStreamEvent => ({ kind: "message.delta", messageId: "m1", delta, channel: "reasoning" });
const toolStart = (id: string): AgentStreamEvent => ({ kind: "tool.start", toolCallId: id, name: "bash" });
const toolEnd = (id: string): AgentStreamEvent => ({ kind: "tool.end", toolCallId: id, status: "completed", durationMs: 5 });

describe("reduceStream", () => {
  it("preserves approval evidence for the live card", () => {
    const state = reduceStream(IDLE, {
      kind: "approval.request",
      approvalId: "approval_1",
      approvalKind: "file-edit",
      title: "apply_patch",
      detail: "npm test",
      rawDetail: "FOO=1 npm test",
      diff: "--- a/x\n+++ b/x",
      destructive: true,
      openWorld: true,
    });
    expect(state.approval).toMatchObject({ rawDetail: "FOO=1 npm test", diff: expect.stringContaining("+++ b/x"), destructive: true, openWorld: true });
  });

  it("ignores historical mode events without changing live presentation state", () => {
    const state = reduceStream(IDLE, {
      kind: "mode.changed",
      mode: "code",
      source: "agent",
      reason: "Repository work is needed",
      applied: false,
      pinnedByUser: false,
    });
    expect(state).toBe(IDLE);
  });

  it("marks the final answer as started once text streams (Codex hasFinalAssistantStarted)", () => {
    const state = play([turnStart, msgStart, toolStart("a"), toolEnd("a")]);
    expect(state.sawText).toBe(false);
    expect(play([textDelta("Hello")], state).sawText).toBe(true);
  });

  it("keeps sawText sticky when prose folds into the timeline before another tool", () => {
    const state = play([turnStart, msgStart, textDelta("Interim status."), toolStart("a")]);
    // The prose was intermediate — folded into the timeline — but the accordion
    // must not re-arm: collapse happens at most once per turn.
    expect(state.text).toBe("");
    expect(state.sawText).toBe(true);
    expect(state.timeline.map((entry) => entry.kind)).toEqual(["text", "tool"]);
  });

  it("resets sawText and endStatus on turn.start", () => {
    const prior = play([turnStart, msgStart, textDelta("Hi"), { kind: "turn.end", turnId: "t1", status: "completed" }]);
    expect(prior.endStatus).toBe("completed");
    const next = reduceStream(prior, turnStart);
    expect(next.sawText).toBe(false);
    expect(next.endStatus).toBeNull();
    expect(next.turnActive).toBe(true);
  });

  it("continues an interrupted turn without resetting its activity UI", () => {
    const interrupted = play([
      turnStart,
      msgStart,
      reasoningDelta("checked the state"),
      toolStart("a"),
      toolEnd("a"),
      { kind: "error", message: "Provider request failed with 429" },
      { kind: "turn.end", turnId: "t1", status: "failed" },
    ]);

    const resumed = play(
      [
        { kind: "turn.start", turnId: "t2", continuation: true },
        { kind: "message.start", messageId: "m2", role: "assistant" },
        toolStart("b"),
      ],
      interrupted,
    );

    expect(resumed.error).toBeNull();
    expect(resumed.turnActive).toBe(true);
    expect(resumed.timeline.map((entry) => entry.kind)).toEqual(["thought", "tool", "tool"]);
    expect(resumed.timeline.filter((entry) => entry.kind === "tool").map((entry) => entry.toolCallId)).toEqual(["a", "b"]);
  });

  it("keeps partial assistant prose through the first resumed message boundary", () => {
    const interrupted = play([
      turnStart,
      msgStart,
      textDelta("partial answer"),
      { kind: "error", message: "Provider request failed with 429" },
      { kind: "turn.end", turnId: "t1", status: "failed" },
    ]);
    const resumed = play(
      [
        { kind: "turn.start", turnId: "t2", continuation: true },
        { kind: "message.start", messageId: "m2", role: "assistant" },
        { kind: "message.delta", messageId: "m2", delta: " continued", channel: "text" },
      ],
      interrupted,
    );
    expect(resumed.text).toBe("partial answer continued");
  });

  it("records cancellation from turn.end so the accordion can pin open", () => {
    const state = play([turnStart, msgStart, toolStart("a"), { kind: "turn.end", turnId: "t1", status: "cancelled" }]);
    expect(state.turnActive).toBe(false);
    expect(state.endStatus).toBe("cancelled");
    // Cancelled with no final text → canCollapse inputs stay false.
    expect(state.sawText).toBe(false);
  });

  it("keeps one interleaved timeline per turn (single accordion source)", () => {
    const state = play([
      turnStart,
      msgStart,
      reasoningDelta("thinking"),
      toolStart("a"),
      toolEnd("a"),
      textDelta("Middle note"),
      toolStart("b"),
      toolEnd("b"),
      textDelta("Final answer"),
    ]);
    expect(state.timeline.map((entry) => entry.kind)).toEqual(["thought", "tool", "text", "tool"]);
    expect(state.text).toBe("Final answer");
    const segments = groupLiveTimeline(state.timeline);
    expect(segments.map((segment) => segment.kind)).toEqual(["thought", "tools", "text", "tools"]);
  });

  it("tracks a pending user question and clears it when answered", () => {
    const state = play([
      turnStart,
      {
        kind: "question.request",
        questionId: "question_1",
        toolCallId: "call_question_1",
        question: "Which path should I take?",
        options: [{ label: "A", description: "First path" }],
        multi: false,
      },
    ]);
    expect(state.question).toMatchObject({ questionId: "question_1", question: "Which path should I take?" });
    expect(play([{ kind: "question.answered", questionId: "other" }], state).question).not.toBeNull();
    expect(play([{ kind: "question.answered", questionId: "question_1" }], state).question).toBeNull();
  });

  it("keeps session note kind for distinct steering and follow-up markers", () => {
    const state = play([
      turnStart,
      { kind: "session.note", note: "steered", detail: "Steered: focus on tests" },
      { kind: "session.note", note: "followed-up", detail: "Queued follow-up: update docs" },
    ]);
    expect(state.timeline).toEqual([
      { kind: "note", note: "steered", text: "Steered: focus on tests" },
      { kind: "note", note: "followed-up", text: "Queued follow-up: update docs" },
    ]);
    expect(groupLiveTimeline(state.timeline)).toEqual([
      { kind: "note", note: "steered", text: "Steered: focus on tests" },
      { kind: "note", note: "followed-up", text: "Queued follow-up: update docs" },
    ]);
  });
});

describe("classifyTurnSegments", () => {
  const tool = (id: string): MessageSegment => ({
    kind: "tools",
    tools: [{ toolCallId: id, name: "bash", status: "completed", startedAt: 0 }],
  });
  const text = (id: string, value: string): MessageSegment => ({ kind: "text", id, text: value });
  const thought = (id: string): MessageSegment => ({ kind: "thought", id, text: "hmm" });
  const error = (id: string): MessageSegment => ({ kind: "error", id, text: "boom" });
  const artifact = (id: string): MessageSegment => ({ kind: "artifact", id, name: "report.pdf", path: "/v1/artifacts/report.pdf" });

  it("keeps intermediate prose inside the activity and only trailing text in the body (Codex LO/BO)", () => {
    const { activity, body, hasFinalText } = classifyTurnSegments([
      thought("th1"),
      tool("a"),
      text("t1", "interim"),
      tool("b"),
      text("t2", "final"),
    ]);
    expect(activity.map((segment) => segment.kind)).toEqual(["thought", "tools", "text", "tools"]);
    expect(body).toEqual([text("t2", "final")]);
    expect(hasFinalText).toBe(true);
  });

  it("reports no final text for a turn that ended on tools (cancelled/aborted shape)", () => {
    const { body, hasFinalText } = classifyTurnSegments([thought("th1"), tool("a")]);
    expect(body).toEqual([]);
    expect(hasFinalText).toBe(false);
  });

  it("always routes errors to the body", () => {
    const { activity, body } = classifyTurnSegments([tool("a"), error("e1"), tool("b")]);
    expect(activity.map((segment) => segment.kind)).toEqual(["tools", "tools"]);
    expect(body).toEqual([{ kind: "error", id: "e1", text: "boom" }]);
  });

  it("always routes persisted artifacts to the visible body", () => {
    const { activity, body } = classifyTurnSegments([tool("a"), artifact("file-1"), tool("b")]);
    expect(activity.map((segment) => segment.kind)).toEqual(["tools", "tools"]);
    expect(body).toEqual([artifact("file-1")]);
  });

  it("puts everything in the body when there is no activity", () => {
    const { activity, body, hasFinalText } = classifyTurnSegments([text("t1", "plain answer")]);
    expect(activity).toEqual([]);
    expect(body).toEqual([text("t1", "plain answer")]);
    expect(hasFinalText).toBe(true);
  });
});
