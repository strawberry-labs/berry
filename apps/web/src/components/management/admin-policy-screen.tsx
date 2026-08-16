import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, FileUp, Plus, Save, Search, UserPlus, Users } from "lucide-react";
import {
  AsyncState, Button, Checkbox, DataTable, FormSelect, Input, ManagementDialog,
  ManagementPage, MetricGrid, SearchInput, Section, StatusPill, SuccessMessage,
  Switch, Toolbar, formatDateTime, formatMoney, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import {
  calculateCacheMetric, UsageRangeControl, usageRangeForPreset,
  type UsageDateRange, type UsageRangePreset,
} from "./usage-controls";
import { parseMemberImportCsv, type MemberImportRow } from "../../lib/member-import";
import { memberAccessStatusOptions, memberStatusUpdate } from "../../lib/member-administration";
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
  const [message, setMessage] = React.useState("");
  const save = async () => {
    if (!client || !r.data) return;
    if (kind === "execution")
      await client.updateExecutionPolicy(tenantId, strip(r.data));
    else if (kind === "authentication")
      await client.updateAuthenticationPolicy(tenantId, strip(r.data));
    else await client.updateDataGovernancePolicy(tenantId, strip(r.data));
    setMessage("Policy saved and added to the organization audit log.");
    r.retry();
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
        {r.data ? (
          <Section
            title="Effective policy"
            actions={
              permissions.includes(write as any) ? (
                <Button onClick={save}>
                  <Save />
                  Save policy
                </Button>
              ) : null
            }
          >
            {kind === "execution" ? (
              <div className="grid gap-4">
                <PolicyFieldGroup title="Sandbox" description="Execution availability and interaction requirements." keys={["sandboxEnabled", "codeExecutionEnabled", "approvalRequired"]} value={r.data} disabled={!permissions.includes(write as any)} onChange={r.setData} />
                <PolicyFieldGroup title="Network" description="Outbound policy, domain boundaries, and available tool classes." keys={["outboundNetwork", "allowedDomains", "blockedDomains", "allowedToolClasses"]} value={r.data} disabled={!permissions.includes(write as any)} onChange={r.setData} />
                <PolicyFieldGroup title="Limits" description="Per-run, concurrency, request-rate, token, and sandbox-minute quotas." keys={["maxRunSeconds", "maxConcurrency", "requestsPerMinute", "tokenQuota", "sandboxMinuteQuota"]} value={r.data} disabled={!permissions.includes(write as any)} onChange={r.setData} />
              </div>
            ) : (
              <PolicyFieldsGrid value={r.data} disabled={!permissions.includes(write as any)} onChange={r.setData} />
            )}
            {message ? <SuccessMessage>{message}</SuccessMessage> : null}
          </Section>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

function PolicyFieldGroup({ title, description, keys, value, disabled, onChange }: { title: string; description: string; keys: string[]; value: Record<string, any>; disabled: boolean; onChange: (value: any) => void }) {
  return <div className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-medium text-foreground">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{description}</p><PolicyFieldsGrid keys={keys} value={value} disabled={disabled} onChange={onChange} /></div>;
}

function PolicyFieldsGrid({ keys, value, disabled, onChange }: { keys?: string[]; value: Record<string, any>; disabled: boolean; onChange: (value: any) => void }) {
  const entries = Object.entries(value).filter(([key]) => !["tenantId", "updatedAt"].includes(key) && (!keys || keys.includes(key)));
  return <div className="mt-3 grid gap-3 sm:grid-cols-2">{entries.map(([key, fieldValue]) => <label key={key} className="grid min-w-0 gap-1.5"><span className="text-xs font-medium text-foreground">{human(key)}</span>{typeof fieldValue === "boolean" ? <span className="flex h-9 items-center"><Switch checked={fieldValue} disabled={disabled} onCheckedChange={(checked) => onChange({ ...value, [key]: checked })} /></span> : typeof fieldValue === "number" ? <Input type="number" value={fieldValue} disabled={disabled} onChange={(event) => onChange({ ...value, [key]: Number(event.currentTarget.value) })} /> : Array.isArray(fieldValue) ? <Input value={fieldValue.join(", ")} disabled={disabled} onChange={(event) => onChange({ ...value, [key]: event.currentTarget.value.split(",").map((item) => item.trim()).filter(Boolean) })} /> : typeof fieldValue === "object" && fieldValue !== null ? <code className="overflow-auto rounded-md bg-muted/30 p-2 text-xs">{JSON.stringify(fieldValue)}</code> : <Input value={String(fieldValue ?? "")} disabled={disabled} onChange={(event) => onChange({ ...value, [key]: event.currentTarget.value })} />}{executionFieldHint(key) ? <span className="text-[11px] leading-4 text-muted-foreground">{executionFieldHint(key)}</span> : null}</label>)}</div>;
}

function executionFieldHint(key: string): string | null {
  return ({
    maxRunSeconds: "Seconds per run",
    maxConcurrency: "Concurrent runs",
    requestsPerMinute: "Requests per minute",
    tokenQuota: "Organization token quota",
    sandboxMinuteQuota: "Sandbox minutes",
    allowedDomains: "Comma-separated domains",
    blockedDomains: "Comma-separated domains",
    allowedToolClasses: "Comma-separated tool classes",
  } as Record<string, string>)[key] ?? null;
}

function human(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function strip(value: any) {
  const { tenantId, updatedAt, ...rest } = value;
  return rest;
}
