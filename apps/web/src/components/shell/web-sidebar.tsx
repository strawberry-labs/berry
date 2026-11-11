import * as React from "react";
import { CalendarClock, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import type { AllowanceBalance, OrgPermission, Task, Workspace } from "@berry/shared";
import { BerryConversationSidebarContent, taskHasUnreadActivity, taskIsInProgress } from "@berry/desktop-ui/components/berry-conversation-sidebar";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import type { SupportViewSubject } from "@/lib/support-view";
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
import { Archive, ArrowUp as Upload, CirclePlus, Ellipsis, FolderOpen, LayoutAlignLeft, Pencil, PencilEdit02Icon, Pin, PinOff, Search, Settings as SettingsIcon, Trash2, Wand2, X } from "@berry/desktop-ui/lib/icons";
import type { SignedInUser } from "./auth-boundary";
import type { ManagementKind } from "../management/management-navigation";
import { WebSettingsNavigation } from "./web-settings-navigation";
import { DeploymentBrandLogo, useDeploymentBrand } from "./deployment-brand";
import { accountAvatarInitial, allowanceProgress, formatAllowanceResetDate, formatCurrencyMicros, timeAgo } from "@berry/client-core/format";

export { accountAvatarInitial, allowanceProgress, formatAllowanceResetDate };

const ProjectUploadDialog = React.lazy(() => import("../projects/project-upload-dialog").then((module) => ({ default: module.ProjectUploadDialog })));

export type SettingsTab = "general" | "account" | "personalization" | "connectors" | "mcp" | "skills" | "schedules" | "usage" | "archived";

export { taskHasUnreadActivity, taskIsInProgress };

export const WEB_SETTINGS_NAV: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "account", label: "Account" },
  { id: "personalization", label: "Personalization" },
  { id: "connectors", label: "Connectors" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "schedules", label: "Automations" },
  { id: "usage", label: "Usage" },
  { id: "archived", label: "Archived tasks" },
];

export function WebWindowChrome({ onHome, onSearch }: {
  onHome: () => void;
  onSearch: () => void;
}) {
  const { state, toggleSidebar } = useSidebar();
  const brand = useDeploymentBrand();
  const sidebarCollapsed = state === "collapsed";

  // Phone and desktop controls are both rendered and switched by the 767px
  // media query so the server render already has the right layout. Phones get
  // the toggle alone on the left; the brand lives in the open sidebar sheet.
  return (
    <div
      className="berry-web-window-chrome pointer-events-none absolute top-0 left-0 z-50 flex h-[var(--berry-titlebar-height)] items-center"
      data-sidebar-state={state}
    >
      <div className="berry-web-window-header pointer-events-auto flex w-full items-center justify-between">
        <SidebarTrigger aria-label="Open sidebar" title="Open sidebar" className="berry-web-header-icon berry-web-mobile-sidebar-toggle" />
        <button
          type="button"
          className="berry-web-home-link"
          onClick={sidebarCollapsed ? toggleSidebar : onHome}
          aria-label={sidebarCollapsed ? "Open sidebar" : `${brand.applicationName} home`}
          title={sidebarCollapsed ? "Open sidebar" : undefined}
        >
          <DeploymentBrandLogo className="berry-web-home-logo size-5" alt="" />
          <LayoutAlignLeft className="berry-web-sidebar-expand-icon" aria-hidden="true" />
          <span className="berry-web-home-label">{brand.applicationName}</span>
        </button>
        <div className="berry-web-window-actions flex items-center">
          <Button variant="ghost" size="icon-lg" onClick={onSearch} aria-label="Search" title="Search" data-web-search-trigger className="berry-web-header-icon"><Search /></Button>
          {!sidebarCollapsed ? <SidebarTrigger aria-label="Toggle sidebar" title="Toggle sidebar" className="berry-web-header-icon berry-web-sidebar-toggle" /> : null}
        </div>
      </div>
    </div>
  );
}

function WebSidebarSheetHeader({ onSearch }: { onSearch: () => void }) {
  const { mobileTriggerRef, setOpenMobile } = useSidebar();
  const brand = useDeploymentBrand();
  return (
    <div className="berry-web-sheet-header flex shrink-0 items-center justify-between">
      <div className="berry-web-sheet-brand flex min-w-0 items-center">
        <DeploymentBrandLogo className="size-5 shrink-0" alt="" />
        <span className="truncate">{brand.applicationName}</span>
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Search"
          title="Search"
          className="berry-web-header-icon"
          onClick={() => {
            // Search takes focus next; don't let the closing sheet hand it back to the toggle.
            mobileTriggerRef.current = null;
            setOpenMobile(false);
            onSearch();
          }}
        >
          <Search />
        </Button>
        <Button variant="ghost" size="icon-lg" aria-label="Close sidebar" title="Close sidebar" className="berry-web-header-icon" onClick={() => setOpenMobile(false)}>
          <X />
        </Button>
      </div>
    </div>
  );
}

export function WebSidebar({ workspaces, tasksByWorkspace, generalTasks, activeWorkspaceId, activeTaskId, tasksSelected, librarySelected, management, loadError, user, allowance, allowanceLoading, onRefreshAllowance, onNewTask, onCreateProject, onSelectWorkspace, onSelectTasks, onOpenTask, onToggleTaskPinned, onArchiveTask, onDeleteTask, onRenameTask, onShareTask, onToggleProjectPinned, onRenameProject, onArchiveProjectTasks, onRemoveProject, onRevealProject, onUploadToProject, onSkills, onLibrary, onSchedules, onUsage, onSettings, onSearch, onOpenMobileApp, onSignOut, supportView = null, onExitSupportView, readOnly = false }: {
  workspaces: Workspace[];
  tasksByWorkspace: Record<string, Task[]>;
  generalTasks: Task[];
  activeWorkspaceId: string;
  activeTaskId: string | null;
  tasksSelected: boolean;
  librarySelected: boolean;
  management: {
    kind: ManagementKind;
    tab: string;
    permissions: OrgPermission[];
    platformAuthorized: boolean;
    supportView?: boolean;
    onNavigate: (kind: ManagementKind, tab: string) => void;
    onBack: () => void;
  } | null;
  loadError: string;
  user: SignedInUser | null;
  allowance: AllowanceBalance | null;
  allowanceLoading: boolean;
  supportView?: SupportViewSubject | null;
  onExitSupportView?: () => void;
  onRefreshAllowance: () => void;
  onNewTask: () => void;
  onCreateProject: () => void;
  onSelectWorkspace: (id: string) => void;
  onSelectTasks: () => void;
  onOpenTask: (id: string) => void;
  onToggleTaskPinned: (task: Task) => void | Promise<void>;
  onArchiveTask: (task: Task) => void | Promise<void>;
  onDeleteTask: (task: Task) => void | Promise<void>;
  onRenameTask: (task: Task) => void | Promise<void>;
  onShareTask: (task: Task) => void | Promise<void>;
  onToggleProjectPinned: (workspace: Workspace) => void | Promise<void>;
  onRenameProject: (workspace: Workspace, name: string) => void | Promise<void>;
  onArchiveProjectTasks: (workspace: Workspace, tasks: Task[]) => void | Promise<void>;
  onRemoveProject: (workspace: Workspace) => void | Promise<void>;
  onRevealProject: (workspace: Workspace) => void | Promise<void>;
  onUploadToProject: (workspace: Workspace, file: File, onProgress: (ratio: number) => void) => Promise<void>;
  onSkills: () => void;
  onLibrary: () => void;
  onSchedules: () => void;
  onUsage: () => void;
  onSettings: () => void;
  onSearch: () => void;
  /** Opens the QR sign-in dialog for the mobile app; omitted where pairing isn't offered. */
  onOpenMobileApp?: () => void;
  onSignOut: () => void;
  readOnly?: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const allTasks = [...Object.values(tasksByWorkspace).flat(), ...generalTasks];
  return (
    <Sidebar variant="inset" className="berry-app-sidebar" mobileClassName="berry-app-sidebar berry-web-sidebar-sheet">
      {isMobile ? <WebSidebarSheetHeader onSearch={onSearch} /> : null}
      {management ? (
        <WebSettingsNavigation
          {...management}
          onNavigate={(kind, tab) => {
            management.onNavigate(kind, tab);
            if (isMobile) setOpenMobile(false);
          }}
        />
      ) : <BerryConversationSidebarContent
        showKindControl={false}
        pinnedConversations={allTasks.filter((task) => task.pinned)}
        projects={workspaces.map((workspace) => ({ workspace, conversations: tasksByWorkspace[workspace.id] ?? [] }))}
        generalConversations={generalTasks}
        chatsSelected={tasksSelected}
        activeWorkspaceId={activeWorkspaceId}
        activeConversationId={activeTaskId}
        projectsError={loadError || null}
        onKindChange={() => {}}
        onSelectProject={onSelectWorkspace}
        onSelectChats={onSelectTasks}
        onOpenConversation={onOpenTask}
        {...(!readOnly ? {
          onToggleConversationPinned: onToggleTaskPinned,
          onArchiveConversation: onArchiveTask,
          onDeleteConversation: onDeleteTask,
          onRenameConversation: onRenameTask,
          onShareConversation: onShareTask,
          onCreateProject,
          onNewProjectConversation: (workspace: Workspace) => onSelectWorkspace(workspace.id),
          renderProjectAction: (workspace: Workspace) => <WebProjectRowActions workspace={workspace} tasks={tasksByWorkspace[workspace.id] ?? []} onTogglePinned={onToggleProjectPinned} onRename={onRenameProject} onArchiveTasks={onArchiveProjectTasks} onRemove={onRemoveProject} onReveal={onRevealProject} onUpload={onUploadToProject} />,
        } : {})}
        onAfterNavigate={() => { if (isMobile) setOpenMobile(false); }}
        formatAge={timeAgo}
        commands={(
          <>
            <SidebarMenu className="berry-sidebar-commands">
              {!readOnly ? <SidebarMenuItem><SidebarMenuButton onClick={onNewTask} className="berry-sidebar-command berry-sidebar-command-primary font-medium"><PencilEdit02Icon /><span>New task</span><Kbd className="ml-auto" aria-hidden>⌘⇧O</Kbd></SidebarMenuButton></SidebarMenuItem> : null}
              {!readOnly ? <SidebarMenuItem><SidebarMenuButton aria-label="Open capabilities" onClick={onSkills} className="berry-sidebar-command"><Wand2 /><span>Skills</span></SidebarMenuButton></SidebarMenuItem> : null}
              {!readOnly ? <SidebarMenuItem><SidebarMenuButton isActive={librarySelected} aria-label="Open library" onClick={onLibrary} className="berry-sidebar-command"><FolderOpen /><span>Library</span></SidebarMenuButton></SidebarMenuItem> : null}
              {!readOnly ? <SidebarMenuItem><SidebarMenuButton aria-label="Open automations" onClick={onSchedules} className="berry-sidebar-command"><CalendarClock /><span>Automations</span></SidebarMenuButton></SidebarMenuItem> : null}
            </SidebarMenu>
          </>
        )}
      />}
      <SidebarFooter className="berry-sidebar-footer">
        {onOpenMobileApp && !readOnly ? (
          <SidebarMenu className="berry-sidebar-mobile-app">
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onOpenMobileApp} className="berry-sidebar-command">
                <Smartphone />
                <span>Get the mobile app</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        {supportView && onExitSupportView ? <SupportViewCard subject={supportView} onExit={onExitSupportView} /> : null}
        <SidebarAllowance allowance={allowance} loading={allowanceLoading} onRefresh={onRefreshAllowance} onUsage={onUsage} />
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="berry-connect-button flex h-11 min-w-0 flex-1 items-center gap-3 px-2 text-left" aria-label="Open account">
                <Avatar size="sm" className="berry-connect-avatar">
                  {user?.image ? <AvatarImage src={user.image} alt="" className="object-cover" /> : null}
                  <AvatarFallback className="bg-[var(--berry-accent-soft)] font-semibold text-[var(--berry-text-primary)]">{accountAvatarInitial(user)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 truncate text-sm font-semibold">{user?.name || user?.email || "Berry Cloud"}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={8} className="w-60 max-w-[calc(100vw-1rem)] p-3">
              <strong className="block truncate text-sm">{user?.name || "Berry account"}</strong>
              <span className="block truncate text-xs text-[var(--berry-text-secondary)]">{user?.email}</span>
            </PopoverContent>
          </Popover>
          {!readOnly ? <Button variant="ghost" size="icon-lg" onClick={onSettings} aria-label="Settings" aria-current={management ? "page" : undefined} data-active={management ? "true" : undefined} className="berry-sidebar-mini-control berry-sidebar-footer-control"><SettingsIcon /></Button> : null}
          {user && !readOnly ? <Button variant="ghost" size="icon-sm" onClick={onSignOut} aria-label="Sign out" className="berry-sidebar-mini-control"><LogOut size={15} /></Button> : null}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function SupportViewCard({ subject, onExit }: { subject: SupportViewSubject; onExit: () => void }) {
  return <section className="berry-support-view-card" aria-label="Support view" data-testid="support-view-card">
    <div className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck className="size-3.5 shrink-0" aria-hidden /><span>Support view</span></div>
    <p className="truncate text-xs" title={subject.name || subject.email}>Viewing as {subject.name || subject.email}</p>
    <p className="text-xs leading-4 text-[var(--berry-text-secondary)]">Changes apply to this member’s account.</p>
    <Button variant="outline" size="sm" className="mt-1 w-full" onClick={onExit}>Exit support view</Button>
  </section>;
}

export function SupportViewFallback({ subject, onExit }: { subject: SupportViewSubject; onExit: () => void }) {
  const { state, isMobile, openMobile } = useSidebar();
  if (isMobile ? openMobile : state !== "collapsed") return null;
  return <div className="berry-support-view-fallback">
    <Button variant="outline" size="sm" onClick={onExit} title={`Viewing as ${subject.name || subject.email}. Exit support view`}>
      <ShieldCheck aria-hidden />Exit support view
    </Button>
  </div>;
}

const SIDEBAR_ALLOWANCE_WARNING_PERCENT = 10;

function SidebarAllowance({ allowance, loading, onRefresh, onUsage }: {
  allowance: AllowanceBalance | null;
  loading: boolean;
  onRefresh: () => void;
  onUsage: () => void;
}) {
  const remaining = allowance && allowance.effectiveLimitMicros !== null
    ? allowance.effectiveLimitMicros === "0" ? 0 : Math.max(0, Math.min(100, 100 - allowanceProgress(allowance)))
    : null;
  // Only surface the allowance when it is nearly spent. A constant meter
  // reads as pressure; the full figures stay on the Usage settings page.
  if (remaining === null || remaining > SIDEBAR_ALLOWANCE_WARNING_PERCENT) return null;
  const label = `${Math.floor(remaining)}% left`;
  return <TooltipProvider delayDuration={250}><Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className="berry-sidebar-allowance" aria-label={`Monthly usage: ${label}. View usage details`} aria-busy={loading} onPointerEnter={onRefresh} onFocus={onRefresh} onClick={onUsage} data-testid="sidebar-allowance">
        <span className="flex items-center justify-between gap-2 text-xs"><span className="text-[var(--berry-text-secondary)]">Monthly usage</span><span className="font-medium tabular-nums">{label}</span></span>
        {remaining !== null ? <Progress value={remaining} className="h-1" aria-label="Monthly allowance remaining" /> : null}
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" align="start" sideOffset={8} collisionPadding={12} showArrow={false} className="berry-sidebar-allowance-details">
      <p className="text-xs font-semibold">Monthly allowance</p>
      {allowance ? <>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-xs">
          <dt>Remaining</dt><dd className="text-right font-medium tabular-nums">{allowance.availableMicros === null ? "Unlimited" : formatCurrencyMicros(allowance.availableMicros)}</dd>
          <dt>Used</dt><dd className="text-right tabular-nums">{formatCurrencyMicros(allowance.usedMicros)}</dd>
          <dt>In progress</dt><dd className="text-right tabular-nums">{formatCurrencyMicros(allowance.reservedMicros)}</dd>
          <dt>Monthly limit</dt><dd className="text-right tabular-nums">{allowance.effectiveLimitMicros === null ? "Unlimited" : formatCurrencyMicros(allowance.effectiveLimitMicros)}</dd>
        </dl>
        <p className="text-xs text-[var(--berry-text-secondary)]">Resets {formatAllowanceResetDate(allowance.cycleEnd)}</p>
      </> : <p className="text-xs text-[var(--berry-text-secondary)]">{loading ? "Loading allowance…" : "Allowance information is unavailable. Click to open usage details."}</p>}
    </TooltipContent>
  </Tooltip></TooltipProvider>;
}

function WebProjectRowActions({ workspace, tasks, onTogglePinned, onRename, onArchiveTasks, onRemove, onReveal, onUpload }: {
  workspace: Workspace;
  tasks: Task[];
  onTogglePinned: (workspace: Workspace) => void | Promise<void>;
  onRename: (workspace: Workspace, name: string) => void | Promise<void>;
  onArchiveTasks: (workspace: Workspace, tasks: Task[]) => void | Promise<void>;
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
          <DropdownMenuItem disabled={tasks.length === 0} onSelect={() => setArchiveOpen(true)}><Archive />Archive tasks</DropdownMenuItem>
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
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive tasks in {workspace.name}?</AlertDialogTitle><AlertDialogDescription>This archives {tasks.length} task{tasks.length === 1 ? "" : "s"}. Archived tasks remain recoverable.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => void onArchiveTasks(workspace, tasks)}>Archive tasks</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {workspace.name}?</AlertDialogTitle><AlertDialogDescription>This removes the project and its tasks from Berry. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void onRemove(workspace)}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </>
  );
}
