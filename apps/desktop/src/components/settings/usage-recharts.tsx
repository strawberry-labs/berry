import { useMemo } from "react";
import { Card } from "@berry/desktop-ui/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@berry/desktop-ui/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

import { formatDay, formatFullDay } from "./shared";

interface UsageDay {
  date: string;
  tokens: number;
  turns: number;
}

export function DailyTokensChart({ days }: { days: UsageDay[] }) {
  const data = useMemo(() => days.slice(-30), [days]);
  return (
    <Card className="gap-4 rounded-xl border-border p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">Tokens per day</h2>
        <p className="text-xs text-muted-foreground">Last 30 days</p>
      </div>
      <ChartContainer
        config={{ tokens: { label: "Tokens", color: "var(--color-chart-1)" } }}
        className="aspect-auto h-52 w-full"
      >
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            tickFormatter={(value: string) => formatDay(value)}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(_value, payload) => {
                  const date = payload?.[0]?.payload?.date;
                  return typeof date === "string" ? formatFullDay(date) : "";
                }}
              />
            }
          />
          <Bar dataKey="tokens" fill="var(--color-tokens)" radius={[4, 4, 0, 0]} maxBarSize={20} />
        </BarChart>
      </ChartContainer>
    </Card>
  );
}
