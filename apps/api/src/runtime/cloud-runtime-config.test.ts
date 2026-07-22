import { describe, expect, it } from "vitest";
import { createCloudRuntimeConfigFromEnv } from "./cloud-runtime-config.ts";

describe("cloud runtime configuration", () => {
  it("builds a server-owned Berry Router provider, E2B-compatible MCP tools, and skills", () => {
    const config = createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1/",
      BERRY_ROUTER_API_KEY: "router-secret",
      BERRY_ROUTER_IMAGE_MODEL: "berry-image-1",
      BERRY_ROUTER_IMAGE_COST_MICROS: "15000",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([
        { id: "kimi-2.6", name: "Kimi 2.6", capabilities: { tools: true, vision: true } },
        { id: "glm-5.2", name: "GLM 5.2", capabilities: { tools: true } },
      ]),
      BERRY_CLOUD_MCP_SERVERS_JSON: JSON.stringify([{
        id: "berrycrawl",
        name: "berrycrawl",
        transport: "streamable-http",
        url: "https://crawl.example.test/mcp",
        credentialEnv: "BERRYCRAWL_API_KEY",
      }]),
      BERRYCRAWL_API_KEY: "crawl-secret",
      BERRY_CLOUD_SKILLS_JSON: JSON.stringify([{
        name: "research",
        description: "Research a topic with cited sources.",
        content: "Use BerryCrawl and cite every factual claim.",
      }]),
      BERRY_CLOUD_NETWORK_ALLOWED_DOMAINS: "crawl.example.test,registry.npmjs.org",
    });

    expect(config.provider).toMatchObject({
      id: "router",
      baseUrl: "https://router.example.test/v1",
      defaultModel: "kimi-2.6",
    });
    expect(config.apiKey).toBe("router-secret");
    expect(config.mcpServers[0]).toMatchObject({ credential: "crawl-secret", trusted: true });
    expect(config.extraSkills[0]).toMatchObject({ name: "research", scope: "registered" });
    expect(config.networkPolicy).toEqual({ egress: "on", allowedDomains: ["crawl.example.test", "registry.npmjs.org"] });
    expect(config.provider?.completionTransport).toBe("stream");
    expect(config.provider?.completionFallback).toBe("buffered");
    expect(config.providerMaxOutputTokens).toBe(16_384);
    expect(config.imageGeneration).toEqual({
      endpoint: "https://router.example.test/v1/images/generations",
      model: "berry-image-1",
      responseFormat: "b64_json",
      costMicros: "15000",
    });
  });

  it("allows buffered transport as an explicit emergency override", () => {
    const config = createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "test-model",
      BERRY_ROUTER_COMPLETION_TRANSPORT: "buffered",
    });

    expect(config.provider?.completionTransport).toBe("buffered");
    expect(config.provider?.completionFallback).toBeUndefined();
  });

  it("rejects an unknown completion transport", () => {
    expect(() => createCloudRuntimeConfigFromEnv({
      BERRY_ROUTER_COMPLETION_TRANSPORT: "instant",
    })).toThrow("BERRY_ROUTER_COMPLETION_TRANSPORT must be stream or buffered");
  });

  it("fails fast when live inference has no server-owned endpoint", () => {
    expect(() => createCloudRuntimeConfigFromEnv({ BERRY_API_MODEL_MODE: "live" }))
      .toThrow("BERRY_ROUTER_INFERENCE_BASE_URL");
  });

  it("requires an explicit image cost when live image generation is enabled", () => {
    expect(() => createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "kimi-2.6",
      BERRY_ROUTER_IMAGE_MODEL: "berry-image-1",
    })).toThrow("BERRY_ROUTER_IMAGE_COST_MICROS");
  });

  it("accepts a bounded cloud model output cap", () => {
    expect(createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "glm-5.2",
      BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS: "2048",
    }).providerMaxOutputTokens).toBe(2_048);
    expect(() => createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "glm-5.2",
      BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS: "0",
    })).toThrow("between 1 and 32000");
  });
});
