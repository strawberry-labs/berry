import * as React from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { ScheduledTask } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { CircleCheckIcon } from "../../ui/icons";
import { Spinner, StatusPill } from "../../ui/primitives";
import { Sheet } from "../../ui/sheet";
import { Text } from "../../ui/text";
import { actionErrorMessage } from "../page-kit/errors";
import { useScheduledTaskRuns } from "./scheduled-data";
import { formatAt, runLabel, runTone } from "./schedule-model";

/** The web's "Runs · name" dialog: the last 30 runs, refreshed every 5 s while open. */
export function RunHistorySheet({ task, notice, onClose }: { task: ScheduledTask | null; notice: string | null; onClose: () => void }) {
  const { colors, layout } = useTheme();
  const runs = useScheduledTaskRuns(task);
  const [shown, setShown] = React.useState(task);
  React.useEffect(() => { if (task) setShown(task); }, [task]);
  const timezone = shown?.schedule.timezone ?? "UTC";
  const data = runs.data ?? [];

  return (
    <Sheet
      open={task !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      scroll
      title={shown ? `Runs · ${shown.name}` : "Run history"}
      description="The most recent 30 runs. Open any chat to see its progress and results."
    >
      {notice ? (
        <View style={[styles.notice, { borderRadius: layout.radius, backgroundColor: colors.accentSoft }]} accessibilityLiveRegion="polite">
          <CircleCheckIcon size={15} color={colors.accent} />
          <Text variant="secondary" style={styles.flex}>{notice}</Text>
        </View>
      ) : null}
      {task && runs.isPending ? (
        <View style={styles.status}><Spinner /></View>
      ) : runs.isError && data.length === 0 ? (
        <View style={styles.status}>
          <Text variant="secondary" tone="secondary">{actionErrorMessage(runs.error, "Could not load run history")}</Text>
          <Button variant="outline" size="sm" label="Try again" onPress={() => void runs.refetch()} />
        </View>
      ) : data.length === 0 ? (
        <Text variant="body" tone="secondary" style={styles.empty}>This schedule hasn’t run yet.</Text>
      ) : (
        <View style={styles.list}>
          {data.map((run) => (
            <View key={run.id} style={[styles.run, { borderColor: colors.border, borderRadius: layout.radius }]}>
              <View style={styles.runHeader}>
                <View style={styles.runMeta}>
                  <StatusPill tone={runTone(run)}>{runLabel(run)}</StatusPill>
                  <Text variant="secondary" tone="secondary" numberOfLines={1}>
                    {formatAt(run.scheduledAt, timezone)} · {run.trigger === "manual" ? "Run now" : "Scheduled"}
                  </Text>
                </View>
                {run.taskId ? (
                  <Button
                    variant="outline"
                    size="sm"
                    label="Open chat"
                    onPress={() => {
                      onClose();
                      router.navigate({ pathname: "/(app)/tasks/[taskId]", params: { taskId: run.taskId! } });
                    }}
                  />
                ) : null}
              </View>
              {run.error ? <Text variant="secondary" tone="secondary">{run.error}</Text> : null}
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10 },
  status: { alignItems: "center", gap: 10, paddingVertical: 24 },
  empty: { paddingVertical: 12, paddingHorizontal: 4 },
  list: { gap: 8 },
  run: { gap: 8, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  runHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  runMeta: { flex: 1, minWidth: 0, alignItems: "flex-start", gap: 6 },
});
