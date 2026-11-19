import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cascadeThemes, evaluateColor, formatColor, resolveTheme } from "./css-tokens.ts";
import { renderGeneratedTokens } from "./generate-source.ts";
import { layout, motion, themeColors } from "./index.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("generated tokens", () => {
  it("match the current web stylesheets", () => {
    const expected = renderGeneratedTokens((path) => readFileSync(resolve(packageDir, "../..", path), "utf8"));
    const actual = readFileSync(resolve(packageDir, "src/tokens.generated.ts"), "utf8");
    // If this fails, run `pnpm --filter @berry/design-tokens generate`.
    expect(actual).toBe(expected);
  });

  it("cover the surfaces native screens use in both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = themeColors(scheme);
      for (const name of ["berry-main-bg", "berry-sidebar-bg", "berry-text-primary", "berry-text-secondary", "berry-text-tertiary", "berry-border", "berry-control-bg", "berry-accent", "berry-user-message-bg", "berry-danger"] as const) {
        expect(colors[name], `${scheme} ${name}`).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
      }
    }
    expect(layout.titlebarHeight).toBe(56);
    expect(layout.radius).toBe(10);
    expect(motion.durations.fast).toBe(250);
    expect(motion.easings.smoothOut).toEqual([0.22, 1, 0.36, 1]);
  });

  it("applies a deployment's brand accent", () => {
    const colors = themeColors("dark", { accent: "#7C6DF2" });
    expect(colors["berry-accent"]).toBe("#7c6df2");
    expect(colors["berry-accent-soft"]).toBe("rgba(124, 109, 242, 0.14)");
    expect(themeColors("dark", { accent: "not-a-color" })["berry-accent"]).toBe(themeColors("dark")["berry-accent"]);
  });
});

describe("CSS color evaluation", () => {
  const color = (value: string) => {
    const parsed = evaluateColor(value);
    return parsed ? formatColor(parsed) : null;
  };

  it("parses hex, rgb and named colors", () => {
    expect(color("#0169cc")).toBe("#0169cc");
    expect(color("#fff")).toBe("#ffffff");
    expect(color("#00000014")).toBe("rgba(0, 0, 0, 0.078)");
    expect(color("rgba(255, 255, 255, 0.16)")).toBe("rgba(255, 255, 255, 0.16)");
    expect(color("rgb(0 0 0 / 0.35)")).toBe("rgba(0, 0, 0, 0.35)");
    expect(color("transparent")).toBe("rgba(0, 0, 0, 0)");
  });

  it("converts oklch to sRGB", () => {
    expect(color("oklch(1 0 0 / 0.1)")).toBe("rgba(255, 255, 255, 0.1)");
    expect(color("oklch(0 0 0)")).toBe("#000000");
    expect(color("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
  });

  it("mixes in sRGB with premultiplied alpha", () => {
    expect(color("color-mix(in srgb, #0169cc 14%, transparent)")).toBe("rgba(1, 105, 204, 0.14)");
    expect(color("color-mix(in srgb, #ffffff 50%, #000000)")).toBe("#808080");
  });

  it("resolves var() chains, fallbacks and dark overrides", () => {
    const themes = cascadeThemes([
      ":root { --a: #111111; --b: var(--a); --c: var(--missing, #222222); }\n.dark { --a: #eeeeee; }",
      "@media (prefers-color-scheme: dark) { :root { --a: #ff0000; } }",
    ]);
    expect(resolveTheme(themes.light).colors).toMatchObject({ a: "#111111", b: "#111111", c: "#222222" });
    expect(resolveTheme(themes.dark).colors).toMatchObject({ a: "#eeeeee", b: "#eeeeee" });
  });
});
