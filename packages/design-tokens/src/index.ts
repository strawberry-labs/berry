import { generatedThemes } from "./tokens.generated.ts";

export type ColorScheme = "light" | "dark";
export type ThemeColors = Record<keyof typeof generatedThemes.light.colors, string>;

export const themes = generatedThemes;

/**
 * The resolved palette for a scheme. A deployment's brand accent replaces
 * `--berry-accent` exactly as `--berry-brand-accent-*` does on the web.
 */
export function themeColors(scheme: ColorScheme, options: { accent?: string | null } = {}): ThemeColors {
  const colors: ThemeColors = { ...generatedThemes[scheme].colors };
  if (options.accent && /^#[0-9a-f]{6}$/i.test(options.accent)) {
    colors["berry-accent"] = options.accent.toLowerCase();
    colors["berry-accent-soft"] = withAlpha(options.accent, 0.14);
  }
  return colors;
}
// Callers pass the scheme-specific accent from `deploymentAccentHex` in
// @berry/client-core, which keeps text contrast above WCAG AA like the web.

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${Math.round(alpha * 1000) / 1000})`;
}

/**
 * The web's variable font uses fine weights (445, 560, 650); native text only
 * supports hundreds, so every surface maps through this one table.
 */
export const fontWeight = {
  body: "400",
  medium: "500",
  emphasis: "600",
  semibold: "600",
  brand: "700",
  bold: "700",
} as const;

/** AGENTS.md type scale: 14px body, 12px secondary, 11px metadata. */
export const typography = {
  body: { fontSize: 14, lineHeight: 21 },
  message: { fontSize: 14, lineHeight: 22 },
  secondary: { fontSize: 12, lineHeight: 16 },
  meta: { fontSize: 11, lineHeight: 14 },
  brand: { fontSize: 15, lineHeight: 18 },
  sectionHeading: { fontSize: 14, lineHeight: 21 },
  pageTitle: { fontSize: 20, lineHeight: 26 },
  code: { fontSize: 13, lineHeight: 20 },
} as const;

export const fontFamily = {
  /** The web uses the platform UI font (SF Pro / Roboto), which native gets by default. */
  sans: undefined,
  mono: "JetBrainsMono_400Regular",
  serif: "SourceSerif4_600SemiBold",
} as const;

const values = generatedThemes.light.values as Record<string, string>;

function px(name: string, fallback: number): number {
  const value = values[name];
  if (!value) return fallback;
  if (value.endsWith("rem")) return Number(value.slice(0, -3)) * 16;
  if (value.endsWith("px")) return Number(value.slice(0, -2));
  return fallback;
}

function ms(name: string, fallback: number): number {
  const value = values[name];
  return value?.endsWith("ms") ? Number(value.slice(0, -2)) : fallback;
}

function bezier(name: string, fallback: [number, number, number, number]): [number, number, number, number] {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(values[name] ?? "");
  const parts = match?.[1]!.split(",").map((part) => Number(part.trim()));
  return parts && parts.length === 4 && parts.every(Number.isFinite) ? parts as [number, number, number, number] : fallback;
}

export const layout = {
  titlebarHeight: px("berry-titlebar-height", 56),
  radius: px("radius", 10),
  panelRadius: px("berry-panel-radius", 14),
  composerRadius: px("berry-composer-radius", 26),
  composerPadding: px("berry-composer-pad", 8),
  contentWidth: px("berry-content-width", 768),
  /** Minimum touch target from the platform guidelines; the web uses 44px on phones too. */
  touchTarget: 44,
} as const;

export const motion = {
  durations: {
    micro: ms("duration-micro", 80),
    quick: ms("duration-quick", 150),
    fast: ms("duration-fast", 250),
    medium: ms("duration-medium", 350),
    slow: ms("duration-slow", 400),
    verySlow: ms("duration-very-slow", 500),
  },
  easings: {
    smoothOut: bezier("ease-smooth-out", [0.22, 1, 0.36, 1]),
    bounce: bezier("ease-bounce", [0.34, 1.36, 0.64, 1]),
    /** Codex's sidebar/activity accordion curve. */
    accordion: [0.19, 1, 0.22, 1] as [number, number, number, number],
  },
  /** Press feedback used by buttons and rows on the web. */
  press: { durationMs: 120, scale: 0.96 },
  accordionMs: 500,
} as const;
