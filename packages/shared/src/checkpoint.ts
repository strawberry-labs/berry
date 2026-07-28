import {
  SessionCheckpointV2Schema,
  type SessionCheckpointV2,
} from "./durable-context.ts";

export interface CheckpointDeterministicFields {
  generatedAt: string;
  coveredEntryStart: string | null;
  coveredEntryEnd: string | null;
  currentLeafId: string | null;
  filesRead?: readonly string[];
  filesModified?: readonly string[];
  commands?: SessionCheckpointV2["commands"];
  toolCalls?: SessionCheckpointV2["toolCalls"];
  approvals?: SessionCheckpointV2["approvals"];
  promptManifestHash?: string | null;
  retrievalSnapshotIds?: readonly string[];
}

export interface CheckpointParseResult {
  checkpoint: SessionCheckpointV2 | null;
  issues: readonly string[];
}

export function parseSessionCheckpoint(value: string | unknown): CheckpointParseResult {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(stripJsonCodeFence(value));
    } catch (error) {
      return {
        checkpoint: null,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
  const parsed = SessionCheckpointV2Schema.safeParse(candidate);
  if (parsed.success) return { checkpoint: parsed.data, issues: [] };
  return {
    checkpoint: null,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "checkpoint"}: ${issue.message}`),
  };
}

export function emptySessionCheckpoint(
  deterministic: CheckpointDeterministicFields,
  narrative = "",
): SessionCheckpointV2 {
  return applyCheckpointDeterminism({
    schema: "berry.session-checkpoint",
    version: 2,
    generatedAt: deterministic.generatedAt,
    goal: "",
    successCriteria: [],
    constraints: [],
    standingInstructions: [],
    completedWork: [],
    currentWork: [],
    blockers: [],
    waitingState: null,
    decisions: [],
    unresolvedQuestions: [],
    nextAction: "",
    filesRead: [],
    filesModified: [],
    artifacts: [],
    commands: [],
    toolCalls: [],
    approvals: [],
    promptManifestHash: null,
    retrievalSnapshotIds: [],
    coveredEntryStart: null,
    coveredEntryEnd: null,
    currentLeafId: null,
    narrative,
  }, deterministic);
}

export function applyCheckpointDeterminism(
  checkpoint: SessionCheckpointV2,
  deterministic: CheckpointDeterministicFields,
): SessionCheckpointV2 {
  return SessionCheckpointV2Schema.parse({
    ...checkpoint,
    generatedAt: deterministic.generatedAt,
    filesRead: unique([...(checkpoint.filesRead ?? []), ...(deterministic.filesRead ?? [])]),
    filesModified: unique([...(checkpoint.filesModified ?? []), ...(deterministic.filesModified ?? [])]),
    commands: dedupeBy(
      [...checkpoint.commands, ...(deterministic.commands ?? [])],
      (item) => `${item.command}\0${item.status}\0${item.result}`,
    ),
    toolCalls: mergeToolCalls(checkpoint.toolCalls, deterministic.toolCalls ?? []),
    approvals: dedupeBy(
      [...checkpoint.approvals, ...(deterministic.approvals ?? [])],
      (item) => item.approvalId,
    ),
    promptManifestHash: deterministic.promptManifestHash ?? checkpoint.promptManifestHash,
    retrievalSnapshotIds: unique([
      ...checkpoint.retrievalSnapshotIds,
      ...(deterministic.retrievalSnapshotIds ?? []),
    ]),
    coveredEntryStart: deterministic.coveredEntryStart,
    coveredEntryEnd: deterministic.coveredEntryEnd,
    currentLeafId: deterministic.currentLeafId,
  });
}

/**
 * Merge an immutable segment into the rolling checkpoint. The segment owns
 * current state; durable facts and provenance are accumulated.
 */
export function mergeSessionCheckpoints(
  previous: SessionCheckpointV2 | null,
  segment: SessionCheckpointV2,
  deterministic: CheckpointDeterministicFields,
): SessionCheckpointV2 {
  if (!previous) return applyCheckpointDeterminism(segment, deterministic);
  const merged: SessionCheckpointV2 = {
    ...segment,
    generatedAt: deterministic.generatedAt,
    goal: segment.goal || previous.goal,
    successCriteria: unique([...previous.successCriteria, ...segment.successCriteria]),
    constraints: unique([...previous.constraints, ...segment.constraints]),
    standingInstructions: unique([...previous.standingInstructions, ...segment.standingInstructions]),
    completedWork: unique([...previous.completedWork, ...segment.completedWork]),
    currentWork: segment.currentWork.length > 0 ? segment.currentWork : previous.currentWork,
    blockers: segment.blockers,
    waitingState: segment.waitingState,
    decisions: dedupeBy([...previous.decisions, ...segment.decisions], checkpointSourceKey),
    unresolvedQuestions: unique([...previous.unresolvedQuestions, ...segment.unresolvedQuestions]),
    nextAction: segment.nextAction || previous.nextAction,
    filesRead: unique([...previous.filesRead, ...segment.filesRead]),
    filesModified: unique([...previous.filesModified, ...segment.filesModified]),
    artifacts: dedupeBy([...previous.artifacts, ...segment.artifacts], (item) => item.id),
    commands: dedupeBy(
      [...previous.commands, ...segment.commands],
      (item) => `${item.command}\0${item.status}\0${item.result}`,
    ),
    toolCalls: mergeToolCalls(previous.toolCalls, segment.toolCalls),
    approvals: dedupeBy([...previous.approvals, ...segment.approvals], (item) => item.approvalId),
    promptManifestHash: segment.promptManifestHash ?? previous.promptManifestHash,
    retrievalSnapshotIds: unique([
      ...previous.retrievalSnapshotIds,
      ...segment.retrievalSnapshotIds,
    ]),
    coveredEntryStart: previous.coveredEntryStart ?? segment.coveredEntryStart,
    coveredEntryEnd: segment.coveredEntryEnd,
    currentLeafId: segment.currentLeafId,
    narrative: segment.narrative || previous.narrative,
  };
  return applyCheckpointDeterminism(merged, {
    ...deterministic,
    coveredEntryStart: previous.coveredEntryStart ?? deterministic.coveredEntryStart,
  });
}

export function rebaseSessionCheckpoint(
  segments: readonly SessionCheckpointV2[],
  deterministic: CheckpointDeterministicFields,
): SessionCheckpointV2 {
  let rolling: SessionCheckpointV2 | null = null;
  for (const segment of segments) {
    rolling = mergeSessionCheckpoints(rolling, segment, {
      ...deterministic,
      generatedAt: segment.generatedAt,
      coveredEntryStart: segment.coveredEntryStart,
      coveredEntryEnd: segment.coveredEntryEnd,
      currentLeafId: segment.currentLeafId,
      filesRead: [],
      filesModified: [],
      commands: [],
      toolCalls: [],
      approvals: [],
      retrievalSnapshotIds: [],
    });
  }
  return applyCheckpointDeterminism(
    rolling ?? emptySessionCheckpoint(deterministic),
    deterministic,
  );
}

export function checkpointFallback(
  previous: SessionCheckpointV2 | null,
  deterministic: CheckpointDeterministicFields,
  options: {
    goal?: string;
    nextAction?: string;
    narrative?: string;
    completedWork?: readonly string[];
    currentWork?: readonly string[];
  } = {},
): SessionCheckpointV2 {
  const delta = emptySessionCheckpoint(deterministic, options.narrative ?? "");
  delta.goal = options.goal?.trim() ?? "";
  delta.nextAction = options.nextAction?.trim() ?? "";
  delta.completedWork = unique(options.completedWork ?? []);
  delta.currentWork = unique(options.currentWork ?? []);
  return mergeSessionCheckpoints(previous, delta, deterministic);
}

function mergeToolCalls(
  earlier: SessionCheckpointV2["toolCalls"],
  later: SessionCheckpointV2["toolCalls"],
): SessionCheckpointV2["toolCalls"] {
  const byId = new Map<string, SessionCheckpointV2["toolCalls"][number]>();
  for (const item of earlier) byId.set(item.toolCallId, item);
  for (const item of later) byId.set(item.toolCallId, item);
  return [...byId.values()];
}

function checkpointSourceKey(
  value: SessionCheckpointV2["decisions"][number],
): string {
  return JSON.stringify(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const output = new Map<string, T>();
  for (const value of values) output.set(key(value), value);
  return [...output.values()];
}

function stripJsonCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
