import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest, ConversationKind, Task, Workspace } from "@berry/shared";
import { ArrowLeft02, ArrowRight02, FolderOpen, ShieldQuestion } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Button } from "@berry/desktop-ui/components/ui/button";
import { BerryShellFrame } from "@berry/desktop-ui/components/berry-shell";
import { Input } from "@berry/desktop-ui/components/ui/input";
import {
  SidebarTrigger,
  useSidebar,
} from "@berry/desktop-ui/components/ui/sidebar";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";

import { host, useHostEvent, WorkbenchProvider, type SettingsPage, type WorkbenchView } from "@/lib/berry";
import { isTauri } from "@/host-client";
import { CodePreviewSettingsBridge } from "@/components/markdown";
import { AppSidebar } from "@/components/app-sidebar";
import { BerryLogo } from "@/components/berry-logo";
import { CommandPalette } from "@/components/command-palette";
import { WorkspaceHome } from "@/components/workspace-home";
import { TaskView } from "@/components/task-view";
import { FilesPanel } from "@/components/files-panel";

const SettingsView = lazy(() => import("@/components/settings").then((module) => ({ default: module.SettingsView })));

export function DesktopApp() {
  const queryClient = useQueryClient();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    () => localStorage.getItem("berry.activeWorkspace"),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedConversationKind, setSelectedConversationKindState] = useState<ConversationKind>(() =>
    localStorage.getItem("berry.conversationKind") === "code" ? "code" : "chat",
  );
  const setSelectedConversationKind = useCallback((kind: ConversationKind) => {
    setSelectedConversationKindState(kind);
    localStorage.setItem("berry.conversationKind", kind);
  }, []);

  // View history so the sidebar back/forward chevrons behave like a browser stack.
  const [history, setHistory] = useState<{ stack: WorkbenchView[]; index: number }>({
    stack: [{ kind: "home" }],
    index: 0,
  });
  const view = history.stack[history.index] ?? { kind: "home" };

  const setView = useCallback((next: WorkbenchView) => {
    setHistory((current) => {
      const active = current.stack[current.index];
      if (active && JSON.stringify(active) === JSON.stringify(next)) return current;
      const stack = [...current.stack.slice(0, current.index + 1), next].slice(-50);
      return { stack, index: stack.length - 1 };
    });
  }, []);
  const goBack = useCallback(() => {
    setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
  }, []);
  const goForward = useCallback(() => {
    setHistory((current) => ({ ...current, index: Math.min(current.stack.length - 1, current.index + 1) }));
  }, []);

  const workspacesQuery = useQuery({
    queryKey: ["workspace.list"],
    queryFn: () => host.call<Workspace[]>("workspace.list", { includeGeneral: true }),
  });
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0] ?? null;

  useEffect(() => {
    if (activeWorkspace) localStorage.setItem("berry.activeWorkspace", activeWorkspace.id);
  }, [activeWorkspace]);

  const tasksQuery = useQuery({
    queryKey: ["task.list", activeWorkspace?.id],
    queryFn: () => host.call<Task[]>("task.list", { workspaceId: activeWorkspace?.id ?? "" }),
    enabled: Boolean(activeWorkspace),
  });
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const approvalsQuery = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => host.call<ApprovalRequest[]>("approval.list"),
    refetchInterval: 3000,
  });

  useHostEvent((event) => {
    if (event.type === "task.updated") {
      void queryClient.invalidateQueries({ queryKey: ["task.list"] });
      void queryClient.invalidateQueries({ queryKey: ["task.listGeneral"] });
    } else if (event.type === "session.lease.lost") {
      toast("Session opened in another client", {
        description: `Live control moved to ${event.owner}.`,
      });
      void queryClient.invalidateQueries({ queryKey: ["session.messages", event.sessionId] });
    }
  });

  const openTask = useCallback((taskId: string) => setView({ kind: "task", taskId }), [setView]);
  const openSettings = useCallback(
    (page: SettingsPage = "general") => setView({ kind: "settings", page }),
    [setView],
  );
  const activeViewTask = view.kind === "task" ? tasks.find((task) => task.id === view.taskId) ?? null : null;
  const openHome = useCallback(() => {
    if (activeViewTask) setSelectedConversationKind(activeViewTask.conversationKind);
    setView({ kind: "home" });
  }, [activeViewTask, setSelectedConversationKind, setView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "n") {
        event.preventDefault();
        openHome();
      } else if (key === ",") {
        event.preventDefault();
        openSettings();
      } else if (key === "j" && activeViewTask?.conversationKind === "code") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("berry:toggle-terminal"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeViewTask?.conversationKind, openHome, openSettings]);

  const workbench = useMemo(
    () => ({
      workspaces,
      activeWorkspace,
      setActiveWorkspaceId,
      tasks,
      view,
      setView,
      openTask,
      openSettings,
      openHome,
      selectedConversationKind,
      setSelectedConversationKind,
      paletteOpen,
      setPaletteOpen,
    }),
    [workspaces, activeWorkspace, tasks, view, setView, openTask, openSettings, openHome, selectedConversationKind, setSelectedConversationKind, paletteOpen],
  );

  return (
    <WorkbenchProvider value={workbench}>
      <CodePreviewSettingsBridge>
      <BerryShellFrame
        bridge={
          <>
            <SidebarShortcutBridge />
            <WindowFullscreenState />
          </>
        }
        chrome={<AppWindowChrome
          canGoBack={history.index > 0}
          canGoForward={history.index < history.stack.length - 1}
          onBack={goBack}
          onForward={goForward}
          approvalCount={approvalsQuery.data?.length ?? 0}
          onApprovals={() => {
            const taskId = approvalsQuery.data?.find((approval) => approval.taskId)?.taskId;
            if (taskId) openTask(taskId);
          }}
        />}
        sidebar={<AppSidebar />}
        overlay={<CommandPalette />}
      >
          {workspacesQuery.isLoading ? null : !activeWorkspace ? (
            <WorkspaceOnboarding />
          ) : view.kind === "home" ? (
            <WorkspaceHome />
          ) : view.kind === "task" ? (
            <TaskView taskId={view.taskId} />
          ) : view.kind === "files" ? (
            <FilesPanel workspaceId={activeWorkspace.id} />
          ) : (
            <Suspense fallback={<MainPanelSkeleton />}>
              <SettingsView page={view.page} />
            </Suspense>
          )}
      </BerryShellFrame>
      </CodePreviewSettingsBridge>
    </WorkbenchProvider>
  );
}

function MainPanelSkeleton() {
  return (
    <div className="h-full min-h-0 bg-background px-8 py-8">
      <div className="flex max-w-5xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </div>
  );
}

/** Lets surfaces outside the sidebar (palette, shortcuts) toggle it via a window event. */
function SidebarShortcutBridge() {
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    const onToggle = () => toggleSidebar();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("berry:toggle-sidebar", onToggle);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("berry:toggle-sidebar", onToggle);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [toggleSidebar]);
  return null;
}

/**
 * Tracks native (green-button) fullscreen via the Tauri window API and mirrors
 * it onto `data-fullscreen` so the titlebar CSS can drop the traffic-light gap.
 * macOS fullscreen isn't the JS Fullscreen API, so `:fullscreen` won't fire.
 */
function WindowFullscreenState() {
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const apply = async () => {
        const fs = await win.isFullscreen().catch(() => false);
        document.documentElement.dataset.fullscreen = fs ? "true" : "false";
      };
      await apply();
      const off = await win.onResized(() => void apply());
      if (cancelled) off();
      else unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return null;
}

function AppWindowChrome({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  approvalCount,
  onApprovals,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  approvalCount: number;
  onApprovals: () => void;
}) {
  // Manual drag: wry's injected data-tauri-drag-region handler silently stops
  // working on macOS transparent windows (macOSPrivateApi + windowEffects), so
  // start the native drag over IPC ourselves. Double-click keeps the macOS
  // titlebar zoom behavior.
  const onTitlebarMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0 || event.target !== event.currentTarget || !isTauri()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      if (event.detail === 2) void win.toggleMaximize();
      else void win.startDragging();
    });
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="pointer-events-none absolute top-0 left-0 z-50 flex h-[var(--berry-titlebar-height)] w-full items-center"
    >
      <div
        data-tauri-drag-region
        onMouseDown={onTitlebarMouseDown}
        className="pointer-events-auto absolute top-0 left-0 h-5 w-full"
      />
      <div className="berry-window-nav pointer-events-auto absolute flex items-center">
        <SidebarTrigger className="berry-titlebar-control" />
        <Button
          variant="ghost"
          size="icon-lg"
          disabled={!canGoBack}
          onClick={onBack}
          aria-label="Back"
          className="berry-titlebar-control"
        >
          <ArrowLeft02 />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          disabled={!canGoForward}
          onClick={onForward}
          aria-label="Forward"
          className="berry-titlebar-control"
        >
          <ArrowRight02 />
        </Button>
        {approvalCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onApprovals}
            aria-label={`${approvalCount} pending approvals`}
            className="berry-titlebar-control gap-1.5 px-2 tabular-nums"
          >
            <ShieldQuestion />
            {approvalCount}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceOnboarding() {
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const open = useMutation({
    mutationFn: (workspacePath: string) =>
      host.call<Workspace>("workspace.open", { path: workspacePath, trusted: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["workspace.list"] }),
  });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        <BerryLogo className="size-20" alt="" />
        <div className="font-logo text-4xl">Berry</div>
      </div>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        Open a folder to start working. Berry keeps tasks, terminals, and approvals scoped to each workspace.
      </p>
      <form
        className="flex w-full max-w-md items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) open.mutate(path.trim());
        }}
      >
        <Input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/path/to/project"
          className="font-mono text-sm"
          autoFocus
        />
        <Button type="submit" disabled={!path.trim() || open.isPending}>
          <FolderOpen data-slot="icon" />
          Open
        </Button>
      </form>
      {open.isError ? <p className="text-sm text-destructive">{String(open.error)}</p> : null}
    </div>
  );
}
