import * as React from "react";
import { Check, Copy, KeyRound, Plus, Save, UsersRound } from "lucide-react";
import {
  AsyncState,
  Button,
  CellStack,
  Checkbox,
  DataTable,
  DefinitionList,
  DetailDrawer,
  EmptyPanel,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  Section,
  SettingList,
  SettingRow,
  StatusPill,
  SuccessMessage,
  formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

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
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [callbackUrl, setCallbackUrl] = React.useState("");
  React.useEffect(() => {
    setCallbackUrl(`${window.location.origin}/v1/auth/callback/google`);
  }, []);
  const detail = activeId ? r.data.find((c: any) => c.id === activeId) ?? null : null;
  const googleConnection = r.data.find((c: any) => c.provider === "google");
  const failing = r.data.filter((c: any) => c.lastErrorCode);
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
      setMessage(input.status === "enabled" ? "Google Workspace sign-in is on." : "Google Workspace settings saved. Sign-in is still off.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save Google Workspace SSO.");
    }
  };
  const openSetup = () => {
    setError("");
    setCopied(false);
    setAdding(true);
  };
  const copyCallback = () => {
    void navigator.clipboard?.writeText(callbackUrl).then(() => setCopied(true)).catch(() => {});
  };
  const setupButton = canWrite ? (
    <Button onClick={openSetup}>
      <Plus aria-hidden />
      {googleConnection ? "Configure Google" : "Set up Google"}
    </Button>
  ) : null;
  return (
    <ManagementPage
      title="SSO & SCIM"
      description="Let members sign in with your identity provider. Password sign-in stays available alongside it."
      eyebrow="Identity & security"
      actions={r.data.length ? setupButton : null}
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {failing.map((connection: any) => (
        <InlineNotice key={connection.id} tone="danger" title={`${connection.displayName} failed its last test`}>
          Error code <span className="font-mono text-xs">{connection.lastErrorCode}</span>
          {connection.lastTestedAt ? `, ${formatDateTime(connection.lastTestedAt)}` : ""}. Members may not be able to sign in with it.
        </InlineNotice>
      ))}
      <ManagementDialog
        open={adding}
        onOpenChange={setAdding}
        title="Configure Google Workspace"
        description="Create an OAuth web client in Google Cloud for this. Berry asks Google only for the member’s identity, email, and profile."
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
          className="grid gap-3"
          onSubmit={submit}
        >
          <Field label="Authorized redirect URI" hint="Add this to the OAuth client in Google Cloud.">
            <span className="flex gap-2">
              <Input value={callbackUrl} readOnly className="font-mono text-xs" />
              <Button type="button" variant="secondary" onClick={copyCallback} aria-label="Copy redirect URI">
                {copied ? <Check data-icon="inline-start" aria-hidden /> : <Copy data-icon="inline-start" aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </span>
          </Field>
          <Field label="Client ID">
            <Input name="clientId" defaultValue={googleConnection?.clientId ?? ""} autoComplete="off" autoFocus required placeholder="123456.apps.googleusercontent.com" />
          </Field>
          <Field label="Client secret" hint={googleConnection?.clientSecretConfigured ? "A secret is saved. Leave blank to keep it." : "Stored encrypted. It cannot be shown again after saving."}>
            <Input name="clientSecret" type="password" autoComplete="new-password" required={!googleConnection?.clientSecretConfigured} placeholder={googleConnection?.clientSecretConfigured ? "Leave blank to keep the saved secret" : "GOCSPX-…"} />
          </Field>
          <Field label="Workspace domain" hint="Only Google accounts on this domain can sign in.">
            <Input name="domain" defaultValue={googleConnection?.domains?.[0] ?? ""} required placeholder="example.com" />
          </Field>
          <div className="grid gap-2.5 border-t border-border pt-3">
            <CheckRow name="jitProvisioning" defaultChecked={googleConnection?.jitProvisioning ?? true} title="Create members on first sign-in" description="New Google users join with the Member role. Existing accounts are linked by verified email." />
            <CheckRow name="enabled" defaultChecked={googleConnection?.status === "enabled"} title="Turn on Google sign-in" description="Shows the Google button on the sign-in page for everyone." />
          </div>
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        </form>
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
      >
        {r.data.length ? (
          <Section title="Sign-in connections" flush>
            <DataTable
              label="Identity connections"
              columns={["Connection", "Status", "Domains", "New members", "Last tested", "Updated"]}
              onRowSelect={(index) => setActiveId(r.data[index]?.id ?? null)}
              activeRow={detail ? r.data.indexOf(detail) : null}
              rowLabel={(index) => `${r.data[index]?.displayName ?? "Connection"} details`}
              rows={r.data.map((connection: any) => [
                <CellStack primary={connection.displayName} secondary={connection.kind === "oidc" ? "OpenID Connect" : "SAML 2.0"} />,
                <StatusPill tone={statusTone(connection.status)}>{statusLabel(connection.status)}</StatusPill>,
                connection.domains.join(", ") || "Any domain",
                connection.jitProvisioning ? "Created on first sign-in" : "Must already exist",
                connection.lastTestedAt ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {formatDateTime(connection.lastTestedAt)}
                    {connection.lastErrorCode ? <StatusPill tone="danger">Failed</StatusPill> : null}
                  </span>
                ) : "Never",
                formatDateTime(connection.updatedAt),
              ])}
            />
          </Section>
        ) : (
          <EmptyPanel
            icon={KeyRound}
            title="No identity connections"
            description="Members sign in with a password. Connect Google Workspace to let them use their work account."
            action={setupButton}
          />
        )}
        <Section title="Directory sync" flush>
          <SettingList>
            <SettingRow
              icon={UsersRound}
              title="SCIM provisioning"
              description="Not available yet. Until it is, members are created on first sign-in or invited from People, and are not removed automatically when they leave your directory."
            >
              <StatusPill tone="neutral">Not available</StatusPill>
            </SettingRow>
          </SettingList>
        </Section>
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={detail.displayName}
          subtitle={detail.kind === "oidc" ? "OpenID Connect" : "SAML 2.0"}
          badge={<StatusPill tone={statusTone(detail.status)}>{statusLabel(detail.status)}</StatusPill>}
          onClose={() => setActiveId(null)}
          footer={canWrite && detail.provider === "google" ? (
            <Button variant="secondary" onClick={openSetup}>Edit settings</Button>
          ) : undefined}
        >
          {detail.lastErrorCode ? (
            <InlineNotice tone="danger" title="Last test failed">
              Error code <span className="font-mono text-xs">{detail.lastErrorCode}</span>
            </InlineNotice>
          ) : null}
          <DefinitionList
            items={[
              { term: "Sign-in", detail: detail.status === "enabled" ? "Shown on the sign-in page" : "Hidden from the sign-in page" },
              { term: "Domains", detail: detail.domains.join(", ") || "Any domain" },
              {
                term: "New members",
                detail: detail.jitProvisioning ? "Created on first sign-in with the Member role" : "Must already exist",
              },
              { term: "Last tested", detail: detail.lastTestedAt ? formatDateTime(detail.lastTestedAt) : "Never" },
              { term: "Updated", detail: formatDateTime(detail.updatedAt) },
            ]}
          />
          <DefinitionList
            items={[
              { term: "Issuer", detail: detail.issuer ?? "Not set" },
              { term: "Client ID", detail: detail.clientId ? <span className="break-all font-mono text-xs">{detail.clientId}</span> : "Not set" },
              { term: "Client secret", detail: detail.clientSecretConfigured ? "Saved (encrypted)" : "Missing" },
              { term: "Connection ID", detail: <span className="font-mono text-xs">{detail.slug}</span> },
            ]}
          />
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid content-start gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal leading-4">{hint}</span> : null}
    </label>
  );
}

function CheckRow({ name, defaultChecked, title, description }: { name: string; defaultChecked: boolean; title: string; description: string }) {
  return (
    <label className="flex items-start gap-2.5">
      <Checkbox className="mt-0.5" name={name} defaultChecked={defaultChecked} />
      <span className="grid gap-0.5">
        <span className="text-md font-medium leading-5 text-foreground">{title}</span>
        <span className="text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

function statusTone(status: string): "good" | "warning" | "neutral" {
  return status === "enabled" ? "good" : status === "disabled" ? "neutral" : "warning";
}

function statusLabel(status: string) {
  return status === "enabled" ? "On" : status === "disabled" ? "Off" : status === "draft" ? "Not finished" : status;
}
