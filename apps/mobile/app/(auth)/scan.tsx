import * as React from "react";
import { Linking, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ALLOW_INSECURE_LOCAL_SERVERS } from "../../src/config";
import { readScannedCode } from "../../src/pairing/pairing";
import { setPendingPairing } from "../../src/pairing/pending";
import { useTheme } from "../../src/theme/theme";
import { Button } from "../../src/ui/button";
import { Flashlight, FlashlightOff, X } from "../../src/ui/icons";
import { Screen } from "../../src/ui/screen";
import { Text } from "../../src/ui/text";

const FRAME = 240;

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [torch, setTorch] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const handled = React.useRef(false);

  const onScanned = React.useCallback((result: BarcodeScanningResult) => {
    if (handled.current) return;
    const scanned = readScannedCode(result.data, { allowInsecureLocal: ALLOW_INSECURE_LOCAL_SERVERS });
    if (scanned.kind === "invalid") {
      setMessage(scanned.message);
      return;
    }
    handled.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPendingPairing({ kind: "qr", pairing: scanned.pairing });
    router.replace("/(auth)/pairing");
  }, []);

  if (!permission) return <Screen><View /></Screen>;

  if (!permission.granted) {
    return (
      <Screen>
        <View style={styles.permission}>
          <Text variant="pageTitle">Allow camera access</Text>
          <Text variant="body" tone="secondary">Berry uses the camera only to scan the sign-in code shown on your computer.</Text>
          <View style={styles.permissionActions}>
            {permission.canAskAgain
              ? <Button size="lg" label="Allow camera" onPress={() => void requestPermission()} />
              : <Button size="lg" label="Open Settings" onPress={() => void Linking.openSettings()} />}
            <Button size="lg" variant="ghost" label="Enter a code instead" onPress={() => router.replace("/(auth)/enter-code")} />
            <Button size="lg" variant="ghost" label="Cancel" onPress={() => router.back()} />
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <View style={styles.camera}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned} />
      <View style={[styles.overlay, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
        <View style={styles.topBar}>
          <Button variant="ghost" size="icon-lg" icon={X} accessibilityLabel="Close scanner" onPress={() => router.back()} style={styles.roundButton} />
          <Button variant="ghost" size="icon-lg" icon={torch ? FlashlightOff : Flashlight} accessibilityLabel={torch ? "Turn off flashlight" : "Turn on flashlight"} onPress={() => setTorch((value) => !value)} style={styles.roundButton} />
        </View>
        <View style={styles.center} pointerEvents="none">
          <View style={styles.frame}>
            {(["topLeft", "topRight", "bottomLeft", "bottomRight"] as const).map((corner) => <View key={corner} style={[styles.corner, styles[corner]]} />)}
          </View>
          <Text variant="body" style={styles.hint}>Point at the code in Berry on your computer</Text>
          {message ? <Text variant="secondary" style={[styles.hint, { color: "#ffd3cf" }]} accessibilityRole="alert">{message}</Text> : null}
        </View>
        <Button size="lg" variant="secondary" label="Enter a code instead" onPress={() => router.replace("/(auth)/enter-code")} style={{ alignSelf: "center", backgroundColor: "rgba(0,0,0,0.55)" }} />
      </View>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: insets.top, backgroundColor: colors.overlay }} pointerEvents="none" />
    </View>
  );
}

const CORNER = { position: "absolute" as const, width: 34, height: 34, borderColor: "#ffffff" };

const styles = StyleSheet.create({
  camera: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between", paddingHorizontal: 16 },
  topBar: { flexDirection: "row", justifyContent: "space-between" },
  roundButton: { backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 22 },
  center: { alignItems: "center", gap: 20 },
  frame: { width: FRAME, height: FRAME },
  corner: CORNER,
  topLeft: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 18 },
  topRight: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 18 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 18 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 18 },
  hint: { color: "#ffffff", textAlign: "center", paddingHorizontal: 24, textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 6 },
  permission: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  permissionActions: { gap: 8, marginTop: 16 },
});
