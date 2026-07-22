import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@berry/desktop-ui/lib/utils";

export function BerryTaskHeaderFrame({ reserveControlLane = false, leading, trailing, children }: {
  reserveControlLane?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="berry-task-header flex shrink-0 items-center gap-2 border-b border-border">
      {reserveControlLane ? <div aria-hidden className="berry-task-header-control-lane" /> : null}
      {children ?? (
        <>
          <div className="berry-task-header-left flex min-w-0 items-center gap-2">{leading}</div>
          {trailing ? <div className="ml-auto flex items-center gap-1.5">{trailing}</div> : null}
        </>
      )}
    </header>
  );
}

/** Shared workspace/branch pill geometry used by desktop and cloud task headers. */
export function BerryTaskPill({
  icon,
  children,
  interactive = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  icon?: ReactNode;
  interactive?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn("berry-task-pill shrink-0", interactive && "berry-task-pill--interactive", className)}
    >
      {icon}
      {children}
    </button>
  );
}
