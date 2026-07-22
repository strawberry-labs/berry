import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Worktree } from "@berry/shared";
import { GitBranch, Trash2 } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@berry/desktop-ui/components/ui/alert-dialog";
import { Button } from "@berry/desktop-ui/components/ui/button";

import { callWithApprovalRetry, host } from "@/lib/berry";

export function ArchiveWorktreeDialog({
  open,
  onOpenChange,
  taskId,
  branch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  branch: string;
}) {
  const queryClient = useQueryClient();
  const [archiving, setArchiving] = React.useState(false);
  const statusQuery = useQuery({
    queryKey: ["worktree.status", taskId],
    queryFn: () => host.call<Worktree>("worktree.status", { taskId }),
    enabled: open,
  });
  const status = statusQuery.data;
  const busy = statusQuery.isFetching || archiving;

  const finishArchive = async (remove: boolean) => {
    setArchiving(true);
    try {
      if (remove) await callWithApprovalRetry("worktree.remove", { taskId });
      await host.call("task.setArchived", { id: taskId, archived: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task.list"] }),
        queryClient.invalidateQueries({ queryKey: ["worktree.list"] }),
        queryClient.invalidateQueries({ queryKey: ["worktree.status", taskId] }),
      ]);
      onOpenChange(false);
      toast.success(remove ? "Worktree removed and task archived" : "Task archived; worktree kept");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not archive task");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Archive worktree task?</AlertDialogTitle>
          <AlertDialogDescription className="text-pretty">
            {statusQuery.isLoading
              ? "Checking the worktree before archiving..."
              : status?.dirty
                ? "This worktree has uncommitted changes. Keep it available when archiving, or cancel and prepare the branch first."
                : status
                  ? "The worktree is clean. You can remove it with the task archive or keep the branch directory for later."
                  : "The worktree status could not be verified. Keep it when archiving to avoid data loss."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0 items-center gap-2 border-y py-3 text-xs text-muted-foreground">
          <GitBranch className="shrink-0" />
          <span className="min-w-0 truncate font-mono">{branch}</span>
          {status ? <span className="ml-auto shrink-0 tabular-nums">{status.ahead} ahead</span> : null}
        </div>
        <AlertDialogFooter className="gap-2 sm:justify-between">
          <AlertDialogCancel className="min-h-10" disabled={busy}>Cancel</AlertDialogCancel>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" className="min-h-10" disabled={busy} onClick={() => void finishArchive(false)}>Keep and archive</Button>
            <Button className="min-h-10" disabled={busy || !status || status.dirty} onClick={() => void finishArchive(true)}>
              <Trash2 /> Remove and archive
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
