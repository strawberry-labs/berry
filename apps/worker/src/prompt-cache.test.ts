import { describe, expect, it } from "vitest";
import type { PromptCachingCapabilities } from "@berry/shared";
import {
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
    expect(plan.cacheKey).toMatch(/^berry_[a-f0-9]{64}$/);
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

  it("omits cache controls when capability support is not declared", () => {
    const unsupported = promptCacheCapabilityFromEnv({
      BERRY_PROMPT_CACHE_ENABLED: "true",
      BERRY_ROUTER_MODELS_JSON: "[]",
    }, "model-a");
    const plan = planned({ capability: unsupported });

    expect(plan.cacheKey).toBeNull();
    expect(plan.retention).toBe("none");
    expect(plan.missReason).toBe("provider_unsupported");
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
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    capability,
    ...overrides,
  });
}
