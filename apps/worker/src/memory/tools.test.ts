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
  it("keeps memory mutations non-abortable and delegates inherited capability", () => {
    const baseSupportsAbort = () => true;
    const executor = new DurablePersonalMemoryToolExecutor({
      supportsAbort: baseSupportsAbort,
      execute: async () => ({ output: {}, summary: "base" }),
    }, repository({ memoryEnabled: true, implicitMemoryEnabled: true }), personalMemory());

    expect(executor.supportsAbort(snapshot(), memoryStep("remember_memory", {
      kind: "profile",
      content: "A fact",
    }))).toBe(false);
    expect(executor.supportsAbort(snapshot(), {
      type: "tool.read",
      input: { toolName: "read", arguments: { path: "/workspace/file.txt" } },
    } as never)).toBe(true);
  });

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
    expect(definitions.find((tool) => tool.function.name === "remember_memory"))
      .toMatchObject({
        function: {
          parameters: {
            properties: {
              expires_at: {
                type: "string",
                format: "date-time",
              },
            },
          },
        },
      });
    const forgetMemory = definitions.find((tool) => tool.function.name === "forget_memory");
    expect(forgetMemory).toMatchObject({
      function: {
        parameters: {
          type: "object",
          properties: {
            memory_id: { type: "string" },
            stable_key: { type: "string" },
          },
        },
      },
    });
    expect(forgetMemory?.function.parameters).not.toHaveProperty("anyOf");
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

  it("never stores a secret, even when asked explicitly (H-040)", async () => {
    let stored = false;
    const executor = new DurablePersonalMemoryToolExecutor(
      baseTools(),
      repository({ memoryEnabled: true, implicitMemoryEnabled: true }),
      personalMemory({ remember: async () => { stored = true; return { operation: "ADD", reason: "x", item: null }; } }),
    );

    await expect(executor.execute(snapshot(), memoryStep("remember_memory", {
      kind: "preference",
      content: "My api key: abcdefghijklmnop",
    }))).rejects.toThrow("Not stored: credentials and secrets are not memory.");
    expect(stored).toBe(false);
  });

  describe("declared memory tools (H-032, H-077)", () => {
    const unavailable = "Personal memory is unavailable for this message";
    const turnedOff = "Personal memory is turned off for this user";
    /** Settings answers in order; records each lookup's tenant and user. */
    const settingsSequence = (results: Array<{ memoryEnabled: boolean } | Error>) => {
      const lookups: Array<[string, string]> = [];
      const repository = {
        async settings(tenantId: string, userId: string) {
          const result = results[Math.min(lookups.length, results.length - 1)]!;
          lookups.push([tenantId, userId]);
          if (result instanceof Error) throw result;
          return { ...result, implicitMemoryEnabled: true };
        },
      } as unknown as SqlWorkerMemoryRepository;
      return { repository, lookups };
    };
    const executorFor = (repository: SqlWorkerMemoryRepository, provider: PersonalMemoryProvider | null = personalMemory(), globallyEnabled = true) =>
      new DurablePersonalMemoryToolExecutor(baseTools(), repository, provider, globallyEnabled);
    /** One model request's preparation, as the runner does it: a fresh snapshot, definitions and content together. */
    const prepare = async (executor: DurablePersonalMemoryToolExecutor) => {
      const current = snapshot();
      const [definitions, content] = await Promise.all([executor.definitions(current), executor.modelContent(current)]);
      return {
        tools: definitions.map((tool) => tool.function.name),
        notice: content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
      };
    };
    const connectionReset = () => new Error("database connection reset");

    it.each([
      ["has memory on", true, ""],
      ["turned memory off", false, turnedOff],
    ] as const)("declares the same tools through a healthy, failed and recovered lookup when the user %s", async (_label, memoryEnabled, settledNotice) => {
      const { repository, lookups } = settingsSequence([{ memoryEnabled }, connectionReset(), { memoryEnabled }]);
      const executor = executorFor(repository);

      const healthy = await prepare(executor);
      const failed = await prepare(executor);
      const recovered = await prepare(executor);

      expect(healthy.tools).toEqual(["base_tool", "remember_memory", "forget_memory"]);
      expect(failed.tools).toEqual(healthy.tools);
      expect(recovered.tools).toEqual(healthy.tools);
      // Each request read the settings once, so the failure was really met.
      expect(lookups).toHaveLength(3);
      expect(failed.notice).toContain(unavailable);
      expect(healthy.notice).toEqual(settledNotice ? expect.stringContaining(settledNotice) : "");
      expect(recovered.notice).toBe(healthy.notice);
    });

    it("declares the same tools when a disabled user's first lookup fails and the next succeeds", async () => {
      const { repository, lookups } = settingsSequence([connectionReset(), { memoryEnabled: false }]);
      const executor = executorFor(repository);

      const unreadable = await prepare(executor);
      const recovered = await prepare(executor);

      expect(unreadable.tools).toEqual(recovered.tools);
      expect(lookups).toHaveLength(2);
      expect(unreadable.notice).toContain(unavailable);
      expect(recovered.notice).toContain(turnedOff);
    });

    it.each([
      ["has memory on", true],
      ["turned memory off", false],
    ] as const)("declares the same tools on another worker or after a restart when the user %s", async (_label, memoryEnabled) => {
      const before = await prepare(executorFor(settingsSequence([{ memoryEnabled }]).repository));
      const failing = settingsSequence([connectionReset()]);
      const afterRestart = await prepare(executorFor(failing.repository));
      const recovered = await prepare(executorFor(settingsSequence([{ memoryEnabled }]).repository));

      expect(afterRestart.tools).toEqual(before.tools);
      expect(recovered.tools).toEqual(before.tools);
      expect(failing.lookups).toHaveLength(1);
      expect(afterRestart.notice).toContain(unavailable);
    });

    it("reads the settings of the request's own tenant and user", async () => {
      const { repository, lookups } = settingsSequence([{ memoryEnabled: true }]);
      await prepare(executorFor(repository));
      expect(lookups).toEqual([["00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002"]]);
    });

    it.each([
      ["unreadable", [connectionReset()], "Personal memory is unavailable right now"],
      ["off", [{ memoryEnabled: false }], "Personal memory is disabled for this user"],
    ] as const)("saves and forgets nothing when the settings are %s, reading them again for each use", async (_label, results, refusal) => {
      const mutations: string[] = [];
      const { repository, lookups } = settingsSequence([...results]);
      const executor = executorFor(repository, personalMemory({
        remember: async () => { mutations.push("remember"); return { operation: "ADD", reason: "x", item: null }; },
        forget: async () => { mutations.push("forget"); return null; },
      }));
      const current = snapshot();

      await executor.modelContent(current);
      await expect(executor.execute(current, memoryStep("remember_memory", { kind: "profile", content: "A fact" }))).rejects.toThrow(refusal);
      await expect(executor.execute(current, memoryStep("forget_memory", { stable_key: "profile:role" }))).rejects.toThrow(refusal);
      expect(mutations).toEqual([]);
      // One lookup to prepare the request, then a fresh one for each use.
      expect(lookups).toHaveLength(3);
    });

    it.each([
      ["memory is switched off for the deployment", personalMemory(), false],
      ["no memory provider is configured", null, true],
    ] as const)("declares no memory tools and reads no settings when %s", async (_label, provider, globallyEnabled) => {
      const { repository, lookups } = settingsSequence([connectionReset()]);
      const executor = executorFor(repository, provider, globallyEnabled);

      expect(await prepare(executor)).toEqual({ tools: ["base_tool"], notice: "" });
      expect(await prepare(executor)).toEqual({ tools: ["base_tool"], notice: "" });
      expect(lookups).toHaveLength(0);
    });
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
