import * as React from "react";
import { Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { hasCapability } from "../../session/compatibility";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { ChevronDown, Search, TriangleAlertIcon, X, type Icon } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import { EmptyState, Input } from "../../ui/primitives";
import { Text } from "../../ui/text";

/** The ManagementPage header: page title and its one-line description. */
export function PageHeader({ title, description }: { title: string; description?: string | undefined }) {
  return (
    <View style={styles.pageHeader}>
      <Text variant="pageTitle" accessibilityRole="header">{title}</Text>
      {description ? <Text variant="secondary" tone="tertiary">{description}</Text> : null}
    </View>
  );
}

/**
 * Shows the page title in the top bar once the in-page title scrolls away,
 * like a large iOS title collapsing into the navigation bar.
 */
export function useScrollTitle(threshold = 40) {
  const [titleVisible, setTitleVisible] = React.useState(false);
  const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > threshold;
    setTitleVisible((current) => (current === next ? current : next));
  }, [threshold]);
  return { titleVisible, onScroll };
}

/** Features an older or restricted server doesn't advertise get an explanation instead of failing requests. */
export function useCapabilityAvailable(capability: string): boolean {
  const { serverInfo } = useSignedInSession();
  // While server info loads, behave like the sidebar and assume the feature is there.
  return !serverInfo || hasCapability(serverInfo, capability);
}

export function CapabilityUnavailable({ feature }: { feature: string }) {
  const { serverInfo, profile } = useSignedInSession();
  const name = (serverInfo?.brand ?? profile.brand).applicationName;
  return (
    <EmptyState
      title={`${feature} isn't available`}
      message={`${name} doesn't offer ${feature.toLowerCase()} on this server. Ask your administrator if you need it.`}
    />
  );
}

/** The web's library search box: a leading search glyph and a clear button. */
export function SearchField({ value, onChangeText, placeholder, accessibilityLabel, style }: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.search, style]}>
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.searchInput, { paddingRight: value ? 40 : 12 }]}
      />
      <View pointerEvents="none" style={styles.searchIcon}><Search size={16} color={colors.textTertiary} /></View>
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => onChangeText("")} style={styles.searchClear}>
          <X size={14} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export type TabItem<T extends string> = { value: T; label: string; icon?: Icon | undefined; count?: number | undefined };

/** The library's underlined tab strip (role tablist), with counts in metadata type. */
export function UnderlineTabs<T extends string>({ items, value, onChange, accessibilityLabel }: {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.tabs, { borderBottomColor: colors.border }]}>
      {items.map((item) => {
        const selected = item.value === value;
        const IconComponent = item.icon;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.count === undefined ? item.label : `${item.label}, ${item.count}`}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(item.value);
            }}
            style={({ pressed }) => [styles.tab, { backgroundColor: pressed ? colors.hover : "transparent" }]}
          >
            {IconComponent ? <IconComponent size={15} color={selected ? colors.textPrimary : colors.textTertiary} /> : null}
            <Text variant="body" tone={selected ? "primary" : "tertiary"} weight={selected ? "medium" : "body"}>{item.label}</Text>
            {item.count !== undefined ? <Text variant="meta" tone="tertiary" style={styles.numeric}>{item.count}</Text> : null}
            {selected ? <View style={[styles.tabIndicator, { backgroundColor: colors.accent }]} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The web's outline ToggleGroup: equal segments, the selected one filled. */
export function SegmentedControl<T extends string>({ items, value, onChange, disabled = false, accessibilityLabel }: {
  items: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const { colors, layout } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={[styles.segmented, { borderColor: colors.borderStrong, borderRadius: layout.radius, opacity: disabled ? 0.5 : 1 }]}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(item.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              index > 0 && { borderLeftWidth: StyleSheet.hairlineWidth * 2, borderLeftColor: colors.borderStrong },
              { backgroundColor: selected ? colors.selected : pressed ? colors.hover : "transparent" },
            ]}
          >
            <Text variant="secondary" weight={selected ? "semibold" : "medium"} tone={selected ? "primary" : "secondary"} numberOfLines={1}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** shadcn's vertical Field: label, control, then helper text. */
export function Field({ label, description, children }: { label: string; description?: string | undefined; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="secondary" weight="medium">{label}</Text>
      {children}
      {description ? <Text variant="secondary" tone="secondary">{description}</Text> : null}
    </View>
  );
}

export type SelectOption = { value: string; label: string };

/** A form select: an input-styled trigger that opens a native menu of options. */
export function SelectField({ value, options, onChange, accessibilityLabel, disabled = false, placeholder = "Choose…", icon: IconComponent, style, compact = false }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  placeholder?: string;
  icon?: Icon | undefined;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const { colors, layout } = useTheme();
  const selected = options.find((option) => option.value === value);
  const trigger = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${selected?.label ?? placeholder}`}
      accessibilityState={{ disabled }}
      style={[
        styles.select,
        {
          minHeight: compact ? 40 : 44,
          borderRadius: layout.radius,
          borderColor: colors.borderStrong,
          backgroundColor: colors.control,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {IconComponent ? <IconComponent size={15} color={colors.textSecondary} /> : null}
      <Text variant="body" tone={selected ? "primary" : "faint"} numberOfLines={1} style={styles.selectLabel}>{selected?.label ?? placeholder}</Text>
      <ChevronDown size={14} color={colors.textTertiary} />
    </View>
  );
  // The native menu view takes no style, so sizing (flex, max width) lives on a wrapper it stretches within.
  return (
    <View style={style}>
      {disabled ? trigger : (
        <Menu title={accessibilityLabel} items={options.map((option) => ({ id: option.value, title: option.label, checked: option.value === value }))} onSelect={onChange}>
          {trigger}
        </Menu>
      )}
    </View>
  );
}

export function TextArea({ style, ...props }: TextInputProps) {
  return <Input multiline textAlignVertical="top" scrollEnabled={false} {...props} style={[styles.textArea, style]} />;
}

/** The web's inline Alert: a bordered note for errors and warnings. */
export function InlineAlert({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "danger" }) {
  const { colors, layout } = useTheme();
  const danger = tone === "danger";
  return (
    <View
      accessibilityRole="alert"
      style={[styles.alert, { borderRadius: layout.radius, borderColor: danger ? colors.danger : colors.border, backgroundColor: danger ? colors.dangerSoft : colors.surfaceInset }]}
    >
      <TriangleAlertIcon size={14} color={danger ? colors.danger : colors.textSecondary} />
      <Text variant="secondary" tone={danger ? "danger" : "secondary"} style={styles.alertText}>{children}</Text>
    </View>
  );
}

export const pageKitStyles = StyleSheet.create({
  /** Horizontal page padding shared by the list screens (the web's 16px phone gutter). */
  gutter: { paddingHorizontal: 16 },
  numeric: { fontVariant: ["tabular-nums"] },
});

const styles = StyleSheet.create({
  pageHeader: { gap: 6, paddingHorizontal: 4 },
  search: { justifyContent: "center" },
  searchInput: { minHeight: 40, paddingLeft: 36 },
  searchIcon: { position: "absolute", left: 12 },
  searchClear: { position: "absolute", right: 6, width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  tabs: { flexDirection: "row", gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  tabIndicator: { position: "absolute", left: 8, right: 8, bottom: -StyleSheet.hairlineWidth, height: 2, borderRadius: 1 },
  numeric: { fontVariant: ["tabular-nums"] },
  segmented: { flexDirection: "row", borderWidth: StyleSheet.hairlineWidth * 2, overflow: "hidden" },
  segment: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  field: { gap: 6 },
  select: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth * 2 },
  selectLabel: { flex: 1 },
  textArea: { minHeight: 112, paddingTop: 10, paddingBottom: 10 },
  alert: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderWidth: StyleSheet.hairlineWidth },
  alertText: { flex: 1 },
});
