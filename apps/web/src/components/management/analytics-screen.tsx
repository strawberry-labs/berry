import * as React from "react";
import { Download, X } from "lucide-react";
import type { UsageAnalyticsQuery, UsageRequestDetail } from "@berry/shared";
import {
  AsyncState,
  Button,
  DataTable,
  DetailDrawer,
  Input,
  ManagementPage,
  MetricGrid,
  Section,
  StatusPill,
  Toolbar,
  formatMoney,
  formatNumber,
} from "./management-primitives";
import {
  BreakdownBars,
  DualTrend,
  HealthRings,
  OutcomeBars,
} from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";

const VIEWS = [
  "overview",
  "people",
  "models",
  "agents",
  "requests",
  "reports",
] as const;
type View = (typeof VIEWS)[number];

export function AnalyticsScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const search = React.useMemo(
    () =>
      new URLSearchParams(
        typeof location === "undefined" ? "" : location.search,
      ),
    [],
  );
  const [view, setView] = React.useState<View>(
    VIEWS.find((item) => item === search.get("view")) ?? "overview",
  );
  const [range, setRange] = React.useState({
    from: (
      search.get("from") ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    ).slice(0, 10),
    to: (search.get("to") ?? new Date().toISOString()).slice(0, 10),
  });
  const query: UsageAnalyticsQuery = {
    from: `${range.from}T00:00:00.000Z`,
    to: `${range.to}T23:59:59.999Z`,
    limit: 50,
  };
  const analytics = useResource(
    `analytics:${tenantId}:${query.from}:${query.to}`,
    async () =>
      client
        ? client.usageAnalytics(tenantId, query)
        : demoAnalytics(
            config.usageDashboards.find((item) => item.tenantId === tenantId),
          ),
    null as any,
  );
  const requests = useResource(
    `requests:${tenantId}:${query.from}:${query.to}`,
    async () =>
      client && view === "requests"
        ? client.usageRequests(tenantId, query)
        : null,
    null as any,
  );
  const savedViews = useResource(
    `analytics-views:${tenantId}`,
    async () =>
      client && view === "reports" ? client.savedAnalyticsViews(tenantId) : [],
    [] as any[],
  );
  const [detail, setDetail] = React.useState<UsageRequestDetail | null>(null);

  function update(nextView: View, nextRange = range) {
    setView(nextView);
    setRange(nextRange);
    const params = new URLSearchParams();
    params.set("view", nextView);
    params.set("from", `${nextRange.from}T00:00:00.000Z`);
    params.set("to", `${nextRange.to}T23:59:59.999Z`);
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }
  async function openRequest(requestId: string) {
    if (client) setDetail(await client.usageRequestDetail(tenantId, requestId));
  }
  const data = analytics.data;
  const attributedRequests = data
    ? (data.breakdowns.members ?? data.breakdowns.users ?? []).reduce(
        (sum: number, row: any) =>
          sum + (row.id == null ? 0 : Number(row.requests)),
        0,
      )
    : 0;
  const cacheReuseRate =
    data && data.totals.tokens > 0
      ? Math.min(1, data.performance.cacheReadTokens / data.totals.tokens)
      : null;

  return (
    <ManagementPage
      title="Analytics"
      description="Operational billed usage, adoption, performance, request attribution, and explainable anomalies."
      eyebrow="Finance"
      actions={
        permissions.includes("usage:export") ? (
          <Button
            variant="secondary"
            disabled={!client}
            onClick={() =>
              client
                ?.exportUsageCsv(tenantId, query)
                .then((csv) => download(csv, "organization-usage.csv"))
            }
          >
            <Download />
            Export CSV
          </Button>
        ) : null
      }
    >
      <Toolbar>
        <div
          className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1"
          role="tablist"
          aria-label="Analytics view"
        >
          {VIEWS.map((item) => (
            <Button
              key={item}
              variant="ghost"
              role="tab"
              aria-selected={view === item}
              onClick={() => update(item)}
            >
              {label(item)}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground">
          <label>
            From
            <Input
              type="date"
              value={range.from}
              onChange={(event) =>
                update(view, { ...range, from: event.currentTarget.value })
              }
            />
          </label>
          <label>
            To
            <Input
              type="date"
              value={range.to}
              onChange={(event) =>
                update(view, { ...range, to: event.currentTarget.value })
              }
            />
          </label>
        </div>
      </Toolbar>
      <AsyncState
        loading={analytics.loading}
        error={analytics.error}
        onRetry={analytics.retry}
        empty={!data || data.totals.requests === 0}
        emptyTitle="No usage in this period"
      >
        {data ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Billed spend",
                  value: formatMoney(data.totals.billedCostMicros),
                },
                {
                  label: "Requests",
                  value: formatNumber(data.totals.requests),
                },
                { label: "Tokens", value: formatNumber(data.totals.tokens) },
                {
                  label: "Success rate",
                  value:
                    data.totals.successRate == null
                      ? "—"
                      : `${Math.round(data.totals.successRate * 100)}%`,
                  status:
                    (data.totals.successRate ?? 1) < 0.9 ? "warning" : "good",
                },
              ]}
            />
            {data.unavailableDimensions.length ? (
              <p
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                Partially unavailable:{" "}
                {data.unavailableDimensions.map(label).join(", ")}.
              </p>
            ) : null}
            {data.anomalies.length ? (
              <Section
                title="Needs attention"
                description="Each anomaly compares the observed value with its stated baseline."
              >
                {data.anomalies.map((item: any) => (
                  <article
                    className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground"
                    key={item.id}
                  >
                    <StatusPill
                      tone={item.severity === "error" ? "danger" : "warning"}
                    >
                      {item.severity}
                    </StatusPill>
                    <div>
                      <b>{item.label}</b>
                      <p>{item.explanation}</p>
                      <small>
                        Baseline {item.baseline} · observed {item.observed}{" "}
                        {item.unit} · {item.dimension.label}
                      </small>
                    </div>
                  </article>
                ))}
              </Section>
            ) : null}
            {view === "overview" ? (
              <>
                <Section title="Spend and request trend">
                  <DualTrend
                    label="Billed spend"
                    points={data.series.map((point: any) => ({
                      label: point.ts.slice(0, 10),
                      spend: Number(point.billedCostMicros) / 1e6,
                      requests: Number(point.requests ?? 0),
                    }))}
                    spendFormat={(value) => formatMoney(value * 1e6)}
                  />
                </Section>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Section
                    title="Request outcomes"
                    description="Successful and failed requests by day reveal reliability shifts before they become aggregate incidents."
                  >
                    <OutcomeBars
                      points={data.series.map((point: any) => ({
                        label: point.ts.slice(0, 10),
                        successes: Number(point.successes ?? 0),
                        failures: Number(point.failures ?? 0),
                      }))}
                    />
                  </Section>
                  <Section
                    title="Quality signals"
                    description="Hover each ring to compare reliability, cache reuse, and request attribution."
                  >
                    <HealthRings
                      successRate={data.totals.successRate}
                      cacheRate={cacheReuseRate}
                      attributionRate={
                        data.totals.requests
                          ? attributedRequests / data.totals.requests
                          : null
                      }
                    />
                  </Section>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Section title="Department spend concentration">
                    <BreakdownBars
                      label="Billed spend"
                      rows={(data.breakdowns.departments ?? []).map(
                        (row: any) => ({
                          label: row.label,
                          value: Number(row.billedCostMicros) / 1e6,
                        }),
                      )}
                      format={(value) => formatMoney(value * 1e6)}
                    />
                  </Section>
                  <Section title="Model request mix">
                    <BreakdownBars
                      label="Requests"
                      rows={(data.breakdowns.models ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.requests),
                      }))}
                    />
                  </Section>
                </div>
                <Breakdown
                  title="Top departments"
                  rows={data.breakdowns.departments ?? []}
                />
                <Breakdown
                  title="Top members"
                  rows={data.breakdowns.members ?? data.breakdowns.users ?? []}
                />
              </>
            ) : null}
            {view === "people" ? (
              <>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Section title="Member spend">
                    <BreakdownBars
                      label="Billed spend"
                      rows={(
                        data.breakdowns.members ??
                        data.breakdowns.users ??
                        []
                      ).map((row: any) => ({
                        label: row.label,
                        value: Number(row.billedCostMicros) / 1e6,
                      }))}
                      format={(value) => formatMoney(value * 1e6)}
                    />
                  </Section>
                  <Section title="Department adoption">
                    <BreakdownBars
                      label="Requests"
                      rows={(data.breakdowns.departments ?? []).map(
                        (row: any) => ({
                          label: row.label,
                          value: Number(row.requests),
                        }),
                      )}
                    />
                  </Section>
                </div>
                <Breakdown
                  title="People"
                  rows={data.breakdowns.members ?? data.breakdowns.users ?? []}
                />
                <Breakdown
                  title="Departments"
                  rows={data.breakdowns.departments ?? []}
                />
              </>
            ) : null}
            {view === "models" ? (
              <>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Section title="Model spend">
                    <BreakdownBars
                      label="Billed spend"
                      rows={(data.breakdowns.models ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.billedCostMicros) / 1e6,
                      }))}
                      format={(value) => formatMoney(value * 1e6)}
                    />
                  </Section>
                  <Section title="Provider traffic">
                    <BreakdownBars
                      label="Requests"
                      rows={(data.breakdowns.providers ?? []).map(
                        (row: any) => ({
                          label: row.label,
                          value: Number(row.requests),
                        }),
                      )}
                    />
                  </Section>
                </div>
                <Breakdown
                  title="Models"
                  rows={data.breakdowns.models ?? []}
                  performance
                />
                <Breakdown
                  title="Features"
                  rows={data.breakdowns.features ?? []}
                  performance
                />
                <Section title="Performance">
                  <MetricGrid
                    items={[
                      {
                        label: "P50 latency",
                        value: duration(data.performance.latencyP50Ms),
                      },
                      {
                        label: "P95 latency",
                        value: duration(data.performance.latencyP95Ms),
                      },
                      {
                        label: "P50 TTFT",
                        value: duration(data.performance.ttftP50Ms),
                      },
                      {
                        label: "Cached tokens",
                        value: formatNumber(data.performance.cachedTokens),
                      },
                    ]}
                  />
                </Section>
              </>
            ) : null}
            {view === "agents" ? (
              <>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Section title="Agent traffic">
                    <BreakdownBars
                      label="Requests"
                      rows={(data.breakdowns.agents ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.requests),
                      }))}
                    />
                  </Section>
                  <Section title="Workspace spend">
                    <BreakdownBars
                      label="Billed spend"
                      rows={(data.breakdowns.workspaces ?? []).map(
                        (row: any) => ({
                          label: row.label,
                          value: Number(row.billedCostMicros) / 1e6,
                        }),
                      )}
                      format={(value) => formatMoney(value * 1e6)}
                    />
                  </Section>
                </div>
                <Breakdown
                  title="Agents"
                  rows={data.breakdowns.agents ?? []}
                  performance
                />
                <Breakdown
                  title="Workspaces"
                  rows={data.breakdowns.workspaces ?? []}
                />
                <Section title="Sandbox activity">
                  <MetricGrid
                    items={[
                      {
                        label: "Sandbox minutes",
                        value: formatNumber(
                          Math.round(data.performance.sandboxMinutes),
                        ),
                      },
                      {
                        label: "Attributed requests",
                        value: formatNumber(
                          (data.breakdowns.agents ?? []).reduce(
                            (sum: number, row: any) => sum + row.requests,
                            0,
                          ),
                        ),
                      },
                    ]}
                  />
                </Section>
              </>
            ) : null}
            {view === "requests" ? (
              <AsyncState
                loading={requests.loading}
                error={requests.error}
                onRetry={requests.retry}
                empty={!requests.data?.items.length}
              >
                <DataTable
                  label="Redacted request records"
                  columns={[
                    "Time",
                    "Request",
                    "Feature",
                    "Model",
                    "Status",
                    "Tokens",
                    "Billed",
                    "Latency",
                    "Reservation",
                  ]}
                  rows={(requests.data?.items ?? []).map((row: any) => [
                    new Date(row.ts).toLocaleString(),
                    <Button
                      variant="ghost"
                      className="grid h-auto max-w-80 justify-start gap-0.5 p-0 text-left [&_b]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"
                      onClick={() => openRequest(row.requestId)}
                    >
                      <b>{row.requestId}</b>
                      <small>
                        {row.agentId ?? row.workspaceId ?? "Unattributed"}
                      </small>
                    </Button>,
                    row.feature,
                    row.model ?? "—",
                    <StatusPill
                      tone={
                        ["completed", "success", "succeeded"].includes(
                          row.status,
                        )
                          ? "good"
                          : "danger"
                      }
                    >
                      {row.status}
                    </StatusPill>,
                    formatNumber(row.tokensIn + row.tokensOut),
                    formatMoney(row.billedCostMicros),
                    duration(row.latencyMs),
                    row.reservationStatus ?? "—",
                  ])}
                />
              </AsyncState>
            ) : null}
            {view === "reports" ? (
              <Section
                title="Saved analytic views"
                description="Schedules and delivery configuration live under Reports & alerts."
              >
                <DataTable
                  label="Saved views"
                  columns={["Name", "Visibility", "Owner", "Updated"]}
                  rows={savedViews.data.map((row: any) => [
                    row.name,
                    row.visibility,
                    row.ownerUserId,
                    new Date(row.updatedAt).toLocaleString(),
                  ])}
                />
              </Section>
            ) : null}
          </>
        ) : null}
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={detail.requestId}
          subtitle="Redacted request"
          onClose={() => setDetail(null)}
        >
          {
            <dl>
              {Object.entries(detail)
                .filter(([key]) => !["safeMetadata"].includes(key))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{label(key)}</dt>
                    <dd>{value == null ? "—" : String(value)}</dd>
                  </div>
                ))}
            </dl>
          }
          <Section title="Safe metadata">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-transparent font-mono text-xs leading-5 text-muted-foreground">
              {JSON.stringify(detail.safeMetadata, null, 2)}
            </pre>
          </Section>
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Prompts, responses, credentials, signatures, and unrestricted
            metadata are never returned by this endpoint.
          </p>
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}

function Breakdown({
  title,
  rows,
  performance = false,
}: {
  title: string;
  rows: any[];
  performance?: boolean;
}) {
  return (
    <Section title={title}>
      <DataTable
        label={title}
        columns={[
          title.slice(0, -1),
          "Requests",
          "Tokens",
          "Billed",
          ...(performance ? ["Error rate", "P95 latency"] : []),
        ]}
        rows={rows.map((row) => [
          row.label,
          formatNumber(row.requests),
          formatNumber(row.tokens),
          formatMoney(row.billedCostMicros),
          ...(performance
            ? [
                row.errorRate == null
                  ? "—"
                  : `${Math.round(row.errorRate * 100)}%`,
                duration(row.latencyP95Ms),
              ]
            : []),
        ])}
      />
    </Section>
  );
}
function duration(value: number | null) {
  return value == null
    ? "—"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(1)} s`;
}
function label(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function download(value: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([value], { type: "text/csv" }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}
function demoAnalytics(dashboard: any) {
  if (!dashboard) return null;
  const totalRequests = Number(dashboard.totals.requests);
  const totalTokens =
    Number(dashboard.totals.tokensIn) + Number(dashboard.totals.tokensOut);
  const totalSpend = Number(dashboard.totals.costBilledMicros);
  const row = (dimension: string, item: any) => ({
    dimension,
    id: item[`${dimension}Id`] ?? item.model ?? item.feature ?? null,
    label:
      item.model ??
      item.feature ??
      item.userId ??
      item.departmentId ??
      "Unattributed",
    billedCostMicros: item.costBilledMicros,
    requests: item.requests,
    tokens: item.tokens,
    errorRate: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
  });
  const demoRow = (
    dimension: string,
    id: string,
    displayLabel: string,
    share: number,
    latencyP50Ms: number,
    latencyP95Ms: number,
  ) => ({
    dimension,
    id,
    label: displayLabel,
    billedCostMicros: String(Math.round(totalSpend * share)),
    requests: Math.round(totalRequests * share),
    tokens: Math.round(totalTokens * share),
    errorRate: Number((0.018 + (1 - share) * 0.012).toFixed(3)),
    latencyP50Ms,
    latencyP95Ms,
  });
  return {
    tenantId: dashboard.tenantId,
    from: dashboard.from,
    to: dashboard.to,
    totals: {
      billedCostMicros: dashboard.totals.costBilledMicros,
      requests: dashboard.totals.requests,
      tokens: dashboard.totals.tokensIn + dashboard.totals.tokensOut,
      successRate: 0.963,
      projectedMonthEndMicros: dashboard.totals.costBilledMicros,
    },
    series: dashboard.burnDown.map((item: any) => ({
      ts: `${item.date}T00:00:00.000Z`,
      billedCostMicros: item.costBilledMicros,
      requests: item.requests,
      tokens: 0,
      successes: Math.round(item.requests * 0.963),
      failures: item.requests - Math.round(item.requests * 0.963),
    })),
    breakdowns: {
      models: dashboard.byModel.map((item: any) => row("model", item)),
      features: dashboard.byFeature.map((item: any) => row("feature", item)),
      users: dashboard.byUser.map((item: any) => row("user", item)),
      members: dashboard.byUser.map((item: any) => row("user", item)),
      departments: dashboard.byDepartment.map((item: any) =>
        row("department", item),
      ),
      providers: [
        demoRow("provider", "berry-router", "Berry Router", 0.72, 690, 1_820),
        demoRow("provider", "direct", "Direct providers", 0.28, 810, 2_240),
      ],
      agents: [
        demoRow("agent", "coding", "Coding agent", 0.57, 740, 1_960),
        demoRow("agent", "research", "Research agent", 0.29, 860, 2_380),
        demoRow("agent", "assistant", "General assistant", 0.14, 510, 1_340),
      ],
      workspaces: [
        demoRow("workspace", "product", "Product workspace", 0.54, 710, 1_900),
        demoRow("workspace", "operations", "Operations", 0.28, 820, 2_180),
        demoRow("workspace", "personal", "Personal", 0.18, 560, 1_470),
      ],
    },
    performance: {
      latencyP50Ms: 740,
      latencyP95Ms: 2_080,
      ttftP50Ms: 310,
      ttftP95Ms: 890,
      cachedTokens: Math.round(totalTokens * 0.31),
      cacheReadTokens: Math.round(totalTokens * 0.26),
      cacheWriteTokens: Math.round(totalTokens * 0.05),
      sandboxMinutes: 184,
    },
    anomalies: [
      {
        id: "demo-spend-acceleration",
        kind: "spend",
        severity: "warning",
        label: "Daily spend accelerated",
        baseline: Math.round(totalSpend / 1e6 / 4),
        observed: Math.round(totalSpend / 1e6 / 3),
        unit: "USD",
        windowStart: dashboard.from,
        windowEnd: dashboard.to,
        dimension: {
          kind: "workspace",
          id: "product",
          label: "Product workspace",
        },
        explanation:
          "Product workspace spend is above its recent daily baseline, led by longer coding-agent sessions.",
      },
    ],
    unavailableDimensions: [],
  };
}
