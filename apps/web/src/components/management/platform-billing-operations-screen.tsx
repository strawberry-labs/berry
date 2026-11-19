import {
  AsyncState,
  CellStack,
  DataTable,
  InlineNotice,
  ManagementPage,
  MetricGrid,
  Num,
  StatusPill,
  formatCompactMoney,
  formatMoney,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

type Tone = "neutral" | "good" | "warning" | "danger";

export function PlatformBillingOperationsScreen({ client }: ManagementScreenProps) {
  const r = useResource(
    "platform:billing-operations",
    async () => (client ? client.platformBilling() : null),
    null as any,
  );
  const data = r.data;
  // Organizations with a billing problem first, then the lowest balances.
  const tenants: any[] = [...(data?.tenants ?? [])].sort(
    (left, right) =>
      toneRank(healthTone(left.billingHealth)) - toneRank(healthTone(right.billingHealth)) ||
      Number(left.prepaidBalanceMicros) - Number(right.prepaidBalanceMicros),
  );
  return (
    <ManagementPage width="wide"
      title="Billing operations"
      description="What organizations have consumed, what they hold in prepaid credit, and whose billing needs attention."
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
        {data ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Consumed this month",
                  value: formatCompactMoney(data.consumedThisMonthMicros),
                  exactValue: formatMoney(data.consumedThisMonthMicros),
                  hint: `${formatCompactMoney(data.prepaidLiabilityMicros)} prepaid credit still held`,
                },
                {
                  label: "Failed payments",
                  value: formatNumber(data.failedPayments),
                  hint: data.failedPayments ? "Payments the provider could not collect" : "All payments collected",
                  ...(data.failedPayments ? { status: "danger" as const } : {}),
                },
                {
                  label: "Blocked organizations",
                  value: formatNumber(data.blockedTenants),
                  hint: `of ${formatNumber(tenants.length)} · requests refused for billing`,
                  ...(data.blockedTenants ? { status: "danger" as const } : {}),
                },
                {
                  label: "Invoices due",
                  value: formatNumber(data.invoicesDue),
                  hint: data.invoicesDue ? "Open and awaiting payment" : "Nothing awaiting payment",
                  ...(data.invoicesDue ? { status: "warning" as const } : {}),
                },
              ]}
            />
            {data.blockedTenants || data.failedPayments ? (
              <InlineNotice
                tone="danger"
                title={[
                  data.blockedTenants ? `${formatNumber(data.blockedTenants)} ${data.blockedTenants === 1 ? "organization is" : "organizations are"} blocked` : "",
                  data.failedPayments ? `${formatNumber(data.failedPayments)} ${data.failedPayments === 1 ? "payment" : "payments"} failed` : "",
                ].filter(Boolean).join(" · ")}
              >
                Blocked organizations cannot send requests until their billing is resolved. They are listed first below.
              </InlineNotice>
            ) : null}
            <DataTable
              label="Organization billing"
              columns={["Organization", "Billing", "Prepaid balance", "Monthly spend", "Plan"]}
              rows={tenants.map((x: any) => [
                <CellStack primary={x.name} secondary={x.slug} />,
                <StatusPill tone={healthTone(x.billingHealth)}>{sentence(x.billingHealth)}</StatusPill>,
                <Num value={x.prepaidBalanceMicros} kind="compact-money" />,
                <Num value={x.monthlySpendMicros} kind="compact-money" />,
                sentence(x.plan ?? "—"),
              ])}
            />
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

function healthTone(health: string): Tone {
  const value = String(health);
  if (/fail|block|error|past|unhealthy/i.test(value)) return "danger";
  if (/degrad|warn|pending|low|not/i.test(value)) return "warning";
  if (/healthy|ok|active|current/i.test(value)) return "good";
  return "neutral";
}

function toneRank(tone: Tone) {
  return tone === "danger" ? 0 : tone === "warning" ? 1 : 2;
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
