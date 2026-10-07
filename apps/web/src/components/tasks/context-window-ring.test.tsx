import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { BerryApiClient } from "@berry/api-client";
import type { TaskTokenUsage } from "@berry/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextWindowRing, formatCacheHitRate, formatTaskTokens, useTaskTokenUsage } from "./context-window-ring";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
const totals: TaskTokenUsage = { taskId: "task_1", inputTokens: 8_000, cachedInputTokens: 6_000, uncachedInputTokens: 2_000, outputTokens: 250, totalTokens: 8_250, cacheHitRate: 0.75 };
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
function Probe({ client, sessionId = "session_1", working = false }: { client: BerryApiClient; sessionId?: string; working?: boolean }) {
  const resource = useTaskTokenUsage(client, sessionId, working);
  return <div><span>{resource.usage?.totalTokens ?? "loading"}</span><button onClick={resource.retry}>retry</button><i>{resource.failed ? "failed" : "ok"}</i></div>;
}

describe("context details", () => {
  it("does not fetch task usage while the ring is closed", async () => {
    const taskTokenUsage = vi.fn(async () => totals);
    await act(async () => {
      renderer = create(<ContextWindowRing stats={undefined} client={{ taskTokenUsage } as unknown as BerryApiClient} sessionId="session_1" working={false} />);
    });
    expect(taskTokenUsage).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("button").props["aria-haspopup"]).toBe("dialog");
  });

  it("shows exact token counts and distinguishes unknown, zero, and small cache rates", () => {
    expect(formatTaskTokens(1_234_567)).toBe("1,234,567");
    expect(formatCacheHitRate(null)).toBe("—");
    expect(formatCacheHitRate(0)).toBe("0%");
    expect(formatCacheHitRate(0.0001)).toBe("<0.1%");
    expect(formatCacheHitRate(0.375)).toBe("37.5%");
  });

  it("refreshes recorded usage while open and aborts work when the panel closes", async () => {
    vi.useFakeTimers();
    const taskTokenUsage = vi.fn(async (_sessionId: string, _options: { signal: AbortSignal }) => totals);
    await act(async () => { renderer = create(<Probe client={{ taskTokenUsage } as unknown as BerryApiClient} working />); });
    expect(taskTokenUsage).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType("span").children).toEqual(["8250"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(taskTokenUsage).toHaveBeenCalledTimes(2);
    const signal = taskTokenUsage.mock.calls.at(-1)![1].signal;
    await act(async () => renderer!.unmount()); renderer = undefined;
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(taskTokenUsage).toHaveBeenCalledTimes(2);
  });

  it("rejects a late response from the previous task", async () => {
    let resolveFirst!: (value: TaskTokenUsage) => void;
    const first = new Promise<TaskTokenUsage>((resolve) => { resolveFirst = resolve; });
    const taskTokenUsage = vi.fn((id: string) => id === "session_1" ? first : Promise.resolve({ ...totals, taskId: "task_2", totalTokens: 900 }));
    const client = { taskTokenUsage } as unknown as BerryApiClient;
    await act(async () => { renderer = create(<Probe client={client} />); });
    await act(async () => { renderer!.update(<Probe client={client} sessionId="session_2" />); });
    await act(async () => { resolveFirst(totals); });
    expect(renderer!.root.findByType("span").children).toEqual(["900"]);
  });

  it("keeps the last reading through a failed refresh and allows a retry", async () => {
    vi.useFakeTimers();
    const taskTokenUsage = vi.fn().mockResolvedValueOnce(totals).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...totals, totalTokens: 9_000 });
    await act(async () => { renderer = create(<Probe client={{ taskTokenUsage } as unknown as BerryApiClient} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(renderer!.root.findByType("span").children).toEqual(["8250"]);
    expect(renderer!.root.findByType("i").children).toEqual(["failed"]);
    await act(async () => { renderer!.root.findByType("button").props.onClick(); });
    expect(renderer!.root.findByType("span").children).toEqual(["9000"]);
    expect(renderer!.root.findByType("i").children).toEqual(["ok"]);
  });
});
