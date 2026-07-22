import * as React from "react";
import type { Message } from "@berry/shared";
import type { StreamState, ToolEntry } from "@berry/desktop-ui/components/thread-stream";
import { Popover, PopoverContent, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";
import { CircleCheckIcon, CircleHollow, Loader2Icon, OctagonXIcon } from "@berry/desktop-ui/lib/icons";

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PlanProgress {
  items: Array<{ content: string; status: PlanItemStatus }>;
  current: number;
  total: number;
  status: PlanItemStatus;
}

type ToolStatus = ToolEntry["status"] | "pending" | "waiting-for-approval" | "cancelled";

interface TodoToolSnapshot {
  args?: Record<string, unknown> | null | undefined;
  status: ToolStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function todoItemsFromArgs(args: Record<string, unknown> | null | undefined, toolStatus: ToolStatus): PlanProgress["items"] {
  const raw = args?.todos;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string" || entry.content.trim().length === 0) return [];
    const explicitStatus: PlanItemStatus =
      entry.status === "completed" || entry.status === "in_progress" || entry.status === "failed"
        ? entry.status
        : "pending";
    // A todo write that fails while declaring an active step should surface as
    // a failed step instead of looking as though work is still progressing.
    const status = (toolStatus === "failed" || toolStatus === "denied") && explicitStatus === "in_progress"
      ? "failed"
      : explicitStatus;
    return [{ content: entry.content.trim(), status }];
  });
}

function planFromTool({ args, status: toolStatus }: TodoToolSnapshot): PlanProgress | null {
  const items = todoItemsFromArgs(args, toolStatus);
  if (items.length === 0) return null;

  const activeIndex = items.findIndex((item) => item.status === "in_progress");
  const pendingIndex = items.findIndex((item) => item.status === "pending");
  const failedIndex = items.findIndex((item) => item.status === "failed");
  const allCompleted = items.every((item) => item.status === "completed");
  const status: PlanItemStatus =
    failedIndex >= 0
      ? "failed"
      : allCompleted
        ? "completed"
        : activeIndex >= 0 || toolStatus === "running"
          ? "in_progress"
          : "pending";
  const currentIndex =
    activeIndex >= 0
      ? activeIndex
      : pendingIndex >= 0
        ? pendingIndex
        : failedIndex >= 0
          ? failedIndex
          : items.length - 1;

  return { items, current: currentIndex + 1, total: items.length, status };
}

function latestPersistedPlan(messages: Message[]): PlanProgress | null {
  let latest: PlanProgress | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.kind !== "tool-call" && part.kind !== "tool-result") continue;
      if (!isRecord(part.content) || part.content.name !== "todo_write") continue;
      const args = isRecord(part.content.arguments)
        ? part.content.arguments
        : isRecord(part.content.args)
          ? part.content.args
          : null;
      const candidate = planFromTool({
        args,
        status: typeof part.content.status === "string" ? part.content.status as ToolStatus : "completed",
      });
      if (candidate) latest = candidate;
    }
  }
  return latest;
}

function collectLiveTools(entries: StreamState["timeline"]): ToolEntry[] {
  const tools: ToolEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    tools.push(entry);
    if (entry.children?.length) tools.push(...collectLiveTools(entry.children));
  }
  return tools;
}

/**
 * The current plan is the last valid todo_write payload. Live tool entries
 * supersede persisted data while a turn runs, so the composer updates before
 * projection writes reach the database.
 */
export function planProgressFromConversation(messages: Message[], stream: StreamState): PlanProgress | null {
  const persisted = latestPersistedPlan(messages);
  const liveTodo = collectLiveTools(stream.timeline)
    .filter((tool) => tool.name === "todo_write")
    .at(-1);
  return liveTodo ? planFromTool(liveTodo) ?? persisted : persisted;
}

const STATUS_ICON = {
  pending: CircleHollow,
  in_progress: Loader2Icon,
  completed: CircleCheckIcon,
  failed: OctagonXIcon,
} satisfies Record<PlanItemStatus, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>>;

export function PlanProgressPill({ plan }: { plan: PlanProgress }) {
  const [open, setOpen] = React.useState(false);
  const PillIcon = STATUS_ICON[plan.status];

  return (
    <div className="berry-plan-progress-anchor">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="berry-plan-progress-pill"
            aria-label={`View plan progress: step ${plan.current} of ${plan.total}`}
            aria-expanded={open}
          >
            <PillIcon className={`berry-plan-progress-status is-${plan.status}`} aria-hidden />
            <span>Step {plan.current} / {plan.total}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          sideOffset={10}
          collisionPadding={16}
          className="berry-plan-progress-popover"
        >
          <ol className="berry-plan-progress-list" aria-label="Plan steps">
            {plan.items.map((item, index) => {
              const Icon = STATUS_ICON[item.status];
              const active = index + 1 === plan.current && plan.status !== "completed";
              return (
                <li
                  key={`${index}-${item.content}`}
                  className={`berry-plan-progress-step is-${item.status}${active ? " is-active" : ""}`}
                  {...(active ? { "aria-current": "step" as const } : {})}
                >
                  <Icon className={`berry-plan-progress-status is-${item.status}`} aria-hidden />
                  <span>{item.content}</span>
                </li>
              );
            })}
          </ol>
        </PopoverContent>
      </Popover>
    </div>
  );
}
