import { describe, expect, it } from "vitest";
import { IDLE, MAX_RETAINED_LIVE_TIMELINE_ENTRIES, reduceStream, windowLiveTimeline, type TimelineEntry } from "./thread-stream";

describe("live timeline rendering window", () => {
  it("keeps a hydrated start time when replaying the same durable turn", () => {
    const startedAt = Date.parse("2026-08-05T13:42:15.000Z");
    const hydrated = { ...IDLE, turnId: "turn_1", turnStartedAt: startedAt };

    expect(reduceStream(hydrated, { kind: "turn.start", turnId: "turn_1" }).turnStartedAt)
      .toBe(startedAt);
  });

  it("keeps the newest activity without deleting durable history", () => {
    const timeline: TimelineEntry[] = Array.from({ length: 5 }, (_, index) => ({
      kind: "note",
      note: "resumed",
      text: `note-${index}`,
    }));

    expect(windowLiveTimeline(timeline, 2)).toEqual({
      entries: timeline.slice(3),
      omitted: 3,
    });
    expect(timeline).toHaveLength(5);
  });

  it("evicts old completed live items from browser memory but keeps running tools", () => {
    let state = reduceStream(IDLE, { kind: "turn.start", turnId: "turn_long" });
    state = reduceStream(state, { kind: "tool.start", toolCallId: "still-running", name: "shell" });
    for (let index = 0; index < MAX_RETAINED_LIVE_TIMELINE_ENTRIES + 8; index += 1) {
      state = reduceStream(state, {
        kind: "session.note",
        note: "resumed",
        detail: `note-${index}`,
      });
    }

    expect(state.timeline.length).toBeLessThanOrEqual(MAX_RETAINED_LIVE_TIMELINE_ENTRIES + 1);
    expect(state.timelineOmitted).toBeGreaterThan(0);
    expect(state.timeline).toContainEqual(expect.objectContaining({ kind: "tool", toolCallId: "still-running" }));
  });
});

describe("image generation stream state", () => {
  it("keeps the newest partial for each batch request in request order", () => {
    let state = reduceStream(IDLE, { kind: "turn.start", turnId: "turn_1" });
    state = reduceStream(state, {
      kind: "tool.start",
      toolCallId: "image_1",
      name: "create_image",
      args: { batch_requests: [{ prompt: "one" }, { prompt: "two" }] },
    });
    state = reduceStream(state, {
      kind: "image.partial",
      toolCallId: "image_1",
      requestIndex: 1,
      index: 0,
      percentComplete: .25,
      b64: "dHdv",
      mimeType: "image/png",
      aspectRatio: "16:9",
    });
    state = reduceStream(state, {
      kind: "image.partial",
      toolCallId: "image_1",
      requestIndex: 0,
      index: 1,
      percentComplete: .5,
      b64: "b25l",
      mimeType: "image/png",
      aspectRatio: "1:1",
    });
    const tool = state.timeline[0];
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool") return;
    expect(tool.imageProgress).toEqual([
      expect.objectContaining({ requestIndex: 0, index: 1, percentComplete: .5, aspectRatio: "1:1" }),
      expect.objectContaining({ requestIndex: 1, index: 0, percentComplete: .25, aspectRatio: "16:9" }),
    ]);
  });
});

describe("question stream state", () => {
  it("keeps a durable question batch available for the web composer popup", () => {
    let state = reduceStream(IDLE, { kind: "turn.start", turnId: "turn_1" });
    state = reduceStream(state, {
      kind: "question.request",
      questionId: "question_1",
      toolCallId: "tool_1",
      question: "Which tone should I use?",
      options: [{ label: "Formal", description: "Business tone" }],
      multi: false,
      questions: [
        {
          question: "Which tone should I use?",
          options: [{ label: "Formal", description: "Business tone" }],
          multi: false,
        },
        {
          question: "When should it take effect?",
          options: [],
          multi: false,
        },
      ],
    });

    expect(state.turnActive).toBe(true);
    expect(state.question).toEqual(expect.objectContaining({
      questionId: "question_1",
      toolCallId: "tool_1",
      questions: [
        expect.objectContaining({ question: "Which tone should I use?" }),
        expect.objectContaining({ question: "When should it take effect?" }),
      ],
    }));
  });
});
