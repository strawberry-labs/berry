/**
 * Rich prompt editor — Lexical with token-mode mention nodes, replacing the
 * transparent-textarea + mirror-overlay hack. A mention is an atomic token
 * the caret can't enter, one backspace removes it whole, and
 * `getTextContent()` returns its markdown form (`@path`, `/cmd`, `$skill`,
 * `#title`) so the serialized prompt is byte-identical to what the plain
 * textarea produced — the host and wire format are untouched.
 */
import * as React from "react";
import {
  $applyNodeReplacement,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  TextNode,
  type DOMConversionMap,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { cn } from "@berry/desktop-ui/lib/utils";

import { detectTrigger, type DetectedTrigger, type MentionTrigger } from "@/lib/mentions";

/* ------------------------------ mention node ------------------------------ */

export type MentionCategory = "files" | "folders" | "commands" | "skills" | "subagents" | "sessions";

export interface PromptMentionConfig {
  id: string;
  category: MentionCategory;
  /** Visible pill text (no trigger char). */
  label: string;
  /** Serialized form included in the outgoing prompt, e.g. `@src/foo.ts`. */
  markdown: string;
}

type SerializedPromptMentionNode = Spread<
  { mentionId: string; category: MentionCategory; markdown: string },
  SerializedTextNode
>;

const CATEGORY_COLOR_VAR: Record<MentionCategory, string> = {
  files: "--berry-node-file",
  folders: "--berry-node-file",
  commands: "--berry-node-command",
  skills: "--berry-node-skill",
  subagents: "--berry-node-subagent",
  sessions: "--berry-node-session",
};

/* Inline pill icons (lucide path data). Injected
   imperatively in createDOM — safe because token-mode nodes are immutable:
   Lexical replaces the whole node on change and never rewrites its text. */
type IconShape = ["path", { d: string }] | ["rect", { x: string; y: string; width: string; height: string; rx: string }];

const CATEGORY_ICON: Record<MentionCategory, IconShape[]> = {
  files: [
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
  ],
  folders: [
    ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }],
  ],
  commands: [
    ["path", { d: "M21 5v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" }],
    ["path", { d: "m9 15 6-6" }],
  ],
  skills: [
    ["path", { d: "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" }],
    ["path", { d: "m14 7 3 3" }],
    ["path", { d: "M5 6v4" }],
    ["path", { d: "M19 14v4" }],
    ["path", { d: "M10 2v2" }],
    ["path", { d: "M7 8H3" }],
    ["path", { d: "M21 16h-4" }],
    ["path", { d: "M11 3H9" }],
  ],
  subagents: [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { x: "4", y: "8", width: "16", height: "12", rx: "2" }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }],
  ],
  sessions: [
    ["path", { d: "M14 9a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" }],
    ["path", { d: "M18 9h2a2 2 0 0 1 2 2v10l-4-4h-6a2 2 0 0 1-2-2v-1" }],
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function createMentionIcon(category: MentionCategory): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("berry-prompt-mention-icon");
  for (const [tag, attrs] of CATEGORY_ICON[category]) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    svg.appendChild(el);
  }
  return svg;
}

export class PromptMentionNode extends TextNode {
  __mentionId: string;
  __category: MentionCategory;
  __markdown: string;

  static getType(): string {
    return "prompt-mention";
  }

  static clone(node: PromptMentionNode): PromptMentionNode {
    return new PromptMentionNode(
      { id: node.__mentionId, category: node.__category, label: node.__text, markdown: node.__markdown },
      node.__key,
    );
  }

  static importJSON(serialized: SerializedPromptMentionNode): PromptMentionNode {
    const node = $createPromptMentionNode({
      id: serialized.mentionId,
      category: serialized.category,
      label: serialized.text,
      markdown: serialized.markdown,
    });
    node.setFormat(serialized.format);
    node.setDetail(serialized.detail);
    node.setStyle(serialized.style);
    return node;
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  constructor(config: PromptMentionConfig, key?: NodeKey) {
    super(config.label, key);
    this.__mentionId = config.id;
    this.__category = config.category;
    this.__markdown = config.markdown;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = "berry-prompt-mention";
    dom.setAttribute("data-mention-category", this.__category);
    dom.setAttribute("spellcheck", "false");
    dom.style.color = `var(${CATEGORY_COLOR_VAR[this.__category]})`;
    // The text node must stay dom.firstChild — Lexical's getDOMTextNode walks
    // the firstChild chain and re-appends the text if an element sits first.
    // The icon is appended after and flex-ordered before the label.
    dom.appendChild(createMentionIcon(this.__category));
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const updated = super.updateDOM(prevNode, dom, config);
    if (prevNode.__category !== this.__category) {
      dom.setAttribute("data-mention-category", this.__category);
      dom.style.color = `var(${CATEGORY_COLOR_VAR[this.__category]})`;
    }
    return updated;
  }

  exportJSON(): SerializedPromptMentionNode {
    return {
      ...super.exportJSON(),
      type: "prompt-mention",
      version: 1,
      mentionId: this.__mentionId,
      category: this.__category,
      markdown: this.__markdown,
    };
  }

  /** The prompt text the model sees — identical to the old plain-text form. */
  getTextContent(): string {
    return this.__markdown;
  }

  isTextEntity(): boolean {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createPromptMentionNode(config: PromptMentionConfig): PromptMentionNode {
  const node = new PromptMentionNode(config);
  // Token mode = atomic: the caret can't land inside, backspace deletes whole.
  node.setMode("token");
  return $applyNodeReplacement(node);
}

/* ------------------------------ controller API ---------------------------- */

/** What the editor needs from the mention system (a subset of MentionsController). */
export interface PromptEditorMentions {
  open: boolean;
  moveActive: (delta: 1 | -1) => void;
  selectActive: () => boolean;
  dismiss: () => void;
  /** Editor → controller: the trigger token under the caret changed. */
  onDetectedChange: (detected: DetectedTrigger | null) => void;
}

export interface PromptEditorHandle {
  focus: () => void;
  clear: () => void;
  /** Appends text (used by the "+" menu to insert a bare trigger char). */
  insertText: (text: string) => void;
  /** Replaces the active trigger token with an atomic mention node. */
  insertMention: (config: PromptMentionConfig, trigger: MentionTrigger) => void;
}

/* -------------------------------- plugins --------------------------------- */

/** Watches the selection and reports the active trigger token (or null). */
function MentionDetectPlugin({ mentionsRef }: { mentionsRef: React.RefObject<PromptEditorMentions | null> }) {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        let detected: DetectedTrigger | null = null;
        if ($isRangeSelection(selection) && selection.isCollapsed()) {
          const anchor = selection.anchor;
          const node = anchor.getNode();
          // Only plain text nodes host trigger tokens; mention nodes are atomic.
          if ($isTextNode(node) && !(node instanceof PromptMentionNode)) {
            detected = detectTrigger(node.getTextContent().slice(0, anchor.offset));
          }
        }
        mentionsRef.current?.onDetectedChange(detected);
      });
    });
  }, [editor, mentionsRef]);
  return null;
}

/** Menu keyboard handling at CRITICAL priority so it wins over submit/newline. */
function MentionKeysPlugin({ mentionsRef }: { mentionsRef: React.RefObject<PromptEditorMentions | null> }) {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => {
    const whenOpen = (handle: (event: KeyboardEvent | null) => boolean) => (event: KeyboardEvent | null) => {
      const mentions = mentionsRef.current;
      if (!mentions?.open) return false;
      return handle(event);
    };
    const unregister = [
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        whenOpen((event) => {
          event?.preventDefault();
          mentionsRef.current?.moveActive(1);
          return true;
        }),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        whenOpen((event) => {
          event?.preventDefault();
          mentionsRef.current?.moveActive(-1);
          return true;
        }),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        whenOpen((event) => {
          if (!mentionsRef.current?.selectActive()) return false;
          event?.preventDefault();
          return true;
        }),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        whenOpen((event) => {
          if (!mentionsRef.current?.selectActive()) return false;
          event?.preventDefault();
          return true;
        }),
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        whenOpen((event) => {
          event?.preventDefault();
          mentionsRef.current?.dismiss();
          return true;
        }),
        COMMAND_PRIORITY_CRITICAL,
      ),
    ];
    return () => unregister.forEach((fn) => fn());
  }, [editor, mentionsRef]);
  return null;
}

/** Enter submits; Shift+Enter falls through to Lexical's linebreak. */
function SubmitPlugin({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  const submitRef = React.useRef(onSubmit);
  submitRef.current = onSubmit;
  React.useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false;
        event?.preventDefault();
        submitRef.current();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);
  return null;
}

/** Files and large text go to the attachments pipeline; small text pastes normally. */
function PastePlugin({ onPaste }: { onPaste?: (event: ClipboardEvent) => boolean }) {
  const [editor] = useLexicalComposerContext();
  const pasteRef = React.useRef(onPaste);
  pasteRef.current = onPaste;
  React.useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) return false;
        return pasteRef.current?.(event) ?? false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);
  return null;
}

/** Bridges the imperative handle to the editor instance. */
function HandlePlugin({
  handleRef,
  autoFocus,
  initialText,
}: {
  handleRef: React.RefObject<{ editor: LexicalEditor | null }>;
  autoFocus?: boolean;
  initialText?: string;
}) {
  const [editor] = useLexicalComposerContext();
  handleRef.current.editor = editor;
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (initialText && !seededRef.current) {
      seededRef.current = true;
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        const lines = initialText.split("\n");
        lines.forEach((line, index) => {
          if (index > 0) paragraph.append($createLineBreakNode());
          if (line) paragraph.append($createTextNode(line));
        });
        root.append(paragraph);
        paragraph.selectEnd();
      });
    }
    if (autoFocus) editor.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  return null;
}

/* ------------------------------- component -------------------------------- */

/** Replaces the trigger token around the caret with a mention node + space. */
function $insertMentionAtSelection(config: PromptMentionConfig): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  if (!$isTextNode(node) || node instanceof PromptMentionNode) return;
  const text = node.getTextContent();
  const offset = anchor.offset;
  const detected = detectTrigger(text.slice(0, offset));
  if (!detected) return;
  const tail = /^[^\s@/$#]*/.exec(text.slice(offset))?.[0] ?? "";
  const start = detected.tokenStart;
  const tokenLength = offset + tail.length - start;

  let target = node;
  if (start > 0) {
    const pieces = node.splitText(start);
    target = pieces[1] ?? pieces[0]!;
  }
  if (target.getTextContent().length > tokenLength) {
    const pieces = target.splitText(tokenLength);
    target = pieces[0]!;
  }
  const mention = $createPromptMentionNode(config);
  target.replace(mention);
  const space = $createTextNode(" ");
  mention.insertAfter(space);
  space.select(1, 1);
}

export const PromptEditor = React.forwardRef(function PromptEditor(
  {
    placeholder,
    autoFocus = false,
    initialText,
    mentions,
    onChange,
    onSubmit,
    onEscape,
    onPasteEvent,
    className,
    testId = "composer-input",
  }: {
    placeholder: string;
    autoFocus?: boolean;
    initialText?: string;
    mentions?: PromptEditorMentions;
    onChange: (text: string) => void;
    onSubmit: () => void;
    onEscape?: () => void;
    /** Return true when the paste was consumed (files / large text). */
    onPasteEvent?: (event: ClipboardEvent) => boolean;
    className?: string;
    testId?: string;
  },
  ref: React.Ref<PromptEditorHandle>,
) {
  const editorBox = React.useRef<{ editor: LexicalEditor | null }>({ editor: null });
  const mentionsRef = React.useRef<PromptEditorMentions | null>(mentions ?? null);
  mentionsRef.current = mentions ?? null;

  React.useImperativeHandle(
    ref,
    (): PromptEditorHandle => ({
      focus: () => editorBox.current.editor?.focus(),
      clear: () => {
        editorBox.current.editor?.update(() => {
          $getRoot().clear();
        });
      },
      insertText: (text: string) => {
        const editor = editorBox.current.editor;
        if (!editor) return;
        editor.update(() => {
          const root = $getRoot();
          const current = root.getTextContent();
          const needsSpace = current.length > 0 && !current.endsWith(" ") && !current.endsWith("\n");
          root.selectEnd();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.insertText(`${needsSpace ? " " : ""}${text}`);
        });
        editor.focus();
      },
      insertMention: (config: PromptMentionConfig) => {
        const editor = editorBox.current.editor;
        if (!editor) return;
        editor.update(() => {
          $insertMentionAtSelection(config);
        });
        editor.focus();
      },
    }),
    [],
  );

  const initialConfig = React.useMemo(
    () => ({
      namespace: "berry-prompt",
      nodes: [PromptMentionNode],
      onError: (error: Error) => {
        console.error("[prompt-editor]", error);
      },
      theme: {
        paragraph: "berry-prompt-paragraph",
      },
    }),
    [],
  );

  const escapeRef = React.useRef(onEscape);
  escapeRef.current = onEscape;

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className={cn("berry-prompt-editor-wrap relative flex-1", className)}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="berry-prompt-editor w-full outline-none"
              data-testid={testId}
              aria-placeholder={placeholder}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !mentionsRef.current?.open) escapeRef.current?.();
              }}
              placeholder={<div className="berry-prompt-placeholder pointer-events-none absolute select-none">{placeholder}</div>}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(editorState) => {
            editorState.read(() => {
              onChange($getRoot().getTextContent());
            });
          }}
        />
        <HandlePlugin handleRef={editorBox} autoFocus={autoFocus} initialText={initialText} />
        {mentions ? <MentionDetectPlugin mentionsRef={mentionsRef} /> : null}
        {mentions ? <MentionKeysPlugin mentionsRef={mentionsRef} /> : null}
        <SubmitPlugin onSubmit={onSubmit} />
        <PastePlugin onPaste={onPasteEvent} />
      </div>
    </LexicalComposer>
  );
});
