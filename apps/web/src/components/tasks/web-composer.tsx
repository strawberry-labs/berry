import * as React from "react";
import { ArrowUp, LoaderCircle, Play, Plus, Square, WandSparkles } from "lucide-react";
import { BerryApiError, type BerryApiClient, type ImageGenerationCapabilityStatus } from "@berry/api-client";
import { parseSlashCommand, type AttachmentInput, type ContextStats, type Message, type PersonalizationProfile, type ReasoningLevel, type Task, type TurnIntent, type Workspace } from "@berry/shared";
import { BerryComposerFrame } from "@berry/desktop-ui/components/berry-composer-frame";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularProgressIndicator } from "@berry/desktop-ui/components/ui/circular-progress-indicator";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import { reduceStream, type QuestionPrompt } from "@berry/desktop-ui/components/thread-stream";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { AtSign, Brain, Check, ChevronDown, FileText, Hash, ImagePlus, SlashSquare } from "@berry/desktop-ui/lib/icons";
import type { WebConfig } from "@/lib/config";
import { MentionMenu, useStaticMentions } from "../mention-menu";
import { PromptEditor, type PromptEditorHandle, type PromptMentionConfig } from "../prompt-editor";
import { ProjectSwitcher } from "../projects/project-switcher";
import { planProgressFromLiveStream, planProgressFromMessages, PlanProgressPill, type PlanProgress } from "./plan-progress-pill";
import { COMPOSER_SEND_ARROW_SIZE, COMPOSER_SEND_BUTTON_CLASS, ComposerQuestionOverlay, questionAnswerTranscript, questionToolAnswer, stableQuestionAnswerMessageId, strictQuestionAnswerAttachment, type ComposerQuestionAnswer } from "./composer-question-overlay";
import { QueuedMessageList } from "./queued-message-list";
import { createQueuedFollowUp, type QueuedFollowUp } from "@/lib/queued-follow-ups";
import { resolveComposerSubmitIntent } from "@/lib/composer-submit-intent";
import { sessionStreamStore, useSessionStream } from "@/lib/session-stream-store";

interface PendingFileUpload {
  id: string;
  file: File;
  uploadedBytes: number;
  ratio: number;
  state: "uploading" | "error";
  error?: string;
  pastedText?: string;
  pastedTextMode?: Exclude<PastedTextMode, "native">;
}

export interface PastedTextPresentation {
  text: string;
  title: string;
  mode: Exclude<PastedTextMode, "native">;
}

interface PastedTextDraft extends PastedTextPresentation {
  attachmentId: string;
  name: string;
}

export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 2_000;
export const PASTED_TEXT_INLINE_LIMIT = 40_000;
export type PastedTextMode = "native" | "inline" | "file";

export function prunePastedTextPresentations(
  presentations: Record<string, PastedTextPresentation>,
  attachments: readonly AttachmentInput[],
  queuedFollowUps: readonly QueuedFollowUp[],
): Record<string, PastedTextPresentation> {
  const liveIds = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.id) liveIds.add(attachment.id);
  }
  for (const followUp of queuedFollowUps) {
    for (const attachment of followUp.attachments) {
      if (attachment.id) liveIds.add(attachment.id);
    }
  }
  const entries = Object.entries(presentations);
  const retained = entries.filter(([id]) => liveIds.has(id));
  return retained.length === entries.length
    ? presentations
    : Object.fromEntries(retained);
}

const CREATE_IMAGE_TOKEN = "__berry_create_image__";
export function improvableComposerPrompt(text: string): string {
  return text.replaceAll(CREATE_IMAGE_TOKEN, "").trim();
}
export function composerSkillMentions(
  text: string,
  skills: WebConfig["skills"],
): PromptMentionConfig[] {
  return skills.flatMap((skill) => {
    const name = skill.name.replace(/^\$/, "").trim();
    const markdown = `$${name}`;
    const pattern = new RegExp(`${escapeComposerRegExp(markdown)}(?![a-z0-9-])`);
    return pattern.test(text)
      ? [{ id: `skill:${skill.id}`, category: "skills" as const, label: name, markdown }]
      : [];
  });
}
function escapeComposerRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function insertCreateImageToken(editor: PromptEditorHandle | null): void {
  editor?.insertPromptToken({
    id: "mode:create-image",
    category: "image",
    label: "Create image",
    markdown: CREATE_IMAGE_TOKEN,
  });
}
const PastedTextEditorDialog = React.lazy(() => import("./pasted-text-editor-dialog").then((module) => ({ default: module.PastedTextEditorDialog })));
const ComposerAttachmentPill = React.lazy(() => import("./composer-attachment-pill").then((module) => ({ default: module.ComposerAttachmentPill })));

export type ComposerPrimaryAction = "stop" | "send" | "continue";

export function resolveComposerPrimaryAction(
  working: boolean,
  hasDraft: boolean,
  continuationAvailable: boolean,
): ComposerPrimaryAction {
  if (working) return "stop";
  if (!hasDraft && continuationAvailable) return "continue";
  return "send";
}

export function Composer({
  config,
  activeTask,
  taskTitles,
  client,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateProject,
  model,
  onModelChange,
  onUserMessage,
  onUserMessagePersisted,
  onAssistantMessage,
  onEvent,
  runTurn,
  onCancel,
  onContinueTurn,
  variant,
  onCreateTask,
  streaming,
  reasoning,
  onReasoningChange,
  onCommand,
  queuedFollowUps,
  onQueuedFollowUp,
  onRemoveFollowUp,
  onRetryFollowUp,
  onReorderFollowUps,
  onSteerFollowUp,
  onUpdateFollowUp,
  onResumeFollowUps,
  onEditingFollowUpChange,
  onSteerMessage,
  planProgress,
  question,
  streamSessionId,
  streamMessages,
  showProjectSwitcher,
  personalization,
  imageGenerationCapability,
}: {
  config: WebConfig;
  activeTask: Task | null;
  taskTitles: string[];
  client: BerryApiClient | null;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateProject: () => void;
  model: string;
  onModelChange: (model: string) => void;
  onUserMessage: (text: string, sessionId: string, taskId: string, attachments?: AttachmentInput[], messageId?: string) => string | void;
  onUserMessagePersisted: (sessionId: string, optimisticMessageId: string, message: Message) => void;
  onAssistantMessage: (text: string, sessionId: string, taskId: string) => void;
  onEvent: (sessionId: string, event: Parameters<typeof reduceStream>[1]) => void;
  runTurn: (task: Task, params: { input: string; intent?: TurnIntent | undefined; messageInput?: string | undefined; requestMessageId?: string | undefined; attachments?: AttachmentInput[] | undefined }) => Promise<void>;
  onCancel: () => void;
  onContinueTurn?: (() => Promise<void>) | undefined;
  variant: "home" | "thread";
  onCreateTask: (options?: { title?: string }) => Promise<Task | null>;
  streaming: boolean;
  reasoning: ReasoningLevel;
  onReasoningChange: (level: ReasoningLevel) => void;
  onCommand: (name: string, args: string[]) => Promise<void>;
  queuedFollowUps: QueuedFollowUp[];
  onQueuedFollowUp: (followUp: QueuedFollowUp) => void;
  onRemoveFollowUp: (followUp: QueuedFollowUp) => Promise<void>;
  onRetryFollowUp: (followUp: QueuedFollowUp) => Promise<void>;
  onReorderFollowUps: (sessionId: string, orderedIds: string[]) => void;
  onSteerFollowUp: (followUp: QueuedFollowUp) => Promise<void>;
  onUpdateFollowUp: (followUp: QueuedFollowUp, update: Pick<QueuedFollowUp, "input" | "intent" | "attachments">) => Promise<void>;
  onResumeFollowUps: (sessionId: string) => Promise<void>;
  onEditingFollowUpChange: (followUp: QueuedFollowUp | null) => boolean;
  onSteerMessage: (task: Task, input: string, attachments: AttachmentInput[], intent?: TurnIntent) => Promise<void>;
  planProgress?: PlanProgress | null;
  question?: QuestionPrompt | null;
  streamSessionId?: string | null;
  streamMessages?: Message[];
  showProjectSwitcher: boolean;
  personalization: PersonalizationProfile;
  imageGenerationCapability: ImageGenerationCapabilityStatus;
}) {
  const observedStream = useSessionStream(streamSessionId);
  const hasExternalStream = Boolean(streamSessionId);
  const hasObservedStream = Boolean(streamSessionId && sessionStreamStore.has(streamSessionId));
  const effectiveStreaming = hasExternalStream ? (streaming || observedStream.turnActive) : streaming;
  // Once the per-session store exists, null is authoritative: a reset must
  // clear an old question rather than falling back to the shell's last prop.
  const effectiveQuestion = hasObservedStream ? observedStream.question : question;
  const persistedPlanProgress = React.useMemo(
    () => (streamMessages ? planProgressFromMessages(streamMessages) : null),
    [streamMessages],
  );
  const effectivePlanProgress = hasObservedStream && streamMessages
    ? planProgressFromLiveStream(observedStream, planProgress ?? persistedPlanProgress)
    : planProgress ?? persistedPlanProgress;
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [continuing, setContinuing] = React.useState(false);
  const working = busy || continuing || effectiveStreaming;
  const [attachments, setAttachments] = React.useState<AttachmentInput[]>([]);
  const [pendingUploads, setPendingUploads] = React.useState<PendingFileUpload[]>([]);
  const [pastedTextPresentations, setPastedTextPresentations] = React.useState<Record<string, PastedTextPresentation>>({});
  const [pastedTextDraft, setPastedTextDraft] = React.useState<PastedTextDraft | null>(null);
  const [savingPastedText, setSavingPastedText] = React.useState(false);
  const [pastedTextError, setPastedTextError] = React.useState("");
  const [uploadError, setUploadError] = React.useState("");
  const [promptImproveError, setPromptImproveError] = React.useState("");
  const [improvingPrompt, setImprovingPrompt] = React.useState(false);
  const [fileDragActive, setFileDragActive] = React.useState(false);
  const [createImageMode, setCreateImageMode] = React.useState(false);
  const [contextStatsResult, setContextStatsResult] = React.useState<{ sessionId: string; stats: ContextStats } | undefined>();
  const [editingFollowUp, setEditingFollowUp] = React.useState<QueuedFollowUp | null>(null);
  const [savingQueuedEdit, setSavingQueuedEdit] = React.useState(false);
  const fileDragDepthRef = React.useRef(0);
  const editorRef = React.useRef<PromptEditorHandle>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const pastedTextCountRef = React.useRef(0);
  const uploadControllersRef = React.useRef(new Map<string, AbortController>());
  const promptImprovementControllerRef = React.useRef<AbortController | null>(null);
  const latestTextRef = React.useRef(text);
  const queueEditDraftRef = React.useRef<{ text: string; attachments: AttachmentInput[]; createImageMode: boolean } | null>(null);
  const queueEditIndexRef = React.useRef<number | null>(null);
  const editingFollowUpRef = React.useRef<QueuedFollowUp | null>(null);
  const contextStatsRequestRef = React.useRef(0);
  const contextStatsInFlightRef = React.useRef(false);
  const contextStatsRefreshPendingRef = React.useRef(false);
  const contextStatsRefreshRef = React.useRef<() => Promise<void>>(async () => {});
  const contextStatsInputRef = React.useRef({ model, text, attachments });
  const setComposerText = React.useCallback((next: string) => {
    latestTextRef.current = next;
    setText(next);
  }, []);
  latestTextRef.current = text;
  contextStatsInputRef.current = { model, text, attachments };
  const contextSessionId = activeTask?.activeSessionId ?? null;
  const contextStats = contextStatsResult?.sessionId === contextSessionId
    ? contextStatsResult.stats
    : undefined;
  const refreshContextStats = React.useCallback(async () => {
    if (!client || !contextSessionId) return;
    if (contextStatsInFlightRef.current) {
      contextStatsRefreshPendingRef.current = true;
      return;
    }
    contextStatsInFlightRef.current = true;
    contextStatsRefreshPendingRef.current = false;
    const requestId = ++contextStatsRequestRef.current;
    const current = contextStatsInputRef.current;
    try {
      const next = await client.contextStats(contextSessionId, {
        model: current.model || null,
        pendingInput: current.text.replaceAll(CREATE_IMAGE_TOKEN, "Create image"),
        attachments: current.attachments,
      });
      if (requestId === contextStatsRequestRef.current) {
        setContextStatsResult({ sessionId: contextSessionId, stats: next });
      }
    } catch {
      // Keep the last valid reading through a transient request failure.
    } finally {
      contextStatsInFlightRef.current = false;
      if (contextStatsRefreshPendingRef.current) {
        contextStatsRefreshPendingRef.current = false;
        window.queueMicrotask(() => void contextStatsRefreshRef.current());
      }
    }
  }, [client, contextSessionId]);
  contextStatsRefreshRef.current = refreshContextStats;
  React.useEffect(() => {
    contextStatsRequestRef.current += 1;
    contextStatsRefreshPendingRef.current = false;
    if (!client || !contextSessionId) {
      setContextStatsResult(undefined);
      return;
    }
    void refreshContextStats();
    return () => {
      contextStatsRequestRef.current += 1;
    };
  }, [client, contextSessionId, refreshContextStats]);
  React.useEffect(() => {
    if (!client || !contextSessionId) return;
    const timeout = window.setTimeout(() => void refreshContextStats(), 220);
    return () => window.clearTimeout(timeout);
  }, [attachments, client, contextSessionId, model, refreshContextStats, text]);
  React.useEffect(() => {
    if (!client || !contextSessionId) return;
    void refreshContextStats();
    const interval = window.setInterval(
      () => void refreshContextStats(),
      effectiveStreaming ? 1_500 : 15_000,
    );
    return () => window.clearInterval(interval);
  }, [client, contextSessionId, effectiveStreaming, refreshContextStats]);
  React.useEffect(() => {
    setPastedTextPresentations((current) => (
      prunePastedTextPresentations(current, attachments, queuedFollowUps)
    ));
  }, [attachments, queuedFollowUps]);
  const onMentionSelected = React.useCallback((item: { id: string; value: string; label: string }) => {
    if (!item.id.startsWith("file:")) return;
    const reference: AttachmentInput = {
      id: `indexed-${item.value}`,
      name: item.value,
      mediaType: "application/vnd.berry.indexed-file",
      size: 0,
      sourceKind: "indexed-workspace-file",
      textContent: `Indexed workspace file reference: ${item.value}`,
    };
    setAttachments((current) => current.some((attachment) => attachment.id === reference.id) ? current : [...current, reference]);
  }, []);
  const enableCreateImageMode = React.useCallback(() => {
    if (!imageGenerationCapability.available) {
      setUploadError(imageGenerationCapability.message ?? "Image generation is unavailable.");
      return;
    }
    if (createImageMode) {
      editorRef.current?.focus();
      return;
    }
    setCreateImageMode(true);
    window.requestAnimationFrame(() => insertCreateImageToken(editorRef.current));
  }, [createImageMode, imageGenerationCapability.available, imageGenerationCapability.message]);
  const mentions = useStaticMentions({ editorRef, config, taskTitles, onSelectItem: onMentionSelected });
  React.useEffect(() => {
    const pending = window.localStorage.getItem("berry.web.pendingPrompt");
    if (!pending) return;
    window.localStorage.removeItem("berry.web.pendingPrompt");
    setComposerText(pending);
    window.requestAnimationFrame(() => editorRef.current?.insertText(pending));
  }, [setComposerText]);
  const composerModels = React.useMemo(
    () => config.providers.flatMap((provider) => provider.models.map((item) => ({ id: item.id, label: item.name ?? item.id, capabilities: item.capabilities }))).filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index),
    [config.providers],
  );
  const selectedComposerModel = composerModels.find((item) => item.id === model);
  const reasoningLevels = React.useMemo(() => reasoningLevelsForModel(selectedComposerModel), [selectedComposerModel]);

  React.useEffect(() => {
    if (!reasoningLevels.includes(reasoning)) onReasoningChange(reasoningLevels[0] ?? "off");
  }, [onReasoningChange, reasoning, reasoningLevels]);

  const editQueuedFollowUp = React.useCallback((followUp: QueuedFollowUp) => {
    if (savingQueuedEdit || editingFollowUp) return;
    if (!onEditingFollowUpChange(followUp)) return;
    queueEditDraftRef.current = { text, attachments, createImageMode };
    queueEditIndexRef.current = queuedFollowUps.findIndex((item) => item.id === followUp.id);
    editingFollowUpRef.current = followUp;
    setEditingFollowUp(followUp);
    const editingImage = followUp.intent === "image_generation";
    const editableInput = editingImage ? followUp.input.replace(/^Create image\s*\n?/, "") : followUp.input;
    setCreateImageMode(editingImage);
    setComposerText(editableInput);
    setAttachments(followUp.attachments);
    window.requestAnimationFrame(() => {
      editorRef.current?.setText(editableInput);
      if (editingImage) insertCreateImageToken(editorRef.current);
    });
  }, [attachments, createImageMode, editingFollowUp, onEditingFollowUpChange, queuedFollowUps, savingQueuedEdit, setComposerText, text]);

  const cancelQueuedEdit = React.useCallback(() => {
    const draft = queueEditDraftRef.current;
    queueEditDraftRef.current = null;
    queueEditIndexRef.current = null;
    editingFollowUpRef.current = null;
    onEditingFollowUpChange(null);
    setEditingFollowUp(null);
    setCreateImageMode(draft?.createImageMode ?? false);
    setComposerText(draft?.text ?? "");
    setAttachments(draft?.attachments ?? []);
    editorRef.current?.setText(draft?.text.replaceAll(CREATE_IMAGE_TOKEN, "") ?? "");
    if (draft?.createImageMode) insertCreateImageToken(editorRef.current);
  }, [onEditingFollowUpChange, setComposerText]);

  React.useEffect(() => () => {
    if (editingFollowUpRef.current) onEditingFollowUpChange(null);
  }, [onEditingFollowUpChange]);

  React.useEffect(() => () => {
    for (const controller of uploadControllersRef.current.values()) controller.abort();
    uploadControllersRef.current.clear();
    promptImprovementControllerRef.current?.abort();
  }, []);

  const reorderQueuedFollowUps = React.useCallback((sessionId: string, orderedIds: string[]) => {
    if (!editingFollowUp || editingFollowUp.sessionId !== sessionId) {
      onReorderFollowUps(sessionId, orderedIds);
      return;
    }
    const restored = [...orderedIds];
    const index = Math.max(0, Math.min(queueEditIndexRef.current ?? restored.length, restored.length));
    restored.splice(index, 0, editingFollowUp.id);
    onReorderFollowUps(sessionId, restored);
  }, [editingFollowUp, onReorderFollowUps]);

  const answerQuestion = React.useCallback(async (answers: ComposerQuestionAnswer[]) => {
    if (!effectiveQuestion || !activeTask?.activeSessionId || !client) throw new Error("This question is no longer available. Refresh and try again.");
    const sessionId = activeTask.activeSessionId;
    const transcript = questionAnswerTranscript(answers);
    const answerAttachments = answers.flatMap((answer) => answer.attachments);
    const answerMessageId = await stableQuestionAnswerMessageId(effectiveQuestion.questionId);
    const result = await client.answerQuestion(effectiveQuestion.questionId, {
      answer: questionToolAnswer(answers),
      answerMessageId,
      selectedOptions: answers.flatMap((item) => item.selectedOptions),
      answers,
    });
    if (!result.ok) throw new Error("This question was already answered or is no longer active.");
    const optimisticMessageId = onUserMessage(
      transcript,
      sessionId,
      activeTask.id,
      answerAttachments,
      answerMessageId,
    );
    if (optimisticMessageId && result.message) {
      onUserMessagePersisted(sessionId, optimisticMessageId, result.message);
    }
  }, [activeTask, client, effectiveQuestion, onUserMessage, onUserMessagePersisted]);

  const improvePrompt = React.useCallback(async () => {
    const prompt = improvableComposerPrompt(text);
    if (!client || !prompt || improvingPrompt) return;
    const originalText = text;
    const skillMentions = composerSkillMentions(prompt, config.skills);
    const preserveCreateImageMode = originalText.includes(CREATE_IMAGE_TOKEN);
    const controller = new AbortController();
    promptImprovementControllerRef.current?.abort();
    promptImprovementControllerRef.current = controller;
    setPromptImproveError("");
    setImprovingPrompt(true);
    try {
      const result = await client.improvePrompt({
        prompt,
        skills: skillMentions.map((mention) => mention.markdown.slice(1)),
      }, { signal: controller.signal });
      if (latestTextRef.current !== originalText) {
        if (improvableComposerPrompt(latestTextRef.current)) {
          setPromptImproveError("Your draft changed while Berry was improving it. Run Improve prompt again to use the latest text.");
        }
        return;
      }
      setComposerText(result.prompt);
      editorRef.current?.setTextWithMentions(result.prompt, skillMentions);
      setCreateImageMode(preserveCreateImageMode);
      if (preserveCreateImageMode) {
        window.requestAnimationFrame(() => insertCreateImageToken(editorRef.current));
      }
    } catch (cause) {
      if (!controller.signal.aborted) setPromptImproveError(promptImprovementErrorMessage(cause));
    } finally {
      if (promptImprovementControllerRef.current === controller) {
        promptImprovementControllerRef.current = null;
        setImprovingPrompt(false);
      }
    }
  }, [client, config.skills, improvingPrompt, setComposerText, text]);

  const continueInterruptedTurn = React.useCallback(async () => {
    if (!onContinueTurn || working || editingFollowUp || pendingUploads.length > 0) return;
    setContinuing(true);
    setUploadError("");
    try {
      await onContinueTurn();
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "Unable to continue this response");
    } finally {
      setContinuing(false);
    }
  }, [editingFollowUp, onContinueTurn, pendingUploads.length, working]);

  const submit = React.useCallback(async (event?: KeyboardEvent | null) => {
    if (savingQueuedEdit || pendingUploads.some((upload) => upload.state === "uploading")) return;
    const plainInput = text.replaceAll(CREATE_IMAGE_TOKEN, "").trim() || (attachments.length > 0 ? "Review the attached files." : "");
    const input = createImageMode ? `Create image\n${plainInput}` : plainInput;
    const intent = createImageMode ? "image_generation" as const : undefined;
    if (!input) {
      await continueInterruptedTurn();
      return;
    }
    if (editingFollowUp) {
      setSavingQueuedEdit(true);
      setUploadError("");
      try {
        const draft = queueEditDraftRef.current;
        await onUpdateFollowUp(editingFollowUp, { input, intent, attachments });
        queueEditDraftRef.current = null;
        queueEditIndexRef.current = null;
        editingFollowUpRef.current = null;
        onEditingFollowUpChange(null);
        setEditingFollowUp(null);
        setCreateImageMode(draft?.createImageMode ?? false);
        setComposerText(draft?.text ?? "");
        setAttachments(draft?.attachments ?? []);
        editorRef.current?.setText(draft?.text.replaceAll(CREATE_IMAGE_TOKEN, "") ?? "");
        if (draft?.createImageMode) insertCreateImageToken(editorRef.current);
      } catch (cause) {
        setUploadError(cause instanceof Error ? cause.message : "Unable to update the queued prompt");
      } finally {
        setSavingQueuedEdit(false);
      }
      return;
    }
    const submitIntent = resolveComposerSubmitIntent(working, event);
    if (submitIntent === "ignore") return;
    const command = submitIntent === "send" ? parseSlashCommand(input) : null;
    if (command) {
      setUploadError("");
      try {
        await onCommand(command.name, command.args);
        setComposerText("");
        setCreateImageMode(false);
        editorRef.current?.clear();
      } catch (cause) {
        setUploadError(cause instanceof Error ? cause.message : `Unable to run /${command.name}`);
      }
      return;
    }
    if (working && activeTask?.activeSessionId) {
      if (submitIntent === "queue") {
        onQueuedFollowUp(createQueuedFollowUp({
          taskId: activeTask.id,
          sessionId: activeTask.activeSessionId,
          ordinal: queuedFollowUps.length,
          input,
          ...(intent ? { intent } : {}),
          attachments,
        }));
        setComposerText("");
        setCreateImageMode(false);
        editorRef.current?.clear();
        setAttachments([]);
        return;
      }

      if (!client) {
        setComposerText("");
        setCreateImageMode(false);
        editorRef.current?.clear();
        setAttachments([]);
        return;
      }
      try {
        await onSteerMessage(activeTask, input, attachments, intent);
        setComposerText("");
        setCreateImageMode(false);
        editorRef.current?.clear();
        setAttachments([]);
      } catch (cause) {
        setUploadError(cause instanceof Error ? cause.message : "Unable to steer the running task");
      }
      return;
    }
    if (working) return;
    const task = activeTask ?? await onCreateTask({ title: input.slice(0, 42) });
    if (!task?.activeSessionId) return;
    const sessionId = task.activeSessionId;
    const profileContext = variant === "home" ? personalizationRuntimeContext(personalization) : "";
    const runtimeInput = profileContext ? `${input}\n\nExplicit user profile context:\n${profileContext}` : input;
    setBusy(true);
    setUploadError("");
    const requestMessageId = globalThis.crypto.randomUUID();
    onUserMessage(input, sessionId, task.id, attachments, requestMessageId);
    setComposerText("");
    setCreateImageMode(false);
    editorRef.current?.clear();
    try {
      if (client) {
        const sent = attachments;
        setAttachments([]);
        await runTurn(task, {
          input: runtimeInput,
          ...(intent ? { intent } : {}),
          ...(runtimeInput !== input ? { messageInput: input } : {}),
          requestMessageId,
          ...(sent.length > 0 ? { attachments: sent } : {}),
        });
      } else {
        onEvent(sessionId, { kind: "turn.start", turnId: `pending_${Date.now()}` });
        const turnId = `turn_${Date.now()}`;
        onEvent(sessionId, { kind: "turn.start", turnId });
        onEvent(sessionId, { kind: "message.start", messageId: `msg_live_${turnId}`, role: "assistant" });
        onEvent(sessionId, { kind: "tool.start", toolCallId: `tool_${turnId}`, name: "sandbox.exec", title: "Fixture sandbox" });
        onEvent(sessionId, { kind: "tool.end", toolCallId: `tool_${turnId}`, status: "completed", summary: "ready" });
        onEvent(sessionId, { kind: "message.delta", messageId: `msg_live_${turnId}`, delta: "Fixture sandbox ready. In demo mode this stays in the browser; set `BERRY_WEB_API_BASE_URL` to run it through the Phase 8 API/SSE surface.", channel: "text" });
        onEvent(sessionId, { kind: "turn.end", turnId, status: "completed" });
        window.setTimeout(() => onAssistantMessage("Fixture sandbox ready. In demo mode this stays in the browser; set `BERRY_WEB_API_BASE_URL` to run it through the Phase 8 API/SSE surface.", sessionId, task.id), 60);
      }
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "Unable to complete the turn");
    } finally {
      setBusy(false);
    }
  }, [activeTask, attachments, client, continueInterruptedTurn, createImageMode, editingFollowUp, onAssistantMessage, onCommand, onCreateTask, onEditingFollowUpChange, onEvent, onQueuedFollowUp, onSteerMessage, onUpdateFollowUp, onUserMessage, onUserMessagePersisted, pendingUploads, personalization, queuedFollowUps.length, runTurn, savingQueuedEdit, setComposerText, text, variant, working]);

  const addFiles = React.useCallback(async (files: FileList | readonly File[] | null, options: { pastedText?: string; pastedTextMode?: Exclude<PastedTextMode, "native"> } = {}) => {
    if (!files?.length) return;
    setUploadError("");
    try {
      const selected = Array.from(files);
      if (attachments.length + pendingUploads.length + selected.length > 100) throw new Error("Attach no more than 100 files to one message.");
      const queued = selected.map((file, index): PendingFileUpload => ({
        id: globalThis.crypto.randomUUID(),
        file,
        uploadedBytes: 0,
        ratio: 0,
        state: "uploading",
        ...(index === 0 && options.pastedText ? { pastedText: options.pastedText, pastedTextMode: options.pastedTextMode } : {}),
      }));
      for (const pending of queued) uploadControllersRef.current.set(pending.id, new AbortController());
      setPendingUploads((current) => [...current, ...queued]);
      await mapWithConcurrency(queued, 2, async (pending) => {
        const controller = uploadControllersRef.current.get(pending.id);
        try {
          if (!controller || controller.signal.aborted) return;
          const attachment: AttachmentInput = client
            ? await client.uploadFile(pending.file, {
              ...(activeTask ? { taskId: activeTask.id, ...(activeTask.activeSessionId ? { sessionId: activeTask.activeSessionId } : {}) } : {}),
              signal: controller.signal,
              onProgress: ({ ratio, uploadedBytes }) => setPendingUploads((current) => current.map((item) => item.id === pending.id ? { ...item, ratio, uploadedBytes } : item)),
            }).then((stored) => {
              return {
                id: stored.id,
                fileId: stored.id,
                name: stored.name,
                mediaType: stored.mediaType,
                declaredMediaType: stored.declaredMediaType,
                detectedMediaType: stored.detectedMediaType,
                size: stored.size,
                sourceKind: "object-storage",
                previewUrl: stored.previewUrl,
              } satisfies AttachmentInput;
            })
            : await fileToAttachment(pending.file);
          if (controller.signal.aborted) return;
          if (pending.pastedText && pending.pastedTextMode && attachment.id) {
            setPastedTextPresentations((current) => ({
              ...current,
              [attachment.id!]: {
                text: pending.pastedText!,
                title: pastedTextTitle(pending.pastedText!),
                mode: pending.pastedTextMode!,
              },
            }));
          }
          setAttachments((current) => [...current, attachment].slice(0, 100));
          setPendingUploads((current) => current.filter((item) => item.id !== pending.id));
          return attachment;
        } catch (cause) {
          if (controller?.signal.aborted) {
            setPendingUploads((current) => current.filter((item) => item.id !== pending.id));
            return;
          }
          const message = cause instanceof Error ? cause.message : "Upload failed";
          setPendingUploads((current) => current.map((item) => item.id === pending.id ? { ...item, state: "error", error: message } : item));
          throw cause;
        } finally {
          uploadControllersRef.current.delete(pending.id);
        }
      });
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "Unable to attach these files");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [activeTask, attachments, client, pendingUploads.length]);

  const dismissPendingUpload = React.useCallback((upload: PendingFileUpload) => {
    uploadControllersRef.current.get(upload.id)?.abort();
    setPendingUploads((current) => current.filter((item) => item.id !== upload.id));
  }, []);

  const uploadQuestionFiles = React.useCallback(async (files: readonly File[]): Promise<ComposerQuestionAnswer["attachments"]> => {
    if (!client || !activeTask?.activeSessionId) throw new Error("This question is no longer available. Refresh and try again.");
    if (files.length > 100) throw new Error("Attach no more than 100 files to one answer.");
    const stored = await mapWithConcurrency(files, 2, async (file) => client.uploadFile(file, {
      taskId: activeTask.id,
      sessionId: activeTask.activeSessionId!,
    }));
    return stored.map(strictQuestionAnswerAttachment);
  }, [activeTask, client]);

  const handlePaste = React.useCallback((event: ClipboardEvent) => {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addFiles(files);
      return true;
    }
    const pastedText = event.clipboardData?.getData("text/plain") ?? "";
    const pastedMode = pastedTextMode(pastedText);
    if (pastedMode === "native") return false;
    event.preventDefault();
    event.stopPropagation();
    pastedTextCountRef.current += 1;
    const count = pastedTextCountRef.current;
    const name = count === 1 ? "Pasted text.txt" : `Pasted text (${count}).txt`;
    void addFiles([new File([pastedText], name, { type: "text/plain" })], { pastedText, pastedTextMode: pastedMode });
    return true;
  }, [addFiles]);

  const showPastedTextInEditor = React.useCallback((attachmentId: string) => {
    const presentation = pastedTextPresentations[attachmentId];
    if (!presentation || presentation.mode !== "inline") return;
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setPastedTextPresentations((current) => {
      const next = { ...current };
      delete next[attachmentId];
      return next;
    });
    editorRef.current?.insertText(presentation.text);
  }, [pastedTextPresentations]);

  const savePastedTextDraft = React.useCallback(async () => {
    if (!pastedTextDraft) return;
    setSavingPastedText(true);
    setPastedTextError("");
    try {
      const file = new File([pastedTextDraft.text], pastedTextDraft.name, { type: "text/plain" });
      const replacement: AttachmentInput = client
        ? await client.uploadFile(file, {
          ...(activeTask ? { taskId: activeTask.id, ...(activeTask.activeSessionId ? { sessionId: activeTask.activeSessionId } : {}) } : {}),
        }).then((stored) => ({
          id: stored.id,
          fileId: stored.id,
          name: stored.name,
          mediaType: stored.mediaType,
          declaredMediaType: stored.declaredMediaType,
          detectedMediaType: stored.detectedMediaType,
          size: stored.size,
          sourceKind: "object-storage",
          previewUrl: stored.previewUrl,
        }))
        : await fileToAttachment(file);
      setAttachments((current) => current.map((attachment) => attachment.id === pastedTextDraft.attachmentId ? replacement : attachment));
      setPastedTextPresentations((current) => {
        const next = { ...current };
        delete next[pastedTextDraft.attachmentId];
        if (replacement.id) {
          next[replacement.id] = {
            text: pastedTextDraft.text,
            title: pastedTextTitle(pastedTextDraft.text),
            mode: pastedTextDraft.text.length <= PASTED_TEXT_INLINE_LIMIT ? "inline" : "file",
          };
        }
        return next;
      });
      setPastedTextDraft(null);
    } catch (cause) {
      setPastedTextError(cause instanceof Error ? cause.message : "Unable to save pasted text");
    } finally {
      setSavingPastedText(false);
    }
  }, [activeTask, client, pastedTextDraft]);

  const handleDragEnter = React.useCallback<React.DragEventHandler<HTMLDivElement>>((event) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  }, []);

  const handleDragOver = React.useCallback<React.DragEventHandler<HTMLDivElement>>((event) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = React.useCallback<React.DragEventHandler<HTMLDivElement>>((event) => {
    if (fileDragDepthRef.current === 0) return;
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  }, []);

  const handleDrop = React.useCallback<React.DragEventHandler<HTMLDivElement>>((event) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    void addFiles(filesFromDataTransfer(event.dataTransfer));
  }, [addFiles]);

  const removeAttachment = React.useCallback((attachment: AttachmentInput, index: number) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    if (!attachment.id) return;
    setPastedTextPresentations((current) => {
      const next = { ...current };
      delete next[attachment.id!];
      return next;
    });
  }, []);

  const openPastedTextFile = React.useCallback((attachment: AttachmentInput, presentation: PastedTextPresentation) => {
    if (!attachment.id || presentation.mode !== "file") return;
    setPastedTextError("");
    setPastedTextDraft({ attachmentId: attachment.id, name: attachment.name, ...presentation });
  }, []);

  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  const showImprovePrompt = improvableComposerPrompt(text).length > 0;
  const uploadInProgress = pendingUploads.some((upload) => upload.state === "uploading");
  const primaryAction = editingFollowUp
    ? "send"
    : resolveComposerPrimaryAction(working, hasDraft, Boolean(onContinueTurn) && pendingUploads.length === 0);
  const primaryActionDisabled = savingQueuedEdit
    || uploadInProgress
    || (primaryAction === "send" && !hasDraft);

  return (
    <>
    <div className={variant === "thread" ? "berry-thread-composer-wrap mx-auto max-w-full pb-5" : "w-full"}>
      <BerryComposerFrame
        variant={variant}
        {...(fileDragActive ? { className: "outline outline-2 -outline-offset-2 outline-[var(--berry-border-strong)]" } : {})}
        shellProps={{
          onDragEnter: handleDragEnter,
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
        }}
        before={
          <>
            <MentionMenu controller={mentions} />
            {variant === "thread" && effectiveQuestion ? <ComposerQuestionOverlay question={effectiveQuestion} onSubmit={answerQuestion} onUploadFiles={uploadQuestionFiles} /> : null}
            {variant === "thread" && (effectivePlanProgress || queuedFollowUps.length > 0) ? (
              <div className="berry-thread-composer-stack">
                {effectivePlanProgress ? <PlanProgressPill plan={effectivePlanProgress} /> : null}
                {queuedFollowUps.length > 0 ? (
                  <QueuedMessageList
                    followUps={editingFollowUp ? queuedFollowUps.filter((followUp) => followUp.id !== editingFollowUp.id) : queuedFollowUps}
                    active={working}
                    onRetry={onRetryFollowUp}
                    onRemove={onRemoveFollowUp}
                    onReorder={reorderQueuedFollowUps}
                    onSendNow={onSteerFollowUp}
                    onEdit={editQueuedFollowUp}
                    onResume={onResumeFollowUps}
                  />
                ) : null}
              </div>
            ) : null}
          </>
        }
        header={
          showProjectSwitcher ? (
            <div className="berry-composer-meta berry-composer-context-row flex min-w-0 items-center gap-2 px-2 pt-2">
              <ProjectSwitcher
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                onSelectWorkspace={onSelectWorkspace}
                onCreateProject={onCreateProject}
                className="berry-composer-project-switcher"
              />
            </div>
          ) : null
        }
      >
        {fileDragActive ? (
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center gap-2 rounded-[18px] bg-card/95 text-sm font-medium text-card-foreground shadow-[var(--berry-ring-strong)]" role="status">
            <FileText />
            <span>Drop files to attach</span>
          </div>
        ) : null}
        <div className="berry-composer-input flex min-h-[96px] flex-1 flex-col">
        {editingFollowUp ? (
          <div className="flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground">
            <span>Editing queued message</span>
            <Button variant="ghost" size="xs" disabled={savingQueuedEdit} onClick={cancelQueuedEdit}>Cancel</Button>
          </div>
        ) : null}
        {attachments.length > 0 || pendingUploads.length > 0 ? (
          <AttachmentGroup className="px-3 pt-2">
            {pendingUploads.map((upload) => (
              <Attachment size="sm" state={upload.state} className="max-w-[360px] flex-nowrap rounded-[22px] border-0 bg-card shadow-[var(--berry-ring-subtle)]" key={upload.id}>
                <AttachmentMedia className="!w-10 rounded-full bg-transparent">
                  {upload.state === "error" ? <FileTypeIcon path={upload.file.name} className="size-10" /> : null}
                  {upload.state === "uploading" ? <UploadProgressRing ratio={upload.ratio} /> : null}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{upload.file.name}</AttachmentTitle>
                  <AttachmentDescription>{upload.state === "error" ? (upload.error ?? "Upload failed") : uploadProgressDescription(upload.uploadedBytes, upload.file.size)}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`${upload.state === "uploading" ? "Cancel upload" : "Remove"} ${upload.file.name}`}
                    onClick={() => dismissPendingUpload(upload)}
                  >×</AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
            {attachments.map((attachment, index) => {
              const presentation = attachment.id ? pastedTextPresentations[attachment.id] : undefined;
              return (
                <React.Suspense key={attachment.id ?? `${attachment.name}-${index}`} fallback={null}>
                  <ComposerAttachmentPill
                    attachment={attachment}
                    presentation={presentation}
                    onRemove={() => removeAttachment(attachment, index)}
                    onShowInline={() => { if (attachment.id) showPastedTextInEditor(attachment.id); }}
                    onOpenFile={() => { if (presentation) openPastedTextFile(attachment, presentation); }}
                  />
                </React.Suspense>
              );
            })}
          </AttachmentGroup>
        ) : null}
        <div className="berry-composer-editor relative flex-1">
          <PromptEditor
            ref={editorRef}
            placeholder={editingFollowUp ? "Edit queued prompt" : variant === "home" ? "Ask Berry anything, @ for files or folders, / for commands, # for related tasks" : "Ask for follow-up changes"}
            autoFocus
            mentions={mentions}
            onPasteEvent={handlePaste}
            onChange={(next) => { setComposerText(next); setCreateImageMode(next.includes(CREATE_IMAGE_TOKEN)); setPromptImproveError(""); }}
            onSubmit={(event) => void submit(event)}
            onEscape={editingFollowUp ? cancelQueuedEdit : undefined}
          />
        </div>
        <div className="berry-composer-controls flex min-w-0 flex-nowrap items-center gap-1">
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => void addFiles(event.currentTarget.files)} />
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-lg" className="berry-composer-icon-button size-8 rounded-[9px]" aria-label="Add context"><Plus /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-64"><DropdownMenuItem className="berry-create-image-menu-item" disabled={!imageGenerationCapability.available} onClick={enableCreateImageMode} title={imageGenerationCapability.available ? undefined : imageGenerationCapability.message ?? "Image generation is unavailable"}><ImagePlus /><strong className="berry-create-image-menu-label">Create image</strong>{!imageGenerationCapability.available ? <span className="ml-auto text-xs text-muted-foreground">Unavailable</span> : null}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => fileInputRef.current?.click()}><ImagePlus /> Add attachment</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => editorRef.current?.insertText("@")}><AtSign /> Insert @ mention</DropdownMenuItem><DropdownMenuItem onClick={() => editorRef.current?.insertText("#")}><Hash /> Insert # task</DropdownMenuItem><DropdownMenuItem onClick={() => editorRef.current?.insertText("/")}><SlashSquare /> Insert / command</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <span className="min-w-0 flex-1" />
          {contextSessionId ? <ContextWindowRing stats={contextStats} /> : null}
          {showImprovePrompt ? (
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    className="berry-composer-icon-button size-8 shrink-0 rounded-[9px] text-muted-foreground transition-[background-color,color,opacity,transform] active:scale-[0.96] motion-reduce:transform-none motion-reduce:transition-none"
                    aria-label={improvingPrompt ? "Improving prompt" : "Improve prompt"}
                    disabled={improvingPrompt}
                    onClick={() => void improvePrompt()}
                  >
                    {improvingPrompt
                      ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
                      : <WandSparkles aria-hidden />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" showArrow={false}>Improve prompt</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="berry-pill-control min-w-0 max-w-[min(42vw,240px)] shrink gap-1.5 text-muted-foreground"><span className="berry-composer-model-label min-w-0 truncate">{selectedComposerModel?.label ?? model ?? "Managed model"}</span><ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="berry-compact-selector-surface w-52"><DropdownMenuLabel>Model</DropdownMenuLabel>{composerModels.map((item) => <DropdownMenuItem key={item.id} onClick={() => { onModelChange(item.id); const nextLevels = reasoningLevelsForModel(item); if (!nextLevels.includes(reasoning)) onReasoningChange(nextLevels[0] ?? "off"); }}><span className="truncate">{item.label}</span>{item.id === model ? <Check className="ml-auto" /> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Reasoning level" aria-pressed={reasoning !== "off"} title={`Reasoning ${reasoning}`} className="berry-pill-control gap-1.5"><Brain /><span className="hidden md:inline">{reasoningLabel(reasoning)}</span><ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="berry-compact-selector-surface w-52"><DropdownMenuLabel>Reasoning for {selectedComposerModel?.label ?? "model"}</DropdownMenuLabel>{reasoningLevels.map((level) => <DropdownMenuItem key={level} onClick={() => onReasoningChange(level)}><Brain /><span>{reasoningLabel(level)}</span>{level === reasoning ? <Check className="ml-auto" /> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
          {primaryAction === "stop" && !editingFollowUp ? (
            <Button
              type="button"
              size="icon-lg"
              variant="secondary"
              onClick={onCancel}
              aria-label="Stop"
              className="berry-composer-send size-8 rounded-full bg-secondary text-secondary-foreground transition-[background-color,color,box-shadow,opacity,transform] active:scale-[0.96] hover:bg-accent"
            >
              <Square size={14} fill="currentColor" aria-hidden />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-lg"
              variant="secondary"
              disabled={primaryActionDisabled}
              onClick={() => void (primaryAction === "continue" ? continueInterruptedTurn() : submit())}
              aria-label={editingFollowUp ? "Save queued message" : primaryAction === "continue" ? "Continue response" : "Send"}
              className={COMPOSER_SEND_BUTTON_CLASS}
            >
              {primaryAction === "continue" ? (
                <Play size={15} fill="currentColor" className="translate-x-px" aria-hidden />
              ) : (
                <ArrowUp size={COMPOSER_SEND_ARROW_SIZE} aria-hidden />
              )}
            </Button>
          )}
        </div>
        </div>
      </BerryComposerFrame>
      {uploadError ? <p className="composer-error" role="alert">{uploadError}</p> : null}
      {promptImproveError ? <p className="composer-error" role="alert">{promptImproveError}</p> : null}
    </div>
    {pastedTextDraft ? (
      <React.Suspense fallback={null}>
        <PastedTextEditorDialog
          name={pastedTextDraft.name}
          text={pastedTextDraft.text}
          saving={savingPastedText}
          error={pastedTextError}
          onTextChange={(next) => setPastedTextDraft((current) => current ? { ...current, text: next } : current)}
          onClose={() => setPastedTextDraft(null)}
          onSave={() => void savePastedTextDraft()}
        />
      </React.Suspense>
    ) : null}
    </>
  );
}

function personalizationRuntimeContext(profile: PersonalizationProfile): string {
  return [
    profile.nickname.trim() ? `Nickname: ${profile.nickname.trim()}` : "",
    profile.occupation.trim() ? `Occupation: ${profile.occupation.trim()}` : "",
    profile.about.trim() ? `About: ${profile.about.trim()}` : "",
    profile.customInstructions.trim() ? `Custom instructions: ${profile.customInstructions.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function pastedTextMode(text: string): PastedTextMode {
  if (text.length < PASTED_TEXT_ATTACHMENT_THRESHOLD) return "native";
  return text.length <= PASTED_TEXT_INLINE_LIMIT ? "inline" : "file";
}

function pastedTextTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Pasted text";
  return firstLine.replace(/\s+/g, " ").slice(0, 120);
}

export function reasoningLevelsForModel(model: {
  id: string;
  label?: string | undefined;
  capabilities?: { reasoning?: boolean | undefined; reasoningEfforts?: ReasoningLevel[] | undefined } | undefined;
} | undefined): ReasoningLevel[] {
  if (!model) return ["off", "low", "medium", "high"];
  if (model.capabilities?.reasoningEfforts?.length) return [...model.capabilities.reasoningEfforts];
  if (model.capabilities?.reasoning === false) return ["off"];
  if (/glm[-_. ]?5(?:\.2|[-_.]?2)/i.test(`${model.id} ${model.label ?? ""}`)) return ["high", "xhigh"];
  return ["off", "low", "medium", "high"];
}

function reasoningLabel(level: ReasoningLevel): string {
  return level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1);
}

function ContextWindowRing({ stats }: { stats: ContextStats | undefined }) {
  const percent = stats?.percentUsed ?? null;
  const used = stats ? formatContextTokens(stats.usedTokens) : null;
  const total = stats?.contextWindow ? formatContextTokens(stats.contextWindow) : null;
  const left = stats?.tokensLeft !== null && stats?.tokensLeft !== undefined
    ? formatContextTokens(stats.tokensLeft)
    : null;
  const leftPercent = percent === null ? null : Math.max(0, 100 - percent);
  const usedPercent = formatContextPercent(percent);
  const leftPercentLabel = formatContextPercent(leftPercent);
  const tooltipLabel = stats && usedPercent !== null
    ? `Active context: ${usedPercent}% used (${leftPercentLabel ?? "0"}% left)${used && total ? `, ${used} / ${total} tokens used` : ""}`
    : "Calculating active context usage";

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={tooltipLabel}
            className="berry-context-ring"
            data-state={stats?.thresholdState ?? "unknown"}
          >
            <CircularProgressIndicator
              value={percent ?? 0}
              size={20}
              strokeWidth={2.4}
              label="Context window usage"
              trackClassName="opacity-30"
              formatValueText={(percentage) => `${Math.round(percentage)}% of context used`}
              aria-busy={!stats}
              title={undefined}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="berry-context-tooltip" showArrow={false}>
          <div className="berry-context-tooltip-content">
            {stats && usedPercent !== null ? (
              <>
                <span className="berry-context-tooltip-label">Active context</span>
                <span>{usedPercent}% used ({leftPercentLabel ?? "0"}% left)</span>
                {used && total ? <span>{used} / {total} tokens used</span> : null}
                {left ? <span className="berry-context-tooltip-label">{left} tokens remaining</span> : null}
              </>
            ) : (
              <span className="berry-context-tooltip-label">Calculating context usage…</span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function UploadProgressRing({ ratio }: { ratio: number }) {
  return (
    <CircularProgressIndicator
      value={ratio * 100}
      size={28}
      className="pointer-events-none absolute inset-1.5 text-muted-foreground"
      label="Uploading"
      formatValueText={(percentage) => `${Math.round(percentage)}% uploaded`}
    />
  );
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}

function formatContextPercent(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent > 0 && percent < 10) return percent.toFixed(1);
  return String(Math.round(percent));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function uploadProgressDescription(uploadedBytes: number, totalBytes: number): string {
  const total = formatFileSize(totalBytes);
  if (uploadedBytes <= 0 || totalBytes <= 0) return `Uploading · ${total}`;
  const percent = Math.min(100, Math.max(1, Math.round((uploadedBytes / totalBytes) * 100)));
  return `Uploading ${percent}% · ${total}`;
}

function promptImprovementErrorMessage(cause: unknown): string {
  if (cause instanceof BerryApiError && cause.body && typeof cause.body === "object") {
    const message = (cause.body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Berry could not improve this prompt. Please try again.";
}

export function filesFromDataTransfer(dataTransfer: Pick<DataTransfer, "files" | "items"> | null): File[] {
  if (!dataTransfer) return [];
  const directFiles = Array.from(dataTransfer.files);
  if (directFiles.length > 0) return directFiles;
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
}

function hasFilePayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files") || filesFromDataTransfer(dataTransfer).length > 0;
}

async function fileToAttachment(file: File): Promise<AttachmentInput> {
  const textLike = file.type.startsWith("text/") || /\.(md|mdx|txt|json|yaml|yml|csv|tsv|js|jsx|ts|tsx|py|rb|go|rs|java|css|html|xml|sql|sh)$/i.test(file.name);
  return {
    id: globalThis.crypto.randomUUID(),
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    sourceKind: "web-upload",
    ...(!textLike ? { dataUrl: await readFile(file, "data-url") } : {}),
    ...(textLike && file.size <= 1_000_000 ? { textContent: await readFile(file, "text") } : {}),
  };
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}

function readFile(file: File, kind: "data-url" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error(`Unable to read ${file.name}`)), { once: true });
    if (kind === "data-url") reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}
