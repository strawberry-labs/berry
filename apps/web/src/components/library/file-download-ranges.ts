import type { DownloadProgress, DownloadSink } from "./file-download";

const PART_BYTES = 8 * 1024 * 1024;
const CONNECTIONS = 4;

/** Bound memory to one window of ranges and write them in file order. */
export async function downloadRanges(input: {
  size: number;
  getUrl(refresh?: boolean, signal?: AbortSignal): Promise<string>;
  signal: AbortSignal;
  sink?: DownloadSink;
  fetcher: typeof fetch;
  onProgress(progress: DownloadProgress): void;
  idleTimeoutMs?: number;
  partBytes?: number;
}): Promise<Blob | null> {
  const fetcher = input.fetcher;
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const partBytes = input.partBytes ?? PART_BYTES;
  const parts = Math.ceil(input.size / partBytes);
  const counts = new Array<number>(parts).fill(0);
  const chunks: ArrayBuffer[] = [];
  const started = performance.now();
  let lastReport = 0;
  let etag: string | null = null;
  const progress = (force = false) => {
    if (!force && performance.now() - lastReport < 150) return;
    lastReport = performance.now();
    const received = counts.reduce((sum, value) => sum + value, 0);
    input.onProgress({ received, total: input.size, bytesPerSecond: received / Math.max(0.001, (performance.now() - started) / 1000) });
  };
  const readPart = async (index: number): Promise<ArrayBuffer> => {
    const start = index * partBytes;
    const end = Math.min(input.size, start + partBytes) - 1;
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      const request = new AbortController();
      const cancel = () => request.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", cancel, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutError = new Error("The download stalled. Please retry.");
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => request.abort(timeoutError), input.idleTimeoutMs ?? 60_000); };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let retryable = false;
      try {
        touch();
        const url = await input.getUrl(attempt > 0, request.signal);
        request.signal.throwIfAborted();
        const response = await fetcher(url, {
          credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: request.signal,
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (response.status !== 206) {
          retryable = [403, 408, 429, 500, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw new Error(`Download failed (HTTP ${response.status}). Please retry.`);
        }
        const range = response.headers.get("content-range");
        if (range !== `bytes ${start}-${end}/${input.size}` || response.headers.get("content-encoding")) {
          await response.body?.cancel();
          throw new Error("Storage returned an invalid file range. Please retry.");
        }
        const currentEtag = response.headers.get("etag");
        if (!currentEtag || (etag !== null && currentEtag !== etag)) {
          await response.body?.cancel();
          throw new Error("The file changed during download. Please retry.");
        }
        etag = currentEtag;
        if (!response.body) throw new Error("Storage returned an empty file range.");
        reader = response.body.getReader();
        const bytes = new Uint8Array(end - start + 1);
        let offset = 0;
        while (true) {
          request.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          touch();
          if (offset + chunk.value.byteLength > bytes.byteLength) throw new Error("Storage returned an invalid file range.");
          bytes.set(chunk.value, offset);
          offset += chunk.value.byteLength;
          counts[index] = offset;
          progress();
        }
        request.signal.throwIfAborted();
        if (offset !== bytes.byteLength) { retryable = true; throw new Error("The download was incomplete. Please retry."); }
        return bytes.buffer;
      } catch (error) {
        await reader?.cancel().catch(() => undefined);
        const cause = request.signal.reason ?? error;
        request.abort(cause);
        if (controller.signal.aborted || attempt >= 2 || !(retryable || cause === timeoutError || cause instanceof TypeError)) throw cause;
        counts[index] = 0;
        progress();
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => { clearTimeout(delay); reject(controller.signal.reason); };
          const delay = setTimeout(() => { controller.signal.removeEventListener("abort", cancelled); resolve(); }, 250 * 2 ** attempt);
          controller.signal.addEventListener("abort", cancelled, { once: true });
          if (controller.signal.aborted) cancelled();
        });
      } finally {
        clearTimeout(timer);
        reader?.releaseLock();
        controller.signal.removeEventListener("abort", cancel);
      }
    }
  };
  try {
    progress(true);
    for (let first = 0; first < parts; first += CONNECTIONS) {
      const window = await Promise.all(Array.from({ length: Math.min(CONNECTIONS, parts - first) }, (_, offset) => readPart(first + offset)));
      for (const bytes of window) {
        controller.signal.throwIfAborted();
        if (input.sink) await input.sink.write(new Uint8Array(bytes));
        else chunks.push(bytes);
      }
    }
    controller.signal.throwIfAborted();
    progress(true);
    if (input.sink) { await input.sink.close(); return null; }
    return new Blob(chunks, { type: "application/octet-stream" });
  } finally {
    controller.abort();
    input.signal.removeEventListener("abort", abort);
  }
}
