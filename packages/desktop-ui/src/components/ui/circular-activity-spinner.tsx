import type { ComponentProps, CSSProperties } from "react";

import { cn } from "@berry/desktop-ui/lib/utils";

type IndicatorSize = number | string;

export interface CircularActivitySpinnerProps
  extends Omit<ComponentProps<"span">, "children"> {
  /** Rendered width and height. */
  size?: IndicatorSize;
  /** Accessible description of the running activity. */
  label?: string;
  /** Duration of one complete rotation. */
  durationMs?: number;
  /** Optional negative animation offset for unsynchronised spinners. */
  phaseOffsetMs?: number;
  /** Additional classes for the dim, complete ring. */
  trackClassName?: string;
  /** Additional classes for the brighter partial arc. */
  indicatorClassName?: string;
}

export function CircularActivitySpinner({
  size = 16,
  label = "Activity in progress",
  durationMs = 2_000,
  phaseOffsetMs = 0,
  trackClassName,
  indicatorClassName,
  className,
  style,
  ...props
}: CircularActivitySpinnerProps) {
  const dimension = normalizeSize(size);
  const spinnerStyle = {
    animationDuration: `${durationMs}ms`,
    animationDelay: `${-Math.abs(phaseOffsetMs)}ms`,
  } satisfies CSSProperties;

  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
      style={{ ...style, width: dimension, height: dimension }}
      {...props}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-full items-center justify-center leading-none animate-spin motion-reduce:animate-none [contain:layout_paint_style]"
        style={spinnerStyle}
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-full shrink-0">
          <path
            d="M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z"
            fill="currentColor"
            className={cn("opacity-30", trackClassName)}
          />
          <path
            d="M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z"
            fill="currentColor"
            className={indicatorClassName}
          />
        </svg>
      </span>
    </span>
  );
}

function normalizeSize(size: IndicatorSize): string {
  return typeof size === "number" ? `${size}px` : size;
}
