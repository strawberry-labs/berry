import * as React from "react";
import { StyleSheet, View } from "react-native";
import { useTheme, type ThemePreference } from "../../theme/theme";
import { Globe, Monitor, Moon, Sun } from "../../ui/icons";
import { SettingsRow } from "../../ui/rows";
import { Section } from "../../ui/screen";
import { Text } from "../../ui/text";
import { SectionBody, SegmentedControl, SettingsPage } from "./settings-ui";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The web's Theme setting; the choice is stored on this phone. */
export function ThemePicker() {
  const { preference, setPreference, colors, scheme } = useTheme();
  const Icon = preference === "system" ? Monitor : scheme === "dark" ? Moon : Sun;
  return (
    <SectionBody>
      <View style={styles.row}>
        <View style={[styles.icon, { borderColor: colors.border, backgroundColor: colors.control }]}>
          <Icon size={16} color={colors.textSecondary} />
        </View>
        <View style={styles.copy}>
          <Text variant="body" weight="medium">Theme</Text>
          <Text variant="secondary" tone="tertiary">Use Berry's light, dark, or system appearance.</Text>
        </View>
      </View>
      <SegmentedControl value={preference} options={THEME_OPTIONS} onChange={setPreference} accessibilityLabel="Theme" />
    </SectionBody>
  );
}

/**
 * Settings › General. Appearance only: browser notifications and sound
 * alerts are web-only, and phone notifications arrive with push later.
 */
export function GeneralTab() {
  const { colors } = useTheme();
  return (
    <SettingsPage title="General" description="Choose how Berry looks on this phone.">
      <Section title="Appearance">
        <ThemePicker />
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
        <SettingsRow
          icon={Globe}
          label="Language"
          detail="Berry follows your phone's language settings."
          trailing={<Text variant="secondary" tone="tertiary">System default</Text>}
          last
        />
      </Section>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  icon: { width: 32, height: 32, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
});
