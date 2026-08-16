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
