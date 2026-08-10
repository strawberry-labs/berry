import * as React from "react";
import type { AttachmentInput } from "@berry/shared";
import type { QuestionPrompt } from "@berry/desktop-ui/components/thread-stream";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { ArrowLeft02, ArrowRight02, Check, X } from "@berry/desktop-ui/lib/icons";
import { Paperclip } from "lucide-react";

export interface ComposerQuestionAnswer {
  question: string;
  answer: string;
  selectedOptions: string[];
  attachments: Array<AttachmentInput & { fileId: string }>;
  skipped: boolean;
}

type Draft = ComposerQuestionAnswer & {
  /** Keeps an intentionally empty multi-select distinct from a custom response. */
  mode: "choice" | "custom" | "skipped";
};

export function updateCustomAnswerDraft(
  drafts: Record<number, Draft>,
  index: number,
  question: string,
  answer: string,
): Record<number, Draft> {
  return {
    ...drafts,
    [index]: {
      question,
      answer,
      selectedOptions: [],
      attachments: drafts[index]?.attachments ?? [],
      skipped: false,
      mode: "custom",
    },
  };
}

export function normalizeQuestionDraft(
  question: string,
  draft: Draft | undefined,
): Draft {
  if (!draft || (draft.mode === "custom" && draft.answer.trim().length === 0 && draft.attachments.length === 0)) {
    return {
      question,
      answer: "Skipped",
      selectedOptions: [],
      attachments: [],
      skipped: true,
      mode: "skipped",
    };
  }
  if (draft.mode === "custom") return { ...draft, answer: draft.answer.trim() };
  return draft;
}

export function questionInteractionLocked(pending: boolean, uploading: boolean): boolean {
  return pending || uploading;
}

function promptItems(question: QuestionPrompt) {
  return question.questions.length > 0
    ? question.questions
    : [{ question: question.question, options: question.options, multi: question.multi }];
}

/** A compact transcript is both human-readable in the chat and safe to save as
 * a normal user message. The agent receives the richer `answers` payload. */
export function questionAnswerTranscript(answers: ComposerQuestionAnswer[]): string {
  return answers.map((item) => {
    const response = item.skipped ? "Skipped" : item.answer.trim();
    const files = item.attachments.length > 0 ? `Attached: ${item.attachments.map((attachment) => attachment.name).join(", ")}` : "";
    return `› ${item.question}\n${[response, files].filter(Boolean).join("\n")}`;
  }).join("\n\n");
}

export function questionToolAnswer(answers: ComposerQuestionAnswer[]): string {
  return answers.map((item) => {
    const response = item.skipped ? "Skipped" : item.answer.trim();
    const files = item.attachments.length > 0 ? `Attached files: ${item.attachments.map((attachment) => attachment.name).join(", ")}` : "";
    return `${item.question}: ${[response, files].filter(Boolean).join("; ")}`;
  }).join("\n");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function stableQuestionAnswerMessageId(questionId: string): Promise<string> {
  if (UUID_PATTERN.test(questionId)) return questionId;
  const compact = questionId.match(/(?:^|_)([0-9a-f]{32})$/i)?.[1];
  if (compact) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`berry-question-answer:${questionId}`),
  ));
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ComposerQuestionOverlay({
  question,
  onSubmit,
  onUploadFiles,
}: {
  question: QuestionPrompt;
  onSubmit: (answers: ComposerQuestionAnswer[]) => Promise<void>;
  onUploadFiles?: (files: readonly File[]) => Promise<Array<AttachmentInput & { fileId: string }>>;
}) {
  const items = React.useMemo(() => promptItems(question), [question]);
  const [current, setCurrent] = React.useState(0);
  const [drafts, setDrafts] = React.useState<Record<number, Draft>>({});
  const [activeOption, setActiveOption] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState("");
  const customInputRef = React.useRef<HTMLInputElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const prompt = items[current]!;
  const draft = drafts[current];
  const isCustom = draft?.mode === "custom";
  const interactionLocked = questionInteractionLocked(pending, uploading);
  const optionCount = prompt.options.length;

  React.useEffect(() => {
    setCurrent(0);
    setDrafts({});
    setActiveOption(0);
    setPending(false);
    setUploading(false);
    setError("");
  }, [question.questionId]);

  React.useEffect(() => {
    setActiveOption(Math.min(activeOption, optionCount));
  }, [activeOption, optionCount]);

  React.useEffect(() => {
    if (!isCustom) return;
    const frame = requestAnimationFrame(() => customInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isCustom, current]);

  const finish = React.useCallback(async (nextDrafts: Record<number, Draft>) => {
    const answers = items.map((item, index) => {
      const draft = normalizeQuestionDraft(item.question, nextDrafts[index]);
      const { mode: _mode, ...answer } = draft;
      return answer;
    });
    setPending(true);
    setError("");
    try {
      await onSubmit(answers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send your response. Try again.");
      setPending(false);
    }
  }, [items, onSubmit]);

  const advance = React.useCallback((nextDraft: Draft) => {
    if (interactionLocked) return;
    const nextDrafts = { ...drafts, [current]: nextDraft };
    setDrafts(nextDrafts);
    if (current >= items.length - 1) {
      void finish(nextDrafts);
      return;
    }
    setCurrent((index) => index + 1);
    setActiveOption(0);
  }, [current, drafts, finish, interactionLocked, items.length]);

  const navigate = React.useCallback((nextIndex: number) => {
    if (interactionLocked || nextIndex === current || nextIndex < 0 || nextIndex >= items.length) return;
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [current]: normalizeQuestionDraft(prompt.question, currentDrafts[current]),
    }));
    setCurrent(nextIndex);
    setActiveOption(0);
    setError("");
  }, [current, interactionLocked, items.length, prompt.question]);

  const chooseOption = React.useCallback((label: string) => {
    if (interactionLocked) return;
    if (prompt.multi) {
      const selected = draft?.selectedOptions ?? [];
      const selectedOptions = selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label];
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [current]: { question: prompt.question, answer: selectedOptions.join(", "), selectedOptions, attachments: [], skipped: false, mode: "choice" },
      }));
      return;
    }
    advance({ question: prompt.question, answer: label, selectedOptions: [label], attachments: [], skipped: false, mode: "choice" });
  }, [advance, current, draft?.selectedOptions, interactionLocked, prompt]);

  const selectCustom = React.useCallback(() => {
    if (interactionLocked) return;
    setActiveOption(optionCount);
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [current]: currentDrafts[current]?.mode === "custom"
        ? currentDrafts[current]!
        : { question: prompt.question, answer: "", selectedOptions: [], attachments: [], skipped: false, mode: "custom" },
    }));
  }, [current, interactionLocked, optionCount, prompt.question]);

  const skip = React.useCallback(() => {
    if (interactionLocked) return;
    advance({ question: prompt.question, answer: "Skipped", selectedOptions: [], attachments: [], skipped: true, mode: "skipped" });
  }, [advance, interactionLocked, prompt.question]);

  const uploadFiles = React.useCallback(async (files: FileList | null) => {
    if (!files?.length || !onUploadFiles || interactionLocked) return;
    selectCustom();
    setUploading(true);
    setError("");
    try {
      const attachments = await onUploadFiles(Array.from(files));
      setDrafts((currentDrafts) => {
        const currentDraft = currentDrafts[current]?.mode === "custom"
          ? currentDrafts[current]!
          : { question: prompt.question, answer: "", selectedOptions: [], attachments: [], skipped: false, mode: "custom" as const };
        return {
          ...currentDrafts,
          [current]: { ...currentDraft, attachments: [...currentDraft.attachments, ...attachments].slice(0, 100) },
        };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to upload these files.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [current, interactionLocked, onUploadFiles, prompt.question, selectCustom]);

  const continueMulti = React.useCallback(() => {
    if (!draft || draft.selectedOptions.length === 0 || interactionLocked) return;
    advance(draft);
  }, [advance, draft, interactionLocked]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (interactionLocked || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (event.key === "Enter" && isCustom && (draft?.answer.trim() || draft?.attachments.length)) {
          event.preventDefault();
          advance({ ...draft, answer: draft.answer.trim() });
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        skip();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const change = event.key === "ArrowDown" ? 1 : -1;
        setActiveOption((index) => (index + change + optionCount + 1) % (optionCount + 1));
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < optionCount) {
          event.preventDefault();
          chooseOption(prompt.options[index]!.label);
        } else if (index === optionCount) {
          event.preventDefault();
          selectCustom();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (activeOption < optionCount) chooseOption(prompt.options[activeOption]!.label);
        else if (isCustom && (draft?.answer.trim() || draft?.attachments.length)) advance({ ...draft, answer: draft.answer.trim() });
        else selectCustom();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeOption, advance, chooseOption, draft, interactionLocked, isCustom, optionCount, prompt.options, selectCustom, skip]);

  return (
    <section className="berry-composer-question" aria-label="Berry needs your input" aria-live="polite">
      <header className="berry-composer-question-header">
        <div className="min-w-0">
          <h2 className="berry-composer-question-title">{prompt.question}</h2>
          {items.length > 1 ? <p className="berry-composer-question-count">Question {current + 1} of {items.length}</p> : null}
        </div>
        <div className="berry-composer-question-header-actions">
          {items.length > 1 ? (
            <>
              <Button type="button" variant="ghost" size="icon-sm" className="berry-composer-question-icon" disabled={interactionLocked || current === 0} aria-label="Previous question" onClick={() => navigate(current - 1)}><ArrowLeft02 /></Button>
              <Button type="button" variant="ghost" size="icon-sm" className="berry-composer-question-icon" disabled={interactionLocked || current === items.length - 1} aria-label="Next question" onClick={() => navigate(current + 1)}><ArrowRight02 /></Button>
            </>
          ) : null}
          <Button type="button" variant="ghost" size="icon-sm" className="berry-composer-question-icon" disabled={interactionLocked} aria-label="Skip this question" title="Skip this question" onClick={skip}><X /></Button>
        </div>
      </header>

      <div className="berry-composer-question-options" role={prompt.multi ? "group" : "radiogroup"} aria-label={prompt.question}>
        {prompt.options.map((option, index) => {
          const selected = draft?.selectedOptions.includes(option.label) ?? false;
          return (
            <button
              key={option.label}
              type="button"
              className={`berry-composer-question-option${selected ? " is-selected" : ""}${activeOption === index ? " is-active" : ""}`}
              disabled={interactionLocked}
              aria-pressed={prompt.multi ? selected : undefined}
              aria-checked={prompt.multi ? undefined : selected}
              role={prompt.multi ? undefined : "radio"}
              onMouseEnter={() => setActiveOption(index)}
              onClick={() => chooseOption(option.label)}
            >
              <span className="berry-composer-question-number">{index + 1}</span>
              <span className="berry-composer-question-option-copy"><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</span>
              {selected ? <Check className="berry-composer-question-selected" aria-hidden /> : <ArrowRight02 className="berry-composer-question-next" aria-hidden />}
            </button>
          );
        })}
        <div className={`berry-composer-question-option berry-composer-question-custom${isCustom ? " is-selected" : ""}${activeOption === optionCount ? " is-active" : ""}`}>
          <button type="button" className="berry-composer-question-custom-select" disabled={interactionLocked} aria-label="Enter your own answer" onMouseEnter={() => setActiveOption(optionCount)} onClick={selectCustom}>
            <span className="berry-composer-question-number">{optionCount + 1}</span>
          </button>
          {isCustom ? (
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Input
                  ref={customInputRef}
                  className="berry-composer-question-custom-input"
                  value={draft?.answer ?? ""}
                  disabled={pending}
                  placeholder="Enter your own answer"
                  onChange={(event) => {
                    const answer = event.currentTarget.value;
                    setDrafts((currentDrafts) => updateCustomAnswerDraft(currentDrafts, current, prompt.question, answer));
                  }}
                />
                {onUploadFiles ? (
                  <>
                    <input ref={fileInputRef} className="visually-hidden" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => void uploadFiles(event.currentTarget.files)} />
                    <Button type="button" variant="ghost" size="icon-sm" disabled={interactionLocked} aria-label="Attach files to this answer" title="Attach files" onClick={() => fileInputRef.current?.click()}>
                      <Paperclip />
                    </Button>
                  </>
                ) : null}
              </div>
              {uploading ? <p className="text-xs text-[var(--berry-text-tertiary)]" role="status">Uploading files…</p> : null}
              {draft?.attachments.length ? (
                <div className="flex flex-wrap gap-1.5" aria-label="Files attached to this answer">
                  {draft.attachments.map((attachment) => (
                    <span key={attachment.fileId ?? attachment.id ?? attachment.name} className="inline-flex min-w-0 max-w-56 items-center gap-1 rounded-md bg-[var(--berry-control-bg)] px-2 py-1 text-xs text-[var(--berry-text-secondary)]">
                      <Paperclip className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{attachment.name}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-sm text-[var(--berry-text-tertiary)] hover:text-[var(--berry-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--berry-focus)]"
                        aria-label={`Remove ${attachment.name}`}
                        onClick={() => setDrafts((currentDrafts) => ({
                          ...currentDrafts,
                          [current]: { ...currentDrafts[current]!, attachments: currentDrafts[current]!.attachments.filter((candidate) => candidate !== attachment) },
                        }))}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : <button type="button" className="berry-composer-question-custom-label" disabled={interactionLocked} onClick={selectCustom}>Or enter your own choice</button>}
          {isCustom && (draft?.answer.trim() || draft?.attachments.length) ? <Button type="button" variant="secondary" size="sm" className="berry-composer-question-custom-next" disabled={pending || uploading} onClick={() => advance({ ...draft, answer: draft.answer.trim() })}>{current === items.length - 1 ? "Send" : "Next"}</Button> : null}
        </div>
      </div>

      {prompt.multi && draft?.selectedOptions.length ? <Button type="button" variant="secondary" className="berry-composer-question-continue" disabled={pending} onClick={continueMulti}>{current === items.length - 1 ? "Send answers" : "Next question"}</Button> : null}
      {error ? <p className="berry-composer-question-error" role="alert">{error}</p> : null}
    </section>
  );
}
