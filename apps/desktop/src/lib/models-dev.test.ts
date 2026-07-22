import { describe, expect, it } from "vitest";
import { enrichModelsWithModelsDev, type ModelsDevCatalog } from "./models-dev";

const catalog: ModelsDevCatalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-test": {
        id: "gpt-test",
        name: "GPT Test",
        family: "gpt",
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128_000, output: 16_000 },
        cost: { input: 1.25, output: 5, cache_read: 0.25 },
      },
    },
  },
};

describe("models.dev capability enrichment", () => {
  it("fills metadata gaps while preserving native values and manual overrides", () => {
    const [model] = enrichModelsWithModelsDev(
      { id: "openai-responses", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
      [{ id: "gpt-test", capabilities: { tools: false }, capabilityOverrides: { vision: false } }],
      catalog,
    );
    expect(model).toMatchObject({
      name: "GPT Test",
      family: "gpt",
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      inputModalities: ["text", "image"],
      capabilities: {
        tools: false,
        vision: true,
        reasoning: true,
        json: true,
        context: { windowTokens: 128_000, maxOutputTokens: 16_000 },
        cost: { input: 1.25, output: 5, cacheRead: 0.25 },
      },
      capabilityOverrides: { vision: false },
    });
  });

  it("returns the original list when no provider catalog matches", () => {
    const models = [{ id: "private-model" }];
    expect(enrichModelsWithModelsDev({ id: "private", name: "Private", baseUrl: "https://private.invalid/v1" }, models, catalog)).toBe(models);
  });
});
