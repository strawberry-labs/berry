import { downloadRanges } from "./file-download-ranges";

export type DownloadProgress = { received: number; total: number | null; bytesPerSecond: number };
export type DownloadSink = { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
export const MAX_BUFFERED_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** One transfer, with backpressure when writing directly to disk. */
export async function transferDownload(input: {
  url: string;
  size: number;
  signal: AbortSignal;
  sink?: DownloadSink;
  onProgress(progress: DownloadProgress): void;
  fetcher?: typeof fetch;
  idleTimeoutMs?: number;
  resolveStorageUrl?: boolean;
}): Promise<Blob | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("No download data received for 60 seconds. Check your connection and retry.")), input.idleTimeoutMs ?? 60_000);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  const started = performance.now();
  try {
    resetTimeout();
    const fetcher = input.fetcher ?? fetch;
    let url = input.url;
    let credentials: RequestCredentials = "include";
    let signedEndpoint: string | undefined;
    if (input.resolveStorageUrl && /\/v1\/(?:orgs\/[^/]+\/support\/users\/[^/]+\/)?files\/[^/]+\/content(?:\?|$)/.test(url)) {
      const endpoint = url.replace(/\/content(?:\?.*)?$/, "/download-url");
      const signed = await fetcher(endpoint, { credentials: "include", signal: controller.signal, cache: "no-store" });
      if (signed.ok) {
        const result = await signed.json() as { url: string };
        if (typeof result.url !== "string" || !/^https?:\/\//.test(result.url)) throw new Error("Invalid download response. Please retry.");
        url = result.url;
        signedEndpoint = endpoint;
        credentials = "omit";
      } else if (signed.status !== 404 && signed.status !== 501) {
        throw new Error(signed.status === 401 ? "Your session expired. Sign in again to download this file."
          : "This file is unavailable or you no longer have access to it.");
      }
    }
    if (signedEndpoint && input.size >= 16 * 1024 * 1024) {
      if (!input.sink && input.size > MAX_BUFFERED_DOWNLOAD_BYTES) throw new Error("This file is too large to buffer in this browser. Use the browser download link below.");
      clearTimeout(timer);
      let signedAt = performance.now();
      let refresh: Promise<string> | undefined;
      const identity = (value: string) => { const parsed = new URL(value); return `${parsed.origin}${parsed.pathname}?versionId=${parsed.searchParams.get("versionId") ?? ""}`; };
      const originalIdentity = identity(url);
      const getUrl = async (force = false, signal?: AbortSignal): Promise<string> => {
        if (!force && performance.now() - signedAt < 45_000) return url;
        if (!refresh) refresh = (async () => {
          const signed = await fetcher(signedEndpoint!, { credentials: "include", cache: "no-store", signal: signal ?? controller.signal });
          if (!signed.ok) throw new Error("Unable to renew download access. Please retry.");
          const result = await signed.json() as { url: string };
          if (identity(result.url) !== originalIdentity) throw new Error("The file changed during download. Please retry.");
          url = result.url; signedAt = performance.now(); return url;
        })().finally(() => { refresh = undefined; });
        return refresh;
      };
      return await downloadRanges({ size: input.size, getUrl, signal: controller.signal, fetcher, onProgress: input.onProgress,
        ...(input.sink ? { sink: input.sink } : {}), ...(input.idleTimeoutMs ? { idleTimeoutMs: input.idleTimeoutMs } : {}) });
    }
    const response = await fetcher(url, { credentials, signal: controller.signal, referrerPolicy: "no-referrer" });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "Your session expired. Sign in again to download this file."
        : response.status === 403 || response.status === 404 ? "This file is unavailable or you no longer have access to it."
        : `Download failed (HTTP ${response.status}). Please retry.`);
    }
    if (!response.body) throw new Error("The server returned an empty download response.");
    const length = Number(response.headers.get("content-length"));
    const total = !response.headers.get("content-encoding") && length > 0 ? length : input.size > 0 ? input.size : null;
    if (!input.sink && total !== null && total > MAX_BUFFERED_DOWNLOAD_BYTES) {
      throw new Error("This file is too large to buffer in this browser. Use the browser download link below.");
    }
    reader = response.body.getReader();
    const progress = () => input.onProgress({ received, total, bytesPerSecond: received / Math.max(0.001, (performance.now() - started) / 1000) });
    progress();
    let lastUpdate = 0;
    let pending = new Uint8Array(1024 * 1024);
    let pendingBytes = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      resetTimeout();
      received += chunk.value.byteLength;
      if (input.sink) {
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const count = Math.min(pending.byteLength - pendingBytes, chunk.value.byteLength - offset);
          pending.set(chunk.value.subarray(offset, offset + count), pendingBytes);
          pendingBytes += count; offset += count;
          if (pendingBytes === pending.byteLength) { await input.sink.write(pending); pending = new Uint8Array(1024 * 1024); pendingBytes = 0; }
        }
      }
      else {
        if (received > MAX_BUFFERED_DOWNLOAD_BYTES) throw new Error("This file is too large to buffer in this browser. Use the browser download link below.");
        chunks.push(chunk.value.slice().buffer as ArrayBuffer);
      }
      if (performance.now() - lastUpdate > 150) { progress(); lastUpdate = performance.now(); }
    }
    controller.signal.throwIfAborted();
    if (total !== null && received !== total) throw new Error("The download was incomplete. Please retry.");
    progress();
    if (input.sink) { if (pendingBytes) await input.sink.write(pending.subarray(0, pendingBytes)); controller.signal.throwIfAborted(); await input.sink.close(); return null; }
    return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
  } catch (error) {
    controller.abort(controller.signal.reason ?? error);
    await reader?.cancel().catch(() => undefined);
    await input.sink?.abort().catch(() => undefined);
    throw controller.signal.reason ?? error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}
