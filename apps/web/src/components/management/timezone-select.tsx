import * as React from "react";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@berry/desktop-ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";
import { Check, ChevronDown, Globe } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";

export type TimezoneOption = {
  id: string;
  city: string;
  region: string;
  offset: string;
  searchValue: string;
};

export function TimezoneSelect({ value, onChange, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const options = React.useMemo(() => timezoneOptions(value), [value]);
  const selected = options.find((option) => option.id === value) ?? options[0]!;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label="Choose organization timezone"
          aria-haspopup="listbox"
          aria-expanded={open}
          className="h-9 w-full justify-between gap-2 px-3 font-normal shadow-none"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Globe className="size-4 shrink-0 text-[var(--berry-text-tertiary)]" aria-hidden />
            <span className="truncate text-sm text-[var(--berry-text-primary)]">{selected.city}</span>
            <span className="shrink-0 text-xs tabular-nums text-[var(--berry-text-tertiary)]">{selected.offset}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-[var(--berry-text-tertiary)]" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,calc(100vw-32px))] p-0">
        <Command>
          <CommandInput placeholder="Search city, region, or UTC offset…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No matching timezone.</CommandEmpty>
            <CommandGroup heading="Timezones">
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.searchValue}
                  onSelect={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  className="min-h-11"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{option.city}</span>
                    <span className="block truncate text-xs text-[var(--berry-text-tertiary)]">{option.region}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--berry-text-secondary)]">{option.offset}</span>
                  <Check className={cn("size-4 shrink-0", option.id === value ? "opacity-100" : "opacity-0")} aria-hidden />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function timezoneOptions(currentValue = "UTC", now = new Date()): TimezoneOption[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const supported = supportedValuesOf ? supportedValuesOf("timeZone") : FALLBACK_TIMEZONES;
  const ids = [...new Set(["UTC", currentValue, ...supported].filter(Boolean))];
  return ids.map((id) => timezoneOption(id, now)).sort((left, right) => {
    const offsetOrder = offsetMinutes(left.offset) - offsetMinutes(right.offset);
    return offsetOrder || left.city.localeCompare(right.city) || left.id.localeCompare(right.id);
  });
}

export function timezoneOption(id: string, now = new Date()): TimezoneOption {
  const segments = id.split("/");
  const city = (segments.at(-1) ?? id).replaceAll("_", " ");
  const region = segments.length > 1 ? segments.slice(0, -1).join(" / ").replaceAll("_", " ") : "Coordinated Universal Time";
  const offset = timezoneOffset(id, now);
  return {
    id,
    city,
    region: id === "UTC" ? region : `${region} · ${id}`,
    offset,
    searchValue: `${city} ${region} ${id} ${offset} ${offset.replace("UTC", "GMT")}`,
  };
}

export function timezoneOffset(id: string, now = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((candidate) => candidate.type === "timeZoneName")?.value;
    if (!part || part === "GMT") return "UTC";
    return part.replace(/^GMT/, "UTC");
  } catch {
    return "Custom";
  }
}

function offsetMinutes(value: string): number {
  const match = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) return value === "UTC" ? 0 : Number.MAX_SAFE_INTEGER;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

const FALLBACK_TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];
