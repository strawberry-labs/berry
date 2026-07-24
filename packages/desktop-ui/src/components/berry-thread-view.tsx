import * as React from "react";
import { MessageAttachmentContentSchema, type Message, type MessageAttachmentContent, type MessagePart } from "@berry/shared";
import { CircleHelp, Copy, GaugeIcon, GitFork, Pencil, ShieldQuestion, Trash2 } from "@berry/desktop-ui/lib/icons";
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
  type ApprovalPrompt,
  type MessageSegment,
  type QuestionPrompt,
  type StreamState,
  type ToolEntry,
} from "@berry/desktop-ui/components/thread-stream";

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
}

const rememberedTurnElapsed = new Map<string, number>();
const REMEMBERED_TURN_ELAPSED_CAP = 800;

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

export interface BerryThreadViewProps {
  sessionId: string;
  taskId?: string;
  stream: StreamState;
  messages: Message[];
  density?: "full" | "compact";
  autoScroll?: boolean;
  showReasoning?: boolean;
  showTodos?: boolean;
  /** Web presents questions over its composer; desktop keeps its inline card. */
  showQuestions?: boolean;
  /** Show the elapsed turn clock before the provider emits its first work item. */
  showPendingTurnActivity?: boolean;
  /** Native desktop keeps the rail 16px from its window edge; web uses 12px. */
  navigatorInset?: number;
  adapter?: BerryThreadAdapter;
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
  density = "full",
  autoScroll = true,
  showReasoning = false,
  showTodos = true,
  showQuestions = true,
  showPendingTurnActivity = false,
  navigatorInset = 12,
  adapter = {},
}: BerryThreadViewProps) {
  const now = useNow(stream.turnActive);
  const settled = messages.filter((message) => message.id !== stream.messageId || !stream.turnActive);

  // Berry shows ONE "Worked for Xs" per user turn; the agent loop persists
  // several assistant messages per turn, so group consecutive ones.
  const turnGroups: Array<{ key: string; user?: Message; assistants: Message[] }> = [];
  for (const message of settled) {
    if (message.role === "user") {
      turnGroups.push({ key: message.id, user: message, assistants: [] });
    } else {
      const last = turnGroups[turnGroups.length - 1];
      if (last) last.assistants.push(message);
      else turnGroups.push({ key: message.id, assistants: [message] });
    }
  }
  const latestTurn = turnGroups[turnGroups.length - 1];
  const liveHasContent =
    stream.turnActive ||
    Boolean(stream.approval) ||
    Boolean(stream.question) ||
    stream.text.length > 0 ||
    stream.timeline.length > 0 ||
    stream.reasoning.length > 0 ||
    Boolean(stream.error);
  const liveHasSessionNote = stream.timeline.some((entry) => entry.kind === "note");
  const latestTurnHasSettledAssistant = Boolean(latestTurn?.user && latestTurn.assistants.length > 0);
  // The host stores settled assistant messages with database ids, not the
  // transient stream message id. Use the latest user turn as the handoff
  // boundary so a stopped turn cannot render both persisted and live activity.
  const liveVisible =
    liveHasContent && (stream.turnActive || Boolean(stream.approval) || Boolean(stream.question) || liveHasSessionNote || !latestTurnHasSettledAssistant);
  const renderedTurnGroups =
    liveVisible && latestTurn?.user
      ? turnGroups.map((group, index) => (index === turnGroups.length - 1 ? { ...group, assistants: [] } : group))
      : turnGroups;
  // Turn accordion state is keyed by session + turn ordinal: stable across the
  // live → persisted render-path handoff, so disclosure state never resets.
  const liveTurnIndex = latestTurn?.user ? turnGroups.length - 1 : turnGroups.length;
  const liveTurnKey = `${sessionId}:turn-${liveTurnIndex}`;

  React.useEffect(() => {
    if (!stream.endStatus || !stream.turnStartedAt) return;
    rememberTurnElapsed(liveTurnKey, Date.now() - stream.turnStartedAt);
  }, [liveTurnKey, stream.endStatus, stream.turnStartedAt]);

  // A rerun turn (edit-and-resubmit truncates and reuses ordinals) must not
  // inherit disclosure state from the turns it replaced. Clear until the
  // answer starts — after that the user may be toggling this very turn.
  React.useEffect(() => {
    if (stream.turnActive && !stream.sawText) forgetTurnDisclosure(sessionId, liveTurnIndex);
  }, [sessionId, stream.turnActive, stream.sawText, liveTurnIndex]);

  const liveSegments = groupLiveTimeline(stream.timeline);
  const liveTimelineOnlyNotes = stream.timeline.length > 0 && stream.timeline.every((entry) => entry.kind === "note");
  let liveThoughtOrdinal = 0;
  const liveActivityNodes = liveSegments.map((segment, index) => {
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
  });

  const navContainerRef = React.useRef<HTMLDivElement>(null);
  const navigatorItems: NavigatorItem[] = renderedTurnGroups
    .filter((group): group is typeof group & { user: Message } => Boolean(group.user))
    .map((group) => ({
      id: group.user.id,
      label: userMessageText(group.user),
      preview: assistantMessageText(group.assistants),
      resources: messageAttachmentNames([...group.user.parts, ...group.assistants.flatMap((assistant) => assistant.parts)]),
    }));

  return (
    <MessageScrollerProvider autoScroll={autoScroll} scrollEdgeThreshold={96}>
      <div ref={navContainerRef} className="relative flex min-h-0 flex-1 flex-col">
        <ConversationNavigator containerRef={navContainerRef} items={navigatorItems} inset={navigatorInset} />
        <MessageScroller className="flex-1">
        <MessageScrollerViewport className="px-6">
          <MessageScrollerContent data-density={density} className="berry-thread-content mx-auto w-full gap-5 py-10">
            {renderedTurnGroups.map((group, groupIndex) => (
              <React.Fragment key={group.key}>
                {group.user ? (
                  <MessageScrollerItem virtualize>
                    <div data-user-anchor={group.user.id}>
                      <BerryHistoricalUserMessage message={group.user} adapter={adapter} />
                    </div>
                  </MessageScrollerItem>
                ) : null}
                {group.assistants.length > 0 ? (
                  <MessageScrollerItem virtualize>
                    <BerryAssistantTurnGroup
                      messages={group.assistants}
                      turnKey={`${sessionId}:turn-${groupIndex}`}
                      showReasoning={showReasoning}
                      showTodos={showTodos}
                      density={density}
                      adapter={adapter}
                    />
                  </MessageScrollerItem>
                ) : null}
              </React.Fragment>
            ))}

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
                          elapsedMs={stream.turnStartedAt ? now - stream.turnStartedAt : undefined}
                          liveAction={
                            stream.turnActive
                              ? latestTurnAction(stream.timeline.filter((entry): entry is ToolEntry => entry.kind === "tool"))
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
                          elapsedMs={stream.turnStartedAt ? now - stream.turnStartedAt : undefined}
                        >
                          <ThoughtRow active reasoning="" />
                        </TurnActivity>
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
                  {stream.text ? <BerryAssistantMarkdownBlock live>{stream.text}</BerryAssistantMarkdownBlock> : null}
                  {stream.error ? <BerryAssistantErrorBlock>{stream.error}</BerryAssistantErrorBlock> : null}
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

function BerryHistoricalUserMessage({ message, adapter }: { message: Message; adapter: BerryThreadAdapter }) {
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
              {bodyParts.map((part) => (
                <BerryMessagePartBody key={part.id} part={part} plain />
              ))}
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
}

/**
 * One settled agent turn: possibly several persisted assistant messages
 * rendered under a single "Worked for Xs" header (Berry shows one per user
 * turn). Tool runs that span message boundaries merge into one flow.
 */
function BerryAssistantTurnGroup({
  messages,
  turnKey,
  showReasoning,
  showTodos,
  density,
  adapter,
}: {
  messages: Message[];
  turnKey: string;
  showReasoning: boolean;
  showTodos: boolean;
  density: "full" | "compact";
  adapter: BerryThreadAdapter;
}) {
  const allParts = messages.flatMap((message) => message.parts);
  const imageParts = allParts.filter(isImageMessagePart);
  const boundaryMessageId = messages[messages.length - 1]?.id;
  const textContent = allParts
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join("\n");

  const { segments, totalMs } = partitionAssistantParts(allParts);
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
          <div className="flex max-w-[775px] flex-wrap gap-2">
            {imageParts.map((part) => <BerryMessagePartBody key={part.id} part={part} />)}
          </div>
        ) : null}
        {bodyNodes}
        {artifacts.length > 0 ? (
          <BerryTurnArtifacts artifacts={artifacts} adapter={adapter} />
        ) : null}
        <MessageFooter className="gap-1 opacity-0 transition-[opacity] group-hover:opacity-100">
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
          {adapter.onFork ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fork conversation"
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
}

function summarizeActivity(segments: MessageSegment[]): string | undefined {
  const tools = segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []);
  const reads = tools.filter((tool) => /^(?:read|read_file|file\.read)$/.test(tool.name)).length;
  const writes = tools.flatMap((tool) => {
    if (!/^(?:write|write_file|edit|edit_file|apply_patch|file\.write)$/.test(tool.name)) return [];
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

function BerryUserAttachmentCard({ part, adapter }: { part: MessagePart; adapter: BerryThreadAdapter }) {
  const parsed = MessageAttachmentContentSchema.safeParse(part.content);
  if (!parsed.success) return null;
  const attachment = parsed.data;
  return (
    <Attachment
      size="default"
      className="w-full max-w-[560px] flex-nowrap border-0 bg-card shadow-[var(--berry-ring-subtle)]"
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
    <div className="max-w-[1360px] rounded-[14px] bg-destructive/10 px-3.5 py-3 text-sm text-destructive shadow-[var(--berry-ring-subtle)]">
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

/**
 * Splits a settled agent turn into an ordered stream of reasoning, tool runs,
 * and prose — walking parts in document order like Berry. Consecutive tools
 * merge into one run (ToolFlow then groups them into "Explore"); reasoning
 * renders inline as a "Thought" row. Tool-call/tool-result parts sharing a
 * call id collapse to one entry with the final status/output.
 */
export function partitionAssistantParts(parts: MessagePart[]): {
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
      upsertTool(id, meta, part.kind === "tool-result");
      if (part.kind === "tool-result" && meta.name === "persist_artifact") {
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

  const tools = [...toolMap.values()];
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return { segments, totalMs, hadTools: tools.length > 0 };
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
    return (
      <img
        data-user-attachment-image
        src={content}
        alt="attachment"
        className="aspect-square w-36 max-w-[min(42vw,180px)] rounded-[14px] object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 sm:w-44"
      />
    );
  }
  if (plain) return <span className="whitespace-pre-wrap">{content}</span>;
  return <Markdown>{content}</Markdown>;
}

export function isImageMessagePart(part: MessagePart): boolean {
  const source = String(part.content ?? "");
  return part.kind === "image" && (source.startsWith("data:") || source.startsWith("https://") || source.startsWith("http://"));
}

function toolStatusFromMeta(value: unknown): ToolEntry["status"] {
  if (value === "running" || value === "failed" || value === "denied" || value === "completed") return value;
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
