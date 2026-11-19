import * as React from "react";
import { CalendarRange } from "lucide-react";
import type { UsageAnalyticsQuery } from "@berry/shared";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@berry/desktop-ui/components/ui/popover";
import { cn } from "@berry/desktop-ui/lib/utils";
import { Button, Input } from "./management-primitives";

export type UsageRangePreset = "month-to-date" | "month" | "three-months" | "year" | "all" | "custom";
export type UsageDateRange = { from: string; to: string };

export const USAGE_RANGE_OPTIONS: ReadonlyArray<{
  value: UsageRangePreset;
  label: string;
}> = [
  { value: "month-to-date", label: "Month to date" },
  { value: "month", label: "Past month" },
  { value: "three-months", label: "Past 3 months" },
  { value: "year", label: "Past year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

const PRESET_DAYS: Partial<Record<UsageRangePreset, number>> = {
  month: 30,
  "three-months": 90,
  year: 365,
};

export function usageRangeForPreset(
  preset: UsageRangePreset,
  anchor = new Date(),
  custom?: UsageDateRange,
  timeZone = browserTimeZone(),
): UsageDateRange {
  if (preset === "custom" && custom && custom.from <= custom.to) return custom;
  const to = usageDateInput(anchor, timeZone);
  if (preset === "all") return { from: "1970-01-01", to };
  if (preset === "month-to-date") return { from: to.slice(0, 7) + "-01", to };
  const days = PRESET_DAYS[preset] ?? PRESET_DAYS.month!;
  return { from: offsetCalendarDate(to, -days), to };
}

export function validDateInput(value: string): boolean {
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function usageReportBounds(range: UsageDateRange, anchor = new Date()): { from: string; to: string } {
  const from = new Date(range.from + "T00:00:00.000Z");
  const nextDay = new Date(offsetCalendarDate(range.to, 1) + "T00:00:00.000Z");
  const end = Math.max(from.getTime(), Math.min(nextDay.getTime(), anchor.getTime()));
  return { from: from.toISOString(), to: new Date(end).toISOString() };
}

export function inferUsageRangePreset(range: UsageDateRange, anchor = new Date()): UsageRangePreset {
  const from = new Date(`${range.from}T00:00:00.000Z`).getTime();
  const to = new Date(`${range.to}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "custom";
  if (range.from === "1970-01-01") return "all";
  const monthToDate = usageRangeForPreset("month-to-date", anchor, undefined, "UTC");
  if (range.from === monthToDate.from && range.to === monthToDate.to) return "month-to-date";
  const days = Math.round((to - from) / 86_400_000);
  if (days === 30) return "month";
  if (days === 90) return "three-months";
  if (days === 365) return "year";
  return "custom";
}

export function UsageRangeControl({
  preset,
  range,
  onChange,
}: {
  preset: UsageRangePreset;
  range: UsageDateRange;
  onChange: (preset: UsageRangePreset, range: UsageDateRange) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [custom, setCustom] = React.useState(range);

  React.useEffect(() => setCustom(range), [range.from, range.to]);

  const choosePreset = (next: UsageRangePreset) => {
    if (next === "custom") return;
    onChange(next, usageRangeForPreset(next, new Date(), undefined, "UTC"));
    setOpen(false);
  };
  const applyCustom = () => {
    if (!validDateInput(custom.from) || !validDateInput(custom.to) || custom.from > custom.to) return;
    onChange("custom", custom);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" aria-label="Select analytics date range">
          <CalendarRange />
          {USAGE_RANGE_OPTIONS.find((option) => option.value === preset)?.label ?? "Date range"}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-3"
      >
        <div className="grid gap-1" aria-label="Analytics date presets">
          {USAGE_RANGE_OPTIONS.filter((option) => option.value !== "custom").map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                "rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground motion-reduce:transition-none",
                preset === option.value && "bg-muted text-foreground",
              )}
              onClick={() => choosePreset(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-2 text-xs font-medium text-foreground">Custom range (UTC)</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              From
              <Input type="date" value={custom.from} onChange={(event) => setCustom({ ...custom, from: event.currentTarget.value })} />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              To
              <Input type="date" value={custom.to} onChange={(event) => setCustom({ ...custom, to: event.currentTarget.value })} />
            </label>
          </div>
          <Button className="mt-3 w-full" disabled={!custom.from || !custom.to || custom.from > custom.to} onClick={applyCustom}>
            Apply custom range
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function usageTokenBreakdown(inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number) {
  const cacheRead = Math.min(inputTokens, cacheReadTokens);
  const cacheWrite = Math.min(inputTokens - cacheRead, cacheWriteTokens);
  return [
    { label: "Fresh input", value: inputTokens - cacheRead - cacheWrite },
    { label: "Cache read", value: cacheRead },
    { label: "Cache write", value: cacheWrite },
    { label: "Output", value: outputTokens },
  ].filter((row) => row.value > 0);
}

export function usageCsvFilter(query: UsageAnalyticsQuery) {
  const { from, to, memberId, departmentId, model, provider, feature, status, workspaceId, agentId } = query;
  return { from, to, userId: memberId, departmentId, model, provider, feature, status, workspaceId, agentId };
}

export function downloadUsageCsv(csv: string, filename: string) {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type CacheMetric = {
  label: "Cache hit rate" | "Cached input-token share";
  value: number | null;
  hint: string;
};

/**
 * The share of input tokens served from cache is the primary cache metric: a
 * request with any cached token counts as a "hit" even when most of its input
 * was uncached, so a request hit rate overstates savings (H-032).
 */
export function calculateCacheMetric(input: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheEligibleRequests: number;
  cacheHitRequests: number;
}): CacheMetric {
  if (input.inputTokens > 0 && input.cacheReadTokens >= 0) {
    const tokens = `${new Intl.NumberFormat().format(input.cacheReadTokens)} cache-read tokens`;
    return {
      label: "Cached input-token share",
      value: Math.min(1, input.cacheReadTokens / input.inputTokens),
      hint: input.cacheHitRequests > 0
        ? `${tokens}; ${new Intl.NumberFormat().format(input.cacheHitRequests)} requests read some cached input`
        : tokens,
    };
  }
  if (input.cacheEligibleRequests > 0) {
    return {
      label: "Cache hit rate",
      value: Math.min(1, input.cacheHitRequests / input.cacheEligibleRequests),
      hint: `${input.cacheHitRequests} of ${input.cacheEligibleRequests} eligible requests`,
    };
  }
  return { label: "Cache hit rate", value: null, hint: "No cache telemetry for this period" };
}

export function usageDateInput(date: Date, timeZone = browserTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function offsetCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formatUsageLabel(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
