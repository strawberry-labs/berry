import { describe, expect, it } from "vitest";
import { COMPOSER_SEND_ARROW_SIZE, COMPOSER_SEND_BUTTON_CLASS, normalizeQuestionDraft, questionAnswerTranscript, questionFileDropPolicy, questionInteractionLocked, questionToolAnswer, stableQuestionAnswerMessageId, strictQuestionAnswerAttachment, updateCustomAnswerDraft } from "./composer-question-overlay.tsx";

describe("question answer summaries", () => {
  const answers = [
    { question: "Which environment?", answer: "Production", selectedOptions: ["Production"], attachments: [], skipped: false },
    { question: "What should be omitted?", answer: "Skipped", selectedOptions: [], attachments: [], skipped: true },
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
        attachments: [],
        skipped: false,
        mode: "custom",
      },
    });
  });

  it("turns an untouched or blank custom answer into an explicit skip", () => {
    expect(normalizeQuestionDraft("Optional context?", undefined)).toMatchObject({
      answer: "Skipped",
      skipped: true,
      mode: "skipped",
    });
    expect(normalizeQuestionDraft("Optional context?", {
      question: "Optional context?",
      answer: "   ",
      selectedOptions: [],
      attachments: [],
      skipped: false,
      mode: "custom",
    })).toMatchObject({ answer: "Skipped", skipped: true, mode: "skipped" });
  });

  it("accepts an attachment-only custom answer", () => {
    const attachment = { fileId: "550e8400-e29b-41d4-a716-446655440000", name: "brief.pdf", mediaType: "application/pdf", size: 42 };
    expect(normalizeQuestionDraft("Upload the brief", {
      question: "Upload the brief",
      answer: "",
      selectedOptions: [],
      attachments: [attachment],
      skipped: false,
      mode: "custom",
    })).toMatchObject({ answer: "", attachments: [attachment], skipped: false });
  });

  it("locks navigation and submission for the full attachment upload", () => {
    expect(questionInteractionLocked(false, true)).toBe(true);
    expect(questionInteractionLocked(true, false)).toBe(true);
    expect(questionInteractionLocked(false, false)).toBe(false);
  });

  it("suppresses the browser file-drop default while question input is locked", () => {
    expect(questionFileDropPolicy(["Files"], true, true)).toEqual({
      suppressBrowserDefault: true,
      acceptFiles: false,
    });
    expect(questionFileDropPolicy(["text/plain"], false, true)).toEqual({
      suppressBrowserDefault: false,
      acceptFiles: false,
    });
  });

  it("shares the composer's exact send-arrow treatment", () => {
    expect(COMPOSER_SEND_BUTTON_CLASS).toBe("berry-composer-send size-8 rounded-full transition-[background-color,color,box-shadow,opacity,transform] active:scale-[0.96] disabled:opacity-45");
    expect(COMPOSER_SEND_ARROW_SIZE).toBe(18);
  });

  it("sends only fields accepted by the strict question-answer API schema", () => {
    expect(strictQuestionAnswerAttachment({ id: "file-1", name: "brief.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 42 })).toEqual({
      fileId: "file-1",
      name: "brief.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 42,
      sourceKind: "object-storage",
    });
  });
});
