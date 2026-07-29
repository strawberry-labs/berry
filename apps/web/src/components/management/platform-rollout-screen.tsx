import * as React from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { AsyncState, Button, Checkbox, DataTable, FormSelect, Input, ManagementPage, Section, StatusPill, SuccessMessage } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PlatformRolloutScreen({ client }: ManagementScreenProps) {
  const resource = useResource("platform:rollouts", async () => client ? client.platformRollouts() : [], [] as any[]);
  const [open, setOpen] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!client || !confirmed) return; const form = new FormData(event.currentTarget);
    await client.upsertPlatformRollout({
      feature: String(form.get("feature")), status: String(form.get("status")) as any, exposurePercent: Number(form.get("exposure")),
      target: { deploymentMode: String(form.get("deployment")), channel: String(form.get("channel")) },
      exclusions: String(form.get("exclusions")).split(",").map((value) => value.trim()).filter(Boolean),
      errorRateRollbackPercent: String(form.get("rollback")) ? Number(form.get("rollback")) : null,
      auditNote: String(form.get("auditNote")), confirmation: true, idempotencyKey: crypto.randomUUID(),
    });
    setOpen(false); setConfirmed(false); setMessage("Rollout rule saved to the platform operator audit trail."); resource.retry();
  }
  return <ManagementPage title="Feature rollout" description="Staged product availability with guardrails, exclusions, preview, rollback thresholds, and operator audit notes." eyebrow="Platform operations" actions={<Button disabled={!client} onClick={() => setOpen(true)}><Plus />New rule</Button>}>
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    {open ? <Section title="Preview rollout rule" description="Targets are evaluated by deployment mode and release channel. Excluded tenant IDs always win."><form className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={save}><label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Feature<Input name="feature" required /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Stage<FormSelect name="status" defaultValue="draft" options={[{ value: "draft", label: "Draft" }, { value: "internal", label: "Internal" }, { value: "beta", label: "Beta" }, { value: "gradual", label: "Gradual" }, { value: "general", label: "General" }]} /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Exposure %<Input name="exposure" type="number" min="0" max="100" step=".1" defaultValue="0" required /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Deployment<FormSelect name="deployment" defaultValue="all" options={[{ value: "all", label: "All" }, { value: "shared", label: "Shared" }, { value: "dedicated", label: "Dedicated" }, { value: "selfhost", label: "Self-hosted" }]} /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Channel<FormSelect name="channel" defaultValue="stable" options={[{ value: "stable", label: "Stable" }, { value: "preview", label: "Preview" }]} /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Auto-rollback error %<Input name="rollback" type="number" min="0" max="100" step=".1" /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">Excluded tenant IDs<Input name="exclusions" placeholder="tenant-a, tenant-b" /></label><label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">Audit note<Input name="auditNote" minLength={3} required /></label><label className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground sm:col-span-2"><Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} /><span>I reviewed the target, exposure, exclusions, and automatic rollback threshold.</span></label><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!confirmed}><ShieldCheck />Publish rule</Button></form></Section> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={resource.data.length === 0} emptyTitle="No rollout rules" emptyText="Create a draft rule to preview product availability before exposure.">
      <DataTable label="Feature rollout rules" columns={["Feature", "Stage", "Exposure", "Target", "Exclusions", "Rollback threshold", "Updated"]} rows={resource.data.map((row: any) => [<b>{row.feature}</b>, <StatusPill tone={row.status === "general" ? "good" : "info"}>{row.status}</StatusPill>, `${row.exposurePercent}%`, `${row.target.deploymentMode ?? "all"} / ${row.target.channel ?? "stable"}`, row.exclusions.length, row.errorRateRollbackPercent == null ? "—" : `${row.errorRateRollbackPercent}%`, new Date(row.updatedAt).toLocaleString()])} />
    </AsyncState>
  </ManagementPage>;
}
