import * as React from "react";
import { Download } from "lucide-react";
import type { UsageAnalytics, UsageRequestPage, UsageRequestSummary } from "@berry/shared";

import {
  AsyncState,
  Button,
  DataTable,
  ManagementPage,
  MetricGrid,
  Section,
  StatusPill,
  formatMoney,
  formatNumber,
} from "./management-primitives";
import { MiniSeries } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

export type PromptCacheSummary = {
  eligibleRequests: number;
  hits: number;
  misses: number;
  hitRate: number | null;
};

export function summarizePromptCache(requests: readonly UsageRequestSummary[]): PromptCacheSummary {
  const eligible = requests.filter((request) => request.cacheEligible);
  const hits = eligible.filter((request) => request.cacheReadTokens > 0).length;
  return {
    eligibleRequests: eligible.length,
    hits,
    misses: Math.max(0, eligible.length - hits),
    hitRate: eligible.length > 0 ? hits / eligible.length : null,
  };
}

function cacheStatus(request: UsageRequestSummary) {
  if (!request.cacheEligible) return { label: "Not eligible", tone: "neutral" as const };
  if (request.cacheReadTokens > 0) return { label: "Hit", tone: "good" as const };
  return { label: "Miss", tone: "warning" as const };
}

function missReason(value: string | null): string {
  if (!value) return "—";
  return value.replaceAll("_", " ");
}

function emptyAnalytics(tenantId: string, from: string, to: string): UsageAnalytics {
  return {
    tenantId,
    from,
    to,
    totals: {
      billedCostMicros: "0",
      requests: 0,
      tokens: 0,
      successRate: null,
      projectedMonthEndMicros: null,
    },
    series: [],
    breakdowns: { models: [], features: [] },
    performance: {
      latencyP50Ms: null,
      latencyP95Ms: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sandboxMinutes: 0,
    },
    anomalies: [],
    unavailableDimensions: [],
  };
}

function downloadCsv(value: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([value], { type: "text/csv" }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export function PersonalUsageScreen({ client, tenantId }: ManagementScreenProps) {
  const range = React.useMemo(() => {
    const to = new Date().toISOString();
    return { from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to };
  }, []);
  const resource = useResource(
    `my-usage-cache:${tenantId}:${range.from}:${range.to}`,
    async () => {
      if (!client) {
        return {
          analytics: emptyAnalytics(tenantId, range.from, range.to),
          requests: { items: [], nextCursor: null, hasMore: false } satisfies UsageRequestPage,
        };
      }
      const [analytics, requests] = await Promise.all([
        client.myUsage(tenantId, { ...range, limit: 50 }),
        client.myUsageRequests(tenantId, { ...range, limit: 50 }),
      ]);
      return { analytics, requests };
    },
    {
      analytics: emptyAnalytics(tenantId, range.from, range.to),
      requests: { items: [], nextCursor: null, hasMore: false } satisfies UsageRequestPage,
    },
  );
  const cache = summarizePromptCache(resource.data.requests.items);

  return (
    <ManagementPage
      title="Personal usage"
      description="Only activity attributed to your authenticated account is shown here."
      eyebrow="Usage"
      actions={(
        <Button
          variant="secondary"
          disabled={!client}
          onClick={() => {
            void client?.exportMyUsageCsv(tenantId, range)
              .then((csv) => downloadCsv(csv, "my-usage.csv"));
          }}
        >
          <Download />
          Export CSV
        </Button>
      )}
    >
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
        <MetricGrid items={[
          { label: "Billed usage", value: formatMoney(resource.data.analytics.totals.billedCostMicros) },
          { label: "Requests", value: formatNumber(resource.data.analytics.totals.requests) },
          { label: "Cache hit rate", value: cache.hitRate === null ? "—" : `${Math.round(cache.hitRate * 100)}%`, hint: `${cache.hits} hits · ${cache.misses} misses` },
          { label: "Cache reads", value: formatNumber(resource.data.analytics.performance.cacheReadTokens), hint: "Prompt tokens reused" },
          { label: "Cache writes", value: formatNumber(resource.data.analytics.performance.cacheWriteTokens), hint: "Prompt tokens written" },
        ]} />
        <Section title="Usage over time">
          <MiniSeries
            label="Daily billed usage"
            points={resource.data.analytics.series.map((point) => ({
              label: new Date(point.ts).toLocaleDateString(),
              value: Number(point.billedCostMicros) / 1_000_000,
            }))}
            format={(value) => formatMoney(value * 1_000_000)}
          />
        </Section>
        <Section title="Models and features">
          <DataTable
            label="Model usage"
            columns={["Model", "Requests", "Tokens", "Billed"]}
            rows={(resource.data.analytics.breakdowns.models ?? []).map((item) => [
              item.label,
              formatNumber(item.requests),
              formatNumber(item.tokens),
              formatMoney(item.billedCostMicros),
            ])}
          />
        </Section>
        <Section
          title="Prompt cache diagnostics"
          description="Developer detail for the most recent requests. Miss reasons explain why an otherwise eligible stable prefix was not reused."
        >
          {resource.data.requests.items.length > 0 ? (
            <DataTable
              label="Prompt cache request diagnostics"
              columns={["Time", "Model", "Cache", "Read tokens", "Write tokens", "Miss reason"]}
              rows={resource.data.requests.items.map((request) => {
                const status = cacheStatus(request);
                return [
                  new Date(request.ts).toLocaleString(),
                  request.model ?? request.provider ?? "—",
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>,
                  formatNumber(request.cacheReadTokens),
                  formatNumber(request.cacheWriteTokens),
                  missReason(request.cacheMissReason),
                ];
              })}
            />
          ) : (
            <p className="text-xs text-muted-foreground">No request-level cache telemetry is available for this period.</p>
          )}
        </Section>
      </AsyncState>
    </ManagementPage>
  );
}
