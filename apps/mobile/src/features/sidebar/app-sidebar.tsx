import * as React from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, View } from "react-native";
import { router, usePathname } from "expo-router";
import type { DrawerContentComponentProps } from "expo-router/drawer";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Task, Workspace } from "@berry/shared";
import {
  INITIAL_CONVERSATION_SECTION_STATE,
  PROJECT_SORT_OPTIONS,
  conversationSectionReducer,
  visibleConversationSlice,
  type ProjectSort,
} from "@berry/client-core/conversations";
import { hasCapability } from "../../session/compatibility";
import { useSignedInSession } from "../../session/session";
import { kv } from "../../storage/kv";
import { useTheme } from "../../theme/theme";
import { BrandLockup } from "../../ui/brand";
import { Button } from "../../ui/button";
import { CalendarClock, Ellipsis, FolderOpen, PencilEdit02Icon, Plus, Search, Settings, Wand2, X } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Avatar } from "../../ui/primitives";
import { PromptSheet } from "../../ui/prompt-sheet";
import { SidebarMenuButton } from "../../ui/rows";
import { Text } from "../../ui/text";
import { buildSidebarModel, useActiveWorkspace, useProjectActions, useTaskActions, useTasks, useWorkspaces } from "../data/shell-data";
import { AllowanceSheet } from "./allowance-sheet";
import { Collapsible, ProjectRow, SectionHeading, ShowMoreRow, SidebarStatus, TaskRow, taskMenuItems } from "./sidebar-rows";

const PROJECT_SORT_KEY = "berry.user.projectSort";

type Prompt =
  | { kind: "rename-task"; task: Task }
  | { kind: "rename-project"; workspace: Workspace }
  | { kind: "create-project" };

/**
 * The web sidebar, section for section: brand header (D6), New task / Skills /
 * Library / Scheduled, Pinned, Projects, Tasks, and the account footer.
 */
export function AppSidebar({ navigation }: { navigation: DrawerContentComponentProps["navigation"] }) {
  const { profile, serverInfo } = useSignedInSession();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const brand = serverInfo?.brand ?? profile.brand;
  const pathname = usePathname();
  const activeTaskId = /^\/tasks\/([^/]+)/.exec(pathname)?.[1] ?? null;

  const workspaces = useWorkspaces();
  const tasks = useTasks();
  const [, setActiveWorkspace] = useActiveWorkspace(workspaces.data);
  const taskActions = useTaskActions();
  const projectActions = useProjectActions();
  const [sections, dispatch] = React.useReducer(conversationSectionReducer, INITIAL_CONVERSATION_SECTION_STATE);
  const [projectSort, setProjectSort] = React.useState<ProjectSort>(() => (kv.getItem(PROJECT_SORT_KEY) as ProjectSort | null) ?? "last-updated");
  const [pinnedOpen, setPinnedOpen] = React.useState(true);
  const [prompt, setPrompt] = React.useState<Prompt | null>(null);
  const [accountOpen, setAccountOpen] = React.useState(false);

  const model = React.useMemo(
    () => buildSidebarModel(workspaces.data ?? [], tasks.data ?? [], projectSort),
    [projectSort, tasks.data, workspaces.data],
  );

  const go = (href: Parameters<typeof router.navigate>[0]) => {
    router.navigate(href);
    navigation.closeDrawer();
  };
  const openTask = (task: Task) => go({ pathname: "/(app)/tasks/[taskId]", params: { taskId: task.id } });

  const onTaskMenu = (task: Task, id: string) => {
    if (id === "pin") taskActions.mutate({ kind: "pin", task });
    else if (id === "rename") setPrompt({ kind: "rename-task", task });
    else if (id === "share") void Share.share({ message: task.title, url: `${profile.serverUrl}/tasks/${task.id}` });
    else if (id === "archive") {
      taskActions.mutate({ kind: "archive", task });
      if (activeTaskId === task.id) go("/(app)");
    } else if (id === "delete") {
      Alert.alert("Delete this task?", "You can restore it from Archived tasks in Settings.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => {
          taskActions.mutate({ kind: "delete", task });
          if (activeTaskId === task.id) go("/(app)");
        } },
      ]);
    }
  };

  const projectMenu = (workspace: Workspace, projectTasks: Task[]): MenuItem[] => [
    { id: "new", title: "New task in project", systemImage: "square.and.pencil" },
    { id: "pin", title: workspace.pinned ? "Unpin project" : "Pin project", systemImage: workspace.pinned ? "pin.slash" : "pin" },
    { id: "rename", title: "Rename project", systemImage: "pencil" },
    { id: "archive", title: "Archive tasks", systemImage: "archivebox", disabled: projectTasks.length === 0 },
    { id: "remove", title: "Remove", systemImage: "trash", destructive: true },
  ];
  const onProjectMenu = (workspace: Workspace, projectTasks: Task[], id: string) => {
    if (id === "new") {
      setActiveWorkspace(workspace.id);
      go("/(app)");
    } else if (id === "pin") projectActions.mutate({ kind: "pin", workspace });
    else if (id === "rename") setPrompt({ kind: "rename-project", workspace });
    else if (id === "archive") {
      Alert.alert(`Archive tasks in ${workspace.name}?`, `This archives ${projectTasks.length} task${projectTasks.length === 1 ? "" : "s"}. Archived tasks remain recoverable.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Archive tasks", onPress: () => projectActions.mutate({ kind: "archive-tasks", workspace, tasks: projectTasks }) },
      ]);
    } else if (id === "remove") {
      Alert.alert(`Remove ${workspace.name}?`, "This removes the project and its tasks from Berry. This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => projectActions.mutate({ kind: "remove", workspace }) },
      ]);
    }
  };

  const showSkills = hasCapability(serverInfo, "skills") || !serverInfo;
  const showLibrary = hasCapability(serverInfo, "library") || !serverInfo;
  const showScheduled = hasCapability(serverInfo, "scheduled-tasks") || !serverInfo;
  const loadError = workspaces.error ?? tasks.error;
  const loading = workspaces.isPending || tasks.isPending;
  const chats = visibleConversationSlice(model.generalTasks, sections.chatsExpanded);

  return (
    <View style={[styles.root, { backgroundColor: colors.sidebar, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <BrandLockup name={brand.applicationName} logoUrl={brand.logoUrl} />
        <View style={styles.headerActions}>
          <Button variant="ghost" size="icon-lg" icon={Search} accessibilityLabel="Search" onPress={() => go("/(app)/search")} />
          <Button variant="ghost" size="icon-lg" icon={X} accessibilityLabel="Close sidebar" onPress={() => navigation.closeDrawer()} />
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.commands}>
          <SidebarMenuButton icon={PencilEdit02Icon} label="New task" active={pathname === "/"} onPress={() => go("/(app)")} />
          {showSkills ? <SidebarMenuButton icon={Wand2} label="Skills" active={pathname.startsWith("/skills")} onPress={() => go("/(app)/skills")} /> : null}
          {showLibrary ? <SidebarMenuButton icon={FolderOpen} label="Library" active={pathname.startsWith("/library")} onPress={() => go("/(app)/library")} /> : null}
          {showScheduled ? <SidebarMenuButton icon={CalendarClock} label="Scheduled" active={pathname.startsWith("/scheduled")} onPress={() => go("/(app)/scheduled")} /> : null}
        </View>

        {model.pinned.length > 0 ? (
          <View>
            <SectionHeading title="Pinned" open={pinnedOpen} onToggle={() => setPinnedOpen((open) => !open)} />
            <Collapsible open={pinnedOpen}>
              {model.pinned.map((task) => (
                <TaskRow key={task.id} task={task} active={task.id === activeTaskId} onPress={() => openTask(task)} menu={taskMenuItems(task, { canMutate: true })} onMenuSelect={(id) => onTaskMenu(task, id)} />
              ))}
            </Collapsible>
          </View>
        ) : null}

        <View>
          <SectionHeading
            title="Projects"
            open={!sections.projectsCollapsed}
            onToggle={() => dispatch({ type: "toggle-projects" })}
            actions={(
              <>
                <Menu
                  title="Sort projects"
                  items={PROJECT_SORT_OPTIONS.map((option) => ({ id: option.value, title: option.label, checked: option.value === projectSort }))}
                  onSelect={(id) => {
                    setProjectSort(id as ProjectSort);
                    kv.setItem(PROJECT_SORT_KEY, id);
                  }}
                >
                  <View accessible accessibilityRole="button" accessibilityLabel="Sort projects" style={styles.iconSlot}><Ellipsis size={16} color={colors.textTertiary} /></View>
                </Menu>
                <Pressable accessibilityRole="button" accessibilityLabel="Create project" onPress={() => setPrompt({ kind: "create-project" })} style={styles.iconSlot} hitSlop={6}>
                  <Plus size={16} color={colors.textTertiary} />
                </Pressable>
              </>
            )}
          />
          <Collapsible open={!sections.projectsCollapsed}>
            {loading ? <SidebarStatus label="Loading projects…" /> : null}
            {loadError ? <SidebarStatus label="Couldn't load projects. Pull to retry." /> : null}
            {model.projects.map(({ workspace, tasks: projectTasks }) => {
              const open = !sections.collapsedProjects.has(workspace.id);
              const slice = visibleConversationSlice(projectTasks, sections.expandedProjects.has(workspace.id));
              return (
                <View key={workspace.id}>
                  <ProjectRow workspace={workspace} open={open} onPress={() => dispatch({ type: "toggle-project", projectId: workspace.id })} menu={projectMenu(workspace, projectTasks)} onMenuSelect={(id) => onProjectMenu(workspace, projectTasks, id)} />
                  <Collapsible open={open}>
                    {slice.visible.map((task) => (
                      <TaskRow key={task.id} task={task} indent={24} active={task.id === activeTaskId} onPress={() => openTask(task)} menu={taskMenuItems(task, { canMutate: true })} onMenuSelect={(id) => onTaskMenu(task, id)} />
                    ))}
                    {slice.hiddenCount > 0 ? <ShowMoreRow indent={24} count={slice.hiddenCount} onPress={() => dispatch({ type: "show-project", projectId: workspace.id })} /> : null}
                    {projectTasks.length === 0 ? <SidebarStatus indent={24} label="No tasks yet" /> : null}
                  </Collapsible>
                </View>
              );
            })}
          </Collapsible>
        </View>

        <View>
          <SectionHeading title="Tasks" open={!sections.chatsCollapsed} onToggle={() => dispatch({ type: "toggle-chats" })} />
          <Collapsible open={!sections.chatsCollapsed}>
            {chats.visible.map((task) => (
              <TaskRow key={task.id} task={task} active={task.id === activeTaskId} onPress={() => openTask(task)} menu={taskMenuItems(task, { canMutate: true })} onMenuSelect={(id) => onTaskMenu(task, id)} />
            ))}
            {chats.hiddenCount > 0 ? <ShowMoreRow count={chats.hiddenCount} onPress={() => dispatch({ type: "show-chats" })} /> : null}
            {!loading && model.generalTasks.length === 0 ? <SidebarStatus label="No tasks yet" /> : null}
          </Collapsible>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open account and allowance" onPress={() => setAccountOpen(true)} style={styles.account}>
          <Avatar name={profile.user.name} email={profile.user.email} image={profile.user.image} size={26} />
          <Text variant="body" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>{profile.user.name || profile.user.email}</Text>
        </Pressable>
        <Button variant="ghost" size="icon-lg" icon={Settings} accessibilityLabel="Settings" onPress={() => go("/(app)/settings")} />
      </View>

      <AllowanceSheet open={accountOpen} onOpenChange={setAccountOpen} user={profile.user} onViewUsage={() => go({ pathname: "/(app)/settings/[tab]", params: { tab: "usage" } })} />
      <PromptSheet
        open={prompt !== null}
        onOpenChange={(open) => { if (!open) setPrompt(null); }}
        title={prompt?.kind === "create-project" ? "New project" : prompt?.kind === "rename-project" ? "Rename project" : "Rename task"}
        {...(prompt?.kind === "rename-project" ? { description: "Only the project name in Berry will change." } : {})}
        initialValue={prompt?.kind === "rename-task" ? prompt.task.title : prompt?.kind === "rename-project" ? prompt.workspace.name : ""}
        placeholder={prompt?.kind === "create-project" ? "e.g. Product launch" : undefined}
        submitLabel={prompt?.kind === "create-project" ? "Create" : "Rename"}
        onSubmit={(value) => {
          if (prompt?.kind === "rename-task") taskActions.mutate({ kind: "rename", task: prompt.task, title: value.slice(0, 120) });
          else if (prompt?.kind === "rename-project") projectActions.mutate({ kind: "rename", workspace: prompt.workspace, name: value.slice(0, 120) });
          else if (prompt?.kind === "create-project") projectActions.mutate({ kind: "create", name: value.slice(0, 120) });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { height: 56, flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4 },
  headerActions: { flexDirection: "row", marginLeft: "auto" },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 8, paddingBottom: 24, gap: 16 },
  commands: { gap: 0 },
  iconSlot: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  footer: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingTop: 6, gap: 4 },
  account: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 8 },
});
