import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";

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
        <CircularActivitySpinner size={28} label="Loading conversation" />
      </section>
    );
  }

  const copy = state === "deleted"
      ? { title: "Conversation deleted", detail: "Restore it from deleted conversations before opening it here." }
      : state === "forbidden"
        ? { title: "Access denied", detail: "Your account does not have access to this conversation." }
        : state === "failed"
          ? { title: "Conversation unavailable", detail: "Berry could not load this conversation. You can retry safely." }
          : { title: "Conversation not found", detail: "It may have been removed, or this link may be incorrect." };

  return (
    <section className="berry-route-state" aria-live="assertive">
      <h1>{copy.title}</h1>
      <p>{copy.detail}</p>
      <div className="flex gap-2">
        {state === "deleted" && onRestore ? <Button onClick={onRestore}>Restore conversation</Button> : null}
        {state === "failed" ? <Button onClick={onRetry}>Retry</Button> : null}
        <Button variant="outline" onClick={onHome}>Back to chats</Button>
      </div>
    </section>
  );
}
