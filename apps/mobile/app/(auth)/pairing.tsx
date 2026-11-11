import * as React from "react";
import { StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import type { MobileBrand } from "@berry/shared";
import { apiErrorMessage, createMobileApiClient } from "../../src/api/client";
import { APP_VERSION, MINIMUM_SERVER_VERSION } from "../../src/config";
import { currentDevice } from "../../src/pairing/device";
import { clearPendingPairing, peekPendingPairing } from "../../src/pairing/pending";
import { runPairing, type PairingProgress } from "../../src/pairing/run-pairing";
import { useSession } from "../../src/session/session";
import { useTheme } from "../../src/theme/theme";
import { BrandLogo } from "../../src/ui/brand";
import { Button } from "../../src/ui/button";
import { Smartphone } from "../../src/ui/icons";
import { Spinner } from "../../src/ui/primitives";
import { Screen } from "../../src/ui/screen";
import { Text } from "../../src/ui/text";

type View_ = PairingProgress | { step: "error"; message: string } | { step: "finishing"; brand: MobileBrand };

export default function Pairing() {
  const { completePairing } = useSession();
  const { colors, layout } = useTheme();
  const [view, setView] = React.useState<View_>({ step: "connecting" });

  React.useEffect(() => {
    const pending = peekPendingPairing();
    if (!pending) {
      router.replace("/(auth)/welcome");
      return;
    }
    const controller = new AbortController();
    void runPairing(pending, (progress) => {
      if (controller.signal.aborted) return;
      if (progress.step === "approved") {
        clearPendingPairing();
        setView({ step: "finishing", brand: progress.serverInfo.brand });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        void completePairing({ serverUrl: progress.serverUrl, apiUrl: progress.apiUrl, serverInfo: progress.serverInfo, result: progress.result })
          .catch(() => setView({ step: "error", message: "Couldn't save the sign-in on this phone. Try again." }));
        return;
      }
      setView(progress);
    }, controller.signal, {
      client: (apiUrl) => createMobileApiClient({ apiUrl, token: null }),
      appVersion: APP_VERSION,
      minimumServerVersion: MINIMUM_SERVER_VERSION,
      device: currentDevice(),
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setView({ step: "error", message: apiErrorMessage(error, "Couldn't connect to that Berry server. Check the address and try again.") });
    });
    return () => controller.abort();
  }, [completePairing]);

  const brand = "brand" in view ? view.brand : null;
  const done = view.step === "denied" || view.step === "expired" || view.step === "error" || view.step === "incompatible";

  return (
    <Screen>
      <View style={styles.container}>
        <View style={styles.hero}>
          {brand ? <BrandLogo uri={brand.logoUrl} size={56} /> : <View style={[styles.iconTile, { backgroundColor: colors.surfaceUnder, borderRadius: layout.panelRadius }]}><Smartphone size={28} color={colors.textSecondary} /></View>}
          {brand ? <Text variant="brand" style={styles.center}>{brand.applicationName}</Text> : null}
        </View>

        <View style={styles.message} accessibilityLiveRegion="polite">
          {view.step === "connecting" ? <><Spinner /><Text variant="body" tone="secondary" style={styles.center}>Connecting to the server…</Text></> : null}
          {view.step === "waiting" ? (
            <>
              <Spinner />
              <Text variant="sectionHeading" style={styles.center}>Approve on your computer</Text>
              <Text variant="body" tone="secondary" style={styles.center}>Berry on your computer is asking whether to sign in on this phone. Choose Approve there.</Text>
            </>
          ) : null}
          {view.step === "finishing" ? <><Spinner /><Text variant="body" tone="secondary" style={styles.center}>Signing in…</Text></> : null}
          {view.step === "denied" ? <Text variant="body" style={styles.center}>The sign-in was denied on your computer.</Text> : null}
          {view.step === "expired" ? <Text variant="body" style={styles.center}>That code expired before it was approved. Show a new code on your computer and try again.</Text> : null}
          {view.step === "incompatible" ? <Text variant="body" style={styles.center}>{view.compatibility.message}</Text> : null}
          {view.step === "error" ? <Text variant="body" style={styles.center}>{view.message}</Text> : null}
        </View>

        <View style={styles.actions}>
          {done ? <Button size="lg" label="Scan again" onPress={() => { clearPendingPairing(); router.replace("/(auth)/scan"); }} /> : null}
          <Button size="lg" variant="ghost" label={done ? "Back" : "Cancel"} onPress={() => { clearPendingPairing(); router.replace("/(auth)/welcome"); }} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 24, paddingBottom: 16, justifyContent: "space-between" },
  hero: { alignItems: "center", gap: 12, paddingTop: 72 },
  iconTile: { width: 64, height: 64, alignItems: "center", justifyContent: "center" },
  message: { alignItems: "center", gap: 12, paddingHorizontal: 8 },
  center: { textAlign: "center" },
  actions: { gap: 8 },
});
