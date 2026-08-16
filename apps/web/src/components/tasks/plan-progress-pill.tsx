import * as React from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@berry/desktop-ui/components/ui/popover";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { CircleCheckIcon, CircleHollow, OctagonXIcon } from "@berry/desktop-ui/lib/icons";
import { Squircle } from "@berry/desktop-ui/lib/squircle";
import type { PlanProgress, PlanItemStatus } from "@/lib/plan-progress";
export { planProgressFromLiveStream, planProgressFromConversation, planProgressFromMessages } from "@/lib/plan-progress";
export type { PlanProgress, PlanItemStatus } from "@/lib/plan-progress";

const STATUS_ICON = {
  pending: CircleHollow,
  completed: CircleCheckIcon,
  failed: OctagonXIcon,
} satisfies Record<Exclude<PlanItemStatus, "in_progress">, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>>;

function PlanStatusIcon({ status, className }: { status: PlanItemStatus; className?: string }) {
  if (status === "in_progress") {
    return <CircularActivitySpinner size={16} label="Step in progress" className={className} />;
  }

  const Icon = STATUS_ICON[status];
  return <Icon className={className} aria-hidden />;
}
export function PlanProgressPill({ plan }: { plan: PlanProgress }) {
  const [open, setOpen] = React.useState(false);
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);

  const openImmediately = React.useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const openOnHover = React.useCallback(() => {
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, 80);
  }, [open]);

  const closeImmediately = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    setOpen(false);
  }, []);

  React.useEffect(() => clearTimers, [clearTimers]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        clearTimers();
        setOpen(nextOpen);
      }}
    >
      <div
        className="berry-plan-progress-anchor"
        onPointerEnter={openOnHover}
        onPointerLeave={closeImmediately}
      >
        <PopoverAnchor asChild>
          <button
            type="button"
            className="berry-plan-progress-pill"
            aria-label={`View plan progress: step ${plan.current} of ${plan.total}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onFocus={openImmediately}
            onBlur={closeImmediately}
          >
            <PlanStatusIcon status={plan.status} className={`berry-plan-progress-status is-${plan.status}`} />
            <span>Step {plan.current} / {plan.total}</span>
          </button>
        </PopoverAnchor>
      </div>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={16}
        className="berry-plan-progress-popover-shell"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Squircle cornerRadius={20} className="berry-plan-progress-popover">
          <ol className="berry-plan-progress-list" aria-label="Plan steps">
            {plan.items.map((item, index) => {
              const active = index + 1 === plan.current && plan.status !== "completed";
              return (
                <li
                  key={`${index}-${item.content}`}
                  className={`berry-plan-progress-step is-${item.status}${active ? " is-active" : ""}`}
                  {...(active ? { "aria-current": "step" as const } : {})}
                >
                  <PlanStatusIcon status={item.status} className={`berry-plan-progress-status is-${item.status}`} />
                  <span>{item.content}</span>
                </li>
              );
            })}
          </ol>
        </Squircle>
      </PopoverContent>
    </Popover>
  );
}
