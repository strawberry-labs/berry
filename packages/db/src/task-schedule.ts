import { Cron } from "croner";
import { TaskScheduleInputSchema, type TaskSchedule, type TaskScheduleInput } from "@berry/shared";

export function normalizeTaskSchedule(input: TaskScheduleInput, now: Date): TaskSchedule {
  const parsed = TaskScheduleInputSchema.parse(input);
  const schedule = parsed.kind === "delay"
    ? { kind: "once" as const, runAt: new Date(now.getTime() + parsed.minutes * 60_000).toISOString(), timezone: parsed.timezone }
    : parsed;
  if (schedule.kind === "once" && new Date(schedule.runAt).getTime() <= now.getTime()) {
    throw new Error("Choose a future time for a one-time task");
  }
  nextTaskScheduleRun(schedule, now);
  return schedule;
}

/** Croner calculates calendar occurrences; persisted database records own dispatch. */
export function nextTaskScheduleRun(schedule: TaskSchedule, from: Date): Date {
  if (schedule.kind === "once") return new Date(schedule.runAt);
  if (schedule.expression.split(/\s+/).length !== 5) {
    throw new Error("Use five-field cron: minute hour day-of-month month day-of-week");
  }
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    const next = cron.nextRun(from);
    if (!next) throw new Error("This cron expression has no future run");
    return next;
  } finally { cron.stop(); }
}
