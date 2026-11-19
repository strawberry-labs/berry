import * as React from "react";
import { Activity, Plus, Save, Server } from "lucide-react";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  MetricGrid,
  Num,
  StatusPill,
  SuccessMessage,
  formatDateTime,
  formatNumber,
  type MetricItem,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const STATUS_LABEL: Record<string, string> = { active: "Active", configured: "Needs activation", error: "Failing", disabled: "Disabled" };
const STATUS_TONE: Record<string, "good" | "warning" | "danger" | "neutral"> = { active: "good", configured: "warning", error: "danger", disabled: "neutral" };
/** Providers that need attention sort first. */
const STATUS_ORDER: Record<string, number> = { error: 0, configured: 1, active: 2, disabled: 3 };
const KIND_LABEL: Record<string, string> = {
  "berry-router": "Berry Router",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible",
  ollama: "Ollama",
  "lm-studio": "LM Studio",
  local: "Other local",
  custom: "Custom",
};
const API_LABEL: Record<string, string> = {
  "openai-chat-completions": "OpenAI chat completions",
  "openai-responses": "OpenAI responses",
  "anthropic-messages": "Anthropic messages",
};
const AUTH_LABEL: Record<string, string> = {
  bearer: "Bearer secret",
  "x-api-key": "x-api-key secret",
  "optional-bearer": "Optional bearer",
  none: "No authentication",
};
const fieldLabel = "grid gap-1.5 text-xs font-medium text-muted-foreground";
const help = "text-xs font-normal leading-4";
const options = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }));

function sentence(value: string) {
  const text = String(value ?? "").replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function AdminProvidersScreen({
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
            client.listOrgTaskModels(tenantId, { includeBlocked: true }),
          ])
        : [[], []],
    [[], []] as any,
  );
  const [providers, models]: [any[], any[]] = r.data;
  const [open, setOpen] = React.useState(false);
  const [enabled, setEnabled] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [testError, setTestError] = React.useState("");
  const [testingProviderId, setTestingProviderId] = React.useState<string | null>(null);
  const [togglingProviderId, setTogglingProviderId] = React.useState<string | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const optional = (name: string) => String(form.get(name) ?? "").trim() || null;
    setSaving(true);
    setFormError("");
    try {
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
      setMessage("Provider saved. Open it and run “Test and activate” before it can serve requests.");
      r.retry();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The provider could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const testProvider = async (providerId: string) => {
    if (!client) return;
    setMessage("");
    setTestError("");
    setTestingProviderId(providerId);
    try {
      await client.testOrganizationModelProvider(tenantId, providerId);
      setMessage("Provider passed its health check and is now active for organization requests.");
      r.retry();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Provider activation failed.");
      r.retry();
    } finally {
      setTestingProviderId(null);
    }
  };

  const setProviderEnabled = async (provider: any, next: boolean) => {
    if (!client) return;
    setMessage("");
    setTestError("");
    setTogglingProviderId(provider.providerId);
    try {
      await client.upsertOrganizationModelProvider(tenantId, {
        providerId: provider.providerId,
        displayName: provider.displayName,
        kind: provider.kind,
        apiType: provider.apiType,
        baseUrl: provider.baseUrl,
        endpointPath: provider.endpointPath ?? null,
        modelsPath: provider.modelsPath ?? null,
        authType: provider.authType,
        credentialRef: provider.credentialRef ?? null,
        defaultModel: provider.defaultModel ?? null,
        enabled: next,
      });
      setMessage(next ? `${provider.displayName} enabled. Run “Test and activate” if it is not active yet.` : `${provider.displayName} disabled.`);
      r.retry();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "The provider could not be updated.");
    } finally {
      setTogglingProviderId(null);
    }
  };

  const rows = [...providers].sort((left: any, right: any) =>
    (STATUS_ORDER[left.status] ?? 2) - (STATUS_ORDER[right.status] ?? 2)
    || String(left.displayName).localeCompare(String(right.displayName)),
  );
  const activeIndex = rows.findIndex((provider: any) => provider.providerId === activeId);
  const detail = activeIndex >= 0 ? rows[activeIndex] : null;
  const modelCount = (providerId: string) => models.filter((model: any) => model.providerId === providerId).length;
  const failing = providers.filter((item: any) => item.status === "error").length;
  const needsActivation = providers.filter((item: any) => item.status === "configured" && item.enabled).length;
  const active = providers.filter((item: any) => item.status === "active").length;
  // The strip earns its place only when something is wrong; a healthy list speaks for itself.
  const metrics: MetricItem[] = failing || needsActivation ? [
    { label: "Active", value: formatNumber(active), hint: `of ${formatNumber(providers.length)} ${providers.length === 1 ? "provider" : "providers"}` },
    ...(failing ? [{ label: "Failing", value: formatNumber(failing), hint: "Last health check failed", status: "danger" as const }] : []),
    ...(needsActivation ? [{ label: "Needs activation", value: formatNumber(needsActivation), hint: "Saved but not yet tested", status: "warning" as const }] : []),
  ] : [];
  const addButton = canWrite ? <Button onClick={() => { setFormError(""); setEnabled(true); setOpen(true); }}><Plus />Add provider</Button> : null;

  return (
    <ManagementPage
      title="Providers"
      description="The inference endpoints Berry sends model requests to: Berry Router, cloud providers, and local servers. Which of their models members can use is set under Models."
      eyebrow="AI & tools"
      actions={addButton}
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {testError ? <InlineNotice tone="danger" title="Provider check failed">{testError}</InlineNotice> : null}
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        {providers.length === 0 ? (
          <EmptyPanel
            icon={Server}
            title="No providers yet"
            description="Members cannot run tasks until at least one provider is added and activated."
            action={addButton}
          />
        ) : (
          <>
            {metrics.length ? <MetricGrid items={metrics} /> : null}
            <DataTable
              label="Providers"
              columns={["Provider", "Status", "Protocol", "Base URL", "Models", "Last tested"]}
              onRowSelect={(index) => setActiveId(rows[index]?.providerId ?? null)}
              activeRow={activeIndex >= 0 ? activeIndex : null}
              rowLabel={(index) => rows[index]?.displayName ?? "Provider"}
              rows={rows.map((provider: any) => [
                <CellStack primary={provider.displayName} secondary={`${KIND_LABEL[provider.kind] ?? sentence(provider.kind)} · ${provider.providerId}`} />,
                <StatusPill tone={STATUS_TONE[provider.status] ?? "neutral"}>{STATUS_LABEL[provider.status] ?? sentence(provider.status)}</StatusPill>,
                API_LABEL[provider.apiType] ?? sentence(provider.apiType),
                <span className="block max-w-72 truncate font-mono text-xs" title={provider.baseUrl}>{provider.baseUrl}</span>,
                <Num value={modelCount(provider.providerId)} kind="number" />,
                provider.lastTestedAt ? formatDateTime(provider.lastTestedAt) : <span className="text-muted-foreground">Never</span>,
              ])}
            />
            <InlineNotice tone="info" title="API keys are not stored here">
              A provider holds a reference to a secret, such as <code>env:BERRY_OPENAI_API_KEY</code>. Set that secret in deployment storage and add the provider’s host to <code>BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS</code>, then run “Test and activate”.
            </InlineNotice>
          </>
        )}
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={detail.displayName}
          subtitle={`${KIND_LABEL[detail.kind] ?? sentence(detail.kind)} · ${detail.providerId}`}
          badge={<StatusPill tone={STATUS_TONE[detail.status] ?? "neutral"}>{STATUS_LABEL[detail.status] ?? sentence(detail.status)}</StatusPill>}
          onClose={() => setActiveId(null)}
          footer={canWrite ? (
            <Button disabled={!detail.enabled || testingProviderId === detail.providerId} onClick={() => void testProvider(detail.providerId)}>
              <Activity />
              {testingProviderId === detail.providerId ? "Testing…" : detail.status === "active" ? "Test again" : "Test and activate"}
            </Button>
          ) : undefined}
        >
          {detail.status === "configured" && detail.enabled ? (
            <InlineNotice tone="warning">Saved but not serving requests yet. Run “Test and activate” to check the credential and endpoint.</InlineNotice>
          ) : detail.status === "error" ? (
            <InlineNotice tone="danger">The last health check failed. Check the secret and the allowed hosts, then test again.</InlineNotice>
          ) : null}
          {testError ? <InlineNotice tone="danger">{testError}</InlineNotice> : null}
          <div className="flex items-center justify-between gap-4">
            <span className="grid gap-0.5">
              <b className="text-md font-medium text-foreground">Enabled</b>
              <small className="text-xs leading-5 text-muted-foreground">
                {canWrite ? "When off, Berry does not send requests to this provider." : "Changing this needs the “Providers & models: manage” permission."}
              </small>
            </span>
            <ManagementSwitch
              checked={Boolean(detail.enabled)}
              disabled={!canWrite || togglingProviderId === detail.providerId}
              onCheckedChange={(next) => void setProviderEnabled(detail, next)}
              aria-label={`${detail.displayName} enabled`}
            />
          </div>
          <DefinitionList
            items={[
              { term: "Protocol", detail: API_LABEL[detail.apiType] ?? sentence(detail.apiType) },
              { term: "Base URL", detail: <code className="break-all">{detail.baseUrl}</code> },
              ...(detail.endpointPath ? [{ term: "Request path", detail: <code>{detail.endpointPath}</code> }] : []),
              ...(detail.modelsPath ? [{ term: "Models path", detail: <code>{detail.modelsPath}</code> }] : []),
              { term: "Authentication", detail: AUTH_LABEL[detail.authType] ?? sentence(detail.authType) },
              {
                term: "Secret reference",
                detail: detail.authType === "none"
                  ? "Not needed"
                  : detail.credentialRef
                    ? <code className="break-all">{detail.credentialRef}</code>
                    : <StatusPill tone="warning">Missing</StatusPill>,
              },
              { term: "Default model", detail: detail.defaultModel ?? "—" },
              { term: "Models", detail: `${formatNumber(modelCount(detail.providerId))} in the organization catalog` },
              { term: "Last tested", detail: detail.lastTestedAt ? formatDateTime(detail.lastTestedAt) : "Never" },
              { term: "Updated", detail: formatDateTime(detail.updatedAt) },
            ]}
          />
          {!detail.enabled && canWrite ? <p className="text-xs text-muted-foreground">Enable the provider to test it.</p> : null}
        </DetailDrawer>
      ) : null}
      <ManagementDialog
        open={open}
        onOpenChange={(next) => { if (!saving) setOpen(next); }}
        title="Add provider"
        description="Save how to reach the endpoint and which deployment secret holds its key. The key itself is never entered or shown here."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button><Button type="submit" form="provider-form" disabled={saving}><Save />{saving ? "Saving…" : "Save provider"}</Button></>}
      >
        <form id="provider-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <label className={fieldLabel}>Display name<Input name="displayName" autoFocus placeholder="OpenAI production" required /></label>
          <label className={fieldLabel}>Provider ID<Input name="providerId" pattern="[A-Za-z0-9._-]+" placeholder="openai-production" required /><small className={help}>Letters, numbers, dots, hyphens. Saving an existing ID replaces that provider.</small></label>
          <label className={fieldLabel}>Kind<FormSelect name="kind" defaultValue="openai-compatible" options={options(KIND_LABEL)} /></label>
          <label className={fieldLabel}>API protocol<FormSelect name="apiType" defaultValue="openai-chat-completions" options={options(API_LABEL)} /></label>
          <label className={`${fieldLabel} sm:col-span-2`}>Base URL<Input name="baseUrl" type="url" placeholder="https://api.openai.com/v1" required /></label>
          <label className={fieldLabel}>Request path<Input name="endpointPath" placeholder="/chat/completions" /><small className={help}>Optional. Leave blank for the protocol default.</small></label>
          <label className={fieldLabel}>Models path<Input name="modelsPath" placeholder="/models" /><small className={help}>Optional. Used to list available models.</small></label>
          <label className={fieldLabel}>Authentication<FormSelect name="authType" defaultValue="bearer" options={options(AUTH_LABEL)} /></label>
          <label className={fieldLabel}>Secret reference<Input name="credentialRef" pattern="[A-Za-z0-9_.:/-]+" placeholder="env:BERRY_OPENAI_API_KEY" /><small className={help}>The name of the deployment secret, not the key.</small></label>
          <label className={fieldLabel}>Default model<Input name="defaultModel" placeholder="gpt-5.4" /><small className={help}>Optional.</small></label>
          <div className="flex items-center justify-between gap-4 sm:col-span-2">
            <span className="grid gap-0.5">
              <b className="text-md font-medium text-foreground">Enabled</b>
              <small className="text-xs text-muted-foreground">Turn off to save the provider without routing requests to it.</small>
            </span>
            <ManagementSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Provider enabled" />
          </div>
        </form>
        {formError ? <div className="mt-3"><InlineNotice tone="danger">{formError}</InlineNotice></div> : null}
      </ManagementDialog>
    </ManagementPage>
  );
}
