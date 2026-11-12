import * as React from "react";
import { Download, Filter } from "lucide-react";
import type { UsageAnalyticsQuery, UsageRequestDetail } from "@berry/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@berry/desktop-ui/components/ui/popover";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  FormSelect,
  InlineNotice,
  ManagementPage,
  MetricGrid,
  Num,
  Section,
  SegmentedControl,
  StatusPill,
  formatCompact,
  formatCompactMoney,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatMoneyWithCents,
  formatNumber,
  formatPercent,
} from "./management-primitives";
import {
  BreakdownBars,
  DualTrend,
  HealthRings,
  OutcomeBars,
  ShareDonut,
  aggregateModelSpendRows,
} from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";
import {
  calculateCacheMetric,
  downloadUsageCsv,
  usageCsvFilter,
  usageReportBounds,
  validDateInput,
  usageTokenBreakdown,
  inferUsageRangePreset,
  UsageRangeControl,
  formatUsageLabel as label,
  usageRangeForPreset,
  type UsageDateRange,
  type UsageRangePreset,
} from "./usage-controls";

const AnalyticsRequests = React.lazy(async () => ({ default: (await import("./analytics-requests")).AnalyticsRequests }));

const VIEWS = ["overview", "people", "models", "agents", "requests"] as const;
type View = (typeof VIEWS)[number];

type UsageFilters = {
  memberId: string;
  departmentId: string;
  model: string;
  provider: string;
  feature: string;
  status: string;
};

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
  const initialRange = React.useMemo<UsageDateRange>(() => {
    const preset = usageRangeForPreset("month-to-date", new Date(), undefined, "UTC");
    const from = search.get("from")?.slice(0, 10) ?? preset.from;
    const to = search.get("to")?.slice(0, 10) ?? preset.to;
    return validDateInput(from) && validDateInput(to) && from <= to ? { from, to } : preset;
  }, [search]);
  const [range, setRange] = React.useState(initialRange);
  const [rangePreset, setRangePreset] = React.useState<UsageRangePreset>(() => inferUsageRangePreset(initialRange));
  const [filters, setFilters] = React.useState<UsageFilters>({
    memberId: search.get("memberId") ?? "",
    departmentId: search.get("departmentId") ?? "",
    model: search.get("model") ?? "",
    provider: search.get("provider") ?? "",
    feature: search.get("feature") ?? "",
    status: search.get("status") ?? "",
  });
  const bounds = React.useMemo(() => usageReportBounds(range), [range]);
  const query: UsageAnalyticsQuery = {
    ...bounds,
    ...Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value.length > 0),
    ),
    limit: 50,
  } as UsageAnalyticsQuery;
  const queryKey = JSON.stringify(query);
  const hasUsageFilters = Object.values(filters).some(Boolean);
  const facetQuery: UsageAnalyticsQuery = {
    from: query.from,
    to: query.to,
    limit: 50,
  };
  const analytics = useResource(
    `analytics:${tenantId}:${queryKey}`,
    async (signal) =>
      client
        ? client.usageAnalytics(tenantId, query, signal ? { signal } : {})
        : demoAnalytics(
            config.usageDashboards.find((item) => item.tenantId === tenantId),
          ),
    null as any,
  );
  const facetAnalytics = useResource(
    `analytics-facets:${tenantId}:${range.from}:${range.to}:${hasUsageFilters}`,
    async (signal) => client && hasUsageFilters
      ? client.usageAnalytics(tenantId, facetQuery, signal ? { signal } : {})
      : null,
    null as any,
  );
  const directory = useResource(
    `usage-directory:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listOrgMembers(tenantId),
            client.listDepartments(tenantId),
          ])
        : [[], config.departments.filter((item) => item.tenantId === tenantId)],
    [[], []] as any,
  );
  const [detail, setDetail] = React.useState<UsageRequestDetail | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState("");

  function update(
    nextView: View,
    nextRange = range,
    nextFilters = filters,
  ) {
    setView(nextView);
    setRange(nextRange);
    setFilters(nextFilters);
    setExportError("");
    const params = new URLSearchParams();
    params.set("view", nextView);
    params.set("from", `${nextRange.from}T00:00:00.000Z`);
    params.set("to", `${nextRange.to}T23:59:59.999Z`);
    for (const [key, value] of Object.entries(nextFilters)) {
      if (value) params.set(key, value);
    }
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }
  async function exportCsv() {
    if (!client) return;
    setExportError("");
    setExporting(true);
    try {
      downloadUsageCsv(await client.exportUsageCsv(tenantId, usageCsvFilter(query)), "organization-usage.csv");
    } catch {
      setExportError("Usage could not be exported. Try again.");
    } finally {
      setExporting(false);
    }
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
  const cacheMetric = calculateCacheMetric({
    inputTokens: Number(data?.totals.inputTokens ?? 0),
    cacheReadTokens: Number(data?.performance.cacheReadTokens ?? 0),
    cacheEligibleRequests: Number(data?.performance.cacheEligibleRequests ?? 0),
    cacheHitRequests: Number(data?.performance.cacheHitRequests ?? 0),
  });
  const cacheHitRate = cacheMetric.value;
  const totalTokens = Number(data?.totals.tokens ?? 0) || Number(data?.totals.inputTokens ?? 0) + Number(data?.totals.outputTokens ?? 0);
  const memberRows: any[] = data?.breakdowns.members ?? data?.breakdowns.users ?? [];
  const [members, departments] = directory.data as [any[], any[]];
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <ManagementPage width="wide"
      title="Usage"
      description={range.from + " to " + range.to + " (UTC)"}
      eyebrow="Usage & billing"
      actions={
        <>
          <UsageRangeControl
            preset={rangePreset}
            range={range}
            onChange={(nextPreset, nextRange) => {
              setRangePreset(nextPreset);
              update(view, nextRange, filters);
            }}
          />
          <UsageFiltersPopover
            filters={filters}
            activeCount={activeFilterCount}
            members={members}
            departments={departments}
            data={facetAnalytics.data ?? data}
            onApply={(nextFilters) => update(view, range, nextFilters)}
            onClear={() => update(view, range, emptyUsageFilters())}
          />
          {permissions.includes("usage:export") ? (
          <Button
            variant="secondary"
            disabled={!client || exporting}
            onClick={() => void exportCsv()}
          >
            <Download />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          ) : null}
        </>
      }
    >
      {exportError ? <InlineNotice tone="warning">{exportError}</InlineNotice> : null}
      <SegmentedControl
        label="Analytics view"
        value={view}
        onChange={(next) => update(next)}
        options={VIEWS.map((item) => ({ value: item, label: label(item) }))}
      />
      <AsyncState
        loading={analytics.loading}
        error={analytics.error}
        onRetry={analytics.retry}
        empty={!data || data.totals.requests === 0}
        emptyTitle="No usage in this period"
        emptyText="Widen the date range or clear the filters to see activity."
      >
        {data ? (
          <>
            {data.unavailableDimensions.length ? (
              <InlineNotice tone="info">
                Some breakdowns are unavailable for this range:{" "}
                {data.unavailableDimensions.map(label).join(", ")}.
              </InlineNotice>
            ) : null}
            {view === "overview" ? (
              <>
                <MetricGrid
                  items={[
                    {
                      label: "Billed spend",
                      value: formatMoneyWithCents(data.totals.billedCostMicros),
                      trend: data.series.map((point: any) => Number(point.billedCostMicros) / 1e6),
                      ...(rangePreset === "month-to-date" && data.totals.projectedMonthEndMicros
                        ? { hint: `Projected ${formatCompactMoney(data.totals.projectedMonthEndMicros)} by month end` }
                        : {}),
                    },
                    {
                      label: "Requests",
                      value: formatCompact(data.totals.requests),
                      exactValue: formatNumber(data.totals.requests),
                      trend: data.series.map((point: any) => Number(point.requests ?? 0)),
                      hint: `${formatCompactMoney(Number(data.totals.billedCostMicros) / Math.max(1, data.totals.requests) * 1000)} per 1K requests`,
                    },
                    {
                      label: "Tokens",
                      value: formatCompact(totalTokens),
                      exactValue: formatNumber(totalTokens),
                      trend: data.series.map((point: any) => Number(point.tokens ?? 0)),
                      hint: `${formatCompact(data.totals.inputTokens)} in · ${formatCompact(data.totals.outputTokens)} out`,
                    },
                    {
                      label: "Success rate",
                      value: formatPercent(data.totals.successRate),
                      status: (data.totals.successRate ?? 1) < 0.95 ? "warning" : "good",
                      trend: data.series.map((point: any) => {
                        const total = Number(point.successes ?? 0) + Number(point.failures ?? 0);
                        return total > 0 ? Number(point.successes ?? 0) / total : 1;
                      }),
                      hint: `P95 latency ${formatDuration(data.performance.latencyP95Ms)}`,
                    },
                  ]}
                />
                {data.anomalies.length ? (
                  <div className="grid gap-2">
                    {data.anomalies.map((item: any) => (
                      <InlineNotice
                        key={item.id}
                        tone={item.severity === "error" ? "danger" : item.severity === "info" ? "info" : "warning"}
                        title={`${item.label} · ${item.dimension.label}`}
                      >
                        {item.explanation}{" "}
                        <span className="whitespace-nowrap">
                          Observed {formatCompact(item.observed)} {item.unit} against a baseline of {formatCompact(item.baseline)}.
                        </span>
                      </InlineNotice>
                    ))}
                  </div>
                ) : null}
                <Section title="Spend and requests" description="Daily billed spend beside request volume for the selected range.">
                  <DualTrend
                    label="Billed spend"
                    points={data.series.map((point: any) => ({
                      label: point.ts,
                      spend: Number(point.billedCostMicros) / 1e6,
                      requests: Number(point.requests ?? 0),
                    }))}
                    spendFormat={(value) => formatMoney(value * 1e6)}
                  />
                </Section>
                <div className="grid gap-5 xl:grid-cols-2">
                  <Section title="Token volume" description="Where the tokens went. Cache reads are billed at a fraction of fresh input.">
                    <ShareDonut
                      caption="Token volume by type"
                      centerLabel="Tokens"
                      rows={usageTokenBreakdown(
                        data.totals.inputTokens, data.totals.outputTokens,
                        data.performance.cacheReadTokens, data.performance.cacheWriteTokens,
                      )}
                      format={formatCompact}
                    />
                  </Section>
                  <Section title="Reliability" description="Share of requests that failed each day.">
                    <OutcomeBars
                      points={data.series.map((point: any) => ({
                        label: point.ts,
                        successes: Number(point.successes ?? 0),
                        failures: Number(point.failures ?? 0),
                      }))}
                    />
                  </Section>
                </div>
                <div className="grid gap-5 xl:grid-cols-2">
                  <Section title="Spend by department">
                    <BreakdownBars
                      label="Department"
                      rows={(data.breakdowns.departments ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.billedCostMicros) / 1e6,
                      }))}
                      format={(value) => formatCompactMoney(value * 1e6)}
                      limit={6}
                    />
                  </Section>
                  <Section title="Spend by model">
                    <ShareDonut
                      caption="Spend by model"
                      centerLabel="Spend"
                      rows={aggregateModelSpendRows(
                        (data.breakdowns.models ?? []).map((row: any) => ({
                          label: row.label,
                          value: Number(row.billedCostMicros) / 1e6,
                        })),
                        6,
                      )}
                      format={(value) => formatCompactMoney(value * 1e6)}
                    />
                  </Section>
                </div>
                <Section title="Efficiency" description="Cache reuse and attribution show how much of the volume is working for you.">
                  <div className="grid items-center gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                    <HealthRings
                      successRate={data.totals.successRate}
                      cacheRate={cacheHitRate}
                      attributionRate={data.totals.requests ? attributedRequests / data.totals.requests : null}
                    />
                    <DefinitionList
                      items={[
                        { term: cacheMetric.label, detail: <>{formatPercent(cacheHitRate)} <span className="text-muted-foreground">· {cacheMetric.hint}</span></> },
                        { term: "Cache-write tokens", detail: <Num value={data.performance.cacheWriteTokens} /> },
                        { term: "Latency", detail: <>{formatDuration(data.performance.latencyP50Ms)} median <span className="text-muted-foreground">· {formatDuration(data.performance.latencyP95Ms)} P95</span></> },
                        { term: "Time to first token", detail: <>{formatDuration(data.performance.ttftP50Ms)} median <span className="text-muted-foreground">· {formatDuration(data.performance.ttftP95Ms)} P95</span></> },
                      ]}
                    />
                  </div>
                </Section>
              </>
            ) : null}
            {view === "people" ? (
              <>
                <div className="grid gap-5 xl:grid-cols-2">
                  <Section title="Top spenders">
                    <BreakdownBars
                      label="Member"
                      rows={memberRows.filter((row: any) => row.id != null).map((row: any) => ({
                        label: row.name ?? row.label,
                        value: Number(row.billedCostMicros) / 1e6,
                      }))}
                      format={(value) => formatCompactMoney(value * 1e6)}
                    />
                  </Section>
                  <Section title="Requests by department">
                    <BreakdownBars
                      label="Department"
                      rows={(data.breakdowns.departments ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.requests),
                      }))}
                      format={formatCompact}
                    />
                  </Section>
                </div>
                <Breakdown title="Members" noun="Member" rows={memberRows} />
                <Breakdown title="Departments" noun="Department" rows={data.breakdowns.departments ?? []} />
              </>
            ) : null}
            {view === "models" ? (
              <>
                <MetricGrid
                  compact
                  items={[
                    { label: "Median latency", value: formatDuration(data.performance.latencyP50Ms) },
                    { label: "P95 latency", value: formatDuration(data.performance.latencyP95Ms) },
                    { label: "Median time to first token", value: formatDuration(data.performance.ttftP50Ms) },
                    { label: "P95 time to first token", value: formatDuration(data.performance.ttftP95Ms) },
                  ]}
                />
                <div className="grid gap-5 xl:grid-cols-2">
                  <Section title="Spend by model">
                    <ShareDonut
                      caption="Spend by model"
                      centerLabel="Spend"
                      rows={aggregateModelSpendRows(
                        (data.breakdowns.models ?? []).map((row: any) => ({
                          label: row.label,
                          value: Number(row.billedCostMicros) / 1e6,
                        })),
                        6,
                      )}
                      format={(value) => formatCompactMoney(value * 1e6)}
                    />
                  </Section>
                  <Section title="Requests by provider">
                    <BreakdownBars
                      label="Provider"
                      rows={(data.breakdowns.providers ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.requests),
                      }))}
                      format={formatCompact}
                    />
                  </Section>
                </div>
                <Breakdown title="Models" noun="Model" rows={data.breakdowns.models ?? []} performance />
                <Breakdown title="Features" noun="Feature" rows={data.breakdowns.features ?? []} performance />
              </>
            ) : null}
            {view === "agents" ? (
              <>
                <MetricGrid
                  compact
                  items={[
                    {
                      label: "Agent requests",
                      value: formatCompact((data.breakdowns.agents ?? []).reduce((sum: number, row: any) => sum + row.requests, 0)),
                    },
                    { label: "Sandbox time", value: `${formatCompact(Math.round(data.performance.sandboxMinutes / 60))} h`, exactValue: `${formatNumber(Math.round(data.performance.sandboxMinutes))} minutes` },
                    { label: "Agents active", value: formatNumber((data.breakdowns.agents ?? []).length) },
                    { label: "Workspaces active", value: formatNumber((data.breakdowns.workspaces ?? []).length) },
                  ]}
                />
                <div className="grid gap-5 xl:grid-cols-2">
                  <Section title="Requests by agent">
                    <BreakdownBars
                      label="Agent"
                      rows={(data.breakdowns.agents ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.requests),
                      }))}
                      format={formatCompact}
                    />
                  </Section>
                  <Section title="Spend by workspace">
                    <BreakdownBars
                      label="Workspace"
                      rows={(data.breakdowns.workspaces ?? []).map((row: any) => ({
                        label: row.label,
                        value: Number(row.billedCostMicros) / 1e6,
                      }))}
                      format={(value) => formatCompactMoney(value * 1e6)}
                    />
                  </Section>
                </div>
                <Breakdown title="Agents" noun="Agent" rows={data.breakdowns.agents ?? []} performance />
                <Breakdown title="Workspaces" noun="Workspace" rows={data.breakdowns.workspaces ?? []} />
              </>
            ) : null}
            {view === "requests" ? (
              <React.Suspense fallback={<p role="status" className="text-xs text-muted-foreground">Loading requests…</p>}>
                <AnalyticsRequests client={client} tenantId={tenantId} query={query} onSelect={(id) => void openRequest(id)} />
              </React.Suspense>
            ) : null}
          </>
        ) : null}
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title="Request"
          subtitle={<code>{detail.requestId}</code>}
          badge={
            <StatusPill tone={["completed", "success", "succeeded"].includes(detail.status) ? "good" : "danger"}>
              {label(String(detail.status))}
            </StatusPill>
          }
          onClose={() => setDetail(null)}
        >
          <DefinitionList
            items={Object.entries(detail)
              .filter(([key]) => !["safeMetadata", "requestId", "status", "id", "tenantId"].includes(key))
              .map(([key, value]) => ({
                term: label(key.replace(/([a-z])([A-Z])/g, "$1 $2")),
                detail: value == null || value === ""
                  ? <span className="text-muted-foreground">—</span>
                  : /Micros$/.test(key) ? formatMoney(value as string)
                  : /^(ts|.*At)$/.test(key) ? formatDateTime(value as string)
                  : typeof value === "number" ? formatNumber(value)
                  : String(value),
              }))}
          />
          {Object.keys(detail.safeMetadata ?? {}).length ? (
            <div className="grid gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Metadata</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-[var(--berry-surface-under)] p-3 font-mono text-xs leading-5 text-foreground">
                {JSON.stringify(detail.safeMetadata, null, 2)}
              </pre>
            </div>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            Prompts, responses and credentials are never returned here.
          </p>
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}

function UsageFiltersPopover({
  filters,
  activeCount,
  members,
  departments,
  data,
  onApply,
  onClear,
}: {
  filters: UsageFilters;
  activeCount: number;
  members: any[];
  departments: any[];
  data: any;
  onApply: (filters: UsageFilters) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(filters);

  React.useEffect(() => {
    if (!open) setDraft(filters);
  }, [filters, open]);

  const updateDraft = (key: keyof UsageFilters, value: string) => {
    setDraft((current) => ({ ...current, [key]: value === "all" ? "" : value }));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" aria-label={activeCount ? `Filters, ${activeCount} active` : "Filters"}>
          <Filter />
          Filters
          {activeCount ? (
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground text-xs tabular-nums text-background">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        className="w-[min(34rem,calc(100vw-1.5rem))] p-0"
      >
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium text-foreground">Filter organization usage</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Narrow every metric and report in the current view.</p>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 [&>label]:grid [&>label]:min-w-0 [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground">
          <UsageFilter
            label="Person"
            value={draft.memberId}
            onChange={(value) => updateDraft("memberId", value)}
            options={members.map((member) => ({ value: member.userId, label: member.name || member.email }))}
          />
          <UsageFilter
            label="Department"
            value={draft.departmentId}
            onChange={(value) => updateDraft("departmentId", value)}
            options={departments.map((department) => ({ value: department.id, label: department.name }))}
          />
          <UsageFilter
            label="Provider"
            value={draft.provider}
            onChange={(value) => updateDraft("provider", value)}
            options={breakdownOptions(data?.breakdowns.providers, draft.provider)}
          />
          <UsageFilter
            label="Model"
            value={draft.model}
            onChange={(value) => updateDraft("model", value)}
            options={breakdownOptions(data?.breakdowns.models, draft.model)}
          />
          <UsageFilter
            label="Feature"
            value={draft.feature}
            onChange={(value) => updateDraft("feature", value)}
            options={breakdownOptions(data?.breakdowns.features, draft.feature)}
          />
          <UsageFilter
            label="Status"
            value={draft.status}
            onChange={(value) => updateDraft("status", value)}
            options={breakdownOptions(data?.breakdowns.statuses, draft.status)}
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button
            variant="ghost"
            disabled={!Object.values(draft).some(Boolean) && activeCount === 0}
            onClick={() => {
              setDraft(emptyUsageFilters());
              onClear();
              setOpen(false);
            }}
          >
            Clear
          </Button>
          <Button
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            Apply filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UsageFilter({
  label: filterLabel,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label>
      {filterLabel}
      <FormSelect
        value={value || "all"}
        onChange={onChange}
        options={[
          { value: "all", label: `All ${filterLabel.toLowerCase()}` },
          ...options,
        ]}
      />
    </label>
  );
}

function breakdownOptions(
  rows: Array<{ id: string | null; label: string }> | undefined,
  current: string,
): Array<{ value: string; label: string }> {
  const options = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.id) options.set(row.id, row.label);
  }
  if (current && !options.has(current)) options.set(current, current);
  return [...options].map(([value, optionLabel]) => ({
    value,
    label: optionLabel,
  }));
}

function emptyUsageFilters(): UsageFilters {
  return {
    memberId: "",
    departmentId: "",
    model: "",
    provider: "",
    feature: "",
    status: "",
  };
}

function Breakdown({
  title,
  noun,
  rows,
  performance = false,
}: {
  title: string;
  noun: string;
  rows: any[];
  performance?: boolean;
}) {
  if (!rows.length) return null;
  return (
    <Section title={title} flush>
      <DataTable
        label={title}
        columns={[
          noun,
          "Requests",
          "Input",
          "Output",
          "Cache read",
          "Billed",
          ...(performance ? ["Error rate", "P95 latency"] : []),
        ]}
        rows={rows.map((row) => [
          <CellStack primary={row.name ?? row.label} secondary={row.email} />,
          <Num value={row.requests} />,
          <Num value={row.inputTokens} />,
          <Num value={row.outputTokens} />,
          <Num value={row.cacheReadTokens} />,
          <Num value={row.billedCostMicros} kind="money" />,
          ...(performance
            ? [
                <span data-sort={Number(row.errorRate ?? 0)}>{formatPercent(row.errorRate, 1)}</span>,
                <span data-sort={Number(row.latencyP95Ms ?? 0)}>{formatDuration(row.latencyP95Ms)}</span>,
              ]
            : []),
        ])}
      />
    </Section>
  );
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
    inputTokens: Math.round(item.tokens * 0.75),
    outputTokens: Math.round(item.tokens * 0.25),
    cacheReadTokens: Math.round(item.tokens * 0.2),
    cacheWriteTokens: Math.round(item.tokens * 0.05),
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
    inputTokens: Math.round(totalTokens * share * 0.75),
    outputTokens: Math.round(totalTokens * share * 0.25),
    cacheReadTokens: Math.round(totalTokens * share * 0.2),
    cacheWriteTokens: Math.round(totalTokens * share * 0.05),
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
      inputTokens: dashboard.totals.tokensIn,
      outputTokens: dashboard.totals.tokensOut,
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
      cacheEligibleRequests: Math.round(totalRequests * 0.72),
      cacheHitRequests: Math.round(totalRequests * 0.49),
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
