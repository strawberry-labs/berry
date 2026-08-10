import * as React from "react";
import { CalendarRange } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@berry/desktop-ui/components/ui/popover";
import { cn } from "@berry/desktop-ui/lib/utils";
import { Button, Input } from "./management-primitives";

export type UsageRangePreset = "month" | "three-months" | "year" | "all" | "custom";
export type UsageDateRange = { from: string; to: string };

export const USAGE_RANGE_OPTIONS: ReadonlyArray<{
  value: UsageRangePreset;
  label: string;
}> = [
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
  const days = PRESET_DAYS[preset] ?? PRESET_DAYS.month!;
  return { from: offsetCalendarDate(to, -days), to };
}

export function inferUsageRangePreset(range: UsageDateRange): UsageRangePreset {
  const from = new Date(`${range.from}T00:00:00.000Z`).getTime();
  const to = new Date(`${range.to}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "custom";
  if (range.from === "1970-01-01") return "all";
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
    onChange(next, usageRangeForPreset(next));
    setOpen(false);
  };
  const applyCustom = () => {
    if (!custom.from || !custom.to || custom.from > custom.to) return;
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
          <p className="mb-2 text-xs font-medium text-foreground">Custom range</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground">
              From
              <Input type="date" value={custom.from} onChange={(event) => setCustom({ ...custom, from: event.currentTarget.value })} />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground">
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

export type CacheMetric = {
  label: "Cache hit rate" | "Cached input-token share";
  value: number | null;
  hint: string;
};

export function calculateCacheMetric(input: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheEligibleRequests: number;
  cacheHitRequests: number;
}): CacheMetric {
  if (input.cacheEligibleRequests > 0) {
    return {
      label: "Cache hit rate",
      value: input.cacheHitRequests / input.cacheEligibleRequests,
      hint: `${input.cacheHitRequests} of ${input.cacheEligibleRequests} eligible requests`,
    };
  }
  if (input.inputTokens > 0 && input.cacheReadTokens >= 0) {
    return {
      label: "Cached input-token share",
      value: Math.min(1, input.cacheReadTokens / input.inputTokens),
      hint: `${new Intl.NumberFormat().format(input.cacheReadTokens)} cache-read tokens`,
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
