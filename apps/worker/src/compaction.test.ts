import { describe, expect, it, vi } from "vitest";
import { RouterClientError, type OpenAIChatCompletionsClient } from "@berry/router-client";
import {
  SESSION_CHECKPOINT_MAX_BYTES,
  sessionCheckpointMetrics,
  type SessionCheckpointV2,
} from "@berry/shared";
import {
  CompactionRetryableError,
  CompactionTerminalError,
  DurableSessionCompactor,
  RouterCheckpointGenerator,
  SqlSessionCompactionRepository,
  compactionModelPricingFromEnv,
  createCheckpointGenerator,
  type CheckpointGenerator,
  type CompactionSessionState,
  type SessionCompactionRepository,
} from "./compaction.js";
import type { CompactionJobPayload } from "./jobs.js";

const job: CompactionJobPayload = {
  tenantId: "00000000-0000-7000-8000-000000000001",
  taskId: "00000000-0000-7000-8000-000000000002",
  sessionId: "00000000-0000-7000-8000-000000000003",
  reason: "token-threshold",
};

function compactionState(overrides: Partial<CompactionSessionState> = {}): CompactionSessionState {
  return {
    tenantId: job.tenantId,
    taskId: job.taskId,
    sessionId: job.sessionId,
    sourceLeafId: "entry-2",
    modelProviderId: null,
    model: null,
    modelAllowed: true,
    algorithmVersion: "checkpoint-v2-bounded",
    entries: [
      {
        entryId: "entry-1",
        parentEntryId: null,
        entryType: "message",
        sequence: 1,
        payload: { role: "user", content: "Implement durable compaction." },
        isLeafMarker: false,
        createdAt: "2026-07-28T12:00:00.000Z",
      },
      {
        entryId: "entry-2",
        parentEntryId: "entry-1",
        entryType: "message",
        sequence: 2,
        payload: { role: "assistant", content: "Working on it." },
        isLeafMarker: true,
        createdAt: "2026-07-28T12:01:00.000Z",
      },
    ],
    previousRolling: null,
    priorSegments: [],
    latestSegmentCoveredEnd: null,
    latestSegmentSourceLeafId: null,
    ...overrides,
  };
}

function checkpointOutput(): SessionCheckpointV2 {
  return {
    schema: "berry.session-checkpoint",
    version: 2,
    generatedAt: "2026-07-28T12:00:00.000Z",
    goal: "Implement durable compaction.",
    successCriteria: [],
    constraints: [],
    standingInstructions: [],
    completedWork: ["Persist the bounded checkpoint."],
    currentWork: [],
    blockers: [],
    waitingState: null,
    decisions: [],
    unresolvedQuestions: [],
    nextAction: "Continue the task.",
    filesRead: [],
    filesModified: [],
    artifacts: [],
    commands: [],
    toolCalls: [],
    approvals: [],
    promptManifestHash: null,
    retrievalSnapshotIds: [],
    coveredEntryStart: "entry-1",
    coveredEntryEnd: "entry-1",
    currentLeafId: "entry-2",
    narrative: "The persisted session segment is checkpointed.",
  };
}

function modelResponse(content: string, usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 }) {
  return {
    id: "checkpoint-response",
    model: "checkpoint-test",
    content,
    finishReason: "stop" as const,
    raw: {},
    usage,
  };
}

describe("durable session compactor", () => {
  it("uses the tool-capable compaction model instead of inheriting the chat default", () => {
    const generator = createCheckpointGenerator({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_API_KEY: "test-key",
      BERRY_ROUTER_DEFAULT_MODEL: "canopywave/deepseek/deepseek-v4-flash",
      BERRY_ROUTER_PROVIDER_ID: "router",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
        id: "canopywave/moonshotai/kimi-k2.6",
        capabilities: { cost: { input: 1, output: 2 } },
      }]),
    });

    expect(generator).toMatchObject({
      provider: "router",
      model: "canopywave/moonshotai/kimi-k2.6",
    });
  });

  it("allows an explicit compaction provider to override the router provider id", () => {
    const generator = createCheckpointGenerator({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_API_KEY: "test-key",
      BERRY_ROUTER_DEFAULT_MODEL: "chat-model",
      BERRY_ROUTER_PROVIDER_ID: "router",
      BERRY_COMPACTION_PROVIDER: "dedicated-compactor",
      BERRY_COMPACTION_MODEL: "dedicated-compaction-model",
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
        id: "dedicated-compaction-model",
        capabilities: { cost: { input: 1, output: 2 } },
      }]),
    });

    expect(generator).toMatchObject({
      provider: "dedicated-compactor",
      model: "dedicated-compaction-model",
    });
  });

  it("falls back to deterministic compaction when the configured model has no price", () => {
    expect(createCheckpointGenerator({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example.test/v1",
      BERRY_ROUTER_API_KEY: "test-key",
      BERRY_COMPACTION_MODEL: "unpriced-compaction-model",
      BERRY_ROUTER_MODELS_JSON: "[]",
    })).toBeNull();
  });

  it("loads compaction prices from the worker model catalog", () => {
    expect(compactionModelPricingFromEnv({
      BERRY_ROUTER_MODELS_JSON: JSON.stringify([{
        id: "checkpoint-test",
        capabilities: { cost: { input: 0.25, output: 1.5, cacheRead: 0.05 } },
      }]),
    })).toEqual({
      "checkpoint-test": { input: 0.25, output: 1.5, cacheRead: 0.05 },
    });
  });

  it("accepts a validated checkpoint from the first physical attempt and records usage", async () => {
    const complete = vi.fn().mockResolvedValue(modelResponse(JSON.stringify(checkpointOutput())));
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
      { "checkpoint-test": { input: 1, output: 2 } },
    );
    const reports: unknown[] = [];
    const result = await generator.generate({
      conversation: '{"entryId":"entry-1"}',
      deterministic: {
        generatedAt: "2026-07-28T12:00:00.000Z",
        coveredEntryStart: "entry-1",
        coveredEntryEnd: "entry-1",
        currentLeafId: "entry-2",
      },
      previousRolling: null,
      maxTokens: 128,
      tokensBefore: 128,
      algorithmVersion: "checkpoint-v2-bounded",
      onProviderAttempt: (report) => reports.push(report),
    });

    expect(result).toMatchObject({
      validationStatus: "valid",
      attempts: 1,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        costRawMicros: "28",
        pricingSource: "measured",
      },
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ providerAttemptOrdinal: 1 }));
    expect(reports).toEqual([]);
  });

  it("overrides model-supplied checkpoint identity before validation instead of paying for a repair", async () => {
    const complete = vi.fn().mockResolvedValue(modelResponse(JSON.stringify({
      ...checkpointOutput(),
      generatedAt: "wrong-time",
      coveredEntryStart: "invented-start",
      coveredEntryEnd: "invented-end",
      currentLeafId: "invented-leaf",
    })));
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
      { "checkpoint-test": { input: 1, output: 2 } },
    );
    const deterministic = {
      generatedAt: "2026-07-28T12:00:00.000Z",
      coveredEntryStart: "entry-1",
      coveredEntryEnd: "entry-1",
      currentLeafId: "entry-2",
    };

    const result = await generator.generate({
      conversation: '{"entryId":"entry-1"}',
      deterministic,
      previousRolling: null,
      maxTokens: 128,
      tokensBefore: 128,
      algorithmVersion: "checkpoint-v2-bounded",
    });

    expect(result).toMatchObject({
      validationStatus: "valid",
      attempts: 1,
      checkpoint: deterministic,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not make a paid compaction call when pricing is unavailable", async () => {
    const complete = vi.fn().mockResolvedValue(modelResponse(JSON.stringify(checkpointOutput())));
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
    );

    await expect(generator.generate({
      conversation: '{"entryId":"entry-1"}',
      deterministic: {
        generatedAt: "2026-07-28T12:00:00.000Z",
        coveredEntryStart: "entry-1",
        coveredEntryEnd: "entry-1",
        currentLeafId: "entry-2",
      },
      previousRolling: null,
      maxTokens: 128,
      tokensBefore: 128,
      algorithmVersion: "checkpoint-v2-bounded",
    })).rejects.toMatchObject({
      name: "CompactionTerminalError",
      failure: { category: "pricing_unavailable" },
    });

    expect(complete).not.toHaveBeenCalled();
  });

  it("creates an estimated non-zero receipt when the provider omits token usage", async () => {
    const response = modelResponse(JSON.stringify(checkpointOutput()));
    const complete = vi.fn().mockResolvedValue({
      id: response.id,
      model: response.model,
      content: response.content,
      finishReason: response.finishReason,
      raw: response.raw,
    });
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
      { "checkpoint-test": { input: 1, output: 2 } },
    );

    const result = await generator.generate({
      conversation: '{"entryId":"entry-1"}',
      deterministic: {
        generatedAt: "2026-07-28T12:00:00.000Z",
        coveredEntryStart: "entry-1",
        coveredEntryEnd: "entry-1",
        currentLeafId: "entry-2",
      },
      previousRolling: null,
      maxTokens: 128,
      tokensBefore: 128,
      algorithmVersion: "checkpoint-v2-bounded",
    });

    expect(result.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      pricingSource: "estimated",
    });
    expect(BigInt(result.usage?.costRawMicros ?? "0")).toBeGreaterThan(0n);
  });

  it("repairs malformed checkpoint output once and never exceeds two physical attempts", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(modelResponse("not-json"))
      .mockResolvedValueOnce(modelResponse(JSON.stringify(checkpointOutput()), { inputTokens: 5, outputTokens: 6, totalTokens: 11 }));
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
      { "checkpoint-test": { input: 1, output: 2 } },
    );

    const result = await generator.generate({
      conversation: "persisted segment",
      deterministic: {
        generatedAt: "2026-07-28T12:00:00.000Z",
        coveredEntryStart: "entry-1",
        coveredEntryEnd: "entry-1",
        currentLeafId: "entry-2",
      },
      previousRolling: null,
      maxTokens: 128,
      tokensBefore: 128,
      algorithmVersion: "checkpoint-v2-bounded",
      maxPhysicalAttempts: 2,
    });

    expect(result).toMatchObject({
      validationStatus: "repaired",
      attempts: 2,
      usage: { inputTokens: 17, outputTokens: 14, costRawMicros: "45", pricingSource: "measured" },
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.map((call) => call[0].providerAttemptOrdinal)).toEqual([1, 2]);
  });

  it("checks governance against the compaction provider and model actually selected", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const repository = new SqlSessionCompactionRepository({
      execute: async () => undefined,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM sessions s")) {
          return [{ id: job.sessionId, task_id: job.taskId, model_provider_id: "chat-provider", model: "chat-model", model_allowed: true }] as T[];
        }
        return [] as T[];
      },
    });

    await repository.load(job, {
      provider: "compaction-provider",
      model: "compaction-model",
      algorithmVersion: "algorithm-v3",
    });

    const governance = queries.find((query) => query.sql.includes("model_governance_policies selected"));
    expect(governance?.sql).toContain("selected.provider_id = $4");
    expect(governance?.sql).toContain("selected.model = $5");
    expect(governance?.params).toEqual([
      job.tenantId,
      job.sessionId,
      job.taskId,
      "compaction-provider",
      "compaction-model",
    ]);
    const checkpoints = queries.find((query) => query.sql.includes("FROM session_checkpoints"));
    expect(checkpoints?.sql).toContain("algorithm_version = $3");
    expect(checkpoints?.params).toEqual([job.tenantId, job.sessionId, "algorithm-v3"]);
  });

  it.each([
    [408, CompactionRetryableError],
    [409, CompactionTerminalError],
  ] as const)("classifies provider HTTP %i as %s", async (status, expectedError) => {
    const releasedErrors: Array<string | undefined> = [];
    const repository: SessionCompactionRepository = {
      claim: async () => true,
      load: async () => compactionState(),
      persist: async () => {
        throw new Error("persist should not be called");
      },
      release: async (_input, _leaseOwner, error) => {
        releasedErrors.push(error);
      },
    };
    const providerRequestId = `provider-request-${status}`;
    const generator: CheckpointGenerator = {
      provider: "test",
      model: "checkpoint-test",
      generate: async () => {
        throw new RouterClientError(`provider secret ${providerRequestId}`, status, "secret body", {
          requestId: providerRequestId,
        });
      },
    };
    const compactor = new DurableSessionCompactor(repository, generator, {
      leaseOwner: "test-worker",
      keepRecentTokens: 1,
    });

    const failure = compactor.compactSession(job);
    await expect(failure).rejects.toBeInstanceOf(expectedError);
    await expect(failure).rejects.not.toThrow(providerRequestId);
    expect(releasedErrors).toHaveLength(1);
    expect(JSON.parse(releasedErrors[0]!)).toEqual({
      category: status === 408 ? "provider_timeout" : "provider_permanent_client",
      status,
      publicMessage: status === 408
        ? "The compaction provider timed out."
        : "The compaction provider rejected the request.",
    });
    expect(releasedErrors[0]).not.toContain(providerRequestId);
    expect(releasedErrors[0]).not.toContain("secret body");
  });

  it("persists one immutable segment and no-ops when the same leaf is delivered again", async () => {
    let persistCalls = 0;
    let generatorCalls = 0;
    let persistedFallbackReason: string | null = null;
    const state = compactionState();
    const repository: SessionCompactionRepository = {
      claim: async () => true,
      load: async () => state,
      persist: async (input) => {
        persistCalls += 1;
        persistedFallbackReason = input.fallbackReason;
        expect(input.segmentMetrics.serializedBytes).toBe(sessionCheckpointMetrics(input.segment).serializedBytes);
        expect(input.rollingMetrics.serializedBytes).toBe(sessionCheckpointMetrics(input.rolling).serializedBytes);
        expect(input.rollingMetrics.tokensAfter).toBe(sessionCheckpointMetrics(input.rolling).tokenEstimate);
        state.previousRolling = input.rolling;
        state.priorSegments = [input.segment];
        state.latestSegmentCoveredEnd = input.segment.coveredEntryEnd;
        state.latestSegmentSourceLeafId = state.sourceLeafId;
        return { segmentCheckpointId: "segment-1", rollingCheckpointId: "rolling-1" };
      },
      release: async () => {},
    };
    const generator: CheckpointGenerator = {
      provider: "test",
      model: "checkpoint-test",
      generate: async () => {
        generatorCalls += 1;
        return {
          checkpoint: null,
          validationStatus: "fallback",
          attempts: 2,
          fallbackReason: "provider request raw-123",
        };
      },
    };
    const compactor = new DurableSessionCompactor(repository, generator, { leaseOwner: "test-worker", keepRecentTokens: 1 });

    const first = await compactor.compactSession(job);
    const replay = await compactor.compactSession(job);

    expect(first).toMatchObject({
      validationStatus: "fallback",
      segmentCheckpointId: "segment-1",
      rollingCheckpointId: "rolling-1",
      fallbackReason: "checkpoint_generation_failed",
    });
    expect(replay.noOp).toBe(true);
    expect(persistCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(persistedFallbackReason).toBe("checkpoint_generation_failed");
    expect(state.previousRolling).toMatchObject({
      schema: "berry.session-checkpoint",
      version: 2,
      goal: "Implement durable compaction.",
      currentWork: ["Implement durable compaction."],
      currentLeafId: "entry-2",
      coveredEntryEnd: "entry-1",
    } satisfies Partial<SessionCheckpointV2>);
  });

  it("does not reuse no-op or rolling state across algorithm versions", async () => {
    const states = new Map<string, CompactionSessionState>();
    let generatorCalls = 0;
    const repository: SessionCompactionRepository = {
      claim: async () => true,
      load: async (_input, selection) => {
        const state = states.get(selection.algorithmVersion)
          ?? compactionState({ algorithmVersion: selection.algorithmVersion });
        states.set(selection.algorithmVersion, state);
        return state;
      },
      persist: async (input) => {
        input.state.previousRolling = input.rolling;
        input.state.priorSegments = [input.segment];
        input.state.latestSegmentCoveredEnd = input.segment.coveredEntryEnd;
        input.state.latestSegmentSourceLeafId = input.state.sourceLeafId;
        return { segmentCheckpointId: "segment", rollingCheckpointId: "rolling" };
      },
      release: async () => {},
    };
    const generator: CheckpointGenerator = {
      provider: "test",
      model: "checkpoint-test",
      generate: async () => {
        generatorCalls += 1;
        return { checkpoint: null, validationStatus: "fallback", attempts: 0 };
      },
    };
    const compactor = new DurableSessionCompactor(repository, generator, {
      leaseOwner: "test-worker",
      keepRecentTokens: 1,
    });

    const first = await compactor.compactSession({ ...job, algorithmVersion: "algorithm-v1" });
    const newAlgorithm = await compactor.compactSession({ ...job, algorithmVersion: "algorithm-v2" });
    const replay = await compactor.compactSession({ ...job, algorithmVersion: "algorithm-v2" });

    expect(first.noOp).not.toBe(true);
    expect(newAlgorithm.noOp).not.toBe(true);
    expect(replay.noOp).toBe(true);
    expect(generatorCalls).toBe(2);
    expect(states.get("algorithm-v1")?.previousRolling).not.toBe(states.get("algorithm-v2")?.previousRolling);
  });

  it("preserves completed tool results and the active plan in a deterministic fallback checkpoint", async () => {
    let persistedSegment: SessionCheckpointV2 | null = null;
    const state = compactionState({
      sourceLeafId: "entry-4",
      entries: [
        {
          entryId: "entry-1",
          parentEntryId: null,
          entryType: "message",
          sequence: 1,
          payload: { role: "user", content: "Create the Phase 4D report." },
          isLeafMarker: false,
          createdAt: "2026-07-28T12:00:00.000Z",
        },
        {
          entryId: "entry-2",
          parentEntryId: "entry-1",
          entryType: "message",
          sequence: 2,
          payload: { role: "assistant", content: "I am extracting the template structure." },
          isLeafMarker: false,
          createdAt: "2026-07-28T12:01:00.000Z",
        },
        {
          entryId: "entry-3",
          parentEntryId: "entry-2",
          entryType: "message",
          sequence: 3,
          payload: {
            role: "toolResult",
            toolName: "read",
            content: [{ type: "text", text: "Template text extracted." }],
            isError: false,
          },
          isLeafMarker: false,
          createdAt: "2026-07-28T12:02:00.000Z",
        },
        {
          entryId: "entry-4",
          parentEntryId: "entry-3",
          entryType: "message",
          sequence: 4,
          payload: { role: "assistant", content: "Next I will build the document." },
          isLeafMarker: true,
          createdAt: "2026-07-28T12:03:00.000Z",
        },
      ],
    });
    const repository: SessionCompactionRepository = {
      claim: async () => true,
      load: async () => state,
      persist: async (input) => {
        persistedSegment = input.segment;
        return { segmentCheckpointId: "segment", rollingCheckpointId: "rolling", usageEventId: null };
      },
      release: async () => {},
    };
    const generator: CheckpointGenerator = {
      provider: "test",
      model: "checkpoint-test",
      generate: async () => ({
        checkpoint: null,
        validationStatus: "fallback",
        attempts: 1,
        fallbackReason: "checkpoint_validation_failed",
      }),
    };

    await new DurableSessionCompactor(repository, generator, {
      leaseOwner: "test-worker",
      keepRecentTokens: 1,
    }).compactSession(job);

    expect(persistedSegment).toMatchObject({
      goal: "Create the Phase 4D report.",
      completedWork: ["read: Template text extracted."],
      currentWork: ["I am extracting the template structure."],
    });
  });

  it("rejects a final rolling checkpoint whose protected identity exceeds the serialized byte limit", async () => {
    const releasedErrors: Array<string | undefined> = [];
    const persist = vi.fn();
    const oversizedCoveredStart = `entry-${"x".repeat(SESSION_CHECKPOINT_MAX_BYTES)}`;
    const repository: SessionCompactionRepository = {
      claim: async () => true,
      load: async () => compactionState({
        previousRolling: {
          ...checkpointOutput(),
          coveredEntryStart: oversizedCoveredStart,
        },
      }),
      persist,
      release: async (_input, _leaseOwner, error) => {
        releasedErrors.push(error);
      },
    };
    const generator: CheckpointGenerator = {
      provider: "test",
      model: "checkpoint-test",
      generate: async () => ({
        checkpoint: checkpointOutput(),
        validationStatus: "valid",
        attempts: 1,
      }),
    };
    const compactor = new DurableSessionCompactor(repository, generator, {
      leaseOwner: "test-worker",
      keepRecentTokens: 1,
    });

    await expect(compactor.compactSession(job)).rejects.toBeInstanceOf(CompactionTerminalError);
    expect(persist).not.toHaveBeenCalled();
    expect(releasedErrors).toHaveLength(1);
    expect(JSON.parse(releasedErrors[0]!)).toEqual({
      category: "checkpoint_invalid",
      status: null,
      publicMessage: "Compaction could not create a valid bounded checkpoint.",
    });
  });

  it("persists distinct segment and rolling token and byte metrics without double-writing turn usage", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    let checkpointId = 0;
    const repository = new SqlSessionCompactionRepository({
      execute: async () => undefined,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT lease_owner FROM session_compaction_leases")) {
          return [{ lease_owner: "lease-owner" }] as T[];
        }
        if (sql.includes("INSERT INTO session_checkpoints")) {
          checkpointId += 1;
          return [{ id: `checkpoint-${checkpointId}` }] as T[];
        }
        return [] as T[];
      },
    });
    const segment = checkpointOutput();
    const rolling = {
      ...segment,
      completedWork: [...segment.completedWork, "Older rolling work"],
      narrative: `${segment.narrative} Rolling history retained.`,
    };
    const segmentSerialized = sessionCheckpointMetrics(segment).serializedBytes;
    const rollingSerialized = sessionCheckpointMetrics(rolling).serializedBytes;

    const result = await repository.persist({
      state: compactionState({ runId: "00000000-0000-7000-8000-000000000004" }),
      leaseOwner: "lease-owner",
      segment,
      rolling,
      validationStatus: "valid",
      provider: "router",
      model: "checkpoint-test",
      rebased: false,
      algorithmVersion: "checkpoint-v2-bounded",
      segmentMetrics: { tokensBefore: 80, tokensAfter: 20, serializedBytes: segmentSerialized },
      rollingMetrics: { tokensBefore: 240, tokensAfter: 40, serializedBytes: rollingSerialized },
      physicalAttempts: 1,
      fallbackReason: null,
      usage: {
        provider: "router",
        model: "checkpoint-test",
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costRawMicros: "28",
        pricingSource: "measured",
      },
    });

    const inserts = queries.filter((query) => query.sql.includes("INSERT INTO session_checkpoints"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.sql).toContain("serialized_bytes");
    expect(inserts[0]?.params.slice(9, 12)).toEqual([80, 20, segmentSerialized]);
    expect(inserts[1]?.params.slice(9, 12)).toEqual([240, 40, rollingSerialized]);
    expect(queries.some((query) => query.sql.includes("INSERT INTO usage_events"))).toBe(false);
    expect(result.usageEventId).toBeNull();
  });
});
