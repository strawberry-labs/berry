import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { nextTaskScheduleRun, ScheduledTaskCreateSchema, type ScheduledTask, type ScheduledTaskRun } from "@berry/shared";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  Section,
  SegmentedControl,
  StatusPill,
  Textarea,
} from "../management/management-primitives";
import type { ManagementScreenProps } from "../management/management-context";
import { TimezoneSelect } from "../management/timezone-select";
import { actionErrorMessage } from "@/lib/action-error";
import { describeTaskSchedule, draftSchedule, scheduleDraft, type ScheduledTaskDraft, type SchedulePreset } from "@/lib/scheduled-task-form";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./field";

const cadenceOptions = [{ value: "0", label: "Off" }, ...Array.from({ length: 24 }, (_, index) => {
  const hours = index + 1;
  return { value: String(hours), label: hours === 24 ? "Once daily" : hours === 1 ? "Every hour" : `Every ${hours} hours` };
})];

function formatAt(value: string | null, timezone: string, fallback = "No upcoming run"): string {
  return value ? new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : fallback;
}
function runTone(run: ScheduledTaskRun): "good" | "warning" | "danger" | "info" | "neutral" {
  if (run.turnState === "completed") return "good";
  if (run.turnState === "failed" || run.turnState === "recovery_required" || run.state === "failed") return "danger";
  if (run.turnState === "waiting") return "warning";
  if (run.turnState === "cancelled" || run.state === "skipped") return "neutral";
  return "info";
}
function taskStatus(task: ScheduledTask): { label: string; tone: "good" | "danger" | "neutral"; rank: number } {
  if (task.lastError) return { label: "Last run failed", tone: "danger", rank: 0 };
  if (task.state === "active") return { label: "Active", tone: "good", rank: 1 };
  if (task.state === "paused") return { label: "Paused", tone: "neutral", rank: 2 };
  return { label: "Finished", tone: "neutral", rank: 3 };
}
function runLabel(run: ScheduledTaskRun): string {
  if (run.turnState === "waiting" && run.waitingReason === "browser_handoff") return "Browser needs help";
  if (run.turnState === "completed") return "Completed";
  if (run.turnState === "failed") return "Failed";
  if (run.turnState === "cancelled") return "Cancelled";
  if (run.turnState === "recovery_required") return "Needs attention";
  if (run.turnState === "waiting") return "Waiting for you";
  if (run.turnState === "queued") return "Queued";
  if (run.state === "admitted") return "Running";
  if (run.state === "dispatching") return "Starting";
  return { pending: "Queued", failed: "Failed", skipped: "Skipped" }[run.state] ?? run.state;
}

export function ScheduledTasksScreen({ client, tenantId, userId, supportView, workspaces }: ManagementScreenProps) {
  const queryClient = useQueryClient();
  const queryKey = ["scheduled-tasks", tenantId, userId, Boolean(supportView)];
  const schedules = useQuery({ queryKey, queryFn: ({ signal }) => client!.listScheduledTasks({ signal }), enabled: Boolean(client), refetchInterval: 10_000 });
  const [editing, setEditing] = React.useState<ScheduledTask | "new" | null>(null);
  const [draft, setDraft] = React.useState<ScheduledTaskDraft>(() => scheduleDraft());
  const [operationId, setOperationId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const [pendingDelete, setPendingDelete] = React.useState<ScheduledTask | null>(null);
  const [historyTask, setHistory] = React.useState<ScheduledTask | null>(null);
  // Follow the list so the drawer reflects a pause, edit or new run right away.
  const history = historyTask ? (schedules.data ?? []).find((task) => task.id === historyTask.id) ?? historyTask : null;
  const manualKeys = React.useRef(new Map<string, string>());
  const runs = useQuery({ queryKey: [...queryKey, "runs", history?.id], queryFn: ({ signal }) => client!.listScheduledTaskRuns(history!.id, 30, { signal }), enabled: Boolean(client && history), refetchInterval: history ? 5_000 : false });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey }); };
  function openEditor(task: ScheduledTask | "new") { setDraft(scheduleDraft(task === "new" ? undefined : task)); setEditing(task); setOperationId(crypto.randomUUID()); setFormError(""); }
  function change<K extends keyof ScheduledTaskDraft>(key: K, value: ScheduledTaskDraft[K]) { setDraft((prior) => ({ ...prior, [key]: value, ...(key === "preset" && (value === "weekly" || value === "monthly") && value !== prior.preset ? { day: "1" } : {}) })); setOperationId(crypto.randomUUID()); setFormError(""); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!client || !editing || inFlight.current) return;
    inFlight.current = true; setSaving(true); setFormError("");
    try {
      const parsed = ScheduledTaskCreateSchema.parse({ operationId, name: draft.name, prompt: draft.prompt, schedule: draftSchedule(draft), ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}) });
      if (editing === "new") await client.createScheduledTask(parsed);
      else {
        const original = scheduleDraft(editing);
        const changed = (["preset", "time", "day", "expression", "timezone", "runAt", "minutes", "untilHour", "weekdayHours", "weekendHours"] as const).some((key) => draft[key] !== original[key]);
        await client.updateScheduledTask(editing.id, { name: parsed.name, prompt: parsed.prompt,
          ...(changed ? { schedule: parsed.schedule, ...(editing.state === "paused" ? { state: "paused" as const } : {}) } : {}),
        }, operationId);
      }
      setEditing(null); toast.success(editing === "new" ? "Automation created" : "Automation updated"); await refresh();
    } catch (error) { setFormError(actionErrorMessage(error, "Could not save this automation. Your draft is still here.")); }
    finally { inFlight.current = false; setSaving(false); }
  }
  async function action(task: ScheduledTask, kind: "pause" | "run" | "delete") {
    if (!client || inFlight.current) return;
    inFlight.current = true; setBusy(task.id);
    try {
      if (kind === "delete") { await client.deleteScheduledTask(task.id); setPendingDelete(null); setHistory(null); toast.success("Automation deleted"); }
      else if (kind === "pause") { await client.updateScheduledTask(task.id, { state: task.state === "active" ? "paused" : "active" }, crypto.randomUUID()); toast.success(task.state === "active" ? "Automation paused" : "Automation resumed"); }
      else {
        const key = manualKeys.current.get(task.id) ?? crypto.randomUUID(); manualKeys.current.set(task.id, key);
        await client.runScheduledTask(task.id, key); manualKeys.current.delete(task.id); setHistory(task); toast.success("Run started. A new chat will appear in your tasks.");
      }
      await refresh();
    } catch (error) { toast.error(actionErrorMessage(error, "Could not update this automation. Try again.")); }
    finally { inFlight.current = false; setBusy(null); }
  }
  const mode: "repeat" | "once" | "delay" = draft.preset === "once" || draft.preset === "delay" ? draft.preset : "repeat";
  const nextRuns = React.useMemo(() => {
    if (!editing || (draft.preset !== "hours" && draft.preset !== "custom")) return [];
    try {
      const schedule = draftSchedule(draft);
      if (schedule.kind !== "cron") return [];
      const runs: string[] = [];
      let from = new Date();
      for (let i = 0; i < 3; i++) {
        from = nextTaskScheduleRun(schedule, from);
        runs.push(formatAt(from.toISOString(), schedule.timezone));
      }
      return runs;
    } catch { return []; }
  }, [editing, draft]);
  const rows = React.useMemo(() => [...(schedules.data ?? [])].sort((left, right) =>
    taskStatus(left).rank - taskStatus(right).rank
    || (left.nextRunAt ?? "9999").localeCompare(right.nextRunAt ?? "9999")
    || left.name.localeCompare(right.name)), [schedules.data]);
  const projectName = (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return !workspace || workspace.workspaceKind === "general" ? "General tasks" : workspace.name;
  };
  return <ManagementPage title="Automations" description="Work Berry does for you on a schedule. Each run opens a new chat, even when you’re away." actions={<Button onClick={() => openEditor("new")} disabled={!client}><Plus />New automation</Button>}>
    <AsyncState loading={Boolean(client && schedules.isPending)} error={schedules.error ? actionErrorMessage(schedules.error, "Could not load automations") : null} onRetry={() => { void schedules.refetch(); }} empty={false}>
      {rows.length === 0 ? <EmptyPanel
        icon={CalendarClock}
        title="No automations yet"
        description="Create one here, or ask in any chat: “Every weekday at 9am, prepare my daily briefing.”"
        action={<Button variant="secondary" disabled={!client} onClick={() => openEditor("new")}><Plus />New automation</Button>}
      /> : <Section flush>
        <DataTable
          label="Automations"
          columns={["Automation", "Schedule", "Next run", "Last run", "Status"]}
          onRowSelect={(index) => setHistory(rows[index] ?? null)}
          rowLabel={(index) => `Opened ${rows[index]?.name ?? "automation"}`}
          rows={rows.map((task) => {
            const status = taskStatus(task);
            return [
              <span className="block max-w-[28rem]"><CellStack primary={task.name} secondary={task.prompt.replace(/\s+/g, " ")} /></span>,
              <CellStack primary={<span className="font-normal">{describeTaskSchedule(task)}</span>} secondary={task.schedule.timezone} />,
              <span className="whitespace-nowrap" data-sort={task.nextRunAt ? new Date(task.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER}>{task.state === "paused" ? "Paused" : formatAt(task.nextRunAt, task.schedule.timezone, "None")}</span>,
              <span className="whitespace-nowrap text-muted-foreground" data-sort={task.lastRunAt ? new Date(task.lastRunAt).getTime() : 0}>{formatAt(task.lastRunAt, task.schedule.timezone, "Never")}</span>,
              <span data-sort={status.rank}><StatusPill tone={status.tone}>{status.label}</StatusPill></span>,
            ];
          })}
        />
      </Section>}
    </AsyncState>
    {history ? <DetailDrawer
      title={history.name}
      subtitle={describeTaskSchedule(history)}
      badge={<StatusPill tone={taskStatus(history).tone}>{taskStatus(history).label}</StatusPill>}
      onClose={() => setHistory(null)}
      footer={<>
        <Button variant="secondary" disabled={busy !== null} onClick={() => setPendingDelete(history)}><Trash2 />Delete</Button>
        {history.state !== "completed" ? <Button variant="secondary" aria-label={`${history.state === "active" ? "Pause" : "Resume"} ${history.name}`} disabled={busy !== null} onClick={() => void action(history, "pause")}>{history.state === "active" ? <Pause /> : <Play />}{history.state === "active" ? "Pause" : "Resume"}</Button> : null}
        <Button variant="secondary" aria-label={`Edit ${history.name}`} disabled={busy !== null} onClick={() => openEditor(history)}><Pencil />Edit</Button>
        <Button variant="secondary" aria-label={`Run ${history.name} now`} disabled={busy !== null} onClick={() => void action(history, "run")}><Play />Run now</Button>
      </>}
    >
      {history.lastError ? <InlineNotice tone="danger" title="Last run failed">{history.lastError}</InlineNotice> : null}
      <DefinitionList items={[
        { term: "Next run", detail: history.state === "paused" ? "Paused" : formatAt(history.nextRunAt, history.schedule.timezone) },
        { term: "Last run", detail: formatAt(history.lastRunAt, history.schedule.timezone, "Never") },
        { term: "Timezone", detail: history.schedule.timezone },
        { term: "Project", detail: projectName(history.workspaceId) },
        ...(history.model ? [{ term: "Model", detail: history.model }] : []),
      ]} />
      <section className="grid gap-1.5">
        <h3 className="text-xs font-medium text-foreground">Instructions</h3>
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--berry-surface-under)] px-3 py-2 text-md leading-5 text-foreground [overflow-wrap:anywhere]">{history.prompt}</p>
      </section>
      <section className="grid gap-1.5">
        <h3 className="text-xs font-medium text-foreground">Recent runs</h3>
        {runs.isPending ? <p className="text-xs text-muted-foreground" role="status">Loading runs…</p>
          : runs.error ? <InlineNotice tone="danger" action={<Button variant="secondary" onClick={() => { void runs.refetch(); }}>Retry</Button>}>{actionErrorMessage(runs.error, "Could not load run history")}</InlineNotice>
          : (runs.data ?? []).length === 0 ? <p className="text-xs text-muted-foreground">This automation hasn’t run yet.</p>
          : <ol className="grid divide-y divide-border">{(runs.data ?? []).map((run) => <li key={run.id} className="grid gap-1 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusPill tone={runTone(run)}>{runLabel(run)}</StatusPill>
                <span className="text-xs text-muted-foreground">{formatAt(run.scheduledAt, history.schedule.timezone)} · {run.trigger === "manual" ? "Run by you" : "Scheduled"}</span>
              </span>
              {run.taskId ? <Button variant="ghost" asChild><Link to="/tasks/$taskId" params={{ taskId: run.taskId }} onClick={() => setHistory(null)}>Open chat</Link></Button> : null}
            </div>
            {run.error ? <p className="text-xs leading-5 text-muted-foreground">{run.error}</p> : null}
          </li>)}</ol>}
      </section>
    </DetailDrawer> : null}
    <ManagementDialog open={editing !== null} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }} title={editing === "new" ? "New automation" : "Edit automation"} description="Say what Berry should do and when. Each run starts in a new chat with only these instructions." footer={<><Button variant="secondary" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="schedule-form" disabled={saving}>{saving ? "Saving…" : editing === "new" ? "Create automation" : "Save changes"}</Button></>}>
      <form id="schedule-form" onSubmit={(event) => void submit(event)}><FieldGroup>
        <Field><FieldLabel htmlFor="schedule-name">Name</FieldLabel><Input id="schedule-name" value={draft.name} maxLength={120} required disabled={saving} placeholder="Daily briefing" onChange={(event) => change("name", event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="schedule-prompt">Instructions</FieldLabel><Textarea id="schedule-prompt" value={draft.prompt} maxLength={32_000} required disabled={saving} rows={4} placeholder="Review today’s priorities and prepare a short briefing with sources." onChange={(event) => change("prompt", event.target.value)} /><FieldDescription>Include everything Berry needs to know; it won’t see your earlier chats.</FieldDescription></Field>
        {editing === "new" ? <Field><FieldLabel>Project</FieldLabel><FormSelect value={draft.workspaceId || "general"} onChange={(value) => change("workspaceId", value === "general" ? "" : value)} disabled={saving} ariaLabel="Project" options={[{ value: "general", label: "General tasks" }, ...workspaces.filter((workspace) => workspace.workspaceKind === "project").map((workspace) => ({ value: workspace.id, label: workspace.name }))]} /><FieldDescription>Where each run’s chat is created. This can’t be changed later.</FieldDescription></Field> : null}
        <Field><FieldLabel>When</FieldLabel><div><SegmentedControl label="Schedule type" value={mode} onChange={(value) => { if (!saving && value !== mode) change("preset", value === "repeat" ? "weekdays" : value); }} options={[{ value: "repeat", label: "Repeat" }, { value: "once", label: "Once" }, { value: "delay", label: "After a delay" }]} /></div></Field>
        {mode === "repeat" ? <div className="grid gap-4 sm:grid-cols-2">
          <Field><FieldLabel>Repeat</FieldLabel><FormSelect value={draft.preset} disabled={saving} ariaLabel="Repeat frequency" onChange={(value) => change("preset", value as SchedulePreset)} options={[{ value: "daily", label: "Every day" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Every week" }, { value: "monthly", label: "Every month" }, { value: "hours", label: "Working hours" }, { value: "custom", label: "Custom (cron)" }]} /></Field>
          {draft.preset !== "custom" ? <Field><FieldLabel htmlFor="schedule-time">{draft.preset === "hours" ? "First check" : "Time"}</FieldLabel><Input id="schedule-time" type="time" required value={draft.time} disabled={saving} onChange={(event) => change("time", event.target.value)} /></Field> : null}
          {draft.preset === "hours" ? <>
            <Field><FieldLabel>Stop before</FieldLabel><FormSelect ariaLabel="Stop before" disabled={saving} value={draft.untilHour} onChange={(v) => change("untilHour", v)} options={Array.from({ length: 24 }, (_, i) => ({ value: String(i + 1), label: i === 23 ? "Midnight (24:00)" : String(i + 1).padStart(2, "0") + ":00" }))} /></Field>
            <Field><FieldLabel>Monday–Friday</FieldLabel><FormSelect ariaLabel="Weekday frequency" disabled={saving} value={draft.weekdayHours} onChange={(v) => change("weekdayHours", v)} options={cadenceOptions} /></Field>
            <Field><FieldLabel>Saturday–Sunday</FieldLabel><FormSelect ariaLabel="Weekend frequency" disabled={saving} value={draft.weekendHours} onChange={(v) => change("weekendHours", v)} options={cadenceOptions} /></Field>
          </> : null}
          {draft.preset === "weekly" ? <Field><FieldLabel>Day</FieldLabel><FormSelect value={draft.day} disabled={saving} ariaLabel="Day of the week" onChange={(value) => change("day", value)} options={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ value: String(index), label }))} /></Field> : null}
          {draft.preset === "monthly" ? <Field><FieldLabel htmlFor="schedule-day">Day of the month</FieldLabel><Input id="schedule-day" type="number" min={1} max={31} required value={draft.day} disabled={saving} onChange={(event) => change("day", event.target.value)} /><FieldDescription>Months without this day are skipped.</FieldDescription></Field> : null}
        </div> : null}
        {draft.preset === "custom" ? <Field><FieldLabel htmlFor="schedule-cron">Cron expression</FieldLabel><Textarea id="schedule-cron" rows={3} className="font-mono" value={draft.expression} required disabled={saving} placeholder="0 9 * * 1-5" onChange={(event) => change("expression", event.target.value)} /><FieldDescription>Enter one five-field cron rule per line. A match on any line starts one run.</FieldDescription></Field> : null}
        {draft.preset === "once" ? <Field><FieldLabel htmlFor="schedule-date">Date and time</FieldLabel><Input id="schedule-date" type="datetime-local" required value={draft.runAt} disabled={saving} onChange={(event) => change("runAt", event.target.value)} /></Field> : null}
        {draft.preset === "delay" ? <Field><FieldLabel htmlFor="schedule-delay">Minutes from now</FieldLabel><Input id="schedule-delay" type="number" min={1} max={525600} required value={draft.minutes} disabled={saving} onChange={(event) => change("minutes", event.target.value)} /><FieldDescription>The delay starts when you save.</FieldDescription></Field> : null}
        <Field><FieldLabel>Timezone</FieldLabel><TimezoneSelect ariaLabel="Timezone" value={draft.timezone} disabled={saving} onChange={(timezone) => change("timezone", timezone)} /><FieldDescription>Times follow this timezone, including its daylight saving changes.</FieldDescription></Field>
        {nextRuns.length > 0 ? <FieldDescription>Next checks · {nextRuns.join(" · ")}</FieldDescription> : null}
        {formError ? <InlineNotice tone="danger">{formError}</InlineNotice> : null}
        <FieldDescription>Runs use your current tool access and count against your allowance. If the previous run is still going, the next one is skipped.</FieldDescription>
      </FieldGroup></form>
    </ManagementDialog>
    <ManagementDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !busy) setPendingDelete(null); }} title={`Delete ${pendingDelete?.name ?? "automation"}?`} description="Future runs stop. Chats and results from earlier runs stay in your tasks." size="sm" footer={<><Button variant="secondary" disabled={busy !== null} onClick={() => setPendingDelete(null)}>Cancel</Button><Button variant="destructive" disabled={busy !== null} onClick={() => { if (pendingDelete) void action(pendingDelete, "delete"); }}>{busy ? "Deleting…" : "Delete automation"}</Button></>}><p className="text-md leading-5 text-muted-foreground">A run that has already started will finish.</p></ManagementDialog>
  </ManagementPage>;
}
