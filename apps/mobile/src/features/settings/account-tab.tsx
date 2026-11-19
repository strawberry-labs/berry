import * as React from "react";
import { StyleSheet, View } from "react-native";
import { apiErrorMessage } from "../../api/client";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Mail, User } from "../../ui/icons";
import { Avatar } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Text } from "../../ui/text";
import { useOrganizationId } from "../data/shell-data";
import { MobileDevicesSection } from "./mobile-devices-section";
import { useEffectivePermissions, useMobileDevices } from "./settings-data";
import { AsyncContent, Chip, SectionBody, SettingsPage } from "./settings-ui";

/** Settings › Account: profile (view only), effective access, and paired phones. */
export function AccountTab() {
  const { profile } = useSignedInSession();
  const { colors, layout } = useTheme();
  const tenantId = useOrganizationId();
  const access = useEffectivePermissions();
  const devices = useMobileDevices();
  const user = profile.user;
  const name = user.name?.trim() || "Unnamed account";
  const permissions = access.data?.permissions ?? [];

  return (
    <SettingsPage
      title="Account"
      description="Your signed-in identity and effective organization access."
      refreshing={access.isRefetching || devices.isRefetching}
      onRefresh={() => {
        // refetch() ignores `enabled`, so wait for the organization id.
        if (tenantId) void access.refetch();
        void devices.refetch();
      }}
    >
      <Section title="Profile">
        <View style={styles.profile}>
          <Avatar name={user.name} email={user.email} image={user.image} size={48} />
          <View style={styles.identity}>
            <Text variant="body" weight="semibold" numberOfLines={1}>{name}</Text>
            <View style={styles.email}>
              <Mail size={13} color={colors.textTertiary} />
              <Text variant="secondary" tone="tertiary" numberOfLines={1} style={{ flexShrink: 1 }}>{user.email || "No email available"}</Text>
            </View>
          </View>
          <View style={[styles.viewOnly, { borderColor: colors.border, backgroundColor: colors.control, borderRadius: layout.radius - 4 }]}>
            <User size={13} color={colors.textSecondary} />
            <Text variant="meta" tone="secondary">View only</Text>
          </View>
        </View>
      </Section>

      <Section
        title="Effective access"
        description={`Role: ${access.data?.role ?? "Unknown"}. Permissions are enforced by the server.`}
      >
        <AsyncContent
          loading={access.isPending}
          error={access.isError ? apiErrorMessage(access.error, "Could not load your access. Try again.") : null}
          onRetry={() => void access.refetch()}
          rows={2}
        >
          <SectionBody>
            {permissions.length === 0 ? (
              <Text variant="secondary" tone="tertiary">No organization permissions are assigned.</Text>
            ) : (
              <View style={styles.chips} accessibilityLabel={`Permissions: ${permissions.join(", ")}`}>
                {permissions.map((permission) => <Chip key={permission} mono>{permission}</Chip>)}
              </View>
            )}
          </SectionBody>
        </AsyncContent>
      </Section>

      <MobileDevicesSection />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16 },
  identity: { flex: 1, minWidth: 0, gap: 4 },
  email: { flexDirection: "row", alignItems: "center", gap: 6 },
  viewOnly: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
