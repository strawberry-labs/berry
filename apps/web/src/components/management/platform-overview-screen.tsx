import {
  AsyncState, DataTable, InlineNotice, ManagementPage, MetricGrid, Section,
  formatCompact, formatCompactMoney, formatDateTime, formatMoney, formatNumber, formatPercent,
} from "./management-primitives";
import { BreakdownBars, DualTrend } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";
import { PlatformOverviewSkeleton } from "./management-screen-skeletons";

const LAG_WARNING_SECONDS = 60;
const SUCCESS_WARNING_RATE = 0.95;

export function PlatformOverviewScreen({ client, config }: ManagementScreenProps) {
  const resource = useResource(
    "platform:overview",
    async () =>
      client ? client.platformOverview() : demoPlatformOverview(config),
    null as any,
  );
  const data = resource.data;
  const series: any[] = data?.series ?? [];
  const requests = series.reduce((sum, point) => sum + Number(point.requests ?? 0), 0);
  const billed = Number(data?.billedSpendMicros ?? 0);
  const margin = Number(data?.marginMicros ?? 0);
  const inactive = data ? data.tenants - data.activeTenants : 0;
  const incidents: any[] = (data?.incidents ?? []).filter((incident: any) => incident.status !== "healthy");
  const lagging = data?.routerLagSeconds != null && data.routerLagSeconds > LAG_WARNING_SECONDS;
  const activity: any[] = data?.recentOperatorActivity ?? [];
  return <ManagementPage width="wide" title="Overview" description="Health, spend, and volume across every organization on this deployment." eyebrow="Platform operations">
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} skeleton={<PlatformOverviewSkeleton />}>
      {data ? <>
        <MetricGrid items={[
          {
            label: "Active organizations",
            value: formatNumber(data.activeTenants),
            hint: inactive ? `of ${formatNumber(data.tenants)} · ${formatNumber(inactive)} not active` : `of ${formatNumber(data.tenants)}`,
          },
          {
            label: "Billed spend",
            value: formatCompactMoney(data.billedSpendMicros),
            exactValue: formatMoney(data.billedSpendMicros),
            hint: billed > 0 ? `${formatCompactMoney(data.marginMicros)} margin (${formatPercent(margin / billed)}) over provider cost` : "No billed usage in this period",
            trend: series.map((point) => Number(point.billedCostMicros) / 1e6),
          },
          {
            label: "Requests",
            value: formatCompact(requests),
            exactValue: formatNumber(requests),
            hint: requests > 0 ? `${formatMoney(billed / requests * 1000)} billed per 1K requests` : "No requests in this period",
            trend: series.map((point) => Number(point.requests ?? 0)),
          },
          {
            label: "Router success rate",
            value: formatPercent(data.successfulRequestRate),
            hint: data.routerLagSeconds == null ? "Event lag unknown" : `Usage events ${Math.round(data.routerLagSeconds)} s behind`,
            trend: series.map((point) => point.successRate ?? 1),
            ...(data.successfulRequestRate != null && data.successfulRequestRate < SUCCESS_WARNING_RATE ? { status: "warning" as const } : {}),
          },
        ]} />
        {incidents.length || lagging ? (
          <div className="grid gap-2">
            {incidents.map((incident) => (
              <InlineNotice key={incident.key} tone={incident.status === "error" ? "danger" : "warning"} title={incident.label}>
                {incident.detail}
              </InlineNotice>
            ))}
            {lagging ? (
              <InlineNotice tone="warning" title="Usage events are arriving late">
                The router is {Math.round(data.routerLagSeconds)} seconds behind, so spend totals are out of date by that much. Router health has the detail.
              </InlineNotice>
            ) : null}
          </div>
        ) : null}
        <Section title="Spend and requests" description="Daily billed spend beside request volume, all organizations.">
          <DualTrend
            label="Billed spend"
            points={series.map((point: any) => ({
              label: point.ts,
              spend: Number(point.billedCostMicros) / 1e6,
              requests: Number(point.requests),
            }))}
            spendFormat={(value) => formatMoney(value * 1e6)}
          />
        </Section>
        <Section title="Top organizations by spend">
          <BreakdownBars
            label="Organization"
            rows={(data.topTenants ?? []).map((tenant: any) => ({
              label: tenant.name,
              value: Number(tenant.billedCostMicros) / 1e6,
            }))}
            format={(value) => formatCompactMoney(value * 1e6)}
          />
        </Section>
        <Section title="Recent operator activity" description="Actions taken from this console. Organization roles never grant access here." flush>
          {activity.length ? (
            <DataTable
              label="Operator activity"
              columns={["When", "Action", "Target", "Operator", "Note"]}
              rows={activity.map((row: any) => [
                formatDateTime(row.createdAt),
                sentence(row.action ?? "Unknown action"),
                row.targetId ? <Mono value={row.targetId} /> : "—",
                row.actorUserId ? <Mono value={row.actorUserId} /> : "System",
                row.auditNote ?? "—",
              ])}
            />
          ) : (
            <p className="px-4 py-3 text-md text-muted-foreground">No operator actions recorded yet.</p>
          )}
        </Section>
      </> : null}
    </AsyncState>
  </ManagementPage>;
}

function Mono({ value }: { value: string }) {
  const text = String(value);
  return <span className="font-mono text-xs" title={text}>{text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text}</span>;
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function demoPlatformOverview(config: ManagementScreenProps["config"]) {
  const usage = config.platformUsage;
  const weights = [0.08, 0.1, 0.11, 0.13, 0.16, 0.19, 0.23];
  const start = new Date(usage.from).getTime();
  const end = new Date(usage.to).getTime();
  const totalSpend = Number(usage.totalSpendMicros);
  const totalRequests = usage.totalUsageEvents;

  return {
    tenants: usage.tenants,
    activeTenants: usage.activeTenants,
    billedSpendMicros: usage.totalSpendMicros,
    rawCostMicros: String(Math.round(totalSpend * 0.64)),
    marginMicros: String(Math.round(totalSpend * 0.36)),
    successfulRequestRate: 0.974,
    routerLagSeconds: 18,
    incidents: [],
    recentOperatorActivity: [],
    series: weights.map((weight, index) => ({
      ts: new Date(start + ((end - start) * index) / (weights.length - 1)).toISOString(),
      billedCostMicros: String(Math.round(totalSpend * weight)),
      rawCostMicros: String(Math.round(totalSpend * weight * 0.64)),
      requests: Math.round(totalRequests * weight),
      successRate: 0.965 + index * 0.003,
    })),
    topTenants: usage.topTenants.map((tenant) => ({
      tenantId: tenant.tenantId,
      name: tenant.tenantName,
      billedCostMicros: tenant.spendMicros,
      requests: tenant.usageEvents,
    })),
  };
}
