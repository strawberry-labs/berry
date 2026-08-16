import * as React from "react";
import { MessageAttachmentContentSchema, type ImageAspectRatio, type Message, type MessageAttachmentContent, type MessageDraft, type MessagePart } from "@berry/shared";
import { ArrowRight02, CircleHelp, Copy, FileImage, GaugeIcon, GitFork, ImagePlus, Pencil, Search, ShieldQuestion, Trash2 } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@berry/desktop-ui/components/ui/accordion";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@berry/desktop-ui/components/ui/attachment";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Message as MessageRow, MessageContent, MessageFooter } from "@berry/desktop-ui/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@berry/desktop-ui/components/ui/message-scroller";
import { cn } from "@berry/desktop-ui/lib/utils";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { useSquircle } from "@berry/desktop-ui/lib/squircle";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";
import { ApprovalEvidence } from "@berry/desktop-ui/components/approval-evidence";
import { ConversationNavigator, type NavigatorItem } from "@berry/desktop-ui/components/conversation-navigator";
import {
  ActivityNote,
  forgetTurnDisclosure,
  latestTurnAction,
  ThoughtRow,
  ToolFlow,
  TurnActivity,
  type ActivityTool,
} from "@berry/desktop-ui/components/thread-activity";
import {
  classifyTurnSegments,
  groupLiveTimeline,
  settleRunningActivityTools,
  toolTerminalStatus,
  windowLiveTimeline,
  type ApprovalPrompt,
  type MessageSegment,
  type QuestionPrompt,
  type StreamState,
  type ToolEntry,
} from "@berry/desktop-ui/components/thread-stream";
import {
  WritingBlockController,
  messageDraftFromToolResult,
} from "@berry/desktop-ui/components/writing-block";
import {
  GeneratedImageGallery,
  generatedImageFromPart,
  type GeneratedImageView,
  type ImageEditAnnotation,
} from "@berry/desktop-ui/components/generated-image-gallery";
import { isContinuableAssistantTurn, isImageMessagePart } from "@berry/desktop-ui/components/thread-message-utils";
export { isContinuableAssistantTurn, isImageMessagePart } from "@berry/desktop-ui/components/thread-message-utils";

export type ApprovalDecision = "approved_once" | "approved_for_session" | "approved_rule" | "denied" | "abort";

/**
 * Host-specific actions injected into the shared thread presentation. The
 * desktop adapter wires these to the Tauri host; the web adapter wires them to
 * the cloud API. Optional actions hide their affordances when absent.
 */
export interface BerryThreadAdapter {
  /** Render an inline editor for a user message; enables the Edit affordance. */
  renderUserEditor?: (message: Message, close: () => void) => React.ReactNode;
  /** Rewind to immediately before a user message and remove that turn and everything after it. */
  onDeleteUserMessage?: (message: Message) => void | Promise<void>;
  /** Fork the conversation at the given assistant message boundary. */
  onFork?: (boundaryMessageId: string | undefined) => void | Promise<void>;
  /** Decide a pending approval. Approval prompts render read-only when absent. */
  onApprovalDecide?: (approval: ApprovalPrompt, decision: ApprovalDecision) => Promise<void>;
  /** Answer a pending structured question. */
  onQuestionAnswer?: (question: QuestionPrompt, answer: string, selectedOptions: string[]) => Promise<void>;
  /** Open a durable submitted attachment in the host's file viewer. */
  onOpenAttachment?: (attachment: MessageAttachmentContent) => void | Promise<void>;
  /** Open an artifact produced by the runtime in the host's file viewer. */
  onOpenArtifact?: (artifact: { name: string; path: string; mediaType?: string; size?: number }) => void | Promise<void>;
  /** Open the task-scoped file library. */
  onViewTaskFiles?: () => void;
  /** Post a new user turn that semantically edits a generated image. */
  onEditGeneratedImage?: (image: GeneratedImageView, instruction: string, annotations: ImageEditAnnotation[]) => void | Promise<void>;
  /** Recreate a generated image at a new aspect ratio. */
  onRegenerateGeneratedImage?: (image: GeneratedImageView, aspectRatio: ImageAspectRatio) => void | Promise<void>;
}

const rememberedTurnElapsed = new Map<string, number>();
const REMEMBERED_TURN_ELAPSED_CAP = 800;
const HISTORY_ESTIMATED_ROW_HEIGHT = 180;
const HISTORY_ROW_GAP = 20;
const HISTORY_OVERSCAN_ROWS = 6;
const HISTORY_MEASURED_HEIGHT_CAP = 512;

function rememberTurnElapsed(turnKey: string, elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  rememberedTurnElapsed.delete(turnKey);
  rememberedTurnElapsed.set(turnKey, elapsedMs);
  if (rememberedTurnElapsed.size > REMEMBERED_TURN_ELAPSED_CAP) {
    const first = rememberedTurnElapsed.keys().next().value;
    if (first) rememberedTurnElapsed.delete(first);
  }
}

function rememberedTurnElapsedMs(turnKey: string): number | undefined {
  return rememberedTurnElapsed.get(turnKey);
}

export interface VariableHeightRange {
  first: number;
  last: number;
  totalHeight: number;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function calculateVariableHeightRangeFromStarts(
  keys: readonly string[],
  starts: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  measuredHeights: ReadonlyMap<string, number>,
  estimate: number,
  overscan: number,
): VariableHeightRange {
  if (keys.length === 0) return { first: 0, last: -1, totalHeight: 0 };
  const lastHeight = Math.max(48, measuredHeights.get(keys[keys.length - 1]!) ?? estimate);
  const totalHeight = starts[starts.length - 1]! + lastHeight;
  const viewportStart = Math.max(0, scrollTop);
  const viewportEnd = viewportStart + Math.max(1, viewportHeight);
  const firstVisible = Math.min(keys.length - 1, Math.max(0, upperBound(starts, viewportStart) - 1));
  let lastVisible = Math.min(keys.length - 1, Math.max(0, upperBound(starts, viewportEnd) - 1));
  if (lastVisible > firstVisible && starts[lastVisible] === viewportEnd) lastVisible -= 1;
  return {
    first: Math.max(0, firstVisible - overscan),
    last: Math.min(keys.length - 1, lastVisible + overscan),
    totalHeight,
  };
}

/** Pure range calculation kept exportable for the 10k-message performance test. */
export function calculateVariableHeightRange(
  keys: readonly string[],
  scrollTop: number,
  viewportHeight: number,
  measuredHeights: ReadonlyMap<string, number> = new Map(),
  estimate = HISTORY_ESTIMATED_ROW_HEIGHT + HISTORY_ROW_GAP,
  overscan = HISTORY_OVERSCAN_ROWS,
): VariableHeightRange {
  if (keys.length === 0) return { first: 0, last: -1, totalHeight: 0 };
  const starts = new Array<number>(keys.length);
  let totalHeight = 0;
  for (let index = 0; index < keys.length; index += 1) {
    starts[index] = totalHeight;
    totalHeight += Math.max(48, measuredHeights.get(keys[index]!) ?? estimate);
  }
  return calculateVariableHeightRangeFromStarts(
    keys,
    starts,
    scrollTop,
    viewportHeight,
    measuredHeights,
    estimate,
    overscan,
  );
}

/** Convert a row offset inside the history window into a viewport scrollTop. */
export function historyWindowScrollTop(
  viewportTop: number,
  viewportScrollTop: number,
  historyWindowTop: number,
  rowStart: number,
): number {
  return Math.max(0, viewportScrollTop + historyWindowTop - viewportTop + rowStart);
}

export function settledTurnKey(sessionId: string, groupKey: string): string {
  return `${sessionId}:turn-${groupKey}`;
}

/** Resolve a turn identity from an overlap-aware message-id map. */
export function stableTurnGroupKey(
  group: { key: string; user?: Message; assistants: Message[] },
  knownIdentities?: ReadonlyMap<string, string>,
): string {
  const ids = [group.user?.id, ...group.assistants.map((message) => message.id)].filter((id): id is string => Boolean(id));
  const known = ids.map((id) => knownIdentities?.get(id)).find((key): key is string => Boolean(key));
  return known ?? group.key;
}

function useVariableHeightWindow(keys: readonly string[], containerRef: React.RefObject<HTMLElement | null>) {
  const measuredHeightsRef = React.useRef(new Map<string, number>());
  const elementsRef = React.useRef(new Map<string, HTMLElement>());
  const itemRefsRef = React.useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const [viewport, setViewport] = React.useState({ scrollTop: 0, height: 720 });
  const [measurementVersion, setMeasurementVersion] = React.useState(0);
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = React.useState<string[]>([]);

  React.useEffect(() => {
    const root = containerRef.current?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    if (!root) return;
    let frame = 0;
    const updateViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewport({ scrollTop: root.scrollTop, height: root.clientHeight || 720 }));
    };
    updateViewport();
    root.addEventListener("scroll", updateViewport, { passive: true });
    const viewportObserver = new ResizeObserver(updateViewport);
    viewportObserver.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", updateViewport);
      viewportObserver.disconnect();
    };
  }, [containerRef]);

  React.useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const updateSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !root.contains(selection.anchorNode)) {
        setSelectedKeys([]);
        return;
      }
      const endpoints = [selection.anchorNode, selection.focusNode]
        .map((node) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-history-key]")?.dataset.historyKey)
        .filter((key): key is string => Boolean(key));
      if (endpoints.length < 2) {
        setSelectedKeys([...new Set(endpoints)]);
        return;
      }
      const first = keys.indexOf(endpoints[0]!);
      const last = keys.indexOf(endpoints[1]!);
      if (first < 0 || last < 0) {
        setSelectedKeys([...new Set(endpoints)]);
        return;
      }
      const start = Math.min(first, last);
      const end = Math.max(first, last);
      // Keep every row touched by a native selection mounted. This is an
      // intentional interaction exception to the viewport budget: unmounting
      // an intermediate row would destroy the browser's selection range.
      setSelectedKeys(keys.slice(start, end + 1));
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [containerRef, keys]);

  React.useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.historyKey;
        if (!key) continue;
        const next = Math.max(48, Math.round(entry.contentRect.height) + HISTORY_ROW_GAP);
        const previous = measuredHeightsRef.current.get(key);
        if (previous !== next) {
          measuredHeightsRef.current.delete(key);
          measuredHeightsRef.current.set(key, next);
          while (measuredHeightsRef.current.size > HISTORY_MEASURED_HEIGHT_CAP) {
            const oldest = measuredHeightsRef.current.keys().next().value;
            if (!oldest) break;
            measuredHeightsRef.current.delete(oldest);
          }
          changed = true;
        }
      }
      if (changed) setMeasurementVersion((value) => value + 1);
    });
    observerRef.current = observer;
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const updateFocusedKey = (event: FocusEvent) => {
      const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-history-key]");
      setFocusedKey(row?.dataset.historyKey ?? null);
    };
    const clearFocusIfOutside = () => {
      if (!root.contains(document.activeElement)) setFocusedKey(null);
    };
    root.addEventListener("focusin", updateFocusedKey);
    root.addEventListener("focusout", clearFocusIfOutside);
    return () => {
      root.removeEventListener("focusin", updateFocusedKey);
      root.removeEventListener("focusout", clearFocusIfOutside);
    };
  }, [containerRef]);

  const starts = React.useMemo(() => {
    const values: number[] = [];
    let offset = 0;
    for (const key of keys) {
      values.push(offset);
      offset += Math.max(48, measuredHeightsRef.current.get(key) ?? HISTORY_ESTIMATED_ROW_HEIGHT + HISTORY_ROW_GAP);
    }
    return values;
  }, [keys, measurementVersion]);
  const previousStartsRef = React.useRef<number[] | null>(null);
  const previousKeysRef = React.useRef<string[] | null>(null);
  React.useLayoutEffect(() => {
    const root = containerRef.current?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    const previousStarts = previousStartsRef.current;
    const previousKeys = previousKeysRef.current;
    const sameKeys = previousKeys !== null
      && previousKeys.length === keys.length
      && previousKeys.every((key, index) => key === keys[index]);
    if (root && sameKeys && previousStarts && previousStarts.length === starts.length && starts.length > 0) {
      const anchorIndex = Math.min(starts.length - 1, Math.max(0, upperBound(previousStarts, root.scrollTop) - 1));
      const delta = starts[anchorIndex]! - previousStarts[anchorIndex]!;
      if (delta !== 0) root.scrollTop += delta;
    }
    previousStartsRef.current = [...starts];
    previousKeysRef.current = [...keys];
  }, [containerRef, keys, starts]);
  // Prefix offsets are rebuilt only when keys or measured heights change;
  // scroll events binary-search this stable array instead of scanning 10k rows.
  const range = React.useMemo(
    () => calculateVariableHeightRangeFromStarts(
      keys,
      starts,
      viewport.scrollTop,
      viewport.height,
      measuredHeightsRef.current,
      HISTORY_ESTIMATED_ROW_HEIGHT + HISTORY_ROW_GAP,
      HISTORY_OVERSCAN_ROWS,
    ),
    [keys, starts, measurementVersion, viewport.height, viewport.scrollTop],
  );

  const getItemRef = React.useCallback((key: string) => {
    const existing = itemRefsRef.current.get(key);
    if (existing) return existing;
    const callback = (element: HTMLDivElement | null) => {
      const previous = elementsRef.current.get(key);
      if (previous && previous !== element) observerRef.current?.unobserve(previous);
      if (!element) {
        elementsRef.current.delete(key);
        itemRefsRef.current.delete(key);
        return;
      }
      element.dataset.historyKey = key;
      elementsRef.current.set(key, element);
      observerRef.current?.observe(element);
      const height = Math.max(48, Math.round(element.getBoundingClientRect().height));
      if (measuredHeightsRef.current.get(key) !== height) {
        measuredHeightsRef.current.delete(key);
        measuredHeightsRef.current.set(key, height);
        while (measuredHeightsRef.current.size > HISTORY_MEASURED_HEIGHT_CAP) {
          const oldest = measuredHeightsRef.current.keys().next().value;
          if (!oldest) break;
          measuredHeightsRef.current.delete(oldest);
        }
        setMeasurementVersion((value) => value + 1);
      }
    };
    itemRefsRef.current.set(key, callback);
    return callback;
  }, []);

  const virtualItems = React.useMemo(() => {
    const indexes = new Set<number>();
    for (let index = range.first; index <= range.last; index += 1) indexes.add(index);
    if (focusedKey) {
      const focusedIndex = keys.indexOf(focusedKey);
      if (focusedIndex >= 0) indexes.add(focusedIndex);
    }
    for (const selectedKey of selectedKeys) {
      const selectedIndex = keys.indexOf(selectedKey);
      if (selectedIndex >= 0) indexes.add(selectedIndex);
    }
    return [...indexes].sort((left, right) => left - right).map((index) => ({
      index,
      key: keys[index]!,
      start: starts[index]!,
      size: measuredHeightsRef.current.get(keys[index]!) ?? HISTORY_ESTIMATED_ROW_HEIGHT + HISTORY_ROW_GAP,
    }));
  }, [focusedKey, keys, range.first, range.last, selectedKeys, starts]);

  const scrollToKey = React.useCallback((key: string, behavior: ScrollBehavior = "smooth") => {
    const index = keys.indexOf(key);
    const userIndex = index >= 0 ? index : keys.indexOf(`${key}:user`);
    const root = containerRef.current?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    const historyWindow = root?.querySelector<HTMLElement>('[data-history-window="true"]');
    if (userIndex < 0 || !root || !historyWindow) return false;
    const viewportRect = root.getBoundingClientRect();
    const historyWindowRect = historyWindow.getBoundingClientRect();
    root.scrollTo({
      top: historyWindowScrollTop(
        viewportRect.top,
        root.scrollTop,
        historyWindowRect.top,
        starts[userIndex] ?? 0,
      ),
      behavior,
    });
    return true;
  }, [containerRef, keys, starts]);

  return { range, virtualItems, getItemRef, scrollToKey };
}

export interface BerryThreadViewProps {
  sessionId: string;
  taskId?: string;
  stream: StreamState;
  messages: Message[];
  /** Host-owned content rendered inside the active turn's message column. */
  liveContent?: React.ReactNode;
  density?: "full" | "compact";
  autoScroll?: boolean;
  showReasoning?: boolean;
  showTodos?: boolean;
  /** Web presents questions over its composer; desktop keeps its inline card. */
  showQuestions?: boolean;
  /** Show the elapsed turn clock before the provider emits its first work item. */
  showPendingTurnActivity?: boolean;
  /** Durable lifecycle phase shown while the turn is active. */
  activeStatus?: string | undefined;
  /** Host-owned fallback for an interrupted latest turn not yet projected as a message part. */
  latestTurnError?: string;
  /** Native desktop keeps the rail 16px from its window edge; web uses 12px. */
  navigatorInset?: number;
  adapter?: BerryThreadAdapter;
  onLoadOlderMessages?: () => Promise<boolean> | boolean;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  /** Search the full task history and return the matching user/row message ID. */
  onSearchMessages?: (query: string) => Promise<string | null>;
  /** Disable near-top auto-fetch for deterministic hosts/benchmarks. */
  autoLoadOlderOnScroll?: boolean;
}

export function shouldReplaceLatestSettledAssistantWithLiveTurn(input: {
  liveVisible: boolean;
  latestTurnHasUser: boolean;
  continuation: boolean;
}): boolean {
  return input.liveVisible && input.latestTurnHasUser && !input.continuation;
}

export function shouldUseLiveMarkdown(stream: Pick<StreamState, "turnActive">): boolean {
  return stream.turnActive;
}

/**
 * The full Berry conversation presentation: settled turn groups (user bubbles
 * + "Worked for Xs" assistant turns) and the live streaming turn, inside the
 * shared message scroller. Pure presentation — data and host actions come in
 * via props/adapter so desktop and web render pixel-identically.
 */
export function BerryThreadView({
  sessionId,
  taskId,
  stream,
  messages,
  liveContent,
  density = "full",
  autoScroll = true,
  showReasoning = false,
  showTodos = true,
  showQuestions = true,
  showPendingTurnActivity = false,
  activeStatus,
  latestTurnError,
  navigatorInset = 12,
  adapter = {},
  onLoadOlderMessages,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  autoLoadOlderOnScroll = true,
  onSearchMessages,
}: BerryThreadViewProps) {
  const now = useNow(stream.turnActive);
  const settled = React.useMemo(
    () => messages.filter((message) => message.id !== stream.messageId || !stream.turnActive),
    [messages, stream.messageId, stream.turnActive],
  );
  const turnIdentityRef = React.useRef(new Map<string, string>());

  // Berry shows ONE "Worked for Xs" per user turn; the agent loop persists
  // several assistant messages per turn, so group consecutive ones.
  const turnGroups = React.useMemo(() => {
    const groups: Array<{ key: string; user?: Message; assistants: Message[] }> = [];
    for (const message of settled) {
      if (message.role === "user") {
        groups.push({ key: message.id, user: message, assistants: [] });
      } else {
        const last = groups[groups.length - 1];
        if (last) last.assistants.push(message);
        else groups.push({ key: message.id, assistants: [message] });
      }
    }
    const identities = turnIdentityRef.current;
    const currentMessageIds = new Set<string>();
    for (const group of groups) {
      const ids = [group.user?.id, ...group.assistants.map((message) => message.id)].filter((id): id is string => Boolean(id));
      const key = stableTurnGroupKey(group, identities);
      group.key = key;
      for (const id of ids) {
        currentMessageIds.add(id);
        identities.set(id, key);
      }
    }
    for (const id of identities.keys()) {
      if (!currentMessageIds.has(id)) identities.delete(id);
    }
    return groups;
  }, [settled]);
  const latestTurn = turnGroups[turnGroups.length - 1];
  const liveHasContent =
    stream.turnActive ||
    Boolean(stream.approval) ||
    Boolean(stream.question) ||
    stream.text.length > 0 ||
    stream.timeline.length > 0 ||
    stream.reasoning.length > 0 ||
    Boolean(stream.error) ||
    Boolean(liveContent);
  const liveHasSessionNote = stream.timeline.some((entry) => entry.kind === "note");
  const latestTurnHasSettledAssistant = Boolean(latestTurn?.user && latestTurn.assistants.length > 0);
  // The host stores settled assistant messages with database ids, not the
  // transient stream message id. Use the latest user turn as the handoff
  // boundary so a stopped turn cannot render both persisted and live activity.
  const liveVisible =
    liveHasContent && (
      stream.turnActive
      || Boolean(stream.approval)
      || Boolean(stream.question)
      || Boolean(liveContent)
      || liveHasSessionNote
      || !latestTurnHasSettledAssistant
    );
  const replaceLatestSettledAssistant = shouldReplaceLatestSettledAssistantWithLiveTurn({
    liveVisible,
    latestTurnHasUser: Boolean(latestTurn?.user),
    continuation: stream.continuation,
  });
  // Turn accordion state is keyed by the stable owning message (or the active
  // run id before its first persisted message), not by array position. Older
  // pages can prepend while a turn is live without resetting its disclosure
  // state or elapsed activity identity.
  const liveTurnKey = settledTurnKey(sessionId, latestTurn?.key ?? stream.turnId ?? "live");
  const writingBlockParts = React.useMemo(
    () => collectMessageDraftParts(settled),
    [settled],
  );
  const conversationImageParts = React.useMemo(
    () => settled.filter((message) => message.role === "assistant").flatMap((message) => message.parts).filter(isImageMessagePart),
    [settled],
  );

  React.useEffect(() => {
    if (!stream.endStatus || !stream.turnStartedAt) return;
    rememberTurnElapsed(liveTurnKey, Date.now() - stream.turnStartedAt);
  }, [liveTurnKey, stream.endStatus, stream.turnStartedAt]);

  // A rerun turn (edit-and-resubmit truncates and reuses ordinals) must not
  // inherit disclosure state from the turns it replaced. Clear until the
  // answer starts — after that the user may be toggling this very turn.
  React.useEffect(() => {
    if (stream.turnActive && !stream.sawText) forgetTurnDisclosure(sessionId, liveTurnKey);
  }, [sessionId, stream.turnActive, stream.sawText, liveTurnKey]);

  const liveTimelineWindow = windowLiveTimeline(stream.timeline);
  const omittedLiveActivity = stream.timelineOmitted + liveTimelineWindow.omitted;
  const liveSegments = groupLiveTimeline(liveTimelineWindow.entries);
  const liveTimelineOnlyNotes = stream.timeline.length > 0 && stream.timeline.every((entry) => entry.kind === "note");
  let liveThoughtOrdinal = 0;
  const liveActivityNodes = [
    ...(omittedLiveActivity > 0 ? [(
      <div
        key="live-timeline-window"
        className="px-1 text-[11px] text-[var(--berry-text-tertiary)]"
        role="status"
      >
        {omittedLiveActivity} earlier live activity items are hidden to keep this tab responsive. They remain in task history.
      </div>
    )] : []),
    ...liveSegments.map((segment, index) => {
      if (segment.kind === "tools") {
        return (
          <ToolFlow
            key={`tools-${segment.tools[0]?.toolCallId ?? index}`}
            tools={segment.tools}
            active={stream.turnActive}
            latest={stream.turnActive && index === liveSegments.length - 1}
            showTodos={showTodos}
          />
        );
      }
      if (segment.kind === "thought") {
        // Berry `mnt`: the collapse key is the identity of the next rendered
        // part after this thought (or the live answer once it starts streaming).
        const next = liveSegments[index + 1];
        const autoCollapseKey = next
          ? next.kind === "tools"
            ? `tools-${next.tools[0]?.toolCallId ?? index + 1}`
            : next.kind === "note"
              ? `note-${index + 1}`
              : next.id
          : stream.text.length > 0
            ? "live-answer"
            : null;
        return (
          <ThoughtRow
            key={segment.id}
            stateKey={`${liveTurnKey}:thought-${liveThoughtOrdinal++}`}
            autoCollapseKey={autoCollapseKey}
            active={stream.turnActive && stream.text.length === 0 && index === liveSegments.length - 1}
            reasoning={segment.text}
            collapseWhenInactive
          />
        );
      }
      if (segment.kind === "text") {
        return <BerryAssistantMarkdownBlock key={segment.id}>{segment.text}</BerryAssistantMarkdownBlock>;
      }
      return (
        <ActivityNote key={`note-${index}`} note={segment.note}>
          {segment.text}
        </ActivityNote>
      );
    }),
  ];

  const navContainerRef = React.useRef<HTMLDivElement>(null);
  const historyRows = React.useMemo(() => turnGroups.flatMap((group, groupIndex) => [
    ...(group.user ? [{ key: `${group.user.id}:user`, kind: "user" as const, group, groupIndex }] : []),
    ...((!replaceLatestSettledAssistant || groupIndex !== turnGroups.length - 1) && group.assistants.length > 0
      ? [{ key: `${stableTurnGroupKey(group)}:assistant`, kind: "assistant" as const, group, groupIndex }]
      : []),
  ]), [replaceLatestSettledAssistant, turnGroups]);
  const historyKeys = React.useMemo(() => historyRows.map((row) => row.key), [historyRows]);
  const { range: historyRange, virtualItems: virtualHistoryItems, getItemRef: getHistoryItemRef, scrollToKey } = useVariableHeightWindow(historyKeys, navContainerRef);
  const olderLoadInFlightRef = React.useRef(false);
  const sessionIdRef = React.useRef(sessionId);
  sessionIdRef.current = sessionId;
  const searchSessionRef = React.useRef(sessionId);
  const searchGenerationRef = React.useRef(0);
  if (searchSessionRef.current !== sessionId) {
    searchSessionRef.current = sessionId;
    searchGenerationRef.current += 1;
  }
  const [historyLoadError, setHistoryLoadError] = React.useState<string | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [searchTargetId, setSearchTargetId] = React.useState<string | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    setHistoryLoadError(null);
    olderLoadInFlightRef.current = false;
    setSearchOpen(false);
    setSearchQuery("");
    setSearching(false);
    setSearchError(null);
    setSearchTargetId(null);
  }, [sessionId]);
  const loadOlderMessages = React.useCallback(async () => {
    if (!onLoadOlderMessages) return false;
    try {
      const loaded = await onLoadOlderMessages();
      setHistoryLoadError(null);
      return loaded;
    } catch (cause) {
      setHistoryLoadError(cause instanceof Error ? cause.message : "Unable to load older messages");
      return false;
    }
  }, [onLoadOlderMessages]);
  const loadOlderWithScroll = React.useCallback(async (viewport: HTMLElement) => {
    if (!onLoadOlderMessages || olderLoadInFlightRef.current) return false;
    const beforeHeight = viewport.scrollHeight;
    const beforeTop = viewport.scrollTop;
    const beforeAnchor = viewport.querySelector<HTMLElement>('[data-history-key]');
    const beforeAnchorKey = beforeAnchor?.dataset.historyKey ?? null;
    const beforeAnchorTop = beforeAnchor?.getBoundingClientRect().top ?? null;
    olderLoadInFlightRef.current = true;
    try {
      const loaded = await loadOlderMessages();
      if (!loaded) return;
      requestAnimationFrame(() => {
        if (sessionIdRef.current !== sessionId || !viewport.isConnected) return;
        const delta = viewport.scrollHeight - beforeHeight;
        viewport.scrollTop = beforeTop + delta;
        const correctAnchor = (attempt: number) => {
          if (sessionIdRef.current !== sessionId || !viewport.isConnected) return;
          const currentAnchor = beforeAnchorKey
            ? viewport.querySelector<HTMLElement>(`[data-history-key="${CSS.escape(beforeAnchorKey)}"]`)
            : null;
          if (currentAnchor && beforeAnchorTop !== null) {
            viewport.scrollTop += currentAnchor.getBoundingClientRect().top - beforeAnchorTop;
          } else if (attempt < 2) {
            requestAnimationFrame(() => correctAnchor(attempt + 1));
          }
        };
        requestAnimationFrame(() => correctAnchor(0));
      });
      return true;
    } finally {
      olderLoadInFlightRef.current = false;
    }
  }, [loadOlderMessages, onLoadOlderMessages, sessionId]);
  React.useEffect(() => {
    if (!onSearchMessages) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen(true);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSearchMessages]);
  React.useEffect(() => {
    if (!searchTargetId) return;
    if (scrollToKey(searchTargetId, "smooth")) {
      setSearchTargetId(null);
      setSearchError(null);
    }
  }, [historyKeys, scrollToKey, searchTargetId]);
  const submitSearch = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSearchMessages || !searchQuery.trim() || searching) return;
    const requestSessionId = sessionId;
    const requestGeneration = searchGenerationRef.current;
    const isCurrentSearch = () => sessionIdRef.current === requestSessionId
      && searchGenerationRef.current === requestGeneration;
    setSearching(true);
    setSearchError(null);
    try {
      const messageId = await onSearchMessages(searchQuery);
      if (!isCurrentSearch()) return;
      if (!messageId) setSearchError("No matching task message found.");
      else setSearchTargetId(messageId);
    } catch (cause) {
      if (!isCurrentSearch()) return;
      setSearchError(cause instanceof Error ? cause.message : "Unable to search task messages");
    } finally {
      if (isCurrentSearch()) setSearching(false);
    }
  }, [onSearchMessages, searchQuery, searching, sessionId]);
  const handleHistoryScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
    if (!autoLoadOlderOnScroll || !onLoadOlderMessages || event.currentTarget.scrollTop > 160) return;
    void loadOlderWithScroll(event.currentTarget);
  }, [autoLoadOlderOnScroll, loadOlderWithScroll, onLoadOlderMessages]);
  const navigatorItems = React.useMemo<NavigatorItem[]>(() => turnGroups
    .filter((group): group is typeof group & { user: Message } => Boolean(group.user))
    .map((group) => ({
      id: group.user.id,
      label: userMessageText(group.user),
      preview: assistantMessageText(group.assistants),
      resources: messageAttachmentNames([...group.user.parts, ...group.assistants.flatMap((assistant) => assistant.parts)]),
    })), [turnGroups]);

  return (
    <MessageScrollerProvider autoScroll={autoScroll} scrollEdgeThreshold={96}>
      <div ref={navContainerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {onSearchMessages ? (
          <div className="absolute right-3 top-3 z-30 flex flex-col items-end gap-1">
            <button
              type="button"
              aria-label="Search task messages"
              className="rounded-full border border-border bg-background/90 p-1.5 text-muted-foreground shadow-sm hover:bg-muted"
              onClick={() => { setSearchOpen((open) => !open); setSearchError(null); window.requestAnimationFrame(() => searchInputRef.current?.focus()); }}
            >
              <Search className="size-3.5" aria-hidden="true" />
            </button>
            {searchOpen ? (
              <form role="search" aria-label="Search task messages" onSubmit={submitSearch} className="flex w-64 flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-lg">
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  disabled={searching}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search task messages…"
                  aria-label="Search task messages"
                  className="h-8 rounded border border-border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button type="submit" disabled={searching || !searchQuery.trim()} className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-60">
                  {searching ? "Searching…" : "Find message"}
                </button>
                {searchError ? <div role="status" className="text-[11px] text-destructive">{searchError}</div> : null}
              </form>
            ) : null}
          </div>
        ) : null}
        <ConversationNavigator
          containerRef={navContainerRef}
          items={navigatorItems}
          inset={navigatorInset}
          onLoadOlder={loadOlderMessages}
          hasOlderMessages={hasOlderMessages}
          onScrollToAnchor={scrollToKey}
          onNavigationFailure={() => setHistoryLoadError("That message is no longer available in the loaded history.")}
        />
        <MessageScroller className="flex-1">
        <MessageScrollerViewport className="px-6" onScroll={handleHistoryScroll}>
          <MessageScrollerContent role="feed" aria-label="Task message history" aria-busy={loadingOlderMessages || searching} data-density={density} className="berry-thread-content mx-auto w-full gap-5 py-10">
            {hasOlderMessages ? (
              <div className="flex justify-center pb-1">
                {loadingOlderMessages ? <span className="sr-only" role="status" aria-live="polite">Loading older messages…</span> : null}
                <button
                  type="button"
                  className="rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-60"
                  disabled={loadingOlderMessages}
                  onClick={(event) => { void loadOlderWithScroll(event.currentTarget.closest<HTMLElement>('[data-slot="message-scroller-viewport"]') ?? event.currentTarget); }}
                >
                  {loadingOlderMessages ? "Loading older messages…" : "Load older messages"}
                </button>
              </div>
            ) : null}
            {historyLoadError ? <div role="alert" className="px-1 text-center text-[11px] text-destructive">{historyLoadError}</div> : null}
            <div data-history-window="true" data-history-mounted={virtualHistoryItems.length} className="relative w-full" style={{ height: historyRange.totalHeight }}>
              {virtualHistoryItems.map((item) => {
                const row = historyRows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={row.key}
                    role="article"
                    {...(hasOlderMessages ? { "aria-setsize": -1 } : { "aria-setsize": historyRows.length, "aria-posinset": item.index + 1 })}
                    ref={getHistoryItemRef(row.key)}
                    className="absolute inset-x-0 top-0"
                    style={{ transform: `translateY(${item.start}px)`, paddingBottom: `${HISTORY_ROW_GAP}px` }}
                  >
                    <MessageScrollerItem>
                      {row.kind === "user" && row.group.user ? (
                        <div data-user-anchor={row.group.user.id}>
                          <BerryHistoricalUserMessage message={row.group.user} adapter={adapter} />
                        </div>
                      ) : row.kind === "assistant" ? (
                        <BerryAssistantTurnGroup
                          messages={row.group.assistants}
                          turnKey={settledTurnKey(sessionId, stableTurnGroupKey(row.group))}
                          showReasoning={showReasoning}
                          showTodos={showTodos}
                          density={density}
                          adapter={adapter}
                          writingBlockParts={writingBlockParts}
                          conversationImageParts={conversationImageParts}
                          {...(row.groupIndex === turnGroups.length - 1 && latestTurnError
                            ? { inlineError: latestTurnError }
                            : {})}
                        />
                      ) : null}
                    </MessageScrollerItem>
                  </div>
                );
              })}
            </div>

            {liveVisible ? (
              <MessageScrollerItem>
                <div className="flex flex-col gap-3">
                  {stream.timeline.length > 0 ? (
                    <BerryActivityStackBlock>
                      {stream.endStatus === "cancelled" || liveTimelineOnlyNotes ? (
                        // Codex `Yx`: a cancelled turn gets no worked-for
                        // divider at all. Standalone session notes (compact,
                        // rewind, fork) also render as bare marker rows.
                        <div className="flex w-full flex-col gap-2">{liveActivityNodes}</div>
                      ) : (
                        <TurnActivity
                          turnKey={liveTurnKey}
                          active={stream.turnActive}
                          activeLabel={activeStatus}
                          elapsedMs={stream.turnStartedAt ? now - stream.turnStartedAt : undefined}
                          liveAction={
                            stream.turnActive
                              ? latestTurnAction(liveTimelineWindow.entries.filter((entry): entry is ToolEntry => entry.kind === "tool"))
                              : null
                          }
                        >
                          {liveActivityNodes}
                        </TurnActivity>
                      )}
                    </BerryActivityStackBlock>
                  ) : stream.turnActive && stream.text.length === 0 ? (
                    <BerryActivityStackBlock>
                      {showPendingTurnActivity ? (
                        <TurnActivity
                          turnKey={liveTurnKey}
                          active
                          activeLabel={activeStatus}
                          elapsedMs={stream.turnStartedAt ? now - stream.turnStartedAt : undefined}
                        />
                      ) : (
                        // Desktop keeps Codex's compact pending treatment.
                        <ThoughtRow active reasoning="" />
                      )}
                    </BerryActivityStackBlock>
                  ) : null}
                  {stream.approval ? (
                    <BerryActivityStackBlock>
                      <BerryApprovalAccordion approval={stream.approval} adapter={adapter} />
                    </BerryActivityStackBlock>
                  ) : null}
                  {showQuestions && stream.question ? (
                    <BerryActivityStackBlock>
                      <BerryQuestionAccordion question={stream.question} adapter={adapter} />
                    </BerryActivityStackBlock>
                  ) : null}
                  {stream.text ? <BerryAssistantMarkdownBlock live={shouldUseLiveMarkdown(stream)}>{stream.text}</BerryAssistantMarkdownBlock> : null}
                  {stream.error ? <BerryAssistantErrorBlock>{stream.error}</BerryAssistantErrorBlock> : null}
                  {liveContent}
                </div>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
  );
}

/** Flatten a user message to a short single line for the navigator preview. */
function userMessageText(message: Message): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function assistantMessageText(messages: Message[]): string {
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function messageAttachmentNames(parts: MessagePart[]): string[] {
  const names = new Set<string>();
  for (const part of parts) {
    if (part.kind !== "attachment") continue;
    const attachment = MessageAttachmentContentSchema.safeParse(part.content);
    if (attachment.success) names.add(attachment.data.name);
  }
  return [...names];
}

/** "May 7, 2:07 PM" for every message so a thread remains legible in captures and history. */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Full, untruncated user text for editing/copying (parts joined verbatim). */
export function fullUserText(message: Message): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join("\n");
}

/** Return the rendered row owner for a transcript search match. */
export function findMessageSearchTarget(messages: Message[], query: string): string | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;
  for (let matchIndex = 0; matchIndex < messages.length; matchIndex += 1) {
    const match = messages[matchIndex]!;
    if (!searchableMessageText(match).includes(needle)) continue;
    if (match.role === "user") return match.id;
    for (let index = matchIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") return messages[index]!.id;
    }
    // A non-user-only page is a bounded-page boundary, not a renderable
    // anchor. Keep scanning: a later user match in this page is still a valid
    // target even when the first matching projection has no owner in-page.
  }
  return null;
}

function searchableMessageText(message: Message): string {
  const visibleParts = message.parts.flatMap((part) => {
    if (part.kind === "attachment") {
      const attachment = MessageAttachmentContentSchema.safeParse(part.content);
      return attachment.success ? [attachment.data.name] : [];
    }
    if (part.kind === "tool-call" || part.kind === "tool-result") {
      return searchableToolResultText(part.content);
    }
    // Search rendered text/code/reasoning and plain error/terminal output, but
    // never serialized tool metadata, IDs, or object keys that are not shown
    // in the transcript.
    return typeof part.content === "string"
      && ["text", "code", "reasoning", "error", "terminal"].includes(part.kind)
      ? [part.content]
      : [];
  });
  return visibleParts.join("\n").toLocaleLowerCase();
}

function searchableToolResultText(content: unknown): string[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return typeof content === "string" ? [content] : [];
  }
  const meta = content as Record<string, unknown>;
  const visible: string[] = [];
  if (typeof meta.name === "string") visible.push(meta.name);
  if (typeof meta.title === "string") visible.push(meta.title);
  if (typeof meta.summary === "string") visible.push(meta.summary);
  for (const key of ["arguments", "args"]) {
    const args = meta[key];
    if (args === undefined || args === null) continue;
    try { visible.push(typeof args === "string" ? args : JSON.stringify(args)); } catch { /* ignore */ }
  }
  if (typeof meta.output === "string") visible.push(meta.output);
  else if (meta.output !== undefined && meta.output !== null) {
    try {
      visible.push(JSON.stringify(meta.output));
    } catch {
      // Ignore non-serializable provider output just as the renderer does.
    }
  }
  if (Array.isArray(meta.children)) {
    for (const child of meta.children) {
      if (!child || typeof child !== "object" || Array.isArray(child)) continue;
      const output = (child as Record<string, unknown>).output;
      const childRecord = child as Record<string, unknown>;
      if (typeof childRecord.name === "string") visible.push(childRecord.name);
      if (typeof childRecord.title === "string") visible.push(childRecord.title);
      if (typeof childRecord.summary === "string") visible.push(childRecord.summary);
      for (const key of ["arguments", "args"]) {
        const args = childRecord[key];
        if (args === undefined || args === null) continue;
        try { visible.push(typeof args === "string" ? args : JSON.stringify(args)); } catch { /* ignore */ }
      }
      if (typeof output === "string") visible.push(output);
      else if (output !== undefined && output !== null) {
        try { visible.push(JSON.stringify(output)); } catch { /* ignore */ }
      }
    }
  }
  return visible;
}

const BerryHistoricalUserMessage = React.memo(function BerryHistoricalUserMessage({ message, adapter }: { message: Message; adapter: BerryThreadAdapter }) {
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  if (editing && adapter.renderUserEditor) {
    return <>{adapter.renderUserEditor(message, () => setEditing(false))}</>;
  }

  const imageParts = message.parts.filter(isImageMessagePart);
  const attachmentParts = message.parts.filter((part) => part.kind === "attachment");
  const bodyParts = message.parts.filter((part) => !isImageMessagePart(part) && part.kind !== "attachment");

  return (
    <MessageRow align="end" className="group">
      <MessageContent>
        <BerryUserMessageStack>
          {imageParts.map((part) => (
            <BerryMessagePartBody key={part.id} part={part} plain />
          ))}
          {attachmentParts.map((part) => (
            <BerryUserAttachmentCard key={part.id} part={part} adapter={adapter} />
          ))}
          {bodyParts.length > 0 ? (
            <BerryUserMessageBubble>
              <CollapsibleSubmittedPrompt>
                {bodyParts.map((part) => (
                  <BerryMessagePartBody key={part.id} part={part} plain />
                ))}
              </CollapsibleSubmittedPrompt>
            </BerryUserMessageBubble>
          ) : null}
        </BerryUserMessageStack>
        <MessageFooter className="gap-1 opacity-0 transition-[opacity] group-hover:opacity-100">
          <span className="select-none pr-1" title={new Date(message.createdAt).toLocaleString()}>
            {formatMessageTime(message.createdAt)}
          </span>
          {adapter.renderUserEditor ? (
            <Button variant="ghost" size="icon-sm" aria-label="Edit message" onClick={() => setEditing(true)}>
              <Pencil />
            </Button>
          ) : null}
          {adapter.onDeleteUserMessage ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete message and later responses"
              title="Delete from here"
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                void Promise.resolve(adapter.onDeleteUserMessage?.(message)).finally(() => setDeleting(false));
              }}
            >
              <Trash2 />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy message"
            onClick={() => {
              void navigator.clipboard.writeText(fullUserText(message));
              toast.success("Copied");
            }}
          >
            <Copy />
          </Button>
        </MessageFooter>
      </MessageContent>
    </MessageRow>
  );
});

/**
 * One settled agent turn: possibly several persisted assistant messages
 * rendered under a single "Worked for Xs" header (Berry shows one per user
 * turn). Tool runs that span message boundaries merge into one flow.
 */
export const BerryAssistantTurnGroup = React.memo(function BerryAssistantTurnGroup({
  messages,
  turnKey,
  showReasoning,
  showTodos,
  density,
  adapter,
  inlineError,
  writingBlockParts,
  conversationImageParts,
  onRender,
}: {
  messages: Message[];
  turnKey: string;
  showReasoning: boolean;
  showTodos: boolean;
  density: "full" | "compact";
  adapter: BerryThreadAdapter;
  inlineError?: string;
  writingBlockParts: Map<string, MessageDraftPartResolution>;
  conversationImageParts: MessagePart[];
  /** Internal render probe used by the streaming isolation regression test. */
  onRender?: () => void;
}) {
  onRender?.();
  const allParts = messages.flatMap((message) => message.parts);
  const imageParts = allParts.filter(isImageMessagePart);
  const boundaryMessageId = messages[messages.length - 1]?.id;
  const textContent = allParts
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join("\n");

  const visibleArtifactToolCallIds = latestArtifactToolCallIds(messages);
  const terminalStatus = latestTerminalMessageStatus(messages);
  const { segments, totalMs } = partitionAssistantParts(
    allParts,
    writingBlockParts,
    visibleArtifactToolCallIds,
    terminalStatus,
  );
  // Merge tool runs that were split across adjacent assistant messages.
  const merged: typeof segments = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.kind === "tools" && last && last.kind === "tools") last.tools.push(...segment.tools);
    else merged.push(segment);
  }

  // Wall-clock turn duration from message timestamps ("Worked for 1m 22s");
  // falls back to the live handoff duration, model generation time, then the
  // summed tool durations. Single-message turns often persist created/updated
  // at the same instant, so timestamps alone can collapse to plain "Worked".
  const first = messages[0];
  const last = messages[messages.length - 1];
  const wallMs = first && last ? Date.parse(last.updatedAt) - Date.parse(first.createdAt) : Number.NaN;

  // Raw inference decode throughput: output tokens ÷ the time the model spent
  // generating (first token → last token per message, summed across the turn).
  // This excludes tool execution, approvals, and idle gaps — it's the API's
  // generation speed, not wall-clock. Prefer the model's reported token count;
  // when the endpoint returns no usage, estimate from output length (~4 chars/token).
  const reportedOutputTokens = messages.reduce((sum, message) => sum + (message.outputTokens ?? 0), 0);
  const generatedChars = allParts
    .filter((part) => part.kind === "text" || part.kind === "reasoning")
    .reduce((sum, part) => sum + String(part.content).length, 0);
  const totalOutputTokens = reportedOutputTokens > 0 ? reportedOutputTokens : Math.ceil(generatedChars / 4);
  const generationMs = messages.reduce((sum, message) => sum + (message.generationMs ?? 0), 0);
  const elapsedCandidates = [
    Number.isFinite(wallMs) && wallMs > 0 ? wallMs : undefined,
    rememberedTurnElapsedMs(turnKey),
    generationMs > 0 ? generationMs : undefined,
    totalMs > 0 ? totalMs : undefined,
  ].filter((value): value is number => value !== undefined);
  const elapsedMs = elapsedCandidates.length > 0 ? Math.max(...elapsedCandidates) : undefined;
  // Historical cloud messages created before generation duration was persisted
  // can still report a useful, clearly-labelled turn-average rate.
  const tokenRateDurationMs = generationMs > 0 ? generationMs : elapsedMs;
  const tokenRateIsEstimated = generationMs <= 0 && tokenRateDurationMs != null;
  const tokensPerSecond =
    totalOutputTokens > 0 && tokenRateDurationMs != null && tokenRateDurationMs > 0
      ? totalOutputTokens / (tokenRateDurationMs / 1000)
      : undefined;

  // When the turn's reply landed.
  const turnTimestamp = last?.createdAt ?? first?.createdAt;

  // Split the turn into collapsible activity (reasoning + tool rows +
  // intermediate prose, matching the live view) and the always-visible final
  // answer, the Codex `LO`/`BO` way. The activity nests under the "Worked for
  // Xs" accordion; the final answer renders below it.
  const { activity, body, hasFinalText } = classifyTurnSegments(merged);
  let thoughtOrdinal = 0;
  const renderSegment = (segment: MessageSegment, index: number): React.ReactNode =>
    segment.kind === "tools" ? (
      <ToolFlow key={`tools-${segment.tools[0]?.toolCallId ?? index}`} tools={segment.tools} showTodos={showTodos} />
    ) : segment.kind === "thought" ? (
      <ThoughtRow
        key={segment.id}
        // Same key scheme as the live path, so a thought left open when the
        // turn settled (e.g. a reasoning-only turn) stays open.
        stateKey={`${turnKey}:thought-${thoughtOrdinal++}`}
        active={false}
        reasoning={segment.text}
        defaultOpen={showReasoning}
      />
    ) : segment.kind === "error" ? (
      <BerryAssistantErrorBlock key={segment.id}>{segment.text}</BerryAssistantErrorBlock>
    ) : segment.kind === "artifact" ? (
      <BerryArtifactCard key={segment.id} artifact={segment} onOpen={adapter.onOpenArtifact} />
    ) : segment.kind === "writing-block" ? (
      <WritingBlockController key={segment.id} draft={segment.draft} />
    ) : (
      <BerryAssistantMarkdownBlock key={segment.id}>{segment.text}</BerryAssistantMarkdownBlock>
    );
  const activityNodes = activity.map(renderSegment);
  const artifacts = body.filter((segment): segment is Extract<MessageSegment, { kind: "artifact" }> => segment.kind === "artifact");
  const bodyNodes = body.filter((segment) => segment.kind !== "artifact").map(renderSegment);

  // Codex `Yx`/`lx`: the "Worked for Xs" divider exists only for a turn that
  // produced a final answer and was not cancelled. Cancelled or answer-less
  // turns render their activity bare and expanded, with no header.
  const cancelled = messages.some((message) => message.status === "cancelled");
  const showHeader = hasFinalText && !cancelled && activityNodes.length > 0;
  const compactSummary = density === "compact" ? summarizeActivity(merged) : undefined;

  return (
    <MessageRow className="group">
      <MessageContent className="gap-3">
        {activityNodes.length > 0 ? (
          <BerryActivityStackBlock>
            {showHeader ? (
              <TurnActivity turnKey={turnKey} active={false} elapsedMs={elapsedMs} summary={compactSummary}>
                {activityNodes}
              </TurnActivity>
            ) : (
              <div className="flex w-full flex-col gap-2">{activityNodes}</div>
            )}
          </BerryActivityStackBlock>
        ) : null}
        {imageParts.length > 0 ? (
          <GeneratedImageGallery
            parts={imageParts}
            conversationParts={conversationImageParts}
            {...(adapter.onEditGeneratedImage ? { onEdit: adapter.onEditGeneratedImage } : {})}
            {...(adapter.onRegenerateGeneratedImage ? { onRegenerate: adapter.onRegenerateGeneratedImage } : {})}
          />
        ) : null}
        {bodyNodes}
        {artifacts.length > 0 ? (
          <BerryTurnArtifacts artifacts={artifacts} adapter={adapter} />
        ) : null}
        {inlineError && !merged.some((segment) => segment.kind === "error") ? (
          <BerryAssistantErrorBlock>{inlineError}</BerryAssistantErrorBlock>
        ) : null}
        <MessageFooter className="gap-1 opacity-0 transition-[opacity] group-hover:opacity-100">
          {textContent ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy message"
              onClick={() => {
                void navigator.clipboard.writeText(textContent);
                toast.success("Copied");
              }}
            >
              <Copy />
            </Button>
          ) : null}
          {adapter.onFork ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fork task"
              onClick={() => void adapter.onFork?.(boundaryMessageId)}
            >
              <GitFork />
            </Button>
          ) : null}
          {tokensPerSecond != null ? (
            <span
              className="inline-flex select-none items-center gap-1 px-2 tabular-nums"
              title={
                tokenRateIsEstimated
                  ? reportedOutputTokens > 0
                    ? "Estimated turn rate (output tokens ÷ available turn duration)"
                    : "Estimated turn rate (output tokens estimated from length ÷ available turn duration)"
                  : reportedOutputTokens > 0
                    ? "Inference decode speed (output tokens ÷ generation time)"
                    : "Inference decode speed (output tokens estimated from length ÷ generation time)"
              }
            >
              <GaugeIcon className="size-3.5" />
              {tokensPerSecond >= 10 ? tokensPerSecond.toFixed(0) : tokensPerSecond.toFixed(1)} tok/s
            </span>
          ) : null}
          {turnTimestamp ? (
            <span className="select-none pl-2" title={new Date(turnTimestamp).toLocaleString()}>
              {formatMessageTime(turnTimestamp)}
            </span>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </MessageRow>
  );
});

function summarizeActivity(segments: MessageSegment[]): string | undefined {
  const tools = segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []);
  const reads = tools.filter((tool) => tool.name === "read").length;
  const writes = tools.flatMap((tool) => {
    if (!/^(?:write|edit)$/.test(tool.name)) return [];
    const args = tool.args ?? {};
    const path = [args.path, args.file_path, args.filePath, args.file].find((value) => typeof value === "string");
    return typeof path === "string" ? [path.replace(/^.*[\\/]/, "")] : [];
  });
  const details: string[] = [];
  if (reads > 0) details.push(`read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (writes.length > 0) details.push(`wrote ${writes.slice(0, 2).join(", ")}`);
  const remaining = tools.length - reads - writes.length;
  if (details.length === 0 && remaining > 0) details.push(`ran ${remaining} ${remaining === 1 ? "tool" : "tools"}`);
  return details.length > 0 ? details.join(", ") : undefined;
}

export function BerryUserMessageStack({ children }: { children: React.ReactNode }) {
  return (
    <div data-user-message-bubble className="ml-auto flex max-w-[775px] flex-col items-end gap-2">
      {children}
    </div>
  );
}

export function BerryUserMessageBubble({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Squircle clips the box, so the border ring must be inset (an outset ring
  // would be clipped away).
  useSquircle(ref, 18);
  return (
    <div
      ref={ref}
      data-user-message-bubble-surface
      className="berry-user-message ml-auto flex max-w-[775px] flex-col gap-2 rounded-[18px] bg-secondary px-4 py-3 font-sans text-[16px] leading-6 text-secondary-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
    >
      {children}
    </div>
  );
}

const SUBMITTED_PROMPT_LINE_LIMIT = 12;

export function CollapsibleSubmittedPrompt({ children }: { children: React.ReactNode }) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setOverflowing(content.scrollHeight > content.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(content);
    return () => observer?.disconnect();
  }, [children, expanded]);

  return (
    <div className="grid min-w-0 gap-1.5">
      <div
        ref={contentRef}
        className={cn("min-w-0", !expanded && "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]")}
        style={expanded ? undefined : { WebkitLineClamp: SUBMITTED_PROMPT_LINE_LIMIT }}
      >
        {children}
      </div>
      {overflowing || expanded ? (
        <button
          type="button"
          className="w-fit rounded-md text-xs font-medium text-[var(--berry-text-secondary)] underline-offset-2 hover:text-[var(--berry-text-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--berry-focus)]"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function BerryUserAttachmentCard({ part, adapter }: { part: MessagePart; adapter: BerryThreadAdapter }) {
  const parsed = MessageAttachmentContentSchema.safeParse(part.content);
  if (!parsed.success) return null;
  const attachment = parsed.data;
  if (attachment.sourceKind === "generated-image-reference") {
    return (
      <button
        type="button"
        className="me-1 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--berry-text-tertiary)] transition-[background-color,color] hover:bg-[var(--berry-hover)] hover:text-[var(--berry-text-primary)]"
        onClick={() => void adapter.onOpenAttachment?.(attachment)}
        disabled={!attachment.fileId || !adapter.onOpenAttachment}
        aria-label={`Open source image ${attachment.name}`}
      >
        <ArrowRight02 className="size-3.5" />
        <span className="grid size-7 place-items-center rounded-md bg-[var(--berry-control-bg)] opacity-70">
          <FileImage className="size-4" />
        </span>
        <span>Edited image</span>
      </button>
    );
  }
  return (
    <Attachment
      size="default"
      className="w-full max-w-[560px] flex-nowrap border-0 bg-card shadow-[var(--berry-ring-subtle)]"
      role="group"
      aria-label={`Attached file: ${attachment.name}`}
    >
      {attachment.fileId && adapter.onOpenAttachment ? (
        <AttachmentTrigger onClick={() => void adapter.onOpenAttachment?.(attachment)} aria-label={`Open ${attachment.name}`} />
      ) : null}
      <AttachmentMedia className="bg-transparent"><FileTypeIcon path={attachment.name} className="size-10" /></AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={attachment.name}>{attachment.name}</AttachmentTitle>
        <AttachmentDescription>{attachmentDescription(attachment)}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}

function attachmentDescription(attachment: MessageAttachmentContent): string {
  const extension = attachment.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase();
  const type = extension ?? attachment.mediaType.split("/", 2)[1]?.split(/[.+-]/, 1)[0]?.toUpperCase() ?? "FILE";
  if (attachment.size <= 0) return type;
  const size = attachment.size < 1024 * 1024
    ? `${Math.max(1, Math.round(attachment.size / 1024))} KB`
    : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;
  return `${type} · ${size}`;
}

export function BerryAssistantMarkdownBlock({ children, live = false }: { children: string; live?: boolean }) {
  // Berry has no per-message enter animation: the only "typing" cue is the
  // word-reveal lag inside Markdown itself.
  return (
    <div className="berry-assistant-message max-w-[1150px] text-foreground">
      <Markdown streaming={live}>{children}</Markdown>
    </div>
  );
}

export function BerryAssistantErrorBlock({ children }: { children: string }) {
  return (
    <div role="alert" className="max-w-[980px] text-[13px] leading-5 text-destructive">
      {children}
    </div>
  );
}

function BerryArtifactCard({ artifact, onOpen }: { artifact: Extract<MessageSegment, { kind: "artifact" }>; onOpen?: BerryThreadAdapter["onOpenArtifact"] }) {
  const size = artifact.size != null ? formatArtifactSize(artifact.size) : undefined;
  const content = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center">
        <FileTypeIcon path={artifact.name} className="size-10" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{artifact.name}</span>
        {size || artifact.mediaType ? <span className="block text-xs text-muted-foreground">{[size, artifact.mediaType].filter(Boolean).join(" · ")}</span> : null}
      </span>
      <span className="text-xs font-medium text-primary">Open</span>
    </>
  );
  const className = "inline-flex w-fit min-w-60 max-w-[min(100%,480px)] items-center gap-3 rounded-[14px] border-0 bg-card px-3.5 py-3 text-left text-foreground shadow-[var(--berry-ring-subtle)] transition-[background-color] hover:bg-accent";
  if (onOpen) {
    return <button type="button" className={className} onClick={() => void onOpen(artifact)}>{content}</button>;
  }
  return <a href={artifact.path} target="_blank" rel="noreferrer" className={className}>{content}</a>;
}

function BerryTurnArtifacts({ artifacts, adapter }: {
  artifacts: Array<Extract<MessageSegment, { kind: "artifact" }>>;
  adapter: BerryThreadAdapter;
}) {
  return (
    <div className="flex max-w-[980px] flex-wrap gap-2" aria-label="Files generated in this turn">
      {artifacts.map((artifact) => (
        <BerryArtifactCard key={artifact.id} artifact={artifact} onOpen={adapter.onOpenArtifact} />
      ))}
      {adapter.onViewTaskFiles ? (
        <button
          type="button"
          className="inline-flex min-h-16 w-fit min-w-60 max-w-[min(100%,480px)] items-center gap-3 rounded-[14px] bg-card px-3.5 py-3 text-left text-sm font-medium text-muted-foreground shadow-[var(--berry-ring-subtle)] transition-[background-color,color] hover:bg-accent hover:text-foreground"
          onClick={adapter.onViewTaskFiles}
        >
          <FileTypeIcon path="task" isDirectory className="size-10" />
          View all files in this task
        </button>
      ) : null}
    </div>
  );
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BerryActivityStackBlock({ children }: { children: React.ReactNode }) {
  return <div className="berry-activity-stack flex max-w-[1360px] flex-col gap-2">{children}</div>;
}

export function latestTerminalMessageStatus(
  messages: readonly Message[],
): Exclude<Message["status"], "streaming"> | undefined {
  const status = messages.at(-1)?.status;
  return status && status !== "streaming" ? status : undefined;
}

/**
 * Splits a settled agent turn into an ordered stream of reasoning, tool runs,
 * and prose — walking parts in document order like Berry. Consecutive tools
 * merge into one run (ToolFlow then groups them into "Explore"); reasoning
 * renders inline as a "Thought" row. Tool-call/tool-result parts sharing a
 * call id collapse to one entry with the final status/output.
 */
export function partitionAssistantParts(
  parts: MessagePart[],
  writingBlockParts: Map<string, MessageDraftPartResolution> = new Map(),
  visibleArtifactToolCallIds?: ReadonlySet<string>,
  terminalStatus?: Message["status"],
): {
  segments: MessageSegment[];
  totalMs: number;
  hadTools: boolean;
} {
  const toolMap = new Map<string, ActivityTool>();
  const segments: MessageSegment[] = [];

  const upsertTool = (id: string, meta: Record<string, unknown>, fromResult: boolean) => {
    const existing = toolMap.get(id);
    const args =
      meta.arguments && typeof meta.arguments === "object" && !Array.isArray(meta.arguments)
        ? (meta.arguments as Record<string, unknown>)
        : existing?.args ?? null;
    const output =
      typeof meta.output === "string"
        ? meta.output
        : meta.output !== undefined && meta.output !== null
          ? JSON.stringify(meta.output)
          : existing?.output;
    // Persisted sub-agent child tool calls (on the `task` tool) → nested tools.
    const children: ActivityTool[] | undefined = Array.isArray(meta.children)
      ? (meta.children as Array<Record<string, unknown>>).map((child) => ({
          toolCallId: typeof child.toolCallId === "string" ? child.toolCallId : "",
          name: typeof child.name === "string" ? child.name : "tool",
          args:
            child.args && typeof child.args === "object" && !Array.isArray(child.args)
              ? (child.args as Record<string, unknown>)
              : null,
          status: toolStatusFromMeta(child.status),
          ...(typeof child.output === "string" ? { output: child.output } : {}),
          ...(typeof child.durationMs === "number" ? { durationMs: child.durationMs } : {}),
          startedAt: typeof child.startedAt === "number" ? child.startedAt : 0,
        }))
      : existing?.children;
    const tool: ActivityTool = {
      toolCallId: id,
      name: typeof meta.name === "string" ? meta.name : existing?.name ?? "tool",
      title: typeof meta.title === "string" ? meta.title : existing?.title,
      args,
      ...(output !== undefined ? { output } : {}),
      ...(children ? { children } : {}),
      status: fromResult ? toolStatusFromMeta(meta.status) : existing?.status ?? toolStatusFromMeta(meta.status),
      summary: typeof meta.summary === "string" ? meta.summary : existing?.summary,
      durationMs: typeof meta.durationMs === "number" ? meta.durationMs : existing?.durationMs,
      startedAt: existing?.startedAt ?? 0,
    };
    toolMap.set(id, tool);
    if (existing) {
      // Update in place inside whichever segment holds it.
      for (const segment of segments) {
        if (segment.kind !== "tools") continue;
        const at = segment.tools.findIndex((candidate) => candidate.toolCallId === id);
        if (at !== -1) {
          segment.tools[at] = tool;
          return;
        }
      }
      return;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === "tools") last.tools.push(tool);
    else segments.push({ kind: "tools", tools: [tool] });
  };

  for (const part of parts) {
    if (part.kind === "tool-call" || part.kind === "tool-result") {
      const meta =
        part.content && typeof part.content === "object" && !Array.isArray(part.content)
          ? (part.content as Record<string, unknown>)
          : {};
      const id = typeof meta.toolCallId === "string" ? meta.toolCallId : part.id;
      if (meta.name === "compose_message") {
        if (part.kind === "tool-result") {
          const resolved = writingBlockParts.get(part.id);
          const draft = resolved?.draft ?? messageDraftFromToolResult(part.content);
          if (draft) {
            segments.push({ kind: "writing-block", id: `writing-block-${part.id}`, draft });
          }
        }
        continue;
      }
      // Finalization can discover files left in /workspace/outputs by an
      // earlier turn and project result-only persist_artifact messages for
      // them. When a settled turn has an explicit, completed publication
      // batch, keep both the cards and activity rows scoped to that batch.
      // Otherwise stale result-only rows land after the final answer and make
      // it look like the current turn published every historical output.
      const visibleArtifactActivity = meta.name !== "persist_artifact"
        || !visibleArtifactToolCallIds
        || visibleArtifactToolCallIds.has(id);
      if (visibleArtifactActivity) upsertTool(id, meta, part.kind === "tool-result");
      if (
        part.kind === "tool-result"
        && meta.name === "persist_artifact"
        && (!visibleArtifactToolCallIds || visibleArtifactToolCallIds.has(id))
      ) {
        const result = meta.output && typeof meta.output === "object" && !Array.isArray(meta.output)
          ? (meta.output as Record<string, unknown>)
          : undefined;
        const artifact = result?.artifact && typeof result.artifact === "object" && !Array.isArray(result.artifact)
          ? (result.artifact as Record<string, unknown>)
          : undefined;
        const path = typeof artifact?.path === "string" ? artifact.path : typeof result?.path === "string" ? result.path : undefined;
        const name = typeof artifact?.name === "string" ? artifact.name : undefined;
        if (path && name) {
          segments.push({
            kind: "artifact",
            id: `${part.id}-artifact`,
            name,
            path,
            ...(typeof artifact?.mediaType === "string" ? { mediaType: artifact.mediaType } : {}),
            ...(typeof artifact?.size === "number" ? { size: artifact.size } : {}),
          });
        }
      }
    } else if (part.kind === "reasoning") {
      const text = String(part.content);
      // Always keep reasoning so "Thought" rows expand to the real text.
      if (text.trim().length > 0) segments.push({ kind: "thought", id: part.id, text });
    } else if (part.kind === "text") {
      const text = String(part.content);
      if (text.trim().length > 0) segments.push({ kind: "text", id: part.id, text });
    } else if (part.kind === "error") {
      segments.push({ kind: "error", id: part.id, text: String(part.content) });
    }
  }

  if (terminalStatus && terminalStatus !== "streaming") {
    const status = toolTerminalStatus(terminalStatus);
    for (const segment of segments) {
      if (segment.kind === "tools") segment.tools = settleRunningActivityTools(segment.tools, status);
    }
  }
  const tools = segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return { segments, totalMs, hadTools: tools.length > 0 };
}

/**
 * A durable user turn can contain many model/tool iterations. Each model
 * message that calls persist_artifact declares one publication batch. Only
 * the latest batch with settled results belongs in the visible response;
 * earlier batches remain available in the task files and activity history.
 */
export function latestArtifactToolCallIds(messages: Message[]): ReadonlySet<string> | undefined {
  const completed = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool-result") continue;
      const meta = part.content && typeof part.content === "object" && !Array.isArray(part.content)
        ? part.content as Record<string, unknown>
        : undefined;
      if (meta?.name !== "persist_artifact" || meta.status !== "completed") continue;
      const toolCallId = typeof meta.toolCallId === "string" ? meta.toolCallId : undefined;
      if (toolCallId) completed.add(toolCallId);
    }
  }

  let latest: Set<string> | undefined;
  for (const message of messages) {
    const batch = new Set<string>();
    for (const part of message.parts) {
      if (part.kind !== "tool-call") continue;
      const meta = part.content && typeof part.content === "object" && !Array.isArray(part.content)
        ? part.content as Record<string, unknown>
        : undefined;
      if (meta?.name !== "persist_artifact") continue;
      const toolCallId = typeof meta.toolCallId === "string" ? meta.toolCallId : part.id;
      if (completed.has(toolCallId)) batch.add(toolCallId);
    }
    if (batch.size > 0) latest = batch;
  }
  return latest;
}

export interface MessageDraftPartResolution {
  draft: MessageDraft;
}

/**
 * Every completed compose_message result remains attached to its own timeline
 * part. The stable draft id still identifies the logical artifact for model
 * follow-ups, while the part id preserves each revision as a separate card.
 */
export function collectMessageDraftParts(messages: Message[]): Map<string, MessageDraftPartResolution> {
  const resolved = new Map<string, MessageDraftPartResolution>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool-result") continue;
      const draft = messageDraftFromToolResult(part.content);
      if (!draft) continue;
      resolved.set(part.id, { draft });
    }
  }
  return resolved;
}

export function BerryApprovalAccordion({ approval, adapter }: { approval: ApprovalPrompt; adapter: BerryThreadAdapter }) {
  const [pending, setPending] = React.useState(false);
  const decide = async (decision: ApprovalDecision) => {
    if (!adapter.onApprovalDecide) return;
    setPending(true);
    try {
      await adapter.onApprovalDecide(approval, decision);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="berry-activity-surface overflow-hidden">
      <Accordion type="single" collapsible defaultValue="approval">
        <AccordionItem value="approval" className="border-none">
          <AccordionTrigger className="px-3 py-2 text-left hover:no-underline">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <ShieldQuestion className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{approval.title}</span>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">{approval.approvalKind}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-3 pb-3">
            <ApprovalEvidence
              detail={approval.detail}
              rawDetail={approval.rawDetail}
              diff={approval.diff}
              destructive={approval.destructive}
              openWorld={approval.openWorld}
              fallback={approval.subject ?? "Approval is required before Berry continues."}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {adapter.onApprovalDecide ? (
        <div className="flex flex-wrap gap-2 px-3 pb-3">
          <Button size="sm" className="min-h-10" disabled={pending} onClick={() => void decide("approved_once")}>
            Allow once
          </Button>
          <Button size="sm" className="min-h-10" variant="outline" disabled={pending} onClick={() => void decide("approved_for_session")}>
            Session
          </Button>
          <Button size="sm" className="min-h-10" variant="outline" disabled={pending} title={approval.subject} onClick={() => void decide("approved_rule")}>
            Always
          </Button>
          <Button size="sm" className="min-h-10" variant="outline" disabled={pending} onClick={() => void decide("denied")}>
            Deny
          </Button>
          <Button size="sm" className="min-h-10" variant="ghost" disabled={pending} onClick={() => void decide("abort")}>
            Abort
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function BerryQuestionAccordion({ question, adapter }: { question: QuestionPrompt; adapter: BerryThreadAdapter }) {
  const [pending, setPending] = React.useState(false);
  const [answer, setAnswer] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const toggleOption = (label: string) => {
    setSelected((current) => {
      if (question.multi) return current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
      return current.includes(label) ? [] : [label];
    });
  };
  const submit = async () => {
    const trimmed = answer.trim();
    const finalAnswer = trimmed || selected.join(", ");
    if (!finalAnswer || pending || !adapter.onQuestionAnswer) return;
    setPending(true);
    try {
      await adapter.onQuestionAnswer(question, finalAnswer, selected);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="berry-activity-surface overflow-hidden">
      <Accordion type="single" collapsible defaultValue="question">
        <AccordionItem value="question" className="border-none">
          <AccordionTrigger className="px-3 py-2 text-left hover:no-underline">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <CircleHelp className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">Berry needs an answer</span>
              {question.multi ? <span className="shrink-0 text-xs font-normal text-muted-foreground">multi-select</span> : null}
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 px-3 pb-3">
            <p className="text-sm leading-5 text-foreground">{question.question}</p>
            {question.options.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {question.options.map((option) => {
                  const active = selected.includes(option.label);
                  return (
                    <Button
                      key={option.label}
                      type="button"
                      variant={active ? "default" : "outline"}
                      disabled={pending}
                      className="h-auto min-h-10 w-full min-w-0 items-start justify-start overflow-hidden whitespace-normal px-3 py-2 text-left"
                      onClick={() => toggleOption(option.label)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden">
                        <span className="max-w-full break-words text-sm leading-5">{option.label}</span>
                        {option.description ? (
                          <span className="line-clamp-2 max-w-full break-words text-pretty text-xs leading-4 font-normal opacity-75">{option.description}</span>
                        ) : null}
                      </span>
                    </Button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={answer}
                disabled={pending}
                placeholder={selected.length > 0 ? "Add detail, or send selected option" : "Type an answer"}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <Button className="sm:w-24" disabled={pending || (!answer.trim() && selected.length === 0)} onClick={() => void submit()}>
                Send
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

export function BerryMessagePartBody({ part, plain = false }: { part: MessagePart; plain?: boolean }) {
  const content = String(part.content ?? "");
  if (isImageMessagePart(part)) {
    const image = generatedImageFromPart(part);
    return (
      <img
        data-user-attachment-image
        src={image?.src ?? content}
        alt={image?.title ?? "attachment"}
        className="aspect-square w-36 max-w-[min(42vw,180px)] rounded-[14px] object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 sm:w-44"
      />
    );
  }
  if (plain && content.startsWith("Create image\n")) {
    return (
      <span className="flex flex-col gap-1.5">
        <span className="inline-flex w-fit max-w-64 items-center gap-1.5 rounded-lg border border-[var(--berry-border)] bg-[var(--berry-control-bg)] px-2 py-1 text-xs font-medium">
          <ImagePlus className="size-3.5 shrink-0" />
          <span className="truncate">Create image</span>
        </span>
        <span className="whitespace-pre-wrap">{content.slice("Create image\n".length)}</span>
      </span>
    );
  }
  if (plain) return <span className="whitespace-pre-wrap">{content}</span>;
  return <Markdown>{content}</Markdown>;
}

function toolStatusFromMeta(value: unknown): ToolEntry["status"] {
  if (value === "running" || value === "failed" || value === "denied" || value === "completed" || value === "cancelled") return value;
  return "completed";
}

function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

// The old shared berry-thread.tsx primitives (BerryUserMessage, BerryTurnActivity,
// BerryThoughtRow, BerryToolRows) are superseded by this full view; keep the
// user-editor frame class exported for adapters that build inline editors.
export function BerryUserEditorFrame({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <div
          {...props}
          className={cn("berry-user-editor relative ml-auto flex w-[775px] max-w-full flex-col rounded-[22px]", className)}
        >
          {children}
        </div>
      </MessageContent>
    </MessageRow>
  );
}
