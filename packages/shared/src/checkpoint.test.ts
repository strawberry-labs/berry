import { describe, expect, it } from "vitest";
import {
  mergeSessionCheckpoints,
  parseSessionCheckpoint,
  rebaseSessionCheckpoint,
  SESSION_CHECKPOINT_MAX_BYTES,
  sessionCheckpointMetrics,
  validateSessionCheckpoint,
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

  it("clears current work, resolved questions, and the next action", () => {
    const previous = checkpoint({
      currentWork: ["Investigate queue retries"],
      unresolvedQuestions: ["Which environment?"],
      nextAction: "Wait for the environment answer",
    });
    const segment = checkpoint({
      completedWork: ["Queue retries fixed"],
      currentWork: [],
      unresolvedQuestions: [],
      nextAction: "",
    });

    const merged = mergeSessionCheckpoints(previous, segment, deterministic());

    expect(merged.currentWork).toEqual([]);
    expect(merged.unresolvedQuestions).toEqual([]);
    expect(merged.nextAction).toBe("");
    expect(merged.completedWork).toEqual(["Queue retries fixed"]);
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

  it("bounds merged rolling history by exact serialized bytes while preserving the latest segment", () => {
    const previousWork = Array.from({ length: 70 }, (_, index) => `previous-${index}-${"p".repeat(760)}`);
    const latestWork = Array.from({ length: 20 }, (_, index) => `latest-${index}-${"l".repeat(760)}`);
    const previous = checkpoint({ completedWork: previousWork });
    const segment = checkpoint({
      completedWork: latestWork,
      coveredEntryStart: "entry-3",
      coveredEntryEnd: "entry-4",
      currentLeafId: "entry-4",
    });

    expect(sessionCheckpointMetrics(previous).serializedBytes).toBeLessThan(SESSION_CHECKPOINT_MAX_BYTES);
    expect(sessionCheckpointMetrics(segment).serializedBytes).toBeLessThan(SESSION_CHECKPOINT_MAX_BYTES);

    const merged = mergeSessionCheckpoints(previous, segment, deterministic({
      coveredEntryStart: "entry-1",
      coveredEntryEnd: "entry-4",
      currentLeafId: "entry-4",
    }));
    const metrics = sessionCheckpointMetrics(merged);

    expect(metrics.serializedBytes).toBeLessThanOrEqual(SESSION_CHECKPOINT_MAX_BYTES);
    expect(latestWork.every((item) => merged.completedWork.includes(item))).toBe(true);
    expect(merged.completedWork.length).toBeLessThan(previousWork.length + latestWork.length);
    expect(validateSessionCheckpoint(merged, deterministic({
      coveredEntryStart: "entry-1",
      coveredEntryEnd: "entry-4",
      currentLeafId: "entry-4",
    })).issues).toEqual([]);
  });

  it("derives token estimates from the exact UTF-8 checkpoint serialization", () => {
    const value = checkpoint({ narrative: "Checkpoint 😀" });
    const serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    expect(sessionCheckpointMetrics(value)).toEqual({
      serializedBytes,
      tokenEstimate: Math.ceil(serializedBytes / 4),
    });
  });

  it("rejects unbounded output, missing tool-call coverage, and pathological reductions", () => {
    const oversized = checkpoint({
      successCriteria: Array.from({ length: 257 }, (_, index) => `criterion-${index}`),
    });
    expect(validateSessionCheckpoint(oversized, deterministic()).issues.join(" ")).toContain("maximum is 256");

    const requiredToolCall = {
      toolCallId: "tool-1",
      toolName: "write_file",
      retryClass: "idempotent_with_key" as const,
      idempotencyKey: "key-1",
      outcome: "completed" as const,
    };
    const missingCoverage = validateSessionCheckpoint(
      checkpoint(),
      deterministic({ toolCalls: [requiredToolCall] }),
    );
    expect(missingCoverage.issues.join(" ")).toContain("missing tool-call coverage");

    const pathological = validateSessionCheckpoint(
      checkpoint({ toolCalls: [requiredToolCall] }),
      deterministic({ toolCalls: [requiredToolCall] }),
      { tokensBefore: 1_000, tokensAfter: 950 },
    );
    expect(pathological.issues.join(" ")).toContain("reduce the persisted context enough");
  });
});
