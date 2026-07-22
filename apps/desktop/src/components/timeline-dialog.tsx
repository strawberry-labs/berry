import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimelineItem } from "@berry/shared";
import { Archive, Files, MessageSquare, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { ScrollArea } from "@berry/desktop-ui/components/ui/scroll-area";
import { toast } from "sonner";

import { callWithApprovalRetry, host } from "@/lib/berry";

type RestoreMode = "files" | "conversation" | "both";

export function TimelineDialog({
  open,
  onOpenChange,
  taskId,
  workspaceId,
  sessionId,
  turnActive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  turnActive: boolean;
}) {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const timelineQuery = useQuery({
    queryKey: ["timeline.list", taskId],
    queryFn: () => host.call<TimelineItem[]>("timeline.list", { taskId }),
    enabled: open,
  });
  const items = timelineQuery.data ?? [];
  const latestEntryId = items.find((item) => item.kind === "conversation")?.entryId ?? null;

  const refresh = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["timeline.list", taskId] }),
      queryClient.invalidateQueries({ queryKey: ["session.messages", sessionId] }),
    ]);
  }, [queryClient, sessionId, taskId]);

  const createCheckpoint = async () => {
    setPendingAction("checkpoint");
    try {
      await host.call("git.checkpoint", {
        workspaceId,
        taskId,
        sessionId,
        ...(latestEntryId ? { entryId: latestEntryId } : {}),
        message: `Task checkpoint ${new Date().toLocaleString()}`,
      });
      await refresh();
      toast.success("Checkpoint created");
    } finally {
      setPendingAction(null);
    }
  };

  const restore = async (item: TimelineItem, mode: RestoreMode) => {
    const actionId = `${item.id}:${mode}`;
    setPendingAction(actionId);
    try {
      await callWithApprovalRetry("timeline.restore", {
        taskId,
        sessionId: item.sessionId ?? sessionId,
        mode,
        ...(item.kind === "checkpoint" ? { checkpointId: item.id } : {}),
        ...(item.entryId ? { entryId: item.entryId } : {}),
      });
      await refresh();
      toast.success(mode === "files" ? "Files restored" : mode === "conversation" ? "Conversation restored" : "Files and conversation restored");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,86vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 text-left">
          <div className="flex items-center gap-3 pr-8">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <RefreshCw className="size-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle>Task timeline</DialogTitle>
              <DialogDescription className="sr-only">Git checkpoints and conversation entries for this task.</DialogDescription>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{items.length} entries</p>
            </div>
            <Button
              size="sm"
              className="ml-auto h-10 shrink-0 gap-1.5 active:scale-[0.96] transition-transform"
              disabled={pendingAction !== null || turnActive}
              onClick={() => void createCheckpoint()}
            >
              <Archive className="size-3.5" />
              Checkpoint now
            </Button>
          </div>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="relative px-5 py-3" data-testid="task-timeline">
            <div aria-hidden className="absolute bottom-5 left-[37px] top-5 w-px bg-border" />
            {timelineQuery.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading timeline...</p>
            ) : items.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No checkpoints or conversation entries yet.</p>
            ) : (
              items.map((item) => (
                <TimelineRow
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  disabled={pendingAction !== null || turnActive}
                  pendingAction={pendingAction}
                  onRestore={(mode) => void restore(item, mode)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function TimelineRow({
  item,
  disabled,
  pendingAction,
  onRestore,
}: {
  item: TimelineItem;
  disabled: boolean;
  pendingAction: string | null;
  onRestore: (mode: RestoreMode) => void;
}) {
  const checkpoint = item.kind === "checkpoint";
  const title = checkpoint ? item.message : item.summary;
  const modeLabel = checkpoint ? checkpointReasonLabel(item.reason) : item.role === "user" ? "You" : "Assistant";
  return (
    <div className="relative flex min-w-0 gap-3 py-3 first:pt-1 last:pb-1" data-timeline-kind={item.kind}>
      <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-md bg-background shadow-[0_0_0_1px_var(--border)] text-muted-foreground">
        {checkpoint ? <Archive className="size-3.5" /> : <MessageSquare className="size-3.5" />}
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium">{modeLabel}</span>
          <time className="truncate text-[11px] tabular-nums text-muted-foreground" dateTime={item.createdAt}>
            {formatTimelineDate(item.createdAt)}
          </time>
          {checkpoint ? <code className="ml-auto shrink-0 text-[10px] text-muted-foreground">{item.commitSha.slice(0, 7)}</code> : null}
        </div>
        <p className="mt-1 line-clamp-2 text-sm leading-5 text-foreground/90">{title}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {checkpoint ? (
            <ScopeButton icon={<Files />} label="Files" item={item} mode="files" disabled={disabled} pendingAction={pendingAction} onRestore={onRestore} />
          ) : null}
          {item.entryId ? (
            <ScopeButton icon={<MessageSquare />} label="Conversation" item={item} mode="conversation" disabled={disabled} pendingAction={pendingAction} onRestore={onRestore} />
          ) : null}
          {checkpoint && item.entryId ? (
            <ScopeButton icon={<RefreshCw />} label="Both" item={item} mode="both" disabled={disabled} pendingAction={pendingAction} onRestore={onRestore} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ScopeButton({
  icon,
  label,
  item,
  mode,
  disabled,
  pendingAction,
  onRestore,
}: {
  icon: React.ReactNode;
  label: string;
  item: TimelineItem;
  mode: RestoreMode;
  disabled: boolean;
  pendingAction: string | null;
  onRestore: (mode: RestoreMode) => void;
}) {
  const pending = pendingAction === `${item.id}:${mode}`;
  return (
    <Button
      variant="outline"
      size="xs"
      className="h-10 gap-1.5 rounded-md px-3 active:scale-[0.96] transition-transform"
      disabled={disabled}
      aria-label={`Restore ${label.toLowerCase()} from ${item.kind === "checkpoint" ? item.message : item.summary}`}
      onClick={() => onRestore(mode)}
    >
      <span className="[&_svg]:size-3">{icon}</span>
      {pending ? "Restoring..." : label}
    </Button>
  );
}

function checkpointReasonLabel(reason: Extract<TimelineItem, { kind: "checkpoint" }>["reason"]): string {
  if (reason === "auto-rewind") return "Before rewind";
  if (reason === "auto-restore") return "Before restore";
  if (reason === "auto-merge") return "Before merge";
  return "Checkpoint";
}

function formatTimelineDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
