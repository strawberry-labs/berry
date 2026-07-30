import type { PersonalMemoryProvider } from "@berry/personal-memory";
import { describe, expect, it } from "vitest";
import type {
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
} from "../turn-runner.js";
import type { SqlWorkerMemoryRepository } from "./repository.js";
import { DurablePersonalMemoryToolExecutor } from "./tools.js";

describe("DurablePersonalMemoryToolExecutor", () => {
  it("adds personal memory tools while preserving inherited tool definitions", async () => {
    const executor = new DurablePersonalMemoryToolExecutor(
      baseTools(),
      repository({ memoryEnabled: true, implicitMemoryEnabled: true }),
      personalMemory(),
    );

    const definitions = await executor.definitions(snapshot());

    expect(definitions.map((tool) => tool.function.name)).toEqual([
      "base_tool",
      "remember_memory",
      "forget_memory",
    ]);
  });

  it("stores an explicit personal memory with turn provenance", async () => {
    let captured: Parameters<PersonalMemoryProvider["remember"]>[0] | undefined;
    const provider = personalMemory({
      async remember(input) {
        captured = input;
        return {
          operation: "ADD",
          reason: "mem0_personal_memory",
          item: { id: "memory-1" } as never,
        };
      },
    });
    const executor = new DurablePersonalMemoryToolExecutor(
      baseTools(),
      repository({ memoryEnabled: true, implicitMemoryEnabled: true }),
      provider,
    );

    const result = await executor.execute(snapshot(), memoryStep("remember_memory", {
      kind: "relationship",
      stable_key: "profile:company-role",
      content: "The user owns Strawberry Labs.",
    }));

    expect(captured).toMatchObject({
      tenantId: "00000000-0000-7000-8000-000000000001",
      userId: "00000000-0000-7000-8000-000000000002",
      kind: "relationship",
      stableKey: "profile:company-role",
      content: "The user owns Strawberry Labs.",
      explicit: true,
      source: {
        actorUserId: "00000000-0000-7000-8000-000000000002",
        taskId: "00000000-0000-7000-8000-000000000004",
        sessionId: "00000000-0000-7000-8000-000000000005",
        messageId: "00000000-0000-7000-8000-000000000006",
        extractorVersion: "explicit-v1",
      },
    });
    expect(result.output).toMatchObject({
      operation: "ADD",
      memoryId: "memory-1",
      stored: true,
    });
  });

  it("does not expose or execute memory tools when the user disabled memory", async () => {
    const executor = new DurablePersonalMemoryToolExecutor(
      baseTools(),
      repository({ memoryEnabled: false, implicitMemoryEnabled: true }),
      personalMemory(),
    );

    await expect(executor.definitions(snapshot())).resolves.toHaveLength(1);
    await expect(executor.execute(
      snapshot(),
      memoryStep("remember_memory", {
        kind: "profile",
        content: "Do not store this.",
      }),
    )).rejects.toThrow("Personal memory is disabled for this user");
  });
});

function baseTools(): DurableTurnToolExecutor {
  return {
    definitions: async () => [{
      type: "function",
      function: {
        name: "base_tool",
        description: "Fixture",
        parameters: { type: "object" },
      },
    }],
    execute: async () => ({ output: {}, summary: "base" }),
  };
}

function repository(settings: {
  memoryEnabled: boolean;
  implicitMemoryEnabled: boolean;
}): SqlWorkerMemoryRepository {
  return {
    settings: async () => settings,
  } as unknown as SqlWorkerMemoryRepository;
}

function personalMemory(
  overrides: Partial<PersonalMemoryProvider> = {},
): PersonalMemoryProvider {
  return {
    remember: async () => ({ operation: "NOOP", reason: "fixture", item: null }),
    ingestConversation: async () => ({ items: [], replayed: false }),
    list: async () => ({ items: [], nextCursor: null }),
    get: async () => null,
    search: async () => [],
    update: async () => ({ operation: "NOOP", reason: "fixture", item: null }),
    forget: async () => null,
    clear: async () => ({ forgotten: 0 }),
    export: async () => ({ items: [], versions: [] }),
    health: async () => true,
    ...overrides,
  };
}

function snapshot(): DurableTurnSnapshot {
  return {
    id: "00000000-0000-7000-8000-000000000007",
    createdAt: new Date().toISOString(),
    tenantId: "00000000-0000-7000-8000-000000000001",
    userId: "00000000-0000-7000-8000-000000000002",
    workspaceId: "00000000-0000-7000-8000-000000000003",
    taskId: "00000000-0000-7000-8000-000000000004",
    sessionId: "00000000-0000-7000-8000-000000000005",
    requestMessageId: "00000000-0000-7000-8000-000000000006",
    state: "executing_tool",
    attempt: 0,
    version: 0,
    leaseOwner: "test",
    cancelledAt: null,
    runtimeRequest: {},
    groundingContext: {},
    promptManifest: {},
    sandboxProvider: null,
    sandboxId: null,
    sandboxState: null,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: "0" },
    steps: [],
    entries: [],
    approvals: [],
  };
}

function memoryStep(
  name: "remember_memory" | "forget_memory",
  args: Record<string, unknown>,
): DurableTurnStep {
  return {
    id: "00000000-0000-7000-8000-000000000008",
    sequence: 1,
    type: `tool.${name}`,
    state: "pending",
    input: {
      toolCallId: "00000000-0000-7000-8000-000000000009",
      toolName: name,
      arguments: args,
    },
    output: null,
    retryClass: "idempotent_with_key",
    idempotencyKey: "memory-tool-fixture",
    attempt: 0,
    error: null,
  };
}
