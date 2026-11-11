import { describe, expect, it, vi } from "vitest";
import { createNativeEventSource, reconnectDelay, streamUrl } from "./event-source";

function streamOf(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]!) } : { done: true },
    }),
  };
}

describe("native event source", () => {
  it("resumes session streams from the last cursor", () => {
    expect(streamUrl("https://a.test/v1/sessions/s1/events", null)).toBe("https://a.test/v1/sessions/s1/events");
    expect(streamUrl("https://a.test/v1/sessions/s1/events?cursor=4", "9")).toBe("https://a.test/v1/sessions/s1/events?cursor=9");
    expect(streamUrl("https://a.test/v1/tasks/t1/events", "9")).toBe("https://a.test/v1/tasks/t1/events");
  });

  it("backs off exponentially with jitter, capped at 30 seconds", () => {
    expect(reconnectDelay(0, 1000, 0.5)).toBe(1000);
    expect(reconnectDelay(3, 1000, 0.5)).toBe(8000);
    expect(reconnectDelay(20, 1000, 0.5)).toBe(30000);
    expect(reconnectDelay(0, 1000, 0)).toBe(750);
  });

  it("parses events, sends the bearer header, and reconnects with the last event id", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let resolveSecond: () => void = () => undefined;
    const secondRequest = new Promise<void>((resolve) => { resolveSecond = resolve; });
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, headers: init.headers });
      if (requests.length === 2) resolveSecond();
      return { ok: true, status: 200, body: requests.length === 1 ? streamOf(["id: 7\ndata: {\"a\":1}\n\n", "id: 8\ndata: {\"a\":2}\n\n"]) : streamOf([]) };
    });
    const timers: Array<() => void> = [];
    const factory = createNativeEventSource({ fetch, setTimeout: (callback) => { timers.push(callback); return timers.length; }, clearTimeout: () => undefined, random: () => 0.5 });
    const headers = new Headers({ Authorization: "Bearer token" });
    const source = factory("https://a.test/v1/sessions/s1/events", { withCredentials: false, headers });
    const messages: Array<{ data: string; lastEventId: string }> = [];
    source.onmessage = (event) => messages.push(event);
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toEqual({ data: "{\"a\":2}", lastEventId: "8" });
    expect(requests[0]!.headers.authorization).toBe("Bearer token");
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    timers[0]!();
    await secondRequest;
    expect(requests[1]!.url).toBe("https://a.test/v1/sessions/s1/events?cursor=8");
    expect(requests[1]!.headers["Last-Event-ID"]).toBe("8");
    source.close();
  });

  it("stops retrying once the session is no longer valid", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401, body: null }));
    const timers: Array<() => void> = [];
    const source = createNativeEventSource({ fetch, setTimeout: (callback) => { timers.push(callback); return 1; }, clearTimeout: () => undefined })("https://a.test/v1/sessions/s1/events", { withCredentials: false, headers: new Headers() });
    const errors: unknown[] = [];
    source.onerror = (event) => errors.push(event);
    await vi.waitFor(() => expect(errors).toEqual([{ type: "error", status: 401 }]));
    expect(timers).toHaveLength(0);
  });
});
