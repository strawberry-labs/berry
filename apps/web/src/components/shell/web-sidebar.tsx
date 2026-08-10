import * as React from "react";
import { DollarSign, LogOut } from "lucide-react";
import type { AllowanceBalance, OrgPermission, Task, Workspace } from "@berry/shared";
import { BerryConversationSidebarContent } from "@berry/desktop-ui/components/berry-conversation-sidebar";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@berry/desktop-ui/components/ui/avatar";
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
import { Popover, PopoverContent, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";
import { Progress } from "@berry/desktop-ui/components/ui/progress";
import {
  Sidebar,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@berry/desktop-ui/components/ui/sidebar";
import { Archive, ArrowUp as Upload, CirclePlus, Ellipsis, FolderOpen, LayoutAlignLeft, Pencil, PencilEdit02Icon, Pin, PinOff, Search, Settings as SettingsIcon, Trash2, Wand2 } from "@berry/desktop-ui/lib/icons";
import type { SignedInUser } from "./auth-boundary";
import type { ManagementKind } from "../management/management-navigation";
import { WebSettingsNavigation } from "./web-settings-navigation";
import { DeploymentBrandLogo, useDeploymentBrand } from "./deployment-brand";

const ProjectUploadDialog = React.lazy(() => import("../projects/project-upload-dialog").then((module) => ({ default: module.ProjectUploadDialog })));

export type SettingsTab = "general" | "account" | "personalization" | "connectors" | "mcp" | "skills" | "usage" | "archived";

export const WEB_SETTINGS_NAV: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "account", label: "Account" },
  { id: "personalization", label: "Personalization" },
  { id: "connectors", label: "Connectors" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "usage", label: "Usage" },
  { id: "archived", label: "Archived chats" },
];

export function WebWindowChrome({ onHome, onSearch }: {
  onHome: () => void;
  onSearch: () => void;
}) {
  const { isMobile, state, toggleSidebar } = useSidebar();
  const brand = useDeploymentBrand();
  const sidebarCollapsed = state === "collapsed";
  const homeControlOpensSidebar = isMobile || sidebarCollapsed;

  return (
    <div
      className="berry-web-window-chrome pointer-events-none absolute top-0 left-0 z-50 flex h-[var(--berry-titlebar-height)] items-center"
      data-sidebar-state={state}
    >
      <div className="berry-web-window-header pointer-events-auto flex w-full items-center justify-between">
        <button
          type="button"
          className="berry-web-home-link"
          onClick={homeControlOpensSidebar ? toggleSidebar : onHome}
          aria-label={homeControlOpensSidebar ? "Open sidebar" : `${brand.applicationName} home`}
          title={homeControlOpensSidebar ? "Open sidebar" : undefined}
        >
          <DeploymentBrandLogo className="berry-web-home-logo size-5" alt="" />
          <LayoutAlignLeft className="berry-web-sidebar-expand-icon" aria-hidden="true" />
          <span className="berry-web-home-label">{brand.applicationName}</span>
        </button>
        <div className="berry-web-window-actions flex items-center">
          {!sidebarCollapsed ? <Button variant="ghost" size="icon-lg" onClick={onSearch} aria-label="Search" title="Search" data-web-search-trigger className="berry-web-header-icon"><Search /></Button> : null}
          {!sidebarCollapsed ? <SidebarTrigger aria-label="Toggle sidebar" title="Toggle sidebar" className="berry-web-header-icon berry-web-sidebar-toggle" /> : null}
        </div>
      </div>
    </div>
  );
}

export function WebSidebar({ workspaces, tasksByWorkspace, generalTasks, activeWorkspaceId, activeTaskId, chatsSelected, librarySelected, management, loadError, user, allowance, allowanceLoading, onRefreshAllowance, onNewTask, onCreateProject, onSelectWorkspace, onSelectChats, onOpenTask, onToggleConversationPinned, onArchiveConversation, onDeleteConversation, onRenameConversation, onShareConversation, onToggleProjectPinned, onRenameProject, onArchiveProjectChats, onRemoveProject, onRevealProject, onUploadToProject, onSkills, onLibrary, onUsage, onSettings, onSignOut }: {
  workspaces: Workspace[];
  tasksByWorkspace: Record<string, Task[]>;
  generalTasks: Task[];
  activeWorkspaceId: string;
  activeTaskId: string | null;
  chatsSelected: boolean;
  librarySelected: boolean;
  management: {
    kind: ManagementKind;
    tab: string;
    permissions: OrgPermission[];
    platformAuthorized: boolean;
    onNavigate: (kind: ManagementKind, tab: string) => void;
    onBack: () => void;
  } | null;
  loadError: string;
  user: SignedInUser | null;
  allowance: AllowanceBalance | null;
  allowanceLoading: boolean;
  onRefreshAllowance: () => void;
  onNewTask: () => void;
  onCreateProject: () => void;
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
  onUploadToProject: (workspace: Workspace, file: File, onProgress: (ratio: number) => void) => Promise<void>;
  onSkills: () => void;
  onLibrary: () => void;
  onUsage: () => void;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const allTasks = [...Object.values(tasksByWorkspace).flat(), ...generalTasks];
  return (
    <Sidebar variant="inset" className="berry-app-sidebar">
      {management ? (
        <WebSettingsNavigation {...management} />
      ) : <BerryConversationSidebarContent
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
        onNewProjectConversation={(workspace) => onSelectWorkspace(workspace.id)}
        onAfterNavigate={() => { if (isMobile) setOpenMobile(false); }}
        formatAge={timeAgo}
        renderProjectAction={(workspace) => <WebProjectRowActions workspace={workspace} tasks={tasksByWorkspace[workspace.id] ?? []} onTogglePinned={onToggleProjectPinned} onRename={onRenameProject} onArchiveChats={onArchiveProjectChats} onRemove={onRemoveProject} onReveal={onRevealProject} onUpload={onUploadToProject} />}
        commands={(
          <>
            <SidebarMenu className="berry-sidebar-commands">
              <SidebarMenuItem><SidebarMenuButton onClick={onNewTask} className="berry-sidebar-command berry-sidebar-command-primary font-medium"><PencilEdit02Icon /><span>New chat</span><Kbd className="ml-auto" aria-hidden>⌘⇧O</Kbd></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton aria-label="Open capabilities" onClick={onSkills} className="berry-sidebar-command"><Wand2 /><span>Skills</span></SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton isActive={librarySelected} aria-label="Open library" onClick={onLibrary} className="berry-sidebar-command"><FolderOpen /><span>Library</span></SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
          </>
        )}
      />}
      <SidebarFooter className="berry-sidebar-footer">
        <div className="flex items-center gap-2">
          <Popover onOpenChange={(open) => { if (open) onRefreshAllowance(); }}>
            <PopoverTrigger asChild>
              <button type="button" className="berry-connect-button flex h-11 min-w-0 flex-1 items-center gap-3 px-2 text-left" aria-label="Open account and allowance">
                <Avatar size="sm" className="berry-connect-avatar">
                  {user?.image ? <AvatarImage src={user.image} alt="" className="object-cover" /> : null}
                  <AvatarFallback className="bg-[var(--berry-accent-soft)] font-semibold text-[var(--berry-text-primary)]">{accountAvatarInitial(user)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 truncate text-sm font-semibold">{user?.name || user?.email || "Berry Cloud"}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={8} className="w-60 max-w-[calc(100vw-1rem)] p-3">
              <div className="grid gap-3">
                <div className="min-w-0">
                  <strong className="block truncate text-sm">{user?.name || "Berry account"}</strong>
                  <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
                </div>
                <div className="grid gap-2 rounded-lg border border-[var(--berry-border)] bg-[var(--berry-control-bg)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-[var(--berry-text-secondary)]">Available this cycle</span>
                    <strong className="text-sm tabular-nums text-[var(--berry-text-primary)]">{allowanceLoading ? "…" : allowance?.availableMicros === null ? "Unlimited" : formatCurrencyMicros(allowance?.availableMicros)}</strong>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-[var(--berry-text-secondary)]">Used</span>
                    <strong className="text-sm tabular-nums text-[var(--berry-text-primary)]">{allowanceLoading ? "…" : formatCurrencyMicros(allowance ? String(BigInt(allowance.usedMicros) + BigInt(allowance.reservedMicros)) : null)}</strong>
                  </div>
                  {allowance?.effectiveLimitMicros ? (
                    <div className="grid gap-1.5">
                      <div className="flex items-center justify-between text-[11px] text-[var(--berry-text-secondary)]">
                        <span>Cycle usage</span>
                        <span className="tabular-nums">{Math.round(allowanceProgress(allowance))}%</span>
                      </div>
                      <Progress value={allowanceProgress(allowance)} aria-label={`${Math.round(allowanceProgress(allowance))}% of allowance used`} />
                    </div>
                  ) : null}
                  <span className="text-[11px] text-[var(--berry-text-secondary)]">{allowance ? `Resets ${formatAllowanceResetDate(allowance.cycleEnd)}` : "Allowance information is unavailable."}</span>
                </div>
                <Button variant="ghost" className="justify-start" onClick={onUsage}>
                  <DollarSign />
                  View personal usage
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="icon-lg" onClick={onSettings} aria-label="Settings" aria-current={management ? "page" : undefined} data-active={management ? "true" : undefined} className="berry-sidebar-mini-control berry-sidebar-footer-control"><SettingsIcon /></Button>
          {user ? <Button variant="ghost" size="icon-sm" onClick={onSignOut} aria-label="Sign out" className="berry-sidebar-mini-control"><LogOut size={15} /></Button> : null}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function formatCurrencyMicros(value: string | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) / 1_000_000);
}

export function allowanceProgress(allowance: AllowanceBalance): number {
  if (!allowance.effectiveLimitMicros || allowance.effectiveLimitMicros === "0") return 0;
  const consumed = Number(allowance.usedMicros) + Number(allowance.reservedMicros);
  return Math.min(100, (consumed / Number(allowance.effectiveLimitMicros)) * 100);
}

export function accountAvatarInitial(user: Pick<SignedInUser, "name" | "email"> | null): string {
  return (user?.name?.trim()[0] || user?.email?.trim()[0] || "?").toUpperCase();
}

export function formatAllowanceResetDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function WebProjectRowActions({ workspace, tasks, onTogglePinned, onRename, onArchiveChats, onRemove, onReveal, onUpload }: {
  workspace: Workspace;
  tasks: Task[];
  onTogglePinned: (workspace: Workspace) => void | Promise<void>;
  onRename: (workspace: Workspace, name: string) => void | Promise<void>;
  onArchiveChats: (workspace: Workspace, tasks: Task[]) => void | Promise<void>;
  onRemove: (workspace: Workspace) => void | Promise<void>;
  onReveal: (workspace: Workspace) => void | Promise<void>;
  onUpload: (workspace: Workspace, file: File, onProgress: (ratio: number) => void) => Promise<void>;
}) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(workspace.name);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);

  React.useEffect(() => setRenameValue(workspace.name), [workspace.name]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction type="button" className="berry-sidebar-workspace-action berry-sidebar-workspace-menu-action md:opacity-0 peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100" aria-label={`Actions for ${workspace.name}`} title="Project actions" onClick={(event) => event.stopPropagation()}>
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="berry-chat-actions-menu">
          <DropdownMenuItem onSelect={() => void onTogglePinned(workspace)}>{workspace.pinned ? <PinOff /> : <Pin />}{workspace.pinned ? "Unpin project" : "Pin project"}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onReveal(workspace)}><FolderOpen />Reveal in Finder</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setUploadOpen(true)}><Upload />Upload to project</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setRenameValue(workspace.name); setRenameOpen(true); }}><Pencil />Rename project</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={tasks.length === 0} onSelect={() => setArchiveOpen(true)}><Archive />Archive chats</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}><Trash2 />Remove</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {uploadOpen ? <React.Suspense fallback={null}><ProjectUploadDialog open workspace={workspace} onOpenChange={setUploadOpen} onUpload={onUpload} /></React.Suspense> : null}

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
