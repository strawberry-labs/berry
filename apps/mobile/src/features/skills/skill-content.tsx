import * as React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { useTheme } from "../../theme/theme";
import { File, FileCode, FileImage } from "../../ui/icons";
import { Text } from "../../ui/text";
import { Markdown } from "../markdown/markdown";
import { base64ByteLength, formatSkillBytes, isPreviewableSkillFile, skillImageMediaType } from "./skill-model";

export function SkillFileIcon({ path, color, size = 15 }: { path: string; color: string; size?: number }) {
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) return <FileImage size={size} color={color} />;
  if (/\.(md|txt|json|ya?ml|toml|csv|py|js|jsx|ts|tsx|sh|bash|css|html?|xml|sql)$/i.test(path)) return <FileCode size={size} color={color} />;
  return <File size={size} color={color} />;
}

/** SKILL.md rendered with the same Markdown as assistant messages. */
export function SkillMarkdown({ markdown }: { markdown: string }) {
  return (
    <View style={styles.markdown}>
      <Markdown>{markdown}</Markdown>
    </View>
  );
}

/**
 * Source with line numbers. The numbers and code are two text columns with
 * the same line height, so thousands of lines stay two native views.
 */
export function SkillSource({ content }: { content: string }) {
  const { colors, fontFamily } = useTheme();
  const lines = React.useMemo(() => content.replace(/\r\n?/g, "\n").split("\n"), [content]);
  const numbers = React.useMemo(() => lines.map((_, index) => index + 1).join("\n"), [lines]);
  const mono = { fontFamily: fontFamily.mono, lineHeight: 22 };
  return (
    <View style={styles.source}>
      <Text variant="secondary" tone="tertiary" style={[mono, styles.lineNumbers]} accessibilityElementsHidden importantForAccessibility="no">{numbers}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator style={[styles.flex, { borderLeftColor: colors.border }, styles.sourceScroll]} contentContainerStyle={styles.sourceContent}>
        <Text variant="secondary" style={mono} selectable>{lines.join("\n")}</Text>
      </ScrollView>
    </View>
  );
}

export function SkillResourceSummary({ file, managed, stored, packageError, path }: {
  file: { path: string; contentBase64: string } | null;
  managed: boolean;
  stored: boolean;
  packageError: string;
  path: string;
}) {
  const { colors, layout } = useTheme();
  const imageType = skillImageMediaType(path);
  if (file && imageType) {
    return (
      <View style={styles.summary}>
        <Image
          source={{ uri: `data:${imageType};base64,${file.contentBase64}` }}
          contentFit="contain"
          style={[styles.resourceImage, { borderRadius: layout.radius, borderColor: colors.border }]}
          accessibilityLabel={path.split("/").at(-1) ?? path}
        />
      </View>
    );
  }
  const bytes = file ? base64ByteLength(file.contentBase64) : null;
  return (
    <View style={styles.summary}>
      <SkillFileIcon path={path} color={colors.textSecondary} size={20} />
      <Text variant="body" weight="medium" style={styles.center}>{path}</Text>
      <Text variant="secondary" tone="secondary" style={styles.center}>
        {managed
          ? `This legacy organization skill lists ${path}, but its package has not been migrated into organization storage yet. An administrator should resync or re-upload the complete .skill archive.`
          : file
            ? `Bundled binary resource${bytes === null ? "" : ` · ${formatSkillBytes(bytes)}`}. Berry stores it with the skill package and stages it beside SKILL.md when the skill activates.`
            : stored && !isPreviewableSkillFile(path)
              ? "Bundled binary resource. Berry stores it with this organization skill and stages it beside SKILL.md when the skill activates."
              : packageError || "This file is listed in the package manifest, but its preview bytes are unavailable."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  markdown: { padding: 16 },
  source: { flexDirection: "row", paddingVertical: 12 },
  lineNumbers: { minWidth: 40, paddingHorizontal: 8, textAlign: "right" },
  sourceScroll: { borderLeftWidth: StyleSheet.hairlineWidth },
  sourceContent: { paddingHorizontal: 12 },
  summary: { alignItems: "center", justifyContent: "center", gap: 8, padding: 24, minHeight: 200 },
  center: { textAlign: "center" },
  resourceImage: { width: "100%", aspectRatio: 1, borderWidth: StyleSheet.hairlineWidth },
});
