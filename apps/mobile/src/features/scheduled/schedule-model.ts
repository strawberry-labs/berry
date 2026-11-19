import { ScheduleTimezoneSchema, type ScheduledTask, type ScheduledTaskRun, type TaskScheduleInput } from "@berry/shared";

/** Ported from apps/web/src/lib/scheduled-task-form.ts and the web ScheduledTasksScreen. */

export type SchedulePreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom" | "once" | "delay";
export type ScheduleMode = "repeat" | "once" | "delay";
export type ScheduledTaskDraft = { name: string; prompt: string; workspaceId: string; preset: SchedulePreset; time: string; day: string; expression: string; timezone: string; runAt: string; minutes: string };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const REPEAT_OPTIONS: Array<{ value: SchedulePreset; label: string }> = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom cron" },
];

export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function localScheduleDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  // Some engines print midnight as "24" even with h23.
  const hour = value("hour") === "24" ? "00" : value("hour");
  return `${value("year")}-${value("month")}-${value("day")}T${hour}:${value("minute")}`;
}

/** Interpret a local "YYYY-MM-DDTHH:MM" in the chosen timezone, rejecting nonexistent DST times. */
export function scheduleDateToIso(local: string, timezone: string): string {
  ScheduleTimezoneSchema.parse(timezone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Choose a date and time");
  const [year, month, day, hour, minute] = local.split(/[-T:]/).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = wall;
  for (let index = 0; index < 4; index += 1) {
    const actual = localScheduleDate(new Date(candidate).toISOString(), timezone);
    if (actual === local) return new Date(candidate).toISOString();
    const [y, m, d, h, min] = actual.split(/[-T:]/).map(Number) as [number, number, number, number, number];
    candidate += wall - Date.UTC(y, m - 1, d, h, min);
  }
  throw new Error("That local time does not exist in this timezone. Choose another time.");
}

export function draftSchedule(draft: ScheduledTaskDraft): TaskScheduleInput {
  const timezone = ScheduleTimezoneSchema.parse(draft.timezone.trim());
  if (draft.preset === "once") return { kind: "once", runAt: scheduleDateToIso(draft.runAt, timezone), timezone };
  if (draft.preset === "delay") {
    const minutes = Number(draft.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525_600) throw new Error("Enter a delay between 1 and 525,600 minutes");
    return { kind: "delay", minutes, timezone };
  }
  if (draft.preset === "custom") return { kind: "cron", expression: draft.expression.trim(), timezone };
  const [hour, minute] = draft.time.split(":").map(Number);
  if (hour === undefined || minute === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("Choose a valid time");
  const expression = draft.preset === "daily" ? `${minute} ${hour} * * *`
    : draft.preset === "weekdays" ? `${minute} ${hour} * * 1-5`
    : draft.preset === "weekly" ? `${minute} ${hour} * * ${draft.day}` : `${minute} ${hour} ${draft.day} * *`;
  return { kind: "cron", expression, timezone };
}

export function scheduleDraft(task?: ScheduledTask, timezoneFallback: string = deviceTimezone()): ScheduledTaskDraft {
  const timezone = task?.schedule.timezone ?? timezoneFallback;
  const draft: ScheduledTaskDraft = { name: task?.name ?? "", prompt: task?.prompt ?? "", workspaceId: task?.workspaceId ?? "", preset: "weekdays", time: "09:00", day: "1", expression: "0 9 * * 1-5", timezone, runAt: "", minutes: "20" };
  if (!task) return draft;
  if (task.schedule.kind === "once") return { ...draft, preset: "once", runAt: localScheduleDate(task.schedule.runAt, timezone) };
  draft.preset = "custom";
  draft.expression = task.schedule.expression;
  const match = /^(\d+) (\d+) (\*|\d+) \* (\*|1-5|\d)$/.exec(task.schedule.expression);
  if (match) {
    draft.time = `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}`;
    if (match[3] !== "*" && match[4] === "*") { draft.preset = "monthly"; draft.day = match[3]!; }
    else if (match[3] === "*" && match[4] === "*") draft.preset = "daily";
    else if (match[3] === "*" && match[4] === "1-5") draft.preset = "weekdays";
    else if (match[3] === "*" && match[4] !== "*") { draft.preset = "weekly"; draft.day = String(Number(match[4]) % 7); }
  }
  return draft;
}

export function describeTaskSchedule(task: ScheduledTask): string {
  const draft = scheduleDraft(task);
  if (draft.preset === "once") return `Once · ${draft.runAt.replace("T", " at ")}`;
  if (draft.preset === "daily") return `Every day at ${draft.time}`;
  if (draft.preset === "weekdays") return `Weekdays at ${draft.time}`;
  if (draft.preset === "weekly") return `Every ${WEEKDAYS[Number(draft.day)] ?? "Sunday"} at ${draft.time}`;
  if (draft.preset === "monthly") return `Day ${draft.day} of each month at ${draft.time}`;
  return `Cron · ${draft.expression}`;
}

export function scheduleMode(preset: SchedulePreset): ScheduleMode {
  return preset === "once" || preset === "delay" ? preset : "repeat";
}

/** The web's change(): switching to weekly or monthly resets the day; switching to Once proposes tomorrow at 09:00. */
export function changeDraft<K extends keyof ScheduledTaskDraft>(prior: ScheduledTaskDraft, key: K, value: ScheduledTaskDraft[K], now: Date = new Date()): ScheduledTaskDraft {
  const next: ScheduledTaskDraft = { ...prior, [key]: value };
  if (key === "preset" && (value === "weekly" || value === "monthly") && value !== prior.preset) next.day = "1";
  if (key === "preset" && value === "once" && !prior.runAt) next.runAt = defaultRunAt(now, prior.timezone);
  return next;
}

/** Only schedule fields count as a schedule change when editing (the web resends the schedule only then). */
export function scheduleChanged(draft: ScheduledTaskDraft, original: ScheduledTaskDraft): boolean {
  return (["preset", "time", "day", "expression", "timezone", "runAt", "minutes"] as const).some((key) => draft[key] !== original[key]);
}

export function stateLabel(state: ScheduledTask["state"]): string {
  return state === "active" ? "Active" : state === "paused" ? "Paused" : "No future runs";
}

export function runLabel(run: Pick<ScheduledTaskRun, "state" | "turnState">): string {
  if (run.turnState === "completed") return "Completed";
  if (run.turnState === "failed") return "Failed";
  if (run.turnState === "cancelled") return "Cancelled";
  if (run.turnState === "recovery_required") return "Needs attention";
  if (run.turnState === "waiting") return "Waiting for you";
  if (run.turnState === "queued") return "Queued";
  if (run.state === "admitted") return "Running";
  if (run.state === "dispatching") return "Starting";
  return ({ pending: "Queued", failed: "Failed", skipped: "Skipped" } as Record<string, string>)[run.state] ?? run.state;
}

export function runTone(run: Pick<ScheduledTaskRun, "state" | "turnState">): "neutral" | "good" | "warning" | "danger" | "info" {
  const label = runLabel(run);
  if (label === "Completed") return "good";
  if (label === "Failed") return "danger";
  if (label === "Needs attention" || label === "Waiting for you") return "warning";
  if (label === "Running" || label === "Starting") return "info";
  return "neutral";
}

export function formatAt(value: string | null, timezone: string, locale?: string): string {
  if (!value) return "No upcoming run";
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString(locale);
  }
}

// Phone pickers: the web uses <input type="time"> and datetime-local; the
// phone composes the same strings from menus.

export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));

/** Five-minute steps, plus the current minute when an existing schedule uses another one. */
export function minuteOptions(current: string): string[] {
  const steps = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, "0"));
  return steps.includes(current) || !/^\d{2}$/.test(current) ? steps : [...steps, current].sort();
}

export function splitTime(time: string): { hour: string; minute: string } {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(time);
  return match ? { hour: match[1]!.padStart(2, "0"), minute: match[2]!.padStart(2, "0") } : { hour: "09", minute: "00" };
}

export function joinTime(hour: string, minute: string): string {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function splitRunAt(runAt: string): { date: string; time: string } {
  const [date = "", time = ""] = runAt.split("T");
  return { date, time: time || "09:00" };
}

export function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function defaultRunAt(now: Date, timezone: string): string {
  let today: string;
  try {
    today = localScheduleDate(now.toISOString(), timezone).slice(0, 10);
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  return `${addDays(today, 1)}T09:00`;
}

/** The next `count` calendar days in the schedule's timezone, labelled for a menu. */
export function upcomingDateOptions(now: Date, timezone: string, count = 60, current?: string, locale?: string): Array<{ value: string; label: string }> {
  let today: string;
  try {
    today = localScheduleDate(now.toISOString(), timezone).slice(0, 10);
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const label = (ymd: string) => format.format(new Date(`${ymd}T00:00:00.000Z`));
  const options = Array.from({ length: count }, (_, index) => {
    const value = addDays(today, index);
    const prefix = index === 0 ? "Today · " : index === 1 ? "Tomorrow · " : "";
    return { value, label: `${prefix}${label(value)}` };
  });
  if (current && /^\d{4}-\d{2}-\d{2}$/.test(current) && !options.some((option) => option.value === current)) {
    const yearLabel = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${current}T00:00:00.000Z`));
    options.unshift({ value: current, label: yearLabel });
  }
  return options;
}
