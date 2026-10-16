import { describe, expect, it } from "vitest";

import { calculateCacheMetric, usageDateInput, usageRangeForPreset } from "./usage-controls";

describe("usage analytics controls", () => {
  it("creates stable preset date ranges", () => {
    expect(usageRangeForPreset("three-months", new Date("2026-08-10T12:00:00.000Z"), undefined, "UTC")).toEqual({
      from: "2026-05-12",
      to: "2026-08-10",
    });
    expect(usageRangeForPreset("all", new Date("2026-08-10T12:00:00.000Z"), undefined, "UTC")).toEqual({
      from: "1970-01-01",
      to: "2026-08-10",
    });
  });

  it("uses the viewer calendar date instead of the UTC date", () => {
    const instant = new Date("2026-08-09T22:30:00.000Z");
    expect(usageDateInput(instant, "Asia/Dubai")).toBe("2026-08-10");
    expect(usageRangeForPreset("month", instant, undefined, "Asia/Dubai")).toEqual({
      from: "2026-07-11",
      to: "2026-08-10",
    });
  });

  it("reports cached input-token share even when most requests had some cache hit", () => {
    // Audit baseline shape: 87% of calls read some cache, 17.8% of input tokens.
    expect(calculateCacheMetric({ inputTokens: 755_271_315, cacheReadTokens: 134_479_572, cacheEligibleRequests: 4_392, cacheHitRequests: 3_839 })).toMatchObject({
      label: "Cached input-token share",
      value: 134_479_572 / 755_271_315,
      hint: expect.stringContaining("3,839 requests read some cached input"),
    });
  });

  it("falls back to request hit rate only without token totals", () => {
    expect(calculateCacheMetric({ inputTokens: 0, cacheReadTokens: 0, cacheEligibleRequests: 10, cacheHitRequests: 3 })).toMatchObject({
      label: "Cache hit rate",
      value: 0.3,
    });
  });

  it("labels the token fallback accurately when eligibility is absent", () => {
    expect(calculateCacheMetric({ inputTokens: 1_000, cacheReadTokens: 400, cacheEligibleRequests: 0, cacheHitRequests: 0 })).toMatchObject({
      label: "Cached input-token share",
      value: 0.4,
    });
  });
});
