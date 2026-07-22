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
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  TextNode,
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
import { detectTrigger, type DetectedTrigger, type MentionTrigger } from "@/lib/mentions";

export type MentionCategory = "files" | "folders" | "commands" | "skills" | "subagents" | "sessions";

export interface PromptMentionConfig {
  id: string;
  category: MentionCategory;
  label: string;
  markdown: string;
}

type SerializedPromptMentionNode = Spread<
  { mentionId: string; category: MentionCategory; markdown: string },
  SerializedTextNode
>;

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
    return new PromptMentionNode({
      id: serialized.mentionId,
      category: serialized.category,
      label: serialized.text,
      markdown: serialized.markdown,
    });
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
    return dom;
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

function $createPromptMentionNode(config: PromptMentionConfig): PromptMentionNode {
  const node = new PromptMentionNode(config);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export interface PromptEditorMentions {
  open: boolean;
  moveActive: (delta: 1 | -1) => void;
  selectActive: () => boolean;
  dismiss: () => void;
  onDetectedChange: (detected: DetectedTrigger | null) => void;
}

export interface PromptEditorHandle {
  focus: () => void;
  clear: () => void;
  insertText: (text: string) => void;
  insertMention: (config: PromptMentionConfig, trigger: MentionTrigger) => void;
}

function MentionDetectPlugin({ mentionsRef }: { mentionsRef: React.RefObject<PromptEditorMentions | null> }) {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const selection = $getSelection();
      let detected: DetectedTrigger | null = null;
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const node = selection.anchor.getNode();
        if ($isTextNode(node) && !(node instanceof PromptMentionNode)) {
          detected = detectTrigger(node.getTextContent().slice(0, selection.anchor.offset));
        }
      }
      mentionsRef.current?.onDetectedChange(detected);
    });
  }), [editor, mentionsRef]);
  return null;
}

function MentionKeysPlugin({ mentionsRef }: { mentionsRef: React.RefObject<PromptEditorMentions | null> }) {
  const [editor] = useLexicalComposerContext();
  React.useEffect(() => {
    const whenOpen = (handle: (event: KeyboardEvent | null) => boolean) => (event: KeyboardEvent | null) => {
      if (!mentionsRef.current?.open) return false;
      return handle(event);
    };
    const unregister = [
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, whenOpen((event) => {
        event?.preventDefault();
        mentionsRef.current?.moveActive(1);
        return true;
      }), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, whenOpen((event) => {
        event?.preventDefault();
        mentionsRef.current?.moveActive(-1);
        return true;
      }), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ENTER_COMMAND, whenOpen((event) => {
        if (!mentionsRef.current?.selectActive()) return false;
        event?.preventDefault();
        return true;
      }), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_TAB_COMMAND, whenOpen((event) => {
        if (!mentionsRef.current?.selectActive()) return false;
        event?.preventDefault();
        return true;
      }), COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, whenOpen((event) => {
        event?.preventDefault();
        mentionsRef.current?.dismiss();
        return true;
      }), COMMAND_PRIORITY_CRITICAL),
    ];
    return () => unregister.forEach((fn) => fn());
  }, [editor, mentionsRef]);
  return null;
}

function EscapePlugin({ onEscape }: { onEscape: () => void }) {
  const [editor] = useLexicalComposerContext();
  const escapeRef = React.useRef(onEscape);
  escapeRef.current = onEscape;
  React.useEffect(() => editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
    event?.preventDefault();
    escapeRef.current();
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  return null;
}

function SubmitPlugin({ onSubmit }: { onSubmit: (event: KeyboardEvent | null) => void }) {
  const [editor] = useLexicalComposerContext();
  const submitRef = React.useRef(onSubmit);
  submitRef.current = onSubmit;
  React.useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
    if (event?.shiftKey) return false;
    event?.preventDefault();
    submitRef.current(event ?? null);
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  return null;
}

function PastePlugin({ onPaste }: { onPaste?: ((event: ClipboardEvent) => boolean) | undefined }) {
  const [editor] = useLexicalComposerContext();
  const pasteRef = React.useRef(onPaste);
  pasteRef.current = onPaste;
  React.useEffect(() => editor.registerCommand(PASTE_COMMAND, (event) => {
    if (!(event instanceof ClipboardEvent)) return false;
    return pasteRef.current?.(event) ?? false;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  return null;
}

function HandlePlugin({
  handleRef,
  autoFocus,
  initialText,
}: {
  handleRef: React.RefObject<{ editor: LexicalEditor | null }>;
  autoFocus?: boolean;
  initialText?: string | undefined;
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
        initialText.split("\n").forEach((line, index) => {
          if (index > 0) paragraph.append($createLineBreakNode());
          if (line) paragraph.append($createTextNode(line));
        });
        root.append(paragraph);
        paragraph.selectEnd();
      });
    }
    if (autoFocus) editor.focus();
  }, [autoFocus, editor, initialText]);
  return null;
}

function $insertMentionAtSelection(config: PromptMentionConfig): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node) || node instanceof PromptMentionNode) return;
  const text = node.getTextContent();
  const offset = selection.anchor.offset;
  const detected = detectTrigger(text.slice(0, offset));
  if (!detected) return;
  const tail = /^[^\s@/$#]*/.exec(text.slice(offset))?.[0] ?? "";
  const start = detected.tokenStart;
  const tokenLength = offset + tail.length - start;
  let target = node;
  if (start > 0) target = node.splitText(start)[1] ?? node;
  if (target.getTextContent().length > tokenLength) target = target.splitText(tokenLength)[0] ?? target;
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
    testId = "composer-input",
  }: {
    placeholder: string;
    autoFocus?: boolean;
    initialText?: string | undefined;
    mentions?: PromptEditorMentions | undefined;
    onChange: (text: string) => void;
  onSubmit: (event: KeyboardEvent | null) => void;
    onEscape?: (() => void) | undefined;
    onPasteEvent?: ((event: ClipboardEvent) => boolean) | undefined;
    testId?: string;
  },
  ref: React.Ref<PromptEditorHandle>,
) {
  const editorBox = React.useRef<{ editor: LexicalEditor | null }>({ editor: null });
  const mentionsRef = React.useRef<PromptEditorMentions | null>(mentions ?? null);
  mentionsRef.current = mentions ?? null;

  React.useImperativeHandle(ref, () => ({
    focus: () => editorBox.current.editor?.focus(),
    clear: () => editorBox.current.editor?.update(() => $getRoot().clear()),
    insertText: (text: string) => {
      const editor = editorBox.current.editor;
      if (!editor) return;
      editor.update(() => {
        const root = $getRoot();
        const current = root.getTextContent();
        root.selectEnd();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(`${current && !current.endsWith(" ") ? " " : ""}${text}`);
      });
      editor.focus();
    },
    insertMention: (config) => {
      const editor = editorBox.current.editor;
      if (!editor) return;
      editor.update(() => $insertMentionAtSelection(config));
      editor.focus();
    },
  }), []);

  const initialConfig = React.useMemo(() => ({
    namespace: "berry-web-prompt",
    nodes: [PromptMentionNode],
    onError: (error: Error) => console.error("[prompt-editor]", error),
    theme: { paragraph: "berry-prompt-paragraph" },
  }), []);

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="berry-prompt-editor-wrap">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="berry-prompt-editor"
              data-testid={testId}
              aria-label={placeholder}
              aria-placeholder={placeholder}
              placeholder={<div className="berry-prompt-placeholder pointer-events-none absolute select-none">{placeholder}</div>}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(editorState) => editorState.read(() => onChange($getRoot().getTextContent()))}
        />
        <HandlePlugin handleRef={editorBox} autoFocus={autoFocus} initialText={initialText} />
        {mentions ? <MentionDetectPlugin mentionsRef={mentionsRef} /> : null}
        {mentions ? <MentionKeysPlugin mentionsRef={mentionsRef} /> : null}
        <SubmitPlugin onSubmit={onSubmit} />
        {onEscape ? <EscapePlugin onEscape={onEscape} /> : null}
        <PastePlugin onPaste={onPasteEvent} />
      </div>
    </LexicalComposer>
  );
});
