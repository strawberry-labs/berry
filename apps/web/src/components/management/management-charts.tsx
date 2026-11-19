import * as React from "react";
import {
  Area as BklitArea,
  AreaChart as BklitAreaChart,
} from "@berry/desktop-ui/components/charts/area-chart";
import { chartCssVars } from "@berry/desktop-ui/components/charts/chart-context";
import { Grid as BklitGrid } from "@berry/desktop-ui/components/charts/grid";
import { Legend } from "@berry/desktop-ui/components/charts/legend/legend";
import { LegendItem } from "@berry/desktop-ui/components/charts/legend/legend-item";
import { LegendLabel } from "@berry/desktop-ui/components/charts/legend/legend-label";
import { LegendMarker } from "@berry/desktop-ui/components/charts/legend/legend-marker";
import { LegendProgress } from "@berry/desktop-ui/components/charts/legend/legend-progress";
import { LegendValue } from "@berry/desktop-ui/components/charts/legend/legend-value";
import { PieChart } from "@berry/desktop-ui/components/charts/pie-chart";
import { PieSlice } from "@berry/desktop-ui/components/charts/pie-slice";
import { Ring } from "@berry/desktop-ui/components/charts/ring";
import { RingChart } from "@berry/desktop-ui/components/charts/ring-chart";
import { ChartTooltip as BklitTooltip } from "@berry/desktop-ui/components/charts/tooltip/chart-tooltip";
import { XAxis as BklitXAxis } from "@berry/desktop-ui/components/charts/x-axis";
import { YAxis as BklitYAxis } from "@berry/desktop-ui/components/charts/y-axis";
import { cn } from "@berry/desktop-ui/lib/utils";

/** Categorical series colours, in the order series are assigned. */
const SERIES = [
  chartCssVars.linePrimary,
  "var(--chart-4)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-5)",
] as const;
const OTHER_COLOR = "var(--berry-text-faint)";
const DANGER_COLOR = "var(--chart-5)";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat();
function compactValue(value: number) {
  return Math.abs(value) < 1000 ? integer.format(Math.round(value * 100) / 100) : compact.format(value);
}

/** The charts use a time scale, so labels become real dates rather than display strings. */
function toDate(value: string): Date | null {
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function withDates<T extends { label: string }>(points: T[]): Array<T & { date: Date }> {
  return points.flatMap((point) => {
    const date = toDate(point.label);
    return date ? [{ ...point, date }] : [];
  });
}

/** Text in the hole of a donut or ring: the headline at rest, the hovered part on hover. */
function ChartCenter({ value, label }: { value: string; label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-9 text-center">
      <strong className="max-w-full truncate text-lg font-semibold leading-6 tracking-[-0.02em] text-foreground">
        {value}
      </strong>
      <span className="line-clamp-2 max-w-full text-xs leading-[14px] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function EmptyChart({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex h-24 items-center justify-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function TrendPanel({
  title,
  total,
  data,
  dataKey,
  color,
  format,
  axisFormat = compactValue,
  short = false,
}: {
  title: string;
  total?: string;
  data: Array<Record<string, unknown>>;
  dataKey: string;
  color: string;
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  short?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <i className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
          {title}
        </span>
        {total ? <strong className="text-md font-semibold text-foreground">{total}</strong> : null}
      </div>
      <BklitAreaChart
        data={data}
        xDataKey="date"
        aspectRatio="auto"
        className={cn("settings-chart", short && "settings-chart-short")}
        margin={{ left: 44, right: 10, top: 8, bottom: 26 }}
      >
        <BklitGrid horizontal strokeDasharray="2,4" />
        <BklitArea
          dataKey={dataKey}
          fill={color}
          fillOpacity={0.2}
          gradientToOpacity={0}
          stroke={color}
          strokeWidth={1.75}
        />
        <BklitYAxis numTicks={4} formatValue={axisFormat} />
        <BklitXAxis numTicks={6} />
        <BklitTooltip
          rows={(point: Record<string, unknown>) => [
            { color, label: title, value: format(Number(point[dataKey])) },
          ]}
        />
      </BklitAreaChart>
    </div>
  );
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
  const data = withDates(points);
  return (
    <figure className="settings-chart-series">
      <figcaption className="sr-only">{label}</figcaption>
      {data.length ? (
        <TrendPanel title={label} data={data} dataKey="value" color={SERIES[0]} format={format} />
      ) : (
        <EmptyChart>No activity in this period.</EmptyChart>
      )}
      <p className="sr-only">
        {points.map((point) => `${point.label}: ${format(point.value)}`).join("; ")}
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
  const data = withDates(points);
  const spendTotal = points.reduce((sum, point) => sum + point.spend, 0);
  const requestTotal = points.reduce((sum, point) => sum + point.requests, 0);

  return (
    <figure className="settings-chart-series grid gap-x-8 gap-y-5 lg:grid-cols-2">
      <figcaption className="sr-only">
        {label} and {requestLabel}
      </figcaption>
      {data.length ? (
        <>
          <TrendPanel
            title={label}
            total={spendFormat(spendTotal)}
            data={data}
            dataKey="spend"
            color={SERIES[0]}
            format={spendFormat}
            axisFormat={(value) => `$${compactValue(value)}`}
          />
          <TrendPanel
            title={requestLabel}
            total={integer.format(requestTotal)}
            data={data}
            dataKey="requests"
            color={SERIES[1]}
            format={(value) => integer.format(value)}
          />
        </>
      ) : (
        <EmptyChart>No activity in this period.</EmptyChart>
      )}
      <p className="sr-only">
        {points
          .map((point) => `${point.label}: ${spendFormat(point.spend)}, ${point.requests} ${requestLabel}`)
          .join("; ")}
      </p>
    </figure>
  );
}

/**
 * Failed share of requests over time. At production volume a stacked
 * success/failure bar hides the failures entirely; the rate is the signal.
 */
export function OutcomeBars({
  points,
}: {
  points: Array<{ label: string; successes: number; failures: number }>;
}) {
  const data = withDates(points).map((point) => {
    const total = point.successes + point.failures;
    return { ...point, errorRate: total > 0 ? (point.failures / total) * 100 : 0 };
  });
  const failures = points.reduce((sum, point) => sum + point.failures, 0);
  const total = points.reduce((sum, point) => sum + point.successes + point.failures, 0);
  const percent = (value: number) => `${value.toFixed(value < 10 ? 2 : 1)}%`;

  return (
    <figure className="settings-chart-series">
      <figcaption className="sr-only">Failed request rate</figcaption>
      {data.length ? (
        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <i className="size-2 rounded-full" style={{ backgroundColor: DANGER_COLOR }} aria-hidden />
              Failed requests
            </span>
            <strong className="text-md font-semibold text-foreground">
              {total > 0 ? percent((failures / total) * 100) : "—"}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {integer.format(failures)} of {compactValue(total)}
              </span>
            </strong>
          </div>
          <BklitAreaChart
            data={data}
            xDataKey="date"
            aspectRatio="auto"
            className="settings-chart"
            margin={{ left: 44, right: 10, top: 8, bottom: 26 }}
          >
            <BklitGrid horizontal strokeDasharray="2,4" />
            <BklitArea
              dataKey="errorRate"
              fill={DANGER_COLOR}
              fillOpacity={0.18}
              gradientToOpacity={0}
              stroke={DANGER_COLOR}
              strokeWidth={1.75}
            />
            <BklitYAxis numTicks={4} formatValue={(value) => `${compactValue(value)}%`} />
            <BklitXAxis numTicks={6} />
            <BklitTooltip
              rows={(point: Record<string, unknown>) => [
                { color: DANGER_COLOR, label: "Failed rate", value: percent(Number(point.errorRate)) },
                { color: DANGER_COLOR, label: "Failed", value: integer.format(Number(point.failures)) },
                { color: SERIES[2], label: "Successful", value: integer.format(Number(point.successes)) },
              ]}
            />
          </BklitAreaChart>
        </div>
      ) : (
        <EmptyChart>No outcomes in this period.</EmptyChart>
      )}
      <p className="sr-only">
        {points
          .map((point) => `${point.label}: ${point.successes} successful, ${point.failures} failed`)
          .join("; ")}
      </p>
    </figure>
  );
}

/**
 * Ranked breakdown of one measure. Rows are a readable list with a magnitude
 * bar, so long model, department and member names never get clipped by an axis.
 */
export function BreakdownBars({
  label,
  rows,
  format = (value) => integer.format(value),
  limit = 8,
}: {
  label: string;
  rows: Array<{ label: string; value: number }>;
  format?: (value: number) => string;
  limit?: number;
}) {
  const ranked = [...rows].sort((left, right) => right.value - left.value);
  const visible = ranked.slice(0, limit);
  const max = Math.max(0, ...visible.map((row) => row.value));
  const total = ranked.reduce((sum, row) => sum + row.value, 0);
  const items = visible.map((row) => ({
    label: row.label,
    value: row.value,
    maxValue: max || 1,
    color: SERIES[0],
  }));
  const hidden = ranked.length - visible.length;

  return (
    <figure className="settings-chart-series">
      <figcaption className="sr-only">{label}</figcaption>
      {items.length ? (
        <>
          <div className="mb-1 flex items-center justify-between px-2 text-xs text-muted-foreground">
            <span>{label}</span>
            <span>Share</span>
          </div>
          <Legend items={items} className="gap-0">
            <LegendItem className="grid cursor-default grid-cols-[minmax(0,1fr)_auto_3rem] items-center gap-x-3 gap-y-1.5 rounded-md px-2 py-1.5">
              <LegendLabel className="truncate text-md font-normal" />
              <LegendValue className="justify-end text-md text-foreground tabular-nums" formatValue={format} />
              <ShareCell total={total} />
              <div className="col-span-3">
                <LegendProgress height="h-1" />
              </div>
            </LegendItem>
          </Legend>
          {hidden > 0 ? (
            <p className="mt-1 px-2 text-xs text-muted-foreground">
              {hidden} more not shown
            </p>
          ) : null}
        </>
      ) : (
        <EmptyChart>No breakdown data in this period.</EmptyChart>
      )}
    </figure>
  );
}

function ShareCell({ total }: { total: number }) {
  return (
    <LegendValue
      className="justify-end text-xs tabular-nums"
      formatValue={(value) => (total > 0 ? `${((value / total) * 100).toFixed(value / total < 0.1 ? 1 : 0)}%` : "—")}
    />
  );
}

/** Rings for independent 0–100% rates, with a legend that shares hover state. */
export function HealthRings({
  successRate,
  cacheRate,
  attributionRate,
}: {
  successRate: number | null;
  cacheRate?: number | null;
  attributionRate?: number | null;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const rates: Array<[string, number | null | undefined]> = [
    ["Success rate", successRate],
    ["Cache reuse", cacheRate],
    ["Attributed to a member", attributionRate],
  ];
  const data = rates.flatMap(([label, rate], index) =>
    rate == null
      ? []
      : [{ label, value: Math.round(rate * 1000) / 10, maxValue: 100, color: SERIES[[2, 0, 1][index]!]! }],
  );

  return (
    <figure className="settings-chart-series">
      <figcaption className="sr-only">Operational quality</figcaption>
      {data.length ? (
        <div className="flex flex-col items-center gap-x-6 gap-y-3 sm:flex-row">
          <div className="relative size-44 shrink-0">
            <RingChart
              data={data}
              className="h-full w-full"
              strokeWidth={9}
              ringGap={5}
              baseInnerRadius={44}
              hoveredIndex={hovered}
              onHoverChange={setHovered}
            >
              {data.map((_, index) => (
                <Ring key={index} index={index} showGlow={false} />
              ))}
            </RingChart>
            <ChartCenter
              value={`${(data[hovered ?? 0] ?? data[0]!).value}%`}
              label={(data[hovered ?? 0] ?? data[0]!).label}
            />
          </div>
          <Legend items={data} hoveredIndex={hovered} onHoverChange={setHovered} className="w-full min-w-0 flex-1 gap-0">
            <LegendItem className="flex items-center gap-2.5 rounded-md px-2 py-2">
              <LegendMarker className="size-2" />
              <LegendLabel className="min-w-0 flex-1 truncate text-md font-normal" />
              <LegendValue className="text-md font-medium text-foreground tabular-nums" formatValue={(value) => `${value}%`} />
            </LegendItem>
          </Legend>
        </div>
      ) : (
        <EmptyChart>No quality signals in this period.</EmptyChart>
      )}
    </figure>
  );
}

/** Parts of a whole as a donut with a linked legend. */
export function ShareDonut({
  caption,
  centerLabel,
  rows,
  format,
}: {
  caption: string;
  centerLabel: string;
  rows: Array<{ label: string; value: number }>;
  format: (value: number) => string;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const data = rows.map((row, index) => ({
    label: row.label,
    value: row.value,
    maxValue: total || 1,
    color: row.label === "Other" ? OTHER_COLOR : SERIES[index % SERIES.length]!,
  }));

  return (
    <figure className="settings-chart-series">
      <figcaption className="sr-only">{caption}</figcaption>
      {data.length ? (
        <div className="flex flex-col items-center gap-x-6 gap-y-3 sm:flex-row">
          <div className="relative size-44 shrink-0">
            <PieChart
              data={data}
              innerRadius={58}
              padAngle={0.02}
              cornerRadius={3}
              hoveredIndex={hovered}
              onHoverChange={setHovered}
              hoverOffset={4}
              className="h-full w-full"
            >
              {data.map((_, index) => (
                <PieSlice key={index} index={index} hoverEffect="grow" hoverOffset={4} />
              ))}
            </PieChart>
            <ChartCenter
              value={
                hovered == null || !data[hovered]
                  ? format(total)
                  : `${((data[hovered].value / (total || 1)) * 100).toFixed(1)}%`
              }
              label={hovered == null || !data[hovered] ? centerLabel : data[hovered].label}
            />
          </div>
          <Legend items={data} hoveredIndex={hovered} onHoverChange={setHovered} className="w-full min-w-0 flex-1 gap-0">
            <LegendItem className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <LegendMarker className="size-2" />
              <LegendLabel className="min-w-0 flex-1 truncate text-md font-normal" />
              <LegendValue
                className="text-md text-foreground tabular-nums"
                percentageClassName="w-10 text-right text-xs text-muted-foreground tabular-nums"
                showPercentage
                formatValue={format}
              />
            </LegendItem>
          </Legend>
        </div>
      ) : (
        <EmptyChart>Nothing to show in this period.</EmptyChart>
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
  return (
    <ShareDonut
      caption="Model spend distribution"
      centerLabel="Model share"
      rows={aggregateModelSpendRows(rows)}
      format={format}
    />
  );
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
