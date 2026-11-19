import * as React from "react";
import { StyleSheet, View } from "react-native";
import type { Workspace } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { ChevronDown, Folder } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { PromptSheet } from "../../ui/prompt-sheet";
import { Text } from "../../ui/text";
import { useProjectActions } from "../data/shell-data";

/** The web's "Choose project" pill in the composer's context strip. */
export function ProjectSwitcher({ workspaces, active, onSelect }: { workspaces: Workspace[]; active: Workspace | null; onSelect: (id: string) => void }) {
  const { colors } = useTheme();
  const projectActions = useProjectActions();
  const [creating, setCreating] = React.useState(false);
  const projects = workspaces.filter((workspace) => workspace.workspaceKind === "project");
  const other = workspaces.filter((workspace) => workspace.workspaceKind === "general");
  const items: MenuItem[] = [
    ...[...projects, ...other].map((workspace) => ({ id: workspace.id, title: workspace.name, systemImage: "folder", checked: workspace.id === active?.id })),
    { id: "__new", title: "New project", systemImage: "folder.badge.plus" },
  ];
  return (
    <>
      <Menu
        items={items}
        title="Choose project"
        onSelect={(id) => {
          if (id === "__new") setCreating(true);
          else onSelect(id);
        }}
      >
        <View accessible accessibilityRole="button" accessibilityLabel={`Choose project, ${active?.name ?? "none"}`} style={styles.pill}>
          <Folder size={14} color={colors.textTertiary} />
          <Text variant="secondary" tone="tertiary" numberOfLines={1} style={{ flexShrink: 1 }}>{active?.name ?? "Choose project"}</Text>
          <ChevronDown size={14} color={colors.textTertiary} />
        </View>
      </Menu>
      <PromptSheet
        open={creating}
        onOpenChange={setCreating}
        title="New project"
        placeholder="Project name"
        submitLabel="Create"
        onSubmit={(name) => projectActions.mutate({ kind: "create", name }, { onSuccess: (workspace) => { if (workspace) onSelect(workspace.id); } })}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", maxWidth: 220, paddingHorizontal: 6, paddingVertical: 6, borderRadius: 8, minHeight: 32 },
});
