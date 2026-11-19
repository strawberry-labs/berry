import * as React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { router } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { CheckIcon, ChevronDown, ChevronLeft, OctagonXIcon, SearchIcon, XIcon } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import { Input, Skeleton } from "../../ui/primitives";
import { Screen } from "../../ui/screen";
import { Text } from "../../ui/text";

/** Leaves a settings sub-page; a deep link with no history lands on the settings home. */
export function leaveSettingsPage() {
  if (router.canGoBack()) router.back();
  else router.navigate("/(app)/settings");
}

/** The pushed-page header: a back button where drawer screens put the sidebar toggle. */
export function SettingsHeader({ title, trailing, onBack = leaveSettingsPage }: { title: string; trailing?: React.ReactNode; onBack?: () => void }) {
  const { layout } = useTheme();
  return (
    <View style={[styles.header, { height: layout.titlebarHeight }]}>
      <Button variant="ghost" size="icon-lg" icon={ChevronLeft} accessibilityLabel="Back" onPress={onBack} />
      <Text variant="body" weight="semibold" numberOfLines={1} accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerTrailing}>{trailing}</View>
    </View>
  );
}

/**
 * The ManagementPage pattern for a pushed settings page: header, the page's
 * one-line description, then sections. Forms scroll clear of the keyboard.
 */
export function SettingsPage({ title, description, trailing, refreshing, onRefresh, children, contentStyle }: {
  title: string;
  description?: string | undefined;
  trailing?: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: (() => void) | undefined;
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Screen edges={["top"]}>
      <SettingsHeader title={title} trailing={trailing} />
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, contentStyle]}
        refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.textTertiary} /> : undefined}
      >
        {description ? <Text variant="secondary" tone="tertiary" style={styles.description}>{description}</Text> : null}
        {children}
      </KeyboardAwareScrollView>
    </Screen>
  );
}

/** A plain scroll body for screens that own their header (the settings home). */
export function SettingsScroll({ children, refreshing, onRefresh }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.page}
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.textTertiary} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

/** Padding for content placed inside a `Section` card. */
export function SectionBody({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.sectionBody, style]}>{children}</View>;
}

export function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="secondary" tone="secondary" weight="medium">{label}</Text>
      {children}
      {hint ? <Text variant="meta" tone="tertiary">{hint}</Text> : null}
    </View>
  );
}

/** Inline replacement for the web's toasts and alert rows. */
export function InlineMessage({ tone, children, onDismiss }: { tone: "danger" | "success" | "info"; children: string; onDismiss?: () => void }) {
  const { colors, layout } = useTheme();
  const palette = tone === "danger"
    ? { background: colors.dangerSoft, border: colors.dangerSoft, foreground: colors.danger, Icon: OctagonXIcon }
    : tone === "success"
      ? { background: colors.surfaceUnder, border: colors.border, foreground: colors.textSecondary, Icon: CheckIcon }
      : { background: colors.accentSoft, border: colors.accentSoft, foreground: colors.textSecondary, Icon: null };
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : "text"}
      accessibilityLiveRegion="polite"
      style={[styles.message, { backgroundColor: palette.background, borderColor: palette.border, borderRadius: layout.radius }]}
    >
      {palette.Icon ? <palette.Icon size={14} color={tone === "success" ? colors.nodeSession : palette.foreground} /> : null}
      <Text variant="secondary" style={{ flex: 1, color: palette.foreground }}>{children}</Text>
      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss} hitSlop={12}>
          <XIcon size={14} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The web's line tabs and theme select as a compact segmented control. */
export function SegmentedControl<T extends string>({ value, options, onChange, accessibilityLabel }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  const { colors, layout } = useTheme();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.segmented, { backgroundColor: colors.command, borderRadius: layout.radius }]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => { if (!selected) onChange(option.value); }}
            style={({ pressed }) => [
              styles.segment,
              { borderRadius: layout.radius - 2 },
              selected
                ? { backgroundColor: colors.card, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth }
                : pressed ? { backgroundColor: colors.hover } : null,
            ]}
          >
            <Text variant="secondary" weight="medium" tone={selected ? "primary" : "secondary"} numberOfLines={1}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The web's FormSelect as a native menu anchored to an input-shaped trigger. */
export function SelectField<T extends string>({ label, value, options, onChange, disabled = false, compact = false }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { colors, layout } = useTheme();
  const current = options.find((option) => option.value === value)?.label ?? value;
  const trigger = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${current}`}
      accessibilityState={{ disabled }}
      style={[
        styles.select,
        {
          minHeight: compact ? 36 : 44,
          borderRadius: layout.radius,
          borderColor: colors.borderStrong,
          backgroundColor: colors.control,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text variant={compact ? "secondary" : "body"} numberOfLines={1} style={{ flex: 1 }}>{current}</Text>
      <ChevronDown size={14} color={colors.textTertiary} />
    </View>
  );
  if (disabled) return trigger;
  return (
    <Menu
      title={label}
      items={options.map((option) => ({ id: option.value, title: option.label, checked: option.value === value }))}
      onSelect={(id) => onChange(id as T)}
    >
      {trigger}
    </Menu>
  );
}

/** A search box for filtering a settings list. */
export function FilterInput({ value, onChangeText, placeholder }: { value: string; onChangeText: (value: string) => void; placeholder: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.filter}>
      <View style={styles.filterIcon} pointerEvents="none"><SearchIcon size={16} color={colors.textTertiary} /></View>
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        style={{ paddingLeft: 36 }}
      />
    </View>
  );
}

/** A label with its value on the right (About, details). */
export function ValueRow({ label, value, last = false, onPress, selectable = false }: { label: string; value: string; last?: boolean; onPress?: () => void; selectable?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${label}, ${value}`}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.valueRow, { backgroundColor: pressed && onPress ? colors.hover : "transparent" }]}
    >
      <View style={[styles.valueBody, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
        <Text variant="body">{label}</Text>
        <Text variant="secondary" tone="tertiary" numberOfLines={1} selectable={selectable} style={styles.value}>{value}</Text>
      </View>
    </Pressable>
  );
}

/** A rounded token, e.g. a permission. */
export function Chip({ children, mono = false }: { children: string; mono?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.chip, { borderColor: colors.borderStrong, backgroundColor: colors.accentSoft }]}>
      <Text variant="meta" weight="medium" mono={mono}>{children}</Text>
    </View>
  );
}

/** The web's AsyncState: skeleton while loading, an error with retry, then content. */
export function AsyncContent({ loading, error, onRetry, rows = 3, children }: {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  rows?: number;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <View style={styles.skeletons} accessibilityLabel="Loading" accessibilityRole="progressbar">
        {Array.from({ length: rows }, (_, index) => <Skeleton key={index} width={index % 2 ? "70%" : "100%"} height={16} />)}
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.error}>
        <InlineMessage tone="danger">{error}</InlineMessage>
        {onRetry ? <Button variant="outline" size="sm" label="Try again" onPress={onRetry} style={{ alignSelf: "flex-start" }} /> : null}
      </View>
    );
  }
  return <>{children}</>;
}

/** A row inside a section card with a hairline divider below. */
export function ListRow({ children, last = false, onPress, onLongPress, accessibilityLabel, style }: {
  children: React.ReactNode;
  last?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      disabled={!onPress && !onLongPress}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.listRow,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
        { backgroundColor: pressed && (onPress || onLongPress) ? colors.hover : "transparent" },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4, gap: 4 },
  headerTitle: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  headerTrailing: { flexDirection: "row", alignItems: "center", paddingRight: 4 },
  page: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 48, gap: 24 },
  description: { paddingHorizontal: 4, marginBottom: -8 },
  sectionBody: { padding: 16, gap: 14 },
  field: { gap: 6 },
  message: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth },
  segmented: { flexDirection: "row", padding: 2, gap: 2 },
  segment: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  select: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth * 2 },
  filter: { justifyContent: "center" },
  filterIcon: { position: "absolute", left: 12, zIndex: 1 },
  valueRow: { paddingLeft: 16 },
  valueBody: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 10, paddingRight: 16 },
  value: { flex: 1, textAlign: "right" },
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  skeletons: { gap: 10, padding: 16 },
  error: { gap: 10 },
  listRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 },
});
