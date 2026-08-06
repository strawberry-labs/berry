import { describe, expect, it } from "vitest";
import { questionAnswerTranscript, questionToolAnswer, stableQuestionAnswerMessageId, updateCustomAnswerDraft } from "./composer-question-overlay.tsx";

describe("question answer summaries", () => {
  const answers = [
    { question: "Which environment?", answer: "Production", selectedOptions: ["Production"], skipped: false },
    { question: "What should be omitted?", answer: "Skipped", selectedOptions: [], skipped: true },
  ];

  it("creates a compact user-visible Q&A transcript", () => {
    expect(questionAnswerTranscript(answers)).toBe("› Which environment?\nProduction\n\n› What should be omitted?\nSkipped");
  });

  it("keeps skipped answers explicit for the agent tool result", () => {
    expect(questionToolAnswer(answers)).toBe("Which environment?: Production\nWhat should be omitted?: Skipped");
  });

  it("maps durable and inline question ids to stable UUID answer messages", async () => {
    const durableId = "550e8400-e29b-41d4-a716-446655440000";
    const inlineId = "question_550e8400e29b41d4a716446655440000";
    await expect(stableQuestionAnswerMessageId(durableId)).resolves.toBe(durableId);
    await expect(stableQuestionAnswerMessageId(inlineId)).resolves.toBe(durableId);
    const first = await stableQuestionAnswerMessageId("fixture-question");
    await expect(stableQuestionAnswerMessageId("fixture-question")).resolves.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("stores a captured custom answer without retaining the React input event", () => {
    expect(updateCustomAnswerDraft({}, 0, "Monthly allowance?", "SAR 5,000")).toEqual({
      0: {
        question: "Monthly allowance?",
        answer: "SAR 5,000",
        selectedOptions: [],
        skipped: false,
        mode: "custom",
      },
    });
  });
});
