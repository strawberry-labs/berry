import * as React from "react";
import type { ConversationKind, Task, Workspace } from "@berry/shared";
import { AnimatedCollapse } from "@berry/desktop-ui/components/animated-collapse";
import {
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@berry/desktop-ui/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Archive, ChevronDown, CodeXml, Ellipsis, Folder, Folder02, ListCollapse, MessageSquare, Pencil, PencilEdit02Icon, Pin, PinOff, Plus, Trash2, Users } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";

const INITIAL_CONVERSATION_COUNT = 5;

export interface BerryConversationProject {
  workspace: Workspace;
  conversations: Task[];
  loading?: boolean;
  error?: string | null;
}

export interface BerryConversationSidebarContentProps {
  selectedKind: ConversationKind;
  showKindControl?: boolean;
  pinnedConversations: Task[];
  projects: BerryConversationProject[];
  generalConversations: Task[];
  activeWorkspaceId: string | null;
  activeConversationId: string | null;
  commands?: React.ReactNode;
  projectsLoading?: boolean;
  projectsError?: string | null;
  chatsLoading?: boolean;
  chatsError?: string | null;
  onKindChange: (kind: ConversationKind) => void | Promise<void>;
  onSelectProject?: (workspaceId: string) => void;
  chatsSelected?: boolean;
  onSelectChats?: () => void;
  onOpenConversation: (taskId: string) => void;
  onAfterNavigate?: () => void;
  formatAge: (iso: string) => string;
  renderProjectAction?: (workspace: Workspace) => React.ReactNode;
  onNewProjectConversation?: (workspace: Workspace) => void;
  onCreateProject?: () => void;
  onToggleConversationPinned?: (task: Task) => void | Promise<void>;
  onArchiveConversation?: (task: Task) => void | Promise<void>;
  onDeleteConversation?: (task: Task) => void | Promise<void>;
  onRenameConversation?: (task: Task) => void | Promise<void>;
  onShareConversation?: (task: Task) => void | Promise<void>;
}

export interface ConversationSectionState {
  collapsedProjects: ReadonlySet<string>;
  expandedProjects: ReadonlySet<string>;
  chatsCollapsed: boolean;
  chatsExpanded: boolean;
  allCollapsed: boolean;
}

export type ConversationSectionAction =
  | { type: "toggle-project"; projectId: string }
  | { type: "show-project"; projectId: string }
  | { type: "toggle-chats" }
  | { type: "show-chats" }
  | { type: "toggle-all"; projectIds: string[] };

export const INITIAL_CONVERSATION_SECTION_STATE: ConversationSectionState = {
  collapsedProjects: new Set(),
  expandedProjects: new Set(),
  chatsCollapsed: false,
  chatsExpanded: false,
  allCollapsed: false,
};

export function conversationSectionReducer(state: ConversationSectionState, action: ConversationSectionAction): ConversationSectionState {
  if (action.type === "toggle-project") {
    const collapsedProjects = new Set(state.collapsedProjects);
    const expandedProjects = new Set(state.expandedProjects);
    if (collapsedProjects.has(action.projectId)) collapsedProjects.delete(action.projectId);
    else {
      collapsedProjects.add(action.projectId);
      expandedProjects.delete(action.projectId);
    }
    return { ...state, collapsedProjects, expandedProjects, allCollapsed: false };
  }
  if (action.type === "show-project") {
    return { ...state, expandedProjects: new Set([...state.expandedProjects, action.projectId]) };
  }
  if (action.type === "toggle-chats") {
    return { ...state, chatsCollapsed: !state.chatsCollapsed, chatsExpanded: false, allCollapsed: false };
  }
  if (action.type === "show-chats") return { ...state, chatsExpanded: true };
  const nextCollapsed = !state.allCollapsed;
  return {
    collapsedProjects: nextCollapsed ? new Set(action.projectIds) : new Set(),
    expandedProjects: new Set(),
    chatsCollapsed: nextCollapsed,
    chatsExpanded: false,
    allCollapsed: nextCollapsed,
  };
}

export function conversationsForKind(tasks: Task[], kind: ConversationKind, excludedIds: ReadonlySet<string> = new Set()): Task[] {
  return tasks
    .filter((task) => task.conversationKind === kind && !excludedIds.has(task.id))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

export function visibleConversationSlice(tasks: Task[], expanded: boolean): { visible: Task[]; hiddenCount: number } {
  if (expanded || tasks.length <= INITIAL_CONVERSATION_COUNT) return { visible: tasks, hiddenCount: 0 };
  return { visible: tasks.slice(0, INITIAL_CONVERSATION_COUNT), hiddenCount: tasks.length - INITIAL_CONVERSATION_COUNT };
}

export function BerryConversationSidebarContent(props: BerryConversationSidebarContentProps) {
  const [sectionState, dispatch] = React.useReducer(conversationSectionReducer, INITIAL_CONVERSATION_SECTION_STATE);
  const [optimisticKind, setOptimisticKind] = React.useState(props.selectedKind);
  const [pendingKind, setPendingKind] = React.useState<ConversationKind | null>(null);
  const [failedKind, setFailedKind] = React.useState<ConversationKind | null>(null);
  const [kindError, setKindError] = React.useState<string | null>(null);
  const [projectSort, setProjectSort] = React.useState<"priority" | "last-updated" | "manual">("last-updated");

  React.useEffect(() => {
    if (!pendingKind) setOptimisticKind(props.selectedKind);
  }, [pendingKind, props.selectedKind]);

  const selectKind = React.useCallback(async (kind: ConversationKind) => {
    if (pendingKind || kind === optimisticKind) return;
    setOptimisticKind(kind);
    setPendingKind(kind);
    setFailedKind(null);
    setKindError(null);
    try {
      await props.onKindChange(kind);
    } catch (error) {
      setOptimisticKind(props.selectedKind);
      setFailedKind(kind);
      setKindError(error instanceof Error ? error.message : "Unable to change conversation type");
    } finally {
      setPendingKind(null);
    }
  }, [optimisticKind, pendingKind, props]);

  const pinned = conversationsForKind(props.pinnedConversations, optimisticKind);
  const pinnedIds = new Set(pinned.map((task) => task.id));
  const chats = conversationsForKind(props.generalConversations, optimisticKind, pinnedIds);
  const projects = React.useMemo(() => {
    if (projectSort === "manual") return props.projects;
    return [...props.projects].sort((left, right) => {
      if (projectSort === "priority" && left.workspace.pinned !== right.workspace.pinned) return Number(right.workspace.pinned) - Number(left.workspace.pinned);
      return right.workspace.updatedAt.localeCompare(left.workspace.updatedAt) || left.workspace.name.localeCompare(right.workspace.name);
    });
  }, [projectSort, props.projects]);
  const projectIds = projects.map((project) => project.workspace.id);
  const openConversation = (taskId: string) => {
    props.onOpenConversation(taskId);
    props.onAfterNavigate?.();
  };

  return (
    <>
      <SidebarHeader className="berry-sidebar-header pt-[var(--berry-titlebar-height)]">
        {props.showKindControl !== false ? (
          <div className="berry-conversation-kind-control grid grid-cols-2 rounded-lg bg-sidebar-accent/70 p-0.5" role="group" aria-label="Conversation type">
            <KindButton kind="chat" selected={optimisticKind === "chat"} pending={pendingKind === "chat"} disabled={pendingKind !== null} onSelect={selectKind} />
            <KindButton kind="code" selected={optimisticKind === "code"} pending={pendingKind === "code"} disabled={pendingKind !== null} onSelect={selectKind} />
          </div>
        ) : null}
        {props.showKindControl !== false && kindError ? (
          <div className="berry-sidebar-kind-error flex items-center gap-2 px-1 text-xs text-destructive" role="alert">
            <span className="min-w-0 flex-1">{kindError}</span>
            {failedKind ? <Button type="button" variant="ghost" size="xs" onClick={() => void selectKind(failedKind)}>Retry</Button> : null}
          </div>
        ) : null}
        {props.commands}
      </SidebarHeader>
      <SidebarContent className="scroll-fade">
        <ConversationSection title="Pinned" open>
          <ConversationRows tasks={pinned} emptyLabel="No pinned conversations" activeTaskId={props.activeConversationId} onOpen={openConversation} formatAge={props.formatAge} onTogglePinned={props.onToggleConversationPinned} onArchive={props.onArchiveConversation} onDelete={props.onDeleteConversation} onRename={props.onRenameConversation} onShare={props.onShareConversation} />
        </ConversationSection>

        <SidebarGroup className="berry-sidebar-project-group">
          <div className="berry-sidebar-project-heading flex items-center pb-1">
            <h2 className="berry-sidebar-section-heading flex-1 text-xs font-medium text-sidebar-foreground/60">Projects</h2>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" className="berry-sidebar-mini-control berry-sidebar-project-header-control" aria-label="Sort projects" title="Sort projects"><Ellipsis /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="berry-project-sort-menu">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={projectSort} onValueChange={(value) => setProjectSort(value as typeof projectSort)}>
                  <DropdownMenuRadioItem value="priority">Priority</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="last-updated">Last updated</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="manual">Manual order</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="berry-sidebar-mini-control berry-sidebar-project-header-control"
              aria-label={sectionState.allCollapsed ? "Expand all projects" : "Collapse all projects"}
              onClick={() => dispatch({ type: "toggle-all", projectIds })}
            >
              <ListCollapse />
            </Button>
            {props.onCreateProject ? <Button type="button" variant="ghost" size="icon-sm" className="berry-sidebar-mini-control berry-sidebar-project-header-control" aria-label="Create project" title="Create project" onClick={props.onCreateProject}><Plus /></Button> : null}
          </div>
          {props.projectsLoading ? <SidebarStatus label="Loading projects" loading /> : null}
          {props.projectsError ? <SidebarStatus label={props.projectsError} error /> : null}
          {!props.projectsLoading && !props.projectsError && props.projects.length === 0 ? <SidebarStatus label="No projects" /> : null}
          <SidebarMenu className="berry-sidebar-tree">
            {projects.map((project) => {
              const id = project.workspace.id;
              const open = !sectionState.collapsedProjects.has(id);
              const projectTasks = conversationsForKind(project.conversations, optimisticKind, pinnedIds);
              const { visible, hiddenCount } = visibleConversationSlice(projectTasks, sectionState.expandedProjects.has(id));
              return (
                <SidebarMenuItem key={id} className="berry-sidebar-workspace-item">
                  <SidebarMenuButton
                    type="button"
                    className={cn("berry-sidebar-workspace-row", (props.onNewProjectConversation || props.renderProjectAction) && "pr-16!")}
                    aria-current={id === props.activeWorkspaceId ? "true" : undefined}
                    aria-expanded={open}
                    onClick={() => {
                      dispatch({ type: "toggle-project", projectId: id });
                      props.onSelectProject?.(id);
                    }}
                  >
                    {open ? <Folder02 /> : <Folder />}
                    <span className="berry-sidebar-row-title min-w-0 flex-1 overflow-hidden whitespace-nowrap">{project.workspace.name}</span>
                    {project.workspace.pinned ? <Pin className="berry-sidebar-project-pin ml-auto size-3" aria-label="Pinned project" /> : null}
                  </SidebarMenuButton>
                  {props.renderProjectAction?.(project.workspace)}
                  {props.onNewProjectConversation ? (
                    <SidebarMenuAction
                      type="button"
                      className="berry-sidebar-workspace-action berry-sidebar-workspace-new-chat-action md:opacity-0 peer-hover/menu-button:opacity-100 hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`New ${optimisticKind === "code" ? "code chat" : "chat"} in ${project.workspace.name}`}
                      title={`New ${optimisticKind === "code" ? "code chat" : "chat"}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onNewProjectConversation?.(project.workspace);
                      }}
                    >
                      <PencilEdit02Icon />
                    </SidebarMenuAction>
                  ) : null}
                  <AnimatedCollapse open={open}>
                    {project.loading ? <SidebarStatus label={`Loading ${project.workspace.name}`} loading indented /> : null}
                    {project.error ? <SidebarStatus label={project.error} error indented /> : null}
                    {!project.loading && !project.error ? (
                      <SidebarMenu className="berry-sidebar-task-list my-0 gap-0 pt-0.5 pb-2">
                        <ConversationRows tasks={visible} emptyLabel="No conversations" activeTaskId={props.activeConversationId} onOpen={openConversation} formatAge={props.formatAge} onTogglePinned={props.onToggleConversationPinned} onArchive={props.onArchiveConversation} onDelete={props.onDeleteConversation} onRename={props.onRenameConversation} onShare={props.onShareConversation} indented />
                        {hiddenCount > 0 ? <ShowMoreRow count={hiddenCount} onClick={() => dispatch({ type: "show-project", projectId: id })} indented /> : null}
                      </SidebarMenu>
                    ) : null}
                  </AnimatedCollapse>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <ConversationSection
          title="Chats"
          open={!sectionState.chatsCollapsed}
          selected={props.chatsSelected === true}
          onToggle={() => {
            dispatch({ type: "toggle-chats" });
            props.onSelectChats?.();
          }}
        >
          {props.chatsLoading ? <SidebarStatus label="Loading chats" loading /> : null}
          {props.chatsError ? <SidebarStatus label={props.chatsError} error /> : null}
          {!props.chatsLoading && !props.chatsError ? (() => {
            const { visible, hiddenCount } = visibleConversationSlice(chats, sectionState.chatsExpanded);
            return (
              <SidebarMenu className="berry-sidebar-task-list my-0 gap-0 pt-0.5 pb-2">
                <ConversationRows tasks={visible} emptyLabel="No chats yet" activeTaskId={props.activeConversationId} onOpen={openConversation} formatAge={props.formatAge} onTogglePinned={props.onToggleConversationPinned} onArchive={props.onArchiveConversation} onDelete={props.onDeleteConversation} onRename={props.onRenameConversation} onShare={props.onShareConversation} />
                {hiddenCount > 0 ? <ShowMoreRow count={hiddenCount} onClick={() => dispatch({ type: "show-chats" })} /> : null}
              </SidebarMenu>
            );
          })() : null}
        </ConversationSection>
      </SidebarContent>
    </>
  );
}

function KindButton({ kind, selected, pending, disabled, onSelect }: {
  kind: ConversationKind;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: (kind: ConversationKind) => void;
}) {
  const Icon = kind === "chat" ? MessageSquare : CodeXml;
  const label = kind === "chat" ? "Chat" : "Code";
  return (
    <button
      type="button"
      className={cn("berry-conversation-kind-option flex min-h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-sidebar-foreground/65 transition-[background-color,color,box-shadow]", selected && "berry-conversation-kind-option-active bg-background text-foreground shadow-sm")}
      aria-pressed={selected}
      aria-label={`${label}${pending ? ", saving" : ""}`}
      disabled={disabled}
      onClick={() => onSelect(kind)}
    >
      {pending ? <CircularActivitySpinner size={14} label={`${label} is saving`} /> : <Icon className="size-3.5" />}
      <span>{label}</span>
    </button>
  );
}

function ConversationSection({ title, open, selected = false, onToggle, children }: {
  title: string;
  open: boolean;
  selected?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    <SidebarGroup className="berry-sidebar-conversation-section">
      {onToggle ? (
        <button type="button" className="berry-sidebar-section-heading flex w-full items-center gap-2 px-2 pb-1 text-left text-xs font-medium text-sidebar-foreground/60" aria-expanded={open} aria-current={selected ? "true" : undefined} onClick={onToggle}>
          <span className="flex-1">{title}</span>
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      ) : <h2 className="berry-sidebar-section-heading px-2 pb-1 text-xs font-medium text-sidebar-foreground/60">{title}</h2>}
      <AnimatedCollapse open={open}>
        {children}
      </AnimatedCollapse>
    </SidebarGroup>
  );
}

function ConversationRows({ tasks, emptyLabel, activeTaskId, onOpen, formatAge, onTogglePinned, onArchive, onDelete, onRename, onShare, indented = false }: {
  tasks: Task[];
  emptyLabel: string;
  activeTaskId: string | null;
  onOpen: (taskId: string) => void;
  formatAge: (iso: string) => string;
  onTogglePinned?: ((task: Task) => void | Promise<void>) | undefined;
  onArchive?: ((task: Task) => void | Promise<void>) | undefined;
  onDelete?: ((task: Task) => void | Promise<void>) | undefined;
  onRename?: ((task: Task) => void | Promise<void>) | undefined;
  onShare?: ((task: Task) => void | Promise<void>) | undefined;
  indented?: boolean;
}) {
  if (tasks.length === 0) return <SidebarStatus label={emptyLabel} indented={indented} />;
  return (
    <>
      {tasks.map((task) => {
        return (
          <SidebarMenuItem key={task.id} className="berry-sidebar-task-item">
            <SidebarMenuButton type="button" isActive={task.id === activeTaskId} onClick={() => onOpen(task.id)} className={cn("berry-sidebar-task-row pr-14!", indented && "pl-8")}>
              <span className="berry-sidebar-row-title min-w-0 flex-1" title={task.title}>{task.title}</span>
            </SidebarMenuButton>
            <ConversationActions task={task} onTogglePinned={onTogglePinned} onArchive={onArchive} onDelete={onDelete} onRename={onRename} onShare={onShare} />
          </SidebarMenuItem>
        );
      })}
    </>
  );
}

function ConversationActions({ task, onTogglePinned, onArchive, onDelete, onRename, onShare }: {
  task: Task;
  onTogglePinned?: ((task: Task) => void | Promise<void>) | undefined;
  onArchive?: ((task: Task) => void | Promise<void>) | undefined;
  onDelete?: ((task: Task) => void | Promise<void>) | undefined;
  onRename?: ((task: Task) => void | Promise<void>) | undefined;
  onShare?: ((task: Task) => void | Promise<void>) | undefined;
}) {
  return (
    <>
      <SidebarMenuAction
        type="button"
        className="berry-sidebar-task-action berry-sidebar-task-pin-action"
        aria-label={task.pinned ? `Unpin ${task.title}` : `Pin ${task.title}`}
        title={task.pinned ? "Unpin chat" : "Pin chat"}
        onClick={(event) => {
          event.stopPropagation();
          void onTogglePinned?.(task);
        }}
      >
        {task.pinned ? <PinOff /> : <Pin />}
      </SidebarMenuAction>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            type="button"
            className="berry-sidebar-task-action berry-sidebar-task-menu-trigger"
            aria-label={`Actions for ${task.title}`}
            title="Chat actions"
            onClick={(event) => event.stopPropagation()}
          >
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} collisionPadding={12} className="berry-chat-actions-menu">
          <DropdownMenuItem onSelect={() => void onShare?.(task)}><Users />Share</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onRename?.(task)}><Pencil />Rename</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Folder />Move to project</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="berry-chat-actions-menu"><DropdownMenuItem disabled>No projects available</DropdownMenuItem></DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => void onTogglePinned?.(task)}>{task.pinned ? <PinOff /> : <Pin />}{task.pinned ? "Unpin chat" : "Pin chat"}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onArchive?.(task)}><Archive />Archive</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void onDelete?.(task)}><Trash2 />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function ShowMoreRow({ count, onClick, indented = false }: { count: number; onClick: () => void; indented?: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton type="button" className={cn("berry-sidebar-show-more text-sidebar-foreground/60", indented && "berry-sidebar-show-more-indented")} aria-label={`Show ${count} more conversations`} onClick={onClick}>
        <span>Show {count} more</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SidebarStatus({ label, loading = false, error = false, indented = false }: { label: string; loading?: boolean; error?: boolean; indented?: boolean }) {
  return (
    <p className={cn("berry-sidebar-empty flex items-center gap-2 px-2 py-1.5 text-xs text-sidebar-foreground/55", indented && "pl-8", error && "text-destructive")} role={error ? "alert" : "status"}>
      {loading ? <CircularActivitySpinner size={14} label={label} /> : null}
      <span>{label}</span>
    </p>
  );
}
