import * as React from "react";
import { Save } from "lucide-react";
import type { OrganizationProfile } from "@berry/shared";
import { AsyncState, Button, DataTable, Input, ManagementPage, Section, StatusPill, SuccessMessage } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function OrganizationProfileScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const resource = useResource(`profile:${tenantId}`, async () => client ? client.organizationProfile(tenantId) : demoProfile(config.organizations.find((item) => item.id === tenantId)), null as OrganizationProfile | null);
  const [draft, setDraft] = React.useState<OrganizationProfile | null>(null);
  const [message, setMessage] = React.useState("");
  React.useEffect(() => { if (resource.data) setDraft(resource.data); }, [resource.data]);
  const writable = permissions.includes("org_settings:write");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!client || !draft) return;
    const { tenantId: _tenantId, domains: _domains, updatedAt: _updatedAt, ...input } = draft;
    const next = await client.updateOrganizationProfile(tenantId, input);
    setDraft(next);
    setMessage("Organization profile saved and added to the audit log.");
    resource.retry();
  }

  return <ManagementPage title="Profile & domains" description="Organization identity, verified domains, contacts, legal links, and deployment metadata." eyebrow="Organization">
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={!resource.data} emptyTitle="Profile unavailable">
      {draft ? <>
        <Section title="Organization profile" description={writable ? "Changes are visible across Berry." : "Your role can view this managed profile but cannot change it."}>
          <form className="mgmt-policy-grid" onSubmit={save}>
            <label className="mgmt-field">Name<Input disabled={!writable} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
            <label className="mgmt-field">Slug<Input disabled={!writable} pattern="[a-z0-9-]+" value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.currentTarget.value })} /></label>
            <label className="mgmt-field">Timezone<Input disabled={!writable} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.currentTarget.value })} /></label>
            <label className="mgmt-field">Language<Input disabled={!writable} value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.currentTarget.value })} /></label>
            <label className="mgmt-field">Support contact<Input disabled={!writable} type="email" value={draft.supportEmail ?? ""} onChange={(event) => setDraft({ ...draft, supportEmail: event.currentTarget.value || null })} /></label>
            <label className="mgmt-field">Security contact<Input disabled={!writable} type="email" value={draft.securityEmail ?? ""} onChange={(event) => setDraft({ ...draft, securityEmail: event.currentTarget.value || null })} /></label>
            <label className="mgmt-field">Terms URL<Input disabled={!writable} type="url" value={draft.termsUrl ?? ""} onChange={(event) => setDraft({ ...draft, termsUrl: event.currentTarget.value || null })} /></label>
            <label className="mgmt-field">Privacy URL<Input disabled={!writable} type="url" value={draft.privacyUrl ?? ""} onChange={(event) => setDraft({ ...draft, privacyUrl: event.currentTarget.value || null })} /></label>
            {writable ? <div className="mgmt-form-actions mgmt-field-wide"><Button><Save />Save profile</Button></div> : null}
          </form>
          {message ? <SuccessMessage>{message}</SuccessMessage> : null}
        </Section>
        <div className="mgmt-two-column">
          <Section title="Domains" description="Verification state is returned by the organization domain service.">
            <DataTable label="Organization domains" columns={["Domain", "Use", "Status"]} rows={draft.domains.map((domain) => [domain.domain, domain.customDomain ? "Custom hostname" : "Login domain", <StatusPill tone={domain.status === "verified" ? "good" : domain.status === "failed" ? "danger" : "warning"}>{domain.status}</StatusPill>])} />
          </Section>
          <Section title="Deployment" description="These values are platform-managed and read only.">
            <dl className="mgmt-metadata"><div><dt>Mode</dt><dd>{draft.deploymentMode}</dd></div><div><dt>Region</dt><dd>{draft.region ?? "Deployment default"}</dd></div><div><dt>Last updated</dt><dd>{new Date(draft.updatedAt).toLocaleString()}</dd></div></dl>
          </Section>
        </div>
      </> : null}
    </AsyncState>
  </ManagementPage>;
}

function demoProfile(organization: ManagementScreenProps["config"]["organizations"][number] | undefined): OrganizationProfile | null { return organization ? { tenantId: organization.id, name: organization.name, slug: organization.slug, logoUrl: null, timezone: "UTC", language: "en", supportEmail: null, securityEmail: null, deploymentMode: organization.deploymentMode, region: null, announcements: [], termsUrl: null, privacyUrl: null, branding: {}, domains: organization.hostname ? [{ id: `demo:${organization.id}`, domain: organization.hostname, status: "verified", customDomain: true, verifiedAt: organization.updatedAt }] : [], updatedAt: organization.updatedAt } : null; }
