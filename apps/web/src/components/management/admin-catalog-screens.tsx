import * as React from "react";
import { Check, Copy, Download, Plus, Save } from "lucide-react";
import { OrgPermissionSchema, type OrgPermission } from "@berry/shared";
import {
  AsyncState, Button, Checkbox, DataTable, DefinitionList, DetailDrawer, FilterSelect, FormSelect, Input, ManagementPage, ManagementSwitch, MetricGrid,
  PermissionDenied, SearchInput, Section, StatusPill, SuccessMessage, TabBar, Toolbar,
  formatDate, formatDateTime, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

/* ------------------------------------------------------------------ helpers */
const ALL_PERMISSIONS = OrgPermissionSchema.options as OrgPermission[];
const PERMISSION_DOMAINS: Array<{ id: string; label: string }> = [
  { id: "org", label: "Organization" }, { id: "org_settings", label: "Organization settings" },
  { id: "members", label: "People" }, { id: "departments", label: "Departments" },
  { id: "rbac", label: "Roles" }, { id: "acl", label: "Resource access" },
  { id: "models", label: "Models" }, { id: "skills", label: "Skills" }, { id: "mcp", label: "MCP" },
  { id: "feature_flags", label: "Feature access" }, { id: "guardrails", label: "Execution & network" },
  { id: "usage", label: "Usage" }, { id: "budgets", label: "Budgets" }, { id: "billing", label: "Billing" },
  { id: "reports", label: "Reports" }, { id: "alerts", label: "Alerts" },
  { id: "sso", label: "SSO & SCIM" }, { id: "policy", label: "Managed policy" },
  { id: "auth_policy", label: "Authentication" }, { id: "data_policy", label: "Data governance" },
  { id: "service_accounts", label: "Service accounts" }, { id: "audit", label: "Audit" },
];
function humanize(value: string) { return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function domainOf(permission: string) { return permission.split(":")[0]; }
function actionOf(permission: string) { return permission.split(":")[1] ?? "read"; }
function copyText(value: string) { void navigator.clipboard?.writeText(value).catch(() => {}); }

/* -------------------------------------------------------------------- roles */
function RolesScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("rbac:write");
  const r = useResource(`roles:${tenantId}`, async () => client ? client.listRolePermissions(tenantId) : config.rolePermissions.filter((x) => x.tenantId === tenantId), [] as any[]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<Set<OrgPermission> | null>(null);
  const [message, setMessage] = React.useState("");
  const roles = r.data.filter((role: any) => role.role.toLowerCase().includes(query.toLowerCase()));
  const active = r.data.find((role: any) => role.role === selected) ?? null;
  const isSystem = active?.source === "system";
  React.useEffect(() => { setDraft(active ? new Set(active.permissions) : null); setMessage(""); }, [selected, r.data]);
  const dirty = Boolean(active && draft) && (draft!.size !== active!.permissions.length || active!.permissions.some((p: OrgPermission) => !draft!.has(p)));
  const toggle = (permission: OrgPermission) => { if (!draft || isSystem || !canWrite) return; const next = new Set(draft); next.has(permission) ? next.delete(permission) : next.add(permission); setDraft(next); };
  const save = async () => {
    if (!active || !draft) return;
    const nextPermissions = [...draft];
    await client?.updateRolePermissions(tenantId, active.role, { permissions: nextPermissions });
    r.setData(r.data.map((role: any) => role.role === active.role ? { ...role, permissions: nextPermissions, updatedAt: new Date().toISOString() } : role));
    setMessage("Role permissions saved and recorded in the audit log.");
  };
  return <ManagementPage title="Roles & permissions" description="Define what each role can read and manage. System roles are locked; clone them to customize." eyebrow="Access">
    <div className="mgmt-split">
      <div className="mgmt-split-list">
        <Toolbar><SearchInput label="Search roles" value={query} onChange={setQuery} placeholder="Search roles" /></Toolbar>
        <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={roles.length === 0}>
          <ul className="mgmt-record-list" aria-label="Roles">
            {roles.map((role: any) => <li key={role.role}><Button type="button" aria-current={selected === role.role ? "true" : undefined} onClick={() => setSelected(role.role)}>
              <span className="mgmt-record-title">{humanize(role.role)}</span>
              <span className="mgmt-record-meta"><StatusPill tone={role.source === "system" ? "neutral" : "info"}>{role.source === "system" ? "System" : "Custom"}</StatusPill><small>{role.permissions.length} permissions</small></span>
            </Button></li>)}
          </ul>
        </AsyncState>
      </div>
      <div className="mgmt-split-detail">
        {active && draft ? <Section title={humanize(active.role)} description={isSystem ? "System role — permissions are managed by Berry and cannot be changed." : "Toggle the permissions granted to this role."} actions={canWrite && !isSystem ? <Button onClick={save} disabled={!dirty}><Save aria-hidden />Save role</Button> : null}>
          <div className="mgmt-permission-matrix">
            {PERMISSION_DOMAINS.map((domain) => {
              const perms = ALL_PERMISSIONS.filter((p) => domainOf(p) === domain.id);
              if (!perms.length) return null;
              return <fieldset key={domain.id} className="mgmt-permission-group"><legend>{domain.label}</legend>{perms.map((permission) => <label key={permission} className="mgmt-permission-cell"><Checkbox checked={draft.has(permission)} disabled={isSystem || !canWrite} onCheckedChange={() => toggle(permission)} /><span>{humanize(actionOf(permission))}</span><code>{permission}</code></label>)}</fieldset>;
            })}
          </div>
          {message ? <SuccessMessage>{message}</SuccessMessage> : null}
        </Section> : <div className="mgmt-split-empty"><p>Select a role to review or edit its permissions.</p></div>}
      </div>
    </div>
  </ManagementPage>;
}

/* --------------------------------------------------------- resource access */
function ResourceAccessScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("acl:write");
  const r = useResource(`acls:${tenantId}`, async () => client ? client.listResourceAcls(tenantId) : config.resourceAcls.filter((x) => x.tenantId === tenantId), [] as any[]);
  const [query, setQuery] = React.useState("");
  const [resourceType, setResourceType] = React.useState("all");
  const [principalType, setPrincipalType] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const resourceTypes = [...new Set(r.data.map((x: any) => x.resourceType))];
  const rows = r.data.filter((x: any) => `${x.resourceId} ${x.principalId}`.toLowerCase().includes(query.toLowerCase()) && (resourceType === "all" || x.resourceType === resourceType) && (principalType === "all" || x.principalType === principalType));
  const detail = active != null ? rows[active] : null;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = { resourceType: String(form.get("resourceType")), resourceId: String(form.get("resourceId")), principalType: String(form.get("principalType")) as any, principalId: String(form.get("principalId")), allow: String(form.get("allow")).split(",").map((v) => v.trim()).filter(Boolean) as OrgPermission[], deny: String(form.get("deny")).split(",").map((v) => v.trim()).filter(Boolean) as OrgPermission[] };
    const saved = await client?.upsertResourceAcl(tenantId, input);
    r.setData([saved ?? { id: crypto.randomUUID(), tenantId, ...input, updatedAt: new Date().toISOString() }, ...r.data]);
    setAdding(false); setMessage("Access rule saved and recorded in the audit log.");
  };
  return <ManagementPage title="Resource access" description="Inspect and override sharing for workspaces, agents, prompts, skills, and conversations." eyebrow="Access" actions={canWrite ? <Button onClick={() => setAdding((v) => !v)}><Plus aria-hidden />Add rule</Button> : null}>
    <Toolbar>
      <SearchInput label="Search resources" value={query} onChange={setQuery} placeholder="Search resource or principal" />
      <FilterSelect label="Resource type" value={resourceType} onChange={setResourceType} options={[{ value: "all", label: "All" }, ...resourceTypes.map((t) => ({ value: String(t), label: humanize(String(t)) }))]} />
      <FilterSelect label="Principal" value={principalType} onChange={setPrincipalType} options={[{ value: "all", label: "All" }, { value: "user", label: "User" }, { value: "role", label: "Role" }, { value: "department", label: "Department" }]} />
    </Toolbar>
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    {adding ? <form className="mgmt-inline-form" onSubmit={submit}>
      <label>Resource type<Input name="resourceType" placeholder="workspace" required /></label>
      <label>Resource ID<Input name="resourceId" required /></label>
      <label>Principal type<FormSelect name="principalType" defaultValue="user" options={[{ value: "user", label: "User" }, { value: "role", label: "Role" }, { value: "department", label: "Department" }]} /></label>
      <label>Principal ID<Input name="principalId" required /></label>
      <label>Allow (comma-separated keys)<Input name="allow" placeholder="acl:read" /></label>
      <label>Deny (comma-separated keys)<Input name="deny" /></label>
      <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
      <Button><Save aria-hidden />Save rule</Button>
    </form> : null}
    <div className={detail ? "mgmt-with-drawer" : undefined}>
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={rows.length === 0}>
        <DataTable label="Resource access rules" columns={["Resource", "Principal", "Allowed", "Denied", "Updated"]} onRowSelect={setActive} activeRow={active} rowLabel={(i) => `${rows[i].resourceType} ${rows[i].resourceId}`} rows={rows.map((x: any) => [
          <span className="mgmt-cell-strong"><b>{x.resourceId}</b><small>{humanize(x.resourceType)}</small></span>,
          <span className="mgmt-cell-strong"><b>{x.principalId}</b><small>{humanize(x.principalType)}</small></span>,
          x.allow.length ? <span className="mgmt-badge-row">{x.allow.map((p: string) => <StatusPill key={p} tone="good">{p}</StatusPill>)}</span> : "—",
          x.deny.length ? <span className="mgmt-badge-row">{x.deny.map((p: string) => <StatusPill key={p} tone="danger">{p}</StatusPill>)}</span> : "—",
          formatDate(x.updatedAt),
        ])} />
      </AsyncState>
      {detail ? <DetailDrawer title={detail.resourceId} subtitle={humanize(detail.resourceType)} badge={<StatusPill tone="info">{humanize(detail.principalType)}</StatusPill>} onClose={() => setActive(null)}>
        <DefinitionList items={[
          { term: "Resource", detail: `${humanize(detail.resourceType)} · ${detail.resourceId}` },
          { term: "Principal", detail: `${humanize(detail.principalType)} · ${detail.principalId}` },
          { term: "Updated", detail: formatDateTime(detail.updatedAt) },
        ]} />
        <h3 className="mgmt-drawer-subhead">Effective permissions</h3>
        <div className="mgmt-badge-row">{detail.allow.length ? detail.allow.map((p: string) => <StatusPill key={p} tone="good">{p}</StatusPill>) : <span className="mgmt-muted">No explicit grants</span>}</div>
        {detail.deny.length ? <><h3 className="mgmt-drawer-subhead">Denied</h3><div className="mgmt-badge-row">{detail.deny.map((p: string) => <StatusPill key={p} tone="danger">{p}</StatusPill>)}</div></> : null}
      </DetailDrawer> : null}
    </div>
  </ManagementPage>;
}

/* ------------------------------------------------------------------ models */
function ModelsScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("models:write");
  const r = useResource(`models:${tenantId}`, async () => client ? Promise.all([client.listOrgModels(tenantId, { includeBlocked: true }), client.listOrgModelDefaults(tenantId)]) : [config.modelPolicies as any[], config.modelDefaults as any[]], [[], []] as any);
  const [models, defaults]: [any[], any[]] = r.data;
  const [query, setQuery] = React.useState("");
  const [provider, setProvider] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<any>(null);
  const [message, setMessage] = React.useState("");
  const providers = [...new Set((models ?? []).map((m) => m.providerId))];
  const rows = (models ?? []).filter((m) => `${m.displayName ?? ""} ${m.model}`.toLowerCase().includes(query.toLowerCase()) && (provider === "all" || m.providerId === provider) && (status === "all" || m.status === status));
  const detail = active != null ? rows[active] : null;
  React.useEffect(() => { setDraft(detail ? { ...detail, modeAllow: [...(detail.modeAllow ?? [])] } : null); setMessage(""); }, [active, r.data]);
  const defaultFor = (mode: string) => (defaults ?? []).find((d) => d.mode === mode);
  const isDefault = (m: any, mode: string) => { const d = defaultFor(mode); return d && d.model === m.model && d.providerId === m.providerId; };
  const setMode = (mode: "chat" | "code", on: boolean) => setDraft((d: any) => ({ ...d, modeAllow: on ? [...new Set([...(d.modeAllow ?? []), mode])] : (d.modeAllow ?? []).filter((x: string) => x !== mode) }));
  const save = async () => {
    if (!draft) return;
    await client?.upsertOrgModelPolicy(tenantId, { providerId: draft.providerId, model: draft.model, displayName: draft.displayName ?? null, status: draft.status, enforce: draft.enforce, modeAllow: draft.modeAllow });
    r.setData([(models ?? []).map((m) => m.id === draft.id ? { ...m, ...draft } : m), defaults]);
    setMessage("Model policy saved and recorded in the audit log.");
  };
  const makeDefault = async (mode: "chat" | "code") => {
    if (!draft) return;
    await client?.upsertOrgModelDefault(tenantId, mode, { providerId: draft.providerId, model: draft.model, enforce: draft.enforce });
    const next = [...(defaults ?? []).filter((d) => d.mode !== mode), { tenantId, mode, providerId: draft.providerId, model: draft.model, enforce: draft.enforce, updatedAt: new Date().toISOString() }];
    r.setData([models, next]);
    setMessage(`Set as the ${mode} default and recorded in the audit log.`);
  };
  return <ManagementPage title="Models" description="Control which models are available and set the defaults for Chat and Code." eyebrow="AI controls">
    <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
      <section className="mgmt-metrics" aria-label="Model defaults">
        {(["chat", "code"] as const).map((mode) => { const d = defaultFor(mode); return <article key={mode} data-status={d ? "good" : "warning"}><span>Default for {mode === "chat" ? "Chat" : "Code"}</span><strong>{d ? (d.model) : "Not set"}</strong><small>{d ? `${d.providerId}${d.enforce ? " · Enforced" : ""}` : "Choose a model below"}</small></article>; })}
      </section>
      <Toolbar>
        <SearchInput label="Search models" value={query} onChange={setQuery} placeholder="Search models" />
        <FilterSelect label="Provider" value={provider} onChange={setProvider} options={[{ value: "all", label: "All providers" }, ...providers.map((p) => ({ value: String(p), label: String(p) }))]} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: "all", label: "All status" }, { value: "allowed", label: "Allowed" }, { value: "blocked", label: "Blocked" }]} />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <div className={detail ? "mgmt-with-drawer" : undefined}>
        <AsyncState loading={false} error={null} onRetry={r.retry} empty={rows.length === 0}>
          <DataTable label="Model catalog" columns={["Model", "Provider", "Modes", "Policy", "Default"]} onRowSelect={setActive} activeRow={active} rowLabel={(i) => rows[i].model} rows={rows.map((m) => [
            <span className="mgmt-cell-strong"><b>{m.displayName || m.model}</b><small>{m.model}</small></span>,
            m.providerId,
            <span className="mgmt-badge-row">{(m.modeAllow ?? []).map((mode: string) => <StatusPill key={mode} tone="neutral">{mode}</StatusPill>)}</span>,
            <span className="mgmt-badge-row"><StatusPill tone={m.status === "allowed" ? "good" : "danger"}>{humanize(m.status)}</StatusPill>{m.enforce ? <StatusPill tone="info">Enforced</StatusPill> : null}</span>,
            isDefault(m, "chat") || isDefault(m, "code") ? <Check aria-label="Default" className="mgmt-check" /> : "—",
          ])} />
        </AsyncState>
        {detail && draft ? <DetailDrawer title={draft.displayName || draft.model} subtitle={draft.providerId} badge={<StatusPill tone={draft.status === "allowed" ? "good" : "danger"}>{humanize(draft.status)}</StatusPill>} onClose={() => setActive(null)} footer={canWrite ? <><Button variant="secondary" onClick={() => setActive(null)}>Cancel</Button><Button onClick={save}><Save aria-hidden />Save policy</Button></> : <span className="mgmt-muted">Read-only — models:write required to edit.</span>}>
          <fieldset className="mgmt-field-block" disabled={!canWrite}>
            <legend>Policy</legend>
            <div className="mgmt-segmented" role="group" aria-label="Policy">
              <Button variant="ghost" type="button" aria-selected={draft.status === "allowed"} onClick={() => setDraft({ ...draft, status: "allowed" })}>Allowed</Button>
              <Button variant="ghost" type="button" aria-selected={draft.status === "blocked"} onClick={() => setDraft({ ...draft, status: "blocked" })}>Blocked</Button>
            </div>
          </fieldset>
          <fieldset className="mgmt-field-block" disabled={!canWrite}>
            <legend>Available in</legend>
            {(["chat", "code"] as const).map((mode) => <label key={mode} className="mgmt-toggle-row"><span>{mode === "chat" ? "Chat" : "Code"}</span><ManagementSwitch checked={(draft.modeAllow ?? []).includes(mode)} onCheckedChange={(checked) => setMode(mode, checked)} aria-label={`${mode} access`} /></label>)}
          </fieldset>
          <label className="mgmt-toggle-row"><span>Enforce policy<small>Members cannot override this policy.</small></span><ManagementSwitch checked={Boolean(draft.enforce)} disabled={!canWrite} onCheckedChange={(checked) => setDraft({ ...draft, enforce: checked })} aria-label="Enforce policy" /></label>
          {draft.capabilities && Object.keys(draft.capabilities).length ? <><h3 className="mgmt-drawer-subhead">Capabilities</h3><div className="mgmt-badge-row">{Object.entries(draft.capabilities).filter(([, v]) => v === true).map(([k]) => <StatusPill key={k} tone="neutral">{humanize(k)}</StatusPill>)}</div></> : null}
          {canWrite ? <><h3 className="mgmt-drawer-subhead">Make default</h3><div className="mgmt-button-row"><Button variant="secondary" onClick={() => makeDefault("chat")} disabled={isDefault(draft, "chat")}>Set as Chat default</Button><Button variant="secondary" onClick={() => makeDefault("code")} disabled={isDefault(draft, "code")}>Set as Code default</Button></div></> : null}
        </DetailDrawer> : null}
      </div>
    </AsyncState>
  </ManagementPage>;
}

/* ------------------------------------------------------------- skills & mcp */
function SkillsMcpScreen({ client, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("skills:write") || permissions.includes("mcp:write");
  const r = useResource(`capabilities:${tenantId}`, async () => client ? client.listOrganizationCapabilities(tenantId) : [], [] as any[]);
  const [tab, setTab] = React.useState("skill");
  const [query, setQuery] = React.useState("");
  const [assignment, setAssignment] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const scoped = r.data.filter((c: any) => c.kind === tab);
  const rows = scoped.filter((c: any) => `${c.name} ${c.capabilityId}`.toLowerCase().includes(query.toLowerCase()) && (assignment === "all" || c.assignment === assignment));
  const detail = active != null ? rows[active] : null;
  const counts = (value: string) => r.data.filter((c: any) => c.assignment === value).length;
  const assignmentTone = (value: string) => value === "required" ? "info" : value === "blocked" ? "danger" : value === "default-on" ? "good" : "neutral";
  const setAllowDisable = async (capability: any, allow: boolean) => {
    await client?.upsertOrganizationCapability(tenantId, { kind: capability.kind, capabilityId: capability.capabilityId, name: capability.name, description: capability.description, assignment: capability.assignment, allowUserDisable: allow });
    r.setData(r.data.map((c: any) => c.id === capability.id ? { ...c, allowUserDisable: allow } : c));
    setMessage("Capability updated and recorded in the audit log.");
  };
  const setAssignmentValue = async (capability: any, value: string) => {
    await client?.upsertOrganizationCapability(tenantId, { kind: capability.kind, capabilityId: capability.capabilityId, name: capability.name, description: capability.description, assignment: value as any, allowUserDisable: capability.allowUserDisable });
    r.setData(r.data.map((c: any) => c.id === capability.id ? { ...c, assignment: value } : c));
    setMessage("Capability assignment updated and recorded in the audit log.");
  };
  return <ManagementPage title="Skills & MCP" description="Choose organization capabilities and how they are assigned to members." eyebrow="AI controls">
    <MetricGrid items={[
      { label: "Required", value: formatNumber(counts("required")), hint: "Cannot be disabled", status: "info" as any },
      { label: "Default on", value: formatNumber(counts("default-on")), hint: "Enabled by default", status: "good" },
      { label: "Available", value: formatNumber(counts("available")), hint: "Can be enabled" },
      { label: "Blocked", value: formatNumber(counts("blocked")), hint: "Not available", status: "danger" },
    ]} />
    <TabBar label="Capability kind" active={tab} onSelect={(id) => { setTab(id); setActive(null); }} tabs={[{ id: "skill", label: "Skills" }, { id: "mcp", label: "MCP servers" }]} />
    <Toolbar>
      <SearchInput label="Search capabilities" value={query} onChange={setQuery} placeholder="Search capabilities" />
      <FilterSelect label="Assignment" value={assignment} onChange={setAssignment} options={[{ value: "all", label: "All" }, { value: "required", label: "Required" }, { value: "default-on", label: "Default on" }, { value: "available", label: "Available" }, { value: "blocked", label: "Blocked" }]} />
    </Toolbar>
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    <div className={detail ? "mgmt-with-drawer" : undefined}>
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={rows.length === 0} emptyTitle="No organization capabilities" emptyText="Skills and MCP servers assigned to the organization will appear here.">
        <DataTable label="Organization capabilities" columns={["Capability", "Assignment", "User override", "Managed"]} onRowSelect={setActive} activeRow={active} rowLabel={(i) => rows[i].name} rows={rows.map((c: any) => [
          <span className="mgmt-cell-strong"><b>{c.name}</b><small>{c.capabilityId}</small></span>,
          <StatusPill tone={assignmentTone(c.assignment) as any}>{humanize(c.assignment)}</StatusPill>,
          c.allowUserDisable ? "Allowed" : "Not allowed",
          c.contentHash ? "Signed" : "Unsigned",
        ])} />
      </AsyncState>
      {detail ? <DetailDrawer title={detail.name} subtitle={detail.capabilityId} badge={<StatusPill tone={assignmentTone(detail.assignment) as any}>{humanize(detail.assignment)}</StatusPill>} onClose={() => setActive(null)}>
        {detail.description ? <p className="mgmt-drawer-lead">{detail.description}</p> : null}
        <DefinitionList items={[
          { term: "Type", detail: detail.kind === "skill" ? "Skill" : "MCP server" },
          { term: "Content hash", detail: detail.contentHash ? <code className="mgmt-hash">{detail.contentHash.slice(0, 20)}…<Button type="button" variant="ghost" size="icon" onClick={() => copyText(detail.contentHash)} aria-label="Copy hash"><Copy aria-hidden /></Button></code> : "Unsigned" },
          { term: "Updated", detail: formatDateTime(detail.updatedAt) },
        ]} />
        <fieldset className="mgmt-field-block" disabled={!canWrite}>
          <legend>Assignment</legend>
          <FilterSelect label="Assignment" value={detail.assignment} onChange={(v) => setAssignmentValue(detail, v)} options={[{ value: "required", label: "Required" }, { value: "default-on", label: "Default on" }, { value: "available", label: "Available" }, { value: "blocked", label: "Blocked" }]} />
        </fieldset>
        <label className="mgmt-toggle-row"><span>Allow user disable<small>Members can turn this off for themselves.</small></span><ManagementSwitch checked={Boolean(detail.allowUserDisable)} disabled={!canWrite || detail.assignment === "required"} onCheckedChange={(checked) => setAllowDisable(detail, checked)} aria-label="Allow user disable" /></label>
      </DetailDrawer> : null}
    </div>
  </ManagementPage>;
}

/* ----------------------------------------------------------- feature access */
function FeatureAccessScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("feature_flags:write");
  const r = useResource(`features:${tenantId}`, async () => client ? client.listFeatureFlags(tenantId) : config.featureFlags.filter((x) => x.tenantId === tenantId), [] as any[]);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const rows = r.data.filter((f: any) => humanize(f.flag).toLowerCase().includes(query.toLowerCase()));
  const detail = active != null ? rows[active] : null;
  const setEnabled = async (flag: any, enabled: boolean) => {
    await client?.upsertFeatureFlag(tenantId, flag.flag, { enabled, roleDefaults: flag.roleDefaults });
    r.setData(r.data.map((f: any) => f.flag === flag.flag ? { ...f, enabled, updatedAt: new Date().toISOString() } : f));
    setMessage(`Feature “${humanize(flag.flag)}” turned ${enabled ? "on" : "off"} and recorded in the audit log.`);
  };
  return <ManagementPage title="Feature access" description="Roll features out across the organization and refine access by role." eyebrow="AI controls">
    <Toolbar><SearchInput label="Search features" value={query} onChange={setQuery} placeholder="Search features" /></Toolbar>
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    <div className={detail ? "mgmt-with-drawer" : undefined}>
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={rows.length === 0}>
        <DataTable label="Feature access" columns={["Feature", "Organization default", "Role overrides", "Updated"]} onRowSelect={setActive} activeRow={active} rowLabel={(i) => humanize(rows[i].flag)} rows={rows.map((f: any) => [
          <b>{humanize(f.flag)}</b>,
          <StatusPill tone={f.enabled ? "good" : "neutral"}>{f.enabled ? "On" : "Off"}</StatusPill>,
          formatNumber(Object.keys(f.roleDefaults ?? {}).length),
          formatDate(f.updatedAt),
        ])} />
      </AsyncState>
      {detail ? <DetailDrawer title={humanize(detail.flag)} subtitle={detail.flag} badge={<StatusPill tone={detail.enabled ? "good" : "neutral"}>{detail.enabled ? "On" : "Off"}</StatusPill>} onClose={() => setActive(null)}>
        <label className="mgmt-toggle-row"><span>Organization default<small>Turn this feature on for the whole organization.</small></span><ManagementSwitch checked={Boolean(detail.enabled)} disabled={!canWrite} onCheckedChange={(checked) => setEnabled(detail, checked)} aria-label="Organization default" /></label>
        <h3 className="mgmt-drawer-subhead">Role overrides</h3>
        {Object.keys(detail.roleDefaults ?? {}).length ? <DefinitionList items={Object.entries(detail.roleDefaults).map(([role, perms]) => ({ term: humanize(role), detail: (perms as string[]).join(", ") || "—" }))} /> : <p className="mgmt-muted">No role overrides. All roles inherit the organization default.</p>}
        {!canWrite ? <p className="mgmt-muted">Read-only — feature_flags:write required to edit.</p> : null}
      </DetailDrawer> : null}
    </div>
  </ManagementPage>;
}

/* --------------------------------------------------------------- sso & scim */
function SsoScimScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("sso:write");
  const r = useResource(`sso:${tenantId}`, async () => client ? client.listSsoConnections(tenantId) : config.ssoConnections.filter((x) => x.tenantId === tenantId), [] as any[]);
  const [active, setActive] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const detail = active != null ? r.data[active] : null;
  const scimCount = r.data.filter((c: any) => c.scimEnabled).length;
  const enabledCount = r.data.filter((c: any) => c.status === "enabled").length;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = { kind: String(form.get("kind")) as "saml" | "oidc", slug: String(form.get("slug")), displayName: String(form.get("displayName")), domains: String(form.get("domains")).split(",").map((v) => v.trim()).filter(Boolean), scimEnabled: form.get("scim") === "on" };
    const saved = await client?.createSsoConnection(tenantId, input);
    r.setData([saved ?? { id: crypto.randomUUID(), tenantId, status: "draft", issuer: null, ssoUrl: null, metadataUrl: null, entityId: null, clientId: null, clientSecretRef: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input }, ...r.data]);
    setAdding(false); setMessage("Connection created as a draft. Configure and test it before enabling.");
  };
  return <ManagementPage title="SSO & SCIM" description="Connect your identity provider and automate membership provisioning." eyebrow="Security & data" actions={canWrite ? <Button onClick={() => setAdding((v) => !v)}><Plus aria-hidden />Add connection</Button> : null}>
    <MetricGrid items={[
      { label: "Connections", value: formatNumber(r.data.length) },
      { label: "Enabled", value: formatNumber(enabledCount), status: enabledCount ? "good" : "warning" },
      { label: "SCIM provisioning", value: scimCount ? "On" : "Off", status: scimCount ? "good" : "warning" },
    ]} />
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    {adding ? <form className="mgmt-inline-form" onSubmit={submit}>
      <label>Type<FormSelect name="kind" defaultValue="oidc" options={[{ value: "oidc", label: "OIDC" }, { value: "saml", label: "SAML" }]} /></label>
      <label>Slug<Input name="slug" pattern="[a-z0-9-]+" required /></label>
      <label>Display name<Input name="displayName" required /></label>
      <label className="mgmt-field-wide">Verified domains (comma-separated)<Input name="domains" placeholder="acme.com" /></label>
      <label className="mgmt-confirm"><Checkbox name="scim" /><span>Enable SCIM provisioning</span></label>
      <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
      <Button><Save aria-hidden />Create connection</Button>
    </form> : null}
    <div className={detail ? "mgmt-with-drawer" : undefined}>
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={r.data.length === 0} emptyTitle="No identity connections" emptyText="Add an OIDC or SAML connection to enable enterprise sign-in.">
        <div className="mgmt-card-grid">
          {r.data.map((connection: any, index: number) => <Button key={connection.id} type="button" variant="ghost" className="mgmt-connection-card" aria-current={active === index ? "true" : undefined} onClick={() => setActive(index)}>
            <div className="mgmt-connection-head"><b>{connection.displayName}</b><StatusPill tone={connection.status === "enabled" ? "good" : connection.status === "disabled" ? "danger" : "warning"}>{humanize(connection.status)}</StatusPill></div>
            <dl className="mgmt-connection-facts"><div><dt>Sign-in</dt><dd>{connection.kind.toUpperCase()}</dd></div><div><dt>SCIM</dt><dd>{connection.scimEnabled ? "Enabled" : "Off"}</dd></div><div><dt>Domains</dt><dd>{connection.domains.join(", ") || "—"}</dd></div></dl>
          </Button>)}
        </div>
      </AsyncState>
      {detail ? <DetailDrawer title={detail.displayName} subtitle={detail.kind.toUpperCase()} badge={<StatusPill tone={detail.status === "enabled" ? "good" : detail.status === "disabled" ? "danger" : "warning"}>{humanize(detail.status)}</StatusPill>} onClose={() => setActive(null)}>
        <DefinitionList items={[
          { term: "Slug", detail: detail.slug },
          { term: "Sign-in", detail: detail.kind === "oidc" ? "OIDC" : "SAML 2.0" },
          { term: "Issuer", detail: detail.issuer ?? "Not configured" },
          { term: "SCIM", detail: detail.scimEnabled ? "Enabled" : "Not configured" },
          { term: "Verified domains", detail: detail.domains.join(", ") || "—" },
          { term: "Updated", detail: formatDateTime(detail.updatedAt) },
        ]} />
      </DetailDrawer> : null}
    </div>
  </ManagementPage>;
}

/* --------------------------------------------------------- managed policy */
function ManagedPolicyScreen({ client, config, tenantId }: ManagementScreenProps) {
  const r = useResource(`policy:${tenantId}`, async () => client ? client.listPolicyVersions(tenantId) : config.policyVersions.filter((x) => x.tenantId === tenantId), [] as any[]);
  const [active, setActive] = React.useState<number | null>(null);
  const versions = [...r.data].sort((a: any, b: any) => b.version - a.version);
  const current = versions.find((v: any) => v.status === "active") ?? versions[0] ?? null;
  const detail = active != null ? versions[active] : null;
  const locksOf = (v: any) => v?.bundle?.policy ? Object.keys(v.bundle.policy).filter((k) => v.bundle.policy[k]) : (v?.locks ?? []);
  return <ManagementPage title="Managed policy" description="Signed policy bundles that lock client behavior across the organization." eyebrow="Security & data">
    <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={versions.length === 0} emptyTitle="No managed policy" emptyText="Published policy bundles will appear here.">
      {current ? <Section title="Current policy">
        <MetricGrid items={[
          { label: "Version", value: `v${current.version}`, status: current.status === "active" ? "good" : "warning" },
          { label: "Status", value: humanize(current.status), status: current.status === "active" ? "good" : current.status === "revoked" ? "danger" : "warning" },
          { label: "Signing key", value: current.keyId ?? "—" },
          { label: "Published", value: formatDate(current.publishedAt ?? current.createdAt) },
        ]} />
      </Section> : null}
      <div className={detail ? "mgmt-with-drawer" : undefined}>
        <Section title="Versions">
          <DataTable label="Policy versions" columns={["Version", "Status", "Signing key", "Published", "Note"]} onRowSelect={setActive} activeRow={active} rowLabel={(i) => `Version ${versions[i].version}`} rows={versions.map((v: any) => [
            <b>v{v.version}</b>,
            <StatusPill tone={v.status === "active" ? "good" : v.status === "revoked" ? "danger" : "neutral"}>{humanize(v.status)}</StatusPill>,
            v.keyId ?? "—",
            formatDateTime(v.publishedAt ?? v.createdAt),
            v.note ?? "—",
          ])} />
        </Section>
        {detail ? <DetailDrawer title={`Version ${detail.version}`} badge={<StatusPill tone={detail.status === "active" ? "good" : detail.status === "revoked" ? "danger" : "neutral"}>{humanize(detail.status)}</StatusPill>} onClose={() => setActive(null)}>
          <DefinitionList items={[
            { term: "Bundle hash", detail: detail.bundleHash ? <code className="mgmt-hash">{detail.bundleHash.slice(0, 24)}…<Button type="button" variant="ghost" size="icon" onClick={() => copyText(detail.bundleHash)} aria-label="Copy hash"><Copy aria-hidden /></Button></code> : "—" },
            { term: "Signing key", detail: detail.keyId ?? "—" },
            { term: "Published", detail: formatDateTime(detail.publishedAt ?? detail.createdAt) },
            { term: "Published by", detail: detail.publishedBy ?? "System" },
            ...(detail.revokedAt ? [{ term: "Revoked", detail: formatDateTime(detail.revokedAt) }] : []),
          ]} />
          <h3 className="mgmt-drawer-subhead">Locks enforced</h3>
          <div className="mgmt-badge-row">{locksOf(detail).length ? locksOf(detail).map((lock: string) => <StatusPill key={lock} tone="info">{humanize(lock)}</StatusPill>) : <span className="mgmt-muted">No locks</span>}</div>
          {detail.bundlePath ? <><h3 className="mgmt-drawer-subhead">Bundle</h3><p className="mgmt-muted">{detail.bundlePath}</p></> : null}
        </DetailDrawer> : null}
      </div>
    </AsyncState>
  </ManagementPage>;
}

/* -------------------------------------------------------------- audit log */
function AuditLogScreen({ client, config, tenantId }: ManagementScreenProps) {
  const r = useResource(`audit:${tenantId}`, async () => client ? client.listAuditEvents(tenantId, { limit: 100 }) : config.auditEvents.filter((x) => x.tenantId === tenantId), [] as any[]);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const categories = [...new Set(r.data.map((x: any) => x.category))];
  const rows = r.data.filter((x: any) => `${x.action} ${x.actorUserId ?? ""} ${x.targetId ?? ""}`.toLowerCase().includes(query.toLowerCase()) && (category === "all" || x.category === category));
  const detail = active != null ? rows[active] : null;
  const exportCsv = () => {
    const header = ["sequence", "ts", "actor", "category", "action", "targetType", "targetId"];
    const body = rows.map((x: any) => [x.sequence, x.ts ?? x.createdAt, x.actorUserId ?? "system", x.category, x.action, x.targetType ?? "", x.targetId ?? ""].join(","));
    const csv = [header.join(","), ...body].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "audit-log.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  return <ManagementPage title="Audit log" description="Tamper-evident administration activity with a verifiable hash chain." eyebrow="Security & data" actions={<Button variant="secondary" onClick={exportCsv}><Download aria-hidden />Export</Button>}>
    <Toolbar>
      <SearchInput label="Search audit events" value={query} onChange={setQuery} placeholder="Search action, actor, or target" />
      <FilterSelect label="Category" value={category} onChange={setCategory} options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: String(c), label: humanize(String(c)) }))]} />
    </Toolbar>
    <div className={detail ? "mgmt-with-drawer" : undefined}>
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={rows.length === 0}>
        <DataTable label="Audit events" columns={["Time", "Actor", "Action", "Target", "Sequence"]} onRowSelect={setActive} activeRow={active} rowLabel={(i) => `${rows[i].category} ${rows[i].action}`} rows={rows.map((x: any) => [
          formatDateTime(x.ts ?? x.createdAt),
          x.actorUserId ?? "System",
          <span className="mgmt-cell-strong"><b>{humanize(x.action)}</b><small>{x.category}.{x.action}</small></span>,
          x.targetId ? `${humanize(x.targetType ?? "")}: ${x.targetId}` : "—",
          <code>#{x.sequence}</code>,
        ])} />
      </AsyncState>
      {detail ? <DetailDrawer title={humanize(detail.action)} subtitle={`${detail.category}.${detail.action}`} badge={<code>#{detail.sequence}</code>} onClose={() => setActive(null)}>
        <DefinitionList items={[
          { term: "Time", detail: formatDateTime(detail.ts ?? detail.createdAt) },
          { term: "Actor", detail: detail.actorUserId ?? "System" },
          { term: "Target", detail: detail.targetId ? `${humanize(detail.targetType ?? "")}: ${detail.targetId}` : "—" },
        ]} />
        {detail.before || detail.after ? <><h3 className="mgmt-drawer-subhead">Change</h3><div className="mgmt-diff"><div><span>Before</span><pre>{JSON.stringify(detail.before ?? null, null, 2)}</pre></div><div><span>After</span><pre>{JSON.stringify(detail.after ?? null, null, 2)}</pre></div></div></> : null}
        {detail.metadata && Object.keys(detail.metadata).length ? <><h3 className="mgmt-drawer-subhead">Metadata</h3><pre className="mgmt-code-block">{JSON.stringify(detail.metadata, null, 2)}</pre></> : null}
        {detail.eventHash ? <><h3 className="mgmt-drawer-subhead">Hash chain</h3><DefinitionList items={[
          { term: "Previous hash", detail: <code className="mgmt-hash">{String(detail.previousHash ?? "—").slice(0, 24)}…</code> },
          { term: "Event hash", detail: <code className="mgmt-hash">{String(detail.eventHash).slice(0, 24)}…</code> },
        ]} /></> : null}
      </DetailDrawer> : null}
    </div>
  </ManagementPage>;
}

/* ------------------------------------------------------------- dispatcher */
const PERMISSION_FOR: Record<string, OrgPermission> = {
  roles: "rbac:read", "resource-access": "acl:read", models: "models:read", "skills-mcp": "org:read",
  "feature-access": "feature_flags:read", "sso-scim": "sso:read", "managed-policy": "policy:read", "audit-log": "audit:read",
};
export function AdminCatalogScreen({ tab, ...props }: ManagementScreenProps & { tab: string }) {
  const required = PERMISSION_FOR[tab];
  if (required && !props.permissions.includes(required)) return <PermissionDenied label={humanize(tab)} />;
  switch (tab) {
    case "roles": return <RolesScreen {...props} />;
    case "resource-access": return <ResourceAccessScreen {...props} />;
    case "models": return <ModelsScreen {...props} />;
    case "skills-mcp": return <SkillsMcpScreen {...props} />;
    case "feature-access": return <FeatureAccessScreen {...props} />;
    case "sso-scim": return <SsoScimScreen {...props} />;
    case "managed-policy": return <ManagedPolicyScreen {...props} />;
    case "audit-log": return <AuditLogScreen {...props} />;
    default: return <PermissionDenied label={humanize(tab)} />;
  }
}
