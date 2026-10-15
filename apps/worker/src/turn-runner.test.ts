import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DURABLE_BASE_BUILT_IN_TOOLS,
  latestAssistantStreamDraft,
  type AgentStreamEvent,
  type TurnRunState,
} from "@berry/shared";
import {
  OpenAIChatCompletionsClient,
  RouterClientError,
  type ChatCompletionChunk,
  type ChatCompletionOptions,
} from "@berry/router-client";
import {
  DurableTurnRunner,
  DurableTurnRetryableError,
  DurableToolExecutionError,
  DURABLE_IMAGE_TOOL_SELECTION_PROMPT,
  DURABLE_REWRITING_PROMPT,
  DURABLE_TOOL_DEFINITIONS,
  RouterDurableTurnModel,
  SnapshotProviderDurableTurnModel,
  SqlDurableTurnRepository,
  createDurableTurnModel,
  durableImageToolSelectionPrompt,
  journalSafeToolResult,
  durableBuiltInToolDefinitions,
  durableToolManifestMetrics,
  queuedFollowUpRuntimeRequest,
  modelMessages,
  usageCostMicros,
  type BudgetReservationDecision,
  type DurableTurnModel,
  type DurableTurnMutation,
  type DurableTurnRepository,
  type DurableTurnRetryDiagnostics,
  type DurableTurnSnapshot,
  type DurableTurnStep,
  type DurableTurnToolExecutor,
  type TurnToolResult,
} from "./turn-runner.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { ActiveTurnCancellationRegistry } from "./turn-cancellation.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const runId = "00000000-0000-7000-8000-000000000002";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable turn runner", () => {
  it("prices Gemini 3.7 Flash usage in micro-dollars from per-million rates", () => {
    expect(usageCostMicros({
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 200,
    }, {
      input: 0.75,
      output: 3.75,
      cacheRead: 0.075,
    })).toBe(990n);
  });

  it("measures the serialized tool manifest before model calls", () => {
    const metrics = durableToolManifestMetrics([
      {
        type: "function",
        function: { name: "read", description: "Read a file", parameters: { type: "object" } },
      },
    ]);

    expect(metrics.toolCount).toBe(1);
    expect(metrics.serializedBytes).toBe(Buffer.byteLength(JSON.stringify([{
      type: "function",
      function: { name: "read", description: "Read a file", parameters: { type: "object" } },
    }]), "utf8"));
    expect(metrics.approximateTokens).toBe(Math.ceil(metrics.serializedBytes / 4));
  });

  it("routes connected-service requests through deferred discovery and keeps path domains explicit", () => {
    const prompt = modelMessages(providerSnapshot("openai-responses"));

    expect(prompt.stableSystemPrompt).toContain("Google Drive");
    expect(prompt.stableSystemPrompt).toContain("tool_search");
    expect(prompt.stableSystemPrompt).toContain("remote file id");
    expect(prompt.stableSystemPrompt).toContain("outputs directory");
  });

  it("includes faithful rewriting instructions in the actual provider system prompt", () => {
    const prompt = modelMessages(providerSnapshot("openai-responses"));
    expect(prompt.stableSystemPrompt).toContain(DURABLE_REWRITING_PROMPT);
    expect(prompt.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"))
      .toContain(DURABLE_REWRITING_PROMPT);
  });

  it("never replays a failed run's platform error as an assistant answer", () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    const providerError = "The model provider rejected this request (HTTP 400). Check the model configuration.";
    const entry = (id: string, message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      entryId: id, parentEntryId: current.entries.at(-1)?.entryId ?? null, entryType: "message", sequence: current.entries.length + 1,
      payload: { type: "message", id, parentId: current.entries.at(-1)?.entryId ?? null, ...extra, message },
    });
    current.entries.push(
      // Pre-fix API projection of a failed message: the error stored as text.
      entry("failed-legacy", { role: "assistant", content: [{ type: "text", text: providerError }], stopReason: "error" }, { projectionSource: "messages" }),
      // Fixed projection keeps the diagnostic typed.
      entry("failed-typed", { role: "assistant", content: [{ type: "error", text: providerError }], stopReason: "error" }, { projectionSource: "messages" }),
      // Genuine partial output journaled by the worker itself is still context.
      entry("partial", { role: "assistant", content: [{ type: "text", text: "Partial draft: the fee is AED 450" }], stopReason: "failed" }),
      // A user may legitimately quote the error; user text is never filtered.
      entry("quote", { role: "user", content: `Rewrite this error for my team: ${providerError}` }),
    );

    const history = modelMessages(current).messages;
    const assistantText = history.filter((message) => message.role === "assistant").map((message) => JSON.stringify(message.content)).join("\n");
    expect(assistantText).not.toContain("HTTP 400");
    expect(assistantText).toContain("Partial draft: the fee is AED 450");
    expect(JSON.stringify(history.at(-1)?.content)).toContain("Rewrite this error for my team");
    expect(history.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  describe("prompt layout for provider prefix caching", () => {
    const turn = (grounding: Record<string, unknown>, builtInTools: string[], history: Array<Record<string, unknown>>) => {
      const current = providerSnapshot("openai-responses");
      current.runtimeRequest = { ...current.runtimeRequest, builtInTools };
      current.groundingContext = grounding;
      current.entries = history.map((message, index) => ({
        entryId: `entry-${index}`, parentEntryId: index ? `entry-${index - 1}` : null, entryType: "message", sequence: index + 1,
        payload: { type: "message", id: `entry-${index}`, message },
      }));
      current.requestMessageId = `entry-${lastIndex(history, (message) => message.role === "user")}`;
      return current;
    };
    const lastIndex = <T,>(items: readonly T[], match: (item: T) => boolean) => {
      for (let index = items.length - 1; index >= 0; index -= 1) if (match(items[index]!)) return index;
      return -1;
    };
    const firstTurn = [{ role: "user", content: "Summarise section 4." }];
    const firstAnswer = [
      ...firstTurn,
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "spec.pdf" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "Section 4: fire pumps" },
      { role: "assistant", content: [{ type: "text", text: "Section 4 covers fire pumps." }], stopReason: "stop" },
    ];

    it("points an explicitly requested short skill name at the enabled skill (H-052)", () => {
      const skill = (name: string, description: string) => ({
        name, description, content: `# ${name}`, filePath: `/personal-skills/${name}/SKILL.md`, disableModelInvocation: false, resources: [],
      });
      const turnContext = (input: string, skills: ReturnType<typeof skill>[], steps: DurableTurnStep[] = []) => {
        const current = turn({}, ["read", "activate_skill"], [{ role: "user", content: input }]);
        current.runtimeRequest = { ...current.runtimeRequest, input, extraSkills: skills };
        current.steps = [...current.steps, ...steps];
        return String(modelMessages(current).messages.find((message) => String(message.content).startsWith("<berry_turn_context>"))?.content);
      };
      // Task 1164: "BSBG" with bsbg-cv-converter enabled.
      const bsbg = skill("bsbg-cv-converter", "Convert CVs to the BSBG format.");
      expect(turnContext("Please use BSBG on the attached CV", [bsbg])).toContain('asks to use "bsbg", which matches the enabled skill bsbg-cv-converter');
      expect(turnContext("Write an email to the AESG team", [skill("aesg-branding", "AESG brand rules.")])).not.toContain("matches the enabled skill");
      expect(turnContext("Use AESG for this deck", [skill("aesg-branding", "AESG brand rules."), skill("aesg-cv", "AESG CVs.")]))
        .toContain("matches several enabled skills: aesg-branding, aesg-cv");
      const activated = { ...toolStep("completed", "read_only", false), type: "tool.activate_skill", input: { toolCallId: "a", toolName: "activate_skill", arguments: { name: "bsbg-cv-converter" }, requiresApproval: false, approvalKind: "file-edit" } } as DurableTurnStep;
      expect(turnContext("Please use BSBG on the attached CV", [bsbg], [activated])).not.toContain("matches the enabled skill");
    });

    it("states the run's start date in the turn context and keeps it stable across calls (H-023)", () => {
      const current = turn({}, ["read"], firstTurn);
      current.createdAt = "2026-10-14T21:30:00.000Z";
      const turnContext = () => String(modelMessages(current).messages.find((message) => String(message.content).startsWith("<berry_turn_context>"))?.content);
      const first = turnContext();
      expect(first).toContain("Current date and time when this turn started: Wednesday, 14 October 2026 at 21:30 (UTC)");
      expect(turnContext()).toBe(first);
      current.runtimeRequest = { ...current.runtimeRequest, timezone: "Asia/Dubai" };
      expect(turnContext()).toContain("Thursday, 15 October 2026 at 01:30 (Asia/Dubai)");
      current.runtimeRequest = { ...current.runtimeRequest, timezone: "Mars/Olympus" };
      expect(turnContext()).toContain("at 21:30 (UTC)");
      // The cached system prefix carries no date.
      expect(String(modelMessages(current).messages[0]?.content)).not.toContain("Current date");
    });

    it("keeps the system message and earlier turns identical when grounding and routed tools change", () => {
      const last = modelMessages(turn({ memory: "project uses NFPA 20" }, ["read"], firstAnswer)).messages;
      const next = modelMessages(turn({ memory: "pumps were replaced in 2025" }, ["read", "bash"], [
        ...firstAnswer, { role: "user", content: "Now check section 5." },
      ])).messages;

      expect(next[0]).toEqual(last[0]);
      expect(String(next[0]?.content)).not.toContain("untrusted_grounding");
      expect(String(next[0]?.content)).toContain("Runtime environment:");
      // Everything before the earlier turn's context message is reused verbatim.
      const earlierContext = last.findIndex((message) => String(message.content).startsWith("<berry_turn_context>"));
      expect(earlierContext).toBe(2);
      expect(next.slice(0, earlierContext)).toEqual(last.slice(0, earlierContext));
      const context = next.find((message, index) => index > 2 && String(message.content).startsWith("<berry_turn_context>"));
      expect(String(context?.content)).toContain("pumps were replaced in 2025");
      expect(next.indexOf(context!) - 1).toBe(lastIndex(next, (message) => message.content === "Now check section 5."));
    });

    it("appends within a run without rewriting the request or its context", () => {
      const grounding = { memory: "project uses NFPA 20" };
      const call1 = modelMessages(turn(grounding, ["read"], firstTurn)).messages;
      const call2 = modelMessages(turn(grounding, ["read"], firstAnswer.slice(0, 3))).messages;
      expect(call2.slice(0, call1.length)).toEqual(call1);
    });

    it("adds per-call recovery text at the end instead of changing the prefix", () => {
      const normal = turn({ memory: "x" }, ["read"], firstAnswer.slice(0, 3));
      const recovering = turn({ memory: "x" }, ["read"], firstAnswer.slice(0, 3));
      recovering.steps = [...recovering.steps, { ...modelStep("pending", 2), input: { iteration: 2, recoveryReason: "empty_response" } }];
      const before = modelMessages(normal).messages;
      const after = modelMessages(recovering).messages;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Recovery instruction") });
    });

    it("keeps the original single system message when the request anchor is unavailable", () => {
      const current = turn({ memory: "legacy grounding" }, ["read"], firstTurn);
      current.requestMessageId = "compacted-away";
      const messages = modelMessages(current).messages;
      expect(String(messages[0]?.content)).toContain("legacy grounding");
      expect(messages.some((message) => String(message.content).startsWith("<berry_turn_context>"))).toBe(false);
    });
  });

  describe("explicit Continue", () => {
    const continued = (after: Array<Record<string, unknown>>) => {
      const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
      current.runtimeRequest = { ...current.runtimeRequest, continueInterruptedTurn: true };
      const push = (id: string, message: Record<string, unknown>) => current.entries.push({
        entryId: id, parentEntryId: current.entries.at(-1)?.entryId ?? null, entryType: "message", sequence: current.entries.length + 1,
        payload: { type: "message", id, parentId: current.entries.at(-1)?.entryId ?? null, message },
      });
      push("earlier-answer", { role: "assistant", content: [{ type: "text", text: "Comment 4 covers the old cable routing." }], stopReason: "stop" });
      push("latest-request", { role: "user", content: "Now refocus the comments on remote monitoring." });
      current.requestMessageId = "latest-request";
      after.forEach((message, index) => push(`after-${index}`, message));
      const built = modelMessages(current);
      const contextIndex = built.messages.findIndex((message) => String(message.content).startsWith("<berry_turn_context>"));
      return {
        system: String(built.messages[0]?.content),
        context: String(built.messages[contextIndex]?.content),
        beforeContext: built.messages[contextIndex - 1],
        last: built.messages.at(-1),
      };
    };

    it("answers the pending request when the interrupted attempt produced nothing", () => {
      const { system, context, beforeContext, last } = continued([]);
      expect(context).toContain("failed before producing any response to the user's latest message");
      expect(context).not.toContain("from the persisted partial output");
      expect(system).not.toContain("explicit continuation request");
      // The pending request is the latest user message; no synthetic "continue" turn follows.
      expect(beforeContext).toMatchObject({ role: "user", content: "Now refocus the comments on remote monitoring." });
      expect(String(last?.content)).toMatch(/^<berry_turn_context>/);
    });

    it("still continues genuine partial output without repeating it", () => {
      const { context, last } = continued([{ role: "assistant", content: [{ type: "text", text: "Remote monitoring: 1." }], stopReason: "failed" }]);
      expect(context).toContain("from the persisted partial output");
      expect(last).toMatchObject({ role: "user", content: "Continue the interrupted response from where it stopped. Do not repeat the completed portion." });
    });

    it("continues from completed tool results without redoing them", () => {
      const { context, last } = continued([
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "spec.pdf" } }], stopReason: "toolUse" },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "Section 7: remote monitoring requirements" },
      ]);
      expect(context).toContain("completed the tool work shown above");
      expect(JSON.stringify(last)).toContain("Continue from the completed tool results above");
    });
  });

  it("keeps a queued prompt's billing identity across delivery retries", () => {
    const runtime = queuedFollowUpRuntimeRequest({ queuedBudgetRequestId: "queued:browser-key", budgetReservationRequired: true }, {
      id: "row-id", attempt_count: 3, input: "Rewrite this email", intent: null, attachments: [],
    });
    expect(runtime).toMatchObject({ requestId: "queued:browser-key", budgetReservationRequired: true, continueInterruptedTurn: false });
  });

  it("guides ordinary image-edit turns toward the admitted image tool", () => {
    expect(durableImageToolSelectionPrompt([...DURABLE_BASE_BUILT_IN_TOOLS, "create_image"]))
      .toBe(DURABLE_IMAGE_TOOL_SELECTION_PROMPT);
    expect(DURABLE_IMAGE_TOOL_SELECTION_PROMPT).toContain("background replacement");
    expect(DURABLE_IMAGE_TOOL_SELECTION_PROMPT).toContain("Prefer create_image");
    expect(DURABLE_IMAGE_TOOL_SELECTION_PROMPT).toContain("already saves the generated file");
    expect(DURABLE_TOOL_DEFINITIONS.find((tool) => tool.function.name === "create_image")?.function.description)
      .toContain("already published");
    expect(durableImageToolSelectionPrompt(DURABLE_BASE_BUILT_IN_TOOLS)).toBe("");
  });

  it("preserves admitted built-ins when workflow routing is advisory", () => {
    const current = providerSnapshot("openai-responses");
    current.runtimeRequest = {
      ...current.runtimeRequest,
      workflowCategory: "communications",
      workflowCategoryVersion: "workflow-v1",
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "ask_user_question", "compose_message", "persist_artifact"],
    };

    const names = durableBuiltInToolDefinitions(current).map((tool) => tool.function.name);
    expect(names).toEqual([
      "read", "bash", "edit", "write", "grep", "find", "ls",
      "ask_user_question", "compose_message", "persist_artifact", "save_personal_skill",
    ]);
  });

  it("uses the queued prompt intent instead of inheriting its predecessor intent", () => {
    const base = { providerId: "router", intent: "image_generation", attachments: [{ fileId: "old" }] };
    const normal = queuedFollowUpRuntimeRequest(base, {
      id: "queue-normal",
      attempt_count: 1,
      input: "Explain the result",
      intent: null,
      attachments: [],
    });
    const image = queuedFollowUpRuntimeRequest({ providerId: "router" }, {
      id: "queue-image",
      attempt_count: 2,
      input: "Create a diagram",
      intent: "image_generation",
      attachments: [],
    });

    expect(normal).not.toHaveProperty("intent");
    expect(normal).toMatchObject({ requestId: "queued:queue-normal:1", input: "Explain the result", attachments: [] });
    expect(image).toMatchObject({ requestId: "queued:queue-image:2", intent: "image_generation", input: "Create a diagram" });
  });

  it("advertises Pi's seven coding tools", () => {
    const write = DURABLE_TOOL_DEFINITIONS.find((tool) => tool.function.name === "write");
    const bash = DURABLE_TOOL_DEFINITIONS.find((tool) => tool.function.name === "bash");
    const edit = DURABLE_TOOL_DEFINITIONS.find((tool) => tool.function.name === "edit");

    expect(write?.function.parameters).toMatchObject({
      required: ["path", "content"],
      properties: { path: { description: "Path to the file to write (relative or absolute)" } },
    });
    expect(write?.function.parameters).not.toHaveProperty("properties.content.maxLength");
    expect(bash?.function.parameters).toMatchObject({
      required: ["command"],
      properties: { timeout: { description: "Timeout in seconds (optional, no default timeout)" } },
    });
    expect(edit?.function.parameters).toMatchObject({
      required: ["path", "edits"],
      properties: {
        edits: {
          items: { required: ["oldText", "newText"] },
        },
      },
    });
    expect(DURABLE_BASE_BUILT_IN_TOOLS.slice(0, 7)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  });

  it("advertises document and ZIP routing on the read tool", () => {
    const read = DURABLE_TOOL_DEFINITIONS.find((tool) => tool.function.name === "read");
    expect(read?.function.description).toContain("PDFs");
    expect(read?.function.description).toContain("Word documents");
    expect(read?.function.description).toContain("spreadsheets");
    expect(read?.function.description).toContain("ZIP archives");
    expect(read?.function.parameters).toMatchObject({
      properties: {
        page_start: { description: expect.stringContaining("PDF page") },
        page_end: { description: expect.stringContaining("PDF page") },
      },
    });
    const current = providerSnapshot("openai-responses");
    current.runtimeRequest = { ...current.runtimeRequest, builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS] };
    expect(modelMessages(current).messages[0]?.content)
      .toContain("For an uploaded PDF, Word document, spreadsheet, presentation, or ZIP, call read");
  });

  it("offers the same file-edit tools to DeepSeek V4 Flash", () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = {
      capabilityVersion: 1,
      input: "Fix the file",
      providerId: "router",
      model: "canopywave/deepseek/deepseek-v4-flash",
      provider: {
        id: "router",
        name: "Berry Router",
        kind: "berry-router",
        baseUrl: "https://router.example.test/v1",
        defaultModel: "canopywave/deepseek/deepseek-v4-flash",
        apiType: "openai-chat-completions",
        endpointPath: "/chat/completions",
        authType: "none",
        models: [],
      },
      conversationKind: "chat",
      workspacePath: "/workspace",
      workspaceId: current.workspaceId,
      permissionMode: "ask",
      reasoning: "off",
      maxTokens: 8_000,
      contextWindowTokens: 128_000,
      modelAcceptsImages: false,
      modelPricing: {},
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS],
      mcpServers: [],
      extraSkills: [],
      attachments: [],
    };

    const names = durableBuiltInToolDefinitions(current).map((tool) => tool.function.name);
    expect(names).toContain("edit");
    expect(names).toContain("write");

    current.runtimeRequest = { ...current.runtimeRequest, model: "kimi-2.6" };
    expect(durableBuiltInToolDefinitions(current).map((tool) => tool.function.name)).toContain("edit");
  });

  it("starts in live mode without a global router for snapshot-admitted providers", () => {
    expect(createDurableTurnModel({ BERRY_API_MODEL_MODE: "live" }))
      .toBeInstanceOf(SnapshotProviderDurableTurnModel);
  });

  it.each([
    ["openai-responses", "resp-success"],
    ["anthropic-messages", "msg-success"],
  ] as const)("returns successful request identifiers from %s", async (apiType, responseId) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      apiType === "openai-responses"
        ? [
            'data: {"type":"response.output_text.delta","delta":"ok"}',
            `data: {"type":"response.completed","response":{"id":"${responseId}","model":"served-model","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}`,
            "data: [DONE]",
            "",
          ].join("\n\n")
        : [
            `data: {"type":"message_start","message":{"id":"${responseId}","model":"served-model","usage":{"input_tokens":2,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}`,
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            'data: {"type":"content_block_stop","index":0}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
            'data: {"type":"message_stop"}',
            "",
          ].join("\n\n"),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-router-request-id": `${apiType} request@42`,
        },
      },
    )) as typeof fetch);
    const current = providerSnapshot(apiType);
    const deltas: string[] = [];
    const result = await new SnapshotProviderDurableTurnModel({}, null).call(
      current,
      modelStep("pending", 1),
      {
        messageId: randomUUID(),
        tools: [],
        additionalUserContent: [],
        emitDelta: async (delta) => { deltas.push(delta); },
        policyForTool: () => ({
          retryClass: "read_only",
          repeatPolicy: "compare_result",
          requiresApproval: false,
          approvalKind: "mcp",
        }),
      },
    );

    expect(result).toMatchObject({
      text: "ok",
      providerResponseId: responseId,
      routerRequestId: `${apiType}_request_42`,
      inputTokens: apiType === "anthropic-messages" ? 9 : 2,
      outputTokens: 1,
    });
    expect(deltas.join("")).toBe("ok");
    if (apiType === "anthropic-messages") {
      expect(result.usage).toMatchObject({ inputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 10 });
      expect(usageCostMicros({ inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        cacheReadTokens: result.usage?.cacheReadTokens ?? 0, cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0 },
      { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 2 })).toBe(8n);
    }
  });

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "rethrows structured transient errors from %s",
    async (apiType) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({ error: { message: "temporarily unavailable", code: "upstream_unavailable" } }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-request-id": `${apiType} request@503`,
          },
        },
      )) as typeof fetch);
      const current = providerSnapshot(apiType);

      await expect(new SnapshotProviderDurableTurnModel({}, null).call(
        current,
        modelStep("pending", 1),
        {
          messageId: randomUUID(),
          tools: [],
          additionalUserContent: [],
          emitDelta: async () => undefined,
          policyForTool: () => ({
            retryClass: "read_only",
            repeatPolicy: "compare_result",
            requiresApproval: false,
            approvalKind: "mcp",
          }),
        },
      )).rejects.toMatchObject({
        name: "RouterClientError",
        status: 503,
        code: "upstream_unavailable",
        requestId: `${apiType}_request_503`,
      });
    },
  );

  it("does not duplicate a completed step when the queue delivery repeats", async () => {
    const repository = new FakeTurnRepository(snapshot("queued", [admittedStep()]));
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        modelCalls += 1;
        await context.emitDelta("Done.", "text");
        return {
          text: "Done.",
          inputTokens: 2,
          outputTokens: 1,
          toolCalls: [],
        };
      },
    }, noTools(), { owner: "worker-a" });

    await runner.execute({ tenantId, runId, reason: "admitted" });
    await runner.execute({ tenantId, runId, reason: "continue" });
    await runner.execute({ tenantId, runId, reason: "continue" });
    const duplicate = await runner.execute({ tenantId, runId, reason: "continue" });

    expect(repository.current.state).toBe("completed");
    expect(modelCalls).toBe(1);
    expect(repository.events.filter((event) => event.kind === "turn.end")).toHaveLength(1);
    expect(duplicate.noOp).toBe(true);
  });

  it("retries one empty model response instead of marking the turn complete", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { text: "", inputTokens: 3, outputTokens: 0, toolCalls: [] }
          : { text: "Completed after retry.", inputTokens: 4, outputTokens: 3, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-empty-response" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(repository.current.state).toBe("calling_model");
    expect(repository.current.steps.find((step) => step.state === "pending" && step.type === "model.call")?.input)
      .toMatchObject({ recoveryReason: "empty_response" });
    expect(repository.events.some((event) => event.kind === "turn.end")).toBe(false);

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "finalizing" });
    expect(modelCalls).toBe(2);
    expect(repository.current.entries.some((entry) => JSON.stringify(entry.payload).includes("Completed after retry.")))
      .toBe(true);
  });

  it("does not spend the turn wall-clock budget on persisted human wait", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    const humanWaitMs = 6 * 24 * 60 * 60 * 1_000;
    current.createdAt = new Date(Date.now() - humanWaitMs).toISOString();
    current.humanWaitMs = humanWaitMs;
    const repository = new FakeTurnRepository(current);
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "Resumed.", inputTokens: 2, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-human-wait", maxTurnDurationMs: 60 * 60 * 1_000 });

    await expect(runner.execute({ tenantId, runId, reason: "user-input" }))
      .resolves.toMatchObject({ state: "finalizing" });
    expect(modelCalls).toBe(1);
  });

  it("releases per-run tool resources while waiting without finalizing artifacts", async () => {
    const current = snapshot("waiting", [admittedStep()]);
    const repository = new FakeTurnRepository(current);
    const release = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => []);
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      ...noTools(),
      release,
      finalize,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "waiting", noOp: true });

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(current);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("fails visibly when the empty-response recovery is also empty", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    const runner = new DurableTurnRunner(repository, {
      call: async () => ({ text: "", inputTokens: 3, outputTokens: 0, toolCalls: [] }),
    }, noTools(), { owner: "worker-repeated-empty-response" });

    await runner.execute({ tenantId, runId, reason: "continue" });
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(repository.current.error).toContain("empty response twice");
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "turn.end",
      status: "failed",
    }));
  });

  it("reports a provider length stop instead of retrying it as an empty response", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = {
      ...current.runtimeRequest,
      contextWindowTokens: 1_000_000,
      maxTokens: 384_000,
    };
    const repository = new FakeTurnRepository(current);
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        modelCalls += 1;
        await context.emitDelta("unfinished reasoning", "reasoning");
        return {
          text: "",
          reasoning: "unfinished reasoning",
          finishReason: "length",
          providerResponseId: "completion-cut-off",
          inputTokens: 50,
          outputTokens: 32_598,
          usage: {
            kind: "usage",
            inputTokens: 50,
            outputTokens: 32_598,
            totalTokens: 32_648,
          },
          toolCalls: [],
        };
      },
    }, noTools(), { owner: "worker-length-stop" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(modelCalls).toBe(1);
    expect(repository.current.error).toContain("32,598 provider-reported output tokens");
    expect(repository.current.error).toContain("Berry requested up to 384,000 output tokens");
    expect(repository.current.error).toContain("lower provider-side generation cap or incorrect model metadata");
    expect(repository.current.error).toContain("Provider response ID: completion-cut-off");
    expect(repository.current.steps.filter((step) => step.type === "model.call")).toHaveLength(1);
    expect(repository.current.steps.at(-1)?.output).toMatchObject({
      finishReason: "length",
      providerResponseId: "completion-cut-off",
      outputTokens: 32_598,
      requestedMaxOutputTokens: 384_000,
      reasoningCharacters: 20,
    });
    expect(repository.events.some((event) => event.kind === "message.end")).toBe(false);
    expect(latestAssistantStreamDraft(repository.events)).toMatchObject({
      reasoning: "unfinished reasoning",
      text: "",
      open: true,
    });
  });

  it("hands sanitized provider diagnostics to the atomic retry release", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.model = "provider/model";
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        throw new RouterClientError(
          "Provider request failed with 503",
          503,
          "sensitive upstream response body",
          { code: "upstream_unavailable", requestId: "router_request_503" },
        );
      },
    }, noTools(), { owner: "worker-provider-retry" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toBeInstanceOf(DurableTurnRetryableError);

    expect(repository.releasedRetryDiagnostics).toEqual({
      stepId: current.steps.find((step) => step.type === "model.call")!.id,
      providerDiagnostics: {
        outcome: "failure",
        model: "provider/model",
        status: 503,
        statusClass: "5xx",
        category: "server",
        retryDecision: "retry",
        physicalAttempt: 2,
        latencyMs: expect.any(Number),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        finishReason: null,
        errorCode: "UPSTREAM_UNAVAILABLE",
      },
    });
    expect(JSON.stringify(repository.releasedRetryDiagnostics)).not.toContain("sensitive upstream response body");
    expect(JSON.stringify(repository.releasedRetryDiagnostics)).not.toContain("router_request_503");
    expect(repository.releasedError).toBe(
      "The model provider returned a server error (HTTP 503). Berry will retry it.",
    );
  });

  it("explains an HTTP 413 as a payload-size failure without leaking provider content", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, {
      call: async () => { throw new RouterClientError("private response", 413, "private image payload", { code: "request_too_large" }); },
    }, noTools(), { owner: "worker-image-budget" });
    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({ state: "failed" });
    expect(repository.current.error).toContain("payload size limit (HTTP 413)");
    expect(repository.current.error).toContain("Reduce the image sizes");
    expect(repository.current.error).not.toContain("configuration");
    expect(JSON.stringify(repository.events)).not.toContain("private");
    expect(repository.releasedRetryDiagnostics).toBeUndefined();
  });

  it("terminally fails provider HTTP 409 instead of releasing it for a BullMQ retry", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        throw new RouterClientError("Upstream tenant secret for request router_request_409", 409, "sensitive body", {
          code: "conflict",
          requestId: "router_request_409",
        });
      },
    }, noTools(), { owner: "worker-provider-conflict" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });

    expect(repository.current.state).toBe("failed");
    expect(repository.current.error).toBe(
      "The model provider rejected the request (HTTP 409). Check the selected model and provider configuration before retrying.",
    );
    expect(repository.releasedRetryDiagnostics).toBeUndefined();
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "turn.end",
      status: "failed",
    }));
    expect(repository.events).toContainEqual({
      kind: "error",
      message: "The model provider rejected the request (HTTP 409). Check the selected model and provider configuration before retrying.",
    });
    const persistedSurface = JSON.stringify({
      error: repository.current.error,
      events: repository.events,
      mutations: repository.mutations,
    });
    expect(persistedSurface).not.toContain("Upstream tenant secret");
    expect(persistedSurface).not.toContain("router_request_409");
    expect(persistedSurface).not.toContain("sensitive body");
  });

  it("stops a sustained exact reasoning loop before it can consume the full model allowance", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let providerAborted = false;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        context.signal?.addEventListener("abort", () => {
          providerAborted = true;
        }, { once: true });
        await context.emitDelta("loop".repeat(300), "reasoning");
        return { text: "", inputTokens: 1, outputTokens: 300, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-output-loop" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(repository.current.error).toContain("exact repeating reasoning loop");
    expect(providerAborted).toBe(true);
  });

  it("aborts an active provider request immediately when cancellation is published", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    const cancellations = new ActiveTurnCancellationRegistry();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => new Promise<never>((_resolve, reject) => {
        providerStarted();
        context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      }),
    }, noTools(), { owner: "worker-immediate-cancel", cancellations });

    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    await started;
    expect(cancellations.cancel(runId)).toBe(1);

    await expect(execution).resolves.toMatchObject({ state: "cancelled" });
  });

  it("bounds a hung signal-aware read and persists timeout progress", async () => {
    const tool = readOnlyToolStep("read", 1, "/workspace/hung.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    let aborted = false;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      supportsAbort: () => true,
      execute: async (_snapshot, _step, signal) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    }, {
      owner: "worker-hung-read",
      toolIdleTimeoutMs: 10,
      toolMaxDurationMs: 1_000,
      abortCleanupTimeoutMs: 50,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(aborted).toBe(true);
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      state: "failed",
      timedOut: true,
      outcomeCertainty: "known",
      abortAcknowledged: true,
    });
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "phase.deadline_exceeded",
      phase: "tool",
      deadlineKind: "idle",
    }));
  });

  it("records a false abort acknowledgment when an explicitly abort-aware read ignores its signal", async () => {
    const tool = readOnlyToolStep("read", 1, "/workspace/ignored.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      supportsAbort: () => true,
      execute: async () => new Promise<never>(() => undefined),
    }, {
      owner: "worker-ignored-read",
      toolIdleTimeoutMs: 5,
      toolMaxDurationMs: 1_000,
      abortCleanupTimeoutMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      state: "failed",
      timedOut: true,
      outcomeCertainty: "known",
      abortAcknowledged: false,
    });
  });

  it("does not infer abort support from an executor's parameter count", async () => {
    const tool = readOnlyToolStep("read", 1, "/workspace/arity.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    let aborted = false;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async (_snapshot, _step, signal) => new Promise<TurnToolResult>((resolve) => {
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        setTimeout(() => resolve({ output: { content: "settled" }, summary: "settled" }), 20);
      }),
    }, {
      owner: "worker-arity-without-capability",
      toolIdleTimeoutMs: 5,
      toolMaxDurationMs: 1_000,
      abortCleanupTimeoutMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(aborted).toBe(false);
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      timedOut: true,
      abortAcknowledged: false,
    });
  });

  it("uses an explicit abort capability even when the executor has no declared parameters", async () => {
    const tool = readOnlyToolStep("read", 1, "/workspace/explicit-capability.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    let aborted = false;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      supportsAbort: () => true,
      execute: async function () {
        const signal = arguments[2] as AbortSignal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    }, {
      owner: "worker-explicit-capability",
      toolIdleTimeoutMs: 5,
      toolMaxDurationMs: 1_000,
      abortCleanupTimeoutMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(aborted).toBe(true);
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      timedOut: true,
      abortAcknowledged: true,
    });
  });

  it("aborts a parallel read-only batch only when every step declares support", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/first.txt");
    const second = readOnlyToolStep("grep", 2, "/workspace/second.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    let aborted = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      supportsAbort: () => true,
      execute: async (_snapshot, _step, signal) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted += 1;
          reject(signal.reason);
        }, { once: true });
      }),
    }, {
      owner: "worker-parallel-capability",
      toolIdleTimeoutMs: 5,
      toolMaxDurationMs: 1_000,
      abortCleanupTimeoutMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toThrow("Parallel read-only tool batch stalled");
    expect(aborted).toBe(2);
    expect(repository.current.steps.filter((step) => step.type.startsWith("tool.")))
      .toEqual([expect.objectContaining({ id: first.id, state: "running" }), expect.objectContaining({ id: second.id, state: "running" })]);
  });

  it("does not abort a parallel read-only batch when one step lacks support", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/first.txt");
    const second = readOnlyToolStep("grep", 2, "/workspace/second.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    let aborted = false;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      supportsAbort: (_snapshot, step) => toolNameFromTestStep(step) === "read",
      execute: async (_snapshot, _step, signal) => new Promise<TurnToolResult>((resolve) => {
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        setTimeout(() => resolve({ output: { content: "settled" }, summary: "settled" }), 20);
      }),
    }, {
      owner: "worker-parallel-mixed-capability",
      toolIdleTimeoutMs: 5,
      toolMaxDurationMs: 1_000,
      abortCleanupTimeoutMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toThrow("Parallel read-only tool batch stalled");
    expect(aborted).toBe(false);
  });

  it("cancels a read-only adapter that observes its signal", async () => {
    const tool = readOnlyToolStep("read", 1, "/workspace/cancel.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const cancellations = new ActiveTurnCancellationRegistry();
    let started!: () => void;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async (_snapshot, _step, signal) => new Promise<never>((_resolve, reject) => {
        started();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }, { owner: "worker-read-cancel", cancellations });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });

    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    await startedPromise;
    expect(cancellations.cancel(runId)).toBe(1);
    await expect(execution).resolves.toMatchObject({ state: "cancelled" });
  });

  it.each(["idle", "wall"] as const)("preserves a confirmed mutation result after its %s deadline", async (deadline) => {
    const tool = toolStep("pending", "non_idempotent_manual", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const receipt = { output: { exitCode: 0, content: "Verified workbook totals" }, summary: "Recalculation completed" };
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return receipt;
    });
    const runner = new DurableTurnRunner(repository, unusedModel(), { execute }, {
      toolIdleTimeoutMs: deadline === "idle" ? 5 : 1_000,
      toolMaxDurationMs: deadline === "wall" ? 5 : 1_000,
    });
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      state: "completed", output: receipt.output,
    });
    expect(repository.current.error).toBeNull();
    expect(repository.events.some((event) => event.kind === "error")).toBe(false);
  });

  it("still requires recovery when a mutation rejects after its deadline without a receipt", async () => {
    const tool = toolStep("pending", "non_idempotent_manual", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("Connection lost before receiving the command result");
    });
    const runner = new DurableTurnRunner(repository, unusedModel(), { execute }, {
      toolIdleTimeoutMs: 5, toolMaxDurationMs: 1_000,
    });
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "recovery_required" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      state: "recovery_required", outcomeCertainty: "unknown",
    });
  });

  it("does not accept a late mutation receipt after losing its lease", async () => {
    const tool = toolStep("pending", "non_idempotent_manual", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    vi.spyOn(repository, "heartbeat").mockResolvedValue(false);
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { output: { accepted: true }, summary: "Late receipt" };
      },
    }, { heartbeatMs: 5, toolIdleTimeoutMs: 10, toolMaxDurationMs: 1_000 });
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "recovery_required" });
    expect(repository.current.steps.find((step) => step.id === tool.id)?.state).toBe("recovery_required");
  });

  it("moves an ignored cancellation during mutation to recovery without replaying it", async () => {
    const tool = toolStep("pending", "non_idempotent_manual", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const cancellations = new ActiveTurnCancellationRegistry();
    let started!: () => void;
    let finish!: (result: TurnToolResult) => void;
    let calls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        calls += 1;
        started();
        return new Promise<TurnToolResult>((resolve) => { finish = resolve; });
      },
    }, { owner: "worker-mutation-cancel", cancellations });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });

    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    await startedPromise;
    expect(cancellations.cancel(runId)).toBe(1);
    finish({ output: { accepted: true }, summary: "Mutation settled after cancellation" });

    await expect(execution).resolves.toMatchObject({ state: "recovery_required" });
    expect(calls).toBe(1);
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      state: "recovery_required",
      outcomeCertainty: "unknown",
    });
    expect(repository.current.error).toBe("ambiguous_external_operation");
  });

  it("caps the model output allowance to the remaining context capacity", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = {
      ...current.runtimeRequest,
      contextWindowTokens: 100_000,
      maxTokens: 60_000,
    };
    current.entries[0]!.payload = {
      type: "message",
      message: { role: "user", content: "x".repeat(200_000) },
    };
    const repository = new FakeTurnRepository(current);
    let receivedMaxTokens = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async (modelSnapshot) => {
        receivedMaxTokens = Number(modelSnapshot.runtimeRequest.maxTokens);
        return { text: "Done.", inputTokens: 50_000, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-context-headroom" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "finalizing" });
    expect(receivedMaxTokens).toBeGreaterThan(0);
    expect(receivedMaxTokens).toBeLessThanOrEqual(49_000);
  });

  it("keeps complete tool results when they fit the model-window envelope", () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    for (let index = 0; index < 30; index += 1) {
      current.entries.push({
        entryId: `tool-entry-${index}`,
        parentEntryId: current.entries.at(-1)?.entryId ?? null,
        entryType: "message",
        sequence: current.entries.length + 1,
        payload: {
          type: "message",
          id: `tool-entry-${index}`,
          message: {
            role: "toolResult",
            toolCallId: `tool-call-${index}`,
            toolName: "read",
            content: [{ type: "text", text: `${"unchanged-result ".repeat(400)}-${index}` }],
          },
        },
      });
    }

    const toolMessages = modelMessages(current).messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(30);
    expect(String(toolMessages[0]?.content)).toBe(`${"unchanged-result ".repeat(400)}-0`);
    expect(String(toolMessages[24]?.content)).toBe(`${"unchanged-result ".repeat(400)}-24`);
    expect(toolMessages.reduce((total, message) => total + String(message.content).length, 0)).toBeGreaterThan(48_000);
  });

  it("bounds tool results at the model-window envelope before provider submission", () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.contextWindowTokens = 32_000;
    current.entries.push({
      entryId: "huge-tool-entry",
      parentEntryId: current.entries.at(-1)?.entryId ?? null,
      entryType: "message",
      sequence: current.entries.length + 1,
      payload: {
        type: "message",
        id: "huge-tool-entry",
        message: {
          role: "toolResult",
          toolCallId: "huge-tool-call",
          toolName: "connector_search",
          content: [{ type: "text", text: "x".repeat(200_000) }],
        },
      },
    });

    const toolMessage = modelMessages(current).messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content).length).toBeLessThanOrEqual((32_000 - 16_384 - 1_024) * 4);
    expect(String(toolMessage?.content)).toContain("[durable-result:huge-tool-entry]");
    expect(String(toolMessage?.content)).toContain("[result content bounded]");
  });

  it("marks results past the shared tool budget as omitted instead of sending them empty (H-036)", () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.contextWindowTokens = 32_000;
    for (const index of [1, 2]) {
      current.entries.push({
        entryId: `large-tool-entry-${index}`,
        parentEntryId: current.entries.at(-1)?.entryId ?? null,
        entryType: "message",
        sequence: current.entries.length + 1,
        payload: {
          type: "message",
          id: `large-tool-entry-${index}`,
          message: { role: "toolResult", toolCallId: `large-tool-call-${index}`, toolName: "connector_search", content: [{ type: "text", text: "y".repeat(200_000) }] },
        },
      });
    }

    const [first, second] = modelMessages(current).messages.filter((message) => message.role === "tool");
    expect(String(first?.content)).toContain("[result content bounded]");
    // The first result used the whole budget; the second used to be "".
    expect(String(second?.content)).toContain("[durable-result:large-tool-entry-2]");
    expect(String(second?.content)).toContain("omitted here to stay within the model's context limit");
  });

  it("reclaims an expired lease from the persisted pending model step", async () => {
    const pending = modelStep("pending", 1);
    const state = snapshot("calling_model", [admittedStep(), pending]);
    state.leaseOwner = "dead-worker";
    const repository = new FakeTurnRepository(state);
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        modelCalls += 1;
        await context.emitDelta("Recovered.", "text");
        return { text: "Recovered.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), { owner: "replacement-worker" });

    const result = await runner.execute({ tenantId, runId, reason: "lease-recovery" });

    expect(result.state).toBe("finalizing");
    expect(modelCalls).toBe(1);
    expect(repository.current.steps.find((step) => step.id === pending.id)?.state).toBe("completed");
  });

  it("fails an exhausted model step instead of recovering forever", async () => {
    const exhausted = { ...modelStep("running", 1), attempt: 3 };
    const current = snapshot("calling_model", [admittedStep(), exhausted]);
    current.error = "The provider stream ended before completion";
    current.sandboxProvider = "e2b";
    current.sandboxId = "sandbox-1";
    current.sandboxState = "running";
    const repository = new FakeTurnRepository(current);
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "", inputTokens: 0, outputTokens: 0, toolCalls: [] };
      },
    }, noTools());

    const result = await runner.execute({ tenantId, runId, reason: "lease-recovery" });

    expect(result.state).toBe("failed");
    expect(modelCalls).toBe(0);
    expect(repository.current.steps.find((step) => step.id === exhausted.id)?.state).toBe("failed");
    expect(repository.outbox).toContainEqual(expect.objectContaining({
      eventType: "sandbox.snapshot",
      dedupeKey: `${runId}:snapshot:failed`,
    }));
  });

  it("aborts and retries a model request that stops making progress", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let aborted = false;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => new Promise((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(context.signal?.reason);
        }, { once: true });
      }),
    }, noTools(), { owner: "worker-timeout", modelIdleTimeoutMs: 10 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toThrow("Model request stalled for 1 seconds without progress");
    expect(aborted).toBe(true);
    expect(repository.current.steps.find((step) => step.type === "model.call")?.attempt).toBe(1);
  });

  it("keeps the lease while non-abortable model preparation settles after its deadline", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let modelCalls = 0;
    let releaseDefinitions!: () => void;
    const definitions = new Promise<readonly []>((resolve) => {
      releaseDefinitions = () => resolve([]);
    });
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "unexpected", inputTokens: 0, outputTokens: 0, toolCalls: [] };
      },
    }, {
      definitions: async () => definitions,
      execute: async () => ({ output: {}, summary: "unused" }),
    }, {
      owner: "worker-preparation-timeout",
      modelPreparationTimeoutMs: 5,
      abortCleanupTimeoutMs: 5,
    });

    let settled = false;
    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toBe(false);
    expect(repository.current.leaseOwner).toMatch(/^worker-preparation-timeout:/);
    expect(modelCalls).toBe(0);

    releaseDefinitions();
    await expect(execution)
      .rejects.toThrow("Model input preparation exceeded its maximum duration");
    expect(modelCalls).toBe(0);
    expect(repository.current.steps.find((step) => step.type === "model.call")?.attempt).toBe(0);
    expect(repository.current.leaseOwner).toBe("");
  });

  it("keeps the turn lease until an aborted model request finishes cleanup", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let cleanupFinished = false;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        try {
          return await new Promise<never>((_resolve, reject) => {
            context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
          });
        } finally {
          await new Promise((resolve) => setTimeout(resolve, 20));
          cleanupFinished = true;
        }
      },
    }, noTools(), {
      owner: "worker-cleanup",
      modelIdleTimeoutMs: 10,
      abortCleanupTimeoutMs: 100,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toThrow("Model request stalled");
    expect(cleanupFinished).toBe(true);
    expect(repository.current.leaseOwner).toBe("");
  });

  it("bounds cleanup time when an aborted provider never settles", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    const runner = new DurableTurnRunner(repository, {
      call: async () => new Promise<never>(() => undefined),
    }, noTools(), {
      owner: "worker-stuck-cleanup",
      modelIdleTimeoutMs: 5,
      abortCleanupTimeoutMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toThrow("Model request stalled");
    expect(repository.current.leaseOwner).toBe("");
  });

  it("aborts a noisy model stream at its absolute duration limit", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let aborted = false;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => new Promise((_resolve, reject) => {
        const activity = setInterval(() => context.reportProgress?.(), 1);
        context.signal?.addEventListener("abort", () => {
          clearInterval(activity);
          aborted = true;
          reject(context.signal?.reason);
        }, { once: true });
      }),
    }, noTools(), {
      owner: "worker-max-duration",
      modelIdleTimeoutMs: 1_000,
      modelMaxDurationMs: 10,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toThrow("Model request exceeded its maximum duration of 1 seconds");
    expect(aborted).toBe(true);
    expect(repository.current.steps.find((step) => step.type === "model.call")?.attempt).toBe(1);
  });

  it("resumes a running read-only tool safely", async () => {
    const tool = toolStep("running", "read_only", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    let calls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        calls += 1;
        return { output: { content: "safe" }, summary: "Read completed" };
      },
    }, { owner: "worker-b" });

    const result = await runner.execute({ tenantId, runId, reason: "lease-recovery" });

    expect(result.state).toBe("calling_model");
    expect(calls).toBe(1);
    expect(repository.current.steps.find((step) => step.id === tool.id)?.state).toBe("completed");
    const completed = repository.mutations.find((mutation) => mutation.toolResultMessage);
    expect(completed?.toolResultMessage?.id).toBe(completed?.entries?.[0]?.entryId);
  });

  it("runs independent reads concurrently and persists reverse-completing results in source order", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/first.txt");
    const second = readOnlyToolStep("grep", 2, "/workspace/second.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async (_snapshot, step) => {
        const name = toolNameFromTestStep(step);
        started.push(name);
        await new Promise<void>((resolve) => releases.set(name, resolve));
        return { output: { content: `${name} result` }, summary: `${name} completed` };
      },
    }, { owner: "worker-parallel-reads" });

    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    releases.get("grep")?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repository.current.steps.find((step) => step.id === first.id)?.state).toBe("running");
    releases.get("read")?.();

    await expect(execution).resolves.toMatchObject({ state: "calling_model" });
    expect(started).toEqual(["read", "grep"]);
    const resultMutation = repository.mutations.find((mutation) => mutation.toolResultMessages);
    expect(resultMutation?.toolResultMessages?.map((result) => result.toolCallId)).toEqual([
      first.input.toolCallId,
      second.input.toolCallId,
    ]);
    expect(repository.current.entries.slice(-2).map((entry) =>
      (entry.payload as { message?: { toolName?: string } }).message?.toolName
    )).toEqual(["read", "grep"]);
  });

  it("persists successful siblings when one parallel read fails", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/missing.txt");
    const second = readOnlyToolStep("ls", 2, "/workspace");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async (_snapshot, step) => {
        if (toolNameFromTestStep(step) === "read") throw new Error("missing file");
        return { output: { content: "second.txt" }, summary: "listed" };
      },
    }, { owner: "worker-parallel-sibling-failure" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });

    expect(repository.current.steps.find((step) => step.id === first.id))
      .toMatchObject({ state: "failed", error: "missing file" });
    expect(repository.current.steps.find((step) => step.id === second.id))
      .toMatchObject({ state: "completed", output: { content: "second.txt" } });
    expect(repository.mutations.find((mutation) => mutation.toolResultMessages)?.toolResultMessages)
      .toEqual([
        expect.objectContaining({ toolCallId: first.input.toolCallId, status: "failed" }),
        expect.objectContaining({ toolCallId: second.input.toolCallId, status: "completed" }),
      ]);
  });

  it("heartbeats a parallel read batch and aborts its durable wait on cancellation", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/first.txt");
    const second = readOnlyToolStep("find", 2, "/workspace");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    let heartbeatCount = 0;
    repository.heartbeat = async () => {
      heartbeatCount += 1;
      return true;
    };
    const cancellations = new ActiveTurnCancellationRegistry();
    const releases: Array<() => void> = [];
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { output: { content: "done" }, summary: "done" };
      },
    }, {
      owner: "worker-parallel-cancel",
      cancellations,
      heartbeatMs: 1,
      leaseSeconds: 1,
    });

    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await vi.waitFor(() => expect(heartbeatCount).toBeGreaterThan(0));
    expect(cancellations.cancel(runId)).toBe(1);
    for (const release of releases) release();

    await expect(execution).resolves.toMatchObject({ state: "cancelled" });
    expect(repository.current.steps.filter((step) => step.type.startsWith("tool.")))
      .toEqual([
        expect.objectContaining({ id: first.id, state: "running" }),
        expect.objectContaining({ id: second.id, state: "running" }),
      ]);
    expect(repository.mutations.some((mutation) => mutation.toolResultMessages)).toBe(false);
  });

  it("falls back to ordered execution when a batch contains a stateful tool", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/source.txt");
    const second = { ...toolStep("pending", "idempotent", false), sequence: 2 };
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    const calls: string[] = [];
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async (_snapshot, step) => {
        calls.push(toolNameFromTestStep(step));
        return { output: { content: "done" }, summary: "done" };
      },
    }, { owner: "worker-mixed-tool-order" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "executing_tool" });
    expect(calls).toEqual(["read"]);
    expect(repository.current.steps.find((step) => step.id === second.id)?.state).toBe("pending");
  });

  it("recovers a running read batch without duplicating start events or completed results", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/first.txt", "running");
    const second = readOnlyToolStep("ls", 2, "/workspace", "running");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    let toolCalls = 0;
    const tools: DurableTurnToolExecutor = {
      execute: async () => {
        toolCalls += 1;
        return { output: { content: "safe" }, summary: "read completed" };
      },
    };
    const runner = new DurableTurnRunner(repository, {
      call: async () => ({ text: "done", inputTokens: 1, outputTokens: 1, toolCalls: [] }),
    }, tools, { owner: "worker-parallel-recovery" });

    await expect(runner.execute({ tenantId, runId, reason: "lease-recovery" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(toolCalls).toBe(2);
    expect(repository.events.filter((event) => event.kind === "tool.start")).toHaveLength(0);
    expect(repository.mutations.filter((mutation) => mutation.toolResultMessages)).toHaveLength(1);

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "finalizing" });
    expect(toolCalls).toBe(2);
    expect(repository.mutations.filter((mutation) => mutation.toolResultMessages)).toHaveLength(1);
  });

  it("moves an ambiguous running non-idempotent tool to recovery_required", async () => {
    const tool = toolStep("running", "non_idempotent_manual", false);
    const current = snapshot("executing_tool", [admittedStep(), tool]);
    current.sandboxProvider = "e2b";
    current.sandboxId = "sandbox-1";
    current.sandboxState = "running";
    const repository = new FakeTurnRepository(current);
    let calls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        calls += 1;
        return { output: {}, summary: "" };
      },
    }, { owner: "worker-c" });

    const result = await runner.execute({ tenantId, runId, reason: "lease-recovery" });

    expect(result.state).toBe("recovery_required");
    expect(calls).toBe(0);
    expect(repository.current.steps.find((step) => step.id === tool.id)?.state).toBe("recovery_required");
    expect(repository.current.error).toBe("ambiguous_non_idempotent_tool");
    expect(repository.outbox).toContainEqual(expect.objectContaining({
      dedupeKey: `${runId}:snapshot:recovery-required`,
    }));
  });

  it("snapshots a cancelled sandbox so the snapshot worker can pause it", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.cancelledAt = new Date().toISOString();
    current.sandboxProvider = "e2b";
    current.sandboxId = "sandbox-1";
    current.sandboxState = "running";
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, unusedModel(), noTools());

    const result = await runner.execute({ tenantId, runId, reason: "continue" });

    expect(result.state).toBe("cancelled");
    expect(repository.outbox).toContainEqual(expect.objectContaining({
      dedupeKey: `${runId}:snapshot:cancelled`,
    }));
  });

  it("settles every unfinished tool projection when cancellation is observed", async () => {
    const first = { ...toolStep("pending", "idempotent", false), sequence: 1 };
    const second = { ...toolStep("waiting", "idempotent", false), sequence: 2 };
    const current = snapshot("executing_tool", [admittedStep(), first, second]);
    current.cancelledAt = new Date().toISOString();
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, unusedModel(), noTools());

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "cancelled" });

    expect(repository.current.steps.filter((step) => step.type.startsWith("tool.")))
      .toEqual([
        expect.objectContaining({ id: first.id, state: "cancelled" }),
        expect.objectContaining({ id: second.id, state: "cancelled" }),
      ]);
    const terminalMutation = repository.mutations.at(-1)!;
    expect(terminalMutation.toolResultMessages).toEqual([
      expect.objectContaining({ toolCallId: first.input.toolCallId, status: "cancelled" }),
      expect.objectContaining({ toolCallId: second.input.toolCallId, status: "cancelled" }),
    ]);
    expect(terminalMutation.events).toEqual([
      expect.objectContaining({ kind: "tool.end", toolCallId: first.input.toolCallId, status: "failed" }),
      expect.objectContaining({ kind: "tool.end", toolCallId: second.input.toolCallId, status: "failed" }),
      expect.objectContaining({ kind: "turn.end", status: "cancelled" }),
    ]);
  });

  it("releases the lease while waiting for approval and resumes after a durable wakeup", async () => {
    const tool = toolStep("pending", "idempotent", true);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    let calls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        calls += 1;
        return { output: { written: true }, summary: "Write completed" };
      },
    }, { owner: "worker-d" });

    const waiting = await runner.execute({ tenantId, runId, reason: "continue" });
    expect(waiting.state).toBe("waiting");
    expect(repository.current.leaseOwner).toBe("");
    expect(repository.current.approvals[0]?.status).toBe("pending");
    expect(repository.outbox.some((item) => item.eventType === "sandbox.snapshot")).toBe(true);

    repository.current.approvals = repository.current.approvals.map((approval) => ({ ...approval, status: "approved" }));
    repository.current.steps = repository.current.steps.map((step) => step.id === tool.id ? { ...step, state: "pending" } : step);
    repository.current.state = "executing_tool";
    const resumed = await runner.execute({ tenantId, runId, reason: "approval-resolved" });

    expect(resumed.state).toBe("calling_model");
    expect(calls).toBe(1);
    expect(repository.outbox.some((item) => item.eventType === "turn.execute")).toBe(true);
  });

  it("compacts an oversized in-flight journal before the next model request", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
    repository.current.entries[0]!.payload = {
      type: "message",
      message: { role: "user", content: "x".repeat(16_000) },
    };
    let compactions = 0;
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        modelCalls += 1;
        await context.emitDelta("Continued.", "text");
        return { text: "Continued.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), {
      owner: "worker-compact",
      contextWindowTokens: 20_000,
      compactor: {
        compactSession: async () => {
          compactions += 1;
          repository.current.checkpointCoveredEntryId = repository.current.entries.at(-1)?.entryId ?? null;
          return { sessionId: repository.current.sessionId, summary: "Checkpointed.", tokensBefore: 2_000, tokensAfter: 100 };
        },
      },
    });

    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("compacting");
    expect(repository.current.steps.find((step) => step.type === "model.call")).toMatchObject({
      state: "pending",
      attempt: 0,
    });
    expect(repository.current.steps.find((step) => step.type === "session.compact")).toMatchObject({
      state: "pending",
    });
    expect(repository.events).toContainEqual({
      kind: "session.note",
      note: "compacting",
      detail: "Context auto-compacting",
    });
    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("calling_model");
    expect(repository.events).toContainEqual({
      kind: "session.note",
      note: "compacted",
      detail: "Context compacted from 2000 to 100 tokens.",
    });
    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("finalizing");
    expect(compactions).toBe(1);
    expect(modelCalls).toBe(1);
  });

  it("does not compact generated image bytes as if their base64 were prompt text", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.contextWindowTokens = 40_000;
    const repository = new FakeTurnRepository(current);
    let compactions = 0;
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "The image is ready.", inputTokens: 2_000, outputTokens: 10, toolCalls: [] };
      },
    }, {
      execute: async () => ({ output: {}, summary: "" }),
      modelContent: async () => [{
        type: "image_url",
        image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` },
      }],
    }, {
      owner: "worker-image-context",
      compactor: {
        compactSession: async () => {
          compactions += 1;
          return { sessionId: current.sessionId, summary: "Unexpected compaction", tokensBefore: 0 };
        },
      },
    });

    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("finalizing");
    expect(compactions).toBe(0);
    expect(modelCalls).toBe(1);
  });

  it("uses a reduced post-compaction estimate instead of compacting the retained tail forever", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.contextWindowTokens = 20_000;
    current.entries.push({
      entryId: "entry-assistant-retained",
      parentEntryId: "entry-user",
      entryType: "message",
      sequence: 2,
      payload: {
        type: "message",
        message: {
          role: "assistant",
          content: "Retained response",
          usage: { input: 18_000, output: 1_000, totalTokens: 19_000 },
        },
      },
    });
    const repository = new FakeTurnRepository(current);
    let compactions = 0;
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "Continued.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), {
      owner: "worker-compact-no-op",
      compactor: {
        compactSession: async () => {
          compactions += 1;
          return {
            sessionId: repository.current.sessionId,
            summary: "The retained tail is already compacted.",
            tokensBefore: 19_000,
            tokensAfter: 2_000,
            noOp: true,
          };
        },
      },
    });

    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("compacting");
    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("calling_model");
    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("finalizing");
    expect(compactions).toBe(1);
    expect(modelCalls).toBe(1);
  });

  it("fails clearly when the retained tail remains too large after compaction", async () => {
    const compactStep: DurableTurnStep = {
      id: randomUUID(),
      sequence: 2,
      type: "session.compact",
      state: "completed",
      input: {},
      output: { noOp: true, tokensBefore: 19_000, tokensAfter: 19_000 },
      retryClass: "idempotent_with_key",
      idempotencyKey: `${runId}:compact:entry-user`,
      attempt: 1,
      error: null,
    };
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1), compactStep]);
    current.runtimeRequest.contextWindowTokens = 20_000;
    const repository = new FakeTurnRepository(current);
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "", inputTokens: 0, outputTokens: 0, toolCalls: [] };
      },
    }, noTools(), {
      owner: "worker-compact-still-large",
      compactor: { compactSession: async () => ({ sessionId: current.sessionId, summary: "", tokensBefore: 0 }) },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({ state: "failed" });
    expect(modelCalls).toBe(0);
    expect(repository.current.error).toContain("Context remains above the safe model limit after compaction");
  });

  it("includes unchanged grounding content in the post-compaction limit check", async () => {
    const compactStep: DurableTurnStep = {
      id: randomUUID(),
      sequence: 2,
      type: "session.compact",
      state: "completed",
      input: {},
      output: { tokensBefore: 30_000, tokensAfter: 500 },
      retryClass: "idempotent_with_key",
      idempotencyKey: `${runId}:compact:entry-user`,
      attempt: 1,
      error: null,
    };
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1), compactStep]);
    current.runtimeRequest.contextWindowTokens = 20_000;
    current.groundingContext = { document: "x".repeat(100_000) };
    const repository = new FakeTurnRepository(current);
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "", inputTokens: 0, outputTokens: 0, toolCalls: [] };
      },
    }, noTools(), {
      owner: "worker-compact-large-grounding",
      compactor: { compactSession: async () => ({ sessionId: current.sessionId, summary: "", tokensBefore: 0 }) },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({ state: "failed" });
    expect(modelCalls).toBe(0);
    expect(repository.current.error).toContain("Context remains above the safe model limit after compaction");
  });

  it("persists model deltas before the model call completes", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        await context.emitDelta("Hello", "text");
        expect(repository.events.map((event) => event.kind)).toEqual([
          "message.start",
          "message.delta",
        ]);
        await context.emitDelta(" world", "text");
        return { text: "Hello world", inputTokens: 2, outputTokens: 2, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-stream" });

    await runner.execute({ tenantId, runId, reason: "continue" });

    expect(repository.events.map((event) => event.kind)).toEqual([
      "message.start",
      "message.delta",
      "message.delta",
      "message.end",
      "provider.attempt",
    ]);
    expect(repository.events
      .filter((event): event is Extract<AgentStreamEvent, { kind: "message.delta" }> => event.kind === "message.delta")
      .map((event) => event.delta)
      .join("")).toBe("Hello world");
  });

  it("keeps consuming reasoning deltas while a journal write is in flight", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
    let releaseJournalWrite!: () => void;
    const journalWriteReleased = new Promise<void>((resolve) => { releaseJournalWrite = resolve; });
    let journalWriteStarted!: () => void;
    const journalWriteStartedPromise = new Promise<void>((resolve) => { journalWriteStarted = resolve; });
    let blockFirstDelta = true;
    const appendEvents = repository.appendEvents.bind(repository);
    repository.appendEvents = async (current, events) => {
      if (blockFirstDelta && events.some((event) => event.kind === "message.delta")) {
        blockFirstDelta = false;
        journalWriteStarted();
        await journalWriteReleased;
      }
      await appendEvents(current, events);
    };
    let consumedSecondDelta = false;
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        await context.emitDelta("First thought. ", "reasoning");
        await context.emitDelta("Second thought.", "reasoning");
        consumedSecondDelta = true;
        return {
          text: "Done.",
          reasoning: "First thought. Second thought.",
          inputTokens: 2,
          outputTokens: 4,
          toolCalls: [],
        };
      },
    }, noTools(), { owner: "worker-smooth-reasoning" });

    const execution = runner.execute({ tenantId, runId, reason: "continue" });
    await journalWriteStartedPromise;
    // Let the model continuation run after the journal promise reports that
    // persistence is blocked. It must not be waiting on that blocked write.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(consumedSecondDelta).toBe(true);
    releaseJournalWrite();
    await execution;

    expect(repository.events
      .filter((event): event is Extract<AgentStreamEvent, { kind: "message.delta" }> => event.kind === "message.delta")
      .map((event) => event.delta)
      .join(""))
      .toBe("First thought. Second thought.");
  });

  it("feeds a read-only tool exception back to the model instead of failing the turn", async () => {
    const tool = toolStep("pending", "read_only", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => { throw new Error("Search provider unavailable"); },
    }, { owner: "worker-tool-failure" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({
      state: "calling_model",
    });
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "tool.end",
      status: "failed",
    }));
    expect(repository.events.some((event) => event.kind === "turn.end")).toBe(false);
    expect(repository.current.steps.find((step) => step.id === tool.id)?.state).toBe("failed");
    expect(repository.current.steps.some((step) =>
      step.type === "model.call" && step.state === "pending"
    )).toBe(true);
    const failed = repository.mutations.find((mutation) => mutation.toolResultMessage);
    expect(failed?.toolResultMessage?.id).toBe(failed?.entries?.[0]?.entryId);
  });

  it("reserves for the vision retry and records provider usage when inspection still fails", async () => {
    const tool = {
      ...toolStep("pending", "idempotent_with_key", false),
      type: "tool.inspect_images",
      input: {
        toolCallId: randomUUID(),
        toolName: "inspect_images",
        arguments: { mode: "overview" },
        requiresApproval: false,
        approvalKind: "file-edit" as const,
      },
    };
    const current = snapshot("executing_tool", [admittedStep(), tool]);
    current.runtimeRequest = {
      capabilityVersion: 1,
      requestId: "vision-request",
      input: "Inspect this image",
      providerId: "router",
      provider: { id: "router", name: "Router", kind: "berry-router", baseUrl: "https://router.example/v1", defaultModel: "text-model" },
      model: "text-model",
      workspacePath: "/workspace",
      workspaceId: current.workspaceId,
      permissionMode: "full-access",
      reasoning: "off",
      maxTokens: 4_096,
      contextWindowTokens: 100_000,
      modelAcceptsImages: false,
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "inspect_images"],
      vision: {
        providerId: "router",
        provider: { id: "router", name: "Router", kind: "berry-router", baseUrl: "https://router.example/v1", defaultModel: "vision-model" },
        model: "vision-model",
        maxTokens: 1_536,
        modelPricing: { input: 0, output: 0 },
        estimatedCostMicros: "3000",
      },
      attachments: [],
    };
    const repository = new FakeTurnRepository(current);
    const usage = {
      kind: "usage" as const,
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      costRawMicros: "25",
      pricingSource: "measured" as const,
      servedProvider: "router",
      servedModel: "vision-model",
    };
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => { throw new DurableToolExecutionError("Vision remained empty", usage); },
    }, { owner: "worker-vision-failure" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({
      state: "calling_model",
    });

    expect(repository.lastBudgetEstimate).toBe("6000");
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "usage",
      inputTokens: 50,
      outputTokens: 10,
      costRawMicros: "25",
    }));
  });

  it("feeds a known non-idempotent tool exception back to the model", async () => {
    const tool = toolStep("pending", "non_idempotent_manual", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => { throw new Error("Command exited with 2: file not found"); },
    }, { owner: "worker-command-failure" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({
      state: "calling_model",
    });
    expect(repository.current.state).toBe("calling_model");
    expect(repository.current.error).toBeNull();
    expect(repository.current.steps.find((step) => step.id === tool.id)).toMatchObject({
      state: "failed",
      error: "Tool failed (repair attempt 1/5). Command exited with 2: file not found",
    });
  });

  it("allows a fifth identical tool attempt after four matching failures", async () => {
    const error = "Arguments must include content; raw is not supported";
    const failures = Array.from({ length: 4 }, (_, index) => ({
      ...toolStep("failed", "idempotent", false),
      sequence: index + 1,
      error: `Tool failed (repair attempt 5/5). ${error}`,
    }));
    const pending = { ...toolStep("pending", "idempotent", false), sequence: 5 };
    let executions = 0;
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), ...failures, pending]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        throw new Error(error);
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(1);
    expect(repository.current.steps.find((step) => step.id === pending.id)).toMatchObject({
      state: "failed",
      error: `Tool failed (repair attempt 5/5). ${error}`,
    });
  });

  it("stops after five identical tool failures instead of starting a sixth loop", async () => {
    const error = "Arguments must include content; raw is not supported";
    const failures = Array.from({ length: 5 }, (_, index) => ({
      ...toolStep("failed", "idempotent", false),
      sequence: index + 1,
      error,
    }));
    const pending = { ...toolStep("pending", "idempotent", false), sequence: 6 };
    const laterPendingToolCallId = randomUUID();
    const laterPending = {
      ...toolStep("pending", "idempotent", false),
      sequence: 7,
      input: {
        toolCallId: laterPendingToolCallId,
        toolName: "write",
        arguments: { path: "/workspace/later.txt", content: "next" },
        requiresApproval: false,
        approvalKind: "file-edit",
      },
    };
    let executions = 0;
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), ...failures, pending, laterPending]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: {}, summary: "unexpected" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(executions).toBe(0);
    expect(repository.current.error).toContain("failed 5 times with identical arguments and error");
    expect(repository.current.error).toContain("before attempt 6");
    expect(repository.current.steps.find((step) => step.id === pending.id)?.state).toBe("failed");
    expect(repository.current.steps.find((step) => step.id === laterPending.id)?.state).toBe("failed");
    const terminalMutation = repository.mutations.at(-1)!;
    expect(terminalMutation.toolResultMessages?.map((result) => result.toolCallId)).toEqual([
      pending.input.toolCallId,
      laterPendingToolCallId,
    ]);
    expect(terminalMutation.events?.filter((event) => event.kind === "tool.end")).toEqual([
      expect.objectContaining({ toolCallId: pending.input.toolCallId, status: "failed" }),
      expect.objectContaining({ toolCallId: laterPendingToolCallId, status: "failed" }),
    ]);
  });

  it("counts identical failures across unrelated tool calls", async () => {
    const error = "write requires a non-empty path";
    const writeArguments = { path: "", content: "result" };
    const steps: DurableTurnStep[] = [admittedStep()];
    for (let index = 0; index < 5; index += 1) {
      steps.push({
        ...toolStep("failed", "idempotent", false),
        id: randomUUID(),
        sequence: index * 2 + 1,
        type: "tool.write",
        input: {
          toolCallId: randomUUID(),
          toolName: "write",
          arguments: writeArguments,
          requiresApproval: false,
          approvalKind: "file-edit",
        },
        error: `Tool failed (repair attempt ${index + 1}/5). ${error}`,
      });
      steps.push({
        ...runCommandStep("completed", index * 2 + 2, `printf ${index}`),
        id: randomUUID(),
        output: { exitCode: 0 },
      });
    }
    const pending = {
      ...toolStep("pending", "idempotent", false),
      id: randomUUID(),
      sequence: 11,
      type: "tool.write",
      input: {
        toolCallId: randomUUID(),
        toolName: "write",
        arguments: writeArguments,
        requiresApproval: false,
        approvalKind: "file-edit",
      },
    };
    steps.push(pending);
    let executions = 0;
    const repository = new FakeTurnRepository(snapshot("executing_tool", steps));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: {}, summary: "unexpected" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(executions).toBe(0);
    expect(repository.current.error).toContain("failed 5 times with identical arguments and error");
  });

  describe("typed tool failures (H-003, H-006)", () => {
    type ScriptedCall = { name: string; args: Record<string, unknown>; retryClass?: "read_only" | "idempotent" | "non_idempotent_manual" };
    // Each entry is one model turn issuing one or more tool calls; the tool
    // executor decides per call whether it fails.
    async function driveCalls(turns: ScriptedCall[][], execute: (call: { name: string; args: Record<string, unknown> }) => unknown) {
      const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
      let modelCalls = 0;
      const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
      const runner = new DurableTurnRunner(repository, {
        call: async () => {
          const turn = turns[modelCalls];
          modelCalls += 1;
          if (!turn) return { text: "Done.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
          return {
            text: "",
            inputTokens: 1,
            outputTokens: 1,
            toolCalls: turn.map((call, index) => ({
              id: `call-${modelCalls}-${index}`,
              name: call.name,
              input: call.args as never,
              retryClass: call.retryClass ?? "read_only",
              repeatPolicy: call.retryClass === "non_idempotent_manual" ? "block_after_success" as const : "compare_result" as const,
              idempotencyKey: null,
              requiresApproval: false,
              approvalKind: call.name.startsWith("mcp__") ? "mcp" as const : "file-edit" as const,
            })),
          };
        },
      }, {
        execute: async (_snapshot, step) => {
          const call = { name: String(step.input.toolName), args: (step.input.arguments ?? {}) as Record<string, unknown> };
          executed.push(call);
          return { output: (await execute(call)) as never ?? { ok: true }, summary: "ok" };
        },
      });
      let state: string = "calling_model";
      for (let turn = 0; turn < turns.length * 4 + 4 && (state === "calling_model" || state === "executing_tool"); turn += 1) {
        state = (await runner.execute({ tenantId, runId, reason: "continue" })).state;
      }
      const toolSteps = repository.current.steps.filter((step) => step.type.startsWith("tool."));
      const failure = (index: number) => (toolSteps[index]?.output as { failure?: Record<string, unknown> } | null)?.failure;
      // What the model reads back for each tool step.
      const modelText = (index: number) => {
        const entry = repository.mutations.flatMap((mutation) => mutation.entries ?? [])
          .find((candidate) => (candidate as { stepId?: string }).stepId === toolSteps[index]?.id);
        const content = ((entry?.payload as { message?: { content?: Array<{ text?: string }> } } | undefined)?.message?.content ?? []);
        return content.map((part) => part.text ?? "").join("\n");
      };
      return { state, executed, toolSteps, failure, modelText };
    }
    const countOf = (executed: Array<{ name: string }>, name: string) => executed.filter((call) => call.name === name).length;

    it("refuses an unchanged repeat of an invalid-input failure and runs the corrected call", async () => {
      const bad = { name: "read", args: { path: "notes.md", offset: -1 } };
      const result = await driveCalls([[bad], [bad], [{ name: "read", args: { path: "notes.md", offset: 0 } }]], ({ args }) => {
        if (Number(args.offset) < 0) throw new Error("offset must be a non-negative integer");
        return { content: "notes" };
      });

      expect(countOf(result.executed, "read")).toBe(2);
      expect(result.failure(0)).toMatchObject({ category: "invalid_input", deterministic: true });
      expect(result.modelText(0)).toContain("Failure class: invalid_input");
      expect(String(result.toolSteps[0]?.error)).not.toContain("Failure class");
      expect(result.toolSteps[1]?.state).toBe("failed");
      expect(result.failure(1)).toMatchObject({ category: "invalid_input", refusedUnchangedRetry: true, previousError: "offset must be a non-negative integer" });
      expect(result.modelText(1)).toContain("Not run: this exact call already failed");
      expect(result.toolSteps[2]?.state).toBe("completed");
    });

    it("re-runs a missing-resource call only after a change-making step", async () => {
      let built = false;
      const read = { name: "read", args: { path: "out/report.md" } };
      const result = await driveCalls([
        [read],
        [{ name: "ls", args: { path: "out" } }],
        [read],
        [{ name: "bash", args: { command: "make report" }, retryClass: "idempotent" }],
        [read],
      ], ({ name }) => {
        if (name === "bash") built = true;
        if (name === "read" && !built) throw new Error("ENOENT: no such file or directory, open '/workspace/out/report.md'");
        return { content: "ok" };
      });

      expect(countOf(result.executed, "read")).toBe(2);
      expect(result.failure(0)).toMatchObject({ category: "missing_resource" });
      expect(result.failure(2)).toMatchObject({ refusedUnchangedRetry: true });
      expect(result.toolSteps[4]?.state).toBe("completed");
    });

    it("keeps refusing a credential failure for the rest of the run", async () => {
      const drive = { name: "mcp__Google_Workspace__drive_read_file", args: { fileId: "drive-1" } };
      const result = await driveCalls([[drive], [{ name: "bash", args: { command: "echo hi" }, retryClass: "idempotent" }], [drive]], ({ name }) => {
        if (name === drive.name) throw new Error("Connector token is invalid or expired");
        return { ok: true };
      });

      expect(countOf(result.executed, drive.name)).toBe(1);
      expect(result.failure(0)).toMatchObject({ category: "credentials" });
      expect(String(result.failure(0)?.action)).toContain("Settings → Connectors");
      expect(result.failure(2)).toMatchObject({ category: "credentials", refusedUnchangedRetry: true });
    });

    it("lets a transient read failure be retried within the existing limit", async () => {
      let attempts = 0;
      const read = { name: "read", args: { path: "remote.csv" } };
      const result = await driveCalls([[read], [read]], () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket hang up");
        return { content: "a,b" };
      });

      expect(countOf(result.executed, "read")).toBe(2);
      expect(result.failure(0)).toMatchObject({ category: "transient", deterministic: false });
      expect(result.toolSteps[1]?.state).toBe("completed");
    });

    it("marks an interrupted change-making call as an unknown outcome and never replays it unchecked", async () => {
      const create = { name: "mcp__Connect_Aesg_MCP__create_record", args: { title: "Tender A" }, retryClass: "non_idempotent_manual" as const };
      let creates = 0;
      const result = await driveCalls([
        [create],
        [create],
        [{ name: "mcp__Connect_Aesg_MCP__list_records", args: { title: "Tender A" } }],
        [create],
      ], ({ name }) => {
        if (name === create.name) {
          creates += 1;
          if (creates === 1) throw new Error("socket hang up");
        }
        return { ok: true };
      });

      expect(countOf(result.executed, create.name)).toBe(2);
      expect(result.failure(0)).toMatchObject({ category: "unknown_outcome", outcome: "unknown" });
      expect(result.modelText(0)).toContain("may already have taken effect");
      expect(result.failure(1)).toMatchObject({ category: "unknown_outcome", refusedUnchangedRetry: true });
      expect(result.toolSteps[3]?.state).toBe("completed");
    });

    it("refuses an unchanged deterministic repeat inside a parallel read batch", async () => {
      const missing = { name: "read", args: { path: "missing.md" } };
      const result = await driveCalls([
        [missing, { name: "read", args: { path: "present.md" } }],
        [missing, { name: "read", args: { path: "other.md" } }],
      ], ({ args }) => {
        if (args.path === "missing.md") throw new Error("[not_found] file not found: lstat /workspace/missing.md no such file or directory");
        return { content: String(args.path) };
      });

      expect(result.executed.filter((call) => call.args.path === "missing.md")).toHaveLength(1);
      expect(result.executed.some((call) => call.args.path === "other.md")).toBe(true);
      const refused = result.toolSteps.filter((step) => (step.output as { failure?: { refusedUnchangedRetry?: boolean } } | null)?.failure?.refusedUnchangedRetry);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.input.arguments).toEqual({ path: "missing.md" });
    });
  });

  describe("repair loops across changed arguments (H-004)", () => {
    // A scripted model keeps calling read with a new path each turn; the tool
    // fails every time, naming the path it was given.
    async function driveFailingRead(pathFor: (attempt: number) => string, errorFor: (path: string) => string, attempts: number) {
      const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
      let modelCalls = 0;
      const executed: string[] = [];
      const runner = new DurableTurnRunner(repository, {
        call: async () => {
          modelCalls += 1;
          if (modelCalls > attempts) return { text: "I could not open the file.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
          return {
            text: "",
            inputTokens: 1,
            outputTokens: 1,
            toolCalls: [{
              id: `call-${modelCalls}`,
              name: "read",
              input: { path: pathFor(modelCalls) },
              retryClass: "read_only",
              repeatPolicy: "compare_result",
              idempotencyKey: null,
              requiresApproval: false,
              approvalKind: "file-edit",
            }],
          };
        },
      }, {
        execute: async (_snapshot, step) => {
          const path = String((step.input.arguments as { path?: unknown } | null)?.path);
          executed.push(path);
          throw new Error(errorFor(path));
        },
      });
      let state: string = "calling_model";
      for (let turn = 0; turn < attempts * 3 && (state === "calling_model" || state === "executing_tool"); turn += 1) {
        state = (await runner.execute({ tenantId, runId, reason: "continue" })).state;
      }
      const failures = repository.current.steps.filter((step) => step.type === "tool.read").map((step) => String(step.error ?? ""));
      return { state, executed, failures, error: repository.current.error };
    }
    const missing = (path: string) => `ENOENT: no such file or directory, open '${path}'`;

    it("treats re-spelt paths to the same file as the same call and stops the loop (H-003 refuses them unrun)", async () => {
      const spellings = [
        "outputs/Q3-report.docx",
        "./outputs/Q3-report.docx",
        "/workspace/outputs/Q3-report.docx",
        "outputs//Q3-report.docx",
        "/workspace/./outputs/Q3-report.docx",
        "outputs/Q3-report.docx/",
      ];
      const result = await driveFailingRead((attempt) => spellings[(attempt - 1) % spellings.length]!, missing, 12);

      // The first spelling runs and fails as a missing resource; every re-spelling
      // is refused without running, and the identical refusals end the run.
      expect(result.executed).toHaveLength(1);
      expect(result.state).toBe("failed");
      expect(result.error).toContain("failed 5 times with identical arguments and error");
      expect(result.failures[0]).toMatch(/repair attempt 1\/5/);
      const refused = result.failures.slice(1, -1);
      expect(refused).toHaveLength(5);
      expect(refused.every((failure) => failure.startsWith("Not run: this exact call already failed"))).toBe(true);
      expect(result.failures.at(-1)).toContain("Berry stopped the task before attempt 6");
    });

    it("tells the model when different arguments keep producing the same error", async () => {
      const ids = ["8f3a1c", "8f3a1e", "8f3b1c", "8e3a1c", "9f3a1c", "8f3a2c"];
      const result = await driveFailingRead((attempt) => `/workspace/attachments/cv-${ids[attempt - 1]}.pdf`, missing, ids.length);

      expect(result.executed).toHaveLength(ids.length);
      expect(result.failures[1]).not.toContain("same error");
      expect(result.failures[2]).toContain("same error 3 times in a row with changed arguments");
      expect(result.failures[5]).toContain("same error 6 times in a row with changed arguments");
      // Guidance only: distinct guesses are not stopped by this counter.
      expect(result.state).toBe("finalizing");
    });

    it("does not add guidance while each attempt fails differently", async () => {
      const errors = ["SyntaxError: invalid syntax", "NameError: name 'total' is not defined", "TypeError: unsupported operand type"];
      const result = await driveFailingRead((attempt) => `/workspace/scripts/build-${attempt}.py`, (path) => `${errors[Number(/build-(\d)/.exec(path)?.[1]) - 1]}`, 3);

      expect(result.executed).toHaveLength(3);
      expect(result.failures.some((failure) => failure.includes("same error"))).toBe(false);
    });
  });

  it("stops repeated unknown skill resources even when other activations succeed between failures", async () => {
    const badArguments = { name: "aesg-branding", resources: ["scripts/create_aesg_docx.py"] };
    const error = "Unknown aesg-branding resource: scripts/create_aesg_docx.py";
    const steps: DurableTurnStep[] = [admittedStep()];
    for (let index = 0; index < 3; index += 1) {
      steps.push({
        ...toolStep("failed", "read_only", false),
        id: randomUUID(),
        sequence: index * 2 + 1,
        type: "tool.activate_skill",
        input: {
          toolCallId: randomUUID(),
          toolName: "activate_skill",
          arguments: badArguments,
          requiresApproval: false,
          approvalKind: "file-edit",
        },
        error: `Tool failed (repair attempt ${index + 1}/3). ${error}`,
      });
      steps.push({
        ...toolStep("completed", "read_only", false),
        id: randomUUID(),
        sequence: index * 2 + 2,
        type: "tool.activate_skill",
        input: {
          toolCallId: randomUUID(),
          toolName: "activate_skill",
          arguments: { name: "docx", resources: [] },
          requiresApproval: false,
          approvalKind: "file-edit",
        },
        output: { location: "/runtime-skills/docx/SKILL.md" },
      });
    }
    const pending = {
      ...toolStep("pending", "read_only", false),
      id: randomUUID(),
      sequence: 7,
      type: "tool.activate_skill",
      input: {
        toolCallId: randomUUID(),
        toolName: "activate_skill",
        arguments: badArguments,
        requiresApproval: false,
        approvalKind: "file-edit" as const,
      },
    };
    steps.push(pending);
    let executions = 0;
    const repository = new FakeTurnRepository(snapshot("executing_tool", steps));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: {}, summary: "unexpected" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(executions).toBe(0);
    expect(repository.current.error).toContain("activate_skill exhausted its 3-attempt repair budget");
  });

  it("does not count changed tool arguments as a repeated failure", async () => {
    const error = "Command exited with 1: ModuleNotFoundError: No module named 'build_agreement'";
    const previousCommand = "python3 -c 'import build_agreement'";
    const changedCommand = "cd /workspace/scripts && python3 -c 'import build_agreement'";
    const failures = Array.from({ length: 5 }, (_, index) => ({
      ...runCommandStep("failed", index + 1, previousCommand),
      error,
    }));
    const pending = runCommandStep("pending", 6, changedCommand);
    let executions = 0;
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), ...failures, pending]));
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: { exitCode: 0 }, summary: "Command completed" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(1);
    expect(repository.current.steps.find((step) => step.id === pending.id)?.state).toBe("completed");
    expect(repository.current.error).toBeNull();
  });

  it("stops a turn that exceeds the total model iteration limit", async () => {
    const steps = Array.from({ length: 81 }, (_, index) => ({
      ...modelStep(index === 80 ? "pending" : "completed", index + 1),
      id: randomUUID(),
      idempotencyKey: `${runId}:model:${index + 1}`,
    }));
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), ...steps]));
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "unexpected", inputTokens: 0, outputTokens: 0, toolCalls: [] };
      },
    }, noTools(), { maxModelIterations: 80 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(modelCalls).toBe(0);
    expect(repository.current.error).toContain("80-step model safety limit");
    expect(repository.current.error).toContain("Continue/Play button");
    expect(repository.current.error).not.toContain("prevent an agent loop");
  });

  it("defaults the model iteration safety limit to 200 steps", async () => {
    const steps = Array.from({ length: 201 }, (_, index) => ({
      ...modelStep(index === 200 ? "pending" : "completed", index + 1),
      id: randomUUID(),
      idempotencyKey: `${runId}:model:${index + 1}`,
    }));
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), ...steps]));
    let modelCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        modelCalls += 1;
        return { text: "unexpected", inputTokens: 0, outputTokens: 0, toolCalls: [] };
      },
    }, noTools());

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(modelCalls).toBe(0);
    expect(repository.current.error).toContain("200-step model safety limit");
  });

  it("allows the 79th and 80th model steps but denies the 81st before the provider call", async () => {
    const cases = [
      { count: 79, expectedState: "finalizing" as const, expectedCalls: 1 },
      { count: 80, expectedState: "finalizing" as const, expectedCalls: 1 },
      { count: 81, expectedState: "failed" as const, expectedCalls: 0 },
    ];

    for (const testCase of cases) {
      const steps = Array.from({ length: testCase.count }, (_, index) => ({
        ...modelStep(index === testCase.count - 1 ? "pending" : "completed", index + 1),
        id: randomUUID(),
        idempotencyKey: `${runId}:model:${index + 1}`,
        input: { iteration: index + 1 },
      }));
      const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), ...steps]));
      let calls = 0;
      const runner = new DurableTurnRunner(repository, {
        call: async () => {
          calls += 1;
          return { text: "ok", inputTokens: 1, outputTokens: 1, toolCalls: [] };
        },
      }, noTools(), { maxModelIterations: 80 });

      await expect(runner.execute({ tenantId, runId, reason: "continue" }))
        .resolves.toMatchObject({ state: testCase.expectedState });
      expect(calls).toBe(testCase.expectedCalls);
    }
  });

  it("suppresses a third identical successful bash call and terminates a fourth without execution", async () => {
    const bashStep = (sequence: number, timeout: number): DurableTurnStep => {
      const step = runCommandStep("pending", sequence, "printf same");
      return {
        ...step,
        input: {
          ...step.input,
          arguments: { command: "printf same", timeout },
        },
      };
    };
    const repository = new FakeTurnRepository(snapshot("executing_tool", [
      admittedStep(),
      bashStep(1, 1),
    ]));
    let executions = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return {
          output: { command: "printf same", exitCode: 0, output: "(no output)" },
          summary: "Command completed",
        };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    queueToolForExecution(repository, bashStep(3, 2));
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "turn.progress",
      progressKind: "result_repeated",
    }));

    const third = bashStep(5, 3);
    queueToolForExecution(repository, third);
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(2);
    expect(repository.current.steps.find((step) => step.id === third.id))
      .toMatchObject({ state: "failed", error: "duplicate_tool_call_suppressed" });

    const fourth = bashStep(7, 4);
    queueToolForExecution(repository, fourth);
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(executions).toBe(2);
    expect(repository.current.error).toBe("duplicate_tool_call_loop");
    expect(repository.current.steps.find((step) => step.id === fourth.id))
      .toMatchObject({ state: "failed", error: "duplicate_tool_call_loop" });
  });

  describe("asynchronous job polling (task 917)", () => {
    const poll = (sequence: number): DurableTurnStep => ({
      ...toolStep("pending", "read_only", false),
      sequence,
      type: "tool.mcp__BerryCrawl__get_extract_status",
      input: {
        toolCallId: randomUUID(),
        toolName: "mcp__BerryCrawl__get_extract_status",
        arguments: { id: "extract-job-1" },
        requiresApproval: false,
        approvalKind: "mcp",
        repeatPolicy: "compare_result",
      },
    });
    const runPolls = async (results: string[], maxPolls: number) => {
      const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), poll(1)]));
      let executions = 0;
      const runner = new DurableTurnRunner(repository, unusedModel(), {
        execute: async () => {
          const status = results[Math.min(executions, results.length - 1)]!;
          executions += 1;
          return { output: { content: JSON.stringify({ success: true, status, data: status === "COMPLETED" ? { title: "Spec" } : null }) }, summary: "Job status" };
        },
      });
      let result = await runner.execute({ tenantId, runId, reason: "continue" });
      // Tool steps are spaced by the model-call step the runner adds after each.
      for (let polls = 2; polls <= maxPolls && result.state !== "failed"; polls += 1) {
        queueToolForExecution(repository, poll(polls * 2 - 1));
        result = await runner.execute({ tenantId, runId, reason: "continue" });
      }
      return { repository, executions, result };
    };

    it("keeps polling a job that reports RUNNING until it completes", async () => {
      const { repository, executions } = await runPolls(["RUNNING", "RUNNING", "RUNNING", "COMPLETED"], 4);
      expect(executions).toBe(4);
      expect(repository.current.error).toBeNull();
      expect(repository.current.steps.some((step) => step.error === "duplicate_tool_call_suppressed")).toBe(false);
    });

    it("still stops a job that never leaves RUNNING on the no-progress budget", async () => {
      const { repository, executions } = await runPolls(["RUNNING"], 12);
      expect(repository.current.error).toBe("no_progress_budget");
      expect(executions).toBeLessThanOrEqual(6);
    });
  });

  describe("binary tool output (H-011)", () => {
    it("journals a tool result containing NUL characters instead of failing the run", async () => {
      const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), readOnlyToolStep("read", 1, "/workspace/inputs/bundle.skill")]));
      const runner = new DurableTurnRunner(repository, unusedModel(), {
        execute: async () => ({ output: { path: "/workspace/inputs/bundle.skill", content: "PK\u0003\u0004\u0000\u0000SKILL.md", meta: { "ke\u0000y": ["a\u0000"] } }, summary: "Read bundle.skill" }),
      });
      await runner.execute({ tenantId, runId, reason: "continue" });
      const read = repository.current.steps.find((step) => step.type === "tool.read");
      expect(read?.state).toBe("completed");
      expect(read?.output).toEqual({ path: "/workspace/inputs/bundle.skill", content: "PK\u0003\u0004\uFFFD\uFFFDSKILL.md", meta: { "ke\uFFFDy": ["a\uFFFD"] } });
      expect(JSON.stringify(repository.mutations)).not.toContain("\\u0000");
    });

    it("journals a tool failure whose message contains NUL characters", async () => {
      const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), readOnlyToolStep("read", 1, "/workspace/inputs/data.bin")]));
      const runner = new DurableTurnRunner(repository, unusedModel(), {
        execute: async () => { throw new Error("Unexpected bytes PK\u0003\u0004\u0000"); },
      });
      await runner.execute({ tenantId, runId, reason: "continue" });
      expect(repository.current.steps.find((step) => step.type === "tool.read")?.error).toContain("PK\u0003\u0004\uFFFD");
      expect(JSON.stringify(repository.mutations)).not.toContain("\\u0000");
    });

    it("returns clean results unchanged", () => {
      const result: TurnToolResult = { output: { content: "Name,Total\nAlpha,12", bytes: [0, 1] }, summary: "Read export.csv" };
      expect(journalSafeToolResult(result)).toBe(result);
    });
  });

  describe("repeat guard after file edits (task 718)", () => {
    const render = (sequence: number) => runCommandStep("pending", sequence, "cd /workspace/tmp && python diagram.py");
    const edit = (sequence: number, path: string): DurableTurnStep => ({
      ...toolStep("completed", "idempotent", false),
      sequence,
      type: "tool.edit",
      input: { toolCallId: randomUUID(), toolName: "edit", arguments: { path, edits: [{ oldText: "a", newText: "b" }] }, requiresApproval: false, approvalKind: "file-edit" },
      output: { path, applied: 1 },
    });
    const runRenders = async (editPath: string) => {
      const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), render(1)]));
      let executions = 0;
      const runner = new DurableTurnRunner(repository, unusedModel(), {
        execute: async () => {
          executions += 1;
          // The renderer prints the same acknowledgement whatever it drew.
          return { output: { exitCode: 0, output: "saved /workspace/outputs/diagram.png" }, summary: "Command completed" };
        },
      });
      await runner.execute({ tenantId, runId, reason: "continue" });
      let sequence = 2;
      for (let round = 0; round < 3; round += 1) {
        repository.current.steps.push(edit(sequence++, editPath));
        queueToolForExecution(repository, render(sequence++));
        await runner.execute({ tenantId, runId, reason: "continue" });
      }
      return { repository, executions };
    };

    it("re-runs a renderer after its source file was edited, even with identical output", async () => {
      const { repository, executions } = await runRenders("/workspace/tmp/diagram.py");
      expect(executions).toBe(4);
      expect(repository.current.error).toBeNull();
      expect(repository.current.steps.some((step) => step.error === "duplicate_tool_call_suppressed" || step.error === "duplicate_tool_call_loop")).toBe(false);
    });

    it("still bounds identical renders when only an unrelated file changed", async () => {
      const { repository, executions } = await runRenders("/workspace/notes/todo.md");
      expect(executions).toBe(2);
      expect(repository.current.error).toBe("duplicate_tool_call_loop");
    });
  });

  describe("republishing a rebuilt file (H-028)", () => {
    const publish = (state: DurableTurnStep["state"], sequence: number): DurableTurnStep => ({
      ...toolStep(state, "idempotent", false),
      sequence,
      type: "tool.persist_artifact",
      input: {
        toolCallId: randomUUID(),
        toolName: "persist_artifact",
        arguments: { path: "/workspace/outputs/schedule.docx" },
        requiresApproval: false,
        approvalKind: "file-edit",
        repeatPolicy: "block_after_success",
      },
      ...(state === "completed" ? { output: { text: "Persisted artifact: schedule.docx", sha256: "a".repeat(64) } } : {}),
    });
    const republish = async (between: DurableTurnStep[]) => {
      const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), publish("completed", 1), ...between, publish("pending", 9)]));
      let executions = 0;
      const runner = new DurableTurnRunner(repository, unusedModel(), {
        execute: async () => {
          executions += 1;
          return { output: { text: "Persisted artifact: schedule.docx", sha256: "b".repeat(64) }, summary: "Persisted schedule.docx" };
        },
      });
      await runner.execute({ tenantId, runId, reason: "continue" });
      return { repository, executions };
    };

    it("publishes again after a command rebuilt the file", async () => {
      const rebuild = { ...runCommandStep("completed", 3, "python build_schedule.py --output /workspace/outputs/schedule.docx"), output: { exitCode: 0 } };
      const { repository, executions } = await republish([rebuild]);
      expect(executions).toBe(1);
      expect(repository.current.steps.find((step) => step.sequence === 9)?.state).toBe("completed");
    });

    it("still suppresses a repeat with no change in between, and says nothing new was published", async () => {
      const unrelated = { ...runCommandStep("completed", 3, "ls /workspace/tmp"), output: { exitCode: 0 } };
      const { repository, executions } = await republish([unrelated]);
      expect(executions).toBe(0);
      const suppressed = repository.current.steps.find((step) => step.sequence === 9);
      expect(suppressed?.error).toBe("duplicate_tool_call_suppressed");
      expect(JSON.stringify(repository.mutations)).toContain("no new version was created");
    });
  });

  it("finishes the remaining sequential tools before giving the model a correction turn", async () => {
    const first = { ...runCommandStep("completed", 1, "printf same"), output: { command: "printf same", output: "" } as const };
    const second = { ...runCommandStep("completed", 2, "printf same"), output: { command: "printf same", output: "" } as const };
    const duplicate = runCommandStep("pending", 3, "printf same");
    const nextWrite = { ...toolStep("pending", "idempotent", false), sequence: 4 };
    const repository = new FakeTurnRepository(snapshot("executing_tool", [
      admittedStep(),
      first,
      second,
      duplicate,
      nextWrite,
    ]));
    const executions: string[] = [];
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async (_snapshot, step) => {
        executions.push(toolNameFromTestStep(step));
        return { output: { acknowledged: true }, summary: "completed" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "executing_tool" });
    expect(executions).toEqual([]);
    expect(repository.current.steps.find((step) => step.id === duplicate.id))
      .toMatchObject({ state: "failed", error: "duplicate_tool_call_suppressed" });
    expect(repository.current.steps.find((step) => step.id === nextWrite.id))
      .toMatchObject({ state: "pending" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toEqual(["write"]);
  });

  it("normalizes Bash formatting and aliases in the repeat signature", async () => {
    const first = { ...runCommandStep("completed", 1, "printf same"), output: { command: "printf same", output: "" } as const };
    const second = {
      ...runCommandStep("completed", 2, "ignored"),
      input: {
        ...runCommandStep("completed", 2, "ignored").input,
        arguments: { cmd: "  printf same  " },
      },
      output: { command: "printf same", output: "" } as const,
    };
    const pending = runCommandStep("pending", 3, "printf same");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second, pending]));
    let executions = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: { command: "printf same", output: "" }, summary: "completed" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(0);
    expect(repository.current.steps.find((step) => step.id === pending.id))
      .toMatchObject({ state: "failed", error: "duplicate_tool_call_suppressed" });
  });

  it("allows the same semantic call again when its result changes", async () => {
    const first = runCommandStep("pending", 1, "printf state");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first]));
    let executions = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return {
          output: { command: "printf state", exitCode: 0, output: executions === 1 ? "old" : "new" },
          summary: "Command completed",
        };
      },
    });

    await runner.execute({ tenantId, runId, reason: "continue" });
    const second = runCommandStep("pending", 3, "printf state");
    queueToolForExecution(repository, second);
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(2);
    expect(repository.current.steps.find((step) => step.id === second.id))
      .toMatchObject({ state: "completed", resultFingerprint: expect.any(String) });
  });

  it("allows pagination when semantic offsets change even if page content overlaps", async () => {
    const pageStep = (sequence: number, offset: number): DurableTurnStep => {
      const step = readOnlyToolStep("read", sequence, "/workspace/items.txt");
      return {
        ...step,
        input: {
          ...step.input,
          arguments: { path: "/workspace/items.txt", offset, limit: 50 },
        },
      };
    };
    const repository = new FakeTurnRepository(snapshot("executing_tool", [
      admittedStep(),
      pageStep(1, 1),
    ]));
    let executions = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: { content: "overlapping page" }, summary: "Read page" };
      },
    });

    await runner.execute({ tenantId, runId, reason: "continue" });
    const second = pageStep(3, 51);
    queueToolForExecution(repository, second);
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(2);
  });

  it("suppresses a repeated successful mutation before its second execution", async () => {
    const first = toolStep("pending", "idempotent", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first]));
    let executions = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: { acknowledged: true }, summary: "Write completed" };
      },
    });

    await runner.execute({ tenantId, runId, reason: "continue" });
    const second = { ...toolStep("pending", "idempotent", false), sequence: 3 };
    queueToolForExecution(repository, second);
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(1);
    expect(repository.current.steps.find((step) => step.id === second.id))
      .toMatchObject({ state: "failed", error: "duplicate_tool_call_suppressed" });
  });

  it("executes only one copy of duplicate read calls emitted in one parallel batch", async () => {
    const first = readOnlyToolStep("read", 1, "/workspace/items.txt");
    const second = readOnlyToolStep("read", 2, "/workspace/items.txt");
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), first, second]));
    let executions = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        executions += 1;
        return { output: { content: "same file" }, summary: "Read file" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(executions).toBe(1);
    expect(repository.current.steps.find((step) => step.id === first.id))
      .toMatchObject({ state: "completed" });
    expect(repository.current.steps.find((step) => step.id === second.id))
      .toMatchObject({ state: "failed", error: "duplicate_tool_call_suppressed" });
  });

  it("treats distinct successful mutations with generic acknowledgements as progress", async () => {
    const prior = Array.from({ length: 4 }, (_, index) => ({
      ...toolStep("completed", "idempotent", false),
      id: randomUUID(),
      sequence: index + 1,
      input: {
        ...toolStep("completed", "idempotent", false).input,
        arguments: { path: `/workspace/result-${index}.txt`, content: `result ${index}` },
      },
      output: { acknowledged: true } as const,
    }));
    const pending = {
      ...toolStep("pending", "idempotent", false),
      id: randomUUID(),
      sequence: 5,
      input: {
        ...toolStep("pending", "idempotent", false).input,
        arguments: { path: "/workspace/result-4.txt", content: "result 4" },
      },
    };
    const current = snapshot("executing_tool", [admittedStep(), ...prior, pending]);
    current.progress = {
      progressEpoch: 4,
      progressKind: "result_repeated",
      consecutiveNoProgress: 4,
      physicalModelAttempt: 0,
      logicalModelIteration: 0,
      toolRepairAttempts: 0,
      cumulativeToolMs: 0,
      cumulativeActiveComputeMs: 0,
      budgetReason: null,
    };
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => ({ output: { acknowledged: true }, summary: "mutation accepted" }),
    }, { noProgressHardThreshold: 5 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(repository.current.progress).toMatchObject({
      consecutiveNoProgress: 0,
      progressKind: "tool_progress",
      budgetReason: null,
    });
  });

  it("allows the same output when read arguments change", async () => {
    const first = { ...readOnlyToolStep("read", 1, "/workspace/old-a.txt", "completed"), output: { content: "same" } as const };
    const second = { ...readOnlyToolStep("read", 2, "/workspace/old-b.txt", "completed"), output: { content: "same" } as const };
    const pending = readOnlyToolStep("read", 3, "/workspace/new.txt");
    const current = snapshot("executing_tool", [admittedStep(), first, second, pending]);
    current.progress = {
      progressEpoch: 4,
      progressKind: "result_repeated",
      consecutiveNoProgress: 4,
      physicalModelAttempt: 0,
      logicalModelIteration: 0,
      toolRepairAttempts: 0,
      cumulativeToolMs: 0,
      cumulativeActiveComputeMs: 0,
      budgetReason: null,
    };
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => ({ output: { content: "same" }, summary: "same result" }),
    }, { noProgressHardThreshold: 5 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(repository.current.progress).toMatchObject({
      consecutiveNoProgress: 0,
      progressKind: "tool_progress",
    });
  });

  it("labels same-signature alternating results as no progress and bounds polling", async () => {
    const readA = { ...readOnlyToolStep("read", 1, "/workspace/poll.txt", "completed"), output: { content: "a" } as const };
    const readB = { ...readOnlyToolStep("read", 2, "/workspace/poll.txt", "completed"), output: { content: "b" } as const };
    const alternatingPending = readOnlyToolStep("read", 3, "/workspace/poll.txt");
    const alternatingCurrent = snapshot("executing_tool", [admittedStep(), readA, readB, alternatingPending]);
    alternatingCurrent.progress = {
      progressEpoch: 4,
      progressKind: "result_repeated",
      consecutiveNoProgress: 4,
      physicalModelAttempt: 0,
      logicalModelIteration: 0,
      toolRepairAttempts: 0,
      cumulativeToolMs: 0,
      cumulativeActiveComputeMs: 0,
      budgetReason: null,
    };
    const alternatingRepository = new FakeTurnRepository(alternatingCurrent);
    const alternatingRunner = new DurableTurnRunner(alternatingRepository, unusedModel(), {
      execute: async () => ({ output: { content: "a" }, summary: "alternating result" }),
    }, { noProgressHardThreshold: 5 });

    await expect(alternatingRunner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(alternatingRepository.events).toContainEqual(expect.objectContaining({
      kind: "turn.progress",
      progressKind: "alternating_no_progress",
    }));

    const pollingPending = {
      ...readOnlyToolStep("read", 3, "/workspace/poll.txt"),
      input: {
        ...readOnlyToolStep("read", 3, "/workspace/poll.txt").input,
        repeatPolicy: "bounded_polling",
        arguments: { path: "/workspace/poll.txt" },
      },
    };
    const pollingCurrent = snapshot("executing_tool", [admittedStep(), readA, readB, pollingPending]);
    pollingCurrent.progress = { ...alternatingCurrent.progress, consecutiveNoProgress: 4 };
    const pollingRepository = new FakeTurnRepository(pollingCurrent);
    const pollingRunner = new DurableTurnRunner(pollingRepository, unusedModel(), {
      execute: async () => ({ output: { content: "a" }, summary: "poll result" }),
    }, { noProgressHardThreshold: 5 });

    await expect(pollingRunner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(pollingRepository.current.progress).toMatchObject({
      consecutiveNoProgress: 5,
      progressKind: "declared_polling",
      budgetReason: "no_progress_budget",
    });
  });

  it("advertises compose_message as a no-approval presentation tool", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    let composePolicy: unknown;
    let imagePolicy: unknown;
    let writePolicy: unknown;
    let editPolicy: unknown;
    let bashPolicy: unknown;
    let toolNames: string[] = [];
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        toolNames = context.tools.map((tool) => tool.function.name);
        composePolicy = context.policyForTool("compose_message");
        imagePolicy = context.policyForTool("create_image");
        writePolicy = context.policyForTool("write");
        editPolicy = context.policyForTool("edit");
        bashPolicy = context.policyForTool("bash");
        return { text: "Done.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-compose-definition" });

    await runner.execute({ tenantId, runId, reason: "continue" });

    expect(toolNames).toEqual(DURABLE_BASE_BUILT_IN_TOOLS);
    expect(composePolicy).toEqual({
      retryClass: "read_only",
      repeatPolicy: "block_after_success",
      requiresApproval: false,
      approvalKind: "file-edit",
    });
    expect(imagePolicy).toEqual({
      retryClass: "non_idempotent_manual",
      repeatPolicy: "block_after_success",
      requiresApproval: false,
      approvalKind: "file-edit",
    });
    expect(writePolicy).toEqual({
      retryClass: "idempotent",
      repeatPolicy: "block_after_success",
      requiresApproval: true,
      approvalKind: "file-edit",
    });
    expect(editPolicy).toEqual({
      retryClass: "non_idempotent_manual",
      repeatPolicy: "block_after_success",
      requiresApproval: true,
      approvalKind: "file-edit",
    });
    expect(bashPolicy).toEqual({
      retryClass: "non_idempotent_manual",
      repeatPolicy: "compare_result",
      requiresApproval: true,
      approvalKind: "shell",
    });
  });

  it("reconstructs create_image from the persisted explicit image admission", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = {
      capabilityVersion: 1,
      input: "Create image\nA red berry icon",
      intent: "image_generation",
      providerId: "router",
      provider: { id: "router", name: "Berry Router", kind: "berry-router", baseUrl: "https://router.example.test/v1", defaultModel: "chat-model" },
      model: "chat-model",
      conversationKind: "chat",
      workspacePath: "/workspace",
      workspaceId: current.workspaceId,
      permissionMode: "ask",
      reasoning: "medium",
      maxTokens: 8_000,
      contextWindowTokens: 128_000,
      modelPricing: {},
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "create_image"],
      imageGeneration: { providerId: "router", model: "openai/gpt-image-2", costMicros: "10" },
      mcpServers: [],
      extraSkills: [],
      attachments: [],
    };
    const repository = new FakeTurnRepository(current);
    let toolNames: string[] = [];
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        toolNames = context.tools.map((tool) => tool.function.name);
        return { text: "Done.", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-image-definition" });

    await runner.execute({ tenantId, runId, reason: "continue" });

    expect(toolNames).toContain("create_image");
  });

  it("rejects duplicate provider tool-call ids before executing either tool", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
    let toolCalls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => ({
        text: "",
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [
          { id: "duplicate-call", name: "read", input: { path: "a" }, retryClass: "read_only", idempotencyKey: null, requiresApproval: false, approvalKind: "file-edit" },
          { id: "duplicate-call", name: "read", input: { path: "b" }, retryClass: "read_only", idempotencyKey: null, requiresApproval: false, approvalKind: "file-edit" },
        ],
      }),
    }, {
      execute: async () => {
        toolCalls += 1;
        return { output: {}, summary: "" };
      },
    }, { owner: "worker-duplicate-tool-id" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" })).resolves.toMatchObject({ state: "failed" });
    expect(toolCalls).toBe(0);
    expect(repository.current.error).toContain("duplicate tool-call id");
    expect(repository.current.steps.some((step) => step.type.startsWith("tool."))).toBe(false);
  });

  describe("malformed question batches (H-057)", () => {
    const askStep = (argumentsValue: Record<string, unknown>) => ({
      ...toolStep("pending", "read_only", false),
      type: "tool.ask_user_question",
      input: {
        toolCallId: "question_call_h057",
        toolName: "ask_user_question",
        arguments: argumentsValue,
        requiresApproval: false,
        approvalKind: "file-edit",
      },
    }) satisfies DurableTurnStep;
    const run = async (argumentsValue: Record<string, unknown>) => {
      const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), askStep(argumentsValue)]));
      const runner = new DurableTurnRunner(repository, unusedModel(), noTools(), { owner: "worker-question-h057" });
      const result = await runner.execute({ tenantId, runId, reason: "continue" });
      return { repository, result };
    };

    it("returns a repair error instead of a reduced question for task 1105's label-only batch", async () => {
      const { repository, result } = await run({
        question: "Tell me about the event",
        questions: [
          { label: "Which slide format?", options: [{ label: "Single slide" }, { label: "Poster" }] },
          { label: "Which style?", options: [{ label: "Spooky" }, { label: "Playful" }] },
          { label: "Which event details?", options: [{ label: "Costume competition" }] },
        ],
      });
      expect(result.state).not.toBe("waiting");
      expect(repository.events.some((event) => event.kind === "question.request")).toBe(false);
      const failed = repository.current.steps.find((step) => step.type === "tool.ask_user_question");
      expect(failed?.state).toBe("failed");
      expect(failed?.error).toContain('questions[0] needs a non-empty "question" string (received: label, options)');
    });

    it("rejects a batch with one invalid entry rather than dropping it", async () => {
      const { repository } = await run({
        questions: [
          { question: "Which tone?", options: [{ label: "Formal" }, { description: "missing label" }] },
          { question: "When?" },
        ],
      });
      expect(repository.events.some((event) => event.kind === "question.request")).toBe(false);
      expect(repository.current.steps.find((step) => step.type === "tool.ask_user_question")?.error)
        .toContain('questions[0].options[1] needs a non-empty "label" string');
    });

    it("still accepts a legacy single question with options", async () => {
      const { repository, result } = await run({ question: "Which tone?", options: [{ label: "Formal" }, { label: "Warm" }] });
      expect(result.state).toBe("waiting");
      expect(repository.events).toContainEqual(expect.objectContaining({
        kind: "question.request",
        question: "Which tone?",
        options: [{ label: "Formal" }, { label: "Warm" }],
      }));
    });
  });

  it("persists requested question batches and emits the popup event before waiting", async () => {
    const questionStep = {
      ...toolStep("pending", "read_only", false),
      type: "tool.ask_user_question",
      input: {
        toolCallId: "question_call_1",
        toolName: "ask_user_question",
        arguments: {
          questions: [
            {
              question: "Which tone should I use?",
              options: [
                { label: "Formal", description: "Use a formal business tone." },
                { label: "Warm", description: "Use a warmer personal tone." },
              ],
            },
            {
              question: "When should it take effect?",
              options: [],
            },
          ],
        },
        requiresApproval: false,
        approvalKind: "file-edit",
      },
    } satisfies DurableTurnStep;
    const supersededStep = {
      ...toolStep("pending", "read_only", false),
      type: "tool.read",
      input: {
        toolCallId: "read_call_superseded",
        toolName: "read",
        arguments: { path: "notes.txt" },
        requiresApproval: false,
        approvalKind: "file-edit",
      },
    } satisfies DurableTurnStep;
    const repository = new FakeTurnRepository(snapshot("executing_tool", [
      admittedStep(),
      questionStep,
      supersededStep,
    ]));
    const runner = new DurableTurnRunner(repository, unusedModel(), noTools(), {
      owner: "worker-question",
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "waiting" });

    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "question.request",
      toolCallId: "question_call_1",
      question: "Which tone should I use?",
      questions: [
        expect.objectContaining({ question: "Which tone should I use?" }),
        expect.objectContaining({ question: "When should it take effect?" }),
      ],
    }));
    expect(repository.current.state).toBe("waiting");
    expect(repository.mutations.at(-1)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: supersededStep.id, state: "cancelled", error: "superseded_by_question" }),
    ]));
    expect(repository.outbox).toContainEqual(expect.objectContaining({
      eventType: "sandbox.snapshot",
    }));
  });

  it("executes compose_message inside the durable runner and persists its editable draft", async () => {
    const draftStep = {
      ...toolStep("pending", "read_only", false),
      type: "tool.compose_message",
      input: {
        toolCallId: "compose_call_1",
        toolName: "compose_message",
        arguments: {
          id: "daily-brief",
          kind: "email",
          summaryTitle: "Daily brief",
          variants: [{
            label: "Professional",
            subject: "Daily brief",
            body: "Hello team,\n\nHere is today's brief.",
            active: true,
          }],
        },
        requiresApproval: false,
        approvalKind: "file-edit",
      },
    } satisfies DurableTurnStep;
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), draftStep]));
    let externalToolCalls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        externalToolCalls += 1;
        throw new Error("compose_message must not reach the sandbox executor");
      },
    }, { owner: "worker-compose-execution" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });

    expect(externalToolCalls).toBe(0);
    expect(repository.mutations.find((mutation) => mutation.toolResultMessage)?.toolResultMessage)
      .toMatchObject({
        name: "compose_message",
        status: "completed",
        output: {
          draft: {
            id: "daily-brief",
            kind: "email",
            variants: [{
              label: "Professional",
              subject: "Daily brief",
              body: "Hello team,\n\nHere is today's brief.",
            }],
          },
        },
      });
  });

  it("settles a denied tool and continues the remaining tool calls", async () => {
    const denied = toolStep("pending", "idempotent", true);
    const remaining = { ...toolStep("pending", "read_only", false), id: randomUUID(), sequence: 2 };
    const current = snapshot("executing_tool", [admittedStep(), denied, remaining]);
    current.approvals.push({
      id: randomUUID(),
      stepId: denied.id,
      status: "denied",
      decision: { decision: "denied" },
    });
    const repository = new FakeTurnRepository(current);
    let calls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        calls += 1;
        return { output: { content: "safe" }, summary: "Read completed" };
      },
    }, { owner: "worker-denied-tool" });

    expect((await runner.execute({ tenantId, runId, reason: "approval-resolved" })).state)
      .toBe("executing_tool");
    expect(repository.current.steps.find((step) => step.id === denied.id)?.state).toBe("failed");
    const deniedMutation = repository.mutations.find((mutation) => mutation.toolResultMessage);
    expect(deniedMutation?.toolResultMessage?.id).toBe(deniedMutation?.entries?.[0]?.entryId);

    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state)
      .toBe("calling_model");
    expect(calls).toBe(1);
  });

  it("surfaces a lost long-operation heartbeat as a retryable failure", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
    repository.heartbeat = async () => false;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { text: "late", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools(), { owner: "worker-heartbeat", heartbeatMs: 1, leaseSeconds: 1 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toBeInstanceOf(DurableTurnRetryableError);
  });

  it("does not release a lease while a non-abort-aware tool is still settling", async () => {
    const current = snapshot("executing_tool", [admittedStep(), toolStep("pending", "read_only", false)]);
    const repository = new FakeTurnRepository(current);
    const order: string[] = [];
    let heartbeatObserved!: () => void;
    const heartbeat = new Promise<void>((resolve) => { heartbeatObserved = resolve; });
    repository.heartbeat = async () => {
      heartbeatObserved();
      return false;
    };
    repository.release = async () => {
      order.push("lease-released");
      repository.current.leaseOwner = "";
    };
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        await heartbeat;
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("tool-settled");
        return { output: { ok: true }, summary: "Done" };
      },
    }, {
      owner: "worker-side-effect-heartbeat",
      heartbeatMs: 1,
      leaseSeconds: 1,
      abortCleanupTimeoutMs: 1,
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .rejects.toBeInstanceOf(DurableTurnRetryableError);
    expect(order).toEqual(["tool-settled", "lease-released"]);
  });

  it("continues beyond the former model-iteration limit", async () => {
    const current = snapshot("calling_model", [
      admittedStep(),
      { ...modelStep("completed", 1), input: { iteration: 1 } },
      { ...modelStep("pending", 2), input: { iteration: 2 } },
    ]);
    const repository = new FakeTurnRepository(current);
    let calls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        calls += 1;
        return { text: "unexpected", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools());

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "finalizing" });
    expect(calls).toBe(1);
  });

  it("continues tool work regardless of cumulative tokens spent in the turn", async () => {
    const current = snapshot("executing_tool", [admittedStep(), toolStep("pending", "read_only", false)]);
    current.usageTotals = {
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
      costMicros: "20",
    };
    const repository = new FakeTurnRepository(current);
    let calls = 0;
    const runner = new DurableTurnRunner(repository, unusedModel(), {
      execute: async () => {
        calls += 1;
        return { output: {}, summary: "" };
      },
    });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });
    expect(calls).toBe(1);
  });

  it("stops at the user spend limit before starting another model call", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = {
      ...current.runtimeRequest,
      requestId: "turn_budget_guard",
      maxTokens: 100,
      modelPricing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
    };
    const repository = new FakeTurnRepository(current);
    repository.budgetDecision = { allowed: false, reason: "user spend limit has been reached." };
    let calls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        calls += 1;
        return { text: "unexpected", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools());

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "completed" });
    expect(calls).toBe(0);
    expect(safeBigIntForTest(repository.lastBudgetEstimate)).toBeGreaterThan(0n);
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "session.note",
      note: "limit-reached",
    }));
  });

  it("fails an inactive budget reservation honestly instead of completing with allowance advice", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = { ...current.runtimeRequest, requestId: "turn_settled", budgetReservationRequired: true };
    const repository = new FakeTurnRepository(current);
    repository.budgetDecision = {
      allowed: false,
      reason: "The budget reservation for this turn is no longer active.",
      code: "reservation_inactive",
    };
    let calls = 0;
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        calls += 1;
        return { text: "unexpected", inputTokens: 1, outputTokens: 1, toolCalls: [] };
      },
    }, noTools());

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "failed" });
    expect(calls).toBe(0);
    expect(repository.current.error).toContain("no longer active");
    expect(repository.current.error).not.toContain("Increase the applicable allowance");
  });

  it("delivers read image pixels after tool results without rewriting the original user message", async () => {
    let request: ChatCompletionOptions | undefined;
    const model = new RouterDurableTurnModel({
      stream: async function* (options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
        request = options;
        yield { id: "vision-response", model: "vision-model", delta: "Layout checked.", finishReason: "stop", raw: {} };
      },
    }, "vision-model", {
      provider: "router", route: "/chat/completions",
      capabilityForModel: () => ({ supported: false, cacheKey: false, cacheControl: false, retention: [], minimumTokens: 1024 }),
    });
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.entries.push({
      entryId: "read-pages", parentEntryId: current.entries[0]!.entryId, entryType: "message", sequence: 2,
      payload: { type: "message", message: { role: "toolResult", toolCallId: "read-page", toolName: "read", content: [{ type: "text", text: "Identified page-1.png as a binary image/png file" }] } },
    });
    const original = modelMessages(current).messages.find((message) => message.role === "user")!.content;
    const pixels = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AQID" } };
    await model.call(current, modelStep("pending", 1), {
      messageId: randomUUID(), tools: [],
      additionalUserContent: [{ type: "text", text: 'Workspace image 1: "/workspace/rendered/page-1.png"' }, pixels],
      emitDelta: async () => {},
      policyForTool: () => ({ retryClass: "read_only", repeatPolicy: "compare_result", requiresApproval: false, approvalKind: "file-edit" }),
    });
    expect(request!.messages.find((message) => message.role === "user")!.content).toEqual(original);
    expect(request!.messages.at(-2)).toMatchObject({ role: "tool", toolCallId: "read-page" });
    expect(request!.messages.at(-1)).toMatchObject({ role: "user", content: expect.arrayContaining([pixels]) });
    expect(JSON.stringify(request!.messages.at(-1)!.content)).toContain("page-1.png");
    expect(JSON.stringify(current.entries)).not.toContain("base64");
  });

  it("records the router-attributed serving backend on the usage event", async () => {
    const model = new RouterDurableTurnModel({
      stream: async function* (): AsyncGenerator<ChatCompletionChunk> {
        yield {
          id: "served", model: "deepseek-v4-flash", delta: "ok", finishReason: "stop", raw: {},
          attribution: { requestedModel: "deepseek-v4-flash", servedProvider: "canopywave", servedModel: "deepseek/deepseek-v4-flash" },
          usage: { inputTokens: 100, outputTokens: 2, totalTokens: 102, cacheReadTokens: 64, cacheReadReported: true },
        };
      },
    }, "deepseek-v4-flash", {
      provider: "router", route: "/chat/completions",
      capabilityForModel: () => ({ supported: false, cacheKey: false, cacheControl: false, retention: [], minimumTokens: 1024 }),
    });
    const result = await model.call(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]), modelStep("pending", 1), {
      messageId: randomUUID(), tools: [], emitDelta: async () => {},
      policyForTool: () => ({ retryClass: "read_only", repeatPolicy: "compare_result", requiresApproval: false, approvalKind: "file-edit" }),
    });

    expect(result.usage).toMatchObject({ servedProvider: "canopywave", servedModel: "deepseek/deepseek-v4-flash", cacheReadTokens: 64, cacheEligible: false });
  });

  it("appends text-only tool context without changing the original user prefix", () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.entries.push({ entryId: "image-read", parentEntryId: current.entries[0]!.entryId, entryType: "message", sequence: 2,
      payload: { message: { role: "toolResult", toolCallId: "read-image", toolName: "read", content: [{ type: "text", text: "Image available" }] } } });
    const original = modelMessages(current).messages;
    const supplemental = [{ type: "text" as const, text: "Two images available through inspect_images" }];
    const changed = modelMessages(current, supplemental).messages;
    expect(changed.slice(0, original.length)).toEqual(original);
    expect(changed.at(-1)).toMatchObject({ role: "user", content: expect.arrayContaining(supplemental) });
  });

  it("keeps tool calls separate when a gateway restarts the index for each event (H-038)", async () => {
    const events: ChatCompletionChunk[] = [
      // Task fe764378: activate_skill and read arrived as "activate_skillread".
      { id: "gemini-1", model: "gemini", delta: "", finishReason: null, raw: {},
        toolCalls: [{ index: 0, id: "call_a", function: { name: "activate_skill", arguments: "{\"name\":\"docx\"}" } }] },
      { id: "gemini-1", model: "gemini", delta: "", finishReason: null, raw: {},
        toolCalls: [{ index: 0, id: "call_b", function: { name: "read", arguments: "{\"path\":\"/workspace/inputs/brief.docx\"}" } }] },
      // A provider that repeats the same id on every fragment of one call.
      { id: "gemini-1", model: "gemini", delta: "", finishReason: null, raw: {},
        toolCalls: [{ index: 0, id: "call_c", function: { name: "ls", arguments: "{\"pa" } }] },
      { id: "gemini-1", model: "gemini", delta: "", finishReason: "tool_calls", raw: {},
        toolCalls: [{ index: 0, id: "call_c", function: { arguments: "th\":\"/workspace\"}" } }] },
    ];
    const client = {
      stream: async function* (): AsyncGenerator<ChatCompletionChunk> { yield* events; },
    } as unknown as OpenAIChatCompletionsClient;
    const model = new RouterDurableTurnModel(client, "gemini", {
      provider: "router",
      route: "/chat/completions",
      capabilityForModel: () => ({ supported: false, cacheKey: false, cacheControl: false, retention: [], minimumTokens: 1_024 }),
    });
    const result = await model.call(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]), modelStep("pending", 1), {
      messageId: randomUUID(),
      tools: ["activate_skill", "read", "ls"].map((name) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object" } } })),
      emitDelta: async () => undefined,
      policyForTool: () => ({ retryClass: "read_only", repeatPolicy: "compare_result", requiresApproval: false, approvalKind: "file-edit" }),
    });
    expect(result.toolCalls.map((call) => [call.providerCallId, call.name, call.input])).toEqual([
      ["call_a", "activate_skill", { name: "docx" }],
      ["call_b", "read", { path: "/workspace/inputs/brief.docx" }],
      ["call_c", "ls", { path: "/workspace" }],
    ]);
  });

  it("explains a 402 as an account credit problem rather than a model setting (H-005)", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]));
    const runner = new DurableTurnRunner(repository, {
      call: async () => { throw new RouterClientError("Payment Required", 402, "PAYMENT_REQUIRED", { code: "payment_required" }); },
    }, noTools(), { owner: "worker-credit" });
    await runner.execute({ tenantId, runId, reason: "continue" });
    const text = JSON.stringify([repository.current.error, repository.events, repository.mutations]);
    expect(text).toContain("credit or quota is exhausted (HTTP 402)");
    expect(text).toContain("choosing another model from the same provider will not help");
  });

  it("uses the router streaming transport and assembles streamed tool calls", async () => {
    let request: ChatCompletionOptions | undefined;
    const client = {
      stream: async function* (options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
        request = options;
        const wrappedArguments = JSON.stringify({ raw: JSON.stringify({ query: "AI news" }) });
        yield {
          id: "completion-1",
          model: "kimi-2.6",
          requestId: "router-request-success",
          delta: "Searching",
          reasoningDelta: "Need current sources.",
          finishReason: null,
          raw: {},
        };
        yield {
          id: "completion-1",
          model: "kimi-2.6",
          delta: "",
          toolCalls: [{
            index: 0,
            id: "call_1",
            function: { name: "mcp__BerryCrawl__search", arguments: wrappedArguments.slice(0, 12) },
            extraContent: { google: { thought_signature: "gemini-signature" } },
          }],
          finishReason: null,
          raw: {},
        };
        yield {
          id: "completion-1",
          model: "kimi-2.6",
          delta: "",
          toolCalls: [{ index: 0, function: { arguments: wrappedArguments.slice(12) } }],
          finishReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          raw: {},
        };
      },
    } as unknown as OpenAIChatCompletionsClient;
    const model = new RouterDurableTurnModel(client, "kimi-2.6", {
      provider: "router",
      route: "/chat/completions",
      capabilityForModel: () => ({
        supported: false,
        cacheKey: false,
        cacheControl: false,
        retention: [],
        minimumTokens: 1_024,
      }),
    });
    const deltas: Array<{ delta: string; channel: "text" | "reasoning" }> = [];
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest = {
      capabilityVersion: 1,
      input: "Create image\nA red berry icon",
      intent: "image_generation",
      providerId: "router",
      provider: { id: "router", name: "Berry Router", kind: "berry-router", baseUrl: "https://router.example.test/v1", defaultModel: "kimi-2.6" },
      model: "kimi-2.6",
      conversationKind: "chat",
      workspacePath: "/home/user/workspace",
      workspaceId: "00000000-0000-7000-8000-000000000004",
      permissionMode: "ask",
      reasoning: "medium",
      maxTokens: 8_000,
      contextWindowTokens: 128_000,
      modelPricing: { input: 1, output: 2 },
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "create_image"],
      imageGeneration: { providerId: "router", model: "openai/gpt-image-2", costMicros: "10" },
      attachments: [],
      mcpServers: [],
      extraSkills: [],
    };
    current.entries[0]!.payload = {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Compare the CVs" },
          {
            type: "attachment",
            content: {
              fileId: "00000000-0000-7000-8000-000000000099",
              name: "candidate.pdf",
              mediaType: "application/pdf",
              size: 2048,
            },
          },
        ],
      },
    };
    const result = await model.call(
      current,
      modelStep("pending", 1),
      {
        messageId: randomUUID(),
        tools: [{
          type: "function",
          function: {
            name: "mcp__BerryCrawl__search",
            description: "Search the web",
            parameters: { type: "object" },
          },
        }, {
          type: "function",
          function: {
            name: "create_image",
            description: "Create an image",
            parameters: { type: "object" },
          },
        }],
        additionalUserContent: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID" },
        }],
        emitDelta: async (delta, channel) => { deltas.push({ delta, channel }); },
        policyForTool: () => ({
          retryClass: "read_only",
          repeatPolicy: "compare_result",
          requiresApproval: false,
          approvalKind: "mcp",
        }),
      },
    );

    expect(request?.tools?.map((tool) => tool.function.name)).toEqual(["create_image", "mcp__BerryCrawl__search"]);
    expect(request?.messages[0]?.content).toContain("The user explicitly selected Create image. Call create_image");
    expect(request?.messages[0]?.content).toContain(DURABLE_IMAGE_TOOL_SELECTION_PROMPT);
    expect(request?.messages[0]?.content).toContain(
      "call compose_message so it renders as an editable writing block",
    );
    expect(request?.messages[0]?.content).toContain(
      "call ask_user_question so the frontend renders the interactive question UI",
    );
    expect(request?.messages[0]?.content).toContain(
      "Path rule: use /home/user/workspace exactly",
    );
    expect(request?.messages[0]?.content).toContain(
      "Never JSON-stringify the entire argument object inside raw",
    );
    const userContent = request?.messages.find((message) => message.role === "user")?.content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(JSON.stringify(userContent)).toContain(
      "Sandbox path: /home/user/workspace/inputs/00000000-0000-7000-8000-000000000099/candidate.pdf",
    );
    expect(JSON.stringify(userContent)).toContain("page-numbered text");
    expect(userContent).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
    });
    expect(deltas.filter((item) => item.channel === "text").map((item) => item.delta).join("")).toBe("Searching");
    expect(deltas.filter((item) => item.channel === "reasoning").map((item) => item.delta).join("")).toBe("Need current sources.");
    expect(result).toMatchObject({
      text: "Searching",
      reasoning: "Need current sources.",
      finishReason: "tool_calls",
      providerResponseId: "completion-1",
      routerRequestId: "router-request-success",
      inputTokens: 10,
      outputTokens: 4,
      usage: { costRawMicros: "18" },
      toolCalls: [{
        providerCallId: "call_1",
        name: "mcp__BerryCrawl__search",
        input: { query: "AI news" },
        extraContent: { google: { thought_signature: "gemini-signature" } },
        retryClass: "read_only",
        requiresApproval: false,
      }],
    });
  });

  it("persists sanitized provider attempt diagnostics in the model step", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    const runner = new DurableTurnRunner(repository, {
      call: async () => ({
        text: "Done.",
        providerResponseId: "completion-success",
        routerRequestId: "router-request-success",
        inputTokens: 2,
        outputTokens: 1,
        toolCalls: [],
      }),
    }, noTools(), { owner: "worker-success-diagnostics" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "finalizing" });

    expect(repository.current.steps.find((step) => step.type === "model.call")?.output)
      .toMatchObject({
        providerDiagnostics: {
          outcome: "success",
          status: 200,
          statusClass: "2xx",
          category: "success",
          retryDecision: "none",
          physicalAttempt: 2,
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          finishReason: null,
          errorCode: null,
        },
      });
    const stepOutput = repository.current.steps.find((step) => step.type === "model.call")?.output as Record<string, unknown>;
    const diagnostics = stepOutput.providerDiagnostics as Record<string, unknown>;
    expect(diagnostics).not.toHaveProperty("routerRequestId");
    expect(diagnostics).not.toHaveProperty("providerResponseId");
    expect(stepOutput).toMatchObject({ providerResponseId: "completion-success" });
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "provider.attempt",
      logicalStepId: expect.any(String),
      category: "success",
      retryDecision: "none",
    }));
  });

  it("counts reported provider fallback attempts from persisted progress without double-counting", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.progress = {
      progressEpoch: 2,
      progressKind: null,
      consecutiveNoProgress: 0,
      physicalModelAttempt: 4,
      logicalModelIteration: 1,
      toolRepairAttempts: 0,
      cumulativeToolMs: 0,
      cumulativeActiveComputeMs: 900,
      budgetReason: null,
    };
    const repository = new FakeTurnRepository(current);
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const runner = new DurableTurnRunner(repository, {
      call: async (_snapshot, _step, context) => {
        context.onProviderAttempt?.({
          physicalAttempt: 1,
          model: "primary-model",
          status: 503,
          statusClass: "5xx",
          category: "server",
          retryDecision: "retry",
          latencyMs: 40,
        });
        context.onProviderAttemptDecision?.(1, "fallback");
        clock += 125;
        context.onProviderAttempt?.({
          physicalAttempt: 2,
          model: "fallback-model",
          status: 200,
          statusClass: "2xx",
          category: "success",
          retryDecision: "none",
          latencyMs: 85,
        });
        return { text: "Done.", inputTokens: 2, outputTokens: 1, toolCalls: [] };
      },
    }, noTools());

    try {
      await expect(runner.execute({ tenantId, runId, reason: "continue" }))
        .resolves.toMatchObject({ state: "finalizing" });
      expect(repository.current.progress).toMatchObject({
        physicalModelAttempt: 6,
        cumulativeActiveComputeMs: 1_025,
      });
      expect(repository.events.filter((event) => event.kind === "provider.attempt"))
        .toEqual([
          expect.objectContaining({ physicalAttempt: 1, retryDecision: "fallback" }),
          expect.objectContaining({ physicalAttempt: 2, retryDecision: "none" }),
        ]);
    } finally {
      now.mockRestore();
    }
  });

  it("adds failed model-call elapsed time without double-counting its reserved attempt", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.model = "provider/model";
    current.progress = {
      progressEpoch: 3,
      progressKind: null,
      consecutiveNoProgress: 0,
      physicalModelAttempt: 7,
      logicalModelIteration: 1,
      toolRepairAttempts: 0,
      cumulativeToolMs: 0,
      cumulativeActiveComputeMs: 400,
      budgetReason: null,
    };
    const repository = new FakeTurnRepository(current);
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const runner = new DurableTurnRunner(repository, {
      call: async () => {
        clock += 275;
        throw new RouterClientError("raw provider failure", 503, "raw provider body", {
          code: "upstream_unavailable",
          requestId: "raw_request_id",
        });
      },
    }, noTools());

    try {
      await expect(runner.execute({ tenantId, runId, reason: "continue" }))
        .rejects.toBeInstanceOf(DurableTurnRetryableError);
      expect(repository.current.progress).toMatchObject({
        physicalModelAttempt: 8,
        cumulativeActiveComputeMs: 675,
      });
      expect(repository.releasedError).toBe(
        "The model provider returned a server error (HTTP 503). Berry will retry it.",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("persists and replays reasoning plus provider continuation metadata with tool calls", async () => {
    const repository = new FakeTurnRepository(snapshot("calling_model", [
      admittedStep(),
      modelStep("pending", 1),
    ]));
    const toolCallId = randomUUID();
    const providerCallId = "default_api:read";
    const extraContent = { google: { thought_signature: "gemini-signature" } };
    const runner = new DurableTurnRunner(repository, {
      call: async () => ({
        text: "",
        reasoning: "I need the file contents before answering.",
        finishReason: "tool_calls",
        inputTokens: 10,
        outputTokens: 8,
        toolCalls: [{
          id: toolCallId,
          providerCallId,
          name: "read",
          input: { path: "/workspace/input.txt" },
          extraContent,
          retryClass: "read_only",
          idempotencyKey: null,
          requiresApproval: false,
          approvalKind: "file-edit",
        }],
      }),
    }, noTools(), { owner: "worker-reasoning-persist" });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "executing_tool" });
    expect(repository.current.entries.at(-1)?.payload).toMatchObject({
      message: {
        role: "assistant",
        reasoningContent: "I need the file contents before answering.",
      },
    });
    expect(repository.current.steps.find((step) => step.type === "model.call")?.output)
      .toMatchObject({
        providerToolCalls: {
          [toolCallId]: { providerCallId, extraContent },
        },
      });
    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "calling_model" });

    let replayedRequest: ChatCompletionOptions | undefined;
    const replayClient = {
      stream: async function* (options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
        replayedRequest = options;
        yield {
          id: "completion-2",
          model: "deepseek-v4-flash",
          delta: "Done.",
          finishReason: "stop",
          raw: {},
        };
      },
    } as unknown as OpenAIChatCompletionsClient;
    const model = new RouterDurableTurnModel(replayClient, "deepseek-v4-flash", {
      provider: "router",
      route: "/chat/completions",
      capabilityForModel: () => ({
        supported: false,
        cacheKey: false,
        cacheControl: false,
        retention: [],
        minimumTokens: 1_024,
      }),
    });
    repository.current.runtimeRequest = {
      capabilityVersion: 1,
      input: "Do the task",
      providerId: "router",
      provider: {
        id: "router",
        name: "Berry Router",
        kind: "berry-router",
        baseUrl: "https://router.example.test/v1",
        defaultModel: "canopywave/deepseek/deepseek-v4-flash",
        apiType: "openai-chat-completions",
        endpointPath: "/chat/completions",
        authType: "none",
        models: [],
      },
      model: "canopywave/deepseek/deepseek-v4-flash",
      conversationKind: "chat",
      workspacePath: "/workspace",
      workspaceId: repository.current.workspaceId,
      permissionMode: "ask",
      reasoning: "off",
      maxTokens: 8_000,
      contextWindowTokens: 128_000,
      modelAcceptsImages: false,
      modelPricing: {},
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS],
      mcpServers: [],
      extraSkills: [],
      attachments: [],
    };
    await model.call(repository.current, modelStep("pending", 3), {
      messageId: randomUUID(),
      tools: [],
      emitDelta: async () => undefined,
      policyForTool: () => ({
        retryClass: "read_only",
        repeatPolicy: "compare_result",
        requiresApproval: false,
        approvalKind: "file-edit",
      }),
    });
    expect(replayedRequest?.messages.find((message) => message.role === "assistant"))
      .toMatchObject({
        reasoningContent: "I need the file contents before answering.",
        toolCalls: [{ id: providerCallId, extraContent }],
      });
    expect(replayedRequest?.messages.find((message) => message.role === "tool"))
      .toMatchObject({ toolCallId: providerCallId });
    expect(replayedRequest?.messages.find((message) => message.role === "system")?.content)
      .not.toContain("file-tool compatibility guard");
  });

  it("casts persisted tool statuses to the PostgreSQL enum", async () => {
    const statements: string[] = [];
    const tool = toolStep("completed", "read_only", false);
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT state,cancelled_at FROM turn_runs")) {
          return [{ state: "executing_tool", cancelled_at: null }] as T[];
        }
        if (sql.startsWith("INSERT INTO turn_steps")) {
          return [{ id: tool.id }] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql: string) => {
        statements.push(sql);
      },
    };
    const current = snapshot("executing_tool", [admittedStep()]);
    current.leaseOwner = "worker-sql";

    await new SqlDurableTurnRepository(executor).commit(current, {
      expectedState: "executing_tool",
      nextState: "calling_model",
      steps: [tool],
      assistantMessage: {
        id: randomUUID(),
        text: "",
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: randomUUID(), name: "read", input: { path: "/workspace/a.txt" } }],
      },
      toolResultMessage: {
        id: randomUUID(),
        toolCallId: randomUUID(),
        name: "read",
        input: { path: "/workspace/a.txt" },
        status: "completed",
        output: { content: "ok" },
      },
      keepLease: true,
    });

    const update = statements.find((sql) => sql.startsWith("UPDATE tool_calls"));
    expect(update).toContain("SET status=$4::tool_call_status");
    expect(update).toContain("CASE WHEN $4::tool_call_status='running'");
    expect(update).toContain("CASE WHEN $4::tool_call_status IN");
    expect(statements.some((sql) => sql.includes("'tool-call'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'tool-result'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'citation'"))).toBe(false);
  });

  it("separates phase claims from ownership generations", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.startsWith("UPDATE turn_runs")) {
          return [{
            id: runId,
            created_at: new Date().toISOString(),
            tenant_id: tenantId,
            user_id: "00000000-0000-7000-8000-000000000003",
            workspace_id: "00000000-0000-7000-8000-000000000004",
            task_id: "00000000-0000-7000-8000-000000000005",
            session_id: "00000000-0000-7000-8000-000000000006",
            request_message_id: null,
            state: "calling_model",
            attempt: 4,
            ownership_generation: 9,
            phase_claim_count: 12,
            worker_role: "foreground",
            source_revision: "release/2026.08",
            version: 2,
            progress_epoch: 0,
            progress_kind: null,
            consecutive_no_progress: 0,
            physical_model_attempt: 0,
            logical_model_iteration: 0,
            tool_repair_attempts: 0,
            cumulative_tool_ms: 0,
            cumulative_active_compute_ms: 0,
            progress_budget_reason: null,
            cancelled_at: null,
            waiting_started_at: null,
            human_wait_ms: 0,
            runtime_request: {},
            grounding_context: {},
            prompt_manifest: {},
            updated_at: new Date().toISOString(),
            sandbox_provider: null,
            sandbox_id: null,
            sandbox_state: null,
          }] as T[];
        }
        return [] as T[];
      },
      execute: async () => undefined,
    };

    await expect(new SqlDurableTurnRepository(executor, {
      workerRole: "foreground",
      sourceRevision: "release/2026.08",
    }).claim({ tenantId, runId, reason: "continue" }, "worker-owner", 30)).resolves.toMatchObject({
      ownershipGeneration: 9,
      phaseClaimCount: 12,
      workerRole: "foreground",
      sourceRevision: "release/2026.08",
    });

    const claim = queries.find(({ sql }) => sql.startsWith("UPDATE turn_runs"));
    expect(claim?.sql).toContain("attempt = attempt + 1");
    expect(claim?.sql).toContain("ownership_generation = ownership_generation + 1");
    expect(claim?.sql).toContain("phase_claim_count = phase_claim_count + 1");
    expect(claim?.params.slice(4, 6)).toEqual(["foreground", "release/2026.08"]);
  });

  it("updates an existing durable step with contiguous PostgreSQL parameters", async () => {
    const step = modelStep("running", 1);
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT state,cancelled_at FROM turn_runs")) {
          return [{ state: "calling_model", cancelled_at: null }] as T[];
        }
        if (sql.startsWith("INSERT INTO turn_steps")) return [] as T[];
        if (sql.startsWith("SELECT id,sequence,idempotency_key")) {
          return [{ id: step.id, sequence: step.sequence, idempotency_key: step.idempotencyKey }] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql, params = []) => {
        statements.push({ sql, params });
      },
    };
    const current = snapshot("calling_model", [admittedStep(), { ...step, state: "pending" }]);
    current.leaseOwner = "worker-step-update";

    await new SqlDurableTurnRepository(executor).commit(current, {
      expectedState: "calling_model",
      nextState: "calling_model",
      steps: [{
        id: step.id,
        sequence: step.sequence,
        type: step.type,
        state: "running",
        input: step.input,
        retryClass: step.retryClass,
        idempotencyKey: step.idempotencyKey,
        incrementAttempt: true,
      }],
      keepLease: true,
    });

    const update = statements.find(({ sql }) => sql.startsWith("UPDATE turn_steps"));
    expect(update?.sql).toContain("SET state=$4");
    expect(update?.sql).toContain("session_entry_id=COALESCE($11,session_entry_id)");
    expect(update?.sql).toContain("result_fingerprint=COALESCE($12,result_fingerprint)");
    expect(update?.params).toHaveLength(18);
    expect(update?.params[3]).toBe("running");
    expect(update?.params[8]).toBe(true);
  });

  it("guards task and session projections by source sequence even without a new session entry", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT state,cancelled_at FROM turn_runs")) {
          return [{ state: "calling_model", cancelled_at: null }] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql, params = []) => {
        statements.push({ sql, params });
      },
    };
    const current = snapshot("calling_model", [admittedStep()]);
    current.leaseOwner = "worker-projection-order";
    current.version = 10;

    await new SqlDurableTurnRepository(executor).commit(current, {
      expectedState: "calling_model",
      nextState: "calling_model",
      taskStatus: "running",
      projectionSourceSequence: 4,
      keepLease: true,
    });

    const taskProjection = statements.find(({ sql }) => sql.includes("status_source_sequence=$5"));
    expect(taskProjection?.sql).toContain("projection_sequence=GREATEST(projection_sequence,$5::bigint)");
    expect(taskProjection?.sql).toContain("status_source_run_id=$4::uuid");
    expect(taskProjection?.sql).toContain("COALESCE(status_source_sequence,-1)<$5::bigint");
    expect(taskProjection?.params[4]).toBe(4);
    const sessionProjection = statements.find(({ sql }) => sql.includes("projection_source_sequence=$6::bigint"));
    expect(sessionProjection?.sql).toContain("runtime_metadata=runtime_metadata || jsonb_build_object");
    expect(sessionProjection?.sql).toContain("projection_source_run_id=$5::uuid");
    expect(sessionProjection?.sql).toContain("projection_source_state_at=$8::timestamptz");
    expect(sessionProjection?.params[5]).toBe(4);
  });

  it("settles a reopened sandboxless finalization as skipped on the next terminal commit", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT state,cancelled_at FROM turn_runs")) {
          return [{ state: "calling_model", cancelled_at: null }] as T[];
        }
        if (sql.includes("SELECT COALESCE(MAX(sequence),0) AS sequence FROM turn_events")) {
          return [{ sequence: 0 }] as T[];
        }
        if (sql.includes("COUNT(*) FILTER (WHERE event_type='usage') AS usage_event_count")) {
          return [{
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_creation_tokens_1h: 0,
            cache_creation_tokens_5m: 0,
            usage_event_count: 0,
            priced_event_count: 0,
            estimated_pricing_count: 0,
            exact_cost_micros: "0",
          }] as T[];
        }
        if (sql.includes("FROM turn_events") && sql.includes("event_type='usage'")) return [] as T[];
        if (sql.includes("budget_reservations")) return [] as T[];
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
      },
    };
    const current = snapshot("calling_model", [admittedStep()]);
    current.leaseOwner = "worker-sandboxless-recovery";
    current.sandboxId = null;

    await new SqlDurableTurnRepository(executor).commit(current, {
      expectedState: "calling_model",
      nextState: "failed",
      nextAction: null,
      error: "terminal failure",
      taskStatus: "failed",
    });

    const finalization = statements.find(({ sql }) => sql.startsWith("INSERT INTO turn_finalizations"));
    expect(finalization?.sql).toContain("id::text || ':finalization',$3::text");
    expect(finalization?.params).toEqual([current.tenantId, current.id, "failed"]);
    expect(finalization?.sql).toContain("WHEN EXCLUDED.status='skipped' THEN 'skipped'");
    expect(finalization?.sql).toContain("WHEN EXCLUDED.status='skipped' THEN EXCLUDED.completed_at");
    expect(finalization?.sql).toContain("manifest=CASE WHEN EXCLUDED.status='skipped' THEN NULL");
    expect(finalization?.sql).toContain("item_count=CASE WHEN EXCLUDED.status='skipped' THEN 0");
    const closeSteps = statements.find(({ sql }) => sql.startsWith("UPDATE turn_steps"));
    const closeToolCalls = statements.find(({ sql }) => sql.startsWith("UPDATE tool_calls"));
    expect(closeSteps?.sql).toContain("$3::text='recovery_required'");
    expect(closeSteps?.sql).toContain("ELSE $4::text");
    expect(closeToolCalls?.sql).toContain("$3::text='recovery_required'");
  });

  it("treats a duplicate step idempotency key as a replay instead of failing the turn", async () => {
    const persistedId = randomUUID();
    const replayId = randomUUID();
    const idempotencyKey = `${runId}:model:95`;
    const queries: string[] = [];
    const statements: string[] = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT state,cancelled_at FROM turn_runs")) {
          return [{ state: "executing_tool", cancelled_at: null }] as T[];
        }
        if (sql.startsWith("INSERT INTO turn_steps")) return [];
        if (sql.startsWith("SELECT id,sequence,idempotency_key")) {
          return [{ id: persistedId, sequence: 210, idempotency_key: idempotencyKey }] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql: string) => {
        statements.push(sql);
      },
    };
    const current = snapshot("executing_tool", [admittedStep()]);
    current.leaseOwner = "worker-replay";

    await new SqlDurableTurnRepository(executor).commit(current, {
      expectedState: "executing_tool",
      nextState: "calling_model",
      steps: [{
        id: replayId,
        sequence: 210,
        type: "model.call",
        state: "pending",
        input: { iteration: 95 },
        retryClass: "idempotent_with_key",
        idempotencyKey,
      }],
      keepLease: true,
    });

    expect(queries.find((sql) => sql.startsWith("INSERT INTO turn_steps")))
      .toContain("ON CONFLICT DO NOTHING");
    expect(statements.some((sql) => sql.startsWith("UPDATE turn_steps"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("UPDATE turn_runs"))).toBe(true);
  });

  it("prices the complete serialized model request before extending the reservation", async () => {
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.modelPricing = { input: 1, output: 0 };
    current.runtimeRequest.maxTokens = 1;
    current.groundingContext = { document: "x".repeat(40_000) };
    const repository = new FakeTurnRepository(current);
    const runner = new DurableTurnRunner(repository, {
      call: async () => ({ text: "done", inputTokens: 1, outputTokens: 1, toolCalls: [] }),
    }, noTools(), { owner: "worker-complete-budget-estimate" });

    await runner.execute({ tenantId, runId, reason: "continue" });

    expect(BigInt(repository.lastBudgetEstimate)).toBeGreaterThan(9_000n);
  });

  it("serializes reservation extensions with API admission at the tenant level", async () => {
    const advisoryLocks: unknown[][] = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string, params = []) => {
        if (sql.includes("FROM budget_reservations")) {
          return [{
            id: randomUUID(),
            user_id: "00000000-0000-7000-8000-000000000003",
            department_id: null,
            reserved_micros: "0",
            status: "reserved",
          }] as T[];
        }
        if (sql.includes("pg_advisory_xact_lock")) {
          advisoryLocks.push([...params]);
          return [] as T[];
        }
        if (sql.includes("allowance_cycle_settings")) return [] as T[];
        if (sql.includes("FROM budget_limits")) return [] as T[];
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async () => undefined,
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.requestId = "model_operation";

    await expect(new SqlDurableTurnRepository(executor).reserveNextModelCall(current, "100"))
      .resolves.toEqual({ allowed: true, reason: null });

    expect(advisoryLocks).toEqual([[`berry-budget:${tenantId}`]]);
  });

  it("fails closed when a durable run references a settled budget reservation", async () => {
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("FROM budget_reservations")) {
          return [{
            id: randomUUID(),
            user_id: "00000000-0000-7000-8000-000000000003",
            department_id: null,
            reserved_micros: "100",
            status: "reconciled",
          }] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async () => undefined,
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.runtimeRequest.requestId = "model_settled_operation";
    current.runtimeRequest.budgetReservationRequired = true;

    await expect(new SqlDurableTurnRepository(executor).reserveNextModelCall(current, "100"))
      .resolves.toEqual({
        allowed: false,
        reason: "The budget reservation for this turn is no longer active.",
        code: "reservation_inactive",
      });
  });

  it("extends a recovery generation's reservation without re-reserving settled usage", async () => {
    const updates: Array<readonly unknown[]> = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("FROM budget_reservations")) {
          return [{ id: randomUUID(), user_id: null, department_id: null, reserved_micros: "0", status: "reserved" }] as T[];
        }
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("allowance_cycle_settings") || sql.includes("FROM budget_limits")) {
          return [] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql, params = []) => {
        if (sql.includes("UPDATE budget_reservations")) updates.push(params);
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
    current.usageTotals = { ...current.usageTotals, costMicros: "5000" };
    current.runtimeRequest.requestId = "turn_request:recovery:1";
    current.runtimeRequest.budgetBaselineCostMicros = "5000";

    await expect(new SqlDurableTurnRepository(executor).reserveNextModelCall(current, "100"))
      .resolves.toEqual({ allowed: true, reason: null });
    // Only the next call's estimate is added; the 5000 settled earlier is not reserved again.
    expect(updates).toEqual([[tenantId, "turn_request:recovery:1", "100"]]);
  });

  it("persists retry diagnostics in the same statement that releases the lease", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      async execute(sql, params = []) {
        statements.push({ sql, params });
      },
      async query<T>() { return [] as T[]; },
    };
    const current = snapshot("calling_model", [admittedStep(), modelStep("running", 1)]);
    current.leaseOwner = "worker-provider-retry";
    const modelCall = current.steps.find((step) => step.type === "model.call")!;
    const diagnostics = {
      outcome: "failure",
      model: "provider/model",
      status: 503,
      statusClass: "5xx",
      category: "server",
      retryDecision: "retry",
      physicalAttempt: 1,
      latencyMs: 42,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      finishReason: null,
      errorCode: "upstream_unavailable",
    };

    await new SqlDurableTurnRepository(executor).release(
      current,
      "Provider request failed with 503",
      { stepId: modelCall.id, providerDiagnostics: diagnostics },
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("WITH released AS");
    expect(statements[0]!.sql).toContain("jsonb_build_object('providerDiagnostics',$5::jsonb)");
    expect(statements[0]!.sql).toContain("EXISTS (SELECT 1 FROM released)");
    expect(statements[0]!.params).toEqual([
      tenantId,
      runId,
      "worker-provider-retry",
      "Provider request failed with 503",
      JSON.stringify(diagnostics),
      modelCall.id,
      null,
    ]);
  });
});

class FakeTurnRepository implements DurableTurnRepository {
  events: AgentStreamEvent[] = [];
  outbox: Array<{ eventType: string; dedupeKey: string }> = [];
  mutations: DurableTurnMutation[] = [];
  budgetDecision: BudgetReservationDecision = { allowed: true, reason: null };
  lastBudgetEstimate = "0";
  releasedError: string | undefined;
  releasedRetryDiagnostics: DurableTurnRetryDiagnostics | undefined;

  constructor(public current: MutableSnapshot) {}

  async claim(
    _input: { tenantId: string; runId: string },
    owner: string,
  ): Promise<DurableTurnSnapshot | null> {
    if (["completed", "failed", "cancelled", "recovery_required"].includes(this.current.state)) return null;
    this.current.leaseOwner = owner;
    return this.current;
  }

  async heartbeat(): Promise<boolean> {
    return true;
  }

  async reserveNextModelCall(_snapshot: DurableTurnSnapshot, estimatedCostMicros: string) {
    this.lastBudgetEstimate = estimatedCostMicros;
    return this.budgetDecision;
  }

  async appendEvents(_snapshot: DurableTurnSnapshot, events: readonly AgentStreamEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async commit(snapshotValue: DurableTurnSnapshot, mutation: DurableTurnMutation): Promise<void> {
    expect(this.current.state).toBe(mutation.expectedState);
    this.mutations.push(mutation);
    for (const patch of mutation.steps ?? []) {
      const index = this.current.steps.findIndex((step) => step.sequence === patch.sequence);
      const previous = index >= 0 ? this.current.steps[index]! : null;
      const next: DurableTurnStep = {
        id: previous?.id ?? patch.id,
        sequence: patch.sequence,
        type: patch.type,
        state: patch.state,
        input: patch.input ?? previous?.input ?? {},
        output: patch.output === undefined ? previous?.output ?? null : patch.output,
        resultFingerprint: patch.resultFingerprint === undefined
          ? previous?.resultFingerprint ?? null
          : patch.resultFingerprint,
        deadlineAt: patch.deadlineAt === undefined ? previous?.deadlineAt ?? null : patch.deadlineAt,
        idleDeadlineAt: patch.idleDeadlineAt === undefined ? previous?.idleDeadlineAt ?? null : patch.idleDeadlineAt,
        timedOut: patch.timedOut === undefined ? previous?.timedOut ?? false : patch.timedOut,
        abortAcknowledged: patch.abortAcknowledged === undefined
          ? previous?.abortAcknowledged ?? false
          : patch.abortAcknowledged,
        outcomeCertainty: patch.outcomeCertainty === undefined
          ? previous?.outcomeCertainty ?? null
          : patch.outcomeCertainty,
        retryClass: patch.retryClass === undefined ? previous?.retryClass ?? null : patch.retryClass,
        idempotencyKey: patch.idempotencyKey === undefined ? previous?.idempotencyKey ?? null : patch.idempotencyKey,
        attempt: (previous?.attempt ?? 0) + (patch.incrementAttempt ? 1 : 0),
        error: patch.error === undefined ? previous?.error ?? null : patch.error,
      };
      if (index >= 0) this.current.steps[index] = next;
      else this.current.steps.push(next);
    }
    for (const entry of mutation.entries ?? []) {
      this.current.entries.push({
        entryId: entry.entryId,
        parentEntryId: this.current.entries.at(-1)?.entryId ?? null,
        entryType: entry.entryType,
        sequence: this.current.entries.length + 1,
        payload: entry.payload,
      });
    }
    if (mutation.approval) {
      this.current.approvals.push({
        id: mutation.approval.id,
        stepId: mutation.approval.stepId,
        status: "pending",
        decision: null,
      });
    }
    this.events.push(...(mutation.events ?? []));
    this.outbox.push(...(mutation.outbox ?? []));
    this.current.state = mutation.nextState;
    this.current.version += 1;
    this.current.error = mutation.error ?? null;
    if (mutation.progress) {
      this.current.progress = {
        progressEpoch: this.current.progress?.progressEpoch ?? 0,
        progressKind: this.current.progress?.progressKind ?? null,
        consecutiveNoProgress: this.current.progress?.consecutiveNoProgress ?? 0,
        physicalModelAttempt: this.current.progress?.physicalModelAttempt ?? 0,
        logicalModelIteration: this.current.progress?.logicalModelIteration ?? 0,
        toolRepairAttempts: this.current.progress?.toolRepairAttempts ?? 0,
        cumulativeToolMs: this.current.progress?.cumulativeToolMs ?? 0,
        cumulativeActiveComputeMs: this.current.progress?.cumulativeActiveComputeMs ?? 0,
        budgetReason: this.current.progress?.budgetReason ?? null,
        ...mutation.progress,
      };
    }
    this.current.leaseOwner = mutation.keepLease ? snapshotValue.leaseOwner : "";
  }

  async release(
    _snapshot: DurableTurnSnapshot,
    error?: string,
    retryDiagnostics?: DurableTurnRetryDiagnostics,
  ): Promise<void> {
    this.releasedError = error;
    this.releasedRetryDiagnostics = retryDiagnostics;
    this.current.leaseOwner = "";
  }
}

type MutableSnapshot = Omit<DurableTurnSnapshot, "steps" | "entries" | "approvals"> & {
  steps: DurableTurnStep[];
  entries: DurableTurnSnapshot["entries"] extends readonly (infer T)[] ? T[] : never;
  approvals: DurableTurnSnapshot["approvals"] extends readonly (infer T)[] ? T[] : never;
  error: string | null;
};

function snapshot(state: TurnRunState, steps: DurableTurnStep[]): MutableSnapshot {
  return {
    id: runId,
    createdAt: new Date().toISOString(),
    tenantId,
    userId: "00000000-0000-7000-8000-000000000003",
    workspaceId: "00000000-0000-7000-8000-000000000004",
    taskId: "00000000-0000-7000-8000-000000000005",
    sessionId: "00000000-0000-7000-8000-000000000006",
    requestMessageId: "00000000-0000-7000-8000-000000000007",
    state,
    attempt: 0,
    version: 0,
    leaseOwner: "",
    cancelledAt: null,
    runtimeRequest: { input: "Do the task", permissionMode: "ask" },
    groundingContext: {},
    promptManifest: {},
    sandboxProvider: null,
    sandboxId: null,
    sandboxState: null,
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicros: "0",
    },
    steps,
    entries: [{
      entryId: "entry-user",
      parentEntryId: null,
      entryType: "message",
      sequence: 1,
      payload: {
        type: "message",
        id: "entry-user",
        parentId: null,
        message: { role: "user", content: "Do the task" },
      },
    }],
    approvals: [],
    error: null,
  };
}

function providerSnapshot(apiType: "openai-responses" | "anthropic-messages"): MutableSnapshot {
  const current = snapshot("calling_model", [admittedStep(), modelStep("pending", 1)]);
  current.runtimeRequest = {
    capabilityVersion: 1,
    input: "Say ok",
    providerId: `provider-${apiType}`,
    provider: {
      id: `provider-${apiType}`,
      name: apiType,
      kind: "test",
      baseUrl: "https://provider.example.test/v1",
      defaultModel: "test-model",
      apiType,
      endpointPath: apiType === "openai-responses" ? "/responses" : "/messages",
      authType: "none",
      models: [],
    },
    model: "test-model",
    conversationKind: "chat",
    workspacePath: "/workspace",
    workspaceId: current.workspaceId,
    permissionMode: "ask",
    reasoning: "off",
    maxTokens: 1_000,
    contextWindowTokens: 16_000,
    modelAcceptsImages: false,
    modelPricing: {},
    builtInTools: [],
    mcpServers: [],
    extraSkills: [],
    attachments: [],
  };
  return current;
}

function admittedStep(): DurableTurnStep {
  return {
    id: randomUUID(),
    sequence: 0,
    type: "turn.admitted",
    state: "completed",
    input: {},
    output: { accepted: true },
    retryClass: "idempotent_with_key",
    idempotencyKey: `${runId}:admitted`,
    attempt: 1,
    error: null,
  };
}

function modelStep(state: DurableTurnStep["state"], sequence: number): DurableTurnStep {
  return {
    id: randomUUID(),
    sequence,
    type: "model.call",
    state,
    input: { iteration: 1 },
    output: null,
    retryClass: "idempotent_with_key",
    idempotencyKey: `${runId}:model:1`,
    attempt: 0,
    error: null,
  };
}

function toolStep(
  state: DurableTurnStep["state"],
  retryClass: NonNullable<DurableTurnStep["retryClass"]>,
  requiresApproval: boolean,
): DurableTurnStep {
  return {
    id: randomUUID(),
    sequence: 1,
    type: "tool.write",
    state,
    input: {
      toolCallId: randomUUID(),
      toolName: "write",
      arguments: { path: "/workspace/result.txt", content: "done" },
      requiresApproval,
      approvalKind: "file-edit",
    },
    output: null,
    retryClass,
    idempotencyKey: retryClass === "idempotent_with_key" ? `${runId}:tool:1` : null,
    attempt: state === "running" ? 1 : 0,
    error: null,
  };
}

function readOnlyToolStep(
  name: "read" | "grep" | "find" | "ls",
  sequence: number,
  path: string,
  state: DurableTurnStep["state"] = "pending",
): DurableTurnStep {
  return {
    id: randomUUID(),
    sequence,
    type: `tool.${name}`,
    state,
    input: {
      toolCallId: randomUUID(),
      toolName: name,
      arguments: name === "grep" ? { path, pattern: "result" } : { path },
      requiresApproval: false,
      approvalKind: "file-edit",
    },
    output: null,
    retryClass: "read_only",
    idempotencyKey: null,
    attempt: state === "running" ? 1 : 0,
    error: null,
  };
}

function toolNameFromTestStep(step: DurableTurnStep): string {
  return typeof step.input.toolName === "string" ? step.input.toolName : step.type.slice(5);
}

function runCommandStep(
  state: DurableTurnStep["state"],
  sequence: number,
  command: string,
): DurableTurnStep {
  return {
    ...toolStep(state, "idempotent", false),
    sequence,
    type: "tool.bash",
    input: {
      toolCallId: randomUUID(),
      toolName: "bash",
      arguments: { command },
      requiresApproval: false,
      approvalKind: "shell",
    },
  };
}

function noTools(): DurableTurnToolExecutor {
  return { execute: async () => ({ output: {}, summary: "" }) };
}

function queueToolForExecution(repository: FakeTurnRepository, step: DurableTurnStep): void {
  repository.current.steps = repository.current.steps.map((candidate) =>
    candidate.type === "model.call" && candidate.state === "pending"
      ? { ...candidate, state: "completed", output: {} }
      : candidate,
  );
  repository.current.steps.push(step);
  repository.current.state = "executing_tool";
}

function unusedModel(): DurableTurnModel {
  return {
    call: async () => {
      throw new Error("model should not be called");
    },
  };
}

function safeBigIntForTest(value: string): bigint {
  return BigInt(value || "0");
}
