import * as React from "react";
import { ExternalLink, Plus } from "lucide-react";
import { actionErrorMessage } from "@/lib/action-error";
import {
  AsyncState, Button, Checkbox, DataTable, DefinitionList, InlineNotice, Input, ManagementDialog,
  ManagementPage, Meter, MetricGrid, Num, Section, StatusPill, SuccessMessage,
  formatCompactMoney, formatDate, formatDateTime, formatMoney, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { AdminBillingSkeleton } from "./management-screen-skeletons";

type Tone = "neutral" | "good" | "warning" | "danger" | "info";

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
    [formError, setFormError] = React.useState(""),
    [idempotencyKey, setIdempotencyKey] = React.useState(""),
    [open, setOpen] = React.useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setFormError("");
    try {
      await client?.createBillingCreditGrant(tenantId, {
        source: "manual",
        amountMicros: String(Math.round(Number(f.get("amount")) * 1e6)),
        currency: "usd",
        reason: String(f.get("reason")),
        externalRef: String(f.get("externalRef")) || null,
        confirmation: true,
        idempotencyKey,
        metadata: {},
      });
      setConfirmed(false);
      setOpen(false);
      setSuccess("Credit added to the organization balance.");
      r.retry();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not add the credit. Nothing was charged or granted; try again."));
    }
  };
  const [s, h, l, a] = r.data;
  const invoices: any[] = [...(s?.invoices ?? [])].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const grants: any[] = s?.activeGrants ?? [];
  const meterEvents: any[] = s?.recentMeterEvents ?? [];
  const ledger: any[] = l?.items ?? [];
  const openInvoices = invoices.filter((invoice) => invoice.status === "open");
  const uncollectible = invoices.filter((invoice) => invoice.status === "uncollectible");
  const openInvoiceMicros = openInvoices.reduce((sum, invoice) => sum + Number(invoice.totalMicros), 0);
  const grantedMicros = grants.reduce((sum, grant) => sum + Number(grant.amountMicros), 0);
  const grantRemainingMicros = grants.reduce((sum, grant) => sum + Number(grant.remainingMicros), 0);
  const failedMeterEvents = meterEvents.filter((event) => event.status === "failed");
  const notConfigured = Boolean(s) && (h?.status === "not_configured" || (s.billingDependencyRequired && !s.providerConfigured));
  const belowRefillTrigger = Boolean(a?.supported && a.enabled && a.triggerBalanceMicros && s && Number(s.prepaidBalanceMicros) < Number(a.triggerBalanceMicros));
  return (
    <ManagementPage width="wide"
      title="Billing"
      description="The organization’s prepaid credit, invoices, and every movement on the balance."
      eyebrow="Usage & billing"
      actions={
        permissions.includes("billing:write") ? (
          <Button
            variant="secondary"
            onClick={() => {
              setFormError("");
              setIdempotencyKey(crypto.randomUUID());
              setOpen(true);
            }}
          >
            <Plus />
            Add credit
          </Button>
        ) : null
      }
    >
      {success ? <SuccessMessage>{success}</SuccessMessage> : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        skeleton={<AdminBillingSkeleton />}
        empty={!r.loading && !s}
        emptyTitle="Billing data unavailable"
        emptyText="Connect the organization billing API to view balances, ledger entries, and refill health."
      >
        {s ? (
          <>
            <MetricGrid
              items={[
                {
                  label: "Credit balance",
                  value: formatCompactMoney(s.prepaidBalanceMicros),
                  exactValue: formatMoney(s.prepaidBalanceMicros),
                  hint: a?.supported
                    ? a.enabled
                      ? `Auto-refill adds ${formatCompactMoney(a.purchaseAmountMicros)} below ${formatCompactMoney(a.triggerBalanceMicros)}`
                      : "Auto-refill is off"
                    : "Auto-refill is not available with this provider",
                  ...(Number(s.prepaidBalanceMicros) <= 0 ? { status: "danger" as const } : belowRefillTrigger ? { status: "warning" as const } : {}),
                },
                {
                  label: "Unused credit grants",
                  value: formatCompactMoney(grantRemainingMicros),
                  exactValue: formatMoney(grantRemainingMicros),
                  hint: grants.length
                    ? `of ${formatCompactMoney(grantedMicros)} across ${formatNumber(grants.length)} active ${grants.length === 1 ? "grant" : "grants"}`
                    : "No active grants",
                },
                {
                  label: "Open invoices",
                  value: formatCompactMoney(openInvoiceMicros),
                  exactValue: formatMoney(openInvoiceMicros),
                  hint: openInvoices.length ? `${formatNumber(openInvoices.length)} awaiting payment` : "Nothing awaiting payment",
                  ...(uncollectible.length ? { status: "danger" as const } : {}),
                },
              ]}
            />
            {notConfigured ? (
              <InlineNotice tone="warning" title="Billing is not connected">
                {h?.explanation || "No billing provider is configured, so usage is not invoiced and the balance does not refill."}
              </InlineNotice>
            ) : h && h.status === "blocked" ? (
              <InlineNotice tone="danger" title="Billing is blocking requests">
                {h.explanation}{h.recoveryStatus ? ` Recovery: ${sentence(h.recoveryStatus)}.` : ""}
              </InlineNotice>
            ) : h && h.status === "degraded" ? (
              <InlineNotice tone="warning" title="Billing is degraded">
                {h.explanation}{h.recoveryStatus ? ` Recovery: ${sentence(h.recoveryStatus)}.` : ""}
              </InlineNotice>
            ) : null}
            {failedMeterEvents.length ? (
              <InlineNotice tone="danger" title={`${formatNumber(failedMeterEvents.length)} usage ${failedMeterEvents.length === 1 ? "report" : "reports"} failed to reach ${providerLabel(s.provider)}`}>
                That usage ({formatMoney(failedMeterEvents.reduce((sum, event) => sum + Number(event.costBilledMicros), 0))}) is not on an invoice yet. The failed reports are listed under usage reports below.
              </InlineNotice>
            ) : null}
            {uncollectible.length ? (
              <InlineNotice tone="danger" title={`${formatNumber(uncollectible.length)} ${uncollectible.length === 1 ? "invoice is" : "invoices are"} marked uncollectible`}>
                Payment could not be collected. Update the payment method with your billing provider.
              </InlineNotice>
            ) : null}
            <Section title="Invoices" flush>
              <DataTable
                label="Invoices"
                columns={["Period", "Invoice", "Status", "Total", "Issued"]}
                rows={invoices.map((invoice) => [
                  invoice.periodStart && invoice.periodEnd ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}` : "—",
                  invoice.hostedInvoiceUrl ? (
                    <a
                      className="inline-flex items-center gap-1 font-mono text-xs text-foreground underline-offset-2 hover:underline"
                      href={invoice.hostedInvoiceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {invoice.externalInvoiceId ?? "View invoice"}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    <span className="font-mono text-xs">{invoice.externalInvoiceId ?? "—"}</span>
                  ),
                  <StatusPill tone={invoiceTone(invoice.status)}>{sentence(invoice.status)}</StatusPill>,
                  <Num value={invoice.totalMicros} kind="money" />,
                  formatDate(invoice.createdAt),
                ])}
              />
            </Section>
            <Section title="Balance activity" description="Purchases, grants, holds for running requests, and settled usage, newest first." flush>
              <DataTable
                label="Balance activity"
                columns={["Time", "Type", "Amount", "Balance after", "Source", "Status"]}
                rows={ledger.map((x: any) => [
                  formatDateTime(x.createdAt),
                  ledgerKind(x.kind),
                  <Num value={x.amountMicros} kind="money" />,
                  <Num value={x.balanceAfterMicros} kind="money" />,
                  sentence(x.source),
                  <StatusPill tone={ledgerTone(x.status)}>{sentence(x.status)}</StatusPill>,
                ])}
              />
            </Section>
            {grants.length ? (
              <Section title="Credit grants" description="Credit added outside of purchases. Grants are spent before purchased credit runs out." flush>
                <DataTable
                  label="Credit grants"
                  columns={["Added", "Source", "Remaining", "Granted", "Reference"]}
                  rows={grants.map((grant) => [
                    formatDate(grant.createdAt),
                    sentence(grant.source),
                    <span className="block w-40" data-sort={Number(grant.remainingMicros)}>
                      <Meter value={Number(grant.amountMicros) - Number(grant.remainingMicros)} max={Number(grant.amountMicros)} label={`${formatMoney(grant.remainingMicros)} left`} />
                    </span>,
                    <Num value={grant.amountMicros} kind="money" />,
                    grant.externalRef ? <span className="font-mono text-xs">{grant.externalRef}</span> : "—",
                  ])}
                />
              </Section>
            ) : null}
            <Section title="Provider and metering" description="How usage reaches the billing provider. Check here when an invoice looks wrong.">
              <div className="grid gap-4">
                <DefinitionList
                  items={[
                    { term: "Provider", detail: <>{providerLabel(s.provider)} <span className="text-muted-foreground">· {s.providerConfigured ? "connected" : "not connected"}</span></> },
                    ...(h ? [
                      { term: "Status", detail: <StatusPill tone={h.status === "healthy" ? "good" : h.status === "blocked" ? "danger" : "warning"}>{sentence(h.status)}</StatusPill> },
                      { term: "Credit holds", detail: h.reservationHealthy ? "Working" : "Failing — requests may be refused" },
                      { term: "Usage ingest", detail: h.ingestHealthy ? "Working" : "Failing — usage may be missing from invoices" },
                    ] : []),
                    {
                      term: "Auto-refill",
                      detail: a?.supported
                        ? a.enabled
                          ? `Buys ${formatMoney(a.purchaseAmountMicros)} when the balance falls below ${formatMoney(a.triggerBalanceMicros)}`
                          : "Off"
                        : "Not available",
                    },
                    { term: "Balance as of", detail: formatDateTime(s.updatedAt) },
                  ]}
                />
                {meterEvents.length ? (
                  <DataTable
                    label="Usage reports"
                    initialPageSize={5}
                    columns={["Time", "Meter", "Quantity", "Billed", "Status", "Reported"]}
                    rows={[...meterEvents]
                      .sort((left, right) => Number(right.status === "failed") - Number(left.status === "failed") || String(right.createdAt).localeCompare(String(left.createdAt)))
                      .map((event) => [
                        formatDateTime(event.createdAt),
                        sentence(event.meter),
                        <Num value={event.quantity} />,
                        <Num value={event.costBilledMicros} kind="money" />,
                        <StatusPill tone={event.status === "reported" ? "good" : event.status === "failed" ? "danger" : event.status === "pending" ? "warning" : "neutral"}>{sentence(event.status)}</StatusPill>,
                        event.reportedAt ? formatDateTime(event.reportedAt) : "—",
                      ])}
                  />
                ) : null}
              </div>
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
        title="Add credit"
        description="Adds a manual credit grant to the organization balance. The grant is recorded in the audit log with your reason."
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
              disabled={!confirmed}
            >
              Add credit
            </Button>
          </>
        }
      >
        <form
          id="grant-credit-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={submit}
        >
          <Field label="Amount (USD)">
            <Input
              name="amount"
              type="number"
              min=".01"
              step=".01"
              autoFocus
              required
            />
          </Field>
          <Field label="Reference" hint="Optional. A purchase order or ticket number.">
            <Input name="externalRef" />
          </Field>
          <Field label="Reason" hint="Recorded in the audit log." className="sm:col-span-2">
            <Input name="reason" minLength={3} required />
          </Field>
          <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground sm:col-span-2">
            <Checkbox
              className="mt-0.5"
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <span>I confirm this increases the organization’s credit balance.</span>
          </label>
          {formError ? <div className="sm:col-span-2"><InlineNotice tone="danger">{formError}</InlineNotice></div> : null}
        </form>
      </ManagementDialog>
    </ManagementPage>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`grid content-start gap-1.5 text-xs font-medium text-muted-foreground ${className ?? ""}`}>
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal leading-4">{hint}</span> : null}
    </label>
  );
}

function providerLabel(provider: string) {
  return provider === "stripe" ? "Stripe" : provider === "lago" ? "Lago" : provider === "none" ? "No provider" : sentence(provider);
}

function ledgerKind(kind: string) {
  return ({
    purchase: "Purchase",
    reservation: "Hold for a request",
    reconciliation: "Usage settled",
    release: "Hold released",
    refund: "Refund",
    expiration: "Credit expired",
    grant: "Credit grant",
    adjustment: "Adjustment",
  } as Record<string, string>)[kind] ?? sentence(kind);
}

function ledgerTone(status: string): Tone {
  if (/fail|error|void|reject/i.test(status)) return "danger";
  if (/pend|hold|reserv|process/i.test(status)) return "warning";
  if (/post|settl|complet|succe|applied|paid/i.test(status)) return "good";
  return "neutral";
}

function invoiceTone(status: string): Tone {
  return status === "paid" ? "good" : status === "open" ? "warning" : status === "uncollectible" ? "danger" : "neutral";
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
