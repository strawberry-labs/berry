import { describe, expect, it } from "vitest";
import { contextEnvelopeKey, estimateContextEntryTokens, estimateContextValueTokens, measureContextEntries, resolveContextBudget, type ContextUsageAnchor } from "./context-budget.ts";

describe("shared context budget", () => {
  const runtime = { provider: { id: "router", baseUrl: "https://router.test/v1", apiType: "openai-chat-completions" }, model: "deepseek", reasoning: "high" };
  const manifest = { stablePrefixHash: "stable", requestPrefix: { toolsHash: "tools" } };
  const envelopeKey = contextEnvelopeKey(runtime, manifest);
  const anchor: ContextUsageAnchor = { version: 1, envelopeKey, projectedTokens: 5_000, requestMessageCount: 2, requestHash: "a".repeat(64) };
  const assistant = { payload: { message: { role: "assistant", stopReason: "toolUse", contextBudget: anchor, content: [{ type: "text", text: "hello" }] } } };

  it("prices image occurrences independently of encoded byte length", () => {
    const image = (length: number) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(length)}` } });
    expect(estimateContextValueTokens([image(10)])).toBe(estimateContextValueTokens([image(500_000)]));
    expect(estimateContextValueTokens([image(10), image(10)])).toBeGreaterThan(2_400);
    expect(estimateContextEntryTokens({ message: { role: "user", content: [{ type: "image", data: "A".repeat(500_000) }] } })).toBe(1_200);
  });

  it("folds trailing tool results and journaled context onto compatible provider usage", () => {
    const entries = [assistant, { payload: { message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(40) }] } } }, { payload: { type: "context", text: "y".repeat(80) } }];
    expect(measureContextEntries(entries, { envelopeKey })).toEqual({ usedTokens: 5_030, source: "provider-reported" });
    expect(measureContextEntries(entries, { envelopeKey, minimumTokens: 6_000 }).usedTokens).toBe(6_000);
  });

  it.each([
    { ...runtime, model: "glm" },
    { ...runtime, reasoning: "off" },
    { ...runtime, provider: { ...runtime.provider, baseUrl: "https://other.test/v1" } },
  ])("rejects usage from a different route/model/reasoning envelope", (changed) => {
    expect(measureContextEntries([assistant], { envelopeKey: contextEnvelopeKey(changed, manifest) }).source).toBe("estimated");
  });

  it("rejects changed tools, changed system instructions and rewritten request prefixes", () => {
    for (const changed of [{ ...manifest, stablePrefixHash: "changed" }, { ...manifest, requestPrefix: { toolsHash: "changed" } }]) {
      expect(measureContextEntries([assistant], { envelopeKey: contextEnvelopeKey(runtime, changed) }).source).toBe("estimated");
    }
    expect(measureContextEntries([assistant], { envelopeKey, acceptsAnchor: () => false }).source).toBe("estimated");
  });

  it("does not reuse legacy, malformed or failed-response usage as a current envelope", () => {
    for (const message of [
      { role: "assistant", usage: { input: 999_999, output: 2 } },
      { ...assistant.payload.message, stopReason: "error" },
      { ...assistant.payload.message, contextBudget: { ...anchor, projectedTokens: Infinity } },
    ]) expect(measureContextEntries([{ payload: { message } }], { envelopeKey }).source).toBe("estimated");
  });

  it("reserves the requested output rather than assuming a fixed output allowance", () => {
    const small = resolveContextBudget(1_024_000, 700_000, 8_000);
    const large = resolveContextBudget(1_024_000, 700_000, 384_000);
    expect(large.triggerTokens).toBeLessThan(small.triggerTokens);
    expect(large.maxOutputTokens).toBe(322_976);
    expect(resolveContextBudget(20_000, 19_999, 8_000).maxOutputTokens).toBe(0);
  });
});
