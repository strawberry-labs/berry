import { describe, expect, it } from "vitest";
import { ModelOutputTimer } from "./model-timing.js";

describe("DeepSeek Harness model timing", () => {
  it("separates prefill/TTFT from decoding and ignores empty events", () => {
    let clock = 0;
    const timer = new ModelOutputTimer(() => clock);
    clock = 100; timer.output(false);
    clock = 5_000; timer.output(true);
    clock = 6_000; timer.output(true);
    clock = 7_000;
    expect(timer.finish()).toEqual({ requestMs: 7_000, firstTokenMs: 5_000, decodeMs: 2_000 });
  });
  it("does not publish decoding for no-output or buffered single-burst calls", () => {
    let clock = 0;
    const empty = new ModelOutputTimer(() => clock);
    const buffered = new ModelOutputTimer(() => clock);
    clock = 1_000; buffered.output(true);
    clock = 2_000;
    expect(empty.finish()).toEqual({ requestMs: 2_000 });
    expect(buffered.finish()).toEqual({ requestMs: 2_000, firstTokenMs: 1_000 });
  });
});
