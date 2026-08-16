import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, FileUp, Plus, Save, Search, UserPlus, Users } from "lucide-react";
import {
  AsyncState, Button, Checkbox, DataTable, FormSelect, Input, ManagementDialog,
  ManagementPage, MetricGrid, SearchInput, Section, StatusPill, SuccessMessage,
  Switch, Toolbar, formatDateTime, formatMoney, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { BreakdownBars, DualTrend, HealthRings, OutcomeBars } from "./management-charts";
import {
  calculateCacheMetric, UsageRangeControl, usageRangeForPreset,
  type UsageDateRange, type UsageRangePreset,
} from "./usage-controls";
import { parseMemberImportCsv, type MemberImportRow } from "../../lib/member-import";
import { memberAccessStatusOptions, memberStatusUpdate } from "../../lib/member-administration";
export function AdminOverviewScreen({ client, config, tenantId }: ManagementScreenProps) {
  const [preset, setPreset] = React.useState<UsageRangePreset>("month");
  const [range, setRange] = React.useState<UsageDateRange>(() => usageRangeForPreset("month"));
  const from = `${range.from}T00:00:00.000Z`;
  const to = `${range.to}T23:59:59.999Z`;
  const r = useResource(
    `overview:${tenantId}:${from}:${to}`,
    async () =>
      client
        ? Promise.all([
            client.listOrgMembers(tenantId),
            client.usageAnalytics(tenantId, { from, to, limit: 20 }),
            client.billingHealth(tenantId),
            client.listAuditEvents(tenantId, { limit: 8 }),
          ])
        : ([
            [],
            config.usageDashboards.find((x) => x?.tenantId === tenantId) ??
              null,
            null,
            config.auditEvents,
          ] as any),
    [] as any,
  );
  const [members, usage, health, audit] = r.data;
  const cacheMetric = calculateCacheMetric({
    inputTokens: Number(usage?.totals?.inputTokens ?? 0),
    cacheReadTokens: Number(usage?.performance?.cacheReadTokens ?? 0),
    cacheEligibleRequests: Number(usage?.performance?.cacheEligibleRequests ?? 0),
    cacheHitRequests: Number(usage?.performance?.cacheHitRequests ?? 0),
  });
  return (
    <ManagementPage
      title="Overview"
      description="Operational health, adoption, spend, and recent administration activity."
      eyebrow="Organization administration"
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
        empty={!r.loading && !usage}
        emptyTitle="Overview data unavailable"
        emptyText="Connect the organization API to load operational health, adoption, and spend."
      >
        {usage ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Active members",
                  value: formatNumber(
                    members.length
                      ? members.filter((m: any) => m.status === "active").length
                      : (usage.byUser ?? []).filter((u: any) => u.userId)
                          .length,
                  ),
                },
                {
                  label: "Billed spend",
                  value: formatMoney(
                    usage.totals?.billedCostMicros ??
                      usage.totals?.costBilledMicros,
                  ),
                },
                {
                  label: "Requests",
                  value: formatNumber(usage.totals?.requests ?? 0),
                },
                {
                  label: "Successful requests",
                  value:
                    usage.totals?.successRate == null
                      ? "—"
                      : `${Math.round(usage.totals.successRate * 100)}%`,
                  status:
                    (usage.totals?.successRate ?? 1) < 0.9 ? "warning" : "good",
                },
                {
                  label: "Input tokens",
                  value: formatNumber(usage.totals?.inputTokens ?? 0),
                },
                {
                  label: cacheMetric.label,
                  value: cacheMetric.value == null ? "—" : `${Math.round(cacheMetric.value * 100)}%`,
                  hint: cacheMetric.hint,
                },
                {
                  label: "Cache-read tokens",
                  value: formatNumber(usage.performance?.cacheReadTokens ?? 0),
                },
                {
                  label: "P95 latency",
                  value: usage.performance?.latencyP95Ms == null ? "—" : `${Math.round(usage.performance.latencyP95Ms)} ms`,
                },
              ]}
            />
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Spend and request trend">
                <DualTrend
                  label="Billed spend"
                  points={(usage.series ?? usage.burnDown ?? []).map(
                    (x: any) => ({
                      label: (x.ts ?? x.date).slice(0, 10),
                      spend:
                        Number(x.billedCostMicros ?? x.costBilledMicros) / 1e6,
                      requests: Number(x.requests ?? 0),
                    }),
                  )}
                  spendFormat={(v) => formatMoney(v * 1e6)}
                />
              </Section>
              <Section title="System health">
                <div className="grid divide-y divide-border [&>p]:flex [&>p]:items-center [&>p]:justify-between [&>p]:gap-4 [&>p]:py-2.5 [&_span]:text-xs [&_span]:text-muted-foreground">
                  <p>
                    <StatusPill
                      tone={health?.status === "healthy" ? "good" : "warning"}
                    >
                      {health?.status ?? "Demo"}
                    </StatusPill>
                    <span>Billing and reservations</span>
                  </p>
                  <p>
                    <StatusPill tone="good">Healthy</StatusPill>
                    <span>Usage ingestion</span>
                  </p>
                  <p>
                    <StatusPill tone="good">Healthy</StatusPill>
                    <span>Audit chain</span>
                  </p>
                </div>
              </Section>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Request outcomes">
                <OutcomeBars
                  points={(usage.series ?? usage.burnDown ?? []).map(
                    (x: any) => ({
                      label: (x.ts ?? x.date).slice(0, 10),
                      successes: Number(x.successes ?? x.requests ?? 0),
                      failures: Number(x.failures ?? 0),
                    }),
                  )}
                />
              </Section>
              <Section title="Adoption and reliability">
                <HealthRings
                  successRate={
                    usage.totals?.successRate ??
                    derivedSuccessRate(usage.series ?? usage.burnDown ?? [])
                  }
                  cacheRate={cacheMetric.value}
                  attributionRate={
                    (usage.totals?.requests ?? 0) > 0
                      ? (
                          usage.breakdowns?.members ??
                          usage.breakdowns?.users ??
                          usage.byUser ??
                          []
                        ).reduce(
                          (sum: number, row: any) =>
                            sum +
                            (row.id == null && row.userId == null
                              ? 0
                              : Number(row.requests ?? 0)),
                          0,
                        ) / usage.totals.requests
                      : null
                  }
                />
              </Section>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Model request mix">
                <BreakdownBars
                  label="Requests"
                  rows={(
                    usage.breakdowns?.models ??
                    usage.byModel ??
                    []
                  ).map((row: any) => ({
                    label: row.label ?? row.model ?? "Unknown",
                    value: Number(row.requests ?? 0),
                  }))}
                />
              </Section>
              <Section title="Department spend">
                <BreakdownBars
                  label="Billed spend"
                  rows={(
                    usage.breakdowns?.departments ??
                    usage.byDepartment ??
                    []
                  ).map((row: any) => ({
                    label:
                      row.label ?? row.departmentId ?? "Unattributed",
                    value:
                      Number(
                        row.billedCostMicros ?? row.costBilledMicros ?? 0,
                      ) / 1e6,
                  }))}
                  format={(value) => formatMoney(value * 1e6)}
                />
              </Section>
            </div>
            <Section title="Recent admin activity">
              <DataTable
                label="Recent activity"
                columns={["Action", "Actor", "When"]}
                rows={audit.map((x: any) => [
                  <b>{human(x.action)}</b>,
                  x.actorUserId ?? "System",
                  formatDateTime(x.ts ?? x.createdAt),
                ])}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
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
function human(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
