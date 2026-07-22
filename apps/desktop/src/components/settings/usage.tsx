import { lazy, Suspense, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UsageEvent } from "@berry/shared";
import { ChartColumn, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Card } from "@berry/desktop-ui/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Progress } from "@berry/desktop-ui/components/ui/progress";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@berry/desktop-ui/components/ui/tooltip";
import { cn } from "@berry/desktop-ui/lib/utils";
import { host } from "@/lib/berry";
import { formatCount, formatFullDay, formatTokens, SettingsPageHeader } from "./shared";

const USAGE_KEY = ["usage", "summary"] as const;
const USAGE_EVENTS_KEY = ["usage", "events"] as const;

interface UsageDay {
  date: string;
  tokens: number;
  turns: number;
}

interface UsageModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

interface UsageTool {
  name: string;
  calls: number;
}

interface UsageSummary {
  days: UsageDay[];
  models: UsageModel[];
  tools: UsageTool[];
}

const DailyTokensChart = lazy(() => import("./usage-recharts").then((module) => ({ default: module.DailyTokensChart })));

/* ------------------------------------------------------------------ */
/* Stat tiles                                                          */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card className="gap-1 rounded-xl border-border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Activity heatmap: 13 columns x 7 rows, sequential single hue        */
/* ------------------------------------------------------------------ */

const HEATMAP_CELLS = 13 * 7;
const HEATMAP_LEVELS = ["bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"] as const;

function heatmapLevel(tokens: number, max: number): string {
  if (tokens <= 0 || max <= 0) return "bg-muted";
  const level = Math.min(HEATMAP_LEVELS.length - 1, Math.floor((tokens / max) * HEATMAP_LEVELS.length));
  return HEATMAP_LEVELS[level] ?? "bg-primary";
}

function ActivityHeatmap({ days }: { days: UsageDay[] }) {
  const cells = useMemo<(UsageDay | null)[]>(() => {
    const recent = days.slice(-HEATMAP_CELLS);
    const padding = Array.from({ length: Math.max(0, HEATMAP_CELLS - recent.length) }, () => null);
    return [...padding, ...recent];
  }, [days]);
  const max = useMemo(() => Math.max(0, ...days.map((day) => day.tokens)), [days]);

  return (
    <Card className="gap-4 rounded-xl border-border p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium">Activity</h2>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Less
          <span className="size-2.5 rounded-[3px] bg-muted" aria-hidden />
          {HEATMAP_LEVELS.map((level) => (
            <span key={level} className={cn("size-2.5 rounded-[3px]", level)} aria-hidden />
          ))}
          More
        </div>
      </div>
      <TooltipProvider delayDuration={150}>
        <div className="grid w-fit grid-flow-col grid-rows-7 gap-1" aria-label="Daily token activity for the last 90 days">
          {cells.map((day, index) =>
            day === null ? (
              <span key={`pad-${index}`} className="size-3 rounded-[3px] bg-transparent" aria-hidden />
            ) : (
              <Tooltip key={day.date}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "size-3 rounded-[3px] transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      heatmapLevel(day.tokens, max),
                    )}
                    aria-label={`${formatCount(day.tokens)} tokens on ${formatFullDay(day.date)}`}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {formatCount(day.tokens)} tokens · {formatFullDay(day.date)}
                </TooltipContent>
              </Tooltip>
            ),
          )}
        </div>
      </TooltipProvider>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Per-model and per-tool lists                                        */
/* ------------------------------------------------------------------ */

function ModelUsageList({ models }: { models: UsageModel[] }) {
  const rows = useMemo(
    () =>
      [...models]
        .map((model) => ({ ...model, total: model.inputTokens + model.outputTokens }))
        .sort((a, b) => b.total - a.total),
    [models],
  );
  const max = Math.max(1, ...rows.map((row) => row.total));

  return (
    <Card className="gap-4 rounded-xl border-border p-4">
      <h2 className="text-sm font-medium">Tokens by model</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.model} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-4">
                <span className="truncate font-mono text-xs">{row.model}</span>
                <span className="shrink-0 text-sm font-medium tabular-nums">{formatTokens(row.total)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: `${Math.max(2, (row.total / max) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out ·{" "}
                {formatCount(row.requests)} requests
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ToolUsageList({ tools }: { tools: UsageTool[] }) {
  const rows = useMemo(() => [...tools].sort((a, b) => b.calls - a.calls), [tools]);
  const max = Math.max(1, ...rows.map((row) => row.calls));

  return (
    <Card className="gap-4 rounded-xl border-border p-4">
      <h2 className="text-sm font-medium">Tool usage</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tool calls yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.name} className="flex items-center gap-4">
              <span className="w-40 truncate font-mono text-xs">{row.name}</span>
              <Progress value={(row.calls / max) * 100} className="h-1.5 flex-1" aria-hidden />
              <span className="w-14 shrink-0 text-right text-sm tabular-nums">{formatCount(row.calls)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UsageEventList({ events }: { events: UsageEvent[] }) {
  return (
    <Card className="gap-4 rounded-xl border-border p-4">
      <h2 className="text-sm font-medium">Recent events</h2>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No detailed usage events yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((event) => (
            <li key={event.id} className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{event.type}</span>
              <span className="min-w-0">
                <span className="block truncate">{event.name}</span>
                {routerServedBy(event) ? (
                  <span className="block truncate text-xs text-muted-foreground">served by {routerServedBy(event)}</span>
                ) : null}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function routerServedBy(event: UsageEvent): string | null {
  if (typeof event.value !== "object" || event.value === null || Array.isArray(event.value)) return null;
  const value = event.value as Record<string, unknown>;
  const provider = typeof value.servedProvider === "string" ? value.servedProvider : null;
  const model = typeof value.servedModel === "string" ? value.servedModel : null;
  if (provider && model) return `${provider} · ${model}`;
  return model ?? provider;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}

export function UsageSettings() {
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: USAGE_KEY,
    queryFn: () => host.call<UsageSummary>("usage.summary"),
  });
  const events = useQuery({
    queryKey: USAGE_EVENTS_KEY,
    queryFn: () => host.call<UsageEvent[]>("usage.events", { limit: 50 }),
  });

  const totals = useMemo(() => {
    const days = summary.data?.days ?? [];
    return {
      tokens: days.reduce((sum, day) => sum + day.tokens, 0),
      turns: days.reduce((sum, day) => sum + day.turns, 0),
      models: summary.data?.models.length ?? 0,
    };
  }, [summary.data]);
  const refreshUsage = () => {
    void queryClient.invalidateQueries({ queryKey: USAGE_KEY });
    void queryClient.invalidateQueries({ queryKey: USAGE_EVENTS_KEY });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Usage"
        description="Local activity across the last 90 days. Usage is tracked on this machine only."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={refreshUsage}
          >
            <RefreshCw className={cn(summary.isFetching && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {summary.isPending ? (
        <UsageSkeleton />
      ) : summary.isError ? (
        <Empty className="border border-dashed border-border py-10 md:p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartColumn />
            </EmptyMedia>
            <EmptyTitle className="text-sm">Usage unavailable</EmptyTitle>
            <EmptyDescription>Berry could not load the local usage summary.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => void summary.refetch()}>
              Try again
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <StatCard label="Total tokens" value={formatTokens(totals.tokens)} detail="Last 90 days" />
            <StatCard label="Turns" value={formatCount(totals.turns)} detail="Last 90 days" />
            <StatCard label="Models used" value={formatCount(totals.models)} detail="Across all providers" />
          </div>
          <ActivityHeatmap days={summary.data.days} />
          <Suspense fallback={<Skeleton className="h-[18.5rem] rounded-xl" />}>
            <DailyTokensChart days={summary.data.days} />
          </Suspense>
          <ModelUsageList models={summary.data.models} />
          <ToolUsageList tools={summary.data.tools} />
          <UsageEventList events={events.data ?? []} />
        </>
      )}
    </div>
  );
}
