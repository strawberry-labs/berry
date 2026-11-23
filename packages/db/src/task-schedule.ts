import { nextTaskScheduleRun, TaskScheduleInputSchema, type TaskSchedule, type TaskScheduleInput } from "@berry/shared";
export { nextTaskScheduleRun } from "@berry/shared";

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
