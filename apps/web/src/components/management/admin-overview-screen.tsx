import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import {
  AsyncState, Button, CellStack, DataTable, InlineNotice, ManagementPage, MetricGrid,
  Section, StatusPill, formatCompact, formatCompactMoney, formatDateTime, formatDuration,
  formatMoney, formatNumber, formatPercent,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { BreakdownBars, DualTrend, OutcomeBars, ShareDonut, aggregateModelSpendRows } from "./management-charts";
import {
  UsageRangeControl, usageRangeForPreset,
  type UsageDateRange, type UsageRangePreset,
} from "./usage-controls";
import { AdminOverviewSkeleton } from "./management-screen-skeletons";

export function AdminOverviewScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const navigate = useNavigate();
  const [preset, setPreset] = React.useState<UsageRangePreset>("month");
  const [range, setRange] = React.useState<UsageDateRange>(() => usageRangeForPreset("month"));
  const from = `${range.from}T00:00:00.000Z`;
  const to = `${range.to}T23:59:59.999Z`;
  const canReadBudgets = permissions.includes("budgets:read");
  const r = useResource(
    `overview:${tenantId}:${from}:${to}`,
    async () =>
      client
        ? Promise.all([
            client.listOrgMembers(tenantId),
            client.usageAnalytics(tenantId, { from, to, limit: 20 }),
            client.billingHealth(tenantId),
            client.listAuditEvents(tenantId, { limit: 8 }),
            canReadBudgets ? client.listBudgetLimits(tenantId).catch(() => []) : Promise.resolve([]),
          ])
        : ([
            [],
            config.usageDashboards.find((x) => x?.tenantId === tenantId) ??
              null,
            null,
            config.auditEvents,
            config.budgetLimits.filter((x) => x.tenantId === tenantId),
          ] as any),
    [] as any,
  );
  const [members = [], usage, health, audit = [], budgets = []] = r.data as [any[], any, any, any[], any[]];
  const open = (tab: string) => void navigate({ to: "/admin/$tab", params: { tab }, search: {} });

  const series: any[] = usage?.series ?? usage?.burnDown ?? [];
  const point = (x: any) => ({
    label: String(x.ts ?? x.date),
    spend: Number(x.billedCostMicros ?? x.costBilledMicros ?? 0) / 1e6,
    requests: Number(x.requests ?? 0),
    tokens: Number(x.tokens ?? 0),
    successes: Number(x.successes ?? x.requests ?? 0),
    failures: Number(x.failures ?? 0),
  });
  const points = series.map(point);
  const spendMicros = Number(usage?.totals?.billedCostMicros ?? usage?.totals?.costBilledMicros ?? 0);
  const inputTokens = Number(usage?.totals?.inputTokens ?? usage?.totals?.tokensIn ?? 0);
  const outputTokens = Number(usage?.totals?.outputTokens ?? usage?.totals?.tokensOut ?? 0);
  const totalTokens = Number(usage?.totals?.tokens ?? 0) || inputTokens + outputTokens;
  const successRate: number | null = usage?.totals?.successRate ?? derivedSuccessRate(series);
  const memberRows: any[] = usage?.breakdowns?.members ?? usage?.breakdowns?.users ?? usage?.byUser ?? [];
  const activeMembers = members.filter((m: any) => m.status === "active").length;
  const membersWithUsage = memberRows.filter((row: any) => (row.id ?? row.userId) != null).length;
  const memberName = React.useMemo(() => {
    const names = new Map<string, string>();
    for (const member of members) names.set(member.userId, member.name || member.email || member.userId);
    return (id: string | null | undefined) => (id ? names.get(id) ?? shortId(id) : "System");
  }, [members]);

  // The monthly organization budget only gives honest context for the month view.
  const orgBudget = budgets.find((b: any) => b.scopeType === "org" && b.period === "month" && b.status !== "disabled");
  const budgetMicros = preset === "month" && orgBudget ? Number(orgBudget.hardLimitMicros) : 0;
  const budgetUse = budgetMicros > 0 ? spendMicros / budgetMicros : null;
  const projected = usage?.totals?.projectedMonthEndMicros;

  return (
    <ManagementPage width="wide"
      title="Overview"
      description="Spend, adoption and reliability for the organization, and what needs your attention."
      eyebrow="Organization"
      actions={
        <UsageRangeControl
          preset={preset}
          range={range}
          onChange={(nextPreset, nextRange) => {
            setPreset(nextPreset);
            setRange(nextRange);
          }}
        />
      }
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        skeleton={<AdminOverviewSkeleton />}
        empty={!r.loading && !usage}
        emptyTitle="No organization data yet"
        emptyText="Usage, adoption and spend appear here once the organization API is connected and members start working."
      >
        {usage ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Billed spend",
                  value: formatCompactMoney(spendMicros),
                  exactValue: formatMoney(spendMicros),
                  trend: points.map((x) => x.spend),
                  ...(budgetUse != null
                    ? {
                        hint: `${formatPercent(budgetUse)} of ${formatCompactMoney(budgetMicros)} monthly budget`,
                        ...(budgetUse >= 1 ? { status: "danger" as const } : budgetUse >= 0.8 ? { status: "warning" as const } : {}),
                      }
                    : projected
                      ? { hint: `Projected ${formatCompactMoney(projected)} by month end` }
                      : {}),
                },
                {
                  label: "Active members",
                  value: formatNumber(activeMembers || membersWithUsage),
                  hint: members.length
                    ? `of ${formatNumber(members.length)} members${membersWithUsage ? ` · ${formatNumber(membersWithUsage)} used Berry in this period` : ""}`
                    : "Members with usage in this period",
                },
                {
                  label: "Tokens",
                  value: formatCompact(totalTokens),
                  exactValue: formatNumber(totalTokens),
                  trend: points.map((x) => x.tokens).some(Boolean) ? points.map((x) => x.tokens) : points.map((x) => x.requests),
                  hint: `${formatCompact(inputTokens)} in · ${formatCompact(outputTokens)} out · ${formatCompact(usage.totals?.requests ?? 0)} requests`,
                },
                {
                  label: "Success rate",
                  value: formatPercent(successRate),
                  ...((successRate ?? 1) < 0.95 ? { status: "warning" as const } : {}),
                  trend: points.map((x) => (x.successes + x.failures > 0 ? x.successes / (x.successes + x.failures) : 1)),
                  hint: usage.performance?.latencyP95Ms == null ? "Share of requests that completed" : `P95 latency ${formatDuration(usage.performance.latencyP95Ms)}`,
                },
              ]}
            />
            <Attention usage={usage} health={health} onOpen={open} />
            <Section
              title="Spend and requests"
              description="Daily billed spend beside request volume."
              actions={<Button variant="ghost" onClick={() => open("analytics")}>Open usage<ArrowRight aria-hidden /></Button>}
            >
              <DualTrend
                label="Billed spend"
                points={points}
                spendFormat={(v) => formatMoney(v * 1e6)}
              />
            </Section>
            <div className="grid gap-5 xl:grid-cols-2">
              <Section title="Spend by department">
                <BreakdownBars
                  label="Department"
                  limit={6}
                  rows={(usage.breakdowns?.departments ?? usage.byDepartment ?? []).map((row: any) => ({
                    label: row.label ?? row.departmentId ?? "Unattributed",
                    value: Number(row.billedCostMicros ?? row.costBilledMicros ?? 0) / 1e6,
                  }))}
                  format={(value) => formatCompactMoney(value * 1e6)}
                />
              </Section>
              <Section title="Spend by model">
                <ShareDonut
                  caption="Spend by model"
                  centerLabel="Spend"
                  rows={aggregateModelSpendRows(
                    (usage.breakdowns?.models ?? usage.byModel ?? []).map((row: any) => ({
                      label: row.label ?? row.model ?? "Unknown",
                      value: Number(row.billedCostMicros ?? row.costBilledMicros ?? 0) / 1e6,
                    })),
                    6,
                  )}
                  format={(value) => formatCompactMoney(value * 1e6)}
                />
              </Section>
            </div>
            <div className="grid gap-5 xl:grid-cols-2">
              <Section title="Reliability" description="Share of requests that failed each day.">
                <OutcomeBars points={points} />
              </Section>
              <Section title="Top members" description="Highest billed spend in this period.">
                <BreakdownBars
                  label="Member"
                  limit={6}
                  rows={memberRows.filter((row: any) => (row.id ?? row.userId) != null).map((row: any) => ({
                    label: row.name ?? row.label ?? memberName(row.id ?? row.userId),
                    value: Number(row.billedCostMicros ?? row.costBilledMicros ?? 0) / 1e6,
                  }))}
                  format={(value) => formatCompactMoney(value * 1e6)}
                />
              </Section>
            </div>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <Section
                title="Recent admin activity"
                flush
                actions={<Button variant="ghost" onClick={() => open("audit-log")}>Audit log<ArrowRight aria-hidden /></Button>}
              >
                <DataTable
                  label="Recent activity"
                  searchable={false}
                  columns={["Event", "Actor", "When"]}
                  rows={audit.map((x: any) => [
                    <CellStack primary={human(x.action)} secondary={[human(x.category ?? ""), x.targetType ? human(x.targetType) : ""].filter(Boolean).join(" · ")} />,
                    memberName(x.actorUserId),
                    <span className="whitespace-nowrap text-muted-foreground" data-sort={new Date(x.ts ?? x.createdAt).getTime()}>{formatDateTime(x.ts ?? x.createdAt)}</span>,
                  ])}
                />
              </Section>
              <Section title="System health" flush>
                <ul className="grid divide-y divide-border">
                  <HealthRow
                    label="Billing"
                    detail={health?.explanation ?? "Billing status is not reported in this environment."}
                    tone={!health ? "neutral" : health.status === "healthy" ? "good" : health.status === "not_configured" ? "neutral" : health.status === "blocked" ? "danger" : "warning"}
                    status={!health ? "Unknown" : human(health.status)}
                  />
                  <HealthRow
                    label="Spend reservations"
                    detail="Holds placed before a request runs, so limits are enforced."
                    tone={!health ? "neutral" : health.reservationHealthy ? "good" : "warning"}
                    status={!health ? "Unknown" : health.reservationHealthy ? "Healthy" : "Degraded"}
                  />
                  <HealthRow
                    label="Usage ingestion"
                    detail="Metering events arriving from the router."
                    tone={!health ? "neutral" : health.ingestHealthy ? "good" : "warning"}
                    status={!health ? "Unknown" : health.ingestHealthy ? "Healthy" : "Degraded"}
                  />
                </ul>
              </Section>
            </div>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

/** What is waiting on an admin. Renders nothing when there is nothing to do. */
function Attention({ usage, health, onOpen }: { usage: any; health: any; onOpen: (tab: string) => void }) {
  const anomalies: any[] = usage?.anomalies ?? [];
  const billingProblem = health && (health.status === "degraded" || health.status === "blocked");
  if (!anomalies.length && !billingProblem) return null;
  return (
    <div className="grid gap-2" aria-label="Needs attention">
      {billingProblem ? (
        <InlineNotice
          tone={health.status === "blocked" ? "danger" : "warning"}
          title={health.status === "blocked" ? "Billing is blocking requests" : "Billing is degraded"}
          action={<Button variant="secondary" onClick={() => onOpen("credits-billing")}>Open billing</Button>}
        >
          {health.explanation}
        </InlineNotice>
      ) : null}
      {anomalies.slice(0, 3).map((item) => (
        <InlineNotice
          key={item.id}
          tone={item.severity === "error" ? "danger" : item.severity === "info" ? "info" : "warning"}
          title={`${item.label} · ${item.dimension?.label ?? "Organization"}`}
          action={<Button variant="secondary" onClick={() => onOpen("analytics")}>Investigate</Button>}
        >
          {item.explanation}
        </InlineNotice>
      ))}
    </div>
  );
}

function HealthRow({ label, detail, status, tone }: { label: string; detail: string; status: string; tone: "good" | "warning" | "danger" | "neutral" }) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="grid min-w-0 gap-0.5">
        <b className="text-md font-medium text-foreground">{label}</b>
        <small className="text-xs leading-5 text-muted-foreground">{detail}</small>
      </span>
      <StatusPill tone={tone}>{status}</StatusPill>
    </li>
  );
}

function shortId(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function derivedSuccessRate(
  points: Array<{ requests?: number; successes?: number; failures?: number }>,
) {
  const totals = points.reduce<{ requests: number; successes: number }>(
    (summary, point) => {
      const requests = Number(point.requests ?? 0);
      const failures = Number(point.failures ?? 0);
      return {
        requests: summary.requests + requests,
        successes: summary.successes + Number(point.successes ?? Math.max(0, requests - failures)),
      };
    },
    { requests: 0, successes: 0 },
  );
  return totals.requests ? totals.successes / totals.requests : null;
}
const ACRONYMS: Record<string, string> = { oauth: "OAuth", sso: "SSO", scim: "SCIM", mcp: "MCP", api: "API", acl: "ACL", csv: "CSV", id: "ID" };
/** `connector_oauth-connected` → "Connector OAuth connected". */
function human(value: string) {
  const words = value.replaceAll("_", " ").replaceAll("-", " ").replaceAll(".", " ").trim().split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => ACRONYMS[word.toLowerCase()] ?? (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()))
    .join(" ");
}
