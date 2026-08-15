import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, MessagePart } from "@berry/shared";
import { shouldMountTaskSurface } from "@/components/app-shell";
import { WebSettingsNavigation } from "@/components/shell/web-settings-navigation";
import { BerryAssistantTurnGroup } from "@berry/desktop-ui/components/berry-thread-view";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";
import { SidebarProvider } from "@berry/desktop-ui/components/ui/sidebar";
import { sessionStreamStore, useSessionStream } from "./session-stream-store";

const SETTLED_MESSAGE = {
  id: "settled-assistant",
  sessionId: "task-a",
  role: "assistant",
  status: "complete",
  parts: [{ id: "settled-part", messageId: "settled-assistant", kind: "text", content: "Settled answer", position: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
  inputTokens: 0,
  outputTokens: 4,
  generationMs: 100,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
} as unknown as Message;
const SETTLED_MESSAGES = [SETTLED_MESSAGE];
const SETTLED_ADAPTER = {};
const SETTLED_WRITING_BLOCK_PARTS = new Map();
const SETTLED_CONVERSATION_IMAGE_PARTS: MessagePart[] = [];

function ensureFakeBrowserGlobals() {
  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
        matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
      },
    });
  }
  if (typeof globalThis.document === "undefined") Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
}

function StreamProbe({ sessionId, renders, values }: { sessionId: string; renders: Map<string, number>; values?: Map<string, string> }) {
  const stream = useSessionStream(sessionId);
  values?.set(sessionId, stream.text);
  renders.set(sessionId, (renders.get(sessionId) ?? 0) + 1);
  return null;
}

function TrackedSettledTurn({ renders }: { renders: Map<string, number> }) {
  renders.set("settled-turn", (renders.get("settled-turn") ?? 0) + 1);
  const onRender = React.useCallback(() => {
    renders.set("settled-turn-actual", (renders.get("settled-turn-actual") ?? 0) + 1);
  }, [renders]);
  return (
    <BerryAssistantTurnGroup
      messages={SETTLED_MESSAGES}
      turnKey="settled-turn"
      showReasoning={false}
      showTodos={false}
      density="compact"
      adapter={SETTLED_ADAPTER}
      writingBlockParts={SETTLED_WRITING_BLOCK_PARTS}
      conversationImageParts={SETTLED_CONVERSATION_IMAGE_PARTS}
      onRender={onRender}
    />
  );
}

function ThreadLike({ sessionId, renders, values }: { sessionId: string; renders: Map<string, number>; values: Map<string, string> }) {
  const stream = useSessionStream(sessionId);
  values.set(sessionId, stream.text);
  renders.set(`thread:${sessionId}`, (renders.get(`thread:${sessionId}`) ?? 0) + 1);
  return <TrackedSettledTurn renders={renders} />;
}

function TaskSurface({ surface, sessionId, renders }: { surface: "task" | "settings" | "library"; sessionId: string; renders: Map<string, number> }) {
  return shouldMountTaskSurface(surface)
    ? <>
      <StreamProbe sessionId={sessionId} renders={renders} />
      <TrackedMarkdown sessionId={sessionId} renders={renders} />
    </>
    : null;
}

function TaskThreadSurface({ surface, sessionId, renders, values }: { surface: "task" | "settings" | "library"; sessionId: string; renders: Map<string, number>; values: Map<string, string> }) {
  return shouldMountTaskSurface(surface)
    ? <>
      <ThreadLike sessionId={sessionId} renders={renders} values={values} />
      <StreamMarkdown sessionId={sessionId} renders={renders} values={values} />
    </>
    : null;
}

function TrackedMarkdown({ sessionId, renders }: { sessionId: string; renders: Map<string, number> }) {
  const key = `markdown:${sessionId}`;
  renders.set(key, (renders.get(key) ?? 0) + 1);
  return <Markdown streaming>{`Live output for ${sessionId}`}</Markdown>;
}

function StreamMarkdown({ sessionId, renders, values }: { sessionId: string; renders: Map<string, number>; values: Map<string, string> }) {
  const stream = useSessionStream(sessionId);
  values.set(`markdown:${sessionId}`, stream.text);
  renders.set(`markdown:${sessionId}`, (renders.get(`markdown:${sessionId}`) ?? 0) + 1);
  return <Markdown streaming>{stream.text}</Markdown>;
}

function NavigationSurface({ renders }: { renders: Map<string, number> }) {
  renders.set("navigation", (renders.get("navigation") ?? 0) + 1);
  return (
    <SidebarProvider>
      <WebSettingsNavigation
        kind="settings"
        tab="general"
        permissions={[]}
        platformAuthorized={false}
        onNavigate={() => undefined}
        onBack={() => undefined}
      />
    </SidebarProvider>
  );
}

describe("streaming surface render isolation", () => {
  afterEach(() => {
    sessionStreamStore.clear();
    vi.useRealTimers();
  });

  it("rerenders only the subscribed task for a coalesced token burst", () => {
    vi.useFakeTimers();
    const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    const previousDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        setTimeout: globalThis.setTimeout,
        clearTimeout: () => undefined,
        matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
    const renders = new Map<string, number>();
    const values = new Map<string, string>();
    let renderer: ReactTestRenderer;
    try {
      act(() => {
        renderer = create(
          <>
            <NavigationSurface renders={renders} />
            <ThreadLike sessionId="task-a" renders={renders} values={values} />
            <StreamProbe sessionId="task-b" renders={renders} values={values} />
            <TrackedMarkdown sessionId="settled" renders={renders} />
          </>,
        );
      });
      expect(renders).toEqual(new Map([
        ["navigation", 1],
        ["thread:task-a", 1],
        ["settled-turn", 1],
        ["settled-turn-actual", 1],
        ["task-b", 1],
        ["markdown:settled", 1],
      ]));

      act(() => {
        sessionStreamStore.update("task-a", { kind: "message.delta", messageId: "message-a", delta: "one", channel: "text" });
        sessionStreamStore.update("task-a", { kind: "message.delta", messageId: "message-a", delta: " two", channel: "text" });
        vi.advanceTimersByTime(500);
      });

      expect(renders.get("thread:task-a")).toBe(2);
      expect(renders.get("task-b")).toBe(1);
      expect(renders.get("settled-turn")).toBe(2);
      expect(renders.get("settled-turn-actual")).toBe(1);
      expect(renders.get("navigation")).toBe(1);
      expect(renders.get("markdown:settled")).toBe(1);
      expect(values.get("task-a")).toBe("one two");
      expect(values.get("task-b")).toBe("");
      act(() => { renderer!.unmount(); });
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  });

  it("does no stream work while management is mounted and isolates a task switch", () => {
    vi.useFakeTimers();
    ensureFakeBrowserGlobals();
    const renders = new Map<string, number>();
    const values = new Map<string, string>();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<TaskSurface surface="settings" sessionId="task-a" renders={renders} />);
      sessionStreamStore.update("task-a", { kind: "message.delta", messageId: "message-a", delta: "hidden", channel: "text" });
      vi.advanceTimersByTime(500);
    });
    expect(renders.size).toBe(0);

    act(() => {
      renderer!.update(<TaskThreadSurface surface="task" sessionId="task-a" renders={renders} values={values} />);
    });
    expect(renders.get("thread:task-a")).toBe(1);
    expect(renders.get("markdown:task-a")).toBe(1);
    expect(values.get("task-a")).toBe("hidden");

    act(() => {
      renderer!.update(<TaskThreadSurface surface="task" sessionId="task-b" renders={renders} values={values} />);
    });
    act(() => {
      sessionStreamStore.update("task-a", { kind: "message.delta", messageId: "message-a", delta: "old task", channel: "text" });
      sessionStreamStore.update("task-b", { kind: "message.delta", messageId: "message-b", delta: "new task", channel: "text" });
      vi.advanceTimersByTime(500);
    });
    expect(renders.get("thread:task-a")).toBe(1);
    expect(renders.get("thread:task-b")).toBe(2);
    expect(renders.get("markdown:task-a")).toBe(1);
    expect(renders.get("markdown:task-b")).toBe(2);
    expect(values.get("task-a")).toBe("hidden");
    expect(values.get("task-b")).toBe("new task");
    expect(renders.get("settled-turn")).toBe(3);
    expect(renders.get("settled-turn-actual")).toBe(1);
    act(() => { renderer!.unmount(); });
  });

  it("terminates abandoned settled-code workers and ignores stale responses", () => {
    vi.useFakeTimers();
    const previousWorker = globalThis.Worker;
    const workers: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: (() => void) | null;
      terminated: boolean;
      postMessage: () => void;
      terminate: () => void;
    }> = [];
    class TestWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor() {
        workers.push(this);
      }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
    try {
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<Markdown>{"```ts\nconst stale = true;\n```"}</Markdown>);
      });
      act(() => { vi.advanceTimersByTime(500); });
      expect(workers).toHaveLength(1);
      const oldWorker = workers[0]!;
      act(() => {
        renderer!.update(<Markdown>{"```ts\nconst current = true;\n```"}</Markdown>);
      });
      expect(oldWorker.terminated).toBe(true);
      oldWorker.onmessage?.({ data: { status: "highlighted", lines: [[{ content: "stale", offset: 0 }]] } } as MessageEvent);
      act(() => { vi.advanceTimersByTime(500); });
      expect(workers).toHaveLength(2);
      act(() => { renderer!.unmount(); });
      expect(workers.every((worker) => worker.terminated)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "Worker", { configurable: true, value: previousWorker });
    }
  });
});
