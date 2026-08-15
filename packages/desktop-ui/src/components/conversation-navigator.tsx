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
const RAIL_MARKER_HEIGHT_PX = 10;
const RAIL_OVERSCAN_MARKERS = 12;
const MAX_NAVIGATOR_LOAD_ATTEMPTS = 256;

export function shouldMaterializeOlderPages(hasDomAnchor: boolean, virtualizerHandled: boolean): boolean {
  return !hasDomAnchor && !virtualizerHandled;
}

export function isFocusedMarkerMounted(focusedIndex: number, range: { first: number; last: number }): boolean {
  return focusedIndex >= range.first && focusedIndex <= range.last;
}

/** Pick a mounted marker to inherit focus when the old focused marker unmounts. */
export function focusedMarkerFallbackIndex(
  focusedIndex: number,
  range: { first: number; last: number } | null,
  itemCount: number,
): number | null {
  if (focusedIndex < 0 || !range || itemCount <= 0 || isFocusedMarkerMounted(focusedIndex, range)) return null;
  return Math.max(0, Math.min(itemCount - 1, focusedIndex < range.first ? range.first : range.last));
}

export function preserveNavigatorScrollTop(
  previousScrollTop: number,
  previousFirstId: string | null,
  currentFirstIndex: number,
  previousLength: number,
  currentLength: number,
): number {
  if (!previousFirstId || currentFirstIndex <= 0 || currentLength < previousLength) return previousScrollTop;
  return previousScrollTop + currentFirstIndex * RAIL_MARKER_HEIGHT_PX;
}

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
  onLoadOlder,
  hasOlderMessages = false,
  onScrollToAnchor,
  onNavigationFailure,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  items: NavigatorItem[];
  /** Native desktop leaves a slightly wider 16px window-edge gutter. */
  inset?: number;
  /** Allow a virtualized transcript to materialize older rows before jumping. */
  onLoadOlder?: (() => Promise<boolean> | boolean) | undefined;
  /** Whether the host can still materialize an older page. */
  hasOlderMessages?: boolean;
  /** Scroll the virtual history window to an offscreen anchor already loaded. */
  onScrollToAnchor?: ((id: string, behavior: ScrollBehavior) => boolean) | undefined;
  /** Surface a bounded/deleted deep-link failure instead of silently no-oping. */
  onNavigationFailure?: ((id: string) => void) | undefined;
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
  const onLoadOlderRef = React.useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const hasOlderMessagesRef = React.useRef(hasOlderMessages);
  hasOlderMessagesRef.current = hasOlderMessages;
  const railRef = React.useRef<HTMLDivElement>(null);
  const previewRef = React.useRef<HTMLElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusIndexRef = React.useRef<number | null>(null);
  const scrubPointerRef = React.useRef<{ id: number; x: number; y: number } | null>(null);
  const scrubbingRef = React.useRef(false);
  const scrubbedIdRef = React.useRef<string | null>(null);
  const suppressClickRef = React.useRef(false);
  const hoveredIdRef = React.useRef<string | null>(null);
  const previewTimerRef = React.useRef<number | null>(null);
  const navigationTokenRef = React.useRef(0);
  const previousItemsRef = React.useRef({ firstId: items[0]?.id ?? null, length: items.length });
  const shouldRender = items.length >= MIN_ITEMS && hasLeftSpace;

  React.useLayoutEffect(() => {
    const previous = previousItemsRef.current;
    const rail = railRef.current;
    const currentFirstIndex = previous.firstId ? items.findIndex((item) => item.id === previous.firstId) : -1;
    if (rail && currentFirstIndex > 0) {
      rail.scrollTop = preserveNavigatorScrollTop(
        rail.scrollTop,
        previous.firstId,
        currentFirstIndex,
        previous.length,
        items.length,
      );
    }
    previousItemsRef.current = { firstId: items[0]?.id ?? null, length: items.length };
  }, [items]);

  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail || items.length < MIN_ITEMS) return;
    const updateVisibleRange = () => {
      const first = Math.max(0, Math.floor(rail.scrollTop / RAIL_MARKER_HEIGHT_PX) - RAIL_OVERSCAN_MARKERS);
      const last = Math.min(
        items.length - 1,
        Math.ceil((rail.scrollTop + rail.clientHeight) / RAIL_MARKER_HEIGHT_PX) + RAIL_OVERSCAN_MARKERS,
      );
      setVisibleRange((current) => current?.first === first && current.last === last ? current : { first, last });
    };
    updateVisibleRange();
    rail.addEventListener("scroll", updateVisibleRange, { passive: true });
    return () => {
      rail.removeEventListener("scroll", updateVisibleRange);
    };
  }, [items.length, shouldRender]);

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
    const containerObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    containerObserver?.observe(scrollEl);
    const content = scrollEl.querySelector<HTMLElement>(".berry-thread-content");
    if (content) containerObserver?.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      containerObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [containerRef, items.length]);

  React.useEffect(() => {
    if (!shouldRender) {
      setRailVisible(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setRailVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [shouldRender]);

  const scrollTo = React.useCallback(async (id: string, behavior: ScrollBehavior) => {
    const navigationToken = ++navigationTokenRef.current;
    const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!scrollEl) return;
    let node = scrollEl.querySelector<HTMLElement>(`[data-user-anchor="${CSS.escape(id)}"]`);
    // The transcript virtualizer can already know this row while its DOM
    // anchor is unmounted. Let it jump by its cached prefix offset first;
    // otherwise a deep link to an already-loaded row would fetch every older
    // page before the virtualizer gets a chance to scroll.
    const virtualizerHandled = !node && Boolean(onScrollToAnchor?.(id, behavior));
    if (virtualizerHandled) return;
    try {
      let attempts = 0;
      while (
        shouldMaterializeOlderPages(Boolean(node), virtualizerHandled)
        && onLoadOlder
        && hasOlderMessagesRef.current
        && attempts < MAX_NAVIGATOR_LOAD_ATTEMPTS
      ) {
        attempts += 1;
        if (!(await onLoadOlder())) break;
        if (navigationTokenRef.current !== navigationToken) return;
        // Loading a page legitimately replaces `items`; compare the loader
        // identity instead so a task switch cancels this old navigation while
        // a multi-page deep link can continue materializing the same task.
        if (onLoadOlderRef.current !== onLoadOlder || !scrollEl.isConnected || containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR) !== scrollEl) return;
        node = scrollEl.querySelector<HTMLElement>(`[data-user-anchor="${CSS.escape(id)}"]`);
      }
    } catch {
      return;
    }
    if (navigationTokenRef.current !== navigationToken) return;
    if (!node && onScrollToAnchor?.(id, behavior)) return;
    if (!node) {
      onNavigationFailure?.(id);
      return;
    }
    if (behavior === "smooth") flashAfterScrollEnd(scrollEl, node);
    node.scrollIntoView({ behavior, block: "start" });
  }, [containerRef, onLoadOlder, onNavigationFailure, onScrollToAnchor]);

  const moveKeyboardFocus = React.useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(items.length - 1, index));
    const item = items[nextIndex];
    const rail = railRef.current;
    if (!item || !rail) return;
    pendingFocusIndexRef.current = nextIndex;
    rail.scrollTop = Math.max(0, nextIndex * RAIL_MARKER_HEIGHT_PX - rail.clientHeight / 2);
    setFocusedId(item.id);
  }, [items]);
  React.useLayoutEffect(() => {
    const index = pendingFocusIndexRef.current;
    if (index !== null) {
      const item = items[index];
      const button = item ? rowRefs.current.get(item.id) : undefined;
      if (!button) return;
      pendingFocusIndexRef.current = null;
      button.focus();
      return;
    }
    const focusedIndex = focusedId ? items.findIndex((item) => item.id === focusedId) : -1;
    const fallbackIndex = focusedMarkerFallbackIndex(focusedIndex, visibleRange, items.length);
    if (fallbackIndex === null) return;
    const fallback = items[fallbackIndex];
    if (!fallback) return;
    pendingFocusIndexRef.current = fallbackIndex;
    setFocusedId(fallback.id);
  }, [focusedId, items, visibleRange]);

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
    const rail = railRef.current;
    const rect = rail?.getBoundingClientRect();
    const index = rail && rect
      ? Math.max(0, Math.min(items.length - 1, Math.floor((clientY - rect.top + rail.scrollTop) / RAIL_MARKER_HEIGHT_PX)))
      : -1;
    const id = items[index]?.id ?? markerIdFromTarget(document.elementFromPoint(clientX, clientY));
    if (!id || scrubbedIdRef.current === id) return;
    scrubbedIdRef.current = id;
    setScrubbedId(id);
    scrollTo(id, "auto");
    setHoveredId(id);
    hoveredIdRef.current = id;
  }, [items, scrollTo]);

  if (!shouldRender) return null;

  const targetId = scrubbedId ?? hoveredId ?? focusedId;
  const targetIndex = targetId ? items.findIndex((item) => item.id === targetId) : -1;
  const railHovered = hoveredId !== null;
  const previewItem = previewId ? items.find((item) => item.id === previewId) ?? null : null;
  const previewResources = previewItem?.resources ?? [];
  const visibleResources = previewResources.slice(0, 3);
  const hiddenResourceCount = Math.max(0, previewResources.length - visibleResources.length);
  const railRange = visibleRange ?? { first: 0, last: Math.min(items.length - 1, RAIL_OVERSCAN_MARKERS * 2) };
  const focusedIndex = focusedId ? items.findIndex((item) => item.id === focusedId) : -1;
  const focusedMarkerMounted = isFocusedMarkerMounted(focusedIndex, railRange);

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
        <div className="relative" style={{ height: items.length * RAIL_MARKER_HEIGHT_PX }}>
          {items.slice(railRange.first, railRange.last + 1).map((item, offset) => {
            const index = railRange.first + offset;
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
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                    event.preventDefault();
                    moveKeyboardFocus(index + 1);
                  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                    event.preventDefault();
                    moveKeyboardFocus(index - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    moveKeyboardFocus(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    moveKeyboardFocus(items.length - 1);
                  }
                }}
                tabIndex={focusedMarkerMounted ? (focusedId === item.id ? 0 : -1) : (index === railRange.first ? 0 : -1)}
                aria-current={selected ? "true" : undefined}
                aria-label={`Jump to message ${index + 1}`}
                className="absolute left-0 flex h-2.5 w-9 shrink-0 cursor-pointer items-center p-0 text-left outline-none focus-visible:bg-muted/60"
                style={{ top: index * RAIL_MARKER_HEIGHT_PX }}
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
