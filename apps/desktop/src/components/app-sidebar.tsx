import * as React from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationKind, Task } from "@berry/shared";
import { Ellipsis, PencilEdit02Icon, Search, Settings, Wand2 } from "@berry/desktop-ui/lib/icons";
import { BerryConversationSidebarContent } from "@berry/desktop-ui/components/berry-conversation-sidebar";
import {
  Sidebar,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@berry/desktop-ui/components/ui/sidebar";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Kbd } from "@berry/desktop-ui/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import { cn } from "@berry/desktop-ui/lib/utils";
import { toast } from "sonner";

import { host, timeAgo, useWorkbench } from "@/lib/berry";
import { BerryLogo } from "@/components/berry-logo";
import { ConnectMenu } from "@/components/connect-menu";
import { WorkspaceRowActions } from "@/components/workspace-switcher";
import { SettingsNav } from "@/components/settings/nav";

export function AppSidebar({ className, ...props }: React.ComponentProps<typeof Sidebar>) {
  const queryClient = useQueryClient();
  const { isMobile, setOpenMobile } = useSidebar();
  const {
    workspaces,
    activeWorkspace,
    setActiveWorkspaceId,
    openTask,
    openHome,
    openSettings,
    setPaletteOpen,
    view,
    selectedConversationKind,
    setSelectedConversationKind,
  } = useWorkbench();
  const projectWorkspaces = workspaces.filter((workspace) => workspace.workspaceKind !== "general");
  const generalWorkspace = workspaces.find((workspace) => workspace.workspaceKind === "general") ?? null;
  const taskQueries = useQueries({
    queries: projectWorkspaces.map((workspace) => ({
      queryKey: ["task.list", workspace.id],
      queryFn: () => host.call<Task[]>("task.list", { workspaceId: workspace.id }),
    })),
  });
  const generalQuery = useQuery({
    queryKey: ["task.listGeneral"],
    queryFn: () => host.call<Task[]>("task.listGeneral", { limit: 500, offset: 0 }),
  });
  const allTasks = [...taskQueries.flatMap((query) => query.data ?? []), ...(generalQuery.data ?? [])];
  const activeTask = view.kind === "task" ? allTasks.find((task) => task.id === view.taskId) ?? null : null;
  const displayedKind = activeTask?.conversationKind ?? selectedConversationKind;

  const refreshTaskLists = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["task.list"] }),
      queryClient.invalidateQueries({ queryKey: ["task.listGeneral"] }),
    ]);
  }, [queryClient]);

  const toggleConversationPinned = React.useCallback(async (task: Task) => {
    try {
      await host.call("task.setPinned", { id: task.id, pinned: !task.pinned });
      await refreshTaskLists();
      toast.success(task.pinned ? "Chat unpinned" : "Chat pinned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the chat");
    }
  }, [refreshTaskLists]);

  const archiveConversation = React.useCallback(async (task: Task) => {
    try {
      await host.call("task.setArchived", { id: task.id, archived: true });
      await refreshTaskLists();
      if (view.kind === "task" && view.taskId === task.id) openHome();
      toast.success("Chat archived");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not archive the chat");
    }
  }, [openHome, refreshTaskLists, view]);

  const updateKind = React.useCallback(async (kind: ConversationKind) => {
    if (view.kind !== "task") {
      setSelectedConversationKind(kind);
      return;
    }
    const taskId = view.taskId;
    const snapshots = queryClient.getQueriesData<Task[]>({ queryKey: ["task.list"] });
    const generalSnapshot = queryClient.getQueryData<Task[]>(["task.listGeneral"]);
    const patchTasks = (current: Task[] | undefined) => current?.map((task) => task.id === taskId ? { ...task, conversationKind: kind } : task);
    queryClient.setQueriesData<Task[]>({ queryKey: ["task.list"] }, patchTasks);
    queryClient.setQueryData<Task[]>(["task.listGeneral"], patchTasks);
    try {
      const updated = await host.call<Task>("task.setConversationKind", { id: taskId, conversationKind: kind });
      const applyCanonical = (current: Task[] | undefined) => current?.map((task) => task.id === taskId ? updated : task);
      queryClient.setQueriesData<Task[]>({ queryKey: ["task.list"] }, applyCanonical);
      queryClient.setQueryData<Task[]>(["task.listGeneral"], applyCanonical);
    } catch (error) {
      for (const [queryKey, data] of snapshots) queryClient.setQueryData(queryKey, data);
      queryClient.setQueryData(["task.listGeneral"], generalSnapshot);
      throw error;
    }
  }, [queryClient, setSelectedConversationKind, view]);

  const openConversation = (taskId: string) => {
    const task = allTasks.find((candidate) => candidate.id === taskId);
    const project = projectWorkspaces.find((workspace, index) => taskQueries[index]?.data?.some((candidate) => candidate.id === taskId));
    if (project) setActiveWorkspaceId(project.id);
    else if (generalWorkspace && generalQuery.data?.some((candidate) => candidate.id === taskId)) setActiveWorkspaceId(generalWorkspace.id);
    if (task) setSelectedConversationKind(task.conversationKind);
    openTask(taskId);
  };

  return (
    <Sidebar variant="inset" className={cn("berry-app-sidebar", className)} {...props}>
      {view.kind === "settings" ? (
        <SettingsNav page={view.page} />
      ) : (
        <BerryConversationSidebarContent
          selectedKind={displayedKind}
          pinnedConversations={allTasks.filter((task) => task.pinned)}
          projects={projectWorkspaces.map((workspace, index) => ({
            workspace,
            conversations: taskQueries[index]?.data ?? [],
            loading: taskQueries[index]?.isPending ?? false,
            error: taskQueries[index]?.error instanceof Error ? taskQueries[index]!.error.message : null,
          }))}
          generalConversations={generalQuery.data ?? []}
          activeWorkspaceId={activeWorkspace?.id ?? null}
          activeConversationId={view.kind === "task" ? view.taskId : null}
          projectsLoading={taskQueries.length > 0 && taskQueries.every((query) => query.isPending)}
          chatsLoading={generalQuery.isPending}
          chatsError={generalQuery.error instanceof Error ? generalQuery.error.message : null}
          onKindChange={updateKind}
          onSelectProject={(workspaceId) => {
            setActiveWorkspaceId(workspaceId);
            openHome();
          }}
          chatsSelected={activeWorkspace?.workspaceKind === "general"}
          onSelectChats={() => {
            if (generalWorkspace) setActiveWorkspaceId(generalWorkspace.id);
            openHome();
          }}
          onOpenConversation={openConversation}
          onToggleConversationPinned={toggleConversationPinned}
          onArchiveConversation={archiveConversation}
          onNewProjectConversation={(workspace) => {
            setActiveWorkspaceId(workspace.id);
            setSelectedConversationKind(displayedKind);
            openHome();
          }}
          onAfterNavigate={() => {
            if (isMobile) setOpenMobile(false);
          }}
          formatAge={timeAgo}
          renderProjectAction={(workspace) => (
            <WorkspaceRowActions
              workspace={workspace}
              tasks={taskQueries[projectWorkspaces.findIndex((candidate) => candidate.id === workspace.id)]?.data ?? []}
              trigger={<SidebarMenuAction aria-label={`Actions for ${workspace.name}`} className="berry-sidebar-workspace-action berry-sidebar-workspace-menu-action md:opacity-0 peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"><Ellipsis /></SidebarMenuAction>}
            />
          )}
          commands={(
            <SidebarMenu className="berry-sidebar-commands">
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => { setSelectedConversationKind(displayedKind); openHome(); }} className="berry-sidebar-command berry-sidebar-command-primary font-medium">
                  <PencilEdit02Icon />
                  <span>{displayedKind === "code" ? "New code chat" : "New chat"}</span>
                  <Kbd className="ml-auto" aria-hidden>⌘N</Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setPaletteOpen(true)} className="berry-sidebar-command">
                  <Search />
                  <span>Search</span>
                  <Kbd className="ml-auto" aria-hidden>⌘K</Kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => openSettings("skills")} className="berry-sidebar-command">
                  <Wand2 />
                  <span>Skills</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
        />
      )}
      <SidebarFooter className="berry-sidebar-footer">
        <div className="flex items-center gap-2">
          <ConnectMenu>
            <Button variant="ghost" className="berry-connect-button h-11 flex-1 justify-start gap-3 px-2">
              <span className="berry-connect-avatar flex size-8 items-center justify-center rounded-full p-1"><BerryLogo className="size-full" alt="" /></span>
              <span className="text-[17px] font-semibold">Connect</span>
            </Button>
          </ConnectMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => openSettings()} aria-label="Settings" className="berry-sidebar-mini-control"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
