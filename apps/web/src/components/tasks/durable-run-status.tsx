import * as React from "react";
import type { TurnState } from "@berry/shared";
import { Clock3 } from "lucide-react";

export type RunPresentation = {
  visible: boolean;
  label: string;
  detail: string;
  tone: "neutral" | "warning";
};

export function runPresentation(
  state: TurnState | null | undefined,
): RunPresentation {
  if (!state?.turnId || !state.active) {
    return { visible: false, label: "", detail: "", tone: "neutral" };
  }
  if (state.runState === "waiting") {
    const userInput = state.waitingReason === "user_input";
    return {
      visible: true,
      label: userInput ? "Waiting for your answer" : "Waiting for approval",
      detail: state.nextAction ?? (userInput
        ? "Answer the question below to continue."
        : "Review the pending action to continue."),
      tone: "warning",
    };
  }
  return { visible: false, label: "", detail: "", tone: "neutral" };
}

export function DurableRunStatus({ state }: {
  state: TurnState | null | undefined;
}) {
  const view = runPresentation(state);
  if (!view.visible) return null;
  return (
    <aside className="durable-run-status" data-tone={view.tone} role="status" aria-live="polite">
      <Clock3 aria-hidden="true" />
      <div><strong>{view.label}</strong><span>{view.detail}</span></div>
    </aside>
  );
}
