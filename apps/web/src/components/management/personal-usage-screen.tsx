import * as React from "react";
import { Download, RefreshCw } from "lucide-react";
import type { AllowanceBalance, UsageAnalytics, UsageRequestSummary } from "@berry/shared";

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
  formatMoneyWithCents,
  formatNumber,
  formatPercent,
  type MetricItem,
} from "./management-primitives";
import { DualTrend, ShareDonut, aggregateModelSpendRows } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";
import { PersonalUsageSkeleton } from "./management-screen-skeletons";
import { InfiniteScrollTrigger } from "../infinite-scroll-trigger";
import { downloadUsageCsv, usageReportBounds, usageRangeForPreset, usageTokenBreakdown } from "./usage-controls";
import { useUsageRequestPages } from "./usage-request-pages";

export type PromptCacheSummary = { eligibleRequests: number; hits: number; misses: number; hitRate: number | null };

type RangeKey = "month-to-date" | "allowance-cycle" | "1h" | "1d" | "1w" | "1mo" | "3mo" | "1y" | "all" | "custom";

const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: "month-to-date", label: "Month to date (UTC)" },
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
  const [rangeKey, setRangeKey] = React.useState<RangeKey>("month-to-date");
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const [customFrom, setCustomFrom] = React.useState(() => localDateTime(new Date(Date.now() - 7 * 86_400_000)));
  const [customTo, setCustomTo] = React.useState(() => localDateTime(new Date()));
  const [exportError, setExportError] = React.useState("");
  const [exporting, setExporting] = React.useState(false);
  const allowance = useResource<AllowanceBalance | null>(
    "my-allowance:" + tenantId,
    async (signal) => client ? client.myAllowanceBalance(tenantId, signal ? { signal } : {}) : null,
    null,
  );
  const balance = allowance.data;
  const selectedKey = rangeKey === "allowance-cycle" && !balance ? "month-to-date" : rangeKey;
  const range = React.useMemo(
    () => selectedRange(selectedKey, anchor, customFrom, customTo, balance),
    [selectedKey, anchor, customFrom, customTo, balance],
  );
  const query = { ...range, limit: 50 };
  const resource = useResource(
    "my-usage:" + tenantId + ':' + range.from + ':' + range.to,
    async (signal) => client
      ? client.myUsage(tenantId, query, signal ? { signal } : {})
      : emptyAnalytics(tenantId, range.from, range.to),
    emptyAnalytics(tenantId, range.from, range.to),
  );
  const { pages: requests, items: requestItems } = useUsageRequestPages(client, tenantId, "personal", query);
  const analytics = resource.data;
  const totals = analytics.totals;
  const performance = analytics.performance;
  const series = analytics.series;
  const models = [...(analytics.breakdowns.models ?? [])].sort((left, right) => Number(right.billedCostMicros) - Number(left.billedCostMicros));
  const totalTokens = totals.tokens || totals.inputTokens + totals.outputTokens;
  const failures = series.reduce((sum, point) => sum + point.failures, 0);
  const customInvalid = rangeKey === "custom" && !(new Date(customFrom).getTime() < new Date(customTo).getTime());

  const refresh = () => {
    setAnchor(Date.now());
    allowance.retry();
    if (selectedKey === "custom") {
      resource.retry();
      void requests.refetch();
    }
  };
  const changeRange = (value: string) => {
    setRangeKey(value as RangeKey);
    setAnchor(Date.now());
    setExportError("");
  };
  const exportCsv = async () => {
    if (!client) return;
    setExportError("");
    setExporting(true);
    try {
      downloadUsageCsv(await client.exportMyUsageCsv(tenantId, range), "usage.csv");
    } catch {
      setExportError("Usage could not be exported. Try again.");
    } finally {
      setExporting(false);
    }
  };

  const limited = balance && balance.effectiveLimitMicros !== null;
  const metrics: MetricItem[] = [
    {
      label: "Billed spend",
      value: formatMoneyWithCents(totals.billedCostMicros),
      trend: series.map((point) => Number(point.billedCostMicros) / 1_000_000),
      hint: selectedKey === "month-to-date" && totals.projectedMonthEndMicros ? `Projected ${formatCompactMoney(totals.projectedMonthEndMicros)} by month end` : rangeLabel(selectedKey),
    },
    ...(balance ? [limited ? {
      label: "Available allowance",
      value: formatMoneyWithCents(balance.availableMicros),
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
    <div className="w-48"><FormSelect ariaLabel="Period" value={selectedKey} onChange={changeRange} options={balance
      ? [RANGE_OPTIONS[0]!, { value: "allowance-cycle", label: "Current allowance cycle" }, ...RANGE_OPTIONS.slice(1)]
      : RANGE_OPTIONS} /></div>
    <Button variant="secondary" disabled={!client} onClick={refresh}><RefreshCw />Refresh</Button>
    <Button variant="secondary" disabled={!client || exporting || customInvalid} onClick={() => void exportCsv()}><Download />{exporting ? "Exporting…" : "Export CSV"}</Button>
  </>}>
    {exportError ? <InlineNotice tone="warning">{exportError}</InlineNotice> : null}
    {allowance.error ? <AsyncState loading={false} error={allowance.error} onRetry={allowance.retry}>{null}</AsyncState> : null}
    {rangeKey === "custom" ? <div className="grid gap-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:w-56">From<Input type="datetime-local" value={customFrom} max={customTo} onChange={(event) => setCustomFrom(event.currentTarget.value)} /></label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:w-56">To<Input type="datetime-local" value={customTo} min={customFrom} onChange={(event) => setCustomTo(event.currentTarget.value)} /></label>
      </div>
      {customInvalid ? <InlineNotice tone="warning">The start must be before the end. Showing month to date until the range is valid.</InlineNotice> : null}
    </div> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} skeleton={<PersonalUsageSkeleton />}>
      <MetricGrid items={metrics} />
      {balance?.status === "blocked" ? <InlineNotice tone="danger" title="Your available allowance is exhausted">
        New requests are blocked until it resets on {formatDate(balance.cycleEnd)}. Ask an organization administrator if you need more before then.
      </InlineNotice> : null}
      {balance && limited ? <Section title="Current allowance cycle" description={formatDateTime(balance.cycleStart) + " – " + formatDateTime(balance.cycleEnd)}>
        <Meter
          value={Number(balance.usedMicros) + Number(balance.reservedMicros)}
          max={Number(balance.effectiveLimitMicros)}
          label={<>{formatMoneyWithCents(balance.usedMicros)} settled · {formatMoneyWithCents(balance.reservedMicros)} reserved · {formatMoneyWithCents(balance.availableMicros)} available</>}
          detail={formatMoneyWithCents(balance.effectiveLimitMicros) + " limit"}
        />
      </Section> : null}
      {totals.requests === 0 ? <EmptyPanel title="No usage in this period" description="Requests you make in Berry appear here. Try a longer period to see earlier activity." /> : <>
        <Section title="Spend and requests" description={formatDateTime(range.from) + " – " + formatDateTime(range.to)}>
          <DualTrend label="Spend" points={series.map((point) => ({ label: point.ts, spend: Number(point.billedCostMicros) / 1_000_000, requests: point.requests }))} spendFormat={(value) => formatMoneyWithCents(value * 1_000_000)} />
        </Section>
        <div className="grid gap-5 xl:grid-cols-2">
          <Section title="Spend by model">
            <ShareDonut caption="Spend by model" centerLabel="Spend" rows={aggregateModelSpendRows(models.map((item) => ({ label: item.label, value: Number(item.billedCostMicros) / 1_000_000 })), 6)} format={(value) => formatCompactMoney(value * 1_000_000)} />
          </Section>
          <Section title="Tokens by type" description="Cache reads reuse earlier context and cost a fraction of fresh input.">
            <ShareDonut caption="Tokens by type" centerLabel="Tokens" format={formatCompact} rows={usageTokenBreakdown(totals.inputTokens, totals.outputTokens, performance.cacheReadTokens, performance.cacheWriteTokens)} />
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
        <Section title="Recent requests" description="Usage recorded in this period, newest first." flush>
          <AsyncState
            loading={requests.isLoading}
            error={requests.error && !requests.isFetchNextPageError ? "Requests could not be loaded." : null}
            onRetry={() => void requests.refetch()}
            empty={!requestItems.length}
            emptyTitle="No individual requests"
          >
            <DataTable label="Recent requests" initialPageSize={20} columns={["Time", "Model", "Input", "Output", "Cache read", "Cost", "Result"]} rows={requestItems.map((request) => [
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
            <InfiniteScrollTrigger
              className="border-t border-border"
              autoLoad={false}
              hasMore={requests.hasNextPage}
              loading={requests.isFetchingNextPage}
              error={requests.isFetchNextPageError ? "Older requests could not be loaded." : null}
              onLoadMore={() => void requests.fetchNextPage({ cancelRefetch: false })}
            />
          </AsyncState>
        </Section>
      </>}
    </AsyncState>
  </ManagementPage>;
}

const ROUTINE_FINISH_REASONS = new Set(["stop", "end_turn", "completed", "success"]);

function humanize(value: string): string {
  const text = value.replace(/[_\-.]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

export function selectedRange(key: RangeKey, anchor: number, customFrom: string, customTo: string, balance: Pick<AllowanceBalance, "cycleStart" | "cycleEnd"> | null) {
  if (key === "allowance-cycle" && balance) {
    const end = Math.min(anchor, Date.parse(balance.cycleEnd));
    return { from: balance.cycleStart, to: new Date(Math.max(Date.parse(balance.cycleStart), end)).toISOString() };
  }
  if (key === "custom") {
    const from = new Date(customFrom).getTime();
    const to = new Date(customTo).getTime();
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  const to = new Date(anchor);
  if (key === "month-to-date" || key === "custom" || key === "allowance-cycle") {
    return usageReportBounds(usageRangeForPreset("month-to-date", to, undefined, "UTC"), to);
  }
  const from = key === "all" ? new Date(0) : new Date(anchor - (RANGE_MS[key] ?? 30 * 86_400_000));
  return { from: from.toISOString(), to: to.toISOString() };
}

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function rangeLabel(key: RangeKey): string {
  return key === "allowance-cycle" ? "Current allowance cycle"
    : RANGE_OPTIONS.find((option) => option.value === key)?.label ?? "Selected period";
}

function successTone(status: string): "good" | "danger" | "neutral" {
  if (["completed", "success", "succeeded"].includes(status)) return "good";
  if (["failed", "error", "cancelled"].includes(status)) return "danger";
  return "neutral";
}
