import * as React from "react";
import { StyleSheet, View } from "react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { activeMessageDraftVariantIndex, type Message } from "@berry/shared";
import { latestTurnActionText } from "@berry/client-core/activity-rows";
import { classifyTurnSegments, groupLiveTimeline, windowLiveTimeline, type MessageSegment, type StreamState, type ToolEntry } from "@berry/client-core/thread-stream";
import {
  assistantTurnText,
  collectMessageDraftParts,
  formatMessageTime,
  groupSettledTurns,
  isImageMessagePart,
  latestArtifactToolCallIds,
  latestTerminalMessageStatus,
  liveTurnVisible,
  mergeAdjacentToolSegments,
  partitionAssistantParts,
  settledTurnKey,
  settledTurnTiming,
  shouldReplaceLatestSettledAssistantWithLiveTurn,
  shouldUseLiveMarkdown,
  stableTurnGroupKey,
  type TurnGroup,
} from "@berry/client-core/thread-turns";
import { Button } from "../../ui/button";
import { Copy } from "../../ui/icons";
import { Spinner } from "../../ui/primitives";
import { Text } from "../../ui/text";
import { ActivityNote, ThoughtRow, ToolFlow, TurnActivity } from "./activity";
import { ApprovalCard, ArtifactCard, AssistantError, AssistantMarkdown, MessageImage, UserMessage, WritingBlock, type ApprovalDecision } from "./thread-parts";


type Row =
  | { key: string; kind: "older" }
  | { key: string; kind: "user"; message: Message }
  | { key: string; kind: "assistant"; group: TurnGroup; turnKey: string; inlineError?: string | undefined }
  | { key: string; kind: "live" };

/** Remembered live-run durations, so a settled turn keeps its "Worked for Xs". */
const rememberedElapsed = new Map<string, number>();

/**
 * The web's BerryThreadView on a native list: settled turn groups (user
 * bubble + one "Worked for Xs" assistant turn per prompt) and the live turn,
 * kept pinned to the bottom while it streams.
 */
export function ThreadView({ sessionId, messages, stream, hasOlder, loadingOlder, activeLabel, latestTurnError, onLoadOlder, onApprovalDecide, contentInsetBottom }: {
  sessionId: string;
  messages: Message[];
  stream: StreamState;
  hasOlder: boolean;
  loadingOlder: boolean;
  activeLabel?: string | undefined;
  latestTurnError?: string | undefined;
  onLoadOlder: () => void;
  onApprovalDecide: (decision: ApprovalDecision) => Promise<void>;
  contentInsetBottom: number;
}) {
  const listRef = React.useRef<FlashListRef<Row>>(null);
  const identitiesRef = React.useRef(new Map<string, string>());
  const settled = React.useMemo(() => messages.filter((message) => message.id !== stream.messageId || !stream.turnActive), [messages, stream.messageId, stream.turnActive]);
  const groups = React.useMemo(() => groupSettledTurns(settled, identitiesRef.current), [settled]);
  const latestTurn = groups[groups.length - 1];
  const liveVisible = liveTurnVisible(stream, latestTurn);
  const replaceLatest = shouldReplaceLatestSettledAssistantWithLiveTurn({ liveVisible, latestTurnHasUser: Boolean(latestTurn?.user), continuation: stream.continuation });
  const liveTurnKey = settledTurnKey(sessionId, latestTurn?.key ?? stream.turnId ?? "live");

  React.useEffect(() => {
    if (stream.endStatus && stream.turnStartedAt) rememberedElapsed.set(liveTurnKey, Date.now() - stream.turnStartedAt);
  }, [liveTurnKey, stream.endStatus, stream.turnStartedAt]);

  const rows = React.useMemo<Row[]>(() => {
    const next: Row[] = hasOlder ? [{ key: "older", kind: "older" }] : [];
    groups.forEach((group, index) => {
      if (group.user) next.push({ key: `${group.user.id}:user`, kind: "user", message: group.user });
      const last = index === groups.length - 1;
      if (group.assistants.length > 0 && !(replaceLatest && last)) {
        next.push({
          key: `${stableTurnGroupKey(group)}:assistant`,
          kind: "assistant",
          group,
          turnKey: settledTurnKey(sessionId, stableTurnGroupKey(group)),
          ...(last && latestTurnError ? { inlineError: latestTurnError } : {}),
        });
      }
    });
    if (liveVisible) next.push({ key: "live", kind: "live" });
    return next;
  }, [groups, hasOlder, latestTurnError, liveVisible, replaceLatest, sessionId]);

  const renderItem = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case "older":
        return (
          <View style={styles.older}>
            {loadingOlder ? <Spinner /> : <Button variant="outline" size="sm" label="Load older messages" onPress={onLoadOlder} />}
          </View>
        );
      case "user":
        return <View style={styles.row}><UserMessage message={item.message} /></View>;
      case "assistant":
        return <View style={styles.row}><AssistantTurn messages={item.group.assistants} turnKey={item.turnKey} inlineError={item.inlineError} /></View>;
      case "live":
        return <View style={styles.row}><LiveTurn stream={stream} turnKey={liveTurnKey} activeLabel={activeLabel} onApprovalDecide={onApprovalDecide} /></View>;
    }
  };

  return (
    <FlashList
      ref={listRef}
      data={rows}
      renderItem={renderItem}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      // The live row's object is stable; re-render visible rows as the stream moves.
      extraData={{ stream, loadingOlder, activeLabel }}
      maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2, animateAutoScrollToBottom: false }}
      onStartReached={hasOlder && !loadingOlder ? onLoadOlder : undefined}
      onStartReachedThreshold={0.2}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: 12, paddingBottom: contentInsetBottom }}
      accessibilityLabel="Task message history"
    />
  );
}

/* ------------------------------ Settled turn ------------------------------ */

const AssistantTurn = React.memo(function AssistantTurn({ messages, turnKey, inlineError }: { messages: Message[]; turnKey: string; inlineError?: string | undefined }) {
  const allParts = messages.flatMap((message) => message.parts);
  const imageParts = allParts.filter(isImageMessagePart);
  const drafts = React.useMemo(() => collectMessageDraftParts(messages), [messages]);
  const { segments, totalMs } = partitionAssistantParts(allParts, drafts, latestArtifactToolCallIds(messages), latestTerminalMessageStatus(messages));
  const merged = mergeAdjacentToolSegments(segments);
  const { activity, body, hasFinalText } = classifyTurnSegments(merged);
  const timing = settledTurnTiming(messages, totalMs, rememberedElapsed.get(turnKey));
  const cancelled = messages.some((message) => message.status === "cancelled");
  const showHeader = hasFinalText && !cancelled && activity.length > 0;
  const text = assistantTurnText(messages);
  const last = messages[messages.length - 1];
  const model = [...messages].reverse().find((message) => message.role === "assistant" && message.model)?.model;
  let thoughtOrdinal = 0;
  const render = (segment: MessageSegment, index: number) => renderSegment(segment, index, () => `${turnKey}:thought-${thoughtOrdinal++}`);
  const activityNodes = activity.map(render);
  const artifacts = body.filter((segment): segment is Extract<MessageSegment, { kind: "artifact" }> => segment.kind === "artifact");
  const bodyNodes = body.filter((segment) => segment.kind !== "artifact").map(render);
  return (
    <View style={styles.turn}>
      {activityNodes.length > 0 ? (
        showHeader ? (
          <TurnActivity turnKey={turnKey} active={false} elapsedMs={timing.elapsedMs}>{activityNodes}</TurnActivity>
        ) : <View style={styles.activityStack}>{activityNodes}</View>
      ) : null}
      {imageParts.length > 0 ? (
        <View style={styles.images}>{imageParts.map((part) => <MessageImage key={part.id} part={part} size={imageParts.length === 1 ? 280 : 160} />)}</View>
      ) : null}
      {bodyNodes}
      {artifacts.map((artifact) => <ArtifactCard key={artifact.id} name={artifact.name} path={artifact.path} size={artifact.size} />)}
      {inlineError && !merged.some((segment) => segment.kind === "error") ? <AssistantError>{inlineError}</AssistantError> : null}
      <View style={styles.footer}>
        {text ? (
          <Button
            variant="ghost"
            size="icon-sm"
            icon={Copy}
            accessibilityLabel="Copy message"
            onPress={() => {
              void Clipboard.setStringAsync(text);
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }}
          />
        ) : null}
        {timing.tokensPerSecond != null ? (
          <Text variant="meta" tone="faint" style={styles.tabular}>{timing.tokensPerSecond >= 10 ? timing.tokensPerSecond.toFixed(0) : timing.tokensPerSecond.toFixed(1)} tok/s</Text>
        ) : null}
        {last ? <Text variant="meta" tone="faint">{formatMessageTime(last.createdAt)}</Text> : null}
        {model ? <Text variant="meta" tone="faint" numberOfLines={1} style={{ flexShrink: 1 }}>{model}</Text> : null}
      </View>
    </View>
  );
});

function renderSegment(segment: MessageSegment, index: number, thoughtKey: () => string): React.ReactNode {
  switch (segment.kind) {
    case "tools":
      return <ToolFlow key={`tools-${segment.tools[0]?.toolCallId ?? index}`} tools={segment.tools} />;
    case "thought":
      return <ThoughtRow key={segment.id} stateKey={thoughtKey()} active={false} reasoning={segment.text} />;
    case "error":
      return <AssistantError key={segment.id}>{segment.text}</AssistantError>;
    case "artifact":
      return <ArtifactCard key={segment.id} name={segment.name} path={segment.path} size={segment.size} />;
    case "writing-block": {
      const variant = segment.draft.variants[activeMessageDraftVariantIndex(segment.draft)] ?? segment.draft.variants[0];
      const title = segment.draft.summaryTitle ?? (segment.draft.kind === "email" ? "Email draft" : segment.draft.kind === "textMessage" ? "Message draft" : "Draft");
      const bodyText = variant ? (variant.subject ? `Subject: ${variant.subject}\n\n${variant.body}` : variant.body) : "";
      return <WritingBlock key={segment.id} title={title} body={bodyText} />;
    }
    default:
      return <AssistantMarkdown key={segment.id}>{segment.text}</AssistantMarkdown>;
  }
}

/* ------------------------------ Live turn ------------------------------ */

function LiveTurn({ stream, turnKey, activeLabel, onApprovalDecide }: { stream: StreamState; turnKey: string; activeLabel?: string | undefined; onApprovalDecide: (decision: ApprovalDecision) => Promise<void> }) {
  const now = useNow(stream.turnActive);
  const window = windowLiveTimeline(stream.timeline);
  const omitted = stream.timelineOmitted + window.omitted;
  const segments = groupLiveTimeline(window.entries);
  const onlyNotes = stream.timeline.length > 0 && stream.timeline.every((entry) => entry.kind === "note");
  let thoughtOrdinal = 0;
  const nodes = [
    ...(omitted > 0 ? [<Text key="omitted" variant="meta" tone="tertiary">{omitted} earlier live activity items are hidden to keep this responsive. They remain in task history.</Text>] : []),
    ...segments.map((segment, index) => {
      if (segment.kind === "tools") {
        return <ToolFlow key={`tools-${segment.tools[0]?.toolCallId ?? index}`} tools={segment.tools} active={stream.turnActive} latest={stream.turnActive && index === segments.length - 1} />;
      }
      if (segment.kind === "thought") {
        const activeThought = stream.turnActive && stream.text.length === 0 && index === segments.length - 1;
        return <ThoughtRow key={segment.id} stateKey={`${turnKey}:thought-${thoughtOrdinal++}`} active={activeThought} reasoning={segment.text} />;
      }
      if (segment.kind === "text") return <AssistantMarkdown key={segment.id}>{segment.text}</AssistantMarkdown>;
      return <ActivityNote key={`note-${index}`} note={segment.note}>{segment.text}</ActivityNote>;
    }),
  ];
  const elapsedMs = stream.turnStartedAt ? now - stream.turnStartedAt : undefined;
  const liveAction = stream.turnActive ? latestTurnActionText(window.entries.filter((entry): entry is ToolEntry => entry.kind === "tool"), "/workspace") : null;
  return (
    <View style={styles.turn}>
      {stream.timeline.length > 0 ? (
        stream.endStatus === "cancelled" || onlyNotes ? (
          <View style={styles.activityStack}>{nodes}</View>
        ) : (
          <TurnActivity turnKey={turnKey} active={stream.turnActive} activeLabel={activeLabel} elapsedMs={elapsedMs} liveAction={liveAction}>{nodes}</TurnActivity>
        )
      ) : stream.turnActive && stream.text.length === 0 ? (
        <TurnActivity turnKey={turnKey} active activeLabel={activeLabel} elapsedMs={elapsedMs} />
      ) : null}
      {stream.approval ? <ApprovalCard approval={stream.approval} onDecide={onApprovalDecide} /> : null}
      {stream.text ? <AssistantMarkdown live={shouldUseLiveMarkdown(stream)}>{stream.text}</AssistantMarkdown> : null}
      {stream.error ? <AssistantError>{stream.error}</AssistantError> : null}
    </View>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingBottom: 20 },
  older: { alignItems: "center", paddingBottom: 16, minHeight: 44, justifyContent: "center" },
  turn: { gap: 12 },
  activityStack: { gap: 8 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  footer: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, marginLeft: -6 },
  tabular: { fontVariant: ["tabular-nums"] },
});
