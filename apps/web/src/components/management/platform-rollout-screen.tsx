import * as React from "react";
import { Plus } from "lucide-react";
import { actionErrorMessage } from "@/lib/action-error";
import {
  AsyncState,
  Button,
  Checkbox,
  DataTable,
  DefinitionList,
  DetailDrawer,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  Meter,
  StatusPill,
  SuccessMessage,
  formatDateTime,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const STAGES = [
  { value: "draft", label: "Draft" },
  { value: "internal", label: "Internal" },
  { value: "beta", label: "Beta" },
  { value: "gradual", label: "Gradual" },
  { value: "general", label: "General" },
];

export function PlatformRolloutScreen({ client }: ManagementScreenProps) {
  const resource = useResource(
    "platform:rollouts",
    async () => (client ? client.platformRollouts() : []),
    [] as any[],
  );
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<any>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [formError, setFormError] = React.useState("");
  // Rules still rolling out come before finished and draft ones; most recently changed first within each.
  const rules = [...resource.data].sort(
    (left: any, right: any) => stageRank(left.status) - stageRank(right.status) || String(right.updatedAt).localeCompare(String(left.updatedAt)),
  );
  const detail = activeId ? rules.find((row: any) => row.id === activeId) ?? null : null;
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !confirmed) return;
    const form = new FormData(event.currentTarget);
    setFormError("");
    try {
      await client.upsertPlatformRollout({
        feature: String(form.get("feature")),
        status: String(form.get("status")) as any,
        exposurePercent: Number(form.get("exposure")),
        target: {
          deploymentMode: String(form.get("deployment")),
          channel: String(form.get("channel")),
        },
        exclusions: String(form.get("exclusions"))
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        errorRateRollbackPercent: String(form.get("rollback"))
          ? Number(form.get("rollback"))
          : null,
        auditNote: String(form.get("auditNote")),
        confirmation: true,
        idempotencyKey: crypto.randomUUID(),
      });
      setOpen(false);
      setConfirmed(false);
      setMessage("Rollout rule saved.");
      resource.retry();
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not save the rule. Exposure is unchanged; try again."));
    }
  }
  const openRule = (rule: any) => {
    setFormError("");
    setConfirmed(false);
    setEditing(rule);
    setOpen(true);
  };
  const newButton = (
    <Button disabled={!client} onClick={() => openRule(null)}>
      <Plus />
      New rule
    </Button>
  );
  return (
    <ManagementPage
      title="Feature rollout"
      description="Which organizations get a feature, how far it has rolled out, and when it rolls back on its own."
      eyebrow="Platform operations"
      actions={rules.length ? newButton : null}
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmed(false);
        }}
        title={editing ? `Edit rollout: ${editing.feature}` : "New rollout rule"}
        description="A rule exposes one feature to a share of matching organizations. Excluded organizations never get it."
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
            <Button
              type="submit"
              form="create-rollout-rule-form"
              disabled={!confirmed}
            >
              {editing ? "Save rule" : "Publish rule"}
            </Button>
          </>
        }
      >
        <form
          id="create-rollout-rule-form"
          key={editing?.id ?? "new"}
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={save}
        >
          <Field label="Feature" hint={editing ? "The feature key cannot change; create a new rule instead." : "The feature key, as it appears in code."}>
            <Input name="feature" className="font-mono text-xs" defaultValue={editing?.feature ?? ""} readOnly={Boolean(editing)} autoFocus={!editing} required />
          </Field>
          <Field label="Stage">
            <FormSelect name="status" ariaLabel="Stage" defaultValue={editing?.status ?? "draft"} options={STAGES} />
          </Field>
          <Field label="Exposure (%)" hint="Share of matching organizations that get the feature.">
            <Input
              name="exposure"
              type="number"
              min="0"
              max="100"
              step=".1"
              defaultValue={String(editing?.exposurePercent ?? 0)}
              required
            />
          </Field>
          <Field label="Roll back above error rate (%)" hint="Optional. The feature rolls back on its own when its error rate passes this.">
            <Input name="rollback" type="number" min="0" max="100" step=".1" defaultValue={editing?.errorRateRollbackPercent == null ? "" : String(editing.errorRateRollbackPercent)} />
          </Field>
          <Field label="Deployment">
            <FormSelect
              name="deployment"
              ariaLabel="Deployment"
              defaultValue={String(editing?.target?.deploymentMode ?? "all")}
              options={[
                { value: "all", label: "All deployments" },
                { value: "shared", label: "Shared" },
                { value: "dedicated", label: "Dedicated" },
                { value: "selfhost", label: "Self-hosted" },
              ]}
            />
          </Field>
          <Field label="Release channel">
            <FormSelect
              name="channel"
              ariaLabel="Release channel"
              defaultValue={String(editing?.target?.channel ?? "stable")}
              options={[
                { value: "stable", label: "Stable" },
                { value: "preview", label: "Preview" },
              ]}
            />
          </Field>
          <Field label="Excluded organizations" hint="Organization IDs, separated by commas." className="sm:col-span-2">
            <Input name="exclusions" className="font-mono text-xs" defaultValue={(editing?.exclusions ?? []).join(", ")} />
          </Field>
          <Field label="Reason" hint="Recorded in the operator audit trail." className="sm:col-span-2">
            <Input name="auditNote" minLength={3} required />
          </Field>
          <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground sm:col-span-2">
            <Checkbox
              className="mt-0.5"
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            <span>I checked the target, exposure, exclusions, and rollback threshold.</span>
          </label>
          {formError ? <div className="sm:col-span-2"><InlineNotice tone="danger">{formError}</InlineNotice></div> : null}
        </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
      >
        {rules.length ? (
          <DataTable
            label="Feature rollout rules"
            columns={[
              "Feature",
              "Stage",
              "Exposure",
              "Target",
              "Excluded",
              "Rolls back above",
              "Updated",
            ]}
            onRowSelect={(index) => setActiveId(rules[index]?.id ?? null)}
            activeRow={detail ? rules.indexOf(detail) : null}
            rowLabel={(index) => `${rules[index]?.feature ?? "Rule"} details`}
            rows={rules.map((row: any) => [
              <span className="font-mono text-xs font-medium text-foreground">{row.feature}</span>,
              <StatusPill tone={stageTone(row.status)}>{stageLabel(row.status)}</StatusPill>,
              <span className="block w-32" data-sort={Number(row.exposurePercent)}>
                <Meter value={Number(row.exposurePercent)} max={100} label={`${formatNumber(row.exposurePercent)}%`} />
              </span>,
              targetLabel(row.target),
              row.exclusions.length ? `${formatNumber(row.exclusions.length)} ${row.exclusions.length === 1 ? "organization" : "organizations"}` : "None",
              row.errorRateRollbackPercent == null
                ? "No auto-rollback"
                : <span className="tabular-nums" data-sort={Number(row.errorRateRollbackPercent)}>{formatNumber(row.errorRateRollbackPercent)}% errors</span>,
              formatDateTime(row.updatedAt),
            ])}
          />
        ) : (
          <EmptyPanel
            title="No rollout rules"
            description="Create a rule to expose a feature to a share of organizations. Start with a draft at 0% and raise exposure in steps."
            action={newButton}
          />
        )}
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={detail.feature}
          subtitle={`Updated ${formatDateTime(detail.updatedAt)}`}
          badge={<StatusPill tone={stageTone(detail.status)}>{stageLabel(detail.status)}</StatusPill>}
          onClose={() => setActiveId(null)}
          footer={
            <Button variant="secondary" disabled={!client} onClick={() => openRule(detail)}>
              Edit rule
            </Button>
          }
        >
          <Meter value={Number(detail.exposurePercent)} max={100} label="Exposure" detail={`${formatNumber(detail.exposurePercent)}% of matching organizations`} />
          <DefinitionList
            items={[
              { term: "Stage", detail: stageLabel(detail.status) },
              { term: "Target", detail: targetLabel(detail.target) },
              {
                term: "Auto-rollback",
                detail: detail.errorRateRollbackPercent == null ? "Off" : `When the error rate passes ${formatNumber(detail.errorRateRollbackPercent)}%`,
              },
              {
                term: "Excluded",
                detail: detail.exclusions.length
                  ? <span className="grid gap-0.5">{detail.exclusions.map((id: string) => <span key={id} className="break-all font-mono text-xs">{id}</span>)}</span>
                  : "No organizations",
              },
              { term: "Owner", detail: <span className="break-all font-mono text-xs">{detail.ownerUserId}</span> },
            ]}
          />
        </DetailDrawer>
      ) : null}
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

function stageLabel(status: string) {
  return STAGES.find((stage) => stage.value === status)?.label ?? status;
}

function stageTone(status: string): "good" | "info" | "neutral" {
  return status === "general" ? "good" : status === "draft" ? "neutral" : "info";
}

function stageRank(status: string) {
  return status === "gradual" || status === "beta" || status === "internal" ? 0 : status === "draft" ? 1 : 2;
}

function targetLabel(target: Record<string, unknown> | null | undefined) {
  const mode = String(target?.deploymentMode ?? "all");
  const channel = String(target?.channel ?? "stable");
  const deployment = mode === "all" ? "All deployments" : mode === "shared" ? "Shared" : mode === "dedicated" ? "Dedicated" : mode === "selfhost" ? "Self-hosted" : mode;
  return `${deployment} · ${channel === "preview" ? "Preview" : channel === "stable" ? "Stable" : channel} channel`;
}
