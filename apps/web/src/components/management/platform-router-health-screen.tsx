import {
  AsyncState,
  DataTable,
  DefinitionList,
  InlineNotice,
  ManagementPage,
  MetricGrid,
  Num,
  Section,
  StatusPill,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from "./management-primitives";
import { BreakdownBars } from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

const LAG_WARNING_SECONDS = 60;
const SUCCESS_WARNING_RATE = 0.95;
const SIGNATURE_WARNING_RATE = 0.99;

export function PlatformRouterHealthScreen({ client }: ManagementScreenProps) {
  const r = useResource(
    "platform:router-health",
    async () => (client ? client.platformRouterHealth() : null),
    null as any,
  );
  const data = r.data;
  // Providers that are not serving normally come first, then the ones carrying the most traffic.
  const providers: any[] = [...(data?.providers ?? [])].sort(
    (left, right) =>
      Number(isAvailable(left.status)) - Number(isAvailable(right.status)) ||
      Number(right.requestShare) - Number(left.requestShare),
  );
  const degraded = providers.filter((provider) => !isAvailable(provider.status));
  const totalShare = providers.reduce((sum, provider) => sum + Number(provider.requestShare), 0);
  // Per-provider error rates weighted by the traffic each provider carries.
  const successRate = totalShare > 0
    ? 1 - providers.reduce((sum, provider) => sum + Number(provider.requestShare) * Number(provider.errorRate), 0) / totalShare
    : null;
  const slowest = providers
    .filter((provider) => provider.latencyP95Ms != null)
    .sort((left, right) => Number(right.latencyP95Ms) - Number(left.latencyP95Ms))[0];
  const lagging = data?.eventLagSeconds != null && data.eventLagSeconds > LAG_WARNING_SECONDS;
  const signaturesFailing = data?.signatureSuccessRate != null && data.signatureSuccessRate < SIGNATURE_WARNING_RATE;
  const routerHealthy = !data || /healthy|ok|available|operational/i.test(String(data.status));
  return (
    <ManagementPage width="wide"
      title="Router health"
      description="Whether model requests are getting through: provider availability, latency, errors, and how current usage data is."
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
        {data ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Success rate",
                  value: formatPercent(successRate),
                  hint: "Across providers, weighted by request share",
                  ...(successRate != null && successRate < SUCCESS_WARNING_RATE ? { status: "warning" as const } : {}),
                },
                {
                  label: "Slowest provider P95",
                  value: slowest ? formatDuration(slowest.latencyP95Ms) : "—",
                  hint: slowest ? providerName(slowest.provider) : "No latency reported",
                },
                {
                  label: "Degraded providers",
                  value: formatNumber(degraded.length),
                  hint: `of ${formatNumber(providers.length)} ${providers.length === 1 ? "provider" : "providers"}`,
                  ...(degraded.length ? { status: "danger" as const } : {}),
                },
                {
                  label: "Usage event lag",
                  value: data.eventLagSeconds == null ? "—" : formatDuration(data.eventLagSeconds * 1000),
                  hint: `Warns above ${LAG_WARNING_SECONDS} s`,
                  ...(lagging ? { status: "warning" as const } : {}),
                },
              ]}
            />
            {!routerHealthy || degraded.length || lagging || signaturesFailing ? (
              <div className="grid gap-2">
                {!routerHealthy ? (
                  <InlineNotice tone="danger" title={`Router status: ${sentence(data.status)}`}>
                    The router is not reporting healthy. Check the providers below for the cause.
                  </InlineNotice>
                ) : null}
                {degraded.length ? (
                  <InlineNotice tone="warning" title={`${degraded.map((provider) => providerName(provider.provider)).join(", ")} ${degraded.length === 1 ? "is" : "are"} not fully available`}>
                    {formatPercent(degraded.reduce((sum, provider) => sum + Number(provider.requestShare), 0))} of requests are routed to {degraded.length === 1 ? "this provider" : "these providers"}.
                  </InlineNotice>
                ) : null}
                {lagging ? (
                  <InlineNotice tone="warning" title="Usage events are arriving late">
                    Events are {Math.round(data.eventLagSeconds)} seconds behind. Spend totals lag by the same amount.
                  </InlineNotice>
                ) : null}
                {signaturesFailing ? (
                  <InlineNotice tone="danger" title="Some usage events fail signature checks">
                    {formatPercent(1 - data.signatureSuccessRate, 2)} of events are rejected because their signature does not verify.
                  </InlineNotice>
                ) : null}
              </div>
            ) : null}
            <Section title="Providers" flush>
              <DataTable
                label="Router providers"
                columns={["Provider", "Status", "Request share", "P95 latency", "Error rate", "Models"]}
                rows={providers.map((x: any) => [
                  <b className="font-medium text-foreground">{providerName(x.provider)}</b>,
                  <StatusPill tone={isAvailable(x.status) ? "good" : /down|unavailable|outage|fail/i.test(String(x.status)) ? "danger" : "warning"}>{sentence(x.status)}</StatusPill>,
                  <span className="tabular-nums" data-sort={Number(x.requestShare)}>{formatPercent(x.requestShare)}</span>,
                  <span className="tabular-nums" data-sort={Number(x.latencyP95Ms ?? 0)}>{formatDuration(x.latencyP95Ms)}</span>,
                  <span className="tabular-nums" data-sort={Number(x.errorRate)}>{formatPercent(x.errorRate, x.errorRate > 0 && x.errorRate < 0.1 ? 2 : undefined)}</span>,
                  <Num value={x.models} kind="number" />,
                ])}
              />
            </Section>
            {providers.length > 1 ? (
              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="Request share" description="Where traffic is going.">
                  <BreakdownBars label="Provider" rows={providers.map((provider: any) => ({ label: providerName(provider.provider), value: Number(provider.requestShare) * 100 }))} format={(value) => `${value.toFixed(value < 10 ? 1 : 0)}%`} />
                </Section>
                <Section title="P95 latency" description="Slowest providers first.">
                  <BreakdownBars label="Provider" rows={providers.filter((provider: any) => provider.latencyP95Ms != null).map((provider: any) => ({ label: providerName(provider.provider), value: Number(provider.latencyP95Ms) }))} format={(value) => formatDuration(value)} />
                </Section>
              </div>
            ) : null}
            <Section title="Usage pipeline" description="How usage events travel from the router into billing.">
              <DefinitionList
                items={[
                  { term: "Router status", detail: <StatusPill tone={routerHealthy ? "good" : "danger"}>{sentence(data.status)}</StatusPill> },
                  { term: "Event contract", detail: <span className="font-mono text-xs">{data.contractVersion}</span> },
                  { term: "Signature checks", detail: data.signatureSuccessRate == null ? "No events yet" : `${formatPercent(data.signatureSuccessRate, 2)} verified` },
                  { term: "Price list updated", detail: data.priceSnapshotAt ? formatDateTime(data.priceSnapshotAt) : "Never" },
                ]}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

function isAvailable(status: string) {
  return /^(available|healthy|ok|operational|active)$/i.test(String(status));
}

function providerName(provider: string) {
  const known: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", azure: "Azure OpenAI", bedrock: "Amazon Bedrock", mistral: "Mistral", xai: "xAI", openrouter: "OpenRouter" };
  return known[String(provider).toLowerCase()] ?? sentence(provider);
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
