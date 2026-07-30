import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentStreamEvent, TurnRunState } from "@berry/shared";
import {
  OpenAIChatCompletionsClient,
  type ChatCompletionChunk,
  type ChatCompletionOptions,
} from "@berry/router-client";
import {
  DurableTurnRunner,
  DurableTurnRetryableError,
  RouterDurableTurnModel,
  SqlDurableTurnRepository,
  type DurableTurnModel,
  type DurableTurnMutation,
  type DurableTurnRepository,
  type DurableTurnSnapshot,
  type DurableTurnStep,
  type DurableTurnToolExecutor,
} from "./turn-runner.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const runId = "00000000-0000-7000-8000-000000000002";

describe("durable turn runner", () => {
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
  });

  it("moves an ambiguous running non-idempotent tool to recovery_required", async () => {
    const tool = toolStep("running", "non_idempotent_manual", false);
    const repository = new FakeTurnRepository(snapshot("executing_tool", [admittedStep(), tool]));
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
      message: { role: "user", content: "x".repeat(8_000) },
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
      compactionTriggerTokens: 100,
      compactor: {
        compactSession: async () => {
          compactions += 1;
          repository.current.checkpointCoveredEntryId = repository.current.entries.at(-1)?.entryId ?? null;
          return { sessionId: repository.current.sessionId, summary: "Checkpointed.", tokensBefore: 2_000, tokensAfter: 100 };
        },
      },
    });

    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("compacting");
    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("calling_model");
    expect((await runner.execute({ tenantId, runId, reason: "continue" })).state).toBe("finalizing");
    expect(compactions).toBe(1);
    expect(modelCalls).toBe(1);
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
    ]);
    expect(repository.events
      .filter((event): event is Extract<AgentStreamEvent, { kind: "message.delta" }> => event.kind === "message.delta")
      .map((event) => event.delta)
      .join("")).toBe("Hello world");
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
      error: "Command exited with 2: file not found",
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

  it("stops before an extra model iteration when the configured limit is reached", async () => {
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
    }, noTools(), { maxModelIterations: 1 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "completed" });
    expect(calls).toBe(0);
    expect(repository.events).toContainEqual(expect.objectContaining({
      kind: "session.note",
      note: "limit-reached",
    }));
  });

  it("stops before another tool after the cumulative token limit is reached", async () => {
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
    }, { maxTotalTokens: 100 });

    await expect(runner.execute({ tenantId, runId, reason: "continue" }))
      .resolves.toMatchObject({ state: "completed" });
    expect(calls).toBe(0);
  });

  it("uses the router streaming transport and assembles streamed tool calls", async () => {
    let request: ChatCompletionOptions | undefined;
    const client = {
      stream: async function* (options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
        request = options;
        yield {
          id: "completion-1",
          model: "kimi-2.6",
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
            function: { name: "mcp__BerryCrawl__search", arguments: "{\"query\":" },
          }],
          finishReason: null,
          raw: {},
        };
        yield {
          id: "completion-1",
          model: "kimi-2.6",
          delta: "",
          toolCalls: [{ index: 0, function: { arguments: "\"AI news\"}" } }],
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
    current.runtimeRequest.modelPricing = { input: 1, output: 2 };
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
        }],
        emitDelta: async (delta, channel) => { deltas.push({ delta, channel }); },
        policyForTool: () => ({
          retryClass: "read_only",
          requiresApproval: false,
          approvalKind: "mcp",
        }),
      },
    );

    expect(request?.tools?.[0]?.function.name).toBe("mcp__BerryCrawl__search");
    expect(request?.messages.find((message) => message.role === "user")?.content).toContain(
      "Sandbox path: /workspace/inputs/00000000-0000-7000-8000-000000000099/candidate.pdf",
    );
    expect(deltas.filter((item) => item.channel === "text").map((item) => item.delta).join("")).toBe("Searching");
    expect(deltas.filter((item) => item.channel === "reasoning").map((item) => item.delta).join("")).toBe("Need current sources.");
    expect(result).toMatchObject({
      text: "Searching",
      reasoning: "Need current sources.",
      inputTokens: 10,
      outputTokens: 4,
      usage: { costRawMicros: "18" },
      toolCalls: [{
        name: "mcp__BerryCrawl__search",
        input: { query: "AI news" },
        retryClass: "read_only",
        requiresApproval: false,
      }],
    });
  });

  it("casts persisted tool statuses to the PostgreSQL enum", async () => {
    const statements: string[] = [];
    const executor: SqlExecutor = {
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT state,cancelled_at FROM turn_runs")) {
          return [{ state: "executing_tool", cancelled_at: null }] as T[];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      execute: async (sql: string) => {
        statements.push(sql);
      },
    };
    const current = snapshot("executing_tool", [admittedStep()]);
    current.leaseOwner = "worker-sql";
    const tool = toolStep("completed", "read_only", false);

    await new SqlDurableTurnRepository(executor).commit(current, {
      expectedState: "executing_tool",
      nextState: "calling_model",
      steps: [tool],
      assistantMessage: {
        id: randomUUID(),
        text: "",
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: randomUUID(), name: "read_file", input: { path: "/workspace/a.txt" } }],
      },
      toolResultMessage: {
        id: randomUUID(),
        toolCallId: randomUUID(),
        name: "read_file",
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
  });
});

class FakeTurnRepository implements DurableTurnRepository {
  events: AgentStreamEvent[] = [];
  outbox: Array<{ eventType: string; dedupeKey: string }> = [];

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

  async appendEvents(_snapshot: DurableTurnSnapshot, events: readonly AgentStreamEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async commit(snapshotValue: DurableTurnSnapshot, mutation: DurableTurnMutation): Promise<void> {
    expect(this.current.state).toBe(mutation.expectedState);
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
    this.current.leaseOwner = mutation.keepLease ? snapshotValue.leaseOwner : "";
  }

  async release(): Promise<void> {
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
    type: "tool.write_file",
    state,
    input: {
      toolCallId: randomUUID(),
      toolName: "write_file",
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

function noTools(): DurableTurnToolExecutor {
  return { execute: async () => ({ output: {}, summary: "" }) };
}

function unusedModel(): DurableTurnModel {
  return {
    call: async () => {
      throw new Error("model should not be called");
    },
  };
}
