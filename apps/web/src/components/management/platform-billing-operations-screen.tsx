import {
  AsyncState,
  DataTable,
  ManagementPage,
  MetricGrid,
  Section,
  formatMoney,
} from "./management-primitives";
import { BreakdownBars, HealthRings } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PlatformBillingOperationsScreen({ client }: ManagementScreenProps) {
  const r = useResource(
    "platform:billing-operations",
    async () => (client ? client.platformBilling() : null),
    null as any,
  );
  return (
    <ManagementPage
      title="Billing operations"
      description="Cross-tenant balances, invoices, grants, meters, dunning, and billing blocks."
      eyebrow="Platform operations"
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !r.data}
        emptyTitle="Billing operations unavailable"
        emptyText="Connect the platform API to load live operational data for this screen."
      >
        {r.data ? (
          <>
            <MetricGrid
              items={[
                { label: "Prepaid liability", value: formatMoney(r.data.prepaidLiabilityMicros) },
                { label: "Consumed this month", value: formatMoney(r.data.consumedThisMonthMicros) },
                { label: "Invoices due", value: String(r.data.invoicesDue) },
                { label: "Failed payments", value: String(r.data.failedPayments), status: r.data.failedPayments ? "danger" : "good" },
                { label: "Blocked tenants", value: String(r.data.blockedTenants) },
              ]}
            />
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Tenant spend concentration">
                <BreakdownBars label="Monthly spend" rows={r.data.tenants.map((tenant: any) => ({ label: tenant.name, value: Number(tenant.monthlySpendMicros) / 1e6 }))} format={(value) => formatMoney(value * 1e6)} />
              </Section>
              <Section title="Billing health">
                <HealthRings successRate={r.data.tenants.length ? r.data.tenants.filter((tenant: any) => tenant.billingHealth !== "failed" && tenant.billingHealth !== "blocked").length / r.data.tenants.length : null} />
              </Section>
            </div>
            <DataTable
              label="Tenant billing operations"
              columns={["Tenant", "Monthly spend", "Prepaid balance", "Health"]}
              rows={r.data.tenants.map((x: any) => [x.name, formatMoney(x.monthlySpendMicros), formatMoney(x.prepaidBalanceMicros), x.billingHealth])}
            />
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}
