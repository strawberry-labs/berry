import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { CloudRuntimeConfigService, createCloudRuntimeConfigFromEnv } from "./cloud-runtime-config.ts";

afterEach(() => vi.unstubAllGlobals());

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
        name: "deep-research",
        description: "Conduct deep research when explicitly requested.",
        content: "Use BerryCrawl and cite every factual claim.",
      }]),
      BERRY_CLOUD_NETWORK_ALLOWED_DOMAINS: "crawl.example.test,registry.npmjs.org",
      BERRY_SANDBOX_CWD: "/home/user/workspace/",
    });

    expect(config.provider).toMatchObject({
      id: "router",
      baseUrl: "https://router.example.test/v1",
      defaultModel: "kimi-2.6",
    });
    expect(config.apiKey).toBe("router-secret");
    expect(config.workspacePath).toBe("/home/user/workspace");
    expect(config.mcpServers[0]).toMatchObject({
      credential: "crawl-secret",
      credentialKey: "env:BERRYCRAWL_API_KEY",
      trusted: true,
    });
    expect(config.extraSkills[0]).toMatchObject({ name: "deep-research", scope: "registered" });
    expect(config.networkPolicy).toEqual({ egress: "on", allowedDomains: ["crawl.example.test", "registry.npmjs.org"] });
    expect(config.provider?.completionTransport).toBe("stream");
    expect(config.provider?.completionFallback).toBe("buffered");
    expect(config.providerMaxOutputTokens).toBeUndefined();
    expect(config.imageGeneration).toEqual({
      endpoint: "https://router.example.test/v1/images/generations",
      editsEndpoint: "https://router.example.test/v1/images/edits",
      model: "berry-image-1",
      responseFormat: "b64_json",
      costMicros: "15000",
    });
  });

  it("includes deployment skill definitions in the downloadable catalog", async () => {
    const service = new CloudRuntimeConfigService({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "kimi-2.6",
      BERRY_CLOUD_SKILLS_JSON: JSON.stringify([{
        name: "deep-research",
        description: "Conduct deep research when explicitly requested.",
        content: "---\nname: deep-research\ndescription: Conduct deep research when explicitly requested.\n---\nUse BerryCrawl.",
      }]),
    });

    await expect(service.catalog(SELF_HOST_TENANT_ID)).resolves.toMatchObject({
      skills: [{
        id: "deep-research",
        name: "deep-research",
        content: expect.stringContaining("Use BerryCrawl."),
        enabled: true,
      }],
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

  it("removes declared cache controls from the inline rollback path when disabled", async () => {
    const service = new CloudRuntimeConfigService({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "model-a",
      BERRY_PROMPT_CACHE_ENABLED: "false",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
        id: "model-a",
        capabilities: {
          promptCaching: {
            supported: true,
            cacheKey: true,
            retention: ["long"],
          },
        },
      }]),
    });

    const resolved = await service.resolve(SELF_HOST_TENANT_ID, {});
    expect(resolved.provider.models?.[0]?.capabilities?.promptCaching).toBeUndefined();
  });

  it("uses the deployment model catalog over stale organization policies", async () => {
    const service = new CloudRuntimeConfigService({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "kimi-2.6",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([
        { id: "kimi-2.6", name: "Kimi 2.6" },
        { id: "glm-5.2", name: "GLM 5.2" },
      ]),
    }, {
      resolve: async () => ({
        provider: {
          id: "router",
          name: "Old Router",
          kind: "berry-router",
          baseUrl: "https://router.example.test/v1",
          defaultModel: "berry/auto",
          models: [{ id: "berry/auto", name: "Berry Router Auto" }],
        },
        apiKey: "secret",
        credentialRef: "env:BERRY_ROUTER_API_KEY",
      }),
      testAndActivate: async () => { throw new Error("not used"); },
    });

    const resolved = await service.resolve(SELF_HOST_TENANT_ID, {});
    expect(resolved.provider.defaultModel).toBe("kimi-2.6");
    expect(resolved.provider.models?.map((model) => model.id)).toEqual(["kimi-2.6", "glm-5.2"]);
  });

  it("does not trust a client-supplied Worker credential reference", async () => {
    const service = new CloudRuntimeConfigService({ BERRY_API_MODEL_MODE: "fixture" });

    const resolved = await service.resolve(SELF_HOST_TENANT_ID, {
      provider: {
        id: "custom",
        name: "Custom",
        kind: "openai-compatible",
        baseUrl: "https://provider.example.test/v1",
        defaultModel: "model",
        credentialRef: "env:BERRY_DURABLE_CAPABILITY_KEY",
      },
      apiKey: "client-secret",
      model: "model",
    });

    expect(resolved.credentialRef).toBeUndefined();
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
    expect(createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "deepseek-v4-flash",
      BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS: "384000",
    }).providerMaxOutputTokens).toBe(384_000);
    expect(() => createCloudRuntimeConfigFromEnv({
      BERRY_API_MODEL_MODE: "live",
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "glm-5.2",
      BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS: "0",
    })).toThrow("between 1 and 1000000");
  });

  it("relays real Image API partials and returns the completed frame", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response([
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
        'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"ZmluYWw="}',
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }));
    const service = new CloudRuntimeConfigService({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "berry/auto",
      BERRY_ROUTER_IMAGE_MODEL: "openai/gpt-image-2",
      BERRY_ROUTER_IMAGE_COST_MICROS: "0",
    });
    const partials: Array<{ index: number; b64: string }> = [];
    await expect(service.generateImage({
      prompt: "A berry floating over Dubai",
      aspectRatio: "16:9",
      stream: true,
      partialImages: 3,
    }, (partial) => partials.push(partial))).resolves.toMatchObject({
      model: "openai/gpt-image-2",
      data: [{ b64_json: "ZmluYWw=" }],
    });
    expect(partials).toEqual([{ index: 0, b64: "cGFydGlhbA==", mimeType: "image/png" }]);
    expect(requestBody).toMatchObject({ size: "1536x1024", stream: true, partial_images: 3 });
    expect(requestBody).not.toHaveProperty("response_format");
  });

  it("uses the edit endpoint for attached reference images", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response([
        'event: image_edit.partial_image\ndata: {"type":"image_edit.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
        'event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"ZWRpdGVk"}',
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }));
    const service = new CloudRuntimeConfigService({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "berry/auto",
      BERRY_ROUTER_IMAGE_MODEL: "openai/gpt-image-2",
      BERRY_ROUTER_IMAGE_COST_MICROS: "0",
    });
    await expect(service.generateImage({
      prompt: "Remove the product label",
      referenceImageUrls: ["data:image/png;base64,c291cmNl"],
      stream: true,
    }, () => undefined)).resolves.toMatchObject({
      data: [{ b64_json: "ZWRpdGVk" }],
    });
    expect(requestUrl).toBe("https://router.example.test/v1/images/edits");
    expect(requestBody).toMatchObject({
      images: [{ image_url: "data:image/png;base64,c291cmNl" }],
    });
    expect(requestBody).not.toHaveProperty("input_fidelity");
  });

  it("surfaces the upstream image error instead of hiding it behind a generic rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        message: "Unknown parameter: 'response_format'.",
        type: "invalid_request_error",
        code: "unknown_parameter",
      },
    }, { status: 400 })));
    const service = new CloudRuntimeConfigService({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_DEFAULT_MODEL: "berry/auto",
      BERRY_ROUTER_IMAGE_MODEL: "vendor/image-model",
      BERRY_ROUTER_IMAGE_COST_MICROS: "0",
    });

    await expect(service.generateImage({
      prompt: "A berry floating over Dubai",
    })).rejects.toThrow("BerryRouter rejected the image generation request: Unknown parameter: 'response_format'.");
  });
});
