import * as React from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import Svg, { Circle } from "react-native-svg";
import { BUILT_IN_COMMANDS, parseSlashCommand, type AttachmentInput, type TurnIntent } from "@berry/shared";
import { detectTrigger, filterItems, type MentionItem, type MentionTrigger } from "@berry/client-core/mentions";
import { reasoningLabel } from "@berry/client-core/models";
import { useSignedInSession } from "../../session/session";
import { kv } from "../../storage/kv";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { ArrowUp, AtSign, Brain, ChevronDown, FileText, Hash, ImagePlus, Play, Plus, SlashSquare, Stop, WandSparkles, X } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Text } from "../../ui/text";
import { useModelSelection } from "../data/models";
import { pickDocuments, pickPhotos, uploadPickedFile, type PickedFile } from "./attachments";
import { applyAtomicDeletion, insertMention, segmentText } from "./mention-text";
import { PENDING_PROMPT_KEY } from "./pending-prompt";

export type ComposerDelivery = "send" | "queue" | "steer";

export type ComposerSubmission = {
  /** The prompt as the web sends it ("Create image\n…" in image mode). */
  input: string;
  intent?: TurnIntent | undefined;
  attachments: AttachmentInput[];
  delivery: ComposerDelivery;
};

type PendingUpload = {
  id: string;
  file: PickedFile;
  ratio: number;
  state: "uploading" | "failed";
  error?: string | undefined;
  controller: AbortController;
};

type ReadyAttachment = { key: string; attachment: AttachmentInput; previewUri: string | null };

const DRAFT_PREFIX = "berry.user.draft.";

const MAX_ATTACHMENTS = 100;
const MENTION_TITLES: Record<MentionTrigger, string> = { "@": "Files", "/": "Commands", $: "Skills", "#": "Tasks" };

/**
 * The web composer (BerryComposerFrame + WebComposer) as a native control:
 * the same placeholder, + menu, model and reasoning pills, send/stop/continue
 * button, mention tokens (`@` `/` `$` `#`), attachments and Create image.
 */
export function Composer({
  variant,
  draftKey,
  working,
  canContinue = false,
  taskId,
  sessionId,
  taskTitles = [],
  header,
  before,
  onSubmit,
  onStop,
  onContinue,
  onCommand,
}: {
  variant: "home" | "thread";
  /** Draft persistence key: "home" or the task id. */
  draftKey: string;
  working: boolean;
  canContinue?: boolean;
  taskId?: string | undefined;
  sessionId?: string | undefined;
  taskTitles?: string[];
  header?: React.ReactNode;
  before?: React.ReactNode;
  onSubmit: (submission: ComposerSubmission) => Promise<void>;
  onStop?: (() => void) | undefined;
  onContinue?: (() => Promise<void>) | undefined;
  onCommand?: ((name: string, args: string[]) => Promise<void>) | undefined;
}) {
  const theme = useTheme();
  const { colors, layout } = theme;
  const { client } = useSignedInSession();
  const models = useModelSelection();
  const inputRef = React.useRef<TextInput>(null);
  const [text, setTextState] = React.useState(() => kv.getItem(`${DRAFT_PREFIX}${draftKey}`) ?? "");
  const [tokens, setTokens] = React.useState<string[]>([]);
  const [selection, setSelection] = React.useState({ start: text.length, end: text.length });
  const [dismissedTrigger, setDismissedTrigger] = React.useState<string | null>(null);
  const [createImage, setCreateImage] = React.useState(false);
  const [ready, setReady] = React.useState<ReadyAttachment[]>([]);
  const [uploads, setUploads] = React.useState<PendingUpload[]>([]);
  const [error, setError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [improving, setImproving] = React.useState(false);
  const textRef = React.useRef(text);
  textRef.current = text;

  const setText = React.useCallback((next: string) => {
    textRef.current = next;
    setTextState(next);
  }, []);

  // Drafts survive leaving the screen, like the web's per-task composer state.
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (text) kv.setItem(`${DRAFT_PREFIX}${draftKey}`, text);
      else kv.removeItem(`${DRAFT_PREFIX}${draftKey}`);
    }, 300);
    return () => clearTimeout(timer);
  }, [draftKey, text]);

  React.useEffect(() => () => {
    for (const upload of uploadsRef.current) upload.controller.abort();
  }, []);

  useFocusEffect(React.useCallback(() => {
    if (variant !== "home") return;
    const pending = kv.getItem(PENDING_PROMPT_KEY);
    if (!pending) return;
    kv.removeItem(PENDING_PROMPT_KEY);
    const current = textRef.current.trimEnd();
    const next = current ? `${current} ${pending}` : pending;
    const token = pending.trim();
    if (/^[@/$#]\S+$/.test(token)) setTokens((existing) => existing.includes(token) ? existing : [...existing, token]);
    setText(next);
    setSelection({ start: next.length, end: next.length });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [setText, variant]));
  const uploadsRef = React.useRef(uploads);
  uploadsRef.current = uploads;

  const mentionItems = React.useMemo<Record<MentionTrigger, MentionItem[]>>(() => ({
    "@": [
      { id: "file:workspace", category: "folders", label: "workspace", description: "Cloud sandbox workspace root", value: "workspace" },
      { id: "file:README.md", category: "files", label: "README.md", description: "Attach by path once sandbox files are indexed", value: "README.md" },
    ],
    "/": BUILT_IN_COMMANDS.filter((command) => command.surfaces.includes("web")).map((command) => ({
      id: `cmd:${command.name}`,
      category: "commands",
      label: `/${command.name}`,
      description: command.description,
      value: command.name,
    })),
    $: models.skills.filter((skill) => skill.enabled).map((skill) => ({
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      description: skill.description,
      value: skill.name,
    })),
    "#": taskTitles.map((title) => ({ id: `task:${title}`, category: "sessions", label: title, description: "Recent task", value: title })),
  }), [models.skills, taskTitles]);

  const detected = selection.start === selection.end ? detectTrigger(text.slice(0, selection.start)) : null;
  const detectedKey = detected ? `${detected.trigger}:${detected.query}:${detected.tokenStart}` : null;
  const suggestions = detected && detectedKey !== dismissedTrigger ? filterItems(mentionItems[detected.trigger], detected.query, 6) : [];

  const onChangeText = (next: string) => {
    const atomic = applyAtomicDeletion(textRef.current, next, tokens);
    setText(atomic);
    setError("");
    if (atomic !== next) {
      // The whole token went; put the caret where it was.
      const caret = Math.max(0, selection.start - (next.length - atomic.length) - 1);
      setSelection({ start: caret, end: caret });
    }
  };

  const onSelectionChange = (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setSelection(event.nativeEvent.selection);
  };

  const chooseSuggestion = (item: MentionItem) => {
    if (!detected) return;
    const markdown = `${detected.trigger}${item.value}`;
    const next = insertMention(text, selection.start, detected, markdown);
    setTokens((current) => current.includes(markdown) ? current : [...current, markdown]);
    setText(next.text);
    setSelection({ start: next.cursor, end: next.cursor });
    void Haptics.selectionAsync();
  };

  const insertTrigger = (trigger: MentionTrigger) => {
    const before = text.slice(0, selection.start);
    const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const next = `${before}${spacer}${trigger}${text.slice(selection.end)}`;
    const caret = before.length + spacer.length + 1;
    setText(next);
    setSelection({ start: caret, end: caret });
    inputRef.current?.focus();
  };

  const addFiles = async (source: "camera" | "library" | "files") => {
    setError("");
    let picked: PickedFile[];
    try {
      picked = source === "files" ? await pickDocuments() : await pickPhotos(source);
    } catch (cause) {
      Alert.alert("Can't attach", cause instanceof Error ? cause.message : "Something went wrong.");
      return;
    }
    if (picked.length === 0) return;
    if (ready.length + uploads.length + picked.length > MAX_ATTACHMENTS) {
      setError("Attach no more than 100 files to one message.");
      return;
    }
    const queued = picked.map((file): PendingUpload => ({ id: globalThis.crypto.randomUUID(), file, ratio: 0, state: "uploading", controller: new AbortController() }));
    setUploads((current) => [...current, ...queued]);
    // Two at a time, like the web.
    let index = 0;
    const worker = async () => {
      while (index < queued.length) {
        const pending = queued[index++]!;
        try {
          const attachment = await uploadPickedFile(client, pending.file, {
            taskId,
            sessionId,
            signal: pending.controller.signal,
            onProgress: (ratio) => setUploads((current) => current.map((item) => item.id === pending.id ? { ...item, ratio } : item)),
          });
          if (pending.controller.signal.aborted) continue;
          setReady((current) => [...current, { key: pending.id, attachment, previewUri: pending.file.mediaType.startsWith("image/") ? pending.file.uri : null }]);
          setUploads((current) => current.filter((item) => item.id !== pending.id));
        } catch (cause) {
          if (pending.controller.signal.aborted) {
            setUploads((current) => current.filter((item) => item.id !== pending.id));
            continue;
          }
          const message = cause instanceof Error ? cause.message : "Upload failed";
          setUploads((current) => current.map((item) => item.id === pending.id ? { ...item, state: "failed", error: message } : item));
        }
      }
    };
    await Promise.all([worker(), worker()]);
  };

  const clear = () => {
    setText("");
    setTokens([]);
    setCreateImage(false);
    setReady([]);
    setSelection({ start: 0, end: 0 });
    kv.removeItem(`${DRAFT_PREFIX}${draftKey}`);
  };

  const uploading = uploads.some((upload) => upload.state === "uploading");
  const attachments = ready.map((item) => item.attachment);
  const hasDraft = text.trim().length > 0 || attachments.length > 0 || createImage;

  const submit = async (delivery: ComposerDelivery) => {
    if (submitting || uploading) return;
    const plain = text.trim() || (attachments.length > 0 ? "Review the attached files." : "");
    const input = createImage ? `Create image\n${plain}` : plain;
    if (!plain) {
      if (!working && canContinue && onContinue) await runGuarded(onContinue);
      return;
    }
    const command = delivery === "send" ? parseSlashCommand(input) : null;
    if (command && onCommand) {
      await runGuarded(async () => {
        await onCommand(command.name, command.args);
        clear();
      });
      return;
    }
    await runGuarded(async () => {
      const sent = { input, ...(createImage ? { intent: "image_generation" as const } : {}), attachments, delivery };
      clear();
      try {
        await onSubmit(sent);
      } catch (cause) {
        // Keep the prompt so nothing typed is lost.
        setText(text);
        setTokens(tokens);
        setCreateImage(createImage);
        setReady(ready);
        throw cause;
      }
    });
  };

  const runGuarded = async (action: () => Promise<void>) => {
    setSubmitting(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const improvePrompt = async () => {
    const prompt = text.trim();
    if (!prompt || improving) return;
    setImproving(true);
    setError("");
    try {
      const skills = tokens.filter((token) => token.startsWith("$")).map((token) => token.slice(1));
      const result = await client.improvePrompt({ prompt, skills });
      if (textRef.current !== text) {
        setError("Your draft changed while Berry was improving it. Run Improve prompt again to use the latest text.");
        return;
      }
      setText(result.prompt);
      setSelection({ start: result.prompt.length, end: result.prompt.length });
    } catch {
      setError("Couldn't improve this prompt. Try again.");
    } finally {
      setImproving(false);
    }
  };

  const addMenu: MenuItem[] = [
    { id: "image", title: models.imageGenerationAvailable ? "Create image" : "Create image (unavailable)", systemImage: "wand.and.stars", disabled: !models.imageGenerationAvailable, checked: createImage },
    { id: "camera", title: "Take photo", systemImage: "camera" },
    { id: "library", title: "Photo library", systemImage: "photo.on.rectangle" },
    { id: "files", title: "Choose file", systemImage: "doc" },
    { id: "@", title: "Insert @ mention", systemImage: "at" },
    { id: "#", title: "Insert # task", systemImage: "number" },
    { id: "/", title: "Insert / command", systemImage: "slash.circle" },
  ];
  const onAddMenu = (id: string) => {
    if (id === "image") setCreateImage((value) => !value);
    else if (id === "camera" || id === "library" || id === "files") void addFiles(id);
    else if (id === "@" || id === "#" || id === "/") insertTrigger(id);
  };

  const current = models.models.find((model) => model.id === models.modelId);
  const modelMenu: MenuItem[] = models.models.map((model) => ({ id: model.id, title: model.name, checked: model.id === models.modelId }));
  const reasoningMenu: MenuItem[] = models.reasoningLevels.map((level) => ({ id: level, title: reasoningLabel(level), checked: level === models.reasoning }));

  const primary: "stop" | "continue" | "send" = working && !hasDraft ? "stop" : !hasDraft && canContinue && uploads.length === 0 ? "continue" : "send";
  const sendDisabled = submitting || uploading || (primary === "send" && !hasDraft);
  const placeholder = variant === "home" ? "Ask Berry anything, @ for files or folders, / for commands, # for related tasks" : "Ask for follow-up changes";
  const segments = segmentText(text, tokens);

  return (
    <View style={styles.root}>
      {before}
      {suggestions.length > 0 && detected ? (
        <View style={[styles.suggestions, { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: 18 }]} accessibilityRole="menu">
          <Text variant="meta" tone="tertiary" style={styles.suggestionsTitle}>{MENTION_TITLES[detected.trigger]}</Text>
          {suggestions.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="menuitem"
              onPress={() => chooseSuggestion(item)}
              style={({ pressed }) => [styles.suggestion, { backgroundColor: pressed ? colors.hover : "transparent", borderRadius: layout.radius }]}
            >
              <MentionIcon trigger={detected.trigger} color={mentionColor(theme, detected.trigger)} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="body" numberOfLines={1}>{item.label}</Text>
                {item.description ? <Text variant="secondary" tone="tertiary" numberOfLines={1}>{item.description}</Text> : null}
              </View>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" onPress={() => setDismissedTrigger(detectedKey)} style={styles.suggestionDismiss}>
            <Text variant="meta" tone="tertiary">Dismiss</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.shell, { borderRadius: layout.composerRadius, backgroundColor: header ? colors.composerStrip : "transparent" }]}>
        {header ? <View style={styles.strip}>{header}</View> : null}
        <View
          style={[
            styles.card,
            {
              backgroundColor: colors.control,
              borderColor: colors.borderStrong,
              borderRadius: layout.composerRadius,
              ...(header ? { borderTopLeftRadius: 22, borderTopRightRadius: 22 } : {}),
              minHeight: variant === "home" ? 112 : 104,
            },
          ]}
        >
          {createImage || ready.length > 0 || uploads.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachments} keyboardShouldPersistTaps="handled">
              {createImage ? (
                <Chip label="Create image" icon={<ImagePlus size={14} color={colors.textPrimary} />} onRemove={() => setCreateImage(false)} />
              ) : null}
              {uploads.map((upload) => (
                <Chip
                  key={upload.id}
                  label={upload.file.name}
                  detail={upload.state === "failed" ? upload.error ?? "Upload failed" : `${Math.round(upload.ratio * 100)}%`}
                  danger={upload.state === "failed"}
                  icon={upload.state === "uploading" ? <ProgressRing ratio={upload.ratio} /> : <FileText size={14} color={colors.danger} />}
                  onRemove={() => {
                    upload.controller.abort();
                    setUploads((items) => items.filter((item) => item.id !== upload.id));
                  }}
                />
              ))}
              {ready.map((item) => (
                <Chip
                  key={item.key}
                  label={item.attachment.name}
                  icon={item.previewUri
                    ? <Image source={{ uri: item.previewUri }} style={styles.thumb} contentFit="cover" />
                    : <FileText size={14} color={colors.textSecondary} />}
                  onRemove={() => setReady((items) => items.filter((candidate) => candidate.key !== item.key))}
                />
              ))}
            </ScrollView>
          ) : null}
          <TextInput
            ref={inputRef}
            multiline
            placeholder={placeholder}
            placeholderTextColor={colors.textTertiary}
            selectionColor={colors.accent}
            onChangeText={onChangeText}
            selection={selection}
            onSelectionChange={onSelectionChange}
            scrollEnabled
            accessibilityLabel={placeholder}
            style={[styles.input, { color: colors.textPrimary }]}
          >
            {segments.map((segment, index) => (
              <Text key={index} style={segment.mention ? { color: mentionColor(theme, segment.text[0] as MentionTrigger), fontWeight: "500" } : undefined}>{segment.text}</Text>
            ))}
          </TextInput>
          <View style={styles.controls}>
            <Menu items={addMenu} onSelect={onAddMenu} title="Add context">
              <Button variant="ghost" size="icon" icon={Plus} accessibilityLabel="Add context" />
            </Menu>
            <View style={{ flex: 1 }} />
            {text.trim() ? (
              <Button variant="ghost" size="icon" icon={WandSparkles} loading={improving} accessibilityLabel={improving ? "Improving prompt" : "Improve prompt"} onPress={() => void improvePrompt()} />
            ) : null}
            {modelMenu.length > 0 ? (
              <Menu items={modelMenu} onSelect={(id) => models.setModel(id)} title="Model">
                <Pill label={current?.name ?? models.modelId ?? "Managed model"} maxWidth={140} />
              </Menu>
            ) : null}
            {reasoningMenu.length > 1 ? (
              <Menu items={reasoningMenu} onSelect={(id) => models.setReasoning(id as typeof models.reasoning)} title={`Reasoning for ${current?.name ?? "model"}`}>
                <Pill icon accessibilityLabel={`Reasoning ${reasoningLabel(models.reasoning)}`} />
              </Menu>
            ) : null}
            {working && hasDraft && onStop ? (
              <RoundButton kind="stop" onPress={onStop} accessibilityLabel="Stop" />
            ) : null}
            {primary === "stop" ? (
              <RoundButton kind="stop" onPress={() => onStop?.()} accessibilityLabel="Stop" />
            ) : primary === "continue" ? (
              <RoundButton kind="continue" disabled={submitting} onPress={() => void submit("send")} accessibilityLabel="Continue response" />
            ) : working ? (
              // While Berry works, send queues the prompt (the web's Enter);
              // long-press offers "Send now", the web's Cmd+Enter steer.
              <Menu
                items={[{ id: "queue", title: "Queue for later", systemImage: "text.badge.plus" }, { id: "steer", title: "Send now", systemImage: "paperplane" }]}
                onSelect={(id) => void submit(id === "steer" ? "steer" : "queue")}
                longPress
              >
                <RoundButton kind="send" disabled={sendDisabled} onPress={() => void submit("queue")} accessibilityLabel="Queue message" />
              </Menu>
            ) : (
              <RoundButton kind="send" disabled={sendDisabled} loading={submitting} onPress={() => void submit("send")} accessibilityLabel="Send" />
            )}
          </View>
        </View>
      </View>
      {error ? <Text variant="secondary" tone="danger" accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function mentionColor(theme: ReturnType<typeof useTheme>, trigger: MentionTrigger): string {
  switch (trigger) {
    case "@": return theme.colors.nodeFile;
    case "/": return theme.colors.nodeCommand;
    case "$": return theme.colors.nodeSkill;
    default: return theme.colors.nodeSession;
  }
}

function MentionIcon({ trigger, color }: { trigger: MentionTrigger; color: string }) {
  if (trigger === "@") return <AtSign size={16} color={color} />;
  if (trigger === "/") return <SlashSquare size={16} color={color} />;
  if (trigger === "#") return <Hash size={16} color={color} />;
  return <WandSparkles size={16} color={color} />;
}

function Pill({ label, icon = false, maxWidth, accessibilityLabel }: { label?: string; icon?: boolean; maxWidth?: number; accessibilityLabel?: string }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} style={[styles.pill, maxWidth ? { maxWidth } : null]}>
      {icon ? <Brain size={16} color={colors.textSecondary} /> : null}
      {label ? <Text variant="secondary" weight="medium" numberOfLines={1} style={{ color: colors.textTertiary, flexShrink: 1 }}>{label}</Text> : null}
      <ChevronDown size={14} color={colors.textTertiary} />
    </View>
  );
}

function RoundButton({ kind, onPress, disabled = false, loading = false, accessibilityLabel }: { kind: "send" | "stop" | "continue"; onPress: () => void; disabled?: boolean; loading?: boolean; accessibilityLabel: string }) {
  const { colors, tokens } = useTheme();
  const stop = kind === "stop";
  const Icon = kind === "send" ? ArrowUp : kind === "stop" ? Stop : Play;
  return (
    <Button
      size="icon"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      loading={loading}
      haptic
      onPress={onPress}
      style={{ width: 32, height: 32, minWidth: 32, borderRadius: 16, marginLeft: 4, backgroundColor: stop ? tokens.secondary : disabled ? colors.textFaint : colors.sendBackground }}
    >
      <Icon size={16} color={stop ? tokens["secondary-foreground"] : colors.sendForeground} />
    </Button>
  );
}

function Chip({ label, detail, icon, danger = false, onRemove }: { label: string; detail?: string; icon: React.ReactNode; danger?: boolean; onRemove: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.chip, { backgroundColor: colors.card, borderColor: danger ? colors.danger : colors.border }]}>
      {icon}
      <View style={{ maxWidth: 160 }}>
        <Text variant="secondary" weight="medium" numberOfLines={1}>{label}</Text>
        {detail ? <Text variant="meta" tone={danger ? "danger" : "tertiary"} numberOfLines={1}>{detail}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${label}`} hitSlop={10} onPress={onRemove}>
        <X size={14} color={colors.textTertiary} />
      </Pressable>
    </View>
  );
}

function ProgressRing({ ratio }: { ratio: number }) {
  const { colors } = useTheme();
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18" accessibilityElementsHidden>
      <Circle cx={9} cy={9} r={radius} stroke={colors.border} strokeWidth={2} fill="none" />
      <Circle
        cx={9}
        cy={9}
        r={radius}
        stroke={colors.textPrimary}
        strokeWidth={2}
        fill="none"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - Math.max(0.04, Math.min(1, ratio)))}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { width: "100%", gap: 8 },
  shell: { width: "100%" },
  strip: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, minHeight: 38, justifyContent: "center" },
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  attachments: { gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 8, paddingRight: 10, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  thumb: { width: 28, height: 28, borderRadius: 6 },
  input: {
    minHeight: 44,
    maxHeight: 200,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 13 : 10,
    paddingBottom: 8,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: "top",
  },
  controls: { flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 8, paddingRight: 10, paddingBottom: 10, minHeight: 44 },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, height: 30, paddingHorizontal: 8, borderRadius: 10 },
  suggestions: { borderWidth: StyleSheet.hairlineWidth, padding: 6, gap: 2 },
  suggestionsTitle: { paddingHorizontal: 10, paddingTop: 4, paddingBottom: 2 },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, minHeight: 44 },
  suggestionDismiss: { alignSelf: "flex-end", paddingHorizontal: 10, paddingVertical: 6 },
  error: { paddingHorizontal: 8 },
});
