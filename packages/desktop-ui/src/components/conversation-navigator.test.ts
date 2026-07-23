import { describe, expect, it } from "vitest";
import { conversationMarkerWidth, type NavigatorItem } from "./conversation-navigator";

const item: NavigatorItem = {
  id: "message",
  label: "Short prompt",
  preview: "Short response",
};

describe("conversation navigator marker widths", () => {
  it("tapers across three markers on each side of the focused marker", () => {
    expect(conversationMarkerWidth(item, 8, 8)).toBe(42);
    expect(conversationMarkerWidth(item, 7, 8)).toBe(32);
    expect(conversationMarkerWidth(item, 9, 8)).toBe(32);
    expect(conversationMarkerWidth(item, 6, 8)).toBe(24);
    expect(conversationMarkerWidth(item, 10, 8)).toBe(24);
    expect(conversationMarkerWidth(item, 5, 8)).toBe(16);
    expect(conversationMarkerWidth(item, 11, 8)).toBe(16);
  });

  it("keeps most distant markers short with occasional structural widths", () => {
    expect(conversationMarkerWidth(item, 1, 8)).toBe(10);
    expect(conversationMarkerWidth(item, 5, -1)).toBe(20);
    expect(conversationMarkerWidth(item, 12, -1)).toBe(32);
    expect(conversationMarkerWidth({ ...item, resources: ["report.pdf"] }, 1, -1)).toBe(32);
  });

  it("caps the focused marker at the reduced 42px maximum", () => {
    const widths = Array.from({ length: 20 }, (_, index) => conversationMarkerWidth(item, index, 10));
    expect(Math.max(...widths)).toBe(42);
  });
});
