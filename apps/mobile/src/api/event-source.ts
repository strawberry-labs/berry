import { createParser } from "eventsource-parser";
import type { BerryEventSourceFactory, BerryEventSourceLike } from "@berry/api-client";

type StreamFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> } } | null;
}>;

type AppStateSource = {
  current(): "active" | "background" | "inactive" | string;
  subscribe(listener: (state: string) => void): () => void;
};

export type NativeEventSourceDeps = {
  fetch: StreamFetch;
  appState?: AppStateSource | undefined;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
};

/** An HTTP status the stream should not retry (signed out, gone, forbidden). */
export class EventStreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Event stream failed with ${status}`);
  }
}

/**
 * React Native has no EventSource, and the browser one cannot send the
 * bearer header. This implementation streams with `fetch`, parses SSE, and
 * resumes from the last event id after drops or while the app was in the
 * background, the way the web's EventSource reconnects.
 */
export function createNativeEventSource(deps: NativeEventSourceDeps): BerryEventSourceFactory {
  return (url, init) => new NativeEventSource(url, headersToRecord(init.headers), deps);
}

class NativeEventSource implements BerryEventSourceLike {
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;

  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #deps: Required<Omit<NativeEventSourceDeps, "appState">> & Pick<NativeEventSourceDeps, "appState">;
  readonly #unsubscribe: (() => void) | null;
  #controller: AbortController | null = null;
  #timer: unknown = null;
  #lastEventId: string | null = null;
  #retryMs = 1_000;
  #attempt = 0;
  #closed = false;
  #paused = false;

  constructor(url: string, headers: Record<string, string>, deps: NativeEventSourceDeps) {
    this.#url = url;
    this.#headers = headers;
    this.#deps = {
      fetch: deps.fetch,
      appState: deps.appState,
      setTimeout: deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms)),
      clearTimeout: deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      random: deps.random ?? Math.random,
    };
    this.#paused = deps.appState ? deps.appState.current() === "background" : false;
    this.#unsubscribe = deps.appState?.subscribe((state) => {
      if (state === "active") this.#resume();
      else if (state === "background") this.#pause();
    }) ?? null;
    // Let callers attach handlers before the first connection opens.
    void Promise.resolve().then(() => this.#connect());
  }

  close(): void {
    this.#closed = true;
    this.#controller?.abort();
    this.#cancelTimer();
    this.#unsubscribe?.();
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#paused) return;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const response = await this.#deps.fetch(streamUrl(this.#url, this.#lastEventId), {
        headers: {
          ...this.#headers,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...(this.#lastEventId ? { "Last-Event-ID": this.#lastEventId } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new EventStreamHttpError(response.status);
      this.#attempt = 0;
      this.onopen?.({ type: "open" });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createParser({
        onEvent: (event) => {
          if (event.id) this.#lastEventId = event.id;
          this.onmessage?.({ data: event.data, lastEventId: event.id ?? this.#lastEventId ?? "" });
        },
        onRetry: (ms) => { this.#retryMs = Math.max(250, ms); },
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.#closed) break;
        if (value) parser.feed(decoder.decode(value, { stream: true }));
      }
      if (!this.#closed && !controller.signal.aborted) this.#scheduleReconnect();
    } catch (error) {
      if (this.#closed || controller.signal.aborted) return;
      this.onerror?.(error instanceof EventStreamHttpError ? { type: "error", status: error.status } : { type: "error", error });
      if (error instanceof EventStreamHttpError && [401, 403, 404, 410].includes(error.status)) {
        this.close();
        return;
      }
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    this.#cancelTimer();
    const delay = reconnectDelay(this.#attempt, this.#retryMs, this.#deps.random());
    this.#attempt += 1;
    this.#timer = this.#deps.setTimeout(() => void this.#connect(), delay);
  }

  #pause(): void {
    if (this.#paused || this.#closed) return;
    this.#paused = true;
    this.#controller?.abort();
    this.#cancelTimer();
  }

  #resume(): void {
    if (!this.#paused || this.#closed) return;
    this.#paused = false;
    this.#attempt = 0;
    void this.#connect();
  }

  #cancelTimer(): void {
    if (this.#timer !== null) this.#deps.clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** Session streams resume from `?cursor=`, which the API prefers over Last-Event-ID. */
export function streamUrl(url: string, lastEventId: string | null): string {
  if (!lastEventId || !url.includes("/sessions/")) return url;
  const [path, query = ""] = url.split("?", 2) as [string, string?];
  const params = query.split("&").filter((part) => part && !part.startsWith("cursor="));
  params.push(`cursor=${encodeURIComponent(lastEventId)}`);
  return `${path}?${params.join("&")}`;
}

/** Exponential backoff from the server's retry hint, capped at 30 s, with ±25% jitter. */
export function reconnectDelay(attempt: number, baseMs: number, random: number): number {
  const exponential = Math.min(30_000, baseMs * 2 ** Math.min(attempt, 10));
  return Math.round(exponential * (0.75 + random * 0.5));
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => { record[key] = value; });
  return record;
}
