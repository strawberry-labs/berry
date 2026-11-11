import * as React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Input, Progress, Spinner } from "../../ui/primitives";
import { Text } from "../../ui/text";
import type { PickedFile } from "../composer/attachments";
import { actionErrorMessage } from "../page-kit/errors";
import { Upload } from "../../ui/icons";
import { InlineAlert, SegmentedControl, TextArea } from "../page-kit/page-kit";
import { validateSkillImportFile } from "./skill-model";
import { readLocalText, uploadSkillPackage } from "./skills-data";

type Source = "upload" | "text" | "git";
type Phase = "idle" | "uploading" | "installing";

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: "upload", label: "Package" },
  { value: "text", label: "Paste" },
  { value: "git", label: "GitHub URL" },
];

/**
 * The web's "Import a skill" dialog: a .skill/.zip package or SKILL.md from
 * Files, pasted instructions, or a GitHub URL. Imported skills are enabled.
 */
export function SkillImport({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  const { client } = useSignedInSession();
  const { colors, layout } = useTheme();
  const [source, setSource] = React.useState<Source>("upload");
  const [file, setFile] = React.useState<PickedFile | null>(null);
  const [content, setContent] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [progress, setProgress] = React.useState(0);
  const locked = React.useRef(false);
  const abort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abort.current?.abort(), []);
  const busy = phase !== "idle";

  const reset = () => {
    setFile(null);
    setContent("");
    setUrl("");
    setError("");
    setSource("upload");
  };
  const close = () => {
    if (locked.current) return;
    onOpenChange(false);
  };

  const choose = async () => {
    if (locked.current) return;
    setError("");
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true, type: "*/*" }).catch(() => null);
    const asset = result && !result.canceled ? result.assets[0] : undefined;
    if (!asset) return;
    const picked: PickedFile = { uri: asset.uri, name: asset.name, mediaType: asset.mimeType ?? "application/octet-stream", size: asset.size ?? null };
    const problem = validateSkillImportFile(picked.name, picked.size);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(picked);
  };

  const submit = async () => {
    if (locked.current || (source === "upload" && !file)) return;
    locked.current = true;
    setError("");
    setProgress(0);
    setPhase("installing");
    const controller = new AbortController();
    abort.current = controller;
    let uploadedId: string | undefined;
    try {
      if (source === "upload" && file && !/\.md$/i.test(file.name)) {
        setPhase("uploading");
        const uploaded = await uploadSkillPackage(client, file, { signal: controller.signal, onProgress: (ratio) => setProgress(Math.round(ratio * 100)) });
        uploadedId = uploaded.id;
        if (controller.signal.aborted) return;
        setPhase("installing");
        await client.installPersonalSkillArchive(uploaded.id, controller.signal);
      } else {
        const text = source === "upload" && file ? await readLocalText(file.uri) : content;
        if (controller.signal.aborted) return;
        await client.savePersonalSkill({ content: text, source, sourceUrl: source === "git" ? url.trim() : null, enabled: true });
      }
      if (controller.signal.aborted) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onImported();
      locked.current = false;
      onOpenChange(false);
      reset();
    } catch (cause) {
      if (!controller.signal.aborted) setError(actionErrorMessage(cause, "Could not import this skill. Please try again."));
    } finally {
      // The uploaded archive was only a carrier for the install.
      if (uploadedId) void client.deleteFile(uploadedId).catch(() => undefined);
      locked.current = false;
      abort.current = null;
      setPhase("idle");
    }
  };

  const canSubmit = !busy && (source === "upload" ? Boolean(file) : source === "text" ? Boolean(content.trim()) : /^https?:\/\/\S+$/i.test(url.trim()));

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={[styles.root, { backgroundColor: colors.panel }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Button variant="ghost" size="sm" label="Cancel" disabled={busy} onPress={close} />
          <Text variant="body" weight="semibold" accessibilityRole="header" numberOfLines={1} style={styles.headerTitle}>Import a skill</Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
          <Text variant="secondary" tone="tertiary">Add a package, paste instructions, or import from GitHub.</Text>
          <SegmentedControl accessibilityLabel="Import source" items={SOURCES} value={source} disabled={busy} onChange={(value) => { setSource(value); setError(""); }} />
          {source === "upload" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={file ? `${file.name}. Choose a different package` : "Choose a skill package"}
              disabled={busy}
              onPress={() => void choose()}
              style={({ pressed }) => [styles.dropzone, { borderColor: colors.borderStrong, borderRadius: layout.panelRadius, backgroundColor: pressed ? colors.hover : colors.surfaceInset }]}
            >
              <Upload size={22} color={colors.textSecondary} />
              <Text variant="body" weight="medium" numberOfLines={2} style={styles.center}>{file?.name || "Choose a skill package"}</Text>
              <Text variant="secondary" tone="tertiary" style={styles.center}>
                {file
                  ? `${file.size === null ? "Size unknown" : `${(file.size / 1024 / 1024).toFixed(1)} MB`} · Tap to replace`
                  : ".skill or .zip up to 500 MB · SKILL.md up to 256 KB"}
              </Text>
            </Pressable>
          ) : source === "text" ? (
            <TextArea
              value={content}
              onChangeText={setContent}
              editable={!busy}
              placeholder="Paste SKILL.md including its name and description…"
              accessibilityLabel="SKILL.md instructions"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.paste}
            />
          ) : (
            <Input
              value={url}
              onChangeText={setUrl}
              editable={!busy}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://github.com/org/repo/blob/main/skill/SKILL.md"
              accessibilityLabel="GitHub SKILL.md URL"
            />
          )}
          {busy ? (
            <View style={styles.status} accessibilityRole="progressbar" accessibilityLiveRegion="polite">
              {phase === "uploading" ? (
                <>
                  <Text variant="secondary" tone="secondary">Uploading… {progress}%</Text>
                  <Progress value={progress} accessibilityLabel="Uploading skill" />
                </>
              ) : (
                <View style={styles.installing}>
                  <Spinner />
                  <Text variant="secondary" tone="secondary">Verifying and installing…</Text>
                </View>
              )}
            </View>
          ) : null}
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <Button label={busy ? "Importing…" : "Import and enable"} disabled={!canSubmit} loading={busy} onPress={() => void submit()} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 56, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1, textAlign: "center" },
  headerSpacer: { width: 72 },
  content: { padding: 16, paddingBottom: 48, gap: 16 },
  dropzone: { minHeight: 140, alignItems: "center", justifyContent: "center", gap: 6, padding: 20, borderWidth: StyleSheet.hairlineWidth * 2, borderStyle: "dashed" },
  center: { textAlign: "center" },
  paste: { minHeight: 200 },
  status: { gap: 8 },
  installing: { flexDirection: "row", alignItems: "center", gap: 10 },
});
