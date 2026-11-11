import type * as Mdast from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/*
 * React-free Markdown model for the native renderer. Same plugin set as the
 * web renderer (remark-gfm + remark-math with their defaults), reduced to the
 * handful of node kinds the app draws. Every block carries a content hash so
 * the renderer can skip re-rendering blocks whose source did not change.
 */

export type MarkdownAlign = "left" | "center" | "right" | null;

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "emphasis"; children: MarkdownInline[] }
  | { type: "delete"; children: MarkdownInline[] }
  | { type: "inlineCode"; value: string }
  | { type: "link"; url: string; title: string | null; children: MarkdownInline[] }
  | { type: "image"; url: string; alt: string; title: string | null }
  | { type: "break" }
  | { type: "inlineMath"; value: string };

export type MarkdownTableCell = MarkdownInline[];

export type MarkdownListItem = {
  /** GFM task list state: `true`/`false` for `[x]`/`[ ]`, `null` for a plain item. */
  checked: boolean | null;
  children: MarkdownBlock[];
};

type BlockBody =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: "code"; lang: string | null; meta: string | null; value: string }
  | { type: "blockquote"; children: MarkdownBlock[] }
  | { type: "list"; ordered: boolean; start: number; spread: boolean; items: MarkdownListItem[] }
  | { type: "table"; align: MarkdownAlign[]; header: MarkdownTableCell[]; rows: MarkdownTableCell[][] }
  | { type: "thematicBreak" }
  | { type: "math"; value: string }
  | { type: "html"; value: string };

/** A block plus a hash of its source, stable across re-parses of the same text. */
export type MarkdownBlock = BlockBody & { hash: string };

export type MarkdownBlockType = MarkdownBlock["type"];

export type MarkdownDocument = { blocks: MarkdownBlock[] };

/* ------------------------------------------------------------------------ */
/* Parsing                                                                    */
/* ------------------------------------------------------------------------ */

function createProcessor() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();
}

let processor: ReturnType<typeof createProcessor> | null = null;

function getProcessor(): ReturnType<typeof createProcessor> {
  processor ??= createProcessor();
  return processor;
}

const CACHE_LIMIT = 64;
const cache = new Map<string, MarkdownDocument>();

/**
 * Parses Markdown into the renderer's block model. Results are memoized in a
 * small LRU keyed by the full text, so settled messages are parsed once.
 * Never throws: partial (streaming) Markdown always yields a document.
 */
export function parseMarkdown(text: string): MarkdownDocument {
  const cached = cache.get(text);
  if (cached) {
    cache.delete(text);
    cache.set(text, cached);
    return cached;
  }
  const document = parseMarkdownUncached(text);
  cache.set(text, document);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return document;
}

/** The parse behind {@link parseMarkdown}, without touching the LRU (streaming tails use this). */
export function parseMarkdownUncached(text: string): MarkdownDocument {
  if (!text.trim()) return { blocks: [] };
  try {
    const root = getProcessor().parse(text);
    const context: ConvertContext = { source: text, definitions: collectDefinitions(root), salt: [] };
    return { blocks: convertBlocks(root.children, context) };
  } catch {
    // micromark handles any input, but a malformed plugin edge case must never
    // take down a message: fall back to the raw text.
    return { blocks: [withHash({ type: "paragraph", children: [{ type: "text", value: text }] }, text)] };
  }
}

/** Test hook: drops memoized parses. */
export function clearMarkdownCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------------ */
/* mdast -> model                                                             */
/* ------------------------------------------------------------------------ */

type Definition = { url: string; title: string | null };

type ConvertContext = {
  source: string;
  definitions: Map<string, Definition>;
  /** Resolved reference URLs, mixed into the hash of the block that used them. */
  salt: string[];
};

function collectDefinitions(root: Mdast.Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  const visit = (node: Mdast.Nodes) => {
    if (node.type === "definition") {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, { url: node.url, title: node.title ?? null });
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child as Mdast.Nodes);
  };
  visit(root);
  return definitions;
}

function convertBlocks(nodes: readonly Mdast.Nodes[], context: ConvertContext): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const node of nodes) convertBlock(node, context, blocks);
  return blocks;
}

function convertBlock(node: Mdast.Nodes, context: ConvertContext, out: MarkdownBlock[]): void {
  const saltStart = context.salt.length;
  const body = blockBody(node, context, out);
  if (!body) return;
  const salt = context.salt.length > saltStart ? `\u0000${context.salt.slice(saltStart).join("\u0000")}` : "";
  out.push(withHash(body, sourceOf(node, context.source, body) + salt));
}

function blockBody(node: Mdast.Nodes, context: ConvertContext, out: MarkdownBlock[]): BlockBody | null {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: convertInlines(node.children, context) };
    case "heading":
      return { type: "heading", level: node.depth, children: convertInlines(node.children, context) };
    case "code":
      return { type: "code", lang: node.lang ?? null, meta: node.meta ?? null, value: node.value };
    case "blockquote":
      return { type: "blockquote", children: convertBlocks(node.children, context) };
    case "list":
      return {
        type: "list",
        ordered: node.ordered === true,
        start: typeof node.start === "number" ? node.start : 1,
        spread: node.spread === true,
        items: node.children.map((item) => ({
          checked: typeof item.checked === "boolean" ? item.checked : null,
          children: convertBlocks(item.children, context),
        })),
      };
    case "table": {
      const [head, ...body] = node.children;
      const columns = Math.max(0, ...node.children.map((row) => row.children.length));
      const cells = (row: Mdast.TableRow | undefined) =>
        Array.from({ length: columns }, (_, index) => {
          const cell = row?.children[index];
          return cell ? convertInlines(cell.children, context) : [];
        });
      return {
        type: "table",
        align: Array.from({ length: columns }, (_, index) => node.align?.[index] ?? null),
        header: cells(head),
        rows: body.map(cells),
      };
    }
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "math":
      return { type: "math", value: node.value };
    case "html":
      return node.value.trim() ? { type: "html", value: node.value } : null;
    case "footnoteDefinition": {
      // Rendered in place: the first paragraph gets a `[label]` prefix.
      const children = convertBlocks(node.children, context);
      const label = { type: "text" as const, value: `[${node.label ?? node.identifier}] ` };
      const [first, ...rest] = children;
      if (first?.type === "paragraph") {
        out.push(withHash({ type: "paragraph", children: [label, ...first.children] }, `${first.hash}:${label.value}`), ...rest);
      } else {
        out.push(withHash({ type: "paragraph", children: [label] }, label.value), ...children);
      }
      return null;
    }
    case "definition":
    case "yaml":
      return null;
    default: {
      // Unknown block-level content (future plugins): keep its text visible.
      const text = plainText(node);
      return text ? { type: "paragraph", children: [{ type: "text", value: text }] } : null;
    }
  }
}

function convertInlines(nodes: readonly Mdast.Nodes[], context: ConvertContext): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.type === "text") out[out.length - 1] = { type: "text", value: last.value + value };
    else out.push({ type: "text", value });
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        pushText(node.value);
        break;
      case "strong":
      case "emphasis":
      case "delete":
        out.push({ type: node.type, children: convertInlines(node.children, context) });
        break;
      case "inlineCode":
        out.push({ type: "inlineCode", value: node.value });
        break;
      case "inlineMath":
        out.push({ type: "inlineMath", value: node.value });
        break;
      case "break":
        out.push({ type: "break" });
        break;
      case "link":
        out.push({ type: "link", url: node.url, title: node.title ?? null, children: convertInlines(node.children, context) });
        break;
      case "image":
        out.push({ type: "image", url: node.url, alt: node.alt ?? "", title: node.title ?? null });
        break;
      case "linkReference": {
        const definition = context.definitions.get(node.identifier);
        context.salt.push(definition?.url ?? "");
        const children = convertInlines(node.children, context);
        if (definition) {
          out.push({ type: "link", url: definition.url, title: definition.title, children });
        } else {
          // Unresolved: show what the author typed.
          pushText("[");
          out.push(...children);
          pushText(node.referenceType === "full" ? `][${node.label ?? node.identifier}]` : "]");
        }
        break;
      }
      case "imageReference": {
        const definition = context.definitions.get(node.identifier);
        context.salt.push(definition?.url ?? "");
        if (definition) out.push({ type: "image", url: definition.url, alt: node.alt ?? "", title: definition.title });
        else pushText(`![${node.alt ?? ""}]`);
        break;
      }
      case "footnoteReference":
        pushText(`[${node.label ?? node.identifier}]`);
        break;
      case "html":
        if (/^<br\s*\/?>$/i.test(node.value.trim())) out.push({ type: "break" });
        else pushText(node.value);
        break;
      default:
        pushText(plainText(node));
    }
  }
  return out;
}

function plainText(node: Mdast.Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Mdast.Nodes[]).map(plainText).join("");
  return "";
}

/* ------------------------------------------------------------------------ */
/* Hashing                                                                    */
/* ------------------------------------------------------------------------ */

function sourceOf(node: Mdast.Nodes, source: string, body: BlockBody): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start === "number" && typeof end === "number") return source.slice(start, end);
  return JSON.stringify(body);
}

function withHash(body: BlockBody, source: string): MarkdownBlock {
  return { ...body, hash: `${body.type}:${source.length.toString(36)}:${fnv1a(source)}` };
}

/** 32-bit FNV-1a, base36. Collisions only cost a skipped re-render of one block. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/* ------------------------------------------------------------------------ */
/* Streaming                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Incremental parse state for a growing (streaming) message. Text before
 * `stableEnd` was split at block boundaries that later tokens cannot change
 * (a blank line followed by an unindented line, outside code/math fences), so
 * each settled segment is parsed exactly once. Only the tail after the last
 * boundary is re-parsed per update, which keeps token updates O(tail).
 */
export type MarkdownStreamState = {
  readonly text: string;
  /** Offset where the re-parsed tail begins. */
  readonly stableEnd: number;
  readonly stableBlocks: readonly MarkdownBlock[];
  readonly blocks: readonly MarkdownBlock[];
  readonly scan: ScanState;
};

type Fence = { marker: "`" | "~" | "$"; length: number };

type ScanState = {
  /** Start of the first line not yet fully scanned. */
  offset: number;
  fence: Fence | null;
  previousBlank: boolean;
};

const INITIAL_SCAN: ScanState = { offset: 0, fence: null, previousBlank: true };

/**
 * Advances `previous` to `text`. Appends reuse all settled work; any other
 * change (a rewrite, a shorter text) starts over. Pure: `previous` is not mutated.
 */
export function advanceMarkdownStream(previous: MarkdownStreamState | null, text: string): MarkdownStreamState {
  const base = previous && text.startsWith(previous.text) ? previous : null;
  if (base && base.text.length === text.length) return base;

  let scan = base?.scan ?? INITIAL_SCAN;
  let stableEnd = base?.stableEnd ?? 0;
  let boundary = stableEnd;
  // Scan complete lines; a boundary sits at the start of a line.
  for (;;) {
    const newline = text.indexOf("\n", scan.offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(scan.offset, lineEnd);
    if (isBoundaryLine(scan, line) && scan.offset > boundary) boundary = scan.offset;
    if (newline === -1) break; // The last line is still streaming; rescan it next time.
    scan = scanLine(scan, line, newline + 1);
  }

  let stableBlocks = base?.stableBlocks ?? [];
  if (boundary > stableEnd) {
    const segment = parseMarkdownUncached(text.slice(stableEnd, boundary)).blocks;
    stableBlocks = stableBlocks.concat(segment);
    stableEnd = boundary;
  }
  const tail = parseMarkdownUncached(text.slice(stableEnd)).blocks;
  return { text, stableEnd, stableBlocks, blocks: tail.length > 0 ? stableBlocks.concat(tail) : stableBlocks, scan };
}

function isBoundaryLine(scan: ScanState, line: string): boolean {
  if (scan.fence || !scan.previousBlank || scan.offset === 0) return false;
  const first = line.charCodeAt(0);
  // Needs a visible, unindented first character: indented lines may continue
  // a list item or be indented code, so they stay with the block above.
  return line.length > 0 && first !== 32 /* space */ && first !== 9 /* tab */ && first !== 13 /* \r */;
}

const FENCE_OPEN = /^[\s>]*(`{3,}|~{3,}|\${2,})(.*)$/;
const FENCE_CLOSE = /^[\s>]*(`{3,}|~{3,}|\${2,})\s*$/;

function scanLine(scan: ScanState, line: string, nextOffset: number): ScanState {
  const blank = line.trim() === "";
  if (scan.fence) {
    const close = FENCE_CLOSE.exec(line);
    const run = close?.[1];
    const closes = run !== undefined && run[0] === scan.fence.marker && run.length >= scan.fence.length;
    return { offset: nextOffset, fence: closes ? null : scan.fence, previousBlank: closes ? false : blank };
  }
  const open = FENCE_OPEN.exec(line);
  const run = open?.[1];
  if (run !== undefined) {
    const marker = run[0] as Fence["marker"];
    const info = open?.[2] ?? "";
    // Backtick fences cannot carry backticks in their info string, and `$$x$$`
    // on one line is inline math, not a math block.
    const opens = marker === "`" ? !info.includes("`") : marker === "$" ? !info.includes("$") : true;
    if (opens) return { offset: nextOffset, fence: { marker, length: run.length }, previousBlank: false };
  }
  return { offset: nextOffset, fence: null, previousBlank: blank };
}
