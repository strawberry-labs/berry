import { describe, expect, it } from "vitest";
import { modelTimingFromDiagnostics } from "./model-timing.ts";

describe("model timing projection", () => {
  it("projects only measured timing and paired tokens", () => {
    expect(modelTimingFromDiagnostics({ latencyMs: 7_000, firstTokenMs: 5_000, decodeMs: 2_000, decodeTokens: 200, secret: "ignored" }))
      .toEqual({ requestMs: 7_000, firstTokenMs: 5_000, decodeMs: 2_000, decodeTokens: 200 });
  });
  it("does not invent historical decoding or accept malformed diagnostics", () => {
    expect(modelTimingFromDiagnostics(null)).toBeUndefined();
    expect(modelTimingFromDiagnostics({ latencyMs: -1 })).toBeUndefined();
    expect(modelTimingFromDiagnostics({ latencyMs: 200, firstTokenMs: 300, decodeMs: 10, decodeTokens: 2 })).toEqual({ requestMs: 200 });
    expect(modelTimingFromDiagnostics({ latencyMs: 200, firstTokenMs: 100, decodeMs: 1_000, decodeTokens: 2 }))
      .toEqual({ requestMs: 200, firstTokenMs: 100 });
    expect(modelTimingFromDiagnostics({ latencyMs: 200, firstTokenMs: 100 }))
      .toEqual({ requestMs: 200, firstTokenMs: 100 });
    expect(modelTimingFromDiagnostics({ latencyMs: 200, firstTokenMs: 100, decodeMs: 100, decodeTokens: NaN }))
      .toEqual({ requestMs: 200, firstTokenMs: 100 });
  });
});
