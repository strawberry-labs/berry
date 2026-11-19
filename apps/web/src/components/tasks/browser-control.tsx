import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { BrowserControlState } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@berry/desktop-ui/components/ui/resizable";
import { useIsMobile } from "@berry/desktop-ui/hooks/use-mobile";
import { Globe, PanelRight, X } from "@berry/desktop-ui/lib/icons";

type Metadata = { page?: { url?: string }; tabs?: { tab_id: string; url: string; active: boolean }[]; human_control?: boolean; controlling?: boolean };
const EMPTY: BrowserControlState = { runId: null, active: false, sessions: [], handoff: null };
function message(error: unknown) { return error instanceof Error ? error.message : "Browser control is unavailable. Try again."; }
const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

/** Credentials live only in this mounted viewer; never in messages, storage or URLs in the page. */
export function TaskBrowserWorkspace({ client, sessionId, active, onChanged, renderHeader, children }: {
  client: BerryApiClient | null;
  sessionId: string | null;
  active: boolean;
  onChanged: () => void;
  renderHeader: (browserButton: React.ReactNode) => React.ReactNode;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState(EMPTY);
  const [open, setOpen] = React.useState(false);
  const [metadata, setMetadata] = React.useState<Metadata>({});
  const [connection, setConnection] = React.useState<"connecting" | "live" | "disconnected">("connecting");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"take" | "return" | null>(null);
  const [frame, setFrame] = React.useState(false);
  const [reconnect, setReconnect] = React.useState(0);
  const [control, setControl] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const isMobile = useIsMobile();
  const paneId = React.useId();
  const trigger = React.useRef<HTMLButtonElement>(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const socket = React.useRef<WebSocket | null>(null);
  const pressedKeys = React.useRef(new Map<string, { key: string; code: string; key_code: number }>());
  const epoch = React.useRef(0);
  const changed = React.useRef(onChanged); changed.current = onChanged;
  const previousHandoff = React.useRef("");
  const opened = React.useRef<{ browser: string; handoff: string | null }>({ browser: "", handoff: null });

  React.useEffect(() => {
    previousHandoff.current = "";
    opened.current = { browser: "", handoff: null };
    setState(EMPTY);
    setOpen(false);
    setControl(false);
    setBusy(null);
    setError(null);
    return () => { epoch.current += 1; };
  }, [client, sessionId]);

  React.useEffect(() => {
    if (!client || !sessionId || busy) return;
    let disposed = false;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await client.browserState(sessionId);
        if (disposed) return;
        setState(result); setNow(Date.now());
        const signature = result.handoff ? `${result.handoff.id}:${result.handoff.state}` : "";
        const handoffChanged = previousHandoff.current !== signature;
        previousHandoff.current = signature;
        if (handoffChanged) changed.current();
      } catch { /* A chat without browser support has no browser controls. Explicit actions report errors. */ }
      finally { pending = false; }
    };
    void load();
    const timer = active ? window.setInterval(() => void load(), 3000) : undefined;
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, sessionId, active, busy]);

  const waiting = state.active && state.handoff?.state === "ready";
  const pausing = state.active && state.handoff?.state === "requested";
  React.useEffect(() => { if (!waiting && !pausing) setControl(false); }, [waiting, pausing]);
  const handoffBrowserId = waiting || pausing ? state.handoff?.sessionId : null;
  const browser = state.active
    ? state.sessions.find((item) => item.sessionId === handoffBrowserId) ?? state.sessions.at(-1)
    : undefined;
  const browserId = browser?.sessionId ?? "";
  const browserKey = browserId ? `${state.runId}:${browserId}` : "";
  const handoffId = waiting ? state.handoff?.id ?? null : null;
  const visible = open && Boolean(browser);
  const expiresAt = browser?.expiresAt;
  const expired = Boolean(expiresAt && Date.parse(expiresAt) <= now);

  React.useEffect(() => {
    const previous = opened.current;
    opened.current = { browser: browserKey, handoff: handoffId };
    if (!browserKey) setOpen(false);
    else if (browserKey !== previous.browser || (handoffId && handoffId !== previous.handoff)) setOpen(true);
  }, [browserKey, handoffId]);

  React.useEffect(() => {
    if (!visible || expired || !expiresAt) return;
    const delay = Math.max(0, Date.parse(expiresAt) - Date.now() + 1);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [visible, expired, expiresAt]);

  const canConnect = visible && !expired && (!control || waiting) && busy !== "return";
  React.useEffect(() => {
    if (!client || !sessionId || !browserId || !canConnect) return;
    let disposed = false, painting = false;
    let ws: WebSocket | undefined;
    setFrame(false); setMetadata({}); setConnection("connecting");
    void client.browserConnection(sessionId, browserId, control).then((connection) => {
      if (disposed) return;
      ws = new WebSocket(connection.url); socket.current = ws; ws.binaryType = "blob";
      ws.onopen = () => {
        if (control) ws!.send(JSON.stringify({ kind: "control", active: true }));
        setConnection("live");
      };
      ws.onclose = () => { if (!disposed) { setMetadata({}); setConnection("disconnected"); } };
      ws.onerror = () => { if (!disposed) setConnection("disconnected"); };
      ws.onmessage = async (event) => {
        if (disposed) return;
        if (event.data instanceof Blob) {
          if (painting) return;
          painting = true;
          try {
            const bitmap = await createImageBitmap(event.data);
            if (!disposed && canvas.current) {
              const target = canvas.current; target.width = bitmap.width; target.height = bitmap.height;
              target.getContext("2d")?.drawImage(bitmap, 0, 0); setFrame(true);
            }
            bitmap.close();
          } catch { if (!disposed) setError("Could not display the browser preview."); }
          finally { painting = false; }
          return;
        }
        try {
          const value = JSON.parse(String(event.data));
          if (value.type === "metadata") {
            setMetadata(value);
          } else if (value.type === "error") {
            setError(value.code === "SESSION_BUSY" ? "The browser is finishing an action. Reconnect when it’s ready." : "Browser input was interrupted. Reconnect to try again.");
            setConnection("disconnected");
          }
        } catch { /* Unknown frames are ignored. */ }
      };
    }).catch((cause) => { if (!disposed) { setError(message(cause)); setConnection("disconnected"); } });
    return () => { disposed = true; ws?.close(); if (socket.current === ws) socket.current = null; };
  }, [client, sessionId, browserId, canConnect, control, reconnect]);

  const controlling = canConnect && connection === "live" && Boolean(metadata.controlling);
  const send = (value: unknown) => { if (controlling && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value)); };
  const releaseKeys = () => {
    for (const key of pressedKeys.current.values()) send({ kind: "key", phase: "keyUp", ...key, modifiers: 0 });
    pressedKeys.current.clear();
  };
  const closeBrowser = () => {
    releaseKeys();
    setOpen(false);
    setControl(false);
    setError(null);
    trigger.current?.focus();
  };
  const takeControl = async () => {
    if (!client || !sessionId || !browserId || busy || expired) return;
    const current = epoch.current; setBusy("take"); setError(null);
    try {
      const result = await client.takeBrowserControl(sessionId, browserId);
      if (current !== epoch.current) return;
      setState(result); setControl(true); setReconnect((value) => value + 1); changed.current();
    } catch (cause) { if (current === epoch.current) setError(message(cause)); }
    finally { if (current === epoch.current) setBusy(null); }
  };
  const returnControl = async () => {
    if (!client || !sessionId || !handoffId || !browserId || busy) return;
    const current = epoch.current; setBusy("return"); setError(null);
    releaseKeys();
    const ws = socket.current; socket.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 2000);
      ws.addEventListener("close", () => { window.clearTimeout(timer); resolve(); }, { once: true });
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: "control", active: false }));
      ws.close();
    });
    try {
      const result = await client.resumeBrowserAgent(sessionId, browserId, handoffId);
      if (current !== epoch.current) return;
      setState(result); setControl(false); setReconnect((value) => value + 1); changed.current();
    } catch (cause) {
      if (current === epoch.current) { setControl(false); setError(message(cause)); }
    } finally { if (current === epoch.current) setBusy(null); }
  };
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, phase: string) => {
    if (!controlling) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (phase === "mousePressed") {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    send({ kind: "mouse", phase, x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)), width: rect.width, height: rect.height, button: ["left", "middle", "right"][event.button] ?? "none", buttons: event.buttons, click_count: phase === "mouseMoved" ? 0 : 1, modifiers: modifiers(event) });
  };
  const key = (event: React.KeyboardEvent<HTMLCanvasElement>, phase: string) => {
    if (!controlling) return;
    if (event.key === "Escape" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); releaseKeys(); event.currentTarget.blur(); return; }
    // Allow the browser's paste event to deliver clipboard text. The paste
    // handler forwards that text without granting remote clipboard access.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") { event.stopPropagation(); return; }
    event.preventDefault(); event.stopPropagation();
    if (phase === "keyDown") pressedKeys.current.set(event.code, { key: event.key, code: event.code, key_code: event.keyCode });
    else pressedKeys.current.delete(event.code);
    send({ kind: "key", phase, key: event.key, code: event.code, key_code: event.keyCode, modifiers: modifiers(event), ...(phase === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { text: event.key } : {}) });
  };
  const browserLabel = visible ? "Hide browser" : waiting ? "Open browser (agent paused)" : "Open browser";
  const browserButton = browser ? (
    <Button
      ref={trigger}
      type="button"
      variant="ghost"
      size="icon-sm"
      className="berry-titlebar-control berry-browser-trigger"
      aria-label={browserLabel}
      title={browserLabel}
      aria-expanded={visible}
      aria-controls={visible ? paneId : undefined}
      disabled={Boolean(busy)}
      onClick={() => { if (visible) closeBrowser(); else setOpen(true); }}
    >
      <PanelRight />
    </Button>
  ) : null;
  const status = expired ? "Session expired"
    : busy === "return" ? "Returning control…"
    : pausing || busy === "take" ? "Pausing agent…"
    : controlling ? "You have control"
    : metadata.human_control && connection === "live" ? "Another viewer has control"
    : control && connection !== "disconnected" ? "Taking control…"
    : waiting ? "Agent paused"
    : connection === "live" ? "Live · View only"
    : connection === "disconnected" ? "Disconnected"
    : "Connecting…";

  return (
    <>
      {renderHeader(browserButton)}
      <div className="workspace">
        <ResizablePanelGroup
          orientation={isMobile ? "vertical" : "horizontal"}
          defaultLayout={visible ? { thread: 55, browser: 45 } : undefined}
        >
          <ResizablePanel id="thread" minSize="30%">
            <section className="thread-pane berry-task-thread h-full" aria-label="Task">
              {children}
            </section>
          </ResizablePanel>
          {visible ? (
            <>
              <ResizableHandle className="berry-browser-divider" aria-label="Resize browser pane" />
              <ResizablePanel id="browser" minSize="30%">
                <aside className="berry-browser-pane" id={paneId} aria-label="Browser">
                  <header className="berry-browser-heading">
                    <Globe aria-hidden="true" />
                    <h2>Browser</h2>
                    <span role="status">{status}</span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Close browser pane" title="Close browser pane" disabled={Boolean(busy)} onClick={closeBrowser}>
                      <X />
                    </Button>
                  </header>
                  {waiting && !expired && state.handoff?.reason ? (
                    <p className="berry-browser-handoff">{state.handoff.reason}</p>
                  ) : null}
                  <div className="berry-browser-toolbar">
                    <span className="min-w-0 flex-1 truncate" title={metadata.page?.url}>{metadata.page?.url ?? "Browser preview"}</span>
                    {metadata.tabs && metadata.tabs.length > 1 ? (
                      <select
                        className="berry-browser-tabs"
                        aria-label="Browser tab"
                        disabled={!controlling}
                        value={metadata.tabs.find((tab) => tab.active)?.tab_id ?? ""}
                        onChange={(event) => send({ kind: "tab", tab_id: event.target.value })}
                      >
                        {metadata.tabs.map((tab) => <option key={tab.tab_id} value={tab.tab_id}>{tab.url.slice(0, 90)}</option>)}
                      </select>
                    ) : null}
                  </div>
                  <div className="berry-browser-stage">
                    <canvas
                      ref={canvas}
                      hidden={!frame || expired}
                      tabIndex={controlling ? 0 : -1}
                      aria-label={controlling ? "Live browser. Click or type to control the page. Press Shift Escape to leave browser input." : "Live browser preview"}
                      onContextMenu={(event) => event.preventDefault()}
                      onPointerMove={(event) => pointer(event, "mouseMoved")}
                      onPointerDown={(event) => pointer(event, "mousePressed")}
                      onPointerUp={(event) => pointer(event, "mouseReleased")}
                      onKeyDown={(event) => key(event, "keyDown")}
                      onKeyUp={(event) => key(event, "keyUp")}
                      onBlur={releaseKeys}
                      onPaste={(event) => {
                        if (!controlling) return;
                        event.preventDefault();
                        send({ kind: "text", text: event.clipboardData.getData("text").slice(0, 10000) });
                      }}
                      onWheel={(event) => {
                        if (!controlling) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        send({ kind: "mouse", phase: "mouseWheel", x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)), width: rect.width, height: rect.height, delta_x: Math.max(-10000, Math.min(10000, event.deltaX)), delta_y: Math.max(-10000, Math.min(10000, event.deltaY)), modifiers: modifiers(event) });
                      }}
                    />
                    {expired ? <p>The browser session has ended.</p>
                      : !frame && connection === "live" ? <p>Waiting for the page…</p>
                      : null}
                  </div>
                  <footer className="berry-browser-footer">
                    {error ? <p role="alert">{error}</p> : null}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {connection === "disconnected" && !expired ? (
                        <Button type="button" variant="outline" size="sm" disabled={Boolean(busy) || pausing} onClick={() => { setError(null); setReconnect((value) => value + 1); }}>
                          Reconnect
                        </Button>
                      ) : null}
                      {!expired && !controlling && !control ? (
                        <Button type="button" size="sm" disabled={Boolean(busy) || pausing} onClick={() => void takeControl()}>
                          Take control
                        </Button>
                      ) : null}
                      {waiting ? (
                        <Button type="button" variant={control || expired ? "default" : "outline"} size="sm" disabled={Boolean(busy)} onClick={() => void returnControl()}>
                          Return to agent
                        </Button>
                      ) : null}
                    </div>
                  </footer>
                </aside>
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </>
  );
}
