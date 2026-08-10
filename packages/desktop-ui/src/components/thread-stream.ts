import type { AgentStreamEvent, ApprovalKind, ImageAspectRatio, MessageDraft, QuestionOption, SessionNoteKind } from "@berry/shared";
import type { ActivityTool } from "@berry/desktop-ui/components/thread-activity";

/* ------------------------------------------------------------------------ */
/* Pure live-stream state: the reducer that folds AgentStreamEvents into the */
/* per-turn timeline, plus the segment grouping shared with the settled view.*/
/* Kept free of React so the turn/accordion logic is unit-testable.          */
/* ------------------------------------------------------------------------ */

export interface ToolEntry {
  kind: "tool";
  toolCallId: string;
  name: string;
  title?: string | undefined;
  status: "running" | "completed" | "failed" | "denied";
  summary?: string | undefined;
  output?: string | undefined;
  args?: Record<string, unknown> | null | undefined;
  durationMs?: number | undefined;
  startedAt: number;
  /** Live child tool calls when this is a `task` (sub-agent) dispatch. */
  children?: ToolEntry[] | undefined;
  imageProgress?: Array<{
    requestIndex: number;
    index: number;
    percentComplete: number;
    src: string;
    aspectRatio: ImageAspectRatio;
  }> | undefined;
}

export interface NoteEntry {
  kind: "note";
  note: SessionNoteKind;
  text: string;
}

/** A finished burst of reasoning, interleaved in arrival order with tools. */
export interface ThoughtEntry {
  kind: "thought";
  id: string;
  text: string;
}

/** Intermediate assistant prose that was followed by more tool calls. */
export interface TextEntry {
  kind: "text";
  id: string;
  text: string;
}

export type TimelineEntry = ToolEntry | NoteEntry | ThoughtEntry | TextEntry;

export const MAX_RENDERED_LIVE_TIMELINE_ENTRIES = 160;
export const MAX_RETAINED_LIVE_TIMELINE_ENTRIES = 320;

/** Keep an unbounded durable event history while limiting the live DOM that a
 * single long-running turn can ask Chromium to lay out at once. */
export function windowLiveTimeline(
  timeline: TimelineEntry[],
  maximum = MAX_RENDERED_LIVE_TIMELINE_ENTRIES,
): { entries: TimelineEntry[]; omitted: number } {
  const limit = Math.max(1, Math.floor(maximum));
  if (timeline.length <= limit) return { entries: timeline, omitted: 0 };
  return {
    entries: timeline.slice(timeline.length - limit),
    omitted: timeline.length - limit,
  };
}

/** Append a reasoning delta: grow the trailing thought, or start a new one so
 * thoughts interleave with tool calls in arrival order (like the settled view). */
export function appendReasoning(timeline: TimelineEntry[], delta: string): TimelineEntry[] {
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "thought") return [...timeline.slice(0, -1), { ...last, text: last.text + delta }];
  return [...timeline, { kind: "thought", id: `thought-${timeline.length}`, text: delta }];
}

export interface ApprovalPrompt {
  approvalId: string;
  approvalKind: ApprovalKind;
  title: string;
  detail?: string | undefined;
  subject?: string | undefined;
  rawDetail?: string | undefined;
  diff?: string | undefined;
  destructive?: boolean | undefined;
  openWorld?: boolean | undefined;
}

export interface QuestionPrompt {
  questionId: string;
  toolCallId: string;
  question: string;
  options: QuestionOption[];
  multi: boolean;
  /** Full batched prompt when the agent needs several related decisions. */
  questions: Array<{ question: string; options: QuestionOption[]; multi: boolean }>;
}

export interface StreamState {
  turnActive: boolean;
  turnId: string | null;
  text: string;
  reasoning: string;
  messageId: string | null;
  timeline: TimelineEntry[];
  /** Count of old completed live-only items evicted from browser memory. */
  timelineOmitted: number;
  approval: ApprovalPrompt | null;
  question: QuestionPrompt | null;
  error: string | null;
  turnStartedAt: number | null;
  /**
   * Codex `hasFinalAssistantStarted`: sticky once any assistant prose starts
   * streaming this turn. Stays true even if that prose turns out to be
   * intermediate (a tool call follows and folds it into the timeline), so the
   * turn accordion collapses at most once per turn.
   */
  sawText: boolean;
  /** Terminal status from turn.end; null while running or unknown. */
  endStatus: "completed" | "failed" | "cancelled" | null;
  /** Preserve the interrupted assistant text through the first resumed message.start. */
  continuationPendingMessage: boolean;
}

export const IDLE: StreamState = {
  turnActive: false,
  turnId: null,
  text: "",
  reasoning: "",
  messageId: null,
  timeline: [],
  timelineOmitted: 0,
  approval: null,
  question: null,
  error: null,
  turnStartedAt: null,
  sawText: false,
  endStatus: null,
  continuationPendingMessage: false,
};

/** Apply the text collected during one browser frame in the same order on
 * every Berry client. Keeping this here prevents desktop and web from
 * developing subtly different live-message behavior. */
export function reduceStreamDeltas(
  state: StreamState,
  deltas: { reasoning?: string; text?: string; messageId?: string },
): StreamState {
  let next = state;
  const messageId = deltas.messageId ?? next.messageId ?? "";
  if (deltas.reasoning) {
    next = reduceStream(next, {
      kind: "message.delta",
      messageId,
      delta: deltas.reasoning,
      channel: "reasoning",
    });
  }
  if (deltas.text) {
    next = reduceStream(next, {
      kind: "message.delta",
      messageId,
      delta: deltas.text,
      channel: "text",
    });
  }
  return next;
}

/** Update a tool entry by id, whether it's top-level or nested under a parent
 * `task` entry (identified by `parentId`). */
function mapToolEntry(
  timeline: TimelineEntry[],
  toolCallId: string,
  parentId: string | undefined,
  update: (entry: ToolEntry) => ToolEntry,
): TimelineEntry[] {
  return timeline.map((entry) => {
    if (entry.kind !== "tool") return entry;
    if (parentId) {
      if (entry.toolCallId !== parentId) return entry;
      return { ...entry, children: (entry.children ?? []).map((child) => (child.toolCallId === toolCallId ? update(child) : child)) };
    }
    return entry.toolCallId === toolCallId ? update(entry) : entry;
  });
}

function boundedTimeline(
  state: StreamState,
  timeline: TimelineEntry[],
): Pick<StreamState, "timeline" | "timelineOmitted"> {
  let excess = timeline.length - MAX_RETAINED_LIVE_TIMELINE_ENTRIES;
  if (excess <= 0) return { timeline, timelineOmitted: state.timelineOmitted };
  let omitted = 0;
  const retained = timeline.filter((entry) => {
    if (excess <= 0 || timelineEntryRunning(entry)) return true;
    excess -= 1;
    omitted += 1;
    return false;
  });
  return { timeline: retained, timelineOmitted: state.timelineOmitted + omitted };
}

function timelineEntryRunning(entry: TimelineEntry): boolean {
  return entry.kind === "tool" && (
    entry.status === "running"
    || (entry.children ?? []).some((child) => child.status === "running")
  );
}

function applySessionNote(
  timeline: TimelineEntry[],
  note: NoteEntry,
): TimelineEntry[] {
  if (note.note !== "compacting" && note.note !== "compacted") {
    return [...timeline, note];
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind !== "note" || entry.note !== "compacting") continue;
    return timeline.map((candidate, candidateIndex) => candidateIndex === index ? note : candidate);
  }
  return [...timeline, note];
}

export function reduceStream(state: StreamState, event: AgentStreamEvent): StreamState {
  switch (event.kind) {
    case "turn.start":
      if (event.continuation) {
        return {
          ...state,
          turnActive: true,
          turnId: event.turnId,
          messageId: null,
          approval: null,
          question: null,
          error: null,
          endStatus: null,
          continuationPendingMessage: true,
          // Keep the original start time: visually and semantically this is
          // still the same assistant turn, with a provider pause in the middle.
          turnStartedAt: state.turnStartedAt ?? Date.now(),
        };
      }
      return {
        ...IDLE,
        turnActive: true,
        turnId: event.turnId,
        turnStartedAt: state.turnId === event.turnId
          ? state.turnStartedAt ?? Date.now()
          : Date.now(),
      };
    case "message.start":
      // Keep `reasoning` for the whole turn (it's cleared on turn.start). A turn
      // often emits a separate reasoning message then a text message; resetting
      // here made the "Thought" row vanish mid-stream until the turn settled.
      return {
        ...state,
        messageId: event.messageId,
        text: state.continuationPendingMessage ? state.text : "",
        continuationPendingMessage: false,
      };
    case "message.delta":
      return event.channel === "reasoning"
        ? {
            ...state,
            reasoning: state.reasoning + event.delta,
            ...boundedTimeline(state, appendReasoning(state.timeline, event.delta)),
          }
        : { ...state, text: state.text + event.delta, sawText: true };
    case "tool.start": {
      const child: ToolEntry = {
        kind: "tool",
        toolCallId: event.toolCallId,
        name: event.name,
        title: event.title,
        args:
          event.args && typeof event.args === "object" && !Array.isArray(event.args)
            ? (event.args as Record<string, unknown>)
            : null,
        status: "running",
        startedAt: Date.now(),
      };
      // A sub-agent's tool call nests under its parent `task` entry.
      if (event.parentToolCallId) {
        const parentId = event.parentToolCallId;
        return {
          ...state,
          timeline: state.timeline.map((entry) =>
            entry.kind === "tool" && entry.toolCallId === parentId
              ? { ...entry, children: [...(entry.children ?? []), child] }
              : entry,
          ),
        };
      }
      // Prose that a tool call follows wasn't the final answer — fold it into
      // the timeline so it stays interleaved (thought → prose → tool → …).
      const folded: TimelineEntry[] = state.text
        ? [...state.timeline, { kind: "text", id: `text-${state.timeline.length}`, text: state.text }]
        : state.timeline;
      return { ...state, text: "", ...boundedTimeline(state, [...folded, child]) };
    }
    case "tool.update":
      return {
        ...state,
        timeline: mapToolEntry(state.timeline, event.toolCallId, event.parentToolCallId, (entry) => ({
          ...entry,
          output: event.detail ?? entry.output,
        })),
      };
    case "image.partial":
      return {
        ...state,
        timeline: mapToolEntry(state.timeline, event.toolCallId, undefined, (entry) => {
          const next = {
            requestIndex: event.requestIndex,
            index: event.index,
            percentComplete: event.percentComplete,
            src: `data:${event.mimeType};base64,${event.b64}`,
            aspectRatio: event.aspectRatio,
          };
          return {
            ...entry,
            imageProgress: [
              ...(entry.imageProgress ?? []).filter((item) => item.requestIndex !== event.requestIndex),
              next,
            ].sort((left, right) => left.requestIndex - right.requestIndex),
          };
        }),
      };
    case "tool.end":
      {
        const timeline = mapToolEntry(state.timeline, event.toolCallId, event.parentToolCallId, (entry) => ({
          ...entry,
          status: event.status,
          summary: event.summary ?? entry.summary,
          output: entry.output ?? event.summary,
          durationMs: event.durationMs,
        }));
      return {
        ...state,
        ...boundedTimeline(state, timeline),
      };
      }
    case "approval.request":
      return {
        ...state,
        approval: {
          approvalId: event.approvalId,
          approvalKind: event.approvalKind,
          title: event.title,
          detail: event.detail,
          subject: event.subject,
          rawDetail: event.rawDetail,
          diff: event.diff,
          destructive: event.destructive,
          openWorld: event.openWorld,
        },
      };
    case "approval.resolved":
      return state.approval?.approvalId === event.approvalId
        ? { ...state, approval: null }
        : state;
    case "question.request":
      {
        const questions = event.questions?.length
          ? event.questions
          : [{ question: event.question, options: event.options, multi: event.multi }];
      return {
        ...state,
        question: {
          questionId: event.questionId,
          toolCallId: event.toolCallId,
          question: event.question,
          options: event.options,
          multi: event.multi,
          questions,
        },
      };
      }
    case "question.answered":
      return state.question?.questionId === event.questionId ? { ...state, question: null } : state;
    case "session.note":
      // A steering request is represented by its normal user prompt in the
      // transcript. Older runtimes can still send this marker, but rendering
      // it duplicates the same action as a decorative divider.
      if (event.note === "steered") return state;
      {
        const note: NoteEntry = { kind: "note", note: event.note, text: event.detail ?? event.note };
        const timeline = applySessionNote(state.timeline, note);
        return {
          ...state,
          ...boundedTimeline(state, timeline),
        };
      }
    case "mode.changed":
      // Legacy streams remain decodable, but presentation changes are user-driven.
      return state;
    case "error":
      return { ...state, error: event.message };
    case "turn.end": {
      // Failed and cancelled compactions do not emit a completed note. Clear
      // the transient marker when the turn terminates so replay cannot leave a
      // permanent "Context auto-compacting" spinner behind.
      const timeline = state.timeline.filter(
        (entry) => entry.kind !== "note" || entry.note !== "compacting",
      );
      return {
        ...state,
        ...boundedTimeline(state, timeline),
        turnActive: false,
        approval: null,
        question: null,
        endStatus: event.status,
      };
    }
    default:
      return state;
  }
}

export type LiveSegment =
  | { kind: "tools"; tools: ToolEntry[] }
  | { kind: "note"; note: SessionNoteKind; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "text"; id: string; text: string };

/** Groups the live timeline into runs of consecutive tools split by
 * thoughts/prose/notes, preserving arrival order (like the settled view). */
export function groupLiveTimeline(timeline: TimelineEntry[]): LiveSegment[] {
  const segments: LiveSegment[] = [];
  for (const entry of timeline) {
    if (entry.kind !== "tool") {
      segments.push(entry);
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === "tools") last.tools.push(entry);
    else segments.push({ kind: "tools", tools: [entry] });
  }
  return segments;
}

export type MessageSegment =
  | { kind: "tools"; tools: ActivityTool[] }
  | { kind: "thought"; id: string; text: string }
  | { kind: "artifact"; id: string; name: string; path: string; mediaType?: string; size?: number }
  | { kind: "writing-block"; id: string; draft: MessageDraft }
  | { kind: "text" | "error"; id: string; text: string };

/**
 * Codex `LO`/`BO`: split a settled turn into the collapsible activity and the
 * always-visible final response. Everything up to and including the last
 * tool/thought segment is activity — intermediate prose included, matching the
 * live view — and only the trailing text is the final answer. Automatic
 * output publication can happen after that text, so it does not move the
 * final-answer boundary. Errors always render in the body.
 */
export function classifyTurnSegments(segments: MessageSegment[]): {
  activity: MessageSegment[];
  body: MessageSegment[];
  hasFinalText: boolean;
} {
  let lastActivity = -1;
  segments.forEach((segment, index) => {
    if (segment.kind === "thought" || (segment.kind === "tools" && !isAutomaticArtifactPublish(segment))) lastActivity = index;
  });
  const activity: MessageSegment[] = [];
  const body: MessageSegment[] = [];
  segments.forEach((segment, index) => {
    if (segment.kind === "error" || segment.kind === "artifact" || segment.kind === "writing-block") body.push(segment);
    else if (segment.kind === "text" && index > lastActivity) body.push(segment);
    else activity.push(segment);
  });
  return { activity, body, hasFinalText: body.some((segment) => segment.kind === "text" || segment.kind === "writing-block") };
}

function isAutomaticArtifactPublish(segment: Extract<MessageSegment, { kind: "tools" }>): boolean {
  return segment.tools.length > 0 && segment.tools.every(
    (tool) => tool.name === "persist_artifact" && tool.args?.automatic === true,
  );
}
