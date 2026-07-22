import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Models,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import { findCutPoint } from "../src/harness/compaction/compaction.ts";
import { NodeExecutionEnv } from "../src/harness/env/nodejs.ts";
import { InMemorySessionRepo } from "../src/harness/session/memory-repo.ts";
import { buildSessionContext } from "../src/harness/session/session.ts";
import type { SessionTreeEntry } from "../src/harness/types.ts";

function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "http://localhost",
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 256,
		...overrides,
	};
}

function assistant(
	model: Model<any>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	totalTokens: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function modelsFor(
	streamFn: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream,
	models: Model<Api>[],
): Models {
	const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
		streamFn(model, context, options);
	return {
		getProviders: () => [],
		getProvider: () => undefined,
		getModels: () => models,
		getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		refresh: async () => {},
		getAuth: async () => undefined,
		stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions | undefined),
		complete: async (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions | undefined).result(),
		streamSimple,
		completeSimple: async (model, context, options) => streamSimple(model, context, options).result(),
	};
}

describe("AgentHarness compaction", () => {
	it("cuts before the last valid entry when a huge trailing tool result exceeds the recent budget", () => {
		const entries: SessionTreeEntry[] = [
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "start", timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: new Date().toISOString(),
				message: assistant(testModel(), [{ type: "toolCall", id: "call_1", name: "large", arguments: {} }], "toolUse", 10),
			},
			{
				type: "message",
				id: "tool",
				parentId: "assistant",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "large",
					content: [{ type: "text", text: "x".repeat(2000) }],
					isError: false,
					timestamp: 2,
				},
			},
		];

		const cutPoint = findCutPoint(entries, 0, entries.length, 100);
		expect(cutPoint.firstKeptEntryIndex).toBe(1);
		expect(cutPoint.isSplitTurn).toBe(true);
		expect(cutPoint.turnStartIndex).toBe(0);
	});

	it("auto-compacts after a large tool result before continuing the loop", async () => {
		const model = testModel();
		const repo = new InMemorySessionRepo();
		const session = await repo.create({});
		const events: string[] = [];
		let compactCalls = 0;
		let sawCompactedContext = false;
		const streamFn = (streamModel: Model<Api>, context: Context): AssistantMessageEventStream => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (context.systemPrompt?.includes("context summarization assistant")) {
					compactCalls++;
					const summary = assistant(streamModel, [{ type: "text", text: "Summary checkpoint." }], "stop", 25);
					stream.push({ type: "start", partial: summary });
					stream.push({ type: "done", reason: "stop", message: summary });
					return;
				}

				const hasToolResult = context.messages.some((message) => message.role === "toolResult");
				if (!hasToolResult) {
					const toolCall: ToolCall = { type: "toolCall", id: "call_large", name: "large_output", arguments: {} };
					const message = assistant(streamModel, [{ type: "text", text: "Checking." }, toolCall], "toolUse", 600);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Checking.", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "Checking.", partial: message });
					stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
					return;
				}

				sawCompactedContext = context.messages.some((message) => {
					if (message.role !== "user") return false;
					const text =
						typeof message.content === "string"
							? message.content
							: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
					return text.includes("conversation history before this point was compacted");
				});
				const message = assistant(streamModel, [{ type: "text", text: "Done." }], "stop", 120);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Done.", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "Done.", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const tool: AgentTool = {
			name: "large_output",
			label: "Large output",
			description: "Return a large output",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "x".repeat(1200) }],
				details: {},
			}),
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			models: modelsFor(streamFn, [model]),
			tools: [tool],
			systemPrompt: "You are a test agent.",
			compaction: { reserveTokens: 100, keepRecentTokens: 100, triggerRatio: 0.5, maxSummarizationInputTokens: 1000 },
		});
		harness.subscribe((event) => {
			events.push(event.type);
		});

		const result = await harness.prompt("start");

		expect(result.stopReason).toBe("stop");
		expect(compactCalls).toBe(1);
		expect(sawCompactedContext).toBe(true);
		expect(events).toContain("session_compact");
		const branch = await session.getBranch();
		const compaction = branch.find((entry) => entry.type === "compaction");
		expect(compaction).toBeTruthy();
		if (compaction?.type === "compaction") {
			expect(compaction.details).toMatchObject({ windowNumber: 1, retainedTokens: expect.any(Number) });
		}
	});

	it("replays remote Responses compaction output without duplicating the retained prefix", () => {
		const remoteItems = [{ type: "compaction", encrypted_content: "opaque" }];
		const entries: SessionTreeEntry[] = [
			{
				type: "message",
				id: "old-user",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "old", timestamp: 1 },
			},
			{
				type: "message",
				id: "kept-user",
				parentId: "old-user",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "would duplicate", timestamp: 2 },
			},
			{
				type: "compaction",
				id: "compact",
				parentId: "kept-user",
				timestamp: "2026-01-01T00:00:02.000Z",
				summary: "fallback summary",
				firstKeptEntryId: "kept-user",
				tokensBefore: 500,
				details: { remote: true, responsesOutputItems: remoteItems },
				fromHook: true,
			},
			{
				type: "message",
				id: "new-user",
				parentId: "compact",
				timestamp: "2026-01-01T00:00:03.000Z",
				message: { role: "user", content: "new", timestamp: 3 },
			},
		];

		const context = buildSessionContext(entries);
		expect(context.messages).toHaveLength(2);
		expect(context.messages[0]).toMatchObject({
			role: "responsesRawItems",
			items: remoteItems,
			fallbackSummary: "fallback summary",
		});
		expect(context.messages[1]).toMatchObject({ role: "user", content: "new" });
	});
});
