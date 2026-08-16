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
export function AdminBillingScreen({ client, tenantId, permissions }: ManagementScreenProps) {
  const r = useResource(
    `billing:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.billingSummary(tenantId),
            client.billingHealth(tenantId),
            client.billingLedger(tenantId),
            client.autoRefill(tenantId),
          ])
        : [null, null, { items: [] }, null],
    [] as any,
  );
  const [confirmed, setConfirmed] = React.useState(false),
    [success, setSuccess] = React.useState(""),
    [open, setOpen] = React.useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await client?.createBillingCreditGrant(tenantId, {
      source: "manual",
      amountMicros: String(Math.round(Number(f.get("amount")) * 1e6)),
      currency: "usd",
      reason: String(f.get("reason")),
      externalRef: String(f.get("externalRef")) || null,
      confirmation: true,
      idempotencyKey: String(f.get("idempotencyKey")),
      metadata: {},
    });
    setConfirmed(false);
    setOpen(false);
    setSuccess("Organization credit grant completed.");
    r.retry();
  };
  const [s, h, l, a] = r.data;
  return (
    <ManagementPage
      title="Credits & billing"
      description="The organization owns one prepaid pool. Reservations, reconciliations, grants, and invoices are auditable."
      eyebrow="Finance"
      actions={
        permissions.includes("billing:write") ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            <Plus />
            Grant credit
          </Button>
        ) : null
      }
    >
      {success ? <SuccessMessage>{success}</SuccessMessage> : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={!r.loading && !s}
        emptyTitle="Billing data unavailable"
        emptyText="Connect the organization billing API to view balances, ledger entries, and refill health."
      >
        {s ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Prepaid balance",
                  value: formatMoney(s.prepaidBalanceMicros),
                },
                { label: "Provider", value: s.provider },
                {
                  label: "Billing health",
                  value: h?.status ?? "Unknown",
                  status: h?.status === "healthy" ? "good" : "warning",
                },
                {
                  label: "Auto-refill",
                  value: a?.supported
                    ? a.enabled
                      ? "On"
                      : "Off"
                    : "Unsupported",
                },
              ]}
            />
            <Section title="Credit ledger">
              <DataTable
                label="Credit ledger"
                columns={[
                  "Time",
                  "Kind",
                  "Amount",
                  "Balance",
                  "Source",
                  "Status",
                ]}
                rows={(l.items ?? []).map((x: any) => [
                  new Date(x.createdAt).toLocaleString(),
                  x.kind,
                  formatMoney(x.amountMicros),
                  formatMoney(x.balanceAfterMicros),
                  x.source,
                  <StatusPill tone="good">{x.status}</StatusPill>,
                ])}
              />
            </Section>
          </>
        ) : null}
      </AsyncState>
      <ManagementDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmed(false);
        }}
        title="Grant organization credit"
        description="Add funds to the shared prepaid pool. This financial mutation requires an audit reason, a unique idempotency key, and explicit confirmation."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="grant-credit-form"
              variant="destructive"
              disabled={!confirmed}
            >
              Grant credit
            </Button>
          </>
        }
      >
        <form
          id="grant-credit-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Amount (USD)
            <Input
              name="amount"
              type="number"
              min=".01"
              step=".01"
              autoFocus
              required
            />
          </label>
          <label>
            External reference
            <Input name="externalRef" />
          </label>
          <label className="sm:col-span-2">
            Idempotency key
            <Input
              name="idempotencyKey"
              defaultValue={crypto.randomUUID()}
              minLength={8}
              required
            />
          </label>
          <label className="sm:col-span-2">
            Reason
            <Input name="reason" minLength={3} required />
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground sm:col-span-2">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <span>
              I confirm this financial mutation changes the organization credit
              pool.
            </span>
          </label>
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}

function human(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
