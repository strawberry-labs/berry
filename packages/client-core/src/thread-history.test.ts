import { describe, expect, it } from "vitest";
import { reduceDurableTurnState, shouldUpdateDurableStateForEvent } from "./thread-history.ts";

describe("browser handoff lifecycle", () => {
  it("shows a durable checkpoint and resumes the same turn after handback", () => {
    const running = reduceDurableTurnState(undefined, { kind: "turn.start", turnId: "turn-1" })!;
    const handoff = { kind: "browser.handoff" as const, handoffId: "d0c7b861-422b-4cec-a728-411eab91d254", browserSessionId: "bses_test", state: "ready" as const, reason: "Complete sign-in" };
    expect(shouldUpdateDurableStateForEvent(handoff)).toBe(true);
    const waiting = reduceDurableTurnState(running, handoff)!;
    expect(waiting).toMatchObject({ turnId: "turn-1", active: true, runState: "waiting", waitingReason: "browser_handoff" });
    expect(waiting.nextAction).toContain("Browser needs help");
    expect(reduceDurableTurnState(waiting, { ...handoff, state: "resumed" })).toMatchObject({ turnId: "turn-1", active: true, runState: "calling_model", waitingReason: null });
  });
});
