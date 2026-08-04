import { afterEach, describe, expect, it, vi } from "vitest";
import { armCompletionSound } from "./task-notifications";

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  state: AudioContextState = "suspended";
  resume = vi.fn(async () => { this.state = "running"; });

  constructor() {
    FakeAudioContext.latest = this;
  }
}

describe("completion sound", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudioContext.latest = null;
  });

  it("unlocks audio from the first user gesture when sound alerts are enabled", async () => {
    const listeners: { pointerdown?: EventListener } = {};
    vi.stubGlobal("document", {
      addEventListener: (type: string, listener: EventListener) => {
        if (type === "pointerdown") listeners.pointerdown = listener;
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      localStorage: { getItem: () => "on" },
    });

    const disarm = armCompletionSound();
    expect(listeners.pointerdown).toBeDefined();
    listeners.pointerdown?.(new Event("pointerdown"));
    await Promise.resolve();

    expect(FakeAudioContext.latest?.resume).toHaveBeenCalledOnce();
    expect(FakeAudioContext.latest?.state).toBe("running");
    disarm();
  });
});
