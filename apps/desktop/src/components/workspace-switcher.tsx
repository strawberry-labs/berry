import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Task, Workspace } from "@berry/shared";
import { Archive, Check, FolderOpen, FolderPlus, Pencil, Pin, PinOff, Search, Trash2 } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Button } from "@berry/desktop-ui/components/ui/button";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";

import { host, isTauri, pickDirectory, useWorkbench } from "@/lib/berry";

/** Shared refresh + activation after a workspace is opened or switched. */
function useWorkspaceActions() {
  const queryClient = useQueryClient();
  const { activeWorkspace, setActiveWorkspaceId, openHome } = useWorkbench();

  const switchTo = React.useCallback(
    (id: string) => {
      if (id === activeWorkspace?.id) return;
      setActiveWorkspaceId(id);
      // Tasks are workspace-scoped, so a switch invalidates the current view.
      openHome();
    },
    [activeWorkspace?.id, setActiveWorkspaceId, openHome],
  );

  const openPath = React.useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return;
      try {
        const workspace = await host.call<Workspace>("workspace.open", { path: trimmed, trusted: true });
        await queryClient.invalidateQueries({ queryKey: ["workspace.list"] });
        setActiveWorkspaceId(workspace.id);
        openHome();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not open that folder");
      }
    },
    [queryClient, setActiveWorkspaceId, openHome],
  );

  return { switchTo, openPath };
}

/**
 * Workspace picker popover: search, the workspace list with an active check,
 * and an "Open folder" action that uses the native OS picker (falling back to
 * manual path entry when no native dialog is available).
 */
export function WorkspaceSwitcher({ children }: { children: React.ReactNode }) {
  const { workspaces, activeWorkspace } = useWorkbench();
  const { switchTo, openPath } = useWorkspaceActions();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [manualOpen, setManualOpen] = React.useState(false);
  const [manualPath, setManualPath] = React.useState("");

  const filtered = React.useMemo(() => {
    const projects = workspaces.filter((workspace) => workspace.workspaceKind !== "general");
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (workspace) =>
        workspace.name.toLowerCase().includes(needle) || workspace.path.toLowerCase().includes(needle),
    );
  }, [workspaces, query]);

  const openFolder = async () => {
    setOpen(false);
    try {
      const path = await pickDirectory();
      if (path) await openPath(path);
    } catch {
      // No native picker (dev browser or older shell) — collect a path manually.
      setManualPath("");
      setManualOpen(true);
    }
  };

  const submitManual = async () => {
    const path = manualPath.trim();
    if (!path) return;
    setManualOpen(false);
    await openPath(path);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="berry-workspace-switcher w-72 p-0">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search workspaces"
              aria-label="Search workspaces"
              className="h-6 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">No workspaces found</p>
            ) : (
              filtered.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => {
                    switchTo(workspace.id);
                    setOpen(false);
                  }}
                  title={workspace.path}
                  className="berry-workspace-switcher-item flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm"
                >
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {workspace.id === activeWorkspace?.id ? (
                    <Check className="size-4 shrink-0 text-foreground" aria-label="Active workspace" />
                  ) : null}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => void openFolder()}
              className="berry-workspace-switcher-item flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm"
            >
              <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
              <span>Open folder</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Manual path entry — the fallback when no native folder dialog exists. */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open folder</DialogTitle>
            <DialogDescription>
              {isTauri()
                ? "Enter the full path to the project folder you want to open."
                : "The native folder picker is only available in the desktop app. Enter a path to open here."}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && manualPath.trim()) void submitManual();
            }}
            placeholder="/path/to/project"
            className="font-mono text-sm"
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button disabled={!manualPath.trim()} onClick={() => void submitManual()}>
              Open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Per-project actions shown from the sidebar tree: pin, reveal, rename,
 * bulk-archive chats, and confirmed removal from Berry.
 */
export function WorkspaceRowActions({ workspace, tasks, trigger }: { workspace: Workspace; tasks: Task[]; trigger: React.ReactNode }) {
  const queryClient = useQueryClient();
  const { activeWorkspace, workspaces, setActiveWorkspaceId, openHome } = useWorkbench();
  const [removeConfirmOpen, setRemoveConfirmOpen] = React.useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(workspace.name);

  React.useEffect(() => setRenameValue(workspace.name), [workspace.name]);

  const refreshWorkspaces = async () => {
    await queryClient.invalidateQueries({ queryKey: ["workspace.list"] });
  };

  const togglePinned = async () => {
    try {
      await host.call<Workspace>("workspace.update", { id: workspace.id, pinned: !workspace.pinned });
      await refreshWorkspaces();
      toast.success(workspace.pinned ? "Project unpinned" : "Project pinned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the project");
    }
  };

  const rename = async () => {
    const name = renameValue.trim();
    if (!name) return;
    try {
      await host.call<Workspace>("workspace.update", { id: workspace.id, name });
      setRenameOpen(false);
      await refreshWorkspaces();
      toast.success("Project renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename the project");
    }
  };

  const archiveChats = async () => {
    const archivable = tasks.filter((task) => task.status !== "running" && task.status !== "waiting-for-approval");
    const skipped = tasks.length - archivable.length;
    try {
      await Promise.all(archivable.map((task) => host.call("task.setArchived", { id: task.id, archived: true })));
      await queryClient.invalidateQueries({ queryKey: ["task.list", workspace.id] });
      if (activeWorkspace?.id === workspace.id) openHome();
      toast.success(
        skipped > 0
          ? `Archived ${archivable.length} chat${archivable.length === 1 ? "" : "s"}; skipped ${skipped} running`
          : `Archived ${archivable.length} chat${archivable.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not archive the project chats");
    }
  };

  const revealInFinder = async () => {
    try {
      await host.call("system.openPath", { workspaceId: workspace.id, path: workspace.path });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the folder");
    }
  };

  const remove = async () => {
    try {
      await host.call("workspace.remove", { id: workspace.id });
      if (workspace.id === activeWorkspace?.id) {
        const next = workspaces.find((item) => item.id !== workspace.id);
        if (next) setActiveWorkspaceId(next.id);
        openHome();
      }
      await queryClient.invalidateQueries({ queryKey: ["workspace.list"] });
      toast.success(`Removed ${workspace.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the workspace");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onSelect={() => void togglePinned()}>
            {workspace.pinned ? <PinOff /> : <Pin />} {workspace.pinned ? "Unpin project" : "Pin project"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void revealInFinder()}>
            <FolderOpen /> Reveal in Finder
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => {
            setRenameValue(workspace.name);
            setRenameOpen(true);
          }}>
            <Pencil /> Rename project
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={tasks.length === 0} onSelect={() => setArchiveConfirmOpen(true)}>
            <Archive /> Archive chats
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setRemoveConfirmOpen(true)}>
            <Trash2 /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>The folder name on disk will not change.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renameValue.trim()) void rename();
            }}
            aria-label="Project name"
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button disabled={!renameValue.trim()} onClick={() => void rename()}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive chats in {workspace.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This archives {tasks.length} chat{tasks.length === 1 ? "" : "s"}. Running chats are skipped. Archived chats remain recoverable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void archiveChats()}>Archive chats</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeConfirmOpen} onOpenChange={setRemoveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {workspace.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the workspace and its tasks from Berry. The folder and its files on disk are not
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void remove()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
