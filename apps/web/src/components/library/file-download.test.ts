import { describe, expect, it, vi } from "vitest";
import { transferDownload } from "./file-download";

const bytes = new Uint8Array([1, 2, 3, 4]);
const response = (length = 4) => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 2)); c.enqueue(bytes.slice(2)); c.close(); } }), { headers: { "content-length": String(length) } });

describe("file download", () => {
  it("reports transferred bytes and returns the complete file", async () => {
    const onProgress = vi.fn();
    const fetcher = vi.fn(async () => response()) as unknown as typeof fetch;
    const blob = await transferDownload({ url: "/file", size: 4, signal: new AbortController().signal, onProgress, fetcher });
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ received: 4, total: 4 }));
    expect(fetcher).toHaveBeenCalledWith("/file", expect.objectContaining({ credentials: "include" }));
  });
  it("streams to disk in order without accumulating a blob", async () => {
    const written: number[] = [];
    const sink = { write: vi.fn(async (part: Uint8Array) => { written.push(...part); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    expect(await transferDownload({ url: "/file", size: 4, signal: new AbortController().signal, onProgress() {}, sink, fetcher: async () => response() })).toBeNull();
    expect(written).toEqual([...bytes]);
    expect(sink.close).toHaveBeenCalledOnce();
    expect(sink.abort).not.toHaveBeenCalled();
  });
  it("does not save a truncated response", async () => {
    const sink = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await expect(transferDownload({ url: "/file", size: 8, signal: new AbortController().signal, onProgress() {}, sink, fetcher: async () => response(8) })).rejects.toThrow("incomplete");
    expect(sink.close).not.toHaveBeenCalled(); expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("shows authentication failure instead of saving an error page", async () => {
    await expect(transferDownload({ url: "/file", size: 4, signal: new AbortController().signal, onProgress() {}, fetcher: async () => new Response("denied", { status: 401 }) })).rejects.toThrow("Sign in again");
  });
  it("cancels a transfer and discards partial disk output", async () => {
    const controller = new AbortController();
    const sink = { write: vi.fn(async () => { controller.abort(); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await expect(transferDownload({ url: "/file", size: 4, signal: controller.signal, onProgress() {}, sink, fetcher: async () => response() })).rejects.toMatchObject({ name: "AbortError" });
    expect(sink.close).not.toHaveBeenCalled(); expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("fails a stalled connection with a visible retryable error", async () => {
    const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => { options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason)); });
    await expect(transferDownload({ url: "/file", size: 4, signal: new AbortController().signal, onProgress() {}, fetcher, idleTimeoutMs: 10 })).rejects.toThrow("No download data");
  });
});

it("resolves an authorized storage URL and omits application credentials on S3", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("download-url")
    ? Response.json({ url: "https://storage.test/signed" }) : response());
  await transferDownload({ url: "/v1/files/id/content?download=1", size: 4, signal: new AbortController().signal, onProgress() {}, fetcher, resolveStorageUrl: true });
  expect(fetcher).toHaveBeenNthCalledWith(1, "/v1/files/id/download-url", expect.objectContaining({ credentials: "include", cache: "no-store" }));
  expect(fetcher).toHaveBeenNthCalledWith(2, "https://storage.test/signed", expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer" }));
});
it("never falls back after a denied download authorization", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
  await expect(transferDownload({ url: "/v1/files/id/content?download=1", size: 4, signal: new AbortController().signal, onProgress() {}, fetcher, resolveStorageUrl: true })).rejects.toThrow("no longer have access");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("coalesces small network chunks into large disk writes", async () => {
  const sink = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const size = 2 * 1024 * 1024;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < size; i += 16384) c.enqueue(new Uint8Array(16384)); c.close(); } }));
  await transferDownload({ url: "/file", size, signal: new AbortController().signal, onProgress() {}, fetcher, sink });
  expect(sink.write).toHaveBeenCalledTimes(2);
  expect(sink.close).toHaveBeenCalledOnce();
});
