import * as React from "react";
import { IDLE, reduceStream, reduceStreamDeltas, type StreamState } from "@berry/desktop-ui/components/thread-stream";

type StreamEvent = Parameters<typeof reduceStream>[1];
type Listener = () => void;

interface PendingDeltas {
  text: string;
  reasoning: string;
  messageId: string;
  frameId: number | null;
}

/**
 * Per-session live state lives outside the app shell's render tree. A stream
 * token therefore wakes only subscribers for that session (the task thread
 * and composer), not the sidebar, route chrome, dialogs, or management
 * screens. The store also owns frame coalescing so every host gets the same
 * bounded update behavior.
 */
export class SessionStreamStore {
  #streams = new Map<string, StreamState>();
  #listeners = new Map<string, Set<Listener>>();
  #pending = new Map<string, PendingDeltas>();

  get(sessionId: string | null | undefined): StreamState {
    return sessionId ? this.#streams.get(sessionId) ?? IDLE : IDLE;
  }

  has(sessionId: string): boolean {
    return this.#streams.has(sessionId);
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(sessionId);
    };
  }

  set(sessionId: string, state: StreamState): void {
    // A replay/recovery snapshot is authoritative. Do not let a frame queued
    // from the previous run append stale text after that replacement lands.
    this.#cancelPending(sessionId);
    if (this.#streams.get(sessionId) === state) return;
    this.#streams.set(sessionId, state);
    this.#notify(sessionId);
  }

  update(sessionId: string, event: StreamEvent): void {
    if (event.kind === "message.delta") {
      const pending = this.#pending.get(sessionId) ?? {
        text: "",
        reasoning: "",
        messageId: event.messageId,
        frameId: null,
      };
      pending.messageId = event.messageId;
      if (event.channel === "reasoning") pending.reasoning += event.delta;
      else pending.text += event.delta;
      if (pending.frameId === null) {
        pending.frameId = this.#scheduleFrame(() => this.flush(sessionId));
      }
      this.#pending.set(sessionId, pending);
      return;
    }

    // Preserve event order: text received before a tool/end event must be
    // visible before that event changes the live turn state.
    this.flush(sessionId);
    this.set(sessionId, reduceStream(this.get(sessionId), event));
  }

  flush(sessionId: string): void {
    const pending = this.#pending.get(sessionId);
    if (!pending) return;
    if (pending.frameId !== null) this.#cancelFrame(pending.frameId);
    this.#pending.delete(sessionId);
    if (!pending.text && !pending.reasoning) return;
    this.set(sessionId, reduceStreamDeltas(this.get(sessionId), pending));
  }

  reset(sessionId: string): void {
    this.#cancelPending(sessionId);
    this.set(sessionId, IDLE);
  }

  delete(sessionId: string): void {
    this.#cancelPending(sessionId);
    this.#streams.delete(sessionId);
    this.#listeners.delete(sessionId);
  }

  clear(): void {
    for (const sessionId of this.#pending.keys()) this.#cancelPending(sessionId);
    this.#pending.clear();
    this.#streams.clear();
    this.#listeners.clear();
  }

  #cancelPending(sessionId: string): void {
    const pending = this.#pending.get(sessionId);
    if (!pending) return;
    if (pending.frameId !== null) this.#cancelFrame(pending.frameId);
    this.#pending.delete(sessionId);
  }

  #notify(sessionId: string): void {
    for (const listener of this.#listeners.get(sessionId) ?? []) listener();
  }

  #scheduleFrame(callback: () => void): number {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(callback);
    }
    return globalThis.setTimeout(callback, 16) as unknown as number;
  }

  #cancelFrame(frameId: number): void {
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameId);
      return;
    }
    globalThis.clearTimeout(frameId);
  }
}

export const sessionStreamStore = new SessionStreamStore();

export function useSessionStream(sessionId: string | null | undefined): StreamState {
  const subscribe = React.useCallback(
    (listener: Listener) => sessionId ? sessionStreamStore.subscribe(sessionId, listener) : () => undefined,
    [sessionId],
  );
  const getSnapshot = React.useCallback(
    () => sessionStreamStore.get(sessionId),
    [sessionId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
