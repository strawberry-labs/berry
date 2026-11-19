import * as React from "react";
import { ManagementPageSkeleton, type ManagementPageSkeletonProps } from "./management-primitives";
import {
  Bone,
  BreakdownSkeleton,
  ChartSkeleton,
  DefaultSkeleton,
  DonutSkeleton,
  DualChartSkeleton,
  MetricGridSkeleton,
  SectionSkeleton,
  SettingListSkeleton,
  TableSkeleton,
  TextBone,
  TextLines,
} from "./management-skeletons";

/*
 * Per-screen loading layouts. Each body mirrors what the screen renders
 * inside `ManagementPage` once its data arrives; the screens pass them to
 * `AsyncState`, and the route-level fallbacks wrap them in a page skeleton
 * while the screen's code is still downloading. Blocks that only appear for
 * some data (warnings, notices) are left out.
 */

/** An `InlineNotice` with a title and wrapped body text. */
export function NoticeSkeleton({ lines = 1, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="flex items-start gap-x-2.5 rounded-lg border border-border px-3 py-2.5" aria-hidden>
      <Bone width={16} height={16} className="mt-0.5 rounded-full" />
      <div className="grid min-w-0 flex-1">
        {title ? <TextBone line={20} width={260} /> : null}
        <TextLines lines={lines} line={20} width="86%" lastWidth="48%" />
      </div>
    </div>
  );
}

export function GeneralSettingsSkeleton() {
  return (
    <>
      <SectionSkeleton title={96} flush>
        <SettingListSkeleton rows={[{ icon: true, description: 1, control: "select", controlWidth: 160 }, { icon: true, description: 1, control: "text", controlWidth: 96 }]} />
      </SectionSkeleton>
      <SectionSkeleton title={104} flush>
        <SettingListSkeleton rows={[{ icon: true, description: 1, control: "switch" }, { icon: true, description: 1, control: "switch" }]} />
      </SectionSkeleton>
    </>
  );
}

function FieldSkeleton({ control, help = false, className }: { control: number; help?: boolean; className?: string }) {
  return (
    <div className={`grid content-start gap-1.5 ${className ?? ""}`}>
      <TextBone line={16} size="xs" width={96} />
      <Bone height={control} width="100%" className="rounded-md" />
      {help ? <TextBone line={20} size="xs" width="72%" /> : null}
    </div>
  );
}

export function PersonalizationSettingsSkeleton() {
  return (
    <>
      <div><Bone width={172} height={32} className="rounded-[9px]" /></div>
      <SectionSkeleton title={84} description={1}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldSkeleton control={36} />
          <FieldSkeleton control={36} />
          <FieldSkeleton control={96} help className="sm:col-span-2" />
          <FieldSkeleton control={144} help className="sm:col-span-2" />
        </div>
      </SectionSkeleton>
    </>
  );
}

/** The mobile devices card body: one phone row (or the empty row, same size). */
export function MobileDevicesSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3.5" aria-hidden>
      <Bone width={16} height={16} className="mt-0.5" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <TextBone line={20} width={140} />
        <TextBone line={20} size="xs" width="62%" />
      </div>
    </div>
  );
}

/** The organization access card; `rows` is the number of permission areas. */
export function AccountAccessSkeleton({ rows = 6 }: { rows?: number | undefined }) {
  return (
    <SectionSkeleton title={140} description={1} actions={[64]}>
      <div className="grid divide-y divide-border overflow-hidden rounded-lg border border-border">
        {Array.from({ length: Math.max(1, rows) }, (_, index) => (
          <div key={index} className="grid gap-0.5 px-3 py-2 sm:grid-cols-[minmax(110px,0.7fr)_minmax(0,1.6fr)] sm:items-center sm:gap-4">
            <TextBone line={20} size="xs" width={`${[60, 44, 70, 52][index % 4]}%`} />
            <TextBone line={20} width={`${[72, 48, 86, 38][index % 4]}%`} />
          </div>
        ))}
      </div>
    </SectionSkeleton>
  );
}

export function AccountSettingsSkeleton({ accessRows }: { accessRows?: number } = {}) {
  return (
    <>
      <SectionSkeleton title={64} description={2}>
        <div className="flex min-w-0 items-center gap-3">
          <Bone width={40} height={40} className="rounded-full" />
          <div className="grid min-w-0 gap-0.5">
            <TextBone line={20} width={120} />
            <TextBone line={16} size="xs" width={180} />
          </div>
        </div>
      </SectionSkeleton>
      <SectionSkeleton title={120} description={1} flush>
        <MobileDevicesSkeleton />
      </SectionSkeleton>
      <AccountAccessSkeleton rows={accessRows} />
    </>
  );
}

export function PersonalConnectorsSkeleton() {
  return (
    <SectionSkeleton title={false} flush>
      <TableSkeleton label="Connectors" columns={["Connector", "Works with", "Status"]} rows={10} cells={[2, 1, "pill"]} pagination />
    </SectionSkeleton>
  );
}

export function PersonalUsageSkeleton() {
  return (
    <>
      <MetricGridSkeleton count={3} trend />
      <SectionSkeleton title={136} description={1}>
        <DualChartSkeleton />
      </SectionSkeleton>
      <div className="grid gap-5 xl:grid-cols-2">
        <SectionSkeleton title={112}><DonutSkeleton items={6} /></SectionSkeleton>
        <SectionSkeleton title={104} description={1}><DonutSkeleton items={4} /></SectionSkeleton>
      </div>
      <SectionSkeleton title={64} description={1} flush>
        <TableSkeleton label="Model usage" columns={["Model", "Spend", "Requests", "Input tokens", "Output tokens", "Cache-read tokens"]} rows={8} />
      </SectionSkeleton>
      <SectionSkeleton title={128} description={1} flush>
        <TableSkeleton label="Recent requests" columns={["Time", "Model", "Input", "Output", "Cache read", "Cost", "Result"]} rows={20} cells={[1, 2, 1, 1, 1, 1, "pill"]} pagination />
        <div className="flex justify-center border-t border-border px-4 py-3"><Bone width={164} height={34} className="rounded-lg" /></div>
      </SectionSkeleton>
    </>
  );
}

function HealthListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid divide-y divide-border">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="grid min-w-0 flex-1 gap-0.5">
            <TextBone line={20} width={120} />
            <TextBone line={20} size="xs" width="80%" />
          </span>
          <Bone width={64} height={20} className="rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function AdminOverviewSkeleton() {
  return (
    <>
      <MetricGridSkeleton count={4} trend />
      <SectionSkeleton title={136} description={1} actions={[112]}>
        <DualChartSkeleton />
      </SectionSkeleton>
      <div className="grid gap-5 xl:grid-cols-2">
        <SectionSkeleton title={148}><BreakdownSkeleton rows={6} more /></SectionSkeleton>
        <SectionSkeleton title={112}><DonutSkeleton items={6} /></SectionSkeleton>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <SectionSkeleton title={84} description={1}><ChartSkeleton /></SectionSkeleton>
        <SectionSkeleton title={104} description={1}><BreakdownSkeleton rows={6} more /></SectionSkeleton>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SectionSkeleton title={152} flush actions={[96]}>
          <TableSkeleton label="Recent activity" columns={["Event", "Actor", "When"]} rows={8} cells={[2, 1, 1]} toolbar={false} />
        </SectionSkeleton>
        <SectionSkeleton title={112} flush><HealthListSkeleton /></SectionSkeleton>
      </div>
    </>
  );
}

export function AdminMembersSkeleton({ columns = ["Member", "Role", "Department", "Status", "Spend this month", "Allowance", "Joined"] }: { columns?: string[] }) {
  return (
    <>
      <MetricGridSkeleton count={4} />
      <TableSkeleton label="Members" columns={columns} rows={12} cells={[2, 1, 1, "pill"]} pagination />
    </>
  );
}

export function AdminRolesSkeleton() {
  return (
    <>
      <NoticeSkeleton lines={2} />
      <SectionSkeleton title={152} description={1} actions={[148]} flush>
        <div className="h-[40rem] overflow-hidden" aria-hidden>
          <div className="flex h-[71px] items-end gap-4 border-b border-border bg-[var(--berry-surface-under)] px-4 py-2">
            <TextBone line={16} size="xs" width={72} className="flex-1" />
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className="grid w-24 justify-items-center">
                <TextBone line={16} size="xs" width={56} />
                <TextBone line={16} size="xs" width={40} />
              </span>
            ))}
          </div>
          {Array.from({ length: 18 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 border-b border-border px-4 py-1.5">
              <TextBone line={20} width={`${[34, 26, 40, 30][index % 4]}%`} className="flex-1" />
              {Array.from({ length: 5 }, (_, cell) => (
                <span key={cell} className="flex w-24 justify-center"><Bone width={16} height={16} /></span>
              ))}
            </div>
          ))}
        </div>
      </SectionSkeleton>
    </>
  );
}

export function AdminModelsSkeleton() {
  return (
    <>
      <SectionSkeleton title={72} flush>
        <SettingListSkeleton rows={[
          { description: 2, control: "select", controlWidth: 392 },
          { description: 2, control: "select", controlWidth: 430 },
          { description: 1, control: "text", controlWidth: 120 },
        ]} />
      </SectionSkeleton>
      <TableSkeleton label="Models" columns={["Model", "Provider", "Policy", "Default", "Context", "Input / 1M", "Output / 1M"]} rows={10} cells={[2, "pill", "pill", "pill"]} pagination />
      <SectionSkeleton title={104} description={2} actions={[148]} flush>
        <TableSkeleton label="Model access rules" columns={["Model", "Applies to", "Effect", "Updated"]} rows={6} cells={[2, 2, "pill"]} />
      </SectionSkeleton>
    </>
  );
}

export function AdminBillingSkeleton() {
  return (
    <>
      <MetricGridSkeleton count={3} />
      <SectionSkeleton title={72} flush>
        <TableSkeleton label="Invoices" columns={["Period", "Invoice", "Status", "Total", "Issued"]} rows={8} cells={[1, 1, "pill"]} />
      </SectionSkeleton>
      <SectionSkeleton title={128} description={1} flush>
        <TableSkeleton label="Balance activity" columns={["Time", "Type", "Amount", "Balance after", "Source", "Status"]} rows={10} cells={[1, 1, 1, 1, 1, "pill"]} pagination />
      </SectionSkeleton>
      <SectionSkeleton title={160} description={1}>
        <div className="grid gap-4">
          <div className="grid divide-y divide-border overflow-hidden rounded-lg border border-border">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="grid gap-0.5 px-3 py-2 text-md sm:grid-cols-[minmax(110px,0.7fr)_minmax(0,1.6fr)] sm:items-center sm:gap-4">
                <TextBone line="1lh" size="xs" width="40%" />
                {index === 1
                  ? <span className="flex h-6 items-center"><Bone width={64} height={20} className="rounded-full" /></span>
                  : <TextBone line="1lh" width={`${[30, 18, 24, 36, 52, 28, 34][index]}%`} />}
              </div>
            ))}
          </div>
          <TableSkeleton label="Usage reports" columns={["Time", "Meter", "Quantity", "Billed", "Status", "Reported"]} rows={5} cells={[1, 1, 1, 1, "pill"]} pagination />
        </div>
      </SectionSkeleton>
    </>
  );
}

/** The audit log's search and category filter, which render before its data. */
export function AuditToolbarSkeleton() {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end" aria-hidden>
      <Bone height={36} className="w-full rounded-md sm:max-w-80" />
      <span className="grid min-w-36 gap-1.5">
        <TextBone line="1lh" size="xs" width={56} className="text-xs" />
        <Bone height={36} width={144} className="rounded-md" />
      </span>
    </div>
  );
}

export function AdminAuditLogSkeleton() {
  return (
    <>
      <TableSkeleton label="Audit events" columns={["Time", "Actor", "Action", "Target", "Category"]} rows={12} cells={[1, 2, 1, 2, "pill"]} toolbar={false} pagination />
      <TextBone line={16} size="xs" width={260} />
    </>
  );
}

export function PlatformOverviewSkeleton() {
  return (
    <>
      <MetricGridSkeleton count={4} hintLines={2} trend />
      <SectionSkeleton title={136} description={1}>
        <DualChartSkeleton />
      </SectionSkeleton>
      <SectionSkeleton title={188}><BreakdownSkeleton rows={8} /></SectionSkeleton>
      <SectionSkeleton title={168} description={1} flush>
        <TableSkeleton label="Operator activity" columns={["When", "Action", "Target", "Operator", "Note"]} rows={10} />
      </SectionSkeleton>
    </>
  );
}

type PageSkeletonSpec = Omit<ManagementPageSkeletonProps, "children"> & { body?: () => React.ReactNode };

/** What each tab's page looks like before its code has loaded. */
const PAGE_SKELETONS: Record<string, PageSkeletonSpec> = {
  "settings:general": { width: "narrow", title: "General", body: GeneralSettingsSkeleton },
  "settings:account": { width: "narrow", title: "Account", body: AccountSettingsSkeleton },
  "settings:personalization": { width: "narrow", title: "Personalization", body: PersonalizationSettingsSkeleton },
  "settings:connectors": { title: "Connectors", actions: [140], body: PersonalConnectorsSkeleton },
  "settings:skills": { title: "Skills" },
  "settings:mcp": { title: "MCP servers" },
  "settings:schedules": { title: "Automations" },
  "settings:usage": { width: "wide", title: "Usage", actions: [176, 122], body: PersonalUsageSkeleton },
  "settings:archived": { width: "narrow", title: "Archived tasks" },
  "admin:overview": { width: "wide", title: "Overview", eyebrow: true, actions: [128], body: AdminOverviewSkeleton },
  "admin:members": { width: "wide", title: "Members", eyebrow: true, actions: [124, 128], body: () => <AdminMembersSkeleton /> },
  "admin:departments": { title: "Departments", eyebrow: true },
  "admin:roles": { width: "wide", title: "Roles & permissions", eyebrow: true, descriptionLines: 2, body: AdminRolesSkeleton },
  "admin:resource-access": { title: "Resource access", eyebrow: true },
  "admin:providers": { title: "Providers", eyebrow: true },
  "admin:models": { title: "Models", eyebrow: true, descriptionLines: 2, actions: [116], body: AdminModelsSkeleton },
  "admin:connectors": { title: "Connectors", eyebrow: true },
  "admin:mcp-approvals": { title: "MCP approvals", eyebrow: true },
  "admin:skills-mcp": { title: "Skills & MCP", eyebrow: true },
  "admin:feature-access": { title: "Feature access", eyebrow: true },
  "admin:analytics": { width: "wide", title: "Usage", eyebrow: true },
  "admin:spend-limits": { width: "wide", title: "Allowances", eyebrow: true },
  "admin:credits-billing": { width: "wide", title: "Billing", eyebrow: true, actions: [116], body: AdminBillingSkeleton },
  "admin:reports-alerts": { width: "wide", title: "Reports & alerts", eyebrow: true },
  "admin:execution-network": { width: "narrow", eyebrow: true },
  "admin:authentication": { width: "narrow", eyebrow: true },
  "admin:data-governance": { width: "narrow", eyebrow: true },
  "admin:service-accounts": { title: "Service accounts", eyebrow: true },
  "admin:sso-scim": { title: "SSO & SCIM", eyebrow: true },
  "admin:managed-policy": { title: "Managed policy", eyebrow: true },
  "admin:profile-domains": { width: "narrow", title: "Organization settings", eyebrow: true },
  "admin:audit-log": { width: "wide", title: "Audit log", descriptionLines: 2, actions: [124], body: () => <><AuditToolbarSkeleton /><AdminAuditLogSkeleton /></> },
  "platform:overview": { width: "wide", title: "Overview", eyebrow: true, body: PlatformOverviewSkeleton },
  "platform:organizations": { width: "wide", title: "Organizations", eyebrow: true },
  "platform:feature-rollout": { title: "Feature rollout", eyebrow: true },
  "platform:router-health": { width: "wide", title: "Router health", eyebrow: true },
  "platform:billing-operations": { width: "wide", title: "Billing operations", eyebrow: true },
};

/** Suspense fallback for a settings, admin or platform tab. */
export function ManagementScreenFallback({ area, tab, body: override }: { area: "settings" | "admin" | "platform"; tab: string; body?: React.ReactNode }) {
  const { body, ...page } = PAGE_SKELETONS[`${area}:${tab}`] ?? { width: area === "settings" ? "narrow" : "regular" };
  return <ManagementPageSkeleton {...page}>{override ?? (body ? body() : <DefaultSkeleton />)}</ManagementPageSkeleton>;
}
