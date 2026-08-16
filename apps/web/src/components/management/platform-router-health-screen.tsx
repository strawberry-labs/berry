import {
  AsyncState,
  DataTable,
  ManagementPage,
  MetricGrid,
  Section,
  StatusPill,
} from "./management-primitives";
import { BreakdownBars } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PlatformRouterHealthScreen({ client }: ManagementScreenProps) {
  const r = useResource(
    "platform:router-health",
    async () => (client ? client.platformRouterHealth() : null),
    null as any,
  );
  return (
    <ManagementPage
      title="Router health"
      description="Contract, pricing snapshot, signature health, ingestion lag, provider errors, and latency."
      eyebrow="Platform operations"
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !r.data}
        emptyTitle="Router health unavailable"
        emptyText="Connect the platform API to load live operational data for this screen."
      >
        {r.data ? (
          <>
            <MetricGrid
              items={[
                { label: "Status", value: r.data.status },
                { label: "Contract", value: r.data.contractVersion },
                { label: "Event lag", value: r.data.eventLagSeconds == null ? "—" : `${Math.round(r.data.eventLagSeconds)} s` },
                { label: "Signature health", value: r.data.signatureSuccessRate == null ? "—" : `${Math.round(r.data.signatureSuccessRate * 100)}%` },
              ]}
            />
            <Section title="Providers">
              <div className="mb-4 grid gap-4 xl:grid-cols-2">
                <BreakdownBars label="Request share" rows={r.data.providers.map((provider: any) => ({ label: provider.provider, value: Number(provider.requestShare) * 100 }))} format={(value) => `${Math.round(value)}%`} />
                <BreakdownBars label="P95 latency" rows={r.data.providers.map((provider: any) => ({ label: provider.provider, value: Number(provider.latencyP95Ms ?? 0) }))} format={(value) => `${Math.round(value)} ms`} />
              </div>
              <DataTable
                label="Router providers"
                columns={["Provider", "Models", "Request share", "P95 latency", "Error rate", "Status"]}
                rows={r.data.providers.map((x: any) => [
                  x.provider,
                  x.models,
                  `${Math.round(x.requestShare * 100)}%`,
                  x.latencyP95Ms == null ? "—" : `${x.latencyP95Ms} ms`,
                  `${Math.round(x.errorRate * 100)}%`,
                  <StatusPill tone={x.status === "available" ? "good" : "warning"}>{x.status}</StatusPill>,
                ])}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}
