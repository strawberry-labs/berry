import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { ArrowDownIcon } from "@berry/desktop-ui/lib/icons"

import { cn } from "@berry/desktop-ui/lib/utils"
import { Button } from "@berry/desktop-ui/components/ui/button"

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        // While autoscrolling the scrollbar is hidden by COLOR, not by
        // `scrollbar-width:none` — removing it entirely collapses the gutter
        // and re-centers the message column, jolting it left/right every time
        // autoscroll toggles (most visible while tables stream in).
        "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:[scrollbar-color:transparent_transparent]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-8", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  virtualize = false,
  style,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item> & { virtualize?: boolean }) {
  // CSS virtualization for stable (settled) items: skip rendering + painting
  // off-screen rows via `content-visibility:auto`. The catch is the placeholder
  // size — WKWebView doesn't reliably honor the `contain-intrinsic-size: auto`
  // "remember the last rendered size" keyword, so off-screen rows fell back to a
  // fixed guess and shifted scrollHeight, jumping the scroll. We instead measure
  // each row's real height in JS and pin `contain-intrinsic-size` to it, so a
  // skipped row reserves exactly its true height — no jump. Never virtualize the
  // live/streaming row (pass virtualize={false}); it grows every frame.
  const ref = React.useRef<HTMLDivElement>(null)
  const [intrinsic, setIntrinsic] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!virtualize) {
      setIntrinsic(null)
      return
    }
    const el = ref.current
    if (!el) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const height = Math.round(el.getBoundingClientRect().height)
        // 0 = the row is currently skipped off-screen; keep the last good size.
        if (height > 0) {
          setIntrinsic((prev) => (prev != null && Math.abs(prev - height) <= 1 ? prev : height))
        }
      })
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [virtualize])
  const virtualStyle: React.CSSProperties | undefined =
    virtualize && intrinsic != null
      ? { contentVisibility: "auto", containIntrinsicSize: `auto ${intrinsic}px` }
      : undefined
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      ref={ref}
      scrollAnchor={scrollAnchor}
      style={virtualStyle ? { ...style, ...virtualStyle } : style}
      className={cn("min-w-0 shrink-0", className)}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "secondary",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute left-1/2 -translate-x-1/2 z-20 size-8 rounded-full border border-border bg-background text-foreground shadow-[var(--berry-shadow-floating)] transition-[translate,scale,opacity] duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)] hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-[var(--scale-tiny)] data-[active=false]:opacity-0 data-[active=false]:duration-[var(--duration-quick)] data-[active=false]:ease-[var(--ease-smooth-out)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[var(--ease-smooth-out)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      aria-label="Scroll to bottom"
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">
            {direction === "end" ? "Scroll to bottom" : "Scroll to top"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
