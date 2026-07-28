import { describe, expect, it } from "vitest";
import {
  mergeSessionCheckpoints,
  parseSessionCheckpoint,
  rebaseSessionCheckpoint,
  type CheckpointDeterministicFields,
  type SessionCheckpointV2,
} from "./index.ts";

function checkpoint(overrides: Partial<SessionCheckpointV2> = {}): SessionCheckpointV2 {
  return {
    schema: "berry.session-checkpoint",
    version: 2,
    generatedAt: "2026-07-28T12:00:00.000Z",
    goal: "Ship durable compaction",
    successCriteria: [],
    constraints: [],
    standingInstructions: [],
    completedWork: [],
    currentWork: [],
    blockers: [],
    waitingState: null,
    decisions: [],
    unresolvedQuestions: [],
    nextAction: "Continue",
    filesRead: [],
    filesModified: [],
    artifacts: [],
    commands: [],
    toolCalls: [],
    approvals: [],
    promptManifestHash: null,
    retrievalSnapshotIds: [],
    coveredEntryStart: "entry-1",
    coveredEntryEnd: "entry-2",
    currentLeafId: "entry-2",
    narrative: "Checkpoint",
    ...overrides,
  };
}

function deterministic(overrides: Partial<CheckpointDeterministicFields> = {}): CheckpointDeterministicFields {
  return {
    generatedAt: "2026-07-28T12:00:00.000Z",
    coveredEntryStart: "entry-1",
    coveredEntryEnd: "entry-2",
    currentLeafId: "entry-2",
    ...overrides,
  };
}

describe("portable session checkpoints", () => {
  it("validates a fenced version 2 checkpoint", () => {
    const parsed = parseSessionCheckpoint(`\`\`\`json\n${JSON.stringify(checkpoint())}\n\`\`\``);
    expect(parsed.issues).toEqual([]);
    expect(parsed.checkpoint).toMatchObject({
      schema: "berry.session-checkpoint",
      version: 2,
      currentLeafId: "entry-2",
    });
  });

  it("preserves durable constraints while the latest segment owns current state", () => {
    const previous = checkpoint({
      constraints: ["Never deploy production"],
      completedWork: ["Packet 1"],
      currentWork: ["Packet 2"],
      nextAction: "Old action",
    });
    const segment = checkpoint({
      constraints: [],
      completedWork: ["Packet 2"],
      currentWork: ["Packet 3"],
      nextAction: "Implement Packet 3",
      coveredEntryStart: "entry-3",
      coveredEntryEnd: "entry-4",
      currentLeafId: "entry-4",
    });
    const merged = mergeSessionCheckpoints(previous, segment, deterministic({
      coveredEntryStart: previous.coveredEntryStart,
      coveredEntryEnd: "entry-4",
      currentLeafId: "entry-4",
    }));
    expect(merged.constraints).toEqual(["Never deploy production"]);
    expect(merged.completedWork).toEqual(["Packet 1", "Packet 2"]);
    expect(merged.currentWork).toEqual(["Packet 3"]);
    expect(merged.nextAction).toBe("Implement Packet 3");
  });

  it("rebases rolling state from immutable segments in order", () => {
    const segments = [
      checkpoint({ completedWork: ["one"], coveredEntryStart: "entry-1", coveredEntryEnd: "entry-2" }),
      checkpoint({
        completedWork: ["two"],
        currentWork: ["three"],
        coveredEntryStart: "entry-3",
        coveredEntryEnd: "entry-4",
        currentLeafId: "entry-4",
      }),
    ];
    const rebased = rebaseSessionCheckpoint(segments, deterministic({
      coveredEntryStart: "entry-1",
      coveredEntryEnd: "entry-4",
      currentLeafId: "entry-4",
    }));
    expect(rebased.completedWork).toEqual(["one", "two"]);
    expect(rebased.currentWork).toEqual(["three"]);
    expect(rebased.coveredEntryStart).toBe("entry-1");
    expect(rebased.coveredEntryEnd).toBe("entry-4");
  });
});
