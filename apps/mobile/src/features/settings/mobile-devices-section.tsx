import * as React from "react";
import { Alert, StyleSheet, View } from "react-native";
import type { MobileDeviceRegistration } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Smartphone } from "../../ui/icons";
import { EmptyState, StatusPill } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Text } from "../../ui/text";
import { useMobileDevices, useRevokeDevice } from "./settings-data";
import { describePairedDevice, deviceTitle, formatDate, formatDateTime, sortDevices } from "./settings-model";
import { AsyncContent, InlineMessage, ListRow } from "./settings-ui";

/** Confirms, then ends this phone's session (server first, then local credentials). */
export function useConfirmSignOut() {
  const { signOut, serverInfo, profile } = useSignedInSession();
  const name = serverInfo?.brand.applicationName ?? profile.brand.applicationName;
  return React.useCallback(() => {
    Alert.alert(
      "Sign out of this phone?",
      `You'll need a new sign-in code from ${name} on the web to use this phone again.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void signOut() },
      ],
    );
  }, [name, signOut]);
}

/**
 * The web's MobileDevicesSection: phones signed in to this account, this
 * phone first, with sign-out for each (this one signs out locally too).
 */
export function MobileDevicesSection({ title = "Mobile devices", description = "Phones signed in with the Berry app. Signing one out takes effect the next time it connects." }: { title?: string; description?: string }) {
  const devices = useMobileDevices();
  const revoke = useRevokeDevice();
  const confirmSignOut = useConfirmSignOut();
  const [error, setError] = React.useState<string | null>(null);
  const sorted = React.useMemo(() => sortDevices(devices.data ?? []), [devices.data]);

  const confirmRevoke = (device: MobileDeviceRegistration) => {
    if (device.current) {
      confirmSignOut();
      return;
    }
    setError(null);
    Alert.alert(
      `Sign out ${deviceTitle(device)}?`,
      "The phone is signed out the next time it contacts Berry. Signing in again needs a new code from the web.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => revoke.mutate(device, { onError: (cause) => setError(apiErrorMessage(cause, "Could not sign out this device. Try again.")) }),
        },
      ],
    );
  };

  return (
    <Section title={title} description={description} footer={error ? <InlineMessage tone="danger" onDismiss={() => setError(null)}>{error}</InlineMessage> : undefined}>
      <AsyncContent
        loading={devices.isPending}
        error={devices.isError ? apiErrorMessage(devices.error, "Could not load your phones. Try again.") : null}
        onRetry={() => void devices.refetch()}
        rows={2}
      >
        {sorted.length === 0 ? (
          <EmptyState title="No phones signed in" message="Choose Get the mobile app in the web sidebar to sign in on a phone." />
        ) : sorted.map((device, index) => (
          <DeviceRow
            key={device.deviceId}
            device={device}
            last={index === sorted.length - 1}
            busy={revoke.isPending && revoke.variables?.deviceId === device.deviceId}
            onSignOut={() => confirmRevoke(device)}
          />
        ))}
      </AsyncContent>
    </Section>
  );
}

function DeviceRow({ device, last, busy, onSignOut }: { device: MobileDeviceRegistration; last: boolean; busy: boolean; onSignOut: () => void }) {
  const { colors, layout } = useTheme();
  const title = deviceTitle(device);
  return (
    <ListRow last={last}>
      <View style={[styles.icon, { backgroundColor: colors.control, borderRadius: layout.radius - 2 }]}>
        <Smartphone size={16} color={colors.textSecondary} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text variant="body" weight="medium" numberOfLines={1} style={styles.shrink}>{title}</Text>
          {device.current ? <StatusPill tone="info">This phone</StatusPill> : null}
        </View>
        <Text variant="secondary" tone="secondary" numberOfLines={1}>{describePairedDevice(device)}</Text>
        <Text variant="meta" tone="tertiary" numberOfLines={1}>
          {device.pairedAt ? `Signed in ${formatDate(device.pairedAt)} · ` : ""}Last active {formatDateTime(device.lastSeenAt)}
        </Text>
      </View>
      <Button
        variant="outline"
        size="sm"
        label="Sign out"
        loading={busy}
        accessibilityLabel={device.current ? "Sign out of this phone" : `Sign out ${title}`}
        onPress={onSignOut}
      />
    </ListRow>
  );
}

const styles = StyleSheet.create({
  icon: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  shrink: { flexShrink: 1 },
});
