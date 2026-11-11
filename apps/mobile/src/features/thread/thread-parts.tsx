import * as React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { MessageAttachmentContentSchema, type Message, type MessagePart, type ServerQueuedFollowUp } from "@berry/shared";
import type { PlanProgress } from "@berry/client-core/plan-progress";
import type { ApprovalPrompt, QuestionPrompt } from "@berry/client-core/thread-stream";
import { formatMessageTime, fullUserText, generatedImageFromPart, isImageMessagePart } from "@berry/client-core/thread-turns";
import { useServerImageSource } from "../../api/media";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { CheckIcon, CircleHelp, CircleHollow, Copy, FileText, ImagePlus, ShieldQuestion, Trash2, X } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import { Input, Spinner } from "../../ui/primitives";
import { Text } from "../../ui/text";
import { Markdown } from "../markdown/markdown";

const SUBMITTED_PROMPT_LINE_LIMIT = 12;

/* ------------------------------ User message ------------------------------ */

/** The web's user bubble: images and file cards stacked above a right-aligned bubble. */
export const UserMessage = React.memo(function UserMessage({ message }: { message: Message }) {
  const { colors } = useTheme();
  const imageParts = message.parts.filter(isImageMessagePart);
  const attachmentParts = message.parts.filter((part) => part.kind === "attachment");
  const bodyParts = message.parts.filter((part) => !isImageMessagePart(part) && part.kind !== "attachment");
  const text = bodyParts.map((part) => String(part.content ?? "")).join("\n");
  const [expanded, setExpanded] = React.useState(false);
  const [clamped, setClamped] = React.useState(false);
  const copy = async () => {
    await Clipboard.setStringAsync(fullUserText(message));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };
  const createImage = text.startsWith("Create image\n");
  return (
    <View style={styles.userRow}>
      {imageParts.map((part) => <MessageImage key={part.id} part={part} size={160} />)}
      {attachmentParts.map((part) => <AttachmentCard key={part.id} part={part} />)}
      {text ? (
        <Menu items={[{ id: "copy", title: "Copy", systemImage: "doc.on.doc" }]} onSelect={() => void copy()} longPress>
          <View style={[styles.userBubble, { backgroundColor: colors.userMessage }]}>
            {createImage ? (
              <View style={[styles.createImageChip, { borderColor: colors.border, backgroundColor: colors.control }]}>
                <ImagePlus size={14} color={colors.textPrimary} />
                <Text variant="secondary" weight="medium">Create image</Text>
              </View>
            ) : null}
            <Text
              variant="message"
              selectable
              numberOfLines={expanded ? undefined : SUBMITTED_PROMPT_LINE_LIMIT}
              onTextLayout={(event) => {
                if (!expanded) setClamped(event.nativeEvent.lines.length >= SUBMITTED_PROMPT_LINE_LIMIT);
              }}
            >
              {createImage ? text.slice("Create image\n".length) : text}
            </Text>
            {clamped || expanded ? (
              <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)} hitSlop={8}>
                <Text variant="secondary" tone="tertiary" weight="medium">{expanded ? "Show less" : "Show more"}</Text>
              </Pressable>
            ) : null}
          </View>
        </Menu>
      ) : null}
      <Text variant="meta" tone="faint">{formatMessageTime(message.createdAt)}</Text>
    </View>
  );
});

export function MessageImage({ part, size }: { part: MessagePart; size: number }) {
  const { colors } = useTheme();
  const image = generatedImageFromPart(part);
  const source = useServerImageSource(image?.src ?? (typeof part.content === "string" ? part.content : null));
  if (!source) return null;
  return (
    <Image
      source={source}
      accessibilityLabel={image?.title ?? "Image"}
      contentFit="cover"
      transition={150}
      style={{ width: size, height: size, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceInset }}
    />
  );
}

function AttachmentCard({ part }: { part: MessagePart }) {
  const { colors } = useTheme();
  const parsed = MessageAttachmentContentSchema.safeParse(part.content);
  if (!parsed.success) return null;
  const attachment = parsed.data;
  return (
    <View style={[styles.attachmentCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <FileText size={18} color={colors.textSecondary} />
      <View style={{ flexShrink: 1 }}>
        <Text variant="secondary" weight="medium" numberOfLines={1}>{attachment.name}</Text>
        <Text variant="meta" tone="tertiary" numberOfLines={1}>{attachmentDescription(attachment.mediaType, attachment.size)}</Text>
      </View>
    </View>
  );
}

function attachmentDescription(mediaType: string, size: number): string {
  const kind = mediaType.split("/")[1]?.split(/[+.;]/)[0]?.toUpperCase() ?? "File";
  const bytes = size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${kind} · ${bytes}`;
}

/* ------------------------------ Assistant parts ------------------------------ */

export function AssistantMarkdown({ children, live = false }: { children: string; live?: boolean }) {
  return <Markdown live={live}>{children}</Markdown>;
}

export function AssistantError({ children }: { children: string }) {
  const { colors, layout } = useTheme();
  return (
    <View accessibilityRole="alert" style={{ borderRadius: layout.radius, backgroundColor: colors.dangerSoft, paddingHorizontal: 12, paddingVertical: 8 }}>
      <Text variant="body" tone="danger" selectable>{children}</Text>
    </View>
  );
}

export function ArtifactCard({ name, path, size }: { name: string; path: string; size?: number | undefined }) {
  const { colors, layout } = useTheme();
  return (
    <View style={[styles.attachmentCard, { alignSelf: "stretch", backgroundColor: colors.card, borderColor: colors.border, borderRadius: layout.panelRadius }]}>
      <FileText size={18} color={colors.textSecondary} />
      <View style={{ flex: 1 }}>
        <Text variant="body" weight="medium" numberOfLines={1}>{name}</Text>
        <Text variant="meta" tone="tertiary" numberOfLines={1}>{size !== undefined ? `${attachmentDescription("file/", size).split(" · ")[1]} · ${path}` : path}</Text>
      </View>
    </View>
  );
}

/** compose_message drafts: the web's writing block, shown read-only with copy. */
export function WritingBlock({ title, body }: { title: string; body: string }) {
  const { colors, layout } = useTheme();
  return (
    <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: layout.panelRadius, backgroundColor: colors.card, padding: 14, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text variant="secondary" weight="medium" tone="tertiary" style={{ flex: 1 }}>{title}</Text>
        <Button variant="ghost" size="icon-sm" icon={Copy} accessibilityLabel="Copy draft" onPress={() => void Clipboard.setStringAsync(body)} />
      </View>
      <Markdown>{body}</Markdown>
    </View>
  );
}

/* ------------------------------ Approval ------------------------------ */

export type ApprovalDecision = "approved_once" | "approved_for_session" | "approved_rule" | "denied" | "abort";

export function ApprovalCard({ approval, onDecide }: { approval: ApprovalPrompt; onDecide: (decision: ApprovalDecision) => Promise<void> }) {
  const { colors, layout } = useTheme();
  const [pending, setPending] = React.useState(false);
  const [open, setOpen] = React.useState(true);
  const decide = async (decision: ApprovalDecision) => {
    setPending(true);
    try {
      await onDecide(decision);
    } catch (cause) {
      Alert.alert("Couldn't send your decision", cause instanceof Error ? cause.message : "Try again.");
    } finally {
      setPending(false);
    }
  };
  const evidence = approval.detail ?? approval.rawDetail ?? approval.subject ?? "Approval is required before Berry continues.";
  return (
    <View style={[styles.surface, { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: layout.panelRadius }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.surfaceHeader}>
        <ShieldQuestion size={16} color={colors.warning} />
        <Text variant="body" weight="medium" numberOfLines={2} style={{ flex: 1 }}>{approval.title}</Text>
        <Text variant="secondary" tone="tertiary">{approval.approvalKind}</Text>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 12, gap: 8 }}>
          {approval.destructive ? <Text variant="secondary" tone="danger">This action can't be undone.</Text> : null}
          {approval.openWorld ? <Text variant="secondary" tone="tertiary">This reaches outside the workspace.</Text> : null}
          <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
            <Text variant="code" mono tone="secondary" selectable>{approval.diff ?? evidence}</Text>
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.approvalActions}>
        <Button size="sm" label="Allow once" disabled={pending} haptic onPress={() => void decide("approved_once")} style={styles.approvalButton} />
        <Button size="sm" variant="outline" label="Session" disabled={pending} onPress={() => void decide("approved_for_session")} style={styles.approvalButton} />
        <Button size="sm" variant="outline" label="Always" disabled={pending} onPress={() => void decide("approved_rule")} style={styles.approvalButton} />
        <Button size="sm" variant="outline" label="Deny" disabled={pending} onPress={() => void decide("denied")} style={styles.approvalButton} />
        <Button size="sm" variant="ghost" label="Abort" disabled={pending} onPress={() => void decide("abort")} style={styles.approvalButton} />
      </View>
    </View>
  );
}

/* ------------------------------ Question ------------------------------ */

export type QuestionAnswer = {
  question: string;
  answer: string;
  selectedOptions: string[];
  attachments: [];
  skipped: boolean;
};

type Draft = QuestionAnswer & { mode: "choice" | "custom" | "skipped" };

/**
 * The web's composer question overlay: one question at a time, options to
 * tap (multi-select continues explicitly), "Something else" for a typed
 * answer, Skip, and a step count for batched questions.
 */
export function QuestionCard({ question, onSubmit }: { question: QuestionPrompt; onSubmit: (answers: QuestionAnswer[]) => Promise<void> }) {
  const { colors, layout } = useTheme();
  const items = React.useMemo(() => question.questions.length > 0
    ? question.questions
    : [{ question: question.question, options: question.options, multi: question.multi }], [question]);
  const [current, setCurrent] = React.useState(0);
  const [drafts, setDrafts] = React.useState<Record<number, Draft>>({});
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    setCurrent(0);
    setDrafts({});
    setPending(false);
    setError("");
  }, [question.questionId]);
  const prompt = items[current]!;
  const draft = drafts[current];

  const finish = async (next: Record<number, Draft>) => {
    const answers = items.map((item, index): QuestionAnswer => {
      const value = next[index];
      if (!value || (value.mode === "custom" && !value.answer.trim())) return { question: item.question, answer: "Skipped", selectedOptions: [], attachments: [], skipped: true };
      return { question: item.question, answer: value.answer.trim(), selectedOptions: value.selectedOptions, attachments: [], skipped: value.skipped };
    });
    setPending(true);
    setError("");
    try {
      await onSubmit(answers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send your response. Try again.");
      setPending(false);
    }
  };
  const advance = (value: Draft) => {
    if (pending) return;
    const next = { ...drafts, [current]: value };
    setDrafts(next);
    if (current >= items.length - 1) void finish(next);
    else setCurrent(current + 1);
  };
  const choose = (label: string) => {
    void Haptics.selectionAsync();
    if (prompt.multi) {
      const selected = draft?.mode === "choice" ? draft.selectedOptions : [];
      const selectedOptions = selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label];
      setDrafts({ ...drafts, [current]: { question: prompt.question, answer: selectedOptions.join(", "), selectedOptions, attachments: [], skipped: false, mode: "choice" } });
      return;
    }
    advance({ question: prompt.question, answer: label, selectedOptions: [label], attachments: [], skipped: false, mode: "choice" });
  };
  const custom = draft?.mode === "custom";
  return (
    <View style={[styles.surface, { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: layout.composerRadius, paddingBottom: 12 }]}>
      <View style={styles.surfaceHeader}>
        <CircleHelp size={16} color={colors.accent} />
        <Text variant="secondary" weight="medium" tone="tertiary" style={{ flex: 1 }}>Berry needs an answer</Text>
        {items.length > 1 ? <Text variant="meta" tone="tertiary">{current + 1} of {items.length}</Text> : null}
      </View>
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <Text variant="body" weight="medium">{prompt.question}</Text>
        {prompt.options.map((option) => {
          const selected = draft?.mode === "choice" && draft.selectedOptions.includes(option.label);
          const Mark = selected ? CheckIcon : CircleHollow;
          return (
            <Pressable
              key={option.label}
              accessibilityRole={prompt.multi ? "checkbox" : "button"}
              accessibilityState={{ checked: selected, disabled: pending }}
              disabled={pending}
              onPress={() => choose(option.label)}
              style={({ pressed }) => [styles.option, { borderColor: selected ? colors.textPrimary : colors.border, backgroundColor: pressed ? colors.hover : colors.control, borderRadius: layout.radius }]}
            >
              <Mark size={16} color={selected ? colors.textPrimary : colors.textTertiary} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body">{option.label}</Text>
                {option.description ? <Text variant="secondary" tone="tertiary" numberOfLines={2}>{option.description}</Text> : null}
              </View>
            </Pressable>
          );
        })}
        {custom ? (
          <Input
            autoFocus
            multiline
            value={draft.answer}
            placeholder="Type your answer"
            editable={!pending}
            onChangeText={(answer) => setDrafts({ ...drafts, [current]: { ...draft, answer } })}
            style={{ minHeight: 64, paddingTop: 10 }}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => setDrafts({ ...drafts, [current]: { question: prompt.question, answer: "", selectedOptions: [], attachments: [], skipped: false, mode: "custom" } })}
            style={({ pressed }) => [styles.option, { borderColor: colors.border, backgroundColor: pressed ? colors.hover : "transparent", borderRadius: layout.radius }]}
          >
            <Text variant="body" tone="secondary">Something else…</Text>
          </Pressable>
        )}
        {error ? <Text variant="secondary" tone="danger">{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          {current > 0 ? <Button variant="ghost" size="sm" label="Back" disabled={pending} onPress={() => setCurrent(current - 1)} /> : null}
          <Button variant="ghost" size="sm" label="Skip" disabled={pending} onPress={() => advance({ question: prompt.question, answer: "Skipped", selectedOptions: [], attachments: [], skipped: true, mode: "skipped" })} />
          {(prompt.multi && draft?.mode === "choice" && draft.selectedOptions.length > 0) || (custom && draft.answer.trim()) ? (
            <Button size="sm" label={current >= items.length - 1 ? "Send" : "Continue"} loading={pending} onPress={() => advance(draft!)} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function questionAnswerTranscript(answers: QuestionAnswer[]): string {
  return answers.map((item) => `› ${item.question}\n${item.skipped ? "Skipped" : item.answer.trim()}`).join("\n\n");
}

export function questionToolAnswer(answers: QuestionAnswer[]): string {
  return answers.map((item) => `${item.question}: ${item.skipped ? "Skipped" : item.answer.trim()}`).join("\n");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Same derivation as the web, so an answer retried from either client is one message. */
export async function stableQuestionAnswerMessageId(questionId: string): Promise<string> {
  if (UUID_PATTERN.test(questionId)) return questionId;
  const compact = questionId.match(/(?:^|_)([0-9a-f]{32})$/i)?.[1];
  if (compact) return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(`berry-question-answer:${questionId}`)));
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------ Plan + queue ------------------------------ */

export function PlanProgressPill({ plan }: { plan: PlanProgress }) {
  const { colors } = useTheme();
  const [open, setOpen] = React.useState(false);
  return (
    <View style={{ alignItems: "center", gap: 6 }}>
      {open ? (
        <View style={[styles.planList, { backgroundColor: colors.panel, borderColor: colors.border }]} accessibilityLabel="Plan steps">
          {plan.items.map((item, index) => {
            const active = index + 1 === plan.current && plan.status !== "completed";
            return (
              <View key={`${index}-${item.content}`} style={styles.planStep}>
                <PlanStatus status={item.status} />
                <Text variant="secondary" tone={active ? "primary" : "tertiary"} weight={active ? "medium" : "body"} style={{ flex: 1 }}>{item.content}</Text>
              </View>
            );
          })}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`View plan progress: step ${plan.current} of ${plan.total}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={[styles.planPill, { backgroundColor: colors.panel, borderColor: colors.border }]}
      >
        <PlanStatus status={plan.status} />
        <Text variant="secondary" weight="medium">Step {plan.current} / {plan.total}</Text>
      </Pressable>
    </View>
  );
}

function PlanStatus({ status }: { status: PlanProgress["status"] }) {
  const { colors } = useTheme();
  if (status === "in_progress") return <Spinner />;
  if (status === "completed") return <CheckIcon size={16} color={colors.nodeSession} />;
  if (status === "failed") return <X size={16} color={colors.danger} />;
  return <CircleHollow size={16} color={colors.textTertiary} />;
}

/** Server-queued follow-ups above the composer, with Send now / Steer and delete. */
export function QueuedMessages({ items, active, onSendNow, onRemove }: {
  items: ServerQueuedFollowUp[];
  active: boolean;
  onSendNow: (item: ServerQueuedFollowUp) => void;
  onRemove: (item: ServerQueuedFollowUp) => void;
}) {
  const { colors, layout } = useTheme();
  if (items.length === 0) return null;
  const paused = items.find((item) => item.status === "paused");
  return (
    <View accessibilityLabel="Queued follow-up messages" style={[styles.queue, { backgroundColor: colors.panel, borderColor: colors.border, borderRadius: layout.panelRadius }]}>
      {paused ? <Text variant="meta" tone="tertiary" style={{ paddingHorizontal: 12, paddingTop: 8 }}>{paused.error ?? "Queue paused"}</Text> : null}
      {items.map((item, index) => {
        const failed = Boolean(item.error) && item.status !== "queued";
        return (
          <View key={item.id} style={[styles.queueRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
            <Text variant="secondary" numberOfLines={2} style={{ flex: 1 }}>{item.input}</Text>
            <Button size="sm" variant="ghost" label={failed ? "Retry" : active ? "Steer" : "Send now"} onPress={() => onSendNow(item)} />
            <Button size="icon-sm" variant="ghost" icon={Trash2} accessibilityLabel={`Delete ${item.input}`} onPress={() => onRemove(item)} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { alignItems: "flex-end", gap: 8, paddingLeft: 40 },
  userBubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, gap: 6, maxWidth: "100%" },
  createImageChip: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  attachmentCard: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, maxWidth: 280 },
  surface: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  surfaceHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
  approvalActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 },
  approvalButton: { minHeight: 40 },
  option: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
  planPill: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 12, height: 32 },
  planList: { alignSelf: "stretch", borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, padding: 12, gap: 8 },
  planStep: { flexDirection: "row", alignItems: "center", gap: 8 },
  queue: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  queueRow: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 12, paddingRight: 4, minHeight: 44 },
});
