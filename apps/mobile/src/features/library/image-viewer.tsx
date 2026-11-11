import * as React from "react";
import { Modal, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { StoredFile } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Share, X } from "../../ui/icons";
import { Spinner } from "../../ui/primitives";
import { Text } from "../../ui/text";
import { useAuthHeaders } from "../page-kit/auth-headers";
import { downloadPercent, fileTypeLabel, formatBytes } from "./library-model";
import { useFileOpener } from "./use-file-opener";

/**
 * The web's image preview (PhotoView) as a full-screen viewer: pinch to zoom
 * on iOS, share or save from the header, and a download fallback on error.
 */
export function ImageViewer({ file, onClose }: { file: StoredFile | null; onClose: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const headers = useAuthHeaders();
  const reduceMotion = useReducedMotion();
  const opener = useFileOpener();
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  React.useEffect(() => setState("loading"), [file?.id]);

  const close = () => {
    opener.cancel();
    onClose();
  };
  const progress = opener.state?.phase === "downloading" ? downloadPercent(opener.state.received, opener.state.total) : null;
  const subtitle = opener.state?.phase === "downloading"
    ? `Preparing to share${progress === null ? "…" : ` · ${progress}%`}`
    : opener.state?.phase === "error"
      ? opener.state.message ?? "Download failed. Please retry."
      : file ? `${fileTypeLabel(file)} · ${formatBytes(file.size)}` : "";

  return (
    <Modal visible={Boolean(file)} animationType={reduceMotion ? "none" : "fade"} onRequestClose={close} statusBarTranslucent supportedOrientations={["portrait"]}>
      {file ? (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
          <View style={[styles.header, { paddingTop: insets.top, borderBottomColor: colors.border }]}>
            <Button variant="ghost" size="icon-lg" icon={X} accessibilityLabel="Close preview" onPress={close} />
            <View style={styles.title}>
              <Text variant="body" weight="semibold" numberOfLines={1}>{file.name}</Text>
              <Text variant="meta" tone={opener.state?.phase === "error" ? "danger" : "tertiary"} numberOfLines={1}>{subtitle}</Text>
            </View>
            <Button
              variant="ghost"
              size="icon-lg"
              icon={Share}
              loading={opener.busy}
              accessibilityLabel={`Share ${file.name}`}
              onPress={() => void opener.start(file)}
            />
          </View>
          <View style={styles.stage} onLayout={(event: LayoutChangeEvent) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
            {headers && size.width > 0 ? (
              <ScrollView
                style={StyleSheet.absoluteFill}
                contentContainerStyle={styles.zoomContent}
                maximumZoomScale={4}
                minimumZoomScale={1}
                bouncesZoom
                centerContent
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
                accessibilityLabel={`${file.name}, pinch to zoom`}
              >
                <Image
                  source={{ uri: file.previewUrl, headers }}
                  cachePolicy="memory"
                  contentFit="contain"
                  transition={reduceMotion ? 0 : 160}
                  style={{ width: size.width, height: size.height - insets.bottom }}
                  onLoad={() => setState("ready")}
                  onError={() => setState("error")}
                  accessibilityIgnoresInvertColors
                  accessibilityLabel={file.name}
                />
              </ScrollView>
            ) : null}
            {state === "loading" ? <View pointerEvents="none" style={styles.overlay}><Spinner size="large" /></View> : null}
            {state === "error" ? (
              <View style={styles.overlay}>
                <Text variant="body" weight="medium" style={styles.center}>This image couldn't be shown</Text>
                <Text variant="secondary" tone="tertiary" style={styles.center}>Open the file in another app instead.</Text>
                <Button variant="outline" size="sm" label="Open in…" loading={opener.busy} onPress={() => void opener.start(file)} style={styles.retry} />
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, minWidth: 0, gap: 1, paddingHorizontal: 4 },
  stage: { flex: 1 },
  zoomContent: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 32 },
  center: { textAlign: "center" },
  retry: { marginTop: 8 },
});
