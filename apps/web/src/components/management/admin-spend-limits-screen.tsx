import * as React from "react";
import { CalendarClock, Plus } from "lucide-react";
import { actionErrorMessage } from "@/lib/action-error";
import {
  AsyncState, Button, CellStack, DataTable, DefinitionList, DetailDrawer, FormSelect, InlineNotice, Input,
  ManagementDialog, ManagementPage, Meter, MetricGrid, Num, Section, SettingList, SettingRow, StatusPill,
  SuccessMessage, formatCompactMoney, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { TimezoneSelect } from "./timezone-select";

const DAY_MS = 86_400_000;

type BalanceView = {
  item: any;
  name: string;
  spentMicros: number;
  limitMicros: number | null;
  ratio: number | null;
  over: boolean;
  near: boolean;
};

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
  const [formError, setFormError] = React.useState("");
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [topUpOpen, setTopUpOpen] = React.useState(false);
  const [cycleOpen, setCycleOpen] = React.useState(false);
  const [cycleTimezone, setCycleTimezone] = React.useState("UTC");
  const [memberBaseOpen, setMemberBaseOpen] = React.useState(false);
  const [defaultOpen, setDefaultOpen] = React.useState(false);
  const [scopeType, setScopeType] = React.useState<"department" | "org">("department");
  const [detailUserId, setDetailUserId] = React.useState<string | null>(null);
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

  // People closest to (or past) their limit come first; members without a limit sink to the bottom.
  const views: BalanceView[] = balances
    .map((item: any): BalanceView => {
      const spentMicros = Number(BigInt(item.usedMicros) + BigInt(item.reservedMicros));
      const limitMicros = item.effectiveLimitMicros === null ? null : Number(item.effectiveLimitMicros);
      const ratio = limitMicros === null ? null : limitMicros > 0 ? spentMicros / limitMicros : 1;
      const over = item.status === "blocked" || (ratio !== null && ratio >= 1);
      return {
        item,
        name: item.userName || item.userEmail || memberNames.get(item.userId) || "Unknown member",
        spentMicros,
        limitMicros,
        ratio,
        over,
        near: !over && (item.status === "warning" || (ratio !== null && ratio >= 0.8)),
      };
    })
    .sort((left: BalanceView, right: BalanceView) => (right.ratio ?? -1) - (left.ratio ?? -1) || right.spentMicros - left.spentMicros);
  const overCount = views.filter((view) => view.over).length;
  const nearCount = views.filter((view) => view.near).length;
  const limited = views.filter((view) => view.limitMicros !== null);
  const totalSpent = views.reduce((sum, view) => sum + view.spentMicros, 0);
  const limitedSpent = limited.reduce((sum, view) => sum + view.spentMicros, 0);
  const totalGranted = limited.reduce((sum, view) => sum + (view.limitMicros ?? 0), 0);
  const cycleStart = balances[0]?.cycleStart ?? null;
  const cycleEnd = balances[0]?.cycleEnd ?? null;
  const daysToReset = cycleEnd ? Math.max(0, Math.ceil((new Date(cycleEnd).getTime() - Date.now()) / DAY_MS)) : null;
  const detail = detailUserId ? views.find((view) => view.item.userId === detailUserId) ?? null : null;
  const detailAdjustments = detail ? adjustments.filter((item: any) => item.userId === detail.item.userId) : [];

  const attempt = async (action: () => Promise<void>) => {
    setFormError("");
    try {
      await action();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not save this change. Nothing was applied; try again."));
    }
  };

  const openTopUp = (userId: string) => {
    setFormError("");
    setTopUpUserId(userId);
    setTopUpOpen(true);
  };

  const openMemberBase = (balance: any) => {
    setFormError("");
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
    setFormError("");
    setDefaultScope(scope);
    setDefaultDepartmentId(departmentId);
    setDefaultMode(scope === "department" && !profile ? "inherit" : "custom");
    setDefaultAmount(profile?.hardLimitMicros ? String(Number(profile.hardLimitMicros) / 1e6) : String(Number(organizationBaseMicros ?? 20_000_000) / 1e6));
    setDefaultOpen(true);
  };

  const submitAllowance = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scopeId = scopeType === "org" ? tenantId : String(form.get("scopeId"));
    return attempt(async () => {
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
      setSuccess("Spending cap saved. New requests are checked against it immediately.");
      r.retry();
    });
  };

  const submitTopUp = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return attempt(async () => {
      await client?.createAllowanceAdjustment(tenantId, {
        userId: topUpUserId,
        amountMicros: String(Math.round(Number(form.get("amount")) * 1e6)),
        reason: String(form.get("reason")),
        idempotencyKey: crypto.randomUUID(),
      });
      setTopUpOpen(false);
      setSuccess("Top-up added to this member’s limit for the current cycle.");
      r.retry();
    });
  };

  const submitMemberBase = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountMicros = memberBaseMode === "inherit"
      ? null
      : String(Math.round(Number(memberBaseAmount) * 1e6));
    return attempt(async () => {
      await client?.updateMemberAllowanceBase(tenantId, memberBaseUserId, { amountMicros });
      setMemberBaseOpen(false);
      setSuccess(memberBaseMode === "inherit"
        ? "Member now follows the department or organization default."
        : "Member allowance updated for this and future cycles.");
      r.retry();
    });
  };

  const submitDefault = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const departmentId = defaultScope === "department" ? defaultDepartmentId : null;
    const existingAssignment = defaultScope === "organization"
      ? organizationDefault
      : departmentDefaults.get(defaultDepartmentId);
    return attempt(async () => {
      if (defaultScope === "department" && defaultMode === "inherit") {
        await client?.upsertAllowanceDefault(tenantId, {
          profileId: null,
          role: null,
          departmentId,
          priority: 100,
        });
        setDefaultOpen(false);
        setSuccess("Department now follows the organization default.");
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
      setSuccess(`${defaultScope === "organization" ? "Organization" : "Department"} default updated.`);
      r.retry();
    });
  };

  const submitCycle = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return attempt(async () => {
      await client?.updateAllowanceCycle(tenantId, {
        timezone: cycleTimezone,
        anchorDay: Number(form.get("anchorDay")),
      });
      setCycleOpen(false);
      setSuccess("Cycle updated. Balances and limit checks use it from now on.");
      r.retry();
    });
  };

  const targetOptions = departments.map((department: any) => ({ value: department.id, label: department.name }));
  const error = formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null;

  return (
    <ManagementPage width="wide"
      title="Allowances"
      description="What each member can spend per cycle, who is close to their limit, and the defaults they inherit."
      eyebrow="Usage & billing"
    >
      {success ? <SuccessMessage>{success}</SuccessMessage> : null}
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        {views.length ? (
          <MetricGrid items={[
            {
              label: "Over limit",
              value: formatNumber(overCount),
              hint: `of ${formatNumber(limited.length)} members with a limit`,
              ...(overCount ? { status: "danger" as const } : {}),
            },
            {
              label: "Above 80%",
              value: formatNumber(nearCount),
              hint: "Likely to hit their limit this cycle",
              ...(nearCount ? { status: "warning" as const } : {}),
            },
            {
              label: "Used this cycle",
              value: formatCompactMoney(totalSpent),
              exactValue: formatMoney(totalSpent),
              hint: totalGranted > 0
                ? `${formatPercent(limitedSpent / totalGranted)} of ${formatCompactMoney(totalGranted)} granted`
                : "No member has a limit",
            },
            {
              label: "Cycle resets",
              value: daysToReset === null ? "—" : daysToReset === 0 ? "Today" : `In ${daysToReset} ${daysToReset === 1 ? "day" : "days"}`,
              hint: cycleEnd ? `${formatDate(cycleEnd)}${cycle ? ` · ${cycle.timezone}` : ""}` : "No cycle data yet",
            },
          ]} />
        ) : null}
        {overCount ? (
          <InlineNotice tone="danger" title={`${formatNumber(overCount)} ${overCount === 1 ? "member has" : "members have"} reached their limit`}>
            Their requests are blocked until the cycle resets. Open a member below to top up or raise their monthly allowance.
          </InlineNotice>
        ) : null}
        <Section
          title="Member balances"
          description="Sorted by share of limit used. Select a member to top up this cycle or change their monthly allowance."
          flush
        >
          <DataTable
            label="Member allowance balances"
            columns={["Member", "Used", "Limit", "Available", "Top-ups", "Source", "State"]}
            rows={views.map((view) => [
              <CellStack primary={view.name} secondary={view.item.userEmail ?? shortId(view.item.userId)} />,
              view.limitMicros === null ? (
                <Num value={view.spentMicros} kind="money" />
              ) : (
                <span className="block w-40" data-sort={view.ratio ?? 0}>
                  <Meter value={view.spentMicros} max={view.limitMicros} label={formatMoney(view.spentMicros)} detail={formatPercent(view.ratio)} />
                </span>
              ),
              view.limitMicros === null ? <span data-sort={Number.MAX_SAFE_INTEGER}>No limit</span> : <Num value={view.limitMicros} kind="money" />,
              view.item.availableMicros === null ? <span data-sort={Number.MAX_SAFE_INTEGER}>No limit</span> : <Num value={view.item.availableMicros} kind="money" />,
              <Num value={view.item.adjustmentMicros} kind="money" />,
              sourceLabel(view.item.baseSource),
              <StatusPill tone={view.over ? "danger" : view.near ? "warning" : view.limitMicros === null ? "neutral" : "good"}>
                {view.over ? "Over limit" : view.near ? "Near limit" : view.limitMicros === null ? "No limit" : "Within limit"}
              </StatusPill>,
            ])}
            onRowSelect={(index) => setDetailUserId(views[index]?.item.userId ?? null)}
            activeRow={detail ? views.indexOf(detail) : null}
            rowLabel={(index) => `${views[index]?.name ?? "Member"} allowance`}
          />
        </Section>
        <Section
          title="Monthly defaults"
          description="Every member gets the organization amount. A department amount replaces it for that department, and a member allowance replaces both."
          flush
        >
          <DataTable
            label="Allowance defaults"
            columns={["Applies to", "Monthly allowance per member", "Source"]}
            rows={[
              [
                <CellStack primary="Everyone" secondary="Organization default" />,
                organizationBaseMicros === null ? "Not set" : <Num value={organizationBaseMicros} kind="money" />,
                <StatusPill tone={organizationBaseMicros === null ? "warning" : "neutral"}>{organizationBaseMicros === null ? "Not set" : "Organization"}</StatusPill>,
              ],
              ...departments.map((department: any) => {
                const assignment = departmentDefaults.get(department.id);
                const profile = assignment?.profileId ? profilesById.get(assignment.profileId) : null;
                const amount = profile?.hardLimitMicros ?? organizationBaseMicros;
                return [
                  <CellStack primary={department.name} secondary="Department" />,
                  amount === null ? "Not set" : <Num value={amount} kind="money" />,
                  <StatusPill tone={profile ? "info" : "neutral"}>{profile ? "Department amount" : "Inherits organization"}</StatusPill>,
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
          <SettingList>
            <SettingRow
              icon={CalendarClock}
              title="Cycle"
              description={cycle
                ? `Resets on day ${cycle.anchorDay} of each month, ${cycle.timezone} time.${cycleStart && cycleEnd ? ` Current cycle: ${formatDate(cycleStart)} – ${formatDate(cycleEnd)}.` : ""}`
                : "No cycle is configured yet."}
            >
              {canWrite ? (
                <Button variant="secondary" onClick={() => { setFormError(""); setCycleTimezone(cycle?.timezone ?? "UTC"); setCycleOpen(true); }}>
                  Change cycle
                </Button>
              ) : null}
            </SettingRow>
          </SettingList>
        </Section>
        <Section
          title="Group spending caps"
          description="A ceiling on the combined spend of a department or the whole organization. It applies on top of each member’s own allowance."
          actions={canWrite ? (
            <Button variant="secondary" onClick={() => { setFormError(""); setAssignOpen(true); }}>
              <Plus />
              Add cap
            </Button>
          ) : null}
          flush
        >
          <DataTable
            label="Spending caps"
            columns={["Applies to", "Period", "Warn at", "Block at", "Requests", "Tokens", "Updated"]}
            rows={limits.map((item: any) => [
              <CellStack
                primary={item.scopeType === "user"
                  ? memberNames.get(item.scopeId) ?? "Unknown member"
                  : item.scopeType === "department"
                    ? departmentNames.get(item.scopeId) ?? "Unknown department"
                    : "Whole organization"}
                secondary={item.scopeType === "user" ? "Member" : item.scopeType === "department" ? "Department" : "Organization"}
              />,
              item.period === "day" ? "Daily" : "Monthly",
              <Num value={item.softLimitMicros} kind="money" />,
              <Num value={item.hardLimitMicros} kind="money" />,
              item.requestLimit == null ? "—" : <Num value={item.requestLimit} />,
              item.tokenLimit == null ? "—" : <Num value={item.tokenLimit} />,
              formatDate(item.updatedAt),
            ])}
          />
        </Section>
        <Section title="Top-ups this cycle" description="One-time additions to a member’s limit. Each records who added it and why, and cannot be edited." flush>
          <DataTable
            label="Top-ups"
            columns={["Member", "Amount", "Reason", "Added by", "Added"]}
            rows={[...adjustments]
              .sort((left: any, right: any) => String(right.createdAt).localeCompare(String(left.createdAt)))
              .map((item: any) => [
                memberNames.get(item.userId) ?? "Unknown member",
                <Num value={item.amountMicros} kind="money" />,
                item.reason,
                memberNames.get(item.createdBy) ?? "Unknown member",
                formatDateTime(item.createdAt),
              ])}
          />
        </Section>
      </AsyncState>

      {detail ? (
        <DetailDrawer
          title={detail.name}
          subtitle={detail.item.userEmail ?? shortId(detail.item.userId)}
          badge={<StatusPill tone={detail.over ? "danger" : detail.near ? "warning" : detail.limitMicros === null ? "neutral" : "good"}>{detail.over ? "Over limit" : detail.near ? "Near limit" : detail.limitMicros === null ? "No limit" : "Within limit"}</StatusPill>}
          onClose={() => setDetailUserId(null)}
          footer={canWrite ? (
            <>
              <Button variant="secondary" onClick={() => openMemberBase(detail.item)}>Change monthly allowance</Button>
              <Button onClick={() => openTopUp(detail.item.userId)}>
                <Plus />
                Top up
              </Button>
            </>
          ) : undefined}
        >
          {detail.limitMicros !== null ? (
            <Meter
              value={detail.spentMicros}
              max={detail.limitMicros}
              label={`${formatMoney(detail.spentMicros)} used`}
              detail={`of ${formatMoney(detail.limitMicros)}`}
            />
          ) : null}
          <DefinitionList
            items={[
              { term: "Monthly allowance", detail: detail.item.baseLimitMicros === null ? "No limit" : formatMoney(detail.item.baseLimitMicros) },
              { term: "Comes from", detail: sourceLabel(detail.item.baseSource) },
              { term: "Top-ups this cycle", detail: formatMoney(detail.item.adjustmentMicros) },
              { term: "Limit this cycle", detail: detail.limitMicros === null ? "No limit" : formatMoney(detail.limitMicros) },
              { term: "Spent", detail: formatMoney(detail.item.usedMicros) },
              { term: "Held for running requests", detail: formatMoney(detail.item.reservedMicros) },
              { term: "Available", detail: detail.item.availableMicros === null ? "No limit" : formatMoney(detail.item.availableMicros) },
              { term: "Cycle", detail: `${formatDate(detail.item.cycleStart)} – ${formatDate(detail.item.cycleEnd)}` },
            ]}
          />
          {detailAdjustments.length ? (
            <DefinitionList
              items={detailAdjustments.map((item: any) => ({
                term: `${formatMoney(item.amountMicros)} · ${formatDate(item.createdAt)}`,
                detail: `${item.reason} — ${memberNames.get(item.createdBy) ?? "Unknown member"}`,
              }))}
            />
          ) : null}
        </DetailDrawer>
      ) : null}

      <ManagementDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title="Add spending cap"
        description="Cap the combined spend of a department or the whole organization. Members keep their own allowances underneath it."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Button><Button type="submit" form="assign-allowance-form">Save cap</Button></>}
      >
        <form id="assign-allowance-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submitAllowance}>
          <Field label="Applies to"><FormSelect ariaLabel="Applies to" value={scopeType} onChange={(value) => setScopeType(value as typeof scopeType)} options={[{ value: "department", label: "One department" }, { value: "org", label: "Whole organization" }]} /></Field>
          {scopeType !== "org"
            ? <Field label="Department"><FormSelect name="scopeId" ariaLabel="Department" options={targetOptions} placeholder="Select department" required /></Field>
            : <p className="self-end pb-1.5 text-xs leading-5 text-muted-foreground">Counts all spend in the organization.</p>}
          <Field label="Period"><FormSelect name="period" ariaLabel="Period" defaultValue="month" options={[{ value: "month", label: "Each cycle (monthly)" }, { value: "day", label: "Each day" }]} /></Field>
          <span className="hidden sm:block" />
          <Field label="Warn at (USD)" hint="Sends a warning; requests continue."><Input name="soft" type="number" min="0" step=".01" required /></Field>
          <Field label="Block at (USD)" hint="New requests are refused above this."><Input name="hard" type="number" min="0" step=".01" required /></Field>
          <Field label="Request limit" hint="Optional."><Input name="requests" type="number" min="0" /></Field>
          <Field label="Token limit" hint="Optional."><Input name="tokens" type="number" min="0" /></Field>
          <Field label="Sandbox minutes" hint="Optional."><Input name="sandbox" type="number" min="0" step=".1" /></Field>
          <Field label="Reason" hint="Recorded in the audit log." className="sm:col-span-2"><Input name="reason" minLength={3} required /></Field>
          {error ? <div className="sm:col-span-2">{error}</div> : null}
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={defaultOpen}
        onOpenChange={setDefaultOpen}
        title={defaultScope === "organization" ? "Organization default" : `${departmentNames.get(defaultDepartmentId) ?? "Department"} allowance`}
        description={defaultScope === "organization"
          ? "The monthly amount every member gets unless their department or their own allowance says otherwise."
          : "Use the organization default for this department, or give its members a different monthly amount."}
        footer={<><Button type="button" variant="secondary" onClick={() => setDefaultOpen(false)}>Cancel</Button><Button type="submit" form="default-allowance-form">Save default</Button></>}
      >
        <form id="default-allowance-form" className="grid gap-3" onSubmit={submitDefault}>
          {defaultScope === "department" ? (
            <Field label="Allowance"><FormSelect ariaLabel="Allowance" value={defaultMode} onChange={(value) => setDefaultMode(value as typeof defaultMode)} options={[{ value: "inherit", label: `Organization default (${organizationBaseMicros === null ? "not set" : formatMoney(organizationBaseMicros)})` }, { value: "custom", label: "Department amount" }]} /></Field>
          ) : null}
          {defaultScope === "organization" || defaultMode === "custom"
            ? <Field label="Monthly allowance per member (USD)"><Input value={defaultAmount} onChange={(event) => setDefaultAmount(event.target.value)} type="number" min="0.01" step=".01" autoFocus required /></Field>
            : <p className="text-xs leading-5 text-muted-foreground">Members of this department get the organization default. Members with their own allowance keep it.</p>}
          {error}
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={memberBaseOpen}
        onOpenChange={setMemberBaseOpen}
        title="Change monthly allowance"
        description={`Set the recurring monthly amount for ${memberNames.get(memberBaseUserId) ?? "this member"}.`}
        footer={<><Button type="button" variant="secondary" onClick={() => setMemberBaseOpen(false)}>Cancel</Button><Button type="submit" form="member-base-form">Save allowance</Button></>}
      >
        <form id="member-base-form" className="grid gap-3" onSubmit={submitMemberBase}>
          <Field label="Allowance"><FormSelect ariaLabel="Allowance" value={memberBaseMode} onChange={(value) => setMemberBaseMode(value as typeof memberBaseMode)} options={[{ value: "inherit", label: "Department or organization default" }, { value: "custom", label: "Amount for this member" }]} /></Field>
          {memberBaseMode === "custom"
            ? <Field label="Monthly allowance (USD)"><Input value={memberBaseAmount} onChange={(event) => setMemberBaseAmount(event.target.value)} type="number" min="0.01" step=".01" autoFocus required /></Field>
            : <p className="text-xs leading-5 text-muted-foreground">The department amount applies if one is set; otherwise the organization default.</p>}
          {error}
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={topUpOpen}
        onOpenChange={setTopUpOpen}
        title="Top up member"
        description={`Add a one-time amount to ${memberNames.get(topUpUserId) ?? "this member"}’s limit for the current cycle. Group spending caps still apply.`}
        footer={<><Button type="button" variant="secondary" onClick={() => setTopUpOpen(false)}>Cancel</Button><Button type="submit" form="top-up-allowance-form">Add top-up</Button></>}
      >
        <form id="top-up-allowance-form" className="grid gap-3" onSubmit={submitTopUp}>
          <Field label="Amount (USD)"><Input name="amount" type="number" min="0.01" step=".01" autoFocus required /></Field>
          <Field label="Reason" hint="Recorded with the top-up and in the audit log."><Input name="reason" minLength={3} maxLength={500} required /></Field>
          {error}
        </form>
      </ManagementDialog>

      <ManagementDialog
        open={cycleOpen}
        onOpenChange={setCycleOpen}
        title="Change cycle"
        description="Allowances reset once a month on this day, at midnight in this timezone."
        footer={<><Button type="button" variant="secondary" onClick={() => setCycleOpen(false)}>Cancel</Button><Button type="submit" form="allowance-cycle-form">Save cycle</Button></>}
      >
        <form id="allowance-cycle-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submitCycle}>
          <Field label="Timezone"><TimezoneSelect value={cycleTimezone} onChange={setCycleTimezone} /></Field>
          <Field label="Reset day" hint="1–28, so every month has it."><Input name="anchorDay" type="number" min="1" max="28" defaultValue={cycle?.anchorDay ?? 1} required /></Field>
          {error ? <div className="sm:col-span-2">{error}</div> : null}
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`grid content-start gap-1.5 text-xs font-medium text-muted-foreground ${className ?? ""}`}>
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal leading-4">{hint}</span> : null}
    </label>
  );
}

function sourceLabel(source: string) {
  return source === "member"
    ? "Member allowance"
    : source === "department"
      ? "Department default"
      : source === "organization"
        ? "Organization default"
        : "No limit";
}

function shortId(id: string) {
  return <span className="font-mono">{id.length > 12 ? `${id.slice(0, 8)}…` : id}</span>;
}
