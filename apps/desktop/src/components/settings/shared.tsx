import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { JsonValue } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Card } from "@berry/desktop-ui/components/ui/card";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { cn } from "@berry/desktop-ui/lib/utils";
import { host } from "@/lib/berry";

/* ------------------------------------------------------------------ */
/* Settings persistence                                                */
/* ------------------------------------------------------------------ */

export function settingQueryKey(key: string): readonly unknown[] {
  return ["settings", key] as const;
}

/** Read a single settings key from the host. */
export function useSetting(key: string) {
  return useQuery({
    queryKey: settingQueryKey(key),
    queryFn: () => host.call<JsonValue | null>("settings.get", { key }),
  });
}

/** Write a settings key optimistically; rolls back and toasts on failure. */
export function useSetSetting(key: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: JsonValue) => host.call("settings.set", { key, value }),
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey: settingQueryKey(key) });
      const previous = queryClient.getQueryData<JsonValue | null>(settingQueryKey(key));
      queryClient.setQueryData(settingQueryKey(key), value);
      return { previous: previous ?? null };
    },
    onError: (_error, _value, context) => {
      queryClient.setQueryData(settingQueryKey(key), context?.previous ?? null);
      toast.error("Could not save setting", { description: key });
    },
  });
}

export function useBooleanSetting(key: string, fallback: boolean) {
  const query = useSetting(key);
  const mutation = useSetSetting(key);
  const value = typeof query.data === "boolean" ? query.data : fallback;
  return { value, set: (next: boolean) => mutation.mutate(next), isPending: query.isPending };
}

export function useStringSetting(key: string, fallback: string) {
  const query = useSetting(key);
  const mutation = useSetSetting(key);
  const value = typeof query.data === "string" ? query.data : fallback;
  return { value, set: (next: string) => mutation.mutate(next), isPending: query.isPending };
}

export function useNumberSetting(key: string, fallback: number) {
  const query = useSetting(key);
  const mutation = useSetSetting(key);
  const value = typeof query.data === "number" ? query.data : fallback;
  return { value, set: (next: number) => mutation.mutate(next), isPending: query.isPending };
}

/* ------------------------------------------------------------------ */
/* Page scaffolding                                                    */
/* ------------------------------------------------------------------ */

export function SettingsPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SettingsSectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-sm font-medium text-muted-foreground", className)}>{children}</h2>;
}

/** A rounded card that stacks setting rows separated by hairlines. */
export function SettingCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card className={cn("block divide-y divide-border overflow-hidden rounded-xl border-border py-0", className)}>
      {children}
    </Card>
  );
}

/** Title + description on the left, control on the right, optional body below. */
export function SettingRow({
  title,
  description,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-8">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-medium">{title}</div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {control ? <div className="flex shrink-0 items-center">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A boolean setting rendered as a right-aligned switch. */
export function SwitchSettingRow({
  title,
  description,
  settingKey,
  defaultValue = false,
}: {
  title: string;
  description?: string;
  settingKey: string;
  defaultValue?: boolean;
}) {
  const { value, set } = useBooleanSetting(settingKey, defaultValue);
  return (
    <SettingRow
      title={title}
      description={description}
      control={<Switch checked={value} onCheckedChange={set} aria-label={title} />}
    />
  );
}

/** A string setting rendered as a full-width input with an explicit Save. */
export function TextSettingRow({
  title,
  description,
  settingKey,
  placeholder,
  mono = false,
}: {
  title: string;
  description?: string;
  settingKey: string;
  placeholder?: string;
  mono?: boolean;
}) {
  const query = useSetting(settingKey);
  const mutation = useSetSetting(settingKey);
  const [draft, setDraft] = useState<string | null>(null);
  const saved = typeof query.data === "string" ? query.data : "";
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;

  const save = () => {
    if (!dirty) return;
    mutation.mutate(value);
    setDraft(null);
  };

  return (
    <SettingRow
      title={title}
      description={description}
      control={
        <Button size="sm" variant="secondary" disabled={!dirty} onClick={save}>
          Save
        </Button>
      }
    >
      <Input
        value={value}
        placeholder={placeholder}
        aria-label={title}
        className={cn(mono && "font-mono text-xs")}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
    </SettingRow>
  );
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const integerFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return integerFormat.format(Math.round(value));
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return integerFormat.format(value);
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullDayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export function formatDay(isoDate: string): string {
  return dayFormat.format(new Date(`${isoDate}T00:00:00`));
}

export function formatFullDay(isoDate: string): string {
  return fullDayFormat.format(new Date(`${isoDate}T00:00:00`));
}
