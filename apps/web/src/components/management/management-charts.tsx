import {
  Area as BklitArea,
  AreaChart as BklitAreaChart,
} from "@berry/desktop-ui/components/charts/area-chart";
import { Bar as BklitBar } from "@berry/desktop-ui/components/charts/bar";
import { BarChart as BklitBarChart } from "@berry/desktop-ui/components/charts/bar-chart";
import { BarXAxis } from "@berry/desktop-ui/components/charts/bar-x-axis";
import { BarYAxis } from "@berry/desktop-ui/components/charts/bar-y-axis";
import { chartCssVars } from "@berry/desktop-ui/components/charts/chart-context";
import { Grid as BklitGrid } from "@berry/desktop-ui/components/charts/grid";
import { Ring } from "@berry/desktop-ui/components/charts/ring";
import { RingCenter } from "@berry/desktop-ui/components/charts/ring-center";
import { RingChart } from "@berry/desktop-ui/components/charts/ring-chart";
import { ringCssVars } from "@berry/desktop-ui/components/charts/ring-context";
import { ChartTooltip as BklitTooltip } from "@berry/desktop-ui/components/charts/tooltip/chart-tooltip";
import { XAxis as BklitXAxis } from "@berry/desktop-ui/components/charts/x-axis";

function compactDateLabel(value: string) {
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  if (date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function MiniSeries({
  label,
  points,
  format = (value) => String(value),
}: {
  label: string;
  points: Array<{ label: string; value: number }>;
  format?: (value: number) => string;
}) {
  return (
    <figure className="settings-chart-series">
      <figcaption>{label}</figcaption>
      {points.length ? (
        <BklitAreaChart
          data={points}
          xDataKey="label"
          aspectRatio="auto"
          className="settings-chart"
          margin={{ left: 12, right: 12, top: 12, bottom: 28 }}
        >
          <BklitGrid horizontal strokeDasharray="3,3" />
          <BklitArea
            dataKey="value"
            fill={chartCssVars.linePrimary}
            fillOpacity={0.24}
            gradientToOpacity={0.02}
            stroke={chartCssVars.linePrimary}
            strokeWidth={2}
          />
          <BklitXAxis numTicks={5} />
          <BklitTooltip
            rows={(point: Record<string, unknown>) => [
              {
                color: chartCssVars.linePrimary,
                label,
                value: format(Number(point.value)),
              },
            ]}
          />
        </BklitAreaChart>
      ) : (
        <p className="text-xs text-muted-foreground">
          No activity in this period.
        </p>
      )}
      <p className="sr-only">
        {points
          .map((point) => `${point.label}: ${format(point.value)}`)
          .join("; ")}
      </p>
    </figure>
  );
}

export function DualTrend({
  label,
  points,
  spendFormat,
  requestLabel = "Requests",
}: {
  label: string;
  points: Array<{ label: string; spend: number; requests: number }>;
  spendFormat: (value: number) => string;
  requestLabel?: string;
}) {
  const chartPoints = points.map((point) => ({
    ...point,
    label: compactDateLabel(point.label),
  }));

  return (
    <figure className="settings-chart-series grid gap-4 lg:grid-cols-2">
      <figcaption className="sr-only">
        {label} and {requestLabel}
      </figcaption>
      {chartPoints.length ? (
        <>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {label}
            </p>
            <BklitAreaChart
              data={chartPoints}
              xDataKey="label"
              aspectRatio="auto"
              className="settings-chart"
              margin={{ left: 12, right: 12, top: 12, bottom: 28 }}
            >
              <BklitGrid horizontal strokeDasharray="3,3" />
              <BklitArea
                dataKey="spend"
                fill={chartCssVars.linePrimary}
                fillOpacity={0.22}
                gradientToOpacity={0.02}
                stroke={chartCssVars.linePrimary}
                strokeWidth={2}
              />
              <BklitXAxis numTicks={5} />
              <BklitTooltip
                rows={(point: Record<string, unknown>) => [
                  {
                    color: chartCssVars.linePrimary,
                    label,
                    value: spendFormat(Number(point.spend)),
                  },
                ]}
              />
            </BklitAreaChart>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {requestLabel}
            </p>
            <BklitBarChart
              data={chartPoints}
              xDataKey="label"
              aspectRatio="auto"
              className="settings-chart"
              margin={{ left: 12, right: 12, top: 12, bottom: 28 }}
              barGap={0.34}
            >
              <BklitGrid horizontal strokeDasharray="3,3" />
              <BklitBar
                dataKey="requests"
                fill={ringCssVars.ring3}
                lineCap={4}
              />
              <BarXAxis maxLabels={6} />
              <BklitTooltip
                rows={(point: Record<string, unknown>) => [
                  {
                    color: ringCssVars.ring3,
                    label: requestLabel,
                    value: new Intl.NumberFormat().format(
                      Number(point.requests),
                    ),
                  },
                ]}
              />
            </BklitBarChart>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No activity in this period.
        </p>
      )}
      <p className="sr-only">
        {chartPoints
          .map(
            (point) =>
              `${point.label}: ${spendFormat(point.spend)}, ${point.requests} ${requestLabel}`,
          )
          .join("; ")}
      </p>
    </figure>
  );
}

export function OutcomeBars({
  points,
}: {
  points: Array<{ label: string; successes: number; failures: number }>;
}) {
  const chartPoints = points.map((point) => ({
    ...point,
    label: compactDateLabel(point.label),
  }));

  return (
    <figure className="settings-chart-series">
      <figcaption className="sr-only">Request outcomes</figcaption>
      {chartPoints.length ? (
        <BklitBarChart
          data={chartPoints}
          xDataKey="label"
          aspectRatio="auto"
          className="settings-chart"
          margin={{ left: 12, right: 12, top: 12, bottom: 28 }}
          stacked
          stackGap={1}
        >
          <BklitGrid horizontal strokeDasharray="3,3" />
          <BklitBar
            dataKey="successes"
            fill={ringCssVars.ring1}
            lineCap={3}
          />
          <BklitBar
            dataKey="failures"
            fill={ringCssVars.ring5}
            lineCap={3}
          />
          <BarXAxis maxLabels={6} />
          <BklitTooltip
            rows={(point: Record<string, unknown>) => [
              {
                color: ringCssVars.ring1,
                label: "Successful",
                value: new Intl.NumberFormat().format(
                  Number(point.successes),
                ),
              },
              {
                color: ringCssVars.ring5,
                label: "Failed",
                value: new Intl.NumberFormat().format(Number(point.failures)),
              },
            ]}
          />
        </BklitBarChart>
      ) : (
        <p className="text-xs text-muted-foreground">
          No outcomes in this period.
        </p>
      )}
      <p className="sr-only">
        {chartPoints
          .map(
            (point) =>
              `${point.label}: ${point.successes} successful, ${point.failures} failed`,
          )
          .join("; ")}
      </p>
    </figure>
  );
}

export function BreakdownBars({
  label,
  rows,
  format = (value) => new Intl.NumberFormat().format(value),
}: {
  label: string;
  rows: Array<{ label: string; value: number }>;
  format?: (value: number) => string;
}) {
  const visibleRows = rows.slice(0, 8);
  return (
    <figure className="settings-chart-series">
      <figcaption>{label}</figcaption>
      {visibleRows.length ? (
        <BklitBarChart
          data={visibleRows}
          xDataKey="label"
          orientation="horizontal"
          aspectRatio="auto"
          className="settings-chart settings-chart-tall"
          margin={{ left: 92, right: 16, top: 8, bottom: 8 }}
          barGap={0.28}
        >
          <BklitGrid vertical fadeVertical />
          <BklitBar
            dataKey="value"
            fill={ringCssVars.ring2}
            lineCap={4}
          />
          <BarYAxis maxLabels={8} />
          <BklitTooltip
            showCrosshair={false}
            rows={(point: Record<string, unknown>) => [
              {
                color: ringCssVars.ring2,
                label,
                value: format(Number(point.value)),
              },
            ]}
          />
        </BklitBarChart>
      ) : (
        <p className="text-xs text-muted-foreground">
          No breakdown data in this period.
        </p>
      )}
      <p className="sr-only">
        {visibleRows
          .map((row) => `${row.label}: ${format(row.value)}`)
          .join("; ")}
      </p>
    </figure>
  );
}

export function HealthRings({
  successRate,
  cacheRate,
  attributionRate,
}: {
  successRate: number | null;
  cacheRate?: number | null;
  attributionRate?: number | null;
}) {
  const data = [
    ...(successRate == null
      ? []
      : [
          {
            label: "Success rate",
            value: Math.round(successRate * 100),
            maxValue: 100,
            color: ringCssVars.ring1,
          },
        ]),
    ...(cacheRate == null
      ? []
      : [
          {
            label: "Cache reuse",
            value: Math.round(cacheRate * 100),
            maxValue: 100,
            color: ringCssVars.ring2,
          },
        ]),
    ...(attributionRate == null
      ? []
      : [
          {
            label: "Attributed",
            value: Math.round(attributionRate * 100),
            maxValue: 100,
            color: ringCssVars.ring3,
          },
        ]),
  ];

  return (
    <figure className="settings-chart-series">
      <figcaption>Operational quality</figcaption>
      {data.length ? (
        <>
          <div className="mx-auto h-56 w-full max-w-64">
            <RingChart
              data={data}
              className="h-full w-full"
              strokeWidth={12}
              ringGap={7}
              baseInnerRadius={48}
            >
              {data.map((_, index) => (
                <Ring key={index} index={index} showGlow={false} />
              ))}
              <RingCenter defaultLabel="Quality signals" suffix="%" />
            </RingChart>
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {data.map((item) => (
              <span
                key={item.label}
                className="inline-flex items-center gap-1.5"
              >
                <i
                  className="size-2 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden
                />
                {item.label} {item.value}%
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No quality signals in this period.
        </p>
      )}
    </figure>
  );
}

export function ModelSpendRings({
  rows,
  format,
}: {
  rows: Array<{ label: string; value: number }>;
  format: (value: number) => string;
}) {
  const visible = aggregateModelSpendRows(rows);
  const total = visible.reduce((sum, row) => sum + row.value, 0);
  const colors = [ringCssVars.ring1, ringCssVars.ring2, ringCssVars.ring3, ringCssVars.ring4, ringCssVars.ring5];
  const data = visible.map((row, index) => ({
    label: row.label,
    value: total > 0 ? Math.round((row.value / total) * 1000) / 10 : 0,
    maxValue: 100,
    color: colors[index]!,
  }));

  return <figure className="settings-chart-series">
    <figcaption className="sr-only">Model spend distribution</figcaption>
    {data.length ? <>
      <div className="mx-auto h-56 w-full max-w-64">
        <RingChart data={data} className="h-full w-full" strokeWidth={11} ringGap={6} baseInnerRadius={48}>
          {data.map((_, index) => <Ring key={index} index={index} showGlow={false} />)}
          <RingCenter defaultLabel="Model share" suffix="%" />
        </RingChart>
      </div>
      <div className="mt-2 grid gap-1.5 text-xs text-muted-foreground">
        {visible.map((row, index) => <span key={`${row.label}:${index}`} className="flex items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-1.5"><i className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colors[index] }} aria-hidden /><span className="truncate">{row.label}</span></span>
          <span className="shrink-0 tabular-nums text-foreground">{data[index]?.value ?? 0}% · {format(row.value)}</span>
        </span>)}
      </div>
    </> : <p className="text-xs text-muted-foreground">No model spend in this period.</p>}
  </figure>;
}

export function aggregateModelSpendRows(
  rows: Array<{ label: string; value: number }>,
  maximumRows = 5,
): Array<{ label: string; value: number }> {
  const positive = rows.filter((row) => row.value > 0).sort((left, right) => right.value - left.value);
  const limit = Math.max(2, Math.floor(maximumRows));
  if (positive.length <= limit) return positive;
  const named = positive.slice(0, limit - 1);
  return [
    ...named,
    { label: "Other", value: positive.slice(limit - 1).reduce((sum, row) => sum + row.value, 0) },
  ];
}
