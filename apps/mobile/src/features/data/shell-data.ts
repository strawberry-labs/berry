import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";
import type { Task, Workspace } from "@berry/shared";
import { allConversations, sortProjects, taskIsInProgress, type ProjectSort } from "@berry/client-core/conversations";
import { useSignedInSession } from "../../session/session";
import { kv } from "../../storage/kv";

const TASK_REFRESH_MS = 30_000;
const RUNNING_TASK_REFRESH_MS = 8_000;
const ACTIVE_WORKSPACE_KEY = "berry.user.activeWorkspaceId";

export const shellKeys = {
  workspaces: (server: string) => ["shell", server, "workspaces"] as const,
  tasks: (server: string) => ["shell", server, "tasks"] as const,
  runningTasks: (server: string, ids: string) => ["shell", server, "tasks", "running", ids] as const,
  organization: (server: string) => ["shell", server, "organization"] as const,
  allowance: (server: string, tenantId: string) => ["shell", server, "allowance", tenantId] as const,
  modelCatalog: (server: string) => ["shell", server, "model-catalog"] as const,
};

/** The same loads the web shell does on bootstrap (AppShell): every workspace and every task. */
export function useWorkspaces() {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: shellKeys.workspaces(profile.serverUrl),
    queryFn: async () => {
      const workspaces = await client.listWorkspaces({ includeGeneral: true });
      if (workspaces.length > 0) return workspaces;
      // A brand-new account starts with one project, as on the web.
      return [await client.createWorkspace({ name: "Default project" })];
    },
    staleTime: 60_000,
  });
}

export function useTasks() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: shellKeys.tasks(profile.serverUrl),
    queryFn: () => client.listTasks({ includeDeleted: true }),
    refetchInterval: TASK_REFRESH_MS,
  });
  // While anything runs, refresh just those tasks more often (the web polls them every 8 s).
  const runningIds = (query.data ?? []).filter(taskIsInProgress).map((task) => task.id).sort().join(",");
  useQuery({
    queryKey: shellKeys.runningTasks(profile.serverUrl, runningIds),
    enabled: runningIds.length > 0,
    refetchInterval: RUNNING_TASK_REFRESH_MS,
    queryFn: async () => {
      const updated = await client.listTasks({ includeDeleted: true, taskIds: runningIds.split(",") });
      mergeTasks(queryClient, profile.serverUrl, updated);
      return updated.length;
    },
  });
  return query;
}

export function mergeTasks(queryClient: QueryClient, server: string, updated: Task[]): void {
  if (updated.length === 0) return;
  const byId = new Map(updated.map((task) => [task.id, task]));
  queryClient.setQueryData<Task[]>(shellKeys.tasks(server), (current) => {
    if (!current) return updated;
    const seen = new Set<string>();
    const merged = current.map((task) => {
      const next = byId.get(task.id);
      if (next) seen.add(task.id);
      return next ?? task;
    });
    return [...updated.filter((task) => !seen.has(task.id)), ...merged];
  });
}

export type SidebarModel = {
  generalWorkspace: Workspace | null;
  projects: Array<{ workspace: Workspace; tasks: Task[] }>;
  generalTasks: Task[];
  pinned: Task[];
  visibleTasks: Task[];
};

/** Groups tasks exactly like the web sidebar: pinned first, then per project, then general. */
export function buildSidebarModel(workspaces: Workspace[], tasks: Task[], projectSort: ProjectSort): SidebarModel {
  const generalWorkspace = workspaces.find((workspace) => workspace.workspaceKind === "general") ?? null;
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const visibleTasks = tasks.filter((task) => !task.deletedAt && !task.archived && known.has(task.workspaceId));
  const pinned = allConversations(visibleTasks.filter((task) => task.pinned));
  const pinnedIds = new Set(pinned.map((task) => task.id));
  const projects = workspaces
    .filter((workspace) => workspace.workspaceKind !== "general")
    .map((workspace) => ({ workspace, tasks: allConversations(visibleTasks.filter((task) => task.workspaceId === workspace.id), pinnedIds) }));
  const generalTasks = generalWorkspace ? allConversations(visibleTasks.filter((task) => task.workspaceId === generalWorkspace.id), pinnedIds) : [];
  return { generalWorkspace, projects: sortProjects(projects, projectSort), generalTasks, pinned, visibleTasks };
}

const activeWorkspaceListeners = new Set<() => void>();

function subscribeActiveWorkspace(listener: () => void): () => void {
  activeWorkspaceListeners.add(listener);
  return () => activeWorkspaceListeners.delete(listener);
}

function readActiveWorkspaceId(): string | null {
  return kv.getItem(ACTIVE_WORKSPACE_KEY);
}

/** Chooses where new tasks go; every screen showing the choice updates at once. */
export function setActiveWorkspaceId(id: string): void {
  kv.setItem(ACTIVE_WORKSPACE_KEY, id);
  for (const listener of activeWorkspaceListeners) listener();
}

/** Where new tasks go: the last project chosen, else the general "Tasks" workspace. */
export function useActiveWorkspace(workspaces: Workspace[] | undefined) {
  const stored = React.useSyncExternalStore(subscribeActiveWorkspace, readActiveWorkspaceId);
  const active = workspaces?.find((workspace) => workspace.id === stored)
    ?? workspaces?.find((workspace) => workspace.workspaceKind === "general")
    ?? workspaces?.[0]
    ?? null;
  return [active, setActiveWorkspaceId] as const;
}

/** Task row actions, applied optimistically and reverted on failure, like the web. */
export function useTaskActions() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const key = shellKeys.tasks(profile.serverUrl);
  const mutation = useMutation({
    mutationFn: async (action: TaskAction) => runTaskAction(client, action),
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Task[]>(key);
      queryClient.setQueryData<Task[]>(key, (tasks) => tasks?.map((task) => task.id === action.task.id ? optimisticTask(task, action) : task));
      return { previous };
    },
    onError: (_error, _action, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (task) => {
      if (task) mergeTasks(queryClient, profile.serverUrl, [task]);
    },
  });
  return mutation;
}

export type TaskAction =
  | { kind: "rename"; task: Task; title: string }
  | { kind: "pin"; task: Task }
  | { kind: "archive"; task: Task }
  | { kind: "delete"; task: Task }
  | { kind: "restore"; task: Task }
  | { kind: "read"; task: Task };

function runTaskAction(client: BerryApiClient, action: TaskAction): Promise<Task | null> {
  switch (action.kind) {
    case "rename": return client.updateTask(action.task.id, { title: action.title });
    case "pin": return client.updateTask(action.task.id, { pinned: !action.task.pinned });
    case "archive": return client.updateTask(action.task.id, { archived: true });
    case "delete": return client.deleteTask(action.task.id);
    case "restore": return client.restoreTask(action.task.id);
    case "read": return action.task.unreadAt ? client.updateTask(action.task.id, { read: true, readThrough: action.task.unreadAt }) : Promise.resolve(null);
  }
}

function optimisticTask(task: Task, action: TaskAction): Task {
  switch (action.kind) {
    case "rename": return { ...task, title: action.title };
    case "pin": return { ...task, pinned: !task.pinned };
    case "archive": return { ...task, archived: true };
    case "delete": return { ...task, deletedAt: new Date().toISOString() };
    case "restore": return { ...task, deletedAt: null, archived: false };
    case "read": return { ...task, lastReadAt: task.unreadAt ?? task.lastReadAt };
  }
}

export type ProjectAction =
  | { kind: "create"; name: string }
  | { kind: "rename"; workspace: Workspace; name: string }
  | { kind: "pin"; workspace: Workspace }
  | { kind: "remove"; workspace: Workspace }
  | { kind: "archive-tasks"; workspace: Workspace; tasks: Task[] };

export function useProjectActions() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const workspacesKey = shellKeys.workspaces(profile.serverUrl);
  const tasksKey = shellKeys.tasks(profile.serverUrl);
  return useMutation({
    mutationFn: async (action: ProjectAction): Promise<Workspace | null> => {
      switch (action.kind) {
        case "create": return client.createWorkspace({ name: action.name });
        case "rename": return client.updateWorkspace(action.workspace.id, { name: action.name });
        case "pin": return client.updateWorkspace(action.workspace.id, { pinned: !action.workspace.pinned });
        case "remove": await client.deleteWorkspace(action.workspace.id); return null;
        case "archive-tasks": await Promise.all(action.tasks.map((task) => client.updateTask(task.id, { archived: true }))); return null;
      }
    },
    onMutate: (action) => {
      if (action.kind === "archive-tasks") {
        const ids = new Set(action.tasks.map((task) => task.id));
        queryClient.setQueryData<Task[]>(tasksKey, (tasks) => tasks?.map((task) => ids.has(task.id) ? { ...task, archived: true } : task));
      }
      if (action.kind === "remove") {
        queryClient.setQueryData<Workspace[]>(workspacesKey, (workspaces) => workspaces?.filter((workspace) => workspace.id !== action.workspace.id));
      }
    },
    onSuccess: (workspace, action) => {
      if (workspace) {
        queryClient.setQueryData<Workspace[]>(workspacesKey, (workspaces) => action.kind === "create"
          ? [...(workspaces ?? []), workspace]
          : workspaces?.map((candidate) => candidate.id === workspace.id ? workspace : candidate));
      }
    },
    onSettled: (_data, error) => {
      if (error) {
        void queryClient.invalidateQueries({ queryKey: workspacesKey });
        void queryClient.invalidateQueries({ queryKey: tasksKey });
      }
    },
  });
}

/** The organization id for allowance and admin links (the web uses the first organization). */
export function useOrganizationId(): string | null {
  const { client, profile } = useSignedInSession();
  const query = useQuery({
    queryKey: shellKeys.organization(profile.serverUrl),
    queryFn: async () => (await client.listOrganizations())[0]?.id ?? null,
    staleTime: 5 * 60_000,
  });
  return query.data ?? null;
}

export function useAllowance(tenantId: string | null) {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: shellKeys.allowance(profile.serverUrl, tenantId ?? "none"),
    queryFn: () => client.myAllowanceBalance(tenantId!),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
  });
}
