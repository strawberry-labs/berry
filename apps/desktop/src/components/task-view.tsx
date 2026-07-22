import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandManifest, JsonValue, Message, ModelProvider, ReasoningLevel, SandboxStatus, Session, SessionTarget, Task } from "@berry/shared";
import {
  Archive,
  ArchiveRestore,
  ArrowRight02,
  ChevronDown,
  CircleCheckIcon,
  CircleHelp,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  GitPullRequest,
  LayoutAlignBottom,
  LayoutAlignRight,
  Pin,
  PinOff,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Button } from "@berry/desktop-ui/components/ui/button";
import { BerryTaskHeaderFrame } from "@berry/desktop-ui/components/berry-task-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@berry/desktop-ui/components/ui/resizable";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import { useSidebar } from "@berry/desktop-ui/components/ui/sidebar";

import { callWithApprovalRetry, host, useWorkbench } from "@/lib/berry";
import { useSquircle } from "@/lib/squircle";
import { Composer, serializeAttachment, useStartTurn, type QueuedFollowUpChip } from "@/components/composer";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { HelpMenu } from "@/components/help-menu";
import { Thread, useThreadStream } from "@/components/thread";
import type { ToolEntry } from "@/components/thread-stream";
import { TimelineDialog } from "@/components/timeline-dialog";
import { ArchiveWorktreeDialog } from "@/components/archive-worktree-dialog";
import { WorktreeMergeDialog } from "@/components/worktree-merge-dialog";
import { WorkPane, type WorkPaneTab } from "@/components/work-pane";
import { ImageGeneration, ImageGenerationError } from "@berry/desktop-ui/components/image-generation";

const TerminalPane = React.lazy(() => import("@/components/terminal-pane").then((module) => ({ default: module.TerminalPane })));

interface CommandOutput {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  [key: string]: JsonValue;
}

interface FileTarget {
  path: string;
  line?: number;
  nonce: number;
}

interface BrowserTarget {
  sessionId?: string;
  url?: string;
  nonce: number;
}

export function TaskView({ taskId }: { taskId: string }) {
  const { activeWorkspace, tasks, openHome, openTask } = useWorkbench();
  // When the sidebar is collapsed on desktop, the floating titlebar controls
  // sit over the top-left of the main panel. Reserve a leading lane in the
  // header so the branch chip and title never render underneath them. On
  // mobile the floating controls are hidden, so no lane is needed.
  const { state: sidebarState, isMobile } = useSidebar();
  const reserveControlLane = sidebarState === "collapsed" && !isMobile;
  const panePrefsKey = `berry.workPane.${taskId}`;
  const [terminalOpen, setTerminalOpen] = React.useState(() => readPanePrefs(panePrefsKey).terminalOpen ?? false);
  const [sidePaneOpen, setSidePaneOpen] = React.useState(() => readPanePrefs(panePrefsKey).open ?? false);
  const [sidePaneTab, setSidePaneTab] = React.useState<WorkPaneTab>(() => readPanePrefs(panePrefsKey).tab ?? "terminal");
  const [sideLayout, setSideLayout] = React.useState<[number, number]>(() => readPanePrefs(panePrefsKey).layout ?? [62, 38]);
  const [fileTarget, setFileTarget] = React.useState<FileTarget | null>(null);
  const [browserTarget, setBrowserTarget] = React.useState<BrowserTarget | null>(null);
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const [worktreeMergeOpen, setWorktreeMergeOpen] = React.useState(false);
  const [archiveWorktreeOpen, setArchiveWorktreeOpen] = React.useState(false);
  const [prActionNonce, setPrActionNonce] = React.useState(0);
  const [imageGeneration, setImageGeneration] = React.useState<{ prompt: string; status: "generating" | "error"; message?: string } | null>(null);

  const taskFromList = tasks.find((task) => task.id === taskId);
  const taskQuery = useQuery({
    queryKey: ["task.get", taskId],
    queryFn: async () => {
      const list = await host.call<Task[]>("task.list", {
        workspaceId: activeWorkspace?.id ?? "",
        includeArchived: true,
        includeDeleted: true,
      });
      return list.find((task) => task.id === taskId) ?? null;
    },
    enabled: !taskFromList && Boolean(activeWorkspace),
  });
  const task = taskFromList ?? taskQuery.data ?? null;
  const sessionId = task?.activeSessionId ?? null;
  const activeWorkspaceId = activeWorkspace?.id ?? null;

  const stream = useThreadStream(sessionId);
  const activeImageTool = [...stream.timeline].reverse().find(
    (entry): entry is ToolEntry => entry.kind === "tool" && entry.name === "image_generation" && entry.status === "running",
  );
  const conversationKind = task?.conversationKind ?? "chat";
  const workbenchMode = conversationKind === "code";
  const [queuedFollowUps, setQueuedFollowUps] = React.useState<QueuedFollowUpChip[]>([]);
  const startTurn = useStartTurn();
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: ["model.provider.list"],
    queryFn: () => host.call<ModelProvider[]>("model.provider.list"),
  });
  // The session remembers its provider/model across turns and reloads; fall
  // back to the first enabled provider only for sessions that never ran.
  const sessionQuery = useQuery({
    queryKey: ["session.get", sessionId],
    queryFn: () => host.call<Session>("session.get", { sessionId }),
    enabled: Boolean(sessionId),
  });
  const sandboxQuery = useQuery({
    queryKey: ["sandbox.status", activeWorkspaceId, taskId, sessionQuery.data?.permissionMode],
    queryFn: () => host.call<SandboxStatus>("sandbox.status", {
      workspaceId: activeWorkspaceId!,
      taskId,
      permissionMode: sessionQuery.data?.permissionMode ?? "ask",
    }),
    enabled: Boolean(activeWorkspaceId && sessionQuery.data),
  });
  const rewindMessagesQuery = useQuery({
    queryKey: ["session.messages", sessionId],
    queryFn: () => host.call<Message[]>("session.messages", { sessionId }),
    enabled: Boolean(sessionId),
  });
  const targetQuery = useQuery({
    queryKey: ["session.target.get", sessionId],
    queryFn: () => host.call<SessionTarget | null>("session.target.get", { sessionId }),
    enabled: Boolean(sessionId),
  });
  const reasoningQuery = useQuery({
    queryKey: ["settings.get", "agent.reasoning"],
    queryFn: () => host.call<ReasoningLevel | null>("settings.get", { key: "agent.reasoning" }),
  });
  const sessionTarget = targetQuery.data ?? null;
  const sessionProvider = (providersQuery.data ?? []).find((provider) => provider.id === sessionQuery.data?.modelProviderId);
  const activeProvider = sessionProvider ?? (providersQuery.data ?? []).find((provider) => provider.enabled);
  const interruptedTurn = continuableInterruption(rewindMessagesQuery.data ?? []) ?? (task?.status === "cancelled" ? "cancelled" : null);

  const continueTurn = React.useCallback(async () => {
    if (!task || !sessionId || !sessionQuery.data || !activeProvider) return;
    await startTurn.mutateAsync({
      taskId: task.id,
      sessionId,
      continueInterruptedTurn: true,
      submission: {
        input: "",
        attachments: [],
        permissionMode: sessionQuery.data.permissionMode,
        reasoning: reasoningQuery.data ?? "medium",
        providerId: activeProvider.id,
        model: sessionQuery.data.model ?? activeProvider.defaultModel,
        credentialRef: activeProvider.credentialRef ?? null,
        createInWorktree: false,
      },
    });
  }, [activeProvider, reasoningQuery.data, sessionId, sessionQuery.data, startTurn, task]);

  // Git branch chip in the header.
  const branchQuery = useQuery({
    queryKey: ["git.branch", activeWorkspace?.id, taskId],
    queryFn: () => host.call<{ stdout?: string }>("git.branch", { workspaceId: activeWorkspace?.id ?? "", taskId }),
    enabled: Boolean(activeWorkspace),
    staleTime: 30_000,
  });
  const branchName = (branchQuery.data?.stdout ?? "").trim() || "No branch";

  // Editable title: click to rename, Enter saves, Escape cancels.
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState("");
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const workspacePillRef = React.useRef<HTMLButtonElement>(null);
  const branchPillRef = React.useRef<HTMLDivElement>(null);
  useSquircle(workspacePillRef, 13, 1);
  useSquircle(branchPillRef, 13, 1);
  const startRename = () => {
    setDraftTitle(task?.title ?? "");
    setEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  };
  const saveTitle = async () => {
    const next = draftTitle.trim();
    setEditingTitle(false);
    if (!task || !next || next === task.title) return;
    await host.call("task.update", { id: task.id, title: next });
    await queryClient.invalidateQueries({ queryKey: ["task.list"] });
  };

  const togglePinned = async () => {
    if (!task) return;
    await host.call("task.setPinned", { id: task.id, pinned: !task.pinned });
    await queryClient.invalidateQueries({ queryKey: ["task.list"] });
    toast.success(task.pinned ? "Task unpinned" : "Task pinned");
  };

  const toggleArchived = async () => {
    if (!task) return;
    if (!task.archived && task.worktreePath && task.worktreeBranch) {
      setArchiveWorktreeOpen(true);
      return;
    }
    await host.call("task.setArchived", { id: task.id, archived: !task.archived });
    await queryClient.invalidateQueries({ queryKey: ["task.list"] });
    toast.success(task.archived ? "Task restored" : "Task archived");
  };

  const deleteTask = async () => {
    if (!task) return;
    await host.call("task.delete", { id: task.id });
    await queryClient.invalidateQueries({ queryKey: ["task.list"] });
    openHome();
    toast.success("Task deleted");
  };

  const restoreDeletedTask = async () => {
    if (!task) return;
    await host.call("task.restore", { id: task.id });
    await queryClient.invalidateQueries({ queryKey: ["task.list"] });
    toast.success("Task restored");
  };

  const openInFinder = async () => {
    if (!activeWorkspace) return;
    await host.call("system.openPath", { workspaceId: activeWorkspace.id, taskId, path: "." });
  };

  const compactSession = React.useCallback(async (reasoning?: ReasoningLevel) => {
    if (!sessionId) return;
    const params: Record<string, JsonValue> = { sessionId };
    if (activeProvider?.id) params.providerId = activeProvider.id;
    const model = sessionQuery.data?.model ?? activeProvider?.defaultModel;
    if (model) params.model = model;
    if (activeProvider?.credentialRef) params.credentialRef = activeProvider.credentialRef;
    if (reasoning) params.reasoning = reasoning;
    await host.call("session.compact", params);
    await queryClient.refetchQueries({ queryKey: ["session.messages", sessionId] });
    toast.success("Conversation compacted");
  }, [activeProvider, queryClient, sessionId, sessionQuery.data]);

  const forkSession = React.useCallback(async () => {
    await host.call("session.fork", { sessionId });
    await queryClient.invalidateQueries({ queryKey: ["task.list"] });
    await queryClient.invalidateQueries({ queryKey: ["session.get"] });
    await queryClient.invalidateQueries({ queryKey: ["session.messages"] });
    await queryClient.invalidateQueries({ queryKey: ["session.target.get"] });
    openTask(taskId);
    toast.success("Fork created");
  }, [openTask, queryClient, sessionId, taskId]);

  const rewindSession = React.useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      await host.call("session.rewind", { sessionId, entryId: messageId });
      await queryClient.invalidateQueries({ queryKey: ["session.messages", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["task.list"] });
      toast.success("Conversation rewound");
    },
    [queryClient, sessionId],
  );

  const setSessionTarget = React.useCallback(
    async (goalText: string, status: SessionTarget["status"] = "active", source?: SessionTarget | null) => {
      if (!sessionId) return null;
      const target = await host.call<SessionTarget>("session.target.set", {
        sessionId,
        goalText,
        status,
        tokenBudget: source?.tokenBudget ?? null,
        timeBudgetMin: source?.timeBudgetMin ?? null,
      });
      await queryClient.invalidateQueries({ queryKey: ["session.target.get", sessionId] });
      return target;
    },
    [queryClient, sessionId],
  );

  const clearSessionTarget = React.useCallback(async () => {
    if (!sessionId) return;
    await host.call("session.target.clear", { sessionId });
    await queryClient.invalidateQueries({ queryKey: ["session.target.get", sessionId] });
  }, [queryClient, sessionId]);

  const runRewindSlashCommand = React.useCallback(
    async (input: string): Promise<boolean> => {
      const parsed = parseSlashCommand(input);
      if (!parsed || parsed.name !== "rewind") return false;
      if (!sessionId) return true;
      const turns = (await host.call<Message[]>("session.messages", { sessionId })).filter((message) => message.role === "user");
      const index = Number.parseInt(parsed.args[0] ?? "", 10);
      if (!Number.isInteger(index) || index < 1 || index > turns.length) {
        toast.error(turns.length > 0 ? `Usage: /rewind 1-${turns.length}` : "No user messages to rewind");
        return true;
      }
      await rewindSession(turns[index - 1]!.id);
      return true;
    },
    [rewindSession, sessionId],
  );

  const runGoalSlashCommand = React.useCallback(
    async (input: string): Promise<boolean> => {
      const parsed = parseSlashCommand(input);
      if (!parsed || parsed.name !== "goal") return false;
      const [action, ...rest] = parsed.args;
      const normalizedAction = action?.toLowerCase();
      const text =
        normalizedAction === "set" || normalizedAction === "replace"
          ? rest.join(" ").trim()
          : normalizedAction === "pause" || normalizedAction === "resume" || normalizedAction === "clear"
            ? ""
            : parsed.args.join(" ").trim();
      const current = sessionTarget ?? (sessionId ? await host.call<SessionTarget | null>("session.target.get", { sessionId }) : null);

      if (normalizedAction === "clear") {
        await clearSessionTarget();
        toast.success("Goal cleared");
        return true;
      }
      if (normalizedAction === "pause") {
        if (!current) {
          toast.error("No goal to pause");
          return true;
        }
        await setSessionTarget(current.goalText, "paused", current);
        toast.success("Goal paused");
        return true;
      }
      if (normalizedAction === "resume") {
        if (!current) {
          toast.error("No goal to resume");
          return true;
        }
        await setSessionTarget(current.goalText, "active", current);
        toast.success("Goal resumed");
        return true;
      }
      if (!text) {
        toast.error("Usage: /goal <goal>, /goal pause, /goal resume, or /goal clear");
        return true;
      }
      await setSessionTarget(text, "active", null);
      toast.success("Goal set");
      return true;
    },
    [clearSessionTarget, sessionId, sessionTarget, setSessionTarget],
  );

  const runPrSlashCommand = React.useCallback(async (input: string): Promise<boolean> => {
    const parsed = parseSlashCommand(input);
    if (!parsed || parsed.name !== "pr") return false;
    if (parsed.args.length > 0) {
      toast.error("Usage: /pr");
      return true;
    }
    setSidePaneOpen(true);
    setSidePaneTab("review");
    setPrActionNonce((value) => value + 1);
    return true;
  }, []);

  const generateImage = React.useCallback(async (prompt: string, appendUserMessage: boolean) => {
    if (!sessionId) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;
    setImageGeneration({ prompt: trimmedPrompt, status: "generating" });
    try {
      if (appendUserMessage) {
        await host.call("session.appendMessage", {
          sessionId,
          role: "user",
          parts: [{ kind: "text", content: `/image ${trimmedPrompt}` }],
        });
      }
      const result = await host.call<{ data?: Array<{ url?: string; b64_json?: string }> }>("router.image.generate", {
        prompt: trimmedPrompt,
        size: "1024x1024",
      });
      const image = result.data?.[0];
      const content = image?.b64_json ? `data:image/png;base64,${image.b64_json}` : image?.url;
      if (!content) throw new Error("The image provider returned no image data");
      await host.call("session.appendMessage", {
        sessionId,
        role: "assistant",
        parts: [{ kind: "image", content }],
      });
      setImageGeneration(null);
      await queryClient.refetchQueries({ queryKey: ["session.messages", sessionId] });
    } catch (error) {
      setImageGeneration({
        prompt: trimmedPrompt,
        status: "error",
        message: error instanceof Error ? error.message : "The image provider could not complete the request",
      });
    }
  }, [queryClient, sessionId]);

  const runImageSlashCommand = React.useCallback(async (input: string): Promise<boolean> => {
    const parsed = parseSlashCommand(input);
    if (!parsed || parsed.name !== "image") return false;
    if (stream.turnActive || imageGeneration?.status === "generating") {
      toast.error("Wait for the current image generation to finish");
      return true;
    }
    const prompt = parsed.args.join(" ").trim();
    if (!prompt) {
      toast.error("Usage: /image <prompt>");
      return true;
    }
    await generateImage(prompt, true);
    return true;
  }, [generateImage, imageGeneration?.status, stream.turnActive]);

  const runCustomSlashCommand = React.useCallback(
    async (input: string): Promise<boolean> => {
      if (!task || !activeWorkspaceId) return false;
      const parsed = parseSlashCommand(input);
      if (!parsed) return false;
      const commands = await host.call<CommandManifest[]>("command.list", { workspaceId: activeWorkspaceId });
      const command = commands.find((item) => item.name === parsed.name && item.enabled && !item.id.startsWith("slash_"));
      if (!command) return false;
      await host.call("session.appendMessage", {
        sessionId,
        role: "user",
        parts: [{ kind: "text", content: input }],
      });
      try {
        const output = await callWithApprovalRetry<CommandOutput>("command.run", {
          workspaceId: activeWorkspaceId,
          taskId: task.id,
          sessionId,
          id: command.id,
          permissionMode: sessionQuery.data?.permissionMode ?? "ask",
        });
        await host.call("session.appendMessage", {
          sessionId,
          role: "assistant",
          parts: [{ kind: output.exitCode === 0 ? "text" : "error", content: commandOutputMarkdown(command, output) }],
        });
      } catch (error) {
        await host.call("session.appendMessage", {
          sessionId,
          role: "assistant",
          parts: [{ kind: "error", content: error instanceof Error ? error.message : "Command failed" }],
        });
        throw error;
      } finally {
        await queryClient.refetchQueries({ queryKey: ["session.messages", sessionId] });
      }
      return true;
    },
    [activeWorkspaceId, queryClient, sessionId, sessionQuery.data?.permissionMode, task],
  );

  React.useEffect(() => {
    const onToggleTerminal = () => setTerminalOpen((open) => !open);
    window.addEventListener("berry:toggle-terminal", onToggleTerminal);
    return () => window.removeEventListener("berry:toggle-terminal", onToggleTerminal);
  }, []);

  React.useEffect(() => {
    const prefs = readPanePrefs(panePrefsKey);
    setTerminalOpen(prefs.terminalOpen ?? false);
    setSidePaneOpen(prefs.open ?? false);
    setSidePaneTab(prefs.tab ?? "terminal");
    setSideLayout(prefs.layout ?? [62, 38]);
  }, [panePrefsKey]);

  React.useEffect(() => {
    writePanePrefs(panePrefsKey, { terminalOpen, open: sidePaneOpen, tab: sidePaneTab, layout: sideLayout });
  }, [panePrefsKey, sideLayout, sidePaneOpen, sidePaneTab, terminalOpen]);

  React.useEffect(() => {
    const onOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: unknown; line?: unknown }>).detail;
      if (!detail || typeof detail.path !== "string") return;
      const normalized = normalizeWorkspacePath(detail.path, activeWorkspace?.path ?? "");
      setFileTarget({
        path: normalized,
        ...(typeof detail.line === "number" && Number.isFinite(detail.line) ? { line: detail.line } : {}),
        nonce: Date.now(),
      });
      setSidePaneOpen(true);
      setSidePaneTab("files");
    };
    window.addEventListener("berry:open-file", onOpenFile);
    return () => window.removeEventListener("berry:open-file", onOpenFile);
  }, [activeWorkspace?.path]);

  React.useEffect(() => {
    const onOpenBrowser = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; url?: unknown }>).detail;
      setBrowserTarget({
        ...(typeof detail?.sessionId === "string" && detail.sessionId.length > 0 ? { sessionId: detail.sessionId } : {}),
        ...(typeof detail?.url === "string" && detail.url.length > 0 ? { url: detail.url } : {}),
        nonce: Date.now(),
      });
      setSidePaneOpen(true);
      setSidePaneTab("browser");
    };
    window.addEventListener("berry:open-browser", onOpenBrowser);
    return () => window.removeEventListener("berry:open-browser", onOpenBrowser);
  }, []);

  React.useEffect(() => {
    if (!task?.unreadAt) return;
    void host.call("task.markRead", { id: task.id }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["task.list"] });
    });
  }, [queryClient, task?.id, task?.unreadAt]);

  React.useEffect(() => {
    setQueuedFollowUps([]);
  }, [sessionId]);

  React.useEffect(() => {
    if (!stream.turnActive) setQueuedFollowUps([]);
  }, [stream.turnActive]);

  if (!task || !sessionId || !activeWorkspace) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Task not found</div>;
  }

  const thread = (
    <div
      className={`berry-task-thread berry-task-thread--${conversationKind} flex h-full min-h-0 flex-col`}
      data-conversation-kind={conversationKind}
    >
      {sessionTarget ? (
        <SessionGoalCard
          target={sessionTarget}
          onPause={() => void setSessionTarget(sessionTarget.goalText, "paused", sessionTarget).then(() => toast.success("Goal paused"))}
          onResume={() => void setSessionTarget(sessionTarget.goalText, "active", sessionTarget).then(() => toast.success("Goal resumed"))}
          onClear={() => void clearSessionTarget().then(() => toast.success("Goal cleared"))}
        />
      ) : null}
      <ConversationArtifacts messages={rewindMessagesQuery.data ?? []} />
      <Thread
        sessionId={sessionId}
        taskId={task.id}
        stream={stream}
        density={workbenchMode ? "full" : "compact"}
        autoScroll
      />
      {activeImageTool && imageGeneration === null ? (
        <ImageGeneration
          prompt={typeof activeImageTool.args?.prompt === "string" ? activeImageTool.args.prompt : undefined}
        />
      ) : null}
      {imageGeneration?.status === "generating" ? <ImageGeneration prompt={imageGeneration.prompt} /> : null}
      {imageGeneration?.status === "error" ? (
        <ImageGenerationError
          prompt={imageGeneration.prompt}
          message={imageGeneration.message ?? "The image provider could not complete the request"}
          onRetry={() => void generateImage(imageGeneration.prompt, false)}
        />
      ) : null}
      <div className="berry-thread-composer-wrap mx-auto max-w-full px-4 pb-5">
        {interruptedTurn && !stream.turnActive ? (
          <div className="mb-2 flex justify-end">
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-full px-4 transition-[background-color,color,box-shadow,opacity,transform] active:scale-[0.96]"
              disabled={startTurn.isPending}
              onClick={() => void continueTurn()}
              title={interruptedTurn === "cancelled" ? "Continue the stopped turn" : "Continue after the provider error"}
            >
              <ArrowRight02 />
              Continue
            </Button>
          </div>
        ) : null}
        <Composer
          variant="thread"
          autoFocus={false}
          sessionId={sessionId}
          taskId={task.id}
          conversationKind={conversationKind}
          sessionSelection={
            sessionQuery.data
              ? { providerId: sessionQuery.data.modelProviderId, model: sessionQuery.data.model }
              : undefined
          }
          streaming={stream.turnActive || startTurn.isPending || imageGeneration?.status === "generating"}
          onCancel={() => void host.call("agent.cancel", { sessionId })}
          allowSubmitWhileStreaming
          queuedFollowUps={queuedFollowUps}
          onSubmit={async (submission) => {
            const command = submission.input.trim();
            if (await runImageSlashCommand(command)) return;
            if (command === "/compact") {
              await compactSession(submission.reasoning);
              return;
            }
            if (command === "/fork") {
              await forkSession();
              return;
            }
            if (await runRewindSlashCommand(command)) return;
            if (await runGoalSlashCommand(command)) return;
            if (await runPrSlashCommand(command)) return;
            if (await runCustomSlashCommand(command)) return;
            if (stream.turnActive) {
              const queueMessages = await host.call<boolean | null>("settings.get", { key: "composer.queueMessages" });
              try {
                await host.call(queueMessages ? "agent.followUp" : "agent.steer", {
                  taskId: task.id,
                  sessionId,
                  input: submission.input,
                  reasoning: submission.reasoning,
                  attachments: submission.attachments.map(serializeAttachment),
                });
                if (queueMessages) {
                  setQueuedFollowUps((current) => [
                    ...current,
                    { id: `queued_${Date.now()}_${current.length}`, text: submission.input },
                  ]);
                }
              } catch (error) {
                throw new Error(error instanceof Error ? error.message : "No active turn is available for steering");
              }
              return;
            }
            await startTurn.mutateAsync({ taskId: task.id, sessionId, submission });
          }}
        />
      </div>
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BerryTaskHeaderFrame reserveControlLane={reserveControlLane}>
        <div className="berry-task-header-left flex min-w-0 items-center gap-2">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveTitle();
                } else if (event.key === "Escape") {
                  setEditingTitle(false);
                }
              }}
              aria-label="Rename task"
              className="berry-task-title-input min-w-0 max-w-[min(42vw,460px)] px-2"
            />
          ) : (
            <button
              type="button"
              onClick={startRename}
              title="Rename task"
              className="berry-task-title-input min-w-0 max-w-[min(42vw,460px)] shrink truncate px-2 text-left"
            >
              {task.title}
            </button>
          )}
          {workbenchMode ? <WorkspaceSwitcher>
            <button ref={workspacePillRef} type="button" aria-label="Switch workspace" className="berry-task-pill berry-task-pill--interactive shrink-0">
              <Folder />
              <span className="truncate">{activeWorkspace.name}</span>
              <ChevronDown className="berry-task-pill-caret" />
            </button>
          </WorkspaceSwitcher> : null}
          {workbenchMode ? <div ref={branchPillRef} className="berry-task-pill hidden shrink-0 sm:inline-flex" title={branchName}>
            <GitBranch />
            <span className="truncate font-mono">{branchName}</span>
          </div> : null}
          {sandboxQuery.data ? (
            <Badge
              variant={sandboxQuery.data.enforcement === "enforced" ? "outline" : "secondary"}
              className="hidden shrink-0 gap-1 sm:inline-flex"
              title={sandboxQuery.data.reason ?? `${sandboxQuery.data.mechanism} enforcement; network ${sandboxQuery.data.network}`}
            >
              <ShieldCheck />
              {sandboxQuery.data.tier === "workspace-write" ? "Workspace sandbox" : sandboxQuery.data.tier === "read-only" ? "Read only" : "Full access"}
              {sandboxQuery.data.enforcement === "approval-only" ? " (approval only)" : ""}
            </Badge>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More actions" className="berry-titlebar-control shrink-0">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={startRename}>
              <Pencil /> Rename task
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void togglePinned()}>
              {task.pinned ? <PinOff /> : <Pin />} {task.pinned ? "Unpin task" : "Pin task"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void toggleArchived()}>
              {task.archived ? <ArchiveRestore /> : <Archive />} {task.archived ? "Restore task" : "Archive task"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void (task.deletedAt ? restoreDeletedTask() : deleteTask())}>
              {task.deletedAt ? <ArchiveRestore /> : <Trash2 />} {task.deletedAt ? "Restore deleted task" : "Delete task"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openInFinder()}>
              <FolderOpen /> Open in Finder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(task.id);
                toast.success("Task ID copied");
              }}
            >
              <Copy /> Copy task ID
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void forkSession()}>
              <GitFork /> Fork conversation
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTimelineOpen(true)}>
              <RefreshCw /> Task timeline
            </DropdownMenuItem>
            {task.worktreePath && task.worktreeBranch ? (
              <DropdownMenuItem onClick={() => setWorktreeMergeOpen(true)}>
                <GitPullRequest /> Merge worktree changes
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => void compactSession()}>
              <Archive /> Compact conversation
            </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={task.pinned ? "Unpin task" : "Pin task"}
                aria-pressed={task.pinned}
                onClick={() => void togglePinned()}
                className="berry-titlebar-control"
              >
                {task.pinned ? <PinOff /> : <Pin />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{task.pinned ? "Unpin task" : "Pin task"}</TooltipContent>
          </Tooltip>
          <HelpMenu>
            <Button variant="ghost" size="icon-lg" aria-label="Help" className="berry-titlebar-control">
              <CircleHelp />
            </Button>
          </HelpMenu>
          {workbenchMode ? <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label="Toggle terminal"
                aria-pressed={terminalOpen}
                className="berry-titlebar-control"
                onClick={() => setTerminalOpen((open) => !open)}
              >
                <LayoutAlignBottom />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle terminal ⌘J</TooltipContent>
          </Tooltip> : null}
          {workbenchMode ? <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label="Toggle side pane"
                aria-pressed={sidePaneOpen}
                className="berry-titlebar-control"
                onClick={() => setSidePaneOpen((open) => !open)}
              >
                <LayoutAlignRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle side pane</TooltipContent>
          </Tooltip> : null}
        </div>
      </BerryTaskHeaderFrame>
      <TimelineDialog
        open={timelineOpen}
        onOpenChange={setTimelineOpen}
        taskId={task.id}
        workspaceId={activeWorkspace.id}
        sessionId={sessionId}
        turnActive={stream.turnActive}
      />
      {task.worktreeBranch ? (
        <WorktreeMergeDialog
          open={worktreeMergeOpen}
          onOpenChange={setWorktreeMergeOpen}
          taskId={task.id}
          taskTitle={task.title}
          branch={task.worktreeBranch}
        />
      ) : null}
      {task.worktreeBranch ? (
        <ArchiveWorktreeDialog
          open={archiveWorktreeOpen}
          onOpenChange={setArchiveWorktreeOpen}
          taskId={task.id}
          branch={task.worktreeBranch}
        />
      ) : null}

      <div className="min-h-0 flex-1">
        {workbenchMode && sidePaneOpen ? (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={{ thread: sideLayout[0], work: sideLayout[1] }}
            onLayoutChanged={(layout) => setSideLayout(toPaneLayout(layout))}
          >
            <ResizablePanel id="thread" defaultSize="62%" minSize="420px">
              {terminalOpen ? <ThreadWithTerminal thread={thread} workspaceId={activeWorkspace.id} taskId={task.id} /> : thread}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="work" defaultSize="38%" minSize="320px">
              <WorkPane
                workspaceId={activeWorkspace.id}
                taskId={task.id}
                activeTab={sidePaneTab}
                onActiveTabChange={setSidePaneTab}
                fileTarget={fileTarget}
                browserTarget={browserTarget}
                prActionNonce={prActionNonce}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : workbenchMode && terminalOpen ? (
          <ThreadWithTerminal thread={thread} workspaceId={activeWorkspace.id} taskId={task.id} />
        ) : (
          thread
        )}
      </div>
    </div>
  );
}

function ConversationArtifacts({ messages }: { messages: Message[] }) {
  const artifacts = recentArtifacts(messages);
  if (artifacts.length === 0) return null;
  return (
    <section className="berry-conversation-artifacts mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 px-6 pt-3" aria-label="Conversation artifacts">
      <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 gap-1.5 overflow-hidden">
        {artifacts.map((artifact) => <span key={artifact} className="berry-artifact-label truncate" title={artifact}>{artifact}</span>)}
      </div>
    </section>
  );
}

function recentArtifacts(messages: Message[]): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const path = value.trim().replace(/^\.\//, "");
    if (!paths.includes(path)) paths.push(path);
  };
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool-call" && part.kind !== "tool-result") continue;
      if (!part.content || typeof part.content !== "object" || Array.isArray(part.content)) continue;
      const meta = part.content as Record<string, JsonValue>;
      const name = typeof meta.name === "string" ? meta.name : "";
      if (name === "browser_screenshot") {
        const output = meta.output && typeof meta.output === "object" && !Array.isArray(meta.output) ? meta.output as Record<string, JsonValue> : {};
        const artifact = output.artifact && typeof output.artifact === "object" && !Array.isArray(output.artifact) ? output.artifact as Record<string, JsonValue> : {};
        add(artifact.path);
        add(output.path);
      } else if (["write_file", "edit_file", "apply_patch"].includes(name)) {
        const args = meta.arguments && typeof meta.arguments === "object" && !Array.isArray(meta.arguments) ? meta.arguments as Record<string, JsonValue> : {};
        add(args.path);
        add(args.file_path);
        if (name === "apply_patch" && typeof args.patch === "string") {
          for (const match of args.patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) add(match[1]);
        }
      }
    }
  }
  return paths.slice(-4).reverse();
}

function SessionGoalCard({
  target,
  onPause,
  onResume,
  onClear,
}: {
  target: SessionTarget;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const paused = target.status === "paused";
  return (
    <div
      data-testid="session-goal-card"
      className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border bg-background/80 px-4 py-2 text-sm"
    >
      <CircleCheckIcon className="size-4 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Goal</span>
        <span className="min-w-0 truncate text-foreground" title={target.goalText}>
          {target.goalText}
        </span>
        <Badge variant={paused ? "outline" : target.status === "met" ? "secondary" : "default"} className="h-5 shrink-0 px-1.5 text-[10px]">
          {target.status}
        </Badge>
        {target.timeBudgetMin ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{target.timeBudgetMin}m</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {paused ? (
          <Button size="sm" variant="outline" onClick={onResume}>
            Resume
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onPause}>
            Pause
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

function readPanePrefs(key: string): { terminalOpen?: boolean; open?: boolean; tab?: WorkPaneTab; layout?: [number, number] } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { terminalOpen?: unknown; open?: unknown; tab?: unknown; layout?: unknown };
    return {
      ...(typeof parsed.terminalOpen === "boolean" ? { terminalOpen: parsed.terminalOpen } : {}),
      ...(typeof parsed.open === "boolean" ? { open: parsed.open } : {}),
      ...(typeof parsed.tab === "string" && isWorkPaneTab(parsed.tab) ? { tab: parsed.tab } : {}),
      ...(typeof parsed.layout === "object" && parsed.layout !== null ? { layout: toPaneLayout(parsed.layout as Record<string, unknown>) } : {}),
    };
  } catch {
    return {};
  }
}

function writePanePrefs(key: string, prefs: { terminalOpen: boolean; open: boolean; tab: WorkPaneTab; layout: [number, number] }): void {
  localStorage.setItem(key, JSON.stringify({ ...prefs, layout: { thread: prefs.layout[0], work: prefs.layout[1] } }));
}

function toPaneLayout(value: Record<string, unknown>): [number, number] {
  const left = typeof value.thread === "number" && Number.isFinite(value.thread) ? value.thread : 62;
  const right = typeof value.work === "number" && Number.isFinite(value.work) ? value.work : 38;
  return [left, right];
}

function isWorkPaneTab(value: string): value is WorkPaneTab {
  return value === "terminal" || value === "browser" || value === "review" || value === "files";
}

function continuableInterruption(messages: Message[]): "provider-error" | "cancelled" | null {
  const latest = messages.at(-1);
  if (!latest || latest.role !== "assistant") return null;
  if (latest.status === "cancelled") return "cancelled";
  if (latest.status !== "failed") return null;
  return latest.parts.some(
    (part) => part.kind === "error" && /Provider request failed with (?:429|5\d\d)\b/i.test(String(part.content)),
  )
    ? "provider-error"
    : null;
}

function normalizeWorkspacePath(path: string, workspacePath: string): string {
  const normalized = path.replace(/\\/g, "/");
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && normalized === root) return "";
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized.replace(/^\.?\//, "");
}

function parseSlashCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName = "", ...args] = trimmed.split(/\s+/);
  const name = rawName.slice(1);
  return name ? { name, args } : null;
}

function commandOutputMarkdown(command: CommandManifest, output: CommandOutput): string {
  const header = `/${command.name} exited with code ${output.exitCode}`;
  const stdout = output.stdout.trim();
  const stderr = output.stderr.trim();
  const chunks = [header];
  if (stdout) chunks.push(["stdout", "```text", stdout, "```"].join("\n"));
  if (stderr) chunks.push(["stderr", "```text", stderr, "```"].join("\n"));
  if (!stdout && !stderr) chunks.push("(no output)");
  return chunks.join("\n\n");
}

function ThreadWithTerminal({ thread, workspaceId, taskId }: { thread: React.ReactNode; workspaceId: string; taskId: string }) {
  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="68%" minSize="240px">
        {thread}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="32%" minSize="140px">
        <React.Suspense fallback={<ThreadTerminalSkeleton />}>
          <TerminalPane workspaceId={workspaceId} taskId={taskId} className="h-full" />
        </React.Suspense>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ThreadTerminalSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 bg-background p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-32 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
      <Skeleton className="min-h-0 flex-1 rounded-lg" />
    </div>
  );
}
