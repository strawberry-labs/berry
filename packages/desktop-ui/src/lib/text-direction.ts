/* ------------------------------------------------------------------------ */
/* Base direction for mixed Arabic/English text (H-047).                      */
/*                                                                            */
/* The browser's first-strong rule (dir="auto") reads "Berry Workspace هو      */
/* المكان ..." as left-to-right because the sentence opens with a product      */
/* name, which scrambles the Arabic around it. Direction here follows the     */
/* script most of a block's words are written in; code, URLs, e-mail          */
/* addresses and paths are ignored, and mixed blocks follow their message.    */
/* ------------------------------------------------------------------------ */

export type TextDirection = "ltr" | "rtl";

export interface ScriptWords {
  rtl: number;
  ltr: number;
  /** Script of the first counted word. */
  first: TextDirection | null;
}

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
const NON_PROSE = /`[^`\n]*`|\b(?:https?|ftp):\/\/\S+|\bwww\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+/gu;
const FENCE = /^\s{0,3}(?:```|~~~)/;

export const NO_WORDS: ScriptWords = { rtl: 0, ltr: 0, first: null };

/** Counts words by script; a word changing script ("وDOCX") counts once for each. */
export function scriptWords(text: string): ScriptWords {
  let rtl = 0;
  let ltr = 0;
  let first: TextDirection | null = null;
  let previous: TextDirection | null = null;
  for (const char of text.replace(NON_PROSE, " ")) {
    const kind: TextDirection | null = LETTER.test(char)
      ? RTL_LETTER.test(char) ? "rtl" : "ltr"
      : MARK.test(char) ? previous : null;
    if (kind && kind !== previous) {
      if (kind === "rtl") rtl += 1;
      else ltr += 1;
      first ??= kind;
    }
    previous = kind;
  }
  return { rtl, ltr, first };
}

export function addScriptWords(left: ScriptWords, right: ScriptWords): ScriptWords {
  return { rtl: left.rtl + right.rtl, ltr: left.ltr + right.ltr, first: left.first ?? right.first };
}

/** The direction a block's own words settle, or null when they are mixed or absent. */
export function decidedDirection({ rtl, ltr }: ScriptWords): TextDirection | null {
  const total = rtl + ltr;
  if (total === 0) return null;
  const share = rtl / total;
  return share >= 0.7 ? "rtl" : share <= 0.3 ? "ltr" : null;
}

/** A message's base direction: a clear majority, otherwise its first word's script. */
export function messageDirection(words: ScriptWords): TextDirection {
  return decidedDirection(words) ?? words.first ?? "ltr";
}

export interface DirectedLine {
  text: string;
  /** Explicit direction, or undefined to follow the message. */
  dir: TextDirection | undefined;
}

/**
 * Splits plain or streaming Markdown text into lines with their own direction.
 * Fenced code stays left-to-right and does not count towards the message.
 * `cache` keeps per-line counts so a growing stream only rescans its last line.
 */
export function directedLines(text: string, cache?: Map<string, ScriptWords>): { direction: TextDirection; lines: DirectedLine[] } {
  let total = NO_WORDS;
  let fenced = false;
  const parts = text.split("\n");
  const lines = parts.map((line, index): DirectedLine => {
    const fence = FENCE.test(line);
    if (fence || fenced) {
      if (fence) fenced = !fenced;
      return { text: line, dir: "ltr" };
    }
    let words = cache?.get(line);
    if (!words) {
      words = scriptWords(line);
      // The last line may still be growing; only finished lines are reused.
      if (index < parts.length - 1) cache?.set(line, words);
    }
    total = addScriptWords(total, words);
    return { text: line, dir: decidedDirection(words) ?? undefined };
  });
  const direction = messageDirection(total);
  return { direction, lines: lines.map(({ text: line, dir }) => ({ text: line, dir: dir === direction ? undefined : dir })) };
}

/** Base direction of Markdown source, ignoring fenced code. */
export function markdownDirection(text: string): TextDirection {
  return directedLines(text).direction;
}

/* Settled Markdown: a rehype plugin marks blocks whose own words settle a     */
/* direction other than their surroundings. Literal code is skipped here and  */
/* rendered left-to-right by the Markdown components.                         */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const DIRECTED_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "th", "td"]);
const LITERAL = new Set(["pre", "code", "kbd", "samp", "script", "style"]);
const SEPARATED = new Set([...DIRECTED_BLOCKS, "table", "thead", "tbody", "tr", "div", "br", "hr"]);

function proseText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type !== "element" && node.type !== "root") return "";
  if (LITERAL.has(node.tagName ?? "")) return " ";
  const text = (node.children ?? []).map(proseText).join("");
  return SEPARATED.has(node.tagName ?? "") ? ` ${text} ` : text;
}

export function rehypeTextDirection(options: { direction: TextDirection }) {
  return (tree: HastNode) => {
    const visit = (node: HastNode, inherited: TextDirection) => {
      for (const child of node.children ?? []) {
        if (child.type !== "element" || LITERAL.has(child.tagName ?? "")) continue;
        let own = inherited;
        if (DIRECTED_BLOCKS.has(child.tagName ?? "")) {
          const decided = decidedDirection(scriptWords(proseText(child)));
          if (decided && decided !== inherited) {
            own = decided;
            const className = child.properties?.className;
            child.properties = {
              ...child.properties,
              dir: decided,
              // An outside bullet would hang past the list's padding, which is
              // on the other side.
              ...(child.tagName === "li" ? { className: [...(Array.isArray(className) ? className : []), "list-inside"] } : {}),
            };
          }
        }
        visit(child, own);
      }
    };
    visit(tree, options.direction);
  };
}
