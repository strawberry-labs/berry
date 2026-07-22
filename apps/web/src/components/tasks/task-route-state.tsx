import { Button } from "@berry/desktop-ui/components/ui/button";

export type TaskRouteStatus = "loading" | "not-found" | "forbidden" | "deleted" | "failed";

export function TaskRouteState({ state, onRetry, onHome, onRestore }: {
  state: TaskRouteStatus;
  onRetry: () => void;
  onHome: () => void;
  onRestore?: (() => void) | undefined;
}) {
  const copy = state === "loading"
    ? { title: "Loading conversation…", detail: "Restoring the task, session, and latest messages." }
    : state === "deleted"
      ? { title: "Conversation deleted", detail: "Restore it from deleted conversations before opening it here." }
      : state === "forbidden"
        ? { title: "Access denied", detail: "Your account does not have access to this conversation." }
        : state === "failed"
          ? { title: "Conversation unavailable", detail: "Berry could not load this conversation. You can retry safely." }
          : { title: "Conversation not found", detail: "It may have been removed, or this link may be incorrect." };

  return (
    <section className="berry-route-state" aria-live={state === "loading" ? "polite" : "assertive"} aria-busy={state === "loading"}>
      <h1>{copy.title}</h1>
      <p>{copy.detail}</p>
      <div className="flex gap-2">
        {state === "deleted" && onRestore ? <Button onClick={onRestore}>Restore conversation</Button> : null}
        {state === "failed" ? <Button onClick={onRetry}>Retry</Button> : null}
        {state !== "loading" ? <Button variant="outline" onClick={onHome}>Back to chats</Button> : null}
      </div>
    </section>
  );
}
