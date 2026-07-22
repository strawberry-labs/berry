import { describe, expect, it } from "vitest";
import { questionAnswerTranscript, questionToolAnswer } from "./composer-question-overlay.tsx";

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
});
