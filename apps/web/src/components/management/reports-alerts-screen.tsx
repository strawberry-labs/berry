import * as React from "react";
import { Plus } from "lucide-react";
import { AsyncState, Button, DataTable, FormSelect, Input, ManagementPage, Section, StatusPill, SuccessMessage } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function ReportsAlertsScreen({ client, tenantId, permissions }: ManagementScreenProps) {
  const resource = useResource(`reports:${tenantId}`, async () => client ? Promise.all([
    client.savedAnalyticsViews(tenantId), client.reportSchedules(tenantId), client.reportRuns(tenantId),
    client.alertDestinations(tenantId), client.alertRules(tenantId), client.alertDeliveries(tenantId),
  ]) : [[], [], [], [], [], []], [] as any);
  const [panel, setPanel] = React.useState<"view" | "report" | "destination" | "rule" | null>(null);
  const [message, setMessage] = React.useState("");
  const [views, schedules, runs, destinations, rules, deliveries] = resource.data;

  async function createView(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!client) return; const form = new FormData(event.currentTarget);
    await client.createSavedAnalyticsView(tenantId, { name: String(form.get("name")), visibility: String(form.get("visibility")) as "private" | "tenant", filters: { from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() } });
    finish("Saved analytics view created.");
  }
  async function createReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!client) return; const form = new FormData(event.currentTarget);
    await client.createReportSchedule(tenantId, { name: String(form.get("name")), savedViewId: String(form.get("view")), format: String(form.get("format")) as "csv" | "html", cadence: String(form.get("cadence")) as "daily" | "weekly" | "monthly", timezone: String(form.get("timezone")), recipients: String(form.get("recipients")).split(",").map((value) => value.trim()).filter(Boolean) });
    finish("Report schedule created. Delivery status changes only after the provider confirms success.");
  }
  async function createDestination(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!client) return; const form = new FormData(event.currentTarget); const kind = String(form.get("kind")) as "email" | "webhook";
    const secret = String(form.get("secret"));
    await client.createAlertDestination(tenantId, { kind, label: String(form.get("label")), emailRecipients: kind === "email" ? String(form.get("recipients")).split(",").map((value) => value.trim()).filter(Boolean) : [], ...(secret ? { secret } : {}) });
    finish("Alert destination stored. Webhook secrets cannot be retrieved.");
  }
  async function createRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!client) return; const form = new FormData(event.currentTarget);
    await client.createAlertRule(tenantId, { name: String(form.get("name")), signal: String(form.get("signal")) as any, enabled: true, threshold: Number(form.get("threshold")), windowMinutes: Number(form.get("window")), destinationIds: [String(form.get("destination"))] });
    finish("Alert rule enabled. Evaluation is idempotent for each rule and time window.");
  }
  function finish(text: string) { setPanel(null); setMessage(text); resource.retry(); }

  return <ManagementPage title="Reports & alerts" description="Persisted analytic views, scheduled delivery, explainable alert rules, and delivery health." eyebrow="Finance">
    {message ? <SuccessMessage>{message}</SuccessMessage> : null}
    <div className="mgmt-form-actions">
      {permissions.includes("reports:write") ? <><Button variant="secondary" disabled={!client} onClick={() => setPanel("view")}><Plus />Saved view</Button><Button variant="secondary" disabled={!client || views.length === 0} onClick={() => setPanel("report")}><Plus />Schedule report</Button></> : null}
      {permissions.includes("alerts:write") ? <><Button variant="secondary" disabled={!client} onClick={() => setPanel("destination")}><Plus />Destination</Button><Button disabled={!client || destinations.length === 0} onClick={() => setPanel("rule")}><Plus />Alert rule</Button></> : null}
    </div>
    {panel ? <Section title={`Create ${panel}`} description="The server validates permissions, stores the configuration, and appends an audit event.">
      {panel === "view" ? <form className="mgmt-inline-form" onSubmit={createView}><label className="mgmt-field">Name<Input name="name" required /></label><label className="mgmt-field">Visibility<FormSelect name="visibility" defaultValue="tenant" options={[{ value: "tenant", label: "Organization" }, { value: "private", label: "Private" }]} /></label><FormButtons close={() => setPanel(null)} /></form> : null}
      {panel === "report" ? <form className="mgmt-inline-form" onSubmit={createReport}><label className="mgmt-field">Name<Input name="name" required /></label><label className="mgmt-field">Saved view<FormSelect name="view" required options={views.map((view: any) => ({ value: view.id, label: view.name }))} /></label><label className="mgmt-field">Format<FormSelect name="format" defaultValue="csv" options={[{ value: "csv", label: "CSV" }, { value: "html", label: "HTML email" }]} /></label><label className="mgmt-field">Cadence<FormSelect name="cadence" defaultValue="weekly" options={[{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }, { value: "monthly", label: "Monthly" }]} /></label><label className="mgmt-field">Timezone<Input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} required /></label><label className="mgmt-field mgmt-field-wide">Recipients<Input name="recipients" type="text" placeholder="owner@example.com, finance@example.com" required /></label><FormButtons close={() => setPanel(null)} /></form> : null}
      {panel === "destination" ? <form className="mgmt-inline-form" onSubmit={createDestination}><label className="mgmt-field">Label<Input name="label" required /></label><label className="mgmt-field">Kind<FormSelect name="kind" defaultValue="email" options={[{ value: "email", label: "Email" }, { value: "webhook", label: "Generic webhook" }]} /></label><label className="mgmt-field mgmt-field-wide">Email recipients<Input name="recipients" placeholder="ops@example.com" /></label><label className="mgmt-field mgmt-field-wide">Webhook secret<Input name="secret" type="password" minLength={8} autoComplete="new-password" /></label><FormButtons close={() => setPanel(null)} /></form> : null}
      {panel === "rule" ? <form className="mgmt-inline-form" onSubmit={createRule}><label className="mgmt-field">Name<Input name="name" required /></label><label className="mgmt-field">Signal<FormSelect name="signal" defaultValue="spend_threshold" options={[{ value: "spend_threshold", label: "Spend threshold" }, { value: "quota_threshold", label: "Quota threshold" }, { value: "projected_overrun", label: "Projected overrun" }, { value: "credits", label: "Credit health" }, { value: "unusual_spend", label: "Unusual spend" }, { value: "request_volume", label: "Request volume" }, { value: "error_rate", label: "Error rate" }, { value: "latency", label: "Latency" }, { value: "blocked_requests", label: "Blocked requests" }, { value: "system_health", label: "System health" }]} /></label><label className="mgmt-field">Threshold<Input name="threshold" type="number" min="0" step=".01" required /></label><label className="mgmt-field">Window (minutes)<Input name="window" type="number" min="1" defaultValue="60" required /></label><label className="mgmt-field">Destination<FormSelect name="destination" options={destinations.map((destination: any) => ({ value: destination.id, label: destination.label }))} /></label><FormButtons close={() => setPanel(null)} /></form> : null}
    </Section> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      <div className="mgmt-two-column">
        <Section title="Scheduled reports" description={`${views.length} saved view${views.length === 1 ? "" : "s"}`}><DataTable label="Report schedules" columns={["Name", "Cadence", "Format", "Status", "Next run"]} rows={schedules.map((row: any) => [row.name, row.cadence, row.format, <StatusPill tone={row.status === "active" ? "good" : "neutral"}>{row.status}</StatusPill>, row.nextRunAt ? new Date(row.nextRunAt).toLocaleString() : "—"])} /></Section>
        <Section title="Alert rules" description={`${destinations.length} configured destination${destinations.length === 1 ? "" : "s"}`}><DataTable label="Alert rules" columns={["Rule", "Signal", "Threshold", "State"]} rows={rules.map((row: any) => [row.name, human(row.signal), row.threshold, row.enabled ? <StatusPill tone="good">On</StatusPill> : <StatusPill>Off</StatusPill>])} /></Section>
      </div>
      <Section title="Delivery history" description={`${runs.length} report run${runs.length === 1 ? "" : "s"}; secrets are always redacted.`}><DataTable label="Delivery history" columns={["Created", "Destination", "Attempt", "Status", "Error"]} rows={deliveries.map((row: any) => [new Date(row.createdAt).toLocaleString(), row.destinationId, row.attempt, <StatusPill tone={row.status === "delivered" ? "good" : row.status === "failed" ? "danger" : "warning"}>{row.status}</StatusPill>, row.error ?? "—"])} /></Section>
    </AsyncState>
  </ManagementPage>;
}

function FormButtons({ close }: { close: () => void }) { return <div className="mgmt-form-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button>Create</Button></div>; }
function human(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
