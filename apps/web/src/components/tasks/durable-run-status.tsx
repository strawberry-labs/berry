import * as React from "react";
import type { TurnState } from "@berry/shared";
import { Clock3 } from "lucide-react";

export type RunPresentation = {
  visible: boolean;
  label: string;
  detail: string;
  tone: "neutral";
};

const ACTIVE_RUN_PRESENTATIONS: Partial<
  Record<NonNullable<TurnState["runState"]>, readonly [label: string, detail: string]>
> = {
  queued: ["Waiting for a worker", "Your request is queued and will start automatically."],
  assembling_context: ["Preparing context", "Loading the conversation and workspace context."],
  calling_model: ["Generating a response", "The model is working on the next response."],
  executing_tool: ["Running a tool", "Berry is completing the current action."],
  compacting: ["Optimizing context", "Preparing the conversation for the next model call."],
  persisting_response: ["Saving the response", "Writing the completed response safely."],
  finalizing: ["Finishing the response", "Saving files and final task state."],
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
      tone: "neutral",
    };
  }
  const presentation = state.runState
    ? ACTIVE_RUN_PRESENTATIONS[state.runState]
    : undefined;
  if (!presentation) return { visible: false, label: "", detail: "", tone: "neutral" };
  return {
    visible: true,
    label: presentation[0],
    detail: state.nextAction ?? presentation[1],
    tone: "neutral",
  };
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
