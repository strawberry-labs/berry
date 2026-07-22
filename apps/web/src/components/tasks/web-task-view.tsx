import * as React from "react";
import { ArrowUp, X } from "lucide-react";
import { type BerryApiClient } from "@berry/api-client";
import { MessageAttachmentContentSchema, type ConversationKind, type Message, type StoredFile } from "@berry/shared";
import { BerryThreadView, BerryUserEditorFrame, fullUserText, type BerryThreadAdapter } from "@berry/desktop-ui/components/berry-thread-view";
import { ImageGeneration, ImageGenerationError, type ImageGenerationState } from "@berry/desktop-ui/components/image-generation";
import type { StreamState, ToolEntry } from "@berry/desktop-ui/components/thread-stream";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { toast } from "sonner";
import type { WebConfig } from "@/lib/config";
import { MentionMenu, useStaticMentions } from "../mention-menu";
import { PromptEditor, type PromptEditorHandle } from "../prompt-editor";
import { FileViewerModal, fileTypeLabel, formatBytes } from "../library/file-viewer-modal";

export function Thread({ sessionId, taskId, messages, stream, mode, client, config, taskTitles, imageGeneration, onRetryImage, editTurn, cancelTurn, onViewTaskFiles }: {
  sessionId: string;
  taskId: string;
  messages: Message[];
  stream: StreamState;
  mode: ConversationKind;
  client: BerryApiClient | null;
  config: WebConfig;
  taskTitles: string[];
  imageGeneration?: ImageGenerationState | null;
  onRetryImage?: ((prompt: string) => void) | undefined;
  editTurn?: ((message: Message, text: string) => Promise<void>) | undefined;
  cancelTurn: () => Promise<void>;
  onViewTaskFiles?: (() => void) | undefined;
}) {
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [selectedAttachment, setSelectedAttachment] = React.useState<StoredFile | null>(null);
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
    ...(client ? {
      onApprovalDecide: async (approval, decision) => {
        if (decision === "abort") {
          await cancelTurn();
          return;
        }
        await client.decideApproval(approval.approvalId, { decision });
      },
      onQuestionAnswer: async (question, answer, selectedOptions) => {
        await client.answerQuestion(question.questionId, { answer, selectedOptions });
      },
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
  }), [cancelTurn, client, config, editTurn, onViewTaskFiles, taskId, taskTitles]);
  const activeImageTool = [...stream.timeline].reverse().find(
    (entry): entry is ToolEntry => entry.kind === "tool" && entry.name === "image_generation" && entry.status === "running",
  );
  const visibleGeneration: ImageGenerationState | null = imageGeneration
    ?? (activeImageTool
      ? { prompt: typeof activeImageTool.args?.prompt === "string" ? activeImageTool.args.prompt : "requested image", status: "generating" }
      : null);

  return (
    <div className="berry-web-thread contents" data-testid="web-thread" data-mode={mode}>
      <BerryThreadView
        sessionId={sessionId}
        taskId={taskId}
        stream={stream}
        messages={messages}
        showTodos={false}
        showQuestions={false}
        showPendingTurnActivity
        showReasoning={showReasoning}
        adapter={adapter}
      />
      {visibleGeneration?.status === "generating" ? <ImageGeneration prompt={visibleGeneration.prompt} /> : null}
      {visibleGeneration?.status === "error" ? (
        <ImageGenerationError
          prompt={visibleGeneration.prompt}
          message={visibleGeneration.message ?? "The image provider could not complete the request"}
          onRetry={() => onRetryImage?.(visibleGeneration.prompt)}
        />
      ) : null}
      <FileViewerModal file={selectedAttachment} onOpenChange={(open) => { if (!open) setSelectedAttachment(null); }} />
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
