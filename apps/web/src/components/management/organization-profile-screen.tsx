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
import { AsyncState, Button, DataTable, Input, ManagementPage, Section, StatusPill, SuccessMessage } from "./management-primitives";
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

  return <ManagementPage title="Organization settings" description="Manage the identity, browser branding, locale, and support details first configured during onboarding." eyebrow="Organization">
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={!resource.data} emptyTitle="Profile unavailable">
      {draft ? <>
        <Section title="Identity and branding" description={writable ? "Logo and favicon uploads are stored in Berry S3 and applied across this deployment." : "Your role can view this managed profile but cannot change it."}>
          <form className="grid gap-5" onSubmit={save}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldLabel label="Name"><Input disabled={!writable || saving} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></FieldLabel>
              <FieldLabel label="Application name"><Input disabled={!writable || saving} value={applicationName} onChange={(event) => updateBranding({ applicationName: event.currentTarget.value })} /></FieldLabel>
              <FieldLabel label="Slug"><Input disabled={!writable || saving} pattern="[a-z0-9-]+" value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.currentTarget.value })} /></FieldLabel>
              <FieldLabel label="Accent color">
                <span className="flex items-center gap-2"><Input className="w-14 shrink-0 p-1" disabled={!writable || saving} type="color" value={accentColor} onChange={(event) => updateBranding({ accentColor: event.currentTarget.value })} /><Input disabled={!writable || saving} pattern="#[0-9A-Fa-f]{6}" value={accentColor} onChange={(event) => updateBranding({ accentColor: event.currentTarget.value })} /></span>
              </FieldLabel>
            </div>

            <div className="grid gap-3 border-t border-[var(--berry-border-subtle)] pt-4 lg:grid-cols-2">
              <BrandAssetField
                kind="logo"
                title="Organization logo"
                description="Shown on sign-in, the sidebar, and workspace home. PNG, JPG, or WebP up to 5 MB."
                previewUrl={logoPreview}
                pending={pendingAssets.logo}
                progress={uploadProgress.logo}
                disabled={!writable || saving}
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
                disabled={!writable || saving}
                onSelect={(file) => selectAsset("favicon", file)}
                onRemove={() => removeAsset("favicon")}
              />
            </div>

            <div className="grid gap-3 border-t border-[var(--berry-border-subtle)] pt-4 sm:grid-cols-2">
              <FieldLabel label="Timezone" hint="Choose a city. Berry stores the IANA timezone and shows its current UTC offset.">
                <TimezoneSelect disabled={!writable || saving} value={draft.timezone} onChange={(timezone) => setDraft({ ...draft, timezone })} />
              </FieldLabel>
              <FieldLabel label="Language"><Input disabled={!writable || saving} value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.currentTarget.value })} /></FieldLabel>
              <FieldLabel label="Support contact"><Input disabled={!writable || saving} type="email" value={draft.supportEmail ?? ""} onChange={(event) => setDraft({ ...draft, supportEmail: event.currentTarget.value || null })} /></FieldLabel>
              <FieldLabel label="Security contact"><Input disabled={!writable || saving} type="email" value={draft.securityEmail ?? ""} onChange={(event) => setDraft({ ...draft, securityEmail: event.currentTarget.value || null })} /></FieldLabel>
              <FieldLabel label="Terms URL"><Input disabled={!writable || saving} type="url" value={draft.termsUrl ?? ""} onChange={(event) => setDraft({ ...draft, termsUrl: event.currentTarget.value || null })} /></FieldLabel>
              <FieldLabel label="Privacy URL"><Input disabled={!writable || saving} type="url" value={draft.privacyUrl ?? ""} onChange={(event) => setDraft({ ...draft, privacyUrl: event.currentTarget.value || null })} /></FieldLabel>
            </div>

            {error ? <p className="text-sm text-[var(--berry-danger)]" role="alert">{error}</p> : null}
            {message ? <SuccessMessage>{message}</SuccessMessage> : null}
            {writable ? <div className="flex justify-end"><Button disabled={saving}><Save />{saving ? "Saving…" : "Save settings"}</Button></div> : null}
          </form>
        </Section>
        <div className="grid gap-4 xl:grid-cols-2">
          <Section title="Domains" description="Verification state is returned by the organization domain service.">
            <DataTable label="Organization domains" columns={["Domain", "Use", "Status"]} rows={draft.domains.map((domain) => [domain.domain, domain.customDomain ? "Custom hostname" : "Login domain", <StatusPill tone={domain.status === "verified" ? "good" : domain.status === "failed" ? "danger" : "warning"}>{domain.status}</StatusPill>])} />
          </Section>
          <Section title="Deployment" description="These values are platform-managed and read only.">
            <dl className="grid divide-y divide-border [&>div]:flex [&>div]:justify-between [&>div]:gap-4 [&>div]:py-2 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:text-right [&_dd]:text-sm"><div><dt>Mode</dt><dd>{draft.deploymentMode}</dd></div><div><dt>Region</dt><dd>{draft.region ?? "Deployment default"}</dd></div><div><dt>Last updated</dt><dd>{new Date(draft.updatedAt).toLocaleString()}</dd></div></dl>
          </Section>
        </div>
      </> : null}
    </AsyncState>
  </ManagementPage>;
}

function FieldLabel({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid content-start gap-1.5 text-xs font-medium text-[var(--berry-text-secondary)]"><span>{label}</span>{children}{hint ? <span className="font-normal leading-4 text-[var(--berry-text-tertiary)]">{hint}</span> : null}</label>;
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
  return <div className="flex min-w-0 items-center gap-3 rounded-xl bg-[var(--berry-control-bg)] p-3 shadow-[var(--berry-ring-subtle)]">
    <div className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-[var(--berry-surface)] outline outline-1 -outline-offset-1 outline-[var(--berry-image-outline)]", kind === "logo" ? "h-14 w-24 rounded-lg" : "size-14 rounded-xl")}>
      {visiblePreviewUrl ? <img src={visiblePreviewUrl} alt="" className={cn("size-full object-contain", kind === "logo" ? "p-2" : "p-1.5")} onError={() => setFailedPreviewUrl(visiblePreviewUrl)} /> : <FileImage className="size-5 text-[var(--berry-text-tertiary)]" aria-hidden />}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2"><strong className="truncate text-sm font-medium text-[var(--berry-text-primary)]">{title}</strong>{pending ? <span className="rounded-full bg-[var(--berry-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--berry-accent)]">Ready to save</span> : null}</div>
      <p className="mt-0.5 text-xs leading-4 text-[var(--berry-text-tertiary)]">{description}</p>
      {progress !== null ? <p className="mt-1 text-xs tabular-nums text-[var(--berry-text-secondary)]" role="status">Uploading {Math.round(progress * 100)}%</p> : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
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
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => inputRef.current?.click()}><ImagePlus />{previewUrl ? "Replace" : "Upload"}</Button>
        {previewUrl ? <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove}><Trash2 />Remove</Button> : null}
      </div>
    </div>
  </div>;
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
