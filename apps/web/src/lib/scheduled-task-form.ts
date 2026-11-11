import { ScheduleTimezoneSchema, type ScheduledTask, type TaskScheduleInput } from "@berry/shared";
export type SchedulePreset = "daily" | "weekdays" | "weekly" | "monthly" | "custom" | "once" | "delay";
export type ScheduledTaskDraft = { name: string; prompt: string; workspaceId: string; preset: SchedulePreset; time: string; day: string; expression: string; timezone: string; runAt: string; minutes: string };

export function localScheduleDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

/** Interpret datetime-local in the chosen timezone, rejecting nonexistent DST times. */
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
  const timezone = ScheduleTimezoneSchema.parse(draft.timezone);
  if (draft.preset === "once") return { kind: "once", runAt: scheduleDateToIso(draft.runAt, timezone), timezone };
  if (draft.preset === "delay") return { kind: "delay", minutes: Number(draft.minutes), timezone };
  if (draft.preset === "custom") return { kind: "cron", expression: draft.expression.trim(), timezone };
  const [hour, minute] = draft.time.split(":").map(Number);
  if (hour === undefined || minute === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("Choose a valid time");
  const expression = draft.preset === "daily" ? `${minute} ${hour} * * *`
    : draft.preset === "weekdays" ? `${minute} ${hour} * * 1-5`
    : draft.preset === "weekly" ? `${minute} ${hour} * * ${draft.day}` : `${minute} ${hour} ${draft.day} * *`;
  return { kind: "cron", expression, timezone };
}
export function scheduleDraft(task?: ScheduledTask): ScheduledTaskDraft {
  const timezone = task?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const draft: ScheduledTaskDraft = { name: task?.name ?? "", prompt: task?.prompt ?? "", workspaceId: task?.workspaceId ?? "", preset: "weekdays", time: "09:00", day: "1", expression: "0 9 * * 1-5", timezone, runAt: "", minutes: "20" };
  if (!task) return draft;
  if (task.schedule.kind === "once") return { ...draft, preset: "once", runAt: localScheduleDate(task.schedule.runAt, timezone) };
  draft.preset = "custom"; draft.expression = task.schedule.expression;
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
  if (draft.preset === "weekly") return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(draft.day)] ?? "Sunday"} at ${draft.time}`;
  if (draft.preset === "monthly") return `Day ${draft.day} of each month at ${draft.time}`;
  return `Cron · ${draft.expression}`;
}
