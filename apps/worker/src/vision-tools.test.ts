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
  it("declares inspection abort support and delegates inherited tools", () => {
    const executor = new DurableVisionToolExecutor({
      supportsAbort: () => true,
      execute: async () => ({ output: {}, summary: "base" }),
    }, new MemoryVisionCache());
    const snapshot = visionSnapshot();

    expect(executor.supportsAbort(snapshot, visionStep())).toBe(false);
    expect(executor.supportsAbort(snapshot, {
      type: "tool.read",
      input: { toolName: "read", arguments: { path: "/workspace/file.txt" } },
    } as never)).toBe(true);
  });

  it("passes labelled pixels directly to a native vision model without an adapter", async () => {
    const parts = [
      { type: "text" as const, text: 'Workspace image 1: "/workspace/rendered/page-1.png"' },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ];
    const snapshot = visionSnapshot();
    const { vision: _vision, ...runtime } = DurableTurnRuntimeRequestSchema.parse(snapshot.runtimeRequest);
    snapshot.runtimeRequest = { ...runtime, modelAcceptsImages: true, builtInTools: runtime.builtInTools.filter((tool) => tool !== "inspect_images") };
    const executor = new DurableVisionToolExecutor({ modelContent: async () => parts, execute: vi.fn() }, new MemoryVisionCache());
    await expect(executor.modelContent(snapshot)).resolves.toEqual(parts);
  });

  it("keeps the admitted vision adapter on queued, Continue and recovered runs", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      id: "vision-response",
      model: "minimax-m3",
      choices: [{ message: { content: "A red safety helmet on a desk." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const executor = new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" });
    const snapshot = visionSnapshot();
    snapshot.runtimeRequest = {
      ...snapshot.runtimeRequest,
      queuedBudgetRequestId: "queued:browser-key",
      continuationSourceRunId: "00000000-0000-7000-8000-000000000099",
      continuationHeadEntryId: "entry-head",
      budgetBaseRequestId: "request-1",
      budgetGeneration: 1,
      budgetUsageAfterSequence: 12,
      budgetBaselineCostMicros: "5000",
    };

    // A text-only model gets the notice, never the raw pixels.
    await expect(executor.modelContent(snapshot)).resolves.toEqual([
      { type: "text", text: "[1 image is available through inspect_images. The selected language model has not received the image bytes.]" },
    ]);
    await expect(executor.execute(snapshot, visionStep())).resolves.toMatchObject({
      output: { vision: { providerId: "router", model: "canopywave/minimax/minimax-m3" } },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://router.example/v1/chat/completions");

    snapshot.runtimeRequest = { ...snapshot.runtimeRequest, unexpectedSetting: true };
    await expect(executor.modelContent(snapshot)).rejects.toThrow("admitted model configuration is invalid");
  });

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

  it("still runs base model preparation for text-only turns without images", async () => {
    const modelContent = vi.fn(async () => [{
      type: "text" as const,
      text: "[Current-turn attachments are staged.]",
    }]);
    const base: DurableTurnToolExecutor = {
      modelContent,
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const snapshot = visionSnapshot();
    const runtime = DurableTurnRuntimeRequestSchema.parse(snapshot.runtimeRequest);
    snapshot.runtimeRequest = DurableTurnRuntimeRequestSchema.parse({
      ...runtime,
      attachments: [{
        name: "requirements.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 1_024,
        sourceKind: "upload",
      }],
    });

    await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache()).modelContent(snapshot))
      .resolves.toEqual([{ type: "text", text: "[Current-turn attachments are staged.]" }]);
    expect(modelContent).toHaveBeenCalledOnce();
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
    // Overview output is capped by the admitted vision maxTokens (2,048 here).
    expect(requestBody).toMatchObject({ max_tokens: 2_048 });
    expect(requestBody).not.toHaveProperty("reasoning");
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });

  it("passes resize and omission notes to the vision model and invalidates stale cached selections", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      id: "vision-notes", model: "minimax-m3",
      choices: [{ message: { content: "One readable page." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    let note = "[Image not sent: broken.png; create a smaller PNG/JPEG copy and read it.]";
    const executor = new DurableVisionToolExecutor({
      modelContent: async () => [
        { type: "text", text: "Workspace image 1: page.png [Preview: 4000x2000 to 2000x1000]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        { type: "text", text: note },
      ], execute: vi.fn(),
    }, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" });
    const current = visionSnapshot();
    const first = await executor.execute(current, visionStep());
    expect(JSON.stringify(first.output)).toContain(note);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("4000x2000 to 2000x1000");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(note);
    note = "[Image not sent: another.png; crop the relevant region.]";
    const second = await executor.execute(current, visionStep());
    expect(second.output).toMatchObject({ vision: { cacheHit: false } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns image recovery guidance without a provider call when every image was omitted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const executor = new DurableVisionToolExecutor({
      modelContent: async () => [{ type: "text", text: "[Image not sent: large.png; create a smaller PNG/JPEG copy or crop, then read it.]" }],
      execute: vi.fn(),
    }, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" });
    await expect(executor.execute(visionSnapshot(), visionStep())).rejects.toThrow("create a smaller PNG/JPEG copy or crop");
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 2_048 });
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

  describe("observations cut off at the output limit (H-039)", () => {
    const respond = (content: string, finishReason: string) => vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
      id: "vision-response",
      model: "minimax-m3",
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 1_024, total_tokens: 1_034 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const question = { mode: "focused", question: "List every employee name in the table." };

    it("reports an observation still cut off after its continuation as incomplete and does not cache it", async () => {
      const fetchMock = respond("1. Amal Haddad\n2. Bilal Khan\n3. Chen", "length");
      vi.stubGlobal("fetch", fetchMock);
      const cache = new MemoryVisionCache();
      const executor = new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" });

      const first = await executor.execute(visionSnapshot(), visionStep(question));
      expect(first.output).toMatchObject({
        vision: {
          complete: false,
          cacheHit: false,
          diagnostics: [{ purpose: "first", finishReason: "length" }, { purpose: "continuation", finishReason: "length" }],
        },
      });
      expect((first.output as { content: string }).content).toContain("Incomplete observation");
      expect(first.summary).toContain("incomplete");
      expect(cache.values.size).toBe(0);

      const repeated = await executor.execute(visionSnapshot(), visionStep(question));
      expect(repeated.output).toMatchObject({ vision: { complete: false, cacheHit: false } });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("continues a cut-off observation once in the same conversation and caches the whole answer", async () => {
      const replies = [
        { content: "1. Amal Haddad\n2. Bilal Khan\n3. Chen", finish: "length" },
        { content: " Wei\n4. Dana Ortiz", finish: "stop" },
      ];
      const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
        const reply = replies[fetchMock.mock.calls.length - 1]!;
        return new Response(JSON.stringify({
          id: "vision-response",
          model: "minimax-m3",
          choices: [{ message: { content: reply.content }, finish_reason: reply.finish }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const cache = new MemoryVisionCache();
      const result = await new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" })
        .execute(visionSnapshot(), visionStep(question));

      expect(result.output).toMatchObject({
        vision: { complete: true, diagnostics: [{ purpose: "first" }, { purpose: "continuation", finishReason: "stop" }] },
      });
      expect((result.output as { content: string }).content).toContain("1. Amal Haddad\n2. Bilal Khan\n3. Chen Wei\n4. Dana Ortiz");
      expect((result.output as { content: string }).content).not.toContain("Incomplete observation");
      expect(cache.values.size).toBe(1);
      const first = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { messages: Array<{ role: string; content: unknown }> };
      const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { messages: Array<{ role: string; content: unknown }> };
      // Same system and image message first, so the provider can reuse its cached prefix.
      expect(second.messages.slice(0, 2)).toEqual(first.messages);
      expect(second.messages.slice(2)).toEqual([
        { role: "assistant", content: "1. Amal Haddad\n2. Bilal Khan\n3. Chen" },
        { role: "user", content: expect.stringContaining("Continue exactly where it stopped") },
      ]);
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 40 });
    });

    const replying = (replies: ReadonlyArray<{ content: string; finish: string }>) => {
      const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
        const reply = replies[(fetchMock.mock.calls.length - 1) % replies.length]!;
        return new Response(JSON.stringify({
          id: "vision-response",
          model: "minimax-m3",
          choices: [{ message: { content: reply.content }, finish_reason: reply.finish }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });
      return fetchMock;
    };

    it.each([
      ["empty", "", "stop"],
      ["blank", "  \n", "stop"],
      ["blocked", " Wei", "content_filter"],
    ])("keeps a cut-off observation incomplete and uncached when its continuation is %s", async (_label, content, finish) => {
      const fetchMock = replying([
        { content: "1. Amal Haddad\n2. Bilal Khan\n3. Chen", finish: "length" },
        { content, finish },
      ]);
      vi.stubGlobal("fetch", fetchMock);
      const cache = new MemoryVisionCache();
      const executor = new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" });

      const first = await executor.execute(visionSnapshot(), visionStep(question));
      expect(first.output).toMatchObject({
        vision: {
          complete: false,
          cacheHit: false,
          diagnostics: [{ purpose: "first", finishReason: "length" }, { purpose: "continuation", finishReason: finish }],
        },
      });
      expect((first.output as { content: string }).content).toContain("Incomplete observation");
      expect((first.output as { content: string }).content).toContain("1. Amal Haddad\n2. Bilal Khan\n3. Chen");
      expect(first.summary).toContain("incomplete");
      // Both completed provider calls are billed.
      expect(first.usage).toMatchObject({ inputTokens: 20, outputTokens: 40 });
      expect(cache.values.size).toBe(0);

      // Asking again goes back to the provider instead of reusing a partial answer.
      const repeated = await executor.execute(visionSnapshot(), visionStep(question));
      expect(repeated.output).toMatchObject({ vision: { complete: false, cacheHit: false } });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    // A provider that stops an answer for another reason than the output
    // limit, such as a content filter, returned part of it. It is not asked
    // again around the filter and never cached as complete (H-039).
    it("keeps a first answer stopped by a content filter incomplete and uncached, without asking again", async () => {
      const fetchMock = respond("1. Amal Haddad\n2. Bilal", "content_filter");
      vi.stubGlobal("fetch", fetchMock);
      const cache = new MemoryVisionCache();
      const executor = new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" });

      const first = await executor.execute(visionSnapshot(), visionStep(question));
      expect(first.output).toMatchObject({
        vision: { complete: false, cacheHit: false, diagnostics: [{ purpose: "first", finishReason: "content_filter" }] },
      });
      expect((first.output as { content: string }).content).toContain("stopped its answer early (content_filter)");
      expect((first.output as { content: string }).content).not.toContain("output limit");
      expect(first.summary).toContain("incomplete");
      expect(first.usage).toMatchObject({ inputTokens: 10, outputTokens: 1_024 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cache.values.size).toBe(0);

      const repeated = await executor.execute(visionSnapshot(), visionStep(question));
      expect(repeated.output).toMatchObject({ vision: { complete: false, cacheHit: false } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps an answer that followed an empty one incomplete when a content filter stopped it", async () => {
      const fetchMock = replying([{ content: "", finish: "stop" }, { content: "1. Amal Haddad", finish: "content_filter" }]);
      vi.stubGlobal("fetch", fetchMock);
      const cache = new MemoryVisionCache();

      const result = await new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" }).execute(visionSnapshot(), visionStep(question));
      expect(result.output).toMatchObject({
        vision: { complete: false, diagnostics: [{ purpose: "first", finishReason: "stop" }, { purpose: "empty_retry", finishReason: "content_filter" }] },
      });
      expect((result.output as { content: string }).content).toContain("stopped its answer early (content_filter)");
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 40 });
      expect(cache.values.size).toBe(0);
    });

    it("says a continuation stopped by a content filter was stopped early, not cut off", async () => {
      const fetchMock = replying([{ content: "1. Amal Haddad\n2. Bilal Khan\n3. Chen", finish: "length" }, { content: " Wei", finish: "content_filter" }]);
      vi.stubGlobal("fetch", fetchMock);

      const result = await new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" }).execute(visionSnapshot(), visionStep(question));
      expect(result.output).toMatchObject({ vision: { complete: false } });
      expect((result.output as { content: string }).content).toContain("stopped its answer early (content_filter)");
    });

    it("treats a missing finish reason as a normal ending", async () => {
      const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
        id: "vision-response",
        model: "minimax-m3",
        choices: [{ message: { content: "1. Amal Haddad\n2. Bilal Khan" }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const cache = new MemoryVisionCache();

      const result = await new DurableVisionToolExecutor(base, cache, { VISION_TEST_KEY: "secret" }).execute(visionSnapshot(), visionStep(question));
      expect(result.output).toMatchObject({ vision: { complete: true } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cache.values.size).toBe(1);
    });

    it("still caches and reuses a complete observation", async () => {
      const fetchMock = respond("1. Amal Haddad\n2. Bilal Khan", "stop");
      vi.stubGlobal("fetch", fetchMock);
      const executor = new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" });

      const first = await executor.execute(visionSnapshot(), visionStep(question));
      expect(first.output).toMatchObject({ vision: { complete: true, cacheHit: false, promptVersion: "vision-observation-v6" } });
      expect((first.output as { content: string }).content).not.toContain("Incomplete observation");
      const repeated = await executor.execute(visionSnapshot(), visionStep(question));
      expect(repeated.output).toMatchObject({ vision: { complete: true, cacheHit: true } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("question handling by mode (H-061)", () => {
    const run = async (argumentsValue: Record<string, unknown>) => {
      const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({
        id: "vision-response",
        model: "minimax-m3",
        choices: [{ message: { content: "Figure 3: Site plan" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const base: DurableTurnToolExecutor = {
        modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
        execute: async () => { throw new Error("unexpected base execution"); },
      };
      const result = await new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
        .execute(visionSnapshot(), visionStep(argumentsValue));
      const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { max_tokens: number; messages: Array<{ content: unknown }> };
      return { result, body, prompt: JSON.stringify(body.messages.at(-1)?.content) };
    };
    const question = "What is the figure number under the site plan?";

    it("answers a question with no mode as a focused question", async () => {
      const { result, body, prompt } = await run({ question });
      expect(prompt).toContain(question);
      expect(body.max_tokens).toBe(2_048);
      expect(result.output).toMatchObject({ vision: { mode: "focused" } });
      expect((result.output as { content: string }).content).not.toContain("was not sent");
    });

    it("says so when explicit overview mode does not send the question", async () => {
      const { result, prompt } = await run({ mode: "overview", question });
      expect(prompt).not.toContain(question);
      expect(result.output).toMatchObject({ vision: { mode: "overview", questionSent: false } });
      expect((result.output as { content: string }).content).toContain("your question was not sent");
    });

    it("keeps the questionless overview digest unchanged", async () => {
      const { result, prompt } = await run({});
      expect(prompt).toContain("comprehensive reusable observation");
      expect(result.output).toMatchObject({ vision: { mode: "overview" } });
      expect(result.output).not.toMatchObject({ vision: { questionSent: false } });
      expect((result.output as { content: string }).content).not.toContain("was not sent");
    });
  });

  describe("retry after a failed inspection (task 843)", () => {
    const ok = () => new Response(JSON.stringify({
      id: "vision-response", model: "minimax-m3",
      choices: [{ message: { content: "A head-and-shoulders portrait photograph." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const base: DurableTurnToolExecutor = {
      modelContent: async () => [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
      execute: async () => { throw new Error("unexpected base execution"); },
    };
    const failed = (sequence: number, error: string) => ({ ...visionStep(), id: `vision-failed-${sequence}`, sequence, state: "failed" as const, error });

    it("allows one identical retry after a transient provider error", async () => {
      const fetchMock = vi.fn(async () => ok());
      vi.stubGlobal("fetch", fetchMock);
      const snapshot = visionSnapshot();
      snapshot.steps = [failed(1, "Vision provider returned HTTP 500: upstream error")];

      await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
        .execute(snapshot, { ...visionStep(), sequence: 3 }))
        .resolves.toMatchObject({ output: { vision: { cacheHit: false } } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("blocks after a second transient failure without calling the provider", async () => {
      const fetchMock = vi.fn(async () => ok());
      vi.stubGlobal("fetch", fetchMock);
      const snapshot = visionSnapshot();
      snapshot.steps = [failed(1, "Vision provider returned HTTP 500"), failed(3, "Vision provider returned HTTP 504")];

      await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
        .execute(snapshot, { ...visionStep(), sequence: 5 }))
        .rejects.toThrow("no new image was exposed");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lets a later successful inspection resolve an earlier failure", async () => {
      const fetchMock = vi.fn(async () => ok());
      vi.stubGlobal("fetch", fetchMock);
      const snapshot = visionSnapshot();
      snapshot.steps = [
        failed(1, "Vision provider returned HTTP 400: invalid request"),
        { ...visionStep(), id: "vision-ok", sequence: 3, state: "completed" as const, output: { vision: { observation: "ok" } } },
      ];

      await expect(new DurableVisionToolExecutor(base, new MemoryVisionCache(), { VISION_TEST_KEY: "secret" })
        .execute(snapshot, { ...visionStep(), sequence: 5 })).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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
