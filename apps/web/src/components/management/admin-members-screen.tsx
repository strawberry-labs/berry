import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, FileUp, Plus, Save, Search, UserPlus, Users } from "lucide-react";
import {
  AsyncState, Button, Checkbox, DataTable, FormSelect, Input, ManagementDialog,
  ManagementPage, MetricGrid, SearchInput, Section, StatusPill, SuccessMessage,
  Switch, Toolbar, formatDateTime, formatMoney, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import {
  calculateCacheMetric, UsageRangeControl, usageRangeForPreset,
  type UsageDateRange, type UsageRangePreset,
} from "./usage-controls";
import { parseMemberImportCsv, type MemberImportRow } from "../../lib/member-import";
import { memberAccessStatusOptions, memberStatusUpdate } from "../../lib/member-administration";
export function AdminMembersScreen({
  client,
  config,
  tenantId,
  userId,
  permissions,
}: ManagementScreenProps) {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState(""),
    [addMode, setAddMode] = React.useState<"choose" | "manual" | "bulk" | null>(null),
    [message, setMessage] = React.useState("");
  const [manualError, setManualError] = React.useState("");
  const [manualBusy, setManualBusy] = React.useState(false);
  const [bulkRows, setBulkRows] = React.useState<BulkMemberRow[]>([]);
  const [bulkFileName, setBulkFileName] = React.useState("");
  const [bulkError, setBulkError] = React.useState("");
  const [bulkImporting, setBulkImporting] = React.useState(false);
  const [bulkNotice, setBulkNotice] = React.useState("");
  const [editing, setEditing] = React.useState<any>(null);
  const [editRole, setEditRole] = React.useState("member");
  const [editStatus, setEditStatus] = React.useState("active");
  const [editDepartments, setEditDepartments] = React.useState<Set<string>>(new Set());
  const [editPrimaryDepartment, setEditPrimaryDepartment] = React.useState("none");
  const [editBusy, setEditBusy] = React.useState(false);
  const [editError, setEditError] = React.useState("");
  const r = useResource(
    `members:${tenantId}`,
    async () => (client ? client.listOrgMembers(tenantId) : []),
    [] as any[],
  );
  const authConfiguration = useResource(
    "member-auth-configuration",
    async () => client ? client.authConfig() : { loginMode: "google" as const, emailPassword: { enabled: false }, ssoProviders: [] },
    { loginMode: "google" as "password" | "google" | "mixed", emailPassword: { enabled: false }, ssoProviders: [] as Array<{ id: "google"; name: string; domain: string }> },
  );
  const googleOnly = authConfiguration.data.loginMode === "google";
  const actorRole = r.data.find((member: any) => member.userId === userId)?.role as "owner" | "admin" | "member" | undefined;
  const canAddGoogleAdministrator = !authConfiguration.loading && !authConfiguration.error && actorRole === "owner";
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
    setManualBusy(true);
    setManualError("");
    try {
      const f = new FormData(e.currentTarget);
      const departmentId = String(f.get("primaryDepartmentId"));
      await client.createOrgMember(tenantId, {
        email: String(f.get("email")),
        name: String(f.get("name") ?? "").trim() || undefined,
        ...(googleOnly ? { provisioning: "google_sso" as const } : { provisioning: "local" as const, password: String(f.get("password")) }),
        role: googleOnly ? "admin" : String(f.get("role")) as any,
        departmentIds: departmentId && departmentId !== "none" ? [departmentId] : [],
        primaryDepartmentId: departmentId && departmentId !== "none" ? departmentId : null,
      });
      setAddMode(null);
      setMessage(googleOnly ? "Administrator added. Access activates after their first Google sign-in." : "Member account created and the default allowance profile was applied.");
      r.retry();
      balances.retry();
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "Member creation failed.");
    } finally {
      setManualBusy(false);
    }
  };
  const chooseAddMode = (mode: "manual" | "bulk") => {
    setManualError("");
    setBulkError("");
    setBulkNotice("");
    setAddMode(mode);
  };
  const readBulkFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBulkFileName(file.name);
    setBulkError("");
    setBulkNotice("");
    try {
      const parsed = parseMemberImportCsv(
        await file.text(),
        r.data.map((member: any) => String(member.email)),
      );
      setBulkRows(parsed.map((row) => ({
        ...row,
        status: row.error ? "failed" : "ready",
        importError: row.error,
      })));
    } catch (error) {
      setBulkRows([]);
      setBulkError(error instanceof Error ? error.message : "Couldn’t read this CSV file.");
    }
  };
  const importBulkMembers = async () => {
    if (!client || bulkImporting) return;
    const readyRows = bulkRows.filter((row) => row.status === "ready");
    if (readyRows.length === 0) return;
    setBulkImporting(true);
    setBulkError("");
    setBulkNotice("");
    let createdCount = 0;
    let failedCount = bulkRows.filter((row) => row.status === "failed").length;
    for (const row of readyRows) {
      setBulkRows((current) => current.map((item) =>
        item.rowNumber === row.rowNumber ? { ...item, status: "creating" } : item,
      ));
      try {
        await client.createOrgMember(tenantId, {
          email: row.email,
          name: row.name,
          password: row.password,
          role: "member",
        });
        createdCount += 1;
        setBulkRows((current) => current.map((item) =>
          item.rowNumber === row.rowNumber ? { ...item, status: "created", importError: undefined } : item,
        ));
      } catch (error) {
        failedCount += 1;
        const importError = error instanceof Error ? error.message : "Account creation failed.";
        setBulkRows((current) => current.map((item) =>
          item.rowNumber === row.rowNumber ? { ...item, status: "failed", importError } : item,
        ));
      }
    }
    setBulkImporting(false);
    setBulkNotice(
      failedCount
        ? `${createdCount} ${createdCount === 1 ? "member" : "members"} created. ${failedCount} ${failedCount === 1 ? "row needs" : "rows need"} attention.`
        : `${createdCount} ${createdCount === 1 ? "member" : "members"} created. Copy the temporary passwords before closing.`,
    );
    if (createdCount) {
      setMessage(`${createdCount} ${createdCount === 1 ? "member was" : "members were"} imported.`);
      r.retry();
      balances.retry();
    }
  };
  const copyCreatedCredentials = async () => {
    const credentials = bulkRows
      .filter((row) => row.status === "created")
      .map((row) => `${row.name}\t${row.email}\t${row.password}`)
      .join("\n");
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(`Name\tEmail\tTemporary password\n${credentials}`);
      setBulkNotice("Created member credentials copied to the clipboard.");
    } catch {
      setBulkError("Clipboard access was blocked. Copy the passwords from the table below.");
    }
  };
  const openMember = (member: any) => {
    setEditError("");
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
    setEditBusy(true);
    setEditError("");
    try {
      const pendingGoogleActivation = editing.status === "pending";
      const statusUpdate = memberStatusUpdate(editing.status, editStatus);
      const updated = await client.updateOrgMember(tenantId, editing.userId, {
        role: editRole as "admin" | "member",
        ...statusUpdate,
        departmentIds: [...editDepartments],
        primaryDepartmentId: editPrimaryDepartment === "none" ? null : editPrimaryDepartment,
      });
      r.setData(r.data.map((member: any) => member.userId === updated.userId ? updated : member));
      setEditing(null);
      setMessage(
        pendingGoogleActivation && editStatus === "pending"
          ? "Pending Google administrator updated. Access will activate after their first Google sign-in."
          : editStatus === "disabled"
            ? "Member blocked. Existing usage history was preserved."
            : editStatus === "deprovisioned"
              ? "Member offboarded. Access was revoked and history was preserved."
              : "Member access and primary department updated.",
      );
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "Member update failed.");
    } finally {
      setEditBusy(false);
    }
  };
  return (
    <ManagementPage
      title="Members"
      description={googleOnly ? "Review Workspace users, promote trusted administrators, and manage organization access." : "Find people by name or email, review current-month spend, and administer local organization accounts."}
      eyebrow="People"
      actions={
        permissions.includes("members:write") && !authConfiguration.loading && !authConfiguration.error && (!googleOnly || canAddGoogleAdministrator) ? (
          <Button onClick={() => {
            setBulkRows([]);
            setBulkFileName("");
            setBulkError("");
            setBulkNotice("");
            setManualError("");
            setAddMode(googleOnly ? "manual" : "choose");
          }}>
            <Plus />
            {googleOnly ? "Add administrator" : "Add member"}
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
      {authConfiguration.error ? <AsyncState loading={false} error={authConfiguration.error} onRetry={authConfiguration.retry}>{null}</AsyncState> : null}
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {!googleOnly ? <ManagementDialog
        open={addMode === "choose"}
        onOpenChange={(next) => { if (!next) setAddMode(null); }}
        title="Add members"
        description="Create one member manually or import a CSV with multiple names and email addresses."
        footer={<Button type="button" variant="secondary" onClick={() => setAddMode(null)}>Cancel</Button>}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            className="group grid min-h-32 gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => chooseAddMode("manual")}
          >
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/50 text-foreground"><UserPlus className="size-4" aria-hidden /></span>
            <span><b className="block text-sm text-foreground">Add manually</b><small className="mt-1 block text-xs leading-5 text-muted-foreground">Enter account details, role, department, and a temporary password.</small></span>
          </button>
          <button
            type="button"
            className="group grid min-h-32 gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => chooseAddMode("bulk")}
          >
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/50 text-foreground"><Users className="size-4" aria-hidden /></span>
            <span><b className="block text-sm text-foreground">Bulk import</b><small className="mt-1 block text-xs leading-5 text-muted-foreground">Upload a CSV. New accounts use the member role and no department.</small></span>
          </button>
        </div>
      </ManagementDialog> : null}
      <ManagementDialog
        open={addMode === "manual"}
        onOpenChange={(next) => { if (!next && !manualBusy) setAddMode(null); }}
        title={googleOnly ? "Add Google administrator" : "Add member"}
        description={googleOnly ? `Reserve the administrator role for a trusted @${authConfiguration.data.ssoProviders[0]?.domain ?? "Workspace"} account. Access activates on their first Google sign-in.` : "Create a local Berry account and apply the selected organization role. Email invitations are not sent in the current no-SSO mode."}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAddMode(googleOnly ? null : "choose")}
              disabled={manualBusy}
            >
              Back
            </Button>
            <Button type="submit" form="invite-member-form" disabled={manualBusy}>
              {manualBusy ? "Saving…" : googleOnly ? "Add administrator" : "Create account"}
            </Button>
          </>
        }
      >
        <form
          id="invite-member-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          {!googleOnly ? <label>
            Name
            <Input name="name" autoFocus required />
          </label> : null}
          <label>
            Email
            <Input name="email" type="email" autoFocus={googleOnly} required />
          </label>
          {!googleOnly ? <label>
            Temporary password
            <Input name="password" type="password" minLength={12} required />
          </label> : null}
          {!googleOnly ? <label>
            Role
            <FormSelect
              name="role"
              defaultValue="member"
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </label> : null}
          <label>
            Primary department
            <FormSelect
              name="primaryDepartmentId"
              defaultValue="none"
              options={[{ value: "none", label: "No department" }, ...departments.data.map((department: any) => ({ value: department.id, label: department.name }))]}
            />
          </label>
        </form>
        {manualError ? <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{manualError}</p> : null}
      </ManagementDialog>
      {!googleOnly ? <ManagementDialog
        open={addMode === "bulk"}
        onOpenChange={(next) => { if (!next && !bulkImporting) setAddMode(null); }}
        title="Bulk import members"
        description="Upload a CSV with name and email columns. Passwords are generated in your browser; every account is created as a member with no department."
        size="lg"
        footer={
          <>
            {bulkRows.some((row) => row.status === "created") ? (
              <Button type="button" variant="secondary" onClick={() => void copyCreatedCredentials()}>
                <Copy aria-hidden />
                Copy credentials
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => setAddMode(bulkRows.some((row) => row.status === "created") ? null : "choose")} disabled={bulkImporting}>
              {bulkRows.some((row) => row.status === "created") ? "Done" : "Back"}
            </Button>
            <Button type="button" onClick={() => void importBulkMembers()} disabled={bulkImporting || !bulkRows.some((row) => row.status === "ready")}>
              <FileUp aria-hidden />
              {bulkImporting ? "Importing…" : bulkRows.some((row) => row.status === "ready") ? `Import ${bulkRows.filter((row) => row.status === "ready").length} members` : "Import members"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-4 transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card"><FileUp className="size-4" aria-hidden /></span>
            <span className="min-w-0 flex-1"><b className="block truncate text-sm text-foreground">{bulkFileName || "Choose a CSV file"}</b><small className="mt-0.5 block text-xs text-muted-foreground">Required headers: name, email. Extra columns are ignored.</small></span>
            <span className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground">Browse</span>
            <input className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void readBulkFile(event)} disabled={bulkImporting} />
          </label>
          {bulkError ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{bulkError}</p> : null}
          {bulkNotice ? <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground" role="status">{bulkNotice}</p> : null}
          {bulkRows.length ? (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
                <b className="text-xs text-foreground">Import preview</b>
                <span className="text-[11px] text-muted-foreground">{bulkRows.filter((row) => row.status === "ready").length} ready · {bulkRows.filter((row) => row.status === "failed").length} need attention</span>
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="sticky top-0 bg-card text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Member</th><th className="px-3 py-2 font-medium">Temporary password</th><th className="px-3 py-2 font-medium">Status</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {bulkRows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="px-3 py-2 text-muted-foreground">{row.rowNumber}</td>
                        <td className="px-3 py-2"><b className="block font-medium text-foreground">{row.name || "Missing name"}</b><span className="text-muted-foreground">{row.email || "Missing email"}</span></td>
                        <td className="px-3 py-2 font-mono text-[11px] text-foreground">{row.password || "—"}</td>
                        <td className="max-w-52 px-3 py-2">
                          {row.status === "created" ? <StatusPill tone="good">Created</StatusPill> : row.status === "creating" ? <StatusPill tone="neutral">Creating</StatusPill> : row.status === "ready" ? <StatusPill tone="neutral">Ready</StatusPill> : <span className="text-[11px] leading-4 text-destructive">{row.importError || "Failed"}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          <p className="text-[11px] leading-4 text-muted-foreground">Password format: capitalized first name, @, then at least six random numbers. Generated passwords are at least 12 characters long.</p>
        </div>
      </ManagementDialog> : null}
      <ManagementDialog
        open={Boolean(editing)}
        onOpenChange={(next) => { if (!next && !editBusy) setEditing(null); }}
        title={editing?.name || "Manage member"}
        description={editing ? `${editing.email} · Set role, access status, and primary department.` : ""}
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setEditing(null)} disabled={editBusy}>Cancel</Button><Button type="button" onClick={() => void saveMember()} disabled={editing?.role === "owner" || editBusy}><Save />{editBusy ? "Saving…" : "Save member"}</Button></>}
      >
        {editing ? (
          <div className="grid gap-4">
            {editing.role === "owner" ? <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">The organization owner cannot be demoted, blocked, or offboarded from this screen.</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground">
              <label>Role<FormSelect value={editRole} onChange={setEditRole} disabled={editing.role === "owner" || actorRole !== "owner"} options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]} /></label>
              <label>Account access<FormSelect value={editStatus} onChange={setEditStatus} disabled={editing.role === "owner" || (editing.role === "admin" && actorRole !== "owner")} options={memberAccessStatusOptions(editing.status)} /></label>
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
            {editError ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{editError}</p> : null}
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

type BulkMemberRow = MemberImportRow & {
  status: "ready" | "creating" | "created" | "failed";
  importError: string | undefined;
};

function human(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
