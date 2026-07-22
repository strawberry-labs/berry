import * as React from "react";
import { memo, type ReactNode } from "react";
import { useTheme } from "next-themes";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import type { BundledLanguage, BundledTheme, ThemedToken } from "shiki";

import { Copy } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";

/* ------------------------------------------------------------------------ */
/* Streaming word reveal tuned to match the observed desktop interaction.      */
/*                                                                            */
/* Berry does NOT fade words in — streamed prose lags the raw stream and      */
/* catches up ~1/8 of its backlog every 16ms (1..24 word units per tick),     */
/* where units come from Intl.Segmenter word granularity. Text present at     */
/* mount is the baseline and never animates.                                  */
/* ------------------------------------------------------------------------ */

const REVEAL_FRAME_MS = 16;
const REVEAL_MAX_UNITS = 24;
const REVEAL_DIVISOR = 8;

function segmentUnits(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/** Reveal ceil(remaining/8) units per frame, min 1, max 24. */
function revealStep(remaining: number): number {
  return remaining <= 0 ? 0 : Math.min(REVEAL_MAX_UNITS, Math.max(1, Math.ceil(remaining / REVEAL_DIVISOR)));
}

interface RevealState {
  content: string;
  units: string[];
  visible: number;
}

function useWordReveal(text: string, streaming: boolean): string {
  // Mount baseline (Berry Gnt/EQ): whatever text exists at mount shows
  // immediately; only text that arrives afterwards is revealed gradually.
  const stateRef = React.useRef<RevealState | null>(null);
  if (stateRef.current === null) {
    const units = segmentUnits(text);
    stateRef.current = { content: text, units, visible: units.length };
  }
  const [, force] = React.useReducer((count: number) => count + 1, 0);

  const state = stateRef.current;
  if (state.content !== text) {
    const units = segmentUnits(text);
    // Berry jet: keep the reveal position across prefix-extensions; snap to
    // full when the content was rewritten (not an append) or when settled.
    const visible = !streaming || !text.startsWith(state.content) || state.visible > units.length
      ? units.length
      : Math.min(state.visible, units.length);
    stateRef.current = { content: text, units, visible };
  } else if (!streaming && state.visible < state.units.length) {
    stateRef.current = { ...state, visible: state.units.length };
  }

  const pending = stateRef.current.visible < stateRef.current.units.length;
  React.useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      const current = stateRef.current!;
      const remaining = current.units.length - current.visible;
      if (remaining <= 0) return;
      stateRef.current = { ...current, visible: Math.min(current.units.length, current.visible + revealStep(remaining)) };
      force();
    }, REVEAL_FRAME_MS);
    return () => window.clearTimeout(timer);
  });

  const current = stateRef.current;
  return current.visible >= current.units.length ? current.content : current.units.slice(0, current.visible).join("");
}

/* ------------------------------------------------------------------------ */
/* Incomplete-markdown completion for partially streamed tokens.              */
/* While streaming, dangling syntax is closed so partial tokens don't flash  */
/* as raw markdown; disabled once settled (Berry passes it `streaming`).      */
/* ------------------------------------------------------------------------ */

function completeIncompleteMarkdown(text: string): string {
  let out = text;
  // Unclosed fenced code block: close it so the partial block renders as code.
  const fences = (out.match(/^```/gm) ?? []).length;
  const inFence = fences % 2 === 1;
  if (inFence) return `${out}\n\`\`\``;
  // Unclosed inline code span.
  const lastLine = out.slice(out.lastIndexOf("\n") + 1);
  if (((lastLine.match(/`/g) ?? []).length) % 2 === 1) out += "`";
  // Unclosed bold / italic on the trailing line.
  const trailing = out.slice(out.lastIndexOf("\n") + 1);
  if (((trailing.match(/\*\*/g) ?? []).length) % 2 === 1) out += "**";
  else {
    const singles = (trailing.replace(/\*\*/g, "").match(/\*/g) ?? []).length;
    if (singles % 2 === 1) out += "*";
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Table scroll shadows (Berry rqe/nqe): the horizontal scroller gets a       */
/* directional 24px fade mask depending on which edges are scrolled out.     */
/* ------------------------------------------------------------------------ */

type ScrollShadow = "none" | "left" | "right" | "both";

const SCROLL_MASKS: Record<ScrollShadow, string> = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent_0,black_24px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_24px,black_100%)]",
  right:
    "[mask-image:linear-gradient(to_right,black_0,black_calc(100%-24px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0,black_calc(100%-24px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_right,transparent_0,black_24px,black_calc(100%-24px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_24px,black_calc(100%-24px),transparent_100%)]",
};

function MarkdownTable({ children, className, ...props }: React.ComponentProps<"table">) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = React.useState<ScrollShadow>("none");
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      const overflow = scroller.scrollWidth - scroller.clientWidth;
      if (overflow <= 1) {
        setShadow("none");
        return;
      }
      const atStart = scroller.scrollLeft <= 1;
      const atEnd = scroller.scrollLeft >= overflow - 1;
      setShadow(atStart ? "right" : atEnd ? "left" : "both");
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return (
    <div className="my-4 w-full min-w-full rounded-xl border border-border" data-markdown-table-container="">
      <div ref={scrollerRef} className={cn("w-full overflow-x-auto overflow-y-visible", SCROLL_MASKS[shadow])}>
        <table className={cn("w-max min-w-full border-separate border-spacing-0 text-[13px]", className)} {...props}>
          {children}
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Markdown body (Berry AP / MessageResponse).                                */
/* ------------------------------------------------------------------------ */

const NO_PLUGINS: never[] = [];
const FILE_PATH_RE = /((?:\.{0,2}\/|\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9_+-]+)(?::(\d+))?/g;

function openFilePath(path: string, line?: number) {
  window.dispatchEvent(new CustomEvent("berry:open-file", { detail: { path, ...(line ? { line } : {}) } }));
}

function linkifyFilePaths(children: ReactNode): ReactNode {
  return React.Children.toArray(children).flatMap((child, childIndex) => {
    if (typeof child !== "string") return [child];
    const nodes: ReactNode[] = [];
    let last = 0;
    FILE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_RE.exec(child)) !== null) {
      const path = match[1] ?? "";
      const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
      if (!path || /^https?:\/\//.test(path)) continue;
      if (match.index > last) nodes.push(child.slice(last, match.index));
      nodes.push(
        <button
          key={`${childIndex}:${match.index}`}
          type="button"
          className="font-mono text-primary underline"
          onClick={() => openFilePath(path, line)}
        >
          {path}{line ? `:${line}` : ""}
        </button>,
      );
      last = match.index + match[0].length;
    }
    if (last < child.length) nodes.push(child.slice(last));
    return nodes.length > 0 ? nodes : [child];
  });
}

/** Assistant message body: GFM markdown, Berry's prose voice and components. */
export const Markdown = memo(function Markdown({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  /** Live decode: reveal streamed words with Berry's catch-up lag and close
   * dangling markdown syntax while the stream is still running. */
  streaming?: boolean;
}) {
  const settings = useCodePreviewSettings();
  const revealed = useWordReveal(children, streaming);
  const source = streaming ? completeIncompleteMarkdown(revealed) : revealed;
  return (
    <div
      className={cn(
        // Berry AP prose: 13px, 1.75 leading, wide tracking, trimmed ends.
        "font-sans min-w-0 text-[13px] leading-[1.75] tracking-wide wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&>p]:my-3",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={NO_PLUGINS}
        components={{
          h1: ({ className: c, ...props }) => <h1 className={cn("mt-6 mb-4 text-lg font-semibold", c)} {...props} />,
          h2: ({ className: c, ...props }) => <h2 className={cn("mt-6 mb-4 text-base font-semibold", c)} {...props} />,
          h3: ({ className: c, ...props }) => <h3 className={cn("mt-6 mb-4 text-[13px] font-semibold", c)} {...props} />,
          h4: ({ className: c, ...props }) => <h4 className={cn("mt-6 mb-4 text-[13px] font-semibold", c)} {...props} />,
          h5: ({ className: c, ...props }) => <h5 className={cn("mt-6 mb-4 text-[13px] font-medium", c)} {...props} />,
          h6: ({ className: c, ...props }) => <h6 className={cn("mt-6 mb-4 text-[13px] font-normal", c)} {...props} />,
          p: ({ className: c, children, ...props }) => (
            <p className={c} {...props}>
              {linkifyFilePaths(children)}
            </p>
          ),
          a: ({ className: c, ...props }) => (
            <a className={cn("wrap-anywhere font-medium text-primary underline", c)} target="_blank" rel="noreferrer" {...props} />
          ),
          strong: ({ className: c, ...props }) => <strong className={cn("font-medium", c)} {...props} />,
          ul: ({ className: c, ...props }) => (
            <ul
              className={cn("my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-muted-foreground/70 [&_ul]:my-1.5 [&_ol]:my-1.5", c)}
              {...props}
            />
          ),
          ol: ({ className: c, ...props }) => (
            <ol
              className={cn("my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-muted-foreground/70 [&_ul]:my-1.5 [&_ol]:my-1.5", c)}
              {...props}
            />
          ),
          li: ({ className: c, children, ...props }) => <li className={cn("pl-1 [&>p]:my-0 [&>p]:inline", c)} {...props}>{linkifyFilePaths(children)}</li>,
          blockquote: ({ className: c, ...props }) => (
            <blockquote className={cn("my-4 border-l-2 border-border pl-3 text-muted-foreground [&_p]:my-0 [&_p+p]:mt-2", c)} {...props} />
          ),
          hr: ({ className: c, ...props }) => <hr className={cn("my-4 border-border", c)} {...props} />,
          pre({ children }) {
            const block = codeBlockFrom(children);
            return block ? (
              <CodeBlock {...block} settings={settings} streaming={streaming} />
            ) : (
              <CodeBlock code={String(children)} settings={settings} streaming={streaming} />
            );
          },
          code({ className, children, ...props }) {
            const isBlock = /language-/.test(className ?? "");
            return isBlock ? (
              <code className={cn("font-mono", className)} {...props}>
                {children}
              </code>
            ) : (
              <code className="rounded-lg bg-[var(--berry-surface-inset)] px-2 py-0.5 font-mono" {...props}>
                {children}
              </code>
            );
          },
          table: MarkdownTable,
          tr: ({ className: c, ...props }) => (
            <tr className={cn("transition-colors last:[&>td]:border-b-0 hover:bg-muted/20", c)} {...props} />
          ),
          th: ({ className: c, ...props }) => (
            <th
              className={cn("min-w-32 max-w-md border-b border-border px-3 py-2 text-left font-normal whitespace-normal break-words text-muted-foreground/70", c)}
              {...props}
            />
          ),
          td: ({ className: c, ...props }) => (
            <td
              className={cn("min-w-32 max-w-md border-b border-border px-3 py-2 align-top whitespace-normal break-words text-foreground", c)}
              {...props}
            />
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

interface CodePreviewSettings {
  fontSize: number;
  lineNumbers: boolean;
  wordWrap: boolean;
  theme: string;
}

/**
 * Host-injected code preview preferences. The desktop app provides these from
 * its settings store; other hosts (web) can leave the defaults. Values are
 * partial so a host can override only what it stores.
 */
export interface CodePreviewPreferences {
  lightTheme?: string;
  darkTheme?: string;
  lineNumbers?: boolean;
  wordWrap?: boolean;
  fontSize?: number;
}

export const CodePreviewPreferencesContext = React.createContext<CodePreviewPreferences>({});

function useCodePreviewSettings(): CodePreviewSettings {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const preferences = React.useContext(CodePreviewPreferencesContext);
  const lightTheme = preferences.lightTheme ?? "berry-light";
  const darkTheme = preferences.darkTheme ?? "berry-dark";
  const lineNumbers = preferences.lineNumbers ?? true;
  const wordWrap = preferences.wordWrap ?? false;
  const fontSize = preferences.fontSize ?? 13;
  return {
    fontSize: typeof fontSize === "number" ? fontSize : 13,
    lineNumbers: lineNumbers !== false,
    wordWrap: wordWrap === true,
    theme: isDark ? String(darkTheme || "berry-dark") : String(lightTheme || "berry-light"),
  };
}

function codeBlockFrom(children: ReactNode): { code: string; className?: string } | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!child || typeof child !== "object" || !("props" in child)) return null;
  const props = child.props as { children?: ReactNode; className?: string };
  return {
    code: reactNodeText(props.children).replace(/\n$/, ""),
    ...(props.className !== undefined ? { className: props.className } : {}),
  };
}

function reactNodeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactNodeText).join("");
  return "";
}

type HighlightStatus = "idle" | "highlighted" | "fallback";
interface HighlightedCode {
  status: HighlightStatus;
  lines: ThemedToken[][];
}

const HIGHLIGHT_CACHE = new Map<string, HighlightedCode>();
const HIGHLIGHT_CACHE_CAP = 100;
const THEME_MAP: Record<string, BundledTheme> = {
  "berry-light": "vitesse-light",
  "berry-dark": "vitesse-dark",
  "github-light": "github-light",
  "one-dark": "one-dark-pro",
};

function rememberHighlight(key: string, value: HighlightedCode): HighlightedCode {
  HIGHLIGHT_CACHE.delete(key);
  HIGHLIGHT_CACHE.set(key, value);
  if (HIGHLIGHT_CACHE.size > HIGHLIGHT_CACHE_CAP) {
    const first = HIGHLIGHT_CACHE.keys().next().value;
    if (first) HIGHLIGHT_CACHE.delete(first);
  }
  return value;
}

function shikiTheme(value: string): BundledTheme {
  return THEME_MAP[value] ?? "vitesse-dark";
}

function tokenStyle(token: ThemedToken): React.CSSProperties | undefined {
  const style: React.CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.bgColor) style.backgroundColor = token.bgColor;
  if (token.fontStyle !== undefined) {
    // vscode-textmate FontStyle bitmask: Italic=1, Bold=2, Underline=4.
    if (token.fontStyle & 1) style.fontStyle = "italic";
    if (token.fontStyle & 2) style.fontWeight = 700;
    if (token.fontStyle & 4) style.textDecoration = "underline";
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function fallbackTokens(lines: string[]): ThemedToken[][] {
  return lines.map((line, index) => [{ content: line || " ", offset: index }]);
}

function useHighlightedCode(code: string, language: string, theme: string): HighlightedCode {
  const lines = React.useMemo(() => code.split("\n"), [code]);
  const cacheKey = React.useMemo(() => `${theme}\0${language}\0${code}`, [code, language, theme]);
  const [highlighted, setHighlighted] = React.useState<HighlightedCode>(() => {
    return HIGHLIGHT_CACHE.get(cacheKey) ?? { status: "idle", lines: fallbackTokens(lines) };
  });

  React.useEffect(() => {
    const cached = HIGHLIGHT_CACHE.get(cacheKey);
    if (cached) {
      setHighlighted(cached);
      return;
    }
    let cancelled = false;
    setHighlighted({ status: "idle", lines: fallbackTokens(lines) });
    void import("shiki")
      .then(async (shiki) => {
        const lang = shikiLanguage(language, shiki.bundledLanguages);
        if (!lang) {
          setHighlighted(rememberHighlight(cacheKey, { status: "fallback", lines: fallbackTokens(lines) }));
          return;
        }
        const result = await shiki.codeToTokens(code, { lang, theme: shikiTheme(theme) });
        if (!cancelled) setHighlighted(rememberHighlight(cacheKey, { status: "highlighted", lines: result.tokens }));
      })
      .catch(() => {
        if (!cancelled) setHighlighted(rememberHighlight(cacheKey, { status: "fallback", lines: fallbackTokens(lines) }));
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, language, lines, theme]);

  return highlighted;
}

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  plaintext: "markdown",
  text: "markdown",
};

function shikiLanguage(language: string, bundledLanguages: Record<string, unknown>): BundledLanguage | null {
  const normalized = language.trim().toLowerCase();
  if (normalized in bundledLanguages) return normalized as BundledLanguage;
  return LANGUAGE_ALIASES[normalized] ?? null;
}

/**
 * Code block (Berry ZN/WKe/GKe): rounded-xl bordered container with a header
 * row — lowercase language label + copy button — over the code body. Uses
 * content-visibility containment for long transcripts, like Berry.
 */
function CodeBlock({
  code,
  className,
  settings,
  streaming = false,
}: {
  code: string;
  className?: string;
  settings: CodePreviewSettings;
  streaming?: boolean;
}) {
  const language = /language-([\w-]+)/.exec(className ?? "")?.[1]?.toLowerCase() ?? "text";
  const highlighted = useHighlightedCode(code, language, settings.theme);
  return (
    <div
      className="group relative my-4 w-full overflow-hidden rounded-xl border border-border bg-[var(--berry-surface-inset)]"
      data-language={language}
      data-highlight-status={highlighted.status}
      style={{ containIntrinsicSize: "auto 200px", contentVisibility: "auto" }}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-muted-foreground">
        <span className="min-w-0 truncate lowercase">{language}</span>
        <button
          type="button"
          aria-label="Copy code"
          title="Copy code"
          className="shrink-0 cursor-pointer rounded-md p-1 opacity-0 transition-opacity hover:bg-muted/40 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            toast.success("Copied");
          }}
        >
          <Copy className="size-3.5" />
        </button>
      </div>
      <pre
        data-code-theme={settings.theme}
        data-streaming={streaming || undefined}
        className={cn(
          "overflow-x-auto px-3 pt-0 pb-3 font-mono leading-relaxed",
          settings.wordWrap && "whitespace-pre-wrap break-words",
        )}
        style={{ fontSize: `${settings.fontSize}px` }}
      >
        <code className={cn("font-mono", className)}>
          {settings.lineNumbers
            ? highlighted.lines.map((line, index) => (
                <span key={index} className="flex min-w-0 gap-4">
                  <span className="w-6 shrink-0 text-right text-muted-foreground/55 select-none" aria-hidden>
                    {index + 1}
                  </span>
                  <span className={cn("min-w-0", settings.wordWrap && "whitespace-pre-wrap break-words")}>
                    {line.map((token, tokenIndex) => (
                      <span key={`${index}:${tokenIndex}`} data-shiki-token="" style={tokenStyle(token)}>
                        {token.content || " "}
                      </span>
                    ))}
                  </span>
                </span>
              ))
            : highlighted.lines.map((line, index) => (
                <span key={index}>
                  {line.map((token, tokenIndex) => (
                    <span key={`${index}:${tokenIndex}`} data-shiki-token="" style={tokenStyle(token)}>
                      {token.content || " "}
                    </span>
                  ))}
                  {index < highlighted.lines.length - 1 ? "\n" : null}
                </span>
              ))}
        </code>
      </pre>
    </div>
  );
}
