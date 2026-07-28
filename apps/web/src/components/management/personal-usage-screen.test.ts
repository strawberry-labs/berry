import type { UsageRequestSummary } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { summarizePromptCache } from "./personal-usage-screen";

function request(patch: Partial<UsageRequestSummary>): UsageRequestSummary {
  return {
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    ts: "2026-07-28T00:00:00.000Z",
    userId: "user-1",
    departmentId: null,
    workspaceId: null,
    agentId: null,
    feature: "model.turn",
    provider: "openai",
    model: "gpt-5",
    status: "completed",
    tokensIn: 100,
    tokensOut: 50,
    tokensCached: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheEligible: true,
    cacheMissReason: "first_request",
    billedCostMicros: "100",
    latencyMs: 100,
    ttftMs: 25,
    reservationStatus: "reconciled",
    ...patch,
  };
}

describe("summarizePromptCache", () => {
  it("counts hits and misses only among eligible requests", () => {
    expect(summarizePromptCache([
      request({ cacheReadTokens: 80, cacheMissReason: null }),
      request({ cacheReadTokens: 0 }),
      request({ cacheEligible: false, cacheReadTokens: 0 }),
    ])).toEqual({ eligibleRequests: 2, hits: 1, misses: 1, hitRate: 0.5 });
  });
});
