import { describe, expect, it, vi } from "vitest";
import { RouterClientError, type OpenAIChatCompletionsClient } from "@berry/router-client";
import type { SessionCheckpointV2 } from "@berry/shared";
import {
  CompactionRetryableError,
  CompactionTerminalError,
  DurableSessionCompactor,
  RouterCheckpointGenerator,
  SqlSessionCompactionRepository,
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

function compactionState(): CompactionSessionState {
  return {
    tenantId: job.tenantId,
    taskId: job.taskId,
    sessionId: job.sessionId,
    sourceLeafId: "entry-2",
    modelProviderId: null,
    model: null,
    modelAllowed: true,
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
    });

    expect(generator).toMatchObject({
      provider: "dedicated-compactor",
      model: "dedicated-compaction-model",
    });
  });

  it("accepts a validated checkpoint from the first physical attempt and records usage", async () => {
    const complete = vi.fn().mockResolvedValue(modelResponse(JSON.stringify(checkpointOutput())));
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
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
        pricingSource: "estimated",
      },
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ providerAttemptOrdinal: 1 }));
    expect(reports).toEqual([]);
  });

  it("repairs malformed checkpoint output once and never exceeds two physical attempts", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(modelResponse("not-json"))
      .mockResolvedValueOnce(modelResponse(JSON.stringify(checkpointOutput()), { inputTokens: 5, outputTokens: 6, totalTokens: 11 }));
    const generator = new RouterCheckpointGenerator(
      { complete } as unknown as OpenAIChatCompletionsClient,
      "router",
      "checkpoint-test",
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

    expect(result).toMatchObject({ validationStatus: "repaired", attempts: 2, usage: { inputTokens: 17, outputTokens: 14 } });
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

    await repository.load(job, { provider: "compaction-provider", model: "compaction-model" });

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
    const generator: CheckpointGenerator = {
      provider: "test",
      model: "checkpoint-test",
      generate: async () => {
        throw new RouterClientError(`provider status ${status}`, status);
      },
    };
    const compactor = new DurableSessionCompactor(repository, generator, {
      leaseOwner: "test-worker",
      keepRecentTokens: 1,
    });

    await expect(compactor.compactSession(job)).rejects.toBeInstanceOf(expectedError);
    expect(releasedErrors).toEqual([`provider status ${status}`]);
  });

  it("persists one immutable segment and no-ops when the same leaf is delivered again", async () => {
    let persistCalls = 0;
    let generatorCalls = 0;
    const state = compactionState();
    const repository: SessionCompactionRepository = {
      claim: async () => true,
      load: async () => state,
      persist: async (input) => {
        persistCalls += 1;
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
        return { checkpoint: null, validationStatus: "fallback", attempts: 2 };
      },
    };
    const compactor = new DurableSessionCompactor(repository, generator, { leaseOwner: "test-worker", keepRecentTokens: 1 });

    const first = await compactor.compactSession(job);
    const replay = await compactor.compactSession(job);

    expect(first).toMatchObject({
      validationStatus: "fallback",
      segmentCheckpointId: "segment-1",
      rollingCheckpointId: "rolling-1",
    });
    expect(replay.noOp).toBe(true);
    expect(persistCalls).toBe(1);
    expect(generatorCalls).toBe(1);
    expect(state.previousRolling).toMatchObject({
      schema: "berry.session-checkpoint",
      version: 2,
      goal: "Implement durable compaction.",
      currentLeafId: "entry-2",
      coveredEntryEnd: "entry-1",
    } satisfies Partial<SessionCheckpointV2>);
  });
});
