import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { cn } from "@berry/desktop-ui/lib/utils";

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let current = node; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") return current;
  }
  return null;
}

/** Settings pages that hold a fill-height list; their bottom padding matches the top (see styles.css). */
const FILL_PAGE = "section.berry-mgmt";

/**
 * Measures how tall a scrolling list can be so it ends at the bottom of the
 * visible page. With `onlyWhenLast`, it only fills when nothing but page
 * padding follows the list; otherwise it reports `active: false` and the
 * caller keeps its own cap.
 */
export function useFillHeight(
  getNode: () => HTMLElement | null,
  { minHeight = 320, onlyWhenLast = false, deps = [] as React.DependencyList } = {},
): { maxHeight: number | undefined; active: boolean } {
  const [state, setState] = React.useState<{ maxHeight: number | undefined; active: boolean }>({ maxHeight: undefined, active: !onlyWhenLast });

  React.useLayoutEffect(() => {
    const node = getNode();
    if (!node || typeof ResizeObserver === "undefined") return;
    const page = scrollParent(node.parentElement);
    const measure = () => {
      const viewport = page ? page.clientHeight : window.innerHeight;
      const pageTop = page ? page.getBoundingClientRect().top - page.scrollTop : -window.scrollY;
      // Positions in page-content coordinates, so scrolling the page does not change them.
      const rect = node.getBoundingClientRect();
      const top = rect.top - pageTop;
      // Whatever sits below the list (card borders, toolbars, page padding, later sections) must fit too.
      // Measure to the end of the page section when there is one: the scroll height also
      // counts empty space below short content, which would make a filled list undo itself.
      const shell = node.closest<HTMLElement>(FILL_PAGE);
      const contentBottom = shell
        ? shell.getBoundingClientRect().bottom - pageTop
        : page ? page.scrollHeight : document.documentElement.scrollHeight;
      const below = Math.max(0, contentBottom - (rect.bottom - pageTop));
      if (onlyWhenLast) {
        const padding = shell ? parseFloat(getComputedStyle(shell).paddingBottom) || 0 : 0;
        if (below - padding > 72) {
          setState((current) => (current.active || current.maxHeight !== undefined ? { maxHeight: undefined, active: false } : current));
          return;
        }
      }
      const available = Math.floor(viewport - top - below);
      const maxHeight = available >= minHeight ? available : Math.max(minHeight, Math.round(viewport * 0.75));
      setState((current) => (current.active && current.maxHeight === maxHeight ? current : { maxHeight, active: true }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (page) observer.observe(page);
    else observer.observe(document.documentElement);
    // Notices or filters above the list change where it starts; sections below change what must fit.
    if (node.parentElement) observer.observe(node.parentElement);
    const shell = node.closest<HTMLElement>(FILL_PAGE);
    if (shell) observer.observe(shell);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minHeight, onlyWhenLast, ...deps]);

  return state;
}

/**
 * A list body that grows to fill the rest of the visible page and then
 * scrolls inside itself, so long lists never push the page past one screen.
 * When the list starts low on the page, it takes most of a screen instead.
 */
export function FillHeightScroller({
  children,
  className,
  minHeight = 320,
}: {
  children: React.ReactNode;
  className?: string;
  minHeight?: number;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { maxHeight } = useFillHeight(() => ref.current, { minHeight });

  return (
    <div
      ref={ref}
      data-fill-scroller=""
      className={cn("min-h-0 overflow-y-auto overscroll-contain", className)}
      style={maxHeight === undefined ? undefined : { maxHeight }}
    >
      {children}
    </div>
  );
}

/**
 * Loads the next page when the end of a list scrolls near view. Watches the
 * nearest scrolling ancestor, so it works inside a FillHeightScroller as well
 * as at the end of a page.
 *
 * It keeps a fixed height while more pages exist, so the list does not jump
 * when the loading line appears. After a failed page it stops and offers a
 * retry instead of looping.
 */
export function InfiniteScrollTrigger({
  hasMore,
  loading,
  onLoadMore,
  error,
  className,
  rootMargin = "480px 0px",
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  error?: string | null | undefined;
  className?: string;
  rootMargin?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const loadRef = React.useRef(onLoadMore);
  loadRef.current = onLoadMore;

  React.useEffect(() => {
    const node = ref.current;
    if (!node || !hasMore || loading || error || typeof IntersectionObserver === "undefined") return;
    // Recreated whenever a page settles; observe() reports the current state
    // straight away, so a short page that leaves the trigger visible loads the next one.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadRef.current();
    }, { root: scrollParent(node.parentElement), rootMargin });
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, hasMore, loading, rootMargin]);

  if (!hasMore) return null;
  return (
    <div ref={ref} className={cn("flex h-11 items-center justify-center gap-2 text-xs text-muted-foreground", className)} aria-live="polite">
      {error ? (
        <>
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={onLoadMore}>Try again</Button>
        </>
      ) : loading ? (
        <>
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          <span>Loading more…</span>
        </>
      ) : null}
    </div>
  );
}
