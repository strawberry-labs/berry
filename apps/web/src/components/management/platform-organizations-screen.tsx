import * as React from "react";
import { Plus } from "lucide-react";
import { actionErrorMessage } from "@/lib/action-error";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  Num,
  StatusPill,
  SuccessMessage,
  formatDateTime,
  formatMoney,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PlatformOrganizationsScreen({
  client,
  config,
}: ManagementScreenProps) {
  const resource = useResource(
    "platform:organizations",
    async () =>
      client
        ? client.platformOrganizations()
        : config.platformTenants.map((row) => ({
            tenantId: row.id,
            name: row.name,
            slug: row.slug,
            lifecycle: row.lifecycle,
            deploymentMode: row.deploymentMode,
            region: row.region,
            hostname: row.hostname,
            plan: row.plan,
            seats: row.seats,
            monthlySpendMicros: row.monthlySpendMicros,
            prepaidBalanceMicros: "0",
            billingHealth: "demo",
            ssoHealth: "demo",
            updatedAt: row.updatedAt,
          })),
    [] as any[],
  );
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState("");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [lifecycleRequest, setLifecycleRequest] = React.useState<{
    tenantId: string;
    name: string;
    next: "active" | "suspended";
  } | null>(null);
  async function provision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    setFormError("");
    try {
      await client.provisionPlatformOrganization({
        name: String(form.get("name")),
        slug: String(form.get("slug")),
        deploymentMode: String(form.get("deployment")) as any,
        plan: String(form.get("plan")),
        region: String(form.get("region")) || null,
        auditNote: String(form.get("auditNote")),
        confirmation: true,
        idempotencyKey: crypto.randomUUID(),
      });
      setOpen(false);
      setMessage("Organization provisioned.");
      resource.retry();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not provision the organization. Nothing was created; try again."));
    }
  }
  async function lifecycle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !lifecycleRequest) return;
    const note = String(
      new FormData(event.currentTarget).get("auditNote"),
    ).trim();
    setPending(lifecycleRequest.tenantId);
    setFormError("");
    try {
      await client.updatePlatformOrganizationLifecycle(
        lifecycleRequest.tenantId,
        {
          lifecycle: lifecycleRequest.next,
          auditNote: note,
          confirmation: true,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setMessage(
        `Organization ${
          lifecycleRequest.next === "suspended" ? "suspended" : "reactivated"
        }.`,
      );
      setLifecycleRequest(null);
      resource.retry();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not change this organization. Its state is unchanged; try again."));
    } finally {
      setPending(null);
    }
  }
  const lifecycleAction =
    lifecycleRequest?.next === "suspended" ? "Suspend" : "Reactivate";
  // Organizations that are not running normally come first, then the biggest spenders.
  const organizations = [...resource.data].sort(
    (left: any, right: any) =>
      Number(left.lifecycle === "active") - Number(right.lifecycle === "active") ||
      Number(right.monthlySpendMicros) - Number(left.monthlySpendMicros),
  );
  const detail = activeId ? organizations.find((row: any) => row.tenantId === activeId) ?? null : null;
  return (
    <ManagementPage width="wide"
      title="Organizations"
      description="Every organization on this deployment: its plan, where it runs, and whether it is active."
      eyebrow="Platform operations"
      actions={
        <Button disabled={!client} onClick={() => { setFormError(""); setOpen(true); }}>
          <Plus />
          Provision organization
        </Button>
      }
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={Boolean(lifecycleRequest)}
        onOpenChange={(next) => {
          if (!next) setLifecycleRequest(null);
        }}
        title={`${lifecycleAction} organization`}
        description={
          lifecycleRequest
            ? lifecycleRequest.next === "suspended"
              ? `Members of ${lifecycleRequest.name} lose access until it is reactivated. Its data is kept.`
              : `Members of ${lifecycleRequest.name} can sign in and run tasks again.`
            : ""
        }
        size="sm"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLifecycleRequest(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="organization-lifecycle-form"
              variant={
                lifecycleRequest?.next === "suspended"
                  ? "destructive"
                  : "default"
              }
              disabled={Boolean(pending)}
            >
              {lifecycleAction}
            </Button>
          </>
        }
      >
        <form
          id="organization-lifecycle-form"
          className="grid gap-3"
          onSubmit={lifecycle}
        >
          <Field label="Reason" hint="Recorded in the operator audit trail.">
            <Input
              name="auditNote"
              minLength={3}
              autoFocus
              required
            />
          </Field>
          {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Provision organization"
        description="Creates a new, isolated organization. Its administrators get no access to this console."
        size="lg"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="provision-organization-form">
              Provision organization
            </Button>
          </>
        }
      >
        <form
          id="provision-organization-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={provision}
        >
          <Field label="Name">
            <Input name="name" autoFocus required />
          </Field>
          <Field label="Slug" hint="Lowercase letters, numbers, and hyphens.">
            <Input name="slug" pattern="[a-z0-9-]+" required />
          </Field>
          <Field label="Deployment">
            <FormSelect
              name="deployment"
              ariaLabel="Deployment"
              defaultValue="shared"
              options={[
                { value: "shared", label: "Shared" },
                { value: "dedicated", label: "Dedicated" },
                { value: "selfhost", label: "Self-hosted" },
              ]}
            />
          </Field>
          <Field label="Plan">
            <Input name="plan" defaultValue="enterprise" required />
          </Field>
          <Field label="Region" hint="Leave blank for the deployment default.">
            <Input name="region" />
          </Field>
          <Field label="Reason" hint="Recorded in the operator audit trail." className="sm:col-span-2">
            <Input name="auditNote" minLength={3} required />
          </Field>
          {formError ? <div className="sm:col-span-2"><InlineNotice tone="danger">{formError}</InlineNotice></div> : null}
        </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={resource.data.length === 0}
        emptyTitle="No organizations"
        emptyText="Provision the first organization to give a customer its own isolated workspace."
      >
        <DataTable
          label="Platform organizations"
          searchable
          columns={[
            "Organization",
            "Plan",
            "Deployment",
            "Region",
            "Lifecycle",
            "Seats",
            "Monthly spend",
          ]}
          onRowSelect={(index) => setActiveId(organizations[index]?.tenantId ?? null)}
          activeRow={detail ? organizations.indexOf(detail) : null}
          rowLabel={(index) => `${organizations[index]?.name ?? "Organization"} details`}
          rows={organizations.map((row: any) => [
            <CellStack primary={row.name} secondary={row.slug} />,
            sentence(row.plan),
            deploymentLabel(row.deploymentMode),
            row.region ?? "Default",
            <StatusPill tone={lifecycleTone(row.lifecycle)}>{sentence(row.lifecycle)}</StatusPill>,
            <Num value={row.seats} kind="number" />,
            <Num value={row.monthlySpendMicros} kind="compact-money" />,
          ])}
        />
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={detail.name}
          subtitle={detail.hostname ?? detail.slug}
          badge={<StatusPill tone={lifecycleTone(detail.lifecycle)}>{sentence(detail.lifecycle)}</StatusPill>}
          onClose={() => setActiveId(null)}
          footer={detail.lifecycle === "active" || detail.lifecycle === "suspended" ? (
            <Button
              variant="secondary"
              disabled={!client || pending === detail.tenantId}
              onClick={() => {
                setFormError("");
                setLifecycleRequest({
                  tenantId: detail.tenantId,
                  name: detail.name,
                  next: detail.lifecycle === "active" ? "suspended" : "active",
                });
              }}
            >
              {detail.lifecycle === "active" ? "Suspend organization" : "Reactivate organization"}
            </Button>
          ) : undefined}
        >
          <DefinitionList
            items={[
              { term: "Plan", detail: sentence(detail.plan) },
              { term: "Seats", detail: formatNumber(detail.seats) },
              { term: "Monthly spend", detail: formatMoney(detail.monthlySpendMicros) },
              { term: "Prepaid balance", detail: formatMoney(detail.prepaidBalanceMicros) },
              { term: "Billing", detail: <StatusPill tone={healthTone(detail.billingHealth)}>{sentence(detail.billingHealth)}</StatusPill> },
              { term: "Single sign-on", detail: <StatusPill tone={healthTone(detail.ssoHealth)}>{sentence(detail.ssoHealth)}</StatusPill> },
            ]}
          />
          <DefinitionList
            items={[
              { term: "Deployment", detail: deploymentLabel(detail.deploymentMode) },
              { term: "Region", detail: detail.region ?? "Deployment default" },
              { term: "Hostname", detail: detail.hostname ?? "—" },
              { term: "Slug", detail: <span className="font-mono text-xs">{detail.slug}</span> },
              { term: "Organization ID", detail: <span className="break-all font-mono text-xs">{detail.tenantId}</span> },
              { term: "Updated", detail: formatDateTime(detail.updatedAt) },
            ]}
          />
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}

type Tone = "neutral" | "good" | "warning" | "danger" | "info";

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`grid content-start gap-1.5 text-xs font-medium text-muted-foreground ${className ?? ""}`}>
      <span>{label}</span>
      {children}
      {hint ? <span className="font-normal leading-4">{hint}</span> : null}
    </label>
  );
}

function lifecycleTone(lifecycle: string): Tone {
  return lifecycle === "active" ? "good" : lifecycle === "suspended" ? "danger" : lifecycle === "provisioning" || lifecycle === "deleting" ? "warning" : "neutral";
}

function healthTone(health: string): Tone {
  if (/healthy|ok|active|enabled|configured/i.test(health) && !/not|un/i.test(health)) return "good";
  if (/fail|block|error|past/i.test(health)) return "danger";
  if (/degrad|warn|pending|low/i.test(health)) return "warning";
  return "neutral";
}

function deploymentLabel(mode: string) {
  return mode === "shared" ? "Shared" : mode === "dedicated" ? "Dedicated" : mode === "selfhost" ? "Self-hosted" : sentence(mode);
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
