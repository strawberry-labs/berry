import { describe, expect, it } from "vitest";
import { conversationProfilePrompt } from "./conversation-profiles.ts";

describe("conversation presentation profiles", () => {
  it("keeps Chat tool-capable and thread-first", () => {
    const prompt = conversationProfilePrompt("chat");
    expect(prompt).toContain("thread-first");
    expect(prompt).toContain("full authorized tool set");
    expect(prompt).toContain("never changes permissions");
  });

  it("describes Code as presentation rather than a permission tier", () => {
    const prompt = conversationProfilePrompt("code");
    expect(prompt).toContain("Work end to end in the repository");
    expect(prompt).toContain("not an additional permission tier");
  });
});
