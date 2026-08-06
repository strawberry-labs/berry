import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@berry/desktop-ui/components/ui/card";
import { Checkbox } from "@berry/desktop-ui/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@berry/desktop-ui/components/ui/popover";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@berry/desktop-ui/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@berry/desktop-ui/components/ui/tabs";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { cn } from "@berry/desktop-ui/lib/utils";

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

export function ManagementPage({
  title,
  description,
  eyebrow,
  actions,
  children,
  status,
}: {
  title: string;
  description: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  status?: ReactNode;
}) {
  const pageTabs = React.useContext(ManagementPageTabsContext);
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-[1120px] flex-col gap-5 px-5 pb-16 pt-[calc(var(--berry-titlebar-height)+1rem)] md:px-7 md:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          {eyebrow ? (
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-balance text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-1.5 max-w-[62ch] text-pretty text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </header>
      {pageTabs && pageTabs.tabs.length > 1 ? (
        <Tabs value={pageTabs.activeTab} onValueChange={pageTabs.onTabChange}>
          <div className="scroll-fade overflow-x-auto border-b border-border">
            <TabsList
              variant="line"
              aria-label={pageTabs.ariaLabel}
              className="min-w-max px-0"
            >
              {pageTabs.tabs.map((tab) => (
                <TabsTrigger key={tab.id} value={tab.id} className="px-3">
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      ) : null}
      {status}
      <div className="grid min-w-0 gap-4">{children}</div>
    </main>
  );
}

export function AsyncState({
  loading,
  error,
  onRetry,
  children,
  empty = false,
  emptyTitle = "Nothing here yet",
  emptyText = "New records will appear here when they are available.",
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
  empty?: boolean;
  emptyTitle?: string;
  emptyText?: string;
}) {
  if (loading)
    return (
      <div
        className="flex min-h-44 items-center justify-center rounded-xl border border-border bg-card"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <CircularActivitySpinner size={28} label="Loading organization data" />
      </div>
    );
  if (error)
    return (
      <div
        className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-8 text-center"
        role="alert"
      >
        <AlertCircle className="size-5 text-destructive" />
        <strong className="text-sm text-foreground">
          Couldn’t load this screen
        </strong>
        <span className="max-w-md text-sm text-muted-foreground">{error}</span>
        <Button className="mt-2" variant="outline" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
      </div>
    );
  if (empty)
    return (
      <Empty className="min-h-44 rounded-xl border border-border bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <span className="size-2 rounded-full bg-muted-foreground/50" />
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyText}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return <>{children}</>;
}

export function PermissionDenied({
  label = "this screen",
}: {
  label?: string;
}) {
  return (
    <div
      className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 px-6 py-8 text-center"
      role="alert"
    >
      <LockKeyhole className="size-5 text-muted-foreground" />
      <strong className="text-sm text-foreground">
        Insufficient permission
      </strong>
      <span className="max-w-md text-sm text-muted-foreground">
        You don’t have permission to view {label}. Ask an organization owner to
        update your role.
      </span>
    </div>
  );
}

export function MetricGrid({
  items,
  compact = false,
}: {
  items: Array<{
    label: string;
    value: string;
    exactValue?: string;
    hint?: string;
    status?: "good" | "warning" | "danger";
    icon?: LucideIcon;
  }>;
  compact?: boolean;
}) {
  return (
    <section
      className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(145px,1fr))]"
      aria-label="Summary metrics"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
        <Card
          key={item.label}
          className="min-w-0 gap-0 py-0 shadow-none"
          data-status={item.status}
        >
          <CardContent className={cn("grid gap-1 px-4", compact ? "py-3" : "py-4")}>
            <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
              <span>{item.label}</span>{Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
            </span>
            <strong className={cn("font-semibold tracking-tight text-foreground tabular-nums", compact ? "text-lg" : "text-xl")} title={item.exactValue} aria-label={item.exactValue ?? item.value}>
              {item.value}
            </strong>
            {item.hint ? (
              <small className="text-xs leading-5 text-muted-foreground">
                {item.hint}
              </small>
            ) : null}
          </CardContent>
        </Card>
      );})}
    </section>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0 shadow-none">
      {title || description || actions ? <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-4 py-4">
        <div className="min-w-0">
          {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
          {description ? (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </CardHeader> : null}
      <CardContent className="min-w-0 px-4 py-4">{children}</CardContent>
    </Card>
  );
}

function LegacyDataTable({
  label,
  columns,
  rows,
  onRowSelect,
  activeRow,
  rowLabel,
  initialPageSize = 10,
  searchable = rows.length > 5,
}: {
  label: string;
  columns: string[];
  rows: Array<Array<ReactNode>>;
  onRowSelect?: (index: number) => void;
  activeRow?: number | null;
  rowLabel?: (index: number) => string;
  initialPageSize?: number;
  searchable?: boolean;
}) {
  const interactive = Boolean(onRowSelect);
  const [query, setQuery] = React.useState("");
  const [filterJoin, setFilterJoin] = React.useState<"and" | "or">("and");
  const [filterRules, setFilterRules] = React.useState<
    Array<{
      id: number;
      column: number;
      operator: "contains" | "equals" | "not_contains";
      value: string;
    }>
  >([]);
  const [sorting, setSorting] = React.useState<{
    column: number;
    direction: "asc" | "desc";
  } | null>(null);
  const [pageSize, setPageSize] = React.useState(initialPageSize);
  const [pageIndex, setPageIndex] = React.useState(0);
  const activeFilterRules = React.useMemo(
    () => filterRules.filter((rule) => rule.value.trim()),
    [filterRules],
  );
  const indexedRows = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (
          normalizedQuery &&
          !sortableText(row).toLocaleLowerCase().includes(normalizedQuery)
        )
          return false;
        if (!activeFilterRules.length) return true;
        const matches = activeFilterRules.map((rule) => {
          const cell = sortableText(row[rule.column]).toLocaleLowerCase();
          const value = rule.value.trim().toLocaleLowerCase();
          if (rule.operator === "equals") return cell === value;
          if (rule.operator === "not_contains") return !cell.includes(value);
          return cell.includes(value);
        });
        return filterJoin === "and"
          ? matches.every(Boolean)
          : matches.some(Boolean);
      });
  }, [activeFilterRules, filterJoin, query, rows]);
  const sortedRows = React.useMemo(() => {
    if (!sorting) return indexedRows;
    return [...indexedRows].sort((a, b) => {
      const left = sortableText(a.row[sorting.column]);
      const right = sortableText(b.row[sorting.column]);
      const result = left.localeCompare(right, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return sorting.direction === "asc" ? result : -result;
    });
  }, [indexedRows, sorting]);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const start = safePageIndex * pageSize;
  const visibleRows = sortedRows.slice(start, start + pageSize);

  React.useEffect(() => {
    setPageIndex(0);
  }, [activeFilterRules, filterJoin, pageSize, query, rows, sorting]);

  function addFilterRule() {
    setFilterRules((current) => [
      ...current,
      {
        id: Date.now(),
        column: 0,
        operator: "contains",
        value: "",
      },
    ]);
  }

  function toggleSort(column: number) {
    setSorting((current) => {
      if (!current || current.column !== column)
        return { column, direction: "asc" };
      if (current.direction === "asc") return { column, direction: "desc" };
      return null;
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_1px_oklch(0_0_0/0.02)]">
      {searchable ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 p-3">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={`Filter ${label.toLocaleLowerCase()}…`}
            label={`Filter ${label}`}
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                aria-label={`Advanced filters for ${label}`}
              >
                <Filter aria-hidden />
                Filters
                {activeFilterRules.length ? (
                  <Badge variant="secondary" className="ml-0.5 tabular-nums">
                    {activeFilterRules.length}
                  </Badge>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(92vw,32rem)] p-0">
              <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Filter {label.toLocaleLowerCase()}
                  </h3>
                  <p className="mt-0.5 text-xs leading-5 text-foreground">
                    Combine column rules to narrow the visible records.
                  </p>
                </div>
                {filterRules.length > 1 ? (
                  <label className="grid shrink-0 gap-1 text-xs font-medium text-foreground">
                    Match
                    <select
                      className="h-10 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:text-xs"
                      value={filterJoin}
                      onChange={(event) =>
                        setFilterJoin(
                          event.currentTarget.value === "or" ? "or" : "and",
                        )
                      }
                    >
                      <option value="and">All rules</option>
                      <option value="or">Any rule</option>
                    </select>
                  </label>
                ) : null}
              </div>
              <div className="grid max-h-80 gap-2 overflow-y-auto p-3">
                {filterRules.length ? (
                  filterRules.map((rule, index) => (
                    <div
                      key={rule.id}
                      className="grid gap-2 rounded-lg border border-border bg-muted/20 p-2 sm:grid-cols-[1fr_1fr_1.25fr_auto]"
                    >
                      <label className="grid gap-1 text-xs font-medium text-foreground">
                        Column
                        <select
                          aria-label={`Column for filter ${index + 1}`}
                          className="h-10 min-w-0 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:text-xs"
                          value={rule.column}
                          onChange={(event) => {
                            const column = Number(event.currentTarget.value);
                            setFilterRules((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      column,
                                    }
                                  : item,
                              ),
                            );
                          }}
                        >
                          {columns.map((column, columnIndex) => (
                            <option key={column} value={columnIndex}>
                              {column}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-foreground">
                        Condition
                        <select
                          aria-label={`Condition for filter ${index + 1}`}
                          className="h-10 min-w-0 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:text-xs"
                          value={rule.operator}
                          onChange={(event) => {
                            const operator = event.currentTarget.value as
                              "contains" | "equals" | "not_contains";
                            setFilterRules((current) =>
                              current.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      operator,
                                    }
                                  : item,
                              ),
                            );
                          }}
                        >
                          <option value="contains">Contains</option>
                          <option value="equals">Equals</option>
                          <option value="not_contains">Does not contain</option>
                        </select>
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-foreground">
                        Value
                        <Input
                          aria-label={`Value for filter ${index + 1}`}
                          value={rule.value}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setFilterRules((current) =>
                              current.map((item) =>
                                item.id === rule.id ? { ...item, value } : item,
                              ),
                            );
                          }}
                        />
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="self-end"
                        aria-label={`Remove filter ${index + 1}`}
                        onClick={() =>
                          setFilterRules((current) =>
                            current.filter((item) => item.id !== rule.id),
                          )
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-foreground">
                    No column filters. Add a rule to build a focused view.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={addFilterRule}
                >
                  <Plus aria-hidden />
                  Add rule
                </Button>
                {filterRules.length ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setFilterRules([])}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
      <div className="max-w-full overflow-x-auto">
        <Table>
          <TableCaption className="sr-only">{label}</TableCaption>
          <TableHeader>
            <TableRow>
              {columns.map((column, columnIndex) => {
                const direction =
                  sorting?.column === columnIndex ? sorting.direction : null;
                const SortIcon =
                  direction === "asc"
                    ? ArrowUp
                    : direction === "desc"
                      ? ArrowDown
                      : ArrowUpDown;
                return (
                  <TableHead
                    key={column}
                    aria-sort={
                      direction === "asc"
                        ? "ascending"
                        : direction === "desc"
                          ? "descending"
                          : "none"
                    }
                    className="h-10 whitespace-nowrap p-0"
                  >
                    <button
                      type="button"
                      className="flex min-h-10 w-full items-center gap-1.5 px-3 text-start text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => toggleSort(columnIndex)}
                    >
                      <span>{column}</span>
                      <SortIcon
                        className={cn(
                          "size-3.5 shrink-0",
                          direction ? "text-foreground" : "opacity-45",
                        )}
                        aria-hidden
                      />
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.length ? (
              visibleRows.map(({ row, index }) => (
                <TableRow
                  key={index}
                  className={cn(
                    "transition-colors",
                    interactive &&
                      "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    activeRow === index && "bg-muted/60",
                  )}
                  aria-selected={activeRow === index ? true : undefined}
                  data-state={activeRow === index ? "selected" : undefined}
                  {...(interactive
                    ? {
                        tabIndex: 0,
                        role: "button",
                        "aria-label": rowLabel?.(index),
                        onClick: () => onRowSelect?.(index),
                        onKeyDown: (
                          event: React.KeyboardEvent<HTMLTableRowElement>,
                        ) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowSelect?.(index);
                          }
                        },
                      }
                    : {})}
                >
                  {row.map((cell, cellIndex) => (
                    <TableCell key={cellIndex}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-28 text-center"
                >
                  <strong className="block text-sm font-medium text-foreground">
                    No {label.toLowerCase()}
                  </strong>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {query || activeFilterRules.length
                      ? "Adjust or clear the active filters."
                      : "Add the first record to get started."}
                  </span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-3 py-1.5 text-xs text-foreground">
        <span className="tabular-nums" aria-live="polite">
          {sortedRows.length
            ? `${start + 1}–${Math.min(start + pageSize, sortedRows.length)} of ${sortedRows.length}${
                query || activeFilterRules.length
                  ? ` matching ${rows.length}`
                  : ""
              }`
            : "0 results"}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 whitespace-nowrap">
            <span>Rows per page</span>
            <select
              className="h-10 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:text-xs"
              value={pageSize}
              onChange={(event) =>
                setPageSize(Number(event.currentTarget.value))
              }
            >
              {[10, 25, 50].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span className="min-w-16 text-center tabular-nums">
            Page {safePageIndex + 1} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-10 md:size-8"
              disabled={safePageIndex === 0}
              onClick={() =>
                setPageIndex((current) => Math.max(0, current - 1))
              }
              aria-label={`Previous page of ${label}`}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-10 md:size-8"
              disabled={safePageIndex >= pageCount - 1}
              onClick={() =>
                setPageIndex((current) => Math.min(pageCount - 1, current + 1))
              }
              aria-label={`Next page of ${label}`}
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function sortableText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  )
    return String(node);
  if (Array.isArray(node)) return node.map(sortableText).join(" ");
  if (React.isValidElement<{ children?: ReactNode }>(node))
    return sortableText(node.props.children);
  return "";
}

export { DataTable } from "./niko-settings-table";

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "danger" | "info";
}) {
  const variant =
    tone === "danger"
      ? "destructive"
      : tone === "neutral"
        ? "outline"
        : tone === "good"
          ? "default"
          : "secondary";
  return (
    <Badge variant={variant} className="font-normal" data-tone={tone}>
      {children}
    </Badge>
  );
}

export function SuccessMessage({ children }: { children: ReactNode }) {
  return (
    <p
      className="flex items-center gap-2 rounded-lg border border-[var(--berry-success)]/25 bg-[var(--berry-success)]/5 px-3 py-2 text-xs text-[var(--berry-success)]"
      role="status"
      aria-live="polite"
    >
      <CheckCircle2 className="size-4" />
      {children}
    </p>
  );
}
export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
      {children}
    </div>
  );
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
        aria-label={placeholder}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Select {...rootProps}>
        <SelectTrigger aria-hidden="true" className={cn("w-full", className)}>
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
      <FormSelect value={value} onChange={onChange} options={options} />
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
        className="w-[min(440px,94vw)] gap-0 p-0 sm:max-w-[440px]"
      >
        <SheetHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              {title}
              {badge}
            </SheetTitle>
            {subtitle ? (
              <SheetDescription className="mt-1">{subtitle}</SheetDescription>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 shrink-0"
            onClick={onClose}
            aria-label="Close details"
          >
            <X aria-hidden />
          </Button>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer ? (
          <SheetFooter className="border-t border-border px-5 py-4">
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
          "max-h-[min(760px,calc(100dvh-2rem))] gap-0 overflow-hidden rounded-xl border-border p-0 shadow-[0_24px_70px_oklch(0_0_0/0.28),0_2px_10px_oklch(0_0_0/0.14)]",
          size === "sm" && "sm:max-w-md",
          size === "md" && "sm:max-w-xl",
          size === "lg" && "sm:max-w-2xl",
        )}
      >
        <DialogHeader className="border-b border-border px-5 py-4 pe-12">
          <DialogTitle className="text-base leading-tight tracking-[-0.01em]">
            {title}
          </DialogTitle>
          <DialogDescription className="max-w-[62ch] text-xs leading-5 text-pretty">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <DialogFooter className="border-t border-border bg-muted/20 px-5 py-3">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionList({
  items,
}: {
  items: Array<{ term: string; detail: ReactNode }>;
}) {
  return (
    <dl className="grid divide-y divide-border rounded-xl border border-border">
      {items.map((item) => (
        <div
          className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(110px,0.8fr)_minmax(0,1.5fr)] sm:gap-4"
          key={item.term}
        >
          <dt className="text-xs font-medium text-muted-foreground">
            {item.term}
          </dt>
          <dd className="min-w-0 text-sm text-foreground">{item.detail}</dd>
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
    <Tabs value={active} onValueChange={onSelect} className="w-full">
      <TabsList
        variant="line"
        className="w-full justify-start overflow-x-auto border-b border-border"
        aria-label={label}
      >
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
