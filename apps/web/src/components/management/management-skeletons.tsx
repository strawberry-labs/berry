import * as React from "react";
import type { ReactNode } from "react";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { cn } from "@berry/desktop-ui/lib/utils";
import { DataTable } from "./niko-settings-table";
import { SectionContext } from "./section-context";

/*
 * Loading placeholders that occupy exactly the space of the management
 * primitives they stand in for. Each one repeats the real component's box
 * model (padding, line heights, borders) and swaps text for a bar centred in
 * its line box, so nothing moves when the data arrives.
 */

type Size = number | string;

/** One placeholder block. Pulses unless the viewer prefers reduced motion. */
export function Bone({ width, height, className, style }: { width?: Size; height?: Size; className?: string; style?: React.CSSProperties }) {
  return (
    <Skeleton
      aria-hidden
      data-skeleton=""
      className={cn("shrink-0 rounded-[4px] bg-[var(--berry-selected)] motion-reduce:animate-none", className)}
      style={{ width, height, ...style }}
    />
  );
}

/** Bar heights for each text size, roughly the x-height plus ascenders. */
const TEXT_BAR = { xs: 8, md: 10, lg: 12, value: 16, title: 14 } as const;

/** A line of text: the full line box, with a bar centred inside it. */
export function TextBone({ width = "60%", line = 20, size = "md", className }: { width?: Size; line?: Size; size?: keyof typeof TEXT_BAR; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center", className)} style={{ height: line }} aria-hidden>
      <Bone width={width} height={TEXT_BAR[size]} className="max-w-full" />
    </span>
  );
}

/** Several lines of text; the last one is shorter, as wrapped prose is. */
export function TextLines({ lines, line = 20, size = "md", width = "80%", lastWidth = "55%" }: { lines: number; line?: number; size?: keyof typeof TEXT_BAR; width?: Size; lastWidth?: Size }) {
  return (
    <>
      {Array.from({ length: lines }, (_, index) => (
        <TextBone key={index} line={line} size={size} width={index === lines - 1 && lines > 1 ? lastWidth : width} />
      ))}
    </>
  );
}

/** Screen-reader announcement wrapper; renders its children in place. */
export function SkeletonRegion({ label = "Loading", children }: { label?: string; children: ReactNode }) {
  return (
    <div className="contents" role="status" aria-live="polite" aria-busy="true" aria-label={label} data-skeleton-region="">
      {children}
    </div>
  );
}

const panelFrame = "rounded-xl border border-border bg-card";

export type MetricGridSkeletonProps = {
  count?: number;
  compact?: boolean;
  /** Lines of hint text under the figure (the tallest cell sets the row). */
  hintLines?: number;
  /** Cells that draw a sparkline. */
  trend?: boolean;
};

/** Mirrors `MetricGrid`: the same ruled strip, column count and cell padding. */
export function MetricGridSkeleton({ count = 4, compact = false, hintLines = 1, trend = false }: MetricGridSkeletonProps) {
  const wide = count <= 5 ? count : count === 6 ? 3 : count === 9 ? 3 : 4;
  return (
    <section className={cn(panelFrame, "overflow-hidden")} aria-hidden>
      <div
        className="-mb-px -mr-px grid grid-cols-2 md:[grid-template-columns:repeat(var(--stat-cols),minmax(0,1fr))]"
        style={{ "--stat-cols": Math.max(1, wide) } as React.CSSProperties}
      >
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className={cn("flex min-w-0 flex-col border-b border-r border-border px-4", compact ? "py-3" : "py-3.5")}>
            <TextBone line="1lh" size="xs" width={index % 2 ? 72 : 92} className="text-xs" />
            <span className="mt-1.5 flex">
              <TextBone line={compact ? 24 : 28} size="value" width={compact ? 64 : 84} />
            </span>
            {hintLines > 0 ? (
              <span className="mt-1 grid">
                <TextLines lines={hintLines} line={16} size="xs" width="78%" lastWidth="46%" />
              </span>
            ) : null}
            {trend ? (
              <div className="mt-auto pt-2">
                <Bone height={28} width="100%" className="bg-[var(--berry-hover)]" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export type SectionSkeletonProps = {
  /** Width of the title bar, or false for a section without a title. */
  title?: Size | false;
  /** Lines of description under the title. */
  description?: number;
  /** Widths of header action buttons. */
  actions?: Size[];
  flush?: boolean;
  className?: string;
  children?: ReactNode;
};

/** Mirrors `Section`: card, header rhythm and body padding. */
export function SectionSkeleton({ title = 120, description = 0, actions = [], flush = false, className, children }: SectionSkeletonProps) {
  const hasHeader = title !== false || description > 0 || actions.length > 0;
  return (
    <section className={cn(panelFrame, "flex min-w-0 flex-col overflow-hidden", className)} aria-hidden>
      {hasHeader ? (
        <header className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5", flush ? "border-b border-border pb-3.5" : "pb-0")}>
          <div className="min-w-0 flex-1">
            {title !== false ? <TextBone line={20} size="md" width={title} /> : null}
            {description > 0 ? (
              <div className="mt-0.5 grid max-w-[72ch]">
                <TextLines lines={description} line={20} size="xs" width="70%" lastWidth="45%" />
              </div>
            ) : null}
          </div>
          {actions.length ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions.map((width, index) => <Bone key={index} width={width} height={32} className="rounded-lg" />)}
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

export type SettingRowSkeleton = {
  icon?: boolean;
  /** Lines of description under the title. */
  description?: number;
  /** The trailing control. */
  control?: "switch" | "select" | "button" | "text" | "none";
  /** Width of the control, for selects, buttons and text. */
  controlWidth?: Size;
  /** A control row under the copy, for textareas and other wide inputs. */
  stacked?: number;
};

/** Mirrors `SettingList` + `SettingRow`. */
export function SettingListSkeleton({ rows }: { rows: number | SettingRowSkeleton[] }) {
  const specs: SettingRowSkeleton[] = typeof rows === "number" ? Array.from({ length: rows }, () => ({ description: 1, control: "switch" })) : rows;
  return (
    <div className="grid divide-y divide-border" aria-hidden>
      {specs.map((row, index) => (
        <div key={index} className={cn("flex gap-x-6 gap-y-2.5 px-4 py-3", row.stacked ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between")}>
          <span className="flex min-w-0 flex-1 items-start gap-3">
            {row.icon ? <Bone width={16} height={16} className="mt-0.5" /> : null}
            <span className="grid min-w-0 flex-1 gap-0.5">
              <TextBone line={20} width={index % 2 ? 110 : 140} />
              {row.description ? <span className="grid max-w-[64ch]"><TextLines lines={row.description} line={20} size="xs" width="88%" lastWidth="52%" /></span> : null}
            </span>
          </span>
          {row.stacked ? <Bone height={row.stacked} width="100%" className="rounded-lg" /> : <SettingControlSkeleton row={row} />}
        </div>
      ))}
    </div>
  );
}

function SettingControlSkeleton({ row }: { row: SettingRowSkeleton }) {
  const control = row.control ?? "switch";
  if (control === "none") return null;
  if (control === "switch") return <Bone width={32} height={18} className="rounded-full" />;
  if (control === "text") return <TextBone line={20} width={row.controlWidth ?? 72} className="shrink-0" />;
  return <Bone width={row.controlWidth ?? (control === "select" ? 160 : 96)} height={32} className="rounded-lg" />;
}

export type TableSkeletonProps = {
  label: string;
  columns: string[];
  /** Placeholder rows; long tables stop at the table's own 36rem cap. */
  rows?: number;
  /** Lines in each column's cells: 2 for `CellStack` cells, "pill" for status pills. */
  cells?: Array<1 | 2 | "pill">;
  /** Show the search/filter toolbar bar (real tables show it past 5 rows). */
  toolbar?: boolean;
  /** Show the pagination bar (real tables show it past one page). */
  pagination?: boolean;
};

/** A `DataTable` with its real header and placeholder cells. */
export function TableSkeleton({ label, columns, rows = 6, cells = [], toolbar = rows > 5, pagination = false }: TableSkeletonProps) {
  const body = React.useMemo(
    () => Array.from({ length: rows }, (_, rowIndex) => columns.map((_, columnIndex) => {
      const kind = cells[columnIndex] ?? 1;
      const width = `${[78, 62, 70, 54, 66][(rowIndex + columnIndex) % 5]}%`;
      // Line boxes use `1lh` so they follow the table's own line height.
      if (kind === "pill") return <span className="flex h-6 items-center"><Bone width={64} height={20} className="rounded-full" /></span>;
      if (kind === 2) return (
        <span className="grid min-w-0 gap-0.5">
          <TextBone line="1lh" width={width} />
          <TextBone line="1lh" size="xs" width="48%" className="text-xs" />
        </span>
      );
      return <TextBone line="1lh" width={width} />;
    })),
    [cells, columns, rows],
  );
  return <DataTable label={label} columns={columns} rows={body} skeleton={{ toolbar, pagination }} initialPageSize={rows} />;
}

/** A chart area, optionally with the legend line the series charts draw above it. */
export function ChartSkeleton({ height = 200, legend = true }: { height?: number; legend?: boolean }) {
  return (
    <div className="min-w-0" aria-hidden>
      {legend ? (
        <div className="mb-2 flex items-center justify-between gap-3">
          <TextBone line="1lh" size="xs" width={88} className="text-xs" />
          <TextBone line="1lh" width={64} className="text-md" />
        </div>
      ) : null}
      <Bone height={height} width="100%" className="rounded-lg bg-[var(--berry-hover)]" />
    </div>
  );
}

/** Two series side by side, as `DualTrend` draws them. */
export function DualChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2" aria-hidden>
      <ChartSkeleton height={height} />
      <ChartSkeleton height={height} />
    </div>
  );
}

/** A donut with its legend, as `ShareDonut` and `HealthRings` draw them. */
export function DonutSkeleton({ items = 5 }: { items?: number }) {
  return (
    <div className="flex flex-col items-center gap-x-6 gap-y-3 sm:flex-row" aria-hidden>
      <div className="relative size-44 shrink-0">
        <Bone width="100%" height="100%" className="rounded-full bg-[var(--berry-hover)]" />
        <span className="absolute inset-[22px] rounded-full bg-card" />
      </div>
      <div className="grid w-full min-w-0 flex-1">
        {Array.from({ length: items }, (_, index) => (
          <span key={index} className="flex items-center gap-2.5 px-2 py-1.5">
            <Bone width={8} height={8} className="rounded-full" />
            <TextBone line="1lh" width={`${[64, 52, 58, 46, 40, 50][index % 6]}%`} className="flex-1 text-md" />
            <TextBone line="1lh" width={44} className="text-md" />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ranked rows with a bar under each, as `BreakdownBars` draws them. */
export function BreakdownSkeleton({ rows = 6, more = false }: { rows?: number; more?: boolean }) {
  return (
    <div aria-hidden>
      <div className="mb-1 flex items-center justify-between px-2 text-xs">
        <TextBone line="1lh" size="xs" width={72} />
        <TextBone line="1lh" size="xs" width={40} />
      </div>
      <div className="grid">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto_3rem] items-center gap-x-3 gap-y-1.5 px-2 py-1.5 text-md">
            <TextBone line="1lh" width={`${[58, 46, 52, 40, 48, 36][index % 6]}%`} />
            <TextBone line="1lh" width={48} />
            <TextBone line="1lh" size="xs" width={28} className="justify-end" />
            <div className="col-span-3">
              <Bone height={4} width={`${[92, 74, 60, 44, 32, 22][index % 6]}%`} className="rounded-full" />
            </div>
          </div>
        ))}
      </div>
      {more ? <TextBone line="1lh" size="xs" width={96} className="mt-1 px-2 text-xs" /> : null}
    </div>
  );
}

/** Generic body for screens that have not described their own skeleton. */
export function DefaultSkeleton() {
  return (
    <SectionSkeleton title={140} description={1} flush>
      <SettingListSkeleton rows={[{ description: 1, control: "select" }, { description: 1, control: "switch" }, { description: 1, control: "text" }]} />
    </SectionSkeleton>
  );
}
