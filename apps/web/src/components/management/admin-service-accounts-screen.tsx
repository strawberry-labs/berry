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
  const [token, setToken] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const row = await client?.createServiceAccount(tenantId, {
      name: String(f.get("name")),
      permissions: ["org:read"],
      resourceRestrictions: [],
      expiresAt: null,
    });
    if (row) {
      setToken(row.token);
      setOpen(false);
    }
    r.retry();
  };
  return (
    <ManagementPage
      title="Service accounts"
      description="Scoped non-human principals with expiry, rotation, revocation, and one-time tokens."
      eyebrow="Security & data"
      actions={
        permissions.includes("service_accounts:write") ? (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            Create account
          </Button>
        ) : null
      }
    >
      {token ? (
        <div
          className="grid gap-1.5 break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-muted-foreground"
          role="status"
        >
          <b>Copy this token now</b>
          <code>{token}</code>
          <span>
            Berry stores only a hash. This token cannot be shown again.
          </span>
        </div>
      ) : null}
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Create service account"
        description="Create a non-human principal with the default read-only organization scope. Berry shows the token once after creation."
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
          className="grid gap-3 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={create}
        >
          <label>
            Account name
            <Input name="name" autoFocus required />
          </label>
        </form>
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={r.data.length === 0}
      >
        <DataTable
          label="Service accounts"
          columns={[
            "Name",
            "Permissions",
            "Status",
            "Token",
            "Last used",
            "Expires",
          ]}
          rows={r.data.map((x: any) => [
            <b>{x.name}</b>,
            x.permissions.join(", "),
            <StatusPill tone={x.status === "active" ? "good" : "danger"}>
              {x.status}
            </StatusPill>,
            `•••• ${x.tokenLast4}`,
            x.lastUsedAt ? new Date(x.lastUsedAt).toLocaleString() : "Never",
            x.expiresAt ? new Date(x.expiresAt).toLocaleDateString() : "Never",
          ])}
        />
      </AsyncState>
    </ManagementPage>
  );
}

function human(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
