import { afterEach, describe, expect, it, vi } from "vitest";
import { DURABLE_BASE_BUILT_IN_TOOLS, DurableTurnRuntimeRequestSchema } from "@berry/shared";
import {
  DURABLE_VISION_TOOL_SELECTION_PROMPT,
  DurableToolExecutionError,
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
    const requestBody = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({ max_tokens: 1_536 });
    expect(requestBody).not.toHaveProperty("reasoning");
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });

  it("retries one empty reasoning-only response and persists sanitized attempt diagnostics", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      call += 1;
      return new Response(JSON.stringify(call === 1 ? {
        id: "vision-empty",
        model: "minimax-m3",
        choices: [{ message: { content: "", reasoning_content: "analysis only" }, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
      } : {
        id: "vision-retry",
        model: "minimax-m3",
        choices: [{ message: { content: "A five-page report with a green AESG header." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": `vision-request-${call}` },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const modelContent = vi.fn(async (snapshot: DurableTurnSnapshot) => {
      expect(snapshot.steps.find((candidate) => candidate.id === visionStep().id)).toMatchObject({
        state: "running",
        input: {
          arguments: { paths: ["/workspace/rendered/page-01.png"] },
        },
      });
      return [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,aGVsbG8=" } }];
    });
    const base: DurableTurnToolExecutor = {
      modelContent,
      execute: async () => { throw new Error("unexpected base execution"); },
    };

    const result = await new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
      .execute(visionSnapshot(), visionStep({
        mode: "overview",
        paths: ["/workspace/rendered/page-01.png"],
      }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output).toMatchObject({
      vision: {
        requestedPathCount: 1,
        diagnostics: [
          {
            attempt: 1,
            finishReason: "length",
            requestId: "vision-request-1",
            contentCharacters: 0,
            reasoningCharacters: 13,
          },
          {
            attempt: 2,
            finishReason: "stop",
            requestId: "vision-request-2",
            contentCharacters: 44,
            reasoningCharacters: 0,
          },
        ],
      },
    });
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 27, totalTokens: 227 });
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body));
    expect(firstBody).not.toHaveProperty("reasoning");
    expect(firstBody).not.toHaveProperty("reasoning_effort");
    expect(secondBody).not.toHaveProperty("reasoning");
    expect(secondBody).not.toHaveProperty("reasoning_effort");
    expect(modelContent).toHaveBeenCalledTimes(1);
  });

  it("reports aggregate usage when both provider attempts return empty final content", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      return new Response(JSON.stringify({
        id: `vision-empty-${call}`,
        model: "minimax-m3",
        choices: [{ message: { content: "", reasoning_content: "hidden analysis" }, finish_reason: "length" }],
        usage: { prompt_tokens: 25, completion_tokens: 5, total_tokens: 30 },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": `request-${call}` },
      });
    }));
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };

    let thrown: unknown;
    try {
      await new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
        .execute(visionSnapshot(), visionStep());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DurableToolExecutionError);
    expect(thrown).toMatchObject({
      message: expect.stringContaining("after 2 attempts"),
      usage: {
        kind: "usage",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        pricingSource: "measured",
      },
    });
    expect((thrown as Error).message).toContain("request=request-1");
    expect((thrown as Error).message).not.toContain("hidden analysis");
  });

  it("preserves completed-attempt usage when the retry request fails", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("socket reset during retry");
      return new Response(JSON.stringify({
        id: "vision-empty-before-error",
        model: "minimax-m3",
        choices: [{ message: { content: "", reasoning_content: "hidden analysis" }, finish_reason: "length" }],
        usage: { prompt_tokens: 25, completion_tokens: 5, total_tokens: 30 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };

    let thrown: unknown;
    try {
      await new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
        .execute(visionSnapshot(), visionStep());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DurableToolExecutionError);
    expect(thrown).toMatchObject({
      message: expect.stringContaining("socket reset during retry"),
      usage: {
        kind: "usage",
        inputTokens: 25,
        outputTokens: 5,
        totalTokens: 30,
        pricingSource: "measured",
      },
    });
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
    snapshot.steps = [{ ...visionStep({ mode: "focused", question: "What does the label say?" }), state: "completed" }];
    await executor.execute(snapshot, visionStep({ mode: "focused", question: "What color is the helmet?" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 1_024 });
  });

  it("reuses the first focused observation by stable user intent when the model paraphrases its question", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      id: "vision-response",
      model: "minimax-m3",
      choices: [{ message: { content: "The model name is GPT-5.5." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new MemoryVisionCache();
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const executor = new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" });

    await executor.execute(
      visionSnapshot(),
      visionStep({ mode: "focused", question: "What exact AI model name is most prominent?" }),
    );
    const repeated = await executor.execute(
      visionSnapshot(),
      visionStep({ mode: "focused", question: "Quote the prominent model identifier." }),
    );

    expect(repeated.output).toMatchObject({ vision: { cacheHit: true } });
    expect(repeated.usage).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("guides text-only models to one task-directed inspection without searching for attachments", () => {
    expect(DURABLE_VISION_TOOL_SELECTION_PROMPT).toContain("call focused mode directly");
    expect(DURABLE_VISION_TOOL_SELECTION_PROMPT).toContain("exact sandbox paths");
    expect(DURABLE_VISION_TOOL_SELECTION_PROMPT).toContain("do not call read, ls, find, or shell first");
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

  it("blocks repeated adapter calls after a failure until a new image is exposed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const snapshot = visionSnapshot();
    snapshot.steps = [{
      ...visionStep(),
      sequence: 1,
      state: "failed",
      error: "The vision model returned an empty observation",
    }];

    await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
      .execute(snapshot, { ...visionStep(), sequence: 3 }))
      .rejects.toThrow("no new image was exposed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds the latest matching failure even when another image selection failed afterward", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const firstPath = "/workspace/rendered/page-01.png";
    const secondPath = "/workspace/rendered/page-02.png";
    const snapshot = visionSnapshot();
    snapshot.steps = [
      {
        ...visionStep({ mode: "overview", paths: [firstPath] }),
        id: "vision-failure-a",
        sequence: 1,
        state: "failed",
        error: "First selection failed",
      },
      {
        ...visionStep({ mode: "overview", paths: [secondPath] }),
        id: "vision-failure-b",
        sequence: 2,
        state: "failed",
        error: "Second selection failed",
      },
    ];

    await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
      .execute(snapshot, {
        ...visionStep({ mode: "overview", paths: [firstPath] }),
        id: "vision-retry-a",
        sequence: 3,
      })).rejects.toThrow("First selection failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a corrected explicit image selection after a failed inspection", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "vision-corrected",
      model: "minimax-m3",
      choices: [{ message: { content: "The corrected page is visible." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const snapshot = visionSnapshot();
    snapshot.steps = [{
      ...visionStep({ mode: "overview", paths: ["/workspace/rendered/page-01.png"] }),
      sequence: 1,
      state: "failed",
      error: "The vision model returned an empty observation",
    }];

    await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
      .execute(snapshot, {
        ...visionStep({ mode: "overview", paths: ["/workspace/rendered/page-02.png"] }),
        sequence: 3,
      })).resolves.toMatchObject({ output: { vision: { requestedPathCount: 1 } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows valid paths after a malformed historical selection failed validation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "vision-corrected-malformed",
      model: "minimax-m3",
      choices: [{ message: { content: "The corrected image is visible." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const snapshot = visionSnapshot();
    snapshot.steps = [{
      ...visionStep({ mode: "overview", paths: [] }),
      id: "vision-malformed",
      sequence: 1,
      state: "failed",
      error: "inspect_images paths must contain between 1 and 5 exact workspace image paths",
    }];

    await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
      .execute(snapshot, {
        ...visionStep({ mode: "overview", paths: ["/workspace/rendered/page-01.png"] }),
        id: "vision-corrected",
        sequence: 2,
      })).resolves.toMatchObject({ output: { vision: { requestedPathCount: 1 } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    attachments: [{
      name: "example.png",
      mediaType: "image/png",
      size: 5,
      sourceKind: "upload",
    }],
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
