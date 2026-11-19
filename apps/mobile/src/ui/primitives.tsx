import * as React from "react";
import { ActivityIndicator, Switch as NativeSwitch, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { accountAvatarInitial } from "@berry/client-core/format";
import { useTheme } from "../theme/theme";
import { Text } from "./text";

export function Separator({ style, inset = 0 }: { style?: StyleProp<ViewStyle>; inset?: number }) {
  const { colors } = useTheme();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: inset }, style]} />;
}

export function Spinner({ size = "small" }: { size?: "small" | "large" }) {
  const { colors } = useTheme();
  return <ActivityIndicator size={size} color={colors.textTertiary} />;
}

export function Avatar({ name, email, image, size = 28 }: { name?: string | null; email?: string | null; image?: string | null; size?: number }) {
  const { colors } = useTheme();
  const [failed, setFailed] = React.useState(false);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: colors.accentSoft }} accessibilityElementsHidden>
      {image && !failed ? (
        <Image source={{ uri: image }} style={{ width: size, height: size }} contentFit="cover" onError={() => setFailed(true)} />
      ) : (
        <Text variant={size >= 40 ? "body" : "secondary"} weight="semibold">{accountAvatarInitial({ name: name ?? null, email: email ?? null })}</Text>
      )}
    </View>
  );
}

export function Input({ style, ref, ...props }: TextInputProps & { ref?: React.Ref<TextInput> }) {
  const theme = useTheme();
  const [focused, setFocused] = React.useState(false);
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={theme.colors.textFaint}
      selectionColor={theme.colors.accent}
      {...props}
      onFocus={(event) => { setFocused(true); props.onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); props.onBlur?.(event); }}
      style={[
        {
          minHeight: 44,
          borderRadius: theme.layout.radius,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: focused ? theme.colors.accent : theme.colors.borderStrong,
          backgroundColor: theme.colors.control,
          color: theme.colors.textPrimary,
          paddingHorizontal: 12,
          // 16px keeps iOS from zooming and matches the web's touch inputs.
          fontSize: 16,
        },
        style,
      ]}
    />
  );
}

export function Switch({ value, onValueChange, disabled, accessibilityLabel }: { value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean; accessibilityLabel?: string }) {
  const { colors } = useTheme();
  return (
    <NativeSwitch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      trackColor={{ true: colors.accent, false: colors.command }}
      thumbColor="#ffffff"
      ios_backgroundColor={colors.command}
    />
  );
}

export function Progress({ value, accessibilityLabel }: { value: number; accessibilityLabel?: string }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={accessibilityLabel} accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }} style={{ height: 6, borderRadius: 3, backgroundColor: colors.command, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: 6, borderRadius: 3, backgroundColor: colors.textPrimary }} />
    </View>
  );
}

export function StatusPill({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "good" | "warning" | "danger" | "info" }) {
  const { colors } = useTheme();
  const palette = {
    neutral: { background: colors.hover, foreground: colors.textSecondary },
    good: { background: "rgba(21, 128, 61, 0.14)", foreground: colors.nodeSession },
    warning: { background: "rgba(217, 119, 6, 0.14)", foreground: colors.warning },
    danger: { background: colors.dangerSoft, foreground: colors.danger },
    info: { background: colors.accentSoft, foreground: colors.accent },
  }[tone];
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: palette.background, alignSelf: "flex-start" }}>
      <Text variant="meta" weight="medium" style={{ color: palette.foreground }}>{children}</Text>
    </View>
  );
}

/** Loading placeholder that pulses like the web skeleton, or rests when motion is reduced. */
export function Skeleton({ width, height = 14, radius = 6, style }: { width: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const { colors, motion } = useTheme();
  const opacity = useSharedValue(0.55);
  React.useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: motion.durations.verySlow * 2, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.System }), -1, true);
  }, [motion.durations.verySlow, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: colors.hover }, animated, style]} />;
}

export function EmptyState({ title, message, action }: { title: string; message?: string; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 48, paddingHorizontal: 24, gap: 8 }}>
      <Text variant="body" weight="medium" style={{ textAlign: "center" }}>{title}</Text>
      {message ? <Text variant="secondary" tone="tertiary" style={{ textAlign: "center" }}>{message}</Text> : null}
      {action ? <View style={{ marginTop: 8 }}>{action}</View> : null}
    </View>
  );
}
