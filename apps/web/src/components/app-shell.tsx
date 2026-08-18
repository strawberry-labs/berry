import * as React from "react";
import { ArrowUp, CreditCard, Plus, Settings, Square, X } from "lucide-react";
import { BerryApiClient, BerryApiError, type ImageGenerationCapabilityStatus, type StartTurnRequest } from "@berry/api-client";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { IMAGE_ASPECT_RATIO_DIMENSIONS, MessageAttachmentContentSchema, PersonalizationProfileSchema, messageAttachmentContent, resolveModelCapabilities, type AllowanceBalance, type AttachmentInput, type ImageAspectRatio, type Message, type MessageHistoryPage, type MessagePart, type OrgMembership, type OrgPermission, type PermissionMode, type PersonalizationProfile, type ReasoningLevel, type Task, type TurnIntent, type TurnState, type Workspace } from "@berry/shared";
import { toast } from "sonner";
import { BerryShellFrame } from "@berry/desktop-ui/components/berry-shell";
import { BerryTaskHeaderFrame } from "@berry/desktop-ui/components/berry-task-header";
import { BerryWorkspaceHomeFrame } from "@berry/desktop-ui/components/berry-workspace-home";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import { IDLE, reduceStream, type StreamState } from "@berry/desktop-ui/components/thread-stream";
import { isContinuableAssistantTurn, isImageMessagePart } from "@berry/desktop-ui/components/thread-message-utils";
import { Toaster } from "@berry/desktop-ui/components/ui/sonner";
import type { ImageGenerationState } from "@berry/desktop-ui/components/image-generation";
import type { GeneratedImageView, ImageEditAnnotation } from "@berry/desktop-ui/components/generated-image-gallery";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { Input } from "@berry/desktop-ui/components/ui/input";
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
import { fixtureMessages, message } from "@/lib/fixtures";
import { confirmOptimisticMessage, OPTIMISTIC_MESSAGE_ID_PREFIX, reconcileDurableEventCursor, reconcileFetchedSessionMessages, type DurableEventSequences } from "@/lib/message-reconciliation";
import { WebConfigSchema } from "@/lib/config";
import type { ShellData } from "@/lib/shell-data";
import { parseCloudShellLocation, type ArtifactLibraryTab, type UserSettingsTab } from "@/lib/cloud-shell-state";
import { MentionMenu, useStaticMentions } from "./mention-menu";
import type { PromptEditorHandle } from "./prompt-editor";
import type { SignedInUser } from "./shell/auth-boundary";
import { DeploymentBrandLogo } from "./shell/deployment-brand";
import { ProjectSwitcher } from "./projects/project-switcher";
import { applyDocumentTheme, watchSystemTheme } from "@/lib/theme";
import { ManagementRouteProvider } from "./management/management-route-context";
import { armCompletionSound, notifyBackgroundProgress, notifyTaskCompleted } from "@/lib/task-notifications";
import { assertImagePreviewBounds } from "./library/image-preview-bounds";
import { PREVIEW_LIMITS } from "./library/file-preview-policy";
import { readResponseBytes } from "./library/preview-stream";

function generatedImageTitle(prompt: string): string {
  const title = prompt
    .replace(/^(?:create|generate|draw|render|make)\s+(?:an?\s+)?/i, "")
    .split(/[.!?\n]/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "Generated image";
}

function generatedFetchCredentials(url: string): RequestCredentials {
  if (typeof window === "undefined") return "omit";
  try {
    return new URL(url, window.location.href).origin === window.location.origin ? "include" : "omit";
  } catch {
    return "omit";
  }
}

function generatedImageExtension(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/avif") return "avif";
  if (normalized === "image/gif") return "gif";
  return "png";
}

import { WebSidebar, WebWindowChrome, taskHasUnreadActivity, taskIsInProgress, type SettingsTab } from "./shell/web-sidebar";
import type { ManagementKind } from "./management/management-navigation";
import { WebCommandPalette } from "./shell/web-command-palette";
import { WebHelpMenu } from "./shell/web-help-menu";
import {
  QUEUED_FOLLOW_UP_STORAGE_PREFIX,
  commitQueuedFollowUps,
  createQueuedFollowUp,
  nextQueuedFollowUp,
  readQueuedFollowUps,
  reconcileInterruptedQueuedFollowUps,
  serverQueuedFollowUpToClient,
  writeQueuedFollowUps,
  type QueuedFollowUp,
} from "@/lib/queued-follow-ups";
import { sessionStreamStore } from "@/lib/session-stream-store";
import { readSupportView, stopSupportView, SUPPORT_VIEW_EVENT, SUPPORT_VIEW_STORAGE_KEY, type SupportViewSubject } from "@/lib/support-view";

const ArtifactLibrary = React.lazy(async () => ({
  default: (await import("./library/artifact-library")).ArtifactLibrary,
}));
const TaskFileLibraryDialog = React.lazy(async () => ({
  default: (await import("./library/task-file-library-dialog")).TaskFileLibraryDialog,
}));
const Composer = React.lazy(async () => ({
  default: (await import("./tasks/web-composer")).Composer,
}));
const Thread = React.lazy(async () => ({
  default: (await import("./tasks/web-task-view")).Thread,
}));
const TaskRouteState = React.lazy(async () => ({
  default: (await import("./tasks/task-route-state")).TaskRouteState,
}));
const MessageHistoryBenchmark = React.lazy(async () => ({
  default: (await import("./message-history-benchmark")).MessageHistoryBenchmark,
}));

type StreamEvent = Parameters<typeof reduceStream>[1];

/** Durable run metadata changes at lifecycle/tool boundaries, not per token or
 * progressive tool/image output. Those high-frequency payloads belong only in
 * the per-session stream store; updating shell state for them would wake the
 * navigation, management, and dialog trees. */
export function shouldUpdateDurableStateForEvent(event: StreamEvent): boolean {
  return event.kind !== "message.delta"
    && event.kind !== "tool.update"
    && event.kind !== "image.partial";
}

export function shouldMountTaskSurface(surface: "task" | "settings" | "library"): boolean {
  return surface === "task";
}

const MESSAGE_PAGE_SIZE = 50;
const MAX_AFTER_PAGE_REQUESTS = 256;
const MAX_TRANSCRIPT_CACHE_SESSIONS = 8;

type MessageHistoryState = Pick<MessageHistoryPage, "hasOlder" | "hasNewer" | "oldestSequence" | "newestSequence" | "historyRevision" | "historyDeletionRevision"> & {
  loadingOlder: boolean;
};

/**
 * Recover one queued message without assuming it is in the newest bounded
 * page. The list-page fallback is deliberately only used for a 404 from the
 * new route: during a rolling deploy an older API returns 404 for that route
 * but still serves its legacy array response, which can contain the persisted
 * message. Other errors remain visible so a transient outage cannot be
 * mistaken for a missing message.
 */
export async function findPersistedMessageById(
  client: Pick<BerryApiClient, "getMessage" | "listMessagePage">,
  sessionId: string,
  messageId: string,
): Promise<Message | undefined> {
  try {
    return await client.getMessage(sessionId, messageId);
  } catch (cause) {
    if (!(cause instanceof BerryApiError) || cause.status !== 404) throw cause;
    const fallback = await client.listMessagePage(sessionId, { limit: 200 });
    return fallback.messages.find((message) => message.id === messageId);
  }
}

/** Probe a queued batch with the bounded route first, then perform at most one
 * legacy-array fallback during a rolling deploy. */
export async function findPersistedMessagesByIds(
  client: Pick<BerryApiClient, "getMessage" | "listMessagePage">,
  sessionId: string,
  messageIds: string[],
): Promise<Array<Message | undefined>> {
  if (messageIds.length === 0) return [];
  const results = await Promise.all(messageIds.map(async (messageId) => {
    try {
      return { messageId, message: await client.getMessage(sessionId, messageId) };
    } catch (cause) {
      if (!(cause instanceof BerryApiError) || cause.status !== 404) throw cause;
      return { messageId, message: undefined };
    }
  }));
  const missingIds = results.filter(({ message }) => !message).map(({ messageId }) => messageId);
  if (missingIds.length === 0) return results.map(({ message }) => message);
  const fallback = await client.listMessagePage(sessionId, { limit: 200 });
  const byId = new Map(fallback.messages.map((message) => [message.id, message]));
  return results.map(({ messageId, message }) => message ?? byId.get(messageId));
}

export function mergeMessagePage(
  current: Message[],
  incoming: Message[],
  direction: "replace" | "prepend" | "append",
): Message[] {
  const ordered = direction === "prepend" ? [...incoming, ...current] : direction === "append" ? [...current, ...incoming] : incoming;
  const byId = new Map<string, Message>();
  // Keep the server copy for duplicate IDs. This matters when a settled page
  // overlaps an optimistic/stream projection while older rows are prepended.
  for (const message of direction === "prepend" ? [...current, ...incoming] : ordered) byId.set(message.id, message);
  const seen = new Set<string>();
  return ordered.filter((message) => {
    if (seen.has(message.id)) return false;
    if (byId.get(message.id) !== message) return false;
    seen.add(message.id);
    return true;
  });
}

/**
 * Replace the bounded newest page without discarding older pages already
 * materialized in the shell. The first overlap identifies the retained prefix;
 * a zero-row server page is authoritative and drops every settled row except
 * still-pending optimistic submissions.
 */
export function mergeRefreshedMessagePage(
  current: Message[],
  serverMessages: Message[],
  reconciledMessages: Message[],
  options: { preserveNoOverlap?: boolean } = {},
): Message[] {
  if (serverMessages.length === 0) return reconciledMessages;
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const firstOverlap = current.findIndex((message) => serverIds.has(message.id));
  // A page with no overlap is normally a new bounded snapshot (for example
  // after an external truncate). Revisit loads can also legitimately have no
  // overlap when a large append moved the newest window past the cached tail;
  // callers opt into retaining that known cached prefix for that case.
  const retainedPrefix = firstOverlap < 0
    ? (options.preserveNoOverlap ? current : [])
    : current.slice(0, firstOverlap);
  return mergeMessagePage(retainedPrefix, reconciledMessages, "append");
}

export function historyRevisionChanged(previous: string | null, next: string | null): boolean {
  return previous !== next;
}

export function historyDeletionRevisionChanged(previous: string | null, next: string | null): boolean {
  return previous !== next;
}

/**
 * Older API instances return the original unbounded message array. The API
 * client wraps it as a page with no sequence metadata; it must be treated as
 * a complete compatibility snapshot, never as an after-cursor delta.
 */
export function isLegacyMessageHistoryPage(page: MessageHistoryPage): boolean {
  return page.newestSequence === null && page.cursorPresent === null;
}

export function replayDurableStreamState(state: TurnState): StreamState {
  const parsedStartedAt = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
  const initialState: StreamState = state.active
    && state.turnId
    && Number.isFinite(parsedStartedAt)
    ? { ...IDLE, turnId: state.turnId, turnStartedAt: parsedStartedAt }
    : IDLE;
  const replayEvents = state.active
    && state.turnId
    && !state.bufferedEvents.some((event) => event.kind === "turn.start")
    ? [{
        kind: "turn.start" as const,
        turnId: state.turnId,
        ...(state.continuation ? { continuation: true } : {}),
      }, ...state.bufferedEvents]
    : state.bufferedEvents;
  return replayEvents.reduce(
    (streamState, event) => reduceStream(streamState, event),
    initialState,
  );
}

export function reduceDurableTurnState(
  previous: TurnState | undefined,
  event: StreamEvent,
): TurnState | null {
  const turnId = event.kind === "turn.start" ? event.turnId : previous?.turnId ?? null;
  if (!turnId) return null;
  const base: TurnState = previous ?? {
    active: true,
    turnId,
    bufferedEvents: [],
    replayOnly: false,
    owner: null,
    runState: "queued",
    waitingReason: null,
    nextAction: null,
    error: null,
  };
  if (event.kind === "turn.start") {
    return {
      ...base,
      active: true,
      turnId,
      continuation: event.continuation === true,
      runState: "queued",
      nextAction: "Waiting for worker",
      error: null,
    };
  }
  if (event.kind === "message.start" || event.kind === "message.delta" || event.kind === "message.end") {
    return { ...base, active: true, runState: "calling_model", waitingReason: null, nextAction: "Calling model" };
  }
  if (event.kind === "tool.start" || event.kind === "tool.update" || event.kind === "tool.end") {
    return { ...base, active: true, runState: "executing_tool", waitingReason: null, nextAction: "Running tool" };
  }
  if (event.kind === "approval.request") {
    return { ...base, active: true, runState: "waiting", waitingReason: "approval", nextAction: "Review the pending action to continue" };
  }
  if (event.kind === "question.request") {
    return { ...base, active: true, runState: "waiting", waitingReason: "user_input", nextAction: "Answer the question below to continue" };
  }
  if (event.kind === "approval.resolved" || event.kind === "question.answered") {
    return { ...base, active: true, runState: "executing_tool", waitingReason: null, nextAction: "Resuming the durable run" };
  }
  if (event.kind === "session.note" && event.note === "compacted") {
    return { ...base, active: true, runState: "calling_model", waitingReason: null, nextAction: "Continuing with compacted context" };
  }
  if (event.kind === "error") {
    return { ...base, error: event.message };
  }
  if (event.kind === "turn.end") {
    return {
      ...base,
      active: false,
      runState: event.status,
      waitingReason: null,
      nextAction: null,
    };
  }
  return base;
}

export function durableTurnPhase(state: TurnState | undefined): string | undefined {
  if (!state?.active) return undefined;
  if (state.nextAction === "Submitting the turn") return "Submitting";
  if (state.nextAction === "Preparing context" || state.runState === "assembling_context") return "Preparing context";
  if (state.runState === "queued") return "Waiting for worker";
  if (state.runState === "calling_model") return "Calling model";
  if (state.runState === "executing_tool") return "Running tool";
  return state.nextAction ?? undefined;
}

export type { ShellData } from "@/lib/shell-data";

export function initialCloudContent(initial: ShellData): Pick<ShellData, "tasks" | "messages"> {
  return initial.config.demoMode
    ? { tasks: initial.tasks, messages: initial.messages }
    : { tasks: [], messages: [] };
}

export function shouldRefreshAdministration(permissions: readonly OrgPermission[]): boolean {
  return permissions.includes("org:admin");
}

export function mergeTaskSnapshots(current: Task[], server: Task[]): Task[] {
  const serverById = new Map(server.map((task) => [task.id, task]));
  const currentIds = new Set(current.map((task) => task.id));
  return [
    ...current.map((task) => serverById.get(task.id) ?? task),
    ...server.filter((task) => !currentIds.has(task.id)),
  ];
}

export function shouldConfirmTurnAdmission(cause: unknown): boolean {
  return !(cause instanceof BerryApiError)
    || cause.status === 408
    || cause.status === 429
    || cause.status >= 500;
}

export function shouldKeepTurnPendingAfterFailedConfirmation(cause: unknown): boolean {
  return shouldConfirmTurnAdmission(cause)
    || (cause instanceof BerryApiError && cause.status === 409);
}

export async function activeTurnStateAfterConflict(
  client: Pick<BerryApiClient, "turnState">,
  sessionId: string,
  cause: unknown,
): Promise<TurnState | null> {
  if (!(cause instanceof BerryApiError) || cause.status !== 409) return null;
  const state = await client.turnState(sessionId);
  return state.active ? state : null;
}

export function clearDurableEventReplayBoundary(
  sessionId: string,
  cursors: Map<string, string>,
  sequences: Map<string, DurableEventSequences>,
): void {
  cursors.delete(sessionId);
  sequences.delete(sessionId);
}

export async function retryTurnAdmission(
  client: Pick<BerryApiClient, "startTurn" | "turnState">,
  sessionId: string,
  request: StartTurnRequest,
): Promise<{ started: { turnId: string; sessionId: string }; state: TurnState | null }> {
  const started = await client.startTurn(sessionId, request);
  const state = await client.turnState(sessionId).catch(() => null);
  return { started, state };
}

export async function revokeAuthSession(
  baseUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    retryDelaysMs?: readonly number[];
  } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retryDelaysMs = options.retryDelaysMs ?? [0, 250, 1_000];
  let lastError: unknown = new Error("Unable to revoke the server session");
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/auth/sign-out`, {
        method: "POST",
        credentials: "include",
      });
      if (response.ok || response.status === 401) return;
      lastError = new Error(`Server logout failed with status ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}

export function isInterruptedTurnAvailable(
  streamEndStatus: StreamState["endStatus"],
  runState: TurnState["runState"],
  messages: Message[],
): boolean {
  const currentTerminalState = streamEndStatus ?? runState ?? null;
  return currentTerminalState === "failed"
    || currentTerminalState === "cancelled"
    || currentTerminalState === "recovery_required"
    || (currentTerminalState !== "completed" && isContinuableAssistantTurn(messages));
}

export async function continueAfterMessageRefresh(
  refreshMessages: () => Promise<void>,
  startContinuation: () => Promise<void>,
): Promise<void> {
  await refreshMessages();
  await startContinuation();
}

export function shouldShowComposerProjectSwitcher(messages: readonly unknown[]): boolean {
  return messages.length === 0;
}

type ModelSelection = { providerId: string; model: string };
type ModelSelectionSource = "organization" | "session" | "user";

export function preferredNewTaskModel(
  browserModel: ModelSelection | null,
  organizationModel: ModelSelection | null,
  availableModels: readonly { id: string }[],
): (ModelSelection & { source: "organization" | "user" }) | null {
  if (
    browserModel
    && (
      !organizationModel
      || browserModel.providerId !== organizationModel.providerId
      || availableModels.length === 0
      || availableModels.some((item) => item.id === browserModel.model)
    )
  ) {
    return { ...browserModel, source: "user" };
  }
  return organizationModel ? { ...organizationModel, source: "organization" } : null;
}

export async function hydratedExistingTaskModel(
  loadedSessionModel: Promise<ModelSelection | null>,
  explicitSessionModel: () => ModelSelection | null,
): Promise<(ModelSelection & { source: "session" | "user" }) | null> {
  const loaded = await loadedSessionModel;
  const explicit = explicitSessionModel();
  if (explicit) return { ...explicit, source: "user" };
  return loaded ? { ...loaded, source: "session" } : null;
}

export function existingTaskTurnModelOverride(
  explicitSessionModel: ModelSelection | null,
): { provider?: { id: string }; model?: string } {
  return explicitSessionModel
    ? { provider: { id: explicitSessionModel.providerId }, model: explicitSessionModel.model }
    : {};
}

export function newTaskModelOverride(
  source: ModelSelectionSource,
  providerId: string,
  model: string,
): { modelProviderId?: string; model?: string } {
  return source === "user" ? { modelProviderId: providerId, model } : {};
}

type PendingTurnSubmission = {
  operationId: string;
  controller: AbortController;
  cancelRequested: boolean;
};

export function prepareTurnCancellation(
  pending: PendingTurnSubmission | undefined,
): { operationId?: string } {
  if (!pending) return {};
  pending.cancelRequested = true;
  pending.controller.abort();
  return { operationId: pending.operationId };
}

export function AppShell({ initial, user, onSignedOut }: {
  initial: ShellData;
  user: SignedInUser | null;
  onSignedOut?: (() => void) | undefined;
}) {
  const [benchmark, setBenchmark] = React.useState(false);
  React.useEffect(() => {
    setBenchmark(
      initial.config.demoMode
      && import.meta.env.DEV
      && new URLSearchParams(window.location.search).get("benchmark") === "message-history",
    );
  }, [initial.config.demoMode]);
  if (benchmark) return <React.Suspense fallback={<LazySurfaceFallback label="Loading benchmark" />}><MessageHistoryBenchmark /></React.Suspense>;
  return <CloudShell initial={initial} user={user} onSignedOut={onSignedOut} />;
}

function CloudShell({ initial, user, onSignedOut }: { initial: ShellData; user: SignedInUser | null; onSignedOut?: (() => void) | undefined }) {
  const location = useLocation();
  const navigate = useNavigate();
  const shellLocation = React.useMemo(() => parseCloudShellLocation(location.pathname), [location.pathname]);
  const bootstrapContent = initialCloudContent(initial);
  const [config, setConfig] = React.useState(initial.config);
  const [hydrated, setHydrated] = React.useState(false);
  const [homeGreeting, setHomeGreeting] = React.useState("Welcome");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [taskFilesOpen, setTaskFilesOpen] = React.useState(false);
  const searchReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const [connectionState, setConnectionState] = React.useState<"online" | "offline" | "reconnecting">("online");
  const [supportView, setSupportView] = React.useState<SupportViewSubject | null>(null);
  const supportViewRef = React.useRef<SupportViewSubject | null>(null);
  const [supportViewActorId, setSupportViewActorId] = React.useState<string | null>(null);
  const supportViewReady = supportViewActorId === (user?.id ?? "");
  const resetSupportRuntimeRef = React.useRef<() => void>(() => undefined);
  const [tasks, setTasks] = React.useState(bootstrapContent.tasks);
  React.useEffect(() => armCompletionSound(), []);
  const [personalization, setPersonalization] = React.useState<PersonalizationProfile>(() => PersonalizationProfileSchema.parse({}));
  const tasksRef = React.useRef(tasks);
  React.useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  const [followUpsBySession, setFollowUpsBySession] = React.useState<Record<string, QueuedFollowUp[]>>({});
  const client = React.useMemo(() => supportViewReady && initial.config.apiBaseUrl && !initial.config.demoMode
    ? new BerryApiClient({
        baseUrl: initial.config.apiBaseUrl,
        ...(supportView ? { supportView: { tenantId: supportView.tenantId, userId: supportView.userId } } : {}),
      })
    : null, [initial.config.apiBaseUrl, initial.config.demoMode, supportView?.tenantId, supportView?.userId, supportViewReady]);
  const [threadScrollRequest, setThreadScrollRequest] = React.useState<{ sessionId: string; id: number } | null>(null);
  const followUpsBySessionRef = React.useRef(followUpsBySession);
  const queuePersistenceErrorShownRef = React.useRef(false);
  const editingFollowUpIdsRef = React.useRef(new Map<string, string>());
  const updateSessionFollowUps = React.useCallback((
    sessionId: string,
    update: (current: QueuedFollowUp[]) => QueuedFollowUp[],
  ) => {
    if (client) {
      const current = followUpsBySessionRef.current[sessionId] ?? [];
      const followUps = update(current);
      followUpsBySessionRef.current = { ...followUpsBySessionRef.current, [sessionId]: followUps };
      setFollowUpsBySession((state) => ({ ...state, [sessionId]: followUps }));
      return;
    }
    const { followUps, persisted } = commitQueuedFollowUps(
      followUpsBySessionRef.current,
      sessionId,
      update,
    );
    if (!persisted && !queuePersistenceErrorShownRef.current) {
      queuePersistenceErrorShownRef.current = true;
      toast.error("This queue could not be saved in this browser. Keep this tab open or remove large attachments.");
    } else if (persisted) {
      queuePersistenceErrorShownRef.current = false;
    }
    setFollowUpsBySession((current) => ({ ...current, [sessionId]: followUps }));
  }, [client]);
  const requestThreadBottom = React.useCallback((sessionId: string) => {
    setThreadScrollRequest((current) => ({ sessionId, id: (current?.id ?? 0) + 1 }));
  }, []);
  const [activeTaskId, setActiveTaskId] = React.useState(shellLocation.kind === "task" ? shellLocation.taskId : "");
  const activeTaskIdRef = React.useRef(activeTaskId);
  React.useEffect(() => { activeTaskIdRef.current = activeTaskId; }, [activeTaskId]);
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
    name: "Tasks",
    workspaceKind: "general",
  }), [fixtureWorkspace, initial.config.workspaceId, initial.config.workspacePath]);
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([fixtureWorkspace, fixtureGeneralWorkspace]);
  const [activeWorkspaceId, setActiveWorkspaceId] = React.useState(initial.config.workspaceId);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const taskTitles = React.useMemo(() => tasks.map((task) => task.title), [tasks]);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const bootstrapSessionId = bootstrapContent.tasks[0]?.activeSessionId ?? null;
  const [messagesBySession, setMessagesBySession] = React.useState<Record<string, Message[]>>(() =>
    bootstrapSessionId ? { [bootstrapSessionId]: bootstrapContent.messages } : {},
  );
  const messagesBySessionRef = React.useRef(messagesBySession);
  React.useEffect(() => {
    messagesBySessionRef.current = messagesBySession;
  }, [messagesBySession]);
  const [messageHistoryBySession, setMessageHistoryBySession] = React.useState<Record<string, MessageHistoryState>>({});
  React.useEffect(() => {
    const applySupportView = (next: SupportViewSubject | null) => {
      const current = supportViewRef.current;
      const identityChanged = current?.tenantId !== next?.tenantId || current?.userId !== next?.userId;
      if (identityChanged && (next || current)) {
        resetSupportRuntimeRef.current();
        tasksRef.current = [];
        messagesBySessionRef.current = {};
        followUpsBySessionRef.current = {};
        setTasks([]);
        setWorkspaces([]);
        setMessagesBySession({});
        setMessageHistoryBySession({});
        setDurableStatesBySession({});
        setImageGenerationBySession({});
        setFollowUpsBySession({});
        setStartingSessions(new Set());
        setThreadScrollRequest(null);
        setActiveTaskId("");
        setActiveWorkspaceId("");
        setSearchOpen(false);
        setTaskFilesOpen(false);
        setCreatingProject(false);
        setEditingTitle(false);
        setAllowance(null);
        setAllowanceLoading(false);
        setResourceErrors({ workspaces: "", tasks: "", messages: "", stream: "", settings: "" });
        setTaskRouteError(null);
        setTasksLoaded(false);
        sessionStreamStore.clear();
      }
      supportViewRef.current = next;
      setSupportView(next);
    };
    const syncSupportView = () => applySupportView(readSupportView(user?.id));
    syncSupportView();
    setSupportViewActorId(user?.id ?? "");
    const onSupportViewChanged = () => syncSupportView();
    const onSupportViewStorageChanged = (event: StorageEvent) => {
      if (event.key === SUPPORT_VIEW_STORAGE_KEY || event.key === null) syncSupportView();
    };
    window.addEventListener(SUPPORT_VIEW_EVENT, onSupportViewChanged);
    window.addEventListener("storage", onSupportViewStorageChanged);
    return () => {
      window.removeEventListener(SUPPORT_VIEW_EVENT, onSupportViewChanged);
      window.removeEventListener("storage", onSupportViewStorageChanged);
    };
  }, [user?.id]);
  const messageHistoryRef = React.useRef(new Map<string, MessageHistoryState>());
  const transcriptLruRef = React.useRef(new Map<string, number>(
    bootstrapSessionId ? [[bootstrapSessionId, Date.now()]] : [],
  ));
  const requestedSurface = shellLocation.kind === "settings" || shellLocation.kind === "admin" || shellLocation.kind === "platform" ? "settings" : shellLocation.kind === "library" ? "library" : "task";
  const surface = supportView && requestedSurface !== "task" ? "task" : requestedSurface;
  const managementKind: ManagementKind = shellLocation.kind === "admin" ? "admin" : shellLocation.kind === "platform" ? "platform" : "settings";
  const managementTab = shellLocation.kind === "settings" || shellLocation.kind === "admin" || shellLocation.kind === "platform" ? shellLocation.tab : "general";
  React.useEffect(() => {
    if (surface !== "task") setTaskFilesOpen(false);
  }, [surface]);
  React.useEffect(() => {
    if (!supportView || requestedSurface === "task") return;
    void navigate({ to: "/", replace: true });
  }, [navigate, requestedSurface, supportView]);
  const [durableStatesBySession, setDurableStatesBySession] = React.useState<Record<string, TurnState>>({});
  const [imageGenerationBySession, setImageGenerationBySession] = React.useState<Record<string, ImageGenerationState | null>>({});
  const [imageGenerationCapability, setImageGenerationCapability] = React.useState<ImageGenerationCapabilityStatus>(() => initial.config.demoMode
    ? { available: true, model: "fixture-image", reason: null, message: null }
    : { available: false, model: null, reason: "loading", message: "Checking image generation availability…" });
  const [startingSessions, setStartingSessions] = React.useState<Set<string>>(() => new Set());
  const permissionMode = "full-access" satisfies PermissionMode;
  const [reasoning, setReasoning] = React.useState<ReasoningLevel>("medium");
  const [resourceErrors, setResourceErrors] = React.useState<Record<"workspaces" | "tasks" | "messages" | "stream" | "settings", string>>({ workspaces: "", tasks: "", messages: "", stream: "", settings: "" });
  const setResourceError = React.useCallback((resource: keyof typeof resourceErrors, message: string) => setResourceErrors((current) => ({ ...current, [resource]: message })), []);
  const [tasksLoaded, setTasksLoaded] = React.useState(initial.config.demoMode);
  const [taskRouteError, setTaskRouteError] = React.useState<"not-found" | "forbidden" | "failed" | null>(null);
  const [creatingProject, setCreatingProject] = React.useState(false);
  const mainPanelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => () => {
    // The store is module-scoped so task subscribers can stay narrow. Clear
    // it when the authenticated shell leaves the tree (sign-out/user switch)
    // so a later session cannot inherit stale live output or pending frames.
    sessionStreamStore.clear();
  }, []);
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
  const providerIdRef = React.useRef(providerId);
  const modelRef = React.useRef(model);
  const organizationModelRef = React.useRef<{ providerId: string; model: string } | null>(null);
  const browserModelRef = React.useRef<{ providerId: string; model: string } | null>(null);
  const sessionModelsRef = React.useRef(new Map<string, ModelSelection>());
  const explicitSessionModelsRef = React.useRef(new Map<string, ModelSelection>());
  const modelSelectionSourceRef = React.useRef<ModelSelectionSource>("organization");
  const applyModelSelection = React.useCallback((nextProviderId: string, nextModel: string, source: ModelSelectionSource) => {
    providerIdRef.current = nextProviderId;
    modelRef.current = nextModel;
    modelSelectionSourceRef.current = source;
    setProviderId(nextProviderId);
    setModel(nextModel);
  }, []);
  const inProgressTaskIds = tasks.filter(taskIsInProgress).map((task) => task.id);
  const inProgressTaskIdsKey = [...inProgressTaskIds].sort().join(",");
  const hasInProgressTasks = inProgressTaskIds.length > 0;

  React.useEffect(() => {
    const storedReasoning = window.localStorage.getItem("berry.web.reasoning");
    const storedModel = window.localStorage.getItem("berry.web.model")?.trim();
    const storedProviderId = window.localStorage.getItem("berry.web.modelProviderId")?.trim()
      || defaultProvider?.id
      || "router";
    if (storedReasoning === "off" || storedReasoning === "low" || storedReasoning === "medium" || storedReasoning === "high" || storedReasoning === "xhigh") setReasoning(storedReasoning);
    if (storedModel) {
      browserModelRef.current = { providerId: storedProviderId, model: storedModel };
      applyModelSelection(storedProviderId, storedModel, "user");
    }
  }, [applyModelSelection, defaultProvider?.id]);
  const updateReasoning = React.useCallback((next: ReasoningLevel) => { setReasoning(next); window.localStorage.setItem("berry.web.reasoning", next); }, []);
  const updateModel = React.useCallback((next: string) => {
    const browserSelection = { providerId: providerIdRef.current, model: next };
    browserModelRef.current = browserSelection;
    const sessionId = activeTask?.activeSessionId;
    if (sessionId) {
      sessionModelsRef.current.set(sessionId, browserSelection);
      explicitSessionModelsRef.current.set(sessionId, browserSelection);
    }
    window.localStorage.setItem("berry.web.modelProviderId", browserSelection.providerId);
    window.localStorage.setItem("berry.web.model", browserSelection.model);
    applyModelSelection(providerIdRef.current, next, "user");
  }, [activeTask?.activeSessionId, applyModelSelection]);
  const [editingTitle, setEditingTitle] = React.useState(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const findPersistedMessage = React.useCallback(async (sessionId: string, messageId: string): Promise<Message | undefined> => {
    if (!client) return undefined;
    return findPersistedMessageById(client, sessionId, messageId);
  }, [client]);
  const [allowance, setAllowance] = React.useState<AllowanceBalance | null>(null);
  const [allowanceLoading, setAllowanceLoading] = React.useState(false);
  const refreshAllowance = React.useCallback(() => {
    if (!client || !activeOrganizationId || !user || supportView) {
      setAllowance(null);
      return;
    }
    setAllowanceLoading(true);
    void client.myAllowanceBalance(activeOrganizationId)
      .then(setAllowance)
      .catch(() => setAllowance(null))
      .finally(() => setAllowanceLoading(false));
  }, [activeOrganizationId, client, supportView, user]);
  React.useEffect(() => refreshAllowance(), [refreshAllowance]);
  React.useEffect(() => {
    if (!client || supportView) return;
    let cancelled = false;
    void client.personalizationProfile()
      .then(async (profile) => {
        const legacyInstructions = window.localStorage.getItem("berry.web.customInstructions")?.trim() ?? "";
        const next = !profile.customInstructions && legacyInstructions
          ? await client.updatePersonalizationProfile({ ...profile, customInstructions: legacyInstructions })
          : profile;
        if (cancelled) return;
        setPersonalization(next);
        if (legacyInstructions && next.customInstructions === legacyInstructions) window.localStorage.removeItem("berry.web.customInstructions");
      })
      .catch((cause) => {
        if (!cancelled) setResourceError("settings", cause instanceof Error ? cause.message : "Unable to load personalization");
      });
    return () => { cancelled = true; };
  }, [client, setResourceError, supportView]);
  React.useEffect(() => {
    if (!client || !activeOrganizationId || supportView) {
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
  }, [activeOrganizationId, client, fallbackOrgPermissions, supportView]);
  // A queued item can be triggered from its card, keyboard shortcut, or a
  // reconciliation refresh. Keep one browser-side lock per item so those
  // paths cannot start two turns for the same prompt.
  const followUpSendInFlightRef = React.useRef(new Set<string>());
  const activeSessionsRef = React.useRef(new Set<string>());
  const pendingSubmissionsRef = React.useRef(new Map<string, PendingTurnSubmission>());
  const pendingRequestMessageIdsBySessionRef = React.useRef(new Map<string, Set<string>>());
  const activeSessionId = activeTask?.activeSessionId ?? null;
  // Async history work can outlive a route change. Keep the active id and
  // connection closer current than any callback closure so an old response
  // cannot evict the newly selected task.
  const activeSessionIdRef = React.useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const stopSessionConnectionRef = React.useRef<(sessionId: string) => void>(() => undefined);
  const historyRequestTailsRef = React.useRef(new Map<string, Promise<void>>());
  const historyEpochRef = React.useRef(new Map<string, number>());
  const messages = activeSessionId ? messagesBySession[activeSessionId] ?? [] : [];
  const activeMessageHistory = activeSessionId ? messageHistoryBySession[activeSessionId] : undefined;
  // Keep token-frequency state outside the shell so only task-surface
  // subscribers rerender while a response is streaming.
  const stream = activeSessionId ? sessionStreamStore.get(activeSessionId) : IDLE;
  const durableState = activeSessionId ? durableStatesBySession[activeSessionId] : undefined;
  const turnBusy = activeSessionId ? startingSessions.has(activeSessionId) : false;
  const interruptedTurnAvailable = isInterruptedTurnAvailable(
    stream.endStatus,
    durableState?.runState,
    messages,
  );

  const replaceSessionMessages = React.useCallback((sessionId: string, next: Message[] | ((current: Message[]) => Message[])) => {
    transcriptLruRef.current.delete(sessionId);
    transcriptLruRef.current.set(sessionId, Date.now());
    const evicted: string[] = [];
    // Keep the transcript cache hard-bounded. Only the currently rendered
    // session is protected; a background turn continues on the server and is
    // rehydrated from turn-state/history when the user returns to it.
    while (transcriptLruRef.current.size > MAX_TRANSCRIPT_CACHE_SESSIONS) {
      const candidate = [...transcriptLruRef.current.keys()].find((id) =>
        id !== sessionId && id !== activeSessionIdRef.current,
      );
      if (!candidate) break;
      transcriptLruRef.current.delete(candidate);
      evicted.push(candidate);
    }
    setMessagesBySession((current) => {
      const candidate = typeof next === "function" ? next(current[sessionId] ?? []) : next;
      const updated = { ...current, [sessionId]: mergeMessagePage([], candidate, "append") };
      for (const id of evicted) delete updated[id];
      return updated;
    });
    if (evicted.length > 0) {
      // Keep eviction side effects outside React state updaters. StrictMode
      // may evaluate an updater more than once; cancellation, teardown, and
      // epoch changes must happen exactly once.
      for (const id of evicted) {
        const pending = pendingSubmissionsRef.current.get(id);
        if (pending) prepareTurnCancellation(pending);
        stopSessionConnectionRef.current(id);
        activeSessionsRef.current.delete(id);
        messageHistoryRef.current.delete(id);
        historyEpochRef.current.set(id, (historyEpochRef.current.get(id) ?? 0) + 1);
        if (!historyRequestTailsRef.current.has(id)) historyEpochRef.current.delete(id);
        pendingRequestMessageIdsBySessionRef.current.delete(id);
        pendingSubmissionsRef.current.delete(id);
        sessionStreamStore.delete(id);
        lastEventCursorBySessionRef.current.delete(id);
        durableEventSequencesBySessionRef.current.delete(id);
        sessionModelsRef.current.delete(id);
        explicitSessionModelsRef.current.delete(id);
        editingFollowUpIdsRef.current.delete(id);
      }
      setMessageHistoryBySession((current) => {
        const updated = { ...current };
        for (const id of evicted) delete updated[id];
        return updated;
      });
      const nextFollowUps = { ...followUpsBySessionRef.current };
      for (const id of evicted) delete nextFollowUps[id];
      followUpsBySessionRef.current = nextFollowUps;
      setFollowUpsBySession((current) => {
        const updated = { ...current };
        for (const id of evicted) {
          delete updated[id];
        }
        return updated;
      });
      setDurableStatesBySession((current) => {
        const updated = { ...current };
        for (const id of evicted) delete updated[id];
        return updated;
      });
      setImageGenerationBySession((current) => {
        const updated = { ...current };
        for (const id of evicted) delete updated[id];
        return updated;
      });
      setStartingSessions((current) => {
        const updated = new Set(current);
        for (const id of evicted) updated.delete(id);
        return updated;
      });
    }
  }, []);

  const markRequestMessagePending = React.useCallback((sessionId: string, messageId: string) => {
    const pending = pendingRequestMessageIdsBySessionRef.current.get(sessionId) ?? new Set<string>();
    pending.add(messageId);
    pendingRequestMessageIdsBySessionRef.current.set(sessionId, pending);
  }, []);

  const clearPendingRequestMessage = React.useCallback((sessionId: string, messageId: string | undefined) => {
    if (!messageId) return;
    const pending = pendingRequestMessageIdsBySessionRef.current.get(sessionId);
    if (!pending) return;
    pending.delete(messageId);
    if (pending.size === 0) pendingRequestMessageIdsBySessionRef.current.delete(sessionId);
  }, []);

  const reconcileSessionMessageSnapshot = React.useCallback((
    sessionId: string,
    serverMessages: Message[],
    localMessages: Message[],
  ) => {
    const pending = pendingRequestMessageIdsBySessionRef.current.get(sessionId);
    return reconcileFetchedSessionMessages(serverMessages, localMessages, pending ? new Set(pending) : new Set());
  }, []);

  const clearPersistedRequestMessages = React.useCallback((sessionId: string, serverMessages: Message[]) => {
    const pending = pendingRequestMessageIdsBySessionRef.current.get(sessionId);
    if (!pending) return;
    for (const message of serverMessages) pending.delete(message.id);
    if (pending.size === 0) pendingRequestMessageIdsBySessionRef.current.delete(sessionId);
  }, []);

  const updateSessionStream = React.useCallback((sessionId: string, event: Parameters<typeof reduceStream>[1]) => {
    sessionStreamStore.update(sessionId, event);
  }, []);

  const resetSessionStream = React.useCallback((sessionId: string) => {
    sessionStreamStore.reset(sessionId);
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
    void navigate({ to: "/settings/$tab", params: { tab: tab as UserSettingsTab } });
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

  React.useEffect(() => {
    if (!client || !activeTask || !taskHasUnreadActivity(activeTask)) return;
    const taskId = activeTask.id;
    const readThrough = activeTask.unreadAt;
    if (!readThrough) return;
    void client.updateTask(taskId, { read: true, readThrough })
      .then((updated) => setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)))
      .catch(() => undefined);
  }, [activeTask, client]);

  React.useEffect(() => {
    const sessionId = activeTask?.activeSessionId;
    if (!sessionId) return;
    let cancelled = false;
    if (!client) {
      setFollowUpsBySession((current) => {
        if (sessionId in current) return current;
        const result = { ...current, [sessionId]: readQueuedFollowUps(sessionId) };
        followUpsBySessionRef.current = result;
        return result;
      });
      return () => { cancelled = true; };
    }
    const legacy = readQueuedFollowUps(sessionId);
    void (async () => {
      const migrated: string[] = [];
      for (const item of legacy) {
        if (item.attachments.some((attachment) => !attachment.fileId)) continue;
        try {
          await client.enqueueQueuedFollowUp(sessionId, {
            taskId: item.taskId,
            workspaceId: activeTask.workspaceId,
            input: item.input,
            ...(item.intent ? { intent: item.intent } : {}),
            attachments: item.attachments,
            idempotencyKey: item.id,
          });
          migrated.push(item.id);
        } catch {
          // Keep only eligible, bounded legacy rows for a later retry. The
          // server remains authoritative once migration succeeds.
        }
      }
      if (migrated.length > 0) {
        const remaining = legacy.filter((item) => !migrated.includes(item.id));
        writeQueuedFollowUps(sessionId, remaining);
      }
      const page = await client.listQueuedFollowUps(sessionId, { limit: 100 });
      if (cancelled) return;
      const next = { ...followUpsBySessionRef.current, [sessionId]: page.items.map(serverQueuedFollowUpToClient) };
      followUpsBySessionRef.current = next;
      setFollowUpsBySession(next);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeTask?.activeSessionId, activeTask?.workspaceId, client]);

  React.useEffect(() => {
    if (client) return;
    const onStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith(QUEUED_FOLLOW_UP_STORAGE_PREFIX)) return;
      const sessionId = event.key.slice(QUEUED_FOLLOW_UP_STORAGE_PREFIX.length);
      if (!sessionId) return;
      const next = readQueuedFollowUps(sessionId);
      setFollowUpsBySession((current) => {
        const result = { ...current, [sessionId]: next };
        followUpsBySessionRef.current = result;
        return result;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [client]);

  React.useEffect(() => {
    const openSearch = () => {
      searchReturnFocusRef.current = document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body
        ? document.activeElement
        : document.querySelector<HTMLElement>("[data-web-search-trigger]");
      setSearchOpen(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (!event.altKey && key === "o") {
          event.preventDefault();
          navigateHome();
        }
        return;
      }
      if (event.altKey) return;
      if (event.key === ",") {
        event.preventDefault();
        if (!supportView) navigateToSettings("general");
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
  }, [navigateHome, navigateToSettings, supportView]);

  React.useEffect(() => {
    setHydrated(true);
    // Timezones belong to the browser. Keep the server and first client render
    // on the same neutral text, then choose the local greeting after hydration.
    setHomeGreeting(greetingForDate(new Date()));
    applyDocumentTheme();
    const language = window.localStorage.getItem("berry.web.language") ?? "system";
    document.documentElement.lang = language === "system" ? navigator.language : language;
    return watchSystemTheme();
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
    void Promise.all([client.listWorkspaces({ includeGeneral: true }), client.listTasks({ includeDeleted: true })])
      .then(async ([nextWorkspaces, nextTasks]) => {
        if (cancelled) return;
        const liveWorkspaces = nextWorkspaces.length > 0 || supportView
          ? nextWorkspaces
          : [await client.createWorkspace({ name: "Default project" })];
        if (cancelled) return;
        setWorkspaces(liveWorkspaces);
        setActiveWorkspaceId((current) => liveWorkspaces.some((workspace) => workspace.id === current) ? current : liveWorkspaces[0]?.id ?? "");
        setTasks(nextTasks);
      })
      .catch((cause) => setResourceError("tasks", cause instanceof Error ? cause.message : "Unable to load this deployment"))
      .finally(() => { if (!cancelled) setTasksLoaded(true); });
    return () => { cancelled = true; };
  }, [client, fixtureWorkspace, supportView]);

  // A task can finish while its route is closed or while an EventSource is
  // reconnecting. Poll only while a task claims to be active, then stop as
  // soon as the durable task projection reaches a terminal state.
  React.useEffect(() => {
    if (!client || !tasksLoaded || !hasInProgressTasks) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || cancelled) return;
      refreshing = true;
      try {
        const taskIds = inProgressTaskIdsKey.split(",");
        const chunks = Array.from(
          { length: Math.ceil(taskIds.length / 50) },
          (_, index) => taskIds.slice(index * 50, (index + 1) * 50),
        );
        const nextTasks = (await Promise.all(chunks.map((ids) =>
          client.listTasks({ includeDeleted: true, taskIds: ids })))).flat();
        if (!cancelled) setTasks((current) => mergeTaskSnapshots(current, nextTasks));
      } catch {
        // The next tick retries; live streams remain authoritative meanwhile.
      } finally {
        refreshing = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 8_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, hasInProgressTasks, inProgressTaskIdsKey, tasksLoaded]);

  React.useEffect(() => {
    if (!client || !tasksLoaded) return;
    let cancelled = false;
    const organizationsRequest = supportView ? Promise.resolve([]) : client.listOrganizations();
    void Promise.allSettled([client.modelCatalog(), organizationsRequest])
      .then(([catalogResult, organizationsResult]) => {
        if (cancelled) return;
        if (organizationsResult.status === "fulfilled" && organizationsResult.value.length > 0) {
          const organizations = organizationsResult.value;
          setConfig((current) => WebConfigSchema.parse({ ...current, organizations }));
          setActiveOrganizationId((current) => organizations.some((organization) => organization.id === current) ? current : organizations[0]!.id);
        }
        if (catalogResult.status === "fulfilled" && catalogResult.value) {
          const catalog = catalogResult.value;
          setImageGenerationCapability(catalog.capabilities.imageGeneration);
          setModelOptions(catalog.models.map((item) => ({ id: item.id, name: item.name ?? item.id, capabilities: resolveModelCapabilities(item) })));
          organizationModelRef.current = { providerId: catalog.providerId, model: catalog.defaultModel };
          if (modelSelectionSourceRef.current === "organization") {
            applyModelSelection(catalog.providerId, catalog.defaultModel, "organization");
          } else if (modelSelectionSourceRef.current === "user") {
            const browserModel = browserModelRef.current;
            const browserModelRetiredFromCurrentProvider = browserModel
              && browserModel.providerId === catalog.providerId
              && !catalog.models.some((item) => item.id === browserModel.model);
            if (browserModelRetiredFromCurrentProvider) {
              browserModelRef.current = null;
              window.localStorage.removeItem("berry.web.modelProviderId");
              window.localStorage.removeItem("berry.web.model");
              applyModelSelection(catalog.providerId, catalog.defaultModel, "organization");
            }
          }
          setConfig((current) => WebConfigSchema.parse({
            ...current,
            providers: [{
              id: catalog.providerId,
              name: catalog.name,
              kind: "berry-router",
              defaultModel: catalog.defaultModel,
              models: catalog.models.map((item) => ({ id: item.id, name: item.name ?? item.id, capabilities: resolveModelCapabilities(item) })),
              enabled: true,
            }],
            skills: catalog.skills,
            mcpServers: catalog.mcpServers,
          }));
        } else if (catalogResult.status === "rejected") {
          setImageGenerationCapability({
            available: false,
            model: null,
            reason: "catalog_unavailable",
            message: catalogResult.reason instanceof Error
              ? catalogResult.reason.message
              : "Image generation availability could not be loaded.",
          });
        } else {
          setImageGenerationCapability({
            available: false,
            model: null,
            reason: "not_configured",
            message: "Image generation is not configured for this deployment.",
          });
        }
        const errors = [catalogResult, organizationsResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason instanceof Error ? result.reason.message : "Unable to load deployment metadata");
        if (errors.length > 0) setResourceError("tasks", errors.join(". "));
      });
    return () => { cancelled = true; };
  }, [applyModelSelection, client, supportView, tasksLoaded]);

  React.useEffect(() => {
    const sessionId = activeTask?.activeSessionId;
    if (!client || !sessionId) return;
    let cancelled = false;
    const cachedSessionModel = sessionModelsRef.current.get(sessionId) ?? null;
    const loadedSessionModel = cachedSessionModel
      ? Promise.resolve(cachedSessionModel)
      : client.getSession(sessionId).then((session) => {
          const loaded = session.modelProviderId && session.model
            ? { providerId: session.modelProviderId, model: session.model }
            : null;
          if (loaded) sessionModelsRef.current.set(sessionId, loaded);
          return loaded;
        });
    void hydratedExistingTaskModel(
      loadedSessionModel,
      () => explicitSessionModelsRef.current.get(sessionId) ?? null,
    )
      .then((selection) => {
        if (cancelled || !selection) return;
        sessionModelsRef.current.set(sessionId, selection);
        applyModelSelection(selection.providerId, selection.model, selection.source);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeTask?.activeSessionId, applyModelSelection, client]);

  React.useEffect(() => {
    if (shellLocation.kind === "task") return;
    const preferredModel = preferredNewTaskModel(browserModelRef.current, organizationModelRef.current, modelOptions);
    if (preferredModel) {
      applyModelSelection(preferredModel.providerId, preferredModel.model, preferredModel.source);
    } else {
      modelSelectionSourceRef.current = "organization";
    }
  }, [applyModelSelection, modelOptions, shellLocation.kind]);

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

  const createTask = React.useCallback(async (options?: { title?: string }) => {
    const title = options?.title?.trim().slice(0, 80) || "New cloud task";
    if (client) {
      try {
        const preferredModel = preferredNewTaskModel(browserModelRef.current, organizationModelRef.current, modelOptions);
        const created = await client.createTask({
          workspaceId: activeWorkspaceId,
          title,
          permissionMode,
          ...(preferredModel
            ? newTaskModelOverride(preferredModel.source, preferredModel.providerId, preferredModel.model)
            : {}),
        });
        if (created.session.modelProviderId && created.session.model) {
          sessionModelsRef.current.set(created.session.id, {
            providerId: created.session.modelProviderId,
            model: created.session.model,
          });
          applyModelSelection(created.session.modelProviderId, created.session.model, "session");
        }
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
  }, [activeWorkspaceId, applyModelSelection, client, modelOptions, navigateToTask, permissionMode, tasks.length]);

  // Turns belong to sessions, not to the currently rendered task. Keep every
  // active SSE reader at shell scope so navigation only changes which stream
  // is visible; it never owns or cancels server-side execution.
  const trackedSessionsRef = React.useRef(new Set<string>());
  const sessionConnectionsRef = React.useRef(new Map<string, {
    source: EventSource;
    reconnectTimer: number | null;
    attempts: number;
    ready: Promise<void>;
    cancelReady: () => void;
  }>());
  const lastEventCursorBySessionRef = React.useRef(new Map<string, string>());
  const durableEventSequencesBySessionRef = React.useRef(new Map<string, DurableEventSequences>());
  const handleQueueTurnEndRef = React.useRef<(sessionId: string, status: string) => void>(() => undefined);
  const reconcileQueueWithTurnStateRef = React.useRef<(sessionId: string, active: boolean, messages: Message[]) => void>(() => undefined);
  const sendNextQueuedFollowUpRef = React.useRef<(sessionId: string) => void>(() => undefined);

  const setMessageHistoryState = React.useCallback((sessionId: string, next: MessageHistoryState) => {
    messageHistoryRef.current.set(sessionId, next);
    setMessageHistoryBySession((current) => ({ ...current, [sessionId]: next }));
  }, []);

  /**
   * Re-read the currently materialized range after a projection-only revision
   * change. The newest-page overlay is insufficient when an older tool/result
   * row changes, because that row may be outside the newest bounded page.
   * Starting from the cached oldest cursor keeps the request bounded to the
   * loaded window while still including newly appended rows.
   */
  const refreshLoadedMessageRange = React.useCallback(async (
    sessionId: string,
    previous: MessageHistoryState,
    epoch: number,
    seedMessages?: Message[],
    stateOverrides?: { hasOlder?: boolean; hasNewer?: boolean },
  ): Promise<Message[] | null> => {
    if (!client || !previous.oldestSequence) return null;
    const current = seedMessages ?? messagesBySessionRef.current[sessionId] ?? [];
    const anchorCandidate = current[0]?.id.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX) ? undefined : current[0];
    let anchor: Message | undefined;
    if (anchorCandidate) {
      try {
        anchor = await client.getMessage(sessionId, anchorCandidate.id);
      } catch (cause) {
        if (!(cause instanceof BerryApiError) || cause.status !== 404) throw cause;
        // The cached anchor was deleted or the API is an incompatible older
        // version. Let the caller take the authoritative newest-page path.
        return null;
      }
    }
    if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;

    const refreshed = anchor ? [anchor] : [];
    let cursor = previous.oldestSequence;
    let latest: MessageHistoryPage | null = null;
    for (let attempt = 0; attempt < MAX_AFTER_PAGE_REQUESTS; attempt += 1) {
      const page = await client.listMessagePage(sessionId, {
        limit: MESSAGE_PAGE_SIZE,
        after: cursor,
        ...(previous.historyRevision ? { historyRevision: previous.historyRevision } : {}),
      });
      if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;
      if (isLegacyMessageHistoryPage(page) || page.cursorPresent === false) return null;
      latest = page;
      refreshed.push(...page.messages);
      if (!page.hasNewer || !page.newestSequence || page.newestSequence === cursor) break;
      cursor = page.newestSequence;
    }
    if (!latest) return null;

    clearPersistedRequestMessages(sessionId, refreshed);
    replaceSessionMessages(sessionId, (local) => {
      const reconciled = reconcileSessionMessageSnapshot(sessionId, refreshed, local);
      return mergeRefreshedMessagePage(local, refreshed, reconciled, { preserveNoOverlap: true });
    });
    setMessageHistoryState(sessionId, {
      ...latest,
      hasOlder: stateOverrides?.hasOlder ?? previous.hasOlder,
      hasNewer: stateOverrides?.hasNewer ?? latest.hasNewer,
      oldestSequence: previous.oldestSequence,
      newestSequence: latest.newestSequence ?? previous.newestSequence,
      loadingOlder: false,
    });
    return refreshed;
  }, [client, clearPersistedRequestMessages, reconcileSessionMessageSnapshot, replaceSessionMessages, setMessageHistoryState]);

  const enqueueHistoryRequest = React.useCallback(<T,>(sessionId: string, work: () => Promise<T>, cancelledValue: T) => {
    const previous = historyRequestTailsRef.current.get(sessionId) ?? Promise.resolve();
    const requestEpoch = historyEpochRef.current.get(sessionId) ?? 0;
    const request = previous.catch(() => undefined).then(() => {
      if ((historyEpochRef.current.get(sessionId) ?? 0) !== requestEpoch) return cancelledValue;
      return work();
    });
    const tail = request.then(() => undefined, () => undefined);
    historyRequestTailsRef.current.set(sessionId, tail);
    void tail.then(() => {
      if (historyRequestTailsRef.current.get(sessionId) !== tail) return;
      historyRequestTailsRef.current.delete(sessionId);
      if (!transcriptLruRef.current.has(sessionId) && !sessionConnectionsRef.current.has(sessionId)) {
        historyEpochRef.current.delete(sessionId);
      }
    });
    return request as Promise<T>;
  }, []);

  const refreshSessionMessages = React.useCallback(async (sessionId: string, options: { reset?: boolean; preserveNoOverlap?: boolean } = {}) => {
    if (!client) return [] as Message[];
    return await enqueueHistoryRequest(sessionId, async () => {
      const epoch = historyEpochRef.current.get(sessionId) ?? 0;
      const previous = messageHistoryRef.current.get(sessionId);
      const replaceWithNewest = (page: MessageHistoryPage) => {
        clearPersistedRequestMessages(sessionId, page.messages);
        replaceSessionMessages(sessionId, (current) => {
          const reconciled = reconcileSessionMessageSnapshot(sessionId, page.messages, current);
          return mergeRefreshedMessagePage(current, page.messages, reconciled, {
            ...(options.preserveNoOverlap === undefined ? {} : { preserveNoOverlap: options.preserveNoOverlap }),
          });
        });
        setMessageHistoryState(sessionId, { ...page, loadingOlder: false });
        return page.messages;
      };
      const replaceAuthoritativeNewest = (page: MessageHistoryPage) => {
        clearPersistedRequestMessages(sessionId, page.messages);
        replaceSessionMessages(sessionId, (current) => reconcileSessionMessageSnapshot(sessionId, page.messages, current));
        setMessageHistoryState(sessionId, { ...page, loadingOlder: false });
        return page.messages;
      };
      const loadAuthoritativeNewest = async (): Promise<Message[] | null> => {
        const page = await client.listMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE });
        if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;
        return replaceAuthoritativeNewest(page);
      };
      const collectAfterPages = async (cursor: string): Promise<{ messages: Message[]; latest: MessageHistoryPage | null } | null> => {
        const messages: Message[] = [];
        let nextCursor = cursor;
        let latest: MessageHistoryPage | null = null;
        for (let attempt = 0; attempt < MAX_AFTER_PAGE_REQUESTS; attempt += 1) {
          if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;
          const page = await client.listMessagePage(sessionId, {
            limit: MESSAGE_PAGE_SIZE,
            after: nextCursor,
            ...(previous?.historyRevision ? { historyRevision: previous.historyRevision } : {}),
          });
          if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;
          latest = page;
          messages.push(...page.messages);
          if (!page.hasNewer || !page.newestSequence || page.newestSequence === nextCursor) break;
          nextCursor = page.newestSequence;
        }
        return { messages, latest };
      };
      if (options.reset || !previous?.newestSequence) {
        const page = await client.listMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE });
        if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return [] as Message[];
        return replaceWithNewest(page);
      }

      // Normal completion reconciliation is incremental. Sequence ids are
      // table-global, so gaps are expected whenever another session writes a
      // message; only the page contents/cursor probes determine freshness.
      const afterResult = await collectAfterPages(previous.newestSequence);
      if (!afterResult) return [] as Message[];
      const page = afterResult.latest;
      if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return [] as Message[];
      if (afterResult.messages.length > 0 && page) {
        // A non-empty after page can still accompany a rewind/delete followed
        // by replacement rows. Revision changes are authoritative; discard
        // the stale prefix and reload the bounded newest snapshot instead of
        // appending new rows onto deleted history.
        // A rolling-back API may return the legacy unbounded array shape. The
        // client wraps that response for compatibility, but it has no cursor
        // metadata; never append it as though it were an incremental page.
        if (isLegacyMessageHistoryPage(page)) {
          return replaceAuthoritativeNewest(page);
        }
        if (historyDeletionRevisionChanged(previous.historyDeletionRevision, page.historyDeletionRevision)) {
          return (await loadAuthoritativeNewest()) ?? [];
        }
        if (page.cursorPresent === false) {
          return (await loadAuthoritativeNewest()) ?? [];
        }
        if (historyRevisionChanged(previous.historyRevision, page.historyRevision)) {
          return (await refreshLoadedMessageRange(sessionId, previous, epoch))
            ?? (await loadAuthoritativeNewest())
            ?? [];
        }
        // Append every page returned after the known cursor. A large completed
        // turn can span more than one page; replacing with only the newest
        // bounded snapshot would discard the already-loaded older prefix.
        replaceSessionMessages(sessionId, (current) => mergeMessagePage(current, afterResult.messages, "append"));
        setMessageHistoryState(sessionId, {
          hasOlder: previous.hasOlder || page.hasOlder,
          hasNewer: page.hasNewer,
          oldestSequence: previous.oldestSequence,
          newestSequence: page.newestSequence ?? previous.newestSequence,
          historyRevision: page.historyRevision ?? previous.historyRevision,
          historyDeletionRevision: page.historyDeletionRevision ?? previous.historyDeletionRevision,
          loadingOlder: false,
        });
        return afterResult.messages;
      }

      // An empty `after` page is ambiguous: it may mean “nothing changed” or
      // that the cursor was deleted. A one-row newest probe distinguishes the
      // cases without materializing the transcript.
      if (page?.cursorPresent === false) {
        return (await loadAuthoritativeNewest()) ?? [];
      }
      const newest = await client.listMessagePage(sessionId, { limit: 1 });
      if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return [] as Message[];
      if (historyDeletionRevisionChanged(previous.historyDeletionRevision, newest.historyDeletionRevision)) {
        return (await loadAuthoritativeNewest()) ?? [];
      }
      if (newest.historyRevision !== previous.historyRevision) {
        if (newest.cursorPresent === false) return (await loadAuthoritativeNewest()) ?? [];
        return (await refreshLoadedMessageRange(sessionId, previous, epoch))
          ?? (await loadAuthoritativeNewest())
          ?? [];
      }
      if (!newest.newestSequence || BigInt(newest.newestSequence) < BigInt(previous.newestSequence)) {
        return (await loadAuthoritativeNewest()) ?? [];
      }
      if (BigInt(newest.newestSequence) > BigInt(previous.newestSequence)) {
        const retryResult = await collectAfterPages(previous.newestSequence);
        if (!retryResult) return [] as Message[];
        if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return [] as Message[];
        const retry = retryResult.latest;
        if (retryResult.messages.length > 0 && retry) {
          if (isLegacyMessageHistoryPage(retry)) {
            return replaceAuthoritativeNewest(retry);
          }
          if (historyDeletionRevisionChanged(previous.historyDeletionRevision, retry.historyDeletionRevision)) {
            return (await loadAuthoritativeNewest()) ?? [];
          }
          if (retry.cursorPresent === false) {
            return (await loadAuthoritativeNewest()) ?? [];
          }
          if (historyRevisionChanged(previous.historyRevision, retry.historyRevision)) {
            return (await refreshLoadedMessageRange(sessionId, previous, epoch))
              ?? (await loadAuthoritativeNewest())
              ?? [];
          }
          replaceSessionMessages(sessionId, (current) => mergeMessagePage(current, retryResult.messages, "append"));
          setMessageHistoryState(sessionId, {
            hasOlder: previous.hasOlder || retry.hasOlder,
            hasNewer: retry.hasNewer,
            oldestSequence: previous.oldestSequence,
            newestSequence: retry.newestSequence ?? previous.newestSequence,
            historyRevision: retry.historyRevision ?? previous.historyRevision,
            historyDeletionRevision: retry.historyDeletionRevision ?? previous.historyDeletionRevision,
            loadingOlder: false,
          });
          return retryResult.messages;
        }
      }
      return [] as Message[];
    }, [] as Message[]);
  }, [clearPersistedRequestMessages, client, enqueueHistoryRequest, reconcileSessionMessageSnapshot, refreshLoadedMessageRange, replaceSessionMessages, setMessageHistoryState]);

  const loadOlderSessionMessages = React.useCallback(async (sessionId: string) => {
    if (!client) return false;
    return await enqueueHistoryRequest(sessionId, async () => {
      const epoch = historyEpochRef.current.get(sessionId) ?? 0;
      const previous = messageHistoryRef.current.get(sessionId);
      if (!previous?.hasOlder || !previous.oldestSequence || previous.loadingOlder) return false;
      setMessageHistoryState(sessionId, { ...previous, loadingOlder: true });
      try {
        const page = await client.listMessagePage(sessionId, {
          limit: MESSAGE_PAGE_SIZE,
          before: previous.oldestSequence,
        });
        if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return false;
        if (historyDeletionRevisionChanged(previous.historyDeletionRevision, page.historyDeletionRevision)) {
          const newest = await client.listMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE });
          if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return false;
          clearPersistedRequestMessages(sessionId, newest.messages);
          replaceSessionMessages(sessionId, (current) => reconcileSessionMessageSnapshot(sessionId, newest.messages, current));
          setMessageHistoryState(sessionId, { ...newest, loadingOlder: false });
          return newest.messages.length > 0;
        }
        if (isLegacyMessageHistoryPage(page) || page.cursorPresent === false) {
          const newest = await client.listMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE });
          if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return false;
          clearPersistedRequestMessages(sessionId, newest.messages);
          replaceSessionMessages(sessionId, (current) => reconcileSessionMessageSnapshot(sessionId, newest.messages, current));
          setMessageHistoryState(sessionId, { ...newest, loadingOlder: false });
          return newest.messages.length > 0;
        }
        if (historyRevisionChanged(previous.historyRevision, page.historyRevision)) {
          const seeded = mergeMessagePage(messagesBySessionRef.current[sessionId] ?? [], page.messages, "prepend");
          const refreshed = await refreshLoadedMessageRange(
            sessionId,
            { ...previous, oldestSequence: page.oldestSequence ?? previous.oldestSequence },
            epoch,
            seeded,
            { hasOlder: page.hasOlder, hasNewer: page.hasNewer || previous.hasNewer },
          );
          if (refreshed) return refreshed.length > 0;
          const newest = await client.listMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE });
          if ((historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return false;
          clearPersistedRequestMessages(sessionId, newest.messages);
          replaceSessionMessages(sessionId, (current) => reconcileSessionMessageSnapshot(sessionId, newest.messages, current));
          setMessageHistoryState(sessionId, { ...newest, loadingOlder: false });
          return newest.messages.length > 0;
        }
        replaceSessionMessages(sessionId, (current) => mergeMessagePage(current, page.messages, "prepend"));
        setMessageHistoryState(sessionId, {
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer || previous.hasNewer,
          oldestSequence: page.oldestSequence ?? previous.oldestSequence,
          newestSequence: previous.newestSequence,
          historyRevision: page.historyRevision ?? previous.historyRevision,
          historyDeletionRevision: page.historyDeletionRevision ?? previous.historyDeletionRevision,
          loadingOlder: false,
        });
        return page.messages.length > 0;
      } catch (cause) {
        if ((historyEpochRef.current.get(sessionId) ?? 0) === epoch) {
          setMessageHistoryState(sessionId, { ...previous, loadingOlder: false });
        }
        throw cause;
      }
    }, false);
  }, [clearPersistedRequestMessages, client, enqueueHistoryRequest, reconcileSessionMessageSnapshot, refreshLoadedMessageRange, replaceSessionMessages, setMessageHistoryState]);
  const loadOlderActiveMessages = React.useCallback(
    () => activeSessionId ? loadOlderSessionMessages(activeSessionId) : false,
    [activeSessionId, loadOlderSessionMessages],
  );

  const applyDurableState = React.useCallback((sessionId: string, state: TurnState, rebuildStream = false) => {
    setDurableStatesBySession((current) => ({ ...current, [sessionId]: state }));
    if (state.lastEventId) {
      lastEventCursorBySessionRef.current.set(sessionId, state.lastEventId);
      const reconciled = reconcileDurableEventCursor(
        durableEventSequencesBySessionRef.current.get(sessionId) ?? {},
        state.lastEventId,
      );
      durableEventSequencesBySessionRef.current.set(sessionId, reconciled.sequences);
    }
    if (!rebuildStream) return;
    sessionStreamStore.set(sessionId, replayDurableStreamState(state));
  }, []);

  const updateDurableStateFromEvent = React.useCallback((
    sessionId: string,
    event: StreamEvent,
  ) => {
    setDurableStatesBySession((current) => {
      const next = reduceDurableTurnState(current[sessionId], event);
      if (!next) return current;
      return { ...current, [sessionId]: next };
    });
  }, []);

  const stopSessionConnection = React.useCallback((sessionId: string, untrack = true) => {
    if (untrack) trackedSessionsRef.current.delete(sessionId);
    const connection = sessionConnectionsRef.current.get(sessionId);
    if (!connection) return;
    connection.cancelReady();
    connection.source.close();
    if (connection.reconnectTimer !== null) window.clearTimeout(connection.reconnectTimer);
    sessionConnectionsRef.current.delete(sessionId);
  }, []);
  stopSessionConnectionRef.current = stopSessionConnection;
  resetSupportRuntimeRef.current = () => {
    const connectedSessionIds = new Set([
      ...trackedSessionsRef.current,
      ...sessionConnectionsRef.current.keys(),
    ]);
    for (const sessionId of connectedSessionIds) stopSessionConnection(sessionId);
    const pendingHistorySessionIds = new Set([
      ...historyEpochRef.current.keys(),
      ...historyRequestTailsRef.current.keys(),
    ]);
    for (const sessionId of pendingHistorySessionIds) {
      historyEpochRef.current.set(sessionId, (historyEpochRef.current.get(sessionId) ?? 0) + 1);
    }
    historyRequestTailsRef.current.clear();
    messageHistoryRef.current.clear();
    transcriptLruRef.current.clear();
    lastEventCursorBySessionRef.current.clear();
    durableEventSequencesBySessionRef.current.clear();
    sessionModelsRef.current.clear();
    explicitSessionModelsRef.current.clear();
    followUpSendInFlightRef.current.clear();
    editingFollowUpIdsRef.current.clear();
    activeSessionsRef.current.clear();
    for (const pending of pendingSubmissionsRef.current.values()) {
      pending.cancelRequested = true;
      pending.controller.abort();
    }
    pendingSubmissionsRef.current.clear();
    pendingRequestMessageIdsBySessionRef.current.clear();
    activeSessionIdRef.current = null;
    activeTaskIdRef.current = "";
    queuePersistenceErrorShownRef.current = false;
  };

  const attachSessionStream = React.useCallback((sessionId: string) => {
    if (!client) return Promise.resolve();
    trackedSessionsRef.current.add(sessionId);
    const existing = sessionConnectionsRef.current.get(sessionId);
    if (existing) return existing.ready;

    const connect = (attempts: number): Promise<void> => {
      const currentConnection = sessionConnectionsRef.current.get(sessionId);
      if (!trackedSessionsRef.current.has(sessionId)) return Promise.resolve();
      if (currentConnection) return currentConnection.ready;
      let terminal = false;
      let resolveReady!: () => void;
      let rejectReady!: (cause: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let source!: EventSource;
      const isCurrentConnection = () => (
        trackedSessionsRef.current.has(sessionId)
        && sessionConnectionsRef.current.get(sessionId)?.source === source
      );
      source = client.streamEvents(sessionId, {
        onOpen: () => {
          if (!isCurrentConnection()) return;
          const current = sessionConnectionsRef.current.get(sessionId);
          if (current) current.attempts = 0;
          setConnectionState("online");
          resolveReady();
        },
        onEvent: (event, cursor) => {
          if (!isCurrentConnection()) return;
          const reconciled = reconcileDurableEventCursor(
            durableEventSequencesBySessionRef.current.get(sessionId) ?? {},
            cursor,
          );
          if (!reconciled.accepted) return;
          const currentRunId = event.kind === "turn.start" && cursor && /^[0-9a-f-]{36}:\d+$/i.test(cursor)
            ? cursor.slice(0, cursor.lastIndexOf(":"))
            : null;
          durableEventSequencesBySessionRef.current.set(
            sessionId,
            currentRunId
              ? { [currentRunId]: reconciled.sequences[currentRunId] ?? 0 }
              : reconciled.sequences,
          );
          if (cursor) lastEventCursorBySessionRef.current.set(sessionId, cursor);
          updateSessionStream(sessionId, event);
          if (shouldUpdateDurableStateForEvent(event)) updateDurableStateFromEvent(sessionId, event);
          const needsTaskMetadata = event.kind === "tool.start" || event.kind === "turn.end";
          const streamedTask = needsTaskMetadata
            ? tasksRef.current.find((task) => task.activeSessionId === sessionId)
            : undefined;
          if (event.kind === "tool.start" && streamedTask) {
            notifyBackgroundProgress({
              sessionId,
              taskId: streamedTask.id,
              taskTitle: streamedTask.title,
              detail: event.title || event.name || "Berry started the next step.",
            });
          }
          if (event.kind !== "turn.end") return;
          if (event.status === "completed" && streamedTask) {
            notifyTaskCompleted({
              completionId: `${sessionId}:${event.turnId}`,
              sessionId,
              taskId: streamedTask.id,
              taskTitle: streamedTask.title,
            });
          }
          const finishedAt = new Date().toISOString();
          setTasks((current) => current.map((task) => {
            if (task.activeSessionId !== sessionId) return task;
            const unread = (event.status === "completed" || event.status === "failed")
              && task.id !== activeTaskIdRef.current;
            return {
              ...task,
              status: event.status,
              ...(unread ? { unreadAt: finishedAt } : {}),
            };
          }));
          if (streamedTask?.id === activeTaskIdRef.current) {
            void client.getTask(streamedTask.id)
              .then((latest) => latest.unreadAt
                ? client.updateTask(latest.id, { read: true, readThrough: latest.unreadAt })
                : latest)
              .then((updated) => setTasks((current) => current.map((task) => task.id === updated.id ? updated : task)))
              .catch(() => undefined);
          }
          terminal = true;
          pendingSubmissionsRef.current.delete(sessionId);
          activeSessionsRef.current.delete(sessionId);
          stopSessionConnection(sessionId);
          handleQueueTurnEndRef.current(sessionId, event.status);
          const terminalEpoch = historyEpochRef.current.get(sessionId) ?? 0;
          const reconcileTerminal = (attempt: number): void => {
            void Promise.all([refreshSessionMessages(sessionId), client.turnState(sessionId)])
              .then(([, state]) => {
                if ((historyEpochRef.current.get(sessionId) ?? 0) !== terminalEpoch) return;
                // A queued follow-up can begin locally before its POST is
                // admitted. Do not let this older terminal snapshot erase
                // that newer pending turn.
                if (!state.active && activeSessionsRef.current.has(sessionId)) return;
                applyDurableState(sessionId, state);
                if (state.active) activeSessionsRef.current.add(sessionId);
                else resetSessionStream(sessionId);
              })
              .catch((cause) => {
                if (attempt < 2) {
                  window.setTimeout(() => reconcileTerminal(attempt + 1), 500 * (attempt + 1));
                  return;
                }
                setResourceError("messages", cause instanceof Error ? cause.message : "Unable to refresh the completed turn");
              });
          };
          reconcileTerminal(0);
        },
        onError: () => {
          if (terminal || !isCurrentConnection()) return;
          rejectReady(new Error("The live response stream could not be opened"));
          source.close();
          sessionConnectionsRef.current.delete(sessionId);
          setConnectionState(navigator.onLine ? "reconnecting" : "offline");
          const nextAttempts = attempts + 1;
          const reconnectTimer = window.setTimeout(() => {
            if (sessionConnectionsRef.current.get(sessionId)?.source !== source) return;
            sessionConnectionsRef.current.delete(sessionId);
            void connect(nextAttempts);
          }, Math.min(5_000, 500 * (2 ** Math.min(nextAttempts, 4))));
          sessionConnectionsRef.current.set(sessionId, {
            source,
            reconnectTimer,
            attempts: nextAttempts,
            ready,
            cancelReady: () => rejectReady(new Error("The live response stream was closed")),
          });
        },
      }, lastEventCursorBySessionRef.current.get(sessionId) ?? null);
      sessionConnectionsRef.current.set(sessionId, {
        source,
        reconnectTimer: null,
        attempts,
        ready,
        cancelReady: () => rejectReady(new Error("The live response stream was closed")),
      });
      return ready;
    };

    return connect(0);
  }, [applyDurableState, client, refreshSessionMessages, resetSessionStream, stopSessionConnection, supportView, updateDurableStateFromEvent, updateSessionStream]);

  React.useEffect(() => () => {
    for (const sessionId of [...trackedSessionsRef.current]) stopSessionConnection(sessionId);
  }, [stopSessionConnection]);

  React.useEffect(() => {
    const sessionId = activeTask?.activeSessionId;
    if (!sessionId) return;
    if (!client) {
      replaceSessionMessages(sessionId, (current) => current.length > 0 ? current : fixtureMessages(sessionId));
      setMessageHistoryState(sessionId, { hasOlder: false, hasNewer: false, oldestSequence: null, newestSequence: null, historyRevision: null, historyDeletionRevision: null, loadingOlder: false });
      return;
    }
    let cancelled = false;
    const epoch = historyEpochRef.current.get(sessionId) ?? 0;
    void enqueueHistoryRequest(sessionId, async () => {
      const [page, state] = await Promise.all([
        client.listMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE }),
        client.turnState(sessionId),
      ]);
      if (cancelled || (historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;
      setMessageHistoryState(sessionId, { ...page, loadingOlder: false });
      const items = page.messages;
      const visibleMessageIds = new Set(items.map((message) => message.id));
      const queued = followUpsBySessionRef.current[sessionId] ?? readQueuedFollowUps(sessionId);
      const missingQueuedMessageIds = [...new Set(queued
        .filter((followUp) => followUp.status === "sending" && followUp.messageId && !visibleMessageIds.has(followUp.messageId))
        .map((followUp) => followUp.messageId!))];
      // The newest page is intentionally bounded. Probe only queued message
      // IDs that fall outside it so a refresh cannot turn an older, already
      // persisted submission into a duplicate retry. Keep these probes in the
      // same per-session queue so a terminal refresh cannot interleave with a
      // stale bootstrap snapshot.
      const recoveredQueuedMessages = await findPersistedMessagesByIds(client, sessionId, missingQueuedMessageIds);
      if (cancelled || (historyEpochRef.current.get(sessionId) ?? 0) !== epoch) return null;
      clearPersistedRequestMessages(sessionId, items);
      replaceSessionMessages(sessionId, (current) => {
        const reconciled = reconcileSessionMessageSnapshot(sessionId, items, current);
        const cachedHistory = messageHistoryRef.current.get(sessionId);
        const preserveNoOverlap = current.length > items.length
          && Boolean(cachedHistory?.newestSequence && page.newestSequence
            && BigInt(page.newestSequence) >= BigInt(cachedHistory.newestSequence));
        return mergeRefreshedMessagePage(current, items, reconciled, { preserveNoOverlap });
      });
      const preserveDurableSurface = state.active || state.runState === "recovery_required";
      applyDurableState(sessionId, state, preserveDurableSurface);
      if (state.active) activeSessionsRef.current.add(sessionId);
      else activeSessionsRef.current.delete(sessionId);
      const persistedQueuedMessages = recoveredQueuedMessages.filter(Boolean) as Message[];
      reconcileQueueWithTurnStateRef.current(sessionId, state.active, [
        ...items,
        ...persistedQueuedMessages,
      ]);
      if (state.active) void attachSessionStream(sessionId).catch(() => undefined);
      else if (!preserveDurableSurface) resetSessionStream(sessionId);
      return null;
    }, null)
      .catch((cause) => {
        if (!cancelled) setResourceError("messages", cause instanceof Error ? cause.message : "Unable to load this task");
      });
    return () => { cancelled = true; };
  }, [activeTask?.activeSessionId, applyDurableState, attachSessionStream, clearPersistedRequestMessages, client, enqueueHistoryRequest, findPersistedMessage, reconcileSessionMessageSnapshot, replaceSessionMessages, resetSessionStream, setMessageHistoryState]);

  const runTurn = React.useCallback(async (
    task: Task,
    params:
      | { input: string; intent?: TurnIntent | undefined; messageInput?: string | undefined; requestMessageId?: string | undefined; continueInterruptedTurn?: false | undefined; attachments?: AttachmentInput[] | undefined; replaceFromMessageId?: string | undefined }
      | { continueInterruptedTurn: true; input?: undefined; attachments?: undefined; replaceFromMessageId?: undefined },
  ) => {
    if (!client || !task.activeSessionId) return;
    const sessionId = task.activeSessionId;
    const operationId = params.continueInterruptedTurn === true
      ? globalThis.crypto.randomUUID()
      : params.requestMessageId ?? globalThis.crypto.randomUUID();
    const submission = {
      operationId,
      controller: new AbortController(),
      cancelRequested: false,
    };
    pendingSubmissionsRef.current.set(sessionId, submission);
    const turnModelOverride = existingTaskTurnModelOverride(
      explicitSessionModelsRef.current.get(sessionId) ?? null,
    );
    const taskWorkspacePath = workspaces.find((workspace) => workspace.id === task.workspaceId)?.path ?? initial.config.workspacePath;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));
    setStartingSessions((current) => new Set(current).add(sessionId));
    activeSessionsRef.current.add(sessionId);
    const pendingTurnId = `pending_${Date.now()}`;
    updateSessionStream(sessionId, {
      kind: "turn.start",
      turnId: pendingTurnId,
      ...(params.continueInterruptedTurn ? { continuation: true } : {}),
    });
    applyDurableState(sessionId, {
      active: true,
      turnId: pendingTurnId,
      continuation: params.continueInterruptedTurn === true,
      bufferedEvents: [],
      replayOnly: false,
      owner: null,
      runState: "queued",
      waitingReason: null,
      nextAction: "Submitting the turn",
      error: null,
    });
    const request = {
      operationId,
      workspacePath: taskWorkspacePath,
      workspaceId: task.workspaceId,
      permissionMode,
      ...turnModelOverride,
      reasoning,
      ...(params.continueInterruptedTurn
        ? { continueInterruptedTurn: true as const }
        : {
          input: params.input,
          ...(params.intent ? { intent: params.intent } : {}),
          ...(params.messageInput ? { messageInput: params.messageInput } : {}),
          ...(params.requestMessageId ? { requestMessageId: params.requestMessageId } : {}),
          ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
          ...(params.replaceFromMessageId ? { replaceFromMessageId: params.replaceFromMessageId } : {}),
        }),
    } satisfies StartTurnRequest;
    let submissionAttempted = false;
    let retainPendingSubmission = false;
    try {
      // Listen before submitting so early deltas render live instead of being
      // delivered together from the server's replay buffer. Connection setup
      // belongs inside this try/finally so an initial SSE failure cannot leave
      // a phantom active turn in browser state.
      await attachSessionStream(sessionId);
      if (submission.cancelRequested) return;
      applyDurableState(sessionId, {
        active: true,
        turnId: pendingTurnId,
        continuation: params.continueInterruptedTurn === true,
        bufferedEvents: [],
        replayOnly: false,
        owner: null,
        runState: "assembling_context",
        waitingReason: null,
        nextAction: "Preparing context",
        error: null,
      });
      submissionAttempted = true;
      const started = await client.startTurn(sessionId, request, { signal: submission.controller.signal });
      if (submission.cancelRequested) return;
      // A stale terminal event can close the pre-admission EventSource while
      // POST /turns is in flight. Reassert ownership after the server accepts
      // this run and reopen the stream from the cursor that event supplied.
      activeSessionsRef.current.add(sessionId);
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));
      applyDurableState(sessionId, {
        active: true,
        turnId: started.turnId,
        continuation: params.continueInterruptedTurn === true,
        bufferedEvents: [],
        replayOnly: false,
        owner: null,
        runState: "queued",
        waitingReason: null,
        nextAction: "Waiting for worker",
        error: null,
      });
      void attachSessionStream(sessionId).catch(() => undefined);
    } catch (cause) {
      if (submission.cancelRequested) {
        activeSessionsRef.current.delete(sessionId);
        stopSessionConnection(sessionId);
        return;
      }
      if (submissionAttempted) {
        const activeConflict = await activeTurnStateAfterConflict(client, sessionId, cause).catch(() => null);
        if (activeConflict) {
          clearPendingRequestMessage(
            sessionId,
            params.continueInterruptedTurn === true ? undefined : params.requestMessageId,
          );
          await refreshSessionMessages(sessionId).catch(() => undefined);
          applyDurableState(sessionId, activeConflict, true);
          activeSessionsRef.current.add(sessionId);
          setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));
          void attachSessionStream(sessionId).catch(() => undefined);
          if (params.continueInterruptedTurn === true) {
            toast.info("The existing turn is still running. Live updates have been restored.");
          } else {
            const queued = createQueuedFollowUp({
              taskId: task.id,
              sessionId,
              ordinal: followUpsBySessionRef.current[sessionId]?.length ?? 0,
              input: params.input,
              ...(params.intent ? { intent: params.intent } : {}),
              ...(params.attachments ? { attachments: params.attachments } : {}),
            });
            updateSessionFollowUps(sessionId, (current) => [...current, queued]);
            toast.info("The existing turn is still running. Live updates were restored and your prompt was queued.");
          }
          return;
        }
      }
      let confirmationFailure: unknown = cause;
      if (submissionAttempted && shouldConfirmTurnAdmission(cause)) {
        try {
          const recovered = await retryTurnAdmission(client, sessionId, request);
          if (submission.cancelRequested) return;
          if (recovered.state) {
            applyDurableState(sessionId, recovered.state);
          } else {
            applyDurableState(sessionId, {
              active: true,
              turnId: recovered.started.turnId,
              continuation: params.continueInterruptedTurn === true,
              bufferedEvents: [],
              replayOnly: false,
              owner: null,
              runState: "queued",
              waitingReason: null,
              nextAction: "Reconciling the confirmed turn",
              error: null,
            });
          }
          if (recovered.state?.active !== false) {
            activeSessionsRef.current.add(sessionId);
            void attachSessionStream(sessionId).catch(() => undefined);
          } else {
            activeSessionsRef.current.delete(sessionId);
            stopSessionConnection(sessionId);
            await refreshSessionMessages(sessionId).catch(() => undefined);
            resetSessionStream(sessionId);
          }
          return;
        } catch (confirmationCause) {
          if (submission.cancelRequested) return;
          confirmationFailure = confirmationCause;
          const confirmedConflict = await activeTurnStateAfterConflict(
            client,
            sessionId,
            confirmationCause,
          ).catch(() => null);
          if (confirmedConflict) {
            clearPendingRequestMessage(
              sessionId,
              params.continueInterruptedTurn === true ? undefined : params.requestMessageId,
            );
            await refreshSessionMessages(sessionId).catch(() => undefined);
            applyDurableState(sessionId, confirmedConflict, true);
            activeSessionsRef.current.add(sessionId);
            setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));
            void attachSessionStream(sessionId).catch(() => undefined);
            return;
          }
        }
      }
      if (submissionAttempted && shouldKeepTurnPendingAfterFailedConfirmation(confirmationFailure)) {
        retainPendingSubmission = true;
        activeSessionsRef.current.add(sessionId);
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));
        applyDurableState(sessionId, {
          active: true,
          turnId: pendingTurnId,
          continuation: params.continueInterruptedTurn === true,
          bufferedEvents: [],
          replayOnly: false,
          owner: null,
          runState: "assembling_context",
          waitingReason: null,
          nextAction: "Confirming submission",
          error: null,
        });
        void attachSessionStream(sessionId).catch(() => undefined);
        return;
      }
      // A definitive confirmation failure means the operation was not
      // accepted, so the normal terminal error path below is safe.
      activeSessionsRef.current.delete(sessionId);
      stopSessionConnection(sessionId);
      clearPendingRequestMessage(
        sessionId,
        params.continueInterruptedTurn === true ? undefined : params.requestMessageId,
      );
      const error = cause instanceof Error ? cause : new Error("Unable to start the turn");
      updateSessionStream(sessionId, { kind: "error", message: error.message });
      const terminalEvent = { kind: "turn.end", turnId: `failed_${Date.now()}`, status: "failed" } as const;
      updateSessionStream(sessionId, terminalEvent);
      updateDurableStateFromEvent(sessionId, terminalEvent);
      const failedAt = new Date().toISOString();
      setTasks((current) => current.map((item) => item.id === task.id
        ? {
          ...item,
          status: "failed",
          ...(item.id !== activeTaskIdRef.current ? { unreadAt: failedAt } : {}),
        }
        : item));
      await client.updateTask(task.id, {
        status: "failed",
        ...(task.id === activeTaskIdRef.current ? { read: true } : {}),
      }).then((updated) => {
        setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
      }).catch(() => undefined);
      await refreshSessionMessages(sessionId).catch(() => undefined);
      throw error;
    } finally {
      if (!retainPendingSubmission && pendingSubmissionsRef.current.get(sessionId) === submission) {
        pendingSubmissionsRef.current.delete(sessionId);
      }
      setStartingSessions((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
    }
  }, [applyDurableState, attachSessionStream, clearPendingRequestMessage, client, initial.config.workspacePath, permissionMode, reasoning, refreshSessionMessages, resetSessionStream, stopSessionConnection, updateDurableStateFromEvent, updateSessionFollowUps, updateSessionStream, workspaces]);

  const cancelTurn = React.useCallback(async () => {
    const sessionId = activeTask?.activeSessionId;
    if (!sessionId) return;
    const pending = pendingSubmissionsRef.current.get(sessionId);
    const cancellation = prepareTurnCancellation(pending);
    try {
      if (client) {
        await client.cancelTurn(sessionId, cancellation);
      }
      stopSessionConnection(sessionId);
      // cancelTurn commits its terminal event before returning. The next turn
      // must open a no-cursor stream so old cancellation cannot replay as the
      // terminal event for the replacement turn.
      clearDurableEventReplayBoundary(
        sessionId,
        lastEventCursorBySessionRef.current,
        durableEventSequencesBySessionRef.current,
      );
      if (pending && pendingSubmissionsRef.current.get(sessionId) === pending) {
        pendingSubmissionsRef.current.delete(sessionId);
      }
      activeSessionsRef.current.delete(sessionId);
      const terminalEvent = {
        kind: "turn.end",
        turnId: sessionStreamStore.get(sessionId).turnId ?? `cancelled_${Date.now()}`,
        status: "cancelled",
      } as const;
      updateSessionStream(sessionId, terminalEvent);
      updateDurableStateFromEvent(sessionId, terminalEvent);
      await refreshSessionMessages(sessionId);
      handleQueueTurnEndRef.current(sessionId, "cancelled");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to stop the active turn");
    }
  }, [activeTask?.activeSessionId, client, refreshSessionMessages, stopSessionConnection, updateDurableStateFromEvent, updateSessionStream]);

  const recoverDurableTurn = React.useCallback(async () => {
    const sessionId = activeTask?.activeSessionId;
    const runId = sessionId ? durableStatesBySession[sessionId]?.turnId : null;
    if (!client || !sessionId || !runId) throw new Error("The durable run is no longer available.");
    const result = await client.recoverTurn(runId, "retry");
    if (!result.ok) throw new Error("The recovery action was not accepted. Refresh the task and review its current state.");
    const state = await client.turnState(sessionId);
    applyDurableState(sessionId, state, state.active);
    if (state.active) {
      activeSessionsRef.current.add(sessionId);
      void attachSessionStream(sessionId).catch(() => undefined);
      return;
    }
    activeSessionsRef.current.delete(sessionId);
    stopSessionConnection(sessionId);
    resetSessionStream(sessionId);
    await refreshSessionMessages(sessionId);
  }, [activeTask?.activeSessionId, applyDurableState, attachSessionStream, client, durableStatesBySession, refreshSessionMessages, resetSessionStream, stopSessionConnection]);

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
    const replacementMessageId = globalThis.crypto.randomUUID();
    markRequestMessagePending(sessionId, replacementMessageId);
    requestThreadBottom(sessionId);
    replaceSessionMessages(sessionId, (current) => {
      const index = current.findIndex((item) => item.id === target.id);
      const kept = index === -1 ? current : current.slice(0, index);
      return [...kept, optimisticUserMessage(sessionId, text, attachments, replacementMessageId)];
    });
    await runTurn(activeTask, {
      input: text,
      ...(text.startsWith("Create image\n") ? { intent: "image_generation" as const } : {}),
      requestMessageId: replacementMessageId,
      ...(attachments.length > 0 ? { attachments } : {}),
      replaceFromMessageId: target.id,
    });
    // The optimistic edit truncates the visible tail before the server
    // rewinds the task. If the edited turn is older than the newest bounded
    // page, that page has no id overlap with the retained prefix; keep the
    // prefix while the authoritative rewrite arrives instead of dropping a
    // user's already-loaded history.
    await refreshSessionMessages(sessionId, { reset: true, preserveNoOverlap: true });
  }, [activeTask, markRequestMessagePending, refreshSessionMessages, replaceSessionMessages, requestThreadBottom, runTurn]);

  const continueTurn = React.useCallback(async () => {
    if (!activeTask?.activeSessionId) return;
    const sessionId = activeTask.activeSessionId;
    requestThreadBottom(sessionId);
    await continueAfterMessageRefresh(
      async () => { await refreshSessionMessages(sessionId); },
      () => runTurn(activeTask, { continueInterruptedTurn: true }),
    );
  }, [activeTask, refreshSessionMessages, requestThreadBottom, runTurn]);

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
    // Replace a task URL immediately so another account cannot inherit it
    // while server-side session revocation is still in flight.
    stopSupportView();
    onSignedOut?.();
    try {
      await revokeAuthSession(initial.config.apiBaseUrl ?? "");
    } catch (cause) {
      toast.error("Server logout could not be confirmed", {
        description: cause instanceof Error
          ? `${cause.message}. Check your connection before leaving this device.`
          : "Check your connection before leaving this device.",
      });
    }
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

  const toggleTaskPinned = React.useCallback(async (task: Task) => {
    const pinned = !task.pinned;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, pinned } : item));
    if (client) {
      try {
        const updated = await client.updateTask(task.id, { pinned });
        setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
      } catch (cause) {
        setTasks((current) => current.map((item) => item.id === task.id ? task : item));
        toast.error(cause instanceof Error ? cause.message : "Unable to update the task");
      }
    }
  }, [client]);

  const renameTask = React.useCallback(async (task: Task) => {
    const title = window.prompt("Rename task", task.title)?.trim();
    if (!title || title === task.title) return;
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, title } : item));
    if (!client) return;
    try {
      const updated = await client.updateTask(task.id, { title });
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setTasks((current) => current.map((item) => item.id === task.id ? task : item));
      toast.error(cause instanceof Error ? cause.message : "Unable to rename the task");
    }
  }, [client]);

  const shareTask = React.useCallback(async (task: Task) => {
    try {
      await navigator.clipboard.writeText(new URL(`/tasks/${task.id}`, window.location.origin).toString());
      toast.success("Task link copied");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to copy the task link");
    }
  }, []);

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
      toast.error(cause instanceof Error ? cause.message : "Unable to delete the task");
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
      toast.error(cause instanceof Error ? cause.message : "Unable to update the task archive");
      throw cause;
    }
  }, [client, navigateHome, shellLocation]);

  const toggleProjectPinned = React.useCallback(async (workspace: Workspace) => {
    const pinned = !workspace.pinned;
    setWorkspaces((current) => current.map((item) => item.id === workspace.id ? { ...item, pinned } : item));
    try {
      const updated = client ? await client.updateWorkspace(workspace.id, { pinned }) : { ...workspace, pinned };
      setWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setWorkspaces((current) => current.map((item) => item.id === workspace.id ? workspace : item));
      toast.error(cause instanceof Error ? cause.message : "Unable to update the project");
    }
  }, [client]);

  const renameProject = React.useCallback(async (workspace: Workspace, name: string) => {
    if (!name || name === workspace.name) return;
    setWorkspaces((current) => current.map((item) => item.id === workspace.id ? { ...item, name } : item));
    try {
      const updated = client ? await client.updateWorkspace(workspace.id, { name }) : { ...workspace, name };
      setWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item));
      toast.success("Project renamed");
    } catch (cause) {
      setWorkspaces((current) => current.map((item) => item.id === workspace.id ? workspace : item));
      toast.error(cause instanceof Error ? cause.message : "Unable to rename the project");
    }
  }, [client]);

  const archiveProjectTasks = React.useCallback(async (workspace: Workspace, projectTasks: Task[]) => {
    try {
      await Promise.all(projectTasks.map((task) => archiveTask(task, true)));
      toast.success(`Archived ${projectTasks.length} task${projectTasks.length === 1 ? "" : "s"}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to archive the project tasks");
    }
  }, [archiveTask]);

  const removeProject = React.useCallback(async (workspace: Workspace) => {
    const previousWorkspaces = workspaces;
    const previousTasks = tasks;
    setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    setTasks((current) => current.map((task) => task.workspaceId === workspace.id ? { ...task, deletedAt: new Date().toISOString() } : task));
    if (activeWorkspaceId === workspace.id) {
      const fallback = workspaces.find((item) => item.id !== workspace.id && item.workspaceKind === "general") ?? workspaces.find((item) => item.id !== workspace.id);
      if (fallback) setActiveWorkspaceId(fallback.id);
      navigateHome();
    }
    try {
      if (client) await client.deleteWorkspace(workspace.id);
      toast.success(`Removed ${workspace.name}`);
    } catch (cause) {
      setWorkspaces(previousWorkspaces);
      setTasks(previousTasks);
      toast.error(cause instanceof Error ? cause.message : "Unable to remove the project");
    }
  }, [activeWorkspaceId, client, navigateHome, tasks, workspaces]);

  const revealProject = React.useCallback((workspace: Workspace) => {
    toast.message(`Reveal in Finder is available in the desktop app for ${workspace.name}.`);
  }, []);

  const uploadToProject = React.useCallback(async (workspace: Workspace, file: File, onProgress: (ratio: number) => void) => {
    if (!client) throw new Error("Project uploads require a connected Berry deployment.");
    await client.uploadFile(file, {
      workspaceId: workspace.id,
      workspaceVisibility: "project",
      onProgress: ({ ratio }) => onProgress(ratio),
    });
  }, [client]);

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
      toast.error(cause instanceof Error ? cause.message : "Unable to restore the task");
    }
  }, [client]);

  const removeFollowUp = React.useCallback(async (followUp: QueuedFollowUp) => {
    const current = (followUpsBySessionRef.current[followUp.sessionId] ?? []).find((item) => item.id === followUp.id);
    if (current?.status === "sending") return;
    if (client) await client.cancelQueuedFollowUp(followUp.id);
    updateSessionFollowUps(followUp.sessionId, (current) => current.filter((item) => item.id !== followUp.id));
  }, [client, updateSessionFollowUps]);

  const rememberFollowUp = React.useCallback((followUp: QueuedFollowUp) => {
    updateSessionFollowUps(followUp.sessionId, (current) => [
      ...current.filter((item) => item.id !== followUp.id),
      followUp,
    ].sort((left, right) => left.ordinal - right.ordinal));
  }, [updateSessionFollowUps]);

  const enqueueFollowUp = React.useCallback(async (followUp: QueuedFollowUp) => {
    if (!client) {
      rememberFollowUp(followUp);
      return;
    }
    const task = tasks.find((item) => item.id === followUp.taskId);
    if (!task) throw new Error("This queued prompt no longer belongs to an available task.");
    const persisted = await client.enqueueQueuedFollowUp(followUp.sessionId, {
      taskId: task.id,
      workspaceId: task.workspaceId,
      input: followUp.input,
      ...(followUp.intent ? { intent: followUp.intent } : {}),
      attachments: followUp.attachments,
      idempotencyKey: followUp.id,
    });
    const mapped = serverQueuedFollowUpToClient(persisted);
    const next = {
      ...followUpsBySessionRef.current,
      [followUp.sessionId]: [
        ...(followUpsBySessionRef.current[followUp.sessionId] ?? []).filter((item) => item.id !== mapped.id),
        mapped,
      ].sort((left, right) => left.ordinal - right.ordinal),
    };
    followUpsBySessionRef.current = next;
    setFollowUpsBySession(next);
  }, [client, rememberFollowUp, tasks]);

  const refreshQueuedFollowUps = React.useCallback(async (sessionId: string) => {
    if (!client) return [];
    try {
      const page = await client.listQueuedFollowUps(sessionId, { limit: 100 });
      const mapped = page.items.map(serverQueuedFollowUpToClient);
      const next = { ...followUpsBySessionRef.current, [sessionId]: mapped };
      followUpsBySessionRef.current = next;
      setFollowUpsBySession(next);
      return mapped;
    } catch (cause) {
      if (cause instanceof BerryApiError && [401, 403, 404].includes(cause.status)) {
        const next = { ...followUpsBySessionRef.current, [sessionId]: [] };
        followUpsBySessionRef.current = next;
        setFollowUpsBySession(next);
      }
      throw cause;
    }
  }, [client]);

  const reorderFollowUps = React.useCallback((sessionId: string, orderedIds: string[]) => {
    if (client) {
      const lastId = orderedIds.at(-1);
      if (lastId) void client.updateQueuedFollowUp(lastId, { orderedIds }).catch(() => undefined);
    }
    updateSessionFollowUps(sessionId, (current) => {
      const byId = new Map(current.map((followUp) => [followUp.id, followUp]));
      const ordered = orderedIds.flatMap((id) => {
        const followUp = byId.get(id);
        if (!followUp) return [];
        byId.delete(id);
        return [followUp];
      });
      return [...ordered, ...byId.values()];
    });
  }, [client, updateSessionFollowUps]);

  const updateFollowUp = React.useCallback(async (followUp: QueuedFollowUp, update: Pick<QueuedFollowUp, "input" | "intent" | "attachments">) => {
    if (client) {
      const persisted = await client.updateQueuedFollowUp(followUp.id, {
        input: update.input,
        intent: update.intent ?? null,
        attachments: update.attachments,
        ...(followUp.status === "failed" ? { status: "queued" as const } : {}),
      });
      const mapped = serverQueuedFollowUpToClient(persisted);
      updateSessionFollowUps(followUp.sessionId, (current) => [...current.filter((item) => item.id !== mapped.id), mapped].sort((left, right) => left.ordinal - right.ordinal));
      return;
    }
    rememberFollowUp({
      ...followUp,
      ...update,
      status: followUp.status === "failed" ? "queued" : followUp.status,
      messageId: null,
      deliveryMode: null,
      error: null,
      updatedAt: new Date().toISOString(),
    });
  }, [client, rememberFollowUp, updateSessionFollowUps]);

  const resumeFollowUps = React.useCallback(async (sessionId: string) => {
    if (client) {
      const current = followUpsBySessionRef.current[sessionId] ?? [];
      await Promise.all(current.filter((item) => item.status === "paused").map((item) => client.updateQueuedFollowUp(item.id, { status: "queued" })));
      const page = await client.listQueuedFollowUps(sessionId, { limit: 100 });
      const mapped = page.items.map(serverQueuedFollowUpToClient);
      followUpsBySessionRef.current = { ...followUpsBySessionRef.current, [sessionId]: mapped };
      setFollowUpsBySession((state) => ({ ...state, [sessionId]: mapped }));
      return;
    }
    updateSessionFollowUps(sessionId, (current) => current.map((followUp) => followUp.status === "paused"
      ? { ...followUp, status: "queued", pausedReason: null, error: null, updatedAt: new Date().toISOString() }
      : followUp));
    window.setTimeout(() => sendNextQueuedFollowUpRef.current(sessionId), 0);
  }, [client, updateSessionFollowUps]);

  /**
   * A steer is an interruption, not an inline instruction to the old turn.
   * Let the active harness finish cancellation and projection writes first,
   * then append the prompt and begin a new turn so message order remains
   * assistant → user → assistant.
   */
  const interruptAndStartTurn = React.useCallback(async (
    task: Task,
    input: string,
    attachments: AttachmentInput[],
    messageId: string = crypto.randomUUID(),
    intent?: TurnIntent,
  ): Promise<Message> => {
    const sessionId = task.activeSessionId;
    if (!client || !sessionId) throw new Error("The active task is no longer available.");

    requestThreadBottom(sessionId);
    const pending = pendingSubmissionsRef.current.get(sessionId);
    await client.cancelTurn(sessionId, prepareTurnCancellation(pending));

    // The cancelled turn must no longer own the live tail before rendering the
    // next user prompt. listMessages waits for server-side projection writes.
    stopSessionConnection(sessionId);
    clearDurableEventReplayBoundary(
      sessionId,
      lastEventCursorBySessionRef.current,
      durableEventSequencesBySessionRef.current,
    );
    activeSessionsRef.current.delete(sessionId);
    resetSessionStream(sessionId);
    await refreshSessionMessages(sessionId);

    const optimistic = optimisticUserMessage(sessionId, input, attachments);
    replaceSessionMessages(sessionId, (current) => [...current, optimistic]);
    let persisted: Message;
    try {
      persisted = await client.appendMessage(sessionId, {
        messageId,
        role: "user",
        parts: [
          { kind: "text", content: input },
          ...attachments.map((attachment) => ({ kind: "attachment" as const, content: messageAttachmentContent(attachment) })),
        ],
      });
    } catch (cause) {
      const recovered = !(cause instanceof BerryApiError)
        ? await findPersistedMessage(sessionId, messageId).catch(() => undefined)
        : undefined;
      if (!recovered) {
        replaceSessionMessages(sessionId, (current) => current.filter((message) => message.id !== optimistic.id));
        throw cause;
      }
      persisted = recovered;
    }
    replaceSessionMessages(sessionId, (current) => confirmOptimisticMessage(current, optimistic.id, persisted));
    requestThreadBottom(sessionId);
    await runTurn(task, {
      input,
      ...(intent ? { intent } : {}),
      requestMessageId: persisted.id,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    requestThreadBottom(sessionId);
    return persisted;
  }, [client, findPersistedMessage, refreshSessionMessages, replaceSessionMessages, requestThreadBottom, resetSessionStream, runTurn, stopSessionConnection]);

  const deliverFollowUp = React.useCallback(async (followUp: QueuedFollowUp) => {
    if (!client) return;
    if (followUpSendInFlightRef.current.has(followUp.id)) return;
    const task = tasks.find((item) => item.id === followUp.taskId);
    if (!task?.activeSessionId) throw new Error("This queued prompt no longer belongs to an active task.");
    const currentlyActive = activeSessionsRef.current.has(followUp.sessionId);
    let messageId = followUp.messageId ?? crypto.randomUUID();
    let deliveryMode = followUp.deliveryMode ?? (currentlyActive ? "steer" : "turn");
    followUpSendInFlightRef.current.add(followUp.id);
    rememberFollowUp({ ...followUp, status: "sending", messageId, deliveryMode, error: null, pausedReason: null, updatedAt: new Date().toISOString() });
    try {
      if (deliveryMode === "steer" && !currentlyActive) {
        const acceptedMessage = await findPersistedMessage(followUp.sessionId, messageId);
        if (acceptedMessage) {
          updateSessionFollowUps(followUp.sessionId, (current) => current.filter((item) => item.id !== followUp.id));
          return;
        }
        deliveryMode = "turn";
        rememberFollowUp({ ...followUp, status: "sending", messageId, deliveryMode, error: null, pausedReason: null, updatedAt: new Date().toISOString() });
      }

      if (deliveryMode === "steer") {
        const message = await interruptAndStartTurn(task, followUp.input, followUp.attachments, messageId, followUp.intent);
        messageId = message.id;
      } else {
        if (currentlyActive) {
          rememberFollowUp({ ...followUp, status: "queued", messageId, deliveryMode, error: null, pausedReason: null, updatedAt: new Date().toISOString() });
          return;
        }
        const existingMessage = followUp.messageId
          ? await findPersistedMessage(followUp.sessionId, messageId)
          : undefined;
        if (!existingMessage) {
          const optimistic = optimisticUserMessage(followUp.sessionId, followUp.input, followUp.attachments);
          replaceSessionMessages(followUp.sessionId, (current) => [...current, optimistic]);
          try {
            const persisted = await client.appendMessage(followUp.sessionId, {
              messageId,
              role: "user",
              parts: [
                { kind: "text", content: followUp.input },
                ...followUp.attachments.map((attachment) => ({ kind: "attachment" as const, content: messageAttachmentContent(attachment) })),
              ],
            });
            messageId = persisted.id;
            replaceSessionMessages(followUp.sessionId, (current) => confirmOptimisticMessage(current, optimistic.id, persisted));
            rememberFollowUp({ ...followUp, status: "sending", messageId, deliveryMode, error: null, pausedReason: null, updatedAt: new Date().toISOString() });
          } catch (cause) {
            const recovered = !(cause instanceof BerryApiError)
              ? await findPersistedMessage(followUp.sessionId, messageId).catch(() => undefined)
              : undefined;
            if (!recovered) {
              replaceSessionMessages(followUp.sessionId, (current) => current.filter((message) => message.id !== optimistic.id));
              throw cause;
            }
            messageId = recovered.id;
            replaceSessionMessages(followUp.sessionId, (current) => confirmOptimisticMessage(current, optimistic.id, recovered));
            rememberFollowUp({ ...followUp, status: "sending", messageId, deliveryMode, error: null, pausedReason: null, updatedAt: new Date().toISOString() });
          }
        }
        await runTurn(task, {
          input: followUp.input,
          ...(followUp.intent ? { intent: followUp.intent } : {}),
          requestMessageId: messageId,
          ...(followUp.attachments.length > 0 ? { attachments: followUp.attachments } : {}),
        });
      }
      updateSessionFollowUps(followUp.sessionId, (current) => current.filter((item) => item.id !== followUp.id));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to send the queued prompt";
      rememberFollowUp({ ...followUp, status: "failed", messageId, deliveryMode, error: message, pausedReason: null, updatedAt: new Date().toISOString() });
      toast.error(message);
      throw cause;
    } finally {
      followUpSendInFlightRef.current.delete(followUp.id);
    }
  }, [client, findPersistedMessage, interruptAndStartTurn, rememberFollowUp, replaceSessionMessages, runTurn, tasks, updateSessionFollowUps]);

  const sendFollowUpNow = React.useCallback(async (requestedFollowUp: QueuedFollowUp) => {
    // In a connected session delivery is a server/worker concern.  The
    // browser only changes the durable queue state; the worker promotes the
    // next item in the same transaction that completes the active turn.
    if (client) {
      const persisted = await client.updateQueuedFollowUp(requestedFollowUp.id, { status: "queued" });
      updateSessionFollowUps(requestedFollowUp.sessionId, (current) => [
        ...current.filter((item) => item.id !== persisted.id),
        serverQueuedFollowUpToClient(persisted),
      ].sort((left, right) => left.ordinal - right.ordinal));
      return;
    }
    const deliverCurrent = async () => {
      const cached = followUpsBySessionRef.current[requestedFollowUp.sessionId] ?? readQueuedFollowUps(requestedFollowUp.sessionId);
      const stored = readQueuedFollowUps(requestedFollowUp.sessionId);
      const current = queuePersistenceErrorShownRef.current
        ? cached.find((followUp) => followUp.id === requestedFollowUp.id)
        : stored.find((followUp) => followUp.id === requestedFollowUp.id);
      if (!current || current.status === "sending") {
        if (!current) updateSessionFollowUps(requestedFollowUp.sessionId, (followUps) => followUps.filter((followUp) => followUp.id !== requestedFollowUp.id));
        return;
      }
      await deliverFollowUp(current);
    };

    const locks = globalThis.navigator?.locks;
    if (!locks) {
      await deliverCurrent();
      return;
    }
    await locks.request(`berry.web.queueDelivery:${requestedFollowUp.sessionId}`, { mode: "exclusive" }, deliverCurrent);
  }, [client, deliverFollowUp, updateSessionFollowUps]);

  const retryFollowUp = React.useCallback(async (followUp: QueuedFollowUp) => {
    const queued = { ...followUp, status: "queued" as const, error: null, pausedReason: null, updatedAt: new Date().toISOString() };
    rememberFollowUp(queued);
    await sendFollowUpNow(queued);
  }, [rememberFollowUp, sendFollowUpNow]);

  const sendNextQueuedFollowUp = React.useCallback((sessionId: string) => {
    if (client) {
      void refreshQueuedFollowUps(sessionId).catch(() => undefined);
      return;
    }
    const queue = followUpsBySessionRef.current[sessionId] ?? readQueuedFollowUps(sessionId);
    const next = nextQueuedFollowUp(queue, editingFollowUpIdsRef.current.get(sessionId) ?? null);
    if (!next) return;
    void sendFollowUpNow(next).catch(() => undefined);
  }, [client, refreshQueuedFollowUps, sendFollowUpNow]);
  sendNextQueuedFollowUpRef.current = sendNextQueuedFollowUp;

  handleQueueTurnEndRef.current = (sessionId, status) => {
    if (status === "completed") {
      if (client) void refreshQueuedFollowUps(sessionId).catch(() => undefined);
      else window.setTimeout(() => sendNextQueuedFollowUpRef.current(sessionId), 0);
      return;
    }
    if (client) {
      void refreshQueuedFollowUps(sessionId).catch(() => undefined);
      return;
    }
    const pausedReason = status === "cancelled"
      ? "Queue paused because you interrupted the current response."
      : "Queue paused because the current response did not complete.";
    updateSessionFollowUps(sessionId, (current) => current.map((followUp) => followUp.status === "queued" || followUp.status === "sending"
      ? { ...followUp, status: "paused", error: null, pausedReason, updatedAt: new Date().toISOString() }
      : followUp));
  };

  reconcileQueueWithTurnStateRef.current = (sessionId, active, messages) => {
    if (client) {
      if (!active) void refreshQueuedFollowUps(sessionId).catch(() => undefined);
      return;
    }
    const persistedMessageIds = new Set(messages.map((message) => message.id));
    updateSessionFollowUps(sessionId, (current) => reconcileInterruptedQueuedFollowUps(current, active, persistedMessageIds));
    if (!active) window.setTimeout(() => sendNextQueuedFollowUpRef.current(sessionId), 0);
  };

  const setEditingFollowUp = React.useCallback((followUp: QueuedFollowUp | null) => {
    if (followUp) {
      const current = (followUpsBySessionRef.current[followUp.sessionId] ?? []).find((item) => item.id === followUp.id);
      if (!current || current.status === "sending") return false;
      editingFollowUpIdsRef.current.set(followUp.sessionId, followUp.id);
      return true;
    }
    const sessionIds = [...editingFollowUpIdsRef.current.keys()];
    editingFollowUpIdsRef.current.clear();
    for (const sessionId of sessionIds) {
      if (!activeSessionsRef.current.has(sessionId)) {
        window.setTimeout(() => sendNextQueuedFollowUpRef.current(sessionId), 0);
      }
    }
    return true;
  }, []);

  const steerActiveTurn = React.useCallback(async (task: Task, input: string, attachments: AttachmentInput[], intent?: TurnIntent) => {
    await interruptAndStartTurn(task, input, attachments, crypto.randomUUID(), intent);
  }, [interruptAndStartTurn]);

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
      let storedImage: Awaited<ReturnType<BerryApiClient["getFile"]>> | null = null;
      if (generated?.b64_json) {
        try {
          const generatedBytes = await readGeneratedImageBytes(content, "image/png");
          const blob = new Blob([new Uint8Array(generatedBytes)], { type: "image/png" });
          const stored = await client.uploadFile(new File([blob], `generated-${Date.now()}.png`, { type: "image/png" }), { taskId: task.id, sessionId, origin: "image_generation", associationRole: "output" });
          content = stored.previewUrl;
          storedImage = stored;
        } catch {
          // The generated image still belongs in the conversation when the
          // optional artifact-library copy is temporarily unavailable.
        }
      }
      const assistantMessage = await client.appendMessage(sessionId, {
        role: "assistant",
        parts: [{
          kind: "image",
          content: {
            src: content,
            ...(storedImage ? { fileId: storedImage.id, downloadUrl: storedImage.downloadUrl, sizeBytes: storedImage.size } : {}),
            title: generatedImageTitle(trimmedPrompt),
            prompt: trimmedPrompt,
            ...(generated?.revised_prompt ? { revisedPrompt: generated.revised_prompt } : {}),
            aspectRatio: "1:1",
            width: 1024,
            height: 1024,
            mimeType: "image/png",
            transparentBackground: false,
          },
        }],
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

  const generatedImageAttachment = React.useCallback(async (task: Task, image: GeneratedImageView): Promise<AttachmentInput> => {
    if (!client) throw new Error("Image editing requires the live Berry API");
    if (image.fileId) {
      const stored = await client.getFile(image.fileId);
      return {
        id: stored.id,
        fileId: stored.id,
        name: stored.name,
        mediaType: stored.mediaType,
        declaredMediaType: stored.declaredMediaType,
        detectedMediaType: stored.detectedMediaType,
        size: stored.size,
        sourceKind: "generated-image-reference",
      };
    }
    const generatedBytes = await readGeneratedImageBytes(image.src, image.mimeType);
    const blob = new Blob([new Uint8Array(generatedBytes)], { type: image.mimeType });
    const stored = await client.uploadFile(new File([blob], `${image.title || "generated-image"}.${generatedImageExtension(image.mimeType)}`, { type: image.mimeType }), {
      taskId: task.id,
      ...(task.activeSessionId ? { sessionId: task.activeSessionId } : {}),
      origin: "image_generation",
      associationRole: "reference",
    });
    return {
      id: stored.id,
      fileId: stored.id,
      name: stored.name,
      mediaType: stored.mediaType,
      declaredMediaType: stored.declaredMediaType,
      detectedMediaType: stored.detectedMediaType,
      size: stored.size,
      sourceKind: "generated-image-reference",
    };
  }, [client]);

  async function readGeneratedImageBytes(url: string, mediaType: string): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { credentials: generatedFetchCredentials(url), signal: controller.signal });
      if (!response.ok) throw new Error("The source image could not be loaded");
      const bytes = await readResponseBytes(response, PREVIEW_LIMITS.imageBytes);
      assertImagePreviewBounds(new Uint8Array(bytes), mediaType);
      return bytes;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("The source image request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const appendDemoGeneratedImageIteration = React.useCallback((
    task: Task,
    image: GeneratedImageView,
    input: string,
    aspectRatio: ImageAspectRatio,
    titleSuffix: string,
  ) => {
    if (!task.activeSessionId) return;
    const sessionId = task.activeSessionId;
    const marker = Date.now().toString(36);
    const now = new Date().toISOString();
    const userMessage = message(`msg_demo_image_request_${marker}`, sessionId, "user", input);
    userMessage.createdAt = now;
    userMessage.updatedAt = now;
    userMessage.parts.push({
      id: `msg_demo_image_reference_${marker}`,
      messageId: userMessage.id,
      kind: "attachment",
      content: {
        id: `demo_reference_${marker}`,
        name: `${image.title || "generated-image"}.png`,
        mediaType: image.mimeType,
        size: image.sizeBytes ?? 0,
        sourceKind: "generated-image-reference",
      },
      position: 1,
      createdAt: now,
    });
    const dimensions = IMAGE_ASPECT_RATIO_DIMENSIONS[aspectRatio];
    const assistantMessage = message(`msg_demo_image_iteration_${marker}`, sessionId, "assistant", "");
    assistantMessage.createdAt = now;
    assistantMessage.updatedAt = now;
    assistantMessage.parts = [{
      id: `msg_demo_image_iteration_part_${marker}`,
      messageId: assistantMessage.id,
      kind: "image",
      content: {
        src: image.src,
        title: `${image.title} — ${titleSuffix}`,
        prompt: input,
        aspectRatio,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes ?? 0,
        transparentBackground: image.transparentBackground,
        generationId: `demo_generation_${marker}`,
        parentGenerationId: image.generationId ?? null,
      },
      position: 0,
      createdAt: now,
    }];
    replaceSessionMessages(sessionId, (current) => [...current, userMessage, assistantMessage]);
    requestThreadBottom(sessionId);
  }, [replaceSessionMessages, requestThreadBottom]);

  const editGeneratedImage = React.useCallback(async (
    image: GeneratedImageView,
    instruction: string,
    annotations: ImageEditAnnotation[],
  ) => {
    if (!activeTask?.activeSessionId) return;
    const regionInstructions = annotations.map((annotation) =>
      `${annotation.index}. At ${annotation.xPct.toFixed(1)}% from the left and ${annotation.yPct.toFixed(1)}% from the top: ${annotation.text.trim()}`,
    );
    const input = [
      `Edit the attached generated image${instruction ? `: ${instruction}` : "."}`,
      ...(regionInstructions.length > 0 ? ["Region comments:", ...regionInstructions] : []),
      "Create a new image iteration and keep the original visible in the task.",
    ].join("\n");
    if (!client) {
      appendDemoGeneratedImageIteration(activeTask, image, input, image.aspectRatio, "edited");
      return;
    }
    const attachment = await generatedImageAttachment(activeTask, image);
    const userMessage = await client.appendMessage(activeTask.activeSessionId, {
      role: "user",
      parts: [
        { kind: "text", content: input },
        { kind: "attachment", content: messageAttachmentContent(attachment) },
      ],
    });
    replaceSessionMessages(activeTask.activeSessionId, (current) => [...current, userMessage]);
    requestThreadBottom(activeTask.activeSessionId);
    await runTurn(activeTask, { input, intent: "image_generation", requestMessageId: userMessage.id, attachments: [attachment] });
  }, [activeTask, appendDemoGeneratedImageIteration, client, generatedImageAttachment, replaceSessionMessages, requestThreadBottom, runTurn]);

  const regenerateGeneratedImage = React.useCallback(async (
    image: GeneratedImageView,
    aspectRatio: ImageAspectRatio,
  ) => {
    if (!activeTask?.activeSessionId) return;
    const input = `Create a new ${aspectRatio} iteration of the attached generated image. Preserve the subject and visual direction. Keep the original visible in the conversation.`;
    if (!client) {
      appendDemoGeneratedImageIteration(activeTask, image, input, aspectRatio, aspectRatio);
      return;
    }
    const attachment = await generatedImageAttachment(activeTask, image);
    const userMessage = await client.appendMessage(activeTask.activeSessionId, {
      role: "user",
      parts: [
        { kind: "text", content: input },
        { kind: "attachment", content: messageAttachmentContent(attachment) },
      ],
    });
    replaceSessionMessages(activeTask.activeSessionId, (current) => [...current, userMessage]);
    requestThreadBottom(activeTask.activeSessionId);
    await runTurn(activeTask, { input, intent: "image_generation", requestMessageId: userMessage.id, attachments: [attachment] });
  }, [activeTask, appendDemoGeneratedImageIteration, client, generatedImageAttachment, replaceSessionMessages, requestThreadBottom, runTurn]);

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
  const sidebarUser: SignedInUser | null = supportView
    ? { id: supportView.userId, email: supportView.email, name: supportView.name || null, image: null }
    : user;
  const exitSupportView = React.useCallback(() => {
    stopSupportView();
    void navigate({ to: "/admin/$tab", params: { tab: "members" }, search: {} });
  }, [navigate]);

  if (!supportViewReady) {
    return <div className="berry-web-shell bg-background" data-testid="web-app-shell" data-hydrated={false} />;
  }

  return (
    <div className="berry-web-shell flex flex-col" data-testid="web-app-shell" data-hydrated={hydrated}>
      <Toaster position="bottom-right" />
      {supportView ? (
        <div className="relative z-[70] flex min-h-12 shrink-0 items-center justify-between gap-3 bg-[var(--berry-danger)] px-3 py-1.5 text-sm text-white sm:px-4" role="status" data-testid="support-view-banner">
          <span className="min-w-0 truncate">
            Viewing as <strong>{supportView.name || supportView.email}</strong>. Prompts, edits, and task changes apply to this member’s account.
          </span>
          <Button
            type="button"
            onClick={exitSupportView}
            className="h-10 shrink-0 bg-white px-4 text-sm font-semibold text-black transition-transform hover:bg-white/90 active:scale-[0.96] motion-reduce:transform-none"
          >
            Exit support view
          </Button>
        </div>
      ) : null}
      <BerryShellFrame
        className="berry-web-shell-frame"
        sidebarWidth="min(20vw, 18rem)"
        chrome={
          <WebWindowChrome
            onHome={navigateHome}
            onSearch={() => {
              searchReturnFocusRef.current = document.querySelector<HTMLElement>("[data-web-search-trigger]");
              setSearchOpen(true);
            }}
          />
        }
        sidebar={(
          <WebSidebar
            workspaces={projectWorkspaces}
            tasksByWorkspace={tasksByWorkspace}
            generalTasks={generalTasks}
            activeWorkspaceId={activeWorkspaceId}
            activeTaskId={activeTask?.id ?? null}
            loadError={resourceErrors.workspaces || resourceErrors.tasks}
            user={sidebarUser}
            allowance={supportView ? null : allowance}
            allowanceLoading={supportView ? false : allowanceLoading}
            onRefreshAllowance={refreshAllowance}
            onNewTask={() => {
              navigateHome();
            }}
            onCreateProject={() => setCreatingProject(true)}
            onSelectWorkspace={(id) => {
              setActiveWorkspaceId(id);
              navigateHome();
            }}
            onOpenTask={(id) => {
              const task = tasks.find((candidate) => candidate.id === id);
              if (task && workspaces.some((workspace) => workspace.id === task.workspaceId)) setActiveWorkspaceId(task.workspaceId);
              navigateToTask(id);
            }}
            onToggleTaskPinned={toggleTaskPinned}
            onArchiveTask={(task) => archiveTask(task, true)}
            onDeleteTask={deleteTask}
            onRenameTask={renameTask}
            onShareTask={shareTask}
            onToggleProjectPinned={toggleProjectPinned}
            onRenameProject={renameProject}
            onArchiveProjectTasks={archiveProjectTasks}
            onRemoveProject={removeProject}
            onRevealProject={revealProject}
            onUploadToProject={uploadToProject}
            onSelectTasks={() => {
              if (generalWorkspace) setActiveWorkspaceId(generalWorkspace.id);
              navigateHome();
            }}
            tasksSelected={!activeTask && Boolean(generalWorkspace && activeWorkspaceId === generalWorkspace.id)}
            librarySelected={surface === "library"}
            management={surface === "settings" ? {
              kind: managementKind,
              tab: managementTab,
              permissions: effectiveOrgPermissions,
              platformAuthorized: config.platformAuthorized,
              onNavigate: navigateManagement,
              onBack: navigateBackToWorkspace,
            } : null}
            onSkills={() => navigateToSettings("skills")}
            onLibrary={() => navigateToLibrary("all")}
            onUsage={() => navigateToSettings("usage")}
            onSettings={() => navigateToSettings("general")}
            onSignOut={() => void signOut()}
          />
        )}
      >
      <div ref={mainPanelRef} className="berry-web-main flex h-full min-h-0 flex-col">
        <React.Suspense fallback={shouldMountTaskSurface(surface) ? <LazySurfaceFallback label="Loading task" /> : null}>
        <div className={shouldMountTaskSurface(surface) ? "contents" : "hidden"}>
        {shouldMountTaskSurface(surface) && activeTask && !activeTask.deletedAt ? (
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
                  <DropdownMenuItem onClick={() => { if (activeTask) void toggleTaskPinned(activeTask); }}>{activeTask?.pinned ? <PinOff /> : <Pin />} {activeTask?.pinned ? "Unpin task" : "Pin task"}</DropdownMenuItem>
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
                onClick={() => { if (activeTask) void toggleTaskPinned(activeTask); }}
                className="berry-titlebar-control"
              >
                {activeTask?.pinned ? <PinOff /> : <Pin />}
              </Button>
              <WebHelpMenu />
            </>
          }
        />
        <div className="workspace">
          <section className="thread-pane berry-task-thread" aria-label="Task">
            <Thread
              sessionId={activeTask.activeSessionId ?? activeTask.id}
              taskId={activeTask.id}
              messages={messages}
              stream={stream}
              client={client}
              config={config}
              taskTitles={taskTitles}
              imageGeneration={imageGenerationBySession[activeTask.activeSessionId ?? activeTask.id] ?? null}
              onRetryImage={(prompt) => void generateImage(activeTask, prompt, false)}
              onEditGeneratedImage={editGeneratedImage}
              onRegenerateGeneratedImage={regenerateGeneratedImage}
              editTurn={activeTask.activeSessionId ? editTurn : undefined}
              recoveryRequired={durableState?.runState === "recovery_required"}
              activeStatus={durableTurnPhase(durableState)}
              cancelTurn={cancelTurn}
              onViewTaskFiles={() => setTaskFilesOpen(true)}
              onLoadOlderMessages={client ? loadOlderActiveMessages : undefined}
              hasOlderMessages={activeMessageHistory?.hasOlder ?? false}
              loadingOlderMessages={activeMessageHistory?.loadingOlder ?? false}
              scrollRequest={threadScrollRequest?.sessionId === (activeTask.activeSessionId ?? activeTask.id) ? threadScrollRequest.id : 0}
            />
            <Composer
              config={config}
              activeTask={activeTask}
              taskTitles={taskTitles}
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
              streaming={turnBusy || stream.turnActive || Boolean(durableState?.active)}
              reasoning={reasoning}
              onReasoningChange={updateReasoning}
              onCommand={runSlashCommand}
              queuedFollowUps={activeTask.activeSessionId ? followUpsBySession[activeTask.activeSessionId] ?? [] : []}
              onQueuedFollowUp={enqueueFollowUp}
              onRemoveFollowUp={removeFollowUp}
              onRetryFollowUp={retryFollowUp}
              onReorderFollowUps={reorderFollowUps}
              onSteerFollowUp={sendFollowUpNow}
              onUpdateFollowUp={updateFollowUp}
              onResumeFollowUps={resumeFollowUps}
              onEditingFollowUpChange={setEditingFollowUp}
              onSteerMessage={steerActiveTurn}
              question={stream.question}
              streamSessionId={activeTask.activeSessionId}
              streamMessages={messages}
              showProjectSwitcher={shouldShowComposerProjectSwitcher(messages)}
              personalization={personalization}
              imageGenerationCapability={imageGenerationCapability}
              onCreateTask={createTask}
              onCancel={() => void cancelTurn()}
              onContinueTurn={activeTask.activeSessionId && interruptedTurnAvailable
                ? durableState?.runState === "recovery_required"
                  ? recoverDurableTurn
                  : continueTurn
                : undefined}
              runTurn={runTurn}
              onUserMessage={(text, sessionId, taskId, attachments, messageId) => {
                if (messageId) markRequestMessagePending(sessionId, messageId);
                const user = optimisticUserMessage(sessionId, text, attachments, messageId);
                const nextTitle = text.trim().slice(0, 42);
                requestThreadBottom(sessionId);
                replaceSessionMessages(sessionId, (current) => current.some((item) => item.id === user.id)
                  ? current
                  : [...current, user]);
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
        ) : (
          (shouldMountTaskSurface(surface) && shellLocation.kind === "task") ? (
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
        ) : shouldMountTaskSurface(surface) ? (
          <BerryWorkspaceHomeFrame
            logo={<DeploymentBrandLogo className="berry-home-greeting-logo" alt="" />}
            greeting={homeGreeting}
            help={<WebHelpMenu />}
            error={Object.values(resourceErrors).find(Boolean) ? <p className="composer-error" role="alert">{Object.values(resourceErrors).find(Boolean)}</p> : undefined}
            composer={(
              <Composer
                config={config}
                activeTask={null}
                taskTitles={taskTitles}
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
                onQueuedFollowUp={enqueueFollowUp}
                onRemoveFollowUp={removeFollowUp}
                onRetryFollowUp={retryFollowUp}
                onReorderFollowUps={reorderFollowUps}
                onSteerFollowUp={sendFollowUpNow}
                onUpdateFollowUp={updateFollowUp}
                onResumeFollowUps={resumeFollowUps}
                onEditingFollowUpChange={setEditingFollowUp}
                onSteerMessage={steerActiveTurn}
                showProjectSwitcher
                personalization={personalization}
                imageGenerationCapability={imageGenerationCapability}
                onCreateTask={createTask}
                onCancel={() => void cancelTurn()}
                runTurn={runTurn}
                onUserMessage={(text, sessionId, _taskId, attachments, messageId) => {
                  if (messageId) markRequestMessagePending(sessionId, messageId);
                  const user = optimisticUserMessage(sessionId, text, attachments, messageId);
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
        ) : null)}
        </div>
        </React.Suspense>
        {surface === "settings" ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            <React.Suspense fallback={<LazySurfaceFallback label="Loading settings" />}>
              <ManagementRouteProvider value={{ config, client, tenantId: activeOrganizationId, userId: user?.id ?? null, user, personalization, onPersonalizationChange: setPersonalization, permissions: effectiveOrgPermissions, tasks, workspaces, onArchiveTask: archiveTask, onDeleteTask: deleteTask, onRestoreTask: restoreTask }}>
                <Outlet />
              </ManagementRouteProvider>
            </React.Suspense>
          </div>
        ) : null}
        {surface === "library" ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <React.Suspense fallback={<LazySurfaceFallback label="Loading library" />}>
              <ArtifactLibrary
                client={client}
                tab={shellLocation.kind === "library" ? shellLocation.tab : "all"}
                onTabChange={navigateToLibrary}
                workspaces={workspaces}
              />
            </React.Suspense>
          </div>
        ) : null}
      </div>
      <ProjectCreationDialog
        container={mainPanelRef.current}
        open={creatingProject}
        onOpenChange={setCreatingProject}
        onSubmit={createProject}
      />
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
        onSettings={supportView ? undefined : () => navigateToSettings("general")}
        onHelp={() => toast.info("Berry help and diagnostics are available from the ? button.")}
      />
      {shouldMountTaskSurface(surface) && activeTask && taskFilesOpen ? (
        <React.Suspense fallback={null}>
          <TaskFileLibraryDialog
            open
            onOpenChange={setTaskFilesOpen}
            client={client}
            taskId={activeTask.id}
            projectWorkspaceId={activeTask.workspaceId}
            projectName={workspaces.find((workspace) => workspace.id === activeTask.workspaceId)?.name ?? "this project"}
          />
        </React.Suspense>
      ) : null}
      {connectionState === "offline" ? <div className="fixed bottom-3 right-3 z-[80] rounded-full bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-lg" role="status">Offline</div> : null}
    </div>
  );
}

function ProjectCreationDialog({
  container,
  open,
  onOpenChange,
  onSubmit,
}: {
  container: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container} className="w-[calc(100%-2rem)] gap-5 sm:max-w-[24rem]" aria-describedby="create-project-description">
        <DialogHeader className="gap-1.5">
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription id="create-project-description">Group related tasks and files in one place.</DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-2">
            <label htmlFor="project-name" className="text-sm font-medium">Project name</label>
            <Input id="project-name" name="projectName" placeholder="e.g. Product launch" autoFocus required maxLength={120} />
          </div>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
            <Button type="submit">Create project</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The web thread renders through the shared desktop presentation
 * (BerryThreadView) with a cloud adapter: message editing rewinds through the
 * API, approvals/questions resolve over HTTP, and fork stays desktop-only.
 */

function optimisticUserMessage(sessionId: string, text: string, attachments: AttachmentInput[] | undefined, messageId?: string): Message {
  const id = messageId ?? `${OPTIMISTIC_MESSAGE_ID_PREFIX}${globalThis.crypto.randomUUID()}`;
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


export function greetingForHour(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function greetingForDate(date: Date): string {
  return greetingForHour(date.getHours());
}

function LazySurfaceFallback({ label }: { label: string }) {
  return (
    <section className="berry-route-state flex flex-1 items-center justify-center" aria-live="polite" aria-busy="true">
      <CircularActivitySpinner size={28} label={label} />
    </section>
  );
}
