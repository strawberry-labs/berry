import * as React from "react";
import { Plus, Save, ShieldCheck } from "lucide-react";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DetailDrawer,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  Num,
  Section,
  SegmentedControl,
  SettingList,
  SettingRow,
  StatusPill,
  SuccessMessage,
  formatDate,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { AdminModelsSkeleton } from "./management-screen-skeletons";

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

const API_OPTIONS = [
  { value: "openai-chat-completions", label: "OpenAI chat completions" },
  { value: "openai-responses", label: "OpenAI responses" },
  { value: "anthropic-messages", label: "Anthropic messages" },
];
const SCOPE_LABEL: Record<string, string> = { org: "Organization", department: "Department", user: "Member" };
const fieldLabel = "grid gap-1.5 text-xs font-medium text-muted-foreground";
const help = "text-xs font-normal leading-4";
const drawerHeading = "text-xs font-medium text-muted-foreground";
const pricePerMillion = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

function sentence(value: string) {
  const text = String(value ?? "").replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function shortId(value: string) {
  const text = String(value ?? "");
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}
const keyOf = (item: { providerId: string; model: string }) => `${item.providerId}:${item.model}`;
/** The editable part of a model policy, for change detection. */
function policyFingerprint(model: any) {
  return JSON.stringify([
    model?.status,
    Boolean(model?.enforce),
    model?.capabilities?.cost ?? {},
    model?.capabilities?.context ?? {},
  ]);
}

function PriceCell({ value }: { value: unknown }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return <span data-sort={-1} className="text-muted-foreground">—</span>;
  return <span data-sort={value} className="tabular-nums">{pricePerMillion.format(value)}</span>;
}

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
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<any>(null);
  const [message, setMessage] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [newTaskDefaultKey, setNewTaskDefaultKey] = React.useState("");
  const [savingNewTaskDefault, setSavingNewTaskDefault] = React.useState(false);
  const [newTaskDefaultError, setNewTaskDefaultError] = React.useState("");
  const [visionKey, setVisionKey] = React.useState("");
  const [savingVision, setSavingVision] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [addingRule, setAddingRule] = React.useState(false);
  const [dialogError, setDialogError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [ruleScope, setRuleScope] = React.useState<"org" | "department" | "user">("department");
  const providers = [...new Set([
    ...(registeredProviders ?? []).map((item) => item.providerId),
    ...(models ?? []).map((m) => m.providerId),
  ])];
  const providerNames = new Map<string, string>(
    (registeredProviders ?? []).map((item) => [item.providerId, item.displayName || item.providerId]),
  );
  const providerLabel = (providerId: string) => providerNames.get(providerId) ?? providerId;
  const modelNames = new Map(
    (models ?? []).map((item) => [
      keyOf(item),
      item.displayName || item.model,
    ]),
  );
  const memberNames = new Map(
    (members ?? []).map((item) => [item.userId, item.name || item.email || item.userId]),
  );
  const memberEmails = new Map((members ?? []).map((item) => [item.userId, item.email]));
  const departmentNames = new Map(
    (departments ?? []).map((item) => [item.id, item.name || item.id]),
  );
  const currentNewTaskDefault = (defaults ?? []).find((d) => d.mode === "chat") ?? defaults?.[0];
  const currentNewTaskDefaultKey = currentNewTaskDefault
    ? keyOf(currentNewTaskDefault)
    : "";
  const visionDefault = (auxiliaryDefaults ?? []).find((item) => item.purpose === "vision");
  const currentVisionKey = visionDefault ? keyOf(visionDefault) : "";
  const isTaskDefault = (m: any) =>
    Boolean(currentNewTaskDefault) && currentNewTaskDefault.model === m.model && currentNewTaskDefault.providerId === m.providerId;
  const isVisionDefault = (m: any) => Boolean(visionDefault) && visionDefault.model === m.model && visionDefault.providerId === m.providerId;
  // Defaults first, then what members can use, then what is blocked.
  const rank = (m: any) => (isTaskDefault(m) ? 0 : isVisionDefault(m) ? 1 : m.status === "allowed" ? 2 : 3);
  const rows = [...(models ?? [])].sort((left, right) =>
    rank(left) - rank(right) || String(left.displayName || left.model).localeCompare(String(right.displayName || right.model)),
  );
  const activeIndex = rows.findIndex((m) => keyOf(m) === activeKey);
  const detail = activeIndex >= 0 ? rows[activeIndex] : null;
  React.useEffect(() => {
    setDraft(
      detail ? { ...detail } : null,
    );
  }, [activeKey, r.data]);
  const modelOption = (item: any) => ({
    value: keyOf(item),
    label: `${item.displayName || item.model} · ${providerLabel(item.providerId)}`,
  });
  const newTaskModelOptions = (models ?? [])
    .filter((item) => item.status === "allowed" && (item.modeAllow ?? ["chat"]).length > 0)
    .map(modelOption);
  const visionModelOptions = (models ?? [])
    .filter((item) => item.status === "allowed" && item.capabilities?.vision === true)
    .map(modelOption);
  React.useEffect(() => {
    setNewTaskDefaultKey(currentNewTaskDefaultKey);
  }, [currentNewTaskDefaultKey]);
  React.useEffect(() => {
    setVisionKey(currentVisionKey);
  }, [currentVisionKey]);
  const otherDefaults = (defaults ?? []).filter((item) => item !== currentNewTaskDefault);
  const otherAuxiliaryDefaults = (auxiliaryDefaults ?? []).filter((item) => item.purpose !== "vision");
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
  /** Runs a drawer action and shows a failure instead of dropping it. */
  const guarded = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error && cause.message ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const save = () => guarded(async () => {
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
  }, "The model policy could not be saved.");
  const makeTaskDefault = () => guarded(async () => {
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
    setMessage("Set as the default for new tasks and recorded in the audit log.");
  }, "The default model could not be changed.");
  const saveNewTaskDefault = async () => {
    const selected = (models ?? []).find(
      (item) => keyOf(item) === newTaskDefaultKey,
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
  const setVisionDefault = async (target: any) => {
    if (!target || target.capabilities?.vision !== true) return;
    const saved = await client?.upsertOrgAuxiliaryModelDefault(tenantId, "vision", {
      providerId: target.providerId,
      model: target.model,
    });
    const next = [
      ...(auxiliaryDefaults ?? []).filter((item) => item.purpose !== "vision"),
      saved ?? {
        tenantId,
        purpose: "vision",
        providerId: target.providerId,
        model: target.model,
        updatedAt: new Date().toISOString(),
      },
    ];
    r.setData([models, defaults, next, registeredProviders, accessRules, members, departments]);
    setMessage("Set as the organization vision model and recorded in the audit log.");
  };
  const makeVisionDefault = () => guarded(() => setVisionDefault(draft), "The vision model could not be changed.");
  const saveVisionDefault = async () => {
    const selected = (models ?? []).find((item) => keyOf(item) === visionKey);
    if (!selected) return;
    setSavingVision(true);
    setMessage("");
    setNewTaskDefaultError("");
    try {
      await setVisionDefault(selected);
    } catch (cause) {
      setNewTaskDefaultError(cause instanceof Error && cause.message ? cause.message : "The vision model could not be saved.");
    } finally {
      setSavingVision(false);
    }
  };
  const addModel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = (name: string) => {
      const value = String(form.get(name) ?? "");
      return value === "" ? undefined : Number(value);
    };
    setBusy(true);
    setDialogError("");
    try {
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
      setMessage("Model added with its pricing and context limits.");
      r.retry();
    } catch (cause) {
      setDialogError(cause instanceof Error && cause.message ? cause.message : "The model could not be added.");
    } finally {
      setBusy(false);
    }
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
    setBusy(true);
    setDialogError("");
    try {
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
      setMessage("Model access rule saved and recorded in the audit log.");
    } catch (cause) {
      setDialogError(cause instanceof Error && cause.message ? cause.message : "The access rule could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const modelRules = (accessRules ?? []).filter((rule) => rule.resourceType === "model");
  const ruleTarget = (rule: any) => {
    if (rule.scopeType === "org") return <CellStack primary="Everyone" secondary="Organization" />;
    if (rule.scopeType === "department") {
      const name = departmentNames.get(rule.scopeId);
      return <CellStack primary={name ?? "Unknown department"} secondary={name ? "Department" : <span className="font-mono" title={rule.scopeId}>{shortId(rule.scopeId)}</span>} />;
    }
    const name = memberNames.get(rule.scopeId);
    return <CellStack primary={name ?? "Unknown member"} secondary={name ? memberEmails.get(rule.scopeId) ?? "Member" : <span className="font-mono" title={rule.scopeId}>{shortId(rule.scopeId)}</span>} />;
  };
  const ruleTargets = ruleScope === "department" ? departments : members;
  const draftDirty = Boolean(detail && draft) && policyFingerprint(draft) !== policyFingerprint(detail);
  const capabilityFlags = draft?.capabilities
    ? Object.entries(draft.capabilities).filter(([, v]) => v === true).map(([k]) => k)
    : [];
  const openAddRule = () => { setDialogError(""); setAddingRule(true); };

  return (
    <ManagementPage
      title="Models"
      description="Which models members can use, which one new tasks start with, and the prices Berry uses to report cost."
      eyebrow="AI & tools"
      actions={canWrite ? <Button onClick={() => { setDialogError(""); setAdding(true); }}><Plus />Add model</Button> : null}
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} skeleton={<AdminModelsSkeleton />}>
        {message ? <SuccessMessage>{message}</SuccessMessage> : null}
        {newTaskDefaultError ? <InlineNotice tone="danger">{newTaskDefaultError}</InlineNotice> : null}
        <Section title="Defaults" flush>
          <SettingList>
            <SettingRow
              title="Default model for new tasks"
              description={
                !canWrite
                  ? "New tasks start with this model. Changing it needs the “Providers & models: manage” permission."
                  : newTaskModelOptions.length === 0
                    ? "No allowed model yet. Add a model below, then choose it here."
                    : "New tasks start with this model; tasks already created keep theirs. Switch it to route new work away from a provider that is down."
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-64 max-w-full">
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
                </div>
                {canWrite ? (
                  <Button
                    variant="secondary"
                    onClick={() => void saveNewTaskDefault()}
                    disabled={savingNewTaskDefault || !newTaskDefaultKey || newTaskDefaultKey === currentNewTaskDefaultKey}
                  >
                    <Save aria-hidden />
                    {savingNewTaskDefault ? "Saving…" : "Save default"}
                  </Button>
                ) : null}
              </div>
            </SettingRow>
            <SettingRow
              title="Vision model"
              description={
                visionModelOptions.length === 0
                  ? "Describes images for models that cannot read them. No allowed model declares image input yet."
                  : "Describes images for models that cannot read them. Only models that declare image input can be chosen."
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {!visionDefault && visionModelOptions.length === 0 ? <StatusPill tone="warning">Not set</StatusPill> : (
                  <div className="w-64 max-w-full">
                    <FormSelect
                      value={visionKey}
                      onChange={(value) => { setVisionKey(value); setNewTaskDefaultError(""); }}
                      options={visionDefault && !visionModelOptions.some((option) => option.value === currentVisionKey)
                        ? [{ value: currentVisionKey, label: `${modelNames.get(currentVisionKey) ?? visionDefault.model} · ${providerLabel(visionDefault.providerId)}` }, ...visionModelOptions]
                        : visionModelOptions}
                      placeholder="Not set"
                      disabled={!canWrite || savingVision}
                      ariaLabel="Vision model"
                    />
                  </div>
                )}
                {canWrite && visionModelOptions.length ? (
                  <Button variant="secondary" onClick={() => void saveVisionDefault()} disabled={savingVision || !visionKey || visionKey === currentVisionKey}>
                    <Save aria-hidden />
                    {savingVision ? "Saving…" : "Save vision model"}
                  </Button>
                ) : null}
              </div>
            </SettingRow>
            {otherDefaults.map((item) => (
              <SettingRow key={`mode:${item.mode}`} title={`Default for ${sentence(String(item.mode)).toLowerCase()} mode`} description={providerLabel(item.providerId)}>
                <span className="text-md text-foreground">{modelNames.get(keyOf(item)) ?? item.model}</span>
              </SettingRow>
            ))}
            {otherAuxiliaryDefaults.map((item) => (
              <SettingRow key={`aux:${item.purpose}`} title={`${sentence(String(item.purpose))} model`} description={providerLabel(item.providerId)}>
                <span className="text-md text-foreground">{modelNames.get(keyOf(item)) ?? item.model}</span>
              </SettingRow>
            ))}
          </SettingList>
        </Section>

        {rows.length === 0 ? (
          <EmptyPanel
            title="No models yet"
            description={providers.length ? "Add the models your providers serve so members can choose them." : "Add a provider under Providers first, then add its models here."}
            action={canWrite && providers.length ? <Button onClick={() => { setDialogError(""); setAdding(true); }}><Plus />Add model</Button> : undefined}
          />
        ) : (
          <DataTable
            label="Models"
            columns={["Model", "Provider", "Policy", "Default", "Context", "Input / 1M", "Output / 1M"]}
            onRowSelect={(index) => { setActionError(""); setActiveKey(rows[index] ? keyOf(rows[index]) : null); }}
            activeRow={activeIndex >= 0 ? activeIndex : null}
            rowLabel={(i) => rows[i].displayName || rows[i].model}
            rows={rows.map((m) => [
              <CellStack primary={m.displayName || m.model} secondary={m.displayName ? <span className="font-mono">{m.model}</span> : undefined} />,
              <StatusPill tone="neutral">{providerLabel(m.providerId)}</StatusPill>,
              <span className="flex flex-wrap gap-1.5">
                <StatusPill tone={m.status === "allowed" ? "good" : "danger"}>
                  {sentence(m.status)}
                </StatusPill>
                {m.enforce ? (
                  <StatusPill tone="info">Enforced</StatusPill>
                ) : null}
              </span>,
              isTaskDefault(m) || isVisionDefault(m) ? (
                <span className="flex flex-wrap gap-1.5">
                  {isTaskDefault(m) ? <StatusPill tone="info">New tasks</StatusPill> : null}
                  {isVisionDefault(m) ? <StatusPill tone="info">Vision</StatusPill> : null}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
              typeof m.capabilities?.context?.windowTokens === "number"
                ? <Num value={m.capabilities.context.windowTokens} kind="compact" />
                : <span data-sort={-1} className="text-muted-foreground">—</span>,
              <PriceCell value={m.capabilities?.cost?.input} />,
              <PriceCell value={m.capabilities?.cost?.output} />,
            ])}
          />
        )}

        <Section
          flush
          title="Access rules"
          description="Narrow or widen a model for one department or member. An organization-wide block always wins; a member rule overrides their primary department’s rule."
          actions={canWrite && rows.length ? <Button variant="secondary" onClick={openAddRule}><ShieldCheck />Add access rule</Button> : null}
        >
          {modelRules.length === 0 ? (
            <p className="px-4 py-6 text-center text-md text-muted-foreground">No rules. Every member can use every allowed model.</p>
          ) : (
            <DataTable
              label="Model access rules"
              columns={["Model", "Applies to", "Effect", "Updated"]}
              rows={modelRules.map((rule) => [
                <CellStack primary={modelNames.get(rule.resourceId) ?? rule.resourceId} secondary={modelNames.has(rule.resourceId) ? <span className="font-mono">{rule.resourceId}</span> : "No longer in the catalog"} />,
                ruleTarget(rule),
                <StatusPill tone={rule.effect === "allowed" ? "good" : "danger"}>{sentence(rule.effect)}</StatusPill>,
                formatDate(rule.updatedAt),
              ])}
            />
          )}
        </Section>
      </AsyncState>

      {detail && draft ? (
        <DetailDrawer
          title={draft.displayName || draft.model}
          subtitle={<>{providerLabel(draft.providerId)} · <code>{draft.model}</code></>}
          badge={
            <StatusPill tone={draft.status === "allowed" ? "good" : "danger"}>
              {sentence(draft.status)}
            </StatusPill>
          }
          onClose={() => setActiveKey(null)}
          footer={
            canWrite ? (
              <>
                <Button variant="secondary" onClick={() => setActiveKey(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void save()} disabled={!draftDirty || busy}>
                  <Save aria-hidden />
                  Save policy
                </Button>
              </>
            ) : undefined
          }
        >
          {!canWrite ? <InlineNotice tone="info">You can view this model. Editing it needs the “Providers &amp; models: manage” permission.</InlineNotice> : null}
          {actionError ? <InlineNotice tone="danger">{actionError}</InlineNotice> : null}
          <div className="grid gap-2">
            <h3 className={drawerHeading}>Availability</h3>
            {canWrite ? (
              <SegmentedControl
                label="Availability"
                value={draft.status === "blocked" ? "blocked" : "allowed"}
                onChange={(status) => setDraft({ ...draft, status })}
                options={[{ value: "allowed", label: "Allowed" }, { value: "blocked", label: "Blocked" }]}
              />
            ) : null}
            <p className="text-xs leading-5 text-muted-foreground">
              {draft.status === "blocked" ? "Nobody in the organization can select this model." : "Members can select this model unless an access rule blocks it for them."}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="grid gap-0.5">
              <b className="text-md font-medium text-foreground">Enforce policy</b>
              <small className="text-xs leading-5 text-muted-foreground">Members cannot override this policy.</small>
            </span>
            <ManagementSwitch
              checked={Boolean(draft.enforce)}
              disabled={!canWrite}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, enforce: checked })
              }
              aria-label="Enforce policy"
            />
          </div>
          <fieldset className="grid gap-2 border-0 p-0" disabled={!canWrite}>
            <legend className={`${drawerHeading} mb-2`}>Price, USD per 1M tokens</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={fieldLabel}>Input<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.input ?? ""} onChange={(event) => setCost("input", event.currentTarget.value)} /></label>
              <label className={fieldLabel}>Output<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.output ?? ""} onChange={(event) => setCost("output", event.currentTarget.value)} /></label>
              <label className={fieldLabel}>Cache read<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.cacheRead ?? ""} onChange={(event) => setCost("cacheRead", event.currentTarget.value)} /></label>
              <label className={fieldLabel}>Cache write<Input type="number" min="0" step="0.0001" value={draft.capabilities?.cost?.cacheWrite ?? ""} onChange={(event) => setCost("cacheWrite", event.currentTarget.value)} /></label>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">Used for cost estimates and usage reports.</p>
          </fieldset>
          <fieldset className="grid gap-2 border-0 p-0" disabled={!canWrite}>
            <legend className={`${drawerHeading} mb-2`}>Context limits, tokens</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={fieldLabel}>Context window<Input type="number" min="1" step="1" value={draft.capabilities?.context?.windowTokens ?? ""} onChange={(event) => setContext("windowTokens", event.currentTarget.value)} /></label>
              <label className={fieldLabel}>Maximum output<Input type="number" min="1" step="1" value={draft.capabilities?.context?.maxOutputTokens ?? ""} onChange={(event) => setContext("maxOutputTokens", event.currentTarget.value)} /></label>
            </div>
          </fieldset>
          {capabilityFlags.length ? (
            <div className="grid gap-2">
              <h3 className={drawerHeading}>Capabilities</h3>
              <div className="flex flex-wrap gap-1.5">
                {capabilityFlags.map((k) => (
                  <StatusPill key={k} tone="neutral">
                    {sentence(k)}
                  </StatusPill>
                ))}
              </div>
            </div>
          ) : null}
          {canWrite ? (
            <div className="grid gap-2">
              <h3 className={drawerHeading}>Use as a default</h3>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void makeTaskDefault()}
                  disabled={busy || isTaskDefault(draft)}
                >
                  {isTaskDefault(draft) ? "Default for new tasks" : "Set as default for new tasks"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void makeVisionDefault()}
                  disabled={busy || draft.capabilities?.vision !== true || isVisionDefault(draft)}
                >
                  {isVisionDefault(draft) ? "Vision model" : "Set as vision model"}
                </Button>
              </div>
              {draft.capabilities?.vision !== true ? (
                <p className="text-xs text-muted-foreground">
                  This model does not declare image input, so it cannot be the vision model.
                </p>
              ) : null}
            </div>
          ) : null}
        </DetailDrawer>
      ) : null}

      <ManagementDialog
        open={adding}
        onOpenChange={(next) => { if (!busy) setAdding(next); }}
        title="Add model"
        description="Register a model a provider serves, with the prices Berry uses for cost estimates and usage reports."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button><Button type="submit" form="add-model-form" disabled={busy || providers.length === 0}><Save />{busy ? "Adding…" : "Add model"}</Button></>}
      >
        {providers.length === 0 ? <div className="mb-3"><InlineNotice tone="warning">Add a provider under Providers before adding models.</InlineNotice></div> : null}
        <form id="add-model-form" className="grid gap-3 sm:grid-cols-2" onSubmit={addModel}>
          <label className={fieldLabel}>Provider<FormSelect name="providerId" options={providers.map((item) => ({ value: String(item), label: providerLabel(String(item)) }))} required /></label>
          <label className={fieldLabel}>Model ID<Input name="model" placeholder="gpt-5.4" autoFocus required /><small className={help}>Exactly as the provider names it.</small></label>
          <label className={fieldLabel}>Display name<Input name="displayName" placeholder="GPT-5.4" /><small className={help}>Optional. Shown to members in the model picker.</small></label>
          <label className={fieldLabel}>API protocol<FormSelect name="apiType" defaultValue="openai-chat-completions" options={API_OPTIONS} /></label>
          <label className={fieldLabel}>Input price, USD per 1M tokens<Input name="inputPrice" type="number" min="0" step="0.0001" /></label>
          <label className={fieldLabel}>Output price, USD per 1M tokens<Input name="outputPrice" type="number" min="0" step="0.0001" /></label>
          <label className={fieldLabel}>Cache-read price, USD per 1M tokens<Input name="cacheReadPrice" type="number" min="0" step="0.0001" /></label>
          <label className={fieldLabel}>Cache-write price, USD per 1M tokens<Input name="cacheWritePrice" type="number" min="0" step="0.0001" /></label>
          <label className={fieldLabel}>Context window, tokens<Input name="contextWindow" type="number" min="1" step="1" /></label>
          <label className={fieldLabel}>Maximum output, tokens<Input name="maxOutput" type="number" min="1" step="1" /></label>
        </form>
        {dialogError ? <div className="mt-3"><InlineNotice tone="danger">{dialogError}</InlineNotice></div> : null}
      </ManagementDialog>
      <ManagementDialog
        open={addingRule}
        onOpenChange={(next) => { if (!busy) setAddingRule(next); }}
        title="Add model access rule"
        description="Allow or block one model for the whole organization, a department, or a single member. A rule for the same model and target replaces the existing one."
        footer={<><Button type="button" variant="secondary" onClick={() => setAddingRule(false)} disabled={busy}>Cancel</Button><Button type="submit" form="add-model-access-rule-form" disabled={busy}><Save />{busy ? "Saving…" : "Save rule"}</Button></>}
      >
        <form id="add-model-access-rule-form" className="grid gap-3 sm:grid-cols-2" onSubmit={addAccessRule}>
          <label className={`${fieldLabel} sm:col-span-2`}>Model<FormSelect name="resourceId" options={(models ?? []).map(modelOption)} required /></label>
          <label className={fieldLabel}>Applies to<FormSelect name="scopeType" value={ruleScope} onChange={(value) => setRuleScope(value as typeof ruleScope)} options={[{ value: "department", label: SCOPE_LABEL.department! }, { value: "user", label: SCOPE_LABEL.user! }, { value: "org", label: "Whole organization" }]} /></label>
          {ruleScope === "org" ? (
            <label className={fieldLabel}>Target<Input value="Everyone" disabled /></label>
          ) : (
            <label className={fieldLabel}>
              {SCOPE_LABEL[ruleScope]}
              <FormSelect name="scopeId" disabled={ruleTargets.length === 0} options={ruleTargets.map((item) => ({ value: String(ruleScope === "department" ? item.id : item.userId), label: ruleScope === "department" ? String(item.name) : item.name ? `${item.name} · ${item.email}` : String(item.email) }))} required />
              {ruleTargets.length === 0 ? <small className={help}>{ruleScope === "department" ? "No departments are available, or you cannot view departments." : "No members are available, or you cannot view members."}</small> : null}
            </label>
          )}
          <label className={`${fieldLabel} sm:col-span-2`}>Effect<FormSelect name="effect" defaultValue="blocked" options={[{ value: "allowed", label: "Allow" }, { value: "blocked", label: "Block" }]} /></label>
        </form>
        {dialogError ? <div className="mt-3"><InlineNotice tone="danger">{dialogError}</InlineNotice></div> : null}
      </ManagementDialog>
    </ManagementPage>
  );
}
