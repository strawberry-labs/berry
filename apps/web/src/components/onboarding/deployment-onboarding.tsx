import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clipboard,
  Cloud,
  Database,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Palette,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";
import GoogleSsoButton from "../shell/google-sso-button.tsx";
import { resolveDeploymentBrandAssetUrl } from "../shell/deployment-brand.tsx";

type StepStatus = "complete" | "current" | "pending";

type SetupStatus = {
  required: boolean;
  completed: boolean;
  unlocked: boolean;
  systemReady: boolean;
  foundationConfigured: boolean;
  currentStep: number;
  ownerEmail: string | null;
  applicationName: string;
  organization: {
    configured: boolean;
    name: string;
    applicationName: string;
    logoUrl: string | null;
    accentColor: string;
    supportEmail: string | null;
    securityEmail: string | null;
    timezone: string;
  };
  sso: {
    configured: boolean;
    clientId: string | null;
    clientSecretConfigured: boolean;
    hostedDomain: string | null;
    jitProvisioning: boolean;
    callbackUrl: string;
  };
  connectors: {
    configured: boolean;
    clientId: string | null;
    clientSecretConfigured: boolean;
    pickerConfigured: boolean;
    pickerProjectNumber: string | null;
    callbackUrl: string;
    drive: { enabled: boolean; maxAccessLevel: "read" | "full"; access?: "selected_files" | "search_workspace" };
    gmail: { enabled: boolean; maxAccessLevel: "read" | "full" };
    calendar: { enabled: boolean; maxAccessLevel: "read" | "full" };
  };
  checks: Array<{ id: string; label: string; status: "pass" | "warning" | "fail"; detail: string; blocking: boolean }>;
  steps: Array<{ id: string; label: string; status: StepStatus }>;
  readyToClaim: boolean;
};

export function DeploymentOnboarding({ baseUrl, initialToken }: { baseUrl: string; initialToken: string }) {
  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [step, setStep] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const unlockedOnce = React.useRef(false);

  const refresh = React.useCallback(async () => {
    const next = await setupRequest<SetupStatus>(`${baseUrl}/v1/setup`);
    setStatus(next);
    setStep((current) => current === 1 || current > next.currentStep ? next.currentStep : current);
    if (typeof document !== "undefined") document.title = `${next.applicationName} setup`;
    return next;
  }, [baseUrl]);

  React.useEffect(() => {
    let cancelled = false;
    if (initialToken) clearSetupFragment();
    void (async () => {
      try {
        let next = await setupRequest<SetupStatus>(`${baseUrl}/v1/setup`);
        if (initialToken && next.required && !next.unlocked && !unlockedOnce.current) {
          unlockedOnce.current = true;
          await setupRequest(`${baseUrl}/v1/setup/unlock`, { method: "POST", body: { setupToken: initialToken } });
          next = await setupRequest<SetupStatus>(`${baseUrl}/v1/setup`);
        }
        if (!cancelled) {
          setStatus(next);
          setStep(next.currentStep);
          if (typeof document !== "undefined") document.title = `${next.applicationName} setup`;
        }
      } catch (cause) {
        if (!cancelled) setError(messageFor(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, initialToken]);

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      await setupRequest(`${baseUrl}/v1/setup/unlock`, { method: "POST", body: { setupToken: String(form.get("setupToken") ?? "") } });
      clearSetupFragment();
      await refresh();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const next = await setupRequest<SetupStatus>(`${baseUrl}/v1/setup/${path}`, { method: "POST", body });
      setStatus(next);
      setStep(next.currentStep);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  async function retryChecks() {
    setBusy(true);
    setError("");
    try {
      await refresh();
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SetupLoading />;
  if (!status) return <SetupFailure error={error || "Setup status is unavailable."} onRetry={() => window.location.reload()} />;
  if (status.required && !status.unlocked) return <SetupUnlock status={status} busy={busy} error={error} onSubmit={unlock} />;
  const logoUrl = resolveDeploymentBrandAssetUrl(baseUrl, status.organization.logoUrl);

  return (
    <main className="berry-onboarding-shell" aria-label="Berry deployment onboarding">
      <aside className="berry-onboarding-rail">
        <div className="berry-onboarding-brand">
          {logoUrl ? <img src={logoUrl} alt="" /> : <BerryLogo alt="" />}
          <div><strong>{status.applicationName}</strong><span>Deployment setup</span></div>
        </div>
        <nav aria-label="Setup progress">
          <ol>
            {status.steps.map((item, index) => {
              const number = index + 1;
              const available = number <= status.currentStep || item.status === "complete";
              return (
                <li key={item.id} data-state={item.status}>
                  <button type="button" disabled={!available} aria-label={item.label} aria-current={step === number ? "step" : undefined} onClick={() => setStep(number)}>
                    <span className="berry-onboarding-step-icon" aria-hidden>
                      <span className="berry-onboarding-step-check"><Check /></span>
                      <span className="berry-onboarding-step-number">{number}</span>
                    </span>
                    <span>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="berry-onboarding-security-note">
          <ShieldCheck aria-hidden />
          <p><strong>Private setup session</strong><span>Secrets are encrypted before storage and never returned to this browser.</span></p>
        </div>
      </aside>

      <section className="berry-onboarding-workspace">
        <div className="berry-onboarding-progress" aria-hidden><i style={{ width: `${step * 20}%` }} /></div>
        <div className="berry-onboarding-stage" key={step}>
          {step === 1 ? <SystemStep status={status} busy={busy} onRetry={retryChecks} onContinue={() => save("foundation", {})} /> : null}
          {step === 2 ? <OrganizationStep status={status} busy={busy} onBack={() => setStep(1)} onSave={(body) => save("organization", body)} /> : null}
          {step === 3 ? <SsoStep status={status} busy={busy} onBack={() => setStep(2)} onSave={(body) => save("google-sso", body)} /> : null}
          {step === 4 ? <ConnectorsStep status={status} busy={busy} onBack={() => setStep(3)} onSave={(body) => save("google-connectors", body)} /> : null}
          {step === 5 ? <ClaimStep baseUrl={baseUrl} status={status} busy={busy} setBusy={setBusy} setError={setError} onBack={() => setStep(4)} /> : null}
          {error ? <p className="berry-onboarding-error" role="alert"><TriangleAlert aria-hidden />{error}</p> : null}
        </div>
      </section>
    </main>
  );
}

function SetupLoading() {
  return <div className="auth-shell" role="status" aria-live="polite"><LoaderCircle className="berry-onboarding-loader" aria-hidden /><span className="sr-only">Loading deployment setup</span></div>;
}

function SetupFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="auth-shell"><div className="auth-card"><TriangleAlert aria-hidden /><h1>Setup could not load</h1><p>{error}</p><button className="primary-button" onClick={onRetry}>Try again</button></div></div>;
}

function SetupUnlock({ status, busy, error, onSubmit }: { status: SetupStatus; busy: boolean; error: string; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return (
    <div className="auth-shell">
      <form className="auth-card berry-onboarding-unlock" onSubmit={onSubmit}>
        <div className="berry-onboarding-lock"><LockKeyhole aria-hidden /></div>
        <div><h1>Unlock deployment setup</h1><p>Enter the one-time setup key generated on the server. Access expires after 30 minutes.</p></div>
        <label>Setup key<input name="setupToken" type="password" autoComplete="off" minLength={32} required autoFocus /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" disabled={busy}>{busy ? "Checking…" : "Unlock setup"}</button>
      </form>
    </div>
  );
}

function StepHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="berry-onboarding-header"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

function SystemStep({ status, busy, onRetry, onContinue }: { status: SetupStatus; busy: boolean; onRetry: () => void; onContinue: () => void }) {
  const blocked = status.checks.some((check) => check.blocking && check.status !== "pass");
  const icons: Record<string, React.ComponentType<{ "aria-hidden"?: boolean }>> = { database: Database, redis: Cloud, storage: HardDrive, encryption: KeyRound, "public-url": LockKeyhole, model: Cloud };
  return <>
    <StepHeader eyebrow="Step 1 of 5" title="Check the production foundation" description="Berry checks the services and security settings it needs before organization data or OAuth credentials are accepted." />
    <div className="berry-onboarding-checks">
      {status.checks.map((check) => {
        const Icon = icons[check.id] ?? Cloud;
        return <article key={check.id} data-status={check.status}><span><Icon aria-hidden /></span><div><strong>{check.label}</strong><p>{check.detail}</p></div>{check.status === "pass" ? <CheckCircle2 aria-label="Ready" /> : <TriangleAlert aria-label={check.status} />}</article>;
      })}
    </div>
    <StepFooter busy={busy} continueLabel={blocked ? "Retry checks" : "Continue to organization"} onContinue={blocked ? onRetry : onContinue} />
  </>;
}

function OrganizationStep({ status, busy, onBack, onSave }: { status: SetupStatus; busy: boolean; onBack: () => void; onSave: (body: unknown) => void }) {
  const [organizationName, setOrganizationName] = React.useState(status.organization.name);
  const [applicationName, setApplicationName] = React.useState(status.organization.applicationName);
  const [accentColor, setAccentColor] = React.useState(status.organization.accentColor);
  return <form onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      organizationName: form.get("organizationName"), applicationName: form.get("applicationName"),
      logoUrl: emptyToNull(form.get("logoUrl")), accentColor: form.get("accentColor"),
      supportEmail: emptyToNull(form.get("supportEmail")), securityEmail: emptyToNull(form.get("securityEmail")), timezone: form.get("timezone"),
    });
  }}>
    <StepHeader eyebrow="Step 2 of 5" title="Make the workspace yours" description="Set the organization identity shown on sign-in, in navigation, and in administrative screens." />
    <div className="berry-onboarding-form-grid">
      <Field label="Organization name"><input name="organizationName" required maxLength={100} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} /></Field>
      <Field label="Application name"><input name="applicationName" required maxLength={60} value={applicationName} onChange={(event) => setApplicationName(event.target.value)} /></Field>
      <Field label="Logo URL" hint="HTTPS PNG, SVG, or WebP"><input name="logoUrl" type="url" placeholder="https://…/logo.svg" defaultValue={status.organization.logoUrl ?? ""} /></Field>
      <Field label="Accent color"><span className="berry-onboarding-color-input"><input name="accentColor" type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /><code>{accentColor}</code></span></Field>
      <Field label="Support email"><input name="supportEmail" type="email" defaultValue={status.organization.supportEmail ?? ""} /></Field>
      <Field label="Security email"><input name="securityEmail" type="email" defaultValue={status.organization.securityEmail ?? ""} /></Field>
      <Field label="Timezone"><input name="timezone" required defaultValue={status.organization.timezone} /></Field>
    </div>
    <div className="berry-onboarding-preview"><Palette aria-hidden /><div><strong>{applicationName || "Berry"}</strong><p>{organizationName || "Your organization"} · Live identity preview</p></div><span role="img" style={{ backgroundColor: accentColor }} aria-label={`Accent ${accentColor}`} /></div>
    <StepFooter busy={busy} onBack={onBack} continueLabel="Save and continue" />
  </form>;
}

function SsoStep({ status, busy, onBack, onSave }: { status: SetupStatus; busy: boolean; onBack: () => void; onSave: (body: unknown) => void }) {
  return <form onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({ clientId: form.get("clientId"), clientSecret: emptyToUndefined(form.get("clientSecret")), hostedDomain: form.get("hostedDomain"), jitProvisioning: true });
  }}>
    <StepHeader eyebrow="Step 3 of 5" title="Connect Google Workspace SSO" description="Only verified accounts from your Workspace domain can sign in. New users always start as members; administrative roles are assigned by the owner." />
    <CopyField label="Authorized redirect URI" value={status.sso.callbackUrl} />
    <div className="berry-onboarding-form-grid">
      <Field label="Workspace domain"><input name="hostedDomain" required placeholder="aesg.com" defaultValue={status.sso.hostedDomain ?? ownerDomain(status.ownerEmail)} /></Field>
      <Field label="OAuth client ID"><input name="clientId" required autoComplete="off" defaultValue={status.sso.clientId ?? ""} /></Field>
      <Field label="OAuth client secret" hint={status.sso.clientSecretConfigured ? "Leave blank to keep the encrypted secret" : "Stored encrypted; never displayed again"}><input name="clientSecret" type="password" autoComplete="new-password" required={!status.sso.clientSecretConfigured} /></Field>
    </div>
    <div className="berry-onboarding-policy"><Users aria-hidden /><div><strong>Just-in-time membership is on</strong><p>Any verified domain user can join as a member. The designated owner is the only account that can claim ownership.</p></div></div>
    <StepFooter busy={busy} onBack={onBack} continueLabel="Save Google SSO" />
  </form>;
}

function ConnectorsStep({ status, busy, onBack, onSave }: { status: SetupStatus; busy: boolean; onBack: () => void; onSave: (body: unknown) => void }) {
  const [drive, setDrive] = React.useState(status.connectors.drive.enabled || !status.connectors.configured);
  const [driveAccess, setDriveAccess] = React.useState(status.connectors.drive.access ?? "selected_files");
  const [gmail, setGmail] = React.useState(status.connectors.gmail.enabled);
  const [calendar, setCalendar] = React.useState(status.connectors.calendar.enabled);
  return <form onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      clientId: form.get("clientId"), clientSecret: emptyToUndefined(form.get("clientSecret")), pickerApiKey: emptyToUndefined(form.get("pickerApiKey")),
      pickerProjectNumber: emptyToUndefined(form.get("pickerProjectNumber")),
      drive: { enabled: drive, access: driveAccess, maxAccessLevel: connectorAccessLevel(form, "driveLevel", status.connectors.drive.maxAccessLevel) },
      gmail: { enabled: gmail, maxAccessLevel: connectorAccessLevel(form, "gmailLevel", status.connectors.gmail.maxAccessLevel) },
      calendar: { enabled: calendar, maxAccessLevel: connectorAccessLevel(form, "calendarLevel", status.connectors.calendar.maxAccessLevel) },
    });
  }}>
    <StepHeader eyebrow="Step 4 of 5" title="Choose Google data access" description="Use a separate OAuth client for Drive, Gmail, and Calendar. Each user grants their own access after signing in." />
    <CopyField label="Connector redirect URI" value={status.connectors.callbackUrl} />
    <div className="berry-onboarding-form-grid">
      <Field label="Connector client ID"><input name="clientId" required defaultValue={status.connectors.clientId ?? ""} /></Field>
      <Field label="Connector client secret" hint={status.connectors.clientSecretConfigured ? "Leave blank to keep the encrypted secret" : "Use the connector OAuth client secret"}><input name="clientSecret" type="password" autoComplete="new-password" required={!status.connectors.clientSecretConfigured} /></Field>
      <Field label="Picker API key" hint="Required for selected-file Drive access"><input name="pickerApiKey" type="password" required={drive && driveAccess === "selected_files" && !status.connectors.pickerConfigured} /></Field>
      <Field label="Picker project number"><input name="pickerProjectNumber" inputMode="numeric" required={drive && driveAccess === "selected_files"} defaultValue={status.connectors.pickerProjectNumber ?? ""} /></Field>
    </div>
    <div className="berry-onboarding-connectors">
      <ConnectorRow icon={HardDrive} title="Drive, Docs, Sheets & Slides" description="Search the workspace or let users choose specific files." checked={drive} onChange={setDrive} name="driveLevel" defaultLevel={status.connectors.drive.maxAccessLevel} extra={<select aria-label="Drive access mode" value={driveAccess} onChange={(event) => setDriveAccess(event.target.value as typeof driveAccess)}><option value="selected_files">Selected files</option><option value="search_workspace">Search workspace</option></select>} />
      <ConnectorRow icon={Mail} title="Gmail" description="Search and read mail; full access also permits drafts and sending." checked={gmail} onChange={setGmail} name="gmailLevel" defaultLevel={status.connectors.gmail.maxAccessLevel} />
      <ConnectorRow icon={Cloud} title="Google Calendar" description="Read schedules; full access also permits event changes." checked={calendar} onChange={setCalendar} name="calendarLevel" defaultLevel={status.connectors.calendar.maxAccessLevel} />
    </div>
    <StepFooter busy={busy} onBack={onBack} continueLabel="Save connector policy" />
  </form>;
}

function ClaimStep({ baseUrl, status, busy, setBusy, setError, onBack }: { baseUrl: string; status: SetupStatus; busy: boolean; setBusy: React.Dispatch<React.SetStateAction<boolean>>; setError: React.Dispatch<React.SetStateAction<string>>; onBack: () => void }) {
  return <>
    <StepHeader eyebrow="Step 5 of 5" title="Review and claim the deployment" description="The designated owner must now prove control of the exact Google Workspace account. This closes onboarding permanently." />
    <div className="berry-onboarding-review">
      <ReviewRow label="Organization" value={`${status.organization.name} · ${status.applicationName}`} />
      <ReviewRow label="Authentication" value={`Google only · @${status.sso.hostedDomain}`} />
      <ReviewRow label="Initial owner" value={status.ownerEmail ?? "Not configured"} />
      <ReviewRow label="Member access" value="Verified domain users · member role" />
      <ReviewRow label="Google data" value={[status.connectors.drive.enabled && "Drive", status.connectors.gmail.enabled && "Gmail", status.connectors.calendar.enabled && "Calendar"].filter(Boolean).join(", ") || "No connectors enabled"} />
    </div>
    <div className="berry-onboarding-claim">
      <LockKeyhole aria-hidden />
      <div><strong>Claim as {status.ownerEmail}</strong><p>No password is created. Berry will accept this exact Google identity and reject every other account until ownership is established.</p></div>
    </div>
    <div className="berry-onboarding-claim-actions">
      <button className="berry-onboarding-back" type="button" onClick={onBack}><ArrowLeft aria-hidden />Back</button>
      {status.readyToClaim && status.sso.hostedDomain ? <GoogleSsoButton standalone baseUrl={baseUrl} domain={status.sso.hostedDomain} busy={busy} setBusy={setBusy} setError={setError} /> : <button className="primary-button" disabled>Finish earlier steps first</button>}
    </div>
  </>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="berry-onboarding-field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  return <div className="berry-onboarding-copy"><span>{label}</span><code>{value}</code><button type="button" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }); }}><Clipboard data-hidden={copied} aria-hidden /><Check data-visible={copied} aria-hidden /></button></div>;
}

function ConnectorRow({ icon: Icon, title, description, checked, onChange, name, defaultLevel, extra }: { icon: React.ComponentType<{ "aria-hidden"?: boolean }>; title: string; description: string; checked: boolean; onChange: (value: boolean) => void; name: string; defaultLevel: "read" | "full"; extra?: React.ReactNode }) {
  return <article data-enabled={checked}><label className="berry-onboarding-connector-toggle"><input type="checkbox" aria-label={`Enable ${title}`} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden /></label><Icon aria-hidden /><div><strong>{title}</strong><p>{description}</p></div>{extra}<select name={name} aria-label={`${title} maximum access`} defaultValue={defaultLevel} disabled={!checked}><option value="read">Read only</option><option value="full">Full access</option></select></article>;
}

function connectorAccessLevel(form: FormData, name: string, fallback: "read" | "full"): "read" | "full" {
  const value = form.get(name);
  return value === "read" || value === "full" ? value : fallback;
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong><CheckCircle2 aria-hidden /></div>;
}

function StepFooter({ busy, disabled, onBack, onContinue, continueLabel }: { busy?: boolean; disabled?: boolean; onBack?: () => void; onContinue?: () => void; continueLabel: string }) {
  return <footer className="berry-onboarding-footer">{onBack ? <button className="berry-onboarding-back" type="button" onClick={onBack} disabled={busy}><ArrowLeft aria-hidden />Back</button> : <span />}<button className="primary-button" type={onContinue ? "button" : "submit"} disabled={busy || disabled} onClick={onContinue}>{busy ? "Saving…" : continueLabel}<ArrowRight aria-hidden /></button></footer>;
}

async function setupRequest<T = unknown>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET", credentials: "include" };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const result = await response.json().catch(() => null) as T & { message?: string | string[]; issues?: Array<{ message: string }> };
  if (!response.ok) {
    const message = Array.isArray(result?.message) ? result.message.join(" ") : result?.message;
    throw new Error(message ?? result?.issues?.map((issue) => issue.message).join(" ") ?? "Setup request failed");
  }
  return result;
}

function emptyToNull(value: FormDataEntryValue | null): string | null { const text = String(value ?? "").trim(); return text || null; }
function emptyToUndefined(value: FormDataEntryValue | null): string | undefined { const text = String(value ?? "").trim(); return text || undefined; }
function ownerDomain(email: string | null): string { return email?.split("@")[1] ?? ""; }
function messageFor(cause: unknown): string { return cause instanceof Error ? cause.message : "Setup request failed"; }
function clearSetupFragment(): void { if (typeof window !== "undefined" && window.location.hash.includes("setup=")) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`); }
