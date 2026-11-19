import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { TaskConnectorReconnect } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { toast } from "sonner";
import { ConnectorMark } from "../connector-mark";

export function TaskConnectorReconnects({ client, taskId, active }: { client: BerryApiClient; taskId: string; active: boolean }) {
  const [actions, setActions] = React.useState<TaskConnectorReconnect[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const storageKey = `berry.mcp-reconnect.dismissed:${taskId}`;
  const [dismissed, setDismissed] = React.useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  });
  const pending = actions.filter((action) => !dismissed.has(actionKey(action)));

  function dismiss(action: TaskConnectorReconnect) {
    const next = new Set(dismissed).add(actionKey(action));
    setDismissed(next);
    try { window.sessionStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Storage is optional. */ }
  }

  React.useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const next = await client.taskConnectorReconnects(taskId, abort.signal);
        if (!abort.signal.aborted) setActions(next);
      } finally { inFlight = false; }
    };
    const refresh = () => void load().catch(() => undefined);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const pageShown = () => { setBusy(null); refresh(); };
    const timer = active || pending.length > 0 ? window.setInterval(refreshWhenVisible, 3_000) : undefined;
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", pageShown);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", pageShown);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [client, taskId, active, pending.length]);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get("connector_error");
    if (error) toast.error(error);
    if (url.searchParams.get("connected") === "true") toast.success("Connector reconnected. You can continue in this task.");
    if (!error && !url.searchParams.has("connected")) return;
    for (const key of ["connector_error", "connected", "connector"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  }, [taskId]);

  async function reconnect(action: TaskConnectorReconnect) {
    setBusy(action.connectorId);
    try {
      const flow = await client.startConnectorOAuth(action.connectorId, action.accessLevel ?? "full", "/settings/mcp", taskId);
      window.location.assign(flow.authorizationUrl);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Couldn't start sign-in. Try again.");
      const next = await client.taskConnectorReconnects(taskId).catch(() => null);
      if (next) setActions(next);
      setBusy(null);
    }
  }

  return pending.map((action) => (
    <article key={actionKey(action)} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-[var(--berry-card-bg)] px-3 py-2.5" data-testid="mcp-reconnect-card">
      <div className="flex min-w-0 items-center gap-3">
        <ConnectorMark connectorKey={action.connectorKey ?? ""} className="size-5 shrink-0 object-contain text-muted-foreground" />
        <div className="min-w-0" role="status">
          <p className="text-sm font-medium">Reconnect {action.name}</p>
          <p className="text-xs text-muted-foreground">{action.canReconnect ? "Sign in again to use this connector in the chat." : "Ask an organization administrator to reconnect this server."}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy === action.connectorId} aria-label={`Cancel reconnect for ${action.name}`} onClick={() => dismiss(action)}>Cancel</Button>
        {action.canReconnect ? (
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} aria-label={`Reconnect ${action.name}`} onClick={() => void reconnect(action)}>
            {busy === action.connectorId ? "Opening sign-in…" : "Reconnect"}
          </Button>
        ) : null}
      </div>
    </article>
  ));
}

function actionKey(action: TaskConnectorReconnect): string {
  return `${action.connectorId}:${action.runId}`;
}
