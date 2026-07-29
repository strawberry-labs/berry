import * as React from "react";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@berry/desktop-ui/components/ui/chart";

function tickLabel(value: unknown) {
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(5) : text;
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
  const reactId = React.useId().replace(/[:]/g, "");
  const config = { value: { label, color: "var(--berry-accent)" } } satisfies ChartConfig;

  return (
    <figure className="settings-chart-series">
      <figcaption>{label}</figcaption>
      {points.length ? (
        <ChartContainer config={config} className="settings-chart aspect-auto w-full">
          <AreaChart data={points} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}>
            <defs>
              <linearGradient id={`settings-fill-${reactId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.24} />
                <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={tickLabel} />
            <YAxis tickLine={false} axisLine={false} width={54} tickFormatter={(value) => format(Number(value))} />
            <ChartTooltip cursor={{ stroke: "var(--berry-border-strong)" }} content={<ChartTooltipContent hideIndicator formatter={(value) => format(Number(value))} />} />
            <Area type="monotone" dataKey="value" stroke="var(--color-value)" strokeWidth={2} fill={`url(#settings-fill-${reactId})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ChartContainer>
      ) : <p className="text-xs text-muted-foreground">No activity in this period.</p>}
      <p className="sr-only">{points.map((point) => `${point.label}: ${format(point.value)}`).join("; ")}</p>
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
  const config = {
    spend: { label, color: "var(--berry-accent)" },
    requests: { label: requestLabel, color: "var(--berry-text-tertiary)" },
  } satisfies ChartConfig;

  return (
    <figure className="settings-chart-series">
      <figcaption>{label}</figcaption>
      {points.length ? (
        <ChartContainer config={config} className="settings-chart aspect-auto w-full">
          <ComposedChart data={points} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={tickLabel} />
            <YAxis yAxisId="spend" tickLine={false} axisLine={false} width={54} tickFormatter={(value) => spendFormat(Number(value))} />
            <YAxis yAxisId="requests" orientation="right" tickLine={false} axisLine={false} width={44} tickFormatter={(value) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(Number(value))} />
            <ChartTooltip cursor={{ fill: "var(--berry-hover)" }} content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar yAxisId="requests" dataKey="requests" fill="var(--color-requests)" radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} opacity={0.5} />
            <Line yAxisId="spend" type="monotone" dataKey="spend" stroke="var(--color-spend)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ChartContainer>
      ) : <p className="text-xs text-muted-foreground">No activity in this period.</p>}
      <p className="sr-only">{points.map((point) => `${point.label}: ${spendFormat(point.spend)}, ${point.requests} ${requestLabel}`).join("; ")}</p>
    </figure>
  );
}
