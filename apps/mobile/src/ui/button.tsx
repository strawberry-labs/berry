import * as React from "react";
import { ActivityIndicator, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme, type Theme } from "../theme/theme";
import type { Icon } from "./icons";
import { PressableScale } from "./pressable-scale";
import { Text } from "./text";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm" | "icon-lg";

export type ButtonProps = Omit<PressableProps, "children" | "style"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: Icon;
  label?: string;
  loading?: boolean;
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

/** Same variant and size names as desktop-ui's shadcn Button. */
export function Button({ variant = "default", size = "default", icon: IconComponent, label, loading = false, haptic = false, disabled, style, onPress, children, accessibilityLabel, ...props }: ButtonProps) {
  const theme = useTheme();
  const palette = variantPalette(theme, variant);
  const dimensions = SIZES[size];
  const iconOnly = size.startsWith("icon");
  const isDisabled = disabled || loading;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(isDisabled), busy: loading }}
      hitSlop={iconOnly && dimensions.height < theme.layout.touchTarget ? (theme.layout.touchTarget - dimensions.height) / 2 : undefined}
      disabled={isDisabled}
      onPress={(event) => {
        if (haptic) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.(event);
      }}
      style={[
        styles.base,
        {
          height: dimensions.height,
          minWidth: iconOnly ? dimensions.height : undefined,
          paddingHorizontal: iconOnly ? 0 : dimensions.paddingHorizontal,
          borderRadius: iconOnly ? 8 : theme.layout.radius,
          backgroundColor: palette.background,
          borderColor: palette.border,
          borderWidth: palette.border === "transparent" ? 0 : StyleSheet.hairlineWidth * 2,
          opacity: isDisabled ? 0.5 : 1,
        },
        style,
      ]}
      {...props}
    >
      {loading ? <ActivityIndicator size="small" color={palette.foreground} /> : (
        <View style={styles.content}>
          {IconComponent ? <IconComponent size={dimensions.icon} color={palette.foreground} /> : null}
          {label ? <Text variant={size === "sm" ? "secondary" : "body"} weight="medium" style={{ color: palette.foreground }}>{label}</Text> : null}
          {children}
        </View>
      )}
    </PressableScale>
  );
}

const SIZES: Record<ButtonSize, { height: number; paddingHorizontal: number; icon: number }> = {
  default: { height: 40, paddingHorizontal: 16, icon: 16 },
  sm: { height: 32, paddingHorizontal: 12, icon: 14 },
  lg: { height: 48, paddingHorizontal: 20, icon: 18 },
  icon: { height: 36, paddingHorizontal: 0, icon: 18 },
  "icon-sm": { height: 28, paddingHorizontal: 0, icon: 15 },
  "icon-lg": { height: 44, paddingHorizontal: 0, icon: 18 },
};

function variantPalette(theme: Theme, variant: ButtonVariant): { background: string; foreground: string; border: string } {
  const { tokens, colors } = theme;
  switch (variant) {
    case "secondary": return { background: tokens.secondary, foreground: tokens["secondary-foreground"], border: "transparent" };
    case "outline": return { background: "transparent", foreground: colors.textPrimary, border: colors.borderStrong };
    case "ghost": return { background: "transparent", foreground: colors.textSecondary, border: "transparent" };
    case "destructive": return { background: colors.danger, foreground: tokens["destructive-foreground"], border: "transparent" };
    default: return { background: tokens.primary, foreground: tokens["primary-foreground"], border: "transparent" };
  }
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center" },
  content: { flexDirection: "row", alignItems: "center", gap: 8 },
});
