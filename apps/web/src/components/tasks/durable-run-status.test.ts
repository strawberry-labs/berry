import type { TurnState } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { runPresentation } from "./durable-run-status";

function state(patch: Partial<TurnState>): TurnState {
  return {
    active: true,
    turnId: "run-1",
    bufferedEvents: [],
    replayOnly: false,
    owner: "worker-1",
    runState: "calling_model",
    waitingReason: null,
    nextAction: null,
    error: null,
    ...patch,
  };
}

describe("runPresentation", () => {
  it("shows explicit recovery actions only for ambiguous non-idempotent work", () => {
    const view = runPresentation(state({
      active: false,
      owner: null,
      runState: "recovery_required",
      error: "The tool result is ambiguous.",
    }), "online");

    expect(view.label).toBe("Recovery required");
    expect(view.recoveryActions).toEqual(["retry", "mark-complete", "cancel"]);
  });

  it("explains durable reconnect and waiting states without recovery controls", () => {
    expect(runPresentation(state({}), "reconnecting")).toMatchObject({
      label: "Reconnecting",
      recoveryActions: [],
    });
    expect(runPresentation(state({ runState: "waiting", waitingReason: "user_input" }), "online")).toMatchObject({
      label: "Waiting for your answer",
      recoveryActions: [],
    });
  });
});
