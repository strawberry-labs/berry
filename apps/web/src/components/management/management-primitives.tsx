import { AlertCircle, CheckCircle2, LockKeyhole, RefreshCw, Search, X } from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Card, CardContent, CardHeader } from "@berry/desktop-ui/components/ui/card";
import { Checkbox } from "@berry/desktop-ui/components/ui/checkbox";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@berry/desktop-ui/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@berry/desktop-ui/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@berry/desktop-ui/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@berry/desktop-ui/components/ui/sheet";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Spinner } from "@berry/desktop-ui/components/ui/spinner";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@berry/desktop-ui/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";

export { Button, Checkbox, Input, Select, Switch, Textarea };

export function ManagementPage({ title, description, eyebrow, actions, children, status }: { title: string; description: string; eyebrow?: string; actions?: ReactNode; children: ReactNode; status?: ReactNode }) {
  return <div className="mgmt-page"><Card className="mgmt-page-card"><CardHeader className="mgmt-page-header"><div>{eyebrow ? <span className="mgmt-eyebrow">{eyebrow}</span> : null}<h1>{title}</h1><p>{description}</p></div>{actions ? <div className="mgmt-page-actions">{actions}</div> : null}</CardHeader>{status}<CardContent className="mgmt-page-body">{children}</CardContent></Card></div>;
}

export function AsyncState({ loading, error, onRetry, children, empty = false, emptyTitle = "Nothing here yet", emptyText = "New records will appear here when they are available." }: { loading: boolean; error: string | null; onRetry: () => void; children: ReactNode; empty?: boolean; emptyTitle?: string; emptyText?: string }) {
  if (loading) return <div className="mgmt-state" role="status" aria-live="polite"><Skeleton className="mgmt-loading-mark" /><Spinner /><strong>Loading</strong><span>Fetching the latest organization data…</span></div>;
  if (error) return <div className="mgmt-state mgmt-state-error" role="alert"><AlertCircle /><strong>Couldn’t load this screen</strong><span>{error}</span><Button variant="outline" onClick={onRetry}><RefreshCw />Retry</Button></div>;
  if (empty) return <Empty className="mgmt-state"><EmptyHeader><EmptyMedia variant="icon"><span className="mgmt-empty-mark" /></EmptyMedia><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{emptyText}</EmptyDescription></EmptyHeader></Empty>;
  return <>{children}</>;
}

export function PermissionDenied({ label = "this screen" }: { label?: string }) {
  return <div className="mgmt-state mgmt-state-denied" role="alert"><LockKeyhole /><strong>Insufficient permission</strong><span>You don’t have permission to view {label}. Ask an organization owner to update your role.</span></div>;
}

export function MetricGrid({ items }: { items: Array<{ label: string; value: string; hint?: string; status?: "good" | "warning" | "danger" }> }) {
  return <section className="mgmt-metrics" aria-label="Summary metrics">{items.map((item) => <Card key={item.label} className="mgmt-metric-card" data-status={item.status}><CardContent><span>{item.label}</span><strong>{item.value}</strong>{item.hint ? <small>{item.hint}</small> : null}</CardContent></Card>)}</section>;
}

export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <Card className="mgmt-section"><CardHeader><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{actions}</CardHeader><CardContent>{children}</CardContent></Card>;
}

export function DataTable({ label, columns, rows, onRowSelect, activeRow, rowLabel }: { label: string; columns: string[]; rows: Array<Array<ReactNode>>; onRowSelect?: (index: number) => void; activeRow?: number | null; rowLabel?: (index: number) => string }) {
  const interactive = Boolean(onRowSelect);
  return <div className="mgmt-table-wrap"><Table className={interactive ? "mgmt-table mgmt-table-interactive" : "mgmt-table"}><TableCaption className="sr-only">{label}</TableCaption><TableHeader><TableRow>{columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={index} aria-selected={activeRow === index ? true : undefined} data-active={activeRow === index ? "" : undefined} data-state={activeRow === index ? "selected" : undefined} {...(interactive ? { tabIndex: 0, role: "button", "aria-label": rowLabel?.(index), onClick: () => onRowSelect?.(index), onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowSelect?.(index); } } } : {})}>{row.map((cell, cellIndex) => <TableCell key={cellIndex}>{cell}</TableCell>)}</TableRow>)}</TableBody></Table></div>;
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warning" | "danger" | "info" }) {
  const variant = tone === "danger" ? "destructive" : tone === "neutral" ? "outline" : tone === "good" ? "default" : "secondary";
  return <Badge variant={variant} className="mgmt-status" data-tone={tone}>{children}</Badge>;
}

function tickLabel(value: unknown) { const text = String(value); return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(5) : text; }

export function MiniSeries({ label, points, format = (value) => String(value) }: { label: string; points: Array<{ label: string; value: number }>; format?: (value: number) => string }) {
  const reactId = React.useId().replace(/[:]/g, "");
  const config = { value: { label, color: "var(--berry-accent)" } } satisfies ChartConfig;
  return <figure className="mgmt-series"><figcaption>{label}</figcaption>{points.length ? <ChartContainer config={config} className="mgmt-chart aspect-auto w-full"><AreaChart data={points} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}><defs><linearGradient id={`mgmt-fill-${reactId}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.24} /><stop offset="100%" stopColor="var(--color-value)" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid vertical={false} strokeDasharray="3 3" /><XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={tickLabel} /><YAxis tickLine={false} axisLine={false} width={54} tickFormatter={(value) => format(Number(value))} /><ChartTooltip cursor={{ stroke: "var(--berry-border-strong)" }} content={<ChartTooltipContent hideIndicator formatter={(value) => format(Number(value))} />} /><Area type="monotone" dataKey="value" stroke="var(--color-value)" strokeWidth={2} fill={`url(#mgmt-fill-${reactId})`} dot={false} isAnimationActive={false} /></AreaChart></ChartContainer> : <p className="mgmt-muted">No activity in this period.</p>}<p className="sr-only">{points.map((point) => `${point.label}: ${format(point.value)}`).join("; ")}</p></figure>;
}

export function DualTrend({ label, points, spendFormat, requestLabel = "Requests" }: { label: string; points: Array<{ label: string; spend: number; requests: number }>; spendFormat: (value: number) => string; requestLabel?: string }) {
  const config = { spend: { label, color: "var(--berry-accent)" }, requests: { label: requestLabel, color: "var(--berry-text-tertiary)" } } satisfies ChartConfig;
  return <figure className="mgmt-series"><figcaption>{label}</figcaption>{points.length ? <ChartContainer config={config} className="mgmt-chart aspect-auto w-full"><ComposedChart data={points} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}><CartesianGrid vertical={false} strokeDasharray="3 3" /><XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={tickLabel} /><YAxis yAxisId="spend" tickLine={false} axisLine={false} width={54} tickFormatter={(value) => spendFormat(Number(value))} /><YAxis yAxisId="requests" orientation="right" tickLine={false} axisLine={false} width={44} tickFormatter={(value) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(Number(value))} /><ChartTooltip cursor={{ fill: "var(--berry-hover)" }} content={<ChartTooltipContent />} /><ChartLegend content={<ChartLegendContent />} /><Bar yAxisId="requests" dataKey="requests" fill="var(--color-requests)" radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} opacity={0.5} /><Line yAxisId="spend" type="monotone" dataKey="spend" stroke="var(--color-spend)" strokeWidth={2} dot={false} isAnimationActive={false} /></ComposedChart></ChartContainer> : <p className="mgmt-muted">No activity in this period.</p>}<p className="sr-only">{points.map((point) => `${point.label}: ${spendFormat(point.spend)}, ${point.requests} ${requestLabel}`).join("; ")}</p></figure>;
}

export function SuccessMessage({ children }: { children: ReactNode }) { return <p className="mgmt-success" role="status" aria-live="polite"><CheckCircle2 />{children}</p>; }
export function Toolbar({ children }: { children: ReactNode }) { return <div className="mgmt-toolbar">{children}</div>; }
export function formatMoney(micros: string | number | bigint | null | undefined) { const value = Number(micros ?? 0) / 1_000_000; return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 2 : 0 }).format(value); }
export function formatNumber(value: number) { return new Intl.NumberFormat().format(value); }
export function formatDate(value: string | number | Date | null | undefined) { if (value == null) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
export function formatDateTime(value: string | number | Date | null | undefined) { if (value == null) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

export function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <InputGroup className="mgmt-searchbox"><InputGroupAddon><Search aria-hidden /></InputGroupAddon><InputGroupInput aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={placeholder} /></InputGroup>;
}

export function FormSelect({ name, value, defaultValue, onChange, options, placeholder, required, disabled, className }: { name?: string; value?: string; defaultValue?: string; onChange?: (value: string) => void; options: Array<{ value: string; label: string }>; placeholder?: string; required?: boolean; disabled?: boolean; className?: string }) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? options[0]?.value ?? "");
  const selectedValue = value ?? uncontrolledValue;
  const selectedLabel = options.find((option) => option.value === selectedValue)?.label;
  React.useEffect(() => { if (value !== undefined) setUncontrolledValue(value); }, [value]);
  const handleValueChange = (next: string) => { setUncontrolledValue(next); onChange?.(next); };
  const rootProps = {
    value: selectedValue,
    onValueChange: handleValueChange,
    ...(required === undefined ? {} : { required }),
    ...(disabled === undefined ? {} : { disabled }),
  };
  return <div className="mgmt-form-select"><select className="mgmt-native-select" name={name} value={selectedValue} onChange={(event) => handleValueChange(event.currentTarget.value)} required={required} disabled={disabled} tabIndex={-1} aria-label={placeholder}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Select {...rootProps}><SelectTrigger aria-hidden="true" className={className}><SelectValue placeholder={placeholder}>{selectedLabel}</SelectValue></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>;
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className="mgmt-filter"><span>{label}</span><FormSelect value={value} onChange={onChange} options={options} /></label>;
}

export function ManagementSwitch({ checked, onCheckedChange, disabled, "aria-label": ariaLabel }: { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; "aria-label"?: string }) {
  const [initialized, setInitialized] = React.useState(false);
  return <Switch role="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} data-on={String(checked)} className={initialized ? "t-toggle is-init" : "t-toggle"} onCheckedChange={(next) => { setInitialized(true); onCheckedChange(next); }} />;
}

export function DetailDrawer({ title, subtitle, badge, onClose, children, footer }: { title: string; subtitle?: ReactNode; badge?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent side="right" showCloseButton={false} className="mgmt-drawer p-0 gap-0"><SheetHeader className="mgmt-drawer-head"><div><SheetTitle className="mgmt-drawer-title">{title}{badge}</SheetTitle>{subtitle ? <SheetDescription>{subtitle}</SheetDescription> : null}</div><Button type="button" variant="ghost" size="icon-sm" className="mgmt-drawer-close" onClick={onClose} aria-label="Close details"><X aria-hidden /></Button></SheetHeader><div className="mgmt-drawer-body">{children}</div>{footer ? <SheetFooter className="mgmt-drawer-foot">{footer}</SheetFooter> : null}</SheetContent></Sheet>;
}

export function DefinitionList({ items }: { items: Array<{ term: string; detail: ReactNode }> }) { return <dl className="mgmt-deflist">{items.map((item) => <div key={item.term}><dt>{item.term}</dt><dd>{item.detail}</dd></div>)}</dl>; }

export function TabBar({ tabs, active, onSelect, label }: { tabs: Array<{ id: string; label: string }>; active: string; onSelect: (id: string) => void; label: string }) {
  return <Tabs value={active} onValueChange={onSelect} className="mgmt-tabbar"><TabsList variant="line" aria-label={label}>{tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}</TabsList></Tabs>;
}
