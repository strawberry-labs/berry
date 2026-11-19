import * as React from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Progress } from "../../ui/primitives";
import { Sheet } from "../../ui/sheet";
import { Text } from "../../ui/text";
import { FileGlyph } from "./library-card";
import { downloadPercent, fileTypeLabel, formatBytes } from "./library-model";
import type { FileOpenState } from "./use-file-opener";

/**
 * The preview modal's header and FileDownloadStatus, for files the phone
 * opens in another app: progress while downloading, then retry on failure.
 */
export function FileOpenSheet({ state, onCancel, onRetry }: {
  state: FileOpenState | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { colors, layout } = useTheme();
  // Keep the last file on screen while the sheet animates closed.
  const [shown, setShown] = React.useState(state);
  React.useEffect(() => { if (state) setShown(state); }, [state]);
  const file = shown?.file;
  const percent = shown ? downloadPercent(shown.received, shown.total) : null;
  const downloading = shown?.phase === "downloading";
  return (
    <Sheet open={state !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      {file && shown ? (
        <View style={styles.body}>
          <View style={styles.header}>
            <View style={[styles.icon, { backgroundColor: colors.control, borderRadius: layout.radius }]}>
              <FileGlyph file={file} size={20} label={false} />
            </View>
            <View style={styles.title}>
              <Text variant="body" weight="medium" numberOfLines={1}>{file.name}</Text>
              <Text variant="secondary" tone="tertiary" numberOfLines={1}>{fileTypeLabel(file)} · {formatBytes(file.size)}</Text>
            </View>
          </View>
          <View style={styles.status} accessibilityLiveRegion="polite">
            <Text variant="secondary" tone={downloading ? "secondary" : "danger"} accessibilityRole={downloading ? undefined : "alert"}>
              {downloading
                ? shown.received > 0
                  ? `${formatBytes(shown.received)}${shown.total ? ` of ${formatBytes(shown.total)} · ${percent ?? 0}%` : ""}`
                  : "Preparing download…"
                : shown.message ?? "Download failed. Please retry."}
            </Text>
            {downloading && percent !== null ? <Progress value={percent} accessibilityLabel="File download progress" /> : null}
          </View>
          <View style={styles.actions}>
            <Button variant="outline" label={downloading ? "Cancel" : "Close"} onPress={onCancel} />
            {!downloading ? <Button label="Retry" onPress={onRetry} /> : null}
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, minWidth: 0, gap: 2 },
  status: { gap: 8 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
