import * as React from "react";
import { LogOut, X } from "lucide-react";
import type { Task, Workspace } from "@berry/shared";
import { BerryConversationSidebarContent } from "@berry/desktop-ui/components/berry-conversation-sidebar";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Kbd } from "@berry/desktop-ui/components/ui/kbd";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@berry/desktop-ui/components/ui/alert-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Input } from "@berry/desktop-ui/components/ui/input";
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
import { Archive, ArrowLeft02, CirclePlus, Ellipsis, FolderOpen, Pencil, PencilEdit02Icon, Pin, PinOff, Search, Settings as SettingsIcon, Trash2, Wand2 } from "@berry/desktop-ui/lib/icons";
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

export function WebWindowChrome({ onHome, onSearch }: {
  onHome: () => void;
  onSearch: () => void;
}) {
  return (
    <div className="pointer-events-none absolute top-0 left-0 z-50 flex h-[var(--berry-titlebar-height)] w-full items-center">
      <div className="berry-web-window-header pointer-events-auto flex w-full items-center justify-between">
        <button type="button" className="berry-web-home-link" onClick={onHome} aria-label="Berry home">
          <BerryLogo className="size-5" alt="" />
          <span>Berry</span>
        </button>
        <div className="berry-web-window-actions flex items-center">
          <Button variant="ghost" size="icon-lg" onClick={onSearch} aria-label="Search" title="Search" data-web-search-trigger className="berry-web-header-icon"><Search /></Button>
          <SidebarTrigger aria-label="Toggle sidebar" title="Toggle sidebar" className="berry-web-header-icon berry-web-sidebar-toggle" />
        </div>
      </div>
    </div>
  );
}

export function WebSidebar({ workspaces, tasksByWorkspace, generalTasks, activeWorkspaceId, activeTaskId, chatsSelected, librarySelected, creatingProject, loadError, user, onNewTask, onCreateProject, onCancelProject, onSubmitProject, onSelectWorkspace, onSelectChats, onOpenTask, onToggleConversationPinned, onArchiveConversation, onDeleteConversation, onRenameConversation, onShareConversation, onToggleProjectPinned, onRenameProject, onArchiveProjectChats, onRemoveProject, onRevealProject, onSkills, onLibrary, onSettings, onSignOut }: {
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
  onCreateProject: () => void;
  onCancelProject: () => void;
  onSubmitProject: (event: React.FormEvent<HTMLFormElement>) => void;
  onSelectWorkspace: (id: string) => void;
  onSelectChats: () => void;
  onOpenTask: (id: string) => void;
  onToggleConversationPinned: (task: Task) => void | Promise<void>;
  onArchiveConversation: (task: Task) => void | Promise<void>;
  onDeleteConversation: (task: Task) => void | Promise<void>;
  onRenameConversation: (task: Task) => void | Promise<void>;
  onShareConversation: (task: Task) => void | Promise<void>;
  onToggleProjectPinned: (workspace: Workspace) => void | Promise<void>;
  onRenameProject: (workspace: Workspace, name: string) => void | Promise<void>;
  onArchiveProjectChats: (workspace: Workspace, tasks: Task[]) => void | Promise<void>;
  onRemoveProject: (workspace: Workspace) => void | Promise<void>;
  onRevealProject: (workspace: Workspace) => void | Promise<void>;
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
        onToggleConversationPinned={onToggleConversationPinned}
        onArchiveConversation={onArchiveConversation}
        onDeleteConversation={onDeleteConversation}
        onRenameConversation={onRenameConversation}
        onShareConversation={onShareConversation}
        onCreateProject={onCreateProject}
        onAfterNavigate={() => { if (isMobile) setOpenMobile(false); }}
        formatAge={timeAgo}
        renderProjectAction={(workspace) => <WebProjectRowActions workspace={workspace} tasks={tasksByWorkspace[workspace.id] ?? []} onTogglePinned={onToggleProjectPinned} onRename={onRenameProject} onArchiveChats={onArchiveProjectChats} onRemove={onRemoveProject} onReveal={onRevealProject} />}
        commands={(
          <>
            <SidebarMenu className="berry-sidebar-commands">
              <SidebarMenuItem><SidebarMenuButton onClick={onNewTask} className="berry-sidebar-command berry-sidebar-command-primary font-medium"><PencilEdit02Icon /><span>New chat</span><Kbd className="ml-auto" aria-hidden>⌘N</Kbd></SidebarMenuButton></SidebarMenuItem>
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

function WebProjectRowActions({ workspace, tasks, onTogglePinned, onRename, onArchiveChats, onRemove, onReveal }: {
  workspace: Workspace;
  tasks: Task[];
  onTogglePinned: (workspace: Workspace) => void | Promise<void>;
  onRename: (workspace: Workspace, name: string) => void | Promise<void>;
  onArchiveChats: (workspace: Workspace, tasks: Task[]) => void | Promise<void>;
  onRemove: (workspace: Workspace) => void | Promise<void>;
  onReveal: (workspace: Workspace) => void | Promise<void>;
}) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(workspace.name);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);

  React.useEffect(() => setRenameValue(workspace.name), [workspace.name]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction type="button" className="berry-sidebar-workspace-action berry-sidebar-workspace-menu-action" aria-label={`Actions for ${workspace.name}`} title="Project actions" onClick={(event) => event.stopPropagation()}>
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="berry-chat-actions-menu">
          <DropdownMenuItem onSelect={() => void onTogglePinned(workspace)}>{workspace.pinned ? <PinOff /> : <Pin />}{workspace.pinned ? "Unpin project" : "Pin project"}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onReveal(workspace)}><FolderOpen />Reveal in Finder</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setRenameValue(workspace.name); setRenameOpen(true); }}><Pencil />Rename project</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={tasks.length === 0} onSelect={() => setArchiveOpen(true)}><Archive />Archive chats</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}><Trash2 />Remove</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename project</DialogTitle><DialogDescription>Only the project name in Berry will change.</DialogDescription></DialogHeader>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameValue.trim()) { void onRename(workspace, renameValue.trim()); setRenameOpen(false); } }} aria-label="Project name" autoFocus />
          <DialogFooter><DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose><Button disabled={!renameValue.trim()} onClick={() => { void onRename(workspace, renameValue.trim()); setRenameOpen(false); }}>Rename</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive chats in {workspace.name}?</AlertDialogTitle><AlertDialogDescription>This archives {tasks.length} chat{tasks.length === 1 ? "" : "s"}. Archived chats remain recoverable.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void onArchiveChats(workspace, tasks)}>Archive chats</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {workspace.name}?</AlertDialogTitle><AlertDialogDescription>This removes the project and its chats from Berry. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void onRemove(workspace)}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </>
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
