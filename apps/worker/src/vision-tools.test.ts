import { afterEach, describe, expect, it, vi } from "vitest";
import { DURABLE_BASE_BUILT_IN_TOOLS, DurableTurnRuntimeRequestSchema } from "@berry/shared";
import {
  DURABLE_VISION_TOOL_SELECTION_PROMPT,
  type DurableTurnSnapshot,
  type DurableTurnStep,
  type DurableTurnToolExecutor,
} from "./turn-runner.js";
import { DurableVisionToolExecutor, type VisionObservationCache } from "./vision-tools.js";

afterEach(() => vi.unstubAllGlobals());

describe("DurableVisionToolExecutor", () => {
  it("withholds images from a text-only model when no approved adapter is available", async () => {
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const snapshot = visionSnapshot();
    const runtime = DurableTurnRuntimeRequestSchema.parse(snapshot.runtimeRequest);
    const { vision: _vision, ...withoutVision } = runtime;
    snapshot.runtimeRequest = DurableTurnRuntimeRequestSchema.parse({
      ...withoutVision,
      builtInTools: withoutVision.builtInTools.filter((tool) => tool !== "inspect_images"),
    });

    await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache()).modelContent(snapshot))
      .resolves.toEqual([{
        type: "text",
        text: "[1 image was withheld because the selected language model does not accept images and no approved vision adapter is available.]",
      }]);
  });

  it("withholds raw pixels from a text-only model and reuses cached observations without a second charge", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      id: "vision-response",
      model: "minimax-m3",
      choices: [{ message: { content: "## Overview\nA red safety helmet on a desk." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new MemoryVisionCache();
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const executor = new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" });
    const snapshot = visionSnapshot();

    await expect(executor.modelContent(snapshot)).resolves.toEqual([
      { type: "text", text: "[1 image is available through inspect_images. The selected language model has not received the image bytes.]" },
    ]);
    const first = await executor.execute(snapshot, visionStep());
    expect(first.output).toMatchObject({
      vision: { providerId: "router", model: "canopywave/minimax/minimax-m3", imageCount: 1, cacheHit: false },
    });
    expect(first.usage).toMatchObject({
      kind: "usage",
      inputTokens: 100,
      outputTokens: 20,
      costRawMicros: "54",
      pricingSource: "measured",
      servedProvider: "router",
      servedModel: "canopywave/minimax/minimax-m3",
    });

    const second = await executor.execute(snapshot, visionStep());
    expect(second.output).toMatchObject({ vision: { cacheHit: true } });
    expect(second.usage).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 1_536 });
  });

  it("keeps focused observations separate by normalized question", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      id: "vision-response",
      model: "minimax-m3",
      choices: [{ message: { content: "The label reads AESG." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const executor = new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" });
    const snapshot = visionSnapshot();
    await executor.execute(snapshot, visionStep({ mode: "focused", question: "What does the label say?" }));
    await executor.execute(snapshot, visionStep({ mode: "focused", question: "What color is the helmet?" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 1_024 });
  });

  it("guides text-only models to one task-directed inspection without searching for attachments", () => {
    expect(DURABLE_VISION_TOOL_SELECTION_PROMPT).toContain("call focused mode directly");
    expect(DURABLE_VISION_TOOL_SELECTION_PROMPT).toContain("do not search for them with list_files, read_file, or shell tools");
    expect(DURABLE_VISION_TOOL_SELECTION_PROMPT).toContain("call read_file once");
  });

  it("uses the admitted per-call estimate when the vision provider omits usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "vision-response",
      model: "minimax-m3",
      choices: [{ message: { content: "A site plan with north at the top." }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };

    const result = await new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
      .execute(visionSnapshot(), visionStep());

    expect(result.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costRawMicros: "3000",
      pricingSource: "estimated",
    });
  });
});

class MemoryVisionCache implements VisionObservationCache {
  readonly values = new Map<string, string>();
  async get(_tenantId: string, cacheKey: string) { return this.values.get(cacheKey) ?? null; }
  async put(input: { cacheKey: string; observation: string }) { this.values.set(input.cacheKey, input.observation); }
}

function visionSnapshot(): DurableTurnSnapshot {
  const runtimeRequest = DurableTurnRuntimeRequestSchema.parse({
    capabilityVersion: 1,
    requestId: "request-1",
    input: "What is in this image?",
    providerId: "router",
    provider: { id: "router", name: "Router", kind: "berry-router", baseUrl: "https://router.example/v1", defaultModel: "deepseek-v4-flash" },
    model: "deepseek-v4-flash",
    workspacePath: "/workspace",
    workspaceId: "workspace-1",
    permissionMode: "full-access",
    reasoning: "off",
    maxTokens: 4_096,
    contextWindowTokens: 1_000_000,
    modelAcceptsImages: false,
    builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "inspect_images"],
    vision: {
      providerId: "router",
      provider: {
        id: "router",
        name: "Router",
        kind: "berry-router",
        baseUrl: "https://router.example/v1",
        defaultModel: "canopywave/minimax/minimax-m3",
        credentialRef: "env:VISION_TEST_KEY",
      },
      model: "canopywave/minimax/minimax-m3",
      maxTokens: 2_048,
      modelPricing: { input: 0.3, output: 1.2, cacheRead: 0.06 },
      estimatedCostMicros: "3000",
    },
  });
  return {
    id: "00000000-0000-7000-8000-000000000901",
    tenantId: "00000000-0000-7000-8000-000000000001",
    runtimeRequest,
  } as unknown as DurableTurnSnapshot;
}

function visionStep(argumentsValue: Record<string, unknown> = { mode: "overview" }): DurableTurnStep {
  return {
    id: "00000000-0000-7000-8000-000000000902",
    sequence: 1,
    type: "tool.inspect_images",
    state: "running",
    attempt: 1,
    input: { toolName: "inspect_images", arguments: argumentsValue },
    output: null,
    error: null,
    retryClass: "idempotent_with_key",
    idempotencyKey: "vision-step-1",
  };
}
