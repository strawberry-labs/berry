import * as React from "react";
import { LogOut, Plus, X } from "lucide-react";
import type { Task, Workspace } from "@berry/shared";
import { BerryConversationSidebarContent } from "@berry/desktop-ui/components/berry-conversation-sidebar";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Kbd } from "@berry/desktop-ui/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@berry/desktop-ui/components/ui/sidebar";
import { ArrowLeft02, ArrowRight02, CirclePlus, FolderOpen, Search, Settings as SettingsIcon, Wand2 } from "@berry/desktop-ui/lib/icons";
import type { SignedInUser } from "./auth-boundary";

export type SettingsTab = "general" | "prompts" | "providers" | "mcp" | "skills" | "privacy" | "usage" | "archived" | "governance" | "platform";

export const WEB_SETTINGS_NAV: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "providers", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Servers" },
  { id: "prompts", label: "Prompts and commands" },
  { id: "privacy", label: "Permissions and privacy" },
  { id: "usage", label: "Usage" },
  { id: "archived", label: "Archived chats" },
  { id: "governance", label: "Organization administration" },
  { id: "platform", label: "Platform administration" },
];

export function WebSettingsSidebar({ tab, onTabChange, onBack, allowPlatform }: { tab: SettingsTab; onTabChange: (tab: SettingsTab) => void; onBack: () => void; allowPlatform: boolean }) {
  return (
    <Sidebar variant="inset" className="berry-app-sidebar berry-settings-sidebar">
      <SidebarHeader className="berry-sidebar-header pt-[var(--berry-titlebar-height)]">
        <Button variant="ghost" className="w-full justify-start gap-2" onClick={onBack}><ArrowLeft02 /> Back to workspace</Button>
      </SidebarHeader>
      <SidebarContent className="px-2 pt-4">
        <SidebarMenu>
          {WEB_SETTINGS_NAV.filter((item) => item.id !== "platform" || allowPlatform).map((item) => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={tab === item.id} onClick={() => onTabChange(item.id)}><SettingsIcon /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}

export function WebWindowChrome({ canGoBack, canGoForward, onBack, onForward }: {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  return (
    <div className="pointer-events-none absolute top-0 left-0 z-50 flex h-[var(--berry-titlebar-height)] w-full items-center">
      <div className="berry-window-nav pointer-events-auto absolute flex items-center">
        <SidebarTrigger className="berry-titlebar-control" />
        <Button variant="ghost" size="icon-lg" disabled={!canGoBack} onClick={onBack} aria-label="Back" className="berry-titlebar-control"><ArrowLeft02 /></Button>
        <Button variant="ghost" size="icon-lg" disabled={!canGoForward} onClick={onForward} aria-label="Forward" className="berry-titlebar-control"><ArrowRight02 /></Button>
      </div>
    </div>
  );
}

export function WebSidebar({ workspaces, tasksByWorkspace, generalTasks, activeWorkspaceId, activeTaskId, chatsSelected, librarySelected, creatingProject, loadError, user, onNewTask, onSearch, onCreateProject, onCancelProject, onSubmitProject, onSelectWorkspace, onSelectChats, onOpenTask, onSkills, onLibrary, onSettings, onSignOut }: {
  workspaces: Workspace[];
  tasksByWorkspace: Record<string, Task[]>;
  generalTasks: Task[];
  activeWorkspaceId: string;
  activeTaskId: string | null;
  chatsSelected: boolean;
  librarySelected: boolean;
  creatingProject: boolean;
  loadError: string;
  user: SignedInUser | null;
  onNewTask: () => void;
  onSearch: () => void;
  onCreateProject: () => void;
  onCancelProject: () => void;
  onSubmitProject: (event: React.FormEvent<HTMLFormElement>) => void;
  onSelectWorkspace: (id: string) => void;
  onSelectChats: () => void;
  onOpenTask: (id: string) => void;
  onSkills: () => void;
  onLibrary: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const allTasks = [...Object.values(tasksByWorkspace).flat(), ...generalTasks];
  return (
    <Sidebar variant="inset" className="berry-app-sidebar">
      <BerryConversationSidebarContent
        selectedKind="chat"
        showKindControl={false}
        pinnedConversations={allTasks.filter((task) => task.pinned)}
        projects={workspaces.map((workspace) => ({ workspace, conversations: tasksByWorkspace[workspace.id] ?? [] }))}
        generalConversations={generalTasks}
        chatsSelected={chatsSelected}
        activeWorkspaceId={activeWorkspaceId}
        activeConversationId={activeTaskId}
        projectsError={loadError || null}
        onKindChange={() => {}}
        onSelectProject={onSelectWorkspace}
        onSelectChats={onSelectChats}
        onOpenConversation={onOpenTask}
        onAfterNavigate={() => { if (isMobile) setOpenMobile(false); }}
        formatAge={timeAgo}
        renderProjectAction={() => <SidebarMenuAction showOnHover aria-label="Create project" onClick={(event) => { event.stopPropagation(); onCreateProject(); }}><Plus /></SidebarMenuAction>}
        commands={(
          <>
            <SidebarMenu className="berry-sidebar-commands">
              <SidebarMenuItem><SidebarMenuButton onClick={onNewTask} className="berry-sidebar-command berry-sidebar-command-primary font-medium"><CirclePlus /><span>New chat</span><Kbd className="ml-auto" aria-hidden>⌘N</Kbd></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton data-web-search-trigger onClick={onSearch} className="berry-sidebar-command"><Search /><span>Search</span><Kbd className="ml-auto" aria-hidden>⌘K</Kbd></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton aria-label="Open capabilities" onClick={onSkills} className="berry-sidebar-command"><Wand2 /><span>Skills</span></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton isActive={librarySelected} aria-label="Open library" onClick={onLibrary} className="berry-sidebar-command"><FolderOpen /><span>Library</span></SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
            {creatingProject ? <form className="new-project-form" onSubmit={onSubmitProject}><input name="projectName" placeholder="Project name" autoFocus required maxLength={120} /><button type="submit">Create</button><button type="button" aria-label="Cancel project" onClick={onCancelProject}><X size={14} /></button></form> : null}
          </>
        )}
      />
      <SidebarFooter className="berry-sidebar-footer">
        <div className="flex items-center gap-2">
          <div className="berry-connect-button flex h-11 min-w-0 flex-1 items-center gap-3 px-2"><span className="berry-connect-avatar flex size-8 shrink-0 items-center justify-center rounded-full p-1"><BerryLogo className="size-full" alt="" /></span><span className="min-w-0 truncate text-sm font-semibold">{user?.name || user?.email || "Berry Cloud"}</span></div>
          <Button variant="ghost" size="icon-sm" onClick={onSettings} aria-label="Settings" className="berry-sidebar-mini-control"><SettingsIcon /></Button>
          {user ? <Button variant="ghost" size="icon-sm" onClick={onSignOut} aria-label="Sign out" className="berry-sidebar-mini-control"><LogOut size={15} /></Button> : null}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
