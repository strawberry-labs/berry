import { describe, expect, it } from "vitest";
import { normalizeFollowUpMode } from "./follow-up-mode.ts";

describe("normalizeFollowUpMode", () => {
  it("keeps the supported modes", () => {
    expect(normalizeFollowUpMode("queue")).toBe("queue");
    expect(normalizeFollowUpMode("steer")).toBe("steer");
  });

  it("migrates the former interrupt setting to steer", () => {
    expect(normalizeFollowUpMode("interrupt")).toBe("steer");
  });

  it("falls back to queue for missing or unknown settings", () => {
    expect(normalizeFollowUpMode(null)).toBe("queue");
    expect(normalizeFollowUpMode("anything-else")).toBe("queue");
  });
});
