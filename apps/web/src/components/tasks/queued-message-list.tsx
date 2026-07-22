import * as React from "react";
import { Pause, Play, Send } from "lucide-react";
import type { AttachmentInput, QueuedFollowUp } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { ChevronRight, Ellipsis, GripVerticalIcon, PencilLine, Queue01Icon, RefreshCw, Trash2, TriangleAlertIcon } from "@berry/desktop-ui/lib/icons";

export function QueuedMessageList({
  followUps,
  active,
  onRemove,
  onRetry,
  onReorder,
  onSendNow,
  onUpdate,
  onResume,
}: {
  followUps: QueuedFollowUp[];
  active: boolean;
  onRemove: (followUp: QueuedFollowUp) => Promise<void>;
  onRetry: (followUp: QueuedFollowUp) => Promise<void>;
  onReorder: (sessionId: string, orderedIds: string[]) => void;
  onSendNow: (followUp: QueuedFollowUp) => Promise<void>;
  onUpdate: (followUp: QueuedFollowUp, input: string) => Promise<void>;
  onResume: (sessionId: string) => Promise<void>;
}) {
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; after: boolean } | null>(null);
  const paused = followUps.some((item) => item.status === "paused");

  const reorder = React.useCallback((sourceId: string, targetId: string, after: boolean) => {
    if (sourceId === targetId) return;
    const ordered = [...followUps];
    const sourceIndex = ordered.findIndex((item) => item.id === sourceId);
    const targetIndex = ordered.findIndex((item) => item.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) return;
    const [moved] = ordered.splice(sourceIndex, 1);
    let destination = targetIndex + (after ? 1 : 0);
    if (sourceIndex < targetIndex) destination -= 1;
    ordered.splice(destination, 0, moved!);
    onReorder(ordered[0]!.sessionId, ordered.map((item) => item.id));
  }, [followUps, onReorder]);

  const moveWithKeyboard = React.useCallback((sourceId: string, direction: -1 | 1) => {
    const sourceIndex = followUps.findIndex((item) => item.id === sourceId);
    const targetIndex = sourceIndex + direction;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= followUps.length) return;
    const ordered = [...followUps];
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved!);
    onReorder(ordered[0]!.sessionId, ordered.map((item) => item.id));
  }, [followUps, onReorder]);

  if (followUps.length === 0) return null;

  return (
    <section className="berry-queued-message-list" aria-label="Queued follow-up messages">
      {paused ? (
        <div className="berry-queued-message-paused">
          <span><Pause aria-hidden /> Queue paused because you interrupted</span>
          <Button variant="ghost" size="xs" onClick={() => void onResume(followUps[0]!.sessionId)}><Play aria-hidden /> Resume</Button>
        </div>
      ) : null}
      <div className="berry-queued-message-scroll" role="list">
        {followUps.map((followUp) => (
          <QueuedMessageRow
            key={followUp.id}
            followUp={followUp}
            active={active}
            dragging={draggingId === followUp.id}
            dropTarget={dropTarget?.id === followUp.id ? dropTarget : null}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", followUp.id);
              setDraggingId(followUp.id);
            }}
            onDragOver={(event) => {
              if (!draggingId || draggingId === followUp.id) return;
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              setDropTarget({ id: followUp.id, after: event.clientY > box.top + box.height / 2 });
            }}
            onDrop={() => {
              if (draggingId && dropTarget?.id === followUp.id) reorder(draggingId, followUp.id, dropTarget.after);
              setDraggingId(null);
              setDropTarget(null);
            }}
            onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
            onKeyboardMove={(direction) => moveWithKeyboard(followUp.id, direction)}
            onRemove={onRemove}
            onRetry={onRetry}
            onSendNow={onSendNow}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </section>
  );
}

function QueuedMessageRow({
  followUp,
  active,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onKeyboardMove,
  onRemove,
  onRetry,
  onSendNow,
  onUpdate,
}: {
  followUp: QueuedFollowUp;
  active: boolean;
  dragging: boolean;
  dropTarget: { id: string; after: boolean } | null;
  onDragStart: React.DragEventHandler<HTMLButtonElement>;
  onDragOver: React.DragEventHandler<HTMLElement>;
  onDrop: React.DragEventHandler<HTMLElement>;
  onDragEnd: React.DragEventHandler<HTMLButtonElement>;
  onKeyboardMove: (direction: -1 | 1) => void;
  onRemove: (followUp: QueuedFollowUp) => Promise<void>;
  onRetry: (followUp: QueuedFollowUp) => Promise<void>;
  onSendNow: (followUp: QueuedFollowUp) => Promise<void>;
  onUpdate: (followUp: QueuedFollowUp, input: string) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(followUp.input);
  const isLocalSaving = followUp.id.startsWith("local_follow_up_");
  const sending = followUp.status === "sending";
  const isSaving = isLocalSaving || sending;
  const failed = followUp.status === "failed";
  const paused = followUp.status === "paused";
  const attachments = attachmentSummary(followUp.attachments);
  const actionLabel = active ? "Steer" : "Send now";

  React.useEffect(() => setDraft(followUp.input), [followUp.input]);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === followUp.input) { setEditing(false); return; }
    await onUpdate(followUp, next);
    setEditing(false);
  };

  return (
    <article
      className={`berry-queued-message-row${dragging ? " is-dragging" : ""}${dropTarget ? ` is-drop-${dropTarget.after ? "after" : "before"}` : ""}`}
      role="listitem"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        className="berry-queued-message-drag"
        type="button"
        draggable={!editing}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onKeyboardMove(event.key === "ArrowUp" ? -1 : 1);
        }}
        aria-keyshortcuts="ArrowUp ArrowDown"
        aria-label={`Reorder ${followUp.input}. Use up and down arrow keys to move it.`}
        title="Drag to reorder, or use up/down arrow keys"
      >
        <Queue01Icon className="berry-queued-message-queue-icon" aria-hidden />
        <GripVerticalIcon className="berry-queued-message-grip" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            className="berry-queued-message-edit"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void save(); }
              if (event.key === "Escape") { setDraft(followUp.input); setEditing(false); }
            }}
            onBlur={() => void save()}
            aria-label="Edit queued prompt"
          />
        ) : <p className="berry-queued-message-text" title={followUp.input}>{followUp.input}</p>}
        {attachments ? <p className="berry-queued-message-attachments">{attachments}</p> : null}
        {failed || paused ? <p className="berry-queued-message-state" data-state={failed ? "failed" : "paused"}>{failed ? <TriangleAlertIcon aria-hidden /> : <Pause aria-hidden />}{failed ? followUp.error || "Send failed" : followUp.pausedReason || "Paused"}</p> : null}
      </div>
      <span className="berry-queued-message-status" aria-live="polite">{isLocalSaving ? "Saving" : sending ? "Sending" : failed ? "Retry" : paused ? "Paused" : actionLabel}</span>
      {failed ? <Button variant="ghost" size="xs" className="berry-queued-message-action" onClick={() => void onRetry(followUp)}><RefreshCw aria-hidden /> Retry</Button> : null}
      {!failed && !isSaving ? <Button variant="ghost" size="xs" className="berry-queued-message-action" onClick={() => void onSendNow(followUp)}><Send aria-hidden /> {actionLabel}</Button> : null}
      <Button variant="ghost" size="icon-xs" className="berry-queued-message-delete" onClick={() => void onRemove(followUp)} aria-label={`Delete ${followUp.input}`}><Trash2 aria-hidden /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`More options for ${followUp.input}`}><Ellipsis aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {!isSaving ? <DropdownMenuItem onClick={() => setEditing(true)}><PencilLine /> Edit</DropdownMenuItem> : null}
          {!isSaving && !failed ? <DropdownMenuItem onClick={() => void onSendNow(followUp)}><ChevronRight /> {actionLabel}</DropdownMenuItem> : null}
          {failed ? <DropdownMenuItem onClick={() => void onRetry(followUp)}><RefreshCw /> Retry</DropdownMenuItem> : null}
          <DropdownMenuItem onClick={() => void onRemove(followUp)}><Trash2 /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}

function attachmentSummary(attachments: AttachmentInput[]): string | null {
  if (attachments.length === 0) return null;
  const first = attachments[0]?.name ?? "attachment";
  return attachments.length === 1 ? `Attached: ${first}` : `Attached: ${first} +${attachments.length - 1}`;
}
