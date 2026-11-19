import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import type { Task, Workspace } from "@berry/shared";
import { taskHasUnreadActivity, taskIsInProgress } from "@berry/client-core/conversations";
import { timeAgo } from "@berry/client-core/format";
import { useTheme } from "../../theme/theme";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Pin } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Spinner } from "../../ui/primitives";
import { Text } from "../../ui/text";

/** "Pinned", "Projects", "Tasks": the web's section headings, collapsible. */
export function SectionHeading({ title, open, onToggle, actions }: { title: string; open: boolean; onToggle?: () => void; actions?: React.ReactNode }) {
  const { colors } = useTheme();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <View style={styles.heading}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${open ? "expanded" : "collapsed"}`}
        onPress={onToggle}
        disabled={!onToggle}
        hitSlop={8}
        style={styles.headingButton}
      >
        <Text variant="sectionHeading" tone="tertiary">{title}</Text>
        {onToggle ? <Chevron size={14} color={colors.textTertiary} /> : null}
      </Pressable>
      <View style={styles.headingActions}>{actions}</View>
    </View>
  );
}

export function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)} layout={LinearTransition.duration(200)}>
      {children}
    </Animated.View>
  );
}

export function taskMenuItems(task: Task, options: { canMutate: boolean }): MenuItem[] {
  if (!options.canMutate) return [];
  return [
    { id: "pin", title: task.pinned ? "Unpin task" : "Pin task", systemImage: task.pinned ? "pin.slash" : "pin" },
    { id: "rename", title: "Rename", systemImage: "pencil" },
    { id: "share", title: "Share", systemImage: "square.and.arrow.up" },
    { id: "archive", title: "Archive", systemImage: "archivebox" },
    { id: "delete", title: "Delete", systemImage: "trash", destructive: true },
  ];
}

/** A conversation row: title, then a spinner, unread dot, or age, like the web sidebar. */
export function TaskRow({ task, active, indent = 0, onPress, menu, onMenuSelect }: {
  task: Task;
  active: boolean;
  indent?: number;
  onPress: () => void;
  menu: MenuItem[];
  onMenuSelect: (id: string) => void;
}) {
  const { colors, layout } = useTheme();
  const running = taskIsInProgress(task);
  const unread = !active && taskHasUnreadActivity(task);
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title || "Untitled task"}${running ? ", working" : unread ? ", new activity" : ""}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.taskRow,
        { paddingLeft: 8 + indent, borderRadius: layout.radius, backgroundColor: active ? colors.selected : pressed ? colors.hover : "transparent" },
      ]}
    >
      <Text variant="body" numberOfLines={1} tone={active ? "primary" : "secondary"} weight={unread ? "medium" : "body"} style={styles.taskTitle}>
        {task.title || "Untitled task"}
      </Text>
      {running ? <Spinner /> : unread ? <View style={[styles.unread, { backgroundColor: colors.accent }]} /> : <Text variant="meta" tone="faint">{timeAgo(task.updatedAt)}</Text>}
    </Pressable>
  );
  if (menu.length === 0) return row;
  return <Menu items={menu} onSelect={onMenuSelect} longPress>{row}</Menu>;
}

export function ProjectRow({ workspace, open, onPress, menu, onMenuSelect }: {
  workspace: Workspace;
  open: boolean;
  onPress: () => void;
  menu: MenuItem[];
  onMenuSelect: (id: string) => void;
}) {
  const { colors, layout } = useTheme();
  const FolderIcon = open ? FolderOpen : Folder;
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${workspace.name} project`}
      onPress={onPress}
      style={({ pressed }) => [styles.projectRow, { borderRadius: layout.radius, backgroundColor: pressed ? colors.hover : "transparent" }]}
    >
      <FolderIcon size={16} color={colors.textSecondary} />
      <Text variant="body" tone="secondary" numberOfLines={1} style={styles.taskTitle}>{workspace.name}</Text>
      {workspace.pinned ? <Pin size={12} color={colors.textFaint} /> : null}
    </Pressable>
  );
  return <Menu items={menu} onSelect={onMenuSelect} longPress>{row}</Menu>;
}

export function ShowMoreRow({ count, onPress, indent = 0 }: { count: number; onPress: () => void; indent?: number }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.showMore, { paddingLeft: 8 + indent }]}>
      <Text variant="secondary" tone="tertiary">Show {count} more</Text>
    </Pressable>
  );
}

export function SidebarStatus({ label, indent = 0 }: { label: string; indent?: number }) {
  return (
    <View style={[styles.showMore, { paddingLeft: 8 + indent }]}>
      <Text variant="secondary" tone="faint">{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", minHeight: 36, paddingLeft: 8, paddingRight: 2 },
  headingButton: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1, minHeight: 36 },
  headingActions: { flexDirection: "row", alignItems: "center" },
  taskRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 10 },
  taskTitle: { flex: 1 },
  unread: { width: 7, height: 7, borderRadius: 4 },
  projectRow: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 8, paddingRight: 10 },
  showMore: { minHeight: 34, justifyContent: "center" },
});
