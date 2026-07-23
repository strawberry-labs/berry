import { describe, expect, it } from "vitest";
import { shouldSubmitPromptOnEnter, shouldSubmitPromptOnModifierEnter } from "./prompt-editor.tsx";

const baseEvent = {
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
};

describe("prompt editor keyboard submission", () => {
  it("submits plain Enter", () => {
    expect(shouldSubmitPromptOnEnter(baseEvent)).toBe(true);
  });

  it("leaves modified, repeated, and composing Enter events to their dedicated handlers", () => {
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, shiftKey: true })).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, metaKey: true })).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, ctrlKey: true })).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, repeat: true })).toBe(false);
    expect(shouldSubmitPromptOnEnter({ ...baseEvent, isComposing: true })).toBe(false);
  });

  it("submits Cmd/Ctrl + Enter without accepting unsafe modifier events", () => {
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true })).toBe(true);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, ctrlKey: true })).toBe(true);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true, shiftKey: true })).toBe(false);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true, altKey: true })).toBe(false);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, ctrlKey: true, repeat: true })).toBe(false);
    expect(shouldSubmitPromptOnModifierEnter({ ...baseEvent, metaKey: true, isComposing: true })).toBe(false);
  });
});
