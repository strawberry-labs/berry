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
