import * as React from "react";
import { Plus } from "lucide-react";
import { actionErrorMessage } from "@/lib/action-error";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  MetricGrid,
  Section,
  SegmentedControl,
  StatusPill,
  SuccessMessage,
  formatDate,
  formatDateTime,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

type Panel = "view" | "report" | "destination" | "rule";
type View = "alerts" | "reports" | "views" | "deliveries";

const SIGNALS = [
  { value: "spend_threshold", label: "Spend threshold" },
  { value: "quota_threshold", label: "Quota threshold" },
  { value: "projected_overrun", label: "Projected overrun" },
  { value: "credits", label: "Credit balance" },
  { value: "unusual_spend", label: "Unusual spend" },
  { value: "request_volume", label: "Request volume" },
  { value: "error_rate", label: "Error rate" },
  { value: "latency", label: "Latency" },
  { value: "blocked_requests", label: "Blocked requests" },
  { value: "system_health", label: "System health" },
];

const PANEL_COPY: Record<Panel, { title: string; description: string; submit: string }> = {
  view: {
    title: "New saved view",
    description: "Saves a usage view of the last 30 days that scheduled reports can send.",
    submit: "Save view",
  },
  report: {
    title: "Schedule report",
    description: "Emails a saved view to the recipients on a fixed cadence.",
    submit: "Schedule report",
  },
  destination: {
    title: "Add destination",
    description: "Where alerts are sent. A webhook secret is stored encrypted and cannot be shown again.",
    submit: "Add destination",
  },
  rule: {
    title: "New alert rule",
    description: "Notifies a destination when a signal crosses the threshold within the window.",
    submit: "Create rule",
  },
};

export function ReportsAlertsScreen({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const resource = useResource(
    `reports:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.savedAnalyticsViews(tenantId),
            client.reportSchedules(tenantId),
            client.reportRuns(tenantId),
            client.alertDestinations(tenantId),
            client.alertRules(tenantId),
            client.alertDeliveries(tenantId),
          ])
        : [[], [], [], [], [], []],
    [[], [], [], [], [], []] as any,
  );
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const [view, setView] = React.useState<View>("alerts");
  const [destinationKind, setDestinationKind] = React.useState<"email" | "webhook">("email");
  const [message, setMessage] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [views, schedules, runs, destinations, rules, deliveries] =
    resource.data;
  const canWriteReports = permissions.includes("reports:write");
  const canWriteAlerts = permissions.includes("alerts:write");
  const destinationById = new Map<string, any>(destinations.map((item: any) => [item.id, item]));
  const viewById = new Map<string, any>(views.map((item: any) => [item.id, item]));
  const latestRunBySchedule = new Map<string, any>();
  for (const run of runs as any[]) {
    const current = latestRunBySchedule.get(run.scheduleId);
    if (!current || String(run.createdAt) > String(current.createdAt)) latestRunBySchedule.set(run.scheduleId, run);
  }
  const enabledRules = rules.filter((rule: any) => rule.enabled).length;
  const activeSchedules = schedules.filter((schedule: any) => schedule.status === "active");
  const nextRun = activeSchedules
    .map((schedule: any) => schedule.nextRunAt)
    .filter(Boolean)
    .sort()[0];
  const failedDeliveries = deliveries.filter((row: any) => row.status === "failed").length;
  const failedRuns = runs.filter((run: any) => run.status === "failed").length;
  const failures = failedDeliveries + failedRuns;
  const hasAnything = views.length + schedules.length + destinations.length + rules.length > 0;

  function openPanel(next: Panel) {
    setFormError("");
    setDestinationKind("email");
    setPanel(next);
  }
  async function attempt(action: () => Promise<unknown>, done: string) {
    setFormError("");
    try {
      await action();
      finish(done);
    } catch (cause) {
      setFormError(actionErrorMessage(cause, "Could not save this. Nothing was created; try again."));
    }
  }
  async function createView(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    await attempt(() => client.createSavedAnalyticsView(tenantId, {
      name: String(form.get("name")),
      visibility: String(form.get("visibility")) as "private" | "tenant",
      filters: {
        from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
    }), "Saved view created.");
  }
  async function createReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    await attempt(() => client.createReportSchedule(tenantId, {
      name: String(form.get("name")),
      savedViewId: String(form.get("view")),
      format: String(form.get("format")) as "csv" | "html",
      cadence: String(form.get("cadence")) as "daily" | "weekly" | "monthly",
      timezone: String(form.get("timezone")),
      recipients: String(form.get("recipients"))
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    }), "Report scheduled. Each run appears in the delivery log once the mail provider confirms it.");
  }
  async function createDestination(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const kind = String(form.get("kind")) as "email" | "webhook";
    const secret = String(form.get("secret") ?? "");
    await attempt(() => client.createAlertDestination(tenantId, {
      kind,
      label: String(form.get("label")),
      emailRecipients:
        kind === "email"
          ? String(form.get("recipients") ?? "")
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : [],
      ...(secret ? { secret } : {}),
    }), "Destination added.");
  }
  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    await attempt(() => client.createAlertRule(tenantId, {
      name: String(form.get("name")),
      signal: String(form.get("signal")) as any,
      enabled: true,
      threshold: Number(form.get("threshold")),
      windowMinutes: Number(form.get("window")),
      destinationIds: [String(form.get("destination"))],
    }), "Alert rule created and enabled.");
  }
  function finish(text: string) {
    setPanel(null);
    setMessage(text);
    resource.retry();
  }

  const destinationName = (id: string) => destinationById.get(id)?.label ?? "Removed destination";
  const copy = panel ? PANEL_COPY[panel] : null;

  return (
    <ManagementPage width="wide"
      title="Reports & alerts"
      description="Get told when spend, errors, or credit cross a line, and send usage reports on a schedule."
      eyebrow="Usage & billing"
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={panel !== null}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
        title={copy?.title ?? "Create"}
        description={copy?.description ?? ""}
        size={panel === "report" || panel === "rule" ? "lg" : "md"}
        footer={
          panel ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPanel(null)}
              >
                Cancel
              </Button>
              <Button type="submit" form={`create-${panel}-form`}>
                {copy?.submit}
              </Button>
            </>
          ) : undefined
        }
      >
        {panel === "view" ? (
          <form id="create-view-form" className="grid gap-3 sm:grid-cols-2" onSubmit={createView}>
            <Field label="Name">
              <Input name="name" autoFocus required />
            </Field>
            <Field label="Who can use it">
              <FormSelect
                name="visibility"
                ariaLabel="Who can use it"
                defaultValue="tenant"
                options={[
                  { value: "tenant", label: "Everyone with usage access" },
                  { value: "private", label: "Only me" },
                ]}
              />
            </Field>
          </form>
        ) : null}
        {panel === "report" ? (
          <form id="create-report-form" className="grid gap-3 sm:grid-cols-2" onSubmit={createReport}>
            <Field label="Name">
              <Input name="name" autoFocus required />
            </Field>
            <Field label="Saved view">
              <FormSelect
                name="view"
                ariaLabel="Saved view"
                required
                options={views.map((item: any) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
            </Field>
            <Field label="Cadence">
              <FormSelect
                name="cadence"
                ariaLabel="Cadence"
                defaultValue="weekly"
                options={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "monthly", label: "Monthly" },
                ]}
              />
            </Field>
            <Field label="Format">
              <FormSelect
                name="format"
                ariaLabel="Format"
                defaultValue="csv"
                options={[
                  { value: "csv", label: "CSV attachment" },
                  { value: "html", label: "HTML email" },
                ]}
              />
            </Field>
            <Field label="Timezone" hint="IANA name, such as Asia/Dubai.">
              <Input
                name="timezone"
                defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
                required
              />
            </Field>
            <Field label="Recipients" hint="Email addresses, separated by commas." className="sm:col-span-2">
              <Input
                name="recipients"
                type="text"
                placeholder="owner@example.com, finance@example.com"
                required
              />
            </Field>
          </form>
        ) : null}
        {panel === "destination" ? (
          <form id="create-destination-form" className="grid gap-3 sm:grid-cols-2" onSubmit={createDestination}>
            <Field label="Name">
              <Input name="label" autoFocus required />
            </Field>
            <Field label="Type">
              <FormSelect
                name="kind"
                ariaLabel="Type"
                value={destinationKind}
                onChange={(value) => setDestinationKind(value as "email" | "webhook")}
                options={[
                  { value: "email", label: "Email" },
                  { value: "webhook", label: "Webhook" },
                ]}
              />
            </Field>
            {destinationKind === "email" ? (
              <Field label="Recipients" hint="Email addresses, separated by commas." className="sm:col-span-2">
                <Input name="recipients" placeholder="ops@example.com" required />
              </Field>
            ) : (
              <Field label="Signing secret" hint="At least 8 characters. Used to sign each webhook request." className="sm:col-span-2">
                <Input
                  name="secret"
                  type="password"
                  minLength={8}
                  autoComplete="new-password"
                />
              </Field>
            )}
          </form>
        ) : null}
        {panel === "rule" ? (
          <form id="create-rule-form" className="grid gap-3 sm:grid-cols-2" onSubmit={createRule}>
            <Field label="Name">
              <Input name="name" autoFocus required />
            </Field>
            <Field label="Signal">
              <FormSelect name="signal" ariaLabel="Signal" defaultValue="spend_threshold" options={SIGNALS} />
            </Field>
            <Field label="Threshold" hint="The value the signal must reach to alert.">
              <Input
                name="threshold"
                type="number"
                min="0"
                step=".01"
                required
              />
            </Field>
            <Field label="Window (minutes)" hint="How far back the signal is measured.">
              <Input
                name="window"
                type="number"
                min="1"
                defaultValue="60"
                required
              />
            </Field>
            <Field label="Send to" className="sm:col-span-2">
              <FormSelect
                name="destination"
                ariaLabel="Send to"
                options={destinations.map((destination: any) => ({
                  value: destination.id,
                  label: destination.label,
                }))}
              />
            </Field>
          </form>
        ) : null}
        {formError ? <div className="mt-3"><InlineNotice tone="danger">{formError}</InlineNotice></div> : null}
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
      >
        {hasAnything ? (
          <MetricGrid
            items={[
              {
                label: "Alert rules on",
                value: formatNumber(enabledRules),
                hint: `of ${formatNumber(rules.length)} ${rules.length === 1 ? "rule" : "rules"}`,
              },
              {
                label: "Reports scheduled",
                value: formatNumber(activeSchedules.length),
                hint: nextRun ? `Next run ${formatDateTime(nextRun)}` : `of ${formatNumber(schedules.length)} ${schedules.length === 1 ? "schedule" : "schedules"}`,
              },
              {
                label: "Failed deliveries",
                value: formatNumber(failures),
                hint: `of ${formatNumber(deliveries.length + runs.length)} recent attempts`,
                ...(failures ? { status: "danger" as const } : {}),
              },
            ]}
          />
        ) : null}
        {failures ? (
          <InlineNotice
            tone="danger"
            title={`${formatNumber(failures)} recent ${failures === 1 ? "delivery" : "deliveries"} failed`}
            action={view === "deliveries" ? undefined : <Button variant="secondary" onClick={() => setView("deliveries")}>View log</Button>}
          >
            An alert or report did not reach its destination. The delivery log shows the error for each attempt.
          </InlineNotice>
        ) : null}
        <SegmentedControl
          label="Reports and alerts view"
          value={view}
          onChange={setView}
          options={[
            { value: "alerts", label: "Alerts" },
            { value: "reports", label: "Scheduled reports" },
            { value: "views", label: "Saved views" },
            { value: "deliveries", label: "Delivery log" },
          ]}
        />
        {view === "alerts" ? (
          <>
            <Section
              title="Alert rules"
              description="Each rule watches one signal and notifies its destinations when the threshold is crossed."
              actions={canWriteAlerts ? (
                <Button disabled={!client || destinations.length === 0} onClick={() => openPanel("rule")}>
                  <Plus />
                  New rule
                </Button>
              ) : null}
              flush
            >
              {rules.length ? (
                <DataTable
                  label="Alert rules"
                  columns={["Rule", "Alerts when", "Sends to", "State", "Updated"]}
                  rows={[...rules]
                    .sort((left: any, right: any) => Number(right.enabled) - Number(left.enabled) || String(left.name).localeCompare(String(right.name)))
                    .map((row: any) => [
                      <CellStack primary={row.name} secondary={signalLabel(row.signal)} />,
                      <span className="tabular-nums">Reaches {formatNumber(row.threshold)} within {formatWindow(row.windowMinutes)}</span>,
                      row.destinationIds.length ? row.destinationIds.map(destinationName).join(", ") : "No destination",
                      <StatusPill tone={row.enabled ? "good" : "neutral"}>{row.enabled ? "On" : "Off"}</StatusPill>,
                      formatDate(row.updatedAt),
                    ])}
                />
              ) : (
                <SectionEmpty
                  title="No alert rules"
                  description={destinations.length
                    ? "Create a rule to be notified when spend, errors, or credit cross a threshold."
                    : "Add a destination first, then create a rule that sends to it."}
                />
              )}
            </Section>
            <Section
              title="Destinations"
              description="The inboxes and webhooks alert rules can send to."
              actions={canWriteAlerts ? (
                <Button variant="secondary" disabled={!client} onClick={() => openPanel("destination")}>
                  <Plus />
                  Add destination
                </Button>
              ) : null}
              flush
            >
              {destinations.length ? (
                <DataTable
                  label="Alert destinations"
                  columns={["Destination", "Type", "Sends to", "Status", "Added"]}
                  rows={destinations.map((row: any) => [
                    <b className="font-medium text-foreground">{row.label}</b>,
                    row.kind === "email" ? "Email" : "Webhook",
                    row.kind === "email" ? (row.emailRecipients.join(", ") || "No recipients") : "Signed webhook request",
                    <StatusPill tone={row.configured ? "good" : "warning"}>{row.configured ? "Ready" : "Needs setup"}</StatusPill>,
                    formatDate(row.createdAt),
                  ])}
                />
              ) : (
                <SectionEmpty title="No destinations" description="Add an email list or a webhook so alert rules have somewhere to send." />
              )}
            </Section>
          </>
        ) : null}
        {view === "reports" ? (
          <Section
            title="Scheduled reports"
            description="A saved view, emailed on a fixed cadence."
            actions={canWriteReports ? (
              <Button disabled={!client || views.length === 0} onClick={() => openPanel("report")}>
                <Plus />
                Schedule report
              </Button>
            ) : null}
            flush
          >
            {schedules.length ? (
              <DataTable
                label="Scheduled reports"
                columns={["Report", "Cadence", "Recipients", "Status", "Last run", "Next run"]}
                rows={schedules.map((row: any) => {
                  const lastRun = latestRunBySchedule.get(row.id);
                  return [
                    <CellStack primary={row.name} secondary={`${viewById.get(row.savedViewId)?.name ?? "Removed view"} · ${row.format === "csv" ? "CSV" : "HTML email"}`} />,
                    <CellStack primary={<span className="font-normal">{sentence(row.cadence)}</span>} secondary={row.timezone} />,
                    row.recipients.length > 1 ? `${row.recipients[0]} +${row.recipients.length - 1}` : row.recipients[0] ?? "—",
                    <StatusPill tone={row.status === "active" ? "good" : row.status === "paused" ? "warning" : "neutral"}>{sentence(row.status)}</StatusPill>,
                    lastRun ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {formatDateTime(lastRun.completedAt ?? lastRun.createdAt)}
                        <StatusPill tone={runTone(lastRun.status)}>{sentence(lastRun.status)}</StatusPill>
                      </span>
                    ) : row.lastRunAt ? formatDateTime(row.lastRunAt) : "Not run yet",
                    row.nextRunAt ? formatDateTime(row.nextRunAt) : "—",
                  ];
                })}
              />
            ) : (
              <SectionEmpty
                title="No scheduled reports"
                description={views.length ? "Schedule a saved view to email it daily, weekly, or monthly." : "Create a saved view first; a schedule sends a saved view."}
              />
            )}
          </Section>
        ) : null}
        {view === "views" ? (
          <Section
            title="Saved views"
            description="Named usage views that scheduled reports send."
            actions={canWriteReports ? (
              <Button disabled={!client} onClick={() => openPanel("view")}>
                <Plus />
                New saved view
              </Button>
            ) : null}
            flush
          >
            {views.length ? (
              <DataTable
                label="Saved views"
                columns={["View", "Date range", "Visible to", "Used by", "Updated"]}
                rows={views.map((row: any) => {
                  const used = schedules.filter((schedule: any) => schedule.savedViewId === row.id).length;
                  return [
                    <b className="font-medium text-foreground">{row.name}</b>,
                    row.filters?.from && row.filters?.to ? `${formatDate(row.filters.from)} – ${formatDate(row.filters.to)}` : "—",
                    row.visibility === "private" ? "Only the owner" : "Everyone with usage access",
                    used ? `${formatNumber(used)} ${used === 1 ? "schedule" : "schedules"}` : "Not scheduled",
                    formatDate(row.updatedAt),
                  ];
                })}
              />
            ) : (
              <SectionEmpty title="No saved views" description="Save a usage view to schedule it as a report." />
            )}
          </Section>
        ) : null}
        {view === "deliveries" ? (
          <Section title="Delivery log" description="Every attempt to send an alert or a report, newest first." flush>
            {deliveries.length ? (
              <DataTable
                label="Delivery log"
                columns={["Time", "Type", "Destination", "Attempt", "Status", "Error"]}
                rows={[...deliveries]
                  .sort((left: any, right: any) => String(right.createdAt).localeCompare(String(left.createdAt)))
                  .map((row: any) => [
                    formatDateTime(row.createdAt),
                    row.reportRunId ? "Report" : "Alert",
                    destinationName(row.destinationId),
                    <span className="tabular-nums" data-sort={row.attempt}>{row.attempt}</span>,
                    <StatusPill tone={row.status === "delivered" ? "good" : row.status === "failed" ? "danger" : "warning"}>{sentence(row.status)}</StatusPill>,
                    row.error ?? "—",
                  ])}
              />
            ) : (
              <SectionEmpty title="Nothing sent yet" description="Attempts appear here once an alert fires or a scheduled report runs." />
            )}
          </Section>
        ) : null}
      </AsyncState>
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

/** Empty state for a flush section: no second border inside the card. */
function SectionEmpty({ title, description }: { title: string; description: string }) {
  return <EmptyPanel title={title} description={description} className="min-h-32 rounded-none border-0" />;
}

function signalLabel(signal: string) {
  return SIGNALS.find((item) => item.value === signal)?.label ?? sentence(signal);
}

function formatWindow(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} min`;
}

function runTone(status: string): "good" | "danger" | "warning" {
  return status === "delivered" ? "good" : status === "failed" ? "danger" : "warning";
}

function sentence(value: string) {
  const text = String(value).replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
