import { AsyncState, DataTable, ManagementPage, MetricGrid, Section, formatMoney, formatNumber } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PlatformOverviewScreen({ client, config }: ManagementScreenProps) {
  const resource = useResource("platform:overview", async () => client ? client.platformOverview() : ({ tenants: config.platformUsage.tenants, activeTenants: config.platformUsage.activeTenants, billedSpendMicros: config.platformUsage.totalSpendMicros, rawCostMicros: "0", marginMicros: config.platformUsage.totalSpendMicros, successfulRequestRate: null, routerLagSeconds: null, incidents: [], recentOperatorActivity: [] }), null as any);
  const data = resource.data;
  return <ManagementPage title="Overview" description="Cross-tenant cost, reliability, incidents, and operator activity." eyebrow="Platform operations">
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      {data ? <><MetricGrid items={[{ label: "Tenants", value: formatNumber(data.tenants) }, { label: "Active tenants", value: formatNumber(data.activeTenants) }, { label: "Billed spend", value: formatMoney(data.billedSpendMicros) }, { label: "Raw cost", value: formatMoney(data.rawCostMicros) }, { label: "Margin", value: formatMoney(data.marginMicros) }, { label: "Router lag", value: data.routerLagSeconds == null ? "—" : `${Math.round(data.routerLagSeconds)} s`, status: (data.routerLagSeconds ?? 0) > 60 ? "warning" : "good" }]} />
        <Section title="Operator audit" description="Platform actions use a separate authorizer and audit stream; organization roles never grant access here."><DataTable label="Recent platform operator activity" columns={["Action", "Target", "Operator", "Audit note", "When"]} rows={(data.recentOperatorActivity ?? []).map((row: any) => [row.action, row.targetId ?? "—", row.actorUserId ?? "System", row.auditNote ?? "—", row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"])} /></Section>
      </> : null}
    </AsyncState>
  </ManagementPage>;
}
