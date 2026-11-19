import { toast } from "sonner";
import { actionErrorMessage } from "@/lib/action-error";
import { PolicyListInput } from "./policy-list-input";
import * as React from "react";
import { Save } from "lucide-react";
import {
  AsyncState, Button, Checkbox, FormSelect, InlineNotice, Input, ManagementPage, ManagementSwitch,
  Section, SettingList, SettingRow, formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

type PolicyKind = "execution" | "authentication" | "data";
type Unit = "seconds" | "minutes" | "hours" | "days" | "per minute" | "runs" | "tokens";
type FieldSpec = { key: string; title: string; description: string } & (
  | { type: "switch" }
  | { type: "number"; unit: Unit; min: number; nullable?: boolean; step?: string }
  | { type: "select"; options: Array<{ value: string; label: string }> }
  | { type: "list"; domains?: boolean }
  | { type: "choices"; options: Array<{ value: string; label: string }> }
  | { type: "text" }
  | { type: "days-by-type" }
);
type FieldGroup = { title: string; description?: string; fields: FieldSpec[] };

const FILTER_MODES = [
  { value: "off", label: "Off" },
  { value: "warn", label: "Warn the member" },
  { value: "block", label: "Block the message" },
];

const POLICY: Record<PolicyKind, { title: string; description: string; permission: string; groups: FieldGroup[] }> = {
  execution: {
    title: "Execution & network",
    description: "What agents may run in sandboxes, what those sandboxes can reach on the internet, and how much they can use.",
    permission: "guardrails:write",
    groups: [
      {
        title: "Sandbox",
        fields: [
          { key: "sandboxEnabled", type: "switch", title: "Sandbox", description: "Agents can work in an isolated sandbox with its own files and shell. Off means no sandbox for anyone." },
          { key: "codeExecutionEnabled", type: "switch", title: "Code execution", description: "Agents can run the code and commands they write inside the sandbox." },
          { key: "approvalRequired", type: "switch", title: "Require approval", description: "Agents stop and ask the member before running an action that needs approval." },
        ],
      },
      {
        title: "Network",
        description: "Outbound internet access from sandboxes.",
        fields: [
          {
            key: "outboundNetwork", type: "select", title: "Outbound access", description: "Blocked means no internet. Allowed domains only is the one mode that can also enforce blocked domains.",
            options: [
              { value: "blocked", label: "Blocked" },
              { value: "allowlist", label: "Allowed domains only" },
              { value: "unrestricted", label: "Unrestricted" },
            ],
          },
          { key: "allowedDomains", type: "list", domains: true, title: "Allowed domains", description: "The only hosts sandboxes can reach in allowed-domains mode. Use api.example.com or *.example.com. An empty list means no internet." },
          { key: "blockedDomains", type: "list", domains: true, title: "Blocked domains", description: "Removed from the allowed list. A wildcard allow rule that covers a blocked domain cannot be enforced, so list the allowed hosts explicitly." },
          { key: "allowedToolClasses", type: "list", title: "Allowed tool classes", description: "Tool classes agents may use. Leave empty to keep the default set." },
        ],
      },
      {
        title: "Limits",
        fields: [
          { key: "maxRunSeconds", type: "number", unit: "seconds", min: 1, title: "Run time limit", description: "The longest a single run can last before it is stopped." },
          { key: "maxConcurrency", type: "number", unit: "runs", min: 1, title: "Concurrent runs", description: "How many runs can be in progress at the same time." },
          { key: "requestsPerMinute", type: "number", unit: "per minute", min: 1, title: "Request rate", description: "Requests allowed per minute before new ones are refused." },
          { key: "tokenQuota", type: "number", unit: "tokens", min: 0, nullable: true, title: "Token quota", description: "Total tokens that can be used. Leave blank for no limit." },
          { key: "sandboxMinuteQuota", type: "number", unit: "minutes", min: 0, nullable: true, step: "any", title: "Sandbox quota", description: "Total sandbox minutes that can be used. Leave blank for no limit." },
        ],
      },
    ],
  },
  authentication: {
    title: "Sign-in",
    description: "How members prove who they are, how long they stay signed in, and which devices they can use.",
    permission: "auth_policy:write",
    groups: [
      {
        title: "Sign-in",
        fields: [
          {
            key: "allowedLoginMethods", type: "choices", title: "Sign-in methods", description: "The ways a member can sign in. Single sign-on also needs a connection under SSO & SCIM.",
            options: [
              { value: "password", label: "Password" },
              { value: "magic_link", label: "Email link" },
              { value: "oidc", label: "Single sign-on (OIDC)" },
              { value: "saml", label: "Single sign-on (SAML)" },
            ],
          },
          { key: "allowedDomains", type: "list", domains: true, title: "Allowed email domains", description: "Only accounts on these domains can sign in. Leave empty to allow any domain." },
          { key: "mfaRequired", type: "switch", title: "Require two-step verification", description: "Members must use a second factor each time they sign in." },
          { key: "trustedDevicesAllowed", type: "switch", title: "Trusted devices", description: "Members can mark a device as trusted so it is not asked for the second factor every time." },
        ],
      },
      {
        title: "Sessions",
        fields: [
          { key: "sessionMaxAgeMinutes", type: "number", unit: "minutes", min: 1, title: "Session length", description: "Members sign in again after this long, even if they have been active." },
          { key: "idleTimeoutMinutes", type: "number", unit: "minutes", min: 1, title: "Idle timeout", description: "Members are signed out after this long without activity." },
        ],
      },
      {
        title: "Access paths",
        fields: [
          { key: "emergencyLocalOwnerEnabled", type: "switch", title: "Emergency owner sign-in", description: "Keeps password sign-in open for the organization owner, so a broken single sign-on setup cannot lock everyone out." },
          { key: "mobileAppEnabled", type: "switch", title: "Berry mobile app", description: "Members can pair a phone and use the mobile app. Off refuses new pairings and mobile sessions." },
        ],
      },
    ],
  },
  data: {
    title: "Data governance",
    description: "How long member data is kept, where it is stored, and what is filtered before it reaches a model.",
    permission: "data_policy:write",
    groups: [
      {
        title: "Retention",
        description: "Data is deleted once it is older than its retention period.",
        fields: [
          { key: "conversationRetentionDays", type: "number", unit: "days", min: 0, title: "Conversations", description: "How long conversations are kept." },
          { key: "temporaryChatHours", type: "number", unit: "hours", min: 0, title: "Temporary chats", description: "How long a temporary chat is kept after it is created." },
          { key: "retentionByDataType", type: "days-by-type", title: "By data type", description: "Retention for each kind of stored data." },
          { key: "legalHoldEnabled", type: "switch", title: "Legal hold", description: "Stops all deletion, including retention and member-requested deletes, until it is turned off." },
        ],
      },
      {
        title: "Storage",
        fields: [
          { key: "residency", type: "text", title: "Data residency", description: "The region organization data is stored in. deployment-default uses the region this deployment runs in." },
        ],
      },
      {
        title: "Content filters",
        description: "Checks applied to a message before it is sent to a model.",
        fields: [
          { key: "piiFilterMode", type: "select", options: FILTER_MODES, title: "Personal data", description: "What happens when a message contains personal data such as an ID or card number." },
          { key: "credentialFilterMode", type: "select", options: FILTER_MODES, title: "Credentials", description: "What happens when a message contains a password, API key, or token." },
          { key: "moderationHookConfigured", type: "switch", title: "Moderation hook", description: "Sends content to the organization’s moderation service for review." },
        ],
      },
    ],
  },
};

export function AdminPolicyScreen({
  kind,
  client,
  tenantId,
  permissions,
}: ManagementScreenProps & { kind: PolicyKind }) {
  const spec = POLICY[kind];
  const write = spec.permission;
  const canWrite = permissions.includes(write as any);
  const formId = React.useId();
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
  const [changed, setChanged] = React.useState(false);
  const draftRef = React.useRef<any>(null);
  const dirty = React.useRef(false);
  React.useEffect(() => { dirty.current = false; setChanged(false); draftRef.current = null; setDraft(null); }, [kind, tenantId]);
  React.useEffect(() => {
    if (!dirty.current) { draftRef.current = r.data; setDraft(r.data); }
  }, [r.data, kind, tenantId]);
  function updateDraft(next: any) {
    dirty.current = true;
    setChanged(true);
    draftRef.current = next;
    setDraft(next);
  }
  function discard() {
    dirty.current = false;
    setChanged(false);
    setSaveError("");
    draftRef.current = r.data;
    setDraft(r.data);
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
    if (draftRef.current === submitted) { dirty.current = false; setChanged(false); }
    r.retry();
    } catch (cause) { setSaveError(actionErrorMessage(cause, "Could not save the policy. Please try again. Your edits are still here.")); }
    finally { saveInFlight.current = false; setSaving(false); }
  };
  const known = new Set(spec.groups.flatMap((group) => group.fields.map((field) => field.key)));
  const otherKeys = draft ? Object.keys(draft).filter((key) => !known.has(key) && !["tenantId", "updatedAt"].includes(key)) : [];
  const disabled = !canWrite || saving;
  const change = (key: string) => (next: unknown) => updateDraft({ ...draftRef.current, [key]: next });
  return (
    <ManagementPage width="narrow"
      title={spec.title}
      description={spec.description}
      eyebrow={kind === "execution" ? "AI & tools" : kind === "authentication" ? "Identity & security" : "Data & privacy"}
      actions={draft && canWrite ? (
        <>
          {changed ? <Button type="button" variant="ghost" disabled={saving} onClick={discard}>Discard changes</Button> : null}
          <Button type="submit" form={formId} disabled={saving || !changed}>
            <Save />
            {saving ? "Saving…" : "Save policy"}
          </Button>
        </>
      ) : null}
      status={draft?.updatedAt ? (
        <p className="text-xs text-muted-foreground">
          Last changed {formatDateTime(draft.updatedAt)}. Changes apply to the whole organization as soon as they are saved.
        </p>
      ) : undefined}
    >
      {draft && !canWrite ? (
        <InlineNotice tone="info">You can view this policy. Changing it needs a role with the {permissionLabel(kind)} permission.</InlineNotice>
      ) : null}
      {kind === "authentication" ? (
        <InlineNotice tone="info">
          Password sign-in and the emergency owner path stay available. Google Workspace sign-in is set up under SSO &amp; SCIM.
        </InlineNotice>
      ) : null}
      {saveError ? <InlineNotice tone="danger" title="Policy not saved">{saveError}</InlineNotice> : null}
      {draft ? policyWarnings(kind, draft).map((warning) => (
        <InlineNotice key={warning.title} tone={warning.tone} title={warning.title}>{warning.text}</InlineNotice>
      )) : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !r.data}
        emptyTitle="Policy unavailable"
        emptyText="Connect the organization API to load and edit the effective policy."
      >
        {draft ? (
          <form
            id={formId}
            key={`${kind}:${tenantId}`}
            className="grid min-w-0 gap-5"
            onSubmit={(event) => { event.preventDefault(); void save(); }}
          >
            {spec.groups.map((group) => {
              const fields = group.fields.filter((field) => field.key in draft);
              if (!fields.length) return null;
              return (
                <Section key={group.title} title={group.title} {...(group.description ? { description: group.description } : {})} flush>
                  <SettingList>
                    {fields.map((field) => (
                      <PolicyField key={field.key} field={field} value={draft[field.key]} disabled={disabled} onChange={change(field.key)} />
                    ))}
                  </SettingList>
                </Section>
              );
            })}
            {otherKeys.length ? (
              <Section title="Other settings" flush>
                <SettingList>
                  {otherKeys.map((key) => (
                    <PolicyField key={key} field={fallbackField(key, draft[key])} value={draft[key]} disabled={disabled} onChange={change(key)} />
                  ))}
                </SettingList>
              </Section>
            ) : null}
          </form>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

function PolicyField({ field, value, disabled, onChange }: { field: FieldSpec; value: any; disabled: boolean; onChange: (value: unknown) => void }) {
  const id = React.useId();
  if (field.type === "switch") {
    return (
      <SettingRow title={field.title} description={field.description}>
        <ManagementSwitch aria-label={field.title} checked={Boolean(value)} disabled={disabled} onCheckedChange={onChange} />
      </SettingRow>
    );
  }
  if (field.type === "select") {
    return (
      <SettingRow title={field.title} description={field.description}>
        <div className="w-full sm:w-56">
          <FormSelect ariaLabel={field.title} value={String(value)} disabled={disabled} onChange={onChange} options={field.options} />
        </div>
      </SettingRow>
    );
  }
  if (field.type === "number") {
    return (
      <SettingRow title={field.title} description={field.description}>
        <span className="flex items-center gap-2">
          <PolicyNumberInput label={field.title} value={value} disabled={disabled} options={field} onChange={onChange} />
          <span className="w-16 text-xs leading-4 text-muted-foreground">
            {field.unit}
            {typeof value === "number" ? <span className="block tabular-nums">{readable(value, field.unit)}</span> : null}
          </span>
        </span>
      </SettingRow>
    );
  }
  if (field.type === "list") {
    return (
      <SettingRow title={field.title} description={field.description} stacked>
        <PolicyListInput id={id} label={field.title} value={Array.isArray(value) ? value : []} domains={field.domains ?? false} disabled={disabled} onChange={onChange} />
      </SettingRow>
    );
  }
  if (field.type === "choices") {
    const selected: string[] = Array.isArray(value) ? value : [];
    return (
      <SettingRow title={field.title} description={field.description} stacked>
        <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label={field.title}>
          {field.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-md text-foreground">
              <Checkbox
                checked={selected.includes(option.value)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(field.options.map((item) => item.value).filter((item) => (item === option.value ? checked === true : selected.includes(item))))
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      </SettingRow>
    );
  }
  if (field.type === "days-by-type") {
    const entries = Object.entries((value ?? {}) as Record<string, number>);
    return (
      <>
        {entries.map(([type, days]) => (
          <SettingRow key={type} title={sentence(type)} description={`How long ${sentence(type).toLowerCase()} data is kept.`}>
            <span className="flex items-center gap-2">
              <PolicyNumberInput label={`${sentence(type)} retention`} value={days} disabled={disabled} options={{ min: 0 }} onChange={(next) => onChange({ ...value, [type]: next ?? 0 })} />
              <span className="w-16 text-xs text-muted-foreground">days</span>
            </span>
          </SettingRow>
        ))}
      </>
    );
  }
  if (typeof value === "object" && value !== null) {
    return (
      <SettingRow title={field.title} description={field.description} stacked>
        <pre className="max-h-40 overflow-auto rounded-lg bg-[var(--berry-surface-under)] p-3 font-mono text-xs leading-5 text-muted-foreground">{JSON.stringify(value, null, 2)}</pre>
      </SettingRow>
    );
  }
  return (
    <SettingRow title={field.title} description={field.description}>
      <div className="w-full sm:w-56">
        <Input aria-label={field.title} value={String(value ?? "")} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
      </div>
    </SettingRow>
  );
}

function PolicyNumberInput({ label, value, disabled, options, onChange }: {
  label: string; value: number | null; disabled: boolean;
  options: { min: number; nullable?: boolean; step?: string }; onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = React.useState(String(value ?? ""));
  React.useEffect(() => { setDraft(String(value ?? "")); }, [value]);
  return <Input aria-label={label} className="w-28 text-right tabular-nums" type="number" min={options.min} step={options.step ?? "1"} required={!options.nullable} placeholder={options.nullable ? "No limit" : undefined} value={draft} disabled={disabled} onChange={(event) => {
    setDraft(event.currentTarget.value);
    onChange(event.currentTarget.value === "" ? null : Number(event.currentTarget.value));
  }} />;
}

/** Combinations the sandbox cannot enforce, or that silently cut access, said before saving. */
function policyWarnings(kind: PolicyKind, draft: Record<string, any>): Array<{ tone: "warning" | "info"; title: string; text: string }> {
  const warnings: Array<{ tone: "warning" | "info"; title: string; text: string }> = [];
  if (kind === "execution") {
    const blocked = Array.isArray(draft.blockedDomains) ? draft.blockedDomains.length : 0;
    const allowed = Array.isArray(draft.allowedDomains) ? draft.allowedDomains.length : 0;
    if (draft.outboundNetwork === "unrestricted" && blocked) {
      warnings.push({ tone: "warning", title: "Blocked domains cannot be enforced with unrestricted access", text: "Sandboxes will refuse to start with this combination. Switch outbound access to allowed domains only, or clear the blocked list." });
    }
    if (draft.outboundNetwork === "allowlist" && !allowed) {
      warnings.push({ tone: "info", title: "No domains are allowed", text: "With an empty allowed list, sandboxes have no internet access." });
    }
  }
  if (kind === "authentication" && Array.isArray(draft.allowedLoginMethods) && draft.allowedLoginMethods.length === 0) {
    warnings.push({ tone: "warning", title: "No sign-in method is selected", text: "Select at least one method, or members will not be able to sign in." });
  }
  return warnings;
}

function fallbackField(key: string, value: unknown): FieldSpec {
  const title = sentence(key);
  if (typeof value === "boolean") return { key, title, description: "", type: "switch" };
  if (typeof value === "number") return { key, title, description: "", type: "number", unit: "runs", min: 0 };
  if (Array.isArray(value)) return { key, title, description: "", type: "list" };
  return { key, title, description: "", type: "text" };
}

function readable(value: number, unit: Unit): string {
  const minutes = unit === "seconds" ? value / 60 : unit === "minutes" ? value : unit === "hours" ? value * 60 : unit === "days" ? value * 1440 : null;
  if (minutes === null) return "";
  const trim = (number: number) => String(Math.round(number * 10) / 10);
  if (unit === "days") return value >= 365 && value % 365 === 0 ? `= ${trim(value / 365)} y` : "";
  if (minutes >= 2880) return `= ${trim(minutes / 1440)} d`;
  if (minutes >= 120 && unit !== "hours") return `= ${trim(minutes / 60)} h`;
  if (unit === "seconds" && minutes >= 1) return `= ${trim(minutes)} min`;
  return "";
}

function permissionLabel(kind: PolicyKind) {
  return kind === "execution" ? "execution and network write" : kind === "authentication" ? "authentication write" : "data governance write";
}

function sentence(value: string) {
  const text = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function strip(value: any) {
  const { tenantId, updatedAt, ...rest } = value;
  return rest;
}
