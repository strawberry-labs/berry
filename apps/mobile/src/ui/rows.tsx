import * as React from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme/theme";
import { ChevronRight, type Icon } from "./icons";
import { Text } from "./text";

/**
 * The web sidebar's `SidebarMenuButton`: a 30px row (44pt touch target on
 * phones) with an icon, label, and optional trailing content.
 */
export function SidebarMenuButton({ icon: IconComponent, label, active = false, onPress, onLongPress, trailing, indent = 0, accessibilityLabel, style, muted = false }: {
  icon?: Icon | undefined;
  label: string;
  active?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  trailing?: React.ReactNode;
  indent?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  muted?: boolean;
}) {
  const { colors, layout } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { borderRadius: layout.radius, paddingLeft: 8 + indent, backgroundColor: active ? colors.selected : pressed ? colors.hover : "transparent" },
        style,
      ]}
    >
      {IconComponent ? <IconComponent size={16} color={active ? colors.textPrimary : colors.textSecondary} /> : null}
      <Text variant="body" numberOfLines={1} tone={muted ? "tertiary" : active ? "primary" : "secondary"} style={styles.label}>{label}</Text>
      {trailing}
    </Pressable>
  );
}

/** A settings list row: label, optional detail, and a chevron or control. */
export function SettingsRow({ icon: IconComponent, label, detail, onPress, trailing, destructive = false, last = false }: {
  icon?: Icon | undefined;
  label: string;
  detail?: string | undefined;
  onPress?: () => void;
  trailing?: React.ReactNode;
  destructive?: boolean;
  last?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.settingsRow, { backgroundColor: pressed && onPress ? colors.hover : "transparent" }]}
    >
      {IconComponent ? <IconComponent size={18} color={destructive ? colors.danger : colors.textSecondary} /> : null}
      <View style={[styles.settingsBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" tone={destructive ? "danger" : "primary"}>{label}</Text>
          {detail ? <Text variant="secondary" tone="tertiary" numberOfLines={2}>{detail}</Text> : null}
        </View>
        {trailing ?? (onPress ? <ChevronRight size={16} color={colors.textFaint} /> : null)}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 8 },
  label: { flex: 1 },
  settingsRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16 },
  settingsBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 10, paddingRight: 16 },
});
