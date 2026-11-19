import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Info,
  LockKeyhole,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Checkbox } from "@berry/desktop-ui/components/ui/checkbox";
import { Input } from "@berry/desktop-ui/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@berry/desktop-ui/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@berry/desktop-ui/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { AreaSparkline } from "@berry/desktop-ui/components/charts/sparkline";
import { cn } from "@berry/desktop-ui/lib/utils";
import { SectionContext } from "./section-context";
import { Bone, DefaultSkeleton, SkeletonRegion, TextBone, TextLines } from "./management-skeletons";

export { Button, Checkbox, Input, Select, Switch, Textarea };

type ManagementPageTabsValue = {
  activeTab: string;
  ariaLabel: string;
  onTabChange: (tab: string) => void;
  tabs: readonly { id: string; label: string }[];
};

const ManagementPageTabsContext = React.createContext<ManagementPageTabsValue | null>(null);

export function ManagementPageTabsProvider({
  value,
  children,
}: {
  value: ManagementPageTabsValue;
  children: ReactNode;
}) {
  return (
    <ManagementPageTabsContext.Provider value={value}>
      {children}
    </ManagementPageTabsContext.Provider>
  );
}

export type ManagementPageWidth = "narrow" | "regular" | "wide";

// Widths include the page's horizontal padding (64px at md and up).
const PAGE_WIDTH_CLASS: Record<ManagementPageWidth, string> = {
  narrow: "max-w-[824px]",
  regular: "max-w-[1104px]",
  wide: "max-w-[1384px]",
};

export function ManagementPage({
  title,
  description,
  eyebrow,
  actions,
  children,
  status,
  width = "regular",
}: {
  title: string;
  description: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  status?: ReactNode;
  /** narrow: settings lists, so controls sit near their labels. regular:
   * lists and tables with a few columns. wide: dashboards and wide tables. */
  width?: ManagementPageWidth;
}) {
  return (
    <ManagementPageFrame width={width} status={status} header={
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-balance text-h2 font-semibold leading-7 tracking-[-0.015em] text-foreground">
            {title}
          </h1>
          <p className="mt-1 max-w-[72ch] text-pretty text-md leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </header>
    }>
      {children}
    </ManagementPageFrame>
  );
}

function ManagementPageFrame({ width, header, status, children }: { width: ManagementPageWidth; header: ReactNode; status?: ReactNode; children: ReactNode }) {
  const pageTabs = React.useContext(ManagementPageTabsContext);
  const hasTabs = Boolean(pageTabs && pageTabs.tabs.length > 1);
  return (
    <section className={cn("berry-mgmt mx-auto flex w-full min-w-0 flex-col gap-5 px-5 pb-20 pt-[calc(var(--berry-titlebar-height)+0.75rem)] md:px-8 md:pt-7", PAGE_WIDTH_CLASS[width])} data-width={width}>
      {header}
      {hasTabs && pageTabs ? (
        <UnderlineTabs
          label={pageTabs.ariaLabel}
          tabs={pageTabs.tabs}
          active={pageTabs.activeTab}
          onSelect={pageTabs.onTabChange}
        />
      ) : null}
      {status}
      <div className="grid min-w-0 gap-5">{children}</div>
    </section>
  );
}

export type ManagementPageSkeletonProps = {
  width?: ManagementPageWidth;
  /** Real title when it is known before the screen loads. */
  title?: string;
  eyebrow?: boolean;
  /** Lines the description wraps to at desktop widths. */
  descriptionLines?: number;
  /** Widths of the header action controls. */
  actions?: number[];
  children?: ReactNode;
};

/** `ManagementPage` while its screen's code is still loading. */
export function ManagementPageSkeleton({ width = "regular", title, eyebrow = false, descriptionLines = 1, actions = [], children }: ManagementPageSkeletonProps) {
  return (
    <ManagementPageFrame width={width} header={
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          {eyebrow ? <TextBone line="1lh" size="xs" width={84} className="mb-1.5 text-xs" /> : null}
          {title ? (
            <h1 className="text-balance text-h2 font-semibold leading-7 tracking-[-0.015em] text-foreground">{title}</h1>
          ) : <TextBone line={28} size="title" width={160} />}
          <div className="mt-1 grid max-w-[72ch]">
            <TextLines lines={descriptionLines} line={20} size="md" width="92%" lastWidth="58%" />
          </div>
        </div>
        {actions.length ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions.map((actionWidth, index) => <Bone key={index} width={actionWidth} height={36} className="rounded-lg" />)}
          </div>
        ) : null}
      </header>
    }>
      <SkeletonRegion label={title ? `Loading ${title}` : "Loading"}>{children ?? <DefaultSkeleton />}</SkeletonRegion>
    </ManagementPageFrame>
  );
}

function UnderlineTabs({
  label,
  tabs,
  active,
  onSelect,
}: {
  label: string;
  tabs: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label={label} className="scroll-fade -mt-1 overflow-x-auto border-b border-border">
      <div className="flex min-w-max items-center gap-5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={tab.id === active ? "page" : undefined}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "-mb-px h-9 border-b-2 border-transparent text-md font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              tab.id === active && "border-foreground text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

const panelFrame = "rounded-xl border border-border bg-card";

export function AsyncState({
  loading,
  error,
  onRetry,
  children,
  empty = false,
  emptyTitle = "Nothing here yet",
  emptyText = "New records will appear here when they are available.",
  skeleton,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
  empty?: boolean;
  emptyTitle?: string;
  emptyText?: string;
  /** Placeholder shaped like the loaded content, so nothing moves when it
   * arrives. Defaults to a generic settings card. */
  skeleton?: ReactNode;
}) {
  if (loading)
    return <SkeletonRegion>{skeleton ?? <DefaultSkeleton />}</SkeletonRegion>;
  if (error)
    return (
      <div
        className={cn(panelFrame, "flex min-h-52 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center")}
        role="alert"
      >
        <AlertCircle className="mb-1 size-5 text-destructive" />
        <strong className="text-sm font-medium text-foreground">
          Couldn’t load this screen
        </strong>
        <span className="max-w-md text-md text-muted-foreground">{error}</span>
        <Button className="mt-3" variant="outline" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
      </div>
    );
  if (empty) return <EmptyPanel title={emptyTitle} description={emptyText} />;
  return <>{children}</>;
}

/** Quiet empty state: one line of what is missing and what fills it. */
export function EmptyPanel({
  title,
  description,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(panelFrame, "flex min-h-44 flex-col items-center justify-center gap-1 border-dashed bg-transparent px-6 py-8 text-center", className)}>
      {Icon ? <Icon className="mb-2 size-5 text-muted-foreground" aria-hidden /> : null}
      <strong className="text-sm font-medium text-foreground">{title}</strong>
      {description ? (
        <span className="max-w-md text-pretty text-md leading-5 text-muted-foreground">{description}</span>
      ) : null}
      {action ? <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function PermissionDenied({
  label = "this screen",
}: {
  label?: string;
}) {
  return (
    <div className="berry-mgmt w-full max-w-[1320px] px-5 pt-[calc(var(--berry-titlebar-height)+0.75rem)] md:px-8 md:pt-7" role="alert">
      <EmptyPanel
        icon={LockKeyhole}
        title="Insufficient permission"
        description={<>You don’t have permission to view {label}. Ask an organization owner to update your role.</>}
      />
    </div>
  );
}

export type MetricItem = {
  label: string;
  value: string;
  /** Unabbreviated value, shown on hover and read by assistive tech. */
  exactValue?: string;
  hint?: string;
  status?: "good" | "warning" | "danger";
  icon?: LucideIcon;
  /** Recent values, oldest first, drawn as a sparkline under the figure. */
  trend?: number[];
  /** Change against the previous period. */
  delta?: { label: string; direction: "up" | "down" | "flat"; sentiment?: "good" | "bad" | "neutral" };
};

/**
 * Headline figures as one ruled strip instead of a wall of separate cards, so
 * any count of metrics fills its rows and long production-scale numbers have
 * room to breathe.
 */
export function MetricGrid({
  items,
  compact = false,
}: {
  items: MetricItem[];
  compact?: boolean;
}) {
  const count = items.length;
  const wide = count <= 5 ? count : count === 6 ? 3 : count === 9 ? 3 : 4;
  return (
    <section
      className={cn(panelFrame, "overflow-hidden")}
      aria-label="Summary metrics"
    >
      <div
        className="mgmt-stat-grid -mb-px -mr-px grid grid-cols-2 md:[grid-template-columns:repeat(var(--stat-cols),minmax(0,1fr))]"
        style={{ "--stat-cols": Math.max(1, wide) } as React.CSSProperties}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={cn("mgmt-stat flex min-w-0 flex-col border-b border-r border-border px-4", compact ? "py-3" : "py-3.5")}
              data-status={item.status}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {item.status ? <i className="size-1.5 shrink-0 rounded-full bg-[var(--tone)]" aria-hidden /> : null}
                <span className="truncate">{item.label}</span>
                {Icon ? <Icon className="ml-auto size-3.5 shrink-0" aria-hidden /> : null}
              </span>
              <span className="mt-1.5 flex items-baseline gap-2">
                <strong
                  className={cn("truncate font-semibold tracking-[-0.02em] text-foreground tabular-nums", compact ? "text-lg leading-6" : "text-[22px] leading-7")}
                  title={item.exactValue ?? item.value}
                  aria-label={item.exactValue ?? item.value}
                >
                  {item.value}
                </strong>
                {item.delta ? <MetricDelta delta={item.delta} /> : null}
              </span>
              {item.hint ? (
                <small className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                  {item.hint}
                </small>
              ) : null}
              {item.trend && item.trend.length > 1 ? (
                <div className="mt-auto pt-2" aria-hidden>
                  <AreaSparkline
                    data={item.trend.map((value) => ({ value }))}
                    dataKey="value"
                    height={28}
                    strokeWidth={1.5}
                    fillOpacity={0.16}
                    interactive={false}
                    color={item.status ? "var(--tone)" : "var(--chart-line-primary)"}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MetricDelta({ delta }: { delta: NonNullable<MetricItem["delta"]> }) {
  const sentiment = delta.sentiment ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs font-medium",
        sentiment === "good" && "text-[var(--mgmt-tone-good)]",
        sentiment === "bad" && "text-[var(--mgmt-tone-danger)]",
        sentiment === "neutral" && "text-muted-foreground",
      )}
    >
      {delta.direction === "up" ? <ArrowUp className="size-3" aria-hidden /> : delta.direction === "down" ? <ArrowDown className="size-3" aria-hidden /> : null}
      {delta.label}
    </span>
  );
}


/**
 * A titled card. `flush` removes the body padding for content that brings its
 * own rows (tables, setting lists) so it never sits as a box inside a box.
 */
export function Section({
  title,
  description,
  actions,
  children,
  flush = false,
  className,
}: {
  title?: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  const hasHeader = Boolean(title || description || actions);
  return (
    <section className={cn(panelFrame, "flex min-w-0 flex-col overflow-hidden", className)}>
      {hasHeader ? (
        <header className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5", flush ? "border-b border-border pb-3.5" : "pb-0")}>
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-md font-semibold leading-5 text-foreground">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 max-w-[72ch] text-pretty text-xs leading-5 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          ) : null}
        </header>
      ) : null}
      <SectionContext.Provider value={flush ? "flush" : "padded"}>
        <div className={cn("min-w-0 flex-1", flush ? "" : hasHeader ? "px-4 pb-4 pt-3" : "p-4")}>{children}</div>
      </SectionContext.Provider>
    </section>
  );
}

/** A list of label/description rows with one control each, ruled by hairlines. */
export function SettingList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid divide-y divide-border", className)}>{children}</div>;
}

export function SettingRow({
  icon: Icon,
  iconContent,
  title,
  description,
  children,
  stacked = false,
}: {
  icon?: LucideIcon;
  iconContent?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Put the control under the copy; for wide controls such as textareas. */
  stacked?: boolean;
}) {
  return (
    <div className={cn("flex gap-x-6 gap-y-2.5 px-4 py-3", stacked ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between")}>
      <span className="flex min-w-0 items-start gap-3">
        {iconContent}
        {Icon ? <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
        <span className="grid min-w-0 gap-0.5">
          <b className="text-md font-medium leading-5 text-foreground">{title}</b>
          {description ? <small className="max-w-[64ch] text-pretty text-xs leading-5 text-muted-foreground">{description}</small> : null}
        </span>
      </span>
      {children ? <span className={cn("min-w-0", stacked ? "" : "shrink-0")}>{children}</span> : null}
    </div>
  );
}

export { DataTable } from "./niko-settings-table";

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "danger" | "info";
}) {
  return (
    <span className="mgmt-pill" data-tone={tone}>
      {children}
    </span>
  );
}

export function SuccessMessage({ children }: { children: ReactNode }) {
  return <InlineNotice tone="good">{children}</InlineNotice>;
}

/** One-line contextual message; the tone carries meaning, not decoration. */
export function InlineNotice({
  children,
  tone = "info",
  title,
  action,
}: {
  children?: ReactNode;
  tone?: "good" | "warning" | "danger" | "info";
  title?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "info" ? Info : AlertCircle;
  return (
    <div
      className="flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border border-[color-mix(in_srgb,var(--tone)_28%,transparent)] bg-[color-mix(in_srgb,var(--tone)_7%,transparent)] px-3 py-2.5 text-md leading-5 text-foreground"
      style={{ "--tone": `var(--mgmt-tone-${tone})` } as React.CSSProperties}
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      aria-live="polite"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-[var(--tone)]" aria-hidden />
      <div className="min-w-[min(100%,14rem)] flex-1">
        {title ? <strong className="block font-medium">{title}</strong> : null}
        {children ? <div className={cn(title && "text-muted-foreground")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
      {children}
    </div>
  );
}

/** Switches between views of the same data; page-level navigation uses tabs. */
export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <div
      className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[9px] bg-[var(--berry-surface-inset)] p-0.5"
      role="tablist"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 shrink-0 rounded-[7px] px-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value && "bg-card text-foreground shadow-[0_0_0_1px_var(--berry-border),0_1px_2px_oklch(0_0_0/0.08)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled share of a limit. Turns amber then red as it nears the cap. */
export function Meter({
  value,
  max,
  label,
  detail,
}: {
  value: number;
  max: number;
  label?: ReactNode;
  detail?: ReactNode;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const tone = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "info";
  return (
    <div className="grid min-w-24 gap-1">
      {label || detail ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="truncate text-foreground">{label}</span>
          <span className="shrink-0 text-muted-foreground">{detail}</span>
        </div>
      ) : null}
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[var(--berry-surface-inset)]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: `var(--mgmt-tone-${tone})` }} />
      </div>
    </div>
  );
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compactNumberPrecise = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
/** 41_812_000_000 → "41.8B". Pair with the exact value in a title or table. */
export function formatCompact(value: number | string | bigint | null | undefined) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "—";
  if (Math.abs(number) < 10_000) return new Intl.NumberFormat().format(number);
  return (Math.abs(number) >= 1e9 ? compactNumberPrecise : compactNumber).format(number);
}
export function formatCompactMoney(micros: string | number | bigint | null | undefined) {
  const value = Number(micros ?? 0) / 1_000_000;
  if (Math.abs(value) < 100_000) return formatMoney(micros);
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}
/**
 * A figure for table cells and lists: abbreviated for scanning, exact on
 * hover, and sortable/right-aligned as a number by the settings table.
 * `money` and `compact-money` take micro-USD.
 */
export function Num({
  value,
  kind = "compact",
}: {
  value: number | string | bigint | null | undefined;
  kind?: "number" | "compact" | "money" | "compact-money";
}) {
  const number = Number(value ?? 0);
  const money = kind === "money" || kind === "compact-money";
  const exact = money
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(number / 1_000_000)
    : formatNumber(number);
  const text =
    kind === "number" ? exact
    : kind === "compact" ? formatCompact(number)
    : kind === "money" ? formatMoney(number)
    : formatCompactMoney(number);
  return (
    <span title={exact} className="tabular-nums">
      {text}
    </span>
  );
}
Num.tableSortValue = (props: Record<string, unknown>) => Number(props.value ?? 0);
Num.tableAlignEnd = true;
/** Two-line table cell: a primary label with a quieter line underneath. */
export function CellStack({ primary, secondary, mono = false }: { primary: ReactNode; secondary?: ReactNode; mono?: boolean }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className={cn("truncate font-medium text-foreground", mono && "font-mono text-xs font-normal")}>{primary}</span>
      {secondary ? <span className="truncate text-xs text-muted-foreground">{secondary}</span> : null}
    </span>
  );
}
export function formatPercent(ratio: number | null | undefined, digits?: number) {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  const percent = ratio * 100;
  // Near the ceiling the decimals are the story: 98.6% and 99.94% must not both read "99%".
  const places = digits ?? (percent >= 99.5 && percent < 100 ? 2 : (percent >= 90 && percent < 100) || (percent > 0 && percent < 10) ? 1 : 0);
  return `${percent.toFixed(places)}%`;
}
export function formatDuration(value: number | null | undefined) {
  if (value == null) return "—";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}
export function formatMoney(
  micros: string | number | bigint | null | undefined,
) {
  const value = Number(micros ?? 0) / 1_000_000;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 10 ? 2 : 0,
  }).format(value);
}
export function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}
export function formatDate(value: string | number | Date | null | undefined) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}
export function formatDateTime(
  value: string | number | Date | null | undefined,
) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <InputGroup className="w-full sm:max-w-80">
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
      />
    </InputGroup>
  );
}

export function FormSelect({
  name,
  value,
  defaultValue,
  onChange,
  options,
  placeholder,
  required,
  disabled,
  className,
  ariaLabel,
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(
    defaultValue ?? options[0]?.value ?? "",
  );
  const selectedValue = value ?? uncontrolledValue;
  const selectedLabel = options.find(
    (option) => option.value === selectedValue,
  )?.label;
  React.useEffect(() => {
    if (value !== undefined) setUncontrolledValue(value);
  }, [value]);
  const handleValueChange = (next: string) => {
    setUncontrolledValue(next);
    onChange?.(next);
  };
  const rootProps = {
    value: selectedValue,
    onValueChange: handleValueChange,
    ...(required === undefined ? {} : { required }),
    ...(disabled === undefined ? {} : { disabled }),
  };
  return (
    <div className="relative w-full">
      <select
        className="pointer-events-none absolute size-px overflow-hidden opacity-0"
        name={name}
        value={selectedValue}
        onChange={(event) => handleValueChange(event.currentTarget.value)}
        required={required}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Select {...rootProps}>
        <SelectTrigger aria-label={ariaLabel ?? placeholder ?? "Select option"} className={cn("w-full", className)}>
          <SelectValue placeholder={placeholder}>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function FilterSelect({
  label,
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
    <label className="grid min-w-36 gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <FormSelect value={value} onChange={onChange} options={options} ariaLabel={label} />
    </label>
  );
}

export function ManagementSwitch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  title,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  title?: string;
}) {
  return (
    <Switch
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      title={title}
      onCheckedChange={onCheckedChange}
    />
  );
}

export function DetailDrawer({
  title,
  subtitle,
  badge,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="berry-mgmt w-[min(480px,94vw)] gap-0 p-0 sm:max-w-[480px]"
      >
        <SheetHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <SheetTitle className="flex flex-wrap items-center gap-2 text-title font-semibold leading-6">
              {title}
              {badge}
            </SheetTitle>
            {subtitle ? (
              <SheetDescription className="mt-0.5 text-xs leading-5">{subtitle}</SheetDescription>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1.5 -mt-0.5 shrink-0"
            onClick={onClose}
            aria-label="Close details"
          >
            <X aria-hidden />
          </Button>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer ? (
          <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function ManagementDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "berry-mgmt max-h-[min(760px,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl border-border p-0 shadow-[0_24px_70px_oklch(0_0_0/0.28),0_2px_10px_oklch(0_0_0/0.14)]",
          size === "sm" && "sm:max-w-md",
          size === "md" && "sm:max-w-xl",
          size === "lg" && "sm:max-w-2xl",
        )}
      >
        <DialogHeader className="gap-1 border-b border-border px-5 py-4 pe-12">
          <DialogTitle className="text-title font-semibold leading-6 tracking-[-0.01em]">
            {title}
          </DialogTitle>
          <DialogDescription className="max-w-[62ch] text-xs leading-5 text-pretty">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <DialogFooter className="border-t border-border px-5 py-3">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionList({
  items,
  bare = false,
}: {
  items: Array<{ term: string; detail: ReactNode }>;
  /** Drop the outer border when a wrapping container (e.g. a scroller) draws it. */
  bare?: boolean;
}) {
  return (
    <dl className={cn("grid divide-y divide-border", !bare && "overflow-hidden rounded-lg border border-border")}>
      {items.map((item) => (
        <div
          className="grid gap-0.5 px-3 py-2 sm:grid-cols-[minmax(110px,0.7fr)_minmax(0,1.6fr)] sm:items-baseline sm:gap-4"
          key={item.term}
        >
          <dt className="text-xs text-muted-foreground">
            {item.term}
          </dt>
          <dd className="min-w-0 break-words text-md text-foreground">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TabBar({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <SegmentedControl
      label={label}
      value={active}
      onChange={onSelect}
      options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
    />
  );
}
