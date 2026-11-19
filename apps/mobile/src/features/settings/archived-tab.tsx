import * as React from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import type { Task } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Trash2 } from "../../ui/icons";
import { EmptyState, StatusPill } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Text } from "../../ui/text";
import { useWorkspaces } from "../data/shell-data";
import { useArchiveTaskAction, useArchivedTasks, useDeleteAllArchived, type ArchiveAction, type ArchiveFilters } from "./settings-data";
import { ARCHIVE_STATES, archiveStatusMessage, formatDateTime, groupArchivedTasks, workspaceLabel, type ArchiveState } from "./settings-model";
import { AsyncContent, FilterInput, InlineMessage, ListRow, SelectField, SettingsPage } from "./settings-ui";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

type Status = { tone: "danger" | "success"; text: string };

/** Settings › Archived tasks: search, filter, unarchive, delete, and restore. */
export function ArchivedTab() {
  const workspaces = useWorkspaces();
  const [search, setSearch] = React.useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [workspace, setWorkspace] = React.useState("all");
  const [state, setState] = React.useState<ArchiveState>("archived");
  const filters = React.useMemo<ArchiveFilters>(() => ({ q, workspace, state }), [q, state, workspace]);
  const archive = useArchivedTasks(filters);
  const action = useArchiveTaskAction();
  const deleteAll = useDeleteAllArchived();
  const [status, setStatus] = React.useState<Status | null>(null);

  const matching = React.useMemo(() => archive.data?.pages.flatMap((page) => page.items) ?? [], [archive.data]);
  const groups = React.useMemo(() => groupArchivedTasks(matching, workspaces.data ?? []), [matching, workspaces.data]);
  const archivedCount = matching.filter((task) => task.archived && !task.deletedAt).length;
  const busy = action.isPending || deleteAll.isPending;
  const projectOptions = React.useMemo(
    () => [{ value: "all", label: "All projects" }, ...(workspaces.data ?? []).map((item) => ({ value: item.id, label: workspaceLabel(item) }))],
    [workspaces.data],
  );

  const run = (task: Task, kind: ArchiveAction) => {
    setStatus(null);
    action.mutate({ task, action: kind }, {
      onSuccess: () => setStatus({ tone: "success", text: archiveStatusMessage(kind, task.title || "Untitled task") }),
      onError: (cause) => setStatus({ tone: "danger", text: apiErrorMessage(cause, "The task could not be updated.") }),
    });
  };

  const confirmDelete = (task: Task) => {
    Alert.alert(`Delete ${task.title || "this task"}?`, "It moves to Recently deleted and can still be restored.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => run(task, "delete") },
    ]);
  };

  const confirmDeleteAll = () => {
    Alert.alert(
      `Delete ${archivedCount} archived ${archivedCount === 1 ? "task" : "tasks"}?`,
      "They will move to Recently deleted and can still be restored.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete all",
          style: "destructive",
          onPress: () => {
            setStatus(null);
            deleteAll.mutate(filters, {
              onSuccess: (result) => setStatus({ tone: "success", text: `Moved ${result.deletedCount} archived ${result.deletedCount === 1 ? "task" : "tasks"} to recently deleted.` }),
              onError: (cause) => setStatus({ tone: "danger", text: apiErrorMessage(cause, "The archived tasks could not be deleted.") }),
            });
          },
        },
      ],
    );
  };

  return (
    <SettingsPage
      title="Archived tasks"
      description="Search, restore, or remove tasks you've archived or deleted."
      refreshing={archive.isRefetching && !archive.isFetchingNextPage}
      onRefresh={() => void archive.refetch()}
      trailing={archivedCount > 0 ? <Button variant="ghost" size="sm" icon={Trash2} label="Delete all" disabled={busy} onPress={confirmDeleteAll} /> : null}
    >
      <View style={styles.filters}>
        <FilterInput value={search} onChangeText={setSearch} placeholder="Search archived tasks" />
        <View style={styles.selects}>
          <View style={styles.select}><SelectField label="Project" value={workspace} options={projectOptions} onChange={setWorkspace} compact /></View>
          <View style={styles.select}><SelectField label="Archive state" value={state} options={ARCHIVE_STATES} onChange={setState} compact /></View>
        </View>
      </View>

      {status ? <InlineMessage tone={status.tone} onDismiss={() => setStatus(null)}>{status.text}</InlineMessage> : null}

      <AsyncContent
        loading={archive.isPending}
        error={archive.isError ? apiErrorMessage(archive.error, "Unable to load archived tasks.") : null}
        onRetry={() => void archive.refetch()}
        rows={5}
      >
        {groups.length === 0 ? (
          <Section>
            <EmptyState
              title={state === "deleted" ? "No recently deleted tasks" : "No archived tasks"}
              message={q ? "Try a different search or filter." : "Tasks you archive will appear here."}
            />
          </Section>
        ) : groups.map((group) => (
          <Section key={group.workspaceId} title={group.title} description={`${group.items.length} ${group.items.length === 1 ? "task" : "tasks"}`}>
            {group.items.map((task, index) => (
              <ArchivedRow
                key={task.id}
                task={task}
                last={index === group.items.length - 1}
                disabled={busy}
                pending={action.isPending && action.variables?.task.id === task.id}
                onDelete={() => confirmDelete(task)}
                onRestore={() => run(task, task.deletedAt ? "restore" : "unarchive")}
              />
            ))}
          </Section>
        ))}
        {archive.hasNextPage ? (
          <Button variant="secondary" label={archive.isFetchingNextPage ? "Loading…" : "Load older tasks"} disabled={archive.isFetchingNextPage} onPress={() => void archive.fetchNextPage()} />
        ) : null}
      </AsyncContent>
    </SettingsPage>
  );
}

function ArchivedRow({ task, last, disabled, pending, onDelete, onRestore }: {
  task: Task;
  last: boolean;
  disabled: boolean;
  pending: boolean;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { colors } = useTheme();
  const deleted = Boolean(task.deletedAt);
  const title = task.title || "Untitled task";
  return (
    <ListRow last={last}>
      <View style={styles.body}>
        <Text variant="body" weight="medium" numberOfLines={1}>{title}</Text>
        <View style={styles.meta}>
          <StatusPill tone={deleted ? "warning" : "info"}>{deleted ? "Recently deleted" : "Archived"}</StatusPill>
          <Text variant="meta" tone="tertiary" numberOfLines={1} style={{ flexShrink: 1 }}>{formatDateTime(task.updatedAt)}</Text>
        </View>
      </View>
      {!deleted ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${title}`}
          disabled={disabled}
          onPress={onDelete}
          hitSlop={6}
          style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.hover }, disabled && { opacity: 0.5 }]}
        >
          <Trash2 size={16} color={colors.textTertiary} />
        </Pressable>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        label={deleted ? "Restore" : "Unarchive"}
        loading={pending}
        disabled={disabled}
        accessibilityLabel={`${deleted ? "Restore" : "Unarchive"} ${title}`}
        onPress={onRestore}
        style={styles.restore}
      />
    </ListRow>
  );
}

const styles = StyleSheet.create({
  filters: { gap: 8 },
  selects: { flexDirection: "row", gap: 8 },
  select: { flex: 1 },
  body: { flex: 1, minWidth: 0, gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 8 },
  iconButton: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  // Keeps the width steady while the button shows its spinner.
  restore: { minWidth: 92 },
});
