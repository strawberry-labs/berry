import * as React from "react";
import { Download } from "lucide-react";
import type { AllowanceBalance, UsageAnalytics, UsageRequestPage, UsageRequestSummary } from "@berry/shared";

import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementPage,
  Meter,
  MetricGrid,
  Num,
  Section,
  StatusPill,
  formatCompact,
  formatCompactMoney,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  type MetricItem,
} from "./management-primitives";
import { DualTrend, ShareDonut, aggregateModelSpendRows } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";
import { PersonalUsageSkeleton } from "./management-screen-skeletons";
import { InfiniteScrollTrigger } from "../infinite-scroll-trigger";

export type PromptCacheSummary = { eligibleRequests: number; hits: number; misses: number; hitRate: number | null };

type RangeKey = "1h" | "1d" | "1w" | "1mo" | "3mo" | "1y" | "all" | "custom";

const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: "1h", label: "Past hour" },
  { value: "1d", label: "Past day" }, { value: "1w", label: "Past week" },
  { value: "1mo", label: "Past month" }, { value: "3mo", label: "Past 3 months" },
  { value: "1y", label: "Past year" }, { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

const RANGE_MS: Partial<Record<RangeKey, number>> = {
  "1h": 3_600_000,
  "1d": 86_400_000, "1w": 7 * 86_400_000, "1mo": 30 * 86_400_000,
  "3mo": 90 * 86_400_000, "1y": 365 * 86_400_000,
};

export function summarizePromptCache(requests: readonly UsageRequestSummary[]): PromptCacheSummary {
  const eligible = requests.filter((request) => request.cacheEligible);
  const hits = eligible.filter((request) => request.cacheReadTokens > 0).length;
  return { eligibleRequests: eligible.length, hits, misses: Math.max(0, eligible.length - hits), hitRate: eligible.length ? hits / eligible.length : null };
}

function emptyAnalytics(tenantId: string, from: string, to: string): UsageAnalytics {
  return {
    tenantId, from, to,
    totals: { billedCostMicros: "0", requests: 0, tokens: 0, inputTokens: 0, outputTokens: 0, successRate: null, projectedMonthEndMicros: null },
    series: [], breakdowns: { models: [] },
    performance: { latencyP50Ms: null, latencyP95Ms: null, ttftP50Ms: null, ttftP95Ms: null, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheEligibleRequests: 0, cacheHitRequests: 0, sandboxMinutes: 0 },
    anomalies: [], unavailableDimensions: [],
  };
}

export function PersonalUsageScreen({ client, tenantId }: ManagementScreenProps) {
  const [rangeKey, setRangeKey] = React.useState<RangeKey>("1mo");
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const [customFrom, setCustomFrom] = React.useState(() => localDateTime(new Date(Date.now() - 7 * 86_400_000)));
  const [customTo, setCustomTo] = React.useState(() => localDateTime(new Date()));
  const range = React.useMemo(() => selectedRange(rangeKey, anchor, customFrom, customTo), [anchor, customFrom, customTo, rangeKey]);
  const resource = useResource(
    `my-usage:${tenantId}:${range.from}:${range.to}`,
    async () => {
      if (!client) return { analytics: emptyAnalytics(tenantId, range.from, range.to), requests: emptyRequestPage() };
      const [analytics, requests] = await Promise.all([
        client.myUsage(tenantId, { ...range, limit: 50 }),
        client.myUsageRequests(tenantId, { ...range, limit: 50 }),
      ]);
      return { analytics, requests };
    },
    { analytics: emptyAnalytics(tenantId, range.from, range.to), requests: emptyRequestPage() },
  );
  // The allowance follows the billing cycle, not the selected range, and must
  // never block the statement if it cannot be read.
  const allowance = useResource<AllowanceBalance | null>(
    `my-allowance:${tenantId}`,
    async (signal) => client ? client.myAllowanceBalance(tenantId, signal ? { signal } : {}).catch(() => null) : null,
    null,
  );
  const [requests, setRequests] = React.useState<UsageRequestPage>(resource.data.requests);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [loadMoreError, setLoadMoreError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setRequests(resource.data.requests);
    setLoadMoreError(null);
  }, [resource.data.requests]);
  const analytics = resource.data.analytics;
  const totals = analytics.totals;
  const performance = analytics.performance;
  const series = analytics.series;
  const models = [...(analytics.breakdowns.models ?? [])].sort((left, right) => Number(right.billedCostMicros) - Number(left.billedCostMicros));
  const totalTokens = totals.tokens || totals.inputTokens + totals.outputTokens;
  const failures = series.reduce((sum, point) => sum + point.failures, 0);
  const customInvalid = rangeKey === "custom" && !(new Date(customFrom).getTime() < new Date(customTo).getTime());

  const changeRange = (value: string) => {
    setRangeKey(value as RangeKey);
    setAnchor(Date.now());
  };

  const loadMore = async () => {
    if (!client || !requests.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await client.myUsageRequests(tenantId, { ...range, cursor: requests.nextCursor, limit: 50 });
      setRequests((current) => ({ ...page, items: [...current.items, ...page.items] }));
    } catch {
      setLoadMoreError("Older requests could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  const balance = allowance.data;
  const limited = balance && balance.effectiveLimitMicros !== null;
  const metrics: MetricItem[] = [
    {
      label: "Spend",
      value: formatCompactMoney(totals.billedCostMicros),
      exactValue: exactMoney(totals.billedCostMicros),
      trend: series.map((point) => Number(point.billedCostMicros) / 1_000_000),
      hint: totals.projectedMonthEndMicros ? `Projected ${formatCompactMoney(totals.projectedMonthEndMicros)} by month end` : rangeLabel(rangeKey),
    },
    ...(balance ? [limited ? {
      label: "Allowance left",
      value: formatCompactMoney(balance.availableMicros ?? "0"),
      exactValue: exactMoney(balance.availableMicros ?? "0"),
      hint: `of ${formatCompactMoney(balance.effectiveLimitMicros)} · resets ${formatDate(balance.cycleEnd)}`,
      ...(balance.status === "blocked" ? { status: "danger" as const } : balance.status === "warning" ? { status: "warning" as const } : {}),
    } : {
      label: "Allowance",
      value: "No limit",
      hint: `${formatCompactMoney(balance.usedMicros)} used this cycle · resets ${formatDate(balance.cycleEnd)}`,
    }] : []),
    {
      label: "Tokens",
      value: formatCompact(totalTokens),
      exactValue: formatNumber(totalTokens),
      trend: series.map((point) => point.tokens),
      hint: `${formatCompact(totals.inputTokens)} in · ${formatCompact(totals.outputTokens)} out`,
    },
    {
      label: "Requests",
      value: formatCompact(totals.requests),
      exactValue: formatNumber(totals.requests),
      trend: series.map((point) => point.requests),
      hint: totals.successRate === null ? "No completed requests yet" : `${formatPercent(totals.successRate)} succeeded${failures ? ` · ${formatNumber(failures)} failed` : ""}`,
      ...(totals.successRate !== null && totals.successRate < 0.95 ? { status: "warning" as const } : {}),
    },
  ];

  return <ManagementPage width="wide" title="Usage" description="Your own spend, tokens and requests, and how much of your allowance is left." actions={<>
    <div className="w-44"><FormSelect ariaLabel="Period" value={rangeKey} onChange={changeRange} options={RANGE_OPTIONS} /></div>
    <Button variant="secondary" disabled={!client} onClick={() => { void client?.exportMyUsageCsv(tenantId, range).then((csv) => downloadCsv(csv, "usage.csv")); }}><Download />Export CSV</Button>
  </>}>
    {rangeKey === "custom" ? <div className="grid gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:w-56">From<Input type="datetime-local" value={customFrom} max={customTo} onChange={(event) => setCustomFrom(event.currentTarget.value)} /></label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:w-56">To<Input type="datetime-local" value={customTo} min={customFrom} onChange={(event) => setCustomTo(event.currentTarget.value)} /></label>
      </div>
      {customInvalid ? <InlineNotice tone="warning">The start must be before the end. Showing the past month until the range is valid.</InlineNotice> : null}
    </div> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} skeleton={<PersonalUsageSkeleton />}>
      <MetricGrid items={metrics} />
      {balance?.status === "blocked" ? <InlineNotice tone="danger" title="You have used your allowance for this cycle">
        New requests are blocked until it resets on {formatDate(balance.cycleEnd)}. Ask an organization administrator if you need more before then.
      </InlineNotice> : null}
      {balance && limited ? <Section>
        <Meter
          value={Number(balance.usedMicros) + Number(balance.reservedMicros)}
          max={Number(balance.effectiveLimitMicros)}
          label={<>Allowance this cycle: <span title={exactMoney(balance.usedMicros)}>{formatCompactMoney(balance.usedMicros)}</span> used of {formatCompactMoney(balance.effectiveLimitMicros)}{Number(balance.reservedMicros) > 0 ? ` · ${formatCompactMoney(balance.reservedMicros)} held for running tasks` : ""}</>}
          detail={`${formatDate(balance.cycleStart)} – ${formatDate(balance.cycleEnd)}`}
        />
      </Section> : null}
      {totals.requests === 0 ? <EmptyPanel title="No usage in this period" description="Requests you make in Berry appear here. Try a longer period to see earlier activity." /> : <>
        <Section title="Spend and requests" description={`${rangeLabel(rangeKey)}.`}>
          <DualTrend label="Spend" points={series.map((point) => ({ label: point.ts, spend: Number(point.billedCostMicros) / 1_000_000, requests: point.requests }))} spendFormat={(value) => formatMoney(value * 1_000_000)} />
        </Section>
        <div className="grid gap-5 xl:grid-cols-2">
          <Section title="Spend by model">
            <ShareDonut caption="Spend by model" centerLabel="Spend" rows={aggregateModelSpendRows(models.map((item) => ({ label: item.label, value: Number(item.billedCostMicros) / 1_000_000 })), 6)} format={(value) => formatCompactMoney(value * 1_000_000)} />
          </Section>
          <Section title="Tokens by type" description="Cache reads reuse earlier context and cost a fraction of fresh input.">
            <ShareDonut caption="Tokens by type" centerLabel="Tokens" format={formatCompact} rows={[
              { label: "Fresh input", value: Math.max(0, totals.inputTokens - performance.cacheReadTokens) },
              { label: "Cache read", value: performance.cacheReadTokens },
              { label: "Output", value: totals.outputTokens },
              { label: "Cache write", value: performance.cacheWriteTokens },
            ].filter((row) => row.value > 0)} />
          </Section>
        </div>
        {models.length ? <Section title="Models" description="What each model you used cost in this period." flush>
          <DataTable label="Model usage" columns={["Model", "Spend", "Requests", "Input tokens", "Output tokens", "Cache-read tokens"]} rows={models.map((item) => [
            <CellStack primary={item.label} />,
            <Num value={item.billedCostMicros} kind="money" />,
            <Num value={item.requests} />,
            <Num value={item.inputTokens} />,
            <Num value={item.outputTokens} />,
            <Num value={item.cacheReadTokens} />,
          ])} />
        </Section> : null}
        <Section title="Recent requests" description="Each model request you made in this period, newest first." flush>
          {requests.items.length ? <>
            <DataTable label="Recent requests" initialPageSize={20} columns={["Time", "Model", "Input", "Output", "Cache read", "Cost", "Result"]} rows={requests.items.map((request) => [
              <span data-sort={new Date(request.ts).getTime()} className="whitespace-nowrap">{formatDateTime(request.ts)}</span>,
              <CellStack primary={request.model ?? request.provider ?? "Unknown model"} secondary={request.model ? request.provider ?? undefined : undefined} />,
              <Num value={request.tokensIn} />,
              <Num value={request.tokensOut} />,
              <Num value={request.cacheReadTokens} />,
              <Num value={request.billedCostMicros} kind="money" />,
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <StatusPill tone={successTone(request.status)}>{humanize(request.status)}</StatusPill>
                {request.finishReason && !ROUTINE_FINISH_REASONS.has(request.finishReason) ? <span className="text-xs text-muted-foreground">{humanize(request.finishReason)}</span> : null}
              </span>,
            ])} />
            <InfiniteScrollTrigger className="border-t border-border" hasMore={Boolean(client && requests.hasMore && requests.nextCursor)} loading={loadingMore} error={loadMoreError} onLoadMore={() => void loadMore()} />
          </> : <p className="px-4 py-3.5 text-xs text-muted-foreground">No individual requests are recorded for this period.</p>}
        </Section>
      </>}
    </AsyncState>
  </ManagementPage>;
}

const ROUTINE_FINISH_REASONS = new Set(["stop", "end_turn", "completed", "success"]);

function exactMoney(micros: string | number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(micros) / 1_000_000);
}

function humanize(value: string): string {
  const text = value.replace(/[_\-.]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

function emptyRequestPage(): UsageRequestPage { return { items: [], nextCursor: null, hasMore: false }; }

function selectedRange(key: RangeKey, anchor: number, customFrom: string, customTo: string) {
  if (key === "custom") {
    const from = new Date(customFrom).getTime();
    const to = new Date(customTo).getTime();
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  const to = new Date(anchor);
  const from = key === "all" ? new Date(0) : new Date(anchor - (RANGE_MS[key] ?? 30 * 86_400_000));
  return { from: from.toISOString(), to: to.toISOString() };
}

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function rangeLabel(key: RangeKey): string {
  return RANGE_OPTIONS.find((option) => option.value === key)?.label ?? "Selected period";
}

function successTone(status: string): "good" | "danger" | "neutral" {
  if (["completed", "success", "succeeded"].includes(status)) return "good";
  if (["failed", "error", "cancelled"].includes(status)) return "danger";
  return "neutral";
}

function downloadCsv(value: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([value], { type: "text/csv" }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}
