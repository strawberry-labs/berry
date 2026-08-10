import * as React from "react";
import {
  Activity,
  Check,
  Copy,
  Download,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  OrgPermissionSchema,
  type OrgCapabilityAssignment,
  type OrgPermission,
  type PersonalSkillReview,
} from "@berry/shared";
import { readBrowserSkillImport } from "@/lib/skill-import";
import {
  AsyncState,
  Button,
  Checkbox,
  DataTable,
  DefinitionList,
  DetailDrawer,
  FilterSelect,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  MetricGrid,
  PermissionDenied,
  SearchInput,
  Section,
  StatusPill,
  SuccessMessage,
  TabBar,
  Textarea,
  Toolbar,
  formatDate,
  formatDateTime,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

/* ------------------------------------------------------------------ helpers */
const ALL_PERMISSIONS = OrgPermissionSchema.options as OrgPermission[];
const PERMISSION_DOMAINS: Array<{ id: string; label: string }> = [
  { id: "org", label: "Organization" },
  { id: "org_settings", label: "Organization settings" },
  { id: "members", label: "People" },
  { id: "departments", label: "Departments" },
  { id: "rbac", label: "Roles" },
  { id: "acl", label: "Resource access" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "feature_flags", label: "Feature access" },
  { id: "guardrails", label: "Execution & network" },
  { id: "usage", label: "Usage" },
  { id: "budgets", label: "Budgets" },
  { id: "billing", label: "Billing" },
  { id: "reports", label: "Reports" },
  { id: "alerts", label: "Alerts" },
  { id: "sso", label: "SSO & SCIM" },
  { id: "policy", label: "Managed policy" },
  { id: "auth_policy", label: "Authentication" },
  { id: "data_policy", label: "Data governance" },
  { id: "service_accounts", label: "Service accounts" },
  { id: "audit", label: "Audit" },
];
function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function domainOf(permission: string) {
  return permission.split(":")[0];
}
function actionOf(permission: string) {
  return permission.split(":")[1] ?? "read";
}
function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {});
}

/* -------------------------------------------------------------------- roles */
function RolesScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("rbac:write");
  const r = useResource(
    `roles:${tenantId}`,
    async () =>
      client
        ? client.listRolePermissions(tenantId)
        : config.rolePermissions.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [selected, setSelected] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Set<OrgPermission> | null>(null);
  const [message, setMessage] = React.useState("");
  const roleOrder = new Map([["owner", 0], ["admin", 1], ["member", 2]]);
  const roles = [...r.data].sort((left: any, right: any) => (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) || left.role.localeCompare(right.role));
  const active = r.data.find((role: any) => role.role === selected) ?? null;
  const isSystem = active?.source === "system";
  React.useEffect(() => {
    if (roles.length > 0 && !roles.some((role: any) => role.role === selected)) setSelected(roles[0].role);
  }, [r.data, selected]);
  React.useEffect(() => {
    setDraft(active ? new Set(active.permissions) : null);
    setMessage("");
  }, [selected, r.data]);
  const dirty =
    Boolean(active && draft) &&
    (draft!.size !== active!.permissions.length ||
      active!.permissions.some((p: OrgPermission) => !draft!.has(p)));
  const toggle = (permission: OrgPermission) => {
    if (!draft || isSystem || !canWrite) return;
    const next = new Set(draft);
    next.has(permission) ? next.delete(permission) : next.add(permission);
    setDraft(next);
  };
  const save = async () => {
    if (!active || !draft) return;
    const nextPermissions = [...draft];
    await client?.updateRolePermissions(tenantId, active.role, {
      permissions: nextPermissions,
    });
    r.setData(
      r.data.map((role: any) =>
        role.role === active.role
          ? {
              ...role,
              permissions: nextPermissions,
              updatedAt: new Date().toISOString(),
            }
          : role,
      ),
    );
    setMessage("Role permissions saved and recorded in the audit log.");
  };
  return (
    <ManagementPage
      title="Roles & permissions"
      description="Review organization roles horizontally, then inspect each permission group below."
      eyebrow="Access"
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={roles.length === 0} emptyTitle="No roles configured">
        <div className="grid min-w-0 gap-4">
          <TabBar
            label="Organization roles"
            active={selected ?? ""}
            onSelect={setSelected}
            tabs={roles.map((role: any) => ({ id: role.role, label: `${humanize(role.role)} · ${role.permissions.length}` }))}
          />
          {active && draft ? (
            <Section
              title={humanize(active.role)}
              description={
                isSystem
                  ? "System role — permissions are managed by Berry and cannot be changed."
                  : "Toggle the permissions granted to this role."
              }
              actions={
                canWrite && !isSystem ? (
                  <Button onClick={save} disabled={!dirty}>
                    <Save aria-hidden />
                    Save role
                  </Button>
                ) : null
              }
            >
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {PERMISSION_DOMAINS.map((domain) => {
                  const perms = ALL_PERMISSIONS.filter(
                    (p) => domainOf(p) === domain.id,
                  );
                  if (!perms.length) return null;
                  return (
                    <fieldset
                      key={domain.id}
                      className="grid gap-1.5 border-0 p-0 [&_legend]:mb-1 [&_legend]:text-xs [&_legend]:font-semibold"
                    >
                      <legend>{domain.label}</legend>
                      {perms.map((permission) => (
                        <label
                          key={permission}
                          className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-xs [&_code]:ml-auto [&_code]:font-mono [&_code]:text-xs [&_code]:text-muted-foreground"
                        >
                          <Checkbox
                            checked={draft.has(permission)}
                            disabled={isSystem || !canWrite}
                            onCheckedChange={() => toggle(permission)}
                          />
                          <span>{humanize(actionOf(permission))}</span>
                          <code>{permission}</code>
                        </label>
                      ))}
                    </fieldset>
                  );
                })}
              </div>
              {message ? <SuccessMessage>{message}</SuccessMessage> : null}
            </Section>
          ) : (
            <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <p>Select a role to review or edit its permissions.</p>
            </div>
          )}
        </div>
      </AsyncState>
    </ManagementPage>
  );
}

/* --------------------------------------------------------- resource access */
function ResourceAccessScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("acl:write");
  const r = useResource(
    `acls:${tenantId}`,
    async () =>
      client
        ? client.listResourceAcls(tenantId)
        : config.resourceAcls.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [query, setQuery] = React.useState("");
  const [resourceType, setResourceType] = React.useState("all");
  const [principalType, setPrincipalType] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const resourceTypes = [...new Set(r.data.map((x: any) => x.resourceType))];
  const rows = r.data.filter(
    (x: any) =>
      `${x.resourceId} ${x.principalId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (resourceType === "all" || x.resourceType === resourceType) &&
      (principalType === "all" || x.principalType === principalType),
  );
  const detail = active != null ? rows[active] : null;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      resourceType: String(form.get("resourceType")),
      resourceId: String(form.get("resourceId")),
      principalType: String(form.get("principalType")) as any,
      principalId: String(form.get("principalId")),
      allow: String(form.get("allow"))
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean) as OrgPermission[],
      deny: String(form.get("deny"))
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean) as OrgPermission[],
    };
    const saved = await client?.upsertResourceAcl(tenantId, input);
    r.setData([
      saved ?? {
        id: crypto.randomUUID(),
        tenantId,
        ...input,
        updatedAt: new Date().toISOString(),
      },
      ...r.data,
    ]);
    setAdding(false);
    setMessage("Access rule saved and recorded in the audit log.");
  };
  return (
    <ManagementPage
      title="Resource access"
      description="Inspect and override sharing for workspaces, agents, prompts, skills, and conversations."
      eyebrow="Access"
      actions={
        canWrite ? (
          <Button onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" aria-hidden />
            Add rule
          </Button>
        ) : null
      }
    >
      <Toolbar>
        <SearchInput
          label="Search resources"
          value={query}
          onChange={setQuery}
          placeholder="Search resource or principal"
        />
        <FilterSelect
          label="Resource type"
          value={resourceType}
          onChange={setResourceType}
          options={[
            { value: "all", label: "All" },
            ...resourceTypes.map((t) => ({
              value: String(t),
              label: humanize(String(t)),
            })),
          ]}
        />
        <FilterSelect
          label="Principal"
          value={principalType}
          onChange={setPrincipalType}
          options={[
            { value: "all", label: "All" },
            { value: "user", label: "User" },
            { value: "role", label: "Role" },
            { value: "department", label: "Department" },
          ]}
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add resource access rule"
        description="Grant or deny specific permissions for a user, role, or department on one Berry resource."
        size="lg"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-resource-rule-form">
              <Save aria-hidden />
              Save rule
            </Button>
          </>
        }
      >
        <form
          id="create-resource-rule-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Resource type
            <Input
              name="resourceType"
              placeholder="workspace"
              autoFocus
              required
            />
          </label>
          <label>
            Resource ID
            <Input name="resourceId" required />
          </label>
          <label>
            Principal type
            <FormSelect
              name="principalType"
              defaultValue="user"
              options={[
                { value: "user", label: "User" },
                { value: "role", label: "Role" },
                { value: "department", label: "Department" },
              ]}
            />
          </label>
          <label>
            Principal ID
            <Input name="principalId" required />
          </label>
          <label>
            Allow (comma-separated keys)
            <Input name="allow" placeholder="acl:read" />
          </label>
          <label>
            Deny (comma-separated keys)
            <Input name="deny" />
          </label>
        </form>
      </ManagementDialog>
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
        >
          <DataTable
            label="Resource access rules"
            columns={["Resource", "Principal", "Allowed", "Denied", "Updated"]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => `${rows[i].resourceType} ${rows[i].resourceId}`}
            rows={rows.map((x: any) => [
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{x.resourceId}</b>
                <small>{humanize(x.resourceType)}</small>
              </span>,
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{x.principalId}</b>
                <small>{humanize(x.principalType)}</small>
              </span>,
              x.allow.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {x.allow.map((p: string) => (
                    <StatusPill key={p} tone="good">
                      {p}
                    </StatusPill>
                  ))}
                </span>
              ) : (
                "—"
              ),
              x.deny.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {x.deny.map((p: string) => (
                    <StatusPill key={p} tone="danger">
                      {p}
                    </StatusPill>
                  ))}
                </span>
              ) : (
                "—"
              ),
              formatDate(x.updatedAt),
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={detail.resourceId}
            subtitle={humanize(detail.resourceType)}
            badge={
              <StatusPill tone="info">
                {humanize(detail.principalType)}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            <DefinitionList
              items={[
                {
                  term: "Resource",
                  detail: `${humanize(detail.resourceType)} · ${detail.resourceId}`,
                },
                {
                  term: "Principal",
                  detail: `${humanize(detail.principalType)} · ${detail.principalId}`,
                },
                { term: "Updated", detail: formatDateTime(detail.updatedAt) },
              ]}
            />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Effective permissions
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {detail.allow.length ? (
                detail.allow.map((p: string) => (
                  <StatusPill key={p} tone="good">
                    {p}
                  </StatusPill>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">
                  No explicit grants
                </span>
              )}
            </div>
            {detail.deny.length ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Denied
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {detail.deny.map((p: string) => (
                    <StatusPill key={p} tone="danger">
                      {p}
                    </StatusPill>
                  ))}
                </div>
              </>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* --------------------------------------------------------------- providers */
function ProvidersScreen({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("models:write");
  const r = useResource(
    `model-providers:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listOrganizationModelProviders(tenantId),
            client.listOrgModels(tenantId, { includeBlocked: true }),
          ])
        : [[], []],
    [[], []] as any,
  );
  const [providers, models] = r.data;
  const [open, setOpen] = React.useState(false);
  const [enabled, setEnabled] = React.useState(true);
  const [message, setMessage] = React.useState("");
  const [testError, setTestError] = React.useState("");
  const [testingProviderId, setTestingProviderId] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optional = (name: string) => String(form.get(name) ?? "").trim() || null;
    await client?.upsertOrganizationModelProvider(tenantId, {
      providerId: String(form.get("providerId")).trim(),
      displayName: String(form.get("displayName")).trim(),
      kind: String(form.get("kind")) as any,
      apiType: String(form.get("apiType")) as any,
      baseUrl: String(form.get("baseUrl")).trim().replace(/\/$/, ""),
      endpointPath: optional("endpointPath"),
      modelsPath: optional("modelsPath"),
      authType: String(form.get("authType")) as any,
      credentialRef: optional("credentialRef"),
      defaultModel: optional("defaultModel"),
      enabled,
    });
    setOpen(false);
    setMessage("Provider configuration saved without storing a raw API key.");
    r.retry();
  };

  const testProvider = async (providerId: string) => {
    if (!client) return;
    setMessage("");
    setTestError("");
    setTestingProviderId(providerId);
    try {
      await client.testOrganizationModelProvider(tenantId, providerId);
      setMessage("Provider passed its guarded health check and is active for organization runtime traffic.");
      r.retry();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Provider activation failed.");
      r.retry();
    } finally {
      setTestingProviderId(null);
    }
  };

  return (
    <ManagementPage
      title="Providers"
      description="Register Berry Router, direct cloud providers, and local inference endpoints. Provider secrets stay in deployment secret storage."
      eyebrow="AI & tools"
      actions={canWrite ? <Button onClick={() => setOpen(true)}><Plus />Add provider</Button> : null}
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {testError ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{testError}</p> : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={providers.length === 0}
        emptyTitle="No organization providers"
        emptyText="Berry can start without a model provider. Register one here when the deployment is ready for live inference."
      >
        <MetricGrid items={[
          { label: "Registered", value: formatNumber(providers.length) },
          { label: "Enabled", value: formatNumber(providers.filter((item: any) => item.enabled).length) },
          { label: "Configured models", value: formatNumber(models.length) },
          { label: "Needs activation", value: formatNumber(providers.filter((item: any) => item.status === "configured").length), status: providers.some((item: any) => item.status === "error") ? "danger" : "warning" },
        ]} />
        <Section
          title="Provider registry"
          description="Configured means the metadata is saved. Active means the runtime has resolved its credential and passed a guarded health check."
        >
          <DataTable
            label="Organization model providers"
            columns={["Provider", "Protocol", "Base URL", "Credential", "Default model", "State", "Updated", "Actions"]}
            rows={providers.map((provider: any) => [
              <span><b>{provider.displayName}</b><small>{provider.providerId} · {humanize(provider.kind)}</small></span>,
              humanize(provider.apiType),
              <span className="max-w-72 break-all font-mono text-xs">{provider.baseUrl}</span>,
              provider.authType === "none" ? "Keyless" : provider.credentialRef ?? "Missing reference",
              provider.defaultModel ?? "—",
              <StatusPill tone={provider.status === "active" ? "good" : provider.status === "error" ? "danger" : provider.status === "configured" ? "warning" : "neutral"}>{provider.status}</StatusPill>,
              formatDateTime(provider.updatedAt),
              canWrite ? <Button variant="secondary" disabled={!provider.enabled || testingProviderId === provider.providerId} onClick={() => void testProvider(provider.providerId)}><Activity />{testingProviderId === provider.providerId ? "Testing…" : "Test & activate"}</Button> : "—",
            ])}
          />
        </Section>
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Raw API keys are intentionally not accepted here. Set the referenced secret in deployment storage, allowlist the provider host with BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS, then run Test &amp; activate.
        </p>
      </AsyncState>
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Add model provider"
        description="Save connection metadata and a secret reference. This form never accepts or returns the provider API key itself."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" form="provider-form"><Save />Save provider</Button></>}
      >
        <form id="provider-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={submit}>
          <label>Display name<Input name="displayName" autoFocus placeholder="OpenAI production" required /></label>
          <label>Provider ID<Input name="providerId" pattern="[A-Za-z0-9._-]+" placeholder="openai-production" required /></label>
          <label>Provider kind<FormSelect name="kind" defaultValue="openai-compatible" options={[
            { value: "berry-router", label: "Berry Router" },
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
            { value: "openai-compatible", label: "OpenAI-compatible" },
            { value: "ollama", label: "Ollama" },
            { value: "lm-studio", label: "LM Studio" },
            { value: "local", label: "Other local" },
            { value: "custom", label: "Custom" },
          ]} /></label>
          <label>API protocol<FormSelect name="apiType" defaultValue="openai-chat-completions" options={[
            { value: "openai-chat-completions", label: "OpenAI chat completions" },
            { value: "openai-responses", label: "OpenAI responses" },
            { value: "anthropic-messages", label: "Anthropic messages" },
          ]} /></label>
          <label className="sm:col-span-2">Base URL<Input name="baseUrl" type="url" placeholder="https://api.openai.com/v1" required /></label>
          <label>Request path<Input name="endpointPath" placeholder="/chat/completions" /></label>
          <label>Models path<Input name="modelsPath" placeholder="/models" /></label>
          <label>Authentication<FormSelect name="authType" defaultValue="bearer" options={[
            { value: "bearer", label: "Bearer secret" },
            { value: "x-api-key", label: "x-api-key secret" },
            { value: "optional-bearer", label: "Optional bearer" },
            { value: "none", label: "No authentication" },
          ]} /></label>
          <label>Credential reference<Input name="credentialRef" pattern="[A-Za-z0-9_.:/-]+" placeholder="env:BERRY_OPENAI_API_KEY" /></label>
          <label>Default model<Input name="defaultModel" placeholder="gpt-5.4" /></label>
          <label className="flex-row items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm text-foreground">Enabled<ManagementSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Provider enabled" /></label>
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}

/* ------------------------------------------------------------------ models */
function ModelsScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("models:write");
  const r = useResource(
    `models:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listOrgModels(tenantId, { includeBlocked: true }),
            client.listOrgModelDefaults(tenantId),
            client.listOrgAuxiliaryModelDefaults(tenantId),
            client.listOrganizationModelProviders(tenantId),
            client.listOrgAiAccessRules(tenantId),
            permissions.includes("members:read")
              ? client.listOrgMembers(tenantId)
              : Promise.resolve([]),
            permissions.includes("departments:read")
              ? client.listDepartments(tenantId)
              : Promise.resolve([]),
          ])
        : [
            config.modelPolicies as any[],
            config.modelDefaults as any[],
            [],
            [],
            [],
            [],
            config.departments.filter((item) => item.tenantId === tenantId),
          ],
    [[], [], [], [], [], [], []] as any,
  );
  const [models, defaults, auxiliaryDefaults, registeredProviders, accessRules, members, departments]: [any[], any[], any[], any[], any[], any[], any[]] = r.data;
  const [query, setQuery] = React.useState("");
  const [provider, setProvider] = React.useState("all");
  const [status, setStatus] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<any>(null);
  const [message, setMessage] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addingRule, setAddingRule] = React.useState(false);
  const [ruleScope, setRuleScope] = React.useState<"org" | "department" | "user">("department");
  const providers = [...new Set([
    ...(registeredProviders ?? []).map((item) => item.providerId),
    ...(models ?? []).map((m) => m.providerId),
  ])];
  const rows = (models ?? []).filter(
    (m) =>
      `${m.displayName ?? ""} ${m.model}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (provider === "all" || m.providerId === provider) &&
      (status === "all" || m.status === status),
  );
  const modelNames = new Map(
    (models ?? []).map((item) => [
      `${item.providerId}:${item.model}`,
      item.displayName || item.model,
    ]),
  );
  const memberNames = new Map(
    (members ?? []).map((item) => [item.userId, item.name || item.email || item.userId]),
  );
  const departmentNames = new Map(
    (departments ?? []).map((item) => [item.id, item.name || item.id]),
  );
  const detail = active != null ? rows[active] : null;
  React.useEffect(() => {
    setDraft(
      detail ? { ...detail, modeAllow: [...(detail.modeAllow ?? [])] } : null,
    );
    setMessage("");
  }, [active, r.data]);
  const defaultFor = (mode: string) =>
    (defaults ?? []).find((d) => d.mode === mode);
  const isDefault = (m: any, mode: string) => {
    const d = defaultFor(mode);
    return d && d.model === m.model && d.providerId === m.providerId;
  };
  const setMode = (mode: "chat" | "code", on: boolean) =>
    setDraft((d: any) => ({
      ...d,
      modeAllow: on
        ? [...new Set([...(d.modeAllow ?? []), mode])]
        : (d.modeAllow ?? []).filter((x: string) => x !== mode),
    }));
  const setCost = (key: "input" | "output" | "cacheRead" | "cacheWrite", value: string) =>
    setDraft((current: any) => ({
      ...current,
      capabilities: {
        ...(current.capabilities ?? {}),
        cost: { ...(current.capabilities?.cost ?? {}), [key]: value === "" ? undefined : Number(value) },
      },
    }));
  const setContext = (key: "windowTokens" | "maxOutputTokens", value: string) =>
    setDraft((current: any) => ({
      ...current,
      capabilities: {
        ...(current.capabilities ?? {}),
        context: { ...(current.capabilities?.context ?? {}), [key]: value === "" ? undefined : Number(value) },
      },
    }));
  const save = async () => {
    if (!draft) return;
    await client?.upsertOrgModelPolicy(tenantId, {
      providerId: draft.providerId,
      model: draft.model,
      displayName: draft.displayName ?? null,
      status: draft.status,
      enforce: draft.enforce,
      modeAllow: draft.modeAllow,
      apiType: draft.apiType ?? null,
      capabilities: draft.capabilities ?? {},
    });
    r.setData([
      (models ?? []).map((m) => (m.id === draft.id ? { ...m, ...draft } : m)),
      defaults,
      auxiliaryDefaults,
      registeredProviders,
      accessRules,
      members,
      departments,
    ]);
    setMessage("Model policy saved and recorded in the audit log.");
  };
  const makeDefault = async (mode: "chat" | "code") => {
    if (!draft) return;
    await client?.upsertOrgModelDefault(tenantId, mode, {
      providerId: draft.providerId,
      model: draft.model,
      enforce: draft.enforce,
    });
    const next = [
      ...(defaults ?? []).filter((d) => d.mode !== mode),
      {
        tenantId,
        mode,
        providerId: draft.providerId,
        model: draft.model,
        enforce: draft.enforce,
        updatedAt: new Date().toISOString(),
      },
    ];
    r.setData([models, next, auxiliaryDefaults, registeredProviders, accessRules, members, departments]);
    setMessage(`Set as the ${mode} default and recorded in the audit log.`);
  };
  const makeVisionDefault = async () => {
    if (!draft || draft.capabilities?.vision !== true) return;
    const saved = await client?.upsertOrgAuxiliaryModelDefault(tenantId, "vision", {
      providerId: draft.providerId,
      model: draft.model,
    });
    const next = [
      ...(auxiliaryDefaults ?? []).filter((item) => item.purpose !== "vision"),
      saved ?? {
        tenantId,
        purpose: "vision",
        providerId: draft.providerId,
        model: draft.model,
        updatedAt: new Date().toISOString(),
      },
    ];
    r.setData([models, defaults, next, registeredProviders, accessRules, members, departments]);
    setMessage("Set as the organization vision model and recorded in the audit log.");
  };
  const addModel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = (name: string) => {
      const value = String(form.get(name) ?? "");
      return value === "" ? undefined : Number(value);
    };
    await client?.upsertOrgModelPolicy(tenantId, {
      providerId: String(form.get("providerId")),
      model: String(form.get("model")),
      displayName: String(form.get("displayName")) || null,
      apiType: String(form.get("apiType")) as any,
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
      capabilities: {
        cost: { input: number("inputPrice"), output: number("outputPrice"), cacheRead: number("cacheReadPrice"), cacheWrite: number("cacheWritePrice") },
        context: { windowTokens: number("contextWindow"), maxOutputTokens: number("maxOutput") },
      },
    });
    setAdding(false);
    setMessage("Model added with its pricing and context metadata.");
    r.retry();
  };
  const addAccessRule = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scopeType = String(form.get("scopeType")) as "org" | "department" | "user";
    const scopeId = scopeType === "org" ? tenantId : String(form.get("scopeId"));
    const input = {
      scopeType,
      scopeId,
      resourceType: "model" as const,
      resourceId: String(form.get("resourceId")),
      effect: String(form.get("effect")) as "allowed" | "blocked",
    };
    const saved = await client?.upsertOrgAiAccessRule(tenantId, input);
    const nextRule = saved ?? {
      id: crypto.randomUUID(),
      tenantId,
      ...input,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const nextRules = [
      nextRule,
      ...(accessRules ?? []).filter((rule) =>
        rule.scopeType !== input.scopeType
        || rule.scopeId !== input.scopeId
        || rule.resourceType !== input.resourceType
        || rule.resourceId !== input.resourceId
      ),
    ];
    r.setData([models, defaults, auxiliaryDefaults, registeredProviders, nextRules, members, departments]);
    setAddingRule(false);
    setMessage("Scoped model access saved and recorded in the audit log.");
  };
  return (
    <ManagementPage
      title="Models"
      description="Add provider models, record token pricing and context limits, control availability, and choose Chat, Code, and vision defaults."
      eyebrow="AI & tools"
      actions={canWrite ? <><Button variant="secondary" onClick={() => setAddingRule(true)}><ShieldCheck />Access rule</Button><Button onClick={() => setAdding(true)}><Plus />Add model</Button></> : null}
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        <section
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Model defaults"
        >
          {(["chat", "code"] as const).map((mode) => {
            const d = defaultFor(mode);
            return (
              <article key={mode} data-status={d ? "good" : "warning"}>
                <span>Default for {mode === "chat" ? "Chat" : "Code"}</span>
                <strong>{d ? d.model : "Not set"}</strong>
                <small>
                  {d
                    ? `${d.providerId}${d.enforce ? " · Enforced" : ""}`
                    : "Choose a model below"}
                </small>
              </article>
            );
          })}
          {(() => {
            const visionDefault = (auxiliaryDefaults ?? []).find((item) => item.purpose === "vision");
            return (
              <article data-status={visionDefault ? "good" : "warning"}>
                <span>Vision adapter</span>
                <strong>{visionDefault ? modelNames.get(`${visionDefault.providerId}:${visionDefault.model}`) ?? visionDefault.model : "Not set"}</strong>
                <small>{visionDefault ? `${visionDefault.providerId} · Used by text-only models` : "Choose a vision-capable model below"}</small>
              </article>
            );
          })()}
        </section>
        <Toolbar>
          <SearchInput
            label="Search models"
            value={query}
            onChange={setQuery}
            placeholder="Search models"
          />
          <FilterSelect
            label="Provider"
            value={provider}
            onChange={setProvider}
            options={[
              { value: "all", label: "All providers" },
              ...providers.map((p) => ({ value: String(p), label: String(p) })),
            ]}
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All status" },
              { value: "allowed", label: "Allowed" },
              { value: "blocked", label: "Blocked" },
            ]}
          />
        </Toolbar>
        {message ? <SuccessMessage>{message}</SuccessMessage> : null}
        <div className={detail ? "min-w-0" : undefined}>
          <AsyncState
            loading={false}
            error={null}
            onRetry={r.retry}
            empty={rows.length === 0}
          >
            <DataTable
              label="Model catalog"
              columns={["Model", "Provider", "Modes", "Policy", "Default"]}
              onRowSelect={setActive}
              activeRow={active}
              rowLabel={(i) => rows[i].model}
              rows={rows.map((m) => [
                <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                  <b>{m.displayName || m.model}</b>
                  <small>{m.model}</small>
                </span>,
                m.providerId,
                <span className="flex flex-wrap gap-1.5">
                  {(m.modeAllow ?? []).map((mode: string) => (
                    <StatusPill key={mode} tone="neutral">
                      {mode}
                    </StatusPill>
                  ))}
                </span>,
                <span className="flex flex-wrap gap-1.5">
                  <StatusPill tone={m.status === "allowed" ? "good" : "danger"}>
                    {humanize(m.status)}
                  </StatusPill>
                  {m.enforce ? (
                    <StatusPill tone="info">Enforced</StatusPill>
                  ) : null}
                </span>,
                isDefault(m, "chat") || isDefault(m, "code") ? (
                  <Check
                    aria-label="Default"
                    className="size-4 text-[var(--berry-accent)]"
                  />
                ) : (
                  "—"
                ),
              ])}
            />
          </AsyncState>
          {detail && draft ? (
            <DetailDrawer
              title={draft.displayName || draft.model}
              subtitle={draft.providerId}
              badge={
                <StatusPill
                  tone={draft.status === "allowed" ? "good" : "danger"}
                >
                  {humanize(draft.status)}
                </StatusPill>
              }
              onClose={() => setActive(null)}
              footer={
                canWrite ? (
                  <>
                    <Button variant="secondary" onClick={() => setActive(null)}>
                      Cancel
                    </Button>
                    <Button onClick={save}>
                      <Save aria-hidden />
                      Save policy
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Read-only — models:write required to edit.
                  </span>
                )
              }
            >
              <fieldset
                className="grid gap-3 border-0 p-0"
                disabled={!canWrite}
              >
                <legend>Policy</legend>
                <div
                  className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1"
                  role="group"
                  aria-label="Policy"
                >
                  <Button
                    variant="ghost"
                    type="button"
                    aria-selected={draft.status === "allowed"}
                    onClick={() => setDraft({ ...draft, status: "allowed" })}
                  >
                    Allowed
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    aria-selected={draft.status === "blocked"}
                    onClick={() => setDraft({ ...draft, status: "blocked" })}
                  >
                    Blocked
                  </Button>
                </div>
              </fieldset>
              <fieldset
                className="grid gap-3 border-0 p-0"
                disabled={!canWrite}
              >
                <legend>Available in</legend>
                {(["chat", "code"] as const).map((mode) => (
                  <label
                    key={mode}
                    className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm"
                  >
                    <span>{mode === "chat" ? "Chat" : "Code"}</span>
                    <ManagementSwitch
                      checked={(draft.modeAllow ?? []).includes(mode)}
                      onCheckedChange={(checked) => setMode(mode, checked)}
                      aria-label={`${mode} access`}
                    />
                  </label>
                ))}
              </fieldset>
              <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
                <span>
                  Enforce policy
                  <small>Members cannot override this policy.</small>
                </span>
                <ManagementSwitch
                  checked={Boolean(draft.enforce)}
                  disabled={!canWrite}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, enforce: checked })
                  }
                  aria-label="Enforce policy"
                />
              </label>
              <fieldset className="grid gap-3 border-0 p-0" disabled={!canWrite}>
                <legend>Pricing (USD per 1M tokens)</legend>
                <div className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:text-muted-foreground">
                  <label>Input<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.input ?? ""} onChange={(event) => setCost("input", event.currentTarget.value)} /></label>
                  <label>Output<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.output ?? ""} onChange={(event) => setCost("output", event.currentTarget.value)} /></label>
                  <label>Cache read<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.cacheRead ?? ""} onChange={(event) => setCost("cacheRead", event.currentTarget.value)} /></label>
                  <label>Cache write<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.cacheWrite ?? ""} onChange={(event) => setCost("cacheWrite", event.currentTarget.value)} /></label>
                </div>
              </fieldset>
              <fieldset className="grid gap-3 border-0 p-0" disabled={!canWrite}>
                <legend>Context limits</legend>
                <div className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:text-muted-foreground">
                  <label>Context window<Input type="number" min="1" step="1" value={draft.capabilities?.context?.windowTokens ?? ""} onChange={(event) => setContext("windowTokens", event.currentTarget.value)} /></label>
                  <label>Maximum output<Input type="number" min="1" step="1" value={draft.capabilities?.context?.maxOutputTokens ?? ""} onChange={(event) => setContext("maxOutputTokens", event.currentTarget.value)} /></label>
                </div>
              </fieldset>
              {draft.capabilities && Object.keys(draft.capabilities).length ? (
                <>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Capabilities
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(draft.capabilities)
                      .filter(([, v]) => v === true)
                      .map(([k]) => (
                        <StatusPill key={k} tone="neutral">
                          {humanize(k)}
                        </StatusPill>
                      ))}
                  </div>
                </>
              ) : null}
              {canWrite ? (
                <>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Make default
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => makeDefault("chat")}
                      disabled={isDefault(draft, "chat")}
                    >
                      Set as Chat default
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => makeDefault("code")}
                      disabled={isDefault(draft, "code")}
                    >
                      Set as Code default
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={makeVisionDefault}
                      disabled={draft.capabilities?.vision !== true
                        || (auxiliaryDefaults ?? []).some((item) => item.purpose === "vision" && item.providerId === draft.providerId && item.model === draft.model)}
                    >
                      Set as vision model
                    </Button>
                  </div>
                  {draft.capabilities?.vision !== true ? (
                    <p className="text-xs text-muted-foreground">
                      Vision defaults must explicitly declare image-input support.
                    </p>
                  ) : null}
                </>
              ) : null}
            </DetailDrawer>
          ) : null}
        </div>
        <Section
          title="Scoped model access"
          description="Organization blocks are absolute. A member exception can override their primary department default only when the organization policy permits the model."
        >
          <DataTable
            label="Scoped model access rules"
            columns={["Model", "Scope", "Target", "Effect", "Updated"]}
            rows={(accessRules ?? []).filter((rule) => rule.resourceType === "model").map((rule) => [
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"><b>{modelNames.get(rule.resourceId) ?? rule.resourceId}</b><small>{rule.resourceId}</small></span>,
              humanize(rule.scopeType),
              rule.scopeType === "org"
                ? "Entire organization"
                : rule.scopeType === "department"
                  ? departmentNames.get(rule.scopeId) ?? rule.scopeId
                  : memberNames.get(rule.scopeId) ?? rule.scopeId,
              <StatusPill tone={rule.effect === "allowed" ? "good" : "danger"}>{humanize(rule.effect)}</StatusPill>,
              formatDate(rule.updatedAt),
            ])}
          />
        </Section>
      </AsyncState>
      <ManagementDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add model"
        description="Register a model identifier and the pricing Berry will use for cost estimates and usage reporting."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="add-model-form"><Save />Add model</Button></>}
      >
        <form id="add-model-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={addModel}>
          <label>Provider<FormSelect name="providerId" options={providers.map((item) => ({ value: String(item), label: String(item) }))} required /></label>
          <label>Model ID<Input name="model" placeholder="gpt-5.4" autoFocus required /></label>
          <label>Display name<Input name="displayName" placeholder="GPT-5.4" /></label>
          <label>API protocol<FormSelect name="apiType" defaultValue="openai-chat-completions" options={[{ value: "openai-chat-completions", label: "OpenAI chat completions" }, { value: "openai-responses", label: "OpenAI responses" }, { value: "anthropic-messages", label: "Anthropic messages" }]} /></label>
          <label>Input price / 1M tokens<Input name="inputPrice" type="number" min="0" step="0.0001" /></label>
          <label>Output price / 1M tokens<Input name="outputPrice" type="number" min="0" step="0.0001" /></label>
          <label>Cache-read price / 1M<Input name="cacheReadPrice" type="number" min="0" step="0.0001" /></label>
          <label>Cache-write price / 1M<Input name="cacheWritePrice" type="number" min="0" step="0.0001" /></label>
          <label>Context window<Input name="contextWindow" type="number" min="1" step="1" /></label>
          <label>Maximum output<Input name="maxOutput" type="number" min="1" step="1" /></label>
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={addingRule}
        onOpenChange={setAddingRule}
        title="Add model access rule"
        description="Set the normal department policy or a specific member exception. Organization blocks remain the final ceiling."
        footer={<><Button type="button" variant="secondary" onClick={() => setAddingRule(false)}>Cancel</Button><Button type="submit" form="add-model-access-rule-form"><Save />Save rule</Button></>}
      >
        <form id="add-model-access-rule-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={addAccessRule}>
          <label className="sm:col-span-2">Model<FormSelect name="resourceId" options={(models ?? []).map((item) => ({ value: `${item.providerId}:${item.model}`, label: `${item.displayName || item.model} · ${item.providerId}` }))} required /></label>
          <label>Scope<FormSelect name="scopeType" value={ruleScope} onChange={(value) => setRuleScope(value as typeof ruleScope)} options={[{ value: "department", label: "Department default" }, { value: "user", label: "Member exception" }, { value: "org", label: "Organization ceiling" }]} /></label>
          {ruleScope === "org" ? (
            <label>Target<Input value="Entire organization" disabled /></label>
          ) : (
            <label>Target<FormSelect name="scopeId" options={(ruleScope === "department" ? departments : members).map((item) => ({ value: String(ruleScope === "department" ? item.id : item.userId), label: ruleScope === "department" ? String(item.name) : `${item.name || item.email} · ${item.email}` }))} required /></label>
          )}
          <label className="sm:col-span-2">Policy<FormSelect name="effect" defaultValue="blocked" options={[{ value: "allowed", label: "Allow" }, { value: "blocked", label: "Block" }]} /></label>
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}

/* ------------------------------------------------------------- skills & mcp */
function SkillsMcpScreen({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWriteSkills = permissions.includes("skills:write");
  const canWriteMcp = permissions.includes("mcp:write");
  const canWritePolicies = canWriteSkills && canWriteMcp;
  const r = useResource(
    `capabilities:${tenantId}`,
    async () => (client ? client.listOrganizationCapabilities(tenantId) : []),
    [] as any[],
  );
  const policy = useResource(
    `capability-policy:${tenantId}`,
    async () =>
      client
        ? client.organizationCapabilitySettings(tenantId)
        : { skills: true, mcp: true },
    { skills: true, mcp: true },
  );
  const [tab, setTab] = React.useState("skill");
  const [skillSource, setSkillSource] = React.useState<"upload" | "paste">("upload");
  const [query, setQuery] = React.useState("");
  const [assignment, setAssignment] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [review, setReview] = React.useState<PersonalSkillReview | null>(null);
  const [importError, setImportError] = React.useState("");
  const [skillDraft, setSkillDraft] = React.useState({
    content: "",
    packageFiles: [] as string[],
    fileName: "",
    assignment: "default-on" as OrgCapabilityAssignment,
    allowUserDisable: true,
  });
  const [mcpDraft, setMcpDraft] = React.useState({
    name: "",
    description: "",
    url: "",
    assignment: "available" as OrgCapabilityAssignment,
    allowUserDisable: true,
  });
  const canWrite = tab === "skill" ? canWriteSkills : canWriteMcp;
  const scoped = r.data.filter((c: any) => c.kind === tab);
  const rows = scoped.filter(
    (c: any) =>
      `${c.name} ${c.capabilityId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (assignment === "all" || c.assignment === assignment),
  );
  const detail = active != null ? rows[active] : null;
  const counts = (value: string) =>
    r.data.filter((c: any) => c.assignment === value).length;
  const assignmentTone = (value: string) =>
    value === "required"
      ? "info"
      : value === "blocked"
        ? "danger"
        : value === "default-on"
          ? "good"
          : "neutral";
  const setAllowDisable = async (capability: any, allow: boolean) => {
    await client?.upsertOrganizationCapability(tenantId, {
      kind: capability.kind,
      capabilityId: capability.capabilityId,
      name: capability.name,
      description: capability.description,
      assignment: capability.assignment,
      allowUserDisable: allow,
    });
    r.setData(
      r.data.map((c: any) =>
        c.id === capability.id ? { ...c, allowUserDisable: allow } : c,
      ),
    );
    setMessage("Capability updated and recorded in the audit log.");
  };
  const setAssignmentValue = async (capability: any, value: string) => {
    await client?.upsertOrganizationCapability(tenantId, {
      kind: capability.kind,
      capabilityId: capability.capabilityId,
      name: capability.name,
      description: capability.description,
      assignment: value as any,
      allowUserDisable: capability.allowUserDisable,
    });
    r.setData(
      r.data.map((c: any) =>
        c.id === capability.id ? { ...c, assignment: value } : c,
      ),
    );
    setMessage("Capability assignment updated and recorded in the audit log.");
  };
  const reviewSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!client) return;
    setImportError("");
    try {
      setReview(
        await client.reviewOrganizationSkill(tenantId, {
          content: skillDraft.content,
          source: skillDraft.fileName ? "upload" : "text",
          packageFiles: skillDraft.packageFiles,
        }),
      );
    } catch (cause) {
      setImportError(
        cause instanceof Error ? cause.message : "Skill review failed",
      );
    }
  };
  const selectSkillFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError("");
    setReview(null);
    try {
      const imported = await readBrowserSkillImport(file);
      setSkillDraft((current) => ({
        ...current,
        content: imported.content,
        packageFiles: imported.packageFiles,
        fileName: imported.fileName,
      }));
      setSkillSource("upload");
    } catch (cause) {
      setImportError(
        cause instanceof Error
          ? cause.message
          : "Could not read this skill package",
      );
    }
  };
  const saveSkill = async () => {
    if (!client || !review) return;
    const saved = await client.upsertOrganizationCapability(tenantId, {
      kind: "skill",
      capabilityId: review.name,
      name: review.name,
      description: review.description,
      assignment: skillDraft.assignment,
      allowUserDisable:
        skillDraft.assignment === "required" ||
        skillDraft.assignment === "blocked"
          ? false
          : skillDraft.allowUserDisable,
      contentHash: review.hash,
      config: { content: skillDraft.content },
    });
    r.setData([
      saved,
      ...r.data.filter(
        (item: any) =>
          !(
            item.kind === saved.kind && item.capabilityId === saved.capabilityId
          ),
      ),
    ]);
    setAdding(false);
    setReview(null);
    setSkillDraft({
      content: "",
      packageFiles: [],
      fileName: "",
      assignment: "default-on",
      allowUserDisable: true,
    });
    setMessage(`$${saved.name} is now available to the organization.`);
  };
  const saveMcp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    setImportError("");
    try {
      const url = new URL(mcpDraft.url);
      if (url.protocol !== "https:") throw new Error("Remote MCP servers must use HTTPS.");
      const capabilityId = `${mcpDraft.name}-${url.hostname}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
      const saved = await client.upsertOrganizationCapability(tenantId, {
        kind: "mcp",
        capabilityId,
        name: mcpDraft.name.trim(),
        description: mcpDraft.description.trim(),
        assignment: mcpDraft.assignment,
        allowUserDisable: mcpDraft.assignment === "required" || mcpDraft.assignment === "blocked" ? false : mcpDraft.allowUserDisable,
        config: { url: url.toString(), transport: "streamable-http" },
      });
      r.setData([saved, ...r.data.filter((item: any) => !(item.kind === saved.kind && item.capabilityId === saved.capabilityId))]);
      setAdding(false);
      setMcpDraft({ name: "", description: "", url: "", assignment: "available", allowUserDisable: true });
      setMessage(`${saved.name} MCP server is now available to the organization.`);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not add this MCP server.");
    }
  };
  const removeCapability = async (capability: any) => {
    if (!client) return;
    await client.deleteOrganizationCapability(tenantId, capability.id);
    r.setData(r.data.filter((item: any) => item.id !== capability.id));
    setActive(null);
    setMessage(`${capability.name} was removed from the organization catalog.`);
  };
  const updatePersonalPolicy = async (next: {
    skills: boolean;
    mcp: boolean;
  }) => {
    if (!client) return;
    policy.setData(
      await client.updateOrganizationCapabilitySettings(tenantId, next),
    );
    setMessage("Personal capability policy saved.");
  };
  return (
    <ManagementPage
      title="Skills & MCP"
      description="Choose organization capabilities and how they are assigned to members."
      eyebrow="AI controls"
      actions={
        canWrite ? (
          <Button
            onClick={() => {
              setAdding(true);
              setReview(null);
              setImportError("");
            }}
          >
            <Plus aria-hidden />
            {tab === "skill" ? "Add organization skill" : "Add MCP server"}
          </Button>
        ) : null
      }
    >
      <MetricGrid
        items={[
          {
            label: "Required",
            value: formatNumber(counts("required")),
            hint: "Cannot be disabled",
            status: "info" as any,
          },
          {
            label: "Default on",
            value: formatNumber(counts("default-on")),
            hint: "Enabled by default",
            status: "good",
          },
          {
            label: "Available",
            value: formatNumber(counts("available")),
            hint: "Can be enabled",
          },
          {
            label: "Blocked",
            value: formatNumber(counts("blocked")),
            hint: "Not available",
            status: "danger",
          },
        ]}
      />
      <TabBar
        label="Capability kind"
        active={tab}
        onSelect={(id) => {
          setTab(id);
          setActive(null);
        }}
        tabs={[
          { id: "skill", label: "Skills" },
          { id: "mcp", label: "MCP servers" },
        ]}
      />
      <ManagementDialog
        open={adding && tab === "skill"}
        onOpenChange={setAdding}
        title={review ? "Review organization skill" : "Add organization skill"}
        description={review ? "Confirm the reviewed package and organization assignment." : "Select one source, provide the skill, then review it before publishing."}
        size="lg"
        footer={!review ? <>
          <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          <Button type="submit" form="organization-skill-source-form"><ShieldCheck aria-hidden />Review skill</Button>
        </> : <>
          <Button type="button" variant="secondary" onClick={() => setReview(null)}>Back</Button>
          <Button type="button" onClick={() => void saveSkill()}><Check aria-hidden />Add to organization</Button>
        </>}
      >
        {!review ? (
          <form
            id="organization-skill-source-form"
            className="grid gap-4"
            onSubmit={reviewSkill}
          >
            <TabBar label="Skill source" active={skillSource} onSelect={(value) => setSkillSource(value as "upload" | "paste")} tabs={[{ id: "upload", label: "Upload package" }, { id: "paste", label: "Paste SKILL.md" }]} />
            {skillSource === "upload" ? (
              <label
                className="settings-skill-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void selectSkillFile(event.dataTransfer.files[0]);
                }}
              >
                <input type="file" accept=".skill,.zip,.md,text/markdown,application/zip" onChange={(event) => void selectSkillFile(event.currentTarget.files?.[0])} />
                <Upload aria-hidden />
                <span className="grid gap-0.5">
                  <b>{skillDraft.fileName || "Choose or drop a .skill package"}</b>
                  <small>.skill, .zip, or SKILL.md · up to 5 MB</small>
                </span>
              </label>
            ) : (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                SKILL.md content
                <Textarea
                  className="min-h-48 resize-y font-mono text-xs"
                  required
                  value={skillDraft.content}
                  placeholder="---\nname: example\ndescription: ...\n---"
                  onChange={(event) => setSkillDraft({ ...skillDraft, content: event.currentTarget.value, fileName: "", packageFiles: [] })}
                />
              </label>
            )}
            {importError ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="alert"
              >
                {importError}
              </div>
            ) : null}
          </form>
        ) : (
          <div className="grid gap-3 [&_dl]:grid [&_dl]:gap-3 sm:[&_dl]:grid-cols-3 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:text-sm">
            <dl>
              <div>
                <dt>Skill</dt>
                <dd>${review.name}</dd>
              </div>
              <div>
                <dt>Description</dt>
                <dd>{review.description}</dd>
              </div>
              <div>
                <dt>Content hash</dt>
                <dd>
                  <code>{review.hash}</code>
                </dd>
              </div>
              <div>
                <dt>Package</dt>
                <dd>
                  {review.resources.length
                    ? `${review.resources.length + 1} files`
                    : "SKILL.md only"}
                </dd>
              </div>
            </dl>
            {review.warnings.length ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="alert"
              >
                {review.warnings.join(" · ")}
              </div>
            ) : (
              <p className="flex items-center gap-2 rounded-lg border border-[var(--berry-success)]/25 bg-[var(--berry-success)]/5 px-3 py-2 text-xs text-[var(--berry-success)]">
                <Check aria-hidden />
                No review warnings found.
              </p>
            )}
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Assignment
              <FormSelect
                value={skillDraft.assignment}
                onChange={(assignment) =>
                  setSkillDraft({
                    ...skillDraft,
                    assignment: assignment as OrgCapabilityAssignment,
                  })
                }
                options={[
                  { value: "required", label: "Required" },
                  { value: "default-on", label: "Default on" },
                  { value: "available", label: "Available" },
                  { value: "blocked", label: "Blocked" },
                ]}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
              <span className="grid min-w-0 gap-0.5">
                Allow user disable
                <small className="text-xs font-normal text-muted-foreground">Members can turn off default-on skills.</small>
              </span>
              <ManagementSwitch
                checked={skillDraft.allowUserDisable}
                disabled={
                  skillDraft.assignment === "required" ||
                  skillDraft.assignment === "blocked"
                }
                onCheckedChange={(allowUserDisable) =>
                  setSkillDraft({ ...skillDraft, allowUserDisable })
                }
                aria-label="Allow user disable"
              />
            </label>
          </div>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={adding && tab === "mcp"}
        onOpenChange={setAdding}
        title="Add organization MCP server"
        description="Register a remote HTTPS MCP endpoint, then choose how it is assigned to members."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="organization-mcp-form"><Plus aria-hidden />Add MCP server</Button></>}
      >
        <form id="organization-mcp-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={saveMcp}>
          <label>Name<Input required autoFocus value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.currentTarget.value })} placeholder="Company knowledge" /></label>
          <label>Assignment<FormSelect value={mcpDraft.assignment} onChange={(assignment) => setMcpDraft({ ...mcpDraft, assignment: assignment as OrgCapabilityAssignment })} options={[{ value: "required", label: "Required" }, { value: "default-on", label: "Default on" }, { value: "available", label: "Available" }, { value: "blocked", label: "Blocked" }]} /></label>
          <label className="sm:col-span-2">Remote MCP URL<Input required type="url" value={mcpDraft.url} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.currentTarget.value })} placeholder="https://mcp.example.com/mcp" /></label>
          <label className="sm:col-span-2">Description<Textarea className="min-h-24 resize-y" value={mcpDraft.description} onChange={(event) => setMcpDraft({ ...mcpDraft, description: event.currentTarget.value })} /></label>
          <label className="sm:col-span-2 flex-row items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm text-foreground">
            <span className="grid gap-0.5">Allow member disable<small className="text-xs font-normal text-muted-foreground">Members can turn off this server unless it is required.</small></span>
            <ManagementSwitch checked={mcpDraft.allowUserDisable} disabled={mcpDraft.assignment === "required" || mcpDraft.assignment === "blocked"} onCheckedChange={(allowUserDisable) => setMcpDraft({ ...mcpDraft, allowUserDisable })} aria-label="Allow member disable" />
          </label>
          {importError ? <p className="sm:col-span-2 text-xs text-destructive" role="alert">{importError}</p> : null}
        </form>
      </ManagementDialog>
      <Section
        title="Personal additions"
        description="Control whether members can add their own capabilities."
      >
        <div className="grid gap-2">
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="grid min-w-0 gap-0.5">
              Personal skills
              <small className="text-xs font-normal text-muted-foreground">Members can import and manage their own skills.</small>
            </span>
            <ManagementSwitch
              checked={policy.data.skills}
              disabled={!canWritePolicies}
              onCheckedChange={(skills) =>
                void updatePersonalPolicy({ ...policy.data, skills })
              }
              aria-label="Allow personal skills"
            />
          </label>
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="grid min-w-0 gap-0.5">
              Personal MCP servers
              <small className="text-xs font-normal text-muted-foreground">Members can add their own remote MCP servers.</small>
            </span>
            <ManagementSwitch
              checked={policy.data.mcp}
              disabled={!canWritePolicies}
              onCheckedChange={(mcp) =>
                void updatePersonalPolicy({ ...policy.data, mcp })
              }
              aria-label="Allow personal MCP servers"
            />
          </label>
        </div>
      </Section>
      <Toolbar>
        <SearchInput
          label="Search capabilities"
          value={query}
          onChange={setQuery}
          placeholder="Search capabilities"
        />
        <FilterSelect
          label="Assignment"
          value={assignment}
          onChange={setAssignment}
          options={[
            { value: "all", label: "All" },
            { value: "required", label: "Required" },
            { value: "default-on", label: "Default on" },
            { value: "available", label: "Available" },
            { value: "blocked", label: "Blocked" },
          ]}
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
          emptyTitle="No organization capabilities"
          emptyText="Skills and MCP servers assigned to the organization will appear here."
        >
          <DataTable
            label="Organization capabilities"
            columns={["Capability", "Assignment", "User override", "Managed"]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => rows[i].name}
            rows={rows.map((c: any) => [
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{c.name}</b>
                <small>{c.capabilityId}</small>
              </span>,
              <StatusPill tone={assignmentTone(c.assignment) as any}>
                {humanize(c.assignment)}
              </StatusPill>,
              c.allowUserDisable ? "Allowed" : "Not allowed",
              c.contentHash ? "Signed" : "Unsigned",
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={detail.name}
            subtitle={detail.capabilityId}
            badge={
              <StatusPill tone={assignmentTone(detail.assignment) as any}>
                {humanize(detail.assignment)}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            {detail.description ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {detail.description}
              </p>
            ) : null}
            <DefinitionList
              items={[
                {
                  term: "Type",
                  detail: detail.kind === "skill" ? "Skill" : "MCP server",
                },
                {
                  term: "Content hash",
                  detail: detail.contentHash ? (
                    <code className="inline-flex items-center gap-1 font-mono text-xs">
                      {detail.contentHash.slice(0, 20)}…
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => copyText(detail.contentHash)}
                        aria-label="Copy hash"
                      >
                        <Copy aria-hidden />
                      </Button>
                    </code>
                  ) : (
                    "Unsigned"
                  ),
                },
                { term: "Updated", detail: formatDateTime(detail.updatedAt) },
              ]}
            />
            <fieldset className="grid gap-3 border-0 p-0" disabled={!canWrite}>
              <legend>Assignment</legend>
              <FilterSelect
                label="Assignment"
                value={detail.assignment}
                onChange={(v) => setAssignmentValue(detail, v)}
                options={[
                  { value: "required", label: "Required" },
                  { value: "default-on", label: "Default on" },
                  { value: "available", label: "Available" },
                  { value: "blocked", label: "Blocked" },
                ]}
              />
            </fieldset>
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
              <span className="grid min-w-0 gap-0.5">
                Allow user disable
                <small className="text-xs font-normal text-muted-foreground">Members can turn this off for themselves.</small>
              </span>
              <ManagementSwitch
                checked={Boolean(detail.allowUserDisable)}
                disabled={!canWrite || detail.assignment === "required"}
                onCheckedChange={(checked) => setAllowDisable(detail, checked)}
                aria-label="Allow user disable"
              />
            </label>
            {canWrite ? (
              <Button
                variant="secondary"
                onClick={() => void removeCapability(detail)}
              >
                <Trash2 aria-hidden />
                Remove capability
              </Button>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* ----------------------------------------------------------- feature access */
function FeatureAccessScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("feature_flags:write");
  const r = useResource(
    `features:${tenantId}`,
    async () =>
      client
        ? client.listFeatureFlags(tenantId)
        : config.featureFlags.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const rows = r.data.filter((f: any) =>
    humanize(f.flag).toLowerCase().includes(query.toLowerCase()),
  );
  const detail = active != null ? rows[active] : null;
  const setEnabled = async (flag: any, enabled: boolean) => {
    await client?.upsertFeatureFlag(tenantId, flag.flag, {
      enabled,
      roleDefaults: flag.roleDefaults,
    });
    r.setData(
      r.data.map((f: any) =>
        f.flag === flag.flag
          ? { ...f, enabled, updatedAt: new Date().toISOString() }
          : f,
      ),
    );
    setMessage(
      `Feature “${humanize(flag.flag)}” turned ${enabled ? "on" : "off"} and recorded in the audit log.`,
    );
  };
  return (
    <ManagementPage
      title="Feature access"
      description="Roll features out across the organization and refine access by role."
      eyebrow="AI controls"
    >
      <Toolbar>
        <SearchInput
          label="Search features"
          value={query}
          onChange={setQuery}
          placeholder="Search features"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
        >
          <DataTable
            label="Feature access"
            columns={[
              "Feature",
              "Organization default",
              "Role overrides",
              "Updated",
            ]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => humanize(rows[i].flag)}
            rows={rows.map((f: any) => [
              <b>{humanize(f.flag)}</b>,
              <StatusPill tone={f.enabled ? "good" : "neutral"}>
                {f.enabled ? "On" : "Off"}
              </StatusPill>,
              formatNumber(Object.keys(f.roleDefaults ?? {}).length),
              formatDate(f.updatedAt),
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={humanize(detail.flag)}
            subtitle={detail.flag}
            badge={
              <StatusPill tone={detail.enabled ? "good" : "neutral"}>
                {detail.enabled ? "On" : "Off"}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
              <span>
                Organization default
                <small>Turn this feature on for the whole organization.</small>
              </span>
              <ManagementSwitch
                checked={Boolean(detail.enabled)}
                disabled={!canWrite}
                onCheckedChange={(checked) => setEnabled(detail, checked)}
                aria-label="Organization default"
              />
            </label>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Role overrides
            </h3>
            {Object.keys(detail.roleDefaults ?? {}).length ? (
              <DefinitionList
                items={Object.entries(detail.roleDefaults).map(
                  ([role, perms]) => ({
                    term: humanize(role),
                    detail: (perms as string[]).join(", ") || "—",
                  }),
                )}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                No role overrides. All roles inherit the organization default.
              </p>
            )}
            {!canWrite ? (
              <p className="text-xs text-muted-foreground">
                Read-only — feature_flags:write required to edit.
              </p>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* --------------------------------------------------------------- sso & scim */
function SsoScimScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("sso:write");
  const r = useResource(
    `sso:${tenantId}`,
    async () =>
      client
        ? client.listSsoConnections(tenantId)
        : config.ssoConnections.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [active, setActive] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [callbackUrl, setCallbackUrl] = React.useState(
    "https://ai.aesg.com/v1/auth/callback/google",
  );
  React.useEffect(() => {
    setCallbackUrl(`${window.location.origin}/v1/auth/callback/google`);
  }, []);
  const detail = active != null ? r.data[active] : null;
  const enabledCount = r.data.filter((c: any) => c.status === "enabled").length;
  const googleConnection = r.data.find((c: any) => c.provider === "google");
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      kind: "oidc" as const,
      provider: "google",
      slug: googleConnection?.slug ?? "google-workspace",
      displayName: "Google Workspace",
      status: form.get("enabled") === "on" ? ("enabled" as const) : ("disabled" as const),
      issuer: "https://accounts.google.com",
      clientId: String(form.get("clientId")).trim(),
      clientSecret: String(form.get("clientSecret")).trim() || undefined,
      domains: [String(form.get("domain")).trim().toLowerCase()],
      jitProvisioning: form.get("jitProvisioning") === "on",
      defaultRole: "member" as const,
      scimEnabled: false,
    };
    setError("");
    try {
      const saved = await client?.createSsoConnection(tenantId, input);
      const next = saved ?? {
        id: googleConnection?.id ?? crypto.randomUUID(),
        tenantId,
        clientSecretConfigured: Boolean(input.clientSecret) || googleConnection?.clientSecretConfigured === true,
        ssoUrl: null,
        metadataUrl: null,
        entityId: null,
        createdAt: googleConnection?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...input,
      };
      r.setData([next, ...r.data.filter((connection: any) => connection.id !== next.id)]);
      setAdding(false);
      setMessage(input.status === "enabled" ? "Google Workspace sign-in is enabled." : "Google Workspace settings saved. Sign-in remains disabled.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save Google Workspace SSO.");
    }
  };
  return (
    <ManagementPage
      title="SSO & SCIM"
      description="Let AESG staff sign in with Google Workspace while keeping local password accounts available."
      eyebrow="Security & data"
      actions={
        canWrite ? (
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {googleConnection ? "Configure Google" : "Set up Google"}
          </Button>
        ) : null
      }
    >
      <MetricGrid
        items={[
          { label: "Connections", value: formatNumber(r.data.length) },
          {
            label: "Enabled",
            value: formatNumber(enabledCount),
            status: enabledCount ? "good" : "warning",
          },
          {
            label: "Provisioning",
            value: "JIT now · SCIM later",
          },
        ]}
      />
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={adding}
        onOpenChange={setAdding}
        title="Configure Google Workspace"
        description="Use a dedicated Google OAuth web client. Berry requests only OpenID, email, and profile for sign-in."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-sso-connection-form">
              <Save data-icon="inline-start" aria-hidden />
              Save settings
            </Button>
          </>
        }
      >
        <form
          id="create-sso-connection-form"
          className="grid gap-3 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Authorized redirect URI
            <div className="flex gap-2">
              <Input value={callbackUrl} readOnly />
              <Button type="button" variant="secondary" onClick={() => copyText(callbackUrl)} aria-label="Copy redirect URI">
                <Copy data-icon="inline-start" aria-hidden />
              </Button>
            </div>
          </label>
          <label>
            Google OAuth client ID
            <Input name="clientId" defaultValue={googleConnection?.clientId ?? ""} autoComplete="off" autoFocus required placeholder="123456.apps.googleusercontent.com" />
          </label>
          <label>
            Google OAuth client secret
            <Input name="clientSecret" type="password" autoComplete="new-password" required={!googleConnection?.clientSecretConfigured} placeholder={googleConnection?.clientSecretConfigured ? "Leave blank to keep the saved secret" : "GOCSPX-…"} />
          </label>
          <label>
            Workspace hosted domain
            <Input name="domain" defaultValue={googleConnection?.domains?.[0] ?? "aesg.com"} required placeholder="aesg.com" />
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Checkbox name="jitProvisioning" defaultChecked={googleConnection?.jitProvisioning ?? true} />
            <span><b className="block text-foreground">Create members on first sign-in</b>New Google users join as members. Existing accounts link by verified email.</span>
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Checkbox name="enabled" defaultChecked={googleConnection?.status === "enabled"} />
            <span><b className="block text-foreground">Enable Google sign-in</b>The button appears on the login screen for everyone.</span>
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </form>
      </ManagementDialog>
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={r.data.length === 0}
          emptyTitle="No identity connections"
          emptyText="Set up the AESG Google Workspace OAuth client to enable enterprise sign-in."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {r.data.map((connection: any, index: number) => (
              <Button
                key={connection.id}
                type="button"
                variant="ghost"
                className="grid h-auto gap-3 rounded-xl border border-border p-3 text-left"
                aria-current={active === index ? "true" : undefined}
                onClick={() => setActive(index)}
              >
                <div className="flex items-center justify-between gap-3 text-sm font-medium">
                  <b>{connection.displayName}</b>
                  <StatusPill
                    tone={
                      connection.status === "enabled"
                        ? "good"
                        : connection.status === "disabled"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {humanize(connection.status)}
                  </StatusPill>
                </div>
                <dl className="grid grid-cols-3 gap-2 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:truncate [&_dd]:text-xs">
                  <div>
                    <dt>Sign-in</dt>
                    <dd>{connection.kind.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>Provisioning</dt>
                    <dd>{connection.jitProvisioning ? "JIT" : "Existing users"}</dd>
                  </div>
                  <div>
                    <dt>Domains</dt>
                    <dd>{connection.domains.join(", ") || "—"}</dd>
                  </div>
                </dl>
              </Button>
            ))}
          </div>
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={detail.displayName}
            subtitle={detail.kind.toUpperCase()}
            badge={
              <StatusPill
                tone={
                  detail.status === "enabled"
                    ? "good"
                    : detail.status === "disabled"
                      ? "danger"
                      : "warning"
                }
              >
                {humanize(detail.status)}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            <DefinitionList
              items={[
                { term: "Slug", detail: detail.slug },
                { term: "Provider", detail: humanize(detail.provider ?? "generic") },
                {
                  term: "Sign-in",
                  detail: detail.kind === "oidc" ? "OIDC" : "SAML 2.0",
                },
                { term: "Issuer", detail: detail.issuer ?? "Not configured" },
                {
                  term: "New members",
                  detail: detail.jitProvisioning ? "Created on first sign-in" : "Must already exist",
                },
                { term: "Client secret", detail: detail.clientSecretConfigured ? "Encrypted and saved" : "Missing" },
                {
                  term: "Verified domains",
                  detail: detail.domains.join(", ") || "—",
                },
                { term: "Updated", detail: formatDateTime(detail.updatedAt) },
                { term: "SCIM", detail: "Reserved for a future release" },
              ]}
            />
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* --------------------------------------------------------- managed policy */
function ManagedPolicyScreen({
  client,
  config,
  tenantId,
}: ManagementScreenProps) {
  const r = useResource(
    `policy:${tenantId}`,
    async () =>
      client
        ? client.listPolicyVersions(tenantId)
        : config.policyVersions.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [active, setActive] = React.useState<number | null>(null);
  const versions = [...r.data].sort((a: any, b: any) => b.version - a.version);
  const current =
    versions.find((v: any) => v.status === "active") ?? versions[0] ?? null;
  const detail = active != null ? versions[active] : null;
  const locksOf = (v: any) =>
    v?.bundle?.policy
      ? Object.keys(v.bundle.policy).filter((k) => v.bundle.policy[k])
      : (v?.locks ?? []);
  return (
    <ManagementPage
      title="Managed policy"
      description="Signed policy bundles that lock client behavior across the organization."
      eyebrow="Security & data"
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={versions.length === 0}
        emptyTitle="No managed policy"
        emptyText="Published policy bundles will appear here."
      >
        {current ? (
          <Section title="Current policy">
            <MetricGrid
              items={[
                {
                  label: "Version",
                  value: `v${current.version}`,
                  status: current.status === "active" ? "good" : "warning",
                },
                {
                  label: "Status",
                  value: humanize(current.status),
                  status:
                    current.status === "active"
                      ? "good"
                      : current.status === "revoked"
                        ? "danger"
                        : "warning",
                },
                { label: "Signing key", value: current.keyId ?? "—" },
                {
                  label: "Published",
                  value: formatDate(current.publishedAt ?? current.createdAt),
                },
              ]}
            />
          </Section>
        ) : null}
        <div className={detail ? "min-w-0" : undefined}>
          <Section title="Versions">
            <DataTable
              label="Policy versions"
              columns={[
                "Version",
                "Status",
                "Signing key",
                "Published",
                "Note",
              ]}
              onRowSelect={setActive}
              activeRow={active}
              rowLabel={(i) => `Version ${versions[i].version}`}
              rows={versions.map((v: any) => [
                <b>v{v.version}</b>,
                <StatusPill
                  tone={
                    v.status === "active"
                      ? "good"
                      : v.status === "revoked"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {humanize(v.status)}
                </StatusPill>,
                v.keyId ?? "—",
                formatDateTime(v.publishedAt ?? v.createdAt),
                v.note ?? "—",
              ])}
            />
          </Section>
          {detail ? (
            <DetailDrawer
              title={`Version ${detail.version}`}
              badge={
                <StatusPill
                  tone={
                    detail.status === "active"
                      ? "good"
                      : detail.status === "revoked"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {humanize(detail.status)}
                </StatusPill>
              }
              onClose={() => setActive(null)}
            >
              <DefinitionList
                items={[
                  {
                    term: "Bundle hash",
                    detail: detail.bundleHash ? (
                      <code className="inline-flex items-center gap-1 font-mono text-xs">
                        {detail.bundleHash.slice(0, 24)}…
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => copyText(detail.bundleHash)}
                          aria-label="Copy hash"
                        >
                          <Copy aria-hidden />
                        </Button>
                      </code>
                    ) : (
                      "—"
                    ),
                  },
                  { term: "Signing key", detail: detail.keyId ?? "—" },
                  {
                    term: "Published",
                    detail: formatDateTime(
                      detail.publishedAt ?? detail.createdAt,
                    ),
                  },
                  {
                    term: "Published by",
                    detail: detail.publishedBy ?? "System",
                  },
                  ...(detail.revokedAt
                    ? [
                        {
                          term: "Revoked",
                          detail: formatDateTime(detail.revokedAt),
                        },
                      ]
                    : []),
                ]}
              />
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Locks enforced
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {locksOf(detail).length ? (
                  locksOf(detail).map((lock: string) => (
                    <StatusPill key={lock} tone="info">
                      {humanize(lock)}
                    </StatusPill>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No locks
                  </span>
                )}
              </div>
              {detail.bundlePath ? (
                <>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Bundle
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {detail.bundlePath}
                  </p>
                </>
              ) : null}
            </DetailDrawer>
          ) : null}
        </div>
      </AsyncState>
    </ManagementPage>
  );
}

/* -------------------------------------------------------------- audit log */
function AuditLogScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const r = useResource(
    `audit:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listAuditEvents(tenantId, { limit: 100 }),
            permissions.includes("members:read") ? client.listOrgMembers(tenantId) : Promise.resolve([]),
          ])
        : [config.auditEvents.filter((x) => x.tenantId === tenantId), []],
    [[], []] as any,
  );
  const [events, members]: [any[], any[]] = r.data;
  const memberById = new Map((members ?? []).map((member) => [member.userId, member]));
  const actorLabel = (actorUserId: string | null) => {
    if (!actorUserId) return "System";
    const member = memberById.get(actorUserId);
    return member ? member.name || member.email : actorUserId;
  };
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const categories = [...new Set(events.map((x: any) => x.category))];
  const rows = events.filter(
    (x: any) =>
      `${x.action} ${x.category} ${actorLabel(x.actorUserId)} ${memberById.get(x.actorUserId)?.email ?? ""} ${x.targetId ?? ""} ${x.workspaceId ?? ""} ${x.taskId ?? ""} ${x.sessionId ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (category === "all" || x.category === category),
  );
  const detail = active != null ? rows[active] : null;
  const exportCsv = () => {
    const header = [
      "sequence",
      "ts",
      "actorName",
      "actorUserId",
      "category",
      "action",
      "targetType",
      "targetId",
    ];
    const body = rows.map((x: any) =>
      [
        x.sequence,
        x.ts ?? x.createdAt,
        actorLabel(x.actorUserId),
        x.actorUserId ?? "system",
        x.category,
        x.action,
        x.targetType ?? "",
        x.targetId ?? "",
      ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","),
    );
    const csv = [header.join(","), ...body].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "audit-log.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <ManagementPage
      title="Audit log"
      description="Tamper-evident administration activity with a verifiable hash chain."
      eyebrow="Security & data"
      actions={
        <Button variant="secondary" onClick={exportCsv}>
          <Download aria-hidden />
          Export
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search audit events"
          value={query}
          onChange={setQuery}
          placeholder="Search action, actor, or target"
        />
        <FilterSelect
          label="Category"
          value={category}
          onChange={setCategory}
          options={[
            { value: "all", label: "All categories" },
            ...categories.map((c) => ({
              value: String(c),
              label: humanize(String(c)),
            })),
          ]}
        />
      </Toolbar>
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
        >
          <DataTable
            label="Audit events"
            columns={["Time", "Actor", "Category", "Action", "Target", "Context", "Sequence"]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => `${rows[i].category} ${rows[i].action}`}
            rows={rows.map((x: any) => [
              formatDateTime(x.ts ?? x.createdAt),
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"><b>{actorLabel(x.actorUserId)}</b><small>{memberById.get(x.actorUserId)?.email ?? x.actorUserId ?? "Service initiated"}</small></span>,
              humanize(x.category),
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{humanize(x.action)}</b>
                <small>
                  {x.category}.{x.action}
                </small>
              </span>,
              x.targetId
                ? `${humanize(x.targetType ?? "")}: ${x.targetId}`
                : "—",
              x.workspaceId ? `Workspace ${x.workspaceId}` : x.taskId ? `Task ${x.taskId}` : x.sessionId ? `Session ${x.sessionId}` : "Organization",
              <code>#{x.sequence}</code>,
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={humanize(detail.action)}
            subtitle={`${detail.category}.${detail.action}`}
            badge={<code>#{detail.sequence}</code>}
            onClose={() => setActive(null)}
          >
            <DefinitionList
              items={[
                {
                  term: "Time",
                  detail: formatDateTime(detail.ts ?? detail.createdAt),
                },
                { term: "Actor", detail: actorLabel(detail.actorUserId) },
                { term: "Actor ID", detail: detail.actorUserId ?? "System" },
                {
                  term: "Target",
                  detail: detail.targetId
                    ? `${humanize(detail.targetType ?? "")}: ${detail.targetId}`
                    : "—",
                },
                { term: "Event ID", detail: detail.id },
                { term: "Workspace", detail: detail.workspaceId ?? "—" },
                { term: "Task", detail: detail.taskId ?? "—" },
                { term: "Session", detail: detail.sessionId ?? "—" },
                { term: "Retained until", detail: formatDateTime(detail.expiresAt) },
              ]}
            />
            {detail.before || detail.after ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Change
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 [&>div]:min-w-0 [&>div]:rounded-lg [&>div]:border [&>div]:border-border [&>div]:bg-muted/30 [&>div]:p-2 [&_span]:mb-1 [&_span]:block [&_span]:text-xs [&_span]:font-semibold [&_span]:uppercase [&_span]:text-muted-foreground [&_pre]:max-h-52 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:font-mono [&_pre]:text-xs">
                  <div>
                    <span>Before</span>
                    <pre>{JSON.stringify(detail.before ?? null, null, 2)}</pre>
                  </div>
                  <div>
                    <span>After</span>
                    <pre>{JSON.stringify(detail.after ?? null, null, 2)}</pre>
                  </div>
                </div>
              </>
            ) : null}
            {detail.metadata && Object.keys(detail.metadata).length ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Metadata
                </h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-transparent font-mono text-xs leading-5 text-muted-foreground">
                  {JSON.stringify(detail.metadata, null, 2)}
                </pre>
              </>
            ) : null}
            {detail.eventHash ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Hash chain
                </h3>
                <DefinitionList
                  items={[
                    {
                      term: "Previous hash",
                      detail: (
                        <code className="inline-flex items-center gap-1 font-mono text-xs">
                          <span className="break-all">{String(detail.previousHash ?? "—")}</span>
                        </code>
                      ),
                    },
                    {
                      term: "Event hash",
                      detail: (
                        <code className="inline-flex items-center gap-1 font-mono text-xs">
                          <span className="break-all">{String(detail.eventHash)}</span>
                        </code>
                      ),
                    },
                  ]}
                />
              </>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* ------------------------------------------------------------- dispatcher */
const PERMISSION_FOR: Record<string, OrgPermission> = {
  roles: "rbac:read",
  "resource-access": "acl:read",
  providers: "models:read",
  models: "models:read",
  "skills-mcp": "org:read",
  "feature-access": "feature_flags:read",
  "sso-scim": "sso:read",
  "managed-policy": "policy:read",
  "audit-log": "audit:read",
};
export function AdminCatalogScreen({
  tab,
  ...props
}: ManagementScreenProps & { tab: string }) {
  const required = PERMISSION_FOR[tab];
  if (required && !props.permissions.includes(required))
    return <PermissionDenied label={humanize(tab)} />;
  switch (tab) {
    case "roles":
      return <RolesScreen {...props} />;
    case "resource-access":
      return <ResourceAccessScreen {...props} />;
    case "providers":
      return <ProvidersScreen {...props} />;
    case "models":
      return <ModelsScreen {...props} />;
    case "skills-mcp":
      return <SkillsMcpScreen {...props} />;
    case "feature-access":
      return <FeatureAccessScreen {...props} />;
    case "sso-scim":
      return <SsoScimScreen {...props} />;
    case "managed-policy":
      return <ManagedPolicyScreen {...props} />;
    case "audit-log":
      return <AuditLogScreen {...props} />;
    default:
      return <PermissionDenied label={humanize(tab)} />;
  }
}
