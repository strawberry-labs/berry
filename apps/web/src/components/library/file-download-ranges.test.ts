import { describe, expect, it, vi } from "vitest";
import { downloadRanges } from "./file-download-ranges";

function rangeResponse(bytes: Uint8Array, start: number, end: number, total: number, etag = '"file-v1"') {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${total}`, etag } });
}
function bounds(init?: RequestInit) {
  const match = new Headers(init?.headers).get("range")!.match(/^bytes=(\d+)-(\d+)$/)!;
  return [Number(match[1]), Number(match[2])] as const;
}
describe("parallel S3 download", () => {
  it("uses at most four requests, assembles out-of-order ranges correctly and reports complete bytes", async () => {
    const bytes = new Uint8Array(Array.from({ length: 23 }, (_, i) => i));
    let active = 0, peak = 0;
    const progress = vi.fn();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const [start, end] = bounds(init);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, start === 0 ? 20 : 1));
      active--;
      expect(init?.credentials).toBe("omit");
      return rangeResponse(bytes.slice(start, end + 1), start, end, bytes.length);
    });
    const blob = await downloadRanges({ size: bytes.length, partBytes: 4, getUrl: async () => "https://s3.test/file", signal: new AbortController().signal, onProgress: progress, fetcher });
    expect(peak).toBe(4);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ received: 23, total: 23 }));
  });
  it("rejects incorrect range metadata", async () => {
    await expect(downloadRanges({ size: 4, partBytes: 4, getUrl: async () => "https://s3.test/file", signal: new AbortController().signal, onProgress() {}, fetcher: async () => rangeResponse(new Uint8Array(4), 1, 4, 4) })).rejects.toThrow("invalid file range");
  });
  it("rejects mismatched object versions", async () => {
    await expect(downloadRanges({ size: 8, partBytes: 4, getUrl: async () => "https://s3.test/file", signal: new AbortController().signal, onProgress() {}, fetcher: async (_url, init) => {
      const [start, end] = bounds(init); return rangeResponse(new Uint8Array(4), start, end, 8, start === 0 ? '"v1"' : '"v2"');
    } })).rejects.toThrow("file changed");
  });
  it("retries only the failed range and refreshes its signed URL", async () => {
    const attempts = new Map<number, number>();
    const getUrl = vi.fn(async () => "https://s3.test/file");
    const blob = await downloadRanges({ size: 8, partBytes: 4, getUrl, signal: new AbortController().signal, onProgress() {}, fetcher: async (_url, init) => {
      const [start, end] = bounds(init); const attempt = attempts.get(start) ?? 0; attempts.set(start, attempt + 1);
      return start === 0 && attempt === 0 ? new Response(null, { status: 503 }) : rangeResponse(new Uint8Array(4), start, end, 8);
    } });
    expect(blob?.size).toBe(8); expect(attempts.get(0)).toBe(2); expect(attempts.get(4)).toBe(1);
    expect(getUrl).toHaveBeenCalledWith(true, expect.any(AbortSignal));
  });
  it("cancels every in-flight range without starting the next window", async () => {
    const controller = new AbortController(); let aborted = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted++; reject(init!.signal!.reason); });
      if (fetcher.mock.calls.length === 4) queueMicrotask(() => controller.abort());
    }));
    await expect(downloadRanges({ size: 24, partBytes: 4, getUrl: async () => "https://s3.test/file", signal: controller.signal, onProgress() {}, fetcher })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(4); expect(aborted).toBe(4);
  });
  it("does not save a truncated range", async () => {
    const sink = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    await expect(downloadRanges({ size: 4, partBytes: 4, getUrl: async () => "https://s3.test/file", signal: new AbortController().signal, onProgress() {}, sink, fetcher: async () => rangeResponse(new Uint8Array(2), 0, 3, 4) })).rejects.toThrow("incomplete");
    expect(sink.close).not.toHaveBeenCalled();
  });
});
