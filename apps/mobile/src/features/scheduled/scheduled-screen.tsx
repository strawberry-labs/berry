import * as React from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ScheduledTask } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { CalendarClock, Clock, Ellipsis, Plus } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Spinner, StatusPill } from "../../ui/primitives";
import { Screen } from "../../ui/screen";
import { Text } from "../../ui/text";
import { TopBar } from "../shell/top-bar";
import { actionErrorMessage } from "../page-kit/errors";
import { CapabilityUnavailable, InlineAlert, PageHeader, useCapabilityAvailable, useScrollTitle } from "../page-kit/page-kit";
import { RunHistorySheet } from "./run-history-sheet";
import { ScheduleEditor } from "./schedule-editor";
import { useScheduleActions, useScheduledTasks } from "./scheduled-data";
import { describeTaskSchedule, formatAt, stateLabel } from "./schedule-model";

/** The web's Scheduled tasks page (settings → schedules) as a drawer screen. */
export function ScheduledScreen() {
  const available = useCapabilityAvailable("scheduled-tasks");
  return (
    <Screen edges={["top"]}>
      {available ? <ScheduledBody /> : (
        <>
          <TopBar title="Scheduled tasks" />
          <CapabilityUnavailable feature="Scheduled tasks" />
        </>
      )}
    </Screen>
  );
}

function ScheduledBody() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useScrollTitle();
  const schedules = useScheduledTasks();
  const actions = useScheduleActions();
  const [editing, setEditing] = React.useState<ScheduledTask | "new" | null>(null);
  const [history, setHistory] = React.useState<{ task: ScheduledTask; notice: string | null } | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [message]);

  const busy = actions.isPending;
  const mutate = actions.mutate;

  const runAction = React.useCallback((task: ScheduledTask, kind: "toggle" | "run" | "delete") => {
    mutate({ kind, task }, {
      onSuccess: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (kind === "run") setHistory({ task, notice: "Run queued. A new chat will appear in your tasks." });
        else if (kind === "toggle") setMessage(task.state === "active" ? "Schedule paused" : "Schedule resumed");
        else setMessage("Scheduled task deleted");
      },
      onError: (error) => Alert.alert("Could not update this schedule", actionErrorMessage(error, "Could not update this schedule. Try again.")),
    });
  }, [mutate]);

  const confirmDelete = React.useCallback((task: ScheduledTask) => {
    Alert.alert(
      "Delete scheduled task",
      `Stop future runs of “${task.name}”. Existing chats and results will stay in your tasks. Already dispatched runs can finish.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete schedule", style: "destructive", onPress: () => runAction(task, "delete") },
      ],
    );
  }, [runAction]);

  const onMenu = React.useCallback((task: ScheduledTask, id: string) => {
    if (id === "run") runAction(task, "run");
    else if (id === "toggle") runAction(task, "toggle");
    else if (id === "edit") setEditing(task);
    else if (id === "history") setHistory({ task, notice: null });
    else if (id === "delete") confirmDelete(task);
  }, [confirmDelete, runAction]);

  const renderItem = React.useCallback<ListRenderItem<ScheduledTask>>(({ item }) => (
    <ScheduleCard task={item} busy={busy} onPress={() => setEditing(item)} onMenu={(id) => onMenu(item, id)} />
  ), [busy, onMenu]);

  const refresh = async () => {
    setRefreshing(true);
    try { await schedules.refetch(); } finally { setRefreshing(false); }
  };

  const data = schedules.data ?? [];
  const header = (
    <View style={styles.header}>
      <PageHeader title="Scheduled tasks" description="Give Berry work to do later. Each run opens a new chat, even when you’re away." />
      {message ? (
        <View accessibilityLiveRegion="polite" style={[styles.message, { backgroundColor: colors.accentSoft }]}>
          <Text variant="secondary">{message}</Text>
        </View>
      ) : null}
    </View>
  );

  const empty = schedules.isPending ? (
    <View style={styles.status}><Spinner size="large" /></View>
  ) : schedules.isError ? (
    <View style={styles.status}>
      <Text variant="body" weight="medium">Could not load schedules</Text>
      <Text variant="secondary" tone="tertiary" style={styles.center}>{actionErrorMessage(schedules.error, "Could not load schedules")}</Text>
      <Button size="sm" label="Try again" onPress={() => void schedules.refetch()} style={styles.statusAction} />
    </View>
  ) : (
    <View style={[styles.emptyCard, { borderColor: colors.border }]}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.control }]}><CalendarClock size={20} color={colors.textSecondary} /></View>
      <Text variant="body" weight="medium" style={styles.center}>No scheduled tasks yet</Text>
      <Text variant="secondary" tone="tertiary" style={styles.center}>
        Ask in any chat: “Every weekday at 9am, prepare my daily briefing.” You can also create a schedule here.
      </Text>
      <Button variant="outline" size="sm" icon={Plus} label="Create a schedule" onPress={() => setEditing("new")} style={styles.statusAction} />
    </View>
  );

  return (
    <>
      <TopBar
        title={scroll.titleVisible ? "Scheduled tasks" : undefined}
        trailing={<Button variant="ghost" size="icon-lg" icon={Plus} accessibilityLabel="New schedule" onPress={() => setEditing("new")} />}
      />
      <FlashList
        data={schedules.isError && data.length === 0 ? [] : data}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        extraData={busy}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ItemSeparatorComponent={Gap}
        onScroll={scroll.onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textTertiary} />}
      />
      <ScheduleEditor target={editing} onClose={() => setEditing(null)} onSaved={setMessage} />
      <RunHistorySheet task={history?.task ?? null} notice={history?.notice ?? null} onClose={() => setHistory(null)} />
    </>
  );
}

function Gap() {
  return <View style={styles.gap} />;
}

function scheduleMenuItems(task: ScheduledTask, busy: boolean): MenuItem[] {
  return [
    { id: "run", title: "Run now", systemImage: "play", disabled: busy },
    ...(task.state !== "completed"
      ? [{ id: "toggle", title: task.state === "active" ? "Pause" : "Resume", systemImage: task.state === "active" ? "pause" : "playpause", disabled: busy }]
      : []),
    { id: "edit", title: "Edit", systemImage: "pencil", disabled: busy },
    { id: "history", title: "Run history", systemImage: "clock.arrow.circlepath" },
    { id: "delete", title: "Delete schedule", systemImage: "trash", destructive: true, disabled: busy },
  ];
}

/** One schedule, as the web's list item: name and state, cadence, prompt, next run, and any last error. */
const ScheduleCard = React.memo(function ScheduleCard({ task, busy, onPress, onMenu }: {
  task: ScheduledTask;
  busy: boolean;
  onPress: () => void;
  onMenu: (id: string) => void;
}) {
  const { colors } = useTheme();
  const items = scheduleMenuItems(task, busy);
  return (
    <View>
      <Menu items={items} onSelect={onMenu} longPress>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${task.name}, ${stateLabel(task.state)}, ${describeTaskSchedule(task)}`}
          accessibilityHint="Edits the schedule. Long press for more actions."
          onPress={onPress}
          style={({ pressed }) => [styles.card, { borderColor: colors.border, backgroundColor: pressed ? colors.hover : colors.card }]}
        >
          <View style={styles.cardTitle}>
            <Text variant="body" weight="medium" numberOfLines={2} style={styles.flexShrink}>{task.name}</Text>
            <StatusPill>{stateLabel(task.state)}</StatusPill>
          </View>
          <View style={styles.cadence}>
            <Clock size={14} color={colors.textSecondary} />
            <Text variant="secondary" tone="secondary" numberOfLines={1} style={styles.flexShrink}>{describeTaskSchedule(task)}</Text>
          </View>
          <Text variant="body" tone="secondary" numberOfLines={2}>{task.prompt}</Text>
          <Text variant="meta" tone="tertiary" numberOfLines={2}>
            Next: {formatAt(task.nextRunAt, task.schedule.timezone)} · {task.schedule.timezone}{task.model ? ` · ${task.model}` : ""}
          </Text>
          {task.lastError ? <InlineAlert>{task.lastError}</InlineAlert> : null}
        </Pressable>
      </Menu>
      <View style={styles.cardAction}>
        <Menu items={items} onSelect={onMenu} title={task.name}>
          <View accessible accessibilityRole="button" accessibilityLabel={`More actions for ${task.name}`} style={styles.cardActionTarget}>
            <Ellipsis size={16} color={colors.textTertiary} />
          </View>
        </Menu>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  header: { gap: 12, paddingBottom: 16 },
  message: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  gap: { height: 12 },
  card: { gap: 8, padding: 14, paddingRight: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth * 2 },
  cardTitle: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  cadence: { flexDirection: "row", alignItems: "center", gap: 6 },
  flexShrink: { flexShrink: 1 },
  cardAction: { position: "absolute", top: 4, right: 2 },
  cardActionTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  status: { minHeight: 240, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 24 },
  emptyCard: { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 20, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth * 2 },
  emptyIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  center: { textAlign: "center" },
  statusAction: { marginTop: 8 },
});
