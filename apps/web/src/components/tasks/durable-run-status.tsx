import * as React from "react";
import type { TurnState } from "@berry/shared";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, RotateCcw, Square } from "lucide-react";
import { Button } from "@berry/desktop-ui/components/ui/button";

export type RunPresentation = {
  visible: boolean;
  label: string;
  detail: string;
  tone: "neutral" | "warning" | "danger";
  recoveryActions: Array<"retry" | "mark-complete" | "cancel">;
};

export function runPresentation(
  state: TurnState | null | undefined,
  connection: "online" | "offline" | "reconnecting",
): RunPresentation {
  if (!state?.turnId) return { visible: false, label: "", detail: "", tone: "neutral", recoveryActions: [] };
  if (state.runState === "recovery_required") {
    return {
      visible: true,
      label: "Recovery required",
      detail: state.error ?? "A non-idempotent action may have completed before the worker stopped. Review the result before continuing.",
      tone: "danger",
      recoveryActions: ["retry", "mark-complete", "cancel"],
    };
  }
  if (!state.active) return { visible: false, label: "", detail: "", tone: "neutral", recoveryActions: [] };
  if (connection === "offline") {
    return { visible: true, label: "Offline", detail: "The run remains durable. Berry will reconnect when the network returns.", tone: "warning", recoveryActions: [] };
  }
  if (connection === "reconnecting") {
    return { visible: true, label: "Reconnecting", detail: "Replaying any events missed while the stream was unavailable.", tone: "warning", recoveryActions: [] };
  }
  if (state.runState === "waiting") {
    const userInput = state.waitingReason === "user_input";
    return {
      visible: true,
      label: userInput ? "Waiting for your answer" : "Waiting for approval",
      detail: state.nextAction ?? (userInput ? "Answer the question below to continue." : "Review the pending action to continue."),
      tone: "warning",
      recoveryActions: [],
    };
  }
  if (state.runState === "queued") {
    return { visible: true, label: "Queued", detail: state.nextAction ?? "Waiting for a worker slot.", tone: "neutral", recoveryActions: [] };
  }
  if (!state.owner && state.runState !== "assembling_context") {
    return { visible: true, label: "Recovering", detail: "The durable run is waiting for another worker to reclaim its next safe step.", tone: "warning", recoveryActions: [] };
  }
  return {
    visible: true,
    label: state.runState === "compacting" ? "Compacting context" : "Running",
    detail: state.nextAction ?? "Berry is advancing the durable run.",
    tone: "neutral",
    recoveryActions: [],
  };
}

export function DurableRunStatus({
  state,
  connection,
  onRecover,
}: {
  state: TurnState | null | undefined;
  connection: "online" | "offline" | "reconnecting";
  onRecover: (action: "retry" | "mark-complete" | "cancel") => Promise<void>;
}) {
  const view = runPresentation(state, connection);
  const [pending, setPending] = React.useState<string | null>(null);
  if (!view.visible) return null;
  const Icon = view.tone === "danger" ? AlertTriangle : view.tone === "warning" ? Clock3 : state?.runState === "completed" ? CheckCircle2 : RefreshCw;
  const recover = async (action: "retry" | "mark-complete" | "cancel") => {
    setPending(action);
    try {
      await onRecover(action);
    } finally {
      setPending(null);
    }
  };
  return (
    <aside className="durable-run-status" data-tone={view.tone} role="status" aria-live="polite">
      <Icon aria-hidden="true" />
      <div><strong>{view.label}</strong><span>{view.detail}</span></div>
      {view.recoveryActions.length > 0 ? (
        <div className="durable-run-actions">
          <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void recover("retry")}><RotateCcw />Retry tool</Button>
          <Button size="sm" disabled={pending !== null} onClick={() => void recover("mark-complete")}><CheckCircle2 />Mark complete</Button>
          <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => void recover("cancel")}><Square />Cancel run</Button>
        </div>
      ) : null}
    </aside>
  );
}
