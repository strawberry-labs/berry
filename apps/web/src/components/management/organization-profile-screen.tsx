import * as React from "react";
import {
  FILE_RESPONSE_SECURITY_VERSION,
  ORGANIZATION_FAVICON_MAX_BYTES,
  ORGANIZATION_FAVICON_MEDIA_TYPES,
  ORGANIZATION_LOGO_MAX_BYTES,
  ORGANIZATION_LOGO_MEDIA_TYPES,
  type OrganizationBrandingAssetKind,
  type OrganizationProfile,
} from "@berry/shared";
import { Save } from "lucide-react";
import { FileImage, ImagePlus, Trash2 } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";
import { AsyncState, Button, DataTable, DefinitionList, InlineNotice, Input, ManagementPage, Section, SettingList, SettingRow, StatusPill, SuccessMessage, formatDate, formatDateTime } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { TimezoneSelect } from "./timezone-select";
import { resolveDeploymentBrandAssetUrl } from "../shell/deployment-brand";

type PendingAssets = Record<OrganizationBrandingAssetKind, File | null>;
type UploadProgress = Record<OrganizationBrandingAssetKind, number | null>;

export function OrganizationProfileScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const resource = useResource(`profile:${tenantId}`, async () => client ? client.organizationProfile(tenantId) : demoProfile(config.organizations.find((item) => item.id === tenantId)), null as OrganizationProfile | null);
  const [draft, setDraft] = React.useState<OrganizationProfile | null>(null);
  const [pendingAssets, setPendingAssets] = React.useState<PendingAssets>({ logo: null, favicon: null });
  const [uploadProgress, setUploadProgress] = React.useState<UploadProgress>({ logo: null, favicon: null });
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  React.useEffect(() => { if (resource.data) setDraft(resource.data); }, [resource.data]);
  const formId = React.useId();
  const writable = permissions.includes("org_settings:write");
  const branding = brandingRecord(draft?.branding);
  const applicationName = typeof branding.applicationName === "string" ? branding.applicationName : "Berry";
  const accentColor = typeof branding.accentColor === "string" ? branding.accentColor : "#7c6df2";
  const logoFileId = brandingFileId(branding, "logo");
  const faviconFileId = brandingFileId(branding, "favicon");
  const logoPreview = useAssetPreview(pendingAssets.logo, logoFileId ? brandingAssetUrl(config.apiBaseUrl, "logo", logoFileId) : draft?.logoUrl ?? null);
  const faviconPreview = useAssetPreview(pendingAssets.favicon, faviconFileId ? brandingAssetUrl(config.apiBaseUrl, "favicon", faviconFileId) : null);

  const updateBranding = (next: Record<string, unknown>) => {
    if (draft) setDraft({ ...draft, branding: { ...branding, ...next } as OrganizationProfile["branding"] });
  };

  const selectAsset = (kind: OrganizationBrandingAssetKind, file: File | null) => {
    if (!file) return;
    try {
      const normalized = normalizeBrandingAssetFile(file, kind);
      setPendingAssets((current) => ({ ...current, [kind]: normalized }));
      setUploadProgress((current) => ({ ...current, [kind]: null }));
      setMessage("");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to use this image");
    }
  };

  const removeAsset = (kind: OrganizationBrandingAssetKind) => {
    setPendingAssets((current) => ({ ...current, [kind]: null }));
    setUploadProgress((current) => ({ ...current, [kind]: null }));
    updateBranding({ [`${kind}FileId`]: null });
    if (kind === "logo" && draft) setDraft({ ...draft, logoUrl: null, branding: { ...branding, logoFileId: null } as OrganizationProfile["branding"] });
    setMessage("");
    setError("");
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!client || !draft || saving) return;
    setSaving(true);
    setMessage("");
    setError("");
    let nextDraft = draft;
    try {
      for (const kind of ["logo", "favicon"] as const) {
        const file = pendingAssets[kind];
        if (!file) continue;
        setUploadProgress((current) => ({ ...current, [kind]: 0 }));
        const stored = await client.uploadFile(file, {
          concurrency: 2,
          onProgress: ({ ratio }) => setUploadProgress((current) => ({ ...current, [kind]: ratio })),
        });
        const nextBranding = { ...brandingRecord(nextDraft.branding), [`${kind}FileId`]: stored.id } as OrganizationProfile["branding"];
        nextDraft = { ...nextDraft, ...(kind === "logo" ? { logoUrl: null } : {}), branding: nextBranding };
        setDraft(nextDraft);
        setPendingAssets((current) => ({ ...current, [kind]: null }));
        setUploadProgress((current) => ({ ...current, [kind]: null }));
      }
      const { tenantId: _tenantId, domains: _domains, updatedAt: _updatedAt, ...input } = nextDraft;
      const next = await client.updateOrganizationProfile(tenantId, input);
      setDraft(next);
      setMessage("Organization settings saved.");
      window.dispatchEvent(new Event("berry:deployment-brand-changed"));
      resource.retry();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save organization settings");
    } finally {
      setSaving(false);
      setUploadProgress({ logo: null, favicon: null });
    }
  }

  const dirty = Boolean(draft && resource.data && (JSON.stringify(draft) !== JSON.stringify(resource.data) || pendingAssets.logo || pendingAssets.favicon));
  const locked = !writable || saving;

  return <ManagementPage width="narrow"
    title="Organization settings"
    description="The name, branding, and contact details members see across this deployment."
    eyebrow="Organization"
    actions={draft && writable ? (
      <Button type="submit" form={formId} disabled={saving || !dirty}><Save />{saving ? "Saving…" : "Save settings"}</Button>
    ) : null}
  >
    {draft && !writable ? <InlineNotice tone="info">You can view these settings. Changing them needs a role with the organization settings write permission.</InlineNotice> : null}
    {error ? <InlineNotice tone="danger" title="Settings not saved">{error}</InlineNotice> : null}
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={!resource.data} emptyTitle="Profile unavailable" emptyText="Connect the organization API to load and edit the organization profile.">
      {draft ? <>
        <form id={formId} className="grid min-w-0 gap-5" onSubmit={save}>
          <Section title="Identity" flush>
            <SettingList>
              <SettingRow title="Organization name" description="Shown in the sidebar, on sign-in, and in emails.">
                <Control><Input aria-label="Organization name" disabled={locked} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></Control>
              </SettingRow>
              <SettingRow title="Application name" description="What the product is called for your members, in the browser tab and on sign-in.">
                <Control><Input aria-label="Application name" disabled={locked} value={applicationName} onChange={(event) => updateBranding({ applicationName: event.currentTarget.value })} /></Control>
              </SettingRow>
              <SettingRow title="Slug" description="The short identifier used in links. Lowercase letters, numbers, and hyphens. Changing it can break saved links.">
                <Control><Input aria-label="Slug" className="font-mono text-xs" disabled={locked} required pattern="[a-z0-9-]+" value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.currentTarget.value })} /></Control>
              </SettingRow>
              <BrandAssetField
                kind="logo"
                title="Organization logo"
                description="Shown on sign-in, the sidebar, and workspace home. PNG, JPG, or WebP up to 5 MB."
                previewUrl={logoPreview}
                pending={pendingAssets.logo}
                progress={uploadProgress.logo}
                disabled={locked}
                onSelect={(file) => selectAsset("logo", file)}
                onRemove={() => removeAsset("logo")}
              />
              <BrandAssetField
                kind="favicon"
                title="Browser favicon"
                description="Shown in browser tabs and bookmarks. Use a square PNG, WebP, or ICO up to 1 MB."
                previewUrl={faviconPreview}
                pending={pendingAssets.favicon}
                progress={uploadProgress.favicon}
                disabled={locked}
                onSelect={(file) => selectAsset("favicon", file)}
                onRemove={() => removeAsset("favicon")}
              />
              <SettingRow title="Accent color" description="Used for buttons and highlights. A six-digit hex value.">
                <span className="flex items-center gap-2">
                  <Input aria-label="Pick accent color" className="w-11 shrink-0 p-1" disabled={locked} type="color" value={accentColor} onChange={(event) => updateBranding({ accentColor: event.currentTarget.value })} />
                  <Input aria-label="Accent color hex value" className="w-28 font-mono text-xs" disabled={locked} pattern="#[0-9A-Fa-f]{6}" value={accentColor} onChange={(event) => updateBranding({ accentColor: event.currentTarget.value })} />
                </span>
              </SettingRow>
            </SettingList>
          </Section>
          <Section title="Defaults" flush>
            <SettingList>
              <SettingRow title="Timezone" description="The organization’s default timezone. Search by city or UTC offset.">
                <Control><TimezoneSelect disabled={locked} value={draft.timezone} onChange={(timezone) => setDraft({ ...draft, timezone })} /></Control>
              </SettingRow>
              <SettingRow title="Language" description="The default language code, such as en.">
                <Control><Input aria-label="Language" disabled={locked} value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.currentTarget.value })} /></Control>
              </SettingRow>
            </SettingList>
          </Section>
          <Section title="Contacts and legal" description="Where members are sent for help and which terms they are shown." flush>
            <SettingList>
              <SettingRow title="Support contact" description="Members are pointed here when they need help.">
                <Control><Input aria-label="Support contact" disabled={locked} type="email" placeholder="support@example.com" value={draft.supportEmail ?? ""} onChange={(event) => setDraft({ ...draft, supportEmail: event.currentTarget.value || null })} /></Control>
              </SettingRow>
              <SettingRow title="Security contact" description="Where security reports and incident notices go.">
                <Control><Input aria-label="Security contact" disabled={locked} type="email" placeholder="security@example.com" value={draft.securityEmail ?? ""} onChange={(event) => setDraft({ ...draft, securityEmail: event.currentTarget.value || null })} /></Control>
              </SettingRow>
              <SettingRow title="Terms of use" description="Linked from the sign-in page.">
                <Control><Input aria-label="Terms URL" disabled={locked} type="url" placeholder="https://" value={draft.termsUrl ?? ""} onChange={(event) => setDraft({ ...draft, termsUrl: event.currentTarget.value || null })} /></Control>
              </SettingRow>
              <SettingRow title="Privacy policy" description="Linked from the sign-in page.">
                <Control><Input aria-label="Privacy URL" disabled={locked} type="url" placeholder="https://" value={draft.privacyUrl ?? ""} onChange={(event) => setDraft({ ...draft, privacyUrl: event.currentTarget.value || null })} /></Control>
              </SettingRow>
            </SettingList>
          </Section>
        </form>
        <Section title="Domains" description="Email domains members sign in with and custom hostnames for this organization. They are managed by the deployment and read only here." flush>
          {draft.domains.length ? (
            <DataTable
              label="Organization domains"
              columns={["Domain", "Used for", "Status", "Verified"]}
              rows={[...draft.domains]
                .sort((left, right) => Number(left.status === "verified") - Number(right.status === "verified"))
                .map((domain) => [
                  <span className="font-mono text-xs text-foreground">{domain.domain}</span>,
                  domain.customDomain ? "Custom hostname" : "Sign-in domain",
                  <StatusPill tone={domain.status === "verified" ? "good" : domain.status === "failed" ? "danger" : "warning"}>{domain.status === "verified" ? "Verified" : domain.status === "failed" ? "Failed" : "Pending"}</StatusPill>,
                  domain.verifiedAt ? formatDate(domain.verifiedAt) : "—",
                ])}
            />
          ) : (
            <p className="px-4 py-3 text-md text-muted-foreground">No domains are attached to this organization.</p>
          )}
        </Section>
        <Section title="Deployment" description="Set when the organization was provisioned. Only a platform operator can change these.">
          <DefinitionList
            items={[
              { term: "Mode", detail: deploymentLabel(draft.deploymentMode) },
              { term: "Region", detail: draft.region ?? "Deployment default" },
              { term: "Last updated", detail: formatDateTime(draft.updatedAt) },
            ]}
          />
        </Section>
      </> : null}
    </AsyncState>
  </ManagementPage>;
}

function Control({ children }: { children: React.ReactNode }) {
  return <div className="w-full sm:w-72">{children}</div>;
}

function deploymentLabel(mode: string) {
  return mode === "shared" ? "Shared" : mode === "dedicated" ? "Dedicated" : mode === "selfhost" ? "Self-hosted" : mode;
}

function BrandAssetField({ kind, title, description, previewUrl, pending, progress, disabled, onSelect, onRemove }: {
  kind: OrganizationBrandingAssetKind;
  title: string;
  description: string;
  previewUrl: string | null;
  pending: File | null;
  progress: number | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
}) {
  const inputId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [failedPreviewUrl, setFailedPreviewUrl] = React.useState<string | null>(null);
  React.useEffect(() => setFailedPreviewUrl(null), [previewUrl]);
  const visiblePreviewUrl = previewUrl && previewUrl !== failedPreviewUrl ? previewUrl : null;
  return <SettingRow
    title={<span className="flex flex-wrap items-center gap-2"><span>{title}</span>{pending ? <StatusPill tone="info">Ready to save</StatusPill> : null}</span>}
    description={<>{description}{progress !== null ? <span className="block tabular-nums text-foreground" role="status">Uploading {Math.round(progress * 100)}%</span> : null}</>}
  >
    <span className="flex flex-wrap items-center gap-2">
      <span className={cn("flex h-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-[var(--berry-surface-under)]", kind === "logo" ? "w-20" : "w-10")}>
        {visiblePreviewUrl ? <img src={visiblePreviewUrl} alt="" className="size-full object-contain p-1.5" onError={() => setFailedPreviewUrl(visiblePreviewUrl)} /> : <FileImage className="size-4 text-muted-foreground" aria-hidden />}
      </span>
      <input
        id={inputId}
        ref={inputRef}
        className="sr-only"
        type="file"
        aria-label={`Upload ${title.toLowerCase()}`}
        accept={kind === "logo" ? ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" : ".png,.webp,.ico,image/png,image/webp,image/x-icon,image/vnd.microsoft.icon"}
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onSelect(file);
          event.currentTarget.value = "";
        }}
      />
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => inputRef.current?.click()}><ImagePlus />{previewUrl ? "Replace" : "Upload"}</Button>
      {previewUrl ? <Button type="button" variant="ghost" disabled={disabled} onClick={onRemove}><Trash2 />Remove</Button> : null}
    </span>
  </SettingRow>;
}

export function normalizeBrandingAssetFile(file: File, kind: OrganizationBrandingAssetKind): File {
  const inferredType = mediaTypeForBrandingFile(file.name);
  const mediaType = (file.type || inferredType).toLowerCase();
  const allowed = kind === "logo" ? ORGANIZATION_LOGO_MEDIA_TYPES : ORGANIZATION_FAVICON_MEDIA_TYPES;
  const maximumBytes = kind === "logo" ? ORGANIZATION_LOGO_MAX_BYTES : ORGANIZATION_FAVICON_MAX_BYTES;
  if (!(allowed as readonly string[]).includes(mediaType)) throw new Error(kind === "logo" ? "Choose a PNG, JPG, or WebP logo." : "Choose a PNG, WebP, or ICO favicon.");
  if (file.size <= 0) throw new Error("The selected image is empty.");
  if (file.size > maximumBytes) throw new Error(`${kind === "logo" ? "Logo" : "Favicon"} must be ${kind === "logo" ? "5 MB" : "1 MB"} or smaller.`);
  return file.type === mediaType ? file : new File([file], file.name, { type: mediaType, lastModified: file.lastModified });
}

function mediaTypeForBrandingFile(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ico: "image/x-icon" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function brandingRecord(value: OrganizationProfile["branding"] | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function brandingFileId(branding: Record<string, unknown>, kind: OrganizationBrandingAssetKind): string | null {
  const value = branding[`${kind}FileId`];
  return typeof value === "string" ? value : null;
}

export function brandingAssetUrl(baseUrl: string | null, kind: OrganizationBrandingAssetKind, fileId: string): string {
  const path = `/v1/branding/${kind}?v=${encodeURIComponent(fileId)}&sv=${FILE_RESPONSE_SECURITY_VERSION}`;
  return resolveDeploymentBrandAssetUrl(baseUrl ?? "", path) ?? path;
}

function useAssetPreview(file: File | null, storedUrl: string | null): string | null {
  const [preview, setPreview] = React.useState<string | null>(storedUrl);
  React.useEffect(() => {
    if (!file) {
      setPreview(storedUrl);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, storedUrl]);
  return preview;
}

function demoProfile(organization: ManagementScreenProps["config"]["organizations"][number] | undefined): OrganizationProfile | null { return organization ? { tenantId: organization.id, name: organization.name, slug: organization.slug, logoUrl: null, timezone: "UTC", language: "en", supportEmail: null, securityEmail: null, deploymentMode: organization.deploymentMode, region: null, announcements: [], termsUrl: null, privacyUrl: null, branding: {}, domains: organization.hostname ? [{ id: `demo:${organization.id}`, domain: organization.hostname, status: "verified", customDomain: true, verifiedAt: organization.updatedAt }] : [], updatedAt: organization.updatedAt } : null; }
