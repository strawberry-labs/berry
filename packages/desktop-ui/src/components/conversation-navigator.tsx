import * as React from "react";
import { cn } from "@berry/desktop-ui/lib/utils";

export interface NavigatorItem {
  id: string;
  label: string;
  preview?: string;
  resources?: string[];
}

const VIEWPORT_SELECTOR = '[data-slot="message-scroller-viewport"]';
/** Codex only shows the rail once a conversation has enough turns to navigate. */
const MIN_ITEMS = 4;
const PREVIEW_DELAY_MS = 500;
const PREVIEW_WIDTH_PX = 288;
const PREVIEW_FALLBACK_HEIGHT_PX = 172;
const VIEWPORT_GUTTER_PX = 12;
const PREVIEW_RAIL_GAP_PX = 4;

type PreviewPosition = { left: number; top: number };

/** Flash the just-scrolled-to message so the eye lands on it (Codex's Ne). */
function flashHighlight(node: HTMLElement): void {
  const target = node.querySelector<HTMLElement>("[data-user-message-bubble]") ?? node;
  const peak = "color-mix(in srgb, var(--color-foreground, currentColor) 14%, transparent)";
  const fade = "color-mix(in srgb, var(--color-foreground, currentColor) 5%, transparent)";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.animate(
    [{ backgroundColor: peak }, { backgroundColor: peak, offset: 0.35 }, { backgroundColor: fade }],
    { duration: reduced ? 0 : 1400, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  );
}

/**
 * Codex's conversation navigator: a vertical rail of thin ticks, one per user
 * message, sitting at the left edge of the thread. The active message is tracked
 * against the transcript viewport with an IntersectionObserver; hovering the
 * rail previews a turn and clicking a marker scrolls to its user-message anchor.
 */
export function ConversationNavigator({
  containerRef,
  items,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  items: NavigatorItem[];
}) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = React.useState<PreviewPosition | null>(null);
  const railRef = React.useRef<HTMLDivElement>(null);
  const previewRef = React.useRef<HTMLElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const hoveredIdRef = React.useRef<string | null>(null);
  const hoverTimerRef = React.useRef<number | null>(null);
  const pointerInsideRef = React.useRef(false);
  // Re-run the observer when the set of messages changes, not on every render.
  const idsKey = items.map((item) => item.id).join("|");

  React.useEffect(() => {
    const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!scrollEl || items.length < MIN_ITEMS) return;
    const order = items.map((item) => item.id);
    const visible = new Set<string>();

    const recompute = () => {
      const next = order.find((id) => visible.has(id)) ?? null;
      setActiveId((current) => current === next ? current : next);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.userAnchor;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        recompute();
      },
      { root: scrollEl },
    );
    const observed = new Set<Element>();
    const scan = () => {
      for (const node of scrollEl.querySelectorAll("[data-user-anchor]")) {
        if (!observed.has(node)) {
          observed.add(node);
          observer.observe(node);
        }
      }
    };
    scan();
    // Anchors mount/unmount as turns stream in; re-scan on DOM changes.
    const mutation = new MutationObserver(scan);
    mutation.observe(scrollEl, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [containerRef, idsKey, items.length]);

  const updatePreviewPosition = React.useCallback((id: string) => {
    const rail = railRef.current;
    const row = rowRefs.current.get(id);
    if (!rail || !row) return;

    const railRect = rail.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const previewHeight = previewRef.current?.offsetHeight ?? PREVIEW_FALLBACK_HEIGHT_PX;
    const left = Math.min(
      window.innerWidth - PREVIEW_WIDTH_PX - VIEWPORT_GUTTER_PX,
      railRect.right + PREVIEW_RAIL_GAP_PX,
    );
    const top = Math.max(
      VIEWPORT_GUTTER_PX,
      Math.min(
        rowRect.top + rowRect.height / 2 - previewHeight / 2,
        window.innerHeight - previewHeight - VIEWPORT_GUTTER_PX,
      ),
    );
    setPreviewPosition({ left: Math.max(VIEWPORT_GUTTER_PX, left), top });
  }, []);

  const clearHoverTimer = React.useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const closePreview = React.useCallback(() => {
    clearHoverTimer();
    pointerInsideRef.current = false;
    hoveredIdRef.current = null;
    setHoveredId(null);
    setPreviewId(null);
    setPreviewPosition(null);
  }, [clearHoverTimer]);

  const updateHoveredMarker = React.useCallback((id: string | null) => {
    if (!id || hoveredIdRef.current === id) return;
    hoveredIdRef.current = id;
    setHoveredId(id);
    if (previewId) {
      setPreviewId(id);
      window.requestAnimationFrame(() => updatePreviewPosition(id));
    }
  }, [previewId, updatePreviewPosition]);

  React.useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  React.useLayoutEffect(() => {
    if (!previewId) return;
    updatePreviewPosition(previewId);
  }, [previewId, updatePreviewPosition]);

  React.useLayoutEffect(() => {
    if (!activeId) return;
    const rail = railRef.current;
    const row = rowRefs.current.get(activeId);
    if (!rail || !row) return;
    const railRect = rail.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < railRect.top) rail.scrollTop += rowRect.top - railRect.top;
    else if (rowRect.bottom > railRect.bottom) rail.scrollTop += rowRect.bottom - railRect.bottom;
  }, [activeId]);

  const scrollTo = React.useCallback(
    (id: string) => {
      const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
      const node = scrollEl?.querySelector<HTMLElement>(`[data-user-anchor="${CSS.escape(id)}"]`);
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      flashHighlight(node);
    },
    [containerRef],
  );

  if (items.length < MIN_ITEMS) return null;

  const previewItem = previewId ? items.find((item) => item.id === previewId) ?? null : null;
  const previewResources = previewItem?.resources ?? [];
  const visibleResources = previewResources.slice(0, 3);
  const hiddenResourceCount = Math.max(0, previewResources.length - visibleResources.length);
  const focusId = hoveredId ?? activeId;
  const focusIndex = focusId ? items.findIndex((item) => item.id === focusId) : -1;

  return (
    <nav
      aria-label="User messages"
      className="berry-convo-rail absolute inset-y-0 left-1.5 z-20 hidden items-center md:flex"
    >
      <div
        ref={railRef}
        className="h-[min(70vh,32rem)] max-h-[32rem] w-14 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onPointerEnter={(event) => {
          pointerInsideRef.current = true;
          updateHoveredMarker(markerIdFromTarget(event.target));
          clearHoverTimer();
          hoverTimerRef.current = window.setTimeout(() => {
            hoverTimerRef.current = null;
            const id = hoveredIdRef.current;
            if (!pointerInsideRef.current || !id) return;
            setPreviewId(id);
            window.requestAnimationFrame(() => updatePreviewPosition(id));
          }, PREVIEW_DELAY_MS);
        }}
        onPointerMove={(event) => updateHoveredMarker(markerIdFromTarget(event.target))}
        onPointerLeave={closePreview}
      >
        <div className="flex min-h-full flex-col justify-center">
          {items.map((item, index) => {
            const active = activeId === item.id;
            const focused = focusIndex === index;
            const width = conversationMarkerWidth(item, index, focusIndex);
            return (
              <button
                key={item.id}
                ref={(node) => setMarkerRowRef(rowRefs.current, item.id, node)}
                type="button"
                data-conversation-marker={item.id}
                onClick={() => scrollTo(item.id)}
                onPointerEnter={() => updateHoveredMarker(item.id)}
                onFocus={() => {
                  clearHoverTimer();
                  updateHoveredMarker(item.id);
                  setPreviewId(item.id);
                }}
                onBlur={(event) => {
                  if (!railRef.current?.contains(event.relatedTarget)) closePreview();
                }}
                aria-current={active ? "true" : undefined}
                aria-label={`Jump to message ${index + 1}`}
                className="flex h-2 w-full shrink-0 cursor-pointer items-center px-1 text-left outline-none focus-visible:bg-muted/60"
              >
                <span
                  className={cn(
                    "h-0.5 rounded-full transition-[width,opacity] duration-[90ms] ease-out motion-reduce:transition-none",
                    focused
                      ? "bg-foreground opacity-100"
                      : active
                        ? "bg-foreground opacity-85"
                        : "bg-muted-foreground/60 opacity-60",
                  )}
                  style={{ width }}
                />
              </button>
            );
          })}
        </div>
      </div>
      {previewItem && previewPosition ? (
        <aside
          ref={previewRef}
          data-conversation-preview
          aria-live="polite"
          className="pointer-events-none fixed z-50 w-72 overflow-hidden rounded-2xl border border-border/70 bg-popover p-3 text-popover-foreground shadow-[0_14px_32px_rgb(0_0_0_/_0.28),0_3px_10px_rgb(0_0_0_/_0.18)]"
          style={previewPosition}
        >
          <p className="line-clamp-2 text-sm font-medium leading-5" title={previewItem.label || "(no content)"}>
            {previewItem.label || "(no content)"}
          </p>
          <p className="mt-1 line-clamp-3 text-xs leading-4 text-muted-foreground" title={previewItem.preview || "No assistant response yet."}>
            {previewItem.preview || "No assistant response yet."}
          </p>
          {visibleResources.length > 0 ? (
            <footer className="mt-3 flex min-w-0 items-center gap-1 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
              {visibleResources.map((resource) => <span key={resource} className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5" title={resource}>{resource}</span>)}
              {hiddenResourceCount > 0 ? <span className="shrink-0">+{hiddenResourceCount}</span> : null}
            </footer>
          ) : null}
        </aside>
      ) : null}
    </nav>
  );
}

function markerIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-conversation-marker]")?.dataset.conversationMarker ?? null;
}

function setMarkerRowRef(rows: Map<string, HTMLButtonElement>, id: string, node: HTMLButtonElement | null): void {
  if (node) rows.set(id, node);
  else rows.delete(id);
}

export function conversationMarkerWidth(item: NavigatorItem, index: number, focusIndex: number): number {
  const distance = focusIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - focusIndex);
  if (distance === 0) return 42;
  if (distance === 1) return 32;
  if (distance === 2) return 24;
  if (distance === 3) return 16;
  if ((item.resources?.length ?? 0) > 0 || index % 12 === 0) return 32;
  if (item.label.length > 160 || index % 5 === 0) return 20;
  return 10;
}
