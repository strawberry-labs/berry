import * as React from "react";
import { Keyboard, Pressable, SectionList, StyleSheet, View, type TextInput } from "react-native";
import { router, useFocusEffect, useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { taskIsInProgress } from "@berry/client-core/conversations";
import { timeAgo } from "@berry/client-core/format";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Folder, LayoutAlignLeft, MessageSquare, PencilEdit02Icon, SearchIcon, Settings, XIcon, type Icon } from "../../ui/icons";
import { EmptyState, Input, Spinner } from "../../ui/primitives";
import { Screen } from "../../ui/screen";
import { Text } from "../../ui/text";
import { useActiveWorkspace, useTasks, useWorkspaces } from "../data/shell-data";
import { SETTINGS_TAB_ICONS, openSettingsTab } from "../settings/settings-navigation";
import { settingsTab, visibleSettingsTabs, type SettingsTabId } from "../settings/settings-model";
import { buildSearchSections, highlightRanges, type SearchAction, type SearchItem, type SearchSection } from "./search-model";

const SETTINGS_PREFIX = "settings:";

/**
 * The web's command palette as a phone screen: a search field that focuses
 * on arrival, then Actions, Projects and Tasks grouped like the web, with
 * your recent tasks before you type.
 */
export function SearchScreen() {
  const { serverInfo } = useSignedInSession();
  const { colors, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const tasks = useTasks();
  const workspaces = useWorkspaces();
  const [, setActiveWorkspace] = useActiveWorkspace(workspaces.data);
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query);
  const inputRef = React.useRef<TextInput>(null);

  // Drawer screens stay mounted, so focus (and start fresh) on every visit.
  useFocusEffect(React.useCallback(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => {
      clearTimeout(timer);
      setQuery("");
    };
  }, []));

  const actions = React.useMemo<SearchAction[]>(() => [
    { id: "new-task", label: "New task", keywords: "new task chat start compose create", pinned: true },
    { id: "settings", label: "Settings", keywords: "settings preferences", pinned: true },
    ...visibleSettingsTabs(serverInfo?.capabilities ?? null).map((tab): SearchAction => ({
      id: `${SETTINGS_PREFIX}${tab.id}`,
      label: tab.label,
      keywords: `settings ${tab.keywords}`,
      ...(tab.href ? {} : { detail: "Settings" }),
    })),
  ], [serverInfo]);

  const sections = React.useMemo(
    () => buildSearchSections({ query: deferredQuery, tasks: tasks.data ?? [], workspaces: workspaces.data ?? [], actions }),
    [actions, deferredQuery, tasks.data, workspaces.data],
  );

  const close = () => {
    Keyboard.dismiss();
    if (router.canGoBack()) router.back();
    else router.navigate("/(app)");
  };

  const select = (item: SearchItem) => {
    Keyboard.dismiss();
    if (item.kind === "task") {
      router.navigate({ pathname: "/(app)/tasks/[taskId]", params: { taskId: item.task.id } });
    } else if (item.kind === "project") {
      setActiveWorkspace(item.workspace.id);
      router.navigate("/(app)");
    } else if (item.action.id === "new-task") {
      router.navigate("/(app)");
    } else if (item.action.id === "settings") {
      router.navigate("/(app)/settings");
    } else if (item.action.id.startsWith(SETTINGS_PREFIX)) {
      openSettingsTab(settingsTab(item.action.id.slice(SETTINGS_PREFIX.length) as SettingsTabId), "navigate");
    }
  };

  const loading = (tasks.isPending || workspaces.isPending) && !tasks.isError;
  const searching = deferredQuery.trim().length > 0;

  return (
    <Screen edges={["top"]}>
      <View style={[styles.bar, { height: layout.titlebarHeight }]}>
        <Button variant="ghost" size="icon-lg" icon={LayoutAlignLeft} accessibilityLabel="Open sidebar" onPress={() => navigation.dispatch(DrawerActions.openDrawer())} />
        <View style={styles.field}>
          <View style={styles.fieldIcon} pointerEvents="none"><SearchIcon size={16} color={colors.textTertiary} /></View>
          <Input
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Search tasks and actions…"
            accessibilityLabel="Search tasks and actions"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            enablesReturnKeyAutomatically
            onSubmitEditing={() => {
              // Return opens the best match, like Enter in the web palette.
              const first = sections[0]?.data[0];
              if (first && searching) select(first);
            }}
            style={styles.input}
          />
          {query ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} onPress={() => { setQuery(""); inputRef.current?.focus(); }} style={styles.clear}>
              <XIcon size={14} color={colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" onPress={close} hitSlop={8} style={styles.cancel}>
          <Text variant="body" tone="secondary">Cancel</Text>
        </Pressable>
      </View>

      <SectionList<SearchItem, SearchSection>
        sections={sections}
        keyExtractor={(item) => item.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        renderSectionHeader={({ section }) => (
          <Text variant="secondary" tone="tertiary" weight="medium" accessibilityRole="header" style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => <ResultRow item={item} query={deferredQuery} onPress={() => select(item)} />}
        ListEmptyComponent={
          searching ? (
            loading ? (
              <View style={styles.loading}><Spinner /><Text variant="secondary" tone="tertiary">Loading tasks…</Text></View>
            ) : <EmptyState title="No tasks or actions found." message="Try a different word or check the spelling." />
          ) : null
        }
        ListFooterComponent={
          tasks.isError ? (
            <View style={styles.footer}>
              <Text variant="secondary" tone="tertiary">Couldn't load your tasks.</Text>
              <Button variant="outline" size="sm" label="Try again" onPress={() => void tasks.refetch()} />
            </View>
          ) : !searching && loading ? (
            <View style={styles.loading}><Spinner /></View>
          ) : null
        }
      />
    </Screen>
  );
}

function actionIcon(action: SearchAction): Icon {
  if (action.id === "new-task") return PencilEdit02Icon;
  if (action.id === "settings") return Settings;
  if (action.id.startsWith(SETTINGS_PREFIX)) return SETTINGS_TAB_ICONS[action.id.slice(SETTINGS_PREFIX.length) as SettingsTabId] ?? Settings;
  return Settings;
}

function ResultRow({ item, query, onPress }: { item: SearchItem; query: string; onPress: () => void }) {
  const { colors, layout } = useTheme();
  let IconComponent: Icon;
  let title: string;
  let detail: string | null = null;
  let trailing: React.ReactNode = null;
  if (item.kind === "task") {
    IconComponent = MessageSquare;
    title = item.task.title || "Untitled task";
    detail = `${item.provenance} · ${item.state}`;
    trailing = taskIsInProgress(item.task) ? <Spinner /> : <Text variant="meta" tone="faint">{timeAgo(item.task.updatedAt)}</Text>;
  } else if (item.kind === "project") {
    IconComponent = Folder;
    title = item.workspace.name;
    detail = `Project · ${item.taskCount} ${item.taskCount === 1 ? "task" : "tasks"}`;
  } else {
    IconComponent = actionIcon(item.action);
    title = item.action.label;
    detail = item.action.detail ?? null;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderRadius: layout.radius, backgroundColor: pressed ? colors.hover : "transparent" }]}
    >
      <IconComponent size={16} color={colors.textSecondary} />
      <View style={styles.rowBody}>
        <HighlightedTitle title={title} query={query} />
        {detail ? <Text variant="meta" tone="tertiary" numberOfLines={1}>{detail}</Text> : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** The title with the typed words in medium weight, so the match is easy to spot. */
function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const ranges = highlightRanges(title, query);
  if (!ranges.length) return <Text variant="body" numberOfLines={1}>{title}</Text>;
  const parts: React.ReactNode[] = [];
  let index = 0;
  ranges.forEach(([start, end], position) => {
    if (start > index) parts.push(<Text key={`t${position}`} variant="body">{title.slice(index, start)}</Text>);
    parts.push(<Text key={`h${position}`} variant="body" weight="semibold">{title.slice(start, end)}</Text>);
    index = end;
  });
  if (index < title.length) parts.push(<Text key="rest" variant="body">{title.slice(index)}</Text>);
  return <Text variant="body" numberOfLines={1}>{parts}</Text>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingLeft: 4, paddingRight: 8, gap: 4 },
  field: { flex: 1, justifyContent: "center" },
  fieldIcon: { position: "absolute", left: 12, zIndex: 1 },
  input: { minHeight: 40, paddingLeft: 36, paddingRight: 32 },
  clear: { position: "absolute", right: 10, width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  cancel: { minHeight: 44, justifyContent: "center", paddingHorizontal: 6 },
  list: { paddingHorizontal: 8, paddingTop: 4 },
  sectionHeader: { paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6 },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 32 },
  footer: { alignItems: "center", gap: 10, paddingVertical: 24 },
});
