import * as React from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { kv } from "../../storage/kv";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { Plus, Wand2 } from "../../ui/icons";
import { Spinner, StatusPill, Switch } from "../../ui/primitives";
import { Screen } from "../../ui/screen";
import { Text } from "../../ui/text";
import { TopBar } from "../shell/top-bar";
import { actionErrorMessage } from "../page-kit/errors";
import { CapabilityUnavailable, PageHeader, SearchField, useCapabilityAvailable, useScrollTitle } from "../page-kit/page-kit";
import { SkillDetails } from "./skill-details";
import { SkillImport } from "./skill-import";
import {
  PENDING_PROMPT_KEY,
  filterSkillRows,
  skillControlHint,
  skillDisplayName,
  skillPolicyLabel,
  skillProviderLabel,
  tryInTaskPrompt,
  type SkillCatalogRow,
} from "./skill-model";
import { useRefreshSkills, useSkillActions, useSkillCatalog } from "./skills-data";

/** The web's Skills page (settings → skills): personal, organization, and deployment skills. */
export function SkillsScreen() {
  const available = useCapabilityAvailable("skills");
  return (
    <Screen edges={["top"]}>
      {available ? <SkillsBody /> : (
        <>
          <TopBar title="Skills" />
          <CapabilityUnavailable feature="Skills" />
        </>
      )}
    </Screen>
  );
}

function SkillsBody() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useScrollTitle();
  const catalog = useSkillCatalog();
  const actions = useSkillActions(catalog.tenantId);
  const refreshSkills = useRefreshSkills();
  const [query, setQuery] = React.useState("");
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timeout);
  }, [message]);

  const rows = React.useMemo(() => filterSkillRows(catalog.rows, query), [catalog.rows, query]);
  // Details follow the live row, so a toggle in either place shows in both.
  const selected = selectedKey ? catalog.rows.find((row) => row.key === selectedKey) ?? null : null;
  const canToggleOrganization = Boolean(catalog.tenantId);
  const mutateAsync = actions.mutateAsync;

  const toggle = React.useCallback(async (skill: SkillCatalogRow, enabled: boolean) => {
    setPendingKeys((current) => new Set(current).add(skill.key));
    try {
      await mutateAsync({ kind: "toggle", skill, enabled });
    } finally {
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(skill.key);
        return next;
      });
    }
  }, [mutateAsync]);

  const toggleFromRow = React.useCallback((skill: SkillCatalogRow, enabled: boolean) => {
    void toggle(skill, enabled).catch((cause: unknown) => Alert.alert("Could not update this skill", actionErrorMessage(cause, "Try again.")));
  }, [toggle]);

  const uninstall = React.useCallback(async (skill: SkillCatalogRow) => {
    if (!skill.personal) return;
    await mutateAsync({ kind: "uninstall", skill: skill.personal });
    setSelectedKey(null);
    setMessage(`${skill.name} uninstalled`);
  }, [mutateAsync]);

  const tryInTask = React.useCallback((skill: SkillCatalogRow) => {
    kv.setItem(PENDING_PROMPT_KEY, tryInTaskPrompt(skill));
    setSelectedKey(null);
    router.navigate("/(app)");
  }, []);

  const renderItem = React.useCallback<ListRenderItem<SkillCatalogRow>>(({ item, index }) => (
    <SkillRow
      skill={item}
      first={index === 0}
      pending={pendingKeys.has(item.key)}
      canToggle={Boolean(item.personal) || canToggleOrganization}
      onPress={() => setSelectedKey(item.key)}
      onToggle={(enabled) => toggleFromRow(item, enabled)}
    />
  ), [canToggleOrganization, pendingKeys, toggleFromRow]);

  const refresh = async () => {
    setRefreshing(true);
    try { await catalog.refetch(); } finally { setRefreshing(false); }
  };

  const header = (
    <View style={styles.header}>
      <PageHeader title="Skills" description="Import your own skills or use capabilities provided by your organization." />
      <SearchField value={query} onChangeText={setQuery} placeholder="Search skills" />
      {message ? (
        <View accessibilityLiveRegion="polite" style={[styles.message, { backgroundColor: colors.accentSoft }]}>
          <Text variant="secondary">{message}</Text>
        </View>
      ) : null}
    </View>
  );

  const empty = catalog.loading ? (
    <View style={styles.status}><Spinner size="large" /></View>
  ) : catalog.error ? (
    <View style={styles.status}>
      <Text variant="body" weight="medium">Could not load this page</Text>
      <Text variant="secondary" tone="tertiary" style={styles.center}>{actionErrorMessage(catalog.error, "Could not load this page. Please try again.")}</Text>
      <Button size="sm" label="Try again" onPress={() => void catalog.refetch()} style={styles.statusAction} />
    </View>
  ) : (
    <View style={styles.status}>
      <Wand2 size={24} color={colors.textTertiary} />
      <Text variant="body" weight="medium">{query.trim() ? "No matching skills" : "No skills yet"}</Text>
      <Text variant="secondary" tone="tertiary" style={styles.center}>
        {query.trim() ? "Try a different name or clear the search." : "Import a skill package or paste SKILL.md instructions to teach Berry a new workflow."}
      </Text>
      {!query.trim() ? <Button variant="outline" size="sm" icon={Plus} label="Import skill" onPress={() => setImporting(true)} style={styles.statusAction} /> : null}
    </View>
  );

  return (
    <>
      <TopBar
        title={scroll.titleVisible ? "Skills" : undefined}
        trailing={<Button variant="ghost" size="icon-lg" icon={Plus} accessibilityLabel="Import skill" onPress={() => setImporting(true)} />}
      />
      <FlashList
        data={catalog.error && catalog.rows.length === 0 ? [] : rows}
        renderItem={renderItem}
        keyExtractor={(item) => item.key}
        extraData={pendingKeys}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        onScroll={scroll.onScroll}
        scrollEventThrottle={32}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textTertiary} />}
      />
      <SkillDetails
        skill={selected}
        tenantId={catalog.tenantId}
        canToggle={Boolean(selected?.personal) || canToggleOrganization}
        onClose={() => setSelectedKey(null)}
        onToggle={toggle}
        onTryInTask={tryInTask}
        onUninstall={uninstall}
      />
      <SkillImport
        open={importing}
        onOpenChange={setImporting}
        onImported={() => {
          refreshSkills();
          setMessage("Skill imported and enabled");
        }}
      />
    </>
  );
}

/** A DataTable row on the phone: name and description, provider and policy, and the switch. */
const SkillRow = React.memo(function SkillRow({ skill, first, pending, canToggle, onPress, onToggle }: {
  skill: SkillCatalogRow;
  first: boolean;
  pending: boolean;
  canToggle: boolean;
  onPress: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { colors } = useTheme();
  const hint = skillControlHint(skill);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${skillDisplayName(skill.name)}, ${skillProviderLabel(skill)}, ${hint}`}
      accessibilityHint="Shows the skill's details and files"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderTopColor: colors.border, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: pressed ? colors.hover : "transparent" },
      ]}
    >
      <View style={styles.rowBody}>
        <Text variant="body" weight="medium" numberOfLines={1}>{skillDisplayName(skill.name)}</Text>
        <Text variant="secondary" tone="tertiary" numberOfLines={2}>{skill.description}</Text>
        <View style={styles.rowMeta}>
          <Text variant="meta" tone="secondary">{skillProviderLabel(skill)}</Text>
          <StatusPill tone={skill.locked ? "neutral" : "info"}>{skillPolicyLabel(skill)}</StatusPill>
          {skill.locked ? <Text variant="meta" tone="tertiary" numberOfLines={1} style={styles.shrink}>{hint}</Text> : null}
        </View>
      </View>
      <Switch
        value={skill.enabled}
        disabled={!canToggle || skill.locked || pending}
        onValueChange={onToggle}
        accessibilityLabel={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  header: { gap: 14, paddingBottom: 8 },
  message: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4 },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  shrink: { flexShrink: 1 },
  status: { minHeight: 260, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 24 },
  center: { textAlign: "center" },
  statusAction: { marginTop: 8 },
});
