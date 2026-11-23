import { describe, expect, it } from "vitest";
import { nextTaskScheduleRun, normalizeTaskSchedule } from "./task-schedule.ts";

const now = new Date("2026-03-27T10:00:00Z");
describe("scheduled calendar occurrences", () => {
  it("keeps recurring clock time in its timezone", () => {
    expect(nextTaskScheduleRun({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Dubai" }, now).toISOString()).toBe("2026-03-30T05:00:00.000Z");
  });
  it("follows daylight saving without shifting the local time", () => {
    const schedule = { kind: "cron" as const, expression: "0 9 * * *", timezone: "Europe/London" };
    expect(nextTaskScheduleRun(schedule, new Date("2026-03-28T10:00:00Z")).toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(nextTaskScheduleRun(schedule, new Date("2026-10-24T10:00:00Z")).toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });
  it("uses one occurrence for overlapping rules and skips quiet hours", () => {
    const schedule = { kind: "cron" as const, timezone: "Asia/Dubai", expression: "20 5-18/2 * * 1-5\n20 5-18/12 * * 0,6\n20 5 * * *" };
    let next = new Date("2026-11-20T13:20:00Z"); // Friday's last local check
    for (const at of ["21T01:20", "21T13:20", "22T01:20", "22T13:20", "23T01:20", "23T03:20"]) {
      next = nextTaskScheduleRun(schedule, next);
      expect(next.toISOString()).toBe(`2026-11-${at}:00.000Z`);
    }
    expect(() => normalizeTaskSchedule({ ...schedule, expression: schedule.expression + "\n70 5 * * *" }, now)).toThrow();
  });
  it("anchors a relative reminder to the supplied server clock", () => {
    expect(normalizeTaskSchedule({ kind: "delay", minutes: 20, timezone: "Asia/Dubai" }, now)).toEqual({ kind: "once", runAt: "2026-03-27T10:20:00.000Z", timezone: "Asia/Dubai" });
  });
  it("rejects past one-time runs, invalid timezone and sub-minute cron", () => {
    expect(() => normalizeTaskSchedule({ kind: "once", runAt: now.toISOString(), timezone: "UTC" }, now)).toThrow("future");
    expect(() => normalizeTaskSchedule({ kind: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" }, now)).toThrow("timezone");
    expect(() => normalizeTaskSchedule({ kind: "cron", expression: "* * * * * *", timezone: "UTC" }, now)).toThrow("five-field");
    expect(() => normalizeTaskSchedule({ kind: "cron", expression: "0 25 * * *", timezone: "UTC" }, now)).toThrow();
    expect(() => normalizeTaskSchedule({ kind: "cron", expression: "0 9 30 2 *", timezone: "UTC" }, now)).toThrow("no future");
  });
});
