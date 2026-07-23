import { describe, expect, it } from "vitest";
import { conversationMarkerWidth, type NavigatorItem } from "./conversation-navigator";

const item: NavigatorItem = {
  id: "message",
  label: "Short prompt",
  preview: "Short response",
};

describe("conversation navigator marker widths", () => {
  it("tapers across three markers on each side of the hovered, focused, or scrubbed prompt", () => {
    expect(conversationMarkerWidth(item, 8, 8)).toBe(26);
    expect(conversationMarkerWidth(item, 7, 8)).toBe(20);
    expect(conversationMarkerWidth(item, 9, 8)).toBe(20);
    expect(conversationMarkerWidth(item, 6, 8)).toBe(14);
    expect(conversationMarkerWidth(item, 10, 8)).toBe(14);
    expect(conversationMarkerWidth(item, 5, 8)).toBe(10);
    expect(conversationMarkerWidth(item, 11, 8)).toBe(10);
  });

  it("keeps every non-neighbor at the 6px idle width", () => {
    expect(conversationMarkerWidth(item, 1, 8)).toBe(6);
    expect(conversationMarkerWidth(item, 5, -1)).toBe(6);
    expect(conversationMarkerWidth({ ...item, resources: ["report.pdf"] }, 1, -1)).toBe(6);
  });

  it("caps the target marker at the nominal 26px maximum", () => {
    const widths = Array.from({ length: 20 }, (_, index) => conversationMarkerWidth(item, index, 10));
    expect(Math.max(...widths)).toBe(26);
  });
});
