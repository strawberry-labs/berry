import { describe, expect, it } from "vitest";
import { draftSchedule, scheduleDateToIso, localScheduleDate, scheduleDraft } from "./scheduled-task-form";

describe("schedule form timezone handling", () => {
  it("interprets entered dates in the chosen timezone, independently of the browser", () => {
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
    const draft = { ...scheduleDraft(), timezone: "Asia/Dubai", time: "09:15", day: "2" };
    expect(draftSchedule({ ...draft, preset: "weekdays" })).toEqual({ kind: "cron", expression: "15 9 * * 1-5", timezone: "Asia/Dubai" });
    expect(draftSchedule({ ...draft, preset: "weekly" })).toEqual({ kind: "cron", expression: "15 9 * * 2", timezone: "Asia/Dubai" });
    expect(draftSchedule({ ...draft, preset: "monthly" })).toEqual({ kind: "cron", expression: "15 9 2 * *", timezone: "Asia/Dubai" });
  });
});
