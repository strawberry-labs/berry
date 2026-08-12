import { describe, expect, it } from "vitest";
import {
  ActiveTurnCancellationRegistry,
  DurableTurnCancellationError,
} from "./turn-cancellation.js";

describe("ActiveTurnCancellationRegistry", () => {
  it("immediately aborts every active provider request for a run", () => {
    const registry = new ActiveTurnCancellationRegistry();
    const first = new AbortController();
    const second = new AbortController();
    const unregisterFirst = registry.register("run_1", first);
    registry.register("run_1", second);

    expect(registry.cancel("run_1")).toBe(2);
    expect(first.signal.reason).toBeInstanceOf(DurableTurnCancellationError);
    expect(second.signal.reason).toBeInstanceOf(DurableTurnCancellationError);

    unregisterFirst();
  });

  it("remembers a cancellation that arrives immediately before registration", () => {
    const registry = new ActiveTurnCancellationRegistry();
    expect(registry.cancel("run_before_register")).toBe(0);

    const controller = new AbortController();
    registry.register("run_before_register", controller);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toMatchObject({ runId: "run_before_register" });
  });
});
