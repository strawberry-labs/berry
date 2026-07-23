import * as React from "react";
import { Pause, Play, Send } from "lucide-react";
import type { QueuedFollowUp } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { ChevronRight, Ellipsis, GripVerticalIcon, PencilLine, Queue01Icon, RefreshCw, Trash2 } from "@berry/desktop-ui/lib/icons";

export const QUEUE_ROW_PRESENCE_MS = 180;
const useBrowserLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export type QueueRowPresence = "entering" | "present" | "exiting";

export interface ExitingQueueRow {
  followUp: QueuedFollowUp;
  index: number;
}

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
  const reducedMotion = useReducedMotion();
  const rows = useRetainedQueueRows(followUps, reducedMotion);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollFade, setScrollFade] = React.useState({ top: false, bottom: false });
  const updateScrollFade = React.useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const overflow = scroll.scrollHeight - scroll.clientHeight;
    if (overflow <= 1) {
      setScrollFade({ top: false, bottom: false });
      return;
    }
    setScrollFade({ top: scroll.scrollTop > 1, bottom: scroll.scrollTop < overflow - 1 });
  }, []);

  useBrowserLayoutEffect(() => {
    updateScrollFade();
  }, [rows.length, updateScrollFade]);

  React.useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.addEventListener("scroll", updateScrollFade, { passive: true });
    const observer = new ResizeObserver(updateScrollFade);
    observer.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", updateScrollFade);
      observer.disconnect();
    };
  }, [updateScrollFade]);

  const reorder = React.useCallback((sourceId: string, targetId: string, after: boolean) => {
    const ordered = reorderQueuedFollowUps(followUps, sourceId, targetId, after);
    if (ordered === followUps || ordered.length === 0) return;
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

  if (rows.length === 0) return null;

  return (
    <section className="berry-queued-message-list" aria-label="Queued follow-up messages">
      {paused ? (
        <div className="berry-queued-message-paused">
          <span><Pause aria-hidden /> Queue paused because you interrupted</span>
          <Button variant="ghost" size="xs" onClick={() => void onResume(followUps[0]!.sessionId)}><Play aria-hidden /> Resume</Button>
        </div>
      ) : null}
      <div ref={scrollRef} className="berry-queued-message-scroll" role="list" data-scroll-top-fade={scrollFade.top || undefined} data-scroll-bottom-fade={scrollFade.bottom || undefined}>
        {rows.map(({ followUp, presence }) => (
          <div key={followUp.id} className="berry-queued-message-presence" data-presence={presence}>
            <QueuedMessageRow
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
                if (!draggingId || draggingId === followUp.id || presence === "exiting") return;
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
          </div>
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
  const actionLabel = queuedActionLabel({ active, failed });

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
        <GripVerticalIcon className="berry-queued-message-grip" aria-hidden />
        <Queue01Icon className="berry-queued-message-queue-icon" aria-hidden />
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
      </div>
      <span className="sr-only" aria-live="polite">{isLocalSaving ? "Saving" : sending ? "Sending" : paused ? "Paused" : failed ? followUp.error || "Send failed" : "Queued"}</span>
      <div className="berry-queued-message-actions">
        {!isSaving ? (
          <Button variant="ghost" size="xs" className="berry-queued-message-action" onClick={() => void (failed ? onRetry(followUp) : onSendNow(followUp))}>
            {failed ? <RefreshCw aria-hidden /> : <Send aria-hidden />}
            {actionLabel}
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-xs" className="berry-queued-message-delete" onClick={() => void onRemove(followUp)} aria-label={`Delete ${followUp.input}`}><Trash2 aria-hidden /></Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="berry-queued-message-more" aria-label={`More options for ${followUp.input}`}><Ellipsis aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="berry-queued-message-menu">
            {!isSaving && !failed ? <DropdownMenuItem onClick={() => setEditing(true)}> <PencilLine /> Edit message</DropdownMenuItem> : null}
            {!isSaving && !failed ? <DropdownMenuItem onClick={() => void onSendNow(followUp)}><ChevronRight /> {actionLabel}</DropdownMenuItem> : null}
            {failed ? <DropdownMenuItem onClick={() => void onRetry(followUp)}><RefreshCw /> Retry</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function queuedActionLabel({ active, failed }: { active: boolean; failed: boolean }): "Retry" | "Steer" | "Send now" {
  return failed ? "Retry" : active ? "Steer" : "Send now";
}

export function reorderQueuedFollowUps(followUps: QueuedFollowUp[], sourceId: string, targetId: string, after: boolean): QueuedFollowUp[] {
  if (sourceId === targetId) return followUps;
  const ordered = [...followUps];
  const sourceIndex = ordered.findIndex((item) => item.id === sourceId);
  const targetIndex = ordered.findIndex((item) => item.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return followUps;
  const [moved] = ordered.splice(sourceIndex, 1);
  let destination = targetIndex + (after ? 1 : 0);
  if (sourceIndex < targetIndex) destination -= 1;
  ordered.splice(destination, 0, moved!);
  return ordered;
}

function useRetainedQueueRows(followUps: QueuedFollowUp[], reducedMotion: boolean): Array<{ followUp: QueuedFollowUp; presence: QueueRowPresence }> {
  const previousRef = React.useRef(followUps);
  const knownIdsRef = React.useRef(new Set(followUps.map((item) => item.id)));
  const timersRef = React.useRef(new Map<string, number>());
  const [enteringIds, setEnteringIds] = React.useState<Set<string>>(() => new Set());
  const [exitingRows, setExitingRows] = React.useState<ExitingQueueRow[]>([]);

  useBrowserLayoutEffect(() => {
    const currentIds = new Set(followUps.map((item) => item.id));
    const previous = previousRef.current;
    const removed = previous.flatMap((item, index) => currentIds.has(item.id) ? [] : [{ followUp: item, index }]);
    const added = followUps.filter((item) => !knownIdsRef.current.has(item.id));

    for (const item of followUps) {
      const timer = timersRef.current.get(item.id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timersRef.current.delete(item.id);
      }
    }
    setExitingRows((current) => current.filter((item) => !currentIds.has(item.followUp.id)));

    if (!reducedMotion && removed.length > 0) {
      setExitingRows((current) => {
        const existing = new Set(current.map((item) => item.followUp.id));
        return [...current, ...removed.filter((item) => !existing.has(item.followUp.id))];
      });
      for (const item of removed) {
        const timer = window.setTimeout(() => {
          timersRef.current.delete(item.followUp.id);
          setExitingRows((current) => current.filter((row) => row.followUp.id !== item.followUp.id));
        }, QUEUE_ROW_PRESENCE_MS);
        timersRef.current.set(item.followUp.id, timer);
      }
    }

    if (!reducedMotion && added.length > 0) {
      setEnteringIds((current) => new Set([...current, ...added.map((item) => item.id)]));
      for (const item of added) {
        const timer = window.setTimeout(() => {
          timersRef.current.delete(item.id);
          setEnteringIds((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
        }, QUEUE_ROW_PRESENCE_MS);
        timersRef.current.set(item.id, timer);
      }
    }

    for (const item of followUps) knownIdsRef.current.add(item.id);
    previousRef.current = followUps;
  }, [followUps, reducedMotion]);

  React.useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
  }, []);

  return React.useMemo(() => mergeQueuePresentationRows(followUps, enteringIds, exitingRows), [enteringIds, exitingRows, followUps]);
}

export function mergeQueuePresentationRows(followUps: QueuedFollowUp[], enteringIds: ReadonlySet<string>, exitingRows: ExitingQueueRow[]): Array<{ followUp: QueuedFollowUp; presence: QueueRowPresence }> {
  const rows = followUps.map((followUp) => ({
    followUp,
    presence: (enteringIds.has(followUp.id) ? "entering" : "present") as QueueRowPresence,
  }));
  for (const exiting of [...exitingRows].sort((left, right) => left.index - right.index)) {
    if (rows.some((row) => row.followUp.id === exiting.followUp.id)) continue;
    rows.splice(Math.min(exiting.index, rows.length), 0, { followUp: exiting.followUp, presence: "exiting" });
  }
  return rows;
}
