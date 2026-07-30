import * as React from "react";
import { Plus } from "lucide-react";
import {
  AsyncState,
  Button,
  DataTable,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  StatusPill,
  SuccessMessage,
  formatMoney,
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
  const [lifecycleRequest, setLifecycleRequest] = React.useState<{
    tenantId: string;
    name: string;
    next: "active" | "suspended";
  } | null>(null);
  async function provision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
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
    setMessage(
      "Organization provisioned and recorded in the operator audit trail.",
    );
    resource.retry();
  }
  async function lifecycle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !lifecycleRequest) return;
    const note = String(
      new FormData(event.currentTarget).get("auditNote"),
    ).trim();
    setPending(lifecycleRequest.tenantId);
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
    } finally {
      setPending(null);
    }
  }
  const lifecycleAction =
    lifecycleRequest?.next === "suspended" ? "Suspend" : "Reactivate";
  return (
    <ManagementPage
      title="Organizations"
      description="Provision, inspect, suspend, and review deployment, billing, and SSO health across tenants."
      eyebrow="Platform operations"
      actions={
        <Button disabled={!client} onClick={() => setOpen(true)}>
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
            ? `${lifecycleAction} ${lifecycleRequest.name}. This changes tenant access and will be recorded in the operator audit trail.`
            : ""
        }
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
          className="grid gap-1.5"
          onSubmit={lifecycle}
        >
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Audit note
            <Input
              name="auditNote"
              minLength={3}
              placeholder="Explain why this lifecycle change is needed"
              autoFocus
              required
            />
          </label>
        </form>
      </ManagementDialog>
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Provision organization"
        description="Create an isolated tenant. Organization administrators do not receive platform access."
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
              Confirm provisioning
            </Button>
          </>
        }
      >
        <form
          id="provision-organization-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={provision}
        >
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Name
            <Input name="name" autoFocus required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Slug
            <Input name="slug" pattern="[a-z0-9-]+" required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Deployment
            <FormSelect
              name="deployment"
              defaultValue="shared"
              options={[
                { value: "shared", label: "Shared" },
                { value: "dedicated", label: "Dedicated" },
                { value: "selfhost", label: "Self-hosted" },
              ]}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Plan
            <Input name="plan" defaultValue="enterprise" required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Region
            <Input name="region" placeholder="Deployment default" />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
            Audit note
            <Input name="auditNote" minLength={3} required />
          </label>
        </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={resource.data.length === 0}
        emptyTitle="No organizations"
      >
        <DataTable
          label="Platform organizations"
          searchable
          columns={[
            "Organization",
            "Lifecycle",
            "Deployment",
            "Region",
            "Seats",
            "Monthly spend",
            "Billing",
            "SSO",
            "Action",
          ]}
          rows={resource.data.map((row: any) => [
            <span>
              <b>{row.name}</b>
              <small>{row.slug}</small>
            </span>,
            <StatusPill tone={row.lifecycle === "active" ? "good" : "warning"}>
              {row.lifecycle}
            </StatusPill>,
            row.deploymentMode,
            row.region ?? "—",
            row.seats,
            formatMoney(row.monthlySpendMicros),
            row.billingHealth,
            row.ssoHealth,
            <Button
              variant={row.lifecycle === "active" ? "destructive" : "secondary"}
              disabled={pending === row.tenantId}
              onClick={() =>
                setLifecycleRequest({
                  tenantId: row.tenantId,
                  name: row.name,
                  next: row.lifecycle === "active" ? "suspended" : "active",
                })
              }
            >
              {row.lifecycle === "active" ? "Suspend" : "Reactivate"}
            </Button>,
          ])}
        />
      </AsyncState>
    </ManagementPage>
  );
}
