import { AlertCircle, CheckCircle2, LockKeyhole, RefreshCw, Search, X } from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Card, CardContent, CardHeader } from "@berry/desktop-ui/components/ui/card";
import { Checkbox } from "@berry/desktop-ui/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@berry/desktop-ui/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@berry/desktop-ui/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@berry/desktop-ui/components/ui/sheet";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@berry/desktop-ui/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { cn } from "@berry/desktop-ui/lib/utils";

export { Button, Checkbox, Input, Select, Switch, Textarea };

export function ManagementPage({ title, description, eyebrow, actions, children, status }: { title: string; description: string; eyebrow?: string; actions?: ReactNode; children: ReactNode; status?: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-5 pb-16 pt-[calc(var(--berry-titlebar-height)+1rem)] md:px-7 md:py-8"><header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 max-w-2xl">{eyebrow ? <p className="mb-1 text-xs font-medium text-muted-foreground">{eyebrow}</p> : null}<h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1><p className="mt-1.5 max-w-[62ch] text-sm leading-6 text-muted-foreground">{description}</p></div>{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}</header>{status}<div className="grid gap-4">{children}</div></main>;
}

export function AsyncState({ loading, error, onRetry, children, empty = false, emptyTitle = "Nothing here yet", emptyText = "New records will appear here when they are available." }: { loading: boolean; error: string | null; onRetry: () => void; children: ReactNode; empty?: boolean; emptyTitle?: string; emptyText?: string }) {
  if (loading) return <div className="flex min-h-44 items-center justify-center rounded-xl border border-border bg-card" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} label="Loading organization data" /></div>;
  if (error) return <div className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-8 text-center" role="alert"><AlertCircle className="size-5 text-destructive" /><strong className="text-sm text-foreground">Couldn’t load this screen</strong><span className="max-w-md text-sm text-muted-foreground">{error}</span><Button className="mt-2" variant="outline" onClick={onRetry}><RefreshCw />Retry</Button></div>;
  if (empty) return <Empty className="min-h-44 rounded-xl border border-border bg-card"><EmptyHeader><EmptyMedia variant="icon"><span className="size-2 rounded-full bg-muted-foreground/50" /></EmptyMedia><EmptyTitle>{emptyTitle}</EmptyTitle><EmptyDescription>{emptyText}</EmptyDescription></EmptyHeader></Empty>;
  return <>{children}</>;
}

export function PermissionDenied({ label = "this screen" }: { label?: string }) {
  return <div className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 px-6 py-8 text-center" role="alert"><LockKeyhole className="size-5 text-muted-foreground" /><strong className="text-sm text-foreground">Insufficient permission</strong><span className="max-w-md text-sm text-muted-foreground">You don’t have permission to view {label}. Ask an organization owner to update your role.</span></div>;
}

export function MetricGrid({ items }: { items: Array<{ label: string; value: string; hint?: string; status?: "good" | "warning" | "danger" }> }) {
  return <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Summary metrics">{items.map((item) => <Card key={item.label} className="gap-0 py-0 shadow-none" data-status={item.status}><CardContent className="grid gap-1 px-4 py-4"><span className="text-xs font-medium text-muted-foreground">{item.label}</span><strong className="text-xl font-semibold tracking-tight text-foreground">{item.value}</strong>{item.hint ? <small className="text-xs leading-5 text-muted-foreground">{item.hint}</small> : null}</CardContent></Card>)}</section>;
}

export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <Card className="gap-0 py-0 shadow-none"><CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-4 py-4"><div className="min-w-0"><h2 className="text-sm font-semibold text-foreground">{title}</h2>{description ? <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p> : null}</div>{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}</CardHeader><CardContent className="px-4 py-4">{children}</CardContent></Card>;
}

export function DataTable({ label, columns, rows, onRowSelect, activeRow, rowLabel }: { label: string; columns: string[]; rows: Array<Array<ReactNode>>; onRowSelect?: (index: number) => void; activeRow?: number | null; rowLabel?: (index: number) => string }) {
  const interactive = Boolean(onRowSelect);
  return <div className="overflow-x-auto rounded-xl border border-border"><Table><TableCaption className="sr-only">{label}</TableCaption><TableHeader><TableRow>{columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow key={index} className={cn(interactive && "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", activeRow === index && "bg-muted/60")} aria-selected={activeRow === index ? true : undefined} data-state={activeRow === index ? "selected" : undefined} {...(interactive ? { tabIndex: 0, role: "button", "aria-label": rowLabel?.(index), onClick: () => onRowSelect?.(index), onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRowSelect?.(index); } } } : {})}>{row.map((cell, cellIndex) => <TableCell key={cellIndex}>{cell}</TableCell>)}</TableRow>)}</TableBody></Table></div>;
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warning" | "danger" | "info" }) {
  const variant = tone === "danger" ? "destructive" : tone === "neutral" ? "outline" : tone === "good" ? "default" : "secondary";
  return <Badge variant={variant} className="font-normal" data-tone={tone}>{children}</Badge>;
}

export function SuccessMessage({ children }: { children: ReactNode }) { return <p className="flex items-center gap-2 rounded-lg border border-[var(--berry-success)]/25 bg-[var(--berry-success)]/5 px-3 py-2 text-xs text-[var(--berry-success)]" role="status" aria-live="polite"><CheckCircle2 className="size-4" />{children}</p>; }
export function Toolbar({ children }: { children: ReactNode }) { return <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">{children}</div>; }
export function formatMoney(micros: string | number | bigint | null | undefined) { const value = Number(micros ?? 0) / 1_000_000; return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 2 : 0 }).format(value); }
export function formatNumber(value: number) { return new Intl.NumberFormat().format(value); }
export function formatDate(value: string | number | Date | null | undefined) { if (value == null) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
export function formatDateTime(value: string | number | Date | null | undefined) { if (value == null) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

export function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <InputGroup className="w-full sm:max-w-80"><InputGroupAddon><Search aria-hidden /></InputGroupAddon><InputGroupInput aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={placeholder} /></InputGroup>;
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
  return <div className="relative w-full"><select className="pointer-events-none absolute size-px overflow-hidden opacity-0" name={name} value={selectedValue} onChange={(event) => handleValueChange(event.currentTarget.value)} required={required} disabled={disabled} tabIndex={-1} aria-label={placeholder}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Select {...rootProps}><SelectTrigger aria-hidden="true" className={cn("w-full", className)}><SelectValue placeholder={placeholder}>{selectedLabel}</SelectValue></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>;
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className="grid min-w-36 gap-1.5 text-xs font-medium text-muted-foreground"><span>{label}</span><FormSelect value={value} onChange={onChange} options={options} /></label>;
}

export function ManagementSwitch({ checked, onCheckedChange, disabled, "aria-label": ariaLabel }: { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; "aria-label"?: string }) {
  return <Switch checked={checked} disabled={disabled} aria-label={ariaLabel} onCheckedChange={onCheckedChange} />;
}

export function DetailDrawer({ title, subtitle, badge, onClose, children, footer }: { title: string; subtitle?: ReactNode; badge?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent side="right" showCloseButton={false} className="w-[min(440px,94vw)] gap-0 p-0 sm:max-w-[440px]"><SheetHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-4"><div className="min-w-0"><SheetTitle className="flex items-center gap-2 text-base">{title}{badge}</SheetTitle>{subtitle ? <SheetDescription className="mt-1">{subtitle}</SheetDescription> : null}</div><Button type="button" variant="ghost" size="icon-sm" className="-mr-1 shrink-0" onClick={onClose} aria-label="Close details"><X aria-hidden /></Button></SheetHeader><div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4">{children}</div>{footer ? <SheetFooter className="border-t border-border px-5 py-4">{footer}</SheetFooter> : null}</SheetContent></Sheet>;
}

export function DefinitionList({ items }: { items: Array<{ term: string; detail: ReactNode }> }) { return <dl className="grid divide-y divide-border rounded-xl border border-border">{items.map((item) => <div className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(110px,0.8fr)_minmax(0,1.5fr)] sm:gap-4" key={item.term}><dt className="text-xs font-medium text-muted-foreground">{item.term}</dt><dd className="min-w-0 text-sm text-foreground">{item.detail}</dd></div>)}</dl>; }

export function TabBar({ tabs, active, onSelect, label }: { tabs: Array<{ id: string; label: string }>; active: string; onSelect: (id: string) => void; label: string }) {
  return <Tabs value={active} onValueChange={onSelect} className="w-full"><TabsList variant="line" className="w-full justify-start overflow-x-auto border-b border-border" aria-label={label}>{tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}</TabsList></Tabs>;
}
