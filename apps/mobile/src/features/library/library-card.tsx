import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { useReducedMotion } from "react-native-reanimated";
import type { StoredFile } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Ellipsis, FileCode, FileImage, FileText, type Icon } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Text } from "../../ui/text";
import { FileArchive, FileAudio, FileCsv, FileDoc, FilePdf, FileSheet, FileSlides, FileTxt, FileVideo } from "../../ui/icons";
import { fileGlyphKind, fileMetaLine, fileTypeLabel, isImageFile, type FileGlyphKind } from "./library-model";

const GLYPHS: Record<FileGlyphKind, Icon> = {
  image: FileImage,
  pdf: FilePdf,
  doc: FileDoc,
  sheet: FileSheet,
  csv: FileCsv,
  slides: FileSlides,
  archive: FileArchive,
  text: FileTxt,
  code: FileCode,
  audio: FileAudio,
  video: FileVideo,
  file: FileText,
};

/** The FileTypeIcon stand-in: a type glyph with its extension underneath. */
export function FileGlyph({ file, size = 28, label = true }: { file: Pick<StoredFile, "name" | "mediaType">; size?: number; label?: boolean }) {
  const { colors } = useTheme();
  const GlyphIcon = GLYPHS[fileGlyphKind(file)];
  return (
    <View style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <GlyphIcon size={size} color={colors.textSecondary} strokeWidth={1.5} />
      {label ? <Text variant="meta" tone="tertiary" weight="medium" numberOfLines={1}>{fileTypeLabel(file)}</Text> : null}
    </View>
  );
}

/**
 * A lazily loaded, authorized thumbnail. Images stay in memory only: the
 * server marks file content private, so it isn't written to the disk cache.
 */
export function LibraryThumbnail({ file, headers }: { file: StoredFile; headers: Record<string, string> | null }) {
  const reduceMotion = useReducedMotion();
  const [failedId, setFailedId] = React.useState<string | null>(null);
  if (!headers || failedId === file.id) return <FileGlyph file={file} />;
  return (
    <Image
      source={{ uri: file.previewUrl, headers }}
      recyclingKey={file.id}
      cachePolicy="memory"
      contentFit="cover"
      transition={reduceMotion ? 0 : 160}
      style={StyleSheet.absoluteFill}
      onError={() => setFailedId(file.id)}
      accessibilityIgnoresInvertColors
    />
  );
}

export function libraryMenuItems(file: StoredFile): MenuItem[] {
  return isImageFile(file)
    ? [
      { id: "open", title: "View", systemImage: "eye" },
      { id: "share", title: "Share…", systemImage: "square.and.arrow.up" },
      { id: "remove", title: "Remove from Library", systemImage: "trash", destructive: true },
    ]
    : [
      { id: "open", title: "Open…", systemImage: "square.and.arrow.up" },
      { id: "remove", title: "Remove from Library", systemImage: "trash", destructive: true },
    ];
}

/** The web's library card: a 4:3 preview, then name and "TYPE · size · date". */
export const LibraryCard = React.memo(function LibraryCard({ file, headers, onOpen, onMenu }: {
  file: StoredFile;
  headers: Record<string, string> | null;
  onOpen: (file: StoredFile) => void;
  onMenu: (file: StoredFile, action: string) => void;
}) {
  const { colors } = useTheme();
  const image = isImageFile(file);
  const items = libraryMenuItems(file);
  return (
    <View>
      <Menu items={items} onSelect={(id) => onMenu(file, id)} longPress>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${file.name}, ${fileMetaLine(file)}`}
          accessibilityHint={image ? "Opens the image" : "Opens the file in another app"}
          onPress={() => onOpen(file)}
          style={({ pressed }) => [styles.card, { borderColor: pressed ? colors.borderStrong : colors.border, backgroundColor: pressed ? colors.hover : colors.card }]}
        >
          <View style={[styles.preview, { backgroundColor: colors.control }]}>
            {image ? <LibraryThumbnail file={file} headers={headers} /> : <FileGlyph file={file} />}
          </View>
          <View style={styles.meta}>
            <Text variant="body" weight="medium" numberOfLines={1}>{file.name}</Text>
            <Text variant="meta" tone="tertiary" numberOfLines={1} style={styles.numeric}>{fileMetaLine(file)}</Text>
          </View>
        </Pressable>
      </Menu>
      <View style={styles.actions}>
        <Menu items={items} onSelect={(id) => onMenu(file, id)}>
          <View accessible accessibilityRole="button" accessibilityLabel={`More actions for ${file.name}`} style={styles.actionTarget}>
            <View style={[styles.actionButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ellipsis size={15} color={colors.textSecondary} />
            </View>
          </View>
        </Menu>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  glyph: { alignItems: "center", justifyContent: "center", gap: 6 },
  card: { padding: 8, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth * 2 },
  preview: { aspectRatio: 4 / 3, borderRadius: 8, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  meta: { gap: 3, paddingTop: 10, paddingHorizontal: 4, paddingBottom: 3 },
  numeric: { fontVariant: ["tabular-nums"] },
  // A 40pt target around the 30pt chip, centered where the web places its corner button.
  actions: { position: "absolute", top: 7, right: 7 },
  actionTarget: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  actionButton: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
});
