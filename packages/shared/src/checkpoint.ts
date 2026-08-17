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

export const SESSION_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const SESSION_CHECKPOINT_MAX_ITEMS = 256;

export interface SessionCheckpointMetrics {
  serializedBytes: number;
  tokenEstimate: number;
}

export interface CheckpointValidationOptions {
  maxBytes?: number;
  maxItems?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  minimumReductionRatio?: number;
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

/** Validate a generated checkpoint before it can advance the covered leaf. */
export function validateSessionCheckpoint(
  checkpoint: SessionCheckpointV2,
  deterministic: CheckpointDeterministicFields,
  options: CheckpointValidationOptions = {},
): CheckpointParseResult {
  const maxBytes = Math.max(1, options.maxBytes ?? SESSION_CHECKPOINT_MAX_BYTES);
  const maxItems = Math.max(1, options.maxItems ?? SESSION_CHECKPOINT_MAX_ITEMS);
  const issues: string[] = [];
  const metrics = sessionCheckpointMetrics(checkpoint);
  if (metrics.serializedBytes > maxBytes) {
    issues.push(`checkpoint exceeds ${maxBytes} bytes`);
  }
  for (const [field, value] of Object.entries(checkpoint)) {
    if (!Array.isArray(value) || value.length <= maxItems) continue;
    issues.push(`${field} contains ${value.length} items; maximum is ${maxItems}`);
  }
  if (checkpoint.coveredEntryStart !== deterministic.coveredEntryStart) {
    issues.push("coveredEntryStart does not match persisted evidence");
  }
  if (checkpoint.coveredEntryEnd !== deterministic.coveredEntryEnd) {
    issues.push("coveredEntryEnd does not match persisted evidence");
  }
  if (checkpoint.currentLeafId !== deterministic.currentLeafId) {
    issues.push("currentLeafId does not match persisted evidence");
  }
  const toolCalls = new Set(checkpoint.toolCalls.map((call) => call.toolCallId));
  for (const required of deterministic.toolCalls ?? []) {
    if (!toolCalls.has(required.toolCallId)) issues.push(`missing tool-call coverage for ${required.toolCallId}`);
  }
  if (
    options.tokensBefore !== undefined
    && options.tokensAfter !== undefined
    && options.tokensBefore >= 256
    && options.tokensAfter > options.tokensBefore * (1 - (options.minimumReductionRatio ?? 0.1))
  ) {
    issues.push("checkpoint does not reduce the persisted context enough");
  }
  return issues.length === 0
    ? { checkpoint, issues: [] }
    : { checkpoint: null, issues };
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
  if (!previous) {
    return boundSessionCheckpoint(
      applyCheckpointDeterminism(segment, deterministic),
      segment,
      deterministic,
    );
  }
  const merged: SessionCheckpointV2 = {
    ...segment,
    generatedAt: deterministic.generatedAt,
    goal: segment.goal || previous.goal,
    successCriteria: boundedUnique([...previous.successCriteria, ...segment.successCriteria], 128),
    constraints: boundedUnique([...previous.constraints, ...segment.constraints], 128),
    standingInstructions: boundedUnique([...previous.standingInstructions, ...segment.standingInstructions], 128),
    completedWork: boundedUnique([...previous.completedWork, ...segment.completedWork], 256),
    currentWork: segment.currentWork,
    blockers: segment.blockers,
    waitingState: segment.waitingState,
    decisions: boundedObjects(dedupeBy([...previous.decisions, ...segment.decisions], checkpointSourceKey), 128),
    unresolvedQuestions: segment.unresolvedQuestions,
    nextAction: segment.nextAction,
    filesRead: boundedUnique([...previous.filesRead, ...segment.filesRead], 256),
    filesModified: boundedUnique([...previous.filesModified, ...segment.filesModified], 256),
    artifacts: boundedObjects(dedupeBy([...previous.artifacts, ...segment.artifacts], (item) => item.id), 256),
    commands: boundedObjects(dedupeBy(
      [...previous.commands, ...segment.commands],
      (item) => `${item.command}\0${item.status}\0${item.result}`,
    ), 128),
    toolCalls: mergeToolCalls(previous.toolCalls, segment.toolCalls),
    approvals: boundedObjects(dedupeBy([...previous.approvals, ...segment.approvals], (item) => item.approvalId), 256),
    promptManifestHash: segment.promptManifestHash ?? previous.promptManifestHash,
    retrievalSnapshotIds: boundedUnique([
      ...previous.retrievalSnapshotIds,
      ...segment.retrievalSnapshotIds,
    ], 128),
    coveredEntryStart: previous.coveredEntryStart ?? segment.coveredEntryStart,
    coveredEntryEnd: segment.coveredEntryEnd,
    currentLeafId: segment.currentLeafId,
    narrative: (segment.narrative || previous.narrative).slice(-8_000),
  };
  const rollingDeterministic = {
    ...deterministic,
    coveredEntryStart: previous.coveredEntryStart ?? deterministic.coveredEntryStart,
  };
  return boundSessionCheckpoint(
    applyCheckpointDeterminism(merged, rollingDeterministic),
    segment,
    rollingDeterministic,
  );
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
  const latest = segments.at(-1) ?? emptySessionCheckpoint(deterministic);
  return boundSessionCheckpoint(
    applyCheckpointDeterminism(
      rolling ?? latest,
      deterministic,
    ),
    latest,
    deterministic,
  );
}

/** Measure the exact UTF-8 serialization persisted for a checkpoint. */
export function sessionCheckpointMetrics(checkpoint: SessionCheckpointV2): SessionCheckpointMetrics {
  const serializedBytes = utf8ByteLength(JSON.stringify(checkpoint));
  return {
    serializedBytes,
    tokenEstimate: Math.ceil(serializedBytes / 4),
  };
}

/**
 * Remove oldest accumulated facts until a rolling checkpoint fits the durable
 * byte limit. Facts from the newest immutable segment and deterministic
 * evidence are never selected for removal; callers still validate the result
 * in case that protected evidence alone is too large.
 */
export function boundSessionCheckpoint(
  checkpoint: SessionCheckpointV2,
  latestSegment: SessionCheckpointV2,
  deterministic: CheckpointDeterministicFields,
  maxBytes = SESSION_CHECKPOINT_MAX_BYTES,
): SessionCheckpointV2 {
  const bounded = cloneCheckpoint(checkpoint);
  const byteLimit = Math.max(1, Math.floor(maxBytes));
  if (sessionCheckpointMetrics(bounded).serializedBytes <= byteLimit) return bounded;

  const shrinkers: Array<() => boolean> = [
    () => removeOldestUnprotected(
      bounded.retrievalSnapshotIds,
      protectedStringKeys(latestSegment.retrievalSnapshotIds, deterministic.retrievalSnapshotIds),
      (value) => value,
    ),
    () => removeOldestUnprotected(
      bounded.filesRead,
      protectedStringKeys(latestSegment.filesRead, deterministic.filesRead),
      (value) => value,
    ),
    () => removeOldestUnprotected(
      bounded.commands,
      protectedObjectKeys(latestSegment.commands, deterministic.commands, commandKey),
      commandKey,
    ),
    () => removeOldestUnprotected(
      bounded.approvals,
      protectedObjectKeys(latestSegment.approvals, deterministic.approvals, (value) => value.approvalId),
      (value) => value.approvalId,
    ),
    () => removeOldestUnprotected(
      bounded.artifacts,
      protectedObjectKeys(latestSegment.artifacts, undefined, (value) => value.id),
      (value) => value.id,
    ),
    () => removeOldestUnprotected(
      bounded.toolCalls,
      protectedObjectKeys(latestSegment.toolCalls, deterministic.toolCalls, (value) => value.toolCallId),
      (value) => value.toolCallId,
    ),
    () => removeOldestUnprotected(
      bounded.filesModified,
      protectedStringKeys(latestSegment.filesModified, deterministic.filesModified),
      (value) => value,
    ),
    () => removeOldestUnprotected(
      bounded.completedWork,
      protectedStringKeys(latestSegment.completedWork),
      (value) => value,
    ),
    () => removeOldestUnprotected(
      bounded.decisions,
      protectedObjectKeys(latestSegment.decisions, undefined, checkpointSourceKey),
      checkpointSourceKey,
    ),
    () => removeOldestUnprotected(
      bounded.successCriteria,
      protectedStringKeys(latestSegment.successCriteria),
      (value) => value,
    ),
    () => removeOldestUnprotected(
      bounded.standingInstructions,
      protectedStringKeys(latestSegment.standingInstructions),
      (value) => value,
    ),
    () => removeOldestUnprotected(
      bounded.constraints,
      protectedStringKeys(latestSegment.constraints),
      (value) => value,
    ),
  ];

  for (const shrink of shrinkers) {
    while (shrink()) {
      if (sessionCheckpointMetrics(bounded).serializedBytes <= byteLimit) return bounded;
    }
  }

  if (bounded.goal !== latestSegment.goal) bounded.goal = latestSegment.goal;
  if (sessionCheckpointMetrics(bounded).serializedBytes <= byteLimit) return bounded;
  if (bounded.narrative !== latestSegment.narrative) bounded.narrative = latestSegment.narrative;
  return bounded;
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
  return boundedObjects([...byId.values()], 256);
}

function cloneCheckpoint(checkpoint: SessionCheckpointV2): SessionCheckpointV2 {
  return {
    ...checkpoint,
    successCriteria: [...checkpoint.successCriteria],
    constraints: [...checkpoint.constraints],
    standingInstructions: [...checkpoint.standingInstructions],
    completedWork: [...checkpoint.completedWork],
    currentWork: [...checkpoint.currentWork],
    blockers: [...checkpoint.blockers],
    decisions: checkpoint.decisions.map((value) => ({ ...value })),
    unresolvedQuestions: [...checkpoint.unresolvedQuestions],
    filesRead: [...checkpoint.filesRead],
    filesModified: [...checkpoint.filesModified],
    artifacts: checkpoint.artifacts.map((value) => ({ ...value })),
    commands: checkpoint.commands.map((value) => ({ ...value })),
    toolCalls: checkpoint.toolCalls.map((value) => ({ ...value })),
    approvals: checkpoint.approvals.map((value) => ({ ...value })),
    retrievalSnapshotIds: [...checkpoint.retrievalSnapshotIds],
  };
}

function protectedStringKeys(
  primary: readonly string[],
  secondary: readonly string[] = [],
): Set<string> {
  return new Set([...primary, ...secondary]);
}

function protectedObjectKeys<T>(
  primary: readonly T[],
  secondary: readonly T[] | undefined,
  key: (value: T) => string,
): Set<string> {
  return new Set([...primary, ...(secondary ?? [])].map(key));
}

function removeOldestUnprotected<T>(
  values: T[],
  protectedKeys: ReadonlySet<string>,
  key: (value: T) => string,
): boolean {
  const index = values.findIndex((value) => !protectedKeys.has(key(value)));
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function commandKey(value: SessionCheckpointV2["commands"][number]): string {
  return `${value.command}\0${value.status}\0${value.result}`;
}

function checkpointSourceKey(
  value: SessionCheckpointV2["decisions"][number],
): string {
  return JSON.stringify(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function boundedUnique(values: readonly string[], limit: number): string[] {
  const normalized = unique(values);
  return normalized.length <= limit ? normalized : normalized.slice(-limit);
}

function boundedObjects<T>(values: readonly T[], limit: number): T[] {
  return values.length <= limit ? [...values] : values.slice(-limit);
}

function dedupeBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const output = new Map<string, T>();
  for (const value of values) output.set(key(value), value);
  return [...output.values()];
}

function stripJsonCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
