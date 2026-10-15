/* ------------------------------------------------------------------------ */
/* Selection copies from rendered messages (H-044).                           */
/*                                                                            */
/* Browsers serialize a copied selection with its computed styles, so Berry's */
/* theme (dark surfaces, light text, code token colours) pasted into Outlook  */
/* and Gmail as a black block. A copy inside the message list writes the      */
/* selected text and HTML that keeps only the semantic structure: paragraphs, */
/* line breaks, lists, tables, headings, emphasis, links and code. Computed   */
/* styles are read only to tell blocks from inline text and to leave out      */
/* hidden or unselectable parts; no style, class or data attribute is copied. */
/* ------------------------------------------------------------------------ */

/** The computed properties that decide what a copied element becomes. */
export interface CopyStyle {
  display: string;
  visibility: string;
  whiteSpace: string;
  userSelect: string;
  webkitUserSelect?: string;
}

export type CopyStyleReader = (element: Element) => CopyStyle;

export interface MessageCopyEvent {
  readonly clipboardData: Pick<DataTransfer, "setData"> | null;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// Inline controls whose text is part of the message, such as linkified file paths.
const COPY_AS_TEXT = "data-copy-text";

// Semantic elements copied as themselves; their attributes are rebuilt, never copied.
const STRUCTURE = new Set(["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td"]);
const PHRASES = new Map([["strong", "strong"], ["b", "strong"], ["em", "em"], ["i", "em"], ["code", "code"], ["del", "del"], ["s", "del"], ["sup", "sup"], ["sub", "sub"], ["a", "a"]]);
const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
// Controls, media and other non-text elements are left out with everything inside them.
const OMITTED = new Set(["button", "input", "textarea", "select", "summary", "svg", "img", "picture", "video", "audio", "canvas", "iframe", "object", "embed", "script", "style", "template", "noscript"]);
const CONTROL_ROLES = new Set(["button", "checkbox", "menu", "menuitem", "radio", "slider", "switch", "tab", "tablist", "toolbar"]);
const CODE_EDITORS = ["monaco-editor", "cm-editor", "CodeMirror"];
const BLOCK_HTML = /<(?:p|div|h[1-6]|ul|ol|li|table|pre|blockquote|hr|br)\b/;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };

interface Walk {
  range: Range;
  styleOf: CopyStyleReader;
  styles: Map<Element, CopyStyle>;
  common: Node;
  /** The common ancestor and its ancestors inside the scope: they hold both ends of the selection. */
  enclosing: Set<Node>;
  /** Table parts kept around a selection that spans cells or rows of one table. */
  tableFrame: Set<Node>;
  touchesEditor: boolean;
}

/**
 * Writes a selection copied from inside `scope` as plain text and sanitized
 * HTML. Returns false and leaves the browser's copy alone when the selection
 * reaches outside `scope`, starts in an input, a text area or the composer, or
 * runs through an editor. Firefox splits a selection around unselectable
 * content into several ranges; it copies without computed colours, so those
 * selections are left to the browser too.
 */
export function copyMessageSelection(
  event: MessageCopyEvent,
  scope: Node,
  selection: Selection | null,
  styleOf: CopyStyleReader = computedCopyStyle,
): boolean {
  if (event.defaultPrevented || !event.clipboardData || !selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
  if (isNode(event.target) && insideEditor(event.target)) return false;
  const range = selection.getRangeAt(0);
  if (!within(scope, range.startContainer) || !within(scope, range.endContainer) || insideEditor(range.commonAncestorContainer)) return false;
  const text = selection.toString();
  if (!text.trim()) return false;
  const html = selectionHtml(range, scope, styleOf);
  if (html === null) return false;
  event.clipboardData.setData("text/plain", text);
  // A selection of controls alone has no HTML worth keeping; plain text pastes clean.
  if (/\S/.test(html.replace(/<[^>]*>/g, ""))) event.clipboardData.setData("text/html", `<meta charset="utf-8">${html}`);
  event.preventDefault();
  return true;
}

/** Sanitized HTML for one selected range inside `scope`, or null when it runs through an editor. */
function selectionHtml(range: Range, scope: Node, styleOf: CopyStyleReader): string | null {
  const common = range.commonAncestorContainer;
  const enclosing = new Set<Node>();
  for (let node: Node | null = common; node && node !== scope; node = node.parentNode) enclosing.add(node);
  const tableFrame = new Set<Node>();
  for (let node: Node | null = common; node && node !== scope && isElement(node) && TABLE_PARTS.has(node.localName); node = node.parentNode) {
    tableFrame.add(node);
    if (node.localName === "table") break;
  }
  const walk: Walk = { range, styleOf, styles: new Map(), common, enclosing, tableFrame, touchesEditor: false };
  const html = childrenHtml(scope, walk);
  if (walk.touchesEditor) return null;
  // A right-to-left answer sets its direction once, on the Markdown root the
  // selection sits inside; the copied fragment keeps it (H-047).
  const direction = enclosingDirection(common, scope);
  if (!direction || !html) return html;
  const wrapper = BLOCK_HTML.test(html) ? "div" : "span";
  return `<${wrapper} dir="${direction}">${html}</${wrapper}>`;
}

function enclosingDirection(common: Node, scope: Node): "ltr" | "rtl" | null {
  for (let node: Node | null = common; node && node !== scope; node = node.parentNode) {
    if (!isElement(node)) continue;
    const direction = node.getAttribute("dir")?.toLowerCase();
    if (direction === "ltr" || direction === "rtl") return direction;
  }
  return null;
}

function childrenHtml(parent: Node, walk: Walk): string {
  let html = "";
  for (const child of parent.childNodes) {
    if (walk.range.intersectsNode(child)) html += nodeHtml(child, walk);
  }
  return html;
}

function nodeHtml(node: Node, walk: Walk): string {
  if (node.nodeType === TEXT_NODE) return textHtml(node as Text, walk);
  if (!isElement(node)) return "";
  if (isEditor(node)) {
    walk.touchesEditor = true;
    return "";
  }
  if (node.hasAttribute(COPY_AS_TEXT)) return escapeHtml(selectedText(node, walk));
  const style = styleFor(node, walk);
  if (isOmitted(node, style)) return "";
  // KaTeX draws math twice (MathML and positioned spans); its TeX source pastes legibly.
  if (hasClass(node, "katex")) return escapeHtml(texSource(node));
  if (node.localName === "pre") {
    const code = preformattedText(node, walk);
    // A selection inside one line of a code block pastes as inline code.
    return walk.enclosing.has(node) && !code.includes("\n")
      ? `<code>${escapeHtml(code)}</code>`
      : `<pre${directionAttribute(node)}>${escapeHtml(code)}</pre>`;
  }
  const inner = childrenHtml(node, walk);
  const tag = outputTag(node, style, walk);
  if (!tag) return inner;
  if (tag === "br" || tag === "hr") return `<${tag}>`;
  // Wrappers left empty by omitted controls (an accordion heading around its button) are dropped.
  if (!inner.trim() && tag !== "td" && tag !== "th") return "";
  return `<${tag}${attributesFor(node, tag)}>${inner}</${tag}>`;
}

function outputTag(element: Element, style: CopyStyle, walk: Walk): string | null {
  const name = element.localName;
  const phrase = PHRASES.get(name);
  if (phrase) return phrase !== "a" || safeHref(element) ? phrase : null;
  // An element around both ends of the selection stays only when the selected
  // parts need it: the list or table whose items, rows or cells are selected.
  if (walk.enclosing.has(element)) {
    if (walk.tableFrame.has(element)) return name;
    return (name === "ul" || name === "ol") && element === walk.common ? name : null;
  }
  if (STRUCTURE.has(name)) return name;
  return isBlockDisplay(style.display) ? "div" : null;
}

function textHtml(node: Text, walk: Walk): string {
  const text = selectedSlice(node, walk.range);
  if (!text) return "";
  const escaped = escapeHtml(text);
  const parent = node.parentNode;
  // Line breaks the page shows through white-space (prompts, drafts, live text) stay line breaks.
  return parent && isElement(parent) && /^(pre|break-spaces)/.test(styleFor(parent, walk).whiteSpace)
    ? escaped.replace(/\n/g, "<br>")
    : escaped;
}

/** Code text with one line break between the boxes each highlighted line renders in. */
function preformattedText(pre: Element, walk: Walk): string {
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      text += selectedSlice(node as Text, walk.range);
      return;
    }
    if (!isElement(node)) return;
    const style = styleFor(node, walk);
    if (isOmitted(node, style)) return;
    const block = isBlockDisplay(style.display);
    if (block && text && !text.endsWith("\n")) text += "\n";
    for (const child of node.childNodes) {
      if (walk.range.intersectsNode(child)) visit(child);
    }
    if (block && text && !text.endsWith("\n")) text += "\n";
  };
  for (const child of pre.childNodes) {
    if (walk.range.intersectsNode(child)) visit(child);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function selectedText(node: Node, walk: Walk): string {
  if (node.nodeType === TEXT_NODE) return selectedSlice(node as Text, walk.range);
  let text = "";
  for (const child of node.childNodes) {
    if (walk.range.intersectsNode(child)) text += selectedText(child, walk);
  }
  return text;
}

function selectedSlice(node: Text, range: Range): string {
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.data.length;
  return node.data.slice(start, end);
}

function texSource(element: Element): string {
  const annotation = findElement(element, (candidate) =>
    candidate.localName === "annotation" && candidate.getAttribute("encoding") === "application/x-tex");
  return (annotation ?? element).textContent ?? "";
}

function findElement(root: Node, matches: (element: Element) => boolean): Element | null {
  for (const child of root.childNodes) {
    if (!isElement(child)) continue;
    if (matches(child)) return child;
    const found = findElement(child, matches);
    if (found) return found;
  }
  return null;
}

function attributesFor(element: Element, tag: string): string {
  let attributes = directionAttribute(element);
  const href = tag === "a" ? safeHref(element) : null;
  if (href) attributes += ` href="${escapeHtml(href)}"`;
  const start = tag === "ol" ? element.getAttribute("start") : null;
  if (start && /^\d+$/.test(start)) attributes += ` start="${start}"`;
  return attributes;
}

// Mixed Arabic/English blocks carry their own direction (H-047); it is not a colour.
function directionAttribute(element: Element): string {
  const direction = element.getAttribute("dir")?.toLowerCase();
  return direction === "rtl" || direction === "ltr" || direction === "auto" ? ` dir="${direction}"` : "";
}

function safeHref(element: Element): string | null {
  const href = (element as Partial<HTMLAnchorElement>).href || element.getAttribute("href") || "";
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

function isOmitted(element: Element, style: CopyStyle): boolean {
  return OMITTED.has(element.localName)
    || element.getAttribute("aria-hidden") === "true"
    || CONTROL_ROLES.has(element.getAttribute("role") ?? "")
    || style.display === "none"
    || style.visibility === "hidden"
    || style.visibility === "collapse"
    || style.userSelect === "none"
    || style.webkitUserSelect === "none";
}

/** Editable regions and code editors own their copy; a selection reaching one is left to them. */
function isEditor(element: Element): boolean {
  const editable = element.getAttribute("contenteditable");
  return (editable !== null && editable !== "false") || CODE_EDITORS.some((name) => hasClass(element, name));
}

function insideEditor(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if (!isElement(current)) continue;
    if (current.localName === "input" || current.localName === "textarea" || current.localName === "select" || isEditor(current)) return true;
  }
  return false;
}

function isBlockDisplay(display: string): boolean {
  return display !== "none" && !/^(inline|contents|ruby|math)/.test(display);
}

function styleFor(element: Element, walk: Walk): CopyStyle {
  let style = walk.styles.get(element);
  if (!style) {
    style = walk.styleOf(element);
    walk.styles.set(element, style);
  }
  return style;
}

function computedCopyStyle(element: Element): CopyStyle {
  const view = element.ownerDocument.defaultView;
  return view ? view.getComputedStyle(element) : { display: "inline", visibility: "visible", whiteSpace: "normal", userSelect: "auto" };
}

function within(scope: Node, node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if (current === scope) return true;
  }
  return false;
}

function hasClass(element: Element, name: string): boolean {
  return (element.getAttribute("class") ?? "").split(/\s+/).includes(name);
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Partial<Node>).nodeType === "number";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}
