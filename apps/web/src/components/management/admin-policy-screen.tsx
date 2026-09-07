import { toast } from "sonner";
import { actionErrorMessage } from "@/lib/action-error";
import { PolicyListInput } from "./policy-list-input";
import * as React from "react";
import { Save } from "lucide-react";
import { AsyncState, Button, FormSelect, Input, Section, ManagementPage, Switch } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
export function AdminPolicyScreen({
  kind,
  client,
  tenantId,
  permissions,
}: ManagementScreenProps & { kind: "execution" | "authentication" | "data" }) {
  const write =
    kind === "execution"
      ? "guardrails:write"
      : kind === "authentication"
        ? "auth_policy:write"
        : "data_policy:write";
  const r = useResource(
    `${kind}:${tenantId}`,
    async () => {
      if (!client) return null;
      return kind === "execution"
        ? client.executionPolicy(tenantId)
        : kind === "authentication"
          ? client.authenticationPolicy(tenantId)
          : client.dataGovernancePolicy(tenantId);
    },
    null as any,
  );
  const [draft, setDraft] = React.useState<any>(null);
  const draftRef = React.useRef<any>(null);
  const dirty = React.useRef(false);
  React.useEffect(() => { dirty.current = false; draftRef.current = null; setDraft(null); }, [kind, tenantId]);
  React.useEffect(() => {
    if (!dirty.current) { draftRef.current = r.data; setDraft(r.data); }
  }, [r.data, kind, tenantId]);
  function updateDraft(next: any) {
    dirty.current = true;
    draftRef.current = next;
    setDraft(next);
  }
  const [saveError, setSaveError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const saveInFlight = React.useRef(false);
  const save = async () => {
    if (!client || !draftRef.current || saveInFlight.current || !permissions.includes(write as any)) return;
    const submitted = draftRef.current;
    saveInFlight.current = true; setSaving(true); setSaveError("");
    try {
    if (kind === "execution")
      await client.updateExecutionPolicy(tenantId, strip(submitted));
    else if (kind === "authentication")
      await client.updateAuthenticationPolicy(tenantId, strip(submitted));
    else await client.updateDataGovernancePolicy(tenantId, strip(submitted));
    toast.success("Policy saved", { description: "Added to the organization audit log." });
    if (draftRef.current === submitted) dirty.current = false;
    r.retry();
    } catch (cause) { setSaveError(actionErrorMessage(cause, "Could not save the policy. Please try again. Your edits are still here.")); }
    finally { saveInFlight.current = false; setSaving(false); }
  };
  return (
    <ManagementPage
      title={
        kind === "execution"
          ? "Execution & network"
          : kind === "authentication"
            ? "Authentication"
            : "Data governance"
      }
      description={
        kind === "execution"
          ? "Sandbox, approvals, network access, concurrency, rate, token, and sandbox-minute controls."
          : kind === "authentication"
            ? "MFA, session lifetime, trusted devices, login methods, domains, and emergency owner access."
            : "Retention, residency, filters, moderation hooks, deletion, export, and legal-hold behavior."
      }
      eyebrow="Security & data"
    >
      {kind === "authentication" ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Local password accounts and the protected owner path stay active. Configure Google Workspace OIDC and just-in-time member provisioning under SSO &amp; SCIM; directory sync and SCIM remain reserved for a future release.
        </p>
      ) : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !r.data}
        emptyTitle="Policy unavailable"
        emptyText="Connect the organization API to load and edit the effective policy."
      >
        {draft ? (
          <form key={`${kind}:${tenantId}`} onSubmit={(event) => { event.preventDefault(); void save(); }}><Section
            title="Organization policy"
            actions={
              permissions.includes(write as any) ? (
                <Button type="submit" disabled={saving}>
                  <Save />
                  {saving ? "Saving…" : "Save policy"}
                </Button>
              ) : null
            }
          >
            {kind === "execution" ? (
              <fieldset disabled={saving} className="grid min-w-0 gap-6 border-0 p-0">
                <PolicyFieldGroup title="Sandbox" description="Execution availability and interaction requirements." keys={["sandboxEnabled", "codeExecutionEnabled", "approvalRequired"]} value={draft} disabled={!permissions.includes(write as any)} onChange={updateDraft} />
                <PolicyFieldGroup title="Network" description="Outbound policy, domain boundaries, and available tool classes." keys={["outboundNetwork", "allowedDomains", "blockedDomains", "allowedToolClasses"]} value={draft} disabled={!permissions.includes(write as any)} onChange={updateDraft} />
                <PolicyFieldGroup title="Limits" description="Per-run, concurrency, request-rate, token, and sandbox-minute quotas." keys={["maxRunSeconds", "maxConcurrency", "requestsPerMinute", "tokenQuota", "sandboxMinuteQuota"]} value={draft} disabled={!permissions.includes(write as any)} onChange={updateDraft} />
              </fieldset>
            ) : (
              <PolicyFieldsGrid value={draft} disabled={!permissions.includes(write as any)} onChange={updateDraft} />
            )}
            {saveError && <p role="alert" className="mt-4 text-sm text-[var(--berry-danger)]">{saveError}</p>}
          </Section></form>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

function PolicyFieldGroup({ title, description, keys, value, disabled, onChange }: { title: string; description: string; keys: string[]; value: Record<string, any>; disabled: boolean; onChange: (value: any) => void }) {
  return <section className="min-w-0 border-t border-[var(--berry-border)] pt-5 first:border-t-0 first:pt-0"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs text-[var(--berry-text-secondary)]">{description}</p><PolicyFieldsGrid keys={keys} value={value} disabled={disabled} onChange={onChange} /></section>;
}

const numericFields: Record<string, { min: number; nullable?: boolean; step?: string }> = {
  maxRunSeconds: { min: 1 }, maxConcurrency: { min: 1 }, requestsPerMinute: { min: 1 },
  tokenQuota: { min: 0, nullable: true }, sandboxMinuteQuota: { min: 0, nullable: true, step: "any" },
};

function PolicyFieldsGrid({ keys, value, disabled, onChange }: { keys?: string[]; value: Record<string, any>; disabled: boolean; onChange: (value: any) => void }) {
  const prefix = React.useId();
  const entries = (keys ?? Object.keys(value)).filter((key) => key in value && !["tenantId", "updatedAt"].includes(key));
  return <div className={`mt-4 grid min-w-0 gap-x-6 gap-y-5 ${entries.every((key) => typeof value[key] === "boolean") ? "lg:grid-cols-3" : "sm:grid-cols-2"}`}>{entries.map((key) => {
    const fieldValue = value[key]; const id = `${prefix}-${key}`; const label = human(key);
    const hint = executionFieldHint(key);
    const change = (next: unknown) => onChange({ ...value, [key]: next });
    if (typeof fieldValue === "boolean") return <div key={key} className="flex items-center justify-between gap-4 rounded-lg bg-[var(--berry-control-bg)] px-3 py-3"><label htmlFor={id} className="text-sm">{label}</label><Switch id={id} aria-label={label} checked={fieldValue} disabled={disabled} onCheckedChange={change} /></div>;
    return <div key={key} className={`grid min-w-0 content-start gap-2 ${key === "outboundNetwork" || key === "allowedToolClasses" ? "sm:col-span-2" : ""}`}>
      <label htmlFor={id} className="text-xs font-medium">{label}</label>
      {Array.isArray(fieldValue) ? <PolicyListInput id={id} label={label} value={fieldValue} domains={key === "allowedDomains" || key === "blockedDomains"} disabled={disabled} onChange={change} />
        : key === "outboundNetwork" ? <FormSelect ariaLabel={label} value={fieldValue} disabled={disabled} onChange={change} options={[{ value: "blocked", label: "Block outbound access" }, { value: "allowlist", label: "Allow listed domains only" }, { value: "unrestricted", label: "Unrestricted access" }]} />
        : numericFields[key] ? <PolicyNumberInput id={id} hint={hint} value={fieldValue} disabled={disabled} options={numericFields[key]!} onChange={change} />
        : typeof fieldValue === "number" ? <Input id={id} type="number" value={fieldValue} disabled={disabled} onChange={(event) => change(Number(event.currentTarget.value))} />
        : typeof fieldValue === "object" && fieldValue !== null ? <code className="overflow-auto rounded-md p-2 text-xs">{JSON.stringify(fieldValue)}</code>
        : <Input id={id} value={String(fieldValue ?? "")} disabled={disabled} onChange={(event) => change(event.currentTarget.value)} />}
      {hint && <p id={`${id}-hint`} className="text-[11px] leading-4 text-[var(--berry-text-secondary)]">{hint}</p>}
    </div>;
  })}</div>;
}

function PolicyNumberInput({ id, hint, value, disabled, options, onChange }: {
  id: string; hint: string | null; value: number | null; disabled: boolean;
  options: { min: number; nullable?: boolean; step?: string }; onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = React.useState(String(value ?? ""));
  React.useEffect(() => { setDraft(String(value ?? "")); }, [value]);
  return <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} type="number" min={options.min} step={options.step ?? "1"} required={!options.nullable} placeholder={options.nullable ? "No limit" : undefined} value={draft} disabled={disabled} onChange={(event) => {
    setDraft(event.currentTarget.value);
    onChange(event.currentTarget.value === "" ? null : Number(event.currentTarget.value));
  }} />;
}

function executionFieldHint(key: string): string | null {
  return ({
    maxRunSeconds: "Seconds per run",
    maxConcurrency: "Concurrent runs",
    requestsPerMinute: "Requests per minute",
    tokenQuota: "Total tokens. Leave blank for no limit.",
    sandboxMinuteQuota: "Total sandbox minutes. Leave blank for no limit.",
    allowedDomains: "Use hostnames such as api.example.com or *.example.com.",
    blockedDomains: "Use hostnames such as api.example.com or *.example.com.",
    allowedToolClasses: "Leave empty to keep the default tool classes.",
  } as Record<string, string>)[key] ?? null;
}

function human(value: string) {
  const labels: Record<string, string> = { sandboxEnabled: "Enable sandbox", codeExecutionEnabled: "Allow code execution", approvalRequired: "Require approval", outboundNetwork: "Outbound access", allowedDomains: "Allowed domains", blockedDomains: "Blocked domains", allowedToolClasses: "Allowed tool classes", maxRunSeconds: "Run timeout", maxConcurrency: "Concurrent runs", requestsPerMinute: "Request rate", tokenQuota: "Token quota", sandboxMinuteQuota: "Sandbox quota" };
  if (labels[value]) return labels[value];
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function strip(value: any) {
  const { tenantId, updatedAt, ...rest } = value;
  return rest;
}
