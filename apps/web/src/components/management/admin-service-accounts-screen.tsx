import * as React from "react";
import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { actionErrorMessage } from "@/lib/action-error";
import {
  AsyncState, Button, CellStack, DataTable, DefinitionList, DetailDrawer, EmptyPanel, FormSelect,
  InlineNotice, Input, ManagementDialog, ManagementPage, MetricGrid, StatusPill,
  formatDate, formatDateTime, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const DAY_MS = 86_400_000;
const EXPIRING_DAYS = 30;
const UNUSED_DAYS = 90;

const DOMAIN_LABELS: Record<string, string> = {
  org: "Organization",
  org_settings: "Organization settings",
  members: "People",
  departments: "Departments",
  rbac: "Roles",
  acl: "Resource access",
  models: "Models",
  skills: "Skills",
  mcp: "MCP",
  feature_flags: "Feature access",
  guardrails: "Execution & network",
  usage: "Usage",
  budgets: "Allowances",
  billing: "Billing",
  reports: "Reports",
  alerts: "Alerts",
  sso: "SSO & SCIM",
  policy: "Managed policy",
  auth_policy: "Sign-in policy",
  data_policy: "Data governance",
  service_accounts: "Service accounts",
  audit: "Audit log",
};

export function AdminServiceAccountsScreen({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const r = useResource(
    `accounts:${tenantId}`,
    async () => (client ? client.serviceAccounts(tenantId) : []),
    [] as any[],
  );
  const canWrite = permissions.includes("service_accounts:write");
  const [token, setToken] = React.useState<{ name: string; value: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [formError, setFormError] = React.useState("");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<any>(null);
  const [revokePending, setRevokePending] = React.useState(false);
  const now = Date.now();
  // Accounts that need a decision first: expiring, then long unused, then the rest; inactive ones last.
  const accounts = [...r.data].sort((left: any, right: any) => rank(left, now) - rank(right, now) || String(left.name).localeCompare(String(right.name)));
  const active = accounts.filter((account: any) => account.status === "active");
  const expiring = active.filter((account: any) => expiresSoon(account, now));
  const unused = active.filter((account: any) => isUnused(account, now));
  const detail = activeId ? accounts.find((account: any) => account.id === activeId) ?? null : null;

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const days = Number(f.get("expiry"));
    setFormError("");
    try {
      const row = await client?.createServiceAccount(tenantId, {
        name: String(f.get("name")),
        permissions: ["org:read"],
        resourceRestrictions: [],
        expiresAt: days > 0 ? new Date(Date.now() + days * DAY_MS).toISOString() : null,
      });
      if (row) {
        setCopied(false);
        setToken({ name: row.account.name, value: row.token });
        setOpen(false);
      }
      r.retry();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not create the service account. Try again."));
    }
  };
  const revoke = async () => {
    if (!client || !revoking) return;
    setRevokePending(true);
    setFormError("");
    try {
      await client.revokeServiceAccount(tenantId, revoking.id);
      setRevoking(null);
      r.retry();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not revoke this account. Its token still works; try again."));
    } finally {
      setRevokePending(false);
    }
  };
  const copyToken = () => {
    if (token) void navigator.clipboard?.writeText(token.value).then(() => setCopied(true)).catch(() => {});
  };
  const createButton = canWrite ? (
    <Button onClick={() => { setFormError(""); setOpen(true); }}>
      <Plus />
      Create account
    </Button>
  ) : null;

  return (
    <ManagementPage
      title="Service accounts"
      description="Tokens for scripts and integrations that call Berry without a person signing in."
      eyebrow="Identity & security"
      actions={accounts.length ? createButton : null}
    >
      {token ? (
        <InlineNotice
          tone="warning"
          title={`Copy the token for ${token.name} now`}
          action={<Button variant="ghost" onClick={() => setToken(null)}>Done</Button>}
        >
          <span className="block">Berry stores only a hash, so this token cannot be shown again.</span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-lg bg-[var(--berry-surface-under)] px-2.5 py-1.5 font-mono text-xs text-foreground">{token.value}</code>
            <Button variant="secondary" onClick={copyToken}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy token"}
            </Button>
          </span>
        </InlineNotice>
      ) : null}
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Create service account"
        description="The account can read organization details only. Its token is shown once, right after you create it."
        size="sm"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-service-account-form">
              Create account
            </Button>
          </>
        }
      >
        <form
          id="create-service-account-form"
          className="grid gap-3"
          onSubmit={create}
        >
          <Field label="Name" hint="Say what uses it, such as “Nightly usage export”.">
            <Input name="name" maxLength={120} autoFocus required />
          </Field>
          <Field label="Token expires" hint="An expired token stops working and the account must be replaced.">
            <FormSelect
              name="expiry"
              ariaLabel="Token expires"
              defaultValue="0"
              options={[
                { value: "0", label: "Never" },
                { value: "30", label: "In 30 days" },
                { value: "90", label: "In 90 days" },
                { value: "365", label: "In 1 year" },
              ]}
            />
          </Field>
          {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={Boolean(revoking)}
        onOpenChange={(next) => { if (!next) setRevoking(null); }}
        title="Revoke service account"
        description={`${revoking?.name ?? "This account"} stops working immediately. Anything using its token will fail, and this cannot be undone.`}
        size="sm"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setRevoking(null)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={revokePending} onClick={() => void revoke()}>
              {revokePending ? "Revoking…" : "Revoke account"}
            </Button>
          </>
        }
      >
        {formError
          ? <InlineNotice tone="danger">{formError}</InlineNotice>
          : <p className="text-md leading-5 text-muted-foreground">Token ending in <span className="font-mono text-xs text-foreground">{revoking?.tokenLast4}</span>{revoking?.lastUsedAt ? `, last used ${formatDateTime(revoking.lastUsedAt)}.` : ", never used."}</p>}
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
      >
        {accounts.length ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Active",
                  value: formatNumber(active.length),
                  hint: `of ${formatNumber(accounts.length)} ${accounts.length === 1 ? "account" : "accounts"}`,
                },
                {
                  label: `Expiring in ${EXPIRING_DAYS} days`,
                  value: formatNumber(expiring.length),
                  hint: expiring.length ? "Replace before the token stops working" : "No token is close to expiry",
                  ...(expiring.length ? { status: "warning" as const } : {}),
                },
                {
                  label: `Unused for ${UNUSED_DAYS}+ days`,
                  value: formatNumber(unused.length),
                  hint: unused.length ? "Active but idle; consider revoking" : "Every active account is in use",
                  ...(unused.length ? { status: "warning" as const } : {}),
                },
              ]}
            />
            <DataTable
              label="Service accounts"
              columns={[
                "Account",
                "Status",
                "Access",
                "Last used",
                "Expires",
                "Created",
              ]}
              onRowSelect={(index) => setActiveId(accounts[index]?.id ?? null)}
              activeRow={detail ? accounts.indexOf(detail) : null}
              rowLabel={(index) => `${accounts[index]?.name ?? "Account"} details`}
              rows={accounts.map((x: any) => [
                <CellStack primary={x.name} secondary={<span className="font-mono">•••• {x.tokenLast4}</span>} />,
                <StatusPill tone={x.status === "active" ? "good" : x.status === "expired" ? "warning" : "danger"}>
                  {x.status === "active" ? "Active" : x.status === "expired" ? "Expired" : "Revoked"}
                </StatusPill>,
                accessSummary(x.permissions),
                <span data-sort={x.lastUsedAt ? new Date(x.lastUsedAt).getTime() : 0} className="inline-flex flex-wrap items-center gap-2">
                  {x.lastUsedAt ? formatDateTime(x.lastUsedAt) : "Never"}
                  {x.status === "active" && isUnused(x, now) ? <StatusPill tone="warning">Idle</StatusPill> : null}
                </span>,
                <span data-sort={x.expiresAt ? new Date(x.expiresAt).getTime() : Number.MAX_SAFE_INTEGER} className="inline-flex flex-wrap items-center gap-2">
                  {x.expiresAt ? formatDate(x.expiresAt) : "Never"}
                  {x.status === "active" && expiresSoon(x, now) ? <StatusPill tone="warning">Soon</StatusPill> : null}
                </span>,
                formatDate(x.createdAt),
              ])}
            />
          </>
        ) : (
          <EmptyPanel
            icon={KeyRound}
            title="No service accounts"
            description="Create one to give a script or integration its own token instead of a person’s sign-in."
            action={createButton}
          />
        )}
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={detail.name}
          subtitle={<span className="font-mono">Token •••• {detail.tokenLast4}</span>}
          badge={<StatusPill tone={detail.status === "active" ? "good" : detail.status === "expired" ? "warning" : "danger"}>{detail.status === "active" ? "Active" : detail.status === "expired" ? "Expired" : "Revoked"}</StatusPill>}
          onClose={() => setActiveId(null)}
          footer={canWrite && detail.status === "active" ? (
            <Button variant="secondary" disabled={!client} onClick={() => { setFormError(""); setRevoking(detail); }}>
              Revoke account
            </Button>
          ) : undefined}
        >
          <DefinitionList
            items={[
              { term: "Last used", detail: detail.lastUsedAt ? formatDateTime(detail.lastUsedAt) : "Never" },
              { term: "Expires", detail: detail.expiresAt ? formatDateTime(detail.expiresAt) : "Never" },
              { term: "Created", detail: formatDateTime(detail.createdAt) },
              { term: "Updated", detail: formatDateTime(detail.updatedAt) },
            ]}
          />
          <DefinitionList
            items={[
              {
                term: "Permissions",
                detail: detail.permissions.length
                  ? <span className="grid gap-0.5">{detail.permissions.map((permission: string) => <span key={permission}>{permissionLabel(permission)}</span>)}</span>
                  : "None",
              },
              {
                term: "Limited to",
                detail: detail.resourceRestrictions.length
                  ? <span className="grid gap-0.5">{detail.resourceRestrictions.map((item: any) => <span key={`${item.type}:${item.id}`}>{sentence(item.type)} <span className="font-mono text-xs text-muted-foreground">{item.id}</span></span>)}</span>
                  : "Everything its permissions cover",
              },
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

function expiresSoon(account: any, now: number) {
  return Boolean(account.expiresAt) && new Date(account.expiresAt).getTime() - now < EXPIRING_DAYS * DAY_MS;
}

function isUnused(account: any, now: number) {
  const reference = account.lastUsedAt ?? account.createdAt;
  return now - new Date(reference).getTime() > UNUSED_DAYS * DAY_MS;
}

function rank(account: any, now: number) {
  if (account.status !== "active") return 3;
  if (expiresSoon(account, now)) return 0;
  if (isUnused(account, now)) return 1;
  return 2;
}

function permissionLabel(permission: string) {
  const [domain = "", action = "read"] = permission.split(":");
  return `${DOMAIN_LABELS[domain] ?? sentence(domain)} · ${action}`;
}

function accessSummary(permissions: string[]) {
  if (!permissions.length) return "None";
  const domains = [...new Set(permissions.map((permission) => permission.split(":")[0] ?? ""))].map((domain) => DOMAIN_LABELS[domain] ?? sentence(domain));
  const writes = permissions.some((permission) => !permission.endsWith(":read"));
  return (
    <CellStack
      primary={<span className="font-normal">{domains.slice(0, 2).join(", ")}{domains.length > 2 ? ` +${domains.length - 2}` : ""}</span>}
      secondary={writes ? "Can make changes" : "Read only"}
    />
  );
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
