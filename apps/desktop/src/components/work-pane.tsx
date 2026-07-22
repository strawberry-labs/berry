import * as React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BrowserSession, GitBranchInfo, GitChangedFile, GitInfo, GitPrStatus, GitPullRequestView, ModelProvider, ReviewComment, ReviewCommentAnchor, ReviewFinding, ReviewSession, Task } from "@berry/shared";
import { ArrowLeft02, ArrowRight02, Camera, Copy, FileText, Files, GitBranch, GitPullRequest, Globe, ImagePlus, Plus, RefreshCw, SquareTerminal, X } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { ScrollArea, ScrollBar } from "@berry/desktop-ui/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { cn } from "@berry/desktop-ui/lib/utils";

import { callWithApprovalRetry, host, useHostEvent } from "@/lib/berry";
import { DiffViewer } from "@/components/diff-viewer";
import { FilesPanel } from "@/components/files-panel";
import { PrCreateDialog } from "@/components/pr-create-dialog";

const TerminalPane = React.lazy(() => import("@/components/terminal-pane").then((module) => ({ default: module.TerminalPane })));

export type WorkPaneTab = "terminal" | "browser" | "review" | "files";

interface BrowserTarget {
  sessionId?: string;
  url?: string;
  nonce: number;
}

interface CommandOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  path?: string;
}

interface BrowserScreenshotOutput extends CommandOutput {
  path: string;
  name?: string;
  mediaType?: string;
  size?: number;
  dataUrl?: string;
}

interface BrowserScreenshotAttachment {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  dataUrl?: string | null;
}

const TABS: Array<{ id: WorkPaneTab; label: string; icon: React.ElementType }> = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "review", label: "Review", icon: GitPullRequest },
  { id: "files", label: "Files", icon: Files },
];

export function WorkPane({
  workspaceId,
  taskId,
  activeTab,
  onActiveTabChange,
  fileTarget,
  browserTarget,
  prActionNonce,
}: {
  workspaceId: string;
  taskId: string;
  activeTab: WorkPaneTab;
  onActiveTabChange: (tab: WorkPaneTab) => void;
  fileTarget?: { path: string; line?: number; nonce: number } | null;
  browserTarget?: BrowserTarget | null;
  prActionNonce?: number;
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        if (isWorkPaneTab(value)) onActiveTabChange(value);
      }}
      className="h-full gap-0 overflow-hidden bg-background"
    >
      <div className="flex h-9 shrink-0 items-center border-b border-border bg-[var(--berry-surface-raised)] px-1">
        <TabsList className="h-7 w-full justify-start rounded-none bg-transparent p-0">
          {TABS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="h-7 flex-none rounded-[8px] px-2.5 text-xs">
              <Icon />
              <span>{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="terminal" className="min-h-0">
        <React.Suspense fallback={<TerminalPaneSkeleton />}>
          <TerminalPane workspaceId={workspaceId} taskId={taskId} className="h-full" />
        </React.Suspense>
      </TabsContent>
      <TabsContent value="browser" className="min-h-0">
        <BrowserPane workspaceId={workspaceId} taskId={taskId} target={browserTarget ?? undefined} />
      </TabsContent>
      <TabsContent value="review" className="min-h-0">
        <ReviewPane workspaceId={workspaceId} taskId={taskId} prActionNonce={prActionNonce ?? 0} />
      </TabsContent>
      <TabsContent value="files" className="min-h-0">
        <FilesPanel workspaceId={workspaceId} taskId={taskId} mode="pane" target={fileTarget ?? undefined} />
      </TabsContent>
    </Tabs>
  );
}

function TerminalPaneSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 bg-background p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-36 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>
      <Skeleton className="min-h-0 flex-1 rounded-lg" />
    </div>
  );
}

function BrowserPane({ workspaceId, taskId, target }: { workspaceId: string; taskId: string; target?: BrowserTarget }) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState("https://example.com");
  const [snapshot, setSnapshot] = React.useState("");
  const [screenshotPath, setScreenshotPath] = React.useState("");
  const [screenshotAttachment, setScreenshotAttachment] = React.useState<BrowserScreenshotAttachment | null>(null);
  const [busy, setBusy] = React.useState(false);

  const sessionsQuery = useQuery({
    queryKey: ["browser.session.list", workspaceId, taskId],
    queryFn: () => host.call<BrowserSession[]>("browser.session.list", { workspaceId, taskId }),
  });
  const sessions = sessionsQuery.data ?? [];
  const openSessions = React.useMemo(() => sessions.filter((session) => session.status !== "closed"), [sessions]);
  const activeSession = openSessions.find((session) => session.id === sessionId) ?? null;

  useHostEvent((event) => {
    if (event.type !== "browser.session.updated" || event.session.workspaceId !== workspaceId) return;
    queryClient.setQueryData<BrowserSession[]>(["browser.session.list", workspaceId, taskId], (current = []) => [
      event.session,
      ...current.filter((session) => session.id !== event.session.id),
    ]);
    if (event.session.status !== "closed") {
      setSessionId((current) => current ?? event.session.id);
      if (event.session.currentUrl) {
        setUrl((current) => current === "https://example.com" || sessionId === event.session.id ? event.session.currentUrl! : current);
      }
    }
  });

  React.useEffect(() => {
    if (sessionId && openSessions.some((session) => session.id === sessionId)) return;
    const first = openSessions[0];
    setSessionId(first?.id ?? null);
    if (first?.currentUrl) setUrl(first.currentUrl);
  }, [openSessions, sessionId]);

  const createSession = React.useCallback(async (targetUrl: string) => {
    const created = await callWithApprovalRetry<BrowserSession>("browser.session.create", { workspaceId, taskId, url: targetUrl || "about:blank" });
    setSessionId(created.id);
    if (created.currentUrl) setUrl(created.currentUrl);
    setScreenshotPath("");
    setScreenshotAttachment(null);
    setSnapshot("");
    await queryClient.invalidateQueries({ queryKey: ["browser.session.list", workspaceId, taskId] });
    return created.id;
  }, [queryClient, taskId, workspaceId]);

  const ensureSession = React.useCallback(async (targetUrl: string, preferredSessionId?: string | null) => {
    const selectedId = preferredSessionId ?? sessionId;
    if (selectedId && openSessions.some((session) => session.id === selectedId)) return selectedId;
    return createSession(targetUrl);
  }, [createSession, openSessions, sessionId]);

  const refreshSessions = React.useCallback(async (selectedId: string) => {
    const refreshed = await host.call<BrowserSession[]>("browser.session.list", { workspaceId, taskId }).catch(() => null);
    if (!refreshed) return;
    queryClient.setQueryData(["browser.session.list", workspaceId, taskId], refreshed);
    const selected = refreshed.find((session) => session.id === selectedId);
    if (selected?.currentUrl) setUrl(selected.currentUrl);
  }, [queryClient, taskId, workspaceId]);

  const run = React.useCallback(async (
    action: "navigate" | "snapshot" | "screenshot" | "back" | "forward" | "reload",
    overrideUrl?: string,
    overrideSessionId?: string,
  ) => {
    setBusy(true);
    try {
      const targetUrl = overrideUrl ?? url;
      const id = await ensureSession(targetUrl, overrideSessionId);
      if (action === "navigate") {
        const output = await callWithApprovalRetry<CommandOutput>("browser.navigate", { id, workspaceId, taskId, url: targetUrl });
        setSnapshot(output.stdout ?? "");
        setUrl(targetUrl);
      } else if (action === "back" || action === "forward" || action === "reload") {
        const output = await host.call<CommandOutput>(`browser.${action}`, { id, workspaceId, taskId });
        setSnapshot(output.stdout ?? output.stderr ?? "");
      } else if (action === "snapshot") {
        const output = await host.call<CommandOutput>("browser.snapshot", { id, workspaceId, taskId });
        setSnapshot(output.stdout ?? output.stderr ?? "");
      } else {
        const output = await host.call<BrowserScreenshotOutput>("browser.screenshot", { id, workspaceId, taskId });
        setScreenshotPath(output.path ?? "");
        setScreenshotAttachment(browserScreenshotAttachment(output, id));
        if (output.stdout) setSnapshot(output.stdout);
      }
      await queryClient.invalidateQueries({ queryKey: ["browser.session.list", workspaceId, taskId] });
      await refreshSessions(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Browser action failed");
    } finally {
      setBusy(false);
    }
  }, [ensureSession, queryClient, refreshSessions, taskId, url, workspaceId]);

  React.useEffect(() => {
    if (!target) return;
    if (target.sessionId) setSessionId(target.sessionId);
    if (target.url) {
      setUrl(target.url);
      void run("navigate", target.url, target.sessionId);
    }
  }, [run, target]);

  const closeSession = async (id: string) => {
    setBusy(true);
    try {
      await host.call("browser.close", { id, workspaceId, taskId });
      const remaining = openSessions.filter((session) => session.id !== id);
      const next = remaining[0] ?? null;
      setSessionId(next?.id ?? null);
      if (next?.currentUrl) setUrl(next.currentUrl);
      await queryClient.invalidateQueries({ queryKey: ["browser.session.list", workspaceId, taskId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Close browser tab failed");
    } finally {
      setBusy(false);
    }
  };

  const imageSrc = screenshotImageSrc(screenshotPath);
  const attachScreenshot = React.useCallback(() => {
    if (!screenshotAttachment) return;
    window.dispatchEvent(new CustomEvent("berry:add-attachments", { detail: { workspaceId, files: [screenshotAttachment] } }));
  }, [screenshotAttachment, workspaceId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-2" role="tablist" aria-label="Browser tabs">
        {openSessions.length > 0 ? (
          openSessions.map((session, index) => (
            <div
              key={session.id}
              className={cn(
                "flex h-7 min-w-0 max-w-40 items-center gap-0.5 rounded-md pr-0.5 pl-2 text-xs",
                session.id === sessionId ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={session.id === sessionId}
                className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={session.currentUrl ?? undefined}
                onClick={() => {
                  setSessionId(session.id);
                  if (session.currentUrl) setUrl(session.currentUrl);
                }}
              >
                <Globe />
                <span className="min-w-0 truncate">{browserTabTitle(session, index)}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${browserTabTitle(session, index)}`}
                className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-background/60 hover:text-foreground"
                onClick={() => void closeSession(session.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))
        ) : (
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">No browser tabs</div>
        )}
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label="New browser tab" onClick={() => void createSession("about:blank")}>
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy || !activeSession}
          aria-label="Duplicate browser tab"
          onClick={() => void createSession(activeSession?.currentUrl ?? url)}
        >
          <Copy />
        </Button>
      </div>
      <form
        className="flex shrink-0 items-center gap-1.5 border-b border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run("navigate");
        }}
      >
        <Button type="button" variant="outline" size="icon-sm" disabled={busy || !activeSession} aria-label="Back" onClick={() => void run("back")}>
          <ArrowLeft02 />
        </Button>
        <Button type="button" variant="outline" size="icon-sm" disabled={busy || !activeSession} aria-label="Forward" onClick={() => void run("forward")}>
          <ArrowRight02 />
        </Button>
        <Button type="button" variant="outline" size="icon-sm" disabled={busy || !activeSession} aria-label="Reload" onClick={() => void run("reload")}>
          <RefreshCw />
        </Button>
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label="Browser URL"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={busy}>
          <Globe />
          Go
        </Button>
        <Button type="button" variant="outline" size="icon-sm" disabled={busy} aria-label="Snapshot" onClick={() => void run("snapshot")}>
          <RefreshCw />
        </Button>
        <Button type="button" variant="outline" size="icon-sm" disabled={busy} aria-label="Screenshot" onClick={() => void run("screenshot")}>
          <Camera />
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || !screenshotAttachment} onClick={attachScreenshot}>
          <ImagePlus />
          Attach
        </Button>
      </form>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(120px,34%)]">
        <div className="min-h-0 border-b border-border bg-[var(--berry-surface-inset)]">
          {imageSrc ? (
            <ScrollArea className="h-full">
              <img
                src={imageSrc}
                alt="Browser screenshot"
                className="m-3 max-w-[calc(100%-1.5rem)] rounded-[18px] bg-background object-contain outline outline-1 -outline-offset-1 outline-black/10 shadow-[var(--berry-ring-subtle)] dark:outline-white/10"
              />
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {screenshotPath ? screenshotPath : "No screenshot captured"}
            </div>
          )}
        </div>
        <ScrollArea className="min-h-0 scroll-fade">
          <pre className="p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
            {snapshot || "No browser snapshot"}
          </pre>
        </ScrollArea>
      </div>
    </div>
  );
}

function ReviewPane({ workspaceId, taskId, prActionNonce }: { workspaceId: string; taskId: string; prActionNonce: number }) {
  const queryClient = useQueryClient();
  const [checkpointing, setCheckpointing] = React.useState(false);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [baseBranch, setBaseBranch] = React.useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = React.useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const [aiReviewBusy, setAiReviewBusy] = React.useState(false);
  const [prCreateOpen, setPrCreateOpen] = React.useState(false);
  const handledPrAction = React.useRef(0);
  const infoQuery = useQuery({
    queryKey: ["git.info", workspaceId, taskId],
    queryFn: () => host.call<GitInfo>("git.info", { workspaceId, taskId }),
  });
  const branchesQuery = useQuery({
    queryKey: ["git.branches", workspaceId, taskId],
    queryFn: () => host.call<{ current: string | null; branches: GitBranchInfo[] }>("git.branches", { workspaceId, taskId }),
  });
  const changedQuery = useQuery({
    queryKey: ["git.changedFiles", workspaceId, taskId],
    queryFn: () => host.call<GitChangedFile[]>("git.changedFiles", { workspaceId, taskId }),
  });
  const prStatusQuery = useQuery({
    queryKey: ["git.pr.status", workspaceId, taskId],
    queryFn: () => host.call<GitPrStatus>("git.pr.status", { workspaceId, taskId }),
  });
  const taskQuery = useQuery({
    queryKey: ["task.list", workspaceId],
    queryFn: () => host.call<Task[]>("task.list", { workspaceId, includeArchived: true }),
  });
  const task = taskQuery.data?.find((candidate) => candidate.id === taskId) ?? null;
  const prViewQuery = useQuery({
    queryKey: ["git.pr.view", workspaceId, taskId, task?.pullRequestNumber],
    queryFn: () => host.call<GitPullRequestView>("git.pr.view", { workspaceId, taskId, number: task!.pullRequestNumber! }),
    enabled: Boolean(prStatusQuery.data?.authenticated && task?.pullRequestNumber),
  });
  const reviewSessionsQuery = useQuery({
    queryKey: ["review.session.list", workspaceId, taskId],
    queryFn: () => host.call<ReviewSession[]>("review.session.list", { workspaceId, taskId }),
  });
  const reviewProvidersQuery = useQuery({ queryKey: ["model.provider.list"], queryFn: () => host.call<ModelProvider[]>("model.provider.list", {}) });
  const info = infoQuery.data;
  const baseBranchOptions = React.useMemo(() => branchOptions(branchesQuery.data?.branches ?? [], info?.defaultBranch), [branchesQuery.data?.branches, info?.defaultBranch]);
  const selectedBaseBranch = baseBranch ?? info?.defaultBranch ?? null;
  const diffQuery = useQuery({
    queryKey: ["git.diff", workspaceId, taskId, selectedPath, selectedBaseBranch],
    queryFn: () => host.call<CommandOutput>("git.diff", {
      workspaceId,
      taskId,
      ...(selectedPath ? { path: selectedPath } : {}),
      ...(selectedBaseBranch ? { baseBranch: selectedBaseBranch } : {}),
    }),
  });
  const changedFiles = changedQuery.data ?? [];
  const reviewSessions = reviewSessionsQuery.data ?? [];
  const selectedReview = reviewSessions.find((session) => session.id === selectedReviewId)
    ?? reviewSessions.find((session) => session.status === "active")
    ?? reviewSessions[0]
    ?? null;
  const reviewCommentsQuery = useQuery({
    queryKey: ["review.comment.list", selectedReview?.id],
    queryFn: () => host.call<ReviewComment[]>("review.comment.list", { reviewSessionId: selectedReview!.id }),
    enabled: Boolean(selectedReview),
  });
  const reviewFindingsQuery = useQuery({
    queryKey: ["review.finding.list", selectedReview?.id],
    queryFn: () => host.call<ReviewFinding[]>("review.finding.list", { reviewSessionId: selectedReview!.id }),
    enabled: Boolean(selectedReview),
  });

  React.useEffect(() => {
    if (baseBranch || !info?.defaultBranch) return;
    setBaseBranch(info.defaultBranch);
  }, [baseBranch, info?.defaultBranch]);

  React.useEffect(() => {
    if (selectedPath || changedFiles.length === 0) return;
    setSelectedPath(changedFiles[0]!.path);
  }, [changedFiles, selectedPath]);

  React.useEffect(() => {
    if (!selectedReviewId && selectedReview) setSelectedReviewId(selectedReview.id);
  }, [selectedReview, selectedReviewId]);

  React.useEffect(() => {
    if (prActionNonce <= handledPrAction.current || !prStatusQuery.data || taskQuery.isLoading) return;
    handledPrAction.current = prActionNonce;
    if (!prStatusQuery.data.installed || !prStatusQuery.data.authenticated) {
      toast.error("Complete GitHub CLI setup to use /pr");
      return;
    }
    if (task?.pullRequestNumber) {
      void prViewQuery.refetch().then(() => toast.success(`Pull request #${task.pullRequestNumber} refreshed`));
      return;
    }
    setPrCreateOpen(true);
  }, [prActionNonce, prStatusQuery.data, prViewQuery, task?.pullRequestNumber, taskQuery.isLoading]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["git.info", workspaceId, taskId] });
    void queryClient.invalidateQueries({ queryKey: ["git.branches", workspaceId, taskId] });
    void queryClient.invalidateQueries({ queryKey: ["git.changedFiles", workspaceId, taskId] });
    void queryClient.invalidateQueries({ queryKey: ["git.diff", workspaceId, taskId] });
    void queryClient.invalidateQueries({ queryKey: ["git.pr.view", workspaceId, taskId] });
  };

  const mutateGit = async (method: "git.stage" | "git.unstage", paths: string[]) => {
    try {
      const output = await callWithApprovalRetry<CommandOutput>(method, { workspaceId, taskId, paths });
      if (output.exitCode !== 0) toast.error(output.stderr || output.stdout || "Git action failed");
      else refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Git action failed");
    }
  };

  const revertFile = async (path: string) => {
    if (!window.confirm(`Revert changes in ${path}?`)) return;
    try {
      const output = await callWithApprovalRetry<CommandOutput>("git.revertFile", { workspaceId, taskId, path });
      if (output.exitCode !== 0) toast.error(output.stderr || output.stdout || "Revert failed");
      else {
        toast.success("File reverted");
        refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Revert failed");
    }
  };

  const copyPatch = async () => {
    try {
      const output = await host.call<{ patch: string }>("git.copyPatch", {
        workspaceId,
        taskId,
        ...(selectedPath ? { path: selectedPath } : {}),
        ...(selectedBaseBranch ? { baseBranch: selectedBaseBranch } : {}),
      });
      await navigator.clipboard.writeText(output.patch);
      toast.success("Patch copied");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Copy patch failed");
    }
  };

  const copySetupCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    toast.success("Command copied");
  };

  const checkpoint = async () => {
    setCheckpointing(true);
    try {
      const output = await host.call<CommandOutput>("git.checkpoint", {
        workspaceId,
        taskId,
        message: `Berry checkpoint ${new Date().toISOString()}`,
      });
      if (output.exitCode && output.exitCode !== 0) {
        toast.error(output.stderr || output.stdout || "Checkpoint failed");
      } else {
        toast.success("Checkpoint created");
        refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Checkpoint failed");
    } finally {
      setCheckpointing(false);
    }
  };

  const startReview = async () => {
    setReviewBusy(true);
    try {
      const created = await host.call<ReviewSession>("review.session.create", { workspaceId, taskId, scope: { kind: "working-tree", baseBranch: selectedBaseBranch } });
      setSelectedReviewId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["review.session.list", workspaceId, taskId] });
      toast.success("Review started");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start review");
    } finally { setReviewBusy(false); }
  };

  const completeReview = async () => {
    if (!selectedReview || selectedReview.status !== "active") return;
    setReviewBusy(true);
    try {
      await host.call("review.session.complete", { id: selectedReview.id });
      await queryClient.invalidateQueries({ queryKey: ["review.session.list", workspaceId, taskId] });
      toast.success("Review completed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not complete review");
    } finally { setReviewBusy(false); }
  };

  const createReviewComment = async (anchor: ReviewCommentAnchor, body: string) => {
    if (!selectedReview) return;
    await host.call("review.comment.create", { reviewSessionId: selectedReview.id, anchor, body });
    await queryClient.invalidateQueries({ queryKey: ["review.comment.list", selectedReview.id] });
  };

  const resolveReviewComment = async (comment: ReviewComment, resolved: boolean) => {
    await host.call("review.comment.resolve", { id: comment.id, resolved });
    await queryClient.invalidateQueries({ queryKey: ["review.comment.list", comment.reviewSessionId] });
  };

  const createPullRequestComment = async (anchor: ReviewCommentAnchor, body: string) => {
    if (!task?.pullRequestNumber) return;
    await callWithApprovalRetry("git.pr.comment.create", { workspaceId, taskId, number: task.pullRequestNumber, anchor, body });
    await queryClient.invalidateQueries({ queryKey: ["git.pr.view", workspaceId, taskId, task.pullRequestNumber] });
    toast.success("Review comment posted");
  };

  const replyToPullRequestComment = async (comment: ReviewComment, body: string) => {
    if (!task?.pullRequestNumber || !comment.externalId) return;
    await callWithApprovalRetry("git.pr.comment.reply", { workspaceId, taskId, number: task.pullRequestNumber, commentId: comment.externalId, body });
    await queryClient.invalidateQueries({ queryKey: ["git.pr.view", workspaceId, taskId, task.pullRequestNumber] });
    toast.success("Reply posted");
  };

  const runAiReview = async () => {
    if (!selectedReview || selectedReview.status !== "active") return;
    const provider = reviewProvidersQuery.data?.find((candidate) => candidate.enabled);
    if (!provider) { toast.error("Enable a model provider before starting AI review"); return; }
    setAiReviewBusy(true);
    try {
      await host.call("review.start", { reviewSessionId: selectedReview.id, providerId: provider.id, credentialRef: provider.credentialRef });
      await reviewFindingsQuery.refetch();
      toast.success("AI review verified");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI review failed");
    } finally { setAiReviewBusy(false); }
  };

  const convertFinding = async (finding: ReviewFinding) => {
    await host.call("review.finding.convert", { id: finding.id });
    await Promise.all([reviewFindingsQuery.refetch(), reviewCommentsQuery.refetch()]);
  };

  const applyFinding = async (finding: ReviewFinding) => {
    try {
      await callWithApprovalRetry("review.finding.apply", { id: finding.id });
      await Promise.all([reviewFindingsQuery.refetch(), queryClient.invalidateQueries({ queryKey: ["git.diff", workspaceId, taskId] }), queryClient.invalidateQueries({ queryKey: ["git.changedFiles", workspaceId, taskId] })]);
      toast.success("Suggestion applied");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not apply suggestion"); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-sm font-medium">
          <GitBranch />
          <span className="truncate">{info?.branch ?? "No branch"}</span>
          {selectedBaseBranch ? <Badge variant="outline" className="shrink-0 text-muted-foreground">base {selectedBaseBranch}</Badge> : null}
          {info && (info.ahead > 0 || info.behind > 0) ? (
            <span className="shrink-0 text-xs text-muted-foreground">+{info.ahead} / -{info.behind}</span>
          ) : null}
        </div>
        {baseBranchOptions.length > 0 ? (
          <Select value={selectedBaseBranch ?? baseBranchOptions[0] ?? ""} onValueChange={(value) => setBaseBranch(value || null)}>
            <SelectTrigger className="h-7 w-36 text-xs" aria-label="Review base branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {baseBranchOptions.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Refresh review" onClick={refresh}>
          <RefreshCw />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Copy patch" onClick={() => void copyPatch()}>
          <Copy />
        </Button>
        <Button size="sm" disabled={checkpointing} onClick={() => void checkpoint()}>
          Checkpoint
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto scroll-fade">
        <div className="flex min-w-0 max-w-full flex-col gap-3 p-3">
          {prStatusQuery.data && (!prStatusQuery.data.installed || !prStatusQuery.data.authenticated) ? (
            <section className="min-w-0 border-b border-border px-1 pb-3" aria-label="GitHub CLI setup">
              <div className="flex min-w-0 items-start gap-3">
                <GitPullRequest className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">GitHub CLI setup</span>
                    <Badge variant="outline">{prStatusQuery.data.installed ? "Sign in required" : "Not installed"}</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {prStatusQuery.data.installed ? "Authenticate gh for github.com before creating or reviewing pull requests." : "Install gh, then authenticate it for github.com."}
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" className="size-10 shrink-0" aria-label="Retry GitHub CLI check" onClick={() => void prStatusQuery.refetch()}>
                  <RefreshCw />
                </Button>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {prStatusQuery.data.setupCommands.map((command) => (
                  <div key={command} className="flex min-w-0 items-center gap-2 rounded-md bg-[var(--berry-surface-inset)] px-3 py-2">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{command}</code>
                    <Button variant="ghost" size="icon-sm" className="size-10 shrink-0" aria-label={`Copy ${command}`} onClick={() => void copySetupCommand(command)}>
                      <Copy />
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {task?.pullRequestUrl ? (
            <section className="flex min-w-0 items-center gap-3 border-b border-border px-1 pb-3" aria-label="Task pull request">
              <GitPullRequest className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2"><span className="truncate text-xs font-medium">{prViewQuery.data?.title ?? `Pull request #${task.pullRequestNumber}`}</span>{prViewQuery.data ? <Badge variant="outline">{prViewQuery.data.state.toLowerCase()}</Badge> : null}</div>
                {prViewQuery.data ? <div className="mt-0.5 flex flex-wrap gap-x-1 text-[10px] text-muted-foreground"><span>#{prViewQuery.data.number}</span><span>·</span><span>{prViewQuery.data.head} → {prViewQuery.data.base}</span><span>·</span><span>{prViewQuery.data.draft ? "Draft" : "Ready"}</span>{prViewQuery.data.mergeable ? <><span>·</span><span className="capitalize">{prViewQuery.data.mergeable.toLowerCase()}</span></> : null}</div> : null}
                <a href={task.pullRequestUrl} target="_blank" rel="noreferrer" className="block truncate text-xs text-primary hover:underline">{task.pullRequestUrl}</a>
              </div>
              <div className="flex shrink-0 items-center gap-1"><Button variant="ghost" size="icon-sm" className="size-10" aria-label="Refresh pull request" onClick={() => void prViewQuery.refetch()}><RefreshCw /></Button><Button variant="ghost" size="sm" className="h-10" onClick={() => window.open(task.pullRequestUrl!, "_blank", "noopener,noreferrer")}><GitPullRequest />Open</Button><Button variant="ghost" size="icon-sm" className="size-10" aria-label="Copy pull request URL" onClick={() => void copySetupCommand(task.pullRequestUrl!)}><Copy /></Button></div>
            </section>
          ) : null}
          <div className="flex min-h-10 min-w-0 items-center gap-2 border-b border-border px-1 pb-3">
            <div className="min-w-0 flex-1">
              {selectedReview ? (
                <Select value={selectedReview.id} onValueChange={setSelectedReviewId}>
                  <SelectTrigger className="h-8 w-full text-xs" aria-label="Review session"><SelectValue /></SelectTrigger>
                  <SelectContent>{reviewSessions.map((session) => <SelectItem key={session.id} value={session.id}>{session.scope.kind} · {session.commitSha.slice(0, 8)} · {session.status}</SelectItem>)}</SelectContent>
                </Select>
              ) : <span className="text-xs text-muted-foreground">No review session</span>}
            </div>
            {selectedReview?.status === "active" ? <Button size="sm" variant="outline" disabled={reviewBusy || aiReviewBusy} onClick={() => void runAiReview()}>{aiReviewBusy ? "Reviewing..." : "AI review"}</Button> : null}
            {selectedReview?.status === "active" ? <Button size="sm" variant="outline" disabled={reviewBusy || aiReviewBusy} onClick={() => void completeReview()}>Complete</Button> : null}
            {prStatusQuery.data?.authenticated && !task?.pullRequestUrl ? <Button size="sm" variant="outline" onClick={() => setPrCreateOpen(true)}><GitPullRequest />Create PR</Button> : null}
            <Button size="sm" disabled={reviewBusy} onClick={() => void startReview()}>{selectedReview ? "New" : "Start review"}</Button>
          </div>
          <section className="berry-activity-surface min-w-0 max-w-full p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">Changed files</div>
              {info ? (
                <Badge variant={info.dirty ? "secondary" : "outline"}>{info.dirty ? `${info.changedFiles} changed` : "Clean"}</Badge>
              ) : null}
            </div>
            {changedFiles.length > 0 ? (
              <div className="flex flex-col gap-1">
                {changedFiles.map((file) => (
                  <div
                    key={file.path}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs",
                      selectedPath === file.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      title={file.path}
                      onClick={() => setSelectedPath(file.path)}
                      onDoubleClick={() => openFilePath(file.path)}
                    >
                      <FileText />
                      <span className="min-w-0 truncate font-mono">{file.path}</span>
                    </button>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {file.indexStatus}{file.worktreeStatus}
                    </Badge>
                    {file.staged ? (
                      <Button variant="ghost" size="sm" onClick={() => void mutateGit("git.unstage", [file.path])}>
                        Unstage
                      </Button>
                    ) : null}
                    {file.unstaged || file.untracked ? (
                      <Button variant="ghost" size="sm" onClick={() => void mutateGit("git.stage", [file.path])}>
                        Stage
                      </Button>
                    ) : null}
                    {!file.untracked ? (
                      <Button variant="ghost" size="icon-sm" aria-label={`Revert ${file.path}`} onClick={() => void revertFile(file.path)}>
                        <RefreshCw />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Working tree clean</p>
            )}
          </section>

          {selectedReview && (reviewFindingsQuery.data?.length ?? 0) > 0 ? (
            <section className="min-w-0 max-w-full" aria-label="Verified findings">
              <div className="mb-2 flex items-center justify-between px-1"><span className="text-xs font-medium text-muted-foreground">Verified findings</span><Badge variant="outline">{reviewFindingsQuery.data!.length}</Badge></div>
              <div className="flex flex-col gap-2">
                {reviewFindingsQuery.data!.map((finding) => (
                  <div key={finding.id} className="rounded-md border border-border bg-[var(--berry-surface-inset)] p-3">
                    <div className="flex items-start gap-2"><Badge variant={finding.severity === "critical" || finding.severity === "high" ? "destructive" : "outline"} className="capitalize">{finding.severity}</Badge><div className="min-w-0 flex-1"><div className="text-xs font-medium">{finding.title}</div><div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{finding.anchor.path}:{finding.anchor.line} · {finding.anchor.commitSha.slice(0, 8)}</div></div></div>
                    <p className="mt-2 text-xs leading-5">{finding.rationale}</p>
                    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Verified: {finding.verificationReason}</p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="ghost" disabled={Boolean(finding.convertedCommentId)} onClick={() => void convertFinding(finding)}>{finding.convertedCommentId ? "Comment added" : "Add as comment"}</Button>
                      {finding.suggestionPatch ? <Button size="sm" variant="outline" disabled={finding.applied} onClick={() => void applyFinding(finding)}>{finding.applied ? "Applied" : "Apply suggestion"}</Button> : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="min-h-0 min-w-0 max-w-full">
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Diff</div>
            <DiffViewer
              diff={prViewQuery.data?.diff ?? diffQuery.data?.stdout ?? ""}
              review={prViewQuery.data ? {
                commitSha: prViewQuery.data.headSha,
                comments: [...(reviewCommentsQuery.data ?? []), ...prViewQuery.data.comments],
                onCreate: createPullRequestComment,
                onReply: replyToPullRequestComment,
                ...(selectedReview?.status === "active" ? { onResolve: resolveReviewComment } : {}),
              } : selectedReview ? {
                commitSha: selectedReview.commitSha,
                comments: reviewCommentsQuery.data ?? [],
                ...(selectedReview.status === "active" ? { onCreate: createReviewComment, onResolve: resolveReviewComment } : {}),
              } : undefined}
            />
          </section>
        </div>
      </div>
      <PrCreateDialog open={prCreateOpen} onOpenChange={setPrCreateOpen} workspaceId={workspaceId} taskId={taskId} />
    </div>
  );
}

function isWorkPaneTab(value: string): value is WorkPaneTab {
  return value === "terminal" || value === "browser" || value === "review" || value === "files";
}

function openFilePath(path: string, line?: number) {
  window.dispatchEvent(new CustomEvent("berry:open-file", { detail: { path, ...(line ? { line } : {}) } }));
}

function browserTabTitle(session: BrowserSession, index: number): string {
  const currentUrl = session.currentUrl?.trim();
  if (!currentUrl || currentUrl === "about:blank") return `Tab ${index + 1}`;
  try {
    const parsed = new URL(currentUrl);
    return parsed.host || parsed.pathname || currentUrl;
  } catch {
    return currentUrl;
  }
}

function branchOptions(branches: GitBranchInfo[], defaultBranch: string | null | undefined): string[] {
  return [...new Set([defaultBranch, ...branches.map((branch) => branch.name)].filter((branch): branch is string => Boolean(branch && branch.length > 0)))];
}

function screenshotImageSrc(path: string): string {
  if (!path) return "";
  if (/^(data:|blob:|https?:)/.test(path)) return path;
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ ? convertFileSrc(path) : "";
}

function browserScreenshotAttachment(output: BrowserScreenshotOutput, sessionId: string): BrowserScreenshotAttachment | null {
  const path = output.path?.trim();
  if (!path) return null;
  const dataUrl = output.dataUrl ?? (/^data:/.test(path) ? path : null);
  return {
    path,
    dataUrl,
    name: output.name ?? `berry-browser-${sessionId}.png`,
    mediaType: output.mediaType ?? mediaTypeFromDataUrl(dataUrl) ?? "image/png",
    size: typeof output.size === "number" && Number.isFinite(output.size) ? Math.max(0, Math.round(output.size)) : dataUrlByteSize(dataUrl),
  };
}

function mediaTypeFromDataUrl(dataUrl: string | null | undefined): string | null {
  return dataUrl?.match(/^data:([^;,]+)/)?.[1] ?? null;
}

function dataUrlByteSize(dataUrl: string | null | undefined): number {
  if (!dataUrl) return 0;
  const [, payload = ""] = dataUrl.split(",", 2);
  if (dataUrl.includes(";base64,")) return Math.ceil((payload.length * 3) / 4);
  return new TextEncoder().encode(decodeURIComponent(payload)).length;
}
