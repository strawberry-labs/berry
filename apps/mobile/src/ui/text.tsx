import * as React from "react";
import { Text as NativeText, type TextProps as NativeTextProps, type TextStyle } from "react-native";
import { useTheme, type Theme } from "../theme/theme";

export type TextVariant = keyof Theme["typography"];
export type TextTone = "primary" | "secondary" | "tertiary" | "faint" | "accent" | "danger" | "inverse";

export type TextProps = NativeTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: keyof Theme["fontWeight"];
  mono?: boolean;
};

/** Berry's type scale: 14 body, 12 secondary, 11 metadata (AGENTS.md). */
export function Text({ variant = "body", tone = "primary", weight, mono = false, style, maxFontSizeMultiplier = 1.6, ...props }: TextProps) {
  const theme = useTheme();
  const base: TextStyle = {
    ...theme.typography[variant],
    color: toneColor(theme, tone),
    fontWeight: theme.fontWeight[weight ?? defaultWeight(variant)],
    ...(mono ? { fontFamily: theme.fontFamily.mono } : {}),
  };
  return <NativeText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[base, style]} {...props} />;
}

function defaultWeight(variant: TextVariant): keyof Theme["fontWeight"] {
  if (variant === "brand") return "brand";
  if (variant === "pageTitle") return "semibold";
  if (variant === "sectionHeading") return "medium";
  return "body";
}

export function toneColor(theme: Theme, tone: TextTone): string {
  switch (tone) {
    case "secondary": return theme.colors.textSecondary;
    case "tertiary": return theme.colors.textTertiary;
    case "faint": return theme.colors.textFaint;
    case "accent": return theme.colors.accent;
    case "danger": return theme.colors.danger;
    case "inverse": return theme.colors.sendForeground;
    default: return theme.colors.textPrimary;
  }
}
