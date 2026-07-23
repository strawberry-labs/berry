import { describe, expect, it } from "vitest";
import {
  DEFAULT_BERRY_THEME,
  normalizeThemePreference,
  readThemePreference,
  resolveTheme,
} from "./theme.ts";

describe("Berry theme resolution", () => {
  it("keeps supported preferences and defaults invalid values to dark", () => {
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference(null)).toBe(DEFAULT_BERRY_THEME);
    expect(normalizeThemePreference("sepia")).toBe(DEFAULT_BERRY_THEME);
  });

  it("resolves system against the browser preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("reads the stored preference and tolerates blocked storage", () => {
    expect(readThemePreference({ getItem: () => "light" })).toBe("light");
    expect(readThemePreference({ getItem: () => null })).toBe("dark");
    expect(readThemePreference({ getItem: () => { throw new Error("blocked"); } })).toBe("dark");
  });
});
