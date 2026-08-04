import * as React from "react";
import { ArrowDown, ArrowUp, CalendarRange, CreditCard, Database, Download, Gauge, List } from "lucide-react";
import type { UsageAnalytics, UsageRequestPage, UsageRequestSummary } from "@berry/shared";

import {
  AsyncState,
  Button,
  DataTable,
  FormSelect,
  Input,
  ManagementPage,
  MetricGrid,
  Section,
  StatusPill,
  formatMoney,
  formatNumber,
} from "./management-primitives";
import { DualTrend, ModelSpendRings, OutcomeBars } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

export type PromptCacheSummary = { eligibleRequests: number; hits: number; misses: number; hitRate: number | null };

type RangeKey = "15m" | "30m" | "1h" | "3h" | "1d" | "1w" | "1mo" | "3mo" | "1y" | "all" | "custom";

const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: "15m", label: "Past 15 minutes" }, { value: "30m", label: "Past 30 minutes" },
  { value: "1h", label: "Past hour" }, { value: "3h", label: "Past 3 hours" },
  { value: "1d", label: "Past day" }, { value: "1w", label: "Past week" },
  { value: "1mo", label: "Past month" }, { value: "3mo", label: "Past 3 months" },
  { value: "1y", label: "Past year" }, { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

const RANGE_MS: Partial<Record<RangeKey, number>> = {
  "15m": 15 * 60_000, "30m": 30 * 60_000, "1h": 3_600_000, "3h": 3 * 3_600_000,
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
  const [requests, setRequests] = React.useState<UsageRequestPage>(resource.data.requests);
  const [loadingMore, setLoadingMore] = React.useState(false);
  React.useEffect(() => setRequests(resource.data.requests), [resource.data.requests]);
  const cacheEligible = resource.data.analytics.performance.cacheEligibleRequests;
  const cacheHits = resource.data.analytics.performance.cacheHitRequests;
  const cache = { hits: cacheHits, misses: Math.max(0, cacheEligible - cacheHits), hitRate: cacheEligible ? cacheHits / cacheEligible : null };
  const models = resource.data.analytics.breakdowns.models ?? [];

  const changeRange = (value: string) => {
    setRangeKey(value as RangeKey);
    setAnchor(Date.now());
  };

  const loadMore = async () => {
    if (!client || !requests.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.myUsageRequests(tenantId, { ...range, cursor: requests.nextCursor, limit: 50 });
      setRequests((current) => ({ ...page, items: [...current.items, ...page.items] }));
    } finally {
      setLoadingMore(false);
    }
  };

  return <ManagementPage title="Usage" description="Understand your model activity, token consumption, and billed usage for any period." actions={<>
    <div className="w-48"><FormSelect value={rangeKey} onChange={changeRange} options={RANGE_OPTIONS} /></div>
    <Button variant="secondary" disabled={!client} onClick={() => { void client?.exportMyUsageCsv(tenantId, range).then((csv) => downloadCsv(csv, "usage.csv")); }}><Download />Export CSV</Button>
  </>}>
    {rangeKey === "custom" ? <Section title="Custom range">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">From<Input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.currentTarget.value)} /></label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">To<Input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.currentTarget.value)} /></label>
      </div>
    </Section> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      <MetricGrid compact items={[
        { label: "Billed usage", value: formatMoney(resource.data.analytics.totals.billedCostMicros), exactValue: formatMoney(resource.data.analytics.totals.billedCostMicros), icon: CreditCard },
        { label: "Requests", value: compactNumber(resource.data.analytics.totals.requests), exactValue: formatNumber(resource.data.analytics.totals.requests), icon: List },
        { label: "Cache hit rate", value: cache.hitRate === null ? "—" : `${Math.round(cache.hitRate * 100)}%`, hint: `${cache.hits} hits · ${cache.misses} misses`, icon: Gauge },
        { label: "Cache-read tokens", value: compactNumber(resource.data.analytics.performance.cacheReadTokens), exactValue: formatNumber(resource.data.analytics.performance.cacheReadTokens), icon: Database },
        { label: "Input tokens", value: compactNumber(resource.data.analytics.totals.inputTokens), exactValue: formatNumber(resource.data.analytics.totals.inputTokens), icon: ArrowDown },
        { label: "Output tokens", value: compactNumber(resource.data.analytics.totals.outputTokens), exactValue: formatNumber(resource.data.analytics.totals.outputTokens), icon: ArrowUp },
      ]} />
      <Section title="Usage over time" description={rangeLabel(rangeKey)}>
        <DualTrend label="Billed usage" points={resource.data.analytics.series.map((point) => ({ label: point.ts, spend: Number(point.billedCostMicros) / 1_000_000, requests: point.requests }))} spendFormat={(value) => formatMoney(value * 1_000_000)} />
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Request outcomes"><OutcomeBars points={resource.data.analytics.series.map((point) => ({ label: point.ts, successes: point.successes, failures: point.failures }))} /></Section>
        <Section title="Model spend distribution"><ModelSpendRings rows={models.map((item) => ({ label: item.label, value: Number(item.billedCostMicros) / 1_000_000 }))} format={(value) => formatMoney(value * 1_000_000)} /></Section>
      </div>
      <Section title="Models">
        <DataTable label="Model usage" columns={["Model", "Requests", "Input tokens", "Output tokens", "Cache-read tokens", "Billed usage"]} rows={models.map((item) => [
          item.label, formatNumber(item.requests), formatNumber(item.inputTokens), formatNumber(item.outputTokens), formatNumber(item.cacheReadTokens), formatMoney(item.billedCostMicros),
        ])} />
      </Section>
      <Section title="Logs" description="Request-level usage telemetry for the selected period.">
        {requests.items.length ? <>
          <DataTable label="Usage request logs" initialPageSize={20} columns={["Time", "Model", "Input", "Output", "Cache read", "Cache write", "Billed", "Finish reason"]} rows={requests.items.map((request) => [
            new Date(request.ts).toLocaleString(), request.model ?? request.provider ?? "—", formatNumber(request.tokensIn), formatNumber(request.tokensOut), formatNumber(request.cacheReadTokens), formatNumber(request.cacheWriteTokens), formatMoney(request.billedCostMicros),
            <StatusPill tone={successTone(request.status)}>{request.finishReason ?? request.status}</StatusPill>,
          ])} />
          {requests.hasMore ? <div className="mt-3 flex justify-center"><Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button></div> : null}
        </> : <p className="text-xs text-muted-foreground">No request logs are available for this period.</p>}
      </Section>
    </AsyncState>
  </ManagementPage>;
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

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
