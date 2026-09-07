import { describe, expect, it } from "vitest";
import type { PromptCachingCapabilities } from "@berry/shared";
import {
  canonicalToolDefinitions,
  planDurablePromptCache,
  promptCacheCapabilityFromEnv,
} from "./prompt-cache.js";

const capability: PromptCachingCapabilities = {
  supported: true,
  cacheKey: true,
  cacheControl: false,
  retention: ["short", "long"],
  minimumTokens: 1,
};

describe("durable prompt cache planning", () => {
  it("uses only declared model capability and derives an opaque stable key", () => {
    const selected = promptCacheCapabilityFromEnv({
      BERRY_PROMPT_CACHE_ENABLED: "true",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
        id: "model-a",
        capabilities: { promptCaching: capability },
      }]),
    }, "model-a");
    const plan = planned({ capability: selected });

    expect(plan.eligible).toBe(true);
    expect(plan.cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.cacheKey).not.toContain("tenant-a");
    expect(plan.missReason).toBe("first_request");
  });

  it("classifies a route change without hashing dynamic context", () => {
    const first = planned();
    const second = planned({
      route: "/responses",
      previousManifest: first.manifest,
      previousObservedAt: new Date().toISOString(),
    });

    expect(second.missReason).toBe("routing_changed");
    expect(second.manifest.dynamicContextBoundary).toBe("stable system".length);
  });

  it("honors the admitted provider catalog while preserving the global control switch", () => {
    const provider = { models: [{ id: "admitted", capabilities: { promptCaching: capability } }] };
    expect(promptCacheCapabilityFromEnv({}, "admitted", provider)).toEqual(capability);
    expect(promptCacheCapabilityFromEnv({ BERRY_PROMPT_CACHE_ENABLED: "false" }, "admitted", provider).supported).toBe(false);
  });

  it("omits cache controls for Gemini 3.7 Flash when support is not declared", () => {
    const model = "google-vertex/gemini-3.7-flash";
    const unsupported = promptCacheCapabilityFromEnv({
      BERRY_PROMPT_CACHE_ENABLED: "true",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
        id: model,
        capabilities: {
          tools: true,
          vision: true,
          reasoning: true,
          cost: { input: 0.75, output: 3.75, cacheRead: 0.075 },
        },
      }]),
    }, model);
    const plan = planned({ model, capability: unsupported });

    expect(plan.cacheKey).toBeNull();
    expect(plan.retention).toBe("none");
    expect(plan.missReason).toBe("unknown");
  });

  it("keeps session affinity through tool discovery, but isolates tenants and models", () => {
    const first = planned();
    expect(planned({ tools: [] }).cacheKey).toBe(first.cacheKey);
    expect(planned({ tenantId: "another-tenant" }).cacheKey).not.toBe(first.cacheKey);
    expect(planned({ sessionId: "another-session" }).cacheKey).not.toBe(first.cacheKey);
    expect(planned({ model: "another-model" }).cacheKey).not.toBe(first.cacheKey);
  });

  it("detects changes beyond the stable prompt and preserves appended history", () => {
    const messages = [{ role: "system" as const, content: "instructions plus grounding" }, { role: "user" as const, content: "private request" }];
    const first = planned({ messages });
    const appended = planned({ previousManifest: first.manifest, messages: [...messages, { role: "assistant", content: "response" }] });
    expect(appended.manifest.requestPrefix).toMatchObject({ comparedToPrevious: true, reusedMessages: 2, firstChangedMessage: null, toolsChanged: false });
    const changed = planned({ previousManifest: first.manifest, messages: [{ ...messages[0]!, content: "instructions plus new grounding" }, messages[1]!] });
    expect(changed.manifest.requestPrefix).toMatchObject({ reusedMessages: 0, firstChangedMessage: 0 });
    expect(planned({ previousManifest: first.manifest, messages, tools: [] }).manifest.requestPrefix?.toolsChanged).toBe(true);
    expect(JSON.stringify(first.manifest)).not.toContain("private request");
    expect(JSON.stringify(first.manifest)).not.toContain("instructions plus grounding");
  });

  it("serializes equivalent tool sets identically without mutating their schemas", () => {
    const left = [{ type: "function" as const, function: { name: "z", parameters: { type: "object", properties: { b: {}, a: {} } } } }, { type: "function" as const, function: { name: "a", parameters: {} } }];
    const right = [left[1]!, { type: "function" as const, function: { parameters: { properties: { a: {}, b: {} }, type: "object" }, name: "z" } }];
    expect(JSON.stringify(canonicalToolDefinitions(left))).toBe(JSON.stringify(canonicalToolDefinitions(right)));
    expect(left[0]?.function.name).toBe("z");
  });
});

function planned(overrides: Partial<Parameters<typeof planDurablePromptCache>[0]> = {}) {
  return planDurablePromptCache({
    tenantId: "tenant-a",
    sessionId: "session-a",
    provider: "router",
    model: "model-a",
    route: "/chat/completions",
    stableSystemPrompt: "stable system",
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    capability,
    ...overrides,
  });
}
