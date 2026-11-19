import * as React from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import * as WebBrowser from "expo-web-browser";
import type { SessionNoteKind } from "@berry/shared";
import type { ActivityTool } from "@berry/client-core/activity";
import {
  describeToolRow,
  exploreGroupFailed,
  exploreSummary,
  subagentInfo,
  thoughtSuffix,
  toolActionText,
  toolFlowSegments,
  toolMetaText,
  toolFailureLabel,
  turnActivityLabel,
  type ToolActionText,
  type ToolRowDescriptor,
  type ToolRowIcon,
} from "@berry/client-core/activity-rows";
import { useTheme } from "../../theme/theme";
import { BookOpen, Bot, Brain, ChevronRight, CircleHelp, CircleHollow, Globe, ListTodo, NotebookPen, PencilLine, Rocket, Search, SquareTerminal, Wrench, ArrowRight02, CheckIcon, type Icon } from "../../ui/icons";
import { Text } from "../../ui/text";
import { Markdown } from "../markdown/markdown";

/** Root that file paths in tool rows are shown relative to (Berry shows "apps/desktop/"). */
const WORKSPACE_ROOT = "/workspace";

/*
 * Remembered disclosure state, keyed like the web's openMap/turnCollapsedChoice:
 * in-memory, shared between the live and settled render paths so a remount
 * at turn settle (or a FlashList recycle) keeps what the person chose.
 */
const openState = new Map<string, boolean>();
const OPEN_STATE_CAP = 800;

function useRememberedOpen(key: string, fallback: boolean): [boolean, (open: boolean) => void, boolean] {
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const remembered = openState.get(key);
  const set = React.useCallback((open: boolean) => {
    openState.delete(key);
    openState.set(key, open);
    if (openState.size > OPEN_STATE_CAP) {
      const first = openState.keys().next().value;
      if (first) openState.delete(first);
    }
    rerender();
  }, [key]);
  return [remembered ?? fallback, set, remembered !== undefined];
}

export function forgetDisclosure(prefix: string): void {
  for (const key of [...openState.keys()]) if (key.startsWith(prefix)) openState.delete(key);
}

const ROW_ICONS: Record<ToolRowIcon, Icon> = {
  terminal: SquareTerminal,
  search: Search,
  globe: Globe,
  pencil: PencilLine,
  wrench: Wrench,
  rocket: Rocket,
  help: CircleHelp,
  notebook: NotebookPen,
  book: BookOpen,
  todo: ListTodo,
};

/* ------------------------------ Turn header ------------------------------ */

/**
 * "Working for 12s" / "Worked for 1m 3s" over a hairline that collapses the
 * whole turn's activity: open for the live run, collapsed once settled,
 * unless the person chose otherwise for this turn.
 */
export function TurnActivity({ turnKey, active, elapsedMs, activeLabel, summary, liveAction, children }: {
  turnKey: string;
  active: boolean;
  elapsedMs?: number | undefined;
  activeLabel?: string | undefined;
  summary?: string | undefined;
  liveAction?: ToolActionText | null | undefined;
  children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useRememberedOpen(`turn:${turnKey}`, active);
  const label = turnActivityLabel({ active, elapsedMs, activeLabel, summary });
  const hasChildren = React.Children.toArray(children).some(Boolean);
  const header = (
    <View style={[styles.turnHeader, { borderBottomColor: colors.borderSubtle }]}>
      <Shimmer active={active}>
        <Text variant="secondary" tone="tertiary" weight="medium" style={styles.tabular}>{label}</Text>
      </Shimmer>
      {hasChildren ? <Chevron open={open} /> : null}
    </View>
  );
  if (!hasChildren) return header;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={label} onPress={() => setOpen(!open)}>
        {header}
      </Pressable>
      {active && !open && liveAction ? (
        <View style={styles.liveAction}><ActionLine action={liveAction} /></View>
      ) : null}
      {open ? <Animated.View entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)} style={styles.turnBody}>{children}</Animated.View> : null}
    </View>
  );
}

/** Berry's reasoning row: "Thinking" while it streams, "Thought for a few seconds" once done. */
export function ThoughtRow({ stateKey, active, reasoning, defaultOpen = false, durationMs }: {
  stateKey: string;
  active: boolean;
  reasoning: string;
  defaultOpen?: boolean;
  durationMs?: number | undefined;
}) {
  const { colors } = useTheme();
  const hasText = reasoning.trim().length > 0;
  const [open, setOpen, chosen] = useRememberedOpen(`thought:${stateKey}`, defaultOpen);
  // Open while streaming; collapse once the next part starts, unless chosen.
  const effectiveOpen = hasText && (chosen ? open : active || defaultOpen);
  const suffix = thoughtSuffix(active, durationMs);
  return (
    <View>
      <Pressable
        disabled={!hasText}
        accessibilityRole="button"
        accessibilityState={{ expanded: effectiveOpen }}
        onPress={() => setOpen(!effectiveOpen)}
        style={styles.rowHeader}
      >
        <Brain size={16} color={colors.textTertiary} />
        <Shimmer active={active}>
          <Text variant="secondary" weight="medium" tone="tertiary">{active ? "Thinking" : "Thought"}</Text>
        </Shimmer>
        {suffix ? <Text variant="secondary" tone="tertiary">{suffix}</Text> : null}
        {hasText ? <Chevron open={effectiveOpen} /> : null}
      </Pressable>
      {effectiveOpen ? (
        <View style={[styles.rail, { borderLeftColor: colors.border }]}>
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
            <Text variant="secondary" tone="tertiary" selectable>{reasoning}</Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** Section break emitted by the agent (compacted, followed up, …). */
export function ActivityNote({ note, children }: { note?: SessionNoteKind | undefined; children: string }) {
  const { colors } = useTheme();
  if (note === "compacting") {
    return (
      <View style={styles.rowHeader} accessibilityRole="text" accessibilityLiveRegion="polite">
        <Shimmer active><Text variant="secondary" weight="medium" tone="tertiary">{children}</Text></Shimmer>
      </View>
    );
  }
  const active = note === "followed-up";
  return (
    <View style={styles.note}>
      <View style={[styles.noteLine, { backgroundColor: active ? colors.accentSoft : colors.border }]} />
      <Text variant="meta" tone={active ? "accent" : "tertiary"} numberOfLines={1}>{children}</Text>
      <View style={[styles.noteLine, { backgroundColor: active ? colors.accentSoft : colors.border }]} />
    </View>
  );
}

/* ------------------------------- Tool flow ------------------------------- */

/** One run of tool calls: Explore groups, sub-agents and single rows, like the web walker. */
export function ToolFlow({ tools, active = false, latest = false, showTodos = true }: { tools: ActivityTool[]; active?: boolean; latest?: boolean; showTodos?: boolean }) {
  const segments = toolFlowSegments(tools, showTodos);
  if (segments.length === 0) return null;
  return (
    <View style={styles.flow}>
      {segments.map((segment, index) => segment.kind === "explore" ? (
        <ExploreGroup key={`explore-${segment.tools[0]?.toolCallId ?? index}`} tools={segment.tools} active={active} latest={latest && index === segments.length - 1} />
      ) : segment.kind === "subagent" ? (
        <SubagentActivity key={segment.tool.toolCallId} tool={segment.tool} active={active} />
      ) : (
        <ToolRow key={segment.tool.toolCallId} descriptor={describeToolRow(segment.tool, WORKSPACE_ROOT)} />
      ))}
    </View>
  );
}

function ExploreGroup({ tools, active, latest }: { tools: ActivityTool[]; active: boolean; latest: boolean }) {
  const { colors } = useTheme();
  const groupId = `${tools[0]?.toolCallId ?? "explore"}:explore`;
  const [open, setOpen] = useRememberedOpen(groupId, false);
  const live = active && (latest || tools.some((tool) => tool.status === "running"));
  const liveAction = live && tools.length > 0 ? toolActionText(tools[tools.length - 1]!, WORKSPACE_ROOT) : null;
  const last = tools[tools.length - 1];
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.rowHeader}>
        <Search size={16} color={colors.textTertiary} />
        <Shimmer active={live}><Text variant="secondary" weight="medium" tone="tertiary">Explore</Text></Shimmer>
        <Text variant="secondary" tone="tertiary">·</Text>
        <View style={styles.rowSummary}>
          {liveAction && !open ? <ActionLine action={liveAction} /> : <Text variant="secondary" tone="tertiary" numberOfLines={1}>{exploreSummary(tools)}</Text>}
        </View>
        {last && toolMetaText(last) ? <Text variant="secondary" tone="tertiary">{toolMetaText(last)}</Text> : null}
        {exploreGroupFailed(tools) ? <Text variant="secondary" tone="danger">Failed</Text> : null}
        <Chevron open={open} />
      </Pressable>
      {open ? (
        <View style={[styles.rail, { borderLeftColor: colors.border }]}>
          {tools.map((tool) => <ToolRow key={tool.toolCallId} descriptor={describeToolRow(tool, WORKSPACE_ROOT)} showIcon={false} />)}
        </View>
      ) : null}
    </View>
  );
}

function SubagentActivity({ tool, active }: { tool: ActivityTool; active: boolean }) {
  const { colors } = useTheme();
  const info = subagentInfo(tool);
  const running = tool.status === "running";
  const [open, setOpen, chosen] = useRememberedOpen(`${tool.toolCallId}:subagent`, false);
  // Open while it runs, collapse once done, unless chosen (autoCollapseOnComplete).
  const effectiveOpen = chosen ? open : active && running;
  const liveAction = running && info.children.length > 0 ? toolActionText(info.children[info.children.length - 1]!, WORKSPACE_ROOT) : null;
  const failure = toolFailureLabel(tool.status);
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: effectiveOpen }} onPress={() => setOpen(!effectiveOpen)} style={styles.rowHeader}>
        <Bot size={16} color={colors.textTertiary} />
        <Shimmer active={running}><Text variant="secondary" weight="medium">SubAgent</Text></Shimmer>
        {info.named ? <Text variant="secondary" mono numberOfLines={1} style={{ color: agentColor(info.agentType, colors), maxWidth: 120 }}>{info.agentType}</Text> : null}
        <Text variant="secondary" tone="tertiary">·</Text>
        <View style={styles.rowSummary}>
          {liveAction && !effectiveOpen ? <ActionLine action={liveAction} /> : <Text variant="secondary" tone="tertiary" numberOfLines={1}>{info.description}</Text>}
        </View>
        {failure ? <Text variant="secondary" tone="danger">{failure}</Text> : null}
        <Chevron open={effectiveOpen} />
      </Pressable>
      {effectiveOpen ? (
        <View style={[styles.rail, { borderLeftColor: colors.border, gap: 12 }]}>
          {info.prompt ? <Box label="Prompt" markdown={info.prompt} /> : null}
          {info.output ? <Box label="Subagent output" markdown={info.output} tinted /> : null}
          {info.children.length > 0 ? <ToolFlow tools={info.children} active={active && running} latest={active && running} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function ToolRow({ descriptor, showIcon = true }: { descriptor: ToolRowDescriptor; showIcon?: boolean }) {
  const { colors } = useTheme();
  const expandable = Boolean(descriptor.detail);
  const [open, setOpen] = useRememberedOpen(descriptor.id, false);
  const RowIcon = ROW_ICONS[descriptor.icon];
  const effectiveOpen = expandable && open;
  const showSecondary = descriptor.secondary && !(effectiveOpen && descriptor.detail?.kind === "command");
  return (
    <View>
      <Pressable
        disabled={!expandable}
        accessibilityRole={expandable ? "button" : "text"}
        accessibilityState={expandable ? { expanded: effectiveOpen } : undefined}
        onPress={() => setOpen(!effectiveOpen)}
        style={styles.rowHeader}
      >
        {showIcon ? <RowIcon size={16} color={colors.textTertiary} /> : null}
        <Shimmer active={descriptor.running}>
          <Text variant="secondary" weight="medium" tone="tertiary" numberOfLines={1}>{descriptor.label}</Text>
        </Shimmer>
        <View style={styles.rowSummary}>
          {descriptor.primary ? <RowText text={descriptor.primary} strong /> : null}
          {showSecondary && descriptor.secondary ? <RowText text={descriptor.secondary} /> : null}
        </View>
        {descriptor.meta ? <Text variant="secondary" tone="tertiary">{descriptor.meta}</Text> : null}
        {descriptor.status ? <Text variant="secondary" tone="danger">{descriptor.status}</Text> : null}
        {expandable ? <Chevron open={effectiveOpen} /> : null}
      </Pressable>
      {effectiveOpen && descriptor.detail ? <ToolDetail detail={descriptor.detail} /> : null}
    </View>
  );
}

function RowText({ text, strong = false }: { text: NonNullable<ToolRowDescriptor["primary"]>; strong?: boolean }) {
  const { colors } = useTheme();
  const url = text.url;
  return (
    <Text
      variant="secondary"
      mono={Boolean(text.mono)}
      numberOfLines={1}
      tone={strong ? "primary" : "tertiary"}
      onPress={url ? () => void openUrl(url) : undefined}
      style={[{ flexShrink: 1 }, url ? { color: colors.accent } : null]}
    >
      {text.text}
    </Text>
  );
}

function ToolDetail({ detail }: { detail: NonNullable<ToolRowDescriptor["detail"]> }) {
  const { colors } = useTheme();
  const panel = [styles.panel, { backgroundColor: colors.panel, borderColor: colors.border }];
  switch (detail.kind) {
    case "command":
      return (
        <View style={panel}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text variant="code" mono tone="tertiary">$</Text>
            <Text variant="code" mono selectable style={{ flex: 1 }}>{detail.command}</Text>
          </View>
          {detail.output ? <Mono text={detail.output} /> : detail.running ? null : <Text variant="code" mono tone="tertiary">No output</Text>}
        </View>
      );
    case "output":
      return <View style={panel}><Mono text={detail.output} /></View>;
    case "raw":
      return (
        <View style={{ gap: 8, marginTop: 6 }}>
          {detail.raw ? <View style={[styles.panel, { backgroundColor: colors.surfaceInset, borderColor: "transparent" }]}><Text variant="meta" mono tone="tertiary" selectable>{detail.raw}</Text></View> : null}
          {detail.output ? (
            <View style={panel}>{detail.markdown ? <Markdown tone="secondary" compact>{detail.output}</Markdown> : <Mono text={detail.output} />}</View>
          ) : null}
        </View>
      );
    case "todos":
      return (
        <View style={[styles.panel, { backgroundColor: colors.hover, borderColor: "transparent", gap: 4 }]}>
          {detail.todos.map((item, index) => {
            const done = item.status === "completed";
            const TodoIcon = done ? CheckIcon : item.status === "in_progress" ? ArrowRight02 : CircleHollow;
            return (
              <View key={`${index}-${item.content}`} style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 2 }}>
                <TodoIcon size={14} color={done ? colors.nodeSession : item.status === "in_progress" ? colors.textPrimary : colors.textTertiary} />
                <Text variant="secondary" tone={item.status === "in_progress" ? "primary" : "tertiary"} style={done ? { textDecorationLine: "line-through", flex: 1 } : { flex: 1 }}>{item.content}</Text>
              </View>
            );
          })}
        </View>
      );
    case "question":
      return (
        <View style={[panel, { gap: 8 }]}>
          <Text variant="secondary">{detail.question}</Text>
          {detail.options.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {detail.options.map((option, index) => (
                <View key={`${index}-${option.label}`} style={[styles.optionChip, { borderColor: colors.border, backgroundColor: colors.surfaceInset }]}>
                  <Text variant="secondary" weight="medium" numberOfLines={1}>{option.label}</Text>
                  {option.description ? <Text variant="meta" tone="tertiary" numberOfLines={1}>{option.description}</Text> : null}
                </View>
              ))}
            </View>
          ) : null}
          {detail.answer ? <Text variant="secondary" tone="tertiary">Answer: {detail.answer}</Text> : null}
        </View>
      );
    case "context":
      return (
        <View style={[panel, { gap: 8 }]}>
          <Text variant="meta" weight="medium" tone="tertiary">Query</Text>
          <Text variant="secondary">{detail.query}</Text>
          {detail.output ? (
            <>
              <Text variant="meta" weight="medium" tone="tertiary">Result</Text>
              <Markdown tone="secondary" compact>{detail.output}</Markdown>
            </>
          ) : null}
        </View>
      );
    case "markdown":
      return <View style={panel}><Markdown tone="secondary" compact>{detail.markdown}</Markdown></View>;
  }
}

function Mono({ text }: { text: string }) {
  return (
    <ScrollView style={{ maxHeight: 400 }} nestedScrollEnabled>
      <Text variant="code" mono tone="tertiary" selectable>{text}</Text>
    </ScrollView>
  );
}

function Box({ label, markdown, tinted = false }: { label: string; markdown: string; tinted?: boolean }) {
  const { colors, layout } = useTheme();
  return (
    <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: layout.radius, backgroundColor: tinted ? colors.hover : "transparent" }}>
      <Text variant="meta" weight="medium" tone="tertiary" style={{ padding: 12, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</Text>
      <ScrollView style={{ maxHeight: tinted ? 256 : 208 }} nestedScrollEnabled contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        <Markdown tone="secondary" compact>{markdown}</Markdown>
      </ScrollView>
    </View>
  );
}

/** "Explore · Reading a.ts" — the live action line under a collapsed header. */
export function ActionLine({ action }: { action: ToolActionText }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 }}>
      {action.prefix ? <Text variant="secondary" weight="medium" tone="tertiary">{action.prefix}</Text> : null}
      {action.prefix ? <Text variant="secondary" tone="tertiary">·</Text> : null}
      <Text variant="secondary" tone="tertiary">{action.verb}</Text>
      {action.text ? <Text variant="secondary" tone="tertiary" mono={Boolean(action.mono)} numberOfLines={1} style={{ flexShrink: 1 }}>{action.text}</Text> : null}
    </View>
  );
}

function Chevron({ open }: { open: boolean }) {
  const { colors } = useTheme();
  return <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}><ChevronRight size={14} color={colors.textTertiary} /></View>;
}

/** The web's `berry-shimmer` running label: a gentle pulse that rests when motion is reduced. */
export function Shimmer({ active, children }: { active: boolean; children: React.ReactNode }) {
  const opacity = useSharedValue(1);
  React.useEffect(() => {
    opacity.value = active
      ? withRepeat(withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.System }), -1, true)
      : withTiming(1, { duration: 150, reduceMotion: ReduceMotion.System });
  }, [active, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function agentColor(name: string, colors: ReturnType<typeof useTheme>["colors"]): string {
  const palette = [colors.warning, colors.danger, colors.nodeSkill, colors.nodeSession, colors.nodeFile, colors.accent, colors.nodeSubagent, colors.nodeCommand];
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

async function openUrl(url: string): Promise<void> {
  if (/^https?:/i.test(url)) await WebBrowser.openBrowserAsync(url).catch(() => undefined);
  else await Linking.openURL(url).catch(() => undefined);
}

const styles = StyleSheet.create({
  tabular: { fontVariant: ["tabular-nums"] },
  turnHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 32 },
  turnBody: { paddingTop: 12, gap: 8 },
  liveAction: { paddingTop: 12 },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, alignSelf: "stretch" },
  rowSummary: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
  rail: { marginLeft: 8, marginTop: 6, paddingLeft: 14, borderLeftWidth: StyleSheet.hairlineWidth, gap: 8 },
  flow: { gap: 8 },
  panel: { marginTop: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, gap: 10 },
  note: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  noteLine: { height: StyleSheet.hairlineWidth, flex: 1 },
  optionChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, maxWidth: "100%" },
});
