import * as React from "react";
import { ArrowUp, X } from "lucide-react";
import { type BerryApiClient } from "@berry/api-client";
import { MessageAttachmentContentSchema, type Message, type StoredFile } from "@berry/shared";
import { BerryThreadView, BerryUserEditorFrame, findMessageSearchTarget, fullUserText, type BerryThreadAdapter } from "@berry/desktop-ui/components/berry-thread-view";
import { ImageGeneration, ImageGenerationError, type ImageGenerationState } from "@berry/desktop-ui/components/image-generation";
import type { GeneratedImageView, ImageEditAnnotation } from "@berry/desktop-ui/components/generated-image-gallery";
import type { StreamState, ToolEntry } from "@berry/desktop-ui/components/thread-stream";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { toast } from "sonner";
import type { WebConfig } from "@/lib/config";
import { MentionMenu, useStaticMentions } from "../mention-menu";
import { PromptEditor, type PromptEditorHandle } from "../prompt-editor";
import { fileTypeLabel, formatBytes } from "../library/file-metadata";
import { stableQuestionAnswerMessageId } from "./composer-question-overlay";
import { sessionStreamStore, useSessionStream } from "@/lib/session-stream-store";

const DocumentPreviewModal = React.lazy(async () => ({
  default: (await import("../library/document-preview-modal")).DocumentPreviewModal,
}));

export function Thread({ sessionId, taskId, messages, stream: initialStream, client, config, taskTitles, imageGeneration, onRetryImage, onEditGeneratedImage, onRegenerateGeneratedImage, editTurn, readOnly = false, recoveryRequired = false, activeStatus, cancelTurn, onViewTaskFiles, onLoadOlderMessages, hasOlderMessages = false, loadingOlderMessages = false, scrollRequest = 0 }: {
  sessionId: string;
  taskId: string;
  messages: Message[];
  stream: StreamState;
  client: BerryApiClient | null;
  config: WebConfig;
  taskTitles: string[];
  imageGeneration?: ImageGenerationState | null;
  onRetryImage?: ((prompt: string) => void) | undefined;
  onEditGeneratedImage?: ((image: GeneratedImageView, instruction: string, annotations: ImageEditAnnotation[]) => void | Promise<void>) | undefined;
  onRegenerateGeneratedImage?: ((image: GeneratedImageView, aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9") => void | Promise<void>) | undefined;
  editTurn?: ((message: Message, text: string) => Promise<void>) | undefined;
  readOnly?: boolean;
  recoveryRequired?: boolean;
  activeStatus?: string | undefined;
  cancelTurn: () => Promise<void>;
  onViewTaskFiles?: (() => void) | undefined;
  onLoadOlderMessages?: (() => Promise<boolean> | boolean) | undefined;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  scrollRequest?: number;
}) {
  const observedStream = useSessionStream(sessionId);
  // The prop keeps the first render compatible with hosts that hydrate a
  // replayed stream before the external store is populated. Subsequent token
  // frames always come from the per-session store.
  const stream = sessionStreamStore.has(sessionId) ? observedStream : initialStream;
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [selectedAttachment, setSelectedAttachment] = React.useState<StoredFile | null>(null);
  const threadRef = React.useRef<HTMLDivElement>(null);
  const messagesRef = React.useRef(messages);
  const hasOlderMessagesRef = React.useRef(hasOlderMessages);
  const searchGenerationRef = React.useRef(0);
  const searchSessionRef = React.useRef(sessionId);
  if (searchSessionRef.current !== sessionId) {
    // Invalidate a pending search during render so a session switch cannot
    // race the passive effect below and let the old search inspect new rows.
    searchSessionRef.current = sessionId;
    searchGenerationRef.current += 1;
  }
  messagesRef.current = messages;
  hasOlderMessagesRef.current = hasOlderMessages;
  React.useEffect(() => {
    searchGenerationRef.current += 1;
    return () => { searchGenerationRef.current += 1; };
  }, [sessionId]);
  React.useLayoutEffect(() => {
    if (scrollRequest === 0) return;
    let nextFrame = window.requestAnimationFrame(() => {
      const viewport = threadRef.current?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
      if (!viewport) return;
      viewport.scrollTop = viewport.scrollHeight;
      nextFrame = window.requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight; });
    });
    return () => window.cancelAnimationFrame(nextFrame);
  }, [scrollRequest]);
  React.useEffect(() => {
    setShowReasoning(window.localStorage.getItem("berry.web.showReasoning") === "true");
    const onSetting = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; value?: string }>).detail;
      if (detail?.key === "berry.web.showReasoning") setShowReasoning(detail.value === "true");
    };
    window.addEventListener("berry:web-setting", onSetting);
    return () => window.removeEventListener("berry:web-setting", onSetting);
  }, []);
  const adapter = React.useMemo<BerryThreadAdapter>(() => ({
    ...(editTurn ? {
      renderUserEditor: (target: Message, close: () => void) => (
        <WebUserMessageEditor
          message={target}
          config={config}
          taskTitles={taskTitles}
          onClose={close}
          onSubmit={async (text) => { await editTurn(target, text); }}
        />
      ),
    } : {}),
    ...(!readOnly && onEditGeneratedImage ? { onEditGeneratedImage } : {}),
    ...(!readOnly && onRegenerateGeneratedImage ? { onRegenerateGeneratedImage } : {}),
    ...(client ? {
      ...(!readOnly ? {
        onApprovalDecide: async (approval, decision) => {
          if (decision === "abort") {
            await cancelTurn();
            return;
          }
          await client.decideApproval(approval.approvalId, { decision });
        },
        onQuestionAnswer: async (question, answer, selectedOptions) => {
          const answerMessageId = await stableQuestionAnswerMessageId(question.questionId);
          await client.appendMessage(sessionId, {
            messageId: answerMessageId,
            role: "user",
            parts: [{ kind: "text", content: answer }],
          });
          await client.answerQuestion(question.questionId, {
            answer,
            answerMessageId,
            selectedOptions,
          });
        },
      } : {}),
      onOpenAttachment: async (attachment) => {
        if (!attachment.fileId) return;
        try {
          setSelectedAttachment(await client.getFile(attachment.fileId));
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : "Unable to open this file");
        }
      },
      onOpenArtifact: async (artifact) => {
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const page = await client.listFiles({ taskId, limit: 100 });
            const file = page.items.find((item) => item.name === artifact.name || item.originalName === artifact.name);
            if (file) {
              setSelectedAttachment(file);
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
          throw new Error(`${artifact.name} is still being prepared. Try again in a moment.`);
        } catch (cause) {
          toast.error(cause instanceof Error ? cause.message : "Unable to open this file");
        }
      },
      ...(onViewTaskFiles ? { onViewTaskFiles } : {}),
    } : {}),
  }), [cancelTurn, client, config, editTurn, onEditGeneratedImage, onRegenerateGeneratedImage, onViewTaskFiles, readOnly, sessionId, taskId, taskTitles]);
  const activeImageTool = [...stream.timeline].reverse().find(
    (entry): entry is ToolEntry => entry.kind === "tool" && entry.name === "create_image" && entry.status === "running",
  );
  const imageToolBatch = activeImageTool && Array.isArray(activeImageTool.args?.batch_requests)
    ? activeImageTool.args.batch_requests.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const primaryImageArgs = imageToolBatch[0] ?? activeImageTool?.args;
  const requestedAspectRatio = primaryImageArgs?.aspect_ratio === "3:4"
    || primaryImageArgs?.aspect_ratio === "4:3"
    || primaryImageArgs?.aspect_ratio === "9:16"
    || primaryImageArgs?.aspect_ratio === "16:9"
    ? primaryImageArgs.aspect_ratio
    : "1:1";
  const visibleGeneration: ImageGenerationState | null = imageGeneration
    ?? (activeImageTool
      ? {
          prompt: typeof primaryImageArgs?.prompt === "string" ? primaryImageArgs.prompt : "requested image",
          status: "generating",
          aspectRatio: requestedAspectRatio,
          batchCount: Math.max(1, imageToolBatch.length),
          partials: activeImageTool.imageProgress ?? [],
        }
      : null);
  const imageGenerationContent = visibleGeneration?.status === "generating" ? (
    <ImageGeneration
      prompt={visibleGeneration.prompt}
      aspectRatio={visibleGeneration.aspectRatio ?? "1:1"}
      batchCount={visibleGeneration.batchCount ?? 1}
      partials={visibleGeneration.partials ?? []}
    />
  ) : visibleGeneration?.status === "error" ? (
    <ImageGenerationError
      prompt={visibleGeneration.prompt}
      message={visibleGeneration.message ?? "The image provider could not complete the request"}
      onRetry={() => onRetryImage?.(visibleGeneration.prompt)}
    />
  ) : null;

  const searchMessages = React.useCallback(async (query: string): Promise<string | null> => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return null;
    const generation = ++searchGenerationRef.current;
    const searchSessionId = searchSessionRef.current;
    const isCurrent = () => generation === searchGenerationRef.current && searchSessionRef.current === searchSessionId;
    for (;;) {
      if (!isCurrent()) return null;
      const currentMessages = messagesRef.current;
      const matchTarget = findMessageSearchTarget(currentMessages, needle);
      if (matchTarget) {
        const match = currentMessages.find((candidate) => candidate.id === matchTarget);
        const matchIndex = match ? currentMessages.indexOf(match) : -1;
        // Assistant rows are grouped under the preceding user turn. Return
        // that owning user id so the virtualizer can address the rendered
        // `${userId}:user`/`${userId}:assistant` row key.
        if (match?.role === "assistant") {
          for (let index = matchIndex - 1; index >= 0; index -= 1) {
            if (currentMessages[index]?.role === "user") return currentMessages[index]!.id;
          }
          // A bounded page can begin in the middle of an assistant group. Load
          // one older page so the owning user row is present before returning
          // a target that the virtualizer can scroll to.
          if (onLoadOlderMessages && hasOlderMessagesRef.current) {
            const beforeLength = currentMessages.length;
            const loaded = await onLoadOlderMessages();
            if (!isCurrent()) return null;
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            if (loaded && messagesRef.current.length > beforeLength) continue;
          }
          // Never return a raw assistant id when its owning user row could not
          // be materialized. BerryThreadView has no row key for that orphan,
          // so leaving it as the target would strand the search UI in a stale
          // pending state with no visible result or error.
          return null;
        }
        return matchTarget;
      }
      if (!onLoadOlderMessages || !hasOlderMessagesRef.current) return null;
      const beforeLength = currentMessages.length;
      const loaded = await onLoadOlderMessages();
      if (!isCurrent()) return null;
      if (!loaded) return null;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (messagesRef.current.length <= beforeLength) return null;
    }
    return null;
  }, [onLoadOlderMessages]);

  return (
    <div ref={threadRef} className="berry-web-thread contents" data-testid="web-task-thread">
      <BerryThreadView
        sessionId={sessionId}
        taskId={taskId}
        stream={stream}
        messages={messages}
        showTodos={false}
        showQuestions={false}
        showPendingTurnActivity
        activeStatus={activeStatus}
        showReasoning={showReasoning}
        {...(recoveryRequired ? { latestTurnError: "Something interrupted this response." } : {})}
        adapter={adapter}
        liveContent={imageGenerationContent}
        {...(onLoadOlderMessages ? { onLoadOlderMessages } : {})}
        hasOlderMessages={hasOlderMessages}
        loadingOlderMessages={loadingOlderMessages}
        {...(onLoadOlderMessages ? { onSearchMessages: searchMessages } : {})}
      />
      {selectedAttachment ? (
        <React.Suspense fallback={null}>
          <DocumentPreviewModal file={selectedAttachment} onOpenChange={(open) => { if (!open) setSelectedAttachment(null); }} />
        </React.Suspense>
      ) : null}
    </div>
  );
}

/** Inline user-message editor (shared frame + web Lexical editor). */
function WebUserMessageEditor({ message: target, config, taskTitles, onClose, onSubmit }: {
  message: Message;
  config: WebConfig;
  taskTitles: string[];
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [value, setValue] = React.useState(() => fullUserText(target));
  const [submitting, setSubmitting] = React.useState(false);
  const editorRef = React.useRef<PromptEditorHandle>(null);
  const mentions = useStaticMentions({ editorRef, config, taskTitles });
  const attachments = React.useMemo(() => target.parts.flatMap((part) => {
    if (part.kind !== "attachment") return [];
    const parsed = MessageAttachmentContentSchema.safeParse(part.content);
    return parsed.success ? [parsed.data] : [];
  }), [target]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to resend the edited message");
      setSubmitting(false);
    }
  };

  return (
    <BerryUserEditorFrame>
      {attachments.length > 0 ? (
        <AttachmentGroup className="mb-2 flex-wrap">
          {attachments.map((attachment) => (
            <Attachment key={attachment.fileId ?? attachment.name} className="w-fit max-w-[min(100%,420px)] flex-nowrap border-0 bg-card shadow-[var(--berry-ring-subtle)]">
              <AttachmentMedia className="bg-transparent"><FileTypeIcon path={attachment.name} className="size-10" /></AttachmentMedia>
              <AttachmentContent className="min-w-0">
                <AttachmentTitle title={attachment.name}>{attachment.name}</AttachmentTitle>
                <AttachmentDescription>{fileTypeLabel(attachment)} · {formatBytes(attachment.size)}</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ))}
        </AttachmentGroup>
      ) : null}
      <MentionMenu controller={mentions} />
      <PromptEditor
        ref={editorRef}
        autoFocus
        initialText={value}
        mentions={mentions}
        onChange={setValue}
        onSubmit={() => void submit()}
        onEscape={onClose}
        placeholder="Edit your message…"
        testId="message-editor-input"
      />
      <div className="berry-user-editor-footer mt-1 flex items-center justify-between">
        <span aria-hidden />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Cancel edit" onClick={onClose} disabled={submitting}>
            <X size={15} />
          </Button>
          <Button
            size="icon-sm"
            aria-label="Send edited message"
            onClick={() => void submit()}
            disabled={submitting || !value.trim()}
            className="rounded-full bg-white text-black hover:bg-white/90"
          >
            <ArrowUp size={15} />
          </Button>
        </div>
      </div>
    </BerryUserEditorFrame>
  );
}
