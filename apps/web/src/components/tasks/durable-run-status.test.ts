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
  it("keeps recovery errors out of the global status area", () => {
    const view = runPresentation(state({
      active: false,
      owner: null,
      runState: "recovery_required",
      error: "The tool result is ambiguous.",
    }));

    expect(view.visible).toBe(false);
  });

  it("shows waiting states that require user action", () => {
    expect(runPresentation(state({ runState: "waiting", waitingReason: "user_input" }))).toMatchObject({
      label: "Waiting for your answer",
      tone: "neutral",
    });
  });

  it("shows the current phase for active durable work", () => {
    for (const runState of ["queued", "assembling_context", "calling_model", "executing_tool", "compacting"] as const) {
      expect(runPresentation(state({ runState })).visible).toBe(true);
    }
    expect(runPresentation(state({ runState: "calling_model", nextAction: "Model request in progress" })))
      .toMatchObject({ label: "Generating a response", detail: "Model request in progress" });
  });
});
