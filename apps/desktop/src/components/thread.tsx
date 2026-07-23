import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentStreamEvent, Message, ModelProvider, ReasoningLevel, Session } from "@berry/shared";
import { ArrowUp, Plus, X } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  BerryThreadView,
  BerryUserEditorFrame,
  fullUserText,
  isImageMessagePart,
  type BerryThreadAdapter,
} from "@berry/desktop-ui/components/berry-thread-view";
import { cn } from "@berry/desktop-ui/lib/utils";

import { host, useHostEvent, useWorkbench } from "@/lib/berry";
import {
  ComposerAttachmentList,
  useComposerAttachments,
  useStartTurn,
  type ComposerAttachment,
} from "@/components/composer";
import { PromptEditor, type PromptEditorHandle } from "@/components/prompt-editor";
import { useMentions, MentionMenu } from "@/components/mention-menu";
import { setActivityWorkspaceRoot } from "@/components/thread-activity";
import { IDLE, reduceStream, reduceStreamDeltas, type StreamState } from "@/components/thread-stream";

interface TurnState {
  active: boolean;
  turnId: string | null;
  bufferedEvents: AgentStreamEvent[];
  replayOnly?: boolean;
}

export function useThreadStream(sessionId: string | null) {
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<StreamState>(IDLE);

  // Coalesce high-frequency text/reasoning deltas into one commit per animation
  // frame. Per-token setState forced a full re-render + ReactMarkdown re-parse +
  // a scroll correction on every token (bursty over the WKWebView bridge); at
  // ≤60/s it stays smooth. Non-delta events flush the buffer first to preserve
  // ordering (e.g. message.start clearing text after prior text is applied).
  const pendingText = React.useRef("");
  const pendingReasoning = React.useRef("");
  const rafId = React.useRef<number | null>(null);
  const flushDeltas = React.useCallback(() => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    const text = pendingText.current;
    const reasoning = pendingReasoning.current;
    if (!text && !reasoning) return;
    pendingText.current = "";
    pendingReasoning.current = "";
    setState((current) => reduceStreamDeltas(current, { reasoning, text }));
  }, []);

  const settle = React.useCallback(() => {
    if (!sessionId) return;
    void queryClient
      .refetchQueries({ queryKey: ["session.messages", sessionId] })
      .then(() =>
        setState((current) =>
          current.turnActive || current.text || current.reasoning || current.timeline.length > 0 || current.error
            ? current
            : { ...IDLE, timeline: [] },
        ),
      );
  }, [queryClient, sessionId]);

  // Recovery path for missed push events: if the host says no turn is
  // running, drop live state and render the persisted messages instead.
  const reconcile = React.useCallback(() => {
    if (!sessionId) return;
    void host
      .call<TurnState>("agent.turnState", { sessionId })
      .then((turnState) => {
        if (turnState.active && !turnState.replayOnly) return;
        if (turnState.replayOnly && turnState.bufferedEvents.length > 0) {
          setState(turnState.bufferedEvents.reduce(reduceStream, IDLE));
        }
        setState((current) => (current.turnActive ? { ...current, turnActive: false, approval: null, question: null } : current));
        settle();
      })
      .catch(() => {});
  }, [sessionId, settle]);

  useHostEvent((event) => {
    if (
      event.type === "task.updated" &&
      event.task.activeSessionId === sessionId &&
      (event.task.status === "completed" || event.task.status === "failed" || event.task.status === "cancelled")
    ) {
      flushDeltas();
      reconcile();
      return;
    }
    if (event.type !== "agent.event" || event.sessionId !== sessionId) return;
    const streamEvent = event.event;
    if (streamEvent.kind === "message.delta") {
      if (streamEvent.channel === "reasoning") pendingReasoning.current += streamEvent.delta;
      else pendingText.current += streamEvent.delta;
      if (rafId.current == null) rafId.current = requestAnimationFrame(flushDeltas);
      return;
    }
    // Any non-delta event: drain buffered deltas first, then apply the event.
    flushDeltas();
    setState((current) => reduceStream(current, streamEvent));
    if (streamEvent.kind === "turn.end") settle();
  });

  React.useEffect(() => {
    let cancelled = false;
    setState(IDLE);
    // Drop any deltas buffered for the previous session.
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
    rafId.current = null;
    pendingText.current = "";
    pendingReasoning.current = "";
    if (!sessionId) {
      return () => {
        cancelled = true;
      };
    }
    void host
      .call<TurnState>("agent.turnState", { sessionId })
      .then((turnState) => {
        if (cancelled) return;
        if (turnState.active || turnState.replayOnly) {
          setState(turnState.bufferedEvents.reduce(reduceStream, IDLE));
          if (!turnState.active) settle();
        } else {
          void queryClient.refetchQueries({ queryKey: ["session.messages", sessionId] });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (rafId.current != null) cancelAnimationFrame(rafId.current);
      rafId.current = null;
    };
  }, [sessionId, queryClient]);

  // Fallback poll while a turn looks active so a missed turn.end cannot leave
  // the thread stuck on "Thinking..." after the host has finished.
  React.useEffect(() => {
    if (!sessionId || !state.turnActive) return;
    const timer = window.setInterval(reconcile, 2000);
    return () => window.clearInterval(timer);
  }, [sessionId, state.turnActive, reconcile]);

  return state;
}

interface ThreadProps {
  sessionId: string;
  taskId?: string;
  stream?: StreamState;
  density?: "full" | "compact";
  autoScroll?: boolean;
}

export function Thread({ sessionId, taskId, stream, density = "full", autoScroll = true }: ThreadProps) {
  if (stream) return <ThreadView sessionId={sessionId} taskId={taskId} stream={stream} density={density} autoScroll={autoScroll} />;
  return <ThreadWithOwnedStream sessionId={sessionId} taskId={taskId} density={density} autoScroll={autoScroll} />;
}

function ThreadWithOwnedStream({ sessionId, taskId, density, autoScroll }: { sessionId: string; taskId?: string; density: "full" | "compact"; autoScroll: boolean }) {
  const stream = useThreadStream(sessionId);
  return <ThreadView sessionId={sessionId} taskId={taskId} stream={stream} density={density} autoScroll={autoScroll} />;
}

function ThreadView({ sessionId, taskId, stream, density, autoScroll }: { sessionId: string; taskId?: string; stream: StreamState; density: "full" | "compact"; autoScroll: boolean }) {
  const queryClient = useQueryClient();
  const { activeWorkspace, openTask } = useWorkbench();
  React.useEffect(() => {
    setActivityWorkspaceRoot(activeWorkspace?.path ?? null);
  }, [activeWorkspace?.path]);
  const messagesQuery = useQuery({
    queryKey: ["session.messages", sessionId],
    queryFn: () => host.call<Message[]>("session.messages", { sessionId }),
  });
  const showReasoningQuery = useQuery({
    queryKey: ["settings.get", "thread.showReasoning"],
    queryFn: () => host.call<boolean | null>("settings.get", { key: "thread.showReasoning" }),
  });
  const showTodosQuery = useQuery({
    queryKey: ["settings.get", "thread.showTodos"],
    queryFn: () => host.call<boolean | null>("settings.get", { key: "thread.showTodos" }),
  });
  const messages = messagesQuery.data ?? [];
  const showReasoning = showReasoningQuery.data === true;
  const showTodos = showTodosQuery.data !== false;

  const adapter = React.useMemo<BerryThreadAdapter>(
    () => ({
      ...(taskId
        ? {
            renderUserEditor: (message: Message, close: () => void) => (
              <UserMessageEditor message={message} sessionId={sessionId} taskId={taskId} onClose={close} />
            ),
            onDeleteUserMessage: async (message: Message) => {
              await host.call("session.rewind", { sessionId, entryId: message.id });
              await queryClient.invalidateQueries({ queryKey: ["session.messages", sessionId] });
              await queryClient.invalidateQueries({ queryKey: ["task.list"] });
              toast.success("Message and later responses deleted");
            },
          }
        : {}),
      onFork: async (boundaryMessageId) => {
        await host.call<{ sessionId: string }>("session.fork", {
          sessionId,
          ...(boundaryMessageId ? { entryId: boundaryMessageId } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: ["task.list"] });
        await queryClient.invalidateQueries({ queryKey: ["session.get"] });
        await queryClient.invalidateQueries({ queryKey: ["session.messages"] });
        if (taskId) openTask(taskId);
        toast.success("Fork created");
      },
      onApprovalDecide: async (approval, decision) => {
        await host.call("approval.decide", { id: approval.approvalId, decision, sessionId });
      },
      onQuestionAnswer: async (question, answer, selectedOptions) => {
        await host.call("question.answer", { id: question.questionId, answer, selectedOptions });
      },
    }),
    [openTask, queryClient, sessionId, taskId],
  );

  return (
    <BerryThreadView
      sessionId={sessionId}
      {...(taskId ? { taskId } : {})}
      stream={stream}
      messages={messages}
      density={density}
      autoScroll={autoScroll}
      showReasoning={showReasoning}
      showTodos={showTodos}
      navigatorInset={16}
      adapter={adapter}
    />
  );
}

function editableAttachmentsFromMessage(message: Message): ComposerAttachment[] {
  return message.parts.filter(isImageMessagePart).map((part, index) => {
    const dataUrl = String(part.content ?? "");
    const mediaType = mediaTypeFromDataUrl(dataUrl) ?? "image/png";
    return {
      id: part.id || `edited-image-${index}`,
      name: `image-${index + 1}.${extensionForMediaType(mediaType)}`,
      mediaType,
      size: dataUrlByteSize(dataUrl),
      state: "done",
      sourceKind: "upload",
      dataUrl,
    };
  });
}

function mediaTypeFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? null;
}

function dataUrlByteSize(dataUrl: string): number {
  const encoded = dataUrl.split(",", 2)[1]?.replace(/\s/g, "") ?? "";
  if (!encoded) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
}

/**
 * Inline editor shown when a user clicks Edit on their message (Berry-style):
 * a composer-like box prefilled with the message. Submitting rewinds the turn
 * and resubmits the edited text; every message after it is dropped.
 */
function UserMessageEditor({
  message,
  sessionId,
  taskId,
  onClose,
}: {
  message: Message;
  sessionId: string;
  taskId: string;
  onClose: () => void;
}) {
  const startTurn = useStartTurn();
  const { activeWorkspace } = useWorkbench();
  const [value, setValue] = React.useState(() => fullUserText(message));
  const [submitting, setSubmitting] = React.useState(false);
  const [draggingFiles, setDraggingFiles] = React.useState(false);
  const editorRef = React.useRef<PromptEditorHandle>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const mentions = useMentions({ editorRef, workspaceId: activeWorkspace?.id, taskId });
  const initialAttachments = React.useMemo(() => editableAttachmentsFromMessage(message), [message]);
  const { attachments, addFiles, chooseFiles, handlePaste, removeAttachment, hasReadyAttachment, hasProcessingAttachment } =
    useComposerAttachments(initialAttachments, activeWorkspace?.id);

  // The Tauri shell only injects the keychain API key into agent.turn when the
  // params carry the provider's credentialRef, so resolve it like the composer.
  const providersQuery = useQuery({
    queryKey: ["model.provider.list"],
    queryFn: () => host.call<ModelProvider[]>("model.provider.list"),
  });
  const sessionQuery = useQuery({
    queryKey: ["session.get", sessionId],
    queryFn: () => host.call<Session>("session.get", { sessionId }),
  });
  const reasoningQuery = useQuery({
    queryKey: ["settings.get", "agent.reasoning"],
    queryFn: () => host.call<ReasoningLevel | null>("settings.get", { key: "agent.reasoning" }),
  });
  const providers = (providersQuery.data ?? []).filter((provider) => provider.enabled);
  const sessionProvider =
    providers.find((provider) => provider.id === sessionQuery.data?.modelProviderId) ?? providers[0];

  const submit = async () => {
    const trimmed = value.trim();
    if ((trimmed.length === 0 && !hasReadyAttachment) || hasProcessingAttachment || submitting) return;
    setSubmitting(true);
    try {
      await startTurn.mutateAsync({
        taskId,
        sessionId,
        replaceFromMessageId: message.id,
        submission: {
          input: trimmed,
          attachments,
          permissionMode: sessionQuery.data?.permissionMode ?? "ask",
          reasoning: reasoningQuery.data ?? "medium",
          providerId: sessionProvider?.id ?? sessionQuery.data?.modelProviderId ?? null,
          model: sessionQuery.data?.model ?? sessionProvider?.defaultModel ?? null,
          credentialRef: sessionProvider?.credentialRef ?? null,
          createInWorktree: false,
        },
      });
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <BerryUserEditorFrame
      className={cn(draggingFiles && "ring-1 ring-ring")}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDraggingFiles(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDraggingFiles(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <MentionMenu controller={mentions} placement="below" />
      <ComposerAttachmentList attachments={attachments} onRemove={removeAttachment} className="px-3 pt-2" />
      <PromptEditor
        ref={editorRef}
        autoFocus
        initialText={value}
        mentions={mentions}
        onChange={setValue}
        onSubmit={() => void submit()}
        onEscape={onClose}
        onPasteEvent={handlePaste}
        placeholder="Edit your message…"
        testId="message-editor-input"
      />
      <div className="berry-user-editor-footer mt-1 flex items-center justify-between">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Add attachment"
          onClick={() => void chooseFiles(() => fileInputRef.current?.click())}
          disabled={submitting}
        >
          <Plus />
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Cancel edit" onClick={onClose} disabled={submitting}>
            <X />
          </Button>
          <Button
            size="icon-sm"
            aria-label="Send edited message"
            onClick={() => void submit()}
            disabled={submitting || hasProcessingAttachment || (value.trim().length === 0 && !hasReadyAttachment)}
            className="rounded-full bg-white text-black hover:bg-white/90"
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </BerryUserEditorFrame>
  );
}
