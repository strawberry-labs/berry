import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { formatCurrencyMicros } from "@berry/client-core/format";
import { APP_VERSION } from "../../config";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { ArrowUpRight01Icon, ChevronRight, LogOut } from "../../ui/icons";
import { Avatar } from "../../ui/primitives";
import { SettingsRow } from "../../ui/rows";
import { Screen, Section } from "../../ui/screen";
import { Text } from "../../ui/text";
import { useAllowance, useOrganizationId } from "../data/shell-data";
import { TopBar } from "../shell/top-bar";
import { ThemePicker } from "./general-tab";
import { MobileDevicesSection, useConfirmSignOut } from "./mobile-devices-section";
import { useEffectivePermissions, useMobileDevices, useOrganization } from "./settings-data";
import { Building } from "../../ui/icons";
import { canOpenAdminConsole, visibleSettingsTabs, webUrl } from "./settings-model";
import { SETTINGS_TAB_ICONS, openSettingsTab } from "./settings-navigation";
import { SettingsScroll, ValueRow } from "./settings-ui";

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Settings home: the web's personal settings tabs as rows, plus what a phone
 * needs at hand (appearance, paired phones, admin console link, about, sign out).
 */
export function SettingsHome() {
  const { profile, serverInfo } = useSignedInSession();
  const { colors } = useTheme();
  const organization = useOrganization();
  const permissions = useEffectivePermissions();
  const devices = useMobileDevices();
  const tenantId = useOrganizationId();
  const allowance = useAllowance(tenantId);
  const confirmSignOut = useConfirmSignOut();
  const [copied, setCopied] = React.useState(false);

  const tabs = visibleSettingsTabs(serverInfo?.capabilities ?? null);
  const user = profile.user;
  const brandName = serverInfo?.brand.applicationName ?? profile.brand.applicationName;
  const isAdmin = canOpenAdminConsole(permissions.data?.permissions ?? []);
  const usageDetail = allowance.data
    ? allowance.data.availableMicros === null ? "Unlimited allowance" : `${formatCurrencyMicros(allowance.data.availableMicros)} available this cycle`
    : undefined;

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const refreshing = organization.isRefetching || permissions.isRefetching || devices.isRefetching;
  const refresh = () => {
    void organization.refetch();
    void devices.refetch();
    // refetch() ignores `enabled`, so wait for the organization id.
    if (tenantId) {
      void permissions.refetch();
      void allowance.refetch();
    }
  };

  return (
    <Screen edges={["top"]}>
      <TopBar title="Settings" />
      <SettingsScroll refreshing={refreshing} onRefresh={refresh}>
        <Section>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Account, ${user.name || user.email}`}
            onPress={() => openSettingsTab({ id: "account", href: null })}
            style={({ pressed }) => [styles.account, pressed && { backgroundColor: colors.hover }]}
          >
            <Avatar name={user.name} email={user.email} image={user.image} size={44} />
            <View style={styles.accountText}>
              <Text variant="body" weight="semibold" numberOfLines={1}>{user.name?.trim() || "Berry account"}</Text>
              <Text variant="secondary" tone="tertiary" numberOfLines={1}>{user.email}</Text>
            </View>
            <ChevronRight size={16} color={colors.textFaint} />
          </Pressable>
        </Section>

        <Section>
          {tabs.map((tab, index) => (
            <SettingsRow
              key={tab.id}
              icon={SETTINGS_TAB_ICONS[tab.id]}
              label={tab.label}
              detail={tab.id === "usage" ? usageDetail : undefined}
              onPress={() => openSettingsTab(tab)}
              last={index === tabs.length - 1}
            />
          ))}
        </Section>

        <Section title="Appearance">
          <ThemePicker />
        </Section>

        <MobileDevicesSection description="Phones signed in to your account. Signing one out takes effect the next time it connects." />

        {isAdmin ? (
          <Section title="Organization" description="Organization administration stays on the web.">
            <SettingsRow
              icon={Building}
              label="Open admin console"
              detail={`Manage ${organization.data?.name ?? brandName} in your browser.`}
              trailing={<ArrowUpRight01Icon size={16} color={colors.textFaint} />}
              onPress={() => void WebBrowser.openBrowserAsync(webUrl(profile.serverUrl, "/admin/overview"))}
              last
            />
          </Section>
        ) : null}

        <Section title="About">
          <ValueRow
            label="Server"
            value={copied ? "Copied" : displayUrl(profile.serverUrl)}
            onPress={() => {
              void Clipboard.setStringAsync(profile.serverUrl);
              setCopied(true);
            }}
          />
          <ValueRow label="Organization" value={organization.data?.name ?? (organization.isPending ? "…" : brandName)} />
          <ValueRow label="App version" value={APP_VERSION} />
          <ValueRow label="Server version" value={serverInfo?.serverVersion ?? "…"} last />
        </Section>

        <Section>
          <SettingsRow icon={LogOut} label="Sign out of this phone" destructive onPress={confirmSignOut} trailing={<View />} last />
        </Section>
      </SettingsScroll>
    </Screen>
  );
}

const styles = StyleSheet.create({
  account: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  accountText: { flex: 1, minWidth: 0, gap: 2 },
});
