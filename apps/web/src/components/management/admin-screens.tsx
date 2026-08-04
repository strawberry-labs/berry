import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Download, Plus, Save, Search } from "lucide-react";
import {
  AsyncState,
  Button,
  Checkbox,
  DataTable,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementPageTabsProvider,
  MetricGrid,
  PermissionDenied,
  SearchInput,
  Section,
  StatusPill,
  SuccessMessage,
  Toolbar,
  formatDateTime,
  formatMoney,
  formatNumber,
} from "./management-primitives";
import {
  BreakdownBars,
  DualTrend,
  HealthRings,
  MiniSeries,
  OutcomeBars,
} from "./management-charts";
import { useResource, type ManagementScreenProps } from "./management-context";
import { OrganizationProfileScreen } from "./organization-profile-screen";
import { ReportsAlertsScreen } from "./reports-alerts-screen";
import { AnalyticsScreen } from "./analytics-screen";
import { AdminCatalogScreen } from "./admin-catalog-screens";
import {
  adminAreaForTab,
  resolvedAdminTab,
} from "./management-navigation";
export function AdminScreen({
  tab,
  ...p
}: ManagementScreenProps & { tab: string }) {
  const navigate = useNavigate();
  const area = adminAreaForTab(tab);
  const resolvedTab = resolvedAdminTab(tab, p.permissions);
  const read = permissionFor(resolvedTab);
  if (read && !p.permissions.includes(read as any))
    return <PermissionDenied label={titleFor(resolvedTab)} />;

  const visibleTabs = area.tabs.filter(
    (item) => !item.permission || p.permissions.includes(item.permission),
  );
  const screen = (() => {
    if (resolvedTab === "overview") return <Overview {...p} />;
    if (resolvedTab === "members") return <Members {...p} />;
    if (resolvedTab === "departments") return <Departments {...p} />;
    if (resolvedTab === "analytics") return <AnalyticsScreen {...p} />;
    if (resolvedTab === "spend-limits") return <SpendLimits {...p} />;
    if (resolvedTab === "credits-billing") return <Billing {...p} />;
    if (resolvedTab === "reports-alerts") return <ReportsAlertsScreen {...p} />;
    if (resolvedTab === "execution-network")
      return <PolicyScreen kind="execution" {...p} />;
    if (resolvedTab === "authentication")
      return <PolicyScreen kind="authentication" {...p} />;
    if (resolvedTab === "data-governance") return <PolicyScreen kind="data" {...p} />;
    if (resolvedTab === "service-accounts") return <ServiceAccounts {...p} />;
    if (resolvedTab === "profile-domains") return <OrganizationProfileScreen {...p} />;
    return <AdminCatalogScreen tab={resolvedTab} {...p} />;
  })();

  return (
    <ManagementPageTabsProvider
      value={{
        activeTab: resolvedTab,
        ariaLabel: `${area.label} sections`,
        tabs: visibleTabs,
        onTabChange: (nextTab) => {
          void navigate({
            to: "/admin/$tab",
            params: { tab: nextTab },
            search: {},
          });
        },
      }}
    >
      {screen}
    </ManagementPageTabsProvider>
  );
}
function Overview({ client, config, tenantId }: ManagementScreenProps) {
  const now = new Date(),
    to = now.toISOString(),
    from = new Date(now.getTime() - 30 * 864e5).toISOString();
  const r = useResource(
    `overview:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listOrgMembers(tenantId),
            client.usageAnalytics(tenantId, { from, to, limit: 20 }),
            client.billingHealth(tenantId),
            client.listAuditEvents(tenantId, { limit: 8 }),
          ])
        : ([
            [],
            config.usageDashboards.find((x) => x?.tenantId === tenantId) ??
              null,
            null,
            config.auditEvents,
          ] as any),
    [] as any,
  );
  const [members, usage, health, audit] = r.data;
  return (
    <ManagementPage
      title="Overview"
      description="Operational health, adoption, spend, and recent administration activity."
      eyebrow="Organization administration"
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !usage}
        emptyTitle="Overview data unavailable"
        emptyText="Connect the organization API to load operational health, adoption, and spend."
      >
        {usage ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Active members",
                  value: formatNumber(
                    members.length
                      ? members.filter((m: any) => m.status === "active").length
                      : (usage.byUser ?? []).filter((u: any) => u.userId)
                          .length,
                  ),
                },
                {
                  label: "Billed spend",
                  value: formatMoney(
                    usage.totals?.billedCostMicros ??
                      usage.totals?.costBilledMicros,
                  ),
                },
                {
                  label: "Requests",
                  value: formatNumber(usage.totals?.requests ?? 0),
                },
                {
                  label: "Successful requests",
                  value:
                    usage.totals?.successRate == null
                      ? "—"
                      : `${Math.round(usage.totals.successRate * 100)}%`,
                  status:
                    (usage.totals?.successRate ?? 1) < 0.9 ? "warning" : "good",
                },
              ]}
            />
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Spend and request trend">
                <DualTrend
                  label="Billed spend"
                  points={(usage.series ?? usage.burnDown ?? []).map(
                    (x: any) => ({
                      label: (x.ts ?? x.date).slice(0, 10),
                      spend:
                        Number(x.billedCostMicros ?? x.costBilledMicros) / 1e6,
                      requests: Number(x.requests ?? 0),
                    }),
                  )}
                  spendFormat={(v) => formatMoney(v * 1e6)}
                />
              </Section>
              <Section title="System health">
                <div className="grid divide-y divide-border [&>p]:flex [&>p]:items-center [&>p]:justify-between [&>p]:gap-4 [&>p]:py-2.5 [&_span]:text-xs [&_span]:text-muted-foreground">
                  <p>
                    <StatusPill
                      tone={health?.status === "healthy" ? "good" : "warning"}
                    >
                      {health?.status ?? "Demo"}
                    </StatusPill>
                    <span>Billing and reservations</span>
                  </p>
                  <p>
                    <StatusPill tone="good">Healthy</StatusPill>
                    <span>Usage ingestion</span>
                  </p>
                  <p>
                    <StatusPill tone="good">Healthy</StatusPill>
                    <span>Audit chain</span>
                  </p>
                </div>
              </Section>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Request outcomes">
                <OutcomeBars
                  points={(usage.series ?? usage.burnDown ?? []).map(
                    (x: any) => ({
                      label: (x.ts ?? x.date).slice(0, 10),
                      successes: Number(x.successes ?? x.requests ?? 0),
                      failures: Number(x.failures ?? 0),
                    }),
                  )}
                />
              </Section>
              <Section title="Adoption and reliability">
                <HealthRings
                  successRate={
                    usage.totals?.successRate ??
                    derivedSuccessRate(usage.series ?? usage.burnDown ?? [])
                  }
                  attributionRate={
                    (usage.totals?.requests ?? 0) > 0
                      ? (
                          usage.breakdowns?.members ??
                          usage.breakdowns?.users ??
                          usage.byUser ??
                          []
                        ).reduce(
                          (sum: number, row: any) =>
                            sum +
                            (row.id == null && row.userId == null
                              ? 0
                              : Number(row.requests ?? 0)),
                          0,
                        ) / usage.totals.requests
                      : null
                  }
                />
              </Section>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Section title="Model request mix">
                <BreakdownBars
                  label="Requests"
                  rows={(
                    usage.breakdowns?.models ??
                    usage.byModel ??
                    []
                  ).map((row: any) => ({
                    label: row.label ?? row.model ?? "Unknown",
                    value: Number(row.requests ?? 0),
                  }))}
                />
              </Section>
              <Section title="Department spend">
                <BreakdownBars
                  label="Billed spend"
                  rows={(
                    usage.breakdowns?.departments ??
                    usage.byDepartment ??
                    []
                  ).map((row: any) => ({
                    label:
                      row.label ?? row.departmentId ?? "Unattributed",
                    value:
                      Number(
                        row.billedCostMicros ?? row.costBilledMicros ?? 0,
                      ) / 1e6,
                  }))}
                  format={(value) => formatMoney(value * 1e6)}
                />
              </Section>
            </div>
            <Section title="Recent admin activity">
              <DataTable
                label="Recent activity"
                columns={["Action", "Actor", "When"]}
                rows={audit.map((x: any) => [
                  <b>{human(x.action)}</b>,
                  x.actorUserId ?? "System",
                  formatDateTime(x.ts ?? x.createdAt),
                ])}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

function derivedSuccessRate(
  points: Array<{ requests?: number; successes?: number; failures?: number }>,
) {
  const totals = points.reduce<{ requests: number; successes: number }>(
    (summary, point) => {
      const requests = Number(point.requests ?? 0);
      const failures = Number(point.failures ?? 0);
      return {
        requests: summary.requests + requests,
        successes:
          summary.successes +
          Number(point.successes ?? Math.max(0, requests - failures)),
      };
    },
    { requests: 0, successes: 0 },
  );
  return totals.requests ? totals.successes / totals.requests : null;
}

function Members({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState(""),
    [open, setOpen] = React.useState(false),
    [message, setMessage] = React.useState("");
  const [editing, setEditing] = React.useState<any>(null);
  const [editRole, setEditRole] = React.useState("member");
  const [editStatus, setEditStatus] = React.useState("active");
  const [editDepartments, setEditDepartments] = React.useState<Set<string>>(new Set());
  const [editPrimaryDepartment, setEditPrimaryDepartment] = React.useState("none");
  const r = useResource(
    `members:${tenantId}`,
    async () => (client ? client.listOrgMembers(tenantId) : []),
    [] as any[],
  );
  const departments = useResource(
    `member-departments:${tenantId}`,
    async () =>
      client
        ? client.listDepartments(tenantId)
        : config.departments.filter((item) => item.tenantId === tenantId),
    [] as any[],
  );
  const now = new Date();
  const usageFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const usage = useResource(
    `member-usage:${tenantId}:${usageFrom}`,
    async () =>
      client && permissions.includes("usage:read")
        ? client.usageAnalytics(tenantId, {
            from: usageFrom,
            to: new Date().toISOString(),
            limit: 100,
          })
        : null,
    null as any,
  );
  const balances = useResource(
    `member-balances:${tenantId}`,
    async () => client && permissions.includes("budgets:read") ? client.allowanceBalances(tenantId) : [],
    [] as any[],
  );
  const departmentNames = new Map<string, string>(
    departments.data.map((department: any) => [department.id, department.name]),
  );
  const memberSpend = new Map<string, string>(
    (
      usage.data?.breakdowns?.members ??
      usage.data?.breakdowns?.users ??
      []
    ).flatMap((row: any) =>
      row.id ? [[row.id, row.billedCostMicros] as const] : [],
    ),
  );
  const memberBalance = new Map<string, any>(
    balances.data.map((balance: any) => [balance.userId, balance]),
  );
  const rows = r.data.filter((m: any) =>
    `${m.name} ${m.email} ${m.role}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!client) return;
    const f = new FormData(e.currentTarget);
    const created = await client.createOrgMember(tenantId, {
      email: String(f.get("email")),
      name: String(f.get("name")),
      password: String(f.get("password")),
      role: String(f.get("role")) as any,
    });
    const departmentId = String(f.get("primaryDepartmentId"));
    if (departmentId && departmentId !== "none") {
      await client.updateOrgMember(tenantId, created.userId, {
        departmentIds: [departmentId],
        primaryDepartmentId: departmentId,
      });
    }
    setOpen(false);
    setMessage("Member account created and the default allowance profile was applied.");
    r.retry();
  };
  const openMember = (member: any) => {
    setEditing(member);
    setEditRole(member.role);
    setEditStatus(member.status);
    setEditDepartments(new Set(member.departmentIds ?? []));
    setEditPrimaryDepartment(member.primaryDepartmentId ?? "none");
  };
  const toggleDepartment = (departmentId: string) => {
    setEditDepartments((current) => {
      const next = new Set(current);
      if (next.has(departmentId)) {
        next.delete(departmentId);
        if (editPrimaryDepartment === departmentId) setEditPrimaryDepartment("none");
      } else {
        next.add(departmentId);
        if (editPrimaryDepartment === "none") setEditPrimaryDepartment(departmentId);
      }
      return next;
    });
  };
  const saveMember = async () => {
    if (!client || !editing) return;
    const updated = await client.updateOrgMember(tenantId, editing.userId, {
      role: editRole as "admin" | "member",
      status: editStatus as "active" | "disabled" | "deprovisioned",
      departmentIds: [...editDepartments],
      primaryDepartmentId: editPrimaryDepartment === "none" ? null : editPrimaryDepartment,
    });
    r.setData(r.data.map((member: any) => member.userId === updated.userId ? updated : member));
    setEditing(null);
    setMessage(editStatus === "disabled" ? "Member blocked. Existing usage history was preserved." : editStatus === "deprovisioned" ? "Member offboarded. Access was revoked and history was preserved." : "Member access and primary department updated.");
  };
  return (
    <ManagementPage
      title="Members"
      description="Find people by name or email, review current-month spend, and administer local organization accounts."
      eyebrow="People"
      actions={
        permissions.includes("members:write") ? (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            Add member
          </Button>
        ) : null
      }
    >
      <Toolbar>
        <SearchInput
          label="Search members"
          value={query}
          onChange={setQuery}
          placeholder="Search name, email, or role"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Add member"
        description="Create a local Berry account and apply the selected organization role. Email invitations are not sent in the current no-SSO mode."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="invite-member-form">
              Create account
            </Button>
          </>
        }
      >
        <form
          id="invite-member-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Name
            <Input name="name" autoFocus required />
          </label>
          <label>
            Email
            <Input name="email" type="email" required />
          </label>
          <label>
            Temporary password
            <Input name="password" type="password" minLength={12} required />
          </label>
          <label>
            Role
            <FormSelect
              name="role"
              defaultValue="member"
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </label>
          <label>
            Primary department
            <FormSelect
              name="primaryDepartmentId"
              defaultValue="none"
              options={[{ value: "none", label: "No department" }, ...departments.data.map((department: any) => ({ value: department.id, label: department.name }))]}
            />
          </label>
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={Boolean(editing)}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        title={editing?.name || "Manage member"}
        description={editing ? `${editing.email} · Set role, access status, and primary department.` : ""}
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="button" onClick={() => void saveMember()} disabled={editing?.role === "owner"}><Save />Save member</Button></>}
      >
        {editing ? (
          <div className="grid gap-4">
            {editing.role === "owner" ? <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">The organization owner cannot be demoted, blocked, or offboarded from this screen.</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground">
              <label>Role<FormSelect value={editRole} onChange={setEditRole} disabled={editing.role === "owner"} options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]} /></label>
              <label>Account access<FormSelect value={editStatus} onChange={setEditStatus} disabled={editing.role === "owner"} options={[{ value: "active", label: "Active" }, { value: "disabled", label: "Blocked" }, { value: "deprovisioned", label: "Offboarded" }]} /></label>
            </div>
            <fieldset className="grid gap-2 border-0 p-0" disabled={editing.role === "owner"}>
              <legend className="mb-1 text-xs font-semibold">Departments</legend>
              {departments.data.map((department: any) => (
                <label key={department.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <Checkbox checked={editDepartments.has(department.id)} onCheckedChange={() => toggleDepartment(department.id)} />
                  {department.name}
                </label>
              ))}
            </fieldset>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Primary department<FormSelect value={editPrimaryDepartment} onChange={setEditPrimaryDepartment} disabled={editing.role === "owner"} options={[{ value: "none", label: "No primary department" }, ...departments.data.filter((department: any) => editDepartments.has(department.id)).map((department: any) => ({ value: department.id, label: department.name }))]} /></label>
            <p className="text-xs text-muted-foreground">Blocked and offboarded members cannot authorize new requests. Their audit and usage history remains available.</p>
          </div>
        ) : null}
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={rows.length === 0}
      >
        <DataTable
          label="Members"
          columns={["Member", "Role", "Departments", "Spend this month", "Allowance cycle", "Source", "Status", ""]}
          rows={rows.map((m: any) => [
            <Button
              variant="ghost"
              className="grid h-auto justify-start gap-0 p-0 text-left"
              onClick={() =>
                void navigate({
                  to: "/admin/$tab",
                  params: { tab: "analytics" },
                  search: { view: "people", memberId: m.userId },
                })
              }
            >
              <b>{m.name}</b>
              <small>{m.email}</small>
            </Button>,
            m.role,
            (m.departmentIds ?? [])
              .map((id: string) => departmentNames.get(id) ?? id.slice(0, 8))
              .join(", ") || "—",
            usage.loading
              ? "Loading…"
              : formatMoney(memberSpend.get(m.userId) ?? "0"),
            balances.loading
              ? "Loading…"
              : memberBalance.get(m.userId)?.effectiveLimitMicros === null
                ? `${formatMoney(memberBalance.get(m.userId)?.usedMicros ?? "0")} · Unlimited`
                : `${formatMoney(memberBalance.get(m.userId)?.usedMicros ?? "0")} / ${formatMoney(memberBalance.get(m.userId)?.effectiveLimitMicros ?? "0")}`,
            m.source,
            <StatusPill tone={m.status === "active" ? "good" : "warning"}>
              {m.status}
            </StatusPill>,
            permissions.includes("members:write") ? <Button variant="secondary" onClick={() => openMember(m)}>Manage</Button> : null,
          ])}
        />
      </AsyncState>
    </ManagementPage>
  );
}
function Departments({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const [open, setOpen] = React.useState(false);
  const r = useResource(
    `departments:${tenantId}`,
    async () =>
      client
        ? client.listDepartments(tenantId)
        : config.departments.filter((d) => d.tenantId === tenantId),
    [] as any[],
  );
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parentId = String(f.get("parentId"));
    await client?.createDepartment(tenantId, {
      name: String(f.get("name")),
      slug: String(f.get("slug")),
      parentId: parentId === "none" ? null : parentId,
    });
    setOpen(false);
    r.retry();
  };
  return (
    <ManagementPage
      title="Departments"
      description="Nested ownership, membership, inherited policies, and departmental spend controls."
      eyebrow="People"
      actions={
        permissions.includes("departments:write") ? (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            New department
          </Button>
        ) : null
      }
    >
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Create department"
        description="Add a department to organize ownership, policy inheritance, membership, and spend controls."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-department-form">
              Create department
            </Button>
          </>
        }
      >
        <form
          id="create-department-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Name
            <Input name="name" autoFocus required />
          </label>
          <label>
            Slug
            <Input name="slug" pattern="[a-z0-9-]+" required />
          </label>
          <label>
            Parent
            <FormSelect
              name="parentId"
              defaultValue="none"
              options={[
                { value: "none", label: "Top level" },
                ...r.data.map((d: any) => ({ value: d.id, label: d.name })),
              ]}
            />
          </label>
        </form>
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={r.data.length === 0}
      >
        <DataTable
          label="Departments"
          columns={["Department", "Parent", "Status", "Updated"]}
          rows={r.data.map((d: any) => [
            <b>{d.name}</b>,
            r.data.find((x: any) => x.id === d.parentId)?.name ??
              "Organization",
            <StatusPill tone={d.status === "active" ? "good" : "neutral"}>
              {d.status}
            </StatusPill>,
            new Date(d.updatedAt).toLocaleDateString(),
          ])}
        />
      </AsyncState>
    </ManagementPage>
  );
}
function Analytics({ client, tenantId }: ManagementScreenProps) {
  const initial = React.useMemo(() => {
    const q = new URLSearchParams(location.search),
      to = q.get("to") ?? new Date().toISOString().slice(0, 10),
      from =
        q.get("from") ??
        new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return { from, to };
  }, []);
  const [range, setRange] = React.useState(initial);
  const from = `${range.from}T00:00:00.000Z`,
    to = `${range.to}T23:59:59.999Z`;
  const r = useResource(
    `analytics:${tenantId}:${from}:${to}`,
    async () =>
      client ? client.usageAnalytics(tenantId, { from, to, limit: 50 }) : null,
    null as any,
  );
  const apply = (next: any) => {
    setRange(next);
    history.replaceState(
      null,
      "",
      `${location.pathname}?from=${next.from}&to=${next.to}`,
    );
  };
  return (
    <ManagementPage
      title="Analytics"
      description="Filterable billed usage, performance, attribution, request detail, and explainable anomalies."
      eyebrow="Finance"
      actions={
        <Button
          variant="secondary"
          onClick={() =>
            client
              ?.exportUsageCsv(tenantId, { from, to })
              .then((csv) => download(csv, "organization-usage.csv"))
          }
        >
          <Download />
          Export CSV
        </Button>
      }
    >
      <Toolbar>
        <label>
          From
          <Input
            type="date"
            value={range.from}
            onChange={(e) => apply({ ...range, from: e.currentTarget.value })}
          />
        </label>
        <label>
          To
          <Input
            type="date"
            value={range.to}
            onChange={(e) => apply({ ...range, to: e.currentTarget.value })}
          />
        </label>
      </Toolbar>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.data || r.data.totals.requests === 0}
      >
        {r.data ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Billed spend",
                  value: formatMoney(r.data.totals.billedCostMicros),
                },
                {
                  label: "Requests",
                  value: formatNumber(r.data.totals.requests),
                },
                { label: "Tokens", value: formatNumber(r.data.totals.tokens) },
                {
                  label: "Projected month-end",
                  value: formatMoney(r.data.totals.projectedMonthEndMicros),
                },
              ]}
            />
            <Section title="Spend trend">
              <MiniSeries
                label="Daily spend"
                points={r.data.series.map((p: any) => ({
                  label: p.ts.slice(0, 10),
                  value: Number(p.billedCostMicros) / 1e6,
                }))}
                format={(v) => formatMoney(v * 1e6)}
              />
            </Section>
            {r.data.anomalies.length ? (
              <Section title="Needs attention">
                {r.data.anomalies.map((a: any) => (
                  <article
                    className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground"
                    key={a.id}
                  >
                    <StatusPill
                      tone={a.severity === "error" ? "danger" : "warning"}
                    >
                      {a.severity}
                    </StatusPill>
                    <div>
                      <b>{a.label}</b>
                      <p>{a.explanation}</p>
                    </div>
                  </article>
                ))}
              </Section>
            ) : null}
            <Section title="Models">
              <DataTable
                label="Model analytics"
                columns={[
                  "Model",
                  "Requests",
                  "Tokens",
                  "Billed",
                  "Errors",
                  "P95 latency",
                ]}
                rows={(r.data.breakdowns.models ?? []).map((x: any) => [
                  x.label,
                  formatNumber(x.requests),
                  formatNumber(x.tokens),
                  formatMoney(x.billedCostMicros),
                  x.errorRate == null
                    ? "—"
                    : `${Math.round(x.errorRate * 100)}%`,
                  x.latencyP95Ms == null ? "—" : `${x.latencyP95Ms} ms`,
                ])}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}
function SpendLimits({ client, tenantId, permissions }: ManagementScreenProps) {
  const r = useResource(
    `allowances:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listBudgetLimits(tenantId),
            client.listAllowanceProfiles(tenantId),
            client.listAllowanceDefaults(tenantId),
            client.allowanceCycle(tenantId),
            client.allowanceBalances(tenantId),
            client.listOrgMembers(tenantId),
            client.listDepartments(tenantId),
            client.allowanceAdjustments(tenantId),
          ])
        : [[], [], [], null, [], [], [], []],
    [[], [], [], null, [], [], [], []] as any,
  );
  const [limits, profiles, defaults, cycle, balances, members, departments, adjustments] = r.data;
  const [success, setSuccess] = React.useState("");
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [topUpOpen, setTopUpOpen] = React.useState(false);
  const [cycleOpen, setCycleOpen] = React.useState(false);
  const [memberBaseOpen, setMemberBaseOpen] = React.useState(false);
  const [defaultOpen, setDefaultOpen] = React.useState(false);
  const [scopeType, setScopeType] = React.useState<"department" | "org">("department");
  const [topUpUserId, setTopUpUserId] = React.useState("");
  const [memberBaseUserId, setMemberBaseUserId] = React.useState("");
  const [memberBaseMode, setMemberBaseMode] = React.useState<"inherit" | "custom">("inherit");
  const [memberBaseAmount, setMemberBaseAmount] = React.useState("");
  const [defaultScope, setDefaultScope] = React.useState<"organization" | "department">("organization");
  const [defaultDepartmentId, setDefaultDepartmentId] = React.useState("");
  const [defaultMode, setDefaultMode] = React.useState<"inherit" | "custom">("custom");
  const [defaultAmount, setDefaultAmount] = React.useState("20");
  const canWrite = permissions.includes("budgets:write");
  const memberNames = new Map<string, string>(members.map((item: any) => [item.userId, item.name || item.email]));
  const departmentNames = new Map<string, string>(departments.map((item: any) => [item.id, item.name]));
  const profilesById = new Map<string, any>(profiles.map((item: any) => [item.id, item]));
  const organizationDefault: any = defaults.find((item: any) => item.role === null && item.departmentId === null);
  const organizationProfile = organizationDefault?.profileId ? profilesById.get(organizationDefault.profileId) : null;
  const organizationBaseMicros = organizationProfile?.hardLimitMicros ?? null;
  const departmentDefaults = new Map<string, any>(
    defaults
      .filter((item: any) => item.role === null && item.departmentId !== null)
      .map((item: any) => [item.departmentId, item]),
  );
  const totalUsed = balances.reduce((sum: bigint, item: any) => sum + BigInt(item.usedMicros), 0n);
  const totalAvailable = balances.reduce(
    (sum: bigint, item: any) => sum + BigInt(item.availableMicros ?? 0),
    0n,
  );

  const openMemberBase = (index: number) => {
    const balance = balances[index];
    if (!balance) return;
    setMemberBaseUserId(balance.userId);
    setMemberBaseMode(balance.baseSource === "member" ? "custom" : "inherit");
    setMemberBaseAmount(balance.baseLimitMicros === null ? "" : String(Number(balance.baseLimitMicros) / 1e6));
    setMemberBaseOpen(true);
  };

  const openDefault = (scope: "organization" | "department", departmentId = "") => {
    const assignment = scope === "organization"
      ? organizationDefault
      : departmentDefaults.get(departmentId);
    const profile = assignment?.profileId ? profilesById.get(assignment.profileId) : null;
    setDefaultScope(scope);
    setDefaultDepartmentId(departmentId);
    setDefaultMode(scope === "department" && !profile ? "inherit" : "custom");
    setDefaultAmount(profile?.hardLimitMicros ? String(Number(profile.hardLimitMicros) / 1e6) : String(Number(organizationBaseMicros ?? 20_000_000) / 1e6));
    setDefaultOpen(true);
  };

  const submitAllowance = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scopeId = scopeType === "org" ? tenantId : String(form.get("scopeId"));
    await client?.bulkUpsertAllowanceLimits(tenantId, {
      idempotencyKey: crypto.randomUUID(),
      reason: String(form.get("reason")),
      dryRun: false,
      items: [{
        scopeType,
        scopeId,
        period: String(form.get("period")) as "day" | "month",
        softLimitMicros: String(Math.round(Number(form.get("soft")) * 1e6)),
        hardLimitMicros: String(Math.round(Number(form.get("hard")) * 1e6)),
        requestLimit: Number(form.get("requests")) || null,
        tokenLimit: Number(form.get("tokens")) || null,
        sandboxMinuteLimit: Number(form.get("sandbox")) || null,
      }],
    });
    setAssignOpen(false);
    setSuccess("Allowance updated. New requests use it immediately.");
    r.retry();
  };

  const submitTopUp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await client?.createAllowanceAdjustment(tenantId, {
      userId: String(form.get("userId")),
      amountMicros: String(Math.round(Number(form.get("amount")) * 1e6)),
      reason: String(form.get("reason")),
      idempotencyKey: crypto.randomUUID(),
    });
    setTopUpOpen(false);
    setSuccess("Top-up added to this member’s current cycle and enforcement limit.");
    r.retry();
  };

  const submitMemberBase = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountMicros = memberBaseMode === "inherit"
      ? null
      : String(Math.round(Number(memberBaseAmount) * 1e6));
    await client?.updateMemberAllowanceBase(tenantId, memberBaseUserId, { amountMicros });
    setMemberBaseOpen(false);
    setSuccess(memberBaseMode === "inherit"
      ? "Member now follows the department or organization allowance."
      : "Member base allowance updated for the current and future cycles.");
    r.retry();
  };

  const submitDefault = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const departmentId = defaultScope === "department" ? defaultDepartmentId : null;
    const existingAssignment = defaultScope === "organization"
      ? organizationDefault
      : departmentDefaults.get(defaultDepartmentId);
    if (defaultScope === "department" && defaultMode === "inherit") {
      await client?.upsertAllowanceDefault(tenantId, {
        profileId: null,
        role: null,
        departmentId,
        priority: 100,
      });
      setDefaultOpen(false);
      setSuccess("Department now follows the organization default allowance.");
      r.retry();
      return;
    }
    const amountMicros = String(Math.round(Number(defaultAmount) * 1e6));
    const existingProfile = existingAssignment?.profileId
      ? profilesById.get(existingAssignment.profileId)
      : null;
    const departmentName = departmentNames.get(defaultDepartmentId) ?? "Department";
    const profile = await client?.upsertAllowanceProfile(tenantId, {
      name: existingProfile?.name ?? (defaultScope === "organization"
        ? "Organization default allowance"
        : `${departmentName} default allowance`),
      description: defaultScope === "organization"
        ? "Monthly base allowance for organization members"
        : `Monthly base allowance for members of ${departmentName}`,
      period: "month",
      softLimitMicros: String(BigInt(amountMicros) * 8n / 10n),
      hardLimitMicros: amountMicros,
      requestLimit: null,
      tokenLimit: null,
      sandboxMinuteLimit: null,
      thresholdPercentages: [80, 100],
      status: "active",
    }, existingProfile?.id);
    if (profile) {
      await client?.upsertAllowanceDefault(tenantId, {
        profileId: profile.id,
        role: null,
        departmentId,
        priority: defaultScope === "department" ? 100 : 0,
      });
    }
    setDefaultOpen(false);
    setSuccess(`${defaultScope === "organization" ? "Organization" : "Department"} default allowance updated.`);
    r.retry();
  };

  const submitCycle = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await client?.updateAllowanceCycle(tenantId, {
      timezone: String(form.get("timezone")),
      anchorDay: Number(form.get("anchorDay")),
    });
    setCycleOpen(false);
    setSuccess("Allowance cycle updated for subsequent balance and enforcement checks.");
    r.retry();
  };

  const targetOptions = departments.map((department: any) => ({ value: department.id, label: department.name }));

  return (
    <ManagementPage
      title="Allowances"
      description="Set the monthly organization default, override it by department or member, and add audited one-time top-ups."
      eyebrow="Usage & billing"
      actions={canWrite ? (
        <>
          <Button variant="secondary" onClick={() => setCycleOpen(true)}>Configure cycle</Button>
          <Button variant="secondary" onClick={() => { setTopUpUserId(members[0]?.userId ?? ""); setTopUpOpen(true); }}>
            <Plus />
            Top up member
          </Button>
          <Button variant="secondary" onClick={() => setAssignOpen(true)}>
            <Plus />
            Add guardrail
          </Button>
          <Button onClick={() => openDefault("organization")}>
            <Save />
            Edit organization default
          </Button>
        </>
      ) : null}
    >
      {success ? <SuccessMessage>{success}</SuccessMessage> : null}
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        <MetricGrid items={[
          { label: "Used this cycle", value: formatMoney(totalUsed) },
          { label: "Available", value: formatMoney(totalAvailable) },
          { label: "Members with limits", value: formatNumber(balances.filter((item: any) => item.effectiveLimitMicros !== null).length) },
          { label: "Needs attention", value: formatNumber(balances.filter((item: any) => item.status === "warning" || item.status === "blocked").length), status: balances.some((item: any) => item.status === "blocked") ? "danger" : "warning" },
        ]} />
        <Section
          title="Default allowance hierarchy"
          description="Every member starts with the organization amount. A department can replace it for its members; a member override wins over both."
        >
          <DataTable
            label="Recurring allowance defaults"
            columns={["Level", "Applies to", "Monthly base", "Behavior"]}
            rows={[
              [
                <b>Organization</b>,
                "All members",
                organizationBaseMicros === null ? "Not configured" : formatMoney(organizationBaseMicros),
                "Default for new and existing members",
              ],
              ...departments.map((department: any) => {
                const assignment = departmentDefaults.get(department.id);
                const profile = assignment?.profileId ? profilesById.get(assignment.profileId) : null;
                return [
                  "Department",
                  department.name,
                  profile?.hardLimitMicros
                    ? formatMoney(profile.hardLimitMicros)
                    : organizationBaseMicros === null
                      ? "Not configured"
                      : formatMoney(organizationBaseMicros),
                  profile ? "Overrides organization" : "Inherits organization",
                ];
              }),
            ]}
            {...(canWrite ? {
              onRowSelect: (index: number) => index === 0
                ? openDefault("organization")
                : openDefault("department", departments[index - 1]?.id ?? ""),
              rowLabel: (index: number) => index === 0
                ? "Edit organization default allowance"
                : `Edit ${departments[index - 1]?.name ?? "department"} allowance`,
            } : {})}
          />
        </Section>
        <Section
          title="Allowance cycle"
          description="Monthly anchors use local organization time. Days 1–28 avoid short-month ambiguity."
        >
          <DataTable
            label="Allowance cycle"
            columns={["Timezone", "Anchor", "Current cycle", "Next reset"]}
            rows={cycle ? [[
              cycle.timezone,
              `Day ${cycle.anchorDay}`,
              balances[0] ? `${new Date(balances[0].cycleStart).toLocaleDateString()} – ${new Date(balances[0].cycleEnd).toLocaleDateString()}` : "—",
              balances[0] ? formatDateTime(balances[0].cycleEnd) : "—",
            ]] : []}
          />
        </Section>
        <Section
          title="Member balances"
          description="Select a member to edit their recurring base or return them to the inherited department or organization allowance."
        >
          <DataTable
            label="Member allowance balances"
            columns={["Member", "Base", "Source", "Top-ups", "Used", "Available", "State", "Reset", ""]}
            rows={balances.map((item: any) => [
              <span><b>{item.userName || item.userEmail || memberNames.get(item.userId) || "Unknown member"}</b><small>{item.userEmail ?? item.userId}</small></span>,
              item.baseLimitMicros === null ? "Unlimited" : formatMoney(item.baseLimitMicros),
              <StatusPill tone={item.baseSource === "member" ? "warning" : item.baseSource === "unlimited" ? "neutral" : "good"}>{human(item.baseSource)}</StatusPill>,
              formatMoney(item.adjustmentMicros),
              formatMoney(BigInt(item.usedMicros) + BigInt(item.reservedMicros)),
              item.availableMicros === null ? "Unlimited" : formatMoney(item.availableMicros),
              <StatusPill tone={item.status === "healthy" ? "good" : item.status === "blocked" ? "danger" : item.status === "warning" ? "warning" : "neutral"}>{item.status}</StatusPill>,
              new Date(item.cycleEnd).toLocaleDateString(),
              canWrite ? <Button variant="ghost" onClick={(event) => { event.stopPropagation(); setTopUpUserId(item.userId); setTopUpOpen(true); }}>Top up</Button> : null,
            ])}
            {...(canWrite ? {
              onRowSelect: openMemberBase,
              activeRow: memberBaseOpen ? balances.findIndex((item: any) => item.userId === memberBaseUserId) : null,
              rowLabel: (index: number) => `Edit ${balances[index]?.userName || balances[index]?.userEmail || "member"} base allowance`,
            } : {})}
          />
        </Section>
        <Section
          title="Assigned limits and aggregate guardrails"
          description="Department and organization rows are aggregate safety ceilings. Recurring member bases are managed in the hierarchy above."
        >
          <DataTable
            label="Assigned allowance limits"
            columns={["Scope", "Period", "Soft", "Hard", "Requests", "Tokens", "Updated"]}
            rows={limits.map((item: any) => [
              `${human(item.scopeType)}: ${item.scopeType === "user" ? memberNames.get(item.scopeId) ?? item.scopeId : item.scopeType === "department" ? departmentNames.get(item.scopeId) ?? item.scopeId : "Emergency organization guardrail"}`,
              item.period,
              formatMoney(item.softLimitMicros),
              formatMoney(item.hardLimitMicros),
              item.requestLimit ?? "—",
              item.tokenLimit ?? "—",
              new Date(item.updatedAt).toLocaleDateString(),
            ])}
          />
        </Section>
        <Section title="Current-cycle top-up history" description="Top-ups are append-only and include an administrator reason.">
          <DataTable
            label="Allowance adjustments"
            columns={["Member", "Amount", "Reason", "Cycle", "Created"]}
            rows={adjustments.map((item: any) => [
              memberNames.get(item.userId) ?? item.userId,
              formatMoney(item.amountMicros),
              item.reason,
              `${new Date(item.cycleStart).toLocaleDateString()} – ${new Date(item.cycleEnd).toLocaleDateString()}`,
              formatDateTime(item.createdAt),
            ])}
          />
        </Section>
        {profiles.length ? <p className="text-xs text-muted-foreground">{profiles.length} reusable allowance {profiles.length === 1 ? "profile" : "profiles"} configured.</p> : null}
      </AsyncState>

      <ManagementDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title="Add aggregate guardrail"
        description="Cap total department or organization spend independently from each member’s recurring base."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Button><Button type="submit" form="assign-allowance-form"><Save />Apply guardrail</Button></>}
      >
        <form id="assign-allowance-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={submitAllowance}>
          <label>Scope<FormSelect value={scopeType} onChange={(value) => setScopeType(value as typeof scopeType)} options={[{ value: "department", label: "Department aggregate guardrail" }, { value: "org", label: "Emergency organization guardrail" }]} /></label>
          {scopeType !== "org" ? <label>Department<FormSelect name="scopeId" options={targetOptions} placeholder="Select department" required /></label> : <p className="self-end rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Applies to all organization spend as an emergency ceiling.</p>}
          <label>Period<FormSelect name="period" defaultValue="month" options={[{ value: "month", label: "Monthly cycle" }, { value: "day", label: "Daily" }]} /></label>
          <label>Soft limit (USD)<Input name="soft" type="number" min="0" step=".01" required /></label>
          <label>Hard limit (USD)<Input name="hard" type="number" min="0" step=".01" required /></label>
          <label>Request quota<Input name="requests" type="number" min="0" /></label>
          <label>Token quota<Input name="tokens" type="number" min="0" /></label>
          <label>Sandbox minutes<Input name="sandbox" type="number" min="0" step=".1" /></label>
          <label className="sm:col-span-2">Audit reason<Input name="reason" minLength={3} required /></label>
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={defaultOpen}
        onOpenChange={setDefaultOpen}
        title={defaultScope === "organization" ? "Organization default allowance" : "Department allowance"}
        description={defaultScope === "organization"
          ? "This monthly amount is applied to every active member unless a department or member override exists."
          : "Choose whether this department inherits the organization amount or gives each member a different monthly base."}
        footer={<><Button type="button" variant="secondary" onClick={() => setDefaultOpen(false)}>Cancel</Button><Button type="submit" form="default-allowance-form">Save default</Button></>}
      >
        <form id="default-allowance-form" className="grid gap-3 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={submitDefault}>
          {defaultScope === "department" ? <>
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-medium text-foreground">{departmentNames.get(defaultDepartmentId) ?? "Department"}</p>
            <label>Allowance source<FormSelect value={defaultMode} onChange={(value) => setDefaultMode(value as typeof defaultMode)} options={[{ value: "inherit", label: `Use organization default (${organizationBaseMicros === null ? "not configured" : formatMoney(organizationBaseMicros)})` }, { value: "custom", label: "Set department amount" }]} /></label>
          </> : null}
          {defaultScope === "organization" || defaultMode === "custom" ? <label>Monthly base per member (USD)<Input value={defaultAmount} onChange={(event) => setDefaultAmount(event.target.value)} type="number" min="0.01" step=".01" autoFocus required /></label> : (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">Members in this department will receive the organization default. Existing member-specific overrides are unchanged.</p>
          )}
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={memberBaseOpen}
        onOpenChange={setMemberBaseOpen}
        title="Edit member base allowance"
        description={memberNames.get(memberBaseUserId) ?? "Choose the recurring monthly amount for this member."}
        footer={<><Button type="button" variant="secondary" onClick={() => setMemberBaseOpen(false)}>Cancel</Button><Button type="submit" form="member-base-form">Save base</Button></>}
      >
        <form id="member-base-form" className="grid gap-3 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={submitMemberBase}>
          <label>Allowance source<FormSelect value={memberBaseMode} onChange={(value) => setMemberBaseMode(value as typeof memberBaseMode)} options={[{ value: "inherit", label: "Use inherited default" }, { value: "custom", label: "Set member override" }]} /></label>
          {memberBaseMode === "custom" ? <label>Monthly base (USD)<Input value={memberBaseAmount} onChange={(event) => setMemberBaseAmount(event.target.value)} type="number" min="0.01" step=".01" autoFocus required /></label> : (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">The department allowance applies first. If the department has no override, this member receives the organization default.</p>
          )}
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={topUpOpen}
        onOpenChange={setTopUpOpen}
        title="Top up member"
        description="Add a one-time amount to this member’s current monthly cycle. Department guardrails still apply."
        footer={<><Button type="button" variant="secondary" onClick={() => setTopUpOpen(false)}>Cancel</Button><Button type="submit" form="top-up-allowance-form">Add top-up</Button></>}
      >
        <form id="top-up-allowance-form" className="grid gap-3 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={submitTopUp}>
          <label>Member<FormSelect name="userId" value={topUpUserId} onChange={setTopUpUserId} options={members.map((member: any) => ({ value: member.userId, label: member.name || member.email }))} required /></label>
          <label>Top-up amount (USD)<Input name="amount" type="number" min="0.01" step=".01" autoFocus required /></label>
          <label>Reason<Input name="reason" minLength={3} maxLength={500} required /></label>
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={cycleOpen}
        onOpenChange={setCycleOpen}
        title="Configure monthly cycle"
        description="Choose the organization timezone and reset day. The anchor is limited to days 1–28."
        footer={<><Button type="button" variant="secondary" onClick={() => setCycleOpen(false)}>Cancel</Button><Button type="submit" form="allowance-cycle-form">Save cycle</Button></>}
      >
        <form id="allowance-cycle-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={submitCycle}>
          <label>Timezone<Input name="timezone" defaultValue={cycle?.timezone ?? "UTC"} placeholder="Asia/Dubai" required /></label>
          <label>Anchor day<Input name="anchorDay" type="number" min="1" max="28" defaultValue={cycle?.anchorDay ?? 1} required /></label>
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}
function Billing({ client, tenantId, permissions }: ManagementScreenProps) {
  const r = useResource(
    `billing:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.billingSummary(tenantId),
            client.billingHealth(tenantId),
            client.billingLedger(tenantId),
            client.autoRefill(tenantId),
          ])
        : [null, null, { items: [] }, null],
    [] as any,
  );
  const [confirmed, setConfirmed] = React.useState(false),
    [success, setSuccess] = React.useState(""),
    [open, setOpen] = React.useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await client?.createBillingCreditGrant(tenantId, {
      source: "manual",
      amountMicros: String(Math.round(Number(f.get("amount")) * 1e6)),
      currency: "usd",
      reason: String(f.get("reason")),
      externalRef: String(f.get("externalRef")) || null,
      confirmation: true,
      idempotencyKey: String(f.get("idempotencyKey")),
      metadata: {},
    });
    setConfirmed(false);
    setOpen(false);
    setSuccess("Organization credit grant completed.");
    r.retry();
  };
  const [s, h, l, a] = r.data;
  return (
    <ManagementPage
      title="Credits & billing"
      description="The organization owns one prepaid pool. Reservations, reconciliations, grants, and invoices are auditable."
      eyebrow="Finance"
      actions={
        permissions.includes("billing:write") ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            <Plus />
            Grant credit
          </Button>
        ) : null
      }
    >
      {success ? <SuccessMessage>{success}</SuccessMessage> : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !s}
        emptyTitle="Billing data unavailable"
        emptyText="Connect the organization billing API to view balances, ledger entries, and refill health."
      >
        {s ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Prepaid balance",
                  value: formatMoney(s.prepaidBalanceMicros),
                },
                { label: "Provider", value: s.provider },
                {
                  label: "Billing health",
                  value: h?.status ?? "Unknown",
                  status: h?.status === "healthy" ? "good" : "warning",
                },
                {
                  label: "Auto-refill",
                  value: a?.supported
                    ? a.enabled
                      ? "On"
                      : "Off"
                    : "Unsupported",
                },
              ]}
            />
            <Section title="Credit ledger">
              <DataTable
                label="Credit ledger"
                columns={[
                  "Time",
                  "Kind",
                  "Amount",
                  "Balance",
                  "Source",
                  "Status",
                ]}
                rows={(l.items ?? []).map((x: any) => [
                  new Date(x.createdAt).toLocaleString(),
                  x.kind,
                  formatMoney(x.amountMicros),
                  formatMoney(x.balanceAfterMicros),
                  x.source,
                  <StatusPill tone="good">{x.status}</StatusPill>,
                ])}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
      <ManagementDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmed(false);
        }}
        title="Grant organization credit"
        description="Add funds to the shared prepaid pool. This financial mutation requires an audit reason, a unique idempotency key, and explicit confirmation."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="grant-credit-form"
              variant="destructive"
              disabled={!confirmed}
            >
              Grant credit
            </Button>
          </>
        }
      >
        <form
          id="grant-credit-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Amount (USD)
            <Input
              name="amount"
              type="number"
              min=".01"
              step=".01"
              autoFocus
              required
            />
          </label>
          <label>
            External reference
            <Input name="externalRef" />
          </label>
          <label className="sm:col-span-2">
            Idempotency key
            <Input
              name="idempotencyKey"
              defaultValue={crypto.randomUUID()}
              minLength={8}
              required
            />
          </label>
          <label className="sm:col-span-2">
            Reason
            <Input name="reason" minLength={3} required />
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground sm:col-span-2">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <span>
              I confirm this financial mutation changes the organization credit
              pool.
            </span>
          </label>
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}
function ReportsAlerts({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const r = useResource(
    `reports:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.savedAnalyticsViews(tenantId),
            client.reportSchedules(tenantId),
            client.reportRuns(tenantId),
            client.alertDestinations(tenantId),
            client.alertRules(tenantId),
            client.alertDeliveries(tenantId),
          ])
        : [[], [], [], [], [], []],
    [] as any,
  );
  const [v, s, runs, d, rules, deliveries] = r.data;
  return (
    <ManagementPage
      title="Reports & alerts"
      description="Saved analytic views, scheduled delivery, alert rules, destinations, and delivery history."
      eyebrow="Finance"
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Scheduled reports">
            <DataTable
              label="Report schedules"
              columns={["Name", "Cadence", "Format", "Status", "Next run"]}
              rows={s.map((x: any) => [
                x.name,
                x.cadence,
                x.format,
                <StatusPill tone={x.status === "active" ? "good" : "neutral"}>
                  {x.status}
                </StatusPill>,
                x.nextRunAt ? new Date(x.nextRunAt).toLocaleString() : "—",
              ])}
            />
          </Section>
          <Section title="Alert rules">
            <DataTable
              label="Alert rules"
              columns={["Rule", "Signal", "Threshold", "State"]}
              rows={rules.map((x: any) => [
                x.name,
                human(x.signal),
                x.threshold,
                x.enabled ? <StatusPill tone="good">On</StatusPill> : "Off",
              ])}
            />
          </Section>
        </div>
        <Section title="Delivery history">
          <DataTable
            label="Delivery history"
            columns={["Created", "Destination", "Attempt", "Status", "Error"]}
            rows={deliveries.map((x: any) => [
              new Date(x.createdAt).toLocaleString(),
              x.destinationId,
              x.attempt,
              <StatusPill
                tone={
                  x.status === "delivered"
                    ? "good"
                    : x.status === "failed"
                      ? "danger"
                      : "warning"
                }
              >
                {x.status}
              </StatusPill>,
              x.error ?? "—",
            ])}
          />
        </Section>
        {permissions.includes("reports:write") && v.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Save an analytics view from Analytics before creating a report
            schedule.
          </p>
        ) : null}
        {d.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            No alert destination is configured. Add one through the API or
            deployment configuration before enabling delivery.
          </p>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}
function PolicyScreen({
  kind,
  client,
  tenantId,
  permissions,
}: ManagementScreenProps & { kind: "execution" | "authentication" | "data" }) {
  const write =
    kind === "execution"
      ? "guardrails:write"
      : kind === "authentication"
        ? "auth_policy:write"
        : "data_policy:write";
  const r = useResource(
    `${kind}:${tenantId}`,
    async () => {
      if (!client) return null;
      return kind === "execution"
        ? client.executionPolicy(tenantId)
        : kind === "authentication"
          ? client.authenticationPolicy(tenantId)
          : client.dataGovernancePolicy(tenantId);
    },
    null as any,
  );
  const [message, setMessage] = React.useState("");
  const save = async () => {
    if (!client || !r.data) return;
    if (kind === "execution")
      await client.updateExecutionPolicy(tenantId, strip(r.data));
    else if (kind === "authentication")
      await client.updateAuthenticationPolicy(tenantId, strip(r.data));
    else await client.updateDataGovernancePolicy(tenantId, strip(r.data));
    setMessage("Policy saved and added to the organization audit log.");
    r.retry();
  };
  return (
    <ManagementPage
      title={
        kind === "execution"
          ? "Execution & network"
          : kind === "authentication"
            ? "Authentication"
            : "Data governance"
      }
      description={
        kind === "execution"
          ? "Sandbox, approvals, network access, concurrency, rate, token, and sandbox-minute controls."
          : kind === "authentication"
            ? "MFA, session lifetime, trusted devices, login methods, domains, and emergency owner access."
            : "Retention, residency, filters, moderation hooks, deletion, export, and legal-hold behavior."
      }
      eyebrow="Security & data"
    >
      {kind === "authentication" ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Berry is currently in No SSO mode. Local password accounts and the protected owner recovery path are active; OIDC, SAML, JIT provisioning, Google Directory sync, and SCIM remain disabled until the deferred identity roadmap is implemented end to end.
        </p>
      ) : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !r.data}
        emptyTitle="Policy unavailable"
        emptyText="Connect the organization API to load and edit the effective policy."
      >
        {r.data ? (
          <Section
            title="Effective policy"
            actions={
              permissions.includes(write as any) ? (
                <Button onClick={save}>
                  <Save />
                  Save policy
                </Button>
              ) : null
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(r.data)
                .filter(([k]) => !["tenantId", "updatedAt"].includes(k))
                .map(([k, v]) => (
                  <label key={k}>
                    <span>{human(k)}</span>
                    {typeof v === "boolean" ? (
                      <Checkbox
                        checked={v}
                        disabled={!permissions.includes(write as any)}
                        onCheckedChange={(checked) =>
                          r.setData({ ...r.data, [k]: checked === true })
                        }
                      />
                    ) : typeof v === "number" ? (
                      <Input
                        type="number"
                        value={v}
                        disabled={!permissions.includes(write as any)}
                        onChange={(e) =>
                          r.setData({
                            ...r.data,
                            [k]: Number(e.currentTarget.value),
                          })
                        }
                      />
                    ) : Array.isArray(v) ? (
                      <Input
                        value={v.join(", ")}
                        disabled={!permissions.includes(write as any)}
                        onChange={(e) =>
                          r.setData({
                            ...r.data,
                            [k]: e.currentTarget.value
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    ) : typeof v === "object" ? (
                      <code>{JSON.stringify(v)}</code>
                    ) : (
                      <Input
                        value={String(v ?? "")}
                        disabled={!permissions.includes(write as any)}
                        onChange={(e) =>
                          r.setData({ ...r.data, [k]: e.currentTarget.value })
                        }
                      />
                    )}
                  </label>
                ))}
            </div>
            {message ? <SuccessMessage>{message}</SuccessMessage> : null}
          </Section>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}
function ServiceAccounts({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const r = useResource(
    `accounts:${tenantId}`,
    async () => (client ? client.serviceAccounts(tenantId) : []),
    [] as any[],
  );
  const [token, setToken] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const row = await client?.createServiceAccount(tenantId, {
      name: String(f.get("name")),
      permissions: ["org:read"],
      resourceRestrictions: [],
      expiresAt: null,
    });
    if (row) {
      setToken(row.token);
      setOpen(false);
    }
    r.retry();
  };
  return (
    <ManagementPage
      title="Service accounts"
      description="Scoped non-human principals with expiry, rotation, revocation, and one-time tokens."
      eyebrow="Security & data"
      actions={
        permissions.includes("service_accounts:write") ? (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            Create account
          </Button>
        ) : null
      }
    >
      {token ? (
        <div
          className="grid gap-1.5 break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground"
          role="status"
        >
          <b>Copy this token now</b>
          <code>{token}</code>
          <span>
            Berry stores only a hash. This token cannot be shown again.
          </span>
        </div>
      ) : null}
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Create service account"
        description="Create a non-human principal with the default read-only organization scope. Berry shows the token once after creation."
        size="sm"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-service-account-form">
              Create account
            </Button>
          </>
        }
      >
        <form
          id="create-service-account-form"
          className="grid gap-3 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={create}
        >
          <label>
            Account name
            <Input name="name" autoFocus required />
          </label>
        </form>
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={r.data.length === 0}
      >
        <DataTable
          label="Service accounts"
          columns={[
            "Name",
            "Permissions",
            "Status",
            "Token",
            "Last used",
            "Expires",
          ]}
          rows={r.data.map((x: any) => [
            <b>{x.name}</b>,
            x.permissions.join(", "),
            <StatusPill tone={x.status === "active" ? "good" : "danger"}>
              {x.status}
            </StatusPill>,
            `•••• ${x.tokenLast4}`,
            x.lastUsedAt ? new Date(x.lastUsedAt).toLocaleString() : "Never",
            x.expiresAt ? new Date(x.expiresAt).toLocaleDateString() : "Never",
          ])}
        />
      </AsyncState>
    </ManagementPage>
  );
}
function Profile({ client, tenantId }: ManagementScreenProps) {
  const r = useResource(
    `profile:${tenantId}`,
    async () => (client ? client.organizationProfile(tenantId) : null),
    null as any,
  );
  return (
    <ManagementPage
      title="Profile & domains"
      description="Organization identity, locale, contacts, verified domains, branding, and deployment metadata."
      eyebrow="Organization"
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        {r.data ? (
          <>
            <MetricGrid
              items={[
                { label: "Organization", value: r.data.name },
                { label: "Slug", value: r.data.slug },
                { label: "Deployment", value: r.data.deploymentMode },
                { label: "Region", value: r.data.region ?? "Default" },
              ]}
            />
            <Section title="Verified domains">
              <DataTable
                label="Organization domains"
                columns={["Domain", "Status", "Custom domain", "Verified"]}
                rows={r.data.domains.map((x: any) => [
                  x.domain,
                  <StatusPill
                    tone={x.status === "verified" ? "good" : "warning"}
                  >
                    {x.status}
                  </StatusPill>,
                  x.customDomain ? "Yes" : "No",
                  x.verifiedAt
                    ? new Date(x.verifiedAt).toLocaleDateString()
                    : "—",
                ])}
              />
            </Section>
            <Section title="Contacts">
              <DataTable
                label="Contacts"
                columns={["Purpose", "Address"]}
                rows={[
                  ["Support", r.data.supportEmail ?? "Not configured"],
                  ["Security", r.data.securityEmail ?? "Not configured"],
                ]}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}
function permissionFor(tab: string) {
  return (
    {
      members: "members:read",
      departments: "departments:read",
      roles: "rbac:read",
      "resource-access": "acl:read",
      providers: "models:read",
      models: "models:read",
      "feature-access": "feature_flags:read",
      "execution-network": "guardrails:read",
      analytics: "usage:read",
      "spend-limits": "budgets:read",
      "credits-billing": "billing:read",
      "reports-alerts": "reports:read",
      "sso-scim": "sso:read",
      "managed-policy": "policy:read",
      authentication: "auth_policy:read",
      "data-governance": "data_policy:read",
      "service-accounts": "service_accounts:read",
      "audit-log": "audit:read",
      "profile-domains": "org_settings:read",
    } as Record<string, string>
  )[tab];
}
function titleFor(tab: string) {
  return (
    (
      {
        roles: "Roles & permissions",
        "resource-access": "Resource access",
        models: "Models",
        "skills-mcp": "Skills & MCP",
        "feature-access": "Feature access",
        "sso-scim": "SSO & SCIM",
        "managed-policy": "Managed policy",
        "audit-log": "Audit log",
      } as Record<string, string>
    )[tab] ?? human(tab)
  );
}
function human(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function strip(value: any) {
  const { tenantId, updatedAt, ...rest } = value;
  return rest;
}
function download(value: string, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([value], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
