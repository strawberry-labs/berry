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
export function AdminSpendLimitsScreen({ client, tenantId, permissions }: ManagementScreenProps) {
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

function human(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
