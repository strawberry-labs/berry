import { describe, expect, it } from "vitest";
import { conversationProfilePrompt } from "./conversation-profiles.ts";

describe("conversation presentation profiles", () => {
  it("uses one task prompt with the full authorized tool set", () => {
    const prompt = conversationProfilePrompt("chat");
    expect(prompt).toContain("interaction clear");
    expect(prompt).toContain("full authorized tool set");
    expect(prompt).toContain("Programming work");
  });

  it("normalizes legacy code records to the same prompt", () => {
    expect(conversationProfilePrompt("code")).toBe(conversationProfilePrompt("chat"));
  });
});
