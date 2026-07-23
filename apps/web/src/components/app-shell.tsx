import * as React from "react";
import { ArrowUp, CreditCard, Plus, Settings, Square, X } from "lucide-react";
import { BerryApiClient, BerryApiError } from "@berry/api-client";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { MessageAttachmentContentSchema, messageAttachmentContent, type AttachmentInput, type Message, type OrgMembership, type OrgPermission, type PermissionMode, type QueuedFollowUp, type ReasoningLevel, type Task, type Workspace } from "@berry/shared";
import { toast } from "sonner";
import { BerryShellFrame } from "@berry/desktop-ui/components/berry-shell";
import { BerryTaskHeaderFrame } from "@berry/desktop-ui/components/berry-task-header";
import { BerryComposerFrame } from "@berry/desktop-ui/components/berry-composer-frame";
import { BerryWorkspaceHomeFrame } from "@berry/desktop-ui/components/berry-workspace-home";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import {
  BerryThreadView,
  BerryUserEditorFrame,
  fullUserText,
  isImageMessagePart,
  type BerryThreadAdapter,
} from "@berry/desktop-ui/components/berry-thread-view";
import { IDLE, reduceStream, reduceStreamDeltas, type StreamState } from "@berry/desktop-ui/components/thread-stream";
import { Toaster } from "@berry/desktop-ui/components/ui/sonner";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";
import type { ImageGenerationState } from "@berry/desktop-ui/components/image-generation";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { FileSearch as FileSearchIcon } from "lucide-react";
import { AtSign, Brain, Check, CircleHelp, ChevronDown, Ellipsis, FileText, GitBranch, Hand, Hash, ImagePlus, NotebookPen, PencilLine, Pin, PinOff, ShieldCheck, SlashSquare, Zap } from "@berry/desktop-ui/lib/icons";
import { fixtureMessages, fixtureTasks, message } from "@/lib/fixtures";
import { confirmOptimisticMessage, OPTIMISTIC_MESSAGE_ID_PREFIX, reconcileFetchedSessionMessages } from "@/lib/message-reconciliation";
import { WebConfigSchema, type WebConfig } from "@/lib/config";
import { parseCloudShellLocation, type ArtifactLibraryTab, type UserSettingsTab } from "@/lib/cloud-shell-state";
import { MentionMenu, useStaticMentions } from "./mention-menu";
import { PromptEditor, type PromptEditorHandle } from "./prompt-editor";
import { AuthBoundary, type SignedInUser } from "./shell/auth-boundary";
import { TaskRouteState } from "./tasks/task-route-state";
import { Composer } from "./tasks/web-composer";
import { Thread } from "./tasks/web-task-view";
import { planProgressFromConversation } from "./tasks/plan-progress-pill";
import { ProjectSwitcher } from "./projects/project-switcher";
import { replaceTenantValue, settledValue } from "@/lib/management/config-refresh";
import { WebSidebar, WebWindowChrome, type SettingsTab } from "./shell/web-sidebar";
import { ManagementSidebar } from "./management/management-sidebar";
import { ManagementRouteProvider } from "./management/management-route-context";
import type { ManagementKind } from "./management/management-navigation";
import { WebCommandPalette } from "./shell/web-command-palette";
import { WebHelpMenu } from "./shell/web-help-menu";
import { ArtifactLibrary } from "./library/artifact-library";
import { TaskFileLibraryDialog } from "./library/task-file-library-dialog";

export interface ShellData {
  config: WebConfig;
  tasks: Task[];
  messages: Message[];
}

const LOCAL_FOLLOW_UP_PREFIX = "local_follow_up_";

function isLocalFollowUp(followUp: QueuedFollowUp): boolean {
  return followUp.id.startsWith(LOCAL_FOLLOW_UP_PREFIX);
}

function followUpOrderStorageKey(sessionId: string): string {
  return `berry.web.followUpOrder:${sessionId}`;
}

function savedFollowUpOrder(sessionId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(followUpOrderStorageKey(sessionId)) ?? "[]");
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

function saveFollowUpOrder(sessionId: string, orderedIds: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(followUpOrderStorageKey(sessionId), JSON.stringify(orderedIds));
}

function orderFollowUps(sessionId: string, followUps: QueuedFollowUp[]): QueuedFollowUp[] {
  const fallback = [...followUps].sort((left, right) => left.ordinal - right.ordinal);
  const saved = savedFollowUpOrder(sessionId);
  if (saved.length === 0) return fallback;
  const position = new Map(saved.map((id, index) => [id, index]));
  return fallback.sort((left, right) => {
    const leftPosition = position.get(left.id);
    const rightPosition = position.get(right.id);
    if (leftPosition === undefined && rightPosition === undefined) return left.ordinal - right.ordinal;
    if (leftPosition === undefined) return 1;
    if (rightPosition === undefined) return -1;
    return leftPosition - rightPosition;
  });
}

function replaceFollowUpOrderId(sessionId: string, oldId: string, newId: string): void {
  const saved = savedFollowUpOrder(sessionId);
  if (!saved.includes(oldId)) return;
  saveFollowUpOrder(sessionId, saved.map((id) => id === oldId ? newId : id));
}

function removeFollowUpOrderId(sessionId: string, followUpId: string): void {
  const saved = savedFollowUpOrder(sessionId);
  if (!saved.includes(followUpId)) return;
  saveFollowUpOrder(sessionId, saved.filter((id) => id !== followUpId));
}

export function initialCloudContent(initial: ShellData): Pick<ShellData, "tasks" | "messages"> {
  return initial.config.demoMode
    ? { tasks: initial.tasks, messages: initial.messages }
    : { tasks: [], messages: [] };
}

export function shouldRefreshAdministration(permissions: readonly OrgPermission[]): boolean {
  return permissions.includes("org:admin");
}

export function AppShell({ initial }: { initial: ShellData }) {
  if (initial.config.demoMode) return <CloudShell initial={initial} user={null} />;
  return (
    <AuthBoundary baseUrl={initial.config.apiBaseUrl ?? ""}>
      {(user, onSignedOut) => <CloudShell initial={initial} user={user} onSignedOut={onSignedOut} />}
    </AuthBoundary>
  );
}

function CloudShell({ initial, user, onSignedOut }: { initial: ShellData; user: SignedInUser | null; onSignedOut?: (() => void) | undefined }) {
  const location = useLocation();
  const navigate = useNavigate();
  const shellLocation = React.useMemo(() => parseCloudShellLocation(location.pathname), [location.pathname]);
  const bootstrapContent = initialCloudContent(initial);
  const [config, setConfig] = React.useState(initial.config);
  const [hydrated, setHydrated] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [taskFilesOpen, setTaskFilesOpen] = React.useState(false);
  const searchReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const [connectionState, setConnectionState] = React.useState<"online" | "offline" | "reconnecting">("online");
  const [tasks, setTasks] = React.useState(bootstrapContent.tasks);
  const [followUpsBySession, setFollowUpsBySession] = React.useState<Record<string, QueuedFollowUp[]>>({});
  const [activeTaskId, setActiveTaskId] = React.useState(shellLocation.kind === "task" ? shellLocation.taskId : "");
  const fixtureWorkspace = React.useMemo<Workspace>(() => ({
    id: initial.config.workspaceId,
    path: initial.config.workspacePath,
    name: "Default project",
    workspaceKind: "project",
    ownerUserId: user?.id ?? null,
    trustState: "trusted",
    lastOpenedAt: "2026-07-10T00:00:00.000Z",
    indexedAt: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    pinned: false,
  }), [initial.config.workspaceId, initial.config.workspacePath, user?.id]);
  const fixtureGeneralWorkspace = React.useMemo<Workspace>(() => ({
    ...fixtureWorkspace,
    id: `${initial.config.workspaceId}:general`,
    path: `${initial.config.workspacePath.replace(/\/$/, "")}/.berry/general`,
    name: "Chats",
    workspaceKind: "general",
  }), [fixtureWorkspace, initial.config.workspaceId, initial.config.workspacePath]);
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([fixtureWorkspace, fixtureGeneralWorkspace]);
  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState(initial.config.workspaceId);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const bootstrapSessionId = bootstrapContent.tasks[0]?.activeSessionId ?? null;
  const [messagesBySession, setMessagesBySession] = React.useState<Record<string, Message[]>>(() =>
    bootstrapSessionId ? { [bootstrapSessionId]: bootstrapContent.messages } : {},
  );
  const surface = shellLocation.kind === "settings" || shellLocation.kind === "admin" || shellLocation.kind === "platform" ? "settings" : shellLocation.kind === "library" ? "library" : "task";
  const managementKind: ManagementKind = shellLocation.kind === "admin" ? "admin" : shellLocation.kind === "platform" ? "platform" : "settings";
  const managementTab = shellLocation.kind === "settings" || shellLocation.kind === "admin" || shellLocation.kind === "platform" ? shellLocation.tab : "general";
  const [streamsBySession, setStreamsBySession] = React.useState<Record<string, StreamState>>({});
  const [imageGenerationBySession, setImageGenerationBySession] = React.useState<Record<string, ImageGenerationState | null>>({});
  const [startingSessions, setStartingSessions] = React.useState<Set<string>>(() => new Set());
  const permissionMode = "full-access" satisfies PermissionMode;
  const [reasoning, setReasoning] = React.useState<ReasoningLevel>("medium");
  const [resourceErrors, setResourceErrors] = React.useState<Record<"workspaces" | "tasks" | "messages" | "stream" | "followUps" | "settings", string>>({ workspaces: "", tasks: "", messages: "", stream: "", followUps: "", settings: "" });
  const setResourceError = React.useCallback((resource: keyof typeof resourceErrors, message: string) => setResourceErrors((current) => ({ ...current, [resource]: message })), []);
  const [tasksLoaded, setTasksLoaded] = React.useState(initial.config.demoMode);
  const [taskRouteError, setTaskRouteError] = React.useState<"not-found" | "forbidden" | "failed" | null>(null);
  const [creatingProject, setCreatingProject] = React.useState(false);
  const [activeOrganizationId, setActiveOrganizationId] = React.useState(initial.config.activeOrganizationId);
  const activeOrganization = config.organizations.find((org) => org.id === activeOrganizationId) ?? config.organizations[0] ?? null;
  const fallbackOrgPermissions = React.useMemo(
    () => config.rolePermissions.find((entry) => entry.tenantId === activeOrganizationId && entry.role === activeOrganization?.role)?.permissions ?? [],
    [activeOrganization?.role, activeOrganizationId, config.rolePermissions],
  );
  const [effectiveOrgPermissions, setEffectiveOrgPermissions] = React.useState<OrgPermission[]>(fallbackOrgPermissions);
  const defaultProvider = initial.config.providers.find((provider) => provider.enabled) ?? initial.config.providers[0];
  const [providerId, setProviderId] = React.useState(defaultProvider?.id ?? "router");
  const [modelOptions, setModelOptions] = React.useState(defaultProvider?.models ?? []);
  const [model, setModel] = React.useState(defaultProvider?.defaultModel ?? "");
  React.useEffect(() => {
    const storedReasoning = window.localStorage.getItem("berry.web.reasoning");
    const storedModel = window.localStorage.getItem("berry.web.model");
    if (storedReasoning === "off" || storedReasoning === "low" || storedReasoning === "medium" || storedReasoning === "high") setReasoning(storedReasoning);
    if (storedModel) setModel(storedModel);
  }, []);
  const updateReasoning = React.useCallback((next: ReasoningLevel) => { setReasoning(next); window.localStorage.setItem("berry.web.reasoning", next); }, []);
  const updateModel = React.useCallback((next: string) => { setModel(next); window.localStorage.setItem("berry.web.model", next); }, []);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const client = React.useMemo(() => initial.config.apiBaseUrl && !initial.config.demoMode
    ? new BerryApiClient({ baseUrl: initial.config.apiBaseUrl })
    : null, [initial.config.apiBaseUrl, initial.config.demoMode]);
  React.useEffect(() => {
    if (!client || !activeOrganizationId) {
      setEffectiveOrgPermissions(fallbackOrgPermissions);
      return;
    }
    let cancelled = false;
    void client.effectivePermissions(activeOrganizationId)
      .then((result) => {
        if (!cancelled) setEffectiveOrgPermissions(result.permissions);
      })
      .catch(() => {
        if (!cancelled) setEffectiveOrgPermissions(fallbackOrgPermissions);
      });
    return () => { cancelled = true; };
  }, [activeOrganizationId, client, fallbackOrgPermissions]);
  // A queued item can be triggered from its card, keyboard shortcut, or a
  // reconciliation refresh. Keep one browser-side lock per item so those
  // paths cannot start two turns for the same prompt.
  const followUpSendInFlightRef = React.useRef(new Set<string>());
  const activeSessionId = activeTask?.activeSessionId ?? null;
  const messages = activeSessionId ? messagesBySession[activeSessionId] ?? [] : [];
  const stream = activeSessionId ? streamsBySession[activeSessionId] ?? IDLE : IDLE;
  const turnBusy = activeSessionId ? startingSessions.has(activeSessionId) : false;

  const replaceSessionMessages = React.useCallback((sessionId: string, next: Message[] | ((current: Message[]) => Message[])) => {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: typeof next === "function" ? next(current[sessionId] ?? []) : next,
    }));
  }, []);

  const pendingStreamDeltasRef = React.useRef(new Map<string, {
    text: string;
    reasoning: string;
    messageId: string;
    frameId: number | null;
  }>());

  const flushSessionDeltas = React.useCallback((sessionId: string) => {
    const pending = pendingStreamDeltasRef.current.get(sessionId);
    if (!pending) return;
    if (pending.frameId !== null) cancelAnimationFrame(pending.frameId);
    pendingStreamDeltasRef.current.delete(sessionId);
    if (!pending.text && !pending.reasoning) return;
    setStreamsBySession((current) => ({
      ...current,
      [sessionId]: reduceStreamDeltas(current[sessionId] ?? IDLE, pending),
    }));
  }, []);

  const updateSessionStream = React.useCallback((sessionId: string, event: Parameters<typeof reduceStream>[1]) => {
    if (event.kind === "message.delta") {
      const pending = pendingStreamDeltasRef.current.get(sessionId) ?? {
        text: "",
        reasoning: "",
        messageId: event.messageId,
        frameId: null,
      };
      pending.messageId = event.messageId;
      if (event.channel === "reasoning") pending.reasoning += event.delta;
      else pending.text += event.delta;
      if (pending.frameId === null) {
        pending.frameId = requestAnimationFrame(() => flushSessionDeltas(sessionId));
      }
      pendingStreamDeltasRef.current.set(sessionId, pending);
      return;
    }

    // Preserve event order: all text received before a tool/end event must be
    // visible before that event changes the live turn state.
    flushSessionDeltas(sessionId);
    setStreamsBySession((current) => ({
      ...current,
      [sessionId]: reduceStream(current[sessionId] ?? IDLE, event),
    }));
  }, [flushSessionDeltas]);

  const resetSessionStream = React.useCallback((sessionId: string) => {
    const pending = pendingStreamDeltasRef.current.get(sessionId);
    if (pending?.frameId !== null && pending?.frameId !== undefined) cancelAnimationFrame(pending.frameId);
    pendingStreamDeltasRef.current.delete(sessionId);
    setStreamsBySession((current) => ({ ...current, [sessionId]: IDLE }));
  }, []);

  React.useEffect(() => () => {
    for (const pending of pendingStreamDeltasRef.current.values()) {
      if (pending.frameId !== null) cancelAnimationFrame(pending.frameId);
    }
    pendingStreamDeltasRef.current.clear();
  }, []);

  const navigateToTask = React.useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    void navigate({ to: "/tasks/$taskId", params: { taskId } });
  }, [navigate]);

  const navigateHome = React.useCallback(() => {
    setActiveTaskId("");
    void navigate({ to: "/" });
  }, [navigate]);

  const lastTaskIdRef = React.useRef(shellLocation.kind === "task" ? shellLocation.taskId : "");

  React.useEffect(() => {
    if (shellLocation.kind === "task") lastTaskIdRef.current = shellLocation.taskId;
  }, [shellLocation]);

  const navigateBackToWorkspace = React.useCallback(() => {
    if (lastTaskIdRef.current) navigateToTask(lastTaskIdRef.current);
    else navigateHome();
  }, [navigateHome, navigateToTask]);

  const navigateToSettings = React.useCallback((tab: SettingsTab) => {
    if (tab === "governance") {
      void navigate({ to: "/admin/$tab", params: { tab: "organization" } });
    } else if (tab === "platform") {
      void navigate({ to: "/platform/$tab", params: { tab: "organizations" } });
    } else {
      void navigate({ to: "/settings/$tab", params: { tab: tab as UserSettingsTab } });
    }
  }, [navigate]);

  const navigateToLibrary = React.useCallback((tab: ArtifactLibraryTab) => {
    void navigate({ to: "/library/$tab", params: { tab } });
  }, [navigate]);
  const navigateManagement = React.useCallback((kind: ManagementKind, tab: string) => {
    if (kind === "settings") void navigate({ to: "/settings/$tab", params: { tab: tab as UserSettingsTab } });
    else if (kind === "admin") void navigate({ to: "/admin/$tab", params: { tab }, search: {} });
    else void navigate({ to: "/platform/$tab", params: { tab } });
  }, [navigate]);

  React.useEffect(() => {
    if (shellLocation.kind === "task") setActiveTaskId(shellLocation.taskId);
    else if (shellLocation.kind === "home") setActiveTaskId("");
  }, [shellLocation]);

  React.useEffect(() => {
    if (activeTask) setActiveWorkspaceId(activeTask.workspaceId);
  }, [activeTask]);

  const refreshFollowUps = React.useCallback(async (sessionId: string) => {
    if (!client) return;
    const items = await client.listFollowUps(sessionId);
    setFollowUpsBySession((current) => ({ ...current, [sessionId]: orderFollowUps(sessionId, items) }));
  }, [client]);

  React.useEffect(() => {
    const sessionId = activeTask?.activeSessionId;
    if (!client || !sessionId) return;
    void refreshFollowUps(sessionId)
      .then(() => undefined)
      .catch((cause) => setResourceError("followUps", cause instanceof Error ? cause.message : "Unable to load queued follow-ups"));
    return undefined;
  }, [activeTask?.activeSessionId, client, refreshFollowUps]);

  React.useEffect(() => {
    const openSearch = () => {
      searchReturnFocusRef.current = document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body
        ? document.activeElement
        : document.querySelector<HTMLElement>("[data-web-search-trigger]");
      setSearchOpen(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        navigateHome();
      } else if (event.key === ",") {
        event.preventDefault();
        navigateToSettings("general");
      } else if (key === "b") {
        event.preventDefault();
        document.querySelector<HTMLElement>("[data-sidebar='trigger']")?.click();
      } else if (key === "k") {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateHome, navigateToSettings]);

  React.useEffect(() => {
    setHydrated(true);
    const theme = window.localStorage.getItem("berry.web.theme") ?? "dark";
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches));
    const language = window.localStorage.getItem("berry.web.language") ?? "system";
    document.documentElement.lang = language === "system" ? navigator.language : language;
  }, []);

  React.useEffect(() => {
    setConnectionState(navigator.onLine ? "online" : "offline");
    const online = () => setConnectionState("online");
    const offline = () => setConnectionState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, []);

  React.useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setTasksLoaded(false);
    void Promise.all([client.listWorkspaces({ includeGeneral: true }), client.listTasks({ includeDeleted: true }), client.modelCatalog(), client.listOrganizations()])
      .then(async ([nextWorkspaces, nextTasks, catalog, organizations]) => {
        if (cancelled) return;
        const liveWorkspaces = nextWorkspaces.length > 0
          ? nextWorkspaces
          : [await client.createWorkspace({ name: "Default project" })];
        if (cancelled) return;
        setWorkspaces(liveWorkspaces);
        setActiveWorkspaceId((current) => liveWorkspaces.some((workspace) => workspace.id === current) ? current : liveWorkspaces[0]!.id);
        setTasks(nextTasks);
        if (organizations.length > 0) {
          setConfig((current) => WebConfigSchema.parse({ ...current, organizations }));
          setActiveOrganizationId((current) => organizations.some((organization) => organization.id === current) ? current : organizations[0]!.id);
        }
        if (catalog) {
          setProviderId(catalog.providerId);
          setModelOptions(catalog.models.map((item) => ({ id: item.id, name: item.name ?? item.id })));
          setModel((current) => catalog.models.some((item) => item.id === current) ? current : catalog.defaultModel);
          setConfig((current) => WebConfigSchema.parse({
            ...current,
            providers: [{
              id: catalog.providerId,
              name: catalog.name,
              kind: "berry-router",
              defaultModel: catalog.defaultModel,
              models: catalog.models.map((item) => ({ id: item.id, name: item.name ?? item.id })),
              enabled: true,
            }],
            skills: catalog.skills,
            mcpServers: catalog.mcpServers,
          }));
        }
      })
      .catch((cause) => setResourceError("tasks", cause instanceof Error ? cause.message : "Unable to load this deployment"))
      .finally(() => { if (!cancelled) setTasksLoaded(true); });
    return () => { cancelled = true; };
  }, [client, fixtureWorkspace]);

  React.useEffect(() => {
    if (shellLocation.kind !== "task") {
      setTaskRouteError(null);
      return;
    }
    if (tasks.some((task) => task.id === shellLocation.taskId)) {
      setTaskRouteError(null);
      return;
    }
    if (!tasksLoaded) return;
    if (taskRouteError) return;
    if (!client) {
      setTaskRouteError("not-found");
      return;
    }
    let cancelled = false;
    setTaskRouteError(null);
    void client.getTask(shellLocation.taskId)
      .then((task) => {
        if (cancelled) return;
        setTasks((current) => current.some((item) => item.id === task.id) ? current : [task, ...current]);
      })
      .catch((cause) => {
        if (cancelled) return;
        setTaskRouteError(cause instanceof BerryApiError && cause.status === 403
          ? "forbidden"
          : cause instanceof BerryApiError && cause.status === 404
            ? "not-found"
            : "failed");
      });
    return () => { cancelled = true; };
  }, [client, shellLocation, taskRouteError, tasks, tasksLoaded]);

  const refreshAdmin = React.useCallback(async () => {
    if (!client || !activeOrganizationId) return;
    if (!shouldRefreshAdministration(effectiveOrgPermissions)) {
      setResourceError("settings", "");
      return;
    }
    const [budgets, usage, billing, policies, defaults, roles, departments, flags, acls, sso, policyVersions, auditSettings, auditEvents, auditExports] = await Promise.allSettled([
      client.listBudgetLimits(activeOrganizationId),
      client.usageDashboard(activeOrganizationId),
      client.billingSummary(activeOrganizationId),
      client.listOrgModels(activeOrganizationId, { includeBlocked: true }),
      client.listOrgModelDefaults(activeOrganizationId),
      client.listRolePermissions(activeOrganizationId),
      client.listDepartments(activeOrganizationId),
      client.listFeatureFlags(activeOrganizationId),
      client.listResourceAcls(activeOrganizationId),
      client.listSsoConnections(activeOrganizationId),
      client.listPolicyVersions(activeOrganizationId),
      client.auditSettings(activeOrganizationId),
      client.listAuditEvents(activeOrganizationId, { limit: 100 }),
      client.listAuditExportConfigs(activeOrganizationId),
    ]);
    const sectionResults = [
      ["budgets", budgets], ["usage", usage], ["billing", billing], ["model policies", policies], ["model defaults", defaults], ["roles", roles], ["departments", departments], ["feature flags", flags], ["resource access", acls], ["SSO", sso], ["policy versions", policyVersions], ["audit settings", auditSettings], ["audit events", auditEvents], ["audit exports", auditExports],
    ] as const;
    const staleSections = sectionResults.filter(([, result]) => result.status === "rejected").map(([name]) => name);
    setResourceError("settings", staleSections.length > 0 ? `Some administration data is stale: ${staleSections.join(", ")}. Retry to refresh.` : "");
    setConfig((current) => WebConfigSchema.parse({
      ...current,
      budgetLimits: settledValue(budgets, current.budgetLimits),
      usageDashboards: replaceTenantValue(current.usageDashboards, activeOrganizationId, settledValue(usage, null)),
      billingSummaries: replaceTenantValue(current.billingSummaries, activeOrganizationId, settledValue(billing, null)),
      modelPolicies: settledValue(policies, current.modelPolicies),
      modelDefaults: settledValue(defaults, current.modelDefaults),
      rolePermissions: settledValue(roles, current.rolePermissions),
      departments: settledValue(departments, current.departments).filter((department: { status?: string }) => department.status !== "disabled"),
      featureFlags: settledValue(flags, current.featureFlags),
      resourceAcls: settledValue(acls, current.resourceAcls),
      ssoConnections: settledValue(sso, current.ssoConnections),
      policyVersions: settledValue(policyVersions, current.policyVersions),
      auditSettings: replaceTenantValue(current.auditSettings, activeOrganizationId, settledValue(auditSettings, null)),
      auditEvents: settledValue(auditEvents, current.auditEvents),
      auditExports: settledValue(auditExports, current.auditExports),
    }));
  }, [activeOrganizationId, client, effectiveOrgPermissions, setResourceError]);

  React.useEffect(() => {
    void refreshAdmin().catch((cause) => setResourceError("settings", cause instanceof Error ? cause.message : "Unable to load administration data"));
  }, [refreshAdmin]);

  const createTask = React.useCallback(async (options?: { title?: string }) => {
    const title = options?.title?.trim().slice(0, 80) || "New cloud task";
    if (client) {
      try {
        const created = await client.createTask({
          workspaceId: activeWorkspaceId,
          conversationKind: "chat",
          title,
          permissionMode,
          modelProviderId: providerId,
          model,
        });
        setTasks((current) => [created.task, ...current]);
        navigateToTask(created.task.id);
        return created.task;
      } catch (cause) {
        setResourceError("tasks", cause instanceof Error ? cause.message : "Unable to create a task");
      }
      return null;
    }
    const id = `task_${tasks.length + 1}`;
    const sessionId = `session_${tasks.length + 1}`;
    const now = "2026-07-10T00:00:00.000Z";
    const task: Task = {
      id,
      workspaceId: activeWorkspaceId,
      title,
      status: "running",
      activeSessionId: sessionId,
      conversationKind: "chat",
      pinned: false,
      archived: false,
      deletedAt: null,
      unreadAt: null,
      lastReadAt: null,
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
      worktreeBaseSha: null,
      pullRequestUrl: null,
      pullRequestNumber: null,
      createdAt: now,
      updatedAt: now,
    };
    setTasks((current) => [task, ...current]);
    navigateToTask(id);
    return task;
  }, [activeWorkspaceId, client, model, navigateToTask, providerId, tasks.length]);

  // Turns belong to sessions, not to the currently rendered task. Keep every
  // active SSE reader at shell scope so navigation only changes which stream
  // is visible; it never owns or cancels server-side execution.
  const trackedSessionsRef = React.useRef(new Set<string>());
  const sessionConnectionsRef = React.useRef(new Map<string, { source: EventSource; reconnectTimer: number | null; attempts: number }>());

  const refreshSessionMessages = React.useCallback(async (sessionId: string) => {
    if (!client) return;
    const nextMessages = await client.listMessages(sessionId);
    replaceSessionMessages(sessionId, (current) => reconcileFetchedSessionMessages(nextMessages, current));
  }, [client, replaceSessionMessages]);

  const stopSessionConnection = React.useCallback((sessionId: string) => {
    trackedSessionsRef.current.delete(sessionId);
    const connection = sessionConnectionsRef.current.get(sessionId);
    if (!connection) return;
    connection.source.close();
    if (connection.reconnectTimer !== null) window.clearTimeout(connection.reconnectTimer);
    sessionConnectionsRef.current.delete(sessionId);
  }, []);

  const attachSessionStream = React.useCallback((sessionId: string) => {
    if (!client) return;
    trackedSessionsRef.current.add(sessionId);
    if (sessionConnectionsRef.current.has(sessionId)) return;

    const connect = (attempts: number) => {
      if (!trackedSessionsRef.current.has(sessionId) || sessionConnectionsRef.current.has(sessionId)) return;
      // The API replays the bounded turn buffer on every connection. Rebuild
      // from IDLE so a reconnect cannot duplicate text or tool deltas.
      if (attempts > 0) resetSessionStream(sessionId);
      let terminal = false;
      const source = client.streamEvents(sessionId, {
        onOpen: () => {
          const current = sessionConnectionsRef.current.get(sessionId);
          if (current) current.attempts = 0;
        },
        onEvent: (event) => {
          updateSessionStream(sessionId, event);
          if (event.kind !== "turn.end") return;
          setTasks((current) => current.map((task) => task.activeSessionId === sessionId ? { ...task, status: event.status } : task));
          terminal = true;
          stopSessionConnection(sessionId);
          void refreshSessionMessages(sessionId)
            .then(() => resetSessionStream(sessionId))
            .catch((cause) => setResourceError("messages", cause instanceof Error ? cause.message : "Unable to refresh the completed turn"));
          void refreshFollowUps(sessionId)
            .catch((cause) => setResourceError("followUps", cause instanceof Error ? cause.message : "Unable to refresh queued follow-ups"));
          void refreshAdmin();
        },
        onError: () => {
          if (terminal || !trackedSessionsRef.current.has(sessionId)) return;
          source.close();
          sessionConnectionsRef.current.delete(sessionId);
          const nextAttempts = attempts + 1;
          const reconnectTimer = window.setTimeout(() => {
            sessionConnectionsRef.current.delete(sessionId);
            connect(nextAttempts);
          }, Math.min(5_000, 500 * (2 ** Math.min(nextAttempts, 4))));
          sessionConnectionsRef.current.set(sessionId, { source, reconnectTimer, attempts: nextAttempts });
        },
      });
      sessionConnectionsRef.current.set(sessionId, { source, reconnectTimer: null, attempts });
    };

    connect(0);
  }, [client, refreshAdmin, refreshFollowUps, refreshSessionMessages, resetSessionStream, stopSessionConnection, updateSessionStream]);

  React.useEffect(() => () => {
    for (const sessionId of [...trackedSessionsRef.current]) stopSessionConnection(sessionId);
  }, [stopSessionConnection]);

  React.useEffect(() => {
    const sessionId = activeTask?.activeSessionId;
    if (!sessionId) return;
    if (!client) {
      setMessagesBySession((current) => current[sessionId]
        ? current
        : { ...current, [sessionId]: fixtureMessages(sessionId) });
      return;
    }
    let cancelled = false;
    void Promise.all([client.listMessages(sessionId), client.turnState(sessionId)])
      .then(([items, state]) => {
        if (cancelled) return;
        replaceSessionMessages(sessionId, (current) => reconcileFetchedSessionMessages(items, current));
        if (state.active) attachSessionStream(sessionId);
        else resetSessionStream(sessionId);
      })
      .catch((cause) => {
        if (!cancelled) setResourceError("messages", cause instanceof Error ? cause.message : "Unable to load this task");
      });
    return () => { cancelled = true; };
  }, [activeTask?.activeSessionId, attachSessionStream, client, replaceSessionMessages, resetSessionStream]);

  const runTurn = React.useCallback(async (
    task: Task,
    params: { input: string; attachments?: AttachmentInput[] | undefined; replaceFromMessageId?: string | undefined; drainQueuedFollowUps?: boolean | undefined },
  ) => {
    if (!client || !task.activeSessionId) return;
    const sessionId = task.activeSessionId;
    const taskWorkspacePath = workspaces.find((workspace) => workspace.id === task.workspaceId)?.path ?? initial.config.workspacePath;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));
    setStartingSessions((current) => new Set(current).add(sessionId));
    updateSessionStream(sessionId, { kind: "turn.start", turnId: `pending_${Date.now()}` });
    // Listen before submitting so early deltas render live instead of being
    // delivered together from the server's replay buffer.
    attachSessionStream(sessionId);
    try {
      await client.startTurn(sessionId, {
        input: params.input,
        workspacePath: taskWorkspacePath,
        workspaceId: task.workspaceId,
        permissionMode,
        provider: { id: providerId },
        model,
        reasoning,
        ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
        ...(params.replaceFromMessageId ? { replaceFromMessageId: params.replaceFromMessageId } : {}),
        ...(params.drainQueuedFollowUps ? { drainQueuedFollowUps: true } : {}),
      });
    } catch (cause) {
      stopSessionConnection(sessionId);
      const error = cause instanceof Error ? cause : new Error("Unable to start the turn");
      updateSessionStream(sessionId, { kind: "error", message: error.message });
      updateSessionStream(sessionId, { kind: "turn.end", turnId: `failed_${Date.now()}`, status: "failed" });
      throw error;
    } finally {
      setStartingSessions((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }, [attachSessionStream, client, initial.config.workspacePath, model, permissionMode, providerId, reasoning, stopSessionConnection, updateSessionStream, workspaces]);

  const cancelTurn = React.useCallback(async () => {
    const sessionId = activeTask?.activeSessionId;
    if (!sessionId) return;
    try {
      if (client) {
        const result = await client.cancelTurn(sessionId);
        if (!result.ok) throw new Error("The active turn could not be cancelled.");
      }
      stopSessionConnection(sessionId);
      updateSessionStream(sessionId, { kind: "turn.end", turnId: streamsBySession[sessionId]?.turnId ?? `cancelled_${Date.now()}`, status: "cancelled" });
      await refreshSessionMessages(sessionId);
      await refreshFollowUps(sessionId);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to stop the active turn");
    }
  }, [activeTask?.activeSessionId, client, refreshFollowUps, refreshSessionMessages, stopSessionConnection, streamsBySession, updateSessionStream]);

  // Edit-and-resubmit: optimistically truncate the local thread at the edited
  // message, then rerun the turn from that point (the API rewinds + persists).
  const editTurn = React.useCallback(async (target: Message, text: string) => {
    if (!activeTask?.activeSessionId) return;
    const sessionId = activeTask.activeSessionId;
    const imageAttachments: AttachmentInput[] = target.parts
      .filter(isImageMessagePart)
      .map((part, index) => {
        const dataUrl = String(part.content ?? "");
        return {
          id: part.id || `edited-image-${index}`,
          name: `image-${index + 1}.png`,
          mediaType: /^data:([^;,]+)[;,]/.exec(dataUrl)?.[1] ?? "image/png",
          size: Math.max(0, Math.floor((dataUrl.length * 3) / 4)),
          sourceKind: "web-upload",
          dataUrl,
        };
      });
    const fileAttachments: AttachmentInput[] = target.parts.flatMap((part) => {
      if (part.kind !== "attachment") return [];
      const parsed = MessageAttachmentContentSchema.safeParse(part.content);
      return parsed.success ? [parsed.data] : [];
    });
    const attachments = [...imageAttachments, ...fileAttachments];
    replaceSessionMessages(sessionId, (current) => {
      const index = current.findIndex((item) => item.id === target.id);
      const kept = index === -1 ? current : current.slice(0, index);
      return [...kept, optimisticUserMessage(sessionId, text, attachments)];
    });
    await runTurn(activeTask, {
      input: text,
      ...(attachments.length > 0 ? { attachments } : {}),
      replaceFromMessageId: target.id,
    });
    await refreshSessionMessages(sessionId);
  }, [activeTask, refreshSessionMessages, replaceSessionMessages, runTurn]);

  const createProject = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("projectName") ?? "").trim();
    if (!name) return;
    try {
      const workspace = client ? await client.createWorkspace({ name }) : { ...fixtureWorkspace, id: `workspace_${Date.now()}`, name };
      setWorkspaces((current) => [...current, workspace]);
      setActiveWorkspaceId(workspace.id);
      navigateHome();
      setCreatingProject(false);
    } catch (cause) {
      setResourceError("workspaces", cause instanceof Error ? cause.message : "Unable to create a project");
    }
  }, [client, fixtureWorkspace, navigateHome]);

  const signOut = React.useCallback(async () => {
    await fetch(`${initial.config.apiBaseUrl ?? ""}/v1/auth/sign-out`, { method: "POST", credentials: "include" });
    onSignedOut?.();
  }, [initial.config.apiBaseUrl, onSignedOut]);

  const saveTaskTitle = React.useCallback(async (title: string) => {
    const nextTitle = title.trim();
    if (!activeTask || !nextTitle || nextTitle === activeTask.title) {
      setEditingTitle(false);
      return;
    }
    setTasks((current) => current.map((task) => task.id === activeTask.id ? { ...task, title: nextTitle } : task));
    setEditingTitle(false);
    if (client) {
      try {
        const updated = await client.updateTask(activeTask.id, { title: nextTitle });
        setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      } catch (cause) {
        setTasks((current) => current.map((task) => task.id === activeTask.id ? activeTask : task));
        toast.error(cause instanceof Error ? cause.message : "Unable to rename the task");
      }
    }
  }, [activeTask, client]);

  const toggleTaskPinned = React.useCallback(async () => {
    if (!activeTask) return;
    const pinned = !activeTask.pinned;
    setTasks((current) => current.map((task) => task.id === activeTask.id ? { ...task, pinned } : task));
    if (client) {
      try {
        const updated = await client.updateTask(activeTask.id, { pinned });
        setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      } catch (cause) {
        setTasks((current) => current.map((task) => task.id === activeTask.id ? activeTask : task));
        toast.error(cause instanceof Error ? cause.message : "Unable to update the task");
      }
    }
  }, [activeTask, client]);

  const deleteTask = React.useCallback(async (task: Task) => {
    const previous = task;
    const deletedAt = new Date().toISOString();
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, deletedAt } : item));
    try {
      if (client) {
        const updated = await client.deleteTask(task.id);
        setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
      if (shellLocation.kind === "task" && shellLocation.taskId === task.id) navigateHome();
    } catch (cause) {
      setTasks((current) => current.map((item) => item.id === previous.id ? previous : item));
      toast.error(cause instanceof Error ? cause.message : "Unable to delete the conversation");
    }
  }, [client, navigateHome, shellLocation]);

  const archiveTask = React.useCallback(async (task: Task, archived: boolean) => {
    const previous = task;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, archived } : item));
    try {
      const updated = client ? await client.updateTask(task.id, { archived }) : { ...task, archived };
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (archived && shellLocation.kind === "task" && shellLocation.taskId === task.id) navigateHome();
    } catch (cause) {
      setTasks((current) => current.map((item) => item.id === previous.id ? previous : item));
      toast.error(cause instanceof Error ? cause.message : "Unable to update the conversation archive");
      throw cause;
    }
  }, [client, navigateHome, shellLocation]);

  const restoreTask = React.useCallback(async (task: Task) => {
    const previous = task;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, deletedAt: null } : item));
    try {
      const updated = client
        ? await client.restoreTask(task.id)
        : { ...task, deletedAt: null };
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setTasks((current) => current.map((item) => item.id === previous.id ? previous : item));
      toast.error(cause instanceof Error ? cause.message : "Unable to restore the conversation");
    }
  }, [client]);

  const removeFollowUp = React.useCallback(async (followUp: QueuedFollowUp) => {
    const previousOrder = savedFollowUpOrder(followUp.sessionId);
    setFollowUpsBySession((current) => ({ ...current, [followUp.sessionId]: (current[followUp.sessionId] ?? []).filter((item) => item.id !== followUp.id) }));
    removeFollowUpOrderId(followUp.sessionId, followUp.id);
    if (!client || isLocalFollowUp(followUp)) return;
    try {
      await client.removeFollowUp(followUp.id);
    } catch (cause) {
      if (previousOrder.length > 0) saveFollowUpOrder(followUp.sessionId, previousOrder);
      setFollowUpsBySession((current) => ({ ...current, [followUp.sessionId]: orderFollowUps(followUp.sessionId, [...(current[followUp.sessionId] ?? []), followUp]) }));
      toast.error(cause instanceof Error ? cause.message : "Unable to remove the follow-up");
    }
  }, [client]);

  const rememberFollowUp = React.useCallback((followUp: QueuedFollowUp, replaceId?: string) => {
    if (replaceId) replaceFollowUpOrderId(followUp.sessionId, replaceId, followUp.id);
    setFollowUpsBySession((current) => ({
      ...current,
      [followUp.sessionId]: orderFollowUps(followUp.sessionId, [
        ...(current[followUp.sessionId] ?? []).filter((item) => item.id !== followUp.id && item.id !== replaceId),
        followUp,
      ]),
    }));
  }, []);

  const markFollowUpFailed = React.useCallback((followUp: QueuedFollowUp, error: string) => {
    rememberFollowUp({ ...followUp, status: "failed", error, updatedAt: new Date().toISOString() });
  }, [rememberFollowUp]);

  const reorderFollowUps = React.useCallback((sessionId: string, orderedIds: string[]) => {
    saveFollowUpOrder(sessionId, orderedIds);
    setFollowUpsBySession((current) => ({
      ...current,
      [sessionId]: orderFollowUps(sessionId, current[sessionId] ?? []),
    }));
    const hasLocalFollowUp = orderedIds.some((id) => id.startsWith(LOCAL_FOLLOW_UP_PREFIX));
    if (!client || hasLocalFollowUp) return;
    void client.reorderFollowUps(sessionId, orderedIds)
      .then((followUps) => setFollowUpsBySession((current) => ({ ...current, [sessionId]: orderFollowUps(sessionId, followUps) })))
      .catch((cause) => toast.error(cause instanceof Error ? cause.message : "Unable to save the queue order"));
  }, [client]);

  const retryFollowUp = React.useCallback(async (followUp: QueuedFollowUp) => {
    if (!isLocalFollowUp(followUp)) {
      const previous = followUp;
      const optimistic = { ...followUp, status: "queued" as const, error: null, pausedReason: null, updatedAt: new Date().toISOString() };
      rememberFollowUp(optimistic);
      if (!client) return;
      try {
        rememberFollowUp(await client.updateFollowUp(followUp.id, { status: "queued", error: null, pausedReason: null }));
      } catch (cause) {
        rememberFollowUp(previous);
        const message = cause instanceof Error ? cause.message : "Unable to retry the follow-up";
        toast.error(message);
        throw cause;
      }
      return;
    }

    const now = new Date().toISOString();
    const optimisticFollowUp: QueuedFollowUp = {
      ...followUp,
      id: `${LOCAL_FOLLOW_UP_PREFIX}${globalThis.crypto.randomUUID()}`,
      status: "queued",
      error: null,
      updatedAt: now,
    };
    rememberFollowUp(optimisticFollowUp, followUp.id);
    if (!client) return;
    try {
      const retried = await client.followUpTurn(followUp.sessionId, { input: followUp.input, attachments: followUp.attachments });
      rememberFollowUp(retried, optimisticFollowUp.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to retry the follow-up";
      markFollowUpFailed(optimisticFollowUp, message);
      toast.error(message);
    }
  }, [client, markFollowUpFailed, rememberFollowUp]);

  const updateFollowUp = React.useCallback(async (followUp: QueuedFollowUp, input: string) => {
    const previous = followUp;
    const optimistic = { ...followUp, input, error: null, updatedAt: new Date().toISOString() };
    rememberFollowUp(optimistic);
    if (!client || isLocalFollowUp(followUp)) return;
    try {
      rememberFollowUp(await client.updateFollowUp(followUp.id, { input }));
    } catch (cause) {
      rememberFollowUp(previous);
      toast.error(cause instanceof Error ? cause.message : "Unable to update the queued prompt");
      throw cause;
    }
  }, [client, rememberFollowUp]);

  const resumeFollowUps = React.useCallback(async (sessionId: string) => {
    if (!client) return;
    try {
      const resumed = await client.resumeFollowUps(sessionId);
      setFollowUpsBySession((current) => ({ ...current, [sessionId]: orderFollowUps(sessionId, resumed) }));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to resume the queue");
      throw cause;
    }
  }, [client]);

  const sendFollowUpNow = React.useCallback(async (followUp: QueuedFollowUp) => {
    if (!client || isLocalFollowUp(followUp)) return;
    if (followUpSendInFlightRef.current.has(followUp.id)) return;
    const task = tasks.find((item) => item.id === followUp.taskId);
    if (!task?.activeSessionId) throw new Error("This queued prompt no longer belongs to an active conversation.");
    const currentlyActive = streamsBySession[followUp.sessionId]?.turnActive || startingSessions.has(followUp.sessionId);
    const previous = followUp;
    followUpSendInFlightRef.current.add(followUp.id);
    rememberFollowUp({ ...followUp, status: "sending", error: null, pausedReason: null, updatedAt: new Date().toISOString() });
    try {
      if (currentlyActive) {
        await client.steerFollowUp(followUp.id);
      } else {
        await client.updateFollowUp(followUp.id, { status: "sending", error: null, pausedReason: null });
        await runTurn(task, {
          input: followUp.input,
          ...(followUp.attachments.length > 0 ? { attachments: followUp.attachments } : {}),
          drainQueuedFollowUps: true,
        });
      }
      await refreshFollowUps(followUp.sessionId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to send the queued prompt";
      if (currentlyActive) {
        rememberFollowUp({ ...previous, status: "failed", error: message, updatedAt: new Date().toISOString() });
      } else {
        try { rememberFollowUp(await client.updateFollowUp(followUp.id, { status: "failed", error: message })); }
        catch { rememberFollowUp({ ...previous, status: "failed", error: message, updatedAt: new Date().toISOString() }); }
      }
      toast.error(message);
      throw cause;
    } finally {
      followUpSendInFlightRef.current.delete(followUp.id);
    }
  }, [client, refreshFollowUps, rememberFollowUp, runTurn, startingSessions, streamsBySession, tasks]);

  const steerActiveTurn = React.useCallback(async (task: Task, input: string, attachments: AttachmentInput[]) => {
    const sessionId = task.activeSessionId;
    if (!client || !sessionId) throw new Error("The active conversation is no longer available.");
    const optimistic = optimisticUserMessage(sessionId, input, attachments);
    replaceSessionMessages(sessionId, (current) => [...current, optimistic]);
    try {
      await client.steerTurn(sessionId, { input, attachments });
      const persisted = [...await client.listMessages(sessionId)].reverse().find((message) => message.role === "user" && fullUserText(message) === input);
      if (!persisted) throw new Error("The running task did not accept this steering message.");
      replaceSessionMessages(sessionId, (current) => confirmOptimisticMessage(current, optimistic.id, persisted));
    } catch (cause) {
      replaceSessionMessages(sessionId, (current) => current.filter((message) => message.id !== optimistic.id));
      throw cause;
    }
  }, [client, replaceSessionMessages]);

  const generateImage = React.useCallback(async (task: Task, prompt: string, appendUserMessage: boolean) => {
    const sessionId = task.activeSessionId;
    const trimmedPrompt = prompt.trim();
    if (!sessionId || !trimmedPrompt) return;
    setImageGenerationBySession((current) => ({
      ...current,
      [sessionId]: { prompt: trimmedPrompt, status: "generating" },
    }));
    try {
      if (!client) throw new Error("Image generation requires the live Berry API");
      if (appendUserMessage) {
        const userMessage = await client.appendMessage(sessionId, {
          role: "user",
          parts: [{ kind: "text", content: `/image ${trimmedPrompt}` }],
        });
        replaceSessionMessages(sessionId, (current) => [...current, userMessage]);
      }
      const result = await client.generateImage({ prompt: trimmedPrompt, size: "1024x1024" });
      const generated = result.data[0];
      let content = generated?.b64_json ? `data:image/png;base64,${generated.b64_json}` : generated?.url;
      if (!content) throw new Error("The image provider returned no image data");
      if (generated?.b64_json) {
        try {
          const blob = await (await fetch(content)).blob();
          const stored = await client.uploadFile(new File([blob], `generated-${Date.now()}.png`, { type: "image/png" }), { taskId: task.id, sessionId, origin: "image_generation", associationRole: "output" });
          content = stored.previewUrl;
        } catch {
          // The generated image still belongs in the conversation when the
          // optional artifact-library copy is temporarily unavailable.
        }
      }
      const assistantMessage = await client.appendMessage(sessionId, {
        role: "assistant",
        parts: [{ kind: "image", content }],
      });
      replaceSessionMessages(sessionId, (current) => [...current, assistantMessage]);
      setImageGenerationBySession((current) => ({ ...current, [sessionId]: null }));
    } catch (cause) {
      setImageGenerationBySession((current) => ({
        ...current,
        [sessionId]: {
          prompt: trimmedPrompt,
          status: "error",
          message: cause instanceof Error ? cause.message : "The image provider could not complete the request",
        },
      }));
    }
  }, [client, replaceSessionMessages]);

  const runSlashCommand = React.useCallback(async (name: string, args: string[]) => {
    if (name === "clear") return;
    if (name === "new") {
      navigateHome();
      return;
    }
    if (name === "help") {
      toast.info("Help is available from the ? button, including diagnostics and support links.");
      return;
    }
    if (name === "mcp") {
      navigateToSettings("mcp");
      return;
    }
    if (name === "skill") {
      navigateToSettings("skills");
      return;
    }
    if (name === "image") {
      const prompt = args.join(" ").trim();
      if (!prompt) throw new Error("Usage: /image <prompt>");
      const task = activeTask ?? await createTask({ title: `Image: ${prompt.slice(0, 56)}` });
      if (!task?.activeSessionId) throw new Error("Unable to create an image task");
      await generateImage(task, prompt, true);
      return;
    }
    if (["compact", "fork", "rewind", "goal", "pr"].includes(name)) {
      throw new Error(`/${name}${args.length ? ` ${args.join(" ")}` : ""} is not available from this cloud deployment yet.`);
    }
    throw new Error(`Unknown command: /${name}`);
  }, [activeTask, createTask, generateImage, navigateHome, navigateToSettings]);

  const projectWorkspaces = React.useMemo(() => workspaces.filter((workspace) => workspace.workspaceKind !== "general"), [workspaces]);
  const generalWorkspace = workspaces.find((workspace) => workspace.workspaceKind === "general") ?? null;
  const visibleTasks = React.useMemo(() => tasks.filter((task) => !task.deletedAt && !task.archived), [tasks]);
  const tasksByWorkspace = React.useMemo(
    () => Object.fromEntries(projectWorkspaces.map((workspace) => [workspace.id, visibleTasks.filter((task) => task.workspaceId === workspace.id)])),
    [projectWorkspaces, visibleTasks],
  );
  const generalTasks = React.useMemo(
    () => generalWorkspace ? visibleTasks.filter((task) => task.workspaceId === generalWorkspace.id) : [],
    [generalWorkspace, visibleTasks],
  );

  return (
    <div className="berry-web-shell" data-testid="web-app-shell" data-hydrated={hydrated}>
      <Toaster position="bottom-right" />
      <BerryShellFrame
        className="berry-web-shell-frame"
        sidebarWidth="min(20vw, 18rem)"
        chrome={
          <WebWindowChrome
            canGoBack={shellLocation.kind !== "home"}
            canGoForward={hydrated}
            onBack={() => window.history.back()}
            onForward={() => window.history.forward()}
          />
        }
        sidebar={surface === "settings" ? (
          <ManagementSidebar kind={managementKind} tab={managementTab} organizations={config.organizations as never} activeOrganizationId={activeOrganizationId} permissions={effectiveOrgPermissions} platformAuthorized={config.platformAuthorized} onNavigate={navigateManagement} onOrganizationChange={setActiveOrganizationId} onBack={navigateBackToWorkspace} />
        ) : (
          <WebSidebar
            workspaces={projectWorkspaces}
            tasksByWorkspace={tasksByWorkspace}
            generalTasks={generalTasks}
            activeWorkspaceId={activeWorkspaceId}
            activeTaskId={activeTask?.id ?? null}
            creatingProject={creatingProject}
            loadError={resourceErrors.workspaces || resourceErrors.tasks}
            user={user}
            onNewTask={() => {
              navigateHome();
            }}
            onCreateProject={() => setCreatingProject(true)}
            onCancelProject={() => setCreatingProject(false)}
            onSubmitProject={(event) => void createProject(event)}
            onSelectWorkspace={(id) => {
              setActiveWorkspaceId(id);
              navigateHome();
            }}
            onOpenTask={(id) => {
              const task = tasks.find((candidate) => candidate.id === id);
              if (task && workspaces.some((workspace) => workspace.id === task.workspaceId)) setActiveWorkspaceId(task.workspaceId);
              navigateToTask(id);
            }}
            onSelectChats={() => {
              if (generalWorkspace) setActiveWorkspaceId(generalWorkspace.id);
              navigateHome();
            }}
            chatsSelected={!activeTask && Boolean(generalWorkspace && activeWorkspaceId === generalWorkspace.id)}
            librarySelected={surface === "library"}
            onSkills={() => navigateToSettings("skills")}
            onLibrary={() => navigateToLibrary("images")}
            onSearch={() => {
              searchReturnFocusRef.current = document.querySelector<HTMLElement>("[data-web-search-trigger]");
              setSearchOpen(true);
            }}
            onSettings={() => navigateToSettings("general")}
            onSignOut={() => void signOut()}
          />
        )}
      >
      <main className="berry-web-main flex h-full min-h-0 flex-col">
        <div className={surface === "task" ? "contents" : "hidden"}>
        {activeTask && !activeTask.deletedAt ? (
        <>
        <BerryTaskHeaderFrame
          leading={
            <>
              <h1 className="berry-task-title min-w-0 truncate">
                {editingTitle ? (
                  <input
                    ref={titleInputRef}
                    autoFocus
                    defaultValue={activeTask?.title ?? "Berry task"}
                    aria-label="Rename task"
                    className="berry-task-title-input min-w-0 max-w-[min(42vw,460px)] px-2"
                    onBlur={(event) => void saveTaskTitle(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveTaskTitle(event.currentTarget.value);
                      } else if (event.key === "Escape") {
                        setEditingTitle(false);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    title="Rename task"
                    className="berry-task-title-input min-w-0 max-w-[min(42vw,460px)] shrink truncate px-2 text-left"
                    onClick={() => setEditingTitle(true)}
                  >
                    {activeTask?.title ?? "Berry task"}
                  </button>
                )}
              </h1>
              {activeWorkspace ? (
                <ProjectSwitcher
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  onSelectWorkspace={(workspaceId) => {
                    setActiveWorkspaceId(workspaceId);
                    const taskId = tasks.find((task) => task.workspaceId === workspaceId && !task.deletedAt && !task.archived)?.id;
                    if (taskId && taskId !== activeTask.id) navigateToTask(taskId);
                    else if (!taskId) navigateHome();
                  }}
                  onCreateProject={() => setCreatingProject(true)}
                />
              ) : null}
              {activeTask?.worktreeBranch ? (
                <span className="berry-task-pill hidden sm:inline-flex" title={activeTask.worktreeBranch}>
                  <GitBranch />
                  <span className="truncate font-mono">{activeTask.worktreeBranch}</span>
                </span>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More actions" className="berry-titlebar-control shrink-0"><Ellipsis /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setEditingTitle(true)}>Rename task</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void toggleTaskPinned()}>{activeTask?.pinned ? <PinOff /> : <Pin />} {activeTask?.pinned ? "Unpin task" : "Pin task"}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void archiveTask(activeTask, true)}>Archive task</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigator.clipboard?.writeText(activeTask?.id ?? "")}>Copy task ID</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void deleteTask(activeTask)}>Delete task</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
          trailing={
            <>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="View all files"
                      onClick={() => setTaskFilesOpen(true)}
                      className="berry-titlebar-control"
                    >
                      <FileSearchIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">View all files</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={activeTask?.pinned ? "Unpin task" : "Pin task"}
                aria-pressed={activeTask?.pinned ?? false}
                onClick={() => void toggleTaskPinned()}
                className="berry-titlebar-control"
              >
                {activeTask?.pinned ? <PinOff /> : <Pin />}
              </Button>
              <WebHelpMenu />
            </>
          }
        />
        <div className="workspace" data-mode="chat">
          <section className="thread-pane berry-task-thread berry-task-thread--chat" aria-label="Thread">
            <Thread
              sessionId={activeTask.activeSessionId ?? activeTask.id}
              taskId={activeTask.id}
              messages={messages}
              stream={stream}
              mode="chat"
              client={client}
              config={config}
              taskTitles={tasks.map((task) => task.title)}
              imageGeneration={imageGenerationBySession[activeTask.activeSessionId ?? activeTask.id] ?? null}
              onRetryImage={(prompt) => void generateImage(activeTask, prompt, false)}
              editTurn={activeTask.activeSessionId ? editTurn : undefined}
              cancelTurn={cancelTurn}
              onViewTaskFiles={() => setTaskFilesOpen(true)}
            />
            <Composer
              config={config}
              activeTask={activeTask}
              taskTitles={tasks.map((task) => task.title)}
              client={client}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onSelectWorkspace={(workspaceId) => {
                setActiveWorkspaceId(workspaceId);
                const taskId = tasks.find((task) => task.workspaceId === workspaceId && !task.deletedAt && !task.archived)?.id;
                if (taskId && taskId !== activeTask.id) navigateToTask(taskId);
                else if (!taskId) navigateHome();
              }}
              onCreateProject={() => setCreatingProject(true)}
              model={model}
              onModelChange={updateModel}
              variant="thread"
              streaming={turnBusy || stream.turnActive}
              reasoning={reasoning}
              onReasoningChange={updateReasoning}
              onCommand={runSlashCommand}
              queuedFollowUps={activeTask.activeSessionId ? followUpsBySession[activeTask.activeSessionId] ?? [] : []}
              onQueuedFollowUp={rememberFollowUp}
              onQueuedFollowUpFailed={markFollowUpFailed}
              onRemoveFollowUp={removeFollowUp}
              onRetryFollowUp={retryFollowUp}
              onReorderFollowUps={reorderFollowUps}
              onSteerFollowUp={sendFollowUpNow}
              onUpdateFollowUp={updateFollowUp}
              onResumeFollowUps={resumeFollowUps}
              onSteerMessage={steerActiveTurn}
              planProgress={planProgressFromConversation(messages, stream)}
              question={stream.question}
              onCreateTask={createTask}
              onCancel={() => void cancelTurn()}
              runTurn={runTurn}
              onUserMessage={(text, sessionId, taskId, attachments) => {
                const user = optimisticUserMessage(sessionId, text, attachments);
                const nextTitle = text.trim().slice(0, 42);
                replaceSessionMessages(sessionId, (current) => [...current, user]);
                setTasks((current) => current.map((task) => task.id === taskId ? { ...task, title: task.title === "New cloud task" ? nextTitle || task.title : task.title } : task));
                if (client && activeTask.title === "New cloud task" && nextTitle) {
                  void client.updateTask(taskId, { title: nextTitle })
                    .catch((cause) => toast.error(cause instanceof Error ? cause.message : "Unable to save the task title"));
                }
                return user.id;
              }}
              onUserMessagePersisted={(sessionId, optimisticMessageId, persistedMessage) => {
                replaceSessionMessages(sessionId, (current) => confirmOptimisticMessage(current, optimisticMessageId, persistedMessage));
              }}
              onAssistantMessage={(text, sessionId) => {
                replaceSessionMessages(sessionId, (current) => [...current, message(`msg_assistant_${Date.now()}`, sessionId, "assistant", text)]);
                resetSessionStream(sessionId);
              }}
              onEvent={updateSessionStream}
            />
          </section>
        </div>
        </>
        ) : shellLocation.kind === "task" ? (
          <TaskRouteState
            state={!tasksLoaded || (!taskRouteError && !activeTask) ? "loading" : activeTask?.deletedAt ? "deleted" : taskRouteError ?? "not-found"}
            onRetry={() => {
              setTaskRouteError(null);
              setTasksLoaded(false);
              window.setTimeout(() => setTasksLoaded(true), 0);
            }}
            onHome={navigateHome}
            onRestore={activeTask?.deletedAt ? () => void restoreTask(activeTask) : undefined}
          />
        ) : (
          <BerryWorkspaceHomeFrame
            logo={<BerryLogo className="berry-home-greeting-logo" alt="" />}
            greeting={greeting()}
            help={<WebHelpMenu />}
            error={Object.values(resourceErrors).find(Boolean) ? <p className="composer-error" role="alert">{Object.values(resourceErrors).find(Boolean)}</p> : undefined}
            composer={(
              <Composer
                config={config}
                activeTask={null}
                taskTitles={tasks.map((task) => task.title)}
                client={client}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                onSelectWorkspace={(workspaceId) => setActiveWorkspaceId(workspaceId)}
                onCreateProject={() => setCreatingProject(true)}
                model={model}
                onModelChange={updateModel}
                variant="home"
                streaming={false}
                reasoning={reasoning}
                onReasoningChange={updateReasoning}
                onCommand={runSlashCommand}
                queuedFollowUps={[]}
                onQueuedFollowUp={rememberFollowUp}
                onQueuedFollowUpFailed={markFollowUpFailed}
                onRemoveFollowUp={removeFollowUp}
                onRetryFollowUp={retryFollowUp}
                onReorderFollowUps={reorderFollowUps}
                onSteerFollowUp={sendFollowUpNow}
                onUpdateFollowUp={updateFollowUp}
                onResumeFollowUps={resumeFollowUps}
                onSteerMessage={steerActiveTurn}
                onCreateTask={createTask}
                onCancel={() => void cancelTurn()}
                runTurn={runTurn}
                onUserMessage={(text, sessionId, _taskId, attachments) => {
                  const user = optimisticUserMessage(sessionId, text, attachments);
                  replaceSessionMessages(sessionId, [user]);
                  return user.id;
                }}
                onUserMessagePersisted={(sessionId, optimisticMessageId, persistedMessage) => {
                  replaceSessionMessages(sessionId, (current) => confirmOptimisticMessage(current, optimisticMessageId, persistedMessage));
                }}
                onAssistantMessage={(text, sessionId) => replaceSessionMessages(sessionId, (current) => [...current, message(`msg_assistant_${Date.now()}`, sessionId, "assistant", text)])}
                onEvent={updateSessionStream}
              />
            )}
          />
        )}
        </div>
        {surface === "settings" ? (
          <ManagementRouteProvider value={{ config, client, tenantId: activeOrganizationId, userId: user?.id ?? null, permissions: effectiveOrgPermissions, tasks, workspaces, onArchiveTask: archiveTask, onDeleteTask: deleteTask, onRestoreTask: restoreTask, onUsePrompt: (prompt) => { window.localStorage.setItem("berry.web.pendingPrompt", prompt); navigateHome(); } }}>
            <Outlet />
          </ManagementRouteProvider>
        ) : null}
        {surface === "library" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <ArtifactLibrary client={client} tab={shellLocation.kind === "library" ? shellLocation.tab : "images"} onTabChange={navigateToLibrary} />
          </div>
        ) : null}
      </main>
      </BerryShellFrame>
      <WebCommandPalette
        open={searchOpen}
        onOpenChange={(open) => {
          setSearchOpen(open);
          if (!open) window.requestAnimationFrame(() => searchReturnFocusRef.current?.focus());
        }}
        tasks={tasks}
        workspaces={workspaces}
        onOpenTask={navigateToTask}
        onSettings={() => navigateToSettings("general")}
        onHelp={() => toast.info("Berry help and diagnostics are available from the ? button.")}
      />
      {activeTask ? (
        <TaskFileLibraryDialog
          open={taskFilesOpen}
          onOpenChange={setTaskFilesOpen}
          client={client}
          taskId={activeTask.id}
          projectTaskIds={tasks.filter((task) => task.workspaceId === activeTask.workspaceId).map((task) => task.id)}
          projectName={workspaces.find((workspace) => workspace.id === activeTask.workspaceId)?.name ?? "this project"}
        />
      ) : null}
      {connectionState !== "online" ? <div className="fixed bottom-3 right-3 z-[80] rounded-full bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg" role="status">{connectionState === "offline" ? "Offline" : "Reconnecting…"}</div> : null}
    </div>
  );
}

/**
 * The web thread renders through the shared desktop presentation
 * (BerryThreadView) with a cloud adapter: message editing rewinds through the
 * API, approvals/questions resolve over HTTP, and fork stays desktop-only.
 */

function optimisticUserMessage(sessionId: string, text: string, attachments: AttachmentInput[] | undefined): Message {
  const id = `${OPTIMISTIC_MESSAGE_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
  const user = message(id, sessionId, "user", text);
  if (!attachments?.length) return user;
  user.parts = [
    ...user.parts,
    ...attachments.map((attachment, index) => ({
      id: `${id}_attachment_${index}`,
      messageId: id,
      kind: "attachment" as const,
      content: messageAttachmentContent(attachment),
      position: index + 1,
      createdAt: user.createdAt,
    })),
  ];
  return user;
}


function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function loadFixtureShellData(config: WebConfig): ShellData {
  const tasks = fixtureTasks();
  return { config, tasks, messages: fixtureMessages(tasks[0]?.activeSessionId ?? "session_cloud") };
}
