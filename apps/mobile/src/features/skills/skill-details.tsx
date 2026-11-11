import * as React from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { ChevronDown, ChevronLeft, CodeXml, Ellipsis, X } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Spinner, Switch } from "../../ui/primitives";
import { Text } from "../../ui/text";
import { actionErrorMessage } from "../page-kit/errors";
import { Eye } from "../../ui/icons";
import { InlineAlert } from "../page-kit/page-kit";
import { SkillFileIcon, SkillMarkdown, SkillResourceSummary, SkillSource } from "./skill-content";
import {
  decodeSkillTextFile,
  isPreviewableSkillFile,
  loadSkillPackageForDownload,
  skillAboutLabel,
  skillControlHint,
  skillMarkdownBody,
  skillPackagePaths,
  skillPackageTreeEntries,
  skillProviderPhrase,
  type SkillCatalogRow,
} from "./skill-model";
import { shareSkillPackage } from "./skills-data";

type LoadedFile = { path: string; contentBase64: string; mode?: number | undefined };
type ViewMode = "rendered" | "source";

/**
 * The web's skill details dialog as a page sheet: enable switch, actions
 * (try in a task, download .skill, uninstall), description, and the package
 * browser with rendered and source views of each file.
 */
export function SkillDetails({ skill, tenantId, canToggle, onClose, onToggle, onTryInTask, onUninstall }: {
  skill: SkillCatalogRow | null;
  tenantId: string | null;
  canToggle: boolean;
  onClose: () => void;
  onToggle: (skill: SkillCatalogRow, enabled: boolean) => Promise<void>;
  onTryInTask: (skill: SkillCatalogRow) => void;
  onUninstall: (skill: SkillCatalogRow) => Promise<void>;
}) {
  const { colors } = useTheme();
  // Keep the last skill rendered while the sheet slides away.
  const [shown, setShown] = React.useState(skill);
  React.useEffect(() => { if (skill) setShown(skill); }, [skill]);
  return (
    <Modal visible={skill !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        {shown ? (
          <SkillDetailsBody
            key={shown.key}
            skill={shown}
            tenantId={tenantId}
            canToggle={canToggle}
            onClose={onClose}
            onToggle={onToggle}
            onTryInTask={onTryInTask}
            onUninstall={onUninstall}
          />
        ) : null}
      </View>
    </Modal>
  );
}

function SkillDetailsBody({ skill, tenantId, canToggle, onClose, onToggle, onTryInTask, onUninstall }: {
  skill: SkillCatalogRow;
  tenantId: string | null;
  canToggle: boolean;
  onClose: () => void;
  onToggle: (skill: SkillCatalogRow, enabled: boolean) => Promise<void>;
  onTryInTask: (skill: SkillCatalogRow) => void;
  onUninstall: (skill: SkillCatalogRow) => Promise<void>;
}) {
  const { client } = useSignedInSession();
  const { colors, layout } = useTheme();
  const [view, setView] = React.useState<ViewMode>("rendered");
  const [selectedPath, setSelectedPath] = React.useState("SKILL.md");
  const [loadedFiles, setLoadedFiles] = React.useState<LoadedFile[]>([]);
  const [packageLoading, setPackageLoading] = React.useState(false);
  const [packageError, setPackageError] = React.useState("");
  const [descriptionExpanded, setDescriptionExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<"toggle" | "download" | "uninstall" | null>(null);
  const [actionError, setActionError] = React.useState("");

  const packagePaths = React.useMemo(() => skillPackagePaths(skill.packageFiles, loadedFiles), [loadedFiles, skill.packageFiles]);
  const treeEntries = React.useMemo(() => skillPackageTreeEntries(packagePaths), [packagePaths]);
  const selectedResource = loadedFiles.find((file) => file.path === selectedPath) ?? null;
  const selectedContent = selectedPath === "SKILL.md" ? skill.content : selectedResource ? decodeSkillTextFile(selectedResource) : null;
  const selectedIsMarkdown = /\.md$/i.test(selectedPath) && selectedContent !== null;
  const controlHint = skillControlHint(skill);

  React.useEffect(() => {
    if (!packagePaths.includes(selectedPath)) setSelectedPath("SKILL.md");
  }, [packagePaths, selectedPath]);

  React.useEffect(() => {
    setView(/\.md$/i.test(selectedPath) ? "rendered" : "source");
  }, [selectedPath]);

  // Personal packages load whole (once); organization packages load one file at a time.
  const personalPackageLoaded = React.useRef(false);
  React.useEffect(() => {
    if (personalPackageLoaded.current || !skill.content || skill.provenance !== "personal" || selectedPath === "SKILL.md" || !isPreviewableSkillFile(selectedPath) || loadedFiles.some((file) => file.path === selectedPath)) return;
    let cancelled = false;
    setPackageLoading(true);
    setPackageError("");
    void loadSkillPackageForDownload(client, tenantId, skill)
      .then((loaded) => {
        if (cancelled) return;
        personalPackageLoaded.current = true;
        setLoadedFiles(loaded.resourceFiles);
      })
      .catch((cause: unknown) => { if (!cancelled) setPackageError(actionErrorMessage(cause, "Could not load package files")); })
      .finally(() => { if (!cancelled) setPackageLoading(false); });
    return () => { cancelled = true; };
  }, [client, loadedFiles, selectedPath, skill, tenantId]);

  React.useEffect(() => {
    if (!tenantId || skill.provenance !== "organization" || skill.packageStorage !== "stored" || selectedPath === "SKILL.md" || !isPreviewableSkillFile(selectedPath) || loadedFiles.some((file) => file.path === selectedPath)) return;
    let cancelled = false;
    setPackageLoading(true);
    setPackageError("");
    void client.organizationSkillPackageFile(tenantId, skill.capabilityId, selectedPath)
      .then((file) => { if (!cancelled) setLoadedFiles((current) => current.some((candidate) => candidate.path === file.path) ? current : [...current, file]); })
      .catch((cause: unknown) => { if (!cancelled) setPackageError(actionErrorMessage(cause, "Could not load this package file")); })
      .finally(() => { if (!cancelled) setPackageLoading(false); });
    return () => { cancelled = true; };
  }, [client, loadedFiles, selectedPath, skill.capabilityId, skill.packageStorage, skill.provenance, tenantId]);

  const changeEnabled = async (enabled: boolean) => {
    setActionError("");
    setBusy("toggle");
    try { await onToggle(skill, enabled); }
    catch (cause) { setActionError(actionErrorMessage(cause, "Could not update this skill")); }
    finally { setBusy(null); }
  };

  const download = async () => {
    setActionError("");
    setBusy("download");
    try { await shareSkillPackage(client, tenantId, skill); }
    catch (cause) { setActionError(actionErrorMessage(cause, "Could not download this skill")); }
    finally { setBusy(null); }
  };

  const uninstall = () => {
    Alert.alert(`Uninstall ${skill.name}?`, "The skill is removed from your account and stops loading in new tasks.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Uninstall",
        style: "destructive",
        onPress: () => {
          setActionError("");
          setBusy("uninstall");
          void onUninstall(skill).catch((cause: unknown) => {
            setActionError(actionErrorMessage(cause, "Could not uninstall this skill"));
            setBusy(null);
          });
        },
      },
    ]);
  };

  const menu: MenuItem[] = [
    { id: "try", title: "Try in a task", systemImage: "bubble.left" },
    { id: "download", title: busy === "download" ? "Downloading…" : "Download .skill", systemImage: "arrow.down.circle", disabled: !skill.content || busy !== null },
    ...(skill.personal ? [{ id: "uninstall", title: busy === "uninstall" ? "Uninstalling…" : "Uninstall", systemImage: "trash", destructive: true, disabled: busy !== null }] : []),
  ];
  const onMenu = (id: string) => {
    if (id === "try") onTryInTask(skill);
    else if (id === "download") void download();
    else if (id === "uninstall") uninstall();
  };

  const fileMenu: MenuItem[] = treeEntries
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({ id: entry.path, title: entry.path, checked: entry.path === selectedPath }));

  return (
    <>
      <View style={styles.header}>
        <Button variant="ghost" size="sm" icon={ChevronLeft} label="Skills" onPress={onClose} />
        <Button variant="ghost" size="icon" icon={X} accessibilityLabel="Close skill details" onPress={onClose} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleBlock}>
          <Text variant="pageTitle" accessibilityRole="header">{skill.name}</Text>
          <Text variant="secondary" tone="secondary">by {skillProviderPhrase(skill)} · {skillAboutLabel(skill)}</Text>
        </View>

        <View style={[styles.controls, { borderColor: colors.border, borderRadius: layout.radius }]}>
          <Switch
            value={skill.enabled}
            disabled={!canToggle || skill.locked || busy !== null}
            onValueChange={(enabled) => void changeEnabled(enabled)}
            accessibilityLabel={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
          />
          <Text variant="secondary" tone="secondary" style={styles.flex}>{busy === "toggle" ? "Saving…" : controlHint}</Text>
          <Menu items={menu} onSelect={onMenu} title={skill.name}>
            <View accessible accessibilityRole="button" accessibilityLabel={`More actions for ${skill.name}`} style={styles.iconTarget}>
              {busy === "download" || busy === "uninstall" ? <Spinner /> : <Ellipsis size={18} color={colors.textSecondary} />}
            </View>
          </Menu>
        </View>

        <View style={styles.description}>
          <Text variant="body" numberOfLines={descriptionExpanded ? undefined : 2}>{skill.description}</Text>
          {skill.description.length > 120 ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: descriptionExpanded }} hitSlop={8} onPress={() => setDescriptionExpanded((expanded) => !expanded)}>
              <Text variant="secondary" tone="accent" weight="medium">{descriptionExpanded ? "See less" : "See more"}</Text>
            </Pressable>
          ) : null}
        </View>
        {actionError ? <InlineAlert tone="danger">{actionError}</InlineAlert> : null}

        <View style={[styles.files, { borderColor: colors.border, backgroundColor: colors.surfaceInset }]} accessibilityLabel={`${skill.name} files`}>
          <View style={[styles.toolbar, { backgroundColor: colors.control, borderBottomColor: colors.border }]}>
            <Menu items={fileMenu} onSelect={setSelectedPath} title={`${packagePaths.length} ${packagePaths.length === 1 ? "file" : "files"}`}>
              <View accessible accessibilityRole="button" accessibilityLabel={`File: ${selectedPath}. Choose another file`} style={[styles.filePicker, { backgroundColor: colors.background, borderRadius: 8 }]}>
                <SkillFileIcon path={selectedPath} color={colors.textSecondary} />
                <Text variant="secondary" weight="medium" numberOfLines={1} style={styles.filePickerLabel}>{selectedPath}</Text>
                <ChevronDown size={13} color={colors.textTertiary} />
              </View>
            </Menu>
            <Text variant="meta" tone="tertiary">{packagePaths.length} {packagePaths.length === 1 ? "file" : "files"}</Text>
            {packageLoading ? <Spinner /> : null}
            <View style={styles.flex} />
            {selectedContent !== null ? (
              <View style={[styles.viewToggle, { borderRadius: 8 }]} accessibilityRole="radiogroup" accessibilityLabel="Skill content view">
                <ViewToggleButton icon="rendered" active={view === "rendered"} disabled={!selectedIsMarkdown} onPress={() => setView("rendered")} />
                <ViewToggleButton icon="source" active={view === "source"} onPress={() => setView("source")} />
              </View>
            ) : null}
          </View>
          {selectedPath === "SKILL.md" && !skill.content ? (
            <View style={styles.unavailable}>
              <Text variant="body" weight="medium" style={styles.center}>SKILL.md is not available</Text>
              <Text variant="secondary" tone="secondary" style={styles.center}>This offline deployment entry only publishes skill metadata. Connect to Berry to load the organization definition.</Text>
            </View>
          ) : selectedContent !== null && view === "rendered" && selectedIsMarkdown ? (
            <SkillMarkdown markdown={selectedPath === "SKILL.md" ? skillMarkdownBody(selectedContent) : selectedContent} />
          ) : selectedContent !== null ? (
            <SkillSource content={selectedContent} />
          ) : (
            <SkillResourceSummary
              file={selectedResource}
              managed={skill.packageStorage === "managed"}
              stored={skill.packageStorage === "stored"}
              packageError={packageError}
              path={selectedPath}
            />
          )}
        </View>
      </ScrollView>
    </>
  );
}

function ViewToggleButton({ icon, active, disabled = false, onPress }: { icon: ViewMode; active: boolean; disabled?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const IconComponent = icon === "rendered" ? Eye : CodeXml;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={icon === "rendered" ? "Rendered Markdown" : "Markdown source"}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.toggleButton, { backgroundColor: active ? colors.selected : pressed ? colors.hover : "transparent", opacity: disabled ? 0.4 : 1 }]}
    >
      <IconComponent size={16} color={active ? colors.textPrimary : colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 56, paddingHorizontal: 8 },
  content: { paddingHorizontal: 16, paddingBottom: 48, gap: 14 },
  titleBlock: { gap: 4 },
  controls: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingRight: 2, minHeight: 52, borderWidth: StyleSheet.hairlineWidth },
  iconTarget: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  description: { gap: 6 },
  files: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  filePicker: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, paddingHorizontal: 10, maxWidth: 200 },
  filePickerLabel: { flexShrink: 1 },
  viewToggle: { flexDirection: "row", gap: 2 },
  toggleButton: { width: 32, height: 32, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  unavailable: { alignItems: "center", gap: 6, padding: 32 },
  center: { textAlign: "center" },
});
