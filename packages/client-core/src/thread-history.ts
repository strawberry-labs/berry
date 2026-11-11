import type { AgentStreamEvent, Message, MessageHistoryPage, Task, TurnState } from "@berry/shared";
import { IDLE, reduceStream, type StreamState } from "./thread-stream.ts";

type StreamEvent = AgentStreamEvent;

/**
 * Transcript paging and durable-turn bookkeeping shared by the web shell and
 * the native app, so both reconcile history and live runs the same way.
 */

/** Durable run metadata changes at lifecycle/tool boundaries, not per token or
 * progressive tool/image output. Those high-frequency payloads belong only in
 * the per-session stream store; updating shell state for them would wake the
 * navigation, management, and dialog trees. */
export function shouldUpdateDurableStateForEvent(event: StreamEvent): boolean {
  return event.kind !== "message.delta"
    && event.kind !== "tool.update"
    && event.kind !== "image.partial";
}

export function mergeMessagePage(
  current: Message[],
  incoming: Message[],
  direction: "replace" | "prepend" | "append",
): Message[] {
  const ordered = direction === "prepend" ? [...incoming, ...current] : direction === "append" ? [...current, ...incoming] : incoming;
  const byId = new Map<string, Message>();
  // Keep the server copy for duplicate IDs. This matters when a settled page
  // overlaps an optimistic/stream projection while older rows are prepended.
  for (const message of direction === "prepend" ? [...current, ...incoming] : ordered) byId.set(message.id, message);
  const seen = new Set<string>();
  return ordered.filter((message) => {
    if (seen.has(message.id)) return false;
    if (byId.get(message.id) !== message) return false;
    seen.add(message.id);
    return true;
  });
}

/**
 * Replace the bounded newest page without discarding older pages already
 * materialized in the shell. The first overlap identifies the retained prefix;
 * a zero-row server page is authoritative and drops every settled row except
 * still-pending optimistic submissions.
 */
export function mergeRefreshedMessagePage(
  current: Message[],
  serverMessages: Message[],
  reconciledMessages: Message[],
  options: { preserveNoOverlap?: boolean } = {},
): Message[] {
  if (serverMessages.length === 0) return reconciledMessages;
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const firstOverlap = current.findIndex((message) => serverIds.has(message.id));
  // A page with no overlap is normally a new bounded snapshot (for example
  // after an external truncate). Revisit loads can also legitimately have no
  // overlap when a large append moved the newest window past the cached tail;
  // callers opt into retaining that known cached prefix for that case.
  const retainedPrefix = firstOverlap < 0
    ? (options.preserveNoOverlap ? current : [])
    : current.slice(0, firstOverlap);
  return mergeMessagePage(retainedPrefix, reconciledMessages, "append");
}

export function historyRevisionChanged(previous: string | null, next: string | null): boolean {
  return previous !== next;
}

export function historyDeletionRevisionChanged(previous: string | null, next: string | null): boolean {
  return previous !== next;
}

/**
 * Older API instances return the original unbounded message array. The API
 * client wraps it as a page with no sequence metadata; it must be treated as
 * a complete compatibility snapshot, never as an after-cursor delta.
 */
export function isLegacyMessageHistoryPage(page: MessageHistoryPage): boolean {
  return page.newestSequence === null && page.cursorPresent === null;
}

export function replayDurableStreamState(state: TurnState): StreamState {
  const parsedStartedAt = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
  const initialState: StreamState = state.active
    && state.turnId
    && Number.isFinite(parsedStartedAt)
    ? { ...IDLE, turnId: state.turnId, turnStartedAt: parsedStartedAt }
    : IDLE;
  const replayEvents = state.active
    && state.turnId
    && !state.bufferedEvents.some((event) => event.kind === "turn.start")
    ? [{
        kind: "turn.start" as const,
        turnId: state.turnId,
        ...(state.continuation ? { continuation: true } : {}),
      }, ...state.bufferedEvents]
    : state.bufferedEvents;
  return replayEvents.reduce(
    (streamState, event) => reduceStream(streamState, event),
    initialState,
  );
}

export function reduceDurableTurnState(
  previous: TurnState | undefined,
  event: StreamEvent,
): TurnState | null {
  const turnId = event.kind === "turn.start" ? event.turnId : previous?.turnId ?? null;
  if (!turnId) return null;
  const base: TurnState = previous ?? {
    active: true,
    turnId,
    bufferedEvents: [],
    replayOnly: false,
    owner: null,
    runState: "queued",
    waitingReason: null,
    nextAction: null,
    error: null,
  };
  if (event.kind === "turn.start") {
    return {
      ...base,
      active: true,
      turnId,
      continuation: event.continuation === true,
      runState: "queued",
      nextAction: "Waiting for worker",
      error: null,
    };
  }
  if (event.kind === "message.start" || event.kind === "message.delta" || event.kind === "message.end") {
    return { ...base, active: true, runState: "calling_model", waitingReason: null, nextAction: "Calling model" };
  }
  if (event.kind === "tool.start" || event.kind === "tool.update" || event.kind === "tool.end") {
    return { ...base, active: true, runState: "executing_tool", waitingReason: null, nextAction: "Running tool" };
  }
  if (event.kind === "browser.handoff") {
    return event.state === "ready"
      ? { ...base, active: true, runState: "waiting", waitingReason: "browser_handoff", nextAction: "Browser needs help. Take control to continue." }
      : { ...base, active: true, runState: "calling_model", waitingReason: null, nextAction: "Continuing after human browser control" };
  }
  if (event.kind === "approval.request") {
    return { ...base, active: true, runState: "waiting", waitingReason: "approval", nextAction: "Review the pending action to continue" };
  }
  if (event.kind === "question.request") {
    return { ...base, active: true, runState: "waiting", waitingReason: "user_input", nextAction: "Answer the question below to continue" };
  }
  if (event.kind === "approval.resolved" || event.kind === "question.answered") {
    return { ...base, active: true, runState: "executing_tool", waitingReason: null, nextAction: "Resuming the durable run" };
  }
  if (event.kind === "session.note" && event.note === "compacted") {
    return { ...base, active: true, runState: "calling_model", waitingReason: null, nextAction: "Continuing with compacted context" };
  }
  if (event.kind === "error") {
    return { ...base, error: event.message };
  }
  if (event.kind === "turn.end") {
    return {
      ...base,
      active: false,
      runState: event.status,
      waitingReason: null,
      nextAction: null,
    };
  }
  return base;
}

export function reconcileAcceptedTurnState(
  previous: TurnState | undefined,
  pendingTurnId: string,
  acceptedTurnId: string,
  continuation: boolean,
): TurnState {
  const queued: TurnState = {
    active: true,
    turnId: acceptedTurnId,
    continuation,
    bufferedEvents: [],
    replayOnly: false,
    owner: null,
    runState: "queued",
    waitingReason: null,
    nextAction: "Waiting for worker",
    error: null,
  };
  if (!previous?.active) return queued;
  if (previous.turnId !== pendingTurnId && previous.turnId !== acceptedTurnId) return queued;
  if (!previous.runState || previous.runState === "queued" || previous.runState === "assembling_context") {
    return queued;
  }
  return {
    ...previous,
    turnId: acceptedTurnId,
    continuation,
  };
}

export function durableTurnPhase(state: TurnState | undefined): string | undefined {
  if (!state?.active) return undefined;
  if (state.nextAction === "Submitting the turn") return "Submitting";
  if (state.nextAction === "Preparing context" || state.runState === "assembling_context") return "Preparing context";
  if (state.runState === "queued") return "Waiting for worker";
  if (state.runState === "calling_model") return "Calling model";
  if (state.runState === "executing_tool") return "Running tool";
  return state.nextAction ?? undefined;
}

export function mergeTaskSnapshots(current: Task[], server: Task[]): Task[] {
  const serverById = new Map(server.map((task) => [task.id, task]));
  const currentIds = new Set(current.map((task) => task.id));
  return [
    ...current.map((task) => serverById.get(task.id) ?? task),
    ...server.filter((task) => !currentIds.has(task.id)),
  ];
}

export function greetingForHour(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function greetingForDate(date: Date): string {
  return greetingForHour(date.getHours());
}
