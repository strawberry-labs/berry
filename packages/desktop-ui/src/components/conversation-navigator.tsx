import * as React from "react";
import { cn } from "@berry/desktop-ui/lib/utils";

export interface NavigatorItem {
  id: string;
  label: string;
  preview?: string;
  resources?: string[];
}

const VIEWPORT_SELECTOR = '[data-slot="message-scroller-viewport"]';
const MIN_ITEMS = 4;
const RAIL_MIN_LEFT_SPACE_PX = 48;
const SCRUB_START_DISTANCE_PX = 3;
const PREVIEW_DELAY_MS = 500;
const PREVIEW_WIDTH_PX = 288;
const PREVIEW_FALLBACK_HEIGHT_PX = 172;
const VIEWPORT_GUTTER_PX = 12;

type VisibleRange = { first: number; last: number } | null;
type PreviewPosition = { left: number; top: number };

/**
 * A compact, proximity-weighted index of user prompts. It stays in the empty
 * left gutter and never competes with the transcript at narrow widths.
 */
export function ConversationNavigator({
  containerRef,
  items,
  inset = 12,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  items: NavigatorItem[];
  /** Native desktop leaves a slightly wider 16px window-edge gutter. */
  inset?: number;
}) {
  const [visibleRange, setVisibleRange] = React.useState<VisibleRange>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const [scrubbedId, setScrubbedId] = React.useState<string | null>(null);
  const [scrubbing, setScrubbing] = React.useState(false);
  const [hasLeftSpace, setHasLeftSpace] = React.useState(false);
  const [railVisible, setRailVisible] = React.useState(false);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = React.useState<PreviewPosition | null>(null);
  const railRef = React.useRef<HTMLDivElement>(null);
  const previewRef = React.useRef<HTMLElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const scrubPointerRef = React.useRef<{ id: number; x: number; y: number } | null>(null);
  const scrubbingRef = React.useRef(false);
  const scrubbedIdRef = React.useRef<string | null>(null);
  const suppressClickRef = React.useRef(false);
  const hoveredIdRef = React.useRef<string | null>(null);
  const previewTimerRef = React.useRef<number | null>(null);
  const idsKey = items.map((item) => item.id).join("|");
  const shouldRender = items.length >= MIN_ITEMS && hasLeftSpace;

  React.useEffect(() => {
    const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!scrollEl || items.length < MIN_ITEMS) return;

    const order = items.map((item) => item.id);
    const visible = new Set<string>();
    const updateVisibleRange = () => {
      const indexes = order.map((id, index) => visible.has(id) ? index : -1).filter((index) => index >= 0);
      const first = indexes.at(0);
      const last = indexes.at(-1);
      const next = first !== undefined && last !== undefined ? { first, last } : null;
      setVisibleRange((current) => current?.first === next?.first && current?.last === next?.last ? current : next);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.userAnchor;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        updateVisibleRange();
      },
      { root: scrollEl, rootMargin: "-16px 0px 0px 0px" },
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
    const mutation = new MutationObserver(scan);
    mutation.observe(scrollEl, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [containerRef, idsKey, items.length]);

  React.useEffect(() => {
    const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!scrollEl || items.length < MIN_ITEMS) return;
    const measure = () => {
      const content = scrollEl.querySelector<HTMLElement>(".berry-thread-content");
      if (!content) return setHasLeftSpace(false);
      const available = content.getBoundingClientRect().left - scrollEl.getBoundingClientRect().left;
      setHasLeftSpace(available >= RAIL_MIN_LEFT_SPACE_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    const content = scrollEl.querySelector<HTMLElement>(".berry-thread-content");
    if (content) observer.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [containerRef, idsKey, items.length]);

  React.useEffect(() => {
    if (!shouldRender) {
      setRailVisible(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setRailVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [shouldRender]);

  React.useLayoutEffect(() => {
    if (visibleRange?.first == null) return;
    const rail = railRef.current;
    const item = items[visibleRange.first];
    if (!item) return;
    const row = rowRefs.current.get(item.id);
    if (!rail || !row) return;
    const railRect = rail.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < railRect.top) rail.scrollTop += rowRect.top - railRect.top;
    else if (rowRect.bottom > railRect.bottom) rail.scrollTop += rowRect.bottom - railRect.bottom;
  }, [idsKey, items, visibleRange]);

  const scrollTo = React.useCallback((id: string, behavior: ScrollBehavior) => {
    const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    const node = scrollEl?.querySelector<HTMLElement>(`[data-user-anchor="${CSS.escape(id)}"]`);
    if (!scrollEl || !node) return;
    if (behavior === "smooth") flashAfterScrollEnd(scrollEl, node);
    node.scrollIntoView({ behavior, block: "start" });
  }, [containerRef]);

  const clearPreviewTimer = React.useCallback(() => {
    if (previewTimerRef.current === null) return;
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
  }, []);
  const updatePreviewPosition = React.useCallback((id: string) => {
    const rail = railRef.current;
    const row = rowRefs.current.get(id);
    if (!rail || !row) return;
    const railRect = rail.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const previewHeight = previewRef.current?.offsetHeight ?? PREVIEW_FALLBACK_HEIGHT_PX;
    const left = Math.min(
      window.innerWidth - PREVIEW_WIDTH_PX - VIEWPORT_GUTTER_PX,
      railRect.right + VIEWPORT_GUTTER_PX,
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
  const closePreview = React.useCallback(() => {
    clearPreviewTimer();
    setPreviewId(null);
    setPreviewPosition(null);
  }, [clearPreviewTimer]);
  const updateHovered = React.useCallback((id: string | null) => {
    if (hoveredIdRef.current === id) return;
    hoveredIdRef.current = id;
    setHoveredId(id);
    if (!id) {
      closePreview();
      return;
    }
    if (previewId) {
      setPreviewId(id);
      window.requestAnimationFrame(() => updatePreviewPosition(id));
    }
  }, [closePreview, previewId, updatePreviewPosition]);
  const startPreview = React.useCallback((id: string | null, immediate = false) => {
    clearPreviewTimer();
    if (!id) return;
    if (immediate) {
      setPreviewId(id);
      window.requestAnimationFrame(() => updatePreviewPosition(id));
      return;
    }
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      if (hoveredIdRef.current !== id) return;
      setPreviewId(id);
      window.requestAnimationFrame(() => updatePreviewPosition(id));
    }, PREVIEW_DELAY_MS);
  }, [clearPreviewTimer, updatePreviewPosition]);
  React.useEffect(() => () => clearPreviewTimer(), [clearPreviewTimer]);
  React.useLayoutEffect(() => {
    if (previewId) updatePreviewPosition(previewId);
  }, [previewId, updatePreviewPosition]);

  const updateScrub = React.useCallback((clientX: number, clientY: number) => {
    const id = markerIdFromTarget(document.elementFromPoint(clientX, clientY));
    if (!id || scrubbedIdRef.current === id) return;
    scrubbedIdRef.current = id;
    setScrubbedId(id);
    scrollTo(id, "auto");
    setHoveredId(id);
    hoveredIdRef.current = id;
  }, [scrollTo]);

  if (!shouldRender) return null;

  const targetId = scrubbedId ?? hoveredId ?? focusedId;
  const targetIndex = targetId ? items.findIndex((item) => item.id === targetId) : -1;
  const railHovered = hoveredId !== null;
  const previewItem = previewId ? items.find((item) => item.id === previewId) ?? null : null;
  const previewResources = previewItem?.resources ?? [];
  const visibleResources = previewResources.slice(0, 3);
  const hiddenResourceCount = Math.max(0, previewResources.length - visibleResources.length);

  return (
    <nav
      aria-label="User messages"
      className={cn(
        "berry-convo-rail absolute inset-y-0 z-20 flex items-center transition-opacity duration-[150ms] ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:opacity-100 motion-reduce:transition-none",
        railVisible ? "opacity-100" : "opacity-0",
      )}
      style={{ left: inset }}
    >
      <div
        ref={railRef}
        data-scrubbing={scrubbing || undefined}
        className="h-[min(70vh,640px)] w-9 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%_-_16px),transparent)] [scrollbar-width:none] [-webkit-mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%_-_16px),transparent)] [&::-webkit-scrollbar]:hidden"
        onPointerEnter={(event) => {
          const id = markerIdFromTarget(event.target);
          updateHovered(id);
          startPreview(id);
        }}
        onPointerMove={(event) => {
          const pointer = scrubPointerRef.current;
          if (!pointer || pointer.id !== event.pointerId) {
            updateHovered(markerIdFromTarget(event.target));
            return;
          }
          if (!scrubbingRef.current && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < SCRUB_START_DISTANCE_PX) return;
          if (!scrubbingRef.current) {
            scrubbingRef.current = true;
            setScrubbing(true);
            closePreview();
          }
          updateScrub(event.clientX, event.clientY);
        }}
        onPointerLeave={() => {
          if (!scrubbingRef.current) updateHovered(null);
        }}
      >
        <div className="flex min-h-full flex-col justify-center">
          {items.map((item, index) => {
            const selected = targetIndex === index;
            const visible = visibleRange !== null && index >= visibleRange.first && index <= visibleRange.last;
            const dimVisible = visible && ((railHovered && !selected) || (scrubbing && !selected));
            const color = selected
              ? "var(--color-foreground)"
              : visible && !dimVisible
                ? "color-mix(in srgb, var(--color-foreground) 60%, transparent)"
                : "color-mix(in srgb, var(--color-description-foreground, var(--color-muted-foreground)) 40%, transparent)";
            return (
              <button
                key={item.id}
                ref={(node) => setMarkerRowRef(rowRefs.current, item.id, node)}
                type="button"
                data-conversation-marker={item.id}
                onPointerDown={(event) => {
                  scrubPointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={(event) => {
                  const wasScrubbing = scrubPointerRef.current?.id === event.pointerId && scrubbingRef.current;
                  if (wasScrubbing) suppressClickRef.current = true;
                  scrubPointerRef.current = null;
                  scrubbingRef.current = false;
                  scrubbedIdRef.current = null;
                  setScrubbing(false);
                  setScrubbedId(null);
                  if (wasScrubbing) {
                    event.currentTarget.blur();
                    updateHovered(markerIdFromTarget(document.elementFromPoint(event.clientX, event.clientY)));
                  }
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={(event) => {
                  scrubPointerRef.current = null;
                  scrubbingRef.current = false;
                  scrubbedIdRef.current = null;
                  setScrubbing(false);
                  setScrubbedId(null);
                  event.currentTarget.blur();
                  updateHovered(null);
                }}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  scrollTo(item.id, "smooth");
                  // Keep actual keyboard focus for accessibility, but release mouse focus
                  // immediately so a clicked marker does not remain visually selected.
                  if (event.detail !== 0) event.currentTarget.blur();
                }}
                onPointerEnter={() => {
                  updateHovered(item.id);
                  startPreview(item.id);
                }}
                onFocus={() => {
                  setFocusedId(item.id);
                  startPreview(item.id, true);
                }}
                onBlur={() => {
                  setFocusedId(null);
                  if (!hoveredIdRef.current) closePreview();
                }}
                aria-current={visibleRange?.first === index ? "true" : undefined}
                aria-label={`Jump to message ${index + 1}`}
                className="flex h-2.5 w-9 shrink-0 cursor-pointer items-center p-0 text-left outline-none focus-visible:bg-muted/60"
              >
                <span
                  className="h-0.5 rounded-full transition-[width] duration-[160ms] ease-[cubic-bezier(.34,1.56,.64,1)] motion-reduce:transition-none"
                  data-scrubbing={scrubbing || undefined}
                  style={{ width: conversationMarkerWidth(item, index, targetIndex), backgroundColor: color }}
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
          className="pointer-events-none fixed z-50 w-72 overflow-hidden rounded-2xl border border-[var(--berry-border)] bg-[var(--berry-control-bg)] p-3 text-[var(--berry-text-primary)] shadow-[var(--berry-shadow-floating)]"
          style={previewPosition}
        >
          <p className="line-clamp-2 text-sm font-medium leading-5" title={previewItem.label || "(no content)"}>
            {previewItem.label || "(no content)"}
          </p>
          <p className="mt-1 line-clamp-3 text-xs leading-4 text-[var(--berry-text-secondary)]" title={previewItem.preview || "No assistant response yet."}>
            {previewItem.preview || "No assistant response yet."}
          </p>
          {visibleResources.length > 0 ? (
            <footer className="mt-3 flex min-w-0 items-center gap-1 border-t border-[var(--berry-border)] pt-2 text-[11px] text-[var(--berry-text-secondary)]">
              {visibleResources.map((resource) => <span key={resource} className="min-w-0 truncate rounded bg-[var(--berry-hover)] px-1.5 py-0.5" title={resource}>{resource}</span>)}
              {hiddenResourceCount > 0 ? <span className="shrink-0">+{hiddenResourceCount}</span> : null}
            </footer>
          ) : null}
        </aside>
      ) : null}
    </nav>
  );
}

function flashAfterScrollEnd(scrollEl: HTMLElement, node: HTMLElement): void {
  let settled = false;
  let timer = 0;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    scrollEl.removeEventListener("scroll", onScroll);
    scrollEl.removeEventListener("scrollend", finish);
    flashHighlight(node);
  };
  const onScroll = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(finish, 140);
  };
  scrollEl.addEventListener("scroll", onScroll, { passive: true });
  scrollEl.addEventListener("scrollend", finish, { once: true });
  timer = window.setTimeout(finish, 180);
}

/** Flash the destination prompt after a smooth rail jump has settled. */
function flashHighlight(node: HTMLElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const target = node.querySelector<HTMLElement>("[data-user-message-bubble-surface]")
    ?? node.querySelector<HTMLElement>("[data-user-message-bubble]")
    ?? node;
  const foreground = "var(--color-token-foreground, var(--color-foreground))";
  target.animate(
    [
      { backgroundColor: `color-mix(in srgb, ${foreground} 14%, transparent)` },
      { backgroundColor: `color-mix(in srgb, ${foreground} 14%, transparent)`, offset: 0.35 },
      { backgroundColor: `color-mix(in srgb, ${foreground} 5%, transparent)` },
    ],
    { duration: 1400, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
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

/** 6px idle rail, expanding through three neighboring prompts to the 26px target. */
export function conversationMarkerWidth(_item: NavigatorItem, index: number, targetIndex: number): number {
  const distance = targetIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - targetIndex);
  if (distance === 0) return 26;
  if (distance === 1) return 20;
  if (distance === 2) return 14;
  if (distance === 3) return 10;
  return 6;
}
