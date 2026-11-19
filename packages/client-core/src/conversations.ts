import type { ConversationKind, Task, Workspace } from "@berry/shared";

/** Sidebar ordering and grouping shared by the web, desktop and native sidebars. */

export const INITIAL_CONVERSATION_COUNT = 5;
export const PROJECT_SORT_OPTIONS = [
  { value: "priority", label: "Priority" },
  { value: "last-updated", label: "Last updated" },
  { value: "manual", label: "Manual order" },
] as const;

export type ProjectSort = (typeof PROJECT_SORT_OPTIONS)[number]["value"];

export interface ConversationSectionState {
  projectsCollapsed: boolean;
  collapsedProjects: ReadonlySet<string>;
  expandedProjects: ReadonlySet<string>;
  chatsCollapsed: boolean;
  chatsExpanded: boolean;
  allCollapsed: boolean;
}

export type ConversationSectionAction =
  | { type: "toggle-projects" }
  | { type: "toggle-project"; projectId: string }
  | { type: "show-project"; projectId: string }
  | { type: "toggle-chats" }
  | { type: "show-chats" }
  | { type: "toggle-all"; projectIds: string[] };

export const INITIAL_CONVERSATION_SECTION_STATE: ConversationSectionState = {
  projectsCollapsed: false,
  collapsedProjects: new Set(),
  expandedProjects: new Set(),
  chatsCollapsed: false,
  chatsExpanded: false,
  allCollapsed: false,
};

export function conversationSectionReducer(state: ConversationSectionState, action: ConversationSectionAction): ConversationSectionState {
  if (action.type === "toggle-projects") return { ...state, projectsCollapsed: !state.projectsCollapsed };
  if (action.type === "toggle-project") {
    const collapsedProjects = new Set(state.collapsedProjects);
    const expandedProjects = new Set(state.expandedProjects);
    if (collapsedProjects.has(action.projectId)) collapsedProjects.delete(action.projectId);
    else {
      collapsedProjects.add(action.projectId);
      expandedProjects.delete(action.projectId);
    }
    return { ...state, projectsCollapsed: false, collapsedProjects, expandedProjects, allCollapsed: false };
  }
  if (action.type === "show-project") {
    return { ...state, projectsCollapsed: false, expandedProjects: new Set([...state.expandedProjects, action.projectId]) };
  }
  if (action.type === "toggle-chats") {
    return { ...state, chatsCollapsed: !state.chatsCollapsed, chatsExpanded: false, allCollapsed: false };
  }
  if (action.type === "show-chats") return { ...state, chatsExpanded: true };
  const nextCollapsed = !state.allCollapsed;
  return {
    projectsCollapsed: false,
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

export function allConversations(tasks: Task[], excludedIds: ReadonlySet<string> = new Set()): Task[] {
  return tasks
    .filter((task) => !excludedIds.has(task.id))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

export function visibleConversationSlice(tasks: Task[], expanded: boolean): { visible: Task[]; hiddenCount: number } {
  if (expanded || tasks.length <= INITIAL_CONVERSATION_COUNT) return { visible: tasks, hiddenCount: 0 };
  return { visible: tasks.slice(0, INITIAL_CONVERSATION_COUNT), hiddenCount: tasks.length - INITIAL_CONVERSATION_COUNT };
}

export function taskIsInProgress(task: Pick<Task, "status">): boolean {
  return task.status === "queued" || task.status === "running" || task.status === "waiting-for-approval";
}

export function taskHasUnreadActivity(task: Pick<Task, "unreadAt" | "lastReadAt">): boolean {
  if (!task.unreadAt) return false;
  return !task.lastReadAt || task.unreadAt > task.lastReadAt;
}

export function sortProjects<T extends { workspace: Workspace }>(projects: readonly T[], sort: ProjectSort): T[] {
  if (sort === "manual") return [...projects];
  return [...projects].sort((left, right) => {
    if (sort === "priority" && left.workspace.pinned !== right.workspace.pinned) return Number(right.workspace.pinned) - Number(left.workspace.pinned);
    return right.workspace.updatedAt.localeCompare(left.workspace.updatedAt) || left.workspace.name.localeCompare(right.workspace.name);
  });
}
