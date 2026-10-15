import { describe, expect, it, vi } from "vitest";

import { copyMessageSelection, type CopyStyle } from "./message-copy";

// A small DOM with ranges and computed styles. Desktop UI tests run without a
// browser DOM, and the handler only walks nodes, attributes and boundaries.
class FakeText {
  readonly nodeType = 3;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  constructor(readonly data: string) {}
  get textContent(): string { return this.data; }
}

class FakeElement {
  readonly nodeType = 1;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  constructor(readonly localName: string, private readonly attributes: Record<string, string>) {}
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string): boolean { return name in this.attributes; }
  get textContent(): string { return this.childNodes.map((child) => child.textContent).join(""); }
}

type FakeNode = FakeText | FakeElement;

function h(tag: string, attributes: Record<string, string> = {}, ...children: Array<FakeNode | string>): FakeElement {
  const element = new FakeElement(tag, attributes);
  for (const child of children) {
    const node = typeof child === "string" ? new FakeText(child) : child;
    node.parentNode = element;
    element.childNodes.push(node);
  }
  return element;
}

function textOf(element: FakeElement): FakeText {
  const text = element.childNodes.find((child): child is FakeText => child instanceof FakeText);
  if (!text) throw new Error(`<${element.localName}> has no text`);
  return text;
}

// Boundary points compare as child-index paths from the root.
function path(node: FakeNode): number[] {
  const indices: number[] = [];
  for (let current: FakeNode = node; current.parentNode; current = current.parentNode) indices.unshift(current.parentNode.childNodes.indexOf(current));
  return indices;
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

class FakeRange {
  constructor(readonly startContainer: FakeNode, readonly startOffset: number, readonly endContainer: FakeNode, readonly endOffset: number) {}
  get commonAncestorContainer(): FakeNode {
    const ancestors = new Set<FakeNode>();
    for (let node: FakeNode | null = this.startContainer; node; node = node.parentNode) ancestors.add(node);
    for (let node: FakeNode | null = this.endContainer; node; node = node.parentNode) if (ancestors.has(node)) return node;
    throw new Error("Range ends are in different trees");
  }
  intersectsNode(node: FakeNode): boolean {
    const parent = node.parentNode;
    if (!parent) return true;
    const index = parent.childNodes.indexOf(node);
    return compare([...path(parent), index], [...path(this.endContainer), this.endOffset]) < 0
      && compare([...path(parent), index + 1], [...path(this.startContainer), this.startOffset]) > 0;
  }
}

// Computed styles come from each element's inline style plus browser defaults;
// visibility, white-space and user-select inherit as they do in Chromium.
const BLOCKS = new Set(["div", "p", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "section", "header"]);
const DISPLAYS: Record<string, string> = { li: "list-item", table: "table", thead: "table-header-group", tbody: "table-row-group", tr: "table-row", th: "table-cell", td: "table-cell" };

function declared(element: FakeElement, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(element.getAttribute("style") ?? "")?.[1]?.trim();
}

function inherited(element: FakeElement, property: string, fallback: string): string {
  for (let node: FakeElement | null = element; node; node = node.parentNode) {
    const value = declared(node, property) ?? (property === "white-space" && node.localName === "pre" ? "pre" : undefined);
    if (value) return value;
  }
  return fallback;
}

function styleOf(element: Element): CopyStyle {
  const fake = element as unknown as FakeElement;
  return {
    display: declared(fake, "display") ?? DISPLAYS[fake.localName] ?? (BLOCKS.has(fake.localName) ? "block" : "inline"),
    visibility: inherited(fake, "visibility", "visible"),
    whiteSpace: inherited(fake, "white-space", "normal"),
    userSelect: inherited(fake, "user-select", "auto"),
  };
}

const DARK = "color: rgb(250, 250, 250); background-color: rgb(24, 24, 24)";

/** A user prompt and an assistant answer as the thread renders them in the dark theme. */
function renderedThread(answerDirection = "ltr") {
  const firstLine = h("span", { dir: "ltr", class: "block", style: "display: block" }, "Please draft the reply.");
  const secondLine = h("span", { dir: "ltr", class: "block", style: "display: block" }, "Keep it short.");
  const prompt = h("span", { dir: "ltr", class: "block whitespace-pre-wrap", style: "display: block; white-space: pre-wrap" }, firstLine, secondLine);
  const userRow = h("div", { role: "article", style: "transform: translateY(0px); padding-bottom: 20px" },
    h("div", { "data-slot": "message", "data-align": "end" },
      h("div", { "data-user-message-bubble-surface": "", class: "berry-user-message bg-secondary", style: DARK }, prompt),
      h("div", { "data-slot": "message-footer", style: "display: flex" },
        h("span", { class: "select-none", style: "user-select: none" }, "Oct 14, 2:07 PM"),
        h("button", { "aria-label": "Copy message" }, h("svg", { "aria-hidden": "true" })))));

  const heading = h("h2", { class: "mt-6 mb-4 text-base font-semibold" }, "Summary");
  const bold = h("strong", { class: "font-medium" }, "the summary");
  const link = h("a", { href: "https://example.com/report", class: "font-medium text-primary underline", dir: "auto", target: "_blank" }, "the team");
  const lead = h("p", {}, "Send ", bold, " to ", link, " and attach ",
    h("button", { type: "button", class: "font-mono text-primary underline", "data-copy-text": "" }, "outputs/report.docx"),
    ". Run ", h("code", { dir: "ltr", class: "rounded-lg bg-[var(--berry-surface-inset)]", style: "background-color: rgb(38, 38, 38)" }, "npm test"), ".");
  const list = h("ul", { class: "my-3 list-disc marker:text-muted-foreground/70" }, h("li", { class: "ps-1" }, "First"), h("li", { class: "ps-1" }, "Second"));
  const balance = h("td", { class: "border-b px-3 text-foreground" }, "Balance");
  const amount = h("td", { class: "border-b px-3 text-foreground" }, "1,250");
  const table = h("div", { "data-markdown-table-container": "", class: "my-4 rounded-xl border border-border" },
    h("div", { class: "overflow-x-auto" },
      h("table", { class: "border-separate text-[13px]" },
        h("thead", {}, h("tr", { class: "hover:bg-muted/20" }, h("th", { class: "text-muted-foreground/70" }, "Item"), h("th", { class: "text-muted-foreground/70" }, "Value"))),
        h("tbody", {}, h("tr", { class: "hover:bg-muted/20" }, balance, amount)))));
  const codeLine = (number: string, ...tokens: FakeElement[]) => h("span", { class: "flex min-w-0 gap-4", style: "display: flex" },
    h("span", { class: "w-6 select-none", "aria-hidden": "true", style: "user-select: none" }, number),
    h("span", { class: "min-w-0", style: "display: block" }, ...tokens));
  const token = (text: string, color: string) => h("span", { "data-shiki-token": "", style: `color: ${color}` }, text);
  const firstCodeLine = codeLine("1", token("const", "#4d9375"), token(" total = price * 2;", "#dbd7caee"));
  const code = h("div", { dir: "ltr", "data-language": "ts", class: "group rounded-xl bg-[var(--berry-surface-inset)]", style: "content-visibility: auto" },
    h("div", { class: "flex items-center justify-between", style: "display: flex" },
      h("span", { class: "truncate lowercase", style: "display: block" }, "ts"),
      h("button", { type: "button", "aria-label": "Copy code" }, h("svg", { class: "size-3.5" }))),
    h("pre", { "data-code-theme": "berry-dark", style: "font-size: 13px" },
      h("code", { class: "font-mono language-ts" }, firstCodeLine, codeLine("2", token("  return total;", "#dbd7caee")))));
  const markdown = h("div", { dir: answerDirection, class: "font-sans min-w-0 text-[13px]" }, heading, lead, list, table, code);
  const assistantRow = h("div", { role: "article" },
    h("div", { "data-slot": "message" }, h("div", { class: "berry-assistant-message text-foreground", style: DARK }, markdown)));

  const questionInput = h("input", { placeholder: "Type an answer" });
  const inlineEditor = h("div", { contenteditable: "true", role: "textbox" }, h("p", {}, "Edited prompt"));
  const feed = h("div", { role: "feed", class: "berry-thread-content" }, userRow, assistantRow, h("div", {}, questionInput), h("div", { class: "berry-user-editor" }, inlineEditor));
  const composer = h("div", { contenteditable: "true", role: "textbox" }, h("p", {}, "Draft a follow-up"));
  const sidebarTask = h("a", { href: "/tasks/1" }, "Sidebar task");
  h("main", {}, h("nav", {}, sidebarTask), feed, h("div", { class: "composer" }, composer));
  return { feed, composer, sidebarTask, inlineEditor, questionInput, prompt, firstLine, secondLine, markdown, heading, lead, bold, link, list, balance, amount, firstCodeLine };
}

function copy(scope: FakeElement, range: FakeRange, text: string, target: FakeNode = range.startContainer, defaultPrevented = false) {
  const data = new Map<string, string>();
  const event = {
    clipboardData: { setData: (type: string, value: string) => { data.set(type, value); } },
    defaultPrevented,
    target: target as unknown as EventTarget,
    preventDefault: vi.fn(),
  };
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => text };
  const handled = copyMessageSelection(event, scope as unknown as Node, selection as unknown as Selection, styleOf);
  return { handled, data, html: data.get("text/html"), prevented: event.preventDefault.mock.calls.length > 0 };
}

describe("selection copy from rendered messages (H-044)", () => {
  it("writes the selected text and structure-only HTML for an answer", () => {
    const thread = renderedThread();
    const range = new FakeRange(thread.markdown, 0, thread.markdown, thread.markdown.childNodes.length);
    const text = "Summary\nSend the summary to the team and attach outputs/report.docx. Run npm test.\nFirst\nSecond\nItem\tValue\nBalance\t1,250\nts\nconst total = price * 2;\n  return total;";
    const result = copy(thread.feed, range, text);

    expect(result.handled).toBe(true);
    expect(result.prevented).toBe(true);
    expect(result.data.get("text/plain")).toBe(text);
    expect(result.html).toBe([
      "<meta charset=\"utf-8\"><div dir=\"ltr\">",
      "<h2>Summary</h2>",
      "<p>Send <strong>the summary</strong> to <a dir=\"auto\" href=\"https://example.com/report\">the team</a> and attach outputs/report.docx. Run <code dir=\"ltr\">npm test</code>.</p>",
      "<ul><li>First</li><li>Second</li></ul>",
      "<div><div><table><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody><tr><td>Balance</td><td>1,250</td></tr></tbody></table></div></div>",
      "<div dir=\"ltr\"><div><div>ts</div></div><pre>const total = price * 2;\n  return total;</pre></div>",
      "</div>",
    ].join(""));
    // Nothing that can carry the dark theme survives: colours, classes, data attributes, controls.
    expect(result.html).not.toMatch(/style=|class=|data-|color|background|rgb|#4d9375|<button|<svg|Copy code|Oct 14/);
  });

  it("keeps the line breaks of a prompt and the direction of a right-to-left answer", () => {
    const thread = renderedThread("rtl");
    const prompt = copy(thread.feed, new FakeRange(textOf(thread.firstLine), 0, textOf(thread.secondLine), 14), "Please draft the reply.\nKeep it short.");
    expect(prompt.html).toBe("<meta charset=\"utf-8\"><div dir=\"ltr\"><div dir=\"ltr\">Please draft the reply.</div><div dir=\"ltr\">Keep it short.</div></div>");

    const answer = copy(thread.feed, new FakeRange(textOf(thread.heading), 0, textOf(thread.lead), 5), "Summary\nSend ");
    expect(answer.html).toBe("<meta charset=\"utf-8\"><div dir=\"rtl\"><h2>Summary</h2><p>Send </p></div>");

    const draft = h("p", { style: "white-space: pre-wrap" }, "Hi Sara,\nThanks for the update.");
    const body = h("div", { "data-writing-block-body": "" }, draft);
    const scope = h("div", { role: "feed" }, body);
    expect(copy(scope, new FakeRange(body, 0, body, 1), "Hi Sara,\nThanks for the update.").html)
      .toBe("<meta charset=\"utf-8\"><p>Hi Sara,<br>Thanks for the update.</p>");
  });

  it("keeps the formatting, link, row or code line around a partial selection", () => {
    const thread = renderedThread();
    expect(copy(thread.feed, new FakeRange(textOf(thread.bold), 4, textOf(thread.bold), 11), "summary").html)
      .toBe("<meta charset=\"utf-8\"><span dir=\"ltr\"><strong>summary</strong></span>");
    expect(copy(thread.feed, new FakeRange(textOf(thread.link), 0, textOf(thread.link), 3), "the").html)
      .toBe("<meta charset=\"utf-8\"><span dir=\"ltr\"><a dir=\"auto\" href=\"https://example.com/report\">the</a></span>");
    expect(copy(thread.feed, new FakeRange(textOf(thread.balance), 0, textOf(thread.amount), 5), "Balance\t1,250").html)
      .toBe("<meta charset=\"utf-8\"><div dir=\"ltr\"><table><tbody><tr><td>Balance</td><td>1,250</td></tr></tbody></table></div>");
    const tokens = thread.firstCodeLine.childNodes[1] as FakeElement;
    const keyword = textOf(tokens.childNodes[0] as FakeElement);
    const rest = textOf(tokens.childNodes[1] as FakeElement);
    expect(copy(thread.feed, new FakeRange(keyword, 0, rest, 6), "const total").html)
      .toBe("<meta charset=\"utf-8\"><span dir=\"ltr\"><code>const total</code></span>");
  });

  it("leaves selections outside messages, spanning out of them or in editors to the browser", () => {
    const thread = renderedThread();
    const sidebarText = textOf(thread.sidebarTask);
    const composerText = textOf(thread.composer.childNodes[0] as FakeElement);
    const editorText = textOf(thread.inlineEditor.childNodes[0] as FakeElement);
    const heading = textOf(thread.heading);
    const outside = copy(thread.feed, new FakeRange(sidebarText, 0, sidebarText, 7), "Sidebar");
    const fromOutside = copy(thread.feed, new FakeRange(sidebarText, 0, heading, 7), "Sidebar task … Summary", heading);
    const intoComposer = copy(thread.feed, new FakeRange(heading, 0, composerText, 5), "Summary … Draft");
    const inComposer = copy(thread.feed, new FakeRange(composerText, 0, composerText, 5), "Draft");
    const inInput = copy(thread.feed, new FakeRange(heading, 0, heading, 7), "Summary", thread.questionInput);
    const inEditor = copy(thread.feed, new FakeRange(editorText, 0, editorText, 6), "Edited");
    const intoEditor = copy(thread.feed, new FakeRange(heading, 0, editorText, 6), "Summary … Edited");
    const handledElsewhere = copy(thread.feed, new FakeRange(heading, 0, heading, 7), "Summary", heading, true);

    for (const result of [outside, fromOutside, intoComposer, inComposer, inInput, inEditor, intoEditor, handledElsewhere]) {
      expect(result.handled).toBe(false);
      expect(result.prevented).toBe(false);
      expect(result.data.size).toBe(0);
    }
  });

  it("writes plain text alone when only controls were selected", () => {
    const button = h("button", { type: "button" }, "Show more");
    const scope = h("div", { role: "feed" }, h("div", { role: "article" }, button));
    const result = copy(scope, new FakeRange(textOf(button), 0, textOf(button), 9), "Show more");
    expect(result.handled).toBe(true);
    expect([...result.data.keys()]).toEqual(["text/plain"]);
  });
});
