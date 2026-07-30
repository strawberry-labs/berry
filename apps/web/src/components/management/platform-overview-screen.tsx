import { AsyncState, DataTable, ManagementPage, MetricGrid, Section, formatMoney, formatNumber } from "./management-primitives";
import { BreakdownBars, DualTrend, HealthRings } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PlatformOverviewScreen({ client, config }: ManagementScreenProps) {
  const resource = useResource(
    "platform:overview",
    async () =>
      client ? client.platformOverview() : demoPlatformOverview(config),
    null as any,
  );
  const data = resource.data;
  return <ManagementPage title="Overview" description="Cross-tenant cost, reliability, incidents, and operator activity." eyebrow="Platform operations">
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      {data ? <><MetricGrid items={[{ label: "Tenants", value: formatNumber(data.tenants) }, { label: "Active tenants", value: formatNumber(data.activeTenants) }, { label: "Billed spend", value: formatMoney(data.billedSpendMicros) }, { label: "Raw cost", value: formatMoney(data.rawCostMicros) }, { label: "Margin", value: formatMoney(data.marginMicros) }, { label: "Router lag", value: data.routerLagSeconds == null ? "—" : `${Math.round(data.routerLagSeconds)} s`, status: (data.routerLagSeconds ?? 0) > 60 ? "warning" : "good" }]} />
        <Section title="Platform usage trend" description="Thirty-day billed usage and request volume across every tenant.">
          <DualTrend
            label="Billed spend"
            points={(data.series ?? []).map((point: any) => ({
              label: point.ts.slice(0, 10),
              spend: Number(point.billedCostMicros) / 1e6,
              requests: Number(point.requests),
            }))}
            spendFormat={(value) => formatMoney(value * 1e6)}
          />
        </Section>
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Tenant spend concentration">
            <BreakdownBars
              label="Billed spend"
              rows={(data.topTenants ?? []).map((tenant: any) => ({
                label: tenant.name,
                value: Number(tenant.billedCostMicros) / 1e6,
              }))}
              format={(value) => formatMoney(value * 1e6)}
            />
          </Section>
          <Section title="Platform reliability">
            <HealthRings successRate={data.successfulRequestRate} />
          </Section>
        </div>
        <Section title="Operator audit" description="Platform actions use a separate authorizer and audit stream; organization roles never grant access here."><DataTable label="Recent platform operator activity" columns={["Action", "Target", "Operator", "Audit note", "When"]} rows={(data.recentOperatorActivity ?? []).map((row: any) => [row.action, row.targetId ?? "—", row.actorUserId ?? "System", row.auditNote ?? "—", row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"])} /></Section>
      </> : null}
    </AsyncState>
  </ManagementPage>;
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
