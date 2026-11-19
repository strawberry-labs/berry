import * as React from "react";
import { useColorScheme } from "react-native";
import { deploymentAccentHex } from "@berry/client-core/brand-accent";
import { fontFamily, fontWeight, layout, motion, themeColors, typography, type ColorScheme, type ThemeColors } from "@berry/design-tokens";
import { kv } from "../storage/kv";

export type ThemePreference = "system" | "light" | "dark";

export type SemanticColors = ReturnType<typeof semanticColors>;

export type Theme = {
  scheme: ColorScheme;
  colors: SemanticColors;
  tokens: ThemeColors;
  typography: typeof typography;
  fontWeight: typeof fontWeight;
  fontFamily: typeof fontFamily;
  layout: typeof layout;
  motion: typeof motion;
};

type ThemeContextValue = Theme & {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const PREFERENCE_KEY = "berry.theme";

/** Names the web's `--berry-*` tokens by role so screens read like the web components. */
function semanticColors(tokens: ThemeColors) {
  return {
    background: tokens["berry-main-bg"],
    sidebar: tokens["berry-sidebar-bg"],
    surfaceUnder: tokens["berry-surface-under"],
    surfaceRaised: tokens["berry-surface-raised"],
    surfaceInset: tokens["berry-surface-inset"],
    card: tokens["berry-card-bg"],
    panel: tokens["berry-panel-bg"],
    header: tokens["berry-header-bg"],
    control: tokens["berry-control-bg"],
    userMessage: tokens["berry-user-message-bg"],
    composerStrip: tokens["berry-composer-strip"],
    command: tokens["berry-command-bg"],
    textPrimary: tokens["berry-text-primary"],
    textSecondary: tokens["berry-text-secondary"],
    textTertiary: tokens["berry-text-tertiary"],
    textFaint: tokens["berry-text-faint"],
    border: tokens["berry-border"],
    borderSubtle: tokens["berry-border-subtle"],
    borderStrong: tokens["berry-border-strong"],
    hover: tokens["berry-hover"],
    selected: tokens["berry-selected"],
    accent: tokens["berry-accent"],
    accentSoft: tokens["berry-accent-soft"],
    focus: tokens["berry-focus"],
    danger: tokens["berry-danger"],
    dangerSoft: tokens["berry-danger-soft"],
    warning: tokens["berry-warning"],
    sendBackground: tokens["berry-send-bg"],
    sendForeground: tokens["berry-send-fg"],
    previewPaper: tokens["berry-preview-paper"],
    previewInk: tokens["berry-preview-ink"],
    modePlan: tokens["berry-mode-plan"],
    modeFull: tokens["berry-mode-full"],
    nodeFile: tokens["berry-node-file"],
    nodeCommand: tokens["berry-node-command"],
    nodeSkill: tokens["berry-node-skill"],
    nodeSubagent: tokens["berry-node-subagent"],
    nodeSession: tokens["berry-node-session"],
    overlay: "rgba(0, 0, 0, 0.4)",
  };
}

export function createTheme(scheme: ColorScheme, accentColor: string | null): Theme {
  const accent = deploymentAccentHex(accentColor);
  const tokens = themeColors(scheme, { accent: accent ? accent[scheme] : null });
  return { scheme, tokens, colors: semanticColors(tokens), typography, fontWeight, fontFamily, layout, motion };
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ accentColor = null, children }: { accentColor?: string | null; children: React.ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = React.useState<ThemePreference>(() => {
    const stored = kv.getItem(PREFERENCE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const scheme: ColorScheme = preference === "system" ? (system === "light" ? "light" : "dark") : preference;
  const setPreference = React.useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    kv.setItem(PREFERENCE_KEY, next);
  }, []);
  const value = React.useMemo<ThemeContextValue>(() => ({ ...createTheme(scheme, accentColor), preference, setPreference }), [accentColor, preference, scheme, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

/** Memoizes a style factory per theme, like a CSS module keyed by the active tokens. */
export function useStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  return React.useMemo(() => factory(theme), [factory, theme]);
}
