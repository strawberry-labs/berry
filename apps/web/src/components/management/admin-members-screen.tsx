import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Eye, FileUp, LineChart, Plus, Save, MonitorSmartphone, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  AsyncState, Button, CellStack, Checkbox, DataTable, DefinitionList, DetailDrawer,
  FormSelect, InlineNotice, Input, ManagementDialog, ManagementPage, Meter, MetricGrid,
  Num, StatusPill, SuccessMessage, formatDate, formatMoney, formatMoneyWithCents, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { parseMemberImportCsv, type MemberImportRow } from "../../lib/member-import";
import { memberAccessStatusOptions, memberStatusUpdate } from "../../lib/member-administration";
import { startSupportView } from "../../lib/support-view";
import { AdminMembersSkeleton } from "./management-screen-skeletons";
const MemberSkillsDialog = React.lazy(async () => ({ default: (await import("./member-skills-dialog")).MemberSkillsDialog }));
const MemberDevicesDialog = React.lazy(async () => ({ default: (await import("./member-devices-dialog")).MemberDevicesDialog }));

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  pending: "Pending sign-in",
  disabled: "Blocked",
  deprovisioned: "Offboarded",
};
const STATUS_TONE: Record<string, "good" | "warning" | "danger" | "neutral"> = {
  active: "good",
  pending: "warning",
  disabled: "danger",
  deprovisioned: "neutral",
};
/** Members waiting on something sort first; people who have left sort last. */
const STATUS_ORDER: Record<string, number> = { pending: 0, disabled: 1, active: 2, deprovisioned: 3 };
const SOURCE_LABEL: Record<string, string> = { manual: "Added by an administrator", sso: "Single sign-on", scim: "Directory sync (SCIM)" };
const fieldLabel = "grid content-start gap-1.5 text-xs font-medium text-muted-foreground";
const fieldHint = "text-xs font-normal leading-snug text-muted-foreground";

/** A titled group inside the member drawer, separated from the one above by a hairline. */
function DrawerSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 border-t border-border pt-4">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-xs leading-snug text-muted-foreground text-pretty">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function AdminMembersScreen({
  client,
  config,
  tenantId,
  userId,
  permissions,
}: ManagementScreenProps) {
  const navigate = useNavigate();
  const [skillsMember, setSkillsMember] = React.useState<{ userId: string; name: string } | null>(null);
  const [devicesMember, setDevicesMember] = React.useState<{ userId: string; name: string } | null>(null);
  const [addMode, setAddMode] = React.useState<"manual" | "bulk" | null>(null),
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
  const canReadUsage = permissions.includes("usage:read");
  const canReadBalances = permissions.includes("budgets:read");
  const canWrite = permissions.includes("members:write");
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
  const rows = [...r.data].sort((left: any, right: any) =>
    (STATUS_ORDER[left.status] ?? 2) - (STATUS_ORDER[right.status] ?? 2)
    || String(left.name || left.email).localeCompare(String(right.name || right.email)),
  );
  const countByStatus = (status: string) => r.data.filter((member: any) => member.status === status).length;
  const departmentLabel = (member: any) => {
    const ids: string[] = member.departmentIds ?? [];
    if (ids.length === 0) return "—";
    const primary = member.primaryDepartmentId && ids.includes(member.primaryDepartmentId) ? member.primaryDepartmentId : ids[0]!;
    const name = departmentNames.get(primary) ?? "Unknown department";
    return ids.length > 1 ? `${name} +${ids.length - 1}` : name;
  };
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
  const openAdd = (mode: "manual" | "bulk") => {
    setBulkRows([]);
    setBulkFileName("");
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

  const createdAny = bulkRows.some((row) => row.status === "created");
  const readyCount = bulkRows.filter((row) => row.status === "ready").length;
  const failedRows = bulkRows.filter((row) => row.status === "failed").length;
  const canAdd = canWrite && !authConfiguration.loading && !authConfiguration.error && (!googleOnly || canAddGoogleAdministrator);

  const editingIsOwner = editing?.role === "owner";
  const roleLocked = editingIsOwner || actorRole !== "owner";
  const statusLocked = editingIsOwner || (editing?.role === "admin" && actorRole !== "owner");
  const editingDepartments: string[] = editing?.departmentIds ?? [];
  const editDirty = Boolean(editing) && (
    editRole !== editing.role
    || editStatus !== editing.status
    || editPrimaryDepartment !== (editing.primaryDepartmentId ?? "none")
    || editDepartments.size !== editingDepartments.length
    || editingDepartments.some((id) => !editDepartments.has(id))
  );
  const editingBalance = editing ? memberBalance.get(editing.userId) : null;
  const editingName = editing ? editing.name || editing.email : "";

  const columns = [
    "Member", "Role", "Department", "Status",
    ...(canReadUsage ? ["Month-to-date spend (UTC)"] : []),
    ...(canReadBalances ? ["Allowance"] : []),
    "Joined",
  ];
  const pending = countByStatus("pending");
  const blocked = countByStatus("disabled");

  return (
    <ManagementPage width="wide"
      title="Members"
      description={googleOnly ? "Everyone who can sign in to this organization, with their role, department, and access." : "Everyone with an account in this organization, with their role, department, access, and allowance."}
      eyebrow="People"
      actions={
        canAdd ? (
          googleOnly ? (
            <Button onClick={() => openAdd("manual")}><Plus />Add administrator</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => openAdd("bulk")}><FileUp />Import CSV</Button>
              <Button onClick={() => openAdd("manual")}><Plus />Add member</Button>
            </>
          )
        ) : null
      }
    >
      {authConfiguration.error ? <AsyncState loading={false} error={authConfiguration.error} onRetry={authConfiguration.retry}>{null}</AsyncState> : null}
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        skeleton={<AdminMembersSkeleton columns={columns} />}
        empty={r.data.length === 0}
        emptyTitle="No members yet"
        emptyText={googleOnly ? "People appear here after their first Google sign-in." : "Add a member or import a CSV to create accounts."}
      >
        <MetricGrid
          items={[
            { label: "Active", value: formatNumber(countByStatus("active")), hint: `of ${formatNumber(r.data.length)} members` },
            { label: "Pending sign-in", value: formatNumber(pending), hint: "Added, not yet signed in", ...(pending ? { status: "warning" as const } : {}) },
            { label: "Blocked", value: formatNumber(blocked), hint: "Cannot sign in or run tasks" },
            { label: "Offboarded", value: formatNumber(countByStatus("deprovisioned")), hint: "Access revoked, history kept" },
          ]}
        />
        <DataTable
          label="Members"
          searchable
          columns={columns}
          initialPageSize={25}
          onRowSelect={(index) => openMember(rows[index])}
          activeRow={editing ? rows.findIndex((member: any) => member.userId === editing.userId) : null}
          rowLabel={(index) => rows[index]?.name || rows[index]?.email || "Member"}
          rows={rows.map((m: any) => {
            const balance = memberBalance.get(m.userId);
            return [
              <CellStack primary={m.name || m.email} secondary={m.name ? m.email : undefined} />,
              sentence(m.role),
              departmentLabel(m),
              <StatusPill tone={STATUS_TONE[m.status] ?? "neutral"}>{STATUS_LABEL[m.status] ?? sentence(m.status)}</StatusPill>,
              ...(canReadUsage ? [
                usage.loading ? "…" : usage.error
                  ? <span className="text-muted-foreground" title="Usage could not be loaded">—</span>
                  : <Num value={memberSpend.get(m.userId) ?? "0"} kind="money" />,
              ] : []),
              ...(canReadBalances ? [
                balances.loading ? "…" : <AllowanceCell balance={balance} />,
              ] : []),
              formatDate(m.joinedAt),
            ];
          })}
        />
      </AsyncState>

      {editing ? (
        <DetailDrawer
          title={editingName}
          subtitle={editing.name ? editing.email : undefined}
          badge={<StatusPill tone={STATUS_TONE[editing.status] ?? "neutral"}>{STATUS_LABEL[editing.status] ?? sentence(editing.status)}</StatusPill>}
          onClose={() => { if (!editBusy) setEditing(null); }}
          footer={canWrite ? (
            <>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)} disabled={editBusy}>Cancel</Button>
              <Button type="button" onClick={() => void saveMember()} disabled={editingIsOwner || editBusy || !editDirty}><Save />{editBusy ? "Saving…" : "Save member"}</Button>
            </>
          ) : undefined}
        >
          <DefinitionList
            items={[
              { term: "Added through", detail: SOURCE_LABEL[editing.source] ?? sentence(String(editing.source ?? "manual")) },
              { term: "Joined", detail: formatDate(editing.joinedAt) },
              ...(canReadUsage && !usage.loading && !usage.error ? [{ term: "Month-to-date spend (UTC)", detail: formatMoneyWithCents(memberSpend.get(editing.userId) ?? "0") }] : []),
              ...(canReadBalances && editingBalance ? [{
                term: "Allowance",
                detail: editingBalance.effectiveLimitMicros === null
                  ? `${formatMoney(editingBalance.usedMicros)} used · Unlimited`
                  : <Meter value={Number(editingBalance.usedMicros)} max={Number(editingBalance.effectiveLimitMicros)} label={`${formatMoney(editingBalance.usedMicros)} used`} detail={`of ${formatMoney(editingBalance.effectiveLimitMicros)}`} />,
              }] : []),
            ]}
          />
          <div className="flex flex-wrap gap-2">
            {canReadUsage ? (
              <Button variant="secondary" onClick={() => void navigate({ to: "/admin/$tab", params: { tab: "analytics" }, search: { view: "people", memberId: editing.userId } })}>
                <LineChart />Usage
              </Button>
            ) : null}
            {permissions.includes("org:admin") && permissions.includes("skills:read") ? (
              <Button variant="secondary" onClick={() => { setSkillsMember({ userId: editing.userId, name: editingName }); setEditing(null); }}><Sparkles />Skills</Button>
            ) : null}
            {permissions.includes("members:read") ? (
              <Button variant="secondary" onClick={() => { setDevicesMember({ userId: editing.userId, name: editingName }); setEditing(null); }}><MonitorSmartphone />Phones</Button>
            ) : null}
            {(actorRole === "owner" || actorRole === "admin") && editing.userId !== userId ? (
              <Button
                variant="secondary"
                onClick={() => {
                  if (!userId) return;
                  try {
                    startSupportView({ tenantId, userId: editing.userId, name: editing.name ?? "", email: editing.email ?? "" }, userId);
                    void navigate({ to: "/" });
                  } catch (cause) {
                    toast.error(cause instanceof Error ? cause.message : "Support view could not be started.");
                  }
                }}
              >
                <Eye />View as user
              </Button>
            ) : null}
          </div>
          {editingIsOwner ? (
            <InlineNotice tone="info">The organization owner cannot be demoted, blocked, or offboarded here.</InlineNotice>
          ) : !canWrite ? (
            <InlineNotice tone="info">You can view members. Changing role, access, or departments needs the “Members: write” permission.</InlineNotice>
          ) : null}
          <DrawerSection title="Access" description="Blocked and offboarded members cannot sign in or start requests. Their audit and usage history is kept.">
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <label className={fieldLabel}>
                Role
                <FormSelect ariaLabel="Role" value={editRole} onChange={setEditRole} disabled={!canWrite || roleLocked} options={editingIsOwner ? [{ value: "owner", label: "Owner" }] : [{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }]} />
                {!editingIsOwner && actorRole !== "owner" ? <small className={fieldHint}>Only the organization owner can change roles.</small> : null}
              </label>
              <label className={fieldLabel}>
                Account access
                <FormSelect ariaLabel="Account access" value={editStatus} onChange={setEditStatus} disabled={!canWrite || statusLocked} options={memberAccessStatusOptions(editing.status)} />
                {!editingIsOwner && statusLocked ? <small className={fieldHint}>Only the owner can change an administrator’s access.</small> : null}
              </label>
            </div>
          </DrawerSection>
          <DrawerSection title="Departments" description="Model rules and allowance defaults follow the primary department.">
            <fieldset className="m-0 min-w-0 border-0 p-0" disabled={!canWrite || editingIsOwner}>
              <legend className="sr-only">Departments</legend>
              {departments.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">No departments exist yet. Create one under People → Departments.</p>
              ) : (
                <div className="grid gap-x-4 sm:grid-cols-2">
                  {departments.data.map((department: any) => (
                    <label key={department.id} className="flex min-w-0 cursor-pointer items-center gap-2.5 py-1.5 text-md text-foreground">
                      <Checkbox checked={editDepartments.has(department.id)} onCheckedChange={() => toggleDepartment(department.id)} />
                      <span className="truncate">{department.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <label className={fieldLabel}>
              Primary department
              <FormSelect ariaLabel="Primary department" value={editPrimaryDepartment} onChange={setEditPrimaryDepartment} disabled={!canWrite || editingIsOwner} options={[{ value: "none", label: "No primary department" }, ...departments.data.filter((department: any) => editDepartments.has(department.id)).map((department: any) => ({ value: department.id, label: department.name }))]} />
            </label>
          </DrawerSection>
          {editError ? <InlineNotice tone="danger">{editError}</InlineNotice> : null}
        </DetailDrawer>
      ) : null}

      <ManagementDialog
        open={addMode === "manual"}
        onOpenChange={(next) => { if (!next && !manualBusy) setAddMode(null); }}
        title={googleOnly ? "Add Google administrator" : "Add member"}
        description={googleOnly ? `Reserve the administrator role for a trusted @${authConfiguration.data.ssoProviders[0]?.domain ?? "Workspace"} account. Access activates on their first Google sign-in.` : "Create a Berry account with a temporary password. No invitation email is sent, so share the password with the member yourself."}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAddMode(null)} disabled={manualBusy}>Cancel</Button>
            <Button type="submit" form="invite-member-form" disabled={manualBusy}>
              {manualBusy ? "Saving…" : googleOnly ? "Add administrator" : "Create account"}
            </Button>
          </>
        }
      >
        <form id="invite-member-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          {!googleOnly ? <label className={fieldLabel}>
            Name
            <Input name="name" autoFocus required />
          </label> : null}
          <label className={fieldLabel}>
            Email
            <Input name="email" type="email" autoFocus={googleOnly} required />
          </label>
          {!googleOnly ? <label className={fieldLabel}>
            Temporary password
            <Input name="password" type="password" minLength={12} required />
            <small className="text-xs font-normal leading-4">At least 12 characters.</small>
          </label> : null}
          {!googleOnly ? <label className={fieldLabel}>
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
          <label className={fieldLabel}>
            Primary department
            <FormSelect
              name="primaryDepartmentId"
              defaultValue="none"
              options={[{ value: "none", label: "No department" }, ...departments.data.map((department: any) => ({ value: department.id, label: department.name }))]}
            />
          </label>
        </form>
        {manualError ? <div className="mt-3"><InlineNotice tone="danger">{manualError}</InlineNotice></div> : null}
      </ManagementDialog>

      {!googleOnly ? <ManagementDialog
        open={addMode === "bulk"}
        onOpenChange={(next) => { if (!next && !bulkImporting) setAddMode(null); }}
        title="Import members from CSV"
        description="Upload a CSV with name and email columns. Each account is created as a member with no department and a temporary password generated in your browser."
        size="lg"
        footer={
          <>
            {createdAny ? (
              <Button type="button" variant="secondary" onClick={() => void copyCreatedCredentials()}>
                <Copy aria-hidden />
                Copy credentials
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => setAddMode(null)} disabled={bulkImporting}>
              {createdAny ? "Done" : "Cancel"}
            </Button>
            <Button type="button" onClick={() => void importBulkMembers()} disabled={bulkImporting || readyCount === 0}>
              <FileUp aria-hidden />
              {bulkImporting ? "Importing…" : readyCount ? `Import ${readyCount} ${readyCount === 1 ? "member" : "members"}` : "Import members"}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 transition-colors hover:bg-[var(--berry-hover)] focus-within:ring-2 focus-within:ring-ring">
            <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <b className="truncate text-md font-medium text-foreground">{bulkFileName || "Choose a CSV file"}</b>
              <small className="text-xs text-muted-foreground">Required headers: name, email. Extra columns are ignored.</small>
            </span>
            <input className="sr-only" type="file" accept=".csv,text/csv" onChange={(event) => void readBulkFile(event)} disabled={bulkImporting} />
          </label>
          {bulkError ? <InlineNotice tone="danger">{bulkError}</InlineNotice> : null}
          {bulkNotice ? <InlineNotice tone={failedRows ? "warning" : "good"}>{bulkNotice}</InlineNotice> : null}
          {bulkRows.length ? (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="tabular-nums">{readyCount}</span> ready · <span className="tabular-nums">{failedRows}</span> {failedRows === 1 ? "needs" : "need"} attention
              </p>
              <DataTable
                label="Import preview"
                searchable={false}
                initialPageSize={25}
                columns={["Row", "Member", "Temporary password", "Status"]}
                rows={bulkRows.map((row) => [
                  <span data-sort={row.rowNumber} className="tabular-nums text-muted-foreground">{row.rowNumber}</span>,
                  <CellStack primary={row.name || "Missing name"} secondary={row.email || "Missing email"} />,
                  <span className="font-mono text-xs">{row.password || "—"}</span>,
                  row.status === "created" ? <StatusPill tone="good">Created</StatusPill>
                    : row.status === "creating" ? <StatusPill tone="info">Creating</StatusPill>
                    : row.status === "ready" ? <StatusPill tone="neutral">Ready</StatusPill>
                    : <CellStack primary={<StatusPill tone="danger">Failed</StatusPill>} secondary={row.importError} />,
                ])}
              />
            </>
          ) : null}
          <p className="text-xs leading-4 text-muted-foreground">Passwords use the capitalized first name, @, then at least six random digits, and are at least 12 characters long.</p>
        </div>
      </ManagementDialog> : null}

      {skillsMember ? <React.Suspense fallback={<p role="status" className="text-xs text-muted-foreground">Loading member skills…</p>}><MemberSkillsDialog client={client} tenantId={tenantId} member={skillsMember} canWrite={permissions.includes("skills:write")} onClose={() => setSkillsMember(null)} /></React.Suspense> : null}
      {devicesMember ? <React.Suspense fallback={<p role="status" className="text-xs text-muted-foreground">Loading member phones…</p>}><MemberDevicesDialog client={client} tenantId={tenantId} member={devicesMember} canRevoke={permissions.includes("members:write")} onClose={() => setDevicesMember(null)} /></React.Suspense> : null}
    </ManagementPage>
  );
}

function AllowanceCell({ balance }: { balance: any }) {
  if (!balance) return <span data-sort={-2} className="text-muted-foreground">—</span>;
  if (balance.effectiveLimitMicros === null) {
    return <span data-sort={-1} className="tabular-nums" title={`${formatMoney(balance.usedMicros)} used`}>Unlimited</span>;
  }
  const used = Number(balance.usedMicros);
  const limit = Number(balance.effectiveLimitMicros);
  return (
    <span data-sort={limit > 0 ? used / limit : 0} className="inline-block w-40 text-left">
      <Meter value={used} max={limit} label={formatMoney(balance.usedMicros)} detail={`of ${formatMoney(balance.effectiveLimitMicros)}`} />
    </span>
  );
}

type BulkMemberRow = MemberImportRow & {
  status: "ready" | "creating" | "created" | "failed";
  importError: string | undefined;
};

function sentence(value: string) {
  const text = String(value ?? "").replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
