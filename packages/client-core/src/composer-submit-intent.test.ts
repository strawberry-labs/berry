import { describe, expect, it } from "vitest";
import { resolveComposerSubmitIntent } from "./composer-submit-intent.ts";

const baseEvent = {
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  metaKey: false,
  repeat: false,
  shiftKey: false,
};

describe("composer submit intent", () => {
  it("sends with Enter while the assistant is idle", () => {
    expect(resolveComposerSubmitIntent(false, baseEvent)).toBe("send");
    expect(resolveComposerSubmitIntent(false, null)).toBe("send");
  });

  it("queues with Enter while the assistant is processing", () => {
    expect(resolveComposerSubmitIntent(true, baseEvent)).toBe("queue");
    expect(resolveComposerSubmitIntent(true, null)).toBe("queue");
  });

  it("steers only with Cmd/Ctrl + Enter while processing", () => {
    expect(resolveComposerSubmitIntent(true, { ...baseEvent, metaKey: true })).toBe("steer");
    expect(resolveComposerSubmitIntent(true, { ...baseEvent, ctrlKey: true })).toBe("steer");
    expect(resolveComposerSubmitIntent(false, { ...baseEvent, metaKey: true })).toBe("ignore");
    expect(resolveComposerSubmitIntent(false, { ...baseEvent, ctrlKey: true })).toBe("ignore");
  });

  it("ignores newline, repeated, composing, and Alt-modified events", () => {
    expect(resolveComposerSubmitIntent(false, { ...baseEvent, shiftKey: true })).toBe("ignore");
    expect(resolveComposerSubmitIntent(true, { ...baseEvent, repeat: true })).toBe("ignore");
    expect(resolveComposerSubmitIntent(true, { ...baseEvent, isComposing: true })).toBe("ignore");
    expect(resolveComposerSubmitIntent(true, { ...baseEvent, altKey: true })).toBe("ignore");
  });
});
