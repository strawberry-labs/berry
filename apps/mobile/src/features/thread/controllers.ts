import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HistoryState } from "./session-controller";
import { SessionController } from "./session-controller";
import { addSignOutListener, useSignedInSession } from "../../session/session";
import { shellKeys } from "../data/shell-data";

const MAX_IDLE_CONTROLLERS = 8;

type Entry = { controller: SessionController; users: number; lastUsed: number };

/**
 * One SessionController per session, shared by every screen that shows it:
 * the home composer starts a new task's first turn on the same controller the
 * task screen then renders, so no optimistic message or early event is lost.
 * Unused controllers stay warm briefly (back-and-forth navigation) and the
 * least recently used are disposed beyond a small cap.
 */
class ControllerRegistry {
  readonly #entries = new Map<string, Entry>();

  acquire(key: string, create: () => SessionController): SessionController {
    const entry = this.#entries.get(key) ?? { controller: create(), users: 0, lastUsed: Date.now() };
    entry.users += 1;
    entry.lastUsed = Date.now();
    this.#entries.set(key, entry);
    return entry.controller;
  }

  peekOrCreate(key: string, create: () => SessionController): SessionController {
    const entry = this.#entries.get(key);
    if (entry) return entry.controller;
    const controller = create();
    this.#entries.set(key, { controller, users: 0, lastUsed: Date.now() });
    this.#trim();
    return controller;
  }

  release(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.users = Math.max(0, entry.users - 1);
    entry.lastUsed = Date.now();
    this.#trim();
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.controller.dispose();
    this.#entries.clear();
  }

  #trim(): void {
    const idle = [...this.#entries.entries()].filter(([, entry]) => entry.users === 0).sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    while (idle.length > MAX_IDLE_CONTROLLERS) {
      const [key, entry] = idle.shift()!;
      entry.controller.dispose();
      this.#entries.delete(key);
    }
  }
}

export const sessionControllers = new ControllerRegistry();
addSignOutListener(() => sessionControllers.clear());

/** The controller for one session, created on first use and refreshed with the task list when a run ends. */
export function useSessionControllerFactory() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return React.useCallback((sessionId: string) => {
    const key = `${profile.serverUrl}|${sessionId}`;
    return {
      key,
      create: () => new SessionController(client, sessionId, {
        onTurnEnd: () => void queryClient.invalidateQueries({ queryKey: shellKeys.tasks(profile.serverUrl) }),
      }),
    };
  }, [client, profile.serverUrl, queryClient]);
}

export function useSessionController(sessionId: string | null): { controller: SessionController | null; state: HistoryState | null } {
  const factory = useSessionControllerFactory();
  const [controller, setController] = React.useState<SessionController | null>(null);
  React.useEffect(() => {
    if (!sessionId) {
      setController(null);
      return;
    }
    const { key, create } = factory(sessionId);
    const next = sessionControllers.acquire(key, create);
    setController(next);
    void next.load();
    return () => sessionControllers.release(key);
  }, [factory, sessionId]);
  const state = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => undefined), [controller]),
    () => controller?.getSnapshot() ?? null,
  );
  return { controller, state };
}
