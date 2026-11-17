import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { TaskConnectorReconnect } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { toast } from "sonner";

export function TaskConnectorReconnects({ client, taskId, active }: { client: BerryApiClient; taskId: string; active: boolean }) {
  const [actions, setActions] = React.useState<TaskConnectorReconnect[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

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
    const timer = active || actions.length > 0 ? window.setInterval(refreshWhenVisible, 3_000) : undefined;
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
  }, [client, taskId, active, actions.length]);

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
      const flow = await client.startConnectorOAuth(action.connectorId, "full", "/settings/mcp", taskId);
      window.location.assign(flow.authorizationUrl);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Couldn't start sign-in. Try again.");
      const next = await client.taskConnectorReconnects(taskId).catch(() => null);
      if (next) setActions(next);
      setBusy(null);
    }
  }

  return actions.map((action) => (
    <div className="berry-task-connector-card" role="status" key={action.connectorId}>
      <p className="min-w-0 text-sm">{action.canReconnect ? `Reconnect ${action.name} to continue.` : `Ask an organization administrator to reconnect ${action.name}.`}</p>
      {action.canReconnect ? <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`Reconnect ${action.name}`} onClick={() => void reconnect(action)}>{busy === action.connectorId ? "Opening sign-in…" : "Reconnect"}</Button> : null}
    </div>
  ));
}
