import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { BrowserControlState } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";

type Metadata = { page?: { url?: string }; tabs?: { tab_id: string; url: string; active: boolean }[]; human_control?: boolean; controlling?: boolean };
const EMPTY: BrowserControlState = { runId: null, active: false, sessions: [], handoff: null };
function message(error: unknown) { return error instanceof Error ? error.message : "Browser control is unavailable. Try again."; }
const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

/** Credentials live only in this mounted viewer; never in messages, storage or URLs in the page. */
export function BrowserControl({ client, sessionId, active, onChanged }: { client: BerryApiClient; sessionId: string; active: boolean; onChanged: () => void }) {
  const [state, setState] = React.useState(EMPTY);
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState("");
  const [metadata, setMetadata] = React.useState<Metadata>({});
  const [status, setStatus] = React.useState("Disconnected");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [frame, setFrame] = React.useState(false);
  const [reconnect, setReconnect] = React.useState(0);
  const [control, setControl] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const socket = React.useRef<WebSocket | null>(null);
  const pressedKeys = React.useRef(new Map<string, { key: string; code: string; key_code: number }>());
  const epoch = React.useRef(0);
  const changed = React.useRef(onChanged); changed.current = onChanged;
  const previousHandoff = React.useRef("");
  React.useEffect(() => {
    const current = ++epoch.current;
    let pending = false;
    setState(EMPTY); setOpen(false); setSelected(""); setError(null);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await client.browserState(sessionId);
        if (current !== epoch.current) return;
        setState(result); setNow(Date.now());
        const signature = `${result.handoff?.id}:${result.handoff?.state}`;
        if (previousHandoff.current && previousHandoff.current !== signature) changed.current();
        previousHandoff.current = signature;
      } catch { /* A chat without browser support has no browser controls. Explicit actions report errors. */ }
      finally { pending = false; }
    };
    void load();
    const timer = active ? window.setInterval(() => void load(), 3000) : undefined;
    return () => { ++epoch.current; window.clearInterval(timer); socket.current?.close(); socket.current = null; };
  }, [client, sessionId, active]);
  const waiting = state.active && state.handoff?.state === "ready";
  const pausing = state.active && state.handoff?.state === "requested";
  React.useEffect(() => { if (!waiting && !pausing) setControl(false); }, [waiting, pausing]);
  const browser = state.sessions.find((item) => item.sessionId === (state.handoff?.state !== "resumed" ? state.handoff?.sessionId : selected)) ?? state.sessions.find((item) => item.sessionId === selected) ?? state.sessions.at(-1);
  const browserId = browser?.sessionId ?? "";
  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  React.useEffect(() => {
    if (!open || !browserId || !state.active || (control && !waiting)) return;
    let disposed = false, painting = false;
    let ws: WebSocket | undefined;
    setFrame(false); setMetadata({}); setStatus("Connecting…");
    void client.browserConnection(sessionId, browserId, control).then((connection) => {
      if (disposed) return;
      ws = new WebSocket(connection.url); socket.current = ws; ws.binaryType = "blob";
      ws.onopen = () => {
        if (control) ws!.send(JSON.stringify({ kind: "control", active: true }));
        setStatus(control ? "Requesting control…" : "Live · view only");
      };
      ws.onclose = () => { if (!disposed) { setMetadata({}); setStatus("Disconnected · reconnect to continue"); } };
      ws.onerror = () => { if (!disposed) setStatus("Connection unavailable · reconnect to retry"); };
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
          } catch { if (!disposed) setStatus("Could not display browser frame"); }
          finally { painting = false; }
          return;
        }
        try {
          const value = JSON.parse(String(event.data));
          if (value.type === "metadata") {
            setMetadata(value);
            setStatus(value.controlling ? "You have control · agent paused" : value.human_control ? "Another viewer has control · agent paused" : "Live · view only");
          } else if (value.type === "error") setStatus(value.code === "SESSION_BUSY" ? "Browser busy · reconnect after the action finishes" : "Browser input unavailable · reconnect to retry");
        } catch { /* Unknown frames are ignored. */ }
      };
    }).catch((cause) => { if (!disposed) { setError(message(cause)); setStatus("Connection unavailable"); } });
    return () => { disposed = true; ws?.close(); if (socket.current === ws) socket.current = null; };
  }, [client, sessionId, browserId, open, control, waiting, state.active, reconnect]);
  React.useEffect(() => { if (!state.active && open) setOpen(false); }, [state.active, open]);
  const send = (value: unknown) => { if (metadata.controlling && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value)); };
  const releaseKeys = () => {
    for (const key of pressedKeys.current.values()) send({ kind: "key", phase: "keyUp", ...key, modifiers: 0 });
    pressedKeys.current.clear();
  };
  const takeControl = async () => {
    if (!browserId || busy) return;
    const current = epoch.current; setBusy(true); setError(null);
    try {
      const result = await client.takeBrowserControl(sessionId, browserId);
      if (current !== epoch.current) return;
      setState(result); setSelected(browserId); setControl(true); setOpen(true); setReconnect((value) => value + 1); changed.current();
    } catch (cause) { if (current === epoch.current) setError(message(cause)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const returnControl = async () => {
    if (!state.handoff || !browserId || busy) return;
    const current = epoch.current; setBusy(true); setError(null);
    releaseKeys();
    const ws = socket.current; socket.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 2000);
      ws.addEventListener("close", () => { window.clearTimeout(timer); resolve(); }, { once: true });
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: "control", active: false }));
      ws.close();
    });
    try {
      const result = await client.resumeBrowserAgent(sessionId, browserId, state.handoff.id);
      if (current !== epoch.current) return;
      setState(result); setControl(false); setOpen(false); changed.current();
    } catch (cause) { if (current === epoch.current) setError(message(cause)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>, phase: string) => {
    if (!metadata.controlling) return;
    event.preventDefault(); event.currentTarget.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    if (phase === "mousePressed") event.currentTarget.setPointerCapture(event.pointerId);
    send({ kind: "mouse", phase, x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)), width: rect.width, height: rect.height, button: ["left", "middle", "right"][event.button] ?? "none", buttons: event.buttons, click_count: phase === "mouseMoved" ? 0 : 1, modifiers: modifiers(event) });
  };
  const key = (event: React.KeyboardEvent<HTMLCanvasElement>, phase: string) => {
    if (!metadata.controlling) return;
    if (event.key === "Escape" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); releaseKeys(); event.currentTarget.blur(); return; }
    // Allow the browser's paste event to deliver clipboard text. The paste
    // handler forwards that text without granting remote clipboard access.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") { event.stopPropagation(); return; }
    event.preventDefault(); event.stopPropagation();
    if (phase === "keyDown") pressedKeys.current.set(event.code, { key: event.key, code: event.code, key_code: event.keyCode });
    else pressedKeys.current.delete(event.code);
    send({ kind: "key", phase, key: event.key, code: event.code, key_code: event.keyCode, modifiers: modifiers(event), ...(phase === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { text: event.key } : {}) });
  };
  if (!state.active || !browser) return null;
  const expired = !!browser.expiresAt && Date.parse(browser.expiresAt) <= now;
  return <>
    <div className="berry-browser-card" role="region" aria-label="Browser control">
      <div className="min-w-0"><p className="text-sm font-medium">{waiting ? "Browser needs your help" : pausing ? "Pausing for browser control…" : "Browser"}</p><p className="text-xs text-[var(--berry-text-secondary)]">{waiting ? state.handoff?.reason : pausing ? "The current action will finish before you take control." : "Watch the browser or take control to unblock a step."}</p></div>
      <div className="flex shrink-0 flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => { setControl(false); setOpen(true); }}>View browser</Button><Button size="sm" disabled={busy || pausing || expired} onClick={() => void takeControl()}>{waiting ? "Take control" : "Pause & take control"}</Button>{waiting ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void returnControl()}>Return to agent</Button> : null}</div>
    </div>
    {error && !open ? <p className="berry-browser-error" role="alert">{error}</p> : null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="berry-browser-dialog" aria-describedby="berry-browser-description" onEscapeKeyDown={(event) => { if (canvas.current === document.activeElement) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Browser</DialogTitle><DialogDescription id="berry-browser-description">{waiting ? "Your agent is paused. Unblock the page, then return control to continue this chat or automation. Closing this panel keeps the agent paused." : pausing ? "The current agent action is finishing. Browser input will unlock once the agent is safely paused." : "Watch this browser live. Pause the agent before interacting with the page."}</DialogDescription></DialogHeader>
        <div className="berry-browser-toolbar"><span className="min-w-0 flex-1 truncate text-xs" title={metadata.page?.url}>{metadata.page?.url ?? browserId}</span><select className="berry-browser-tabs" aria-label="Browser tab" disabled={!metadata.controlling} value={metadata.tabs?.find((tab) => tab.active)?.tab_id ?? ""} onChange={(event) => send({ kind: "tab", tab_id: event.target.value })}>{metadata.tabs?.map((tab) => <option key={tab.tab_id} value={tab.tab_id}>{tab.url.slice(0, 90)}</option>)}</select></div>
        <div className="berry-browser-stage"><canvas ref={canvas} hidden={!frame} tabIndex={metadata.controlling ? 0 : -1} aria-label={metadata.controlling ? "Live browser. Click or type to control the page. Press Shift Escape to leave browser input." : "Live browser preview"} onContextMenu={(event) => event.preventDefault()} onPointerMove={(event) => pointer(event, "mouseMoved")} onPointerDown={(event) => pointer(event, "mousePressed")} onPointerUp={(event) => pointer(event, "mouseReleased")} onKeyDown={(event) => key(event, "keyDown")} onKeyUp={(event) => key(event, "keyUp")} onBlur={releaseKeys} onPaste={(event) => { if (metadata.controlling) { event.preventDefault(); send({ kind: "text", text: event.clipboardData.getData("text").slice(0, 10000) }); } }} onWheel={(event) => {
          if (!metadata.controlling) return;
          const rect = event.currentTarget.getBoundingClientRect();
          send({ kind: "mouse", phase: "mouseWheel", x: Math.max(0, event.clientX - rect.left), y: Math.max(0, event.clientY - rect.top), width: rect.width, height: rect.height, delta_x: Math.max(-10000, Math.min(10000, event.deltaX)), delta_y: Math.max(-10000, Math.min(10000, event.deltaY)), modifiers: modifiers(event) });
        }} />{!frame ? <p className="text-xs text-[var(--berry-text-secondary)]">{pausing ? "Waiting for the current agent action to finish…" : status}</p> : null}</div>
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs text-[var(--berry-text-secondary)]"><p role="status" aria-live="polite">{pausing ? "Pausing agent…" : status}</p><p>{expired ? "This browser has expired. Return to the agent to recover." : browser.expiresAt ? `Browser expires in ${Math.max(0, Math.ceil((Date.parse(browser.expiresAt) - now) / 60000))} min. Idle sessions can end sooner.` : "Idle sessions can expire. Return control when finished."}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || pausing || expired} onClick={() => { setError(null); setReconnect((value) => value + 1); }}>Reconnect</Button>{!metadata.controlling ? <Button size="sm" disabled={busy || pausing || expired} onClick={() => void takeControl()}>Take control</Button> : null}{waiting ? <Button size="sm" disabled={busy} onClick={() => void returnControl()}>{busy ? "Returning…" : "Return to agent"}</Button> : null}</div></div>
        {error ? <p className="text-xs text-[var(--berry-text-secondary)]" role="alert">{error}</p> : null}
      </DialogContent>
    </Dialog>
  </>;
}
