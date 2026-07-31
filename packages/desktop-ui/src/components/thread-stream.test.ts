import { describe, expect, it } from "vitest";
import { IDLE, reduceStream } from "./thread-stream";

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
