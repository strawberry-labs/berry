import { describe, expect, it } from "vitest";
import { questionAnswerTranscript, questionToolAnswer, updateCustomAnswerDraft } from "./composer-question-overlay.tsx";

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
