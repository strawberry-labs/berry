import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Clock3, History, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ScheduledTaskCreateSchema, type ScheduledTask, type ScheduledTaskRun } from "@berry/shared";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Alert, AlertDescription } from "@berry/desktop-ui/components/ui/alert";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@berry/desktop-ui/components/ui/toggle-group";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@berry/desktop-ui/components/ui/empty";
import { ManagementDialog, ManagementPage, AsyncState, FormSelect } from "../management/management-primitives";
import type { ManagementScreenProps } from "../management/management-context";
import { actionErrorMessage } from "@/lib/action-error";
import { describeTaskSchedule, draftSchedule, scheduleDraft, type ScheduledTaskDraft, type SchedulePreset } from "@/lib/scheduled-task-form";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./field";

function formatAt(value: string | null, timezone: string): string {
  return value ? new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "No upcoming run";
}
function runLabel(run: ScheduledTaskRun): string {
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

export function ScheduledTasksScreen({ client, tenantId, userId, workspaces }: ManagementScreenProps) {
  const queryClient = useQueryClient();
  const queryKey = ["scheduled-tasks", tenantId, userId];
  const schedules = useQuery({ queryKey, queryFn: ({ signal }) => client!.listScheduledTasks({ signal }), enabled: Boolean(client), refetchInterval: 10_000 });
  const [editing, setEditing] = React.useState<ScheduledTask | "new" | null>(null);
  const [draft, setDraft] = React.useState<ScheduledTaskDraft>(() => scheduleDraft());
  const [operationId, setOperationId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const [pendingDelete, setPendingDelete] = React.useState<ScheduledTask | null>(null);
  const [history, setHistory] = React.useState<ScheduledTask | null>(null);
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
        const changed = (["preset", "time", "day", "expression", "timezone", "runAt", "minutes"] as const).some((key) => draft[key] !== original[key]);
        await client.updateScheduledTask(editing.id, { name: parsed.name, prompt: parsed.prompt,
          ...(changed ? { schedule: parsed.schedule, ...(editing.state === "paused" ? { state: "paused" as const } : {}) } : {}),
        }, operationId);
      }
      setEditing(null); toast.success(editing === "new" ? "Scheduled task created" : "Scheduled task updated"); await refresh();
    } catch (error) { setFormError(actionErrorMessage(error, "Could not save this schedule. Your draft is still here.")); }
    finally { inFlight.current = false; setSaving(false); }
  }
  async function action(task: ScheduledTask, kind: "pause" | "run" | "delete") {
    if (!client || inFlight.current) return;
    inFlight.current = true; setBusy(task.id);
    try {
      if (kind === "delete") { await client.deleteScheduledTask(task.id); setPendingDelete(null); toast.success("Scheduled task deleted"); }
      else if (kind === "pause") { await client.updateScheduledTask(task.id, { state: task.state === "active" ? "paused" : "active" }, crypto.randomUUID()); toast.success(task.state === "active" ? "Schedule paused" : "Schedule resumed"); }
      else {
        const key = manualKeys.current.get(task.id) ?? crypto.randomUUID(); manualKeys.current.set(task.id, key);
        await client.runScheduledTask(task.id, key); manualKeys.current.delete(task.id); setHistory(task); toast.success("Run queued. A new chat will appear in your tasks.");
      }
      await refresh();
    } catch (error) { toast.error(actionErrorMessage(error, "Could not update this schedule. Try again.")); }
    finally { inFlight.current = false; setBusy(null); }
  }
  const mode = ["once", "delay"].includes(draft.preset) ? draft.preset : "repeat";
  return <ManagementPage title="Scheduled tasks" description="Give Berry work to do later. Each run opens a new chat, even when you’re away." actions={<Button onClick={() => openEditor("new")} disabled={!client}><Plus data-icon="inline-start" />New schedule</Button>}>
    <AsyncState loading={Boolean(client && schedules.isPending)} error={schedules.error ? actionErrorMessage(schedules.error, "Could not load schedules") : null} onRetry={() => { void schedules.refetch(); }} empty={false}>
      {(schedules.data ?? []).length === 0 ? <Empty className="border border-[var(--berry-border)]">
        <EmptyHeader><EmptyMedia variant="icon"><CalendarClock /></EmptyMedia><EmptyTitle>No scheduled tasks yet</EmptyTitle><EmptyDescription>Ask in any chat: “Every weekday at 9am, prepare my daily briefing.” You can also create a schedule here.</EmptyDescription></EmptyHeader>
        <EmptyContent><Button variant="outline" disabled={!client} onClick={() => openEditor("new")}><Plus data-icon="inline-start" />Create a schedule</Button></EmptyContent>
      </Empty> : <ul className="flex flex-col gap-3">{(schedules.data ?? []).map((task) => <li key={task.id} className="rounded-xl border border-[var(--berry-border)] bg-[var(--berry-card-bg)] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium text-[var(--berry-text-primary)]">{task.name}</h2><Badge variant="secondary">{task.state === "active" ? "Active" : task.state === "paused" ? "Paused" : "No future runs"}</Badge></div>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--berry-text-secondary)]"><Clock3 className="size-3.5 shrink-0" />{describeTaskSchedule(task)}</p>
            <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm text-[var(--berry-text-secondary)]">{task.prompt}</p>
            <p className="mt-2 text-[11px] text-[var(--berry-text-tertiary)]">Next: {formatAt(task.nextRunAt, task.schedule.timezone)} · {task.schedule.timezone}{task.model ? ` · ${task.model}` : ""}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={`Run ${task.name} now`} title="Run now" disabled={busy !== null} onClick={() => void action(task, "run")}><Play /></Button>
            {task.state !== "completed" ? <Button variant="ghost" size="icon-sm" aria-label={`${task.state === "active" ? "Pause" : "Resume"} ${task.name}`} title={task.state === "active" ? "Pause" : "Resume"} disabled={busy !== null} onClick={() => void action(task, "pause")}>{task.state === "active" ? <Pause /> : <Play />}</Button> : null}
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${task.name}`} title="Edit" disabled={busy !== null} onClick={() => openEditor(task)}><Pencil /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={`View runs for ${task.name}`} title="Run history" onClick={() => setHistory(task)}><History /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${task.name}`} title="Delete schedule" disabled={busy !== null} onClick={() => setPendingDelete(task)}><Trash2 /></Button>
          </div>
        </div>
        {task.lastError ? <Alert className="mt-3"><AlertDescription>{task.lastError}</AlertDescription></Alert> : null}
      </li>)}</ul>}
    </AsyncState>
    <ManagementDialog open={editing !== null} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }} title={editing === "new" ? "New scheduled task" : "Edit scheduled task"} description="Write the full instructions Berry should follow each time it runs." footer={<><Button variant="outline" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="schedule-form" disabled={saving}>{saving ? "Saving…" : editing === "new" ? "Create schedule" : "Save changes"}</Button></>}>
      <form id="schedule-form" onSubmit={(event) => void submit(event)}><FieldGroup>
        <Field><FieldLabel htmlFor="schedule-name">Name</FieldLabel><Input id="schedule-name" value={draft.name} maxLength={120} required disabled={saving} placeholder="Daily briefing" onChange={(event) => change("name", event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="schedule-prompt">Instructions</FieldLabel><Textarea id="schedule-prompt" value={draft.prompt} maxLength={32_000} required disabled={saving} rows={4} placeholder="Review today’s priorities and prepare a short briefing with sources." onChange={(event) => change("prompt", event.target.value)} /><FieldDescription>Each run starts in a new chat. Include all context it will need.</FieldDescription></Field>
        {editing === "new" ? <Field><FieldLabel>Project</FieldLabel><FormSelect value={draft.workspaceId || "general"} onChange={(value) => change("workspaceId", value === "general" ? "" : value)} disabled={saving} ariaLabel="Project" options={[{ value: "general", label: "General tasks" }, ...workspaces.filter((workspace) => workspace.workspaceKind === "project").map((workspace) => ({ value: workspace.id, label: workspace.name }))]} /></Field> : null}
        <Field><FieldLabel>When</FieldLabel><ToggleGroup type="single" value={mode} variant="outline" size="sm" disabled={saving} aria-label="Schedule type" onValueChange={(value) => { if (value) change("preset", value === "repeat" ? "weekdays" : value as SchedulePreset); }}><ToggleGroupItem value="repeat">Repeat</ToggleGroupItem><ToggleGroupItem value="once">Once</ToggleGroupItem><ToggleGroupItem value="delay">After a delay</ToggleGroupItem></ToggleGroup></Field>
        {mode === "repeat" ? <Field><FieldLabel>Repeat</FieldLabel><FormSelect value={draft.preset} disabled={saving} ariaLabel="Repeat frequency" onChange={(value) => change("preset", value as SchedulePreset)} options={[{ value: "daily", label: "Every day" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Every week" }, { value: "monthly", label: "Every month" }, { value: "custom", label: "Custom cron" }]} /></Field> : null}
        {mode === "repeat" && draft.preset !== "custom" ? <Field><FieldLabel htmlFor="schedule-time">Time</FieldLabel><Input id="schedule-time" type="time" required value={draft.time} disabled={saving} onChange={(event) => change("time", event.target.value)} /></Field> : null}
        {draft.preset === "weekly" ? <Field><FieldLabel>Day</FieldLabel><FormSelect value={draft.day} disabled={saving} ariaLabel="Day of the week" onChange={(value) => change("day", value)} options={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ value: String(index), label }))} /></Field> : null}
        {draft.preset === "monthly" ? <Field><FieldLabel htmlFor="schedule-day">Day of the month</FieldLabel><Input id="schedule-day" type="number" min={1} max={31} required value={draft.day} disabled={saving} onChange={(event) => change("day", event.target.value)} /><FieldDescription>Months without this day are skipped.</FieldDescription></Field> : null}
        {draft.preset === "custom" ? <Field><FieldLabel htmlFor="schedule-cron">Cron expression</FieldLabel><Input id="schedule-cron" value={draft.expression} required disabled={saving} placeholder="0 9 * * 1-5" onChange={(event) => change("expression", event.target.value)} /><FieldDescription>Minute · hour · day of month · month · day of week. For example, 0 9 * * 1-5 runs on weekdays at 09:00.</FieldDescription></Field> : null}
        {draft.preset === "once" ? <Field><FieldLabel htmlFor="schedule-date">Date and time</FieldLabel><Input id="schedule-date" type="datetime-local" required value={draft.runAt} disabled={saving} onChange={(event) => change("runAt", event.target.value)} /></Field> : null}
        {draft.preset === "delay" ? <Field><FieldLabel htmlFor="schedule-delay">Run in this many minutes</FieldLabel><Input id="schedule-delay" type="number" min={1} max={525600} required value={draft.minutes} disabled={saving} onChange={(event) => change("minutes", event.target.value)} /><FieldDescription>The delay starts when you save this schedule.</FieldDescription></Field> : null}
        <Field><FieldLabel htmlFor="schedule-timezone">Timezone</FieldLabel><Input id="schedule-timezone" value={draft.timezone} required disabled={saving} onChange={(event) => change("timezone", event.target.value)} /><FieldDescription>Use an IANA timezone such as Asia/Dubai or Europe/London. Recurring times follow its daylight saving rules.</FieldDescription></Field>
        {formError ? <Alert role="alert"><AlertDescription>{formError}</AlertDescription></Alert> : null}
        <p className="text-[11px] leading-5 text-[var(--berry-text-tertiary)]">Runs use your current tool access and allowance. If a previous run is still active, the next occurrence is skipped. After server downtime, Berry runs one overdue occurrence.</p>
      </FieldGroup></form>
    </ManagementDialog>
    <ManagementDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !busy) setPendingDelete(null); }} title="Delete scheduled task" description={`Stop future runs of “${pendingDelete?.name ?? "this task"}”. Existing chats and results will stay in your tasks.`} footer={<><Button variant="outline" disabled={busy !== null} onClick={() => setPendingDelete(null)}>Cancel</Button><Button variant="destructive" disabled={busy !== null} onClick={() => { if (pendingDelete) void action(pendingDelete, "delete"); }}>Delete schedule</Button></>}><p className="text-sm text-[var(--berry-text-secondary)]">Already dispatched runs can finish.</p></ManagementDialog>
    <ManagementDialog open={history !== null} onOpenChange={(open) => { if (!open) setHistory(null); }} title={history ? `Runs · ${history.name}` : "Run history"} description="The most recent 30 runs. Open any chat to see its progress and results." size="lg">
      <AsyncState loading={Boolean(history && runs.isPending)} error={runs.error ? actionErrorMessage(runs.error, "Could not load run history") : null} onRetry={() => { void runs.refetch(); }} empty={false}>
        {(runs.data ?? []).length === 0 ? <p className="text-sm text-[var(--berry-text-secondary)]">This schedule hasn’t run yet.</p> : <ol className="flex flex-col gap-3">{(runs.data ?? []).map((run) => <li key={run.id} className="flex flex-col gap-2 rounded-lg border border-[var(--berry-border)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{runLabel(run)}</Badge><span className="text-xs text-[var(--berry-text-secondary)]">{formatAt(run.scheduledAt, history?.schedule.timezone ?? "UTC")} · {run.trigger === "manual" ? "Run now" : "Scheduled"}</span></div>{run.taskId ? <Button variant="outline" size="sm" asChild><Link to="/tasks/$taskId" params={{ taskId: run.taskId }} onClick={() => setHistory(null)}>Open chat</Link></Button> : null}</div>
          {run.error ? <p className="text-xs text-[var(--berry-text-secondary)]">{run.error}</p> : null}
        </li>)}</ol>}
      </AsyncState>
    </ManagementDialog>
  </ManagementPage>;
}
