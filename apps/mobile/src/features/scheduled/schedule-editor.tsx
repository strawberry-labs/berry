import * as React from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { ScheduledTaskCreateSchema, type ScheduledTask } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Input } from "../../ui/primitives";
import { Text } from "../../ui/text";
import { useWorkspaces } from "../data/shell-data";
import { actionErrorMessage } from "../page-kit/errors";
import { Field, InlineAlert, SegmentedControl, SelectField, TextArea } from "../page-kit/page-kit";
import { newOperationId, useScheduleActions } from "./scheduled-data";
import {
  HOUR_OPTIONS,
  REPEAT_OPTIONS,
  WEEKDAYS,
  changeDraft,
  draftSchedule,
  joinTime,
  minuteOptions,
  scheduleChanged,
  scheduleDraft,
  scheduleMode,
  splitRunAt,
  splitTime,
  upcomingDateOptions,
  type ScheduleMode,
  type SchedulePreset,
  type ScheduledTaskDraft,
} from "./schedule-model";

const MODE_OPTIONS: Array<{ value: ScheduleMode; label: string }> = [
  { value: "repeat", label: "Repeat" },
  { value: "once", label: "Once" },
  { value: "delay", label: "After a delay" },
];

const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));

/**
 * The web's "New / Edit scheduled task" dialog as an iOS page sheet. Every
 * field, default, and validation matches the web form; time and date inputs
 * become menus because the app ships no native date picker.
 */
export function ScheduleEditor({ target, onClose, onSaved }: {
  target: ScheduledTask | "new" | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { colors } = useTheme();
  const workspaces = useWorkspaces();
  const actions = useScheduleActions();
  const saving = actions.isPending;
  const [draft, setDraft] = React.useState<ScheduledTaskDraft>(() => scheduleDraft());
  const [operationId, setOperationId] = React.useState(newOperationId);
  const [formError, setFormError] = React.useState("");
  // Keep the last target while the sheet slides away so its title doesn't flash.
  const [shown, setShown] = React.useState(target);

  React.useEffect(() => {
    if (!target) return;
    setShown(target);
    setDraft(scheduleDraft(target === "new" ? undefined : target));
    setOperationId(newOperationId());
    setFormError("");
  }, [target]);

  const change = <K extends keyof ScheduledTaskDraft>(key: K, value: ScheduledTaskDraft[K]) => {
    setDraft((prior) => changeDraft(prior, key, value));
    setOperationId(newOperationId());
    setFormError("");
  };

  const close = () => { if (!saving) onClose(); };

  const submit = async () => {
    if (!target || saving) return;
    setFormError("");
    try {
      const parsed = ScheduledTaskCreateSchema.parse({
        operationId,
        name: draft.name,
        prompt: draft.prompt,
        schedule: draftSchedule(draft),
        ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
      });
      if (target === "new") {
        await actions.mutateAsync({ kind: "create", input: parsed });
      } else {
        const changed = scheduleChanged(draft, scheduleDraft(target));
        await actions.mutateAsync({
          kind: "update",
          task: target,
          operationId,
          changes: {
            name: parsed.name,
            prompt: parsed.prompt,
            ...(changed ? { schedule: parsed.schedule, ...(target.state === "paused" ? { state: "paused" as const } : {}) } : {}),
          },
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved(target === "new" ? "Scheduled task created" : "Scheduled task updated");
      onClose();
    } catch (error) {
      setFormError(actionErrorMessage(error, "Could not save this schedule. Your draft is still here."));
    }
  };

  const isNew = shown === "new";
  const mode = scheduleMode(draft.preset);
  const projects = (workspaces.data ?? []).filter((workspace) => workspace.workspaceKind === "project");
  const runAt = splitRunAt(draft.runAt);
  const canSubmit = Boolean(draft.name.trim() && draft.prompt.trim()) && !saving;

  return (
    <Modal visible={target !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={[styles.root, { backgroundColor: colors.panel }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Button variant="ghost" size="sm" label="Cancel" disabled={saving} onPress={close} />
          <Text variant="body" weight="semibold" numberOfLines={1} accessibilityRole="header" style={styles.headerTitle}>
            {isNew ? "New scheduled task" : "Edit scheduled task"}
          </Text>
          <Button size="sm" label={isNew ? "Create" : "Save"} loading={saving} disabled={!canSubmit} onPress={() => void submit()} accessibilityLabel={isNew ? "Create schedule" : "Save changes"} />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          <Text variant="secondary" tone="tertiary">Write the full instructions Berry should follow each time it runs.</Text>
          <Field label="Name">
            <Input value={draft.name} maxLength={120} editable={!saving} placeholder="Daily briefing" onChangeText={(value) => change("name", value)} accessibilityLabel="Name" returnKeyType="next" />
          </Field>
          <Field label="Instructions" description="Each run starts in a new chat. Include all context it will need.">
            <TextArea value={draft.prompt} maxLength={32_000} editable={!saving} placeholder="Review today’s priorities and prepare a short briefing with sources." onChangeText={(value) => change("prompt", value)} accessibilityLabel="Instructions" />
          </Field>
          {isNew ? (
            <Field label="Project">
              <SelectField
                value={draft.workspaceId || "general"}
                disabled={saving}
                accessibilityLabel="Project"
                onChange={(value) => change("workspaceId", value === "general" ? "" : value)}
                options={[{ value: "general", label: "General tasks" }, ...projects.map((workspace) => ({ value: workspace.id, label: workspace.name }))]}
              />
            </Field>
          ) : null}
          <Field label="When">
            <SegmentedControl
              accessibilityLabel="Schedule type"
              items={MODE_OPTIONS}
              value={mode}
              disabled={saving}
              onChange={(value) => change("preset", value === "repeat" ? "weekdays" : value)}
            />
          </Field>
          {mode === "repeat" ? (
            <Field label="Repeat">
              <SelectField value={draft.preset} disabled={saving} accessibilityLabel="Repeat frequency" options={REPEAT_OPTIONS} onChange={(value) => change("preset", value as SchedulePreset)} />
            </Field>
          ) : null}
          {mode === "repeat" && draft.preset !== "custom" ? (
            <Field label="Time">
              <TimeSelect value={draft.time} disabled={saving} label="Time" onChange={(value) => change("time", value)} />
            </Field>
          ) : null}
          {draft.preset === "weekly" ? (
            <Field label="Day">
              <SelectField value={draft.day} disabled={saving} accessibilityLabel="Day of the week" options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} onChange={(value) => change("day", value)} />
            </Field>
          ) : null}
          {draft.preset === "monthly" ? (
            <Field label="Day of the month" description="Months without this day are skipped.">
              <SelectField value={draft.day} disabled={saving} accessibilityLabel="Day of the month" options={DAY_OF_MONTH_OPTIONS} onChange={(value) => change("day", value)} />
            </Field>
          ) : null}
          {draft.preset === "custom" ? (
            <Field label="Cron expression" description="Minute · hour · day of month · month · day of week. For example, 0 9 * * 1-5 runs on weekdays at 09:00.">
              <Input value={draft.expression} editable={!saving} placeholder="0 9 * * 1-5" autoCapitalize="none" autoCorrect={false} onChangeText={(value) => change("expression", value)} accessibilityLabel="Cron expression" />
            </Field>
          ) : null}
          {draft.preset === "once" ? (
            <Field label="Date and time">
              <View style={styles.stack}>
                <SelectField
                  value={runAt.date}
                  disabled={saving}
                  accessibilityLabel="Date"
                  placeholder="Choose a date"
                  options={upcomingDateOptions(new Date(), draft.timezone, 60, runAt.date)}
                  onChange={(value) => change("runAt", `${value}T${runAt.time}`)}
                />
                <TimeSelect value={runAt.time} disabled={saving} label="Run time" onChange={(value) => change("runAt", `${runAt.date}T${value}`)} />
              </View>
            </Field>
          ) : null}
          {draft.preset === "delay" ? (
            <Field label="Run in this many minutes" description="The delay starts when you save this schedule.">
              <Input value={draft.minutes} editable={!saving} keyboardType="number-pad" maxLength={6} onChangeText={(value) => change("minutes", value.replace(/[^0-9]/g, ""))} accessibilityLabel="Run in this many minutes" />
            </Field>
          ) : null}
          <Field label="Timezone" description="Use an IANA timezone such as Asia/Dubai or Europe/London. Recurring times follow its daylight saving rules.">
            <Input value={draft.timezone} editable={!saving} autoCapitalize="none" autoCorrect={false} onChangeText={(value) => change("timezone", value)} accessibilityLabel="Timezone" />
          </Field>
          {formError ? <InlineAlert tone="danger">{formError}</InlineAlert> : null}
          <Text variant="meta" tone="tertiary" style={styles.footnote}>
            Runs use your current tool access and allowance. If a previous run is still active, the next occurrence is skipped. After server downtime, Berry runs one overdue occurrence.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function TimeSelect({ value, onChange, disabled, label }: { value: string; onChange: (value: string) => void; disabled: boolean; label: string }) {
  const { hour, minute } = splitTime(value);
  return (
    <View style={styles.timeRow}>
      <SelectField
        value={hour}
        disabled={disabled}
        accessibilityLabel={`${label}, hour`}
        options={HOUR_OPTIONS.map((option) => ({ value: option, label: option }))}
        onChange={(next) => onChange(joinTime(next, minute))}
        style={styles.timePart}
      />
      <Text variant="body" weight="semibold" tone="secondary">:</Text>
      <SelectField
        value={minute}
        disabled={disabled}
        accessibilityLabel={`${label}, minute`}
        options={minuteOptions(minute).map((option) => ({ value: option, label: option }))}
        onChange={(next) => onChange(joinTime(hour, next))}
        style={styles.timePart}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 56, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1, textAlign: "center" },
  content: { padding: 16, paddingBottom: 48, gap: 18 },
  stack: { gap: 8 },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  timePart: { flex: 1 },
  footnote: { lineHeight: 18 },
});
