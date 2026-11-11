import * as React from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { MemoryItem } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { FileDown, Pencil, Plus, Trash2 } from "../../ui/icons";
import { EmptyState, Input, StatusPill, Switch } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Sheet } from "../../ui/sheet";
import { Text } from "../../ui/text";
import { useClearMemories, useForgetMemory, useMemories, useMemorySettings, useSaveMemory, useUpdateMemorySettings } from "./settings-data";
import { filterMemories, formatDate, groupActiveMemories, humanize, memoryKindOptions, parseMemoryExpiry } from "./settings-model";
import { datedFileName, shareTextFile } from "./share-file";
import { AsyncContent, Field, FilterInput, InlineMessage, ListRow, SectionBody, SelectField } from "./settings-ui";

type Editor = { memory: MemoryItem | null };

/** The web's Memory tab: recall switches, saved entries by category, add/edit/forget. */
export function MemorySection() {
  const { client } = useSignedInSession();
  const settings = useMemorySettings();
  const updateSettings = useUpdateMemorySettings();
  const memories = useMemories();
  const forget = useForgetMemory();
  const clear = useClearMemories();
  const [query, setQuery] = React.useState("");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const items = React.useMemo(() => memories.data?.pages.flatMap((page) => page.items) ?? [], [memories.data]);
  const groups = React.useMemo(() => groupActiveMemories(filterMemories(items, query)), [items, query]);
  const memoryEnabled = settings.data?.memoryEnabled ?? true;
  const implicitEnabled = settings.data?.implicitMemoryEnabled ?? true;

  const toggle = (patch: { memoryEnabled?: boolean; implicitMemoryEnabled?: boolean }) => {
    setError(null);
    updateSettings.mutate(patch, { onError: (cause) => setError(apiErrorMessage(cause, "Unable to update memory settings.")) });
  };

  const confirmForget = (memory: MemoryItem) => {
    Alert.alert("Forget this memory?", memory.content.length > 160 ? `${memory.content.slice(0, 160)}…` : memory.content, [
      { text: "Keep", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => forget.mutate(memory, { onError: (cause) => setError(apiErrorMessage(cause, "Unable to forget this memory.")) }) },
    ]);
  };

  const confirmClear = () => {
    Alert.alert("Forget all personal memory?", "This removes every active personal entry from recall while preserving the audit and version history.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget all", style: "destructive", onPress: () => clear.mutate(undefined, { onError: (cause) => setError(apiErrorMessage(cause, "Unable to clear personal memory.")) }) },
    ]);
  };

  const exportMemory = async () => {
    setExporting(true);
    setError(null);
    try {
      const value = await client.exportMemories();
      await shareTextFile(datedFileName("berry-memory", "json"), JSON.stringify(value, null, 2), "application/json");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Unable to export memory."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <View style={styles.toolbar}>
        <Button variant="secondary" size="sm" icon={FileDown} label="Export" loading={exporting} onPress={() => void exportMemory()} />
        <Button size="sm" icon={Plus} label="Add memory" disabled={!memoryEnabled} onPress={() => setEditor({ memory: null })} />
      </View>

      {error ? <InlineMessage tone="danger" onDismiss={() => setError(null)}>{error}</InlineMessage> : null}

      <Section>
        <AsyncContent loading={settings.isPending} error={settings.isError ? apiErrorMessage(settings.error, "Could not load memory settings.") : null} onRetry={() => void settings.refetch()} rows={2}>
          <ToggleRow label="Use personal memory" value={memoryEnabled} disabled={updateSettings.isPending} onChange={(value) => toggle({ memoryEnabled: value })} />
          <ToggleRow label="Learn from completed tasks" value={implicitEnabled} disabled={!memoryEnabled || updateSettings.isPending} onChange={(value) => toggle({ implicitMemoryEnabled: value })} last />
          {!memoryEnabled ? (
            <SectionBody style={{ paddingTop: 0 }}>
              <InlineMessage tone="info">Recall and implicit extraction are off. Existing entries remain available to edit, export, or forget.</InlineMessage>
            </SectionBody>
          ) : null}
        </AsyncContent>
      </Section>

      <View style={styles.saved}>
        <View style={styles.savedHeader}>
          <Text variant="sectionHeading">Saved memory</Text>
          <Text variant="secondary" tone="tertiary">Explicit entries are yours. Inferred entries were consolidated from completed tasks.</Text>
        </View>
        <FilterInput value={query} onChangeText={setQuery} placeholder="Search memory" />
        <AsyncContent loading={memories.isPending} error={memories.isError ? apiErrorMessage(memories.error, "Could not load your memories.") : null} onRetry={() => void memories.refetch()}>
          {groups.length === 0 ? (
            <Section>
              <EmptyState
                title={query ? "No matching memories" : "Nothing saved yet"}
                message={query ? "Try a different search." : "Add a preference or let Berry learn after completed tasks."}
              />
            </Section>
          ) : groups.map((group) => (
            <Section key={group.kind} title={`${humanize(group.kind)} · ${group.items.length}`}>
              {group.items.map((memory, index) => (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  last={index === group.items.length - 1}
                  onEdit={() => setEditor({ memory })}
                  onForget={() => confirmForget(memory)}
                />
              ))}
            </Section>
          ))}
          {memories.hasNextPage && !query ? (
            <Button variant="outline" label={memories.isFetchingNextPage ? "Loading…" : "Load more"} disabled={memories.isFetchingNextPage} onPress={() => void memories.fetchNextPage()} />
          ) : null}
        </AsyncContent>
        <Button
          variant="ghost"
          icon={Trash2}
          label="Clear all personal memory"
          disabled={items.length === 0 || clear.isPending}
          onPress={confirmClear}
          style={{ alignSelf: "flex-start" }}
        />
      </View>

      <MemoryEditorSheet editor={editor} onClose={() => setEditor(null)} />
    </>
  );
}

function ToggleRow({ label, value, onChange, disabled, last = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled: boolean; last?: boolean }) {
  return (
    <ListRow last={last} style={styles.toggleRow}>
      <Text variant="body" weight="medium" style={{ flex: 1 }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={label} />
    </ListRow>
  );
}

function MemoryRow({ memory, last, onEdit, onForget }: { memory: MemoryItem; last: boolean; onEdit: () => void; onForget: () => void }) {
  const { colors } = useTheme();
  const sourceTaskId = memory.sourceTaskId;
  return (
    <ListRow last={last} onPress={onEdit} accessibilityLabel={`Edit memory: ${memory.content}`} style={styles.memoryRow}>
      <View style={styles.memoryBody}>
        <Text variant="body" numberOfLines={4}>{memory.content}</Text>
        <View style={styles.meta}>
          <StatusPill tone={memory.explicit ? "info" : "neutral"}>{memory.explicit ? "Explicit" : "Inferred"}</StatusPill>
          <Text variant="meta" tone="tertiary">{Math.round(memory.confidence * 100)}% confidence</Text>
          <Text variant="meta" tone="tertiary">Last used {formatDate(memory.lastUsedAt)}</Text>
          {memory.expiresAt ? <Text variant="meta" tone="tertiary">Expires {formatDate(memory.expiresAt)}</Text> : null}
          {sourceTaskId ? (
            <Pressable accessibilityRole="link" hitSlop={8} onPress={() => router.navigate({ pathname: "/(app)/tasks/[taskId]", params: { taskId: sourceTaskId } })}>
              <Text variant="meta" tone="accent">Source task</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.memoryActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Edit memory" onPress={onEdit} hitSlop={6} style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.hover }]}>
          <Pencil size={16} color={colors.textTertiary} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Forget memory" onPress={onForget} hitSlop={6} style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.hover }]}>
          <Trash2 size={16} color={colors.textTertiary} />
        </Pressable>
      </View>
    </ListRow>
  );
}

function MemoryEditorSheet({ editor, onClose }: { editor: Editor | null; onClose: () => void }) {
  const save = useSaveMemory();
  const [kind, setKind] = React.useState("preference");
  const [content, setContent] = React.useState("");
  const [expires, setExpires] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const memory = editor?.memory ?? null;

  React.useEffect(() => {
    if (!editor) return;
    setKind(editor.memory?.kind ?? "preference");
    setContent(editor.memory?.content ?? "");
    setExpires(editor.memory?.expiresAt ? editor.memory.expiresAt.slice(0, 10) : "");
    setError(null);
  }, [editor]);

  const submit = () => {
    const trimmed = content.trim();
    if (!trimmed || save.isPending) return;
    const expiry = parseMemoryExpiry(expires);
    if (!expiry.ok) {
      setError("Enter the expiry date as YYYY-MM-DD, or leave it empty.");
      return;
    }
    setError(null);
    save.mutate(
      { id: memory?.id ?? null, kind: kind.trim() || memory?.kind || "preference", content: trimmed, expiresAt: expiry.expiresAt },
      { onSuccess: onClose, onError: (cause) => setError(apiErrorMessage(cause, "Unable to save this memory.")) },
    );
  };

  return (
    <Sheet
      open={editor !== null}
      onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}
      title={memory ? "Edit memory" : "Add a memory"}
      description="Save only durable context you want Berry to reuse."
    >
      <Field label="Category">
        <SelectField label="Category" value={kind} options={memoryKindOptions(kind)} onChange={setKind} />
      </Field>
      <Field label="Memory">
        <Input value={content} onChangeText={setContent} maxLength={20_000} multiline textAlignVertical="top" style={styles.memoryInput} accessibilityLabel="Memory" placeholder="e.g. Prefers concise answers with sources" autoFocus={!memory} />
      </Field>
      <Field label="Expires" hint="Optional. The memory stops being recalled after this day.">
        <Input value={expires} onChangeText={setExpires} placeholder="YYYY-MM-DD" accessibilityLabel="Expiry date" keyboardType="numbers-and-punctuation" autoCorrect={false} maxLength={10} />
      </Field>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      <View style={styles.sheetActions}>
        <Button variant="outline" label="Cancel" disabled={save.isPending} onPress={onClose} />
        <Button label={save.isPending ? "Saving…" : "Save memory"} disabled={!content.trim() || save.isPending} onPress={submit} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginBottom: -8 },
  saved: { gap: 12 },
  savedHeader: { gap: 2, paddingHorizontal: 4 },
  toggleRow: { minHeight: 52 },
  memoryRow: { alignItems: "flex-start" },
  memoryBody: { flex: 1, minWidth: 0, gap: 6 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 4 },
  memoryActions: { flexDirection: "row", gap: 2, marginRight: -8 },
  iconButton: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  memoryInput: { minHeight: 96, paddingTop: 12, paddingBottom: 12 },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
