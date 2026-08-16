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
export function AdminSsoScimScreen({
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
