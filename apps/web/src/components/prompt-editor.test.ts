import { describe, expect, it } from "vitest";
import { readPromptSendBehavior, shouldSubmitPromptOnEnter, shouldSubmitPromptOnModifierEnter } from "./prompt-editor.tsx";

const baseEvent = {
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
};

describe("prompt editor keyboard submission", () => {
  it("uses Enter by default and reads the modifier preference", () => {
    expect(readPromptSendBehavior({ getItem: () => null })).toBe("enter");
    expect(readPromptSendBehavior({ getItem: () => "enter" })).toBe("enter");
    expect(readPromptSendBehavior({ getItem: () => "modifier" })).toBe("modifier");
  });

  it("submits plain Enter only in Enter mode", () => {
    expect(shouldSubmitPromptOnEnter(baseEvent, "enter")).toBe(true);
    expect(shouldSubmitPromptOnEnter(baseEvent, "modifier")).toBe(false);
  });

  it("leaves modified, repeated, and composing Enter events to their dedicated handlers", () => {
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, shiftKey: true }, "enter")).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, metaKey: true }, "enter")).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, ctrlKey: true }, "enter")).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, repeat: true }, "enter")).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, isComposing: true }, "enter")).toBe(false);
  });

  it("submits Cmd/Ctrl + Enter without accepting unsafe modifier events", () => {
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true })).toBe(true);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, ctrlKey: true })).toBe(true);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true, shiftKey: true })).toBe(true);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true, altKey: true })).toBe(false);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, ctrlKey: true, repeat: true })).toBe(false);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true, isComposing: true })).toBe(false);
  });
});
