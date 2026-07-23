import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Worktree, WorktreeApplyBackPreview, WorktreeApplyBackResult } from "@berry/shared";
import { GitBranch, GitPullRequest, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { Input } from "@berry/desktop-ui/components/ui/input";

import { DiffViewer } from "@/components/diff-viewer";
import { callWithApprovalRetry, host } from "@/lib/berry";

export function WorktreeMergeDialog({
  open,
  onOpenChange,
  taskId,
  taskTitle,
  branch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  taskTitle: string;
  branch: string;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState<"apply" | "branch" | null>(null);
  const [message, setMessage] = React.useState(`Berry task: ${taskTitle}`);
  const previewQuery = useQuery({
    queryKey: ["worktree.applyBack.preview", taskId],
    queryFn: () => host.call<WorktreeApplyBackPreview>("worktree.applyBack.preview", { taskId }),
    enabled: open,
  });
  const preview = previewQuery.data;

  const refreshWorkspace = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["worktree.applyBack.preview", taskId] }),
      queryClient.invalidateQueries({ queryKey: ["worktree.status", taskId] }),
      queryClient.invalidateQueries({ queryKey: ["git.info"] }),
      queryClient.invalidateQueries({ queryKey: ["git.changedFiles"] }),
      queryClient.invalidateQueries({ queryKey: ["git.diff"] }),
      queryClient.invalidateQueries({ queryKey: ["timeline.list", taskId] }),
    ]);
  };

  const applyBack = async () => {
    if (!preview?.patch || !preview.applicable) return;
    setBusy("apply");
    try {
      const result = await callWithApprovalRetry<WorktreeApplyBackResult>("worktree.applyBack", { taskId });
      await refreshWorkspace();
      toast.success(`Applied ${result.files.length} file${result.files.length === 1 ? "" : "s"} to the main workspace`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not apply worktree changes");
    } finally {
      setBusy(null);
    }
  };

  const prepareBranch = async () => {
    if (!message.trim()) return;
    setBusy("branch");
    try {
      const worktree = await host.call<Worktree>("worktree.prepareBranch", { taskId, message: message.trim() });
      await refreshWorkspace();
      toast.success(`Branch ${worktree.branch ?? branch} is ready for a pull request`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not prepare branch");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(820px,90vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 text-left">
          <DialogTitle>Merge worktree changes</DialogTitle>
          <DialogDescription className="flex min-w-0 items-center gap-1.5 text-xs">
            <GitBranch className="shrink-0" />
            <span className="truncate font-mono">{branch}</span>
            <span className="shrink-0">to the main workspace</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2">
            {preview ? <Badge variant="outline" className="tabular-nums">{preview.files.length} file{preview.files.length === 1 ? "" : "s"}</Badge> : null}
            {preview?.applicable ? <Badge variant="outline">Applies cleanly</Badge> : null}
            {preview && !preview.applicable ? <Badge variant="destructive">Conflict detected</Badge> : null}
            <Button variant="ghost" size="icon-sm" className="ml-auto size-10" aria-label="Refresh worktree preview" onClick={() => void previewQuery.refetch()} disabled={previewQuery.isFetching || Boolean(busy)}>
              {previewQuery.isFetching ? <CircularActivitySpinner size={16} label="Refreshing worktree preview" /> : <RefreshCw />}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4">
            {previewQuery.isLoading ? (
              <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">Preparing diff...</div>
            ) : previewQuery.error ? (
              <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-destructive">{previewQuery.error.message}</div>
            ) : preview?.conflict ? (
              <div className="mb-3 border-l-2 border-destructive px-3 py-2 text-xs leading-5 text-destructive">{preview.conflict}</div>
            ) : null}
            {preview?.patch ? <DiffViewer diff={preview.patch} /> : preview && !previewQuery.isLoading ? (
              <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">No worktree changes to merge</div>
            ) : null}
          </div>

          <div className="shrink-0 border-t px-5 py-3">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="worktree-commit-message">Branch checkpoint message</label>
            <Input id="worktree-commit-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500} disabled={Boolean(busy)} />
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t px-5 py-4 sm:justify-between">
          <Button variant="outline" className="min-h-10" disabled={Boolean(busy) || !message.trim()} onClick={() => void prepareBranch()}>
            <GitPullRequest />
            {busy === "branch" ? "Preparing..." : "Prepare branch for PR"}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" className="min-h-10" disabled={Boolean(busy)} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="min-h-10" disabled={Boolean(busy) || !preview?.patch || !preview.applicable} onClick={() => void applyBack()}>
              {busy === "apply" ? "Applying..." : "Apply to main"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
