import * as React from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSession } from "../../src/session/session";
import { useTheme } from "../../src/theme/theme";
import { BrandLogo } from "../../src/ui/brand";
import { Button } from "../../src/ui/button";
import { QrCode } from "../../src/ui/icons";
import { Screen } from "../../src/ui/screen";
import { Text } from "../../src/ui/text";

const STEPS = [
  "On your computer, open Berry and sign in.",
  "Choose Get the mobile app at the bottom of the sidebar.",
  "Scan the code, then approve the sign-in on your computer.",
];

export default function Welcome() {
  const { state } = useSession();
  const { colors, layout } = useTheme();
  const reason = state.status === "signed-out" ? state.reason : null;
  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.hero}>
          <BrandLogo size={56} />
          <Text variant="pageTitle" style={styles.center}>Berry</Text>
          <Text variant="body" tone="secondary" style={styles.center}>Sign in with your organization's Berry. The app connects to the same server you use on the web.</Text>
        </View>

        {reason === "revoked" ? (
          <View style={[styles.notice, { backgroundColor: colors.surfaceUnder, borderColor: colors.border, borderRadius: layout.radius }]} accessibilityRole="alert">
            <Text variant="secondary">This phone was signed out, either from the web or by your organization. Sign in again to continue.</Text>
          </View>
        ) : null}

        <View style={[styles.steps, { backgroundColor: colors.surfaceUnder, borderColor: colors.border, borderRadius: layout.panelRadius }]}>
          {STEPS.map((step, index) => (
            <View key={step} style={styles.step}>
              <View style={[styles.stepNumber, { backgroundColor: colors.accentSoft }]}>
                <Text variant="meta" weight="semibold">{index + 1}</Text>
              </View>
              <Text variant="body" style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        <View style={styles.actions}>
          <Button size="lg" icon={QrCode} label="Scan QR code" haptic onPress={() => router.push("/(auth)/scan")} />
          <Button size="lg" variant="ghost" label="Enter a code instead" onPress={() => router.push("/(auth)/enter-code")} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, paddingBottom: 16, justifyContent: "space-between" },
  hero: { alignItems: "center", gap: 12, paddingTop: 48 },
  center: { textAlign: "center" },
  notice: { padding: 12, borderWidth: StyleSheet.hairlineWidth },
  steps: { padding: 16, gap: 14, borderWidth: StyleSheet.hairlineWidth },
  step: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stepNumber: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginTop: -1 },
  stepText: { flex: 1 },
  actions: { gap: 8 },
});
