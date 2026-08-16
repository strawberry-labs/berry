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
  ORGANIZATION_SKILL_PACKAGE_MAX_BYTES,
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

export async function saveNewTaskDefaultSafely<T>(
  save: () => T | Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await save() };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message
          : "Could not save the default model. Try again.",
    };
  }
}

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
function formatPackageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------- roles */
export function AdminModelsScreen({
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
            client.listOrgTaskModels(tenantId, { includeBlocked: true }),
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
  const [newTaskDefaultKey, setNewTaskDefaultKey] = React.useState("");
  const [savingNewTaskDefault, setSavingNewTaskDefault] = React.useState(false);
  const [newTaskDefaultError, setNewTaskDefaultError] = React.useState("");
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
      detail ? { ...detail } : null,
    );
    setMessage("");
  }, [active, r.data]);
  const currentNewTaskDefault = (defaults ?? []).find((d) => d.mode === "chat") ?? defaults?.[0];
  const currentNewTaskDefaultKey = currentNewTaskDefault
    ? `${currentNewTaskDefault.providerId}:${currentNewTaskDefault.model}`
    : "";
  const newTaskModelOptions = (models ?? [])
    .filter((item) => item.status === "allowed" && (item.modeAllow ?? ["chat"]).length > 0)
    .map((item) => ({
      value: `${item.providerId}:${item.model}`,
      label: `${item.displayName || item.model} · ${item.providerId}`,
    }));
  React.useEffect(() => {
    setNewTaskDefaultKey(currentNewTaskDefaultKey);
  }, [currentNewTaskDefaultKey]);
  const isTaskDefault = (m: any) =>
    currentNewTaskDefault && currentNewTaskDefault.model === m.model && currentNewTaskDefault.providerId === m.providerId;
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
    await client?.upsertOrgTaskModelPolicy(tenantId, {
      providerId: draft.providerId,
      model: draft.model,
      displayName: draft.displayName ?? null,
      status: draft.status,
      enforce: draft.enforce,
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
  const makeTaskDefault = async () => {
    if (!draft) return;
    const enforce = false;
    await client?.upsertOrgTaskDefault(tenantId, {
      providerId: draft.providerId,
      model: draft.model,
      enforce,
    });
    const next = [
      ...(defaults ?? []).filter((d) => d.mode !== "chat"),
      {
        tenantId,
        mode: "chat",
        providerId: draft.providerId,
        model: draft.model,
        enforce,
        updatedAt: new Date().toISOString(),
      },
    ];
    r.setData([models, next, auxiliaryDefaults, registeredProviders, accessRules, members, departments]);
    setMessage("Set as the task default and recorded in the audit log.");
  };
  const saveNewTaskDefault = async () => {
    const selected = (models ?? []).find(
      (item) => `${item.providerId}:${item.model}` === newTaskDefaultKey,
    );
    if (!selected) return;
    setSavingNewTaskDefault(true);
    setMessage("");
    setNewTaskDefaultError("");
    try {
      const result = await saveNewTaskDefaultSafely(() =>
        client?.upsertOrgTaskDefault(tenantId, {
          providerId: selected.providerId,
          model: selected.model,
          enforce: false,
        }),
      );
      if (!result.ok) {
        setNewTaskDefaultError(result.error);
        return;
      }
      const saved = result.value;
      const nextDefault = saved ?? {
        tenantId,
        mode: "chat",
        providerId: selected.providerId,
        model: selected.model,
        enforce: false,
        updatedAt: new Date().toISOString(),
      };
      r.setData([
        models,
        [...(defaults ?? []).filter((item) => item.mode !== "chat"), nextDefault],
        auxiliaryDefaults,
        registeredProviders,
        accessRules,
        members,
        departments,
      ]);
      setMessage("New tasks will now start with this model. Existing tasks were not changed.");
    } finally {
      setSavingNewTaskDefault(false);
    }
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
    await client?.upsertOrgTaskModelPolicy(tenantId, {
      providerId: String(form.get("providerId")),
      model: String(form.get("model")),
      displayName: String(form.get("displayName")) || null,
      apiType: String(form.get("apiType")) as any,
      status: "allowed",
      enforce: false,
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
      description="Choose the model new tasks start with, manage provider models, and control availability, pricing, and context limits."
      eyebrow="AI & tools"
      actions={canWrite ? <><Button variant="secondary" onClick={() => setAddingRule(true)}><ShieldCheck />Access rule</Button><Button onClick={() => setAdding(true)}><Plus />Add model</Button></> : null}
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        <Section
          title="Default model for new tasks"
          description="Use this to route new tasks to a healthy model during an outage. The choice is snapshotted when a task is created, so existing tasks keep their current model."
        >
          <div className="grid items-end gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Organization default
              <FormSelect
                value={newTaskDefaultKey}
                onChange={(value) => {
                  setNewTaskDefaultKey(value);
                  setNewTaskDefaultError("");
                }}
                options={newTaskModelOptions}
                placeholder="Choose a model"
                disabled={!canWrite || savingNewTaskDefault || newTaskModelOptions.length === 0}
                ariaLabel="Default model for new tasks"
              />
            </label>
            <Button
              onClick={() => void saveNewTaskDefault()}
              disabled={!canWrite || savingNewTaskDefault || !newTaskDefaultKey || newTaskDefaultKey === currentNewTaskDefaultKey}
            >
              <Save aria-hidden />
              {savingNewTaskDefault ? "Saving…" : "Save default"}
            </Button>
          </div>
          {newTaskDefaultError ? (
            <p className="text-xs text-[var(--berry-danger)]" role="alert">
              {newTaskDefaultError}
            </p>
          ) : null}
        </Section>
        <section
          className="grid gap-3 sm:grid-cols-2"
          aria-label="Model defaults"
        >
          <article data-status={currentNewTaskDefault ? "good" : "warning"}>
            <span>Default for tasks</span>
            <strong>{currentNewTaskDefault ? currentNewTaskDefault.model : "Not set"}</strong>
            <small>
              {currentNewTaskDefault
                ? `${currentNewTaskDefault.providerId}${currentNewTaskDefault.enforce ? " · Enforced" : ""}`
                : "Choose a model below"}
            </small>
          </article>
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
              columns={["Model", "Provider", "Policy", "Default"]}
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
                  <StatusPill tone={m.status === "allowed" ? "good" : "danger"}>
                    {humanize(m.status)}
                  </StatusPill>
                  {m.enforce ? (
                    <StatusPill tone="info">Enforced</StatusPill>
                  ) : null}
                </span>,
                isTaskDefault(m) ? (
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
                      onClick={() => void makeTaskDefault()}
                      disabled={isTaskDefault(draft)}
                    >
                      Set as task default
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
