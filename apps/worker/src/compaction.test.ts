import { describe, expect, it } from "vitest";
import type { SessionCheckpointV2 } from "@berry/shared";
import {
  DurableSessionCompactor,
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

describe("durable session compactor", () => {
  it("persists one immutable segment and no-ops when the same leaf is delivered again", async () => {
    let persistCalls = 0;
    let generatorCalls = 0;
    const state: CompactionSessionState = {
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
