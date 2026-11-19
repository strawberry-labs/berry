import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "@berry/shared";
import {
  addDays,
  changeDraft,
  defaultRunAt,
  describeTaskSchedule,
  draftSchedule,
  formatAt,
  joinTime,
  localScheduleDate,
  minuteOptions,
  runLabel,
  runTone,
  scheduleChanged,
  scheduleDateToIso,
  scheduleDraft,
  scheduleMode,
  splitRunAt,
  splitTime,
  stateLabel,
  upcomingDateOptions,
} from "./schedule-model";

const task = (schedule: ScheduledTask["schedule"]) => ({ name: "Brief", prompt: "Do it", workspaceId: "w", schedule, state: "active" }) as ScheduledTask;

describe("schedule form timezone handling (web parity)", () => {
  it("interprets entered dates in the chosen timezone, independently of the device", () => {
    expect(scheduleDateToIso("2026-10-07T09:00", "Asia/Dubai")).toBe("2026-10-07T05:00:00.000Z");
    expect(scheduleDateToIso("2026-07-07T09:00", "America/New_York")).toBe("2026-07-07T13:00:00.000Z");
    expect(scheduleDateToIso("2026-01-07T09:00", "America/New_York")).toBe("2026-01-07T14:00:00.000Z");
    expect(scheduleDateToIso("2026-10-07T09:00", "Asia/Kathmandu")).toBe("2026-10-07T03:15:00.000Z");
  });

  it("rejects a missing clock time during the spring DST transition", () => {
    expect(() => scheduleDateToIso("2026-03-08T02:30", "America/New_York")).toThrow("does not exist");
    expect(() => scheduleDateToIso("2026-02-30T09:00", "UTC")).toThrow();
  });

  it("round-trips midnight and a repeated autumn clock time", () => {
    for (const local of ["2026-10-07T00:00", "2026-11-01T01:30"]) {
      expect(localScheduleDate(scheduleDateToIso(local, "America/New_York"), "America/New_York")).toBe(local);
    }
  });

  it("produces five-field cron for common repeat options", () => {
    const draft = { ...scheduleDraft(undefined, "Asia/Dubai"), time: "09:15", day: "2" };
    expect(draftSchedule({ ...draft, preset: "daily" })).toEqual({ kind: "cron", expression: "15 9 * * *", timezone: "Asia/Dubai" });
    expect(draftSchedule({ ...draft, preset: "weekdays" })).toEqual({ kind: "cron", expression: "15 9 * * 1-5", timezone: "Asia/Dubai" });
    expect(draftSchedule({ ...draft, preset: "weekly" })).toEqual({ kind: "cron", expression: "15 9 * * 2", timezone: "Asia/Dubai" });
    expect(draftSchedule({ ...draft, preset: "monthly" })).toEqual({ kind: "cron", expression: "15 9 2 * *", timezone: "Asia/Dubai" });
    expect(draftSchedule({ ...draft, preset: "delay", minutes: "45" })).toEqual({ kind: "delay", minutes: 45, timezone: "Asia/Dubai" });
    expect(() => draftSchedule({ ...draft, preset: "delay", minutes: "0" })).toThrow("between 1");
    expect(() => draftSchedule({ ...draft, time: "25:00" })).toThrow("valid time");
    expect(() => draftSchedule({ ...draft, timezone: "Mars/Olympus" })).toThrow();
  });
});

describe("schedule descriptions and drafts", () => {
  it("reads presets back from cron expressions", () => {
    expect(describeTaskSchedule(task({ kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" }))).toBe("Weekdays at 09:00");
    expect(describeTaskSchedule(task({ kind: "cron", expression: "30 7 * * *", timezone: "UTC" }))).toBe("Every day at 07:30");
    expect(describeTaskSchedule(task({ kind: "cron", expression: "0 18 * * 5", timezone: "UTC" }))).toBe("Every Friday at 18:00");
    expect(describeTaskSchedule(task({ kind: "cron", expression: "0 8 15 * *", timezone: "UTC" }))).toBe("Day 15 of each month at 08:00");
    expect(describeTaskSchedule(task({ kind: "cron", expression: "*/5 * * * *", timezone: "UTC" }))).toBe("Cron · */5 * * * *");
    expect(describeTaskSchedule(task({ kind: "once", runAt: "2026-10-07T05:00:00.000Z", timezone: "Asia/Dubai" }))).toBe("Once · 2026-10-07 at 09:00");
  });

  it("resets the day for weekly and monthly, proposes a time for Once, and detects schedule edits", () => {
    const base = scheduleDraft(undefined, "UTC");
    expect(changeDraft({ ...base, day: "5" }, "preset", "weekly").day).toBe("1");
    expect(changeDraft(base, "preset", "once", new Date("2026-10-09T22:00:00.000Z")).runAt).toBe("2026-10-10T09:00");
    expect(changeDraft({ ...base, runAt: "2026-12-01T10:00" }, "preset", "once").runAt).toBe("2026-12-01T10:00");
    expect(scheduleChanged({ ...base, name: "New name" }, base)).toBe(false);
    expect(scheduleChanged({ ...base, time: "10:00" }, base)).toBe(true);
    expect(scheduleMode("weekly")).toBe("repeat");
    expect(scheduleMode("delay")).toBe("delay");
  });

  it("labels states and runs like the web", () => {
    expect(stateLabel("completed")).toBe("No future runs");
    expect(runLabel({ state: "admitted", turnState: null })).toBe("Running");
    expect(runLabel({ state: "admitted", turnState: "recovery_required" })).toBe("Needs attention");
    expect(runLabel({ state: "skipped", turnState: null })).toBe("Skipped");
    expect(runTone({ state: "admitted", turnState: "completed" })).toBe("good");
    expect(runTone({ state: "failed", turnState: null })).toBe("danger");
    expect(formatAt(null, "UTC")).toBe("No upcoming run");
    expect(formatAt("2026-10-07T05:00:00.000Z", "Asia/Dubai", "en-US")).toBe("Oct 7, 9:00 AM");
  });
});

describe("phone pickers", () => {
  it("splits and joins times and run dates", () => {
    expect(splitTime("9:5")).toEqual({ hour: "09", minute: "05" });
    expect(splitTime("bad")).toEqual({ hour: "09", minute: "00" });
    expect(joinTime("7", "30")).toBe("07:30");
    expect(splitRunAt("2026-10-07T18:45")).toEqual({ date: "2026-10-07", time: "18:45" });
    expect(splitRunAt("")).toEqual({ date: "", time: "09:00" });
  });

  it("offers five-minute steps and keeps an existing odd minute", () => {
    expect(minuteOptions("00")).toHaveLength(12);
    expect(minuteOptions("07")).toContain("07");
    expect(minuteOptions("07")).toHaveLength(13);
  });

  it("lists upcoming days in the schedule's timezone", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(defaultRunAt(new Date("2026-10-09T21:30:00.000Z"), "Asia/Dubai")).toBe("2026-10-11T09:00");
    const options = upcomingDateOptions(new Date("2026-10-09T12:00:00.000Z"), "UTC", 3, undefined, "en-US");
    expect(options.map((option) => option.value)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(options[0]?.label).toBe("Today · Fri, Oct 9");
    expect(options[1]?.label.startsWith("Tomorrow · ")).toBe(true);
    const withFarDate = upcomingDateOptions(new Date("2026-10-09T12:00:00.000Z"), "UTC", 3, "2027-03-01", "en-US");
    expect(withFarDate[0]).toEqual({ value: "2027-03-01", label: "Mon, Mar 1, 2027" });
  });
});
