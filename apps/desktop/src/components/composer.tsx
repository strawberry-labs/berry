import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resolveModelCapabilities, type ContextStats, type ConversationKind, type McpServerConfig, type Message, type ModelProvider, type PermissionMode, type ReasoningLevel, type Session, type Task, type TurnState, type Worktree } from "@berry/shared";
import { toast } from "sonner";
import {
  ArrowUp02,
  AtSign,
  Brain,
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  GitFork,
  Hand,
  Hash,
  ImagePlus,
  NotebookPen,
  Paperclip,
  PencilLine,
  Plus,
  SlashSquare,
  Square,
  X,
  Zap,
} from "@berry/desktop-ui/lib/icons";

import { Button } from "@berry/desktop-ui/components/ui/button";
import { BerryComposerFrame } from "@berry/desktop-ui/components/berry-composer-frame";
import { CircularProgressIndicator } from "@berry/desktop-ui/components/ui/circular-progress-indicator";
import { Toggle } from "@berry/desktop-ui/components/ui/toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@berry/desktop-ui/components/ui/tooltip";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@berry/desktop-ui/components/ui/attachment";
import { cn } from "@berry/desktop-ui/lib/utils";
import { useSquircle } from "@/lib/squircle";

import { callWithApprovalRetry, host, localFilePreviewUrl, pickFiles, useWorkbench } from "@/lib/berry";
import { useMentions, MentionMenu } from "@/components/mention-menu";
import { ModelSelector } from "@/components/model-selector";
import { PromptEditor, type PromptEditorHandle } from "@/components/prompt-editor";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

export interface ComposerAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  state: "processing" | "done" | "error";
  sourceKind: "upload" | "native-path" | "clipboard-text";
  dataUrl?: string | null;
  textContent?: string | null;
  localPath?: string | null;
  error?: string;
  file?: File;
  objectUrl?: string;
}

interface NativeAttachmentInput {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  dataUrl?: string | null;
}

export interface ComposerSubmit {
  input: string;
  attachments: ComposerAttachment[];
  permissionMode: PermissionMode;
  reasoning: ReasoningLevel;
  providerId: string | null;
  model: string | null;
  /** Keychain reference for the provider; the Tauri shell swaps it for the secret. */
  credentialRef: string | null;
  createInWorktree: boolean;
}

export interface QueuedFollowUpChip {
  id: string;
  text: string;
}

interface CommandOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; detail: string; icon: React.ElementType; color?: string }> = [
  { id: "ask", label: "Ask before changes", detail: "Approve file edits and commands", icon: Hand },
  { id: "auto-edit", label: "Edit automatically", detail: "Safe edits apply without asking", icon: PencilLine, color: "var(--berry-mode-auto-edit)" },
  { id: "plan", label: "Plan mode", detail: "Read-only; produce a plan first", icon: NotebookPen, color: "var(--berry-mode-plan)" },
  { id: "full-access", label: "Full access", detail: "Run everything without prompts", icon: Zap, color: "var(--berry-mode-full)" },
];

const REASONING_LEVELS: Array<{ id: ReasoningLevel; label: string; detail: string }> = [
  { id: "off", label: "Off", detail: "No provider thinking request" },
  { id: "low", label: "Low", detail: "Short reasoning budget" },
  { id: "medium", label: "Medium", detail: "Balanced reasoning budget" },
  { id: "high", label: "High", detail: "Deeper reasoning budget" },
];

const MAX_ATTACHMENTS = 8;
const INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const INLINE_TEXT_CHARS = 64 * 1024;
const LARGE_PASTE_CHARS = 5 * 1024;
const TEXT_EXTENSIONS = new Set([
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "mjs",
  "py",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

/** An explicit provider/model pair chosen for upcoming turns. */
export interface ModelSelection {
  providerId: string;
  model: string;
}

const MODEL_SELECTION_KEY = "model.defaultSelection";

export function Composer({
  variant,
  streaming = false,
  onSubmit,
  onCancel,
  allowSubmitWhileStreaming = false,
  autoFocus = true,
  className,
  sessionSelection,
  sessionId,
  taskId,
  conversationKind,
  queuedFollowUps = [],
}: {
  variant: "home" | "thread";
  streaming?: boolean;
  onSubmit: (submission: ComposerSubmit) => void | Promise<void>;
  onCancel?: () => void;
  allowSubmitWhileStreaming?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Provider/model already recorded on the session (thread variant). */
  sessionSelection?: { providerId: string | null; model: string | null } | undefined;
  /** Session to record explicit model picks on (thread variant), so resend
   * paths that bypass the composer (edit-and-resubmit) use the new model. */
  sessionId?: string;
  taskId?: string;
  /** Current presentation profile; selects the matching configured model default. */
  conversationKind?: ConversationKind | null;
  queuedFollowUps?: QueuedFollowUpChip[];
}) {
  const { activeWorkspace, openSettings } = useWorkbench();
  const [input, setInput] = React.useState("");
  const [createInWorktree, setCreateInWorktree] = React.useState(false);
  const editorRef = React.useRef<PromptEditorHandle>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  useSquircle(shellRef, 26);
  // The prompt-box card: interior corners (against the strip) at 22, outer
  // corners matching the shell's 26 so the two clips stay flush.
  useSquircle(
    cardRef,
    variant === "home"
      ? { topLeftCornerRadius: 22, topRightCornerRadius: 22, bottomLeftCornerRadius: 26, bottomRightCornerRadius: 26 }
      : 26,
  );
  const mentions = useMentions({
    editorRef,
    workspaceId: activeWorkspace?.id,
    taskId,
  });

  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>("ask");
  React.useEffect(() => {
    void host.call<PermissionMode | null>("permission.mode.get").then((mode) => {
      if (mode) setPermissionMode(mode);
    });
  }, []);
  const changeMode = (mode: PermissionMode) => {
    setPermissionMode(mode);
    void host.call("permission.mode.set", { mode });
  };
  React.useEffect(() => {
    if (variant !== "home") return;
    const enable = () => setCreateInWorktree(true);
    window.addEventListener("berry:new-worktree-task", enable);
    return () => window.removeEventListener("berry:new-worktree-task", enable);
  }, [variant]);

  const providersQuery = useQuery({
    queryKey: ["model.provider.list"],
    queryFn: () => host.call<ModelProvider[]>("model.provider.list"),
  });
  const providers = (providersQuery.data ?? []).filter((provider) => provider.enabled);

  // Explicit selection wins; then the session's recorded provider/model; then
  // the persisted default; then the first enabled provider. Only an explicit
  // pick is sent with the turn, so untouched sessions keep their own model.
  const [selectedModel, setSelectedModel] = React.useState<ModelSelection | null>(null);
  const globalDefaultSelectionQuery = useQuery({
    queryKey: ["settings", MODEL_SELECTION_KEY],
    queryFn: () => host.call<ModelSelection | null>("settings.get", { key: MODEL_SELECTION_KEY }),
  });
  const modeSelectionKey = conversationKind ? `${MODEL_SELECTION_KEY}.${conversationKind}` : null;
  const modeDefaultSelectionQuery = useQuery({
    queryKey: ["settings", modeSelectionKey],
    queryFn: () => host.call<ModelSelection | null>("settings.get", { key: modeSelectionKey ?? "" }),
    enabled: modeSelectionKey !== null,
  });
  const validSelection = (value: ModelSelection | null | undefined): ModelSelection | null =>
    value && typeof value.providerId === "string" && typeof value.model === "string" ? value : null;
  const persistedSelection = validSelection(modeDefaultSelectionQuery.data) ?? validSelection(globalDefaultSelectionQuery.data);
  const sessionModel =
    sessionSelection?.providerId && sessionSelection.model
      ? { providerId: sessionSelection.providerId, model: sessionSelection.model }
      : null;
  const activeModel =
    selectedModel ??
    sessionModel ??
    (persistedSelection && providers.some((provider) => provider.id === persistedSelection.providerId) ? persistedSelection : null) ??
    (providers[0] ? { providerId: providers[0].id, model: providers[0].defaultModel } : null);
  const activeProvider = providers.find((provider) => provider.id === activeModel?.providerId);
  const activeModelMetadata = activeProvider?.models.find((model) => model.id === activeModel?.model);
  const supportsImageInput =
    (resolveModelCapabilities(activeModelMetadata).vision ?? activeProvider?.capabilities.imageInput) !== false;
  const unsupportedImageMessage = `${activeModel?.model ?? "The selected model"} does not support image input. Choose a vision-capable model to attach images.`;
  const { attachments, addFiles, chooseFiles, clearAttachments, handlePaste, removeAttachment, hasReadyAttachment, hasProcessingAttachment } =
    useComposerAttachments([], activeWorkspace?.id, { supportsImageInput, unsupportedImageMessage });

  const queryClient = useQueryClient();
  const pickModel = (selection: ModelSelection) => {
    setSelectedModel(selection);
    void host.call("settings.set", { key: MODEL_SELECTION_KEY, value: { ...selection } });
    // Record the pick on the session immediately so resend paths that bypass
    // the composer (edit-and-resubmit) run on the newly chosen model too.
    if (sessionId) {
      void host
        .call("session.setModel", { sessionId, providerId: selection.providerId, model: selection.model })
        .then(() => queryClient.invalidateQueries({ queryKey: ["session.get", sessionId] }));
    }
  };

  const branchQuery = useQuery({
    queryKey: ["git.branch", activeWorkspace?.id],
    queryFn: () => host.call<CommandOutput>("git.branch", { workspaceId: activeWorkspace?.id ?? "" }),
    enabled: Boolean(activeWorkspace),
    retry: false,
    staleTime: 30_000,
  });
  const branchName = normalizeBranch(branchQuery.data?.stdout);

  const statsAttachments = React.useMemo(
    () => attachments.filter((attachment) => attachment.state === "done").map(serializeAttachment),
    [attachments],
  );
  const contextStatsQuery = useQuery({
    queryKey: [
      "session.contextStats",
      sessionId,
      activeModel?.providerId ?? null,
      activeModel?.model ?? null,
      input,
      statsAttachments.map((attachment) => `${attachment.id}:${attachment.name}:${attachment.mediaType}:${attachment.size}:${attachment.dataUrl?.length ?? 0}:${attachment.textContent?.length ?? 0}`).join("|"),
    ],
    queryFn: () =>
      host.call<ContextStats>("session.contextStats", {
        sessionId: sessionId ?? "",
        providerId: activeModel?.providerId ?? null,
        model: activeModel?.model ?? null,
        pendingInput: input,
        attachments: statsAttachments,
      }),
    enabled: Boolean(sessionId),
    staleTime: 1500,
  });

  const [reasoning, setReasoning] = React.useState<ReasoningLevel>("medium");
  React.useEffect(() => {
    void host.call<ReasoningLevel | null>("settings.get", { key: "agent.reasoning" }).then((value) => {
      if (value === "off" || value === "low" || value === "medium" || value === "high") setReasoning(value);
    });
  }, []);
  const changeReasoning = (level: ReasoningLevel) => {
    setReasoning(level);
    void host.call("settings.set", { key: "agent.reasoning", value: level });
  };

  const insertToken = (token: string) => {
    editorRef.current?.insertText(token);
  };

  const [draggingFiles, setDraggingFiles] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const canSubmit =
    (input.trim().length > 0 || hasReadyAttachment) &&
    !hasProcessingAttachment &&
    !submitting &&
    (!streaming || allowSubmitWhileStreaming) &&
    Boolean(activeWorkspace);

  const submit = async () => {
    if (!canSubmit) return;
    const submission: ComposerSubmit = {
      input: input.trim(),
      attachments,
      permissionMode,
      reasoning,
      providerId: activeModel?.providerId ?? null,
      model: activeModel?.model ?? null,
      credentialRef: activeProvider?.credentialRef ?? null,
      createInWorktree: variant === "home" && createInWorktree,
    };
    setSubmitting(true);
    try {
      await onSubmit(submission);
      setInput("");
      editorRef.current?.clear();
      clearAttachments();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send message");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BerryComposerFrame
      variant={variant}
      shellRef={shellRef}
      cardRef={cardRef}
      before={<MentionMenu controller={mentions} />}
      shellProps={{
        onDragOver: (event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          setDraggingFiles(true);
        },
        onDragLeave: (event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
        },
        onDrop: (event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDraggingFiles(false);
          addFiles(event.dataTransfer.files);
        },
      }}
      className={cn(draggingFiles && "ring-1 ring-ring", className)}
      header={activeWorkspace && variant === "home" ? (
        <div className="berry-composer-meta flex min-w-0 items-center gap-2">
          <WorkspaceSwitcher>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Switch workspace"
              className="berry-pill-control berry-composer-workspace min-w-0 max-w-[min(48vw,260px)] justify-start gap-1.5 text-[13px] font-medium"
            >
              <Folder />
              <span className="truncate">{activeWorkspace.name}</span>
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </WorkspaceSwitcher>
          <div
            className="berry-composer-branch hidden min-w-0 max-w-44 items-center gap-1.5 rounded-full px-2.5 sm:flex"
            title={branchName}
          >
            <GitBranch className="shrink-0" />
            <span className="truncate">{branchName}</span>
          </div>
          <Toggle
            type="button"
            pressed={createInWorktree}
            onPressedChange={setCreateInWorktree}
            className="berry-pill-control h-10 shrink-0 gap-1.5 active:scale-[0.96] transition-transform"
          >
            <GitFork />
            Worktree
          </Toggle>
        </div>
      ) : null}
    >
      <div className="berry-composer-input flex min-h-[96px] flex-1 flex-col">
        {queuedFollowUps.length > 0 ? (
          <div data-testid="queued-followups" className="flex max-w-full flex-wrap gap-1.5 px-3 pt-2">
            {queuedFollowUps.map((queued) => (
              <span
                key={queued.id}
                className="max-w-full truncate rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                title={queued.text}
              >
                Queued: {queued.text}
              </span>
            ))}
          </div>
        ) : null}
        <ComposerAttachmentList attachments={attachments} onRemove={removeAttachment} className="px-3 pt-2" />

        <div className="berry-composer-editor relative flex-1">
          <PromptEditor
            ref={editorRef}
            autoFocus={autoFocus}
            mentions={mentions}
            onChange={setInput}
            onSubmit={() => void submit()}
            onPasteEvent={handlePaste}
            placeholder={
              variant === "home"
                ? "Ask Berry anything, @ for files or folders, / for commands, # for related conversations"
                : "Ask for follow-up changes"
            }
          />
        </div>

        {/* Codex footer: 4px gaps on the leading pills, 12px on the trailing group. */}
        <div className="berry-composer-controls @container flex min-w-0 flex-nowrap items-center gap-1">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label="Add context"
                className="berry-composer-icon-button size-8 rounded-[9px] text-muted-foreground transition-[background-color,color,box-shadow,opacity] hover:bg-accent/60 hover:text-foreground"
              >
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuItem onClick={() => void chooseFiles(() => fileInputRef.current?.click())}>
                <ImagePlus /> Add attachment
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => insertToken("@")}>
                <AtSign /> Insert <span>@</span> mention
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => insertToken("#")}>
                <Hash /> Insert <span>#</span> session
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => insertToken("/")}>
                <SlashSquare /> Insert <span>/</span> command
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ModeSelector mode={permissionMode} onChange={changeMode} />

          <div className="ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-3">
          {sessionId ? <ContextWindowRing stats={contextStatsQuery.data} /> : null}

          <ModelSelector
            providers={providers}
            active={activeModel}
            onPick={pickModel}
            onOpenSettings={() => openSettings("models")}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Reasoning level"
                aria-pressed={reasoning !== "off"}
                title={`Reasoning ${reasoning}`}
                className="berry-pill-control gap-1.5"
              >
                <Brain />
                <span className="[@container_(max-width:380px)]:hidden">
                  {REASONING_LEVELS.find((level) => level.id === reasoning)?.label}
                </span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
              {REASONING_LEVELS.map((level) => (
                <DropdownMenuItem key={level.id} onClick={() => changeReasoning(level.id)}>
                  <Brain />
                  <div className="flex min-w-0 flex-col">
                    <span>{level.label}</span>
                    <span className="text-xs text-muted-foreground">{level.detail}</span>
                  </div>
                  {level.id === reasoning ? <Check className="ml-auto" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {streaming ? (
            <Button
              size="icon-lg"
              variant="secondary"
              onClick={onCancel}
              aria-label="Stop"
              className="berry-composer-send size-8 rounded-full bg-secondary text-secondary-foreground transition-[background-color,color,box-shadow,opacity,transform] active:scale-[0.96] hover:bg-accent"
            >
              <Square />
            </Button>
          ) : (
            <Button
              size="icon-lg"
              variant="secondary"
              disabled={!canSubmit}
              onClick={() => void submit()}
              aria-label="Send"
              className="berry-composer-send size-8 rounded-full transition-[background-color,color,box-shadow,opacity,transform] active:scale-[0.96] disabled:opacity-45"
            >
              <ArrowUp02 />
            </Button>
          )}
          </div>
        </div>
      </div>
    </BerryComposerFrame>
  );
}

export interface ComposerAttachmentsController {
  attachments: ComposerAttachment[];
  addFiles: (files: FileList | null) => void;
  chooseFiles: (fallback?: () => void) => Promise<void>;
  clearAttachments: () => void;
  /** Returns true when the paste was consumed (files / large text). */
  handlePaste: (event: { clipboardData: DataTransfer | null; preventDefault: () => void }) => boolean;
  removeAttachment: (id: string) => void;
  hasReadyAttachment: boolean;
  hasProcessingAttachment: boolean;
}

export function useComposerAttachments(
  initialAttachments: ComposerAttachment[] = [],
  workspaceId?: string,
  options: { supportsImageInput?: boolean; unsupportedImageMessage?: string } = {},
): ComposerAttachmentsController {
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>(() => initialAttachments);
  const attachmentsRef = React.useRef<ComposerAttachment[]>(initialAttachments);
  const supportsImageInput = options.supportsImageInput !== false;
  const unsupportedImageMessage = options.unsupportedImageMessage ?? "The selected model does not support image input.";

  React.useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  React.useEffect(
    () => () => {
      revokeAttachmentObjectUrls(attachmentsRef.current);
    },
    [],
  );
  React.useEffect(() => {
    if (supportsImageInput) return;
    const removed = attachments.filter((attachment) => attachment.mediaType.startsWith("image/"));
    if (removed.length === 0) return;
    revokeAttachmentObjectUrls(removed);
    setAttachments((current) => current.filter((attachment) => !attachment.mediaType.startsWith("image/")));
    toast.error(unsupportedImageMessage);
  }, [attachments, supportsImageInput, unsupportedImageMessage]);

  const updateAttachment = React.useCallback((id: string, patch: Partial<ComposerAttachment>) => {
    setAttachments((current) => current.map((attachment) => (attachment.id === id ? { ...attachment, ...patch } : attachment)));
  }, []);

  const processBrowserAttachment = React.useCallback(
    async (attachment: ComposerAttachment) => {
      const file = attachment.file;
      if (!file) return;
      try {
        if (attachment.mediaType.startsWith("image/")) {
          updateAttachment(attachment.id, {
            state: "done",
            dataUrl: await imageDataUrlForSend(file, attachment.mediaType),
          });
          return;
        }
        if (isTextLikeFile(file.name, attachment.mediaType)) {
          updateAttachment(attachment.id, {
            state: "done",
            textContent: truncateAttachmentText(await file.text()),
          });
          return;
        }
        updateAttachment(attachment.id, { state: "done" });
      } catch (error) {
        updateAttachment(attachment.id, {
          state: "error",
          error: error instanceof Error ? error.message : "Could not read attachment",
        });
      }
    },
    [updateAttachment],
  );

  const enqueueBrowserFiles = React.useCallback(
    (files: Iterable<File>, sourceKind: ComposerAttachment["sourceKind"] = "upload") => {
      const selected = Array.from(files);
      const blockedImages = supportsImageInput ? [] : selected.filter((file) => (file.type || inferMediaType(file.name)).startsWith("image/"));
      if (blockedImages.length > 0) toast.error(unsupportedImageMessage);
      const incoming = supportsImageInput ? selected : selected.filter((file) => !(file.type || inferMediaType(file.name)).startsWith("image/"));
      if (incoming.length === 0) return;
      const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
      if (incoming.length > room) toast.warning(`Only ${MAX_ATTACHMENTS} attachments can be added`);
      const additions = incoming.slice(0, room).map((file): ComposerAttachment => {
        const mediaType = file.type || inferMediaType(file.name);
        return {
          id: crypto.randomUUID(),
          name: file.name,
          mediaType,
          size: file.size,
          state: "processing",
          sourceKind,
          file,
          objectUrl: mediaType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          dataUrl: null,
        };
      });
      if (additions.length === 0) return;
      setAttachments((current) => [...current, ...additions]);
      queueMicrotask(() => additions.forEach((attachment) => void processBrowserAttachment(attachment)));
    },
    [processBrowserAttachment, supportsImageInput, unsupportedImageMessage],
  );

  const enqueueNativeFiles = React.useCallback((files: Array<{ path: string; name: string; mediaType: string; size: number; dataUrl?: string | null }>): number => {
    const blockedImages = supportsImageInput ? [] : files.filter((file) => (file.mediaType || inferMediaType(file.name)).startsWith("image/"));
    if (blockedImages.length > 0) toast.error(unsupportedImageMessage);
    const accepted = supportsImageInput ? files : files.filter((file) => !(file.mediaType || inferMediaType(file.name)).startsWith("image/"));
    if (accepted.length === 0) return 0;
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
    if (accepted.length > room) toast.warning(`Only ${MAX_ATTACHMENTS} attachments can be added`);
    const additions = accepted.slice(0, room).map((file): ComposerAttachment => ({
      id: crypto.randomUUID(),
      name: file.name,
      mediaType: file.mediaType || inferMediaType(file.name),
      size: file.size,
      state: "done",
      sourceKind: "native-path",
      localPath: file.path,
      dataUrl: file.dataUrl ?? null,
    }));
    if (additions.length > 0) setAttachments((current) => [...current, ...additions]);
    return additions.length;
  }, [supportsImageInput, unsupportedImageMessage]);

  React.useEffect(() => {
    const onAddAttachments = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: unknown; files?: unknown }>).detail;
      if (!detail || (workspaceId && detail.workspaceId !== workspaceId)) return;
      const files = Array.isArray(detail.files)
        ? detail.files.flatMap((file): NativeAttachmentInput[] => {
            if (!file || typeof file !== "object" || Array.isArray(file)) return [];
            const record = file as Record<string, unknown>;
            if (typeof record.path !== "string" || typeof record.name !== "string" || typeof record.mediaType !== "string") return [];
            const size = typeof record.size === "number" && Number.isFinite(record.size) ? Math.max(0, Math.round(record.size)) : 0;
            return [{
              path: record.path,
              name: record.name,
              mediaType: record.mediaType,
              size,
              dataUrl: typeof record.dataUrl === "string" ? record.dataUrl : null,
            }];
          })
        : [];
      const acceptedCount = enqueueNativeFiles(files);
      if (acceptedCount > 0) toast.success(`${acceptedCount === 1 ? files.find((file) => !file.mediaType.startsWith("image/") || supportsImageInput)?.name ?? "File" : `${acceptedCount} files`} attached`);
    };
    window.addEventListener("berry:add-attachments", onAddAttachments);
    return () => window.removeEventListener("berry:add-attachments", onAddAttachments);
  }, [enqueueNativeFiles, supportsImageInput, workspaceId]);

  const addFiles = React.useCallback(
    (files: FileList | null) => {
      if (files) enqueueBrowserFiles(files);
    },
    [enqueueBrowserFiles],
  );

  const chooseFiles = React.useCallback(
    async (fallback?: () => void) => {
      try {
        const selected = await pickFiles();
        if (selected.length > 0) enqueueNativeFiles(selected);
        return;
      } catch {
        // Plain browser dev mode falls back to the hidden file input.
      }
      fallback?.();
    },
    [enqueueNativeFiles],
  );

  const removeAttachment = React.useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target?.objectUrl) URL.revokeObjectURL(target.objectUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clearAttachments = React.useCallback(() => {
    setAttachments((current) => {
      revokeAttachmentObjectUrls(current);
      return [];
    });
  }, []);

  const handlePaste = React.useCallback(
    (event: { clipboardData: DataTransfer | null; preventDefault: () => void }): boolean => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        enqueueBrowserFiles(files);
        return true;
      }
      const pastedText = event.clipboardData?.getData("text/plain") ?? "";
      if (pastedText.length >= LARGE_PASTE_CHARS) {
        event.preventDefault();
        const name = pastedTextFilename();
        enqueueBrowserFiles([new File([pastedText], name, { type: "text/plain" })], "clipboard-text");
        return true;
      }
      return false;
    },
    [enqueueBrowserFiles],
  );

  return {
    attachments,
    addFiles,
    chooseFiles,
    clearAttachments,
    handlePaste,
    removeAttachment,
    hasReadyAttachment: attachments.some((attachment) => attachment.state === "done"),
    hasProcessingAttachment: attachments.some((attachment) => attachment.state === "processing"),
  };
}

export function ComposerAttachmentList({
  attachments,
  onRemove,
  className,
}: {
  attachments: ComposerAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <AttachmentGroup className={className}>
      {attachments.map((attachment) => {
        const previewSrc = attachmentPreviewSrc(attachment);
        if (previewSrc) {
          return (
            <div
              key={attachment.id}
              className={cn(
                "group/attachment-preview relative size-24 shrink-0 overflow-hidden rounded-[18px] border border-border/80 bg-background/35 shadow-[var(--berry-ring-subtle)]",
                attachment.state === "processing" && "berry-shimmer",
                attachment.state === "error" && "border-destructive/40",
              )}
              title={attachment.name}
              data-attachment-preview="image"
              data-state={attachment.state}
            >
              <img
                src={previewSrc}
                alt={attachment.name}
                className="size-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
                className="absolute top-1.5 right-1.5 size-6 rounded-full bg-background/95 text-foreground shadow-sm hover:bg-background"
              >
                <X />
              </Button>
            </div>
          );
        }
        return (
          <Attachment
            key={attachment.id}
            size="sm"
            state={attachment.state}
            className="max-w-60 rounded-full bg-background/35 shadow-[var(--berry-ring-subtle)]"
          >
            <AttachmentMedia className="rounded-[10px]">
              <Paperclip />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{attachment.name}</AttachmentTitle>
              <AttachmentDescription>{attachmentDescription(attachment)}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}>
                <X />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}

function ContextWindowRing({ stats }: { stats: ContextStats | undefined }) {
  const percent = stats?.percentUsed ?? null;
  const used = stats ? formatTokens(stats.usedTokens) : null;
  const total = stats?.contextWindow ? formatTokens(stats.contextWindow) : null;
  const leftPercent = percent === null ? null : Math.max(0, 100 - percent);
  const roundedUsedPercent = percent === null ? null : Math.round(percent);
  const roundedLeftPercent = leftPercent === null ? null : Math.round(leftPercent);
  const tooltipLabel = stats && roundedUsedPercent !== null
    ? `Context Window: ${roundedUsedPercent}% used (${roundedLeftPercent ?? 0}% left)${used && total ? `, ${used} / ${total} tokens used` : ""}`
    : "Context Window: unknown";

  return (
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
          />
        </button>
      </TooltipTrigger>
      <TooltipContent className="rounded-[16px] border border-white/10 bg-[#2b2b2d] px-7 py-3 text-center text-[15px] leading-snug text-white shadow-[0_14px_32px_rgba(0,0,0,0.28)] text-nowrap [&_svg]:bg-[#2b2b2d] [&_svg]:fill-[#2b2b2d]">
        <div className="flex flex-col items-center gap-1 tabular-nums">
          {stats && roundedUsedPercent !== null ? (
            <>
              <span className="text-white/55">Context Window:</span>
              <span>{roundedUsedPercent}% used ({roundedLeftPercent ?? 0}% left)</span>
              {used && total ? <span>{used} / {total} tokens used</span> : null}
            </>
          ) : (
            <span className="text-white/55">Context Window: unknown</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ModeSelector({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  const active = PERMISSION_MODES.find((candidate) => candidate.id === mode) ?? PERMISSION_MODES[0]!;
  // Berry rolodex: on selection the old icon+label rolls out the top while the
  // new rolls in from below (berry-roll-* classes; reduced-motion disables).
  const [exiting, setExiting] = React.useState<typeof active | null>(null);
  const previousRef = React.useRef(active);
  React.useEffect(() => {
    if (previousRef.current.id !== active.id) {
      setExiting(previousRef.current);
      previousRef.current = active;
      const timer = window.setTimeout(() => setExiting(null), 300);
      return () => window.clearTimeout(timer);
    }
  }, [active]);
  const ActiveIcon = active.icon;
  const ExitingIcon = exiting?.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="berry-pill-control max-w-[min(44vw,230px)] justify-start gap-1.5"
          style={active.color ? { color: active.color } : undefined}
        >
          <span className="relative flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span key={active.id} className={cn("flex min-w-0 items-center gap-1.5", exiting && "berry-roll-enter")}>
              <ActiveIcon className="shrink-0" />
              <span className="berry-composer-permission-label truncate [@container_(max-width:480px)]:hidden">{active.label}</span>
            </span>
            {exiting && ExitingIcon ? (
              <span
                aria-hidden
                className="berry-roll-exit absolute inset-0 flex min-w-0 items-center gap-1.5"
                style={exiting.color ? { color: exiting.color } : { color: "var(--berry-text-secondary)" }}
              >
                <ExitingIcon className="shrink-0" />
                <span className="truncate [@container_(max-width:480px)]:hidden">{exiting.label}</span>
              </span>
            ) : null}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {PERMISSION_MODES.map((candidate) => {
          const Icon = candidate.icon;
          return (
            <DropdownMenuItem key={candidate.id} onClick={() => onChange(candidate.id)}>
              <Icon style={candidate.color ? { color: candidate.color } : undefined} />
              <div className="flex min-w-0 flex-col">
                <span>{candidate.label}</span>
                <span className="text-xs text-muted-foreground">{candidate.detail}</span>
              </div>
              {candidate.id === mode ? <Check className="ml-auto" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function serializeAttachment(attachment: ComposerAttachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    dataUrl: attachment.dataUrl ?? null,
    textContent: attachment.textContent ?? null,
    localPath: attachment.localPath ?? null,
    sourceKind: attachment.sourceKind,
  };
}

function attachmentDescription(attachment: ComposerAttachment): string {
  if (attachment.state === "processing") return "Processing";
  if (attachment.state === "error") return attachment.error ?? "Could not read";
  const kind = attachment.mediaType.startsWith("image/")
    ? "Image"
    : isTextLikeName(attachment.name, attachment.mediaType)
      ? "Text"
      : attachment.mediaType === "application/pdf"
        ? "PDF"
        : "File";
  const state = attachment.textContent
    ? "included"
    : attachment.dataUrl
      ? "ready"
      : attachment.localPath
        ? "path"
        : "reference";
  return `${kind} · ${formatBytes(attachment.size)} · ${state}`;
}

function attachmentPreviewSrc(attachment: ComposerAttachment): string | null {
  if (!attachment.mediaType.startsWith("image/")) return null;
  if (attachment.dataUrl) return attachment.dataUrl;
  if (attachment.objectUrl) return attachment.objectUrl;
  return attachment.localPath ? localFilePreviewUrl(attachment.localPath) : null;
}

function revokeAttachmentObjectUrls(attachments: ComposerAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
  }
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function imageDataUrlForSend(file: File, mediaType: string): Promise<string | null> {
  if (!canResizeInBrowser(mediaType)) return file.size <= INLINE_IMAGE_BYTES ? readAsDataUrl(file) : null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= INLINE_IMAGE_BYTES) return readAsDataUrl(file);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file.size <= INLINE_IMAGE_BYTES ? readAsDataUrl(file) : null;
    context.drawImage(bitmap, 0, 0, width, height);
    const preferred = mediaType === "image/webp" ? "image/webp" : mediaType === "image/png" ? "image/png" : "image/jpeg";
    const first = await canvasToBlob(canvas, preferred, 0.86);
    if (first && first.size <= INLINE_IMAGE_BYTES) return readAsDataUrl(first);
    if (preferred === "image/png") {
      const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.82);
      if (jpeg && jpeg.size <= INLINE_IMAGE_BYTES) return readAsDataUrl(jpeg);
    }
    for (const quality of [0.74, 0.64, 0.54]) {
      const compressed = await canvasToBlob(canvas, preferred === "image/png" ? "image/jpeg" : preferred, quality);
      if (compressed && compressed.size <= INLINE_IMAGE_BYTES) return readAsDataUrl(compressed);
    }
    return null;
  } catch {
    return file.size <= INLINE_IMAGE_BYTES ? readAsDataUrl(file) : null;
  } finally {
    bitmap?.close();
  }
}

function canResizeInBrowser(mediaType: string): boolean {
  return mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp";
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function isTextLikeFile(name: string, mediaType: string): boolean {
  return mediaType.startsWith("text/") || isTextLikeName(name, mediaType);
}

function isTextLikeName(name: string, mediaType: string): boolean {
  if (mediaType === "application/json") return true;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(extension);
}

function truncateAttachmentText(text: string): string {
  if (text.length <= INLINE_TEXT_CHARS) return text;
  return `${text.slice(0, INLINE_TEXT_CHARS)}\n[attachment truncated after ${INLINE_TEXT_CHARS} characters]`;
}

function inferMediaType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "txt":
    case "log":
      return "text/plain";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return TEXT_EXTENSIONS.has(extension) ? "text/plain" : "application/octet-stream";
  }
}

function pastedTextFilename(): string {
  const stamp = new Date().toISOString().replaceAll("-", "").replace("T", "-").slice(0, 15);
  return `pasted-text-${stamp}.txt`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}K`;
  return String(tokens);
}

function normalizeBranch(stdout: string | undefined): string {
  const branch = stdout?.trim();
  return branch && branch.length > 0 ? branch : "No branch";
}

/** Shared submit pipeline: create a task when needed, then start an agent turn. */
export function useStartTurn() {
  const queryClient = useQueryClient();
  const { activeWorkspace, openTask, selectedConversationKind } = useWorkbench();

  return useMutation({
    mutationFn: async ({
      taskId,
      sessionId,
      submission,
      replaceFromMessageId,
      continueInterruptedTurn,
    }: {
      taskId?: string;
      sessionId?: string;
      submission: ComposerSubmit;
      replaceFromMessageId?: string;
      continueInterruptedTurn?: boolean;
    }) => {
      if (!activeWorkspace) throw new Error("No active workspace");
      let resolvedTaskId = taskId;
      let resolvedSessionId = sessionId;
      if (!resolvedTaskId) {
        const created = await host.call<{ task: Task; session: Session }>("task.create", {
          workspaceId: activeWorkspace.id,
          workspaceKind: activeWorkspace.workspaceKind,
          conversationKind: selectedConversationKind,
          title: submission.input.slice(0, 64) || (submission.attachments[0] ? `Attached: ${submission.attachments[0].name}` : selectedConversationKind === "code" ? "New code chat" : "New chat"),
          permissionMode: submission.permissionMode,
          modelProviderId: submission.providerId,
          model: submission.model,
        });
        resolvedTaskId = created.task.id;
        resolvedSessionId = created.task.activeSessionId ?? created.session.id;
        queryClient.setQueryData<Task[]>(["task.list", activeWorkspace.id], (current) => [
          created.task,
          ...(current ?? []).filter((task) => task.id !== created.task.id),
        ]);
        if (activeWorkspace.workspaceKind === "general") {
          queryClient.setQueryData<Task[]>(["task.listGeneral"], (current) => [
            created.task,
            ...(current ?? []).filter((task) => task.id !== created.task.id),
          ]);
        }
        if (submission.createInWorktree) {
          const worktree = await callWithApprovalRetry<Worktree>("worktree.create", {
            taskId: created.task.id,
            baseRef: "HEAD",
            permissionMode: submission.permissionMode,
          });
          const updatedTask = { ...created.task, worktreePath: worktree.path, worktreeBranch: worktree.branch, worktreeBaseRef: worktree.baseRef };
          queryClient.setQueryData<Task[]>(["task.list", activeWorkspace.id], (current) => [
            updatedTask,
            ...(current ?? []).filter((task) => task.id !== updatedTask.id),
          ]);
        }
      }
      try {
        if (resolvedSessionId && !replaceFromMessageId && !continueInterruptedTurn) {
          const turnState = await host.call<TurnState>("agent.turnState", { sessionId: resolvedSessionId });
          if (!turnState.active) {
            const stats = await host.call<ContextStats>("session.contextStats", {
              sessionId: resolvedSessionId,
              providerId: submission.providerId,
              model: submission.model,
              pendingInput: submission.input,
              attachments: submission.attachments.map(serializeAttachment),
            });
            if (stats.percentUsed !== null && stats.percentUsed >= 85) {
              try {
                await host.call("session.compact", {
                  sessionId: resolvedSessionId,
                  providerId: submission.providerId,
                  model: submission.model,
                  credentialRef: submission.credentialRef,
                  permissionMode: submission.permissionMode,
                  reasoning: submission.reasoning,
                });
              } catch (error) {
                const detail = error instanceof Error ? error.message : "unknown error";
                throw new Error(`Auto compaction failed before send: ${detail}`);
              }
              await queryClient.invalidateQueries({ queryKey: ["session.messages", resolvedSessionId] });
              await queryClient.invalidateQueries({ queryKey: ["session.contextStats", resolvedSessionId] });
            }
          }
        }
        const webSearchProvider = await host.call<string | null>("settings.get", { key: "web.search.provider" });
        const webSearchCredentialRef = webSearchProvider === "brave" || webSearchProvider === "tavily" || webSearchProvider === "ollama"
          ? `web-search-${webSearchProvider}`
          : null;
        const mcpCredentialRefs = (await host.call<McpServerConfig[]>("mcp.server.list"))
          .filter((server) => server.enabled && server.trusted && server.credentialRef)
          .map((server) => server.credentialRef!);
        await host.call("agent.turn", {
          taskId: resolvedTaskId,
          sessionId: resolvedSessionId ?? null,
          ...(replaceFromMessageId ? { replaceFromMessageId } : {}),
          ...(continueInterruptedTurn ? { continueInterruptedTurn: true } : { input: submission.input }),
          permissionMode: submission.permissionMode,
          reasoning: submission.reasoning,
          providerId: submission.providerId,
          model: submission.model,
          credentialRef: submission.credentialRef,
          ...(webSearchCredentialRef ? { webSearchCredentialRef } : {}),
          ...(mcpCredentialRefs.length > 0 ? { mcpCredentialRefs } : {}),
          attachments: submission.attachments.map(serializeAttachment),
        });
        if (resolvedSessionId) {
          const messages = await host.call<Message[]>("session.messages", { sessionId: resolvedSessionId });
          queryClient.setQueryData<Message[]>(["session.messages", resolvedSessionId], messages);
        }
      } catch (error) {
        void queryClient.invalidateQueries({ queryKey: ["task.list"] });
        if (resolvedSessionId) void queryClient.invalidateQueries({ queryKey: ["session.messages", resolvedSessionId] });
        if (!taskId && resolvedTaskId) openTask(resolvedTaskId);
        throw error;
      }
      return { taskId: resolvedTaskId, sessionId: resolvedSessionId };
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Prompt failed");
    },
    onSuccess: ({ taskId }) => {
      void queryClient.invalidateQueries({ queryKey: ["task.list"] });
      openTask(taskId);
    },
  });
}
