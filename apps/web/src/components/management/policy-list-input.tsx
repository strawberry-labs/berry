import * as React from "react";
import { X } from "lucide-react";

export function parsePolicyItems(text: string, domains: boolean): string[] {
  const items = text.split(/[\s,;]+/).filter(Boolean).map((item) => domains ? item.toLowerCase() : item);
  if (domains && items.some((item) => {
    const host = item.startsWith("*.") ? item.slice(2) : item;
    return host.length > 253 || !host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part));
  })) throw new Error("Enter a domain such as example.com or *.example.com, without https://, a port, or a path.");
  return [...new Set(items)];
}

export function PolicyListInput({ id, label, value, onChange, disabled, domains = false }: {
  id: string; label: string; value: string[]; onChange: (items: string[]) => void; disabled: boolean; domains?: boolean;
}) {
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);
  function commit(text = draft) {
    try {
      const items = parsePolicyItems(text, domains);
      onChange([...new Set([...value, ...items])]);
      setDraft(""); setError(""); input.current?.setCustomValidity("");
    } catch (cause) {
      const message = (cause as Error).message;
      setDraft(text); setError(message); input.current?.setCustomValidity(message);
    }
  }
  return <div className="min-w-0">
    <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--berry-border)] bg-[var(--berry-control-bg)] p-2 focus-within:outline-2 focus-within:outline-[var(--berry-focus)]" onClick={() => input.current?.focus()}>
      {value.map((item, index) => <span key={`${item}:${index}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--berry-border)] bg-[var(--berry-main-bg)] py-1 pl-2 pr-1 text-xs">
        <span className="min-w-0 break-all">{item}</span>
        <button type="button" disabled={disabled} aria-label={`Remove ${item} from ${label}`} className="grid size-6 shrink-0 place-items-center rounded hover:bg-[var(--berry-hover)] focus-visible:outline-2 disabled:opacity-40" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onChange(value.filter((_, i) => i !== index)); input.current?.focus(); }}><X size={12} /></button>
      </span>)}
      <input ref={input} id={id} aria-label={label} aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} disabled={disabled} value={draft} autoComplete="off" spellCheck={false} placeholder={domains ? "Add a domain…" : "Add an item…"} className="min-w-24 flex-1 bg-transparent px-1 py-1 text-sm outline-none disabled:opacity-50" onChange={(event) => { setDraft(event.target.value); setError(""); event.target.setCustomValidity(""); }} onBlur={() => { if (draft.trim()) commit(); }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (["Enter", ",", ";"].includes(event.key)) { event.preventDefault(); commit(); }
        else if (event.key === "Tab" && draft.trim()) commit();
      }} onPaste={(event) => { const text = event.clipboardData.getData("text"); if (/[\s,;]/.test(text)) { event.preventDefault(); const target = event.currentTarget; commit(draft.slice(0, target.selectionStart ?? draft.length) + text + draft.slice(target.selectionEnd ?? draft.length)); } }} />
    </div>
    <p id={`${id}-hint`} className="mt-1.5 text-[11px] leading-4 text-[var(--berry-text-secondary)]">Press Enter to add. You can paste several {domains ? "domains" : "items"} at once.</p>
    {error && <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-[var(--berry-danger)]">{error}</p>}
  </div>;
}
