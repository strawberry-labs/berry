import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@berry/desktop-ui/components/ui/empty";
import { MessageSquareOff, ShieldAlert, TriangleAlert } from "lucide-react";

export type TaskRouteStatus = "loading" | "not-found" | "forbidden" | "deleted" | "failed";

export function TaskRouteState({ state, onRetry, onHome, onRestore }: {
  state: TaskRouteStatus;
  onRetry: () => void;
  onHome: () => void;
  onRestore?: (() => void) | undefined;
}) {
  if (state === "loading") {
    return (
      <section className="flex flex-1 items-center justify-center" aria-live="polite" aria-busy="true">
        <CircularActivitySpinner size={28} label="Loading task" />
      </section>
    );
  }

  const copy = state === "deleted"
      ? { title: "Task deleted", detail: "Restore it from deleted tasks before opening it here." }
      : state === "forbidden"
        ? { title: "Access denied", detail: "Your account does not have access to this task." }
        : state === "failed"
          ? { title: "Task unavailable", detail: "Berry could not load this task. You can retry safely." }
          : { title: "Task not found", detail: "It may have been removed, or this link may be incorrect." };
  const Icon = state === "forbidden" ? ShieldAlert : state === "failed" ? TriangleAlert : MessageSquareOff;

  return (
    <section className="flex min-h-0 flex-1 items-center justify-center p-6" aria-labelledby="task-route-state-title">
      <Empty className="max-w-md border border-[var(--berry-border)] bg-[var(--berry-card-bg)] shadow-[var(--berry-shadow-floating)]">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-[var(--berry-surface-inset)] text-[var(--berry-text-secondary)]">
            <Icon aria-hidden />
          </EmptyMedia>
          <EmptyTitle id="task-route-state-title" className="text-[var(--berry-text-primary)]">{copy.title}</EmptyTitle>
          <EmptyDescription className="text-[var(--berry-text-secondary)]">{copy.detail}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          {state === "deleted" && onRestore ? <Button onClick={onRestore}>Restore task</Button> : null}
          {state === "failed" ? <Button onClick={onRetry}>Retry</Button> : null}
          <Button variant="outline" onClick={onHome}>Back to tasks</Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}
