import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { ContextStats, TaskTokenUsage } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularProgressIndicator } from "@berry/desktop-ui/components/ui/circular-progress-indicator";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";
import { Separator } from "@berry/desktop-ui/components/ui/separator";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";

export function ContextWindowRing({ stats, client, sessionId, working }: {
  stats: ContextStats | undefined;
  client: BerryApiClient | null;
  sessionId: string;
  working: boolean;
}) {
  const percent = stats?.percentUsed ?? null;
  const usedPercent = formatContextPercent(percent);
  const summary = usedPercent !== null ? `${usedPercent}% of active context used` : "Calculating active context usage";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Context details: ${summary}`} className="berry-context-ring" data-context-state={stats?.thresholdState ?? "unknown"}>
          <CircularProgressIndicator
            value={percent ?? 0} size={20} strokeWidth={2.4}
            label="Active context usage" trackClassName="opacity-30"
            formatValueText={(percentage) => `${Math.round(percentage)}% of context used`}
            aria-busy={!stats} title={undefined}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={9} collisionPadding={12} className="berry-context-details" aria-label="Context details">
        <PopoverHeader>
          <PopoverTitle>Context details</PopoverTitle>
          <PopoverDescription>Active context and task token usage</PopoverDescription>
        </PopoverHeader>
        <section className="berry-context-details-section" aria-label="Active context">
          <div className="berry-context-details-row">
            <span>Active context</span>
            <strong>{usedPercent === null ? "—" : `${usedPercent}%`}</strong>
          </div>
          {stats ? (
            <p className="berry-context-details-caption">
              {formatContextTokens(stats.usedTokens)}{stats.contextWindow ? ` / ${formatContextTokens(stats.contextWindow)}` : ""} tokens used
              {stats.tokensLeft !== null ? ` · ${formatContextTokens(stats.tokensLeft)} left` : ""}
            </p>
          ) : <p className="berry-context-details-caption">Calculating context usage…</p>}
        </section>
        <Separator />
        <TaskTokenDetails client={client} sessionId={sessionId} working={working} />
      </PopoverContent>
    </Popover>
  );
}

export function useTaskTokenUsage(client: BerryApiClient | null, sessionId: string, working: boolean) {
  const [result, setResult] = React.useState<{ client: BerryApiClient; sessionId: string; usage: TaskTokenUsage }>();
  const [failed, setFailed] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(() => {
    if (!client) return;
    setFailed(false);
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const usage = await client.taskTokenUsage(sessionId, { signal: controller.signal });
        if (!disposed) {
          setResult({ client, sessionId, usage });
          setFailed(false);
        }
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), working ? 5_000 : 15_000);
    const onVisible = () => void load();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, sessionId, working, refresh]);
  return {
    usage: result?.client === client && result.sessionId === sessionId ? result.usage : undefined,
    failed: !client || failed,
    retry: () => setRefresh((value) => value + 1),
  };
}

function TaskTokenDetails({ client, sessionId, working }: { client: BerryApiClient | null; sessionId: string; working: boolean }) {
  const { usage, failed, retry } = useTaskTokenUsage(client, sessionId, working);
  return (
    <section className="berry-context-details-section" aria-label="Task token usage">
      <div className="berry-context-details-heading">
        <h3>Token usage</h3>
        <span className="berry-context-details-caption">Across the whole task</span>
      </div>
      {usage ? (
        <>
          <dl className="berry-context-details-metrics">
            <div className="berry-context-details-row berry-context-details-total"><dt>Total tokens</dt><dd>{formatTaskTokens(usage.totalTokens)}</dd></div>
            <div className="berry-context-details-row"><dt>Cache hit rate</dt><dd>{formatCacheHitRate(usage.cacheHitRate)}</dd></div>
            <div className="berry-context-details-row"><dt>Uncached input</dt><dd>{formatTaskTokens(usage.uncachedInputTokens)}</dd></div>
            <div className="berry-context-details-row"><dt>Cached input</dt><dd>{formatTaskTokens(usage.cachedInputTokens)}</dd></div>
            <div className="berry-context-details-row"><dt>Output</dt><dd>{formatTaskTokens(usage.outputTokens)}</dd></div>
          </dl>
        </>
      ) : !failed ? (
        <div className="berry-context-details-loading" role="status" aria-label="Loading task token usage">
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-3 w-full" />)}
        </div>
      ) : null}
      {failed ? (
        <div className="berry-context-details-error" role="status">
          <span>{usage ? "Could not refresh usage." : "Token usage is unavailable."}</span>
          {client ? <Button type="button" variant="ghost" size="sm" onClick={retry}>Retry</Button> : null}
        </div>
      ) : null}
    </section>
  );
}

const tokenFormatter = new Intl.NumberFormat("en-US");
export function formatTaskTokens(tokens: number): string { return tokenFormatter.format(tokens); }
export function formatCacheHitRate(rate: number | null): string {
  if (rate === null) return "—";
  if (rate > 0 && rate < 0.001) return "<0.1%";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(rate * 100)}%`;
}
function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}
function formatContextPercent(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent > 0 && percent < 10) return percent.toFixed(1);
  return String(Math.round(percent));
}
