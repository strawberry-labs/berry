import * as React from "react";
import type { QuestionPrompt } from "@berry/desktop-ui/components/thread-stream";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { ArrowLeft02, ArrowRight02, Check, X } from "@berry/desktop-ui/lib/icons";

export interface ComposerQuestionAnswer {
  question: string;
  answer: string;
  selectedOptions: string[];
  skipped: boolean;
}

type Draft = ComposerQuestionAnswer & {
  /** Keeps an intentionally empty multi-select distinct from a custom response. */
  mode: "choice" | "custom" | "skipped";
};

function promptItems(question: QuestionPrompt) {
  return question.questions.length > 0
    ? question.questions
    : [{ question: question.question, options: question.options, multi: question.multi }];
}

/** A compact transcript is both human-readable in the chat and safe to save as
 * a normal user message. The agent receives the richer `answers` payload. */
export function questionAnswerTranscript(answers: ComposerQuestionAnswer[]): string {
  return answers.map((item) => `› ${item.question}\n${item.skipped ? "Skipped" : item.answer}`).join("\n\n");
}

export function questionToolAnswer(answers: ComposerQuestionAnswer[]): string {
  return answers.map((item) => `${item.question}: ${item.skipped ? "Skipped" : item.answer}`).join("\n");
}

export function ComposerQuestionOverlay({
  question,
  onSubmit,
}: {
  question: QuestionPrompt;
  onSubmit: (answers: ComposerQuestionAnswer[]) => Promise<void>;
}) {
  const items = React.useMemo(() => promptItems(question), [question]);
  const [current, setCurrent] = React.useState(0);
  const [drafts, setDrafts] = React.useState<Record<number, Draft>>({});
  const [activeOption, setActiveOption] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState("");
  const customInputRef = React.useRef<HTMLInputElement>(null);
  const prompt = items[current]!;
  const draft = drafts[current];
  const isCustom = draft?.mode === "custom";
  const optionCount = prompt.options.length;

  React.useEffect(() => {
    setCurrent(0);
    setDrafts({});
    setActiveOption(0);
    setPending(false);
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
      const draft = nextDrafts[index];
      if (!draft) {
        return { question: item.question, answer: "Skipped", selectedOptions: [], skipped: true };
      }
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
    const nextDrafts = { ...drafts, [current]: nextDraft };
    setDrafts(nextDrafts);
    if (current >= items.length - 1) {
      void finish(nextDrafts);
      return;
    }
    setCurrent((index) => index + 1);
    setActiveOption(0);
  }, [current, drafts, finish, items.length]);

  const chooseOption = React.useCallback((label: string) => {
    if (pending) return;
    if (prompt.multi) {
      const selected = draft?.selectedOptions ?? [];
      const selectedOptions = selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label];
      setDrafts((currentDrafts) => ({
        ...currentDrafts,
        [current]: { question: prompt.question, answer: selectedOptions.join(", "), selectedOptions, skipped: false, mode: "choice" },
      }));
      return;
    }
    advance({ question: prompt.question, answer: label, selectedOptions: [label], skipped: false, mode: "choice" });
  }, [advance, current, draft?.selectedOptions, pending, prompt]);

  const selectCustom = React.useCallback(() => {
    if (pending) return;
    setActiveOption(optionCount);
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [current]: currentDrafts[current]?.mode === "custom"
        ? currentDrafts[current]!
        : { question: prompt.question, answer: "", selectedOptions: [], skipped: false, mode: "custom" },
    }));
  }, [current, optionCount, pending, prompt.question]);

  const skip = React.useCallback(() => {
    if (pending) return;
    advance({ question: prompt.question, answer: "Skipped", selectedOptions: [], skipped: true, mode: "skipped" });
  }, [advance, pending, prompt.question]);

  const continueMulti = React.useCallback(() => {
    if (!draft || draft.selectedOptions.length === 0 || pending) return;
    advance(draft);
  }, [advance, draft, pending]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pending || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (event.key === "Enter" && isCustom && draft?.answer.trim()) {
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
        else if (isCustom && draft?.answer.trim()) advance({ ...draft, answer: draft.answer.trim() });
        else selectCustom();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeOption, advance, chooseOption, draft, isCustom, optionCount, pending, prompt.options, selectCustom, skip]);

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
              <Button type="button" variant="ghost" size="icon-sm" className="berry-composer-question-icon" disabled={pending || current === 0} aria-label="Previous question" onClick={() => setCurrent((index) => Math.max(0, index - 1))}><ArrowLeft02 /></Button>
              <Button type="button" variant="ghost" size="icon-sm" className="berry-composer-question-icon" disabled={pending || current === items.length - 1} aria-label="Next question" onClick={() => setCurrent((index) => Math.min(items.length - 1, index + 1))}><ArrowRight02 /></Button>
            </>
          ) : null}
          <Button type="button" variant="ghost" size="icon-sm" className="berry-composer-question-icon" disabled={pending} aria-label="Skip this question" title="Skip this question" onClick={skip}><X /></Button>
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
              disabled={pending}
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
          <button type="button" className="berry-composer-question-custom-select" disabled={pending} aria-label="Enter your own answer" onMouseEnter={() => setActiveOption(optionCount)} onClick={selectCustom}>
            <span className="berry-composer-question-number">{optionCount + 1}</span>
          </button>
          {isCustom ? (
            <Input
              ref={customInputRef}
              className="berry-composer-question-custom-input"
              value={draft?.answer ?? ""}
              disabled={pending}
              placeholder="Enter your own answer"
              onChange={(event) => setDrafts((currentDrafts) => ({ ...currentDrafts, [current]: { question: prompt.question, answer: event.currentTarget.value, selectedOptions: [], skipped: false, mode: "custom" } }))}
            />
          ) : <button type="button" className="berry-composer-question-custom-label" disabled={pending} onClick={selectCustom}>Or enter your own choice</button>}
          {isCustom && draft?.answer.trim() ? <Button type="button" variant="secondary" size="sm" className="berry-composer-question-custom-next" disabled={pending} onClick={() => advance({ ...draft, answer: draft.answer.trim() })}>{current === items.length - 1 ? "Send" : "Next"}</Button> : null}
        </div>
      </div>

      {prompt.multi && draft?.selectedOptions.length ? <Button type="button" variant="secondary" className="berry-composer-question-continue" disabled={pending} onClick={continueMulti}>{current === items.length - 1 ? "Send answers" : "Next question"}</Button> : null}
      {error ? <p className="berry-composer-question-error" role="alert">{error}</p> : null}
    </section>
  );
}
