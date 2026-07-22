import * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import { cn } from "@berry/desktop-ui/lib/utils";

export interface NavigatorItem {
  id: string;
  label: string;
}

const VIEWPORT_SELECTOR = '[data-slot="message-scroller-viewport"]';
/** Codex only shows the rail once a conversation has enough turns to navigate. */
const MIN_ITEMS = 4;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

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
 * message, sitting at the left edge of the thread. The tick for every on-screen
 * message brightens (contiguous visible run, tracked with an IntersectionObserver
 * rooted on the scroll viewport); hovering a tick previews the message and
 * clicking smooth-scrolls to it with a highlight flash.
 */
export function ConversationNavigator({
  containerRef,
  items,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  items: NavigatorItem[];
}) {
  const [activeIds, setActiveIds] = React.useState<Set<string>>(() => new Set());
  // Re-run the observer when the set of messages changes, not on every render.
  const idsKey = items.map((item) => item.id).join("|");

  React.useEffect(() => {
    const scrollEl = containerRef.current?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    if (!scrollEl || items.length < MIN_ITEMS) return;
    const order = items.map((item) => item.id);
    const visible = new Set<string>();

    const recompute = () => {
      const first = order.findIndex((id) => visible.has(id));
      if (first === -1) {
        setActiveIds((prev) => (prev.size ? new Set() : prev));
        return;
      }
      let last = first;
      for (let i = order.length - 1; i > first; i--) {
        if (visible.has(order[i]!)) {
          last = i;
          break;
        }
      }
      const next = new Set(order.slice(first, last + 1));
      setActiveIds((prev) => (sameSet(prev, next) ? prev : next));
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

  return (
    <nav
      aria-label="User messages"
      className="berry-convo-rail absolute top-1/2 left-1.5 z-20 hidden -translate-y-1/2 md:block"
    >
      {/* delayDuration 0 for an instant preview; the tooltip portals to <body>
          so it escapes the rail's overflow clip (the old inline pill was
          clipped by the scroll container's forced overflow-x). */}
      <TooltipProvider delayDuration={0}>
        <div className="group/rail flex max-h-[min(70vh,32rem)] flex-col overflow-y-auto overscroll-contain py-1 pr-2.5 pl-1 opacity-30 transition-opacity duration-150 [scrollbar-width:none] group-hover/rail:opacity-100 hover:opacity-100 focus-within:opacity-100">
          {items.map((item, index) => {
            const active = activeIds.has(item.id);
            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => scrollTo(item.id)}
                    aria-current={active ? "true" : undefined}
                    aria-label={`Jump to message ${index + 1}`}
                    className="group/row relative flex h-2 w-8 shrink-0 cursor-pointer items-center"
                  >
                    <span
                      className={cn(
                        "h-0.5 rounded-full transition-[width,background-color] duration-300 group-hover/row:w-6",
                        active ? "w-6 bg-foreground" : "w-4 bg-muted-foreground/60",
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-80 truncate">
                  {item.label || "(no content)"}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    </nav>
  );
}
