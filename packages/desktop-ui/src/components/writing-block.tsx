import * as React from "react";
import {
  MessageDraftSchema,
  activeMessageDraftVariantIndex,
  type MessageDraft,
  type MessageVariant,
} from "@berry/shared";
import { ArrowUpRight01Icon, Check, Copy, Pencil } from "@berry/desktop-ui/lib/icons";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { cn } from "@berry/desktop-ui/lib/utils";
import { toast } from "sonner";

export interface WritingBlockVariantState {
  label: string;
  subject?: string | undefined;
  body: string;
  dirty: boolean;
}

export interface MessageDraftState {
  id: string;
  kind: MessageDraft["kind"];
  summaryTitle?: string | undefined;
  activeIndex: number;
  variants: WritingBlockVariantState[];
}

export interface WritingBlockProps {
  data: MessageDraftState;
  conflict?: MessageVariant | undefined;
  onVariantChange: (activeIndex: number) => void;
  onBodyEdit: (activeIndex: number, body: string) => void;
  onSubjectEdit: (activeIndex: number, subject: string) => void;
  onUseAIRevision?: (() => void) | undefined;
  onKeepLocalRevision?: (() => void) | undefined;
  onCopy?: ((text: string) => void) | undefined;
}

export interface OptionTabsProps {
  variants: Array<Pick<WritingBlockVariantState, "label" | "dirty">>;
  activeIndex: number;
  onChange: (activeIndex: number) => void;
}

export function OptionTabs({ variants, activeIndex, onChange }: OptionTabsProps) {
  if (variants.length < 2) return null;
  return (
    <Tabs
      value={String(activeIndex)}
      onValueChange={(value) => onChange(Number(value))}
      className="min-w-0 flex-1"
    >
      <TabsList
        variant="line"
        aria-label="Message draft variants"
        className="h-auto max-w-full justify-start gap-1 overflow-x-auto rounded-full p-0 [scrollbar-width:none]"
      >
        {variants.map((variant, index) => (
          <TabsTrigger
            key={`${variant.label}-${index}`}
            value={String(index)}
            className={cn(
              "h-9 flex-none gap-2 rounded-full px-3 text-[13px] font-medium text-[var(--berry-text-tertiary)] after:hidden",
              "hover:bg-[var(--berry-hover)] hover:text-[var(--berry-text-primary)]",
              "data-[state=active]:bg-[var(--berry-selected)] data-[state=active]:text-[var(--berry-text-primary)] data-[state=active]:shadow-none",
            )}
          >
            <span
              aria-hidden="true"
              className="grid size-[18px] place-items-center rounded-full border border-current text-[10px] leading-none tabular-nums"
            >
              {index + 1}
            </span>
            {variant.label}
            {variant.dirty ? <span className="size-1.5 rounded-full bg-[var(--berry-accent)]" aria-label="Edited" /> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export interface WritingBlockActionsProps {
  copied: boolean;
  launchHref?: string | undefined;
  launchLabel?: string | undefined;
  onCopy: () => void;
}

export function WritingBlockActions({
  copied,
  launchHref,
  launchLabel,
  onCopy,
}: WritingBlockActionsProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? "Copied" : "Copy message"}
        title={copied ? "Copied" : "Copy"}
        className="rounded-full text-[var(--berry-text-secondary)] hover:bg-[var(--berry-hover)] hover:text-[var(--berry-text-primary)]"
        onClick={onCopy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      {launchHref && launchLabel ? (
        <Button
          asChild
          size="sm"
          className="h-9 rounded-full bg-[var(--berry-text-primary)] px-3.5 text-[13px] text-[var(--berry-main-bg)] shadow-none hover:bg-[var(--berry-text-secondary)]"
        >
          <a href={launchHref} aria-label={launchLabel}>
            <ArrowUpRight01Icon />
            <span className="hidden sm:inline">{launchLabel}</span>
          </a>
        </Button>
      ) : null}
    </div>
  );
}

export function WritingBlock({
  data,
  conflict,
  onVariantChange,
  onBodyEdit,
  onSubjectEdit,
  onUseAIRevision,
  onKeepLocalRevision,
  onCopy,
}: WritingBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const [isEditing, setIsEditing] = React.useState(false);
  const copyTimerRef = React.useRef<number | null>(null);
  const active = data.variants[data.activeIndex] ?? data.variants[0];

  React.useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  if (!active) return null;

  const composed = composeWritingBlockText(data.kind, active);
  const launch = writingBlockLaunchAction(data.kind, active);

  const copy = async () => {
    try {
      await copyWritingBlockText(composed);
      onCopy?.(composed);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to copy this draft");
    }
  };

  return (
    <section
      data-writing-block={data.id}
      aria-label={data.summaryTitle ? `Editable message: ${data.summaryTitle}` : "Editable message draft"}
      className="w-full max-w-[1150px] overflow-hidden rounded-[22px] border border-[var(--berry-border)] bg-[var(--berry-card-bg)] text-[var(--berry-text-primary)] shadow-[var(--berry-shadow-sm)]"
    >
      <header className="flex min-h-14 items-center gap-2 border-b border-[var(--berry-border)] px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={isEditing ? "Preview message" : "Edit message"}
          aria-pressed={isEditing}
          title={isEditing ? "Preview message" : "Edit message"}
          className={cn(
            "size-10 shrink-0 rounded-full border border-[var(--berry-border)] text-[var(--berry-text-secondary)] transition-[background-color,color,transform] hover:bg-[var(--berry-hover)] hover:text-[var(--berry-text-primary)] active:scale-[0.96]",
            isEditing && "bg-[var(--berry-selected)] text-[var(--berry-text-primary)]",
          )}
          onClick={() => setIsEditing((current) => !current)}
        >
          <Pencil className="size-4" />
        </Button>
        <OptionTabs variants={data.variants} activeIndex={data.activeIndex} onChange={onVariantChange} />
        {data.variants.length === 1 ? (
          <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium">{active.label}</span>
        ) : null}
        <WritingBlockActions
          copied={copied}
          {...(launch ? { launchHref: launch.href, launchLabel: launch.label } : {})}
          onCopy={() => void copy()}
        />
      </header>

      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--berry-border)] bg-[var(--berry-accent-soft)] px-4 py-2 text-[12px] text-[var(--berry-text-secondary)]">
          <span className="min-w-48 flex-1">AI returned a revision. Your unsaved edits were kept.</span>
          <Button type="button" size="xs" variant="ghost" onClick={onKeepLocalRevision}>Keep mine</Button>
          <Button type="button" size="xs" variant="secondary" onClick={onUseAIRevision}>Use AI version</Button>
        </div>
      ) : null}

      <div className={cn("px-4", data.kind === "textMessage" ? "py-4" : "")}>
        {data.kind === "email" ? (
          <div
            data-writing-block-subject
            className="-mx-4 grid grid-cols-[58px_minmax(0,1fr)] items-center border-b border-[var(--berry-border)] px-4 py-2"
          >
            <span className="text-[12px] text-[var(--berry-text-tertiary)]">Subject</span>
            {isEditing ? (
              <input
                value={active.subject ?? ""}
                aria-label="Email subject"
                placeholder="Add a subject"
                className="min-w-0 border-0 bg-transparent p-0 text-base text-[var(--berry-text-primary)] placeholder:text-[var(--berry-text-tertiary)] focus:outline-none sm:text-[14px]"
                onChange={(event) => onSubjectEdit(data.activeIndex, event.target.value)}
              />
            ) : (
              <span className="min-w-0 truncate text-[14px] text-[var(--berry-text-primary)]">
                {active.subject?.trim() || "No subject"}
              </span>
            )}
          </div>
        ) : null}
        {isEditing ? (
          <AutosizeTextarea
            value={active.body}
            aria-label={`${active.label} message body`}
            onChange={(event) => onBodyEdit(data.activeIndex, event.target.value)}
            className={cn(
              "block w-full resize-none overflow-hidden border-0 bg-transparent text-base leading-[1.65] text-[var(--berry-text-primary)] outline-none placeholder:text-[var(--berry-text-tertiary)] sm:text-[15px]",
              data.kind === "email" ? "min-h-52 px-0 py-4" : "min-h-28 rounded-[18px] bg-[var(--berry-control-bg)] px-4 py-3",
            )}
          />
        ) : (
          <div
            data-writing-block-body
            className={cn(
              "min-h-28 text-[var(--berry-text-primary)]",
              data.kind === "email" ? "py-4" : "rounded-[18px] bg-[var(--berry-control-bg)] px-4 py-3",
            )}
          >
            {active.body.trim() ? (
              <Markdown className="text-[15px] leading-[1.65] tracking-normal [&>p]:my-4 [&_p]:whitespace-pre-wrap [&_strong]:font-semibold">
                {active.body}
              </Markdown>
            ) : (
              <p className="text-[15px] text-[var(--berry-text-tertiary)]">No message content</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function WritingBlockController({ draft }: { draft: MessageDraft }) {
  const [state, setState] = React.useState<MessageDraftState>(() => messageDraftState(draft));
  const [conflicts, setConflicts] = React.useState<Array<MessageVariant | undefined>>([]);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const modelFingerprintRef = React.useRef(messageDraftFingerprint(draft));

  React.useEffect(() => {
    const fingerprint = messageDraftFingerprint(draft);
    if (fingerprint === modelFingerprintRef.current) return;
    modelFingerprintRef.current = fingerprint;
    const reconciled = reconcileMessageDraftState(stateRef.current, draft);
    setConflicts(reconciled.conflicts);
    setState(reconciled.state);
  }, [draft]);

  const updateVariant = (index: number, patch: Partial<WritingBlockVariantState>) => {
    setState((current) => ({
      ...current,
      variants: current.variants.map((variant, variantIndex) =>
        variantIndex === index ? { ...variant, ...patch, dirty: true } : variant),
    }));
  };

  const activeConflict = conflicts[state.activeIndex];

  return (
    <WritingBlock
      data={state}
      {...(activeConflict ? { conflict: activeConflict } : {})}
      onVariantChange={(activeIndex) => setState((current) => ({ ...current, activeIndex }))}
      onBodyEdit={(index, body) => updateVariant(index, { body })}
      onSubjectEdit={(index, subject) => updateVariant(index, { subject })}
      onKeepLocalRevision={() => {
        setConflicts((current) => current.map((conflict, index) => index === state.activeIndex ? undefined : conflict));
      }}
      onUseAIRevision={() => {
        if (!activeConflict) return;
        setState((current) => ({
          ...current,
          variants: current.variants.map((variant, index) =>
            index === current.activeIndex
              ? {
                label: activeConflict.label,
                ...(activeConflict.subject !== undefined ? { subject: activeConflict.subject } : {}),
                body: activeConflict.body,
                dirty: false,
              }
              : variant),
        }));
        setConflicts((current) => current.map((conflict, index) => index === state.activeIndex ? undefined : conflict));
      }}
    />
  );
}

export function messageDraftState(draft: MessageDraft): MessageDraftState {
  return {
    id: draft.id,
    kind: draft.kind,
    ...(draft.summaryTitle ? { summaryTitle: draft.summaryTitle } : {}),
    activeIndex: activeMessageDraftVariantIndex(draft),
    variants: draft.variants.map((variant) => ({
      label: variant.label,
      ...(variant.subject !== undefined ? { subject: variant.subject } : {}),
      body: variant.body,
      dirty: false,
    })),
  };
}

export function reconcileMessageDraftState(
  current: MessageDraftState,
  incoming: MessageDraft,
): { state: MessageDraftState; conflicts: Array<MessageVariant | undefined> } {
  const used = new Set<number>();
  const conflicts: Array<MessageVariant | undefined> = [];
  const variants = incoming.variants.map((variant, incomingIndex): WritingBlockVariantState => {
    let currentIndex = current.variants.findIndex((candidate, index) =>
      !used.has(index) && candidate.label === variant.label);
    if (currentIndex === -1 && current.variants[incomingIndex] && !used.has(incomingIndex)) currentIndex = incomingIndex;
    const local = currentIndex === -1 ? undefined : current.variants[currentIndex];
    if (currentIndex !== -1) used.add(currentIndex);
    if (!local || !local.dirty) {
      return {
        label: variant.label,
        ...(variant.subject !== undefined ? { subject: variant.subject } : {}),
        body: variant.body,
        dirty: false,
      };
    }
    const changed = local.body !== variant.body || (local.subject ?? "") !== (variant.subject ?? "");
    if (!changed) {
      return {
        label: variant.label,
        ...(variant.subject !== undefined ? { subject: variant.subject } : {}),
        body: variant.body,
        dirty: false,
      };
    }
    conflicts[incomingIndex] = variant;
    return {
      ...local,
      label: variant.label,
      ...(incoming.kind !== "email" ? { subject: undefined } : {}),
    };
  });

  for (let index = 0; index < current.variants.length; index += 1) {
    const variant = current.variants[index];
    if (!used.has(index) && variant?.dirty) variants.push(variant);
  }

  return {
    state: {
      ...current,
      id: incoming.id,
      kind: incoming.kind,
      ...(incoming.summaryTitle ? { summaryTitle: incoming.summaryTitle } : { summaryTitle: undefined }),
      activeIndex: Math.min(current.activeIndex, Math.max(0, variants.length - 1)),
      variants,
    },
    conflicts,
  };
}

export function messageDraftFromToolResult(content: unknown): MessageDraft | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (record.name !== "compose_message" || record.status === "failed" || record.status === "denied" || record.status === "cancelled") return null;
  const output = record.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const outputRecord = output as Record<string, unknown>;
  const parsed = MessageDraftSchema.safeParse(outputRecord.draft ?? outputRecord);
  return parsed.success ? parsed.data : null;
}

export function composeWritingBlockText(
  kind: MessageDraft["kind"],
  variant: Pick<WritingBlockVariantState, "subject" | "body">,
): string {
  if (kind !== "email" || !variant.subject?.trim()) return variant.body;
  return `Subject: ${variant.subject.trim()}\n\n${variant.body}`;
}

export function writingBlockLaunchAction(
  kind: MessageDraft["kind"],
  variant: Pick<WritingBlockVariantState, "subject" | "body">,
): { href: string; label: string } | null {
  if (kind === "email") {
    const subject = encodeURIComponent(variant.subject ?? "");
    const body = encodeURIComponent(variant.body);
    return { href: `mailto:?subject=${subject}&body=${body}`, label: "Open in Mail" };
  }
  if (kind === "textMessage") {
    return { href: `sms:?&body=${encodeURIComponent(variant.body)}`, label: "Open in Messages" };
  }
  return null;
}

function AutosizeTextarea({
  value,
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} value={value} className={className} {...props} />;
}

function messageDraftFingerprint(draft: MessageDraft): string {
  return JSON.stringify(draft);
}

async function copyWritingBlockText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through for browsers and self-hosted origins that deny Clipboard API access.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Unable to copy this draft");
}
