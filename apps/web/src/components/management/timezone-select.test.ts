import { describe, expect, it } from "vitest";
import { timezoneOffset, timezoneOption, timezoneOptions } from "./timezone-select.tsx";

describe("organization timezone options", () => {
  const now = new Date("2026-08-10T08:00:00.000Z");

  it("represents Dubai with its IANA identifier and current UTC offset", () => {
    expect(timezoneOption("Asia/Dubai", now)).toMatchObject({
      id: "Asia/Dubai",
      city: "Dubai",
      offset: "UTC+4",
    });
  });

  it("keeps UTC and the current stored value available", () => {
    const options = timezoneOptions("Asia/Dubai", now);
    expect(options.some((option) => option.id === "UTC")).toBe(true);
    expect(options.some((option) => option.id === "Asia/Dubai" && option.searchValue.includes("UTC+4"))).toBe(true);
  });

  it("does not crash on a legacy custom timezone value", () => {
    expect(timezoneOffset("UTC+4", now)).toBe("Custom");
    expect(timezoneOptions("UTC+4", now).some((option) => option.id === "UTC+4")).toBe(true);
  });
});
