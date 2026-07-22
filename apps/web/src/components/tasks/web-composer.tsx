import * as React from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { type BerryApiClient } from "@berry/api-client";
import { messageAttachmentContent, parseSlashCommand, type AttachmentInput, type Message, type QueuedFollowUp, type ReasoningLevel, type Task } from "@berry/shared";
import { BerryComposerFrame } from "@berry/desktop-ui/components/berry-composer-frame";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { reduceStream } from "@berry/desktop-ui/components/thread-stream";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { AtSign, Brain, Check, ChevronDown, FileText, Folder, Hash, ImagePlus, SlashSquare } from "@berry/desktop-ui/lib/icons";
import type { WebConfig } from "@/lib/config";
import { MentionMenu, useStaticMentions } from "../mention-menu";
import { PromptEditor, type PromptEditorHandle } from "../prompt-editor";

interface PendingFileUpload {
  id: string;
  file: File;
  uploadedBytes: number;
  ratio: number;
  state: "uploading" | "error";
  error?: string;
}

export function Composer({
  config,
  activeTask,
  taskTitles,
  client,
  workspacePath,
  model,
  onModelChange,
  onUserMessage,
  onUserMessagePersisted,
  onAssistantMessage,
  onEvent,
  runTurn,
  onCancel,
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
}: {
  config: WebConfig;
  activeTask: Task | null;
  taskTitles: string[];
  client: BerryApiClient | null;
  workspacePath: string;
  model: string;
  onModelChange: (model: string) => void;
  onUserMessage: (text: string, sessionId: string, taskId: string, attachments?: AttachmentInput[]) => string | void;
  onUserMessagePersisted: (sessionId: string, optimisticMessageId: string, message: Message) => void;
  onAssistantMessage: (text: string, sessionId: string, taskId: string) => void;
  onEvent: (sessionId: string, event: Parameters<typeof reduceStream>[1]) => void;
  runTurn: (task: Task, params: { input: string; attachments?: AttachmentInput[] | undefined }) => Promise<void>;
  onCancel: () => void;
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
}) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const working = busy || streaming;
  const [attachments, setAttachments] = React.useState<AttachmentInput[]>([]);
  const [pendingUploads, setPendingUploads] = React.useState<PendingFileUpload[]>([]);
  const [uploadError, setUploadError] = React.useState("");
  const [fileDragActive, setFileDragActive] = React.useState(false);
  const fileDragDepthRef = React.useRef(0);
  const editorRef = React.useRef<PromptEditorHandle>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
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
  const mentions = useStaticMentions({ editorRef, config, taskTitles, onSelectItem: onMentionSelected });
  React.useEffect(() => {
    const pending = window.localStorage.getItem("berry.web.pendingPrompt");
    if (!pending) return;
    window.localStorage.removeItem("berry.web.pendingPrompt");
    setText(pending);
    window.requestAnimationFrame(() => editorRef.current?.insertText(pending));
  }, []);
  const composerModels = React.useMemo(
    () => config.providers.flatMap((provider) => provider.models.map((item) => ({ id: item.id, label: item.name ?? item.id }))).filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index),
    [config.providers],
  );

  const submit = React.useCallback(async () => {
    if (pendingUploads.some((upload) => upload.state === "uploading")) return;
    const input = text.trim() || (attachments.length > 0 ? "Review the attached files." : "");
    if (!input) return;
    const command = parseSlashCommand(input);
    if (command) {
      setUploadError("");
      try {
        await onCommand(command.name, command.args);
        setText("");
        editorRef.current?.clear();
      } catch (cause) {
        setUploadError(cause instanceof Error ? cause.message : `Unable to run /${command.name}`);
      }
      return;
    }
    if (working && activeTask?.activeSessionId && client) {
      try {
        const queueMessages = window.localStorage.getItem("berry.web.queueMessages") !== "false";
        if (queueMessages) {
          const followUp = await client.followUpTurn(activeTask.activeSessionId, { input, attachments });
          onQueuedFollowUp(followUp);
        } else {
          await client.steerTurn(activeTask.activeSessionId, { input, attachments });
        }
        const optimisticMessageId = onUserMessage(input, activeTask.activeSessionId, activeTask.id, attachments);
        // Queue/steer endpoints persist the user message themselves. Confirm
        // that exact row immediately so turn completion cannot leave both the
        // local bubble and its database copy on screen.
        if (optimisticMessageId) {
          const persisted = [...await client.listMessages(activeTask.activeSessionId)].reverse().find((message) => message.role === "user");
          if (persisted) onUserMessagePersisted(activeTask.activeSessionId, optimisticMessageId, persisted);
        }
        setText("");
        editorRef.current?.clear();
        setAttachments([]);
      } catch (cause) {
        setUploadError(cause instanceof Error ? cause.message : "Unable to steer the running task");
      }
      return;
    }
    if (working && activeTask?.activeSessionId && !client) {
      const sessionId = activeTask.activeSessionId;
      if (window.localStorage.getItem("berry.web.queueMessages") !== "false") {
        const now = new Date().toISOString();
        onQueuedFollowUp({ id: `follow_up_${Date.now()}`, taskId: activeTask.id, sessionId, ordinal: queuedFollowUps.length, input, attachments, status: "queued", error: null, createdAt: now, updatedAt: now });
      }
      onUserMessage(input, sessionId, activeTask.id, attachments);
      setText("");
      editorRef.current?.clear();
      setAttachments([]);
      return;
    }
    if (working) return;
    const task = activeTask ?? await onCreateTask({ title: input.slice(0, 42) });
    if (!task?.activeSessionId) return;
    const sessionId = task.activeSessionId;
    const customInstructions = variant === "home" ? window.localStorage.getItem("berry.web.customInstructions")?.trim() : "";
    const runtimeInput = customInstructions ? `${input}\n\nUser instructions:\n${customInstructions}` : input;
    setBusy(true);
    setUploadError("");
    const optimisticMessageId = onUserMessage(input, sessionId, task.id, attachments);
    setText("");
    editorRef.current?.clear();
    try {
      if (client) {
        const persistedUserMessage = await client.appendMessage(sessionId, {
          role: "user",
          parts: [
            { kind: "text", content: input },
            ...attachments.map((attachment) => ({ kind: "attachment" as const, content: messageAttachmentContent(attachment) })),
          ],
        });
        if (optimisticMessageId) onUserMessagePersisted(sessionId, optimisticMessageId, persistedUserMessage);
        const sent = attachments;
        setAttachments([]);
        await runTurn(task, { input: runtimeInput, ...(sent.length > 0 ? { attachments: sent } : {}) });
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
  }, [activeTask, attachments, client, onAssistantMessage, onCommand, onCreateTask, onEvent, onQueuedFollowUp, onUserMessage, onUserMessagePersisted, pendingUploads, queuedFollowUps.length, runTurn, text, variant, working]);

  const addFiles = React.useCallback(async (files: FileList | readonly File[] | null) => {
    if (!files?.length) return;
    setUploadError("");
    try {
      const selected = Array.from(files);
      if (attachments.length + pendingUploads.length + selected.length > 100) throw new Error("Attach no more than 100 files to one message.");
      const queued = selected.map((file): PendingFileUpload => ({ id: globalThis.crypto.randomUUID(), file, uploadedBytes: 0, ratio: 0, state: "uploading" }));
      setPendingUploads((current) => [...current, ...queued]);
      await mapWithConcurrency(queued, 2, async (pending) => {
        try {
          const attachment: AttachmentInput = client
            ? await client.uploadFile(pending.file, {
              ...(activeTask ? { taskId: activeTask.id, ...(activeTask.activeSessionId ? { sessionId: activeTask.activeSessionId } : {}) } : {}),
              onProgress: ({ ratio, uploadedBytes }) => setPendingUploads((current) => current.map((item) => item.id === pending.id ? { ...item, ratio, uploadedBytes } : item)),
            }).then((stored) => {
              return {
                id: stored.id,
                fileId: stored.id,
                name: stored.name,
                mediaType: stored.mediaType,
                size: stored.size,
                sourceKind: "object-storage",
              } satisfies AttachmentInput;
            })
            : await fileToAttachment(pending.file);
          setAttachments((current) => [...current, attachment].slice(0, 100));
          setPendingUploads((current) => current.filter((item) => item.id !== pending.id));
          return attachment;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Upload failed";
          setPendingUploads((current) => current.map((item) => item.id === pending.id ? { ...item, state: "error", error: message } : item));
          throw cause;
        }
      });
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "Unable to attach these files");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [activeTask, attachments, client, pendingUploads.length]);

  const handlePaste = React.useCallback((event: ClipboardEvent) => {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    void addFiles(files);
    return true;
  }, [addFiles]);

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

  return (
    <div className={variant === "thread" ? "berry-thread-composer-wrap mx-auto max-w-full px-4 pb-5" : "w-full"}>
      <BerryComposerFrame
        variant={variant}
        {...(fileDragActive ? { className: "outline outline-2 -outline-offset-2 outline-[var(--berry-focus)]" } : {})}
        shellProps={{
          onDragEnter: handleDragEnter,
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
        }}
        before={<MentionMenu controller={mentions} />}
        header={variant === "home" ? (
        <div className="berry-composer-meta flex min-w-0 items-center gap-2 px-2 pt-2">
          <span className="berry-pill-control flex min-w-0 max-w-[260px] items-center gap-1.5 px-2.5" title={workspacePath}><Folder className="shrink-0" /><span className="truncate">{workspacePath.split("/").filter(Boolean).at(-1) ?? "Workspace"}</span></span>
        </div>
      ) : null}
      >
        {fileDragActive ? (
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center gap-2 rounded-[18px] bg-card/95 text-sm font-medium text-card-foreground shadow-[var(--berry-ring-strong)]" role="status">
            <FileText />
            <span>Drop files to attach</span>
          </div>
        ) : null}
        <div className="berry-composer-input flex min-h-[96px] flex-1 flex-col">
        {variant === "thread" && queuedFollowUps.length > 0 ? (
          <div className="grid gap-1 px-3 pt-2" aria-label="Queued follow-ups">
            {queuedFollowUps.map((followUp) => (
              <div key={followUp.id} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate">{followUp.input}</span>
                <span className="text-muted-foreground">{followUp.status}</span>
                {followUp.status === "failed" ? <Button variant="ghost" size="sm" onClick={() => void onRetryFollowUp(followUp)}>Retry</Button> : null}
                <Button variant="ghost" size="sm" onClick={() => void onRemoveFollowUp(followUp)}>Remove</Button>
              </div>
            ))}
          </div>
        ) : null}
        {attachments.length > 0 || pendingUploads.length > 0 ? (
          <AttachmentGroup className="px-3 pt-2">
            {pendingUploads.map((upload) => (
              <Attachment size="sm" state={upload.state} style={{ width: 280, maxWidth: "100%" }} className="flex-nowrap rounded-[22px] border-0 bg-card shadow-[var(--berry-ring-subtle)]" key={upload.id}>
                <AttachmentMedia className="!w-10 rounded-full bg-transparent">
                  {upload.state === "error" ? <FileTypeIcon path={upload.file.name} className="size-10" /> : null}
                  {upload.state === "uploading" ? <UploadProgressRing ratio={upload.ratio} /> : null}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{upload.file.name}</AttachmentTitle>
                  <AttachmentDescription>{upload.state === "error" ? (upload.error ?? "Upload failed") : formatFileSize(upload.uploadedBytes)}</AttachmentDescription>
                </AttachmentContent>
                {upload.state === "error" ? <AttachmentActions><AttachmentAction aria-label={`Remove ${upload.file.name}`} onClick={() => setPendingUploads((current) => current.filter((item) => item.id !== upload.id))}>×</AttachmentAction></AttachmentActions> : null}
              </Attachment>
            ))}
            {attachments.map((attachment, index) => (
              <Attachment size="sm" style={{ width: 280, maxWidth: "100%" }} className="flex-nowrap rounded-[22px] border-0 bg-card shadow-[var(--berry-ring-subtle)]" key={attachment.id ?? `${attachment.name}-${index}`}>
                <AttachmentMedia className="!w-10 rounded-full bg-transparent">
                  <FileTypeIcon path={attachment.name} className="size-10" />
                </AttachmentMedia>
                <AttachmentContent><AttachmentTitle>{attachment.name}</AttachmentTitle><AttachmentDescription>{formatFileSize(attachment.size)}</AttachmentDescription></AttachmentContent>
                <AttachmentActions><AttachmentAction aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</AttachmentAction></AttachmentActions>
              </Attachment>
            ))}
          </AttachmentGroup>
        ) : null}
        <div className="berry-composer-editor relative flex-1">
          <PromptEditor
            ref={editorRef}
            placeholder={variant === "home" ? "Ask Berry anything, @ for files or folders, / for commands, # for related conversations" : "Ask for follow-up changes"}
            autoFocus
            mentions={mentions}
            onPasteEvent={handlePaste}
            onChange={setText}
            onSubmit={() => void submit()}
          />
        </div>
        <div className="berry-composer-controls flex min-w-0 flex-nowrap items-center gap-1">
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => void addFiles(event.currentTarget.files)} />
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-lg" className="berry-composer-icon-button size-8 rounded-[9px]" aria-label="Add context"><Plus /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-60"><DropdownMenuItem onClick={() => fileInputRef.current?.click()}><ImagePlus /> Add attachment</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onClick={() => editorRef.current?.insertText("@")}><AtSign /> Insert @ mention</DropdownMenuItem><DropdownMenuItem onClick={() => editorRef.current?.insertText("#")}><Hash /> Insert # conversation</DropdownMenuItem><DropdownMenuItem onClick={() => editorRef.current?.insertText("/")}><SlashSquare /> Insert / command</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <span className="min-w-0 flex-1" />
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="berry-pill-control min-w-0 max-w-[min(42vw,240px)] shrink gap-1.5 text-muted-foreground"><span className="berry-composer-model-label min-w-0 truncate">{composerModels.find((item) => item.id === model)?.label ?? model ?? "Managed model"}</span><ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64"><DropdownMenuLabel>Model</DropdownMenuLabel>{composerModels.map((item) => <DropdownMenuItem key={item.id} onClick={() => onModelChange(item.id)}><span className="truncate">{item.label}</span>{item.id === model ? <Check className="ml-auto" /> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Reasoning level" aria-pressed={reasoning !== "off"} title={`Reasoning ${reasoning}`} className="berry-pill-control gap-1.5"><Brain /><span className="hidden md:inline">{reasoning[0]!.toUpperCase() + reasoning.slice(1)}</span><ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64"><DropdownMenuLabel>Reasoning</DropdownMenuLabel>{(["off", "low", "medium", "high"] as const).map((level) => <DropdownMenuItem key={level} onClick={() => onReasoningChange(level)}><Brain /><span className="capitalize">{level}</span>{level === reasoning ? <Check className="ml-auto" /> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
          {working ? (
            <Button
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
              size="icon-lg"
              variant="secondary"
              disabled={pendingUploads.some((upload) => upload.state === "uploading") || (!text.trim() && attachments.length === 0)}
              onClick={() => void submit()}
              aria-label="Send"
              className="berry-composer-send size-8 rounded-full transition-[background-color,color,box-shadow,opacity,transform] active:scale-[0.96] disabled:opacity-45"
            >
              <ArrowUp size={18} aria-hidden />
            </Button>
          )}
        </div>
        </div>
      </BerryComposerFrame>
      {uploadError ? <p className="composer-error" role="alert">{uploadError}</p> : null}
    </div>
  );
}

function UploadProgressRing({ ratio }: { ratio: number }) {
  const progress = Math.max(0, Math.min(1, ratio));
  return (
    <svg className="pointer-events-none absolute inset-1.5 size-7 -rotate-90 text-muted-foreground" viewBox="0 0 36 36" role="progressbar" aria-label="Uploading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - progress * 100} className="transition-[stroke-dashoffset] duration-150" />
    </svg>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
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
